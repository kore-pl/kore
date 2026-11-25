> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M0

# CORE — 内核规格

## 0. 文档定位

| 项 | 内容 |
| --- | --- |
| 读者 | implementer（照此实现）、verifier（照此验收）、red-team（照此攻击） |
| 作用 | 把"内核只定规则"落成 11 个模块的字段级规格：职责、输入输出、失败模式、明确不做 |
| 不作用 | 不写组件图与进程模型（见 [ARCHITECTURE.md](./ARCHITECTURE.md)）、不写愿景（见 [VISION.md](./VISION.md)）、不写业务插件规格 |
| 硬约束 | 依赖白名单 3 个（`yaml.v3`、`bbolt`、M3 的 `protobuf`）；`internal/core` 禁 import `plugins/**`；禁 SQL/Web 框架/出网客户端 |
| 版本基线 | MVP 0.1.1（首个含 `file_write` 受控写的内核版本；`Makefile` 的 `VERSION` 是唯一真源）；协议 `kore.plugin.v1`；帧上限 8 MiB；术语以 [GLOSSARY.md](./GLOSSARY.md) 为准 |

## 1. 内核边界

| # | 内核做 | 内核不做 |
| --- | --- | --- |
| 1 | 插件包安装/卸载/启停/热升级的**流程编排** | 实现任何具体运维功能（站点、备份、证书签发、数据库管理） |
| 2 | 协议帧编解码、请求路由、超时与错误码映射 | 理解业务参数语义（"备份哪个目录""站点用哪个域名"） |
| 3 | 单用户口令校验、会话签发与吊销 | 用户注册、多租户、角色权限矩阵、OAuth/SSO |
| 4 | supervisor 进程生命周期 + cgroup v2 限额 | 容器编排、跨机调度、插件内部健康语义 |
| 5 | bbolt KV 持久化（元数据/会话/插件清单） | 业务数据存储、SQL 查询、报表统计 |
| 6 | 事件总线扇出 + SSE 推送 | 消息持久化、可靠投递、跨重启重放 |
| 7 | `//go:embed` 静态资源与插件前端资产托管 | 前端业务页面（登录页之外全在插件里） |
| 8 | 配置解析、校验、SIGHUP 热重载 | 配置中心、远端下发、灰度、配置版本管理 |
| 9 | `/-/healthz`、`/system/info`、`/system/metrics`、结构化日志 | 监控平台、指标聚合、告警、APM（仅提供请求路径上的资源快照） |
| 10 | 日志写文件与 `req_id` 关联 | 日志聚合/检索；轮转在 M3 交付 |

判据：表中任一行"不做"侧出现代码，即设计事故。评审用 [ARCHITECTURE.md](./ARCHITECTURE.md) §9.2 的扩展点清单拦截。

## 2. 模块规格

每个模块四小节。配置字段名与默认值以 `DATA-MODEL.md` §3 为**唯一真源**，本文件不复写键表，只写内核行为与失败码。

**§2 共 18 小节 = 15 个内核模块 + 3 个支撑小节**。模块数唯一口径是**代码事实**：`ls internal/core/` 的 15 个包，一包一节——`auth` / `bus` / `config` / `credential` / `envprobe` / `filewrite` / `httpapi` / `installer` / `market` / `metrics` / `privilege` / `registry` / `scheduler` / `store` / `supervisor`（§2.1–§2.7、§2.11–§2.18；编号沿用历史不重排，避免外部交叉引用失效）。其中 `installer`（§2.12）、`privilege`（§2.13，ADR-0018 提权通道）、`market`（§2.14）、`scheduler`（§2.15，ADR-0019 定时任务）、`credential`（§2.16，ADR-0026 托管凭据）、`filewrite`（§2.17，ADR-0028 受控文件写）、`metrics`（§2.18，请求路径惰性采样）是后续里程碑新增模块（包名用 `market` 避开 §2.2 持久化 `store`，对外 API/UI 仍叫「商店」）。`envprobe`（§2.11）是启动期一次性探测，**包在 `internal/core/envprobe`**、由 `cmd/kored` 装配，属内核包、计入模块数。3 个支撑小节**不是包、不计入模块数**：`logger`（§2.8，跨包 `log/slog` 约定，无独立目录）、`static`（§2.9，`internal/core/httpapi/server.go` 的 `staticRoutes()` + `embed.FS`）、`sse`（§2.10，`internal/core/httpapi/sse.go`）。

### 2.1 `internal/core/config`

- **职责**：内置默认值 → `/etc/kore/config.yaml` 覆盖 → 环境变量覆盖 → 字段校验 → 不可变 `Config` 快照；SIGHUP 时重新解析并按 §6 白名单热替换。优先级：内置默认 < 配置文件 < 环境变量。**内核侧配置覆盖变量共 5 个**：`KORE_CONFIG`（改配置路径）、`KORE_STATE_DIR`（覆盖 `paths.state_dir`）、`KORE_PLUGIN_DIR`（覆盖 `paths.plugin_dir`）、`KORE_PROFILE`（`portable`/`fhs`，ADR-0023）、`KORE_HOME`（显式安装根目录）。**零侵入 profile（ADR-0023）**：`profile` 取 `portable`（默认）或 `fhs`。`portable` 下四类目录与 socket 全部落在安装目录内——`<install>/config/config.yaml`、`<install>/data`（state/plugins/index）、`<install>/run/kore.sock`、`<install>/logs`；`<install>` 由 `KORE_HOME` 优先、否则取自可执行文件位置（`<install>/bin/kored` → `<install>`；可执行文件在 `/usr/bin` 等系统目录时自动退回 `fhs`）。`fhs` 保留旧的 `/etc/kore` + `/var/lib/kore` + `/run/kore` + `/var/log/kore`，属**非零侵入模式**，启动打 WARN。profile 优先级：`KORE_PROFILE` > 配置文件 `profile` > 可执行文件位置推导。**不做自动迁移**：检测到 `/etc/kore/config.yaml` 或 `/var/lib/kore/state.db` 且新路径为空时只打可操作 WARN（提示 `KORE_PROFILE=fhs` 或迁移命令）。**另有 1 个可选环境变量 `KORE_PRESETS_DIR`**：预设目录，供 §2.14 `GET /api/v1/store/presets` 读取，缺省为空即预设列表返回空列表（非错误），不是 config 覆盖变量、不计入上述 5 个。**派生规则**：`paths.state_dir` 解析优先级 = `KORE_STATE_DIR` > `--state-dir` > 配置 `paths.state_dir` > **profile 默认**（`portable` 为 `<install>/data`、`fhs` 为 `/var/lib/kore`）；`paths.plugin_dir` 解析优先级 = `KORE_PLUGIN_DIR` > 配置 `paths.plugin_dir` > **`<state_dir>/plugins`（未显式设置时派生）**。即只设 `KORE_STATE_DIR=/tmp/x` 时，状态库为 `/tmp/x/state.db`、插件目录自动为 `/tmp/x/plugins`（M1 修复：此前 `plugin_dir` 写死，与 `state_dir` 脱节）。**路径归一化**：所有 `paths.*`（含派生 `plugin_dir`）在加载末段统一 `filepath.Abs + Clean` 成绝对路径，覆盖来源（配置文件 / 环境变量 / `--state-dir`）同样生效——supervisor 切换 `cmd.Dir` 后不再出现相对路径失配；相对值归一化时逐项写 WARN，便于日志核对，且 `GET /api/v1/system/info` 的 `paths` 段可查。**不支持 `~` 家目录展开**：`paths.*` 以 `~` 开头直接退出码 2（明确报错，不静默拼成 `<cwd>/~`）。键名与默认值以 `DATA-MODEL.md` §3 为唯一真源。
- **输入输出**：输入为配置文件路径（`KORE_CONFIG`）、`KORE_STATE_DIR`、`KORE_PLUGIN_DIR` 与 `--state-dir`，输出 `*Config`（各模块只读引用）+ `[]ValidationError`；字段组为 `server.*` / `auth.*` / `paths.*` / `log.*` / `resources.*` / `plugins.*` / `security.*` / `audit.*`，逐键定义见 `DATA-MODEL.md` §3，本文件不复制。
- **失败模式与处理**：文件不存在 → 用内置默认值 + WARN，继续启动；只有真正必填项缺失才拒绝启动（退出码 2）——`auth.admin_password_hash` **不是**必填项，空值走 §2.3 的首启 bootstrap。YAML 语法错 → stderr 报行号，退出码 2。**未知字段 → WARN + 继续启动**，附最接近的合法键名拼写建议（不因拼写把服务打死）。**类型错误 / 必填缺失 / 取值越界 → 退出码 2**（如 `auth.session_ttl` 超出 1m–720h、`server.addr` 非回环地址）。`auth.initialized=true` 但哈希为空 → 退出码 2（配置损坏，**不重新生成**，避免覆盖已被运维重置的意图）。SIGHUP 重载失败 → 保留旧快照 + ERROR，不回滚进程。
- **明确不做什么**：不定义或复写配置键（真源在 `DATA-MODEL.md` §3）；不做配置中心/远端拉取/版本管理；不做 schema 迁移（属 store）；不读插件配置（插件自管 `/var/lib/kore/plugins/<id>/` 下文件）；不监听文件变更（零轮询定时器，只认 SIGHUP）。

### 2.2 `internal/core/store`

- **职责**：打开/关闭 bbolt（`0600`、`Timeout=1s`），定义 9 个 bucket：`meta`（schema 版本、安装时间、kore 版本）、`plugins`（清单与安装元数据）、`plugin_state`（desired/actual 状态与重启计数）、`tasks`（**预留 bucket：当前无写入方**，任务原始输出仍落 `/var/lib/kore/tasks/`）、`sessions`（会话哈希→**五段空格分隔元信息** `expiry created lastSeen ip ua`（纳秒戳 + 按 5 分钟节流写回的 `lastSeen` + base64url 的 ip/ua；兼容旧的单 expiry / expiry+created 格式）；另存 `password-fingerprint` 保留键，见 §2.3 与 [DATA-MODEL](./DATA-MODEL.md) §5）、`audit`（审计；按龄清理由 scheduler 内置任务 `builtin-audit-clean` 执行，保留期 `audit.retention` 默认 90 天，见 [DATA-MODEL](./DATA-MODEL.md) §11）、`scheduler_tasks` / `scheduler_runs`（ADR-0019 定时任务与最近 100 条执行记录）、`alerts`（告警中心，顶层桶内嵌套子桶 `events`；保留最近 500 条、同 title+source 5 分钟内合并 count+1、`seen` 已读标记；字段表见 [DATA-MODEL.md](./DATA-MODEL.md) §5）。`scheduler_*` 与 `alerts` 均属 schema v1 的**追加** bucket，旧二进制忽略、不升版本。单管理员无用户表，鉴权凭据来自 `config.yaml` 的 `auth.admin_password_hash`（不建 `users`）。提供 `View`/`Update` 事务封装与错误分类。
- **输入输出**：输入 `path=/var/lib/kore/state.db` 与 bucket/key/value；输出类型化错误：`ErrNotFound`、`ErrConflict`、`ErrCorrupt`、`ErrSchemaTooNew`。值大小上限 1 MiB，超限直接拒绝（大对象是设计错误）。
- **失败模式与处理**：文件锁被占/损坏 → 退出码 4，日志给损坏页偏移与"从 `state.db.bak` 恢复"指引；schema 版本高于二进制 → 退出码 4（拒绝降级写）；磁盘满 → 事务回滚，返回 `E_INTERNAL` 且 `message` 写明"磁盘空间不足"；事务超过 500 ms → WARN（长事务是设计味道）。
- **明确不做什么**：不暴露 SQL/查询语言；不存业务数据；不做跨 bucket 长事务；不做自动修复（损坏只报告，不猜）；不缓存热数据（bbolt 自身 mmap 即缓存）。

### 2.3 `internal/core/auth`

