> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M0

# kore 安全模型（SECURITY）

本文定义 kore 的威胁模型、信任边界、鉴权与授权、插件隔离、输入校验、密钥与升级链、审计与安全默认值。前端契约见 [FRONTEND.md](./FRONTEND.md)，进程隔离的选型理由见 [ADR-0003](./DECISIONS/0003-process-isolation-plugins.md)。

## 1. 威胁模型

### 1.1 资产清单

| 资产 | 位置 | 敏感度 |
| --- | --- | --- |
| admin 口令哈希 | `/etc/kore/config.yaml` 的 `auth.admin_password_hash` | 高（可离线爆破） |
| 会话凭据 | bbolt `sessions` bucket + 浏览器 cookie | 高 |
| 插件密钥 | `/var/lib/kore/secrets/<id>.json`（`0600 root:root`，目录 `0700`） | 中高 |
| 插件可执行文件 | `/var/lib/kore/plugins/<id>/<version>/bin/<id>` | 中（可替换即等于代码执行） |
| 插件能力授予记录 | bbolt `plugins` bucket 的 `granted_capabilities` 字段 | 高（越权即扩大攻击面） |
| 审计日志 | bbolt `audit` bucket + `/var/log/kore/` | 中 |
| 宿主文件系统 | 插件以 `kore-<id>` 可读的路径 | 视权限而定 |

### 1.2 攻击面

网络面：UDS `/run/kore/kore.sock`（默认唯一）；可选 HTTP `127.0.0.1:8787`。本地面：插件进程、`/etc/kore`、`/var/lib/kore`、`/var/log/kore`。供应链面：插件包（未签名期）、npm 依赖（仅构建期）。人因面：安装来路不明插件、把 HTTP 监听到 `0.0.0.0`。

### 1.3 威胁表

| 威胁 | 场景 | 影响 | 缓解 | 残余风险 |
| --- | --- | --- | --- | --- |
| 未授权访问控制台 | 同机其他用户或暴露到 0.0.0.0 的 8787 被扫 | 全量插件操作 | 默认仅 UDS；目录 0700；**本机通道不是认证**（§3.2，ADR-0043）：`withAuth` 对全部 `/api/v1/*` 一律会话校验，本机 UDS / loopback 未登录同样是 401 + 登录页；「操作免密」只指登录一次后的 7 天滑动会话；**远程**另需 PBKDF2 口令 + 会话校验 | 用户显式绑 `0.0.0.0` 且无 TLS 时远程口令走明文 |
| 口令爆破 | 反复 `POST /api/v1/auth/login` | 账号接管 | 连续失败 5 次后按 1s→2s→4s→…→30s 递增延迟（正确口令始终放行，见 §3.5）、恒定时间比较、PBKDF2 校验单飞 | 并行连接仍可占满校验队列/消耗哈希 CPU（变慢但不锁死、不夺权）；限速状态随重启清零 |
| CSRF | 恶意页面诱导已登录浏览器发写请求 | 停机、卸载插件 | `SameSite=Strict` + 双提交 token（两方，非会话绑定）+ `X-Kore-CSRF` + Origin 校验 | 同源 XSS 可绕过全部三层（纯双提交无会话绑定兜底，见 §4） |
| 会话劫持 | XSS 读 cookie，或同机读取浏览器数据 | 会话盗用 | `HttpOnly`、默认 168h（7 天）滑动 TTL（阈值 `min(24h, ttl/2)`，绝对上限 30 天）、登出即删 | 同机 root 可读浏览器进程内存；**无 UA/IP 指纹绑定**，被盗 cookie 可在其它浏览器重放 |
| 插件越权调用 | 低权插件请求 `system:admin` 方法 | 宿主被改写 | capabilities 三处校验（安装/授予/调用）+ 审计 | 用户安装时授予过宽能力 |
| 恶意插件包 | 安装来路不明的包 | 以 `kore-<id>` 执行任意代码 | M4 起 ed25519 强制签名；独立 uid + cgroup | M0–M3 未签名期无法证明来源 |
| 索引仓库被篡改 | 索引指向恶意包，或把 sha256 换成攻击者的值 | 用户安装到恶意插件 | 索引只是**发现渠道，不是信任源**：kore 只信安装时计算并记录的 `plugins.package_sha256`，M4 起以 ed25519 验包 | 首次安装前索引与包同时被篡改且用户未核对来源时，sha256 自洽但包仍恶意（M4 签名后消失） |
| 路径穿越 | 插件 id 或资产路径含 `../` | 读宿主任意文件 | id 正则白名单 + `filepath.Clean` 前缀校验 + `Lstat` 拒 symlink | 需逐处校验，遗漏一处即失效 |
| 解压攻击 | zip-slip、symlink 条目、解压炸弹 | 覆盖宿主文件、撑爆磁盘 | 逐条目目标前缀校验、拒非 regular/dir、包与解压总量上限 | 高压缩率正常包可能被误拒 |
| 资源耗尽 | 插件吃满内存/CPU/PID | 主壳与宿主不可用 | cgroup v2 `memory.max`/`cpu.max`/`pids.max` | 同机其他服务仍受低强度 thrash 影响 |
| lazy 冷启动风暴 | 大量并发请求同时唤醒同一插件 | CPU 被打满、插件反复启停 | 单插件启动互斥 + 队列上限（默认 32）+ 超限 `E_RATELIMIT` | 已排队请求延迟上升 |
| UDS 被同机用户连接 | `/run/kore` 权限过宽 | 非属主本机用户可连到管理 socket（**仍需会话，登录门不被文件权限绕过**） | 目录 `0700 root:root`、主壳 socket `0600`、插件 socket `0600`、`SO_PEERCRED` 校验 | 仅 root 可连到 socket；**连上仍需会话**（ADR-0043） |
| 日志泄密 | 口令/token/secret 进日志 | 凭据二次泄露 | 字段白名单 fail-closed + 丢弃非白名单字段 | 插件自写日志不受主壳控制 |
| SSE 连接耗尽 | 大量 `/events` 长连接 | FD 与内存耗尽 | 单会话 1 条、全局上限 64、空闲 90s 断开 | 已认证用户可占满配额 |

## 2. 信任边界

```text
[浏览器 / 第三方页面]   不受信：任何输入都可能是攻击载荷
          │  HTTP/HTTPS；Cookie + X-Kore-CSRF；Origin/Referer 校验
          ▼
[主壳 kored]  root 运行，唯一可信裁决点：鉴权、授权、路由、资源限额
          │  UDS + 4 字节大端长度前缀 + JSON；帧 ≤ 8 MiB；每帧按 capabilities 校验
          ▼
[插件进程 kore-<id>]  独立系统用户 + cgroup v2；不可信执行体
          │  exec.Command（不经过 shell）；文件系统按目录权限收口
          ▼
[宿主 Linux]  systemd / cgroup v2 / 文件系统 —— 最终信任根
```

规则：跨边界只走协议帧，不共享内存、不共享文件句柄、不共享环境变量；主壳对插件不信任，插件对浏览器不信任。

## 3. 鉴权与会话

### 3.1 口令存储

- 算法 **PBKDF2-HMAC-SHA256，600,000 次迭代**，salt 16 字节（`crypto/rand`），输出 key 32 字节。
- 实现走 Go 1.24+ 标准库 `crypto/pbkdf2`：零新增依赖、无 CGO，不破主壳依赖白名单（G-02 上限 3）与单二进制 ≤ 25 MiB 预算。
- 存储格式：`pbkdf2-sha256$600000$<base64(salt)>$<base64(hash)>`，写在 `/etc/kore/config.yaml` 的 `auth.admin_password_hash`，文件权限 `0600 root:root`。
- 校验用 `subtle.ConstantTimeCompare`；迭代次数从存储串读取（属校验参数），上调不破坏旧哈希，登录成功时可透明重算升级。
- 系统只有一个账号，不做用户枚举。

**取舍与复审条件**：PBKDF2 无内存硬化，对 GPU/ASIC 离线爆破的抵抗弱于内存硬 KDF。当前可接受的前提是三条同时成立：单管理员账号、默认只绑 UDS 或 `127.0.0.1`、无公网暴露面；再叠加 60s 内 5 次失败锁 300s 的限速，在线爆破不可行，离线爆破的前置是攻击者已能读 `0600 root:root` 的配置（等价 root）。**复审条件**：默认暴露公网、出现多用户/多租户、或 `auth.admin_password_hash` 进入非 root 可读的备份路径时，必须改用内存硬 KDF（**Argon2id**）并开新 ADR 显式放宽依赖白名单（新增 `golang.org/x/crypto`），同时给出哈希迁移与双格式兼容方案。

### 3.2 登录门与操作免密（ADR-0043，更正 ADR-0041）

kore 是**单管理员、Web 面板管理**的产品（G-11：不做多用户 RBAC）。**登录 = kore 自己的 Web 登录体系**，凭据只有 `auth.admin_password_hash`（单管理员口令，**无用户名**）。**「操作免密」不是「免登录」**——两者必须分开。宝塔 / 1Panel 都是「单管理员但用户名+密码」的账号体系；kore 固定不加用户名：单管理员下用户名不是秘密，固定值不增加安全性（随机值则退化为第二个口令且必须落盘/展示），却要改登录契约与登录页。登录页因此只校验口令，页面本身自洽（「控制台 · 单管理员登录」）：

