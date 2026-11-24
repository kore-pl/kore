元信息: API 安全红队审计（认证 / CSRF / 传输 / 授权注入 / 审计 / 产品面） | 2026-11-24 10:39–11:05 +08 | 执行: api-security-redteam 子 agent | 对象: kore 内核 HTTP API（`internal/core/httpapi`、`internal/core/auth`、`internal/core/privilege`、`pkg/pluginapi`）| 结论: **不可判定为「已安全」**——发现 P1 三条（审计可擦除 / 登录锁定 DoS / 会话 cookie 默认无 Secure），P2 七条，P3 五条；同时确认 5 项强项（session ID 规范实现、登出真删、0.0.0.0 被拒、root-action 形状策略、审计 fail-closed） | 隔离实例: `/tmp/rt-api2`（127.0.0.1:18901）+ `/tmp/rt-api-20261124`（127.0.0.1:18899），全部 config/state/run/log 落 `/tmp`；**本轮未改动主实例 8787、未改 `.kore-local.yaml` / 主 state / 主 run / 主 log**

# API 安全红队审计 · kore（2026-11-24）

> 用户定调：**「api 加密方面一定要安全，因为他基本是我们唯一的安全机制」**。
> 因此本文的判据不是「有没有做」，而是**「攻击者这样做能不能绕」**。凡标「实测」的条目均在隔离实例上跑过真实请求；凡未跑通的写「未确认」，不编。

## 0. 一句话结论

**kore 的认证底座方向是对的（服务端 SessionId、登出真删、常量时间比较），但有三个洞会把「唯一防线」打穿：**

1. **审计可被 API 自己擦掉**（`POST /api/v1/scheduler/tasks` + `run` → 内置 `audit.clean`，实测 2 条→1 条），事后取证归零；
2. **会话 cookie 默认不带 `Secure`**（`cookie_secure: auto` 在代码里恒等于 false），HTTP 下 7 天根权限令牌明文传输；
3. **登录锁定是全局单桶**（5 次失败锁 300s），任何能到达端口的本地进程可无限锁死管理员登录（实测正确口令也被 429）。

**产品面最关键的一条「好消息」：`0.0.0.0` 会被配置校验拒绝（实测 exit=2），默认连 TCP 都不开（只开 UDS）。** 所以「装完就能被局域网爆破接管」这个最坏叠加**不成立**——除非用户自己加了反向代理/端口转发，此时第 2、3 条才升级为网络可达风险。

## 1. 认证（按「规范 SessionId 10 条」逐条判定）

