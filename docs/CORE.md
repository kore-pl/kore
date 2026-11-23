> 状态: draft · 归属: architect · 更新: 2026-11-21 · 里程碑: M0

# CORE — 内核规格

## 0. 文档定位

| 项 | 内容 |
| --- | --- |
| 读者 | implementer（照此实现）、verifier（照此验收）、red-team（照此攻击） |
| 作用 | 把"内核只定规则"落成 10 个模块的字段级规格：职责、输入输出、失败模式、明确不做 |
| 不作用 | 不写组件图与进程模型（见 [ARCHITECTURE.md](./ARCHITECTURE.md)）、不写愿景（见 [VISION.md](./VISION.md)）、不写业务插件规格 |
| 硬约束 | 依赖白名单 3 个（`yaml.v3`、`bbolt`、M3 的 `protobuf`）；`internal/core` 禁 import `plugins/**`；禁 SQL/Web 框架/出网客户端 |
| 版本基线 | MVP 0.1.0；协议 `kore.plugin.v1`；帧上限 8 MiB；术语以 [GLOSSARY.md](./GLOSSARY.md) 为准 |

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

14 个小节中，`config/store/auth/registry/supervisor/bus/httpapi` 对应 `internal/core` 的 7 个子包；`installer`（§2.12）、`privilege`（§2.13，ADR-0018 提权通道）与 `market`（§2.14）是 M2 新增内核模块（包名用 `market` 避开 §2.2 持久化 `store`，对外 API/UI 仍叫「商店」）；`logger`、`static`、`sse` 物理上是 `internal/core/httpapi` 的包内子包（不单开顶层目录，避免"7 个子包"契约漂移）；`envprobe`（§2.11）是启动期一次性探测，放 `cmd/kored/envprobe`，不进内核规则集。

### 2.1 `internal/core/config`

- **职责**：内置默认值 → `/etc/kore/config.yaml` 覆盖 → 环境变量覆盖 → 字段校验 → 不可变 `Config` 快照；SIGHUP 时重新解析并按 §6 白名单热替换。优先级：内置默认 < 配置文件 < 环境变量。**内核侧配置覆盖变量共 3 个**：`KORE_CONFIG`（改配置路径）、`KORE_STATE_DIR`（覆盖 `paths.state_dir`）、`KORE_PLUGIN_DIR`（覆盖 `paths.plugin_dir`）。**另有 1 个可选环境变量 `KORE_PRESETS_DIR`**：预设目录，供 §2.14 `GET /api/v1/store/presets` 读取，缺省为空即预设列表返回空列表（非错误），不是 config 覆盖变量、不计入上述 3 个。**派生规则**：`paths.state_dir` 解析优先级 = `KORE_STATE_DIR` > `--state-dir` > 配置 `paths.state_dir` > `/var/lib/kore`；`paths.plugin_dir` 解析优先级 = `KORE_PLUGIN_DIR` > 配置 `paths.plugin_dir` > **`<state_dir>/plugins`（未显式设置时派生）**。即只设 `KORE_STATE_DIR=/tmp/x` 时，状态库为 `/tmp/x/state.db`、插件目录自动为 `/tmp/x/plugins`（M1 修复：此前 `plugin_dir` 写死，与 `state_dir` 脱节）。**路径归一化**：所有 `paths.*`（含派生 `plugin_dir`）在加载末段统一 `filepath.Abs + Clean` 成绝对路径，覆盖来源（配置文件 / 环境变量 / `--state-dir`）同样生效——supervisor 切换 `cmd.Dir` 后不再出现相对路径失配；相对值归一化时逐项写 WARN，便于日志核对，且 `GET /api/v1/system/info` 的 `paths` 段可查。**不支持 `~` 家目录展开**：`paths.*` 以 `~` 开头直接退出码 2（明确报错，不静默拼成 `<cwd>/~`）。键名与默认值以 `DATA-MODEL.md` §3 为唯一真源。
- **输入输出**：输入为配置文件路径（`KORE_CONFIG`）、`KORE_STATE_DIR`、`KORE_PLUGIN_DIR` 与 `--state-dir`，输出 `*Config`（各模块只读引用）+ `[]ValidationError`；字段组为 `server.*` / `auth.*` / `paths.*` / `log.*` / `resources.*` / `plugins.*` / `security.*` / `audit.*`，逐键定义见 `DATA-MODEL.md` §3，本文件不复制。
- **失败模式与处理**：文件不存在 → 用内置默认值 + WARN，继续启动；只有真正必填项缺失才拒绝启动（退出码 2）——`auth.admin_password_hash` **不是**必填项，空值走 §2.3 的首启 bootstrap。YAML 语法错 → stderr 报行号，退出码 2。**未知字段 → WARN + 继续启动**，附最接近的合法键名拼写建议（不因拼写把服务打死）。**类型错误 / 必填缺失 / 取值越界 → 退出码 2**（如 `auth.session_ttl` 超出 1m–720h、`server.addr` 非回环地址）。`auth.initialized=true` 但哈希为空 → 退出码 2（配置损坏，**不重新生成**，避免覆盖已被运维重置的意图）。SIGHUP 重载失败 → 保留旧快照 + ERROR，不回滚进程。
- **明确不做什么**：不定义或复写配置键（真源在 `DATA-MODEL.md` §3）；不做配置中心/远端拉取/版本管理；不做 schema 迁移（属 store）；不读插件配置（插件自管 `/var/lib/kore/plugins/<id>/` 下文件）；不监听文件变更（零轮询定时器，只认 SIGHUP）。