| 场景 | 未登录 | 登录一次之后 |
| --- | --- | --- |
| 本机浏览器（`127.0.0.1` loopback） | **401** + 登录页 | 所有操作免密（含 root 特权动作），7 天滑动会话 |
| 本机 CLI（UDS `<run>/kore.sock`） | **401** | 复用同一会话 cookie，免密 |
| **其他机器访问面板** | **401** | 同一套 Web 登录（口令只校验一次） |
| root 特权动作 | 不可达 | 会话授权后由内核 root 服务执行（ADR-0042），**不弹本机账号口令、不弹 polkit、不用 sudo** |

- **本机通道不是认证**：`withAuth` 对全部 `/api/v1/*` 一律做会话校验，UDS 与 loopback 不再跳过（ADR-0041 曾把本机通道直接当认证，已被 ADR-0043 更正）。本机通道只保留 CSRF 令牌引导（`csrf_local.go`）与 UDS 的 CSRF 豁免。
- **首启凭据（新装实例第一次就能登录，全程不要系统账号密码）**：`auth.admin_password_hash` 为空且 stderr 是终端（SSH / 串口 / 本机 TTY）时，`serve` 用 `crypto/rand` 生成 24 字符随机口令 → PBKDF2 哈希与 `auth.initialized: true` **原子写回 serve 自己解析的那个配置文件**（0600）→ 明文**只在当前终端打印一次**，本次启动即可登录；配置 / state / 日志里只有哈希。非终端启动（systemd / journald / 重定向）**不生成、不打印明文**（日志长期可读，不能留一次性凭据），只打印不含秘密的 `kored admin-password --generate --config <同一路径>` 指引；写入失败同样不打印无法使用的明文。重置只走 CLI（`kored admin-password --set`），没有 Web 找回、不发邮件、不要求系统账号密码。
- **没有口令就登不进**：哈希为空时 `auth.Manager.Verify` 一律返回 `false`，登录端点回 **401「口令错误」**，**空口令绝不比对通过**；面板停在登录页（不会因为"没设口令"就放行）。
- **已有实例不破坏**：配置文件里已有 `auth.admin_password_hash` 时行为与升级前一致（PBKDF2-HMAC-SHA256 / 600,000 次，见 §3.1）；`admin-password` 命令的 `--generate/--set/--hash` 语义不变。首启生成的明文口令永不进日志，只打印一次。

### 3.3 会话

- 服务端存 bbolt `sessions`：key 为 token 的 `sha256`（64 位小写 hex，明文 token 不落库），value 为 `"<expiry> <created> <lastSeen> <b64url(ip)> <b64url(ua)>"`（旧两段 / 单段格式仍可读）；bucket 内另有保留键 `password-fingerprint`（存 `sha256(admin_password_hash)`，启动时比对以决定是否全局吊销）。
- **会话元信息（最后活跃 / 来源 IP / UA 摘要）只用于展示与人工判断，不参与鉴权**：`auth.Touch` 按 5 分钟节流写回，`GET /api/v1/security/sessions` 把它列给管理员看（可踢单个会话、可一键全踢但保留当前会话）；`DELETE .../sessions/{id}` 拒绝踢当前会话（退出当前登录走登出）。元信息写失败只 WARN、不拒绝请求。
- TTL **默认 168h（7 天）滑动**：仅当剩余寿命低于 `min(24h, ttl/2)` 时把 `expiry` 推到 `now+ttl` 并重发 cookie（相邻两次续期至少间隔 `ttl/2`，避免每次鉴权写盘）；绝对上限 **30 天**（`created+30d`，续期不得越过），到点强制重新登录。`auth.session_ttl` 可配置，取值 1m–720h。
- **不绑定 UA/IP**：会话与客户端指纹无关（元信息只记录、不比对、不拦截新 IP 的 cookie 复用）；持有 token 即可在其它浏览器重放（残余风险见 §1.3），管理员只能在账户与安全中心看到「来源网段变了」并手动踢下线。
- cookie：`kore_session=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<ttl 秒数>`（默认 604800），`Secure` 见 3.4。
- 登出：删除服务端记录 + `Set-Cookie: kore_session=; Max-Age=0; Path=/`；服务端删除是唯一失效依据，不依赖浏览器。

### 3.4 `Secure` 在纯 HTTP 下的取舍

**前提**：内核不终结 TLS（`server.tls` 固定 off，配置层拒绝），对外只能由同机反向代理暴露；反代经 UDS / `127.0.0.1` 回源。所以"浏览器这一段是不是 HTTPS"只能由反代告诉内核。

决策：`auth.cookie_secure` 三值，`auto`（默认）**逐请求**判定，判定顺序：

1. `r.TLS != nil` → 加 `Secure`（为将来内核自终结 TLS 预留）；
2. 对端是本机通道（UDS 或 loopback TCP）且 `X-Forwarded-Proto` 首个值（逗号分隔）为 `https` → 加 `Secure`；
3. 其余（纯 HTTP）→ 不加 `Secure`。

`kore_csrf` 与会话 cookie 使用同一判据（登录时从已写出的 `kore_session` 解析，保持一致）。

**为什么不再按回环 Host 判 `Secure`**：回环访问没有网络嗅探面，加不加 `Secure` 不改变泄漏风险；而加了会让 curl / 非浏览器客户端在 `http://127.0.0.1` 下拿到 cookie 后不回传，等于把本机自动化路径弄坏。安全收益为零，破坏面真实存在，故 auto 只看传输方式。

**`X-Forwarded-Proto` 的可伪造性**（选择 `auto` 的已知代价）：内核只监听 UDS 与回环，能连进来的只有本机进程与同机反代；非本机对端的转发头一律不采信。转发头只能**加** `Secure`、不能**减**——请求本身是 TLS 时伪造 `http` 仍是 `Secure`（有反例用例）。伪造 `https` 的最坏后果是浏览器在纯 HTTP 下拒绝回传 cookie（自己登不上，fail-secure），不构成会话泄漏。残余风险是反代自身若把客户端传入的头原样透传：那也只影响"加不加 Secure"，不影响"该加时被拿掉"。反代必须**覆盖写**该头（nginx `proxy_set_header X-Forwarded-Proto $scheme`）。

**显式两值**：`true` 恒加 `Secure`——经纯 HTTP 访问时浏览器会丢弃 cookie，表现为"口令正确却立刻掉线"，启动日志给 INFO 提示；`false` 恒不加——即使经 HTTPS 反代也不加，启动日志给 WARN。

**HTTP over network（本次 P1 的场景）**：反代没终结 TLS、用户直接 `http://域名` 访问时，`auto` 必须**不**加 `Secure`（加了就彻底登不上），此时浏览器↔反代这一段明文可被同网段嗅探 7 天会话令牌。内核在检测到"非回环 Host + 未解析出 Secure + 确实对外暴露（TCP 监听或带反代转发头）"时打一次 `WARN`（每进程一次），提示去反代开 TLS 并透传 `X-Forwarded-Proto: https`。这是有意的取舍：**可用性不能让位于一个假的安全属性**，修复责任在入口。

### 3.5 登录限速（P1 DoS 修复后口径）

**单一全局桶 + 递增延迟，无锁定期**：`internal/core/auth/ratelimit.go` 的 `LoginLimiter` 实现，口径取 `security.login_rate_limit`（默认 `attempts=5` / `window=60s` / `lock=300s`）。单管理员体系下只有一个账号，key 固定 `"admin"`；接口保留 key 参数。**不做 per-IP 桶**：UDS 与本机回环下 `RemoteAddr` 恒为 local（全机同 IP），per-IP 桶退化成全局桶，多一层无收益。

判定顺序：**先校验口令，再对错误口令施加惩罚**——正确口令在任何时候都直接 200（并清零），不存在"锁定期内连正确口令也拒"的硬锁。这一改动修复「任意本地进程 5 次错口令即可永久锁死管理员」的 P1 DoS（`8d7368e` 实测：单桶 key=`admin`、无 IP 维度、锁定期内正确口令也 429、每 60s 重复即永久锁死）。

**惩罚数字表**（连续失败 n，成功或有 `lock` 静默即归零）：

| n | 本次错误口令的应答延迟 | 响应 |
| --- | --- | --- |
| 1–5 | 0 | 401 `E_UNAUTHORIZED`（容忍手误） |
| 6 | 1s | 429 `E_RATELIMIT` |
| 7 | 2s | 429 `E_RATELIMIT` |
| 8 | 4s | 429 `E_RATELIMIT` |
| 9 | 8s | 429 `E_RATELIMIT` |
| 10 | 16s | 429 `E_RATELIMIT` |
| ≥11 | 30s（封顶） | 429 `E_RATELIMIT` |
| 任意 | **正确口令 0s** | 200（立即放行） |

延迟由服务端在应答前施加；429 带 `Retry-After` = 下一次错误口令将被延迟的秒数（向上取整、最小 1）。进入惩罚后不会因"等过一个窗口"重新白拿 5 次猜测：惩罚模式只由登录成功或静默超过 `lock` 退出。

**防爆破 vs 防 DoS 的平衡（如实说明）**：两者天然冲突——UDS/本机回环下没有可区分攻击者与管理员的客户端身份，唯一的判别器就是口令本身，因此"不校验就拒绝"必然误伤正确口令。本实现选择"校验后对错误口令收费"：① 串行爆破被压到 1/30s（≈120 次/小时，原硬锁口径约 60 次/小时，同数量级）；② 并行爆破由 `BeginVerify` **单飞串行化 PBKDF2 校验**，猜测吞吐上限 ≈ 1/单次哈希耗时，不随并发连接数放大；③ 正确口令始终 0 延迟放行，管理员不会被锁死。**残余风险**：攻击者持续灌登录请求仍可占用校验队列让管理员登录变慢、消耗哈希 CPU（这是"管理员必须随时能登入"的必然代价，见 §10 附则）；彻底根治需独立恢复通道（root 直改配置 / CLI 重置），v1 不做。