- **职责**：单用户口令校验、会话签发/校验/吊销、登录限速。口令哈希用标准库 `crypto/pbkdf2`（PBKDF2-HMAC-SHA256，迭代 600000，salt 16 B，key 32 B），存储格式 `pbkdf2-sha256$600000$<salt-b64>$<hash-b64>`；口令来源是配置 `auth.admin_password_hash`（无用户表，见 §2.2 store）。会话 token 32 B 随机（`crypto/rand`），`sessions` 的 key 为 token 的 `sha256`（64 位小写 hex），明文 token 不落库；Cookie 名 `kore_session`，`HttpOnly`、`SameSite=Strict`、`Path=/`、HTTPS 下 `Secure`；**会话 TTL 默认 168 h（7 天）**（`auth.session_ttl` 可配置，取值 1m–720h，显式配置优先）；**滑动续期阈值 = `min(24h, ttl/2)`**（7 天实例 24 h、12 h 实例 6 h、1 h 实例 30 m）——只有剩余寿命低于阈值才把 `expires_at` 推到 `now + ttl` 并重发 `Set-Cookie`，相邻两次续期至少间隔 `ttl/2`，因此不会每次鉴权都写 bbolt（消除写放大）；**绝对上限 30 天**（`created + 30d`，滑动不得越过，到点必须重新登录）；**改口令 → 全局吊销所有会话**（启动时比对 `sha256(admin_password_hash)` 指纹，变化即 `RevokeAll`）。登录成功时同时下发两个 cookie：`kore_session`（HttpOnly、SameSite=Strict）与 `kore_csrf`（32 B 随机，`crypto/rand` base64url；`SameSite=Strict`；**不设 HttpOnly**——前端需读取后回填 `X-Kore-CSRF` 头，这正是双提交的机制；不设 Path 限制）；登出与 session 过期时一并失效。`kore_csrf` 与 `kore_session` 绑定同一会话记录，校验时用常量时间比较。
- **首登强制改密状态机（`auth.must_change_password`，[ADR-0055](./DECISIONS/0055-initial-admin-credential.md)，2026-11-25）**：凭据文件 / 哈希落盘时原子写入 `true`；登录校验通过且该标志为真 → 只发**受限会话**（改密端点 / 登出 / 静态壳可用，其余 `/api/v1/*` 返回 403 + 白话「首次登录请先设置新口令」）。改密成功后 `ApplyCredentialSnapshot(hash,false)` 清标志、吊销旧会话、删一次性凭据文件并写 `auth.password_initial_changed` 审计；API token / 插件 bearer 在前序分支处理不走本闸门。这是单管理员一次性状态机，**非 RBAC**（G-11）。SIGHUP 同步：仅当哈希 / 标志真变化时才 `RevokeAll`，普通热更不误踢会话。
- **输入输出**：`POST /api/v1/auth/login {username,password,otp}` → `Set-Cookie` + `{authenticated,expires_at}`（ADR-0057：账号+口令；账号固定单值 `admin`/`auth.admin_username`，账号错与口令错统一 401「账号或口令错误」防枚举，限速 key 不按输入账号分桶）；`POST /api/v1/auth/logout` → 删会话 + 清 Cookie；`GET /api/v1/auth/session` → `{authenticated,expires_at}`（无有效会话时 401）；中间件输入 Cookie，输出 `Session` 或 `401`。
- **登录限速（`ratelimit.go`）**：纯内存计数器，口径取 `security.login_rate_limit`（默认 `attempts=5` / `window=60s` / `lock=300s`）。**先校验口令、再对错误口令施加递增延迟，无锁定期**：正确口令任何时刻直接放行并清零（修复「任意本地进程用错口令永久锁死管理员」的 P1 DoS）；连续失败 6/7/8/9/10/≥11 次分别延迟 1s/2s/4s/8s/16s/30s（封顶），429 `E_RATELIMIT` + `Retry-After`（下一次错误尝试的秒数）。`BeginVerify` 单飞串行化 PBKDF2，让并行爆破吞吐不随连接数放大。单管理员体系下 key 固定 `"admin"` 构成**全局桶**（接口保留 key 参数，供后续 per-IP 分桶），不做 per-IP 桶——UDS 下 `RemoteAddr` 恒为 local，per-IP 桶等同于全局桶，多一层无收益。**零 ticker / 零 AfterFunc / 零后台 goroutine**（G-19）：过期条目在调用路径上按次数惰性清理。**状态只在进程内存，重启清零**（不持久化；持久化限速状态排在 M3）。`security.login_rate_limit.*` 属 SIGHUP 热更白名单，重载后调 `Server.ApplyLoginPolicy` 立刻生效，**已累计的连续失败与惩罚等级不变**，只影响之后的判定与新增惩罚。
- **失败模式与处理**：口令错 → 401 `E_UNAUTHORIZED`，响应耗时恒定在 150–250 ms（防时序侧信道）；连续失败进入惩罚 → 先施加 1s→30s 递增延迟，再 429 `E_RATELIMIT`，`Retry-After` 给下一次错误尝试的秒数；**正确口令始终 200，不受惩罚影响**；会话过期 → 401 `E_UNAUTHORIZED`（服务端不回写清 Cookie，旧 token 已失效，携带它的请求一律 401）；store 不可用 → 500 `E_INTERNAL`；`auth.admin_password_hash` 为空 → 首启 bootstrap（`firstRunBootstrap`）：stderr 是终端时用 `crypto/rand` 生成 24 字符口令（字母表剔除 `0/O/1/I`），把 PBKDF2 哈希与 `auth.initialized=true` 原子写回 serve 自己解析的配置文件，明文口令**只打印到 stderr/tty 一次**（不入配置文件、state、日志文件），本次启动即生效；非终端（systemd / journald / 重定向）**不生成、不打印明文**，只打印 `kored admin-password --generate` 指引。生成失败或配置不可写 → WARN + 不打印明文 + 提示 CLI 兜底（不退出、不降级为空口令）；`auth.initialized=true` 但哈希为空 → 退出码 2（配置不一致，不重新生成）。
- **明确不做什么**：不做多用户/注册/找回密码/RBAC；不做 JWT（避免密钥轮换与吊销难题）；不引入 `golang.org/x/crypto`（bcrypt/argon2 破依赖白名单）；不把会话放进程内存（重启即全员掉线不可接受）。**已实现的安全增强（`security.go`，commit `0a66c10`；详见 [SECURITY](./SECURITY.md) §3.6）**：① **TOTP 两步验证**（RFC 6238 / HMAC-SHA1 / 6 位 / 30 s 周期，允许 ±1 步时钟偏差；开启流程一次性展示 **10 个**恢复码，恢复码单次有效、库中只存 sha256；密钥只在开启时返回一次）——开启后登录 = 口令 + 动态码，**缺 OTP 返回 428 `E_2FA_REQUIRED`**，码错返回 401 `E_2FA_INVALID`；② **登录 IP 白名单**（CIDR 列表，开启后在**口令校验之前**判定，未命中 / 列表为空 / CIDR 无法解析一律拒绝，**403 `E_IP_DENIED`**，fail-closed 且文案不回显白名单）；③ **API token**（`Authorization: Bearer kore_…`，scope 两档：`read` 只放行安全方法、`admin` 放行全部；明文只在创建时返回一次、库中只存 sha256；默认 90 天、上限 365 天；按 id 吊销且幂等）。**三者默认全部关闭**，须管理员在安全页主动开启；边界：2FA 依赖用户自备的 TOTP App（内核不联网、不发短信/邮件），IP 白名单只管登录入口，API token 与 Cookie 会话并存。

### 2.4 `internal/core/httpapi`