### 2.2 `internal/core/store`

- **职责**：打开/关闭 bbolt（`0600`、`Timeout=1s`），定义 6 个 bucket：`meta`（schema 版本、安装时间、kore 版本）、`plugins`（清单与安装元数据）、`plugin_state`（desired/actual 状态与重启计数）、`tasks`（任务索引，原始输出落 `/var/lib/kore/tasks/`）、`sessions`（会话哈希→过期时间）、`audit`（审计，保留 90 天）。单管理员无用户表，鉴权凭据来自 `config.yaml` 的 `auth.admin_password_hash`（不建 `users`）。提供 `View`/`Update` 事务封装与错误分类。
- **输入输出**：输入 `path=/var/lib/kore/state.db` 与 bucket/key/value；输出类型化错误：`ErrNotFound`、`ErrConflict`、`ErrCorrupt`、`ErrSchemaTooNew`。值大小上限 1 MiB，超限直接拒绝（大对象是设计错误）。
- **失败模式与处理**：文件锁被占/损坏 → 退出码 4，日志给损坏页偏移与"从 `state.db.bak` 恢复"指引；schema 版本高于二进制 → 退出码 4（拒绝降级写）；磁盘满 → 事务回滚，返回 `E_INTERNAL` 且 `message` 写明"磁盘空间不足"；事务超过 500 ms → WARN（长事务是设计味道）。
- **明确不做什么**：不暴露 SQL/查询语言；不存业务数据；不做跨 bucket 长事务；不做自动修复（损坏只报告，不猜）；不缓存热数据（bbolt 自身 mmap 即缓存）。

### 2.3 `internal/core/auth`