**实现约束**：零 ticker / 零 AfterFunc / 零后台 goroutine（G-19），过期条目在判定路径上惰性清理，空闲零开销；**状态只在进程内存，重启清零**（限速状态持久化排在 M3，见 §10 附则）。`security.login_rate_limit.*` 可 SIGHUP 热更，已累计的连续失败与惩罚等级不变。

**未落地项（如实标注）**：~~`auth.login` / `ratelimit.hit` 审计事件尚未实现~~——**登录审计已落地**：成功写 `login.success`（`result=ok`，detail=`{ip,user_agent,session_id_prefix}`），失败写 `login.failed`（`result=denied`，detail=`{ip,user_agent,reason}`，reason ∈ `wrong_password` / `rate_limited` / `no_session`；进入惩罚的错误口令记 `rate_limited`）。IP 只保留前 3 段、UA 截断 100 字符、会话只留 8 字符前缀，**口令任何形式都不进审计**；可按 `action=login.failed` 从审计库追溯暴力破解。

### 3.6 两步验证、登录 IP 白名单与 API token（2026-11-25 落地，`0a66c10`）

三项均为**默认关闭**的显式开关，状态存 bbolt `security` 桶（`security.totp` / `security.totp.pending` / `security.ipallow` / `security.tokens`）；改配置类操作额外要求当前口令。实现：`internal/core/auth/security.go`、`internal/core/httpapi/handlers_security.go`、`internal/core/httpapi/middleware.go`。

| 项 | 实现口径 | 边界与残余风险 |
| --- | --- | --- |
| TOTP 两步验证 | RFC 6238 / HMAC-SHA1 / 6 位 / 30 s 周期，允许 ±1 步时钟偏差；开启时一次性展示 **10 个**恢复码（单次有效、库中只存 sha256），密钥只在开启流程返回一次；开启后登录 = 口令 + 动态码，**缺 OTP → 428 `E_2FA_REQUIRED`**，码错 → 401 `E_2FA_INVALID` | 依赖用户自备 TOTP App，内核不联网、不发短信/邮件；恢复码用尽需关闭后重开；密钥在校验侧必须可取回（bbolt 中非哈希存储），威胁等价于能读 `state.db` 的 root |
| 登录 IP 白名单 | CIDR 列表；开启后在**口令校验之前**判定（不泄露口令正确性），未命中 / 列表为空 / CIDR 解析失败一律拒绝 **403 `E_IP_DENIED`**（fail-closed，文案不回显白名单）；来源取 TCP 对端，仅 UDS / 回环对端才采信 `X-Forwarded-For` 首段 | 只约束**登录入口**，不限制已签发会话与 API token；反向代理非本机时看到的是代理地址，白名单须放行代理 IP；IPv4/IPv6 需分别登记 |
| API token | `Authorization: Bearer kore_<base64url>`；明文只在创建时返回一次、库中只存 sha256；scope 两档：`read` 只放行安全方法，`admin` 放行全部；TTL 默认 90 天、上限 365 天；按 id 吊销，不存在的 id 幂等成功 | 与 Cookie 会话并存；token 无 IP/UA 绑定，泄漏即等于对应 scope 的长期权限；`read` 是方法级只读，不按资源细分 |

## 4. CSRF

三层同时启用，任一层失败即拒绝：

1. **`SameSite=Strict`**：跨站请求不携带会话 cookie。
2. **双提交 token（只做两方比对，没有会话绑定）**：登录成功下发 `kore_csrf=<32 字节 hex>`（**非 HttpOnly**，双提交要求前端可读）；前端每个写请求带 `X-Kore-CSRF: <值>`；服务端**只比对 `header == cookie`**（`internal/core/httpapi/middleware.go` 的 `withCSRF`，常量时间比较）。**`auth.Session` 没有 `csrf` 字段**（`internal/core/auth/session.go:40-47` 只有 `TokenHash` / `ExpiresAt` / `CreatedAt`），服务端不存"这个 token 属于哪个会话"——这是纯双提交，不是会话绑定。
   - **当前防什么**：攻击者页面读不到受害者的 `kore_csrf`（跨源读 cookie 被同源策略挡住），因此无法给伪造的写请求补上匹配的 `X-Kore-CSRF`；叠加上 `SameSite=Strict` 与 `Origin` 校验，挡得住跨站伪造型 CSRF。
   - **不防什么**：**同源 XSS**。token 必须让前端脚本可读，XSS 就能读出它并同时写进 cookie 与 header，两方比对自洽通过——这道门对同源 XSS 等于不存在。
   - **与会话绑定的真实差距（残余风险）**：目标态是服务端在 session 上存 csrf 并三方比对 `header == cookie == sessions.csrf`、token 改 `HttpOnly` 使脚本读不到（[ADR-0040](./DECISIONS/0040-plugin-ui-distribution.md) §2.4 的未来方案，v1.0 前不实现）。差这一维的后果有两条：① 同源 XSS 能读到 token 并复用，而会话绑定 + `HttpOnly` 下 XSS 读不到；② 两方比对只证明"两个位置一致"，**不证明这个 token 属于当前会话**——兄弟子域 / 中间人注入一对自洽的 cookie+header 即可绕过，服务端没有参照值可校验。因此**不得把本实现按"会话绑定 CSRF"评估**；实际强度取决于 `SameSite=Strict` + `Origin` 校验 + 同源 XSS 面收敛（会话 cookie 是 `HttpOnly`）。
3. **同源校验**：`Origin`（缺失时倒退 `Referer`）必须与请求 `Host` 同源；**非 GET 请求缺 Origin/Referer 直接 `E_UNAUTHORIZED`**。

所有非 GET 必须带 `X-Kore-CSRF`；`GET /-/healthz`（探针例外，不带业务前缀）与 `GET /api/v1/events` 例外（只读），但 SSE 仍要求有效 session cookie，`SameSite=Strict` 阻止跨站 `EventSource`。

## 5. 授权（capabilities）

### 5.1 校验点

| 阶段 | 触发 | 校验内容 | 失败码 |
| --- | --- | --- | --- |
| 安装声明 | `POST /api/v1/plugins` 解析 `info.json` | 按 §5.2 顺序校验：非空（≥1 项）、语法合法、域为 6 特权之一或等于自身 id、无重复、≤16 项 | `E_INVALID` |
| 启用授予 | `POST /api/v1/plugins/{id}/enable` | 确认授予记录：补齐缺失记录、清空升级新增的待确认项（`granted_by=enable:<subject>`，审计 `capability.grant_confirmed`） | 记录写入失败 → `500 E_INTERNAL`（不伪造确认） |
| 调用校验 | 每个 `POST /api/v1/invoke/{plugin}/{method}` 帧 | 按目标插件 `capabilities` 的宿主前缀与动作级判定：`read` 任意已登录会话、`write/admin` 需 `system:admin`（或会话能力集含该项），未知宿主动作 fail-closed；内核不维护方法→业务能力映射表（G-01） | `403 E_UNAUTHORIZED`（未知宿主动作 `E_UNSUPPORTED`）+ 审计 `capability.denied` |

授予记录写在 `plugins` bucket 的 `granted_capabilities`（`granted_by/granted_at/version/declaration_sha256/capabilities[]/added_capabilities[]`）：安装时按声明自动授予（`install:auto`）；升级新增能力时自动扩展并记 `upgrade:auto` + 待确认项 + WARN/审计 `capability.grant_extended`——**不阻断升级/启用**（默认放行是硬约束，「静默」由记录与审计消除）；启用动作确认并清空待确认项；存量库启动时按已装声明回填（`legacy:backfill`）。

### 5.2 能力模型（两段）

| 段 | 内容 | 归属与语义 |
| --- | --- | --- |
| 特权能力（6 个，固定不可扩展） | `system:read` `system:admin` `net:read` `net:write` `proc:read` `proc:write` | 对宿主有实际影响，由内核集中校验与授权；`system:admin` 最高危，启用时强制二次确认 |
| 插件自有能力 | `<plugin-id>:<action>`，**域必须等于声明它的插件 id**（`site` 可声明 `site:read`；`db-mysql` 不得声明 `site:write`） | 插件自治，内核只校验语法与域归属 |

校验规则（按序，安装时执行）：① 语法 `^[a-z][a-z0-9-]{0,30}:[a-z][a-z0-9-]{0,30}$`，非法 → `E_INVALID`；② 域 ∈ 特权集 → 允许；③ 否则域必须 == `info.json.id`，不等 → `E_INVALID`（message 说明原因）；④ **必须非空（≥1 项）且 ≤16 项**，空数组、重复项或超限 → `E_INVALID`。

设计理由：**内核不得维护业务域名词表**——只认识 6 个宿主级特权能力 + 通用语法，其余归插件自治，新增插件永远不需要改内核（G-01）。

越权一律 `E_UNAUTHORIZED`（invoke 为 `403`，其余为 `401`），`detail` 只含缺失的能力名，不泄露方法内部实现。插件之间不允许互相直接调用；跨插件协作只经主壳 `kore.event` 广播。

## 6. 插件隔离

