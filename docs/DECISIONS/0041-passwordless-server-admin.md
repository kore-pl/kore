> 状态: superseded-in-part · 归属: architect · 更新: 2026-11-23 · 里程碑: M5 · 取代: [0043-login-gate-vs-passwordless-ops](./0043-login-gate-vs-passwordless-ops.md)（仅核心「本机通道即认证」；逐条见文末「取代关系」）
> ADR 状态: superseded-in-part（**不是 rejected**：§2.A 本机免密被 ADR-0043 取代并已撤除，§2.B 会话参数与 §4 兼容条款仍有效且已落地；按档位逐条见文末「取代关系（2026-11-23）」）· 关联: ../SECURITY.md §3.2–§3.4/§4、../CORE.md §2.3/§2.4、../RUNBOOK.md、[0018-privilege-model](./0018-privilege-model.md)、[0026-credential-transport](./0026-credential-transport.md)、[0043-login-gate-vs-passwordless-ops](./0043-login-gate-vs-passwordless-ops.md)

# ADR-0041: 服务器管理免密认证（本机 socket 免密 + 长会话 + 可撤销 token）

## 0. 背景与产品级否决

### 0.1 用户原话（硬约束，不是优化建议）

> **「需要我输入密码的设计肯定是不行的，服务器管理的时候不可能每次让输入密码」**

这是一条**产品级否决**：任何"每次管理操作都要人输一次口令"的形态直接判定不成立，不需要再论证性价比。

### 0.2 当前被这条否决咬到的现场（2026-11-23）

一整天大量 agent/自动化需要访问管理 API，全部卡在 `401 E_UNAUTHORIZED`，只能靠"起隔离实例 + 现场造口令 + 登录换 cookie"绕过；真实运维场景更糟——每敲一个命令都要先登录一次，产品没人会用。

根因不是"口令太弱"，而是**认证模型只有一种身份**：口令登录换来的浏览器 session cookie。本机（Unix socket）、CLI、自动化、面板四种调用方被强行塞进同一个"必须先有人输口令"的入口。

## 1. 现状实测（2026-11-23，逐条给证据）

### 1.1 面板会话 TTL 与续期

| 观测项 | 事实 | 证据 |
| --- | --- | --- |
| 默认 TTL | **12 小时**（`DefaultTTL = 12 * time.Hour`） | `internal/core/auth/session.go:23` |
| 配置项 | `auth.session_ttl`，取值域 **1m–720h**（30 天），默认 12h | `internal/core/config/validate.go:62`、`internal/core/config/types.go:167`、`internal/core/config/parse.go:132` |
| cookie 有效期 | `MaxAge: int(m.ttl.Seconds())` = **43200 秒** | `internal/core/auth/session.go:116` |
| 服务端过期 | `sessions` bucket 的 value **只存一个整数**：`expiry.UnixNano()` | `internal/core/auth/session.go:69-74` |
| 校验口径 | `Validate` 只做 `time.Now().Before(expiry)`，**不写回、不刷新** | `internal/core/auth/session.go:100-104` |
| 活跃是否续期 | **不续期，固定过期**（全仓无 `last_seen` / `renew` / cookie 重发） | `grep -rn "续期\|renew\|last_seen\|Touch" internal/core/auth internal/core/httpapi` 仅命中限速器与注释 |
| 实测配置 | 本机 `.kore-local.yaml` 显式 `auth.session_ttl: "12h"` | 配置文件（运行态资产，未改动） |

**结论 1**：12h **固定**过期，不是滑动。面板放一天不用就得重新登录；这不是"每次操作都要输"，但已经足以让自动化与长时运维频繁断线。

**结论 2（文档与实现偏差，G-06 欠账）**：`docs/CORE.md:54` 写"TTL 12 h，剩余 < 2 h 时滑动续期"，`docs/SECURITY.md:32`/§3.3 写"12h **滑动** TTL，每次鉴权刷新 `last_seen`，绝对上限 7 天"、value 含 `created`/`last_seen`/`ua_hash`/`ip_hash`。**代码两条都没实现**：无滑动、value 只有一个整数、无 UA/IP 绑定。本 ADR 不掩盖这一点：现状按代码事实描述，文档需在实施第 1 步纠偏或补齐。

### 1.2 Unix socket 访问是否需要口令/会话

```
$ ls -l .kore-local-run/
drwx------  pt pt  .kore-local-run
srw-------  pt pt  .kore-local-run/kore.sock

$ curl -s -o /dev/null -w '%{http_code}\n' --unix-socket .kore-local-run/kore.sock \
    http://localhost/api/v1/system/info
401
```