- **职责**：单用户口令校验、会话签发/校验/吊销、登录限速。口令哈希用标准库 `crypto/pbkdf2`（PBKDF2-HMAC-SHA256，迭代 600000，salt 16 B，key 32 B），存储格式 `pbkdf2-sha256$600000$<salt-b64>$<hash-b64>`；口令来源是配置 `auth.admin_password_hash`（无用户表，见 §2.2 store）。会话 token 32 B 随机（`crypto/rand`），`sessions` 的 key 为 token 的 `sha256`（64 位小写 hex），明文 token 不落库；Cookie 名 `kore_session`，`HttpOnly`、`SameSite=Strict`、`Path=/`、HTTPS 下 `Secure`；TTL 12 h，剩余 < 2 h 时滑动续期。登录成功时同时下发两个 cookie：`kore_session`（HttpOnly、SameSite=Strict）与 `kore_csrf`（32 B 随机，`crypto/rand` base64url；`SameSite=Strict`；**不设 HttpOnly**——前端需读取后回填 `X-Kore-CSRF` 头，这正是双提交的机制；不设 Path 限制）；登出与 session 过期时一并失效。`kore_csrf` 与 `kore_session` 绑定同一会话记录，校验时用常量时间比较。
- **输入输出**：`POST /api/v1/auth/login {username,password}` → `Set-Cookie` + `{username,expiresAt}`；`POST /api/v1/auth/logout` → 删会话 + 清 Cookie；`GET /api/v1/self` → 当前用户；中间件输入 Cookie，输出 `Session` 或 `401`。
- **登录限速（`ratelimit.go`）**：纯内存滑动窗口计数器，口径取 `security.login_rate_limit`（默认 **60 s 窗口内失败 5 次即锁 300 s**）。`Allow(key)` 在口令校验**之前**判定，锁定期内连正确口令也回 429 `E_RATELIMIT` + `Retry-After`（秒，向上取整、最小 1）；口令错记 `RecordFailure`，登录成功 `RecordSuccess` 清零。单管理员体系下 key 固定 `"admin"` 构成**全局桶**（接口保留 key 参数，供后续 per-IP 分桶），不做 per-IP 桶——UDS 下 `RemoteAddr` 恒为 local，per-IP 桶等同于全局桶，多一层无收益。**零 ticker / 零 AfterFunc / 零后台 goroutine**（G-19）：过期条目在 `Allow`/`Record*` 调用路径上按次数惰性清理。**状态只在进程内存，重启清零**（不持久化；持久化限速状态排在 M3）。`security.login_rate_limit.*` 属 SIGHUP 热更白名单，重载后调 `Server.ApplyLoginPolicy` 立刻生效，**已累计的窗口计数与进行中的锁定不变**，只影响之后的判定与新锁定。
- **失败模式与处理**：口令错 → 401 `E_UNAUTHORIZED`，响应耗时恒定在 150–250 ms（防时序侧信道）；超限 → 429 `E_RATELIMIT`，`Retry-After` 给剩余秒数；会话过期 → 401 且清 Cookie；store 不可用 → 500 `E_INTERNAL`；`auth.admin_password_hash` 为空 → 首启 bootstrap：用 `crypto/rand` 生成 24 字符口令（base32 字母表剔除 `0/O/1/I`），写回 PBKDF2 哈希并置 `auth.initialized=true`，明文口令**只打印到 stderr/tty 一次**（不进日志文件，日志只记 `auth.admin_initialized`）；生成失败、配置文件不可写，或 `auth.initialized=true` 但哈希为空 → 退出码 2（不降级为空口令启动）。
- **明确不做什么**：不做多用户/注册/找回密码/2FA/RBAC；不做 JWT（避免密钥轮换与吊销难题）；不引入 `golang.org/x/crypto`（bcrypt/argon2 破依赖白名单）；不把会话放进程内存（重启即全员掉线不可接受）。

### 2.4 `internal/core/httpapi`

- **职责**：路由表、固定顺序中间件链（§3）、JSON 编解码、错误码→HTTP 状态映射、静态与插件资产托管入口、SSE 入口。路由用 Go 1.22+ `net/http.ServeMux` 的方法+路径模式，不引入 Web 框架。
- **输入输出**：输入 HTTP 请求；输出统一 JSON 体 `{code,message,detail}`（成功体直接返回业务 `result`，错误体三字段固定）。路由清单（前缀 `/api/v1`）：业务 `POST /auth/login`、`POST /auth/logout`、`GET /auth/session`、`GET /plugins`、`GET /plugins/{id}`、`POST /plugins`（501 占位，M2 实现）、`POST /plugins/{id}/enable`、`POST /plugins/{id}/disable`、`POST /plugins/{id}/root-action`、`GET /plugins/{id}/root-action/{action_id}/confirm-token`、`POST /invoke/{plugin}/{method}`、`GET /system/info`、`GET /system/metrics`、`GET /audit`（M4-C 操作审计查询，`since` 必填）、`GET /events`（501 占位）；商店：`GET /store/plugins`、`GET /store/plugins/{id}`、`POST /store/refresh`、`GET /store/presets`、`POST /store/install`、`POST /store/update`、`GET /store/jobs/{id}`。共 **22 个端点**（15 业务 + 7 store，其中 2 个 501 占位）；另有 `GET /-/healthz` 与 2 条静态前缀（`GET /{$}`、`GET /assets/*`）。`GET /api/v1/system/info` 在 capability report 之外附带 `supervisor{resident,restarts}`（常驻插件数 / 历史累计重启）与 `paths{state_dir,run_dir,log_dir,index_dir,plugin_dir}`（归一化后的绝对路径，排障用）。
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
- **明确不做什么**：不做容器/命名空间隔离（cgroup v2 + 系统用户已够，容器是红线④）；不做跨机调度；不解析插件日志内容（只重定向到文件）；不替插件做业务重试。