- **系统用户**：每个插件一个 `kore-<id>`，不与其它插件共享 uid。`kored` 以 root 启动时**按需创建**（该插件第一次启动前）：`useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group kore-<id>`，并**加入通道共享组 `kore`**（固定候选路径、不查 `PATH`；无 `useradd` 时回退 Debian `adduser`，已存在用户只补组关系）。用户建不出来 → **该插件启动失败**（`E_INTERNAL` + 人话提示），不退回同 uid。`kored` 非 root 时是**显式降级形态**：插件与内核同 uid（WARN + 本节 §15 标注），需要 root 的动作只能走 root-action 通道。
- **目录权限**：`/var/lib/kore/plugins/<id>`（`KORE_STATE_DIR`）属 `kore-<id>:kore-<id>`、**0700**（不为可写放宽到 0777）；状态根与运行根（`/var/lib/kore`、`/run/kore` 及其 `plugins` 子目录）为 root:root **0701**（只补 o+x：可穿越、不可列举）；插件根 `<pluginDir>`、版本目录 `<id>/<version>` 为 root:root **0755**，包内文件由安装器**归一为 0644（不可执行）/ 0755（可执行）**——不采信包内 mode（root 构建的 0600 会让非 root 启动的 kored 读不到清单而误判"未安装"）；插件 socket `/run/kore/plugins/<id>.sock` 由主壳创建后 `chown kore-<id>`、**0600**。
- **属主移交范围（降权启动前）**：移交是**两段式**、只覆盖「插件自己的落点」，不是整棵状态树 `chown -R`。① 顶层 `<id>` → `kore-<id>` 0700（插件要能在其中原子创建 `config.json`）；② `<id>` 下的**非安装树**条目（`config.json`、插件自建数据目录、`<state>/plugin-data/<id>` 整棵数据根）递归移交属主且**不改 mode**；③ 安装树（`<id>/<version>`、`<version>.bak-*`、`current` 链接）**保持 root:root 0755**——移交它等于把「替换自己二进制」的能力交给插件，读取能力只靠 o+rx；④ `<state>/plugin-data` 为 root:root **0701**（可穿越到自己的数据根、不可列举其它插件）。**符号链接只改链接自身（`lchown`，绝不 follow）**，否则插件在自己目录里放一个指向 `/etc/shadow` 的链接就能让内核把宿主文件交给它；深度上限 64 层（超出 WARN 并停止，可手工 `chown -R` 补齐）；任一 chown 失败 → **拒绝启动**（`E_INTERNAL` + 可操作的 `chown -R` 提示），不静默半移交。
- **提权通道 socket（独立）**：`<run>/kore-channel.sock` 属 `root:kore`、**0660**，仅供插件请求 root-action；内核不经它暴露任何管理端点（只认 `POST /api/v1/plugins/<id>/root-action`）。连接必须同时通过：插件 bearer（token 所属 id == 路径 id）、`SO_PEERCRED` 的 **uid 必须等于该插件 `kore-<id>`**、**pid 必须等于 supervisor 记录的子进程 pid**、且插件已获 `system:admin`。管理入口 `/run/kore/kore.sock` 仍是 `root:root 0600`，不因通道放宽。
- **cgroup v2**：`/sys/fs/cgroup/kore/<id>.slice`；控制文件 `memory.max` / `memory.high` / `memory.swap.max` / `cpu.max` / `pids.max` 的取值与默认值以 [RESOURCE-MODEL](./RESOURCE-MODEL.md) 为唯一真源，本文件不复制数值。安全含义：supervisor 在拉起前按 `resources` 声明与全局上限**取小值**后写入，插件无法自报放大；超限分别表现为 OOM kill、限流、fork 失败。oneshot 进程退出后 RSS 计 0。
- **进程属性**：环境 = 内核进程环境（运维经 env 注入插件配置类变量，见 RUNBOOK）覆盖以 5 个唯一变量 `KORE_PLUGIN_ID` / `KORE_PLUGIN_SOCK` / `KORE_PLUGIN_TOKEN` / `KORE_STATE_DIR` / `KORE_LOG_DIR`；降权时另覆写 `HOME=<KORE_STATE_DIR>` / `USER` / `LOGNAME` 为插件身份（避免插件读写 `/root` 得到难归因的 EACCES）。stdin 关闭；stdout/stderr 重定向到 `/var/log/kore/plugins/<id>.log`。

### 6.1 明确不做 seccomp / namespace

- **不做 seccomp**：Go runtime 需要 clone3、futex、epoll、io_uring 等宽 syscall 面，手写白名单跨内核版本极易误杀，且 EPERM 归因困难；引入 libseccomp 或容器运行时 SDK 直接违反主壳依赖上限 3 个与单二进制 ≤ 25 MiB。残余风险：插件可调用任意 syscall，但独立 uid 使其无法 ptrace 其它插件或主壳。
- **不做 namespace**：user/net/mount namespace 编排等于半个容器运行时，违反红线④（不搞容器化底座）；跨 namespace 的 UDS 还需 bind mount 或抽象 socket。残余风险：插件共享宿主网络栈与文件系统视图，靠权限位与 cgroup 收口。

### 6.2 SELinux / AppArmor 兼容

宿主开启 SELinux（RHEL / CentOS / Fedora）或 AppArmor（Ubuntu / Debian / SUSE）时，kore 必须能在 **enforcing** 模式下正常运行，且**不得要求用户关闭安全模块**。

受影响路径（策略需允许，权限不变）：

| 路径 | 权限 | 用途 |
| --- | --- | --- |
| `/run/kore` | `0700 root:root` | socket 与运行目录 |
| `/var/lib/kore` | `0700 root:root` | 状态库、插件版本目录、secrets |
| `/etc/kore/config.yaml` | `0600 root:root` | 配置与口令哈希 |
| `/var/log/kore` | `0640 root:kore` | 日志与审计导出 |

- **SELinux**：M3 提供 `kore.te` 与 `kore.fc`（源码树 `deploy/selinux/`）与安装说明（`semodule -i kore.pp`、`restorecon -Rv`）。enforcing 下若被拒绝，启动必须**明确失败并打印 AVC 指路**（`ausearch -m avc -c kored`），**禁止静默降级**——自动 `setenforce 0` 或吞掉 `EACCES` 都不允许。
- **AppArmor**：M3 提供 `deploy/apparmor/kored` profile 与 `apparmor_parser -r` 说明；被拒绝同样打印 `dmesg | grep -i apparmor` 指路，不得静默继续。
- **明确不做**：不要求用户关闭 SELinux / AppArmor（不把 `setenforce 0`、`aa-disable` 写进任何步骤）；**不自动修改系统安全策略**——改策略属宿主级高危操作，kore 只输出所需路径与指引，由运维决策并留痕。
- **与退出码衔接**：安全模块拦截导致状态目录不可写 → **退出码 3**（状态目录不可用）；策略缺失但路径仍可写 → `WARN` 不阻断启动，除非配置显式开启严格模式（`security.strict_mac: true`）。环境级硬要求缺失（内核、架构）仍走 [ADR-0009](./DECISIONS/0009-compatibility-baseline.md) 的退出码 6。

### 6.3 三平台隔离强度

Tier A 与 Tier B 的隔离能力**不是同一量级**，必须在文档与 UI 中都披露，不允许用"支持三平台"掩盖差异：

| 平台 | 用户隔离 | 身份校验 | 资源硬限 |
| --- | --- | --- | --- |
| Linux（Tier A） | 独立 uid `kore-<id>` | `SO_PEERCRED`（uid + pid） | cgroup v2（`memory.max` / `cpu.max` / `pids.max`） |
| macOS（Tier B） | 独立 uid | `LOCAL_PEERCRED` | 无强制限额，仅观测 + 告警 |
| Windows（Tier B） | **同用户运行**，无 UID 隔离 | hello 携带 HMAC（每插件独立密钥） | Job Objects（只限资源，不构成安全边界） |

- **Linux**：最强。uid + cgroup + peercred 三重，插件越界即被内核拒绝。
- **macOS**：uid + peercred 仍在，但无内存/CPU 硬限；超限只能观测告警，不能强制回收。
- **Windows 残余风险三条（写死）**：
  1. 恶意插件与主壳同用户，可读主壳可读的任意文件（含配置与状态库）→ 缓解：插件目录 ACL 收窄（`icacls` 等价），状态库与配置目录单独 ACL 拒绝插件账号；插件只经 UDS 通信。
  2. HMAC 密钥若落盘即被同用户插件读取 → 缓解：密钥仅经环境变量传入，进程启动后不再落盘，插件退出即失效。
  3. 同用户下无法阻止插件直接读写主壳 socket 之外的文件 → 缓解：业务能力仍受 capabilities 校验，越权返回 `E_UNAUTHORIZED`，并写审计。
- **明确不做**：不为 Windows 实现 AppContainer / 低完整性级别（IL），M4 再评估；**不声称 Tier B 具备 Tier A 的隔离强度**。

## 7. UDS 本地攻击面

- 主壳管理入口 `/run/kore/kore.sock` 属 `root:root`，**0600**；父目录 `/run/kore` 为 `0700 root:root`。只有 root 可直连——**文件权限即边界**，CLI 与运维脚本以 root 运行是刻意前提。**可达性 ≠ 授权**：连上管理 socket 仍需 `withAuth` 校验会话（ADR-0043），登录门不被文件权限绕过。
- 插件 socket `/run/kore/plugins/<id>.sock` 由主壳 listen 后 `chown kore-<id>`、**0600**；accept 后取 `SO_PEERCRED`，对端 uid 必须等于 `kore-<id>`、pid 必须等于 hello 自报 pid，否则立即 close 并记审计。其它插件用户既读不到也连不上。
- 启动时先 `Lstat` 校验 `/run/kore` 属主为 root 且非 symlink，再删除残留 socket 并 `bind`；父目录不可写使插件无法替换 socket。
- 残余风险：root 可直连管理入口（等价宿主完全控制，不额外防御；**连上仍需 `withAuth` 会话**，ADR-0043）；能读 `/etc/kore/config.yaml` 的账号已等同 root 级别。