- **职责**：路由表、固定顺序中间件链（§3）、JSON 编解码、错误码→HTTP 状态映射、静态与插件资产托管入口、SSE 入口。路由用 Go 1.22+ `net/http.ServeMux` 的方法+路径模式，不引入 Web 框架。
- **输入输出**：输入 HTTP 请求；输出统一 JSON 体 `{code,message,detail}`（成功体直接返回业务 `result`，错误体三字段固定）。路由清单（前缀 `/api/v1`）：业务 `POST /auth/login`、`POST /auth/logout`、`GET /auth/session`、`GET /plugins`、`GET /plugins/{id}`、`POST /plugins`（501 占位，M2 实现）、`POST /plugins/{id}/enable`、`POST /plugins/{id}/disable`、`DELETE /plugins/{id}`（卸载：先优雅停进程 → 原子摘除 `data/plugins/<id>` 整个目录 → 一个事务删除 `plugins` / `plugin_state` 记录 → 写 `plugin.uninstall` 审计；**审计 fail-closed**，写不进去就把目录与记录全部还原并回 503。id 走 `^[a-z][a-z0-9-]*$` 白名单，`..` / 路径分隔符一律 400。需 `system:admin`；幂等口径：**未装 id 回 200 + `already_absent=true`**，不是 404——卸载是幂等动作，404 会把"目标态已达成"报成错误，也与"路由不存在/权限不足"难以区分）、`POST /plugins/{id}/root-action`、`GET /plugins/{id}/root-action/{action_id}/confirm-token`、`POST /invoke/{plugin}/{method}`、`GET /system/info`、`GET /system/metrics`、`GET /system/upgrade`（自升级状态：当前/回滚目标/最近标记；需 `system:admin`）、`POST /system/upgrade`（发起升级：`{source_path,sha256,confirm}`，来源必须是本机绝对路径 + sha256 先校验后替换，URL 一律拒绝；202 + job id；审计 fail-closed）、`GET /system/upgrade/jobs/{id}`（进度轮询，客户端按需拉取，服务端零定时器）、`POST /system/upgrade/rollback`（用 `<bin>.prev` 回滚，同样需 `confirm=true`；审计同上）、`GET /audit`（M4-C 操作审计查询，`since` 必填；**只读筛选 `subject`/`plugin`/`result`/`target`/`q`/`offhours`/`offset`，响应增 `total`/`offset` 回显，筛选只在读取侧、不改写入与 bbolt 结构**，详见 [DATA-MODEL](./DATA-MODEL.md) §9）、`GET /alerts`（告警中心列表，最新在前，`limit` ≤500；需 `system:read`）、`POST /alerts`（显式写入；需 `system:admin`）、`POST /alerts/{id}/seen`（标记已读；需 `system:admin`）、`GET /webhook`（通知通道列表 + 投递历史；需 `system:read`）、`POST /webhook`（新增 Webhook / 邮件 / IM 机器人通道，默认不启用；需 `system:admin`）、`PATCH /webhook/{id}`（启用 / 停用；需 `system:admin`）、`DELETE /webhook/{id}`（删除；需 `system:admin`）、`POST /webhook/{id}/test`（发一条测试消息，不写告警库；需 `system:admin`）、`GET /events`（SSE 任务进度推送）、`POST /credentials`（ADR-0026 凭据创建/更新，需 `system:admin`；请求体 `{owner,name,envVar,secret}`，响应只回 `{id}`）、`GET /credentials`（凭据元数据列表，**永不返回 secret**；可按 `owner` 过滤）、`POST /credentials/{id}/grants`（授权 grantee，审计 fail-closed）、`DELETE /credentials/{id}/grants/{grantee}`（撤销授权，审计 fail-closed）、`DELETE /credentials/{id}`（删除凭据与密文，需 `system:admin`；**先写 `credential.delete` 审计，fail-closed**，审计失败回 `E_AUDIT` 且不删；凭据 5 端点集中为 `POST /credentials` · `GET /credentials` · `POST /credentials/{id}/grants` · `DELETE /credentials/{id}/grants/{grantee}` · `DELETE /credentials/{id}`）、`GET /scheduler/tasks`、`POST /scheduler/tasks`、`PUT /scheduler/tasks/{id}`（就地改表达式 / 周期 / 超时 / 启停；插件与方法不可改，内置任务拒绝）、`GET /scheduler/tasks/{id}/runs`（该任务的执行历史，最新在前，`limit` 缺省 20 / 上限 100；只读内核自己的调度记录，不代理插件业务）、`POST /scheduler/tasks/{id}/run`、`DELETE /scheduler/tasks/{id}`（ADR-0019 定时任务，需 `system:admin`）、`GET /system/restart/confirm-token?reason=...`（签发 reason-bound 一次性重启令牌，5 分钟有效）、`POST /system/restart`（自服务重启：会话 + `system:admin` + reason-bound confirm；缺 confirm → 401，202 = `--no-block` 已提交 ≠ 已生效；并发排队不合并；审计 fail-closed，无可用 unit → 501 `E_NO_SELF_RESTART` + 白话 hint；见 [ADR-0056](./DECISIONS/0056-self-restart.md)）、`POST /system/config`（配置写入：复用 coldChanged 判据，命中 `paths.index_dir` 等冷字段返回 `restart_required: true`，原子写保留注释）、`POST /api/v1/system/self-update`（**ADR-0058 UDS-only 专用更新端点**：独立 socket `<run>/kore-selfupdate.sock` 上的独立 http.Server，不进主 mux/公开门；请求体 `{source_path,sha256,version?,confirm}`，confirm 必填。严格三重鉴权：① 只接受 UDS 连接（loopback TCP/远程 401）；② `SO_PEERCRED` uid ∈ {0, kored uid}，取不到凭据 fail-closed（伪造 uid 403）；③ 单一专用能力 `system:self_update`，**不含 6 项 admin、不进会话能力集**（公开会话持 admin 也不自动拥有）。每次调用写 `system.self_update` 审计（detail 仅 uid/channel/capability/target_version，无凭据字段），审计写不进即 503 且不更新；通过后委托共享 `SelfUpdater`（与进程内编排同语义）。公开门零变化：未登录 UDS 访问 `store/install` 仍 401）；商店：`GET /store/plugins`、`GET /store/plugins/{id}`、`POST /store/refresh`、`GET /store/presets`、`POST /store/install`、`POST /store/update`、`GET /store/jobs/{id}`。共 **72 个端点**（65 业务 + 7 store；其中 ADR-0056 新增 `GET /system/restart/confirm-token` / `POST /system/restart` / `POST /system/config` 3 条，ADR-0057 新增 `GET /auth/captcha` 1 条，ADR-0058 新增 UDS-only `POST /system/self-update` 1 条；固定 501 占位 2 个：`POST /plugins`（M2 实现）与 `GET /store/jobs/{id}`（M3 异步 job 队列：已存在任务回 501、未知 id 回 404）；任务书写作 3 个端点 / 22→25，实际落地 4 条路由，按实数登记）。**端点口径**：`routes()` 中已注册的具体「方法 + 路径」路由，不含 `/api/v1/store/`、`/api/v1/auth/`、`/api/v1/alerts/`、`/api/v1/scheduler/`、`/` 这 5 条 catch-all 兜底；healthz 与静态前缀单列、不计入端点总数（旧文案写 39，现按实际注册数登记为 72）。**交叉核对**：`routes()` 74 条注册 − 6 条兜底 = 68（60 业务 + 7 store + 1 healthz），另 `registerRestartRoutes()` 3 条、`registerLogAlertRoutes`/`registerSiteImportRoutes`/`registerSecurityCenterRoutes` 独立注册、`registerCaptcha` 1 条、ADR-0058 的独立 UDS 专用端点 `POST /system/self-update` 1 条、`staticRoutes()` 2 条；合计 72 个业务 / store 端点（65 业务 + 7 store；端点清单以 §2.4 与 §12.2 为准，上一版 §2.4 残留的「70/63」为漏同步旧值，本轮按实数统一）。**告警写入埋点**（服务端，非前端上传；全部走进程内 `AlertSink`，HTTP 侧的 `POST /alerts` 仅供运维/测试显式写入）：`login.failed` 连续 ≥3 次合并一条（成功登录清零）、`capability.denied` 与 root-action 拒绝（统一 `auditDenied` 出口）、插件 `state=failed` / `restarts>3`（`GET /plugins` 观测时点）、资源红线 RSS>16 MiB / goroutine>20（`GET /system/metrics` 采样时点）、常驻槽位满 resident≥3（`GET /system/info` 时点）；重复场景由持久层 5 分钟同 title+source 去重合并为 `count+1`，全部在请求路径同步发生、不引入轮询（G-19）。另有 `GET /-/healthz` 与 2 条静态前缀（`GET /{$}`、`GET /assets/*`）。**独立注册的端点**（不写 `routes()`，由 `New()` 里的 `registerLogAlertRoutes` / `registerSiteImportRoutes` / `registerSecurityCenterRoutes` 注册，Go 1.22 ServeMux 按最长前缀匹配、注册顺序无关）：日志告警与站点迁移两组之外，**账户与安全中心 5 条**——`GET /security/overview`（账户状态总览：口令强度/上次修改、2FA 开启与恢复码剩余、token 数量与最近使用、登录白名单、活跃会话数、最近登录与异常标记）、`GET /security/sessions`（活跃会话：登录时间 / 来源 IP / UA 摘要 / 最后活跃 / 到期时间，含 `current` 标记）、`DELETE /security/sessions/{id}`（踢单个会话，**拒绝踢当前会话**、提示用登出；需 `system:admin`）、`POST /security/sessions/revoke-others`（一键全踢，保留当前会话；需 `system:admin`）、`GET /security/login-records`（登录成功/失败记录 + 异常标记 `new_network` / `fail_burst` / `rate_limited`，`limit` ≤200、`days` ≤90，需 `system:read`；数据源是既有审计流，不另建登录表）。`GET /api/v1/system/info` 在 capability report 之外附带 `supervisor{resident,restarts,resident_max,lazy_slots}`（常驻插件数 / 历史累计重启 / resident 独占上限 / 仍可供 lazy 使用的槽位）、`paths{state_dir,run_dir,log_dir,index_dir,plugin_dir}`（归一化后的绝对路径，排障用）与 `demotion{enabled,kernel_uid,reason}`（**插件降权是否真的生效**：`enabled=false` 是内核非 root 的合法降级形态，但必须在接口上可见并带 `reason` 与生效办法，不允许只留一条启动 WARN 日志；`true` 时插件确实以 `kore-<id>` 运行）。
- **失败模式与处理**：未知路由 → 404 `E_NOTFOUND`；方法不符 → 405 `E_INVALID`；body 超限 → 413 `E_INVALID`（同时断开连接，不读完剩余字节）；handler panic → recover 记堆栈，500 `E_INTERNAL`；`invoke` 目标插件不存在 → 404 `E_NOTFOUND`，未启用 → 409 `E_CONFLICT`，插件超时 → 504 `E_UPSTREAM`。**`POST /invoke` 转发前按目标插件声明的能力做调用校验**：先查方法级 `method_capabilities[<id>.<method>]`（命中即单独生效），未命中回退插件级 `capabilities`（多项取最高）；内核只认 `system:`/`net:`/`proc:` 前缀，`read` 动作任意已登录会话可调、`write/admin` 动作需 `system:admin`（或会话能力集含该项），宿主前缀下的未知动作 fail-closed；不足 → 403 `E_UNAUTHORIZED`（message 写明所需能力）并写审计 `capability.denied`，插件自有 `<id>:<action>` 不由内核解释（G-01）。**审计按最终生效能力收口**：只有 `write`/`admin` 类写 `invoke.*`，解析为 `*:read` 的方法不写；单用户模式下会话恒持全权、授权仍全放行，方法级能力此时只在审计侧生效。
- **明确不做什么**：不做业务参数校验（交插件）；不直连 bbolt；不直接 `exec` 进程（只调 supervisor）；不实现 WebSocket（SSE 是唯一推送通道）；不做 CORS（同源部署，跨源是设计外）。

### 2.5 `internal/core/registry`

- **职责**：插件包 `<id>-<version>.tar.gz` 校验与原子安装（解压到 `/var/lib/kore/plugins/.staging/<id>-<version>/` 后 `rename` 到 `<id>/<version>/`）；`info.json` 字段校验按 **9 必填 + 3 可选**：必填 `id,name,version,protocol,entry,capabilities[],resources{memory_mb,cpu_quota,pids_max},requires_kore,triggers[]`；可选 `lifecycle`（缺省 `lazy`，G-14）、`scenario_tags`（缺省 `[]`）、`size_bytes`（缺省 `0`）；**`lifecycle` 取值 `resident|lazy|oneshot`（缺省 `lazy`；旧字段名已废弃、不保留别名）**；capabilities 按**两段模型**校验：6 个特权能力（`system:read` `system:admin` `net:read` `net:write` `proc:read` `proc:write`）+ 插件自有 `<id>:<action>`（域必须等于自身 id），**必须非空（至少 1 项、上限 16 项）**，空数组/重复/超限拒绝（详见 PLUGIN-PROTOCOL §3.1.2）；维护 installed/enabled 状态并持久化到 `plugins` bucket。
- **输入输出**：输入 multipart 包（`POST /api/v1/plugins`，body ≤ 32 MiB）或 `{id}` 路径参数；输出插件视图 `{id,name,version,lifecycle,state,capabilities,resources,installedAt}`。安装为原子操作：任何一步失败都清理 `.staging`，不留半装状态。
- **失败模式与处理**：tar 路径穿越（`..`/绝对路径/符号链接逃逸）→ 400 `E_INVALID` 且拒绝整包；缺字段/类型错/版本非 semver → 400 `E_INVALID` 带字段名；同 id 同版本已存在 → 409 `E_CONFLICT`；降级安装（新版本 < 已装）→ 400 `E_INVALID`；解压后总大小 > 128 MiB、单文件 > 64 MiB 或文件数 > 2000 → 400 `E_INVALID`（防 zip bomb）；磁盘满 → 507 语义（映射 `E_INTERNAL` + 明确 message）。
- **明确不做什么**：不做签名密钥管理（M4 才强校验，MVP 只存 `signature` 文件不验）；不做依赖解析（插件是静态二进制）；不启动/停止进程（交 supervisor）；不做插件市场、审核、评分、遥测。

### 2.6 `internal/core/supervisor`

- **职责**：插件进程全生命周期——按清单建 cgroup、以 `kore-<id>` 身份拉起、握手校验、健康探测、退避重启、优雅停止、热升级、孤儿清理。详细参数见 §4。
- **输入输出**：输入 `Manifest`（来自 registry）与动作 `Start|Stop|Restart|Upgrade|Ensure|Reap`；输出插件运行时视图 `{state,pid,startedAt,restarts,lastError}` 与事件（状态迁移写 bus → SSE）。
- **失败模式与处理**：cgroup 不可写（`/sys/fs/cgroup/kore/<id>.slice` 创建失败）→ 插件 `failed`，`detail` 提示"宿主 systemd 需 `Delegate=yes`"；系统用户不存在 → 尝试 `useradd --system` 失败则 `failed` 并给命令原文；socket 被占 → unlink 后重试 1 次；hello 超时/字段不符 → SIGKILL + `failed`；连续重启超阈值 → `failed` 且不再自动重试。
- **槽位保护（RESOURCE-MODEL §2.6 / R5-5）**：同时常驻总数 ≤3，其中 `resident` 独占上限 `resources.resident_max`（默认 2，范围 1–3），即 lazy 至少保留 `max_slots-resident_max` 个槽位。resident 的 `enable` 与 invoke 冷启走同一准入闸门；超限返回 `E_RATELIMIT` + 「常驻插件已达上限 2（推荐 ≤2）；如需启用请先停用其他常驻插件：<当前 resident 列表>」。lazy 唤醒满槽时只驱逐最久未用的 lazy，resident 永不驱逐；启动按 `plugin_state.desired` 恢复时超限的 resident 只 WARN 跳过，不阻止内核启动。`resident_max=3` 表示显式放弃保护（启动 WARN，需重启生效）。
- **明确不做什么**：不做容器/命名空间隔离（cgroup v2 + 系统用户已够，容器是红线④）；不做跨机调度；不解析插件日志内容（只重定向到文件）；不替插件做业务重试。

### 2.7 `internal/core/bus`