### 2.7 `internal/core/bus`

- **职责**：帧编解码（4 字节大端长度前缀 + JSON，单帧 ≤ 8 MiB = 8388608 字节）、请求-响应关联、单次调用超时、事件扇出与 SSE 环形缓冲。帧信封：`type` 取 `request|response|event|ping|pong`，请求 `{type:"request",id,req_id,method,params}`，响应 `{type:"response",id,result}` 或 `{type:"response",id,error:{code,message,detail}}`（字段级细节以 `PLUGIN-PROTOCOL.md` 为准）；`id` 为连接内唯一请求标识，`req_id` 透传 HTTP 侧请求标识便于跨进程追日志。
- **输入输出**：`Call(plugin, method, params, timeout) (result, *PluginError)`；`Publish(plugin, event)`；`Subscribe() <-chan Event`。事件 id 为进程内单调 uint64，环形缓冲 256 条（只服务断线补发）。
- **失败模式与处理**：帧长 > 8 MiB 或 < 2 字节 → 断开该连接 + `E_INVALID`（超长帧是攻击或 bug，不尝试读一半）；JSON 解析失败 → `E_INVALID` 并记 method 摘要；调用目标未运行（lazy/oneshot）→ 触发冷启动并排队（上限 32，超限 429 `E_RATELIMIT`）；插件 15 s 不响应（默认，envelope 可覆盖至 120 s）→ 504 `E_UPSTREAM`；连接断开 → 该插件所有在途请求立即 `E_UPSTREAM`（不重试，避免重复副作用）；缓冲满 → 丢最旧 + WARN（事件是通知不是事实来源）。
- **明确不做什么**：不做消息持久化；不做自动重试（重连由 supervisor 负责）；不保证跨插件事件顺序；不做流式分片（单帧必须完整）。

### 2.8 `internal/core/logger`（`log/slog`，无第三方）

- **职责**：JSON 行日志写 `/var/log/kore/kore.log`（`0640 root:kore`），同时启动期镜像 stderr；字段固定 `ts,level,mod,req_id,msg`，可选 `plugin,method,dur_ms,err_code`；级别由 `log.level` 控制，热更即时生效。
- **输入输出**：`Logger(mod)` 派生带 `mod` 的子 logger；调用方传 `req_id`/`plugin`/`method` 字段；输出单行 JSON（≤ 4 KiB/条，超长截断并记 `truncated=true`）。
- **失败模式与处理**：日志文件不可写 → 降级 stderr 一次 WARN，并在内存保留最近 100 条供 `/system/info` 诊断；磁盘满 → WARN 一次后继续尝试（不阻塞业务）；时间戳统一 RFC3339 带毫秒与本地时区偏移。
- **明确不做什么**：不做轮转（M3 落地：内核 10 MiB × 5、插件 10 MiB × 2，口径见 `DATA-MODEL.md`）；不做聚合/检索/上报；不打口令、Cookie、token、插件 payload 正文、Authorization 头；不在循环内逐条打印（批量操作只记汇总）。

### 2.9 `internal/core/static`（含 embed）