| # | 要求 | 判定 | 证据（`file:line`） |
|---|---|---|---|
| 1 | 熵 ≥128bit + CSPRNG | **PASS** | `internal/core/auth/session.go:311-317`（`crypto/rand` 32B → base64url 43 字符 = 256 bit）；实测 cookie 值长度 43 |
| 2 | 不透明 | **PASS** | `session.go:88,319-323`；库里只有 `sha256(token)` hex，明文 token 不落库、不进日志 |
| 3 | 服务端存储 | **PASS** | `session.go:23,102-107`（bbolt `sessions` bucket，key=sha256） |
| 4 | 登录时轮换 ID（防 Session Fixation） | **PASS** | `handlers_auth.go:73` 每次登录 `Issue()` 新 token；入站 cookie 被忽略（`Issue` 不读入站值，`session.go:83-99`）。实测两次登录 sessionId 不同 |
| 5 | Cookie：HttpOnly + Secure + SameSite | **FAIL（Secure 缺失）** | `session.go:292-299` 有 HttpOnly、SameSite=Strict；`Secure: m.secure`，而 `m.secure` 由 `cmd/kored/serve_runtime.go:142-143` 传入 `CookieSecure == "true"`——默认值是 `"auto"`（`config/types.go:177`），**`auto` 永远不等于 `"true"` → 默认恒 false**。实测登录响应：`Set-Cookie: kore_session=…; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict`（**无 Secure**） |
| 6 | 绝对过期 + 空闲过期 | **PASS（有语义折扣）** | 滑动 TTL 7d（`session.go:26`）+ 绝对上限 30d（`:29`，`Validate` 在 `:128-134` 双重判定）。折扣：所谓「空闲过期」是滑动续期（`Slide` `:164-186`），**只要令牌被使用就一直续**，没有真正的「N 分钟无操作即失效」独立计数 |
| 7 | 登出真删服务端状态 | **PASS（实测）** | `handlers_auth.go:139-149` → `auth.Revoke` 删 bbolt key（`session.go:212-219`）；实测 logout 200 后旧 cookie 再查 `/auth/session` = **401** |
| 8 | 改密后使其它会话失效 | **部分 FAIL** | 重启时 `ReconcilePasswordFingerprint` 会 `RevokeAll`（`session.go:257-289`）；但**热更路径明确不吊销**：`internal/core/config/reload.go:18-23` 原文「密码已更新，现有会话不吊销（如需强制下线请重启）」。即：改密不重启 → 被盗会话最长再活 7 天（绝对上限 30 天） |
| 9 | 并发会话可见/可控 | **FAIL** | 无 `GET /auth/sessions` / 无「踢下线」端点（`handlers.go:55-105` 路由表无此项；grep `httpapi` 无 RevokeAll 调用）。实测：第二次登录后**第一次的会话仍 200**，并发会话无上限、不可枚举、不可单独吊销 |
| 10 | 常量时间比较 | **PASS** | 口令：`auth/password.go:102-112` 用 `subtle.ConstantTimeCompare`；插件 bearer：`cmd/kored/serve_runtime.go:186-200` 同样常量时间。会话查询按 sha256 键查表，无逐字节比较面 |

**补充（口令存储）**：`pbkdf2-sha256`，迭代 600000，盐 16B，键 32B（`auth/password.go:28-37,76-96`）。参数合理但 **PBKDF2 不是内存硬函数**，GPU/ASIC 攻击成本显著低于 Argon2id；作为「唯一防线」建议 P3 升 Argon2id（保留 PBKDF2 兼容读）。

**登录失败计数**：`auth/ratelimit.go:9-17`（5 次 / 60s 窗口 / 锁 300s）+ `handlers_auth.go:38-55`（先 `Allow` 后校验，锁定期内正确口令也拒——设计如此，但见 P1-3 的 DoS 后果）。

## 2. CSRF

**实现事实**：双提交，`cookie kore_csrf` == `header X-Kore-CSRF`，常量时间比较；免检路径仅 healthz / login / setup / logout（`httpapi/middleware.go:129-179`）。`kore_csrf` **非 HttpOnly**（`csrf_local.go:61-66`，`HttpOnly: false`），SameSite=Strict，Secure 跟随请求 TLS（本机 HTTP 时为 false）。

**实测矩阵（隔离实例，登录后）**：

| 请求 | 结果 |
|---|---|
| 会话 + csrf cookie，无 header | 401（CSRF 拒绝） |
| 会话 + csrf cookie，错误 header | 401 |
| 会话 + 正确 cookie/header 对 | 通过 CSRF → 404「插件 nope 未安装」（到达鉴权层） |
| **攻击者自选对**：`Cookie: kore_session=<真实会话>; kore_csrf=ATTACKER-CHOSEN` + `X-Kore-CSRF: ATTACKER-CHOSEN` | **404（CSRF 通过）** |

**结论（给判断）**：