- **职责**：帧编解码（4 字节大端长度前缀 + JSON，单帧 ≤ 8 MiB = 8388608 字节）、请求-响应关联、单次调用超时、事件扇出与 SSE 环形缓冲。帧信封：`type` 取 `request|response|event|ping|pong`，请求 `{type:"request",id,req_id,method,params}`，响应 `{type:"response",id,result}` 或 `{type:"response",id,error:{code,message,detail}}`（字段级细节以 `PLUGIN-PROTOCOL.md` 为准）；`id` 为连接内唯一请求标识，`req_id` 透传 HTTP 侧请求标识便于跨进程追日志。
- **输入输出**：`Call(plugin, method, params, timeout) (result, *PluginError)`；`Publish(plugin, event)`；`Subscribe() <-chan Event`。事件 id 为进程内单调 uint64，环形缓冲 256 条（只服务断线补发）。
- **失败模式与处理**：帧长 > 8 MiB 或 < 2 字节 → 断开该连接 + `E_INVALID`（超长帧是攻击或 bug，不尝试读一半）；JSON 解析失败 → `E_INVALID` 并记 method 摘要；调用目标未运行（lazy/oneshot）→ 触发冷启动并排队（上限 32，超限 429 `E_RATELIMIT`）；插件 15 s 不响应（默认，envelope 可覆盖至 120 s）→ 504 `E_UPSTREAM`；连接断开 → 该插件所有在途请求立即 `E_UPSTREAM`（不重试，避免重复副作用）；缓冲满 → 丢最旧 + WARN（事件是通知不是事实来源）。
- **超时与迟到帧**：超时保留连接（帧边界已丢失时才断开），插件迟到写回的响应帧在下一次调用丢弃并重同步，不把上一次超时的残留报成本次 `E_INVALID`。**预算前提**：下一次调用能否成功取决于该次调用的剩余超时预算是否覆盖迟到帧到达时刻——每次 `Call` 都从进入时刻重算预算（`min(CallTimeout, ctx 剩余)`，`internal/core/bus/bus.go:88-100`，默认 15 s，`internal/core/bus/bus.go:23-24`），并在 `internal/core/bus/call.go:81` 用 `SetDeadline` 落成绝对截止时间；迟到帧在该截止时间前到达才会被读到并丢弃重同步（`internal/core/bus/call.go:118-153`），预算不足则再次在帧边界超时并返回 `E_UPSTREAM`（`internal/core/bus/call.go:205-212`，连接仍保留，但仍不是 `E_INVALID`）；只有连续超过 32 个无法关联的响应帧才弃连接并判 `E_INVALID`（`internal/core/bus/call.go:16-22`、`internal/core/bus/call.go:136-141`）。**一次性连接例外**：连接实现 bus 的 `CallFinisher`（当前只有 oneshot 的包装连接）时，`Call` 在返回前（成功/超时/协议错误一律）回调一次 `FinishCall`，由 supervisor 按「一次调用后回收」收尾——否则超时路径既没有响应帧、也没有 Close，进程回收与串行令牌归还会被永久跳过（`ARCHITECTURE` §8、`RESOURCE-MODEL` §5 的 oneshot 超时回收口径）。
- **明确不做什么**：不做消息持久化；不做自动重试（重连由 supervisor 负责）；不保证跨插件事件顺序；不做流式分片（单帧必须完整）。

### 2.8 logger（跨包 `log/slog` 约定，非独立包）

- **职责**：JSON 行日志写 `/var/log/kore/kore.log`（`0640 root:kore`），同时启动期镜像 stderr；字段固定 `ts,level,mod,req_id,msg`，可选 `plugin,method,dur_ms,err_code`；级别由 `log.level` 控制，热更即时生效。
- **输入输出**：`Logger(mod)` 派生带 `mod` 的子 logger；调用方传 `req_id`/`plugin`/`method` 字段；输出单行 JSON（≤ 4 KiB/条，超长截断并记 `truncated=true`）。
- **失败模式与处理**：日志文件不可写 → 降级 stderr 一次 WARN，并在内存保留最近 100 条供 `/system/info` 诊断；磁盘满 → WARN 一次后继续尝试（不阻塞业务）；时间戳统一 RFC3339 带毫秒与本地时区偏移。
- **明确不做什么**：不做轮转（M3 落地：内核 10 MiB × 5、插件 10 MiB × 2，口径见 `DATA-MODEL.md`）；不做聚合/检索/上报；不打口令、Cookie、token、插件 payload 正文、Authorization 头；不在循环内逐条打印（批量操作只记汇总）。

### 2.9 static（`internal/core/httpapi` 包内静态托管，含 embed）

- **职责**：`//go:embed web/dist` 打进二进制；`GET /` 返回 `index.html`（SPA fallback：非 `/api/`、非 `/assets/` 的 404 回落到 index）；`/assets/*` 用构建期预压缩产物（`.gz`/`.br`），按 `Accept-Encoding` 直接发，`Cache-Control: public,max-age=31536000,immutable`；`/plugin-assets/<id>/*` 从 `/var/lib/kore/plugins/<id>/<version>/web/` 读，需会话，`Cache-Control: no-cache`（升级后必须刷新）。
- **输入输出**：输入 URL 路径 + `Accept-Encoding`；输出字节流 + `Content-Type`（按扩展名白名单）+ `ETag`（文件 mtime+size 的 sha256 前 16 位）。
- **失败模式与处理**：插件 web 目录不存在 → 404 `E_NOTFOUND`；路径穿越（`..`、编码后的 `%2e%2e`）→ 400 `E_INVALID`；embed 缺失（构建期未跑 `make frontend`）→ 500 `E_INTERNAL` 且日志提示构建命令；文件读失败 → 503 `E_UPSTREAM`。
- **明确不做什么**：不做 CDN/反向代理；不做动态 gzip（预压缩是构建期职责）；不做目录列表；不托管插件之外的用户文件。

### 2.10 `internal/core/httpapi/sse.go`（任务进度推送，httpapi 包内文件）

- **职责**：`GET /api/v1/events` 的 SSE 入口；只推送**本进程内**的安装/升级任务进度（`task.progress` / `task.done` / `task.failed`），事件源是 `chan` + 进程内扇出中心 `TaskEvents`，不落库、不跨重启、不转发插件事件（插件事件仍走 bus）。
- **输入输出**：输入已鉴权会话；输出 `event: <type>` + `data: {"task_id","phase","percent","message"}` + 空行，`task_id` 固定为 `<plugin-id>@<version>`。阶段由 installer 上报：`download`(0–40) → `verify`(40–60) → `extract`(60–80) → `register`(80–95) → `reload`(95–100)。
- **失败模式与处理**：无 `http.Flusher` 或装配层未注入 `TaskEvents` → 501 `E_UNSUPPORTED`；订阅者通道满（16 帧）→ 丢弃该帧，不阻塞安装主流程；客户端断开 → `r.Context().Done()` 退订并关闭通道，连接级回收。
- **明确不做什么**：不做 WebSocket/双向通道；不做 `Last-Event-ID` 补发与心跳定时器（G-19：禁止后台 goroutine 续命）；不做并发上限与 429（连接随请求生命周期结束）；不做事件持久化或跨进程广播。

### 2.11 `internal/core/envprobe`（启动期探测）

- **职责**：启动第 2 步一次性探测 **10** 项环境能力（平台/架构、OS 版本、AF_UNIX、对端身份、资源后端、委派可写、服务管理器、SELinux、AppArmor、状态目录文件系统）并产出不可变 capability report；按 Tier 判定后绑定 `internal/platform` 五接口。硬要求（平台/架构、OS 版本低于下限、状态目录文件系统）失败 **exit 6**；软要求（cgroup/Job Objects、委派、systemd/SCM/launchd、SELinux、AppArmor）缺失只 WARN + 降级。
- **输入输出**：输入 `*config.Config`（只用 `paths.state_dir`）与只读探测；输出 `Report{arch,os,os_version,tier,kernel,cgroup_mode,cgroup_enforced,delegation,service_manager,selinux,apparmor,peer_identity,fs_type}`（**13 字段**，非适用平台记 `N/A`），由 `cmd/kored` 注入 httpapi，`GET /api/v1/system/info` 原样返回。探测项与矩阵见 [COMPATIBILITY.md](./COMPATIBILITY.md) §5–§7。
- **失败模式与处理**：探测源不可读 → 按"不满足"记 WARN（不猜默认值）；cgroup 试写失败 → 回滚后置 `cgroup_enforced=false`；状态目录 fs ∈ {nfs,smb,cifs}（Windows 网络盘）→ **exit 6**；架构非 amd64/arm64、Linux 内核 < 4.18、Windows < 1809（build 17763）、macOS < 12.0、AF_UNIX 不可用、OS 版本不可读 → **exit 6**。
- **明确不做什么**：不改宿主配置（不写 sysctl、不切 SELinux 模式、不装包）；不重试探测；不缓存跨启动结果；`serve` 之外的 CLI 子命令不跑探测；不把软缺失升级成拒绝启动。

### 2.12 `internal/core/installer`

- **职责**：预设解析（构建期 `//go:embed presets/` 快照 + `--offline-dir` 本地目录优先）、sha256 校验、`requires_kore` 区间校验、依赖 DAG 拓扑排序、按序安装并 enable、**失败整预设回滚**（逆序卸载 + 恢复启用状态 + 清已写状态目录）、运行时预检结果透传（只报缺什么/多大，不装运行时）。
- **输入输出**：输入 `Preset{id,plugins[{id,version_range,optional}],config_template}`（schema 见 [SCENARIOS.md](./SCENARIOS.md) §2）；输出安装计划 `{steps[],resident_quota,disk_bytes,runtime_gaps[]}` 或异步 `job_id`。HTTP `POST /api/v1/store/install|update` 与 CLI `kored install --package <tar.gz>` **共用同一实现**。**实现状态（2026-11-23 核实）**：单包安装链路已落地；**预设解析与 `--scenario` / `--offline-dir` / `--yes` 属 M2 未实现**——CLI 对 `--scenario` 直接返回 `E_UNSUPPORTED` 并列出**当前真实可用**的替代路径（`--package` 单包 / 面板商店逐插件安装），不假装成功。
- **包下载（`InstallFromURL`，索引 `download_url`）**：内核**唯一出站口**——先把已验签索引声明的 `https://` 地址流式拉到 `<state_dir>/tmp/pkg-*/<id>-<version>.tar.gz`，**边下边算 sha256**（不整包读入内存），单包上限 64 MiB（超限立即中止并删临时文件），摘要必须与索引声明一致才交回 `Install` 复用本地包安装链路；摘要不符/超限/非 200 一律拒并删除临时目录。只允许 `https://`（拒 `http://` / `file://` / `gopher://` 等），客户端 60 s 总超时且禁用 keep-alive（G-19：装完不留空闲连接）。失败不落盘：`defer` 删下载目录 + `Install` 自清 staging。
- **授予记录（`granted_capabilities`）**：落 `plugins` bucket，与声明同一事务写入，字段 `granted_by/granted_at/version/declaration_sha256/capabilities[]/added_capabilities[]`（DATA-MODEL §5）。默认放行：安装按声明授予（`install:auto`）；升级声明新增能力时自动扩展并记 `upgrade:auto` + 待确认项（WARN + 审计 `capability.grant_extended`，不阻断）；显式 `POST /plugins/{id}/enable` 确认（`enable:<subject>`，清空待确认项并审计 `capability.grant_confirmed`）；存量库启动回填（`legacy:backfill`）。内核只做字符串集合比较，能力语法与域归属仍由安装期校验负责（G-01）。
- **失败模式与处理**：预设 id 未知 / 版本区间不可解析 → 400 `E_INVALID`；sha256 不符 → 400 `E_INVALID`（不落盘）；`requires_kore` 不满足 → 409 `E_UNSUPPORTED`；常驻配额超限（>3 个或 >24 MiB）→ **安装前** 409 `E_CONFLICT` 并给"需先停用 <id>"建议；包下载失败 / 下载内容与索引声明摘要不符 → **502 `E_UPSTREAM`**（market 按 installer 错误分类映射，可重试或换源）；任一步失败即整预设回滚，回滚自身失败则写 `audit` 并保留现场（不删证据）。
- **明确不做什么**：不实现第二条安装链路——下载安装与本地包安装共用同一套校验/解包/落位/落库（下载只多"拉到临时文件 + 摘要比对"一步），URL 与 sha256 只能来自已验签索引、不由本包决定；不安装运行时（运行时由插件调宿主包管理器，kore 不下载）；不做版本求解（只按索引区间取满足的最高版并 pin）；不做包签名校验（M4 由 market 负责 ed25519）。
- **运行期安装约束（state.db 独占锁）**：`serve` 常驻时以独占方式持有 `state.db`，CLI `kored install --package`（`--scenario` 未实现，M2）同为独立进程、会争同一把锁并退出码 3（状态库被占用）——**这是设计使然，不是缺陷**。serve 运行时请走 `POST /api/v1/store/install`（经同一 installer 校验落盘，并由装配层**真正重载** registry/supervisor：运行中的旧版本先 Stop → 丢弃旧 instance → 从状态库与磁盘重新装载新版本清单 → `Replace` 登记 → 按持久化 `desired_state` 决定是否拉起）；同 id 升级后 `GET /plugins` 报新版本、新方法可直接调用，无需重启内核；`POST /store/update` 走同一重载路径。响应新增 `reload` 字段（`reloaded` / `restarted`）与升级语义字段 `previous_version`（安装前版本，首次安装为空）、`stale_versions`（磁盘上残留的旧版本目录名，**不自动删除**，供前端提示清理），重载失败显式 500 而非假装成功。重载成功后若新清单声明了 `post_upgrade`（可选，完整方法名），内核按声明经 bus 调用一次（15s 上限，lazy 插件为此冷启一次、随后按 `idle_timeout_s` 回收）。**`desired_state=enabled` 的重载立即执行**；`desired=disabled` 时只登记新版本、**不拉起进程**，但若本次是升级（版本确实变化）且清单声明了 `post_upgrade`，装配层落一个「待补跑」标记（`plugin_state.post_upgrade_pending` = 新版本），用户随后 `Enable` 成功时补跑一次并清空——既不在禁用态拉起插件（尊重用户意图），又保证启用后不会带着未迁移的旧外部引用上线；首次安装/同版本重装不是升级，不留标记也不误跑（见 `PLUGIN-PROTOCOL` §12 第 6 步）。内核只读声明、不认识动作语义（G-01），失败不阻断安装但写 WARN + 告警，禁止静默。`GET /api/v1/plugins` 的每条已装记录由 httpapi 用已验签索引对齐 `latest_version` / `latest_sha256` / `update_available`（纯数据对齐，不判升级方向，G-01）。CLI install **仅离线使用**（serve 未启动）。**离线升级不经过重载，但不会丢迁移**：安装器在落库时若发现「旧版本 → 新版本」且新清单声明了 `post_upgrade`，直接写同一条 `plugin_state.post_upgrade_pending`（值 = 新版本），CLI 同时打印待补跑提示；下次 `serve` 启动恢复 `desired=enabled` 时经 `Enable` 消费并补跑一次，禁用态插件则在用户下次启用时补跑。首次安装与同版本重装不留标记。