## 8. 输入校验与危险操作

- **标识符**：插件 id `^[a-z][a-z0-9-]{1,30}$`；方法名 `^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,31}$`。
- **路径**：一律 `filepath.Clean`，结果必须前缀匹配 `filepath.Join(root, id)`；用 `os.Lstat` 拒绝符号链接；`/plugin-assets` 只放行 `js`/`css`/`svg`/`png`/`woff2`/`json`。
- **子进程**：只用 `exec.Command(binPath, args...)`，**永不经过 shell**；args 由主壳构造，不拼接插件或浏览器输入；不使用 `sh -c`、`bash -c`、`system()`。
- **包名与清单一致**：包文件名必须匹配 `<id>-<version>.tar.gz`，且与 `info.json` 的 `id`/`version` 完全一致，不一致返回 `E_INVALID`（防替换包身份）。
- **解压**：逐条目 `Clean(header.Name)` 后必须仍在目标目录内；`Typeflag` 非 regular/dir 一律拒绝（含 symlink、hardlink、device）；单包大小以 [CORE](./CORE.md) 的 `body_limit` 为真源，解压后 ≤ 128 MiB、条目 ≤ 2000、单文件 ≤ 64 MiB；先解到临时目录，校验通过后 `rename` 原子落位，失败清理。
- **请求体**：JSON body ≤ 1 MiB；上传包走流式读取并卡 [CORE](./CORE.md) 的 `body_limit` 上限，超限立即断流。
- **帧**：解码前先读 4 字节长度，> 8 MiB 直接断链并记 `E_INVALID`，不分配对应缓冲。

### 8.1 预设注入防护

场景预设来自索引仓库（可被第三方镜像、可被篡改），因此 preset 是**不可信输入**，不是配置模板快捷方式：

- **`config_template` 只允许白名单键**：仅接受 `site.*` / `db.*` / `log.*` / `store.mirror` 等显式列举的键；出现白名单外的键（如 `security.login_rate_limit`、`auth.*`、`supervisor.*`）整条预设拒绝，不允许"部分应用"。
- **应用前必须过 schema 校验**：预设里的每个键都按配置 schema 校验类型与取值范围，校验失败即 `E_INVALID` 并整条丢弃；写入成功后记审计 `preset.apply`（含 preset id、`preset_snapshot_version`、插件清单摘要）。
- **预设不得携带可执行内容**：只允许"插件 id + 版本区间 + 配置模板"三样；出现 `web` 资产、脚本、`entry`、二进制路径、`capabilities` 覆盖声明等字段一律拒绝——能力只能来自插件自身 `info.json`，不能被预设"授予"。

### 8.2 冷启动风暴防护

**资源耗尽也是一类攻击**：`lazy` 插件的冷启动是"一次请求 → 拉起一个进程"的放大操作。攻击者（或一个写错的脚本）在插件空闲退出的瞬间并发打同一方法，会让主壳同时拉起 N 个进程、把 CPU 打满，而每个进程又因为争抢而在 hello 阶段超时——最终既没有服务，也耗尽资源。

三条缓解同时生效：

- **单插件启动互斥**：同一插件同一时刻只允许一个冷启动在跑，其余请求进入等待队列，不并发 spawn（否则 `spawn → 超时 → 杀 → 重 spawn` 会形成抖动循环）。
- **队列上限**：每插件等待队列默认 32（可配），达到上限直接拒绝，不允许无界堆积把内存吃穿。
- **超限 `E_RATELIMIT`**：被拒绝的请求返回 `E_RATELIMIT` 并带 `Retry-After`，写审计 `plugin.start_suppressed`；调用方应退避重试，而不是立即重打。

配套约束：冷启动 `hello` ≤ 300ms 超时（见 [ADR-0013](./DECISIONS/0013-extreme-resource-frugality.md)），超时即杀进程并释放互斥，避免"一个卡死的冷启动锁死整个插件"。配额与上层限速（登录限速、SSE 上限）相互独立，不互相抵扣。

## 9. 密钥与配置

- `/etc/kore/config.yaml` 权限 `0600 root:root`；`auth.admin_password_hash` 可读但不可逆，PBKDF2-HMAC-SHA256 600,000 次迭代使单次校验约 0.2s 量级，配合 60s 内 5 次失败锁 300s 的限速后在线爆破不可行。
- **插件 secret 存储决策**：不把秘密混进状态库，单独存 `/var/lib/kore/secrets/<plugin-id>.json`（`0600 root:root`，目录 `0700`）。理由：状态库备份与导出不连带泄露、单插件可独立轮换与删除、迁移成本与 `state.db` 解耦。M0–M2 明文（无主密钥时的加密是自欺）；M4 引入主密钥 `/var/lib/kore/master.key`（`0600`），用 XChaCha20-Poly1305 信封加密，文件内保留 `v` 字段支持逐文件迁移。
- 配置热重载**不重读** `auth.admin_password_hash`，防止替换配置文件后提权；改口令需重启并写审计 `config.change`。
- 环境变量白名单：`KORE_CONFIG`、`KORE_STATE_DIR`、`KORE_HTTP_ADDR`、`KORE_WEB_DEV`、`KORE_LOG_LEVEL`，其余忽略。

## 10. 升级链安全

- **来源与校验链**：包由 `kore-plugin-<id>` 仓库的 release 提供（`<id>-<version>.tar.gz` + 同名 `.sha256`）→ 安装时 kore 自行计算并记录 `plugins.package_sha256`（**不采信包内或索引声明的哈希**）→ M4 起叠加 ed25519 签名校验 → `info.json.requires_kore` 与当前内核版本不兼容直接拒绝（`E_UNSUPPORTED`）。`kore-plugins` 索引只做格式校验与发现，不代管包、不审核、不是信任源（见 [ADR-0008](./DECISIONS/0008-multi-repo-topology.md)）。
- **插件前端资产不 embed**：插件前端在 `kore-plugin-<id>` 仓库内用任意栈构建，产物以 `web/` 进包，安装时落到 `/var/lib/kore/plugins/<id>/<version>/web/`；`/plugin-assets/<id>/*` 由 kore 从该目录读取并托管。**kore 的 `go:embed` 只含主壳前端，不含任何插件资产**；kore 对该目录只读（安装/卸载与升级清理除外）。
- **签名对象**：包内除 `signature` 外所有文件的规范化清单（路径 + sha256，按路径字节序排序）拼接后做 **ed25519** 签名，结果存包内 `signature`。公钥内置二进制，可选追加 `/etc/kore/trusted_keys/*.pub`（root 所有，0644）。
- **校验顺序**：先按 8 节上限解压到临时目录 → 计算清单摘要 → 验证签名 → 通过才 `rename` 落位。即使签名未过，恶意内容也只存在于受限临时目录且从未执行。
- **M0–M3**：`plugins.allow_unsigned` 默认 `true`，安装未签名包必须在 UI 二次确认，并写审计 `signature.absent`。
- **M4**：默认改 `false`，未签名包返回 `E_UNSUPPORTED`；临时开启需显式改配置并在 UI 红条提示，开关变更写审计。公钥轮换保留上一版一个周期。

## 11. 审计与日志脱敏

- 审计写 bbolt `audit` bucket，**保留目标 90 天**（与 [DATA-MODEL](./DATA-MODEL.md) §11 一致），**已实现自动按龄清理**：由 scheduler 内置任务 `builtin-audit-clean` 执行（ADR-0044），`audit.clean_enabled: false` 时退回手工清理：`login.success`、`login.failed`、`auth.logout`、`session.expired`、`plugin.install/enable/disable/upgrade/uninstall`、`plugin.ui_load_failed`、`capability.denied`、`invoke.<plugin>.<method>`（写/管理类；`audit.invoke_all=true` 时全量）、`invoke.burst`（同方法 1s 内超 10 次合并）、`config.change`、`signature.absent`、`signature.reject`（**无独立 `ratelimit.hit` 事件**：惩罚中的错误口令记为 `login.failed`，reason=`rate_limited`）。登录审计的 `ip` 保留前 3 段、`user_agent` 截断 100 字符，口令不落库。
- **清理入口唯一 + 内置任务身份约束**（P1 修复，`a0cd926`）：`audit.clean` 只允许内核固定内置任务 `builtin-audit-clean` 执行；`POST /api/v1/scheduler/tasks` 拒绝 `plugin="kore"`（400 `E_INVALID`，任务不落库），其他任务 id 调 `audit.clean` 一律拒绝。参数硬下限 `retention_seconds ≥ 24h`、`batch` 1–10000——任何一次清理都删不掉最近 24h 的审计，即使任务参数被伪造或残留旧值。**被拒绝的清理尝试**（冒用任务 id / 非法参数）写一条 `audit.clean(result=error)`，detail 带被尝试的 `retention_seconds` / `batch`（可解析时）；API 创建被拒在入口就 400，不产生该审计。
- **留痕边界（如实）**：① 拒绝留痕是 **best-effort，不是 fail-closed**——`audit.clean` 审计写入失败只 WARN，不阻止清理；② 这条 error 记录本身最终也按保留期被清理，但**同一次清理删不掉它**（新记录晚于本次 `cutoff`）；③ 真正「删不掉」需要归档 / WORM 存储，**本轮未做**。
- **日志字段白名单（M1-14 计划，当前未实现）**：目标字段集合为 `ts`、`level`、`event`、`req_id`、`plugin_id`、`method`、`code`、`dur_ms`、`bytes` 等，落地后按白名单重建、白名单外字段丢弃而非透传（fail-closed）。**现状**：`access_log` 中间件与白名单重建均未实现（`internal/core/httpapi/middleware.go:269` 标注归 M1-14），当前只有 `req_id` 注入；该集合**不含** `ua_hash` / `ip_hash`（全仓无此日志字段）。
- 禁止记录：口令、token、cookie、secret、`Authorization`、完整请求体、签名原文；`ip`/`ua` 只存 sha256 前 16 字节。
- 日志文件 `/var/log/kore/kore.log`（插件为 `/var/log/kore/plugins/<id>.log`）权限 `0640 root:kore`；轮转容量以 [DATA-MODEL](./DATA-MODEL.md) 为唯一真源（内核 10 MiB × 5、插件 10 MiB × 2），本文件不另立数字。