- **职责**：`//go:embed web/dist` 打进二进制；`GET /` 返回 `index.html`（SPA fallback：非 `/api/`、非 `/assets/` 的 404 回落到 index）；`/assets/*` 用构建期预压缩产物（`.gz`/`.br`），按 `Accept-Encoding` 直接发，`Cache-Control: public,max-age=31536000,immutable`；`/plugin-assets/<id>/*` 从 `/var/lib/kore/plugins/<id>/<version>/web/` 读，需会话，`Cache-Control: no-cache`（升级后必须刷新）。
- **输入输出**：输入 URL 路径 + `Accept-Encoding`；输出字节流 + `Content-Type`（按扩展名白名单）+ `ETag`（文件 mtime+size 的 sha256 前 16 位）。
- **失败模式与处理**：插件 web 目录不存在 → 404 `E_NOTFOUND`；路径穿越（`..`、编码后的 `%2e%2e`）→ 400 `E_INVALID`；embed 缺失（构建期未跑 `make frontend`）→ 500 `E_INTERNAL` 且日志提示构建命令；文件读失败 → 503 `E_UPSTREAM`。
- **明确不做什么**：不做 CDN/反向代理；不做动态 gzip（预压缩是构建期职责）；不做目录列表；不托管插件之外的用户文件。

### 2.10 `internal/core/sse`（httpapi 内的独立包）

- **职责**：`GET /api/v1/events` 长连接；`text/event-stream`；支持 `Last-Event-ID` 补发；心跳 `: ping` 每 15 s；全局并发上限 64；内核关闭时广播 `event: shutdown`。
- **输入输出**：输入已鉴权会话 + 可选 `Last-Event-ID`；输出事件流帧 `id: <n>` / `event: <type>` / `data: <json>` + 空行。
- **失败模式与处理**：客户端写阻塞 > 30 s → 断开该连接（慢消费者不拖垮内核）；事件缺口（请求 id 早于缓冲最旧） → 发 `event: resync` 让前端全量刷新；超 64 连接 → 429 `E_RATELIMIT`；关闭时 5 s 内未 flush 完成 → 直接断开。
- **明确不做什么**：不做 WebSocket/双向通道；不做事件持久化；不做按插件粒度的订阅过滤（M2 有真实需求再走 ADR）；不做断线自动重连（前端负责）。

### 2.11 `cmd/kored/envprobe`（启动期探测，非内核规则）

- **职责**：启动第 2 步一次性探测 **10** 项环境能力（平台/架构、OS 版本、AF_UNIX、对端身份、资源后端、委派可写、服务管理器、SELinux、AppArmor、状态目录文件系统）并产出不可变 capability report；按 Tier 判定后绑定 `internal/platform` 五接口。硬要求（平台/架构、OS 版本低于下限、状态目录文件系统）失败 **exit 6**；软要求（cgroup/Job Objects、委派、systemd/SCM/launchd、SELinux、AppArmor）缺失只 WARN + 降级。
- **输入输出**：输入 `*config.Config`（只用 `paths.state_dir`）与只读探测；输出 `Report{arch,os,os_version,tier,kernel,cgroup_mode,cgroup_enforced,delegation,service_manager,selinux,apparmor,peer_identity,fs_type}`（**13 字段**，非适用平台记 `N/A`），由 `cmd/kored` 注入 httpapi，`GET /api/v1/system/info` 原样返回。探测项与矩阵见 [COMPATIBILITY.md](./COMPATIBILITY.md) §5–§7。
- **失败模式与处理**：探测源不可读 → 按"不满足"记 WARN（不猜默认值）；cgroup 试写失败 → 回滚后置 `cgroup_enforced=false`；状态目录 fs ∈ {nfs,smb,cifs}（Windows 网络盘）→ **exit 6**；架构非 amd64/arm64、Linux 内核 < 4.18、Windows < 1809（build 17763）、macOS < 12.0、AF_UNIX 不可用、OS 版本不可读 → **exit 6**。
- **明确不做什么**：不改宿主配置（不写 sysctl、不切 SELinux 模式、不装包）；不重试探测；不缓存跨启动结果；`serve` 之外的 CLI 子命令不跑探测；不把软缺失升级成拒绝启动。

### 2.12 `internal/core/installer`