- **「无 session 绑定」是真的**：`auth.Session` 结构无 csrf 字段（`session.go:39-47`），服务端只比较 cookie 与 header 两者相等，不校验该值是否由本次会话签发（`middleware.go:143-147` 注释也自认「只做两方比对」）。
- **但单独不可利用**：跨站表单无法设置自定义头；SameSite=Strict 又让跨站请求根本带不上该 cookie。要打通需要**同时具备**「能给受害者写入 cookie」+「能让受害者请求带上匹配 header」两个原语（同源 XSS 或 CORS 配置错误）。同源 XSS 面前 CSRF 本来就没有意义。
- **因此定级 P2（纵深防御缺口），不是 P0/P1**。真正该修的是把 csrf 值绑进会话（服务端存 `session.csrf`，三方比对），顺带解决「XSS 可读 csrf」的观感问题；但**不能指望 CSRF 保护 XSS**——`kore_csrf` 非 HttpOnly 是双提交的硬要求，XSS 拿到它并不能直接伪造跨站请求，代价是少了一层「XSS 也要先想办法拿 token」的摩擦。
- **SameSite 已设 Strict**（会话与 csrf 都是），这是当前 CSRF 的主力防线；`Origin`/`Referer` 校验**没有**（grep 零命中），建议补一条 Origin 白名单作为独立第二防线。
- **logout 免 CSRF**：可被跨站强制登出（`middleware.go:132-135` 自认「只造成一次重新登录」）。可接受，但应记为已知取舍。

## 3. 传输与信息泄露

| 项 | 现状 | 证据 |
|---|---|---|
| TLS | **进程内不支持**，`server.tls: true` 直接配置报错「MVP 固定 off，请由反向代理终结 TLS」 | `config/validate.go:48-49` |
| 强制 HTTPS / HSTS | **无**。无 301 跳转、无 `Strict-Transport-Security` | 实测响应头（下方） |
| 响应头 | **6 项安全头命中 0**：无 `X-Content-Type-Options` / `X-Frame-Options` / `CSP` / `HSTS` / `Referrer-Policy` / `Permissions-Policy` | 实测 `GET /` 全量响应头；grep 仅 `sse.go:146` 有 `Cache-Control: no-store` |
| `Server:` 头 | **无**（Go net/http 默认不写），版本不由此泄露 | 实测响应头 |
| 版本泄露 | 认证后 `GET /api/v1/system/info` 返回 `version: 0.1.0` 与**绝对路径**（state/run/log/index/plugin_dir） | 实测；`handlers.go:17-28,115-131` |
| 错误体 | 统一 `{code,message,detail}`；401 不区分「无 cookie / 过期」；404 不区分「文件不存在 / 类型不支持」 | `middleware.go:21-22,186-189`、`server.go:469-497` |
| 静态缺失泄露路径 | `staticFile` 读 embed 失败时把内部路径写进 `detail`（`server.go:488-492`） | 低危，仅在 embed 不完整时触发 |

**实测响应头（隔离实例 `GET /`）**：

```
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Set-Cookie: kore_csrf=…; Path=/; SameSite=Strict
X-Request-Id: r-8a427f1eecd06eaf
Date: …
Content-Length: 1288
```

> 判读：没有 CSP + 面板是 root 权限控制台 → 任何一处存储型/反射型 XSS 都直接等于 root（XSS 可在同源内调全部 API）。X-Frame-Options/CSP frame-ancestors 缺失 → 点击劫持（诱导管理员点「启用插件/执行 root 动作」）。**P2**。

## 4. 授权与注入

**4.1 只有 admin 一个角色**：单管理员语义，`defaultCapabilityResolver` 对任意有效会话返回 6 项全权（`server.go:158-171`），`authorizeInvoke` 的 capability 检查在生产路径**恒通过**（`invoke_capability.go:107-140`，注释自认）。=> 会话 = root 等价物，这是一切前置结论的分母。

**4.2 API token / 长期凭据**：**没有**给脚本/CI 的长期 token（路由表 `handlers.go:55-105` 无 token 端点）。插件 bearer 仅进程存活期有效、且只对 root-action 路径生效（`middleware.go:33-56`、`supervisor/manager.go:273-283`）。**后果**：所有自动化只能复用 admin 口令或盗来的会话 cookie——口令暴露面更大，且无法按用途撤销/限权。**P2 设计缺口**（与用户问题 6 一致）。

**4.3 命令注入（重点）**：