## 12. 无联网声明

运行期**零出站连接**：主壳不主动外联，插件默认无出站许可（声明 `net:read`/`net:write` 才允许，M3 起叠加 egress 策略）。唯一例外是用户显式触发：证书续期检查（也是唯一允许的常驻定时器，可关）与插件包下载（地址只来自已验签索引的 `download_url`，不接受请求体传入 URL）。没有远程账号、没有联网校验、没有隐藏上报、没有功能封锁。

验证手段：`ss -tnp | grep kored` 应为空；CI 静态检查 `net.Dial` / `http.Get` 只允许出现在白名单包内，越界即失败。

### 12.1 软件商店与联网边界

商店不改变"零后台出站"的底线，只是把出站收敛到**用户显式触发**的少数入口：

- **运行期零后台出站**：空载 `ss -tnp` 必须为空，不存在定时轮询商店、心跳上报或版本检查。
- **例外仅三类**：用户显式 `POST /api/v1/store/refresh`、安装/更新时的包下载、ACME 证书续期（由插件发起，需 `net:write` 能力且受 egress 策略约束）。
- **索引是发现渠道不是信任源**：M2 起索引条目必须带 sha256，安装时 kore 自算并与索引声明比对，冲突即拒。
- **包下载信任链（`POST /store/install` `download=true`）**：地址只取自已验签索引的 `download_url`，请求体没有任何字段能注入 URL（防 SSRF）；协议只允许 `https://`（拒 `http://` / `file://` / `gopher://` 等）；下载**边下边算 sha256**，必须与索引声明一致才安装，不一致立即删除临时文件并回 **502 `E_UPSTREAM`**——摘要校验不设跳过开关；单包上限 64 MiB、客户端 60 s 总超时，临时文件无论成败都删除（`<state_dir>/tmp/`）。`store.allow_unsigned=true` 是运维显式选择的信任空窗（写 WARN 审计），不改变上述下载门禁。
- **索引签名前移到 M2（信任空窗 = 0）**：M2 即引入**索引级 ed25519 签名**，不等 M4——公钥内置在 kore 二进制，签名对象 = **索引文件本体**；未签名索引默认拒绝，`store.allow_unsigned=true` 需显式配置并写审计。插件包签名仍按 M4 时间线（见 [ADR-0012](./DECISIONS/0012-scenario-presets-and-store.md)）。
- **离线导入包**：`--offline-dir` 下的包走**同一条**安装链路——sha256 + `info.json` schema + 路径穿越/符号链接/zip-bomb 防护全部沿用第 8 节，不另写一套宽松逻辑。
- **镜像源**：`store.mirror` 支持 `https://` 与 `file://`；镜像内容仍按本地计算的 sha256 校验，镜像不可信不能成为跳过校验的理由。

## 13. 安全默认值清单

| 项 | 默认 | 可改 | 影响 |
| --- | --- | --- | --- |
| HTTP 监听 | 关闭（仅 UDS） | `KORE_HTTP_ADDR` | 开启即把攻击面从本机扩到网络 |
| 监听地址 | `127.0.0.1:8787`（开启时） | 配置 | 改 `0.0.0.0` 暴露到内网 |
| `auth.cookie_secure` | `auto` | 配置 | 逐请求判定（§3.4）：TLS 或本机反代 `X-Forwarded-Proto: https` 才加 `Secure`；纯 HTTP 不加 |
| 会话 TTL | 168h（7d）滑动 / 30d 绝对 | `auth.session_ttl`（1m–720h） | 调大增加劫持窗口；阈值 `min(24h, ttl/2)` 决定写盘频率 |
| 登录限速 | 60s 内 5 次失败后按 1s→30s 递增延迟（无锁定期） | 配置 | 只惩罚错误口令，正确口令始终放行（§3.5）；`lock` 是惩罚记忆窗口 |
| 两步验证（TOTP） | 关闭 | 安全页主动开启（口令 + 动态码确认） | 开启后登录需口令 + 6 位动态码；恢复码 10 个单次有效（§3.6） |
| 登录 IP 白名单 | 关闭（关闭时放行所有来源） | 安全页配置 CIDR | 开启后 fail-closed：列表为空 / 未命中 / 解析失败一律拒登（§3.6） |
| API token | 不预置；新建默认 90 天，上限 365 天 | 安全页生成 / 吊销，scope `read` / `admin` | `read` 仅安全方法；明文只回显一次；无 IP/UA 绑定（§3.6） |
| 插件签名 | `allow_unsigned=true`（M4 改 `false`） | 配置 | 未签名期无法证明来源 |
| 插件包大小 | 以 [CORE](./CORE.md) `body_limit` 为真源 | 配置 | 调大增加解压炸弹面 |
| 单插件内存 | 12 MiB | `resources.memory_mb`（取声明与上限较小值） | 超限被 cgroup OOM kill |
| 常驻插件内存合计 | 24 MiB（单插件 ≤12 MiB） | 不支持 | 合计触顶或常驻数达 3 时拒绝再启用新常驻插件（配额上限 3、推荐 ≤2） |
| 单插件 CPU | 0.5 核 | `resources.cpu_quota` | 超限被限流 |
| 单插件 PID | 以 [RESOURCE-MODEL](./RESOURCE-MODEL.md) 为准（默认 128，范围 16–512） | `resources.pids_max` | 超限 fork 失败 |
| swap | 0 | 不支持 | 防止内存挤压旁路 |
| 主壳 socket 权限 | 0600 root:root | 不支持 | 仅 root 可直连管理入口；**连上仍需会话**（ADR-0043） |
| 运行目录权限 | 0700 root:root | 不支持 | 非 root 无法枚举或替换 socket |
| 插件 socket 权限 | 0600 | 不支持 | 降权才能收紧，不能放宽 |
| 插件目录权限 | 见 §6 权限口径 | 不支持 | 同上 |
| 日志级别 | `info` | 配置 / 运行时 | `debug` 可能带敏感上下文 |
| 审计保留 | 30 天或 10 万条 | 配置 | 影响取证窗口与磁盘占用 |
| SSE 连接上限 | 64（单会话 1 条） | 配置 | 影响长连接占用的 FD |

## 14. 加固路线

**M3**：插件 egress 策略（nftables 按 cgroup 匹配）、`SO_PEERCRED` 全链路校验、限速状态持久化、审计导出为 JSONL、签名校验预研与试运行（不强制）、内存压力下的降级路径。

**M4**：ed25519 强制签名 + 公钥轮换流程、主密钥信封加密 `/var/lib/kore/secrets/*.json`、可选 seccomp 配置文件（opt-in，加载失败降级为不启用并告警）、SBOM 生成、依赖 CVE 扫描进 CI。

两条不变式贯穿所有阶段：主壳是唯一裁决点；任何"方便"的改动不得让插件获得跨信任边界的能力。

## 15. 提权模型（ADR-0018；插件降权 2026-11-23 已实现）

需要宿主权限的插件（firewall / site / waf / dns / container / runtime-\*，以及跨用户目录的 backup）**不以 root 运行**：Linux GA 下 `kored` 以 root 启动、插件一律降到 `kore-<id>`；需要 root 的动作只能由内核**直接 `exec`**（ADR-0049：新进程组 + 真实退出码，不经 `systemd-run` / polkit / shell）执行，插件自身永不获得 root。方案对比、实现选择、被否决方案与复审条件见 [ADR-0018](./DECISIONS/0018-privilege-model.md)；真机证据（命令 + 退出码 + 原始输出）见 [r5-plugin-demotion](../.agents/verify/r5-plugin-demotion.md)。

### 15.1 已实现（不再是"承诺"）