- **职责**：预设解析（构建期 `//go:embed presets/` 快照 + `--offline-dir` 本地目录优先）、sha256 校验、`requires_kore` 区间校验、依赖 DAG 拓扑排序、按序安装并 enable、**失败整预设回滚**（逆序卸载 + 恢复启用状态 + 清已写状态目录）、运行时预检结果透传（只报缺什么/多大，不装运行时）。
- **输入输出**：输入 `Preset{id,plugins[{id,version_range,optional}],config_template}`（schema 见 [SCENARIOS.md](./SCENARIOS.md) §2）；输出安装计划 `{steps[],resident_quota,disk_bytes,runtime_gaps[]}` 或异步 `job_id`。HTTP `POST /api/v1/store/install|update` 与 CLI `kored install --scenario <id> [--offline-dir] [--yes]`、`kored install --package <tar.gz>` **共用同一实现**。
- **包下载（`InstallFromURL`，索引 `download_url`）**：内核**唯一出站口**——先把已验签索引声明的 `https://` 地址流式拉到 `<state_dir>/tmp/pkg-*/<id>-<version>.tar.gz`，**边下边算 sha256**（不整包读入内存），单包上限 64 MiB（超限立即中止并删临时文件），摘要必须与索引声明一致才交回 `Install` 复用本地包安装链路；摘要不符/超限/非 200 一律拒并删除临时目录。只允许 `https://`（拒 `http://` / `file://` / `gopher://` 等），客户端 60 s 总超时且禁用 keep-alive（G-19：装完不留空闲连接）。失败不落盘：`defer` 删下载目录 + `Install` 自清 staging。
- **失败模式与处理**：预设 id 未知 / 版本区间不可解析 → 400 `E_INVALID`；sha256 不符 → 400 `E_INVALID`（不落盘）；`requires_kore` 不满足 → 409 `E_UNSUPPORTED`；常驻配额超限（>3 个或 >24 MiB）→ **安装前** 409 `E_CONFLICT` 并给"需先停用 <id>"建议；包下载失败 / 下载内容与索引声明摘要不符 → **502 `E_UPSTREAM`**（market 按 installer 错误分类映射，可重试或换源）；任一步失败即整预设回滚，回滚自身失败则写 `audit` 并保留现场（不删证据）。
- **明确不做什么**：不实现第二条安装链路——下载安装与本地包安装共用同一套校验/解包/落位/落库（下载只多"拉到临时文件 + 摘要比对"一步），URL 与 sha256 只能来自已验签索引、不由本包决定；不安装运行时（运行时由插件调宿主包管理器，kore 不下载）；不做版本求解（只按索引区间取满足的最高版并 pin）；不做包签名校验（M4 由 market 负责 ed25519）。
- **运行期安装约束（state.db 独占锁）**：`serve` 常驻时以独占方式持有 `state.db`，CLI `kored install --package` 与 `--scenario` 同为独立进程、会争同一把锁并退出码 3（状态库被占用）——**这是设计使然，不是缺陷**。serve 运行时请走 `POST /api/v1/store/install`（经同一 installer 校验落盘，并由装配层**真正重载** registry/supervisor：运行中的旧版本先 Stop → 丢弃旧 instance → 从状态库与磁盘重新装载新版本清单 → `Replace` 登记 → 按持久化 `desired_state` 决定是否拉起）；同 id 升级后 `GET /plugins` 报新版本、新方法可直接调用，无需重启内核；`POST /store/update` 走同一重载路径。响应新增 `reload` 字段（`reloaded` / `restarted`）与升级语义字段 `previous_version`（安装前版本，首次安装为空）、`stale_versions`（磁盘上残留的旧版本目录名，**不自动删除**，供前端提示清理），重载失败显式 500 而非假装成功。`GET /api/v1/plugins` 的每条已装记录由 httpapi 用已验签索引对齐 `latest_version` / `latest_sha256` / `update_available`（纯数据对齐，不判升级方向，G-01）。CLI install **仅离线使用**（serve 未启动）。

### 2.13 `internal/core/privilege`（提权通道，ADR-0018）