| 观测项 | 事实 | 证据 |
| --- | --- | --- |
| socket 权限 | **0600**，属主=运行用户（本机 `pt pt`，非 root） | `internal/platform/linux.go:81-89`（Listen 后 `os.Chmod(path, 0o600)`）；`ls -l` 实测 |
| 运行目录权限 | **0700** | `internal/platform/linux.go:57`；`ls -l` 实测 `drwx------` |
| 鉴权是否读 socket 身份 | **不读**。主监听器上没有任何 `SO_PEERCRED` 判定 | `internal/core/httpapi/middleware.go:29-49` 只查 cookie；`SO_PEERCRED` 仅用于插件通道 `httpapi/channel.go:79` 与 supervisor hello `supervisor/hello.go:143` |
| UDS 与 TCP | 同一 `mux` + 同一 `withAuth`，**都要求 session cookie** | `internal/core/httpapi/server.go:323-326`、`middleware.go:38-47` |
| 是否有 "UID 0 / socket 属主免密" | **完全没有** | 全仓 grep `Geteuid`/`uid==` 无鉴权豁免分支 |
| 实测结果 | UDS 无 cookie → **401**；TCP 127.0.0.1 无 cookie → **401** | 上列 curl 输出 |

**结论 3**：socket 的 0600 已经是一道真实的 Unix 权限边界（别人连不上），但**连上之后仍要口令**——文件系统权限被浪费了，等于"门锁了还要再敲一次暗号"。这是本 ADR 要修的核心缺口。

### 1.3 是否有长期 token / API key 机制

| 观测项 | 事实 | 证据 |
| --- | --- | --- |
| 长期 token / API key | **没有**（无 bucket、无 CLI、无配置项） | `grep -rn "token\|api_key" internal/core/auth internal/core/httpapi` 命中项只有：session token、CSRF token、confirm-token |
| 唯一的 bearer | **插件进程内 token**（`KORE_PLUGIN_TOKEN`，spawn 注入、退出即清） | `httpapi/middleware.go:67-86`（仅 root-action 路径接受）、`docs/SECURITY.md:306` |
| CLI 子命令 | `serve` / `version` / `install` / `audit` / `uninstall` / `status` / `admin-password` / `help` —— **没有 token** | `cmd/kored/main.go:38-53` |
| 运维改口令入口 | `kored admin-password`（写 `auth.admin_password_hash`，0600 原子写） | `cmd/kored/admin_password.go:285-309` |

**结论 4**：只有"口令登录 + session"一条路。自动化只能：造口令 → `POST /auth/login` → 解析 `Set-Cookie` → 维护 cookie jar。这就是今天所有 agent 被迫起隔离实例的直接原因。

### 1.4 口令到底用在哪（调用点全列）

| 调用点 | 位置 | 性质 |
| --- | --- | --- |
| `POST /api/v1/auth/login` 请求体 `{password}` | `internal/core/httpapi/handlers_auth.go:20-23`、`:56-64` | **唯一**接受口令的入口 |
| 口令校验 | `handlers_auth.go:64` → `auth.Manager.Verify` → `internal/core/auth/session.go:56` → `internal/core/auth/password.go:102` | PBKDF2-HMAC-SHA256，600000 迭代 |
| 口令校验成功 → 签发 session | `handlers_auth.go:73-82`（`Issue` + `SetCookie`） | 口令到此为止，后续全靠 cookie |
| 口令写入（运维） | `cmd/kored/admin_password.go`（首启 bootstrap / `admin-password` 子命令） | 只写哈希，不回显明文 |
| 其余 **全部** 端点 | `internal/core/httpapi/middleware.go:43`（`sessionFrom` 失败即 401） | **不校验口令，但被 session 连累** |

**结论 5**：真正需要口令的只有**一次登录**；**没有任何管理操作本身需要口令**。所谓"每次输密码"是 session 太短 + 没有任何本机/长期凭据替代方案造成的**认证机制缺失**，不是操作真的需要口令。这一点决定了方案方向：**加认证通道，而不是给每个操作加口令。**

### 1.5 今天 401 的现场（只读端点）

```
GET /api/v1/system/info   （UDS，无 cookie）→ 401 {"code":"E_UNAUTHORIZED","message":"未授权","detail":""}
GET /api/v1/system/info   （TCP 127.0.0.1:8787）→ 401
GET /api/v1/store/plugins （UDS，无 cookie）→ 401
GET /-/healthz            （TCP）→ 200
```