- 执行面**不经 shell**：`exec.Command(argv[0], argv[1:]...)`（`privilege/exec.go:51`），`LC_ALL=C`，独立进程组、超时 kill 整组（`:36-84`）。
- `argv[0]` 双重限制：白名单命令名，或绝对路径且目录必须在 `/bin,/sbin,/usr/bin,/usr/sbin,/usr/local/bin,/usr/local/sbin`（`rootpolicy.go:40-47,705-725`）；声明 argv 必须落在「命令+子命令+参数形状」表内（`rootpolicy.go:135-270`），`ValidateRootAction` 逐项校验（`rootaction.go:146-204`）。
- **追加参数**（运行时来自插件进程，视为不可信）必须匹配该动作命中的 `Tail` 形状，长度也校验；跨语句只允许最后一段带追加（`rootpolicy.go:529-641`）。nft 的 token 形状显式禁 `;`/引号/反引号/`$`/换行，并禁 `include`/`define`（`:434-448`）。
- HTTP 层：`action_id` 正则 `^[a-z][a-z0-9-]*$`、`DisallowUnknownFields`、64 KiB 上限（`handlers_rootaction.go:19-30,120-135`）；未声明动作 404（`:137-159`）。
- **实测**：`action_id="../../etc/passwd"` → 400；合法语法但未声明 → 404；有效会话 + 伪造 Bearer → 401（**不做 cookie 回退**，`middleware.go:40-52`，这一点很关键，否则「无效 bearer + 有效 cookie」会绕过 CSRF 语义）。

> 判定：**未发现命令注入**。残余风险不在 argv 拼接，而在**策略表本身**（`chmod`/`chown` 允许操作 `/var/lib/kore/**`，`ufw`/`nft`/`fail2ban` 可改宿主防火墙）——这些是「API=root」的既定语义，不是漏洞；但任何放宽形状表的 PR 都应视为安全边界变更（代码注释已要求配 ADR）。

**4.4 路径穿越**：静态资源只认 `/assets/` 单段文件名 + 后缀白名单，含 `/`、`\`、`.`、`..` 一律 404（`server.go:469-483`）。实测 4 种编码（`..%2f`、`%2e%2e%2f`、裸 `../`）全部 404；插件路径穿越请求先被 401 拦下。**未发现穿越**。

**4.5 SSRF**：唯一出站是商店下载，`requireHTTPSURL` 只放行 https，拒 http/file/gopher/data（`installer/download.go:106-114`），并有 60s 墙钟 + 10s 握手超时。**未发现 SSRF**（下载地址来自签名索引，不来自用户输入）。

## 5. 审计与可绕过性

**5.1 fail-closed 成立**：root 动作执行前先写 `begin` 审计，写失败即返回 `E_INTERNAL` 且不执行（`privilege/service.go:206-212`；`privilege/audit.go:90-97` 明确 Auditor 为 nil 时拒绝）。拒绝路径也写 `deny` 审计（`audit.go:99-112`）。**PASS**。

**5.2 审计可被删——实测成立（P1）**：

```
GET  /api/v1/audit?since=2000-01-01T00:00:00Z&limit=1000
  before: count=2  ['login.success','login.success']
POST /api/v1/scheduler/tasks
  {"name":"h","plugin":"kore","method":"audit.clean",
   "params":{"retention_seconds":1,"batch":1000},"interval_s":3600,"enabled":true}
  -> 200 {"id":"tsk-4068c4fdcd59fa56", ...}
POST /api/v1/scheduler/tasks/tsk-4068c4fdcd59fa56/run
  -> 200 {"status":"ok","dur_ms":9}
GET  /api/v1/audit?since=2000-01-01T00:00:00Z&limit=1000
  after : count=1  ['audit.clean']