- **职责**：校验 `info.json.root_actions` schema；经 `systemd-run --uid=0 --collect --wait --pipe` 的 transient unit 执行**固定 argv**；签发/核销不可回滚动作的一次性 `confirm` 令牌；构造 `root.action` 审计事件并 **fail-closed**（审计写失败 → 动作不执行，返回 `E_INTERNAL`）。
- **边界**：不认识 `ufw`/`nginx` 等业务语义（G-01）；不直接 import `store`（审计走 `Auditor` 单方法接口，装配层写 bbolt）；不引入常驻进程（ADR-0016）；插件永远拿不到 root。
- **执行契约**：请求只能给 `action_id` + 追加参数（拼在声明 argv 之后，不能替换 argv[0]）；transient unit 名 `kore-root-<plugin>-<action>-<rand>`；超时 kill unit；stdout/stderr 各上限 1 MiB；`exit_code` 取 `systemd-run --wait` 的退出码。
- **降级**：非 root → `E_NEED_ROOT`；无 systemd → `E_NO_SYSTEMD`；均带 `detail.hint`（HTTP 层提升为顶层 `hint`）。
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
- **端点实现状态（M2-B 快照；终态规格见上文"输入输出"）**：7 个 store 端点中，M2-B 已接通 4 个路由——`GET /store/plugins`、`GET /store/plugins/{id}`、`POST /store/install`、`GET /store/jobs/{id}`；其余 `POST /store/refresh`、`GET /store/presets`、`POST /store/update`、`DELETE /store/plugins/{id}` 属后续里程碑。**路由接通 ≠ 功能完成**：`GET /store/jobs/{id}` 虽已注册，handler 当前返回 **501 `E_UNSUPPORTED`**（message 标注 M3 支持），任务进度查询到 M3 才落地；M2-B 阶段该端点仅占位，不返回真实 job 状态。

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
| 7 | `rate_limit` | `/auth/login` 5 次/60 s（全局桶，key=`admin`，见 §2.3）；`/invoke` 120 次/60 s/会话 | 429 `E_RATELIMIT` |
| 8 | `router` | 匹配路径与方法，进入 handler | 404 `E_NOTFOUND` / 405 `E_INVALID` |

设计理由：`csrf` 必须在 `auth` 之后（先有会话才有 token 可比对）、在 `rate_limit` 之前（拒绝伪造请求不应消耗业务限速桶）；`rate_limit` 放在 `auth` 之后，未登录流量不消耗业务限速桶（登录接口自身有独立桶）；`body_limit` 放在 `auth` 之前，超大 body 不进入鉴权与业务路径；`recover` 必须在 `access_log` 之前才能记录 500 的真实来源。`GET /-/healthz` 绕过 auth、csrf 与 rate_limit，`access_log` 降为 DEBUG（避免探活刷日志）。

## 4. supervisor 规格

### 4.1 拉起参数

| 项 | 值 |
| --- | --- |
| 可执行文件 | `/var/lib/kore/plugins/<id>/<version>/bin/<id>`（`info.json.entry` 相对包根） |
| 运行身份 | 系统用户/组 `kore-<id>`（uid/gid 由 `useradd --system --no-create-home` 提供，主壳启动时确保存在） |
| cgroup | `/sys/fs/cgroup/kore/<id>.slice`：`memory.max = resources.memory_mb × 1 MiB`；`cpu.max = "<cpu_quota> 100000"`；`pids.max = resources.pids_max` |
| 环境变量 | 注入插件的仅 5 个：`KORE_PLUGIN_ID`、`KORE_PLUGIN_SOCK`、`KORE_PLUGIN_TOKEN`（hello HMAC 用，Windows 必需）、`KORE_STATE_DIR=/var/lib/kore/plugins/<id>`、`KORE_LOG_DIR=/var/log/kore/plugins`（**内核侧另有 `KORE_CONFIG` / `KORE_STATE_DIR` / `KORE_PLUGIN_DIR` 三个配置覆盖变量，不注入插件**，见 §2.1）；任务目录为 `<KORE_STATE_DIR>/tasks`（派生，不另设 env）；协议版本与 capabilities 来自 `info.json` 与 `kore.hello`，**不设环境变量**（无 `KORE_SOCKET` 等别名） |
| socket | 主壳**作为 server** 先 bind `/run/kore/plugins/<id>.sock`（`chmod 0600`、`chown kore-<id>`；其它插件用户既读不到也连不上），插件以 client 身份 `connect` |
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