| 端点 | 无会话 | 是否只读 | 是否该要求认证 |
| --- | --- | --- | --- |
| `GET /api/v1/system/info` | 401 | 是（版本/路径/能力报告） | 面板/远程需认证；**本机 socket 应免密放行** |
| `GET /api/v1/store/plugins` | 401 | 是（商店列表） | 同上 |
| `GET /api/v1/audit` | 401 | 是，但含操作者/时间 | 保留 `system:read` 能力校验（`httpapi/audit_gate.go:26-29`） |
| `GET /-/healthz` | 200 | 是 | 探针例外，保持（`middleware.go:94-98`） |

**结论 6**：只读端点**不应**对"本机 + 合法 socket 连接"要求 cookie；但**不应**对 TCP/远程裸放行——`system/info` 含 `paths`、能力报告，`store/plugins` 含商店拓扑，公开等于给扫描器送情报。正确切法是**按传输通道分级**，不是"只读就放行"。

## 2. 备选方案（A 必须有 / B 长会话 / C 长期 token / D 二期 / E 否决）

### A. 本机特权免密（认证 = 文件系统权限）——**采纳**

**做法**：主监听器在 UDS 上读 `SO_PEERCRED`；若对端 `uid` 等于 socket 属主（或 `0`），直接注入"本机管理员"actor，**不要求 cookie、不要求 CSRF**（本机进程无浏览器 CSRF 面）。

- 权限模型：run 目录 `0700`（已有，`platform/linux.go:57`）+ socket `0600`（已有，`linux.go:89`），属主 = 运行用户或 root。
- 多用户机器：非属主用户**连不上**（EACCES），不存在"低权只读用户"——这与 G-11（不做多用户 RBAC）一致。
- 审计：记 **uid / pid / 可执行名**（`SO_PEERCRED` 提供 pid/uid/gid，Linux 可读 `/proc/<pid>/comm`），不记"会话"。现有 `login.success` 审计字段是 `{ip, user_agent, session_id_prefix}`（`httpapi/audit_http.go:95-110`），本机通道需新增一类 `local.access`（uid/pid/comm/path）。
- 复用现成能力：`platform.PeerCred` 已实现（`internal/platform/linux.go:105-120`），只是主监听器没接。

**为什么这是正解**：Unix 的既有信任模型就是"能读写这个 socket 的人就是管理员"——`docker`（`/var/run/docker.sock`）、`systemd`（`/run/systemd/private`）、`postgres`（`/var/run/postgresql/.s.PGSQL.5432`）都这么做，**不引入任何口令**。Kore 没有理由比它们更啰嗦。

**否决的替代**：给 socket 加"本机口令"——等于把问题原样搬一层，直接违反用户否决。

### B. 面板会话长时有效（7 天 + 滑动续期）——**采纳**

- 默认 `auth.session_ttl` 从 **12h → 7d（168h）**；保留 1m–720h 取值域（`config/validate.go:62` 无需改）。
- **滑动续期**：每次鉴权通过时，若剩余 < 续期阈值（建议 24h），在同一事务里写回新 expiry 并重发 `Set-Cookie`（`Max-Age` 同步刷新）。当前 `Validate` 是只读比较（`auth/session.go:100-104`），需扩成"校验+续期"。
- 绝对上限：滑动续期**不得无限延长**——建议绝对 30 天封顶（写死 expiry 的 `created+30d`，需要存 created，见 1.1 偏差项）。
- 失效条件：登出（`handlers_auth.go:143-152`）、改口令（当前**不吊销**既有会话，`docs/CORE.md:244` 已明示；本 ADR 建议改为"改口令即吊销全部会话"）、显式吊销（`Manager.Revoke`，`auth/session.go:107-113`）。

**安全边界**：`HttpOnly` + `SameSite=Strict` + 双提交 CSRF + 同源校验（`middleware.go:104-173`）已覆盖跨站面；长 session 的真实风险是**同机读取浏览器数据/进程内存**与**XSS**。缓解：`Secure=auto`（非回环 HTTP 打 WARN，`SECURITY.md` §3.4）、写操作仍强制 CSRF、改口令全局吊销、审计每次登录的 IP 前 3 段 + UA 截断（已有）。**不做** UA/IP 硬绑（现状也没做，硬绑会让移动网络用户频繁掉线，收益低）。

### C. 可撤销的长期 API Token（给自动化与 CI）——**采纳**