```

- 根因链：`CreateInput.normalize` 只校验 `plugin`/`method` 的**语法**（`scheduler/input.go:32-74`），不禁止保留值；`invoke` 对 `plugin=="kore"` + `method=="audit.clean"` 直接调 `cleanAudit` 并**使用调用方给的 params**（`scheduler/run.go:38-53`）；`cleanAudit` 按 `retention_seconds` 算 cutoff，`1` 秒即删光（`scheduler/auditclean.go:100-135`），`store.CleanAudit` 按龄删（`store/audit.go:165-200`）。
- 攻击路径：拿到会话（=root）→ 建任务 → 反复 run → 每轮只留一条 `audit.clean`，再等 1 秒把这条也删掉。**「审计 fail-closed」只保证「写不进去不执行」，不保证「写进去删不掉」。**
- 修复：`normalize` 拒绝 `plugin=="kore"` 的用户创建/立即执行（保留值仅内核可写）；`CleanAudit` 增加最小保留期下限（如 ≥24h）与「只能由固定 id 的内置任务调用」。

**5.3 不经过审计的操作**：登录本身**有**审计（`login.success`/`login.failed`，实测 before 里两条都是它）；静态资源、`/-/healthz`、`GET /api/v1/auth/session` 无审计（只读，可接受）；invoke 默认只审计需要 admin 的方法（`audit.invoke_all=false`，`config/types.go:98-102`）——**只读方法调用不留痕**，P3。

## 6. 产品级 8 项（用户追加口径）

| # | 项 | 现状（证据） | 攻击路径 | 严重度 | 对标宝塔/1Panel |
|---|---|---|---|---|---|
| 1 | 默认传输 | 进程内 HTTP only，TLS 被配置层拒绝（`config/validate.go:48-49`）；无 HSTS、无强制跳转 | 用户按文档开 `127.0.0.1:8787` → 本机 HTTP；一旦加反代/端口转发，口令与会话 cookie 在链路上明文；且 cookie 无 Secure，降级到 HTTP 时浏览器**照样发送** | **P1（仅在用户做网络暴露时）** | 宝塔/1Panel 面板强制 HTTPS 或至少提供一键 SSL + HSTS |
| 2 | 监听地址 | 默认 `server.addr` 为空 = **只开 UDS**（`config/types.go:174`）；只允许 `127.0.0.1`（`config/checks.go:12-25`）；实测 `0.0.0.0:8787` → **exit=2**「MVP 只允许回环地址」 | 无（默认不暴露）；本地非特权用户可访问 127.0.0.1 端口（若用户开启 TCP） | **P3（现状是强项）** | 宝塔默认全开 8888；kore 这里**更安全**，应保持并写进文档 |
| 3 | 安全入口 | **不存在**（`grep 安全入口/secret_path` 零命中）；登录页固定在 `/`（实测未认证 `GET /` = 200） | 若用户做端口映射/反代，扫描器直接看到登录页 → 定向爆破（再叠加 #5 的锁定 DoS） | **P2（暴露时）** | 宝塔有随机安全入口；1Panel 有安全入口 + 授权 IP |
| 4 | 端口选择 | 无默认 TCP 端口；**文档/QUICKSTART 建议 8787**（`QUICKSTART.md §2.3`、`DATA-MODEL.md`） | 固定端口 = 指纹，扫描器可识别 kore 面板 | **P3** | 宝塔固定 8888（同类问题）；1Panel 可改 |
| 5 | 登录失败锁定 | 有：5 次/60s → 锁 300s，`Retry-After` 正确（实测第 6 次 429、`Retry-After=300`）；**单桶 key 恒为 `"admin"`**（`handlers_auth.go:15-17`），**无 IP 维度、无递增延迟** | 任意能到达端口的进程每 60s 打 5 次错误口令 → **管理员永久无法登录**（实测锁定期内正确口令也 429）；不需要知道口令 | **P1（可用性，且是可反复触发）** | 宝塔按 IP 限流 + 递增延迟；1Panel 有 IP 白名单 |
| 6 | API token / 长期凭据 | **无**（见 §4.2） | 所有自动化必须存 admin 口令或会话 cookie；一旦泄露，唯一止血手段是改密 + 重启（且热更不吊销会话） | **P2** | 宝塔有 API 密钥 + IP 白名单；1Panel 有 API 密钥 |
| 7 | 响应头安全 | 6 项全缺（实测 0 命中） | 无 CSP → XSS 直接拿 root；无 XFO/frame-ancestors → 点击劫持诱导 root 动作 | **P2** | 两家都未做 CSP，但都做了 X-Frame-Options |
| 8 | 静态/错误页泄露 | 无 `Server:` 头（好）；静态仅 `/assets/` 白名单（好）；**认证后** `system/info` 给版本 + 绝对路径；静态缺失时 detail 带内部路径 | 需要先有会话 → 主要价值是「拿到会话后快速定位安装路径」，辅助提权/横向 | **P3** | 宝塔默认页会泄露版本；kore 现状更好 |

**关于「四个 P0 叠加」的明确判定**：**不成立**。默认是「UDS only + 回环 only + 0.0.0.0 被拒」，装完**不会**被局域网扫到并爆破。真正成立的是「用户自己开 TCP/反代之后」的 **P1 叠加**：无 HTTPS + 无 Secure cookie + 无安全入口 + 全局锁定桶。

## 7. 漏洞清单（按严重度）

### P1（可直接接管 / 可致唯一防线失效）

**P1-1 审计可被 API 擦除**
- 路径：`POST /api/v1/scheduler/tasks`（`plugin:"kore"`,`method:"audit.clean"`,`params.retention_seconds:1`）→ `POST …/{id}/run`，循环执行。
- 证据：§5.2 实测 2→1 条；`scheduler/input.go:32-74`、`scheduler/run.go:38-53`、`scheduler/auditclean.go:100-135`。
- 影响：攻击者拿到会话后（会话=root）可把自己的 root 动作痕迹在秒级抹掉，事后取证链断裂。
- 修复：拒绝用户创建/执行保留 plugin/method；`CleanAudit` 加保留期下限；清理动作只允许固定内置 id。

**P1-2 会话 cookie 默认无 `Secure`（`cookie_secure: auto` 恒等于 false）**
- 路径：默认配置登录 → cookie 无 Secure（实测）→ 用户在反代/端口转发/明文 HTTP 场景下，任何链路旁路（同机抓包、代理日志、降级请求）拿到 7 天根权限令牌。
- 证据：`session.go:292-299` + `cmd/kored/serve_runtime.go:142-143` + `config/types.go:177`。
- 修复：`auto` 解析为「TLS 或 loopback 时 true」；默认改 `true`；HTTP 场景下拒绝登录或强制跳转（当前无 HTTPS 能力，至少要给显式告警）。

**P1-3 登录锁定可被任意本地用户打满（DoS）**
- 路径：`curl -d '{"…":"wrong"}'` ×5 → 全局锁 300s；每 60s 重复即永久锁死。实测锁定期内**正确口令也 429**。
- 证据：`auth/ratelimit.go:9-17,72-95`；`handlers_auth.go:15-17,38-55`。
- 影响：唯一管理员无法登录面板；root 动作无法执行（运维中断）。不需要任何凭据。
- 修复：per-IP（含 UDS/loopback 区分）+ 全局桶只做「高水位保护」；失败延迟递增；锁定期间对**正确口令**放行（当前刻意拒绝，代价是 DoS）。

### P2（纵深防御 / 设计缺口）

**P2-1 CSRF 纯双提交，无会话绑定** —— §2；实测攻击者自选对可通过。单独不可利用，需叠加 cookie 注入 + 头注入原语。修：服务端 `session.csrf` 三方比对 + Origin/Referer 白名单。

**P2-2 改密不吊销既有会话（热更路径）** —— `config/reload.go:18-23` 原文「现有会话不吊销」。修：SIGHUP 检测到哈希变化即 `RevokeAll`（`ReconcilePasswordFingerprint` 已有实现，接到热更即可）。

**P2-3 无并发会话管理** —— 无列表/吊销端点，实测旧会话在新登录后仍有效。修：`GET/DELETE /api/v1/auth/sessions`，UI 展示「登录设备」。

**P2-4 无 CSP / X-Frame-Options / HSTS / X-Content-Type-Options** —— 实测 0/6。修：中间件统一注入（CSP 先 `default-src 'self'` + 逐步收紧，`frame-ancestors 'none'`）。

**P2-5 无安全入口 + 文档固定 8787** —— 暴露时扫到即登录页。修：可选随机入口（默认关闭，避免破坏易用性）+ 文档改成「用随机高位端口」。

**P2-6 无 API token（自动化只能用 admin 口令）** —— §4.2。修：一次性 token 签发 + scope + 撤销 + IP 绑定（与用户「API 是唯一防线」的定调一致，这是产品缺口不是实现 bug）。

**P2-7 `plugins.allow_unsigned` 默认 true** —— `config/types.go`（`Plugins.AllowUnsigned: true`）。未签名插件可装；插件进程虽降权（root 内核下 `kore-<id>`），但可调自己声明的 root 动作。修：默认 false，或安装时强提示 + 二次确认。

### P3（信息泄露 / 加固）

- **P3-1** 认证后 `system/info` 返回绝对路径与版本（实测）；建议只返回逻辑名或按需脱敏。
- **P3-2** PBKDF2 非内存硬（600k 迭代尚可）；建议 Argon2id（保留 PBKDF2 读兼容）。
- **P3-3** 本机 CSRF 引导 token 是**进程级稳定值**（`csrf_local.go:45-57`），且未认证 `GET /` 即可获得；不构成单独绕过（仍需 cookie==header），但「稳定 + 公开可读」放大了未来 cookie 注入类漏洞的可用性。
- **P3-4** 只读 invoke 默认不审计（`audit.invoke_all=false`），只读侦察不留痕。
- **P3-5** `staticFile` 失败时把内部路径写进 `detail`（`server.go:488-492`）。

### 确认无问题的项（不编漏洞，也不漏）

- **Session Fixation 不存在**：登录必发新 token，入站 cookie 被忽略。
- **登出真删**（实测 401）。
- **0.0.0.0 被拒**（实测 exit=2），默认 UDS-only —— 这是相对宝塔的**安全优势**，别在后续版本里为了「方便」放开。
- **root-action 无命令注入**：不经 shell + 命令白名单 + 目录白名单 + 形状表 + 追加参数 Tail + action_id 正则，实测三类注入均被拒。
- **路径穿越 4 种编码全部 404**。
- **SSRF 面关闭**：仅 https + 超时。
- **审计 fail-closed 成立**（写不进不执行）。
- **常量时间比较**（口令、插件 token）。

## 8. 修复优先级

1. **P1-1 审计擦除**（一天内）：一行校验 + 保留期下限，回归测试用本报告第 §5.2 的请求序列。
2. **P1-2 Secure cookie**（一天内）：`auto` → TLS/loopback 为 true；默认 `true`。
3. **P1-3 锁定 DoS**（两天内）：per-IP 桶 + 锁定期内正确口令放行。
4. **P2-2 改密吊销**（两天内，复用已有 `RevokeAll`）。
5. **P2-4 安全响应头**（三天内，中间件一处）。
6. **P2-1 CSRF 会话绑定**（一周内，需改 `auth.Session` 与前端读取方式）。
7. **P2-3 会话管理 / P2-6 API token**（一个迭代，产品面）。
8. P2-5 / P2-7 / P3：随版本收敛。

## 9. 未确认清单（明确不装懂）

1. **子域 cookie tossing 能否稳定压过 host-only cookie**：需要浏览器实测（Chrome/Firefox 的 Cookie 头排序规则不同），本轮无浏览器环境，**未确认**。它决定 P2-1 的「条件利用」在真实浏览器里是否可达。
2. **`Secure` cookie 在 `http://127.0.0.1` 下是否被目标浏览器接受**：影响 P1-2 修复方案（直接默认 true 是否会把本地登录打死）。Chrome 对 localhost 有特例，Firefox 行为需实测，**未确认**。
3. **主壳前端是否存在可利用 XSS**：本轮只审后端与静态托管，未做前端代码审计，**未确认**。若存在，P2-4（无 CSP）会把它直接放大成 root。
4. **未签名插件安装链路**（`allow_unsigned=true`）的实际可利用度：本轮未走商店安装 e2e，**未确认**。
5. **会话查表的时序差异**（bbolt 命中/未命中）是否可测：本轮未做统计采样，**未确认**（令牌 256bit，理论不可利用）。
6. **插件声明的 root 动作在真实插件仓里的形状是否过宽**：本轮实例未安装任何插件（`echo` 未安装），只验证了策略引擎，**未确认**到具体插件粒度。
7. **HTTPS 反向代理下的端到端行为**（cookie Secure、X-Forwarded-Proto 处理）：kore 不读转发头，本轮未搭反代，**未确认**。