### 2.13 `internal/core/privilege`（提权通道，ADR-0018）

- **职责**：校验 `info.json.root_actions` schema；用 `os/exec` **直接执行固定 argv**（ADR-0049：不经 `systemd-run`、不经 shell、不依赖 systemd / polkit）；签发/核销不可回滚动作的一次性 `confirm` 令牌；构造 `root.action` 审计事件并 **fail-closed**（审计写失败 → 动作不执行，返回 `E_INTERNAL`）。**进程树回收**：`internal/platform` 收口 `Setpgid` + `kill(-pgid, SIGKILL)`，超时 / 取消时父与所有后代一起回收（`systemd-run` 时代由 unit cgroup 提供的唯一真实价值，由本层保住）。
- **宿主变更账本（ADR-0049 §5.1，`hostwrite.go`）**：`root_actions[].writes_host=true` 的动作**成功**（`exit_code=0` 且未超时）后，经 `ChangeRecorder` 单方法接口追加一条 `changes.jsonl`（`summary`/`target`/`purge_op`，见 DATA-MODEL §9.1）——用户能在账本里看到"软件替我用 root 改了什么、怎么退回去"。**账本未装配时写宿主动作 fail-closed**（`deny_reason=change_ledger_unavailable`，不执行）；账本写失败不回滚已执行动作，但 WARN 留痕且响应里 `host_change_recorded=false`。**降级**：`writes_host=true` 但无结构化 `purge_op` → `NeedsConfirm=true`，按不可逆动作要求一次性 `confirm` 令牌（`confirm-token` 端点用同一判据，避免"降级了却拿不到令牌"）。回滚只按白名单 `purge_op` 分派，**账本内永不存 shell 字符串**。
- **边界**：不认识 `ufw`/`nginx` 等业务语义（G-01）；不直接 import `store`（审计走 `Auditor` 单方法接口，装配层写 bbolt）；不引入常驻进程（ADR-0016）；插件永远拿不到 root。
- **执行契约**：请求只能给 `action_id` + 追加参数（拼在声明 argv 之后，不能替换 argv[0]）；审计标识 `kore-root-<plugin>-<action>-<rand>`（串起 begin/end 两条记录，不再是 transient unit 名）；超时 / 取消 kill **整棵进程组**；`LC_ALL=C`、无 shell、stdout/stderr 各上限 1 MiB；`exit_code` 是**被调命令的真实退出码**（`exec.ExitError.ExitCode()`，`exit 42` → 42；超时 / 未执行归一为 -1）。
- **降级**：非 root → `E_NEED_ROOT`（带 `detail.hint`）。**无 systemd 不再是降级条件**（容器 / Alpine / Tier B 照常执行）；`E_NO_SYSTEMD` 常量保留做协议兼容但**不再触发**；平台无进程组语义（非 Unix）→ 显式 `E_UPSTREAM`，禁止静默降级为「只杀直接子进程」。
- **端点**：`POST /api/v1/plugins/{id}/root-action` 需 `system:admin`（或目标插件自身的 bearer 身份 + 该插件已获 `system:admin`）；`GET .../confirm-token` 只允许管理会话签发，5 分钟一次性。

### 2.14 `internal/core/market`（软件商店，HTTP 前缀 `/store`）

- **职责**：索引缓存 `/var/lib/kore/store/index.json`（`0600`，含 `id,name,version,requires_kore,sha256,size_bytes,depth_level,scenario_tags`）、**显式刷新**（`POST /store/refresh`，唯一联网入口）、安装/更新任务队列（异步 job）、本地目录导入、出站白名单（仅 refresh 与包下载两处，运行期零后台出站）。
- **输入输出**：`GET /store/plugins` 读本地缓存（零出站，可带 `stale=true`）；`POST /store/install|update` → `{job_id}`，`GET /store/jobs/{job_id}` 轮询进度；`DELETE /store/plugins/{id}` 卸载；`GET /api/v1/store/presets` 见下（M3-D）。
- **`POST /api/v1/store/install` 请求体（来源三选一，显式字段）**：`package_path` 走本地包（离线场景）；`download=true` + `id`/`version` 从**已验签索引**取 `download_url` 与 `sha256` 下载安装——URL 不接受请求体传入（防 SSRF），协议只允许 `https://`，缺 `sha256` 或 `download_url` 的条目直接拒；两者同给按歧义 400 拒，都不给 400 并提示二选一。`force=true` 允许覆盖已装同版本（修复/重装）：装配层先停用插件、installer 备份旧目录后覆盖，失败回滚并把旧插件拉回，成功按原 `desired_state` 重载；不带 force 的同版本安装返回 **409 `E_CONFLICT`**。失败码：上游不可达/摘要不符 → 502 `E_UPSTREAM`，索引或包结构非法 → 400 `E_INVALID`。索引验签失败返回 401 `E_UNAUTHORIZED`，错误体带 `requires_restart:true` 与「若刚更新过索引，需重启 kored 重新载入公钥」提示（签名判定本身不变）。
- **`GET /api/v1/store/presets`（M3-D）**：从环境变量 `KORE_PRESETS_DIR` 读取预设目录，按 id 升序返回预设元数据。
- **缺省行为**：未设 `KORE_PRESETS_DIR` 时**返回空列表，不是错误**；缺省不指向索引仓，也不是 embed 快照。
- **验签顺序**：该端点先过 market 强制验签门；索引验签失败即 401，且**不读预设**。
- **失败模式与处理**：索引缺失/过期 → 200 + `stale=true`（不阻塞首装，用 embed 快照兜底）；刷新失败 → **保留旧缓存**并返回 `E_UPSTREAM`（禁止清空）；job 不存在 → 404 `E_NOTFOUND`；包 sha256 不符 → job `failed` + `E_INVALID`；同一插件并发安装 → 409 `E_CONFLICT`。
- **明确不做什么**：不做审核 / 账号 / 评分 / 评论；不做自动后台刷新（**零轮询**，G-19）；不代理第三方下载（按索引 URL 取包后**自算 sha256**，索引不是信任源）；不长期存包（安装完成即删临时文件）。
- **端点实现状态（2026-11-23 核实；终态规格见上文"输入输出"）**：7 个 store 路由均已注册——`GET /store/plugins`、`GET /store/plugins/{id}`、`POST /store/refresh`、`GET /store/presets`、`POST /store/install`、`POST /store/update`、`GET /store/jobs/{id}`。**路由接通 ≠ 功能完成**：`GET /store/jobs/{id}` 的 handler 固定返回 **501 `E_UNSUPPORTED`**（异步 job 队列 M3 落地）；`GET /store/presets` **只返回元数据、不支持批量安装**（商店预设卡片「一键安装」为禁用态，批量预设安装 M2 未实现）；`DELETE /store/plugins/{id}` 未注册（卸载走 `DELETE /api/v1/plugins/{id}`）。

### 2.15 `internal/core/scheduler`（定时任务，ADR-0019）

- **职责**：内核**唯一**的周期执行器。单个 ticker（30s 检查）扫描 `scheduler_tasks` 中 `next_run_at <= now` 的任务，到点调用 `Invoker.Invoke(plugin, method, params)`（oneshot 调用面），写 `scheduler_runs` 执行记录并推进下次时间；不认业务语义，只搬运 `{plugin, method, params}`（G-01）。
- **输入输出**：任务 `{id,name,plugin,method,params,schedule|interval_s,enabled,timeout_s,next_run_at,last_run_at,last_result,missed_count}`（`schedule` 即 5 段 cron 表达式；字段名按 thin-shell 名词表取语义等价词，见 ADR-0019「命名决策」）；表达式 5 段（分 时 日 月 周，自写解析、零依赖），支持 `*` / `n` / `a-b` / `a,b` / `*/n` / `a-b/n`；`cert_renew.enabled=true` 时迁移为内置任务（`plugin="kore"`、`method="cert.renew_due"`），原独立 ticker 不再创建。审计按龄清理同为内置任务（`builtin-audit-clean`、`method="audit.clean"`，默认启用；保留期/周期/单次上限取 `audit.retention` / `audit.clean_interval` / `audit.clean_batch`），由 scheduler 直接执行（需要状态库句柄），仍复用同一 ticker。日志切割与清理是**插件任务**（`builtin-logs-maintain`、`plugin="logs"`、`method="logs.maintain"`、默认 6h、默认启用）：内核只负责到点调一次，策略由插件按出厂预设执行（见 [DATA-MODEL](./DATA-MODEL.md) §11），不新增 ticker。
- **内置任务身份约束**：`plugin="kore"` 是内核伪插件保留名，**API 不能创建**（`POST /api/v1/scheduler/tasks` 回 400 `E_INVALID`，任务不落库）；内置任务只由内核注册（`builtin-cert-renew` / `builtin-audit-clean`，id 固定）。`audit.clean` 只接受固定 id `builtin-audit-clean`，其他任务 id 一律拒绝并留 `audit.clean(result=error)` 审计，清理参数硬下限 `retention_seconds ≥ 24h`、`batch` 1–10000（ADR-0044）。
- **内置任务 `update.check`**（`builtin-update-check`，ADR-0019 修订 / ADR-0059 §3.1，U4）：与 `cert.renew_due` 同挂在**唯一** ticker 上，不新增周期源；默认**禁用**（`update.source.enabled=false` / 源地址空，不落任务行、零出站，`enabled=true` 但源空或检查器未装配则拒绝注册 fail-closed）。`IsOffline` 为真（或未注入判定）时直接短路记 `offline_skipped`、零出站、不报错；验签失败（`E_UNAUTHORIZED`）的错误 detail 含 `requires_restart:true`、本次不更新。真实「已验签索引 → https → sha256」供应链由装配层注入（M6），调度器不自行联网（G-10）。
- **生命周期**：`Start` 恢复任务（停机期间 `next_run_at` 已过 → 记 `missed`、**不补跑**、从 now 重算）→ 有启用任务才起 ticker（默认零后台定时器）；任务全禁用/删除后 ticker 停掉；`Stop` 取消循环。同一任务不并发（执行中再触发记 `skipped` + WARN）；单任务超时默认 300s（可配 1–3600s），超时记 `timeout`；运行时迟到 >5min 视为 `missed`。
- **失败模式与处理**：表达式非法 / 参数非对象 / `schedule` 与 `interval_s` 同给或都不给 → 400 `E_INVALID`；任务不存在 → 404 `E_NOTFOUND`；执行中手动触发或任务已禁用 → 409 `E_CONFLICT`；内置处理器或插件调用面未装配 → 执行失败并记 `failed`（不假装成功）；单条任务记录损坏 → 跳过 + WARN（不猜内容、不自动删）。
- **端点**：`GET /api/v1/scheduler/tasks`、`POST /api/v1/scheduler/tasks`、`PUT /api/v1/scheduler/tasks/{id}`、`GET /api/v1/scheduler/tasks/{id}/runs`、`POST /api/v1/scheduler/tasks/{id}/run`、`DELETE /api/v1/scheduler/tasks/{id}`，全部要求 `system:admin`。
- **就地改计划（PUT /{id}）**：只接受 `name` / `params` / `schedule` / `interval_s` / `timeout_s` / `enabled`，缺省字段沿用原值；`schedule` 与 `interval_s` 互斥（同时给回 400），只给一个就切到该模式并清空另一个。校验复用创建路径的 `normalize`（不另写一套），保留 `id` / `created_at` / `missed_count` / `last_run_at` / `last_result`，`next_run_at` 立即重算。目标插件与方法不可改（改了就是另一条任务，请删除后重建）；`plugin="kore"` 的内置任务拒绝就地修改（启动时会被配置回填）。
- **执行历史（GET /{id}/runs）**：读 `scheduler_runs` 中该任务的记录，最新在前，`limit` 缺省 20、上限 `maxRuns`（100），保留口径写进响应 `note`。这是**内核自己的调度记录**，不是代理插件业务——crontab 任务的逐次执行日志由 cron 插件的 `cron.runlog` 提供，前端直接调插件方法（G-01）。
- **明确不做什么**：不做秒级精度、不做 per-task 时区、不做分布式锁与跨机调度、不做业务参数校验、不写系统 crontab（那是插件自治）、不主动联网（G-10）。