- `kored token create --scope read|admin --expires 30d --name <label>` → **只在创建时打印一次**明文；服务端只存 `sha256(token)`。
- `kored token list`（只列 id/name/scope/创建时间/过期时间/最后使用时间，**永不回显明文**）、`kored token revoke <id>`。
- 存储：bbolt 新 bucket `api_tokens`（key=hash，value 显式结构 `{id,name,scope,created,expires_at,last_used}`；**不用 `map[string]any`**，G-24）。
- 校验收口仍在 `withAuth`：先试 cookie session，再试 `Authorization: Bearer`；token 命中后按 scope 映射能力集（`read` → `system:read`，`admin` → `system:admin`）。
- 审计：`token.create` / `token.revoke` / `token.denied`；token 明文任何形式不落库、不进日志（沿用 `SECURITY.md` §7 禁止清单）。

**这正是今天 agent 需要的东西**：一次创建、写进 CI secret、按 scope 收窄、可随时吊销——而不是让每个自动化都去造口令、偷 cookie。

### D. 可选增强：passkey / WebAuthn、TOTP —— **v1.0 不做（二期）**

理由（G-11 非目标保护 + G-02 依赖白名单）：

1. WebAuthn 需要新的第三方依赖（当前第三方直接依赖上限 3：`yaml.v3` / `bbolt` / `protobuf`），且要新增注册/恢复/备份流程与前端页面；
2. TOTP 需要时钟偏差处理 + 恢复码 + 丢失恢复流程，属于"账号体系"的边缘，与"单管理员、无用户表"（`docs/CORE.md:21`）冲突；
3. A+B+C 已完全覆盖"服务器管理全程不求人输密码"这个目标，D 只提升"口令被猜中"的抗性——而本机通道已经不用口令，收益集中在远程面板首次登录这一条窄路径；
4. 二期触发条件写进 §7 复审条件，不是永久关闭。

### E. 明确否决项

| 被否决方案 | 为什么不行 |
| --- | --- |
| 口令写进命令行参数（`--password xxx`） | `/proc/<pid>/cmdline` 全局可读、shell history、`ps`、审计/监控采集全部留痕；等于把口令广播给同机所有进程 |
| 口令进环境变量明文（`KORE_ADMIN_PASSWORD=...`） | `/proc/<pid>/environ` 同用户可读、systemd unit 文件与 `systemctl show` 可读、日志采集器常抓 env；泄漏面比命令行更大 |
| 每个管理操作弹一次口令（含 `sudo` 式每命令确认） | **直接命中用户产品否决**（§0.1）；且自动化/CI 无法无人值守执行 |
| 管理 API 完全无鉴权（含 `0.0.0.0:8787` 裸奔） | 同网段任意主机可停机、卸载插件、读审计；`SECURITY.md:29` 已把"未授权访问控制台"列为高危。必须保留"本机 socket 身份 **或** session/token"二选一 |
| 口令/session 放 URL query（`?token=...`） | 进访问日志、`Referer`、浏览器历史、代理日志；`SECURITY.md:239` 明令禁止记录 token/cookie |
| 用 JWT 代替 session（可离线验证、无需服务端状态） | 吊销困难（正是自动化 token 必须可撤销的反面），且需密钥轮换；`docs/CORE.md:58` 已明确不做 |

## 3. 决策建议

**采纳 A + B + C，D 延后，E 全部否决。** 三档模型的分工一句话：

| 档位 | 调用方 | 凭据 | 何时失效 |
| --- | --- | --- | --- |
| A 本机免密 | 本机 CLI / agent / 运维 shell | **无凭据**，认证 = socket `0600` + `SO_PEERCRED` uid | 离开本机 / 非属主用户 |
| B 长会话 | 浏览器面板 | `kore_session` cookie（7d 滑动、30d 绝对上限） | 登出 / 改口令 / 吊销 / 绝对上限 |
| C 长期 token | CI / 自动化 / 远程脚本 | `Authorization: Bearer <token>`（只在创建时可见，存哈希，read/admin scope，可过期） | 过期 / `token revoke` |

**判定口径（写进验收）**：装完 Kore、本机 `curl --unix-socket .../kore.sock /api/v1/system/info` **不需要任何口令/会话**即 200；浏览器首次登录一次后 7 天内不再要求输入；CI 用 token 调用不再构造 cookie。

## 4. 迁移与兼容