## 10. 攻击测试记录（隔离实例原文，已脱敏）

实例：`/tmp/rt-api2`，`server.addr: 127.0.0.1:18901`，state/run/log/index 全在 `/tmp/rt-api2`；PBKDF2 哈希由本机 `hashlib.pbkdf2_hmac('sha256', …, 600000, 32)` 生成后经 `kored admin-password --hash` 写入（与 `auth.HashPassword` 同格式）。**未触碰 8787，未改主配置。**

```
[1] 未认证 GET /api/v1/system/info -> 401 ; GET / -> 200（登录页可被扫描器看到）
[2] POST /api/v1/auth/login -> 200
    Set-Cookie: kore_session=***; Path=/; Expires=…; Max-Age=43200; HttpOnly; SameSite=Strict
    Set-Cookie: kore_csrf=***;    Path=/; Max-Age=43200; SameSite=Strict
    ← 两条都没有 Secure
[6] 安全头命中数（x-content-type-options|x-frame-options|csp|hsts|referrer-policy|permissions-policy）= 0
[7] CSRF: 无头=401 / 错头=401 / 正确对=404（进到业务层）/ 攻击者自选对=404（CSRF 通过）
[8] 两次登录 sessionId 不同=YES；旧会话第二次登录后仍可用=200
[9] 审计擦除：before count=2 ['login.success','login.success']
    create plugin=kore/method=audit.clean retention_seconds=1 -> 200 tsk-4068c4fdcd59fa56
    run -> 200 status=ok dur_ms=9
    after  count=1 ['audit.clean']
[10] 伪造 Bearer + 有效会话 -> 401（不回退会话）
     action_id="../../etc/passwd" -> 400 E_INVALID
     action_id="nginx-reload"（未声明）-> 404 E_NOTFOUND
[11] /assets/..%2f..%2fetc%2fpasswd -> 404
     /assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd -> 404
     /api/v1/plugins/..%2f..%2fetc/enable -> 401
[12] logout -> 200；旧 cookie 再查 /auth/session -> 401（服务端真删）
[13] 连续 5 次错误口令后，第 6 次 -> 429 Retry-After=300
     锁定期内用正确口令 -> 429
[15] server.addr="0.0.0.0:8787" -> exit=2
     配置错误: server.addr MVP 只允许回环地址 127.0.0.1，实际为 0.0.0.0
```

## 11. 与用户定调的对齐

- 用户说「API 加密是唯一安全机制」——**准确**：会话 = 6 项全权 = root，`system/info` 的 `demotion` 也自认非 root 时插件不降权。所以本文把「会话/审计/登录入口」全部按 root 资产定级（P1），而不是按普通 Web 会话定 P2/P3。
- 用户说「不要建议换 JWT」——**同意且未提**：kore 现在是**规范 SessionId**（不透明、服务端存储、登录轮换、真登出、常量时间），方向正确；要修的是 5 个实现细节（Secure、改密吊销、会话管理、CSRF 绑定、锁定桶），不是换模型。
- 用户给的口子 1「CSRF 无 session 绑定」——**确认存在，但定级 P2**，理由见 §2（单独不可利用，需叠加原语）；口子 2「`kore_csrf` 非 HttpOnly」——确认，且它是双提交的硬要求，真正该补的是会话绑定而不是 HttpOnly；口子 3「无 UA/IP 绑定」——确认，但会话 cookie 的 IP 绑定会伤害移动端/双栈，建议改为「异常时告警 + 会话管理页可踢」，不建议硬绑。