### 2.16 `internal/core/credential`（托管凭据库，ADR-0026 方案 A）

- **职责**：凭据只落 `<install>/data/credentials/`（目录 `0700`）、元数据 `index.json`（`0600`，字段显式）、每条密钥 `<id>.secret`（`0600`，原子写）；读取只对 owner 或显式 grantee 放行，越权返回 `E_NEED_GRANT`；授权 / 撤销 / 删除先写审计（`credential.grant` / `credential.revoke` / `credential.delete`），审计写失败按 **fail-closed** 拒绝（`E_AUDIT`），操作不生效。
- **输入输出**：`Set` / `Get` / `Grant` / `Revoke` / `List` / `Delete` / `EnvFor(pluginID)`；HTTP 侧 5 个端点集中为 `POST /credentials` · `GET /credentials` · `POST /credentials/{id}/grants` · `DELETE /credentials/{id}/grants/{grantee}` · `DELETE /credentials/{id}`，响应只回 `{id}` 或元数据，**永不返回 secret**。
- **失败模式与处理**：既非 owner 也无授权 → `E_NEED_GRANT`；审计写失败 → `E_AUDIT` 且授权 / 删除不生效；secret 与索引均为原子写（临时文件 → rename），失败不留半文件。
- **明确不做什么**：不写日志、不回显 secret（G-30）；结构体字段全部显式、不用 `map[string]any`（G-24）；不做外部 KMS / 加密托管（方案 A 是文件权限模型），也不把 secret 写进配置、state 或日志。

### 2.17 `internal/core/filewrite`（受控文件写原语，ADR-0028 一期）

- **职责**：只往白名单目录下的文件写受控内容——路径规范化 + 白名单前缀校验（拒绝 `..`、非规范路径、软链接目标与父目录）、内容 ≤ 256 KiB 且禁 NUL、`mode ∈ {0644,0600,0640}`、写前备份到 `<copyRoot>/<plugin>/<timestamp>/`（备份失败即中止）、审计 **fail-closed**（审计写不进去就不写文件，只记 sha256 / size / mode / 备份路径，不记全文）、原子替换（同目录 `O_CREAT|O_EXCL` 临时文件 → chmod → fsync → rename → fsync(dir)）。
- **输入输出**：`ValidatePath` / `ValidateContent` / `ValidateMode` / `ValidatePlugin` 先校验，再由 `Write(Options)` 落盘并返回 `Result`（sha256 / size / mode / 备份路径），不返回文件全文。
- **失败模式与处理**：路径越界（`..`、非规范、软链逃逸）→ 拒绝且不落盘；内容超 256 KiB 或含 NUL → 拒绝；`mode` 不在白名单 → 拒绝；备份失败 → 中止（不留未备份的新内容）；审计失败 → 不写文件（fail-closed）。
- **明确不做什么**：不做内容语义校验（内核不认识 sshd / nginx 语法，G-01）；不做整文件替换以外的变更集（ADR-0028 §7 复审条件 3）；白名单只允许 drop-in 片段目录——这不是「任意路径写」。

### 2.18 `internal/core/metrics`（请求路径惰性资源采样）

- **职责**：在请求路径上惰性采集宿主资源快照——**零后台 goroutine、零周期定时器**（G-19）：每次 `Collect` 现读 `/proc`，CPU 百分比用两次 `/proc/stat` 差值算、基线懒缓存；进程启动时刻在包初始化时记录，用于 uptime。
- **输入输出**：`Collect() (Snapshot, error)`；`Snapshot{CPUPercent,RSSKiB,DiskUsedKiB,DiskTotalKiB,Load1,Goroutines,FDs,UptimeSec,TakenAt}` 字段与 HTTP 契约一一对应，由 `GET /api/v1/system/metrics` 原样返回，并供 `GET /system/metrics` 观测点的资源红线告警埋点（RSS > 16 MiB / goroutine > 20）。
- **失败模式与处理**：当前构建目标无采样实现 → `ErrUnsupported`（Tier B 降级**必须可见，不静默填 0**）；首次采样只建立基线、无差值可算；`/proc` 读取失败 → 返回错误，不虚构数值。
- **明确不做什么**：不起后台采样 goroutine、不注册周期定时器（周期只允许 scheduler）；不存历史序列（无时序库，客户端按需轮询）；不做跨平台指标归一（缺失走 `ErrUnsupported` 降级，不伪造读数）。

## 3. 中间件链

顺序**固定**，禁止调换或跳层（调换即评审拒绝）。拒绝时状态码与错误码如下：

| # | 层 | 作用 | 拒绝时 |
| --- | --- | --- | --- |
| 1 | `req_id` | 读 `X-Request-Id`，缺失则生成 16 hex；注入 ctx 与响应头 | 不拒绝（无输入可拒） |
| 2 | `recover` | 捕获 panic，记堆栈 | 500 `E_INTERNAL` |
| 3 | `access_log` | 记 `method,path,status,dur_ms,req_id` | 不拒绝 |
| 4 | `body_limit` | `/invoke` 8 MiB；`POST /plugins` 32 MiB；其余 64 KiB（硬上限 1 MiB） | 413 `E_INVALID` |
| 5 | `auth` | 校验 `kore_session`；豁免 `POST /auth/login`、`GET /-/healthz`、`GET /`、`GET /assets/*` | 401 `E_UNAUTHORIZED` |
| 6 | `csrf` | 校验 `X-Kore-CSRF` 头与 `kore_csrf` cookie 双提交（常量时间比较）；豁免 `GET`/`HEAD`/`OPTIONS`、`POST /auth/login`（尚无会话）、`GET /-/healthz` | 403 `E_UNAUTHORIZED` |
| 7 | `rate_limit` | `/auth/login` 连续失败 5 次后 1s→30s 递增延迟（全局桶，key=`admin`，正确口令放行，见 §2.3）；`/invoke` 120 次/60 s/会话 | 429 `E_RATELIMIT` |
| 8 | `router` | 匹配路径与方法，进入 handler | 404 `E_NOTFOUND` / 405 `E_INVALID` |

设计理由：`csrf` 必须在 `auth` 之后（先有会话才有 token 可比对）、在 `rate_limit` 之前（拒绝伪造请求不应消耗业务限速桶）；`rate_limit` 放在 `auth` 之后，未登录流量不消耗业务限速桶（登录接口自身有独立桶）；`body_limit` 放在 `auth` 之前，超大 body 不进入鉴权与业务路径；`recover` 必须在 `access_log` 之前才能记录 500 的真实来源。`GET /-/healthz` 绕过 auth、csrf 与 rate_limit，`access_log` 降为 DEBUG（避免探活刷日志）。

## 4. supervisor 规格

### 4.1 拉起参数

| 项 | 值 |
| --- | --- |
| 可执行文件 | `/var/lib/kore/plugins/<id>/<version>/bin/<id>`（`info.json.entry` 相对包根） |
| 运行身份 | 系统用户/组 `kore-<id>`（uid/gid 由 `useradd --system --no-create-home` 提供，主壳启动时确保存在）；另加入通道共享组 `kore`，随 `Credential.Groups` 获得该 gid |
| cgroup | `/sys/fs/cgroup/kore/<id>.slice`：`memory.max = resources.memory_mb × 1 MiB`；`cpu.max = "<cpu_quota> 100000"`；`pids.max = resources.pids_max` |
| 环境变量 | 注入插件的固定 5 个：`KORE_PLUGIN_ID`、`KORE_PLUGIN_SOCK`、`KORE_PLUGIN_TOKEN`（hello HMAC 用，Windows 必需）、`KORE_STATE_DIR=/var/lib/kore/plugins/<id>`、`KORE_LOG_DIR=/var/log/kore/plugins`；通道启用时另加 `KORE_KERNEL_SOCK=<run>/kore-channel.sock`；另固定注入 `KORE_PLUGIN_DATA=<data>/plugin-data/<id>`（数据根，0700、属主 `kore-<id>`，与只读安装树分离——安装树是 `<data>/plugins/<id>/<version>`，不能作数据根）与 `KORE_INSTALL_DIR=<install>`（只读资源定位）（**内核侧另有 `KORE_CONFIG` / `KORE_STATE_DIR` / `KORE_PLUGIN_DIR` / `KORE_PROFILE` / `KORE_HOME` 五个配置覆盖变量，不注入插件**，见 §2.1）；任务目录为 `<KORE_STATE_DIR>/tasks`（派生，不另设 env）；协议版本与 capabilities 来自 `info.json` 与 `kore.hello`，**不设环境变量**（无 `KORE_SOCKET` 等别名） |
| socket | 主壳**作为 server** 先 bind `/run/kore/plugins/<id>.sock`（`chmod 0600`、`chown kore-<id>`；其它插件用户既读不到也连不上），插件以 client 身份 `connect` |
| 提权通道 socket | `<run>/kore-channel.sock`（`root:kore 0660`，只接受插件 bearer + `SO_PEERCRED(uid,pid)` 双校验的 `root-action`；管理入口 `kore.sock` 仍 `0600 root:root`） |
| 工作目录 | `/var/lib/kore/plugins/<id>`（`0700 kore-<id>`），插件不得写工作目录之外 |
| stdout/stderr | 重定向到 `/var/log/kore/plugins/<id>.log`（`0640 root:kore`），内核不解析内容 |
| umask | `0077` |

### 4.2 健康检查

握手：插件 `connect` 后 **2 s 内**必须发 `kore.hello`，含 `{id,version,protocol,pid,capabilities[]}`。校验 `id`/`version`/`protocol` 与清单一致、`capabilities` ⊆ `info.json` 声明且已授予；任一不符 → SIGKILL → `failed`。

存活：`kore.ping` 每 **10 s** 一次，单次超时 **2 s**。连续 **3 次**超时 → `degraded`（暂停路由新调用，返回 503 `E_UPSTREAM`），继续探测；60 s 内无任何成功响应（≈连续 **6 次** ping 失败）→ 重启；任一 ping 成功 → 回 `ready` 并清零计数。

### 4.3 lazy 管理与配额仲裁