1. **不删除 `auth.admin_password_hash`**。删掉会触发首启 bootstrap 重新生成口令并打印到 tty（`CORE.md:57`），反而破坏已有用户的脚本与会话。保留它作为**远程/浏览器首次登录**的一种方式。
2. **不删除 `POST /api/v1/auth/login`**。它是"新浏览器/新设备首次建立会话"的唯一入口，且是 A/B/C 三档里唯一需要人参与的一步——一次性，不是每次操作。
3. 现有 `.kore-local.yaml` 的 `session_ttl: "12h"` **原地保留**（显式配置优先于新默认值）；只有未显式配置的实例升级后拿到 7d 默认。这保证"升级不改变已声明行为"。
4. 已有会话不因升级失效（`sessions` bucket 结构不变；若新增 `created` 字段，旧 value 只有 expiry 整数 → 需**双格式兼容**：解析失败时按"仅 expiry、绝对上限 = expiry"处理，不强制全员下线）。
5. 本机免密默认**开启**，但保留配置开关 `auth.local_socket_admin: true|false`（默认 true），便于"多用户共享机器、只允许 root"的部署收窄到 `false` 后回落到 B/C 档。
6. **安全后果（必须写进 SECURITY.md）**：本机免密 = **能登进这台机器且是运行用户（或 root）的人就能管 Kore**。这与 `docker`/`systemd` 一致，与"面板暴露公网"是两个不同威胁模型。**边界**：这不是多用户 RBAC——不引入用户表、不引入角色矩阵、不为不同 UID 分配不同权限；非属主用户的体验是"连不上"（EACCES），不是"只读"。任何"按 UID 分权"的诉求按 G-11 退回提案阶段。

## 5. 后果与风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 同机其他进程（同用户）可代管 Kore | 中 | 本就是 Unix 模型：同用户进程可读你的 `~/.ssh`、可 `ptrace` 你的进程。要更强就把 kored 跑成独立系统用户（root 或 `kore`），socket 归它 |
| 长 session 被盗（XSS / 浏览器数据） | 中 | `HttpOnly` + `SameSite=Strict` + CSRF + `Secure`（回环/TLS 自动）；改口令全局吊销；7d 而非永久 |
| token 泄漏（CI 日志） | 中高 | 只在创建时显示一次；存 sha256；scope 最小化（CI 用 `read`）；可设过期与吊销；审计 `token.denied` |
| 本机免密被误当成"公网也免密" | 高（认知） | 只在 UDS 监听器上启用；TCP 监听器**永不**走本机 actor；`system/info` 返回当前通道身份（`local`/`session`/`token`）便于排障 |
| 文档与实现继续漂移 | 中 | 实施第 1 步先纠偏 §1.1 的两处假声明，再改代码（G-06：代码与文档不一致不得合并） |
| 资源预算 | 低 | A 复用 `platform.PeerCred`；C 只加一个 bucket 与三条 CLI，无新依赖、无常驻 goroutine（G-19 不破） |

## 6. 实施拆分（5 步，每步可独立验证）

| 步 | 内容 | 独立验证 |
| --- | --- | --- |
| 1 | **文档纠偏**：把 `CORE.md:54` 的"滑动续期"、`SECURITY.md` §3.3 的 `last_seen`/`ua_hash`/`ip_hash`/7d 绝对上限改为事实（"当前固定 12h、未绑定 UA/IP"），或标注"随 ADR-0041 实施"。同步 `SECURITY.md` §3.3 增加"三档认证"小节 | `make docs-check` exit 0；`grep -n "滑动" docs/SECURITY.md docs/CORE.md` 无未标注的假声明 |
| 2 | **B 长会话**：`DefaultTTL` → 7d；`Validate` 改为"校验 + 剩余 < 24h 则写回新 expiry"；中间件在续期时重发 cookie；`sessions` value 改显式结构（含 created），旧整数格式双兼容；改口令吊销全部会话 | 单测：`auth` 包 session 续期用例 + `httpapi` 中间件重发 cookie 用例；实测：登录后 `expires_at` 前移、`Set-Cookie` `Max-Age` 刷新；`go test ./internal/core/auth/... ./internal/core/httpapi/...` |
| 3 | **A 本机免密**：主 UDS 监听器读 `SO_PEERCRED`，uid == socket 属主或 0 → 注入 `local` actor；`withAuth` 在本机 actor 下跳过 cookie 与 CSRF；审计写 `local.access{uid,pid,comm}` | 实测：`curl --unix-socket .../kore.sock /api/v1/system/info` **无 cookie → 200**；`curl 127.0.0.1:8787/...` 无 cookie **仍 401**；非属主用户（`sudo -u nobody curl --unix-socket ...`）→ `000`/EACCES；审计库出现 `local.access` |
| 4 | **C token**：`cmd/kored/token.go`（create/list/revoke）、`internal/core/auth/token.go`（生成/哈希/校验）、bbolt `api_tokens` bucket、`withAuth` Bearer 分支 + scope→能力映射、审计三事件 | 实测：`kored token create --scope read` → `curl -H "Authorization: Bearer $T" .../system/info` 200；`.../plugins/{id}/disable` → 401（read 不够）；`kored token revoke <id>` 后同一 token → 401；`MD5`/sha 比对：库里无明文 |
| 5 | **收口**：`RUNBOOK.md` 补"本机免密 + token 发放/吊销"运维步骤；`SECURITY.md` 威胁表补"本机 socket 被同用户进程连接"一行已存在但需更新缓解口径；`.agents/LOG/DECISIONS.md` 记 G-23 裁决 | `make check` 全绿（16 段）；`make secret-check` 无命中；`git show --stat` 只含预期文件 |