- **进程身份**：root 内核下，supervisor 在 bind / exec **之前**解析（必要时按需创建）`kore-<id>`；`exec.Cmd.SysProcAttr.Credential` 写入 uid/gid，并**显式把补充组收为仅目标 gid**（否则子进程继承 root 的 `docker` / `sudo` 等组 = 换 uid 不换实质）。用户建不出来 / chown 失败 / Credential 写入失败 → **本次启动失败**（`E_INTERNAL` + 可操作提示），绝不退回同 uid。
- **socket 与身份校验**：插件 socket 由主壳 listen 后 `chown kore-<id>`、`0600`；hello 阶段用 `SO_PEERCRED` 校验 `pid` 且（降权时）`uid == kore-<id>`，不符即拒绝进入 ready。凭据不可用而处于降权状态时 **fail-closed**。
- **插件 → 内核 root-action 通道（独立 socket）**：`<run>/kore-channel.sock` 为 `root:kore 0660`，插件用户通过共享组 `kore` 获得 connect 权限；请求必须同时通过 bearer（token 所属插件 == 路径插件）、`SO_PEERCRED` 的 uid==`kore-<id>` 与 pid==supervisor 记录的子进程、`system:admin` 能力四关。管理入口 `kore.sock` 保持 `0600 root:root` 不放宽；拒绝路径落 `capability.denied` 审计并 WARN。
- **目录收口**：`KORE_STATE_DIR`（`<pluginDir>/<id>`）`0700 kore-<id>`；状态根/运行根 `0701 root:root`（只补 o+x，可穿越不可列举）；版本树补 `o+rx` 让插件能 exec 自己的二进制（属主与写权限不动）。详见 §6。
- **非 root 内核是显式降级**：启动时 WARN「插件降权未生效（插件与内核同 uid）」，插件仍需 root 的动作只能返回 `E_NEED_ROOT`，管理面经 root-action 通道执行。
- **降级必须显式**：非 root 时插件返回 `available=false` + `E_NEED_ROOT` + 可操作 `hint`；平台无进程组语义时返回 `502 E_UPSTREAM`（显式拒绝，不退回「只杀直接子进程」）。**无 systemd 不再是降级条件**（ADR-0049）；`E_NO_SYSTEMD` 常量保留、不再触发。禁止静默失败、空 error、把权限错误映射成 `E_INVALID`。
- **审计 fail-closed**：每次提权（含被拒绝的）写 `root.action`；字段 `actor / plugin_id / action_id / argv（脱敏）/ unit / decision(allow|deny) / deny_reason / exit_code / dur_ms`（时间在 bbolt 键里，字典序即时间序）。实现顺序：**执行前**先写一条 `phase=begin` 的 allow 记录，写失败即返回 `E_INTERNAL` 且不拉起 unit；执行后补一条 `phase=end` 携带 `exit_code/dur_ms`。审计未装配按失败处理（不允许"没装配就不审计"）。
- **不可回滚动作**（防火墙 / IP 与路由 / 服务重启 / 包卸载 / 删备份 / 容器删除）需一次性 `confirm` 令牌二次确认：`GET .../confirm-token` 只允许管理会话签发（插件 bearer 不得自签），令牌 5 分钟有效、绑定 `plugin_id + action_id`、单次核销、进程重启即失效。一次一确认，不批量静默执行。
- **调用方边界**：管理会话需 `system:admin`；插件经 `KORE_PLUGIN_TOKEN` bearer 只能调用**自己**声明的动作，且该插件必须已获 `system:admin`；插件 token 只在进程存活期有效（spawn 注入、退出即清），比较用常量时间。插件永远不会拿到 root，也不会执行 sudo/setuid。

### 15.2 降级矩阵（低权下逐能力核对；完整表见 ADR-0018「实现记录」）

| 插件 | 动作 | 低权可用性 | 失效时的正确行为 | 证据 |
| --- | --- | --- | --- | --- |
| echo / monitor | 协议握手、`/proc` `/sys` 只读 | **可用** | — | 实测 |
| logs | 读 world-readable 文件 | **可用** | `0640 root:adm` 的 `/var/log/syslog` → 权限错误 + hint，不得返回空列表冒充"没有日志" | 实测 |
| terminal | PTY + 登录 shell | **可用**，shell 即插件 uid | `sudo` / `ufw` / `nft` 全部被拒（exit 1）；UI 必须显示会话身份 | 实测 |
| firewall | 读状态（经通道）、写规则 | 读经管理会话通道 **可用**；插件自连通道被 `kore.sock 0600` 阻断 | `available=false` + `E_NEED_ROOT` + hint；不可回滚动作另需 confirm | 实测 |
| process / file | `/proc` 读、允许根内读写 | 读可用；kill 仅同 uid、越权路径按 DAC 拒绝 | `E_NEED_ROOT` / `E_ACCESS` + hint | 代码审阅（未装） |
| site | 写 `/etc/nginx` + reload | **不可用** | `E_ACCESS` / `E_NEED_ROOT` + hint；需声明 `root_actions` 或改插件自有前缀 | 代码审阅（未装） |
| container | `docker.sock` | **不可用**（不在 docker 组） | `E_NEED_ROOT` + hint；**禁止**把插件加进 docker 组（等价 root） | 实测（插件 shell） |
| waf / dns / runtime-* | 改系统配置 / 装包 | **不可用** | `E_NEED_ROOT` + hint，待声明 `root_actions` | 设计推演（未验证） |

> 硬约束：**禁止**为了"都能用"把插件加入 sudoers、给 `CAP_SYS_ADMIN`、或把目录放宽成 0777——那等于换皮不换实质。

### 15.3 插件 → 内核 root-action 通道（独立 socket，已实现）

历史问题：§7 的 `/run/kore/kore.sock` 是 `root:root 0600`，插件降权后连它得 `connect: permission denied`，`firewall.status` 退化为 `E_NEED_ROOT`（曾在隔离实例 `chmod 0666` 才跑通）。**已按 lead 裁决的方案①落地**：

| 项 | 实现 |
| --- | --- |
| socket | `<run>/kore-channel.sock`（`kore.sock` 旁），**0660 root:kore**；管理入口 `kore.sock` 仍 `0600 root:root` |
| 组 | 共享系统组 `kore`（root 内核启动时创建）；插件用户降权时加入该组，随 `Credential.Groups` 获得 gid |
| 路由 | 通道只接受 `POST /api/v1/plugins/<id>/root-action`；其它路径 404；**完全不接受管理会话 cookie** |
| 校验 | ① bearer token 有效且 token 所属 id == 路径 id；② `SO_PEERCRED` uid == 该插件 `kore-<id>` uid；③ pid == supervisor 记录的子进程 pid；④ 已获 `system:admin`。任一不符 401 + `capability.denied` 审计（不向调用方泄露具体失败点） |
| 失败策略 | root 内核下通道建不起来（组/属组/listen）→ kored 启动失败（exit 6/5），不静默降级；非 root 内核不建通道，插件 `KORE_KERNEL_SOCK` 缺省 → 显式 `E_NEED_ROOT` |

被否决：②放宽 `kore.sock` 到 0660（所有 kore 组进程可连管理面，爆炸半径过大）；③只由管理会话发起（插件自主 root 动作彻底不可用，waf/dns 自动响应报废）。
**残余取舍（见 §15.4）**：共享组方案下 socket 属主是 `root` 而非 `kore-<id>`（无法用单 socket 表达每插件属主）；身份边界靠 bearer + uid/pid 双校验，而非文件属主。若未来要"每插件一个通道 socket"，需引入按插件 listener，成本更高。

#### 15.3.1 写宿主动作的账本与降级（ADR-0049 §5.1）

root 的管理能力本身是产品能力的一部分，因此提权通道的**写宿主动作**必须可被用户在面板/账本上读懂并回滚，而不是只留在内部审计里：

| 规则 | 实现（`privilege/hostwrite.go` + `cmd/kored/changes.go`） |
| --- | --- |
| 声明 | `root_actions[].writes_host=true` 时 `target`（影响对象）必填；`purge_op` 只允许出现在 `writes_host=true` 的动作上 |
| 成功落账 | `exit_code=0` 且未超时 → 追加一条 `changes.jsonl`（`summary`=description、`target`、`reversible`、结构化 `purge_op`）；**账本未装配 → fail-closed 拒绝执行**（`deny_reason=change_ledger_unavailable`） |
| 无回滚信息 | `writes_host=true` 但无 `purge_op` → **降级为需一次性 confirm 令牌**（`NeedsConfirm`，与 `irreversible` 同一出口；`confirm-token` 端点用同一判据，不会出现"降级了却签不出令牌"） |
| 回滚执行 | 只按白名单 `purge_op.kind`（`file.remove` / `file.restore`）分派，路径必须绝对且非根、无 `..`；**账本内不存 shell 命令字符串**，未知 kind 直接拒绝 |
| 与审计的分工 | bbolt `audit` 仍是**事前 fail-closed** 的取证链（`root.action` begin/end）；`changes.jsonl` 是**事后产品记录**（用户可见、可回滚）。账本写失败不回滚已执行动作，但 WARN 留痕且响应 `host_change_recorded=false`，不静默 |

**未放宽的边界**：审计 fail-closed 口径不变（`begin` 写不进去仍拒绝执行）；账本不能替代审计，也不因为"有账本"而跳过审计。

#### 15.3.2 受控写目录白名单（`KORE_FILE_WRITE_ALLOW_DIRS`，fail-closed）

受控文件写（[ADR-0052](./DECISIONS/0052-nginx-vhost-controlled-write.md)）只能写到**白名单前缀**内，两类来源分工明确：

| 来源 | 谁定义 | 例子 | 能否由插件/环境改写 |
| --- | --- | --- | --- |
| 协议类别目录 | 内核 `pluginapi.FileWritePrefixClasses`（唯一真源） | `/etc/nginx/conf.d/` | 否——新增类别 = 扩内核写面，须改 ADR-0028 §8 并新增 ADR |
| 安装路径目录 | **安装/运维侧运行时注入**：`Environment=KORE_FILE_WRITE_ALLOW_DIRS=<list>` | `<install>/data/ssl/` | 是——值由 unit 决定；未注入 = 空 |