- **空闲判定**：supervisor 记 `last_used_at`（任何 call 或事件命中即刷新）；空闲满 **300 s** 进入 drain：停接新调用 → 等在途 ≤2 s → `kore.shutdown` → 5 s → `SIGKILL` → 删 socket，状态回 `enabled`（不是 `stopped`，否则下次无法自动唤醒）。
- **进程回收**：`waitpid` 后断言 RSS=0、`pgrep` 为 0；lazy 插件**不得内部起 ticker 续命**，否则记问题单（F-06 同类：常驻化绕过配额）。
- **冷启动互斥**：同一插件同时只允许 1 次 cold start，并发请求并入队列（**上限 32**），超限返回 429 `E_RATELIMIT`；hello 失败则整队返回 `E_UPSTREAM`。
- **配额仲裁**：resident 同时 **≤3 个、合计 ≤24 MiB、单个 ≤12 MiB**；启用第 4 个时**拒绝**并提示"需先停用 <id>（最久未用）"，不自动踢人；`resources.profile=compact` 时降为 1 个 / ≤12 MiB。
- **明确不做**：不预热多个插件、不跨插件共享冷启动队列、不为 lazy 保留"半退"进程。

### 4.4 重启退避

间隔序列 `1s → 2s → 4s → 8s → 16s → 32s → 60s`（上限 60 s，之后恒定 60 s）。稳定运行 **10 分钟**后计数清零。**10 分钟窗口内重启 5 次** → 置 `failed`，停止自动重启，需人工 `enable` 或重新安装。退避期间状态保持 `starting`，插件中心显示下次重试倒计时。**`starting` 阶段的失败同样计入重启次数**（hello 超时、进程秒退、cgroup 建立失败都算一次）——它与退避共同构成"每插件 1 s 内最多拉起 1 次"的速率限制，防止 hello 失败后 1 s 内无限重拉形成重启风暴。

### 4.5 优雅停止

**停止序列**：主壳向插件 socket 发送 `kore.shutdown` 帧 → 等待 **≤5 s** → 超时 `SIGKILL` → `stopped`（记 `killed=true`）。**不发 `SIGTERM`**——插件是独立进程，`kore.shutdown` 即其优雅停止信号；主壳不直接调用 `syscall.SIGTERM`（G-16：平台专有 API 收口在 `internal/platform`）。进程在 5 s 内退出 → `stopped`。之后删 socket、删 cgroup 目录、清理 `run.json`。关闭流程总预算 ≤ 12 s，systemd `TimeoutStopSec=15` 兜底。**时延来自配置项，不是硬编码**：上面两个等待分别是 `supervisor.Options.ShutdownGrace`（默认 **5 s**，`internal/core/supervisor/manager.go:29`；未显式配置时由 `internal/core/supervisor/options.go:86-87` 填空）与 SIGKILL 之后的兜底等待 `defaultKillWait`（**2 s**，`internal/core/supervisor/manager.go:30`），由 `internal/core/supervisor/stop.go:52-57` 串联执行——`kored` 未显式配置 `ShutdownGrace` 时**最坏回收时延 ≈ 7 s**（5 s 优雅期 + 2 s 兜底）。oneshot 的「一次调用后回收」走同一 `Stop` 路径（`internal/core/bus/call.go:176` 的 `finishCall` → `internal/core/supervisor/oneshot.go:95` 的 `FinishCall` → `internal/core/supervisor/oneshot.go:53` 的 `finishOneshot` → `m.Stop`），回收时延同样取决于该配置；任何「X 秒内必须回收」的断言都必须显式收紧该值（独立复验用 200 ms，`internal/core/supervisor/oneshot_timeout_test.go:95`），**默认值下未实测**。

### 4.6 热升级

1. registry 校验新包（id 相同、版本更高、协议兼容 `kore.plugin.v1`）。
2. 解压到 `/var/lib/kore/plugins/<id>/<newVersion>/`，不覆盖旧版本目录。
3. 为新进程 bind 临时 socket `/run/kore/plugins/<id>.next.sock`，拉起新进程。
4. 新进程 hello ≤ 2 s 且校验通过 → registry 把路由与 socket 指向新进程；失败 → SIGKILL 新进程，保留旧进程，升级失败返回 409 `E_CONFLICT`。
5. 对旧进程发 `kore.shutdown`，5 s → `SIGKILL`（**不发 `SIGTERM`**，理由同 §4.5：G-16 信号收口）。
6. 删除旧 socket，把 `<id>.next.sock` 重命名为 `/run/kore/plugins/<id>.sock`；后续调用按 registry 记录的 socket 路径寻址（不硬编码）。
7. 旧版本目录保留 1 份用于回滚（`POST /plugins/{id}/upgrade` 带 `rollback=true` 可回退），再升级时删除更旧的版本。

### 4.7 孤儿进程清理

每个运行中的插件写 `/var/lib/kore/plugins/<id>/run.json`：`{pid,start_time,version,socket,started_at}`，`start_time` 取 `/proc/<pid>/stat` 第 22 字段（clock ticks）。主壳启动时逐条核对：pid 存在 **且** `start_time` 一致 **且** `/proc/<pid>/comm` 匹配 id → 判定为孤儿，`SIGTERM` → 5 s → `SIGKILL`；任一项不匹配 → 只删 socket 文件，不动进程（防 pid 复用误杀）。无法读取 `/proc`（权限）→ WARN 并跳过，不猜。

## 5. 单实例锁

```
open("/run/kore/kore.lock", O_CREAT|O_RDWR, 0600)
flock(fd, LOCK_EX|LOCK_NB)   // 失败 → 读文件内容里的 pid，stderr 提示 "kore already running (pid=N)"
ftruncate(fd,0); write(fd, "<pid>\n")
// fd 持有到进程退出，不主动 unlink 文件（避免 inode 竞争）
```

失败退出码 **3**。为什么用 flock 而不是纯 pid 文件：pid 文件在崩溃后残留、pid 会复用，flock 由内核在进程退出时自动释放，文件是否存在无关。`/run` 是 tmpfs，重启自动清空，不会留下"幽灵锁"。

## 6. 配置热重载边界

触发方式只有 **SIGHUP**（零轮询定时器）。流程：重新解析 → 与当前快照 diff → 应用白名单字段 → INFO 记 `config.reloaded` 与应用字段列表。不可热更字段变化时：**不修改运行值**，WARN 列出需重启的字段名。

| 键（`DATA-MODEL.md` §3 路径） | 可热更 | 说明 |
| --- | --- | --- |
| `log.level` | 是 | 下一条日志即生效 |
| `log.rotate.max_size_mb`、`log.rotate.max_backups` | 是 | 下一次写入/轮转生效 |
| `auth.session_ttl` | 否 | 当前实现未接热更：SIGHUP 只替换配置快照，`auth.Manager` 的 TTL 在启动装配时拷贝（`serve_runtime.go` 构造后无 setter），改后需重启内核才生效——新会话签发与续期判断都按旧值 |
| `auth.admin_password_hash` | 否 | 哈希只在启动装配时读取（SIGHUP 只更新配置快照，运行中的校验仍按旧口令）；**重启时比对 `password-fingerprint`，哈希变了就 `RevokeAll` 吊销全部旧会话**——改口令 = 全局下线，无需手工 kick |
| `security.login_rate_limit.attempts`、`.window`、`.lock` | 是 | 只影响之后的判定与新增惩罚，已累计连续失败不变 |
| `audit.invoke_all` | 是 | 下一次 invoke 审计生效（只影响写审计范围，不影响授权） |
| `resources.defaults.memory_mb`、`.cpu_quota`、`.pids_max` | 是 | 只对之后拉起的插件生效；已运行进程的 cgroup 不改 |
| `resources.enforce` | 是 | 下一次限额写入生效 |
| `plugins.allow_unsigned` | 是 | 下一次安装校验生效 |
| `plugins.autostart` | 否 | 启动序列已执行，改后需重启内核 |
| `server.*` 中的**超时类**字段（读 / 写 / 空闲超时；当前 `DATA-MODEL.md` §3 未登记，登记后按本行规则热更） | 是 | 只对之后建立的连接生效，已有连接不变 |
| `server.socket`、`server.addr`、`server.tls` | 否 | 需重新 bind，重启内核 |
| `paths.state_dir`（任务卡曾写 `server.state_dir`，键名以 `DATA-MODEL.md` §3 的 `paths.*` 为准）、`paths.log_dir`、`paths.run_dir`、`paths.plugin_dir` | 否 | 目录与文件句柄已打开 |
| `web/dist` 静态资源（embed） | 否 | 编进二进制，需重新构建 |
| `cert_renew.enabled`、`cert_renew.interval` | 是 | 唯一允许的常驻定时器，默认关闭；`enabled=false` 时不创建任何 ticker |

证书续期检查是唯一允许的常驻定时器（默认关闭，即"默认零后台定时器"）：开启后按配置周期（默认 `6h`）检查一次，**只发事件** `kore.event{type:"cert.renew_due"}` 委托插件处理，内核不做 ACME、不联网。开关与周期以 `DATA-MODEL.md` §3 的 `cert_renew.enabled`（默认 `false`）/ `cert_renew.interval`（默认 `6h`）为唯一真源；`enabled=false` 时内核不创建任何 ticker，严格守住「默认零后台定时器」。内核不新增未登记配置键。

## 7. systemd unit 样例

> **profile 说明（ADR-0023）**：下面这份是 **`fhs` profile**（系统路径）的样例，需要 `KORE_PROFILE=fhs` 或显式 `paths.*`；`portable`（默认）安装目录自包含，`ExecStart` 只需 `kored serve`，无需 `--config` / `KORE_CONFIG` / `KORE_STATE_DIR`，状态落在 `<install>/data`、socket 在 `<install>/run`、日志在 `<install>/logs`。

```ini
[Unit]
Description=kore thin kernel
Documentation=file:///usr/share/doc/kore/ARCHITECTURE.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/kored --config /etc/kore/config.yaml
Environment=KORE_CONFIG=/etc/kore/config.yaml
Environment=KORE_STATE_DIR=/var/lib/kore
Restart=on-failure
RestartSec=2
TimeoutStopSec=15
KillMode=mixed
Delegate=yes
LimitNOFILE=65536
RuntimeDirectory=kore
RuntimeDirectoryMode=0700
StateDirectory=kore
StateDirectoryMode=0700
LogsDirectory=kore
LogsDirectoryMode=0750
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/kore /var/log/kore /run/kore /sys/fs/cgroup/kore
NoNewPrivileges=no

[Install]
WantedBy=multi-user.target
```

内存调优（三者均由 `cmd/kored/serve.go` 的 `setRuntimeLimits()` **显式设置**（锚点在此钉死），且都可被同名环境变量覆盖，供消融实验）：运行时默认 **`GOGC=50` + `GOMEMLIMIT=6MiB`（`debug.SetMemoryLimit(6 << 20)`）+ `GOMAXPROCS` 上限 8（仅 CPU>8 时收敛）**。依据（M1-02 实测）：默认档空载 **8472 KiB 超预算**，调整后 **7832 KiB**；详见 ADR-0015。为什么不调高 GOGC：GOGC 越高，下一次 GC 在 live heap 的更高倍数处触发，只会放大堆峰值；GOMEMLIMIT 是软上限，GC 会为守住上限更主动。**systemd unit 里不再单独设 `GOGC`**，以 `main` 的显式设置为准（环境变量仍可覆盖）。

要点：`Delegate=yes` 让 `/sys/fs/cgroup/kore` 归本 unit 管，主壳才能创建 `<id>.slice`；`Restart=on-failure` 与 `RestartSec=2` 是"内核崩了 2 s 回来"的兜底；`LimitNOFILE=65536` 覆盖 SSE + 插件连接；`ReadWritePaths` 精确列出运行期写入点，其余文件系统只读；`NoNewPrivileges=no` 是 M0/M2 的临时妥协（创建插件用户需要 setuid），M3 收窄 capability 后必须改回 `yes` 并写 ADR。改完执行 `systemctl daemon-reload && systemd-analyze verify /etc/systemd/system/kore.service`。

## 8. 错误处理与日志约定

错误码 → HTTP 状态映射（唯一权威表，插件错误体原样透传并按下表映射）：