**依赖顺序**：1 → 2 → 3 → 4 → 5。第 3 步（本机免密）是用户否决的直接解，若时间紧可先做 1+3，2/4 紧随。

## 7. 复审条件

出现以下任一情况时重开本 ADR（而不是永久冻结）：

- `kored` 默认绑定非回环地址（`0.0.0.0` / 公网），本机免密的信任前提失效；
- 出现真实的多用户/多租户诉求（G-11 变更），必须同时重画权限模型，不得在本 ADR 上打补丁；
- socket 权限被放宽（>0600 或目录 >0700），或 `SO_PEERCRED` 不可用的平台（Tier B：macOS/Windows preview）需要降级方案；
- 出现一次自动化 token 越权/泄漏事故；
- 依赖白名单放开到可引入 WebAuthn/TOTP 且远程面板成为主入口（此时 D 档转正）。

## 8. 未确认项（如实标注，不猜）

1. **现状 12h 是否已在真实运维中造成"每天重登"**：本次只做了代码与单点 curl 实测，没有用户侧使用时长统计（无遥测，G-10 也不允许加）。
2. **Tier B（macOS/Windows preview）的本机免密等价物**：Windows 命名管道 ACL、macOS `LOCAL_PEERCRED` 需分别验证，本 ADR 只定 Linux GA（Tier A）口径，Tier B 降级方案未设计。
3. **7d / 24h / 30d 三个数值的最终取舍**：属可调参数，需 lead 拍板；代码只保证"默认值 + 显式配置优先"。
4. **`local.access` 审计是否会显著增加写放大**：本机高频调用（agent 轮询）下每条请求写一条审计可能过密，建议只记写操作与首次连接；需在第 3 步实测后再定。

## 实施注记（2026-11-23 追加；上文正文按 ADR 惯例保持历史原样，冲突处以代码为准）

**性质**：本节只追加事实说明，不改写 §1.1 与 §6 的原始记录。§1.1 是 ADR 立项时（2026-11-23 早）的实测快照，其「固定 12h」结论已被同一日的后续实现取代。

| §1.1 原文（立项时事实） | 现行事实 | 证据 |
| --- | --- | --- |
| 默认 TTL **12 小时**（`DefaultTTL = 12 * time.Hour`）、cookie `MaxAge` 43200 | `DefaultTTL = 7 * 24 * time.Hour`（168h）；cookie `MaxAge = int(m.ttl.Seconds())`，默认 604800 | `internal/core/auth/session.go:26`、`:297` |
| `sessions` value **只存一个整数** `expiry.UnixNano()` | value 为 `"<expiryUnixNano> <createdUnixNano>"` 两段纳秒戳；旧单整数格式仍可读（按 TTL 反推 created）；bucket 内另有保留键 `password-fingerprint` | `internal/core/auth/session.go:103`、`:139-158`、`:36` |
| 活跃**不续期，固定过期**（无滑动、无 cookie 重发） | 已实现滑动续期 `Slide`：仅当剩余寿命 < `min(24h, ttl/2)` 时把 expiry 推到 `now+ttl`（不越过 `created+30d`）并重发 cookie | `internal/core/auth/session.go:164-206` |
| 绝对上限 **7 天** | `AbsoluteTTL = 30 * 24 * time.Hour`（30 天） | `internal/core/auth/session.go:29` |
| §6 步骤 1 写「把文档纠偏成**固定 12h**」 | 该步已被实现取代：文档改为描述「默认 168h 滑动 + 阈值 `min(24h, ttl/2)` + 绝对 30 天」，**不是**「固定 12h」 | 见下方取代提交 |