四条判据（都是拒绝式，不是建议）：

1. **默认拒绝**：`ssl_certificate*` / `auth_basic_user_file` 的白名单缺省为空，此时一律返回"白名单为空"的拒绝。`file_write` 调用本函数**不会**放宽 `DefaultFileWriteOptions()` 的口径。缺注入的后果是**装完带证书的 vhost 全失败**（安装器因此强制注入，见 [RUNBOOK-INSTALL §6.1.2](./RUNBOOK-INSTALL.md)）。
2. **格式**：`os.PathListSeparator` 分隔（Linux `:`）；每条必须绝对、不得含 `..` 段 / `$` / 反斜杠 / 控制字符；规范化后补尾斜杠并去重。`/` 会被丢弃（其前缀等于放行一切绝对路径 = 取消白名单）。非法条目**逐条丢弃**，全部丢弃等价于空 = 拒绝。
3. **纯词法、不 stat/不解析软链**：注入发生在进程启动期，按目录存在性拒绝会把启动顺序变成安全条件；软链在注入后仍可替换，注入期解析只是 TOCTOU 假安全。真正的边界是"安装目录不可被非 root 改写"（`root:root` 0755/0700），落盘前还有属主复核（`root:root 0644`）与 `nginx -t` 兜底。
4. **白名单只约束"写"，不授予读**：它不改变插件本身的权限边界，也不给插件 root；越界写入仍然是 `E_INVALID`，不会因为"目录已存在"而放行。

### 15.4 未证明项（明确列出，不得当成已通过）

1. **macOS / Windows（Tier B）**：非 Linux 只有 `ErrUnsupported` 桩，插件仍与内核同用户；§6.3「macOS 独立 uid」仍是目标。
2. **无 `useradd` / `adduser` 的发行版**（部分 Alpine / busybox）：按需建用户只有固定候选路径 + Debian `adduser` 回退，**未实测**。
3. **SELinux / AppArmor enforcing 宿主**：`Credential` + `chown` + o+x 全链路未在 enforcing 下实测。
4. **版本树与清单世界可读（已知约束）**：安装器把插件根/版本目录归一为 0755、文件 0644/0755（否则非 root 启动的 kored 读不到清单）；当前包内只有二进制、`info.json` 与前端资产，可接受；**触发条件**：一旦插件包内含证书 / 私钥 / 口令等敏感材料，必须改为按包属主可读（`0700 kore-<id>`，或安装期按清单 chown 到插件用户 + 目录 0700），否则等于把敏感材料暴露给所有本地用户。
5. **插件可写自己的状态目录**（含版本子目录的父目录）：能破坏/替换自己的版本目录，只影响自身可用性，不构成提权；未做防篡改。
6. **root ↔ 非 root 切换**：先以 root 运行（目录已 chown 给 `kore-<id>`）再以非 root 运行会因目录不可进入而启动失败；未做自动回切，仅保证错误可见（清单读取失败现在会给出 chown/chmod 可操作提示，不再只打"未安装"）。
7. **共享组 `kore` 的回收**：`kore uninstall` 目前按前缀清理 `kore-<id>` 用户/组，**共享组 `kore` 的删除未纳入**（空组无害，但属残留）；跨发行版 groupadd/usermod 的 busybox 形态未实测。
8. **通道抗重放/限流**：通道复用 root-action 的 confirm/审计，但没有独立速率限制；同组内恶意插件可高频触发被拒请求（仅产生 WARN/审计噪音，不越权）。

### 15.5 root 提权为何不需要口令（结论：系统级 root 服务）

用户裁决：「root 管理本来也是这个软件的功能的一部分，不应该有任何一次输入账号密码确认」。ADR-0018 只定了「谁来执行」（最初实现为内核经 `systemd-run --uid=0` 的 transient unit；ADR-0049 起改为内核直接 `exec`），**没定「谁来授权」**——默认 polkit 策略下 `org.freedesktop.systemd1.manage-units` 是 `auth_admin`，于是普通用户跑 `kored` 时每个 root 动作都弹管理员口令框（实测：`systemd-run --uid=0 --pipe true` → `Failed to start transient service unit: Access denied`，journal 记 `FAILED to authenticate to gain authorization`）。这是产品级否决。

**结论（ADR-0042 方案 B + ADR-0049）**：`kored` 以**系统级 root 服务**运行（`/etc/systemd/system/kore.service`，`User=root`），特权动作由内核**直接 `exec`**（新进程组 + 真实退出码）——机制上已不存在 polkit 判定这一步，也不依赖 systemd 运行时。于是运行期**不存在授权判定这一步**，也不可能出现口令输入；这与 `dockerd` 以 root 运行、`docker run` 从不要口令同构。插件仍是独立低权进程（`kore-<id>`），G-04 与 ADR-0018「插件低权、内核代理特权动作」原意不变。方案对比、代价（root 进程面、目录属主迁移、两实例互斥）与复审条件见 [ADR-0042](./DECISIONS/0042-privilege-without-prompt.md)；安装走 `scripts/install-system-service.sh`（幂等、`--dry-run`，只写 ADR-0023 §3.5 豁免 #1 的 unit）。

**为什么不是"配一条 polkit 规则"**：规则只是把弹框改成静默 YES，**每次操作仍过一次 authorization check**；规则丢失/被覆盖/被收紧时会退回弹框，违反用户「任何时候都不应该有本机账号密码的输入」这条绝对约束；而且规则本身是一个静默提权面（等价于该用户可免密以任意 uid 起 `kore-root-*` 单元），需要新增 ADR-0023 豁免项。因此 polkit 规则只保留为**降级路径 A**：


#### 降级路径 A：polkit 免密规则（仅当必须普通用户运行服务时）

`scripts/install-polkit-rule.sh` 写入一条 polkit 规则（默认 `/etc/polkit-1/rules.d/49-kore.rules`，目录按本机实际存在性选择），只对**调用方指定的 kore 服务用户**放行 `manage-units`，且必须同时满足 5 条收紧条件（action id / `subject.user` / `subject.local && active` / `verb ∈ {start,kill,stop,reset-failed}` / unit 名匹配 `^kore-root-<plugin>-<action>(-<8hex>)?\.service$`）；其余一律 `polkit.Result.NOT_HANDLED`，交回系统默认 `auth_admin`，**不写无条件 YES，也不写 NO**。

- **等价于什么**：该服务用户可**免口令**、以**任意 uid（含 uid=0）**启动/终止 `kore-root-*` 前缀的 transient unit。这本身是提权，不是"配置小改"。
- **与 ADR-0018 的关系**：授权发生点从「每次操作弹框」前移到「安装时一次性显式执行脚本」；授权范围由 unit 名前缀白名单收敛；执行面不变（仍是内核代理 + 固定 argv + 审计 fail-closed）。
- **审计**：unit 名携带插件 id + 动作 id（`kore-root-<plugin>-<action>-<rand8>`），`journalctl -u <unit>` 看 stdout/stderr，`journalctl _COMM=systemd-run` / `polkitd` 看发起者与授权结果，kored 的 `root.action` 审计（`actor/plugin_id/action_id/unit/decision/exit_code`）看业务侧；三方可对上。
- **撤销**：`bash scripts/install-polkit-rule.sh --remove`（幂等；须在已有 root 上下文的系统服务 / 安装期执行——普通用户 shell 会权限不足，这是降级路径 A 的**已知缺口**，见 [ADR-0042](./DECISIONS/0042-privilege-without-prompt.md)），polkitd 监听规则目录自动重载；`--dry-run` / `--check` 可非 root 只读校验（`--check` 用假 polkit 沙箱跑 13 条断言）。
- **最小权限的边界**：仍默认拒绝同用户对其他 unit（`nginx.service`、`kore.service`）的任何 manage-units 操作；`disable`/`mask`/`edit`/`set-property` 等危险 verb 不放行；`unit` 名带 shell 注入字符不匹配正则即拒。
- **与 G-11「多用户 RBAC 不做」的关系**：本条**不是** RBAC。`subject.user` 是安装时钉死的单个服务身份，没有角色、没有按用户分权、没有授权表；它只回答"本机这台 kore 的服务用户能否免口令执行自己的 root-action 白名单"，与"多用户各自权限"无关。多用户 RBAC 仍明确不做。

**（仅方案 A）这条规则要不要进 ADR-0023 §3.5 豁免清单？——要。** 它新增了一处安装目录外写入（`/etc/polkit-1/rules.d/49-kore.rules`，0 字节代码、1 个文件），按 G-31「新增任何安装目录外写入必须先改 ADR-0023」必须列为豁免项。建议文案（由 ADR 维护方落笔，本轨不改 ADR-0023）：

> | 5 | polkit 免口令规则（可选，仅 systemd 环境） | `/etc/polkit-1/rules.d/49-kore.rules`（或 `/usr/share/polkit-1/rules.d/`） | `kore uninstall` / `scripts/install-polkit-rule.sh --remove`（删文件，polkitd 自动重载） | 仅当选择"root 提权零口令"安装时写入；规则按 `subject.user` + `kore-root-*` unit 名前缀收敛，卸载后立即恢复口令授权 |

> 未入豁免清单前，本脚本按"用户批准的可选安装步骤"执行、默认不运行；拒绝接受此提权的用户继续走每次弹口令的 `auth_admin` 路径（功能可用，体验降级）。