| code | HTTP | 语义 | 典型场景 |
| --- | --- | --- | --- |
| `E_INVALID` | 400 | 入参/包格式非法 | 未知字段、缺字段、tar 穿越、帧超长 |
| `E_UNAUTHORIZED` | 401 / 403 | 未认证 / 已认证但无权 | 无会话、会话过期、调用 `kore.*` 保留方法 |
| `E_NOTFOUND` | 404 | 目标不存在 | 插件未安装、路由不存在、资产缺失 |
| `E_CONFLICT` | 409 | 状态冲突 | 同版本已装、插件未启用、升级失败 |
| `E_UPSTREAM` | 502 / 504 | 下游失败 / 超时 | 插件崩溃、调用超时、帧断开 |
| `E_INTERNAL` | 500 | 内核内部错误 | store 失败、panic、磁盘满 |
| `E_UNSUPPORTED` | 501 | 明确不支持 | 协议版本不兼容、方法未实现 |
| `E_RATELIMIT` | 429 | 触发限速 | 登录暴力尝试、SSE 超 64 连接 |

分层规则：HTTP 层只做状态码映射与用户可读 `message`；内核层用 `fmt.Errorf("...: %w", err)` 保留错误链，`errors.Is/As` 分类；插件层错误体三字段原样透传，`message` 面向用户、`detail` 面向日志（可含路径与错误原文，不含 payload）。

日志级别语义：**ERROR** 需人工介入或状态进入 `failed`（cgroup 不可写、store 损坏、插件连续重启耗尽）；**WARN** 可自愈降级（degraded、重试、热重载失败）；**INFO** 状态迁移与关键动作（启停、安装、配置重载、就绪）；**DEBUG** 帧摘要（method/字节数/耗时，不含正文）。`req_id` 必带，插件帧的 `req_id` 字段由主壳透传，便于 `grep <req_id> /var/log/kore/kore.log /var/log/kore/plugins/*.log` 串起一次调用。

## 9. 内核"永不膨胀"守卫

全部落成 `make gate` 的检查项，M1 起进 CI；任一失败即不得合并。**膨胀告警的处置顺序**：先看是否多了**设计要素**（模块 / 依赖 / 进程 / 定时器 / 转发层），再看是否多了**代码量**，最后才看参数——对应 [VISION.md](./VISION.md) §7 原则 1「设计优化优先于代码优化」。

| # | 守卫 | 命令 | 判据 |
| --- | --- | --- | --- |
| 1 | 禁反向依赖 | `go list -deps ./cmd/kored \| grep -c 'kore-plugin-'` | 输出 `0`（插件在独立仓库，kore 不得 import） |
| 2 | 依赖白名单 | `go list -m all` 与白名单逐项比对 | 直接依赖 ≤ 3 且仅 `yaml.v3`/`bbolt`/`protobuf`(M3) |
| 3 | 业务词表 | `grep -rniE "wordpress\|nginx\|mysql\|redis\|backup\|站点\|数据库\|证书签发" internal/core/ --include=*.go` | 零命中（含注释） |
| 4 | 禁 SQL | `grep -rniE "database/sql\|INSERT INTO\|SELECT .* FROM\|gorm" internal/` | 零命中 |
| 5 | 禁出网客户端 | `grep -rn "http.Client\|net.Dial" internal/ pkg/` | 零命中（server 侧监听不算） |
| 6 | 定时器白名单 | `grep -rn "time.NewTicker\|time.NewTimer\|time.AfterFunc" internal/` | 周期源仅 `internal/core/scheduler/`（单实例单 ticker，ADR-0019）；`time.NewTimer` 仅允许请求级且必须 `Stop()` |
| 7 | 行数预算 | `find internal/ pkg/pluginapi -name '*.go' \| xargs wc -l` | 合计 ≤ 8000 行（M1 实测后校准，超 10% 需 ADR）；单文件 ≤ 400 行 |
| 8 | 协议可独立实现 | `go test ./pkg/pluginapi/...` 含帧编解码往返与超长拒绝用例 | 全绿 |
| 9 | 二进制体积 | `du -b bin/kored` | ≤ 26214400 字节（25 MiB） |
| 10 | 空载内存 | `ps -o rss= -p $(pgrep -x kored)` 60 s 中位数 | ≤ 8192 KiB |

守卫 7 的 8000 行是**初值**，M1 实测后按实际内核规模校准一次，校准结果写入 ADR；校准只能一次性调整基线，不得每次超限就调高——那叫改尺子，不叫达标。

## 10. CLI 入口（`kored` 子命令）

`kored` 是单二进制：**无子命令时等价 `kored serve`**；子命令用标准库 `flag` 手写分发，不引 cobra/urfave（G-02）。**唯一权威清单是 `kored help`**：已实现 `serve`（默认）/ `version` / `install` / `audit` / `uninstall` / `status` / `upgrade` / `admin-password` / `help`；**没有** `db` / `backup` / `restore` / `invoke` / `store` 子命令（`cmd/kored/main.go:37-62`）。

| 子命令 | 作用 | 起 HTTP / 插件进程 |
| --- | --- | --- |
| `serve`（默认） | 启动主壳（§4–§7 全流程） | 是 |
| `db dump` / `backup` / `restore` | **未实现**：无对应子命令，照敲得到「未知子命令」退出码 2。替代：停机手工流程见 [DATA-MODEL](./DATA-MODEL.md) §10 与 [OPERATIONS](./OPERATIONS.md) §2（停服 → `bbolt` / `tar` → 校验 → 恢复） | 否 |
| `invoke <plugin> <method>` | **未实现且不再计划**（ADR-0046 裁决 B2）：没有对外的 CLI 唤醒入口。一次性调用走 `POST /api/v1/invoke/{plugin}/{method}`（登录会话 + `X-Kore-CSRF`）；定时唤醒走内核 scheduler（ADR-0019，`POST /api/v1/scheduler/tasks`），由 bus 按需拉起插件 | 否 |
| `install --scenario <id>` | **未实现（M2）**：当前返回 `E_UNSUPPORTED` 并列出替代路径（`--package` 单包 / 面板商店逐插件安装；无批量预设一键装） | 否 |
| `install --package <tar.gz>` | 单包安装（离线/内网） | 否 |
| `version` | 版本 / 协议版本（`cmd/kored/main.go:40-42`；**不打印 commit**，`kored --version` 不是有效写法） | 否 |

退出码沿用 `DATA-MODEL.md` §7 码表（2 配置 / 3 状态目录或锁 / 4 存储或 schema / 5 监听绑定 / 6 环境硬要求不满足），子命令失败码与 `serve` 一致；`serve` 之外子命令执行完即退出，不留后台进程、不注册 systemd。

## 11. 与其他文档的关系

| 文档 | 关系 |
| --- | --- |
| [VISION.md](./VISION.md) | 上位目标与量化判据；本文任何数字与之冲突时以 VISION 为准并回改本文 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 组件图、进程模型、状态机、故障域；本文是其模块级展开 |
| [GLOSSARY.md](./GLOSSARY.md) | 术语、反术语与命名约定；字段名/错误码/方法名的唯一解释 |

> 规格的价值不在"写得很全"，在于 implementer 照着写不会跑偏、verifier 照着测能给出红绿。本文任何一条"明确不做什么"被实现，就是内核开始膨胀的第一天。
- **职责**：凭据只落 `<install>/data/credentials/`（目录 `0700`）、元数据 `index.json`（`0600`，字段显式）、每条密钥 `<id>.secret`（`0600`，原子写）；读取只对 owner 或显式 grantee 放行，越权返回 `E_NEED_GRANT`；授权 / 撤销 / 删除先写审计（`credential.grant` / `credential.revoke` / `credential.delete`），审计写失败按 **fail-closed** 拒绝（`E_AUDIT`），操作不生效。
## 12. ADR-0057 账号模型与登录防护口径补充（2026-11-25；§0–§11 原文不动）

> 本节 append-only 补充 §2.1 / §2.3 / §2.4 中已被 ADR-0057 推进的字段与端点口径；[ADR-0057](DECISIONS/0057-login-account-model.md) accepted，实现 commit `b1f7e59` / `ee724d5` / `b5480a6` / `7af792f` 等。

### 12.1 配置字段 `auth.admin_username`（§2.1 补充）

- **类型 / 默认**：显式 string（G-24，无 `any/object`），默认 `admin`；老配置缺失 / 空归一 `admin`（无需写盘即可登录）；显式值 2–32 位、小写字母开头的小写字母 / 数字 / 中划线 / 下划线；首启统一入口幂等写回同一 0600 配置。
- **冷字段**：`reload.go` 的 `coldChanged` 收 `auth.admin_username`，SIGHUP **不热更**（提示重启），`mergeHot` 不含该字段；避免会话 / 限速主体与配置分叉。单一事实源在 config，**不进 state.db**（§2.2 的无用户表口径不变）。
- **限速默认值**：`security.login_rate_limit.attempts` 由 5 改 **1**（宽容次数），键名与热更白名单不变；`lock` 仍 300s，仅清延时等级、不清验证码挑战态。

### 12.2 登录 / 改密请求体与失败防护端点（§2.3 / §2.4 补充）

| 端点 | 请求 / 响应 | 口径 |
| --- | --- | --- |
| `POST /api/v1/auth/login` | body `{username,password,otp,captcha_id,captcha_answer}` | 账号 → IP 白名单 → 验证码（挑战态才要）→ 口令 → OTP → 签发；账号错与口令错统一 401「账号或口令错误」防枚举，账号错不动限速桶 / 挑战态；限速 key 固定 `"admin"` 不按输入分桶。首次口令错置 `captcha_required`，第 2 次起 1s→30s 递增延时，正确口令 0s 并清零；`Retry-After` 给下一次错误延迟秒数 |
| `GET /api/v1/auth/captcha` | 响应 `{captcha_id,image,text_question,expires_in}` | **新增独立注册端点**（`server.go` 的 `mux.HandleFunc`，不写 `routes()`）；`middleware.isPublicPath` 放行（GET 安全方法，不放宽 CSRF），登录前可拉取；stdlib PNG 点阵字形 + 文本加法题双通道；challenge 只存内存（sha256 + TTL 2 分钟 + 一次性）；端点自身 10 次/分钟限流；缺 / 错 / 过期分回 428 `E_CAPTCHA_REQUIRED` / 401 `E_CAPTCHA_INVALID`，不计口令失败 |
| `POST /api/v1/auth/password` | body `{username,current_password,new_password}` | `username` 必填（缺 400 / 错 403「账号不匹配，无法修改口令」）；会话 + 双提交 CSRF 两道门保留；成功后清 must_change、吊销旧会话、删一次性凭据文件、写审计（只记元数据）。失败闭环「先吊销 → 再持久化 → 后切内存」不变 |

**端点计数变化**：§2.4 的 **70 → 71 → 72** 个业务 / store 端点（ADR-0057 新增 `GET /api/v1/auth/captcha` 1 条，ADR-0058 新增 UDS-only `POST /api/v1/system/self-update` 1 条；`POST /auth/login` 与 `POST /auth/password` 是既有路由的请求体扩展，不新增路由数）。独立注册策略与 ADR-0056 的 3 条重启路由、账户与安全中心 5 条、ADR-0058 的独立 UDS 专用端点一致，Go 1.22 ServeMux 最长前缀匹配、**注册顺序无关**；不计入 `routes()` 的 5 条 catch-all 兜底，healthz 与 2 条静态前缀仍单列。根 [AGENTS.md](../AGENTS.md) §6 与 [README.md](../README.md) 文档表已同轮同步为 72（65 业务 + 7 store）；逐条清单以 §2.4 与本节为准。

**must_change 非阻断**（§2.3 补充）：`auth.must_change_password` 键名保留，但不再把会话降权——登录成功即签完整会话，取消对 `/api/v1/*` 的 403 闸门；会话鉴权通过后由 `notePasswordHint` 挂响应头 `X-Kore-Password-Hint: 1`，前端显示可关闭白话提示。SIGHUP 仅在哈希 / 标志真变化时 `RevokeAll`，普通热更不误踢会话。

实现复核与门禁证据见 [ADR-0057 §6](DECISIONS/0057-login-account-model.md)、[account-t123.md](../.agents/verify/account-t123.md)、[account-t4-bruteforce.md](../.agents/verify/account-t4-bruteforce.md)。