**取代本 ADR §1.1 现状描述的提交**：

- `0cae448` `feat(auth): 面板会话 TTL 7 天 + 滑动续期` —— 改 `DefaultTTL` 为 7d、新增 `Slide`、value 增加 created 段、引入 30d 绝对上限。
- `72bb463` `fix(core/auth): 滑动续期阈值改为 min(24h, ttl/2) 消除短 TTL 写放大` —— 续期阈值由固定 24h 改为 `min(24h, ttl/2)`。
- `51dde8e` `docs(core): 会话 TTL 口径同步代码现状（默认 7d / 阈值 min(24h,ttl/2) / 绝对 30d）` —— `docs/CORE.md` §2.3 与 `docs/DATA-MODEL.md` §3.1 已按代码同步。

**§1.1 中仍然成立的部分**：会话层「无 UA/IP 绑定」成立（`ua_hash` / `last_seen` 在 `*.go` 全仓零命中）；`auth.session_ttl` 取值域 1m–720h 成立（`internal/core/config/validate.go:62`）。

**接口路径**：`GET /api/v1/self` 在实现中不存在，实际注册为 `GET /api/v1/auth/session`（`internal/core/httpapi/handlers.go:87`），响应 `{authenticated, expires_at}`；`docs/CORE.md` §2.3 已按实际路由改写。

## 取代关系（2026-11-23）

**性质**：本节按 ADR 惯例只追加，上文（含 §1.1 与 §6）一字未改。本 ADR 立项时把「服务器管理不该每次输密码」实现成「本机通道不经登录即管理员」；用户同日裁决「面板必须要有登录页面，我是说操作必须免密」后，[ADR-0043](./0043-login-gate-vs-passwordless-ops.md) 转 accepted 并由 `a68c4b1` 恢复登录门、撤除本机免登身份。故本 ADR 的状态是 **superseded-in-part（部分被取代）**，不是 rejected，也不是 accepted。

**为什么不能标 `rejected`**：rejected 会把整篇连同仍在生效的条款一起判死，读者会以为 §2.B 的「7d + 滑动 + 30d 绝对上限」与 §4 的「不删口令哈希 / 不删登录端点」也作废——而它们正是 ADR-0043 §1「保留 ADR-0041 成果」明文继承的部分，且已是现行代码事实。**为什么也不能标 `accepted`**：本 ADR 从未整体获批，其核心档（§2.A 本机免密）已被否决。三档里只有「按档位逐条判定」能同时表达这两件事，故取 `superseded-in-part` 一词，`· 取代:` 限定字段沿用 [0018](./0018-privilege-model.md) 头部 `· 实现进度:` 的既有写法。