**停止序列**：主壳向插件 socket 发送 `kore.shutdown` 帧 → 等待 **≤5 s** → 超时 `SIGKILL` → `stopped`（记 `killed=true`）。**不发 `SIGTERM`**——插件是独立进程，`kore.shutdown` 即其优雅停止信号；主壳不直接调用 `syscall.SIGTERM`（G-16：平台专有 API 收口在 `internal/platform`）。进程在 5 s 内退出 → `stopped`。之后删 socket、删 cgroup 目录、清理 `run.json`。关闭流程总预算 ≤ 12 s，systemd `TimeoutStopSec=15` 兜底。

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
| `auth.session_ttl` | 是 | 只影响新会话与后续续期判断 |
| `auth.admin_password_hash` | 是 | 只影响新登录，**既有会话不失效**；如需强制全部下线必须重启内核（改哈希不吊销会话） |
| `security.login_rate_limit.attempts`、`.window`、`.lock` | 是 | 只影响新计数与新锁定 |
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
| 6 | 定时器白名单 | `grep -rn "time.NewTicker\|time.NewTimer\|time.AfterFunc" internal/` | 仅命中 `cert_renew` 包 |
| 7 | 行数预算 | `find internal/ pkg/pluginapi -name '*.go' \| xargs wc -l` | 合计 ≤ 8000 行（M1 实测后校准，超 10% 需 ADR）；单文件 ≤ 400 行 |
| 8 | 协议可独立实现 | `go test ./pkg/pluginapi/...` 含帧编解码往返与超长拒绝用例 | 全绿 |
| 9 | 二进制体积 | `du -b bin/kored` | ≤ 26214400 字节（25 MiB） |
| 10 | 空载内存 | `ps -o rss= -p $(pgrep -x kored)` 60 s 中位数 | ≤ 8192 KiB |

守卫 7 的 8000 行是**初值**，M1 实测后按实际内核规模校准一次，校准结果写入 ADR；校准只能一次性调整基线，不得每次超限就调高——那叫改尺子，不叫达标。

## 10. CLI 入口（`kored` 子命令）

`kored` 是单二进制：**无子命令时等价 `kored serve`**；子命令用标准库 `flag` 手写分发，不引 cobra/urfave（G-02）。

| 子命令 | 作用 | 起 HTTP / 插件进程 |
| --- | --- | --- |
| `serve`（默认） | 启动主壳（§4–§7 全流程） | 是 |
| `db dump <bucket>` / `backup <out>` / `restore <in>` | 只读导出 bucket / 停写快照 / 恢复（恢复前校验 sha256 与 schema 版本） | 否 |
| `invoke <plugin> <method> [--json]` | 一次性调用，仅拉起目标插件 | 否 |
| `install --scenario <id> [--offline-dir <dir>] [--yes]` | 按预设安装（与 HTTP `store/install` 共用 installer） | 否 |
| `install --package <tar.gz>` | 单包安装（离线/内网） | 否 |
| `version` | 版本 / 协议版本 / commit | 否 |

退出码沿用 `DATA-MODEL.md` §7 码表（2 配置 / 3 状态目录或锁 / 4 存储或 schema / 5 监听绑定 / 6 环境硬要求不满足），子命令失败码与 `serve` 一致；`serve` 之外子命令执行完即退出，不留后台进程、不注册 systemd。

## 11. 与其他文档的关系

| 文档 | 关系 |
| --- | --- |
| [VISION.md](./VISION.md) | 上位目标与量化判据；本文任何数字与之冲突时以 VISION 为准并回改本文 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 组件图、进程模型、状态机、故障域；本文是其模块级展开 |
| [GLOSSARY.md](./GLOSSARY.md) | 术语、反术语与命名约定；字段名/错误码/方法名的唯一解释 |

> 规格的价值不在"写得很全"，在于 implementer 照着写不会跑偏、verifier 照着测能给出红绿。本文任何一条"明确不做什么"被实现，就是内核开始膨胀的第一天。