| # | 0041 的决策 | 现状 | 证据 |
| --- | --- | --- | --- |
| A-1 | §2.A 本机特权免密：UDS 读 `SO_PEERCRED`，对端 uid == socket 属主即注入「本机管理员」actor，不要求 cookie/CSRF（`0041:104-115`，§3 三档表 A 行 `0041:162`） | **被 0043 取代**：`withAuth` 对全部 `/api/v1/*` 一律会话校验，UDS / loopback 不再跳过；`defaultCapabilityResolver` 只认 `kore_session`，删除「本机通道 = admin 全权」旁路 | `0043:18-19`、`a68c4b1`、`internal/core/httpapi/middleware.go:106`（认证放行只剩 `/-/healthz`、`/api/v1/auth/login` 与主壳静态资源）、`internal/core/httpapi/local_access.go:11-23`（文件头注释已收窄为「通道识别，不是身份」） |
| A-2 | §1.5 / §3 判定口径：装完本机 `curl --unix-socket .../system/info` 无 cookie 即 200（`0041:95`、`0041:166`） | **被 0043 取代（契约反转）**：同一请求现为 401，登录后 200；只读端点也不按通道分级放行 | `0043:45-49`（未登录 loopback / UDS 均 401、登录 200）、`a68c4b1` |
| A-3 | §2.A 审计：新增 `local.access{uid,pid,comm}` 事件（`0041:110`） | **被 0043 取代**：`local.access` 审计与 context actor 一并删除；本机通道只保留 CSRF 令牌引导与 UDS 的 CSRF 豁免两项**非认证**用途 | `0043:22`、`internal/core/httpapi/local_access.go:11-23`（只剩 CSRF 引导 / UDS 豁免两项用途的说明）、`a68c4b1` |
| A-4 | §4.5 配置开关 `auth.local_socket_admin`（默认 true，可回落到 B/C 档，`0041:174`） | **作废且从未实现**：登录门无开关，全仓只有本 ADR 自身提到该键 | `grep -rn "local_socket_admin"` 仅命中本文件 `0041:174` |
| A-5 | §4.6 安全叙述「本机免密 = 能登机且是运行用户的人就能管 Kore」，要求写进 SECURITY（`0041:175`） | **被 0043 取代**：SECURITY §3.2 改为「本机通道不是认证，登录是唯一入口」，本机浏览器未登录同样 401 + 登录页 | `docs/SECURITY.md:73`、`docs/SECURITY.md:79`、`docs/SECURITY.md:84` |
| B-1 | §2.B 面板会话默认 7d + 滑动续期（剩余 < `min(24h, ttl/2)`）+ 30d 绝对上限（`0041:117-124`） | **仍有效，已落地**，并被 0043 §1 明文保留 | `internal/core/auth/session.go:26`（DefaultTTL 7d）、`:29`（AbsoluteTTL 30d）、`:164-186`（Slide）、`:188-200`（阈值）、`:297`（cookie MaxAge）、`0cae448`、`72bb463`、`0043:20` |
| B-2 | §4.4 旧会话（value 只有 expiry 整数）双格式兼容，不强制全员下线（`0041:173`） | **仍有效，已落地**：value 写为「expiry created」两段纳秒，旧单整数按 TTL 反推 created | `internal/core/auth/session.go:101-107`（writeExpiry）、`:139-158`（parseSessionValue 双格式）、`0cae448` |
| B-3 | §4.3 显式 `auth.session_ttl` 优先于新默认值（升级不改变已声明行为，`0041:172`） | **仍有效，已落地**：显式配置优先，未配置才取 7d 默认；取值域 1m–720h 未变 | `internal/core/config/parse.go:131-132`、`internal/core/config/types.go:167`、`internal/core/config/validate.go:62` |
| C-1 | §2.C 可撤销长期 API token：`kored token create/list/revoke`、bbolt `api_tokens` bucket、`withAuth` 的 `Authorization: Bearer` 分支（`0041:126-134`） | **未实施，且与 0043 §1「认证只有一个入口」冲突 → 需重新提案**（既非「仍有效」也非「被 0043 取代」：0043 未否决 token 机制本身，但把所有 `/api/v1/*` 收口到会话校验后，Bearer 分支当前无落点） | 全仓 `grep -rn "api_tokens"` 零命中；`cmd/kored/` 无 `token.go`；`0043:18`、`0043:14` |
| D-1 | §2.D passkey / WebAuthn / TOTP v1.0 不做（`0041:136-143`） | **仍有效**：依赖白名单未放开，第三方直接依赖仍是 bbolt / yaml.v3（+ 同仓 pluginapi 嵌套 module）；0043 同轮再次否决 PAM / 系统账号 | `go.mod:5-11`、`0043:32` |
| E-1 | §2.E 否决清单：口令进 argv / 进 env 明文 / 每操作弹一次口令 / 管理 API 完全无鉴权 / 口令进 URL query / 用 JWT 代替 session（`0041:145-154`） | **仍有效**，其中「管理 API 完全无鉴权」一条被 0043 的真机后果反向加强：未登录即可操作全部管理 API 正是 0043 §0 判定必须收回的现状 | `0043:10`、`0043:29` |
| F-1 | §4.1 不删除 `auth.admin_password_hash`（`0041:170`） | **仍有效，且升级为唯一凭据**：0043 把 kore 自己的 Web 登录定为唯一认证入口，凭据即该哈希 | `0043:14`、`internal/core/auth/password.go:3`、`docs/SECURITY.md:75` |
| F-2 | §4.2 不删除 `POST /api/v1/auth/login`（`0041:171`） | **仍有效，且升级为唯一入口**：认证放行白名单里除 `/-/healthz` 与主壳静态资源，只有它 | `internal/core/httpapi/middleware.go:106`、`0043:18` |

**分组结论**：A 组（本机通道即认证，及其判定口径 / 审计 / 配置开关 / 安全叙述）整组退出；B 组（会话时长与升级兼容）是本 ADR 的净遗产，已被 0043 继承并落地；C 组（长期 token）悬空待重新提案；D / E / F 组不受 0043 影响，继续有效。**任何按本 ADR §2.A 重新引入「本机通道即认证」的改动，一律按 `0043:57` 的复审条件退回提案阶段**（须先回答「登录页是否仍然必须存在」）。
