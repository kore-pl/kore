> 状态: draft（ architect 草案，待用户/lead 审阅） · 归属: architect（login-account-model） · 日期: 2026-11-25 · 工作区: /home/pt/Work/GolandProjects/kore-pl
> 纪律: **只出设计，不改任何代码 / 配置 / 运行态；不打印任何真实凭据；commit 不 push、不触发 CI**。唯一写入是本报告 `kore/.agents/verify/login-account-model.md` 及其 commit。
> 用户口径: 「而且登录应该是账号加密码」（本轮）；「还有一次错误后需要动态验证码加每次错误延时」（lead 转述）。
> 结论先行: **单账号有名字（固定账号名 `admin`）+ PBKDF2 口令，非 RBAC，不命中 G-11；一次口令错误后强制本地图形验证码，口令错误按 1s→2s→4s→8s→16s→30s 递增延时；落地 7 张任务卡**。

# 登录账号+密码模型 ADR 草案（ADR-0057 候选）与落地拆解

> 本 ADR 只在报告内定稿为 **draft**，不直接改 `docs/DECISIONS/` 的正式文件（append-only 修订内容在 §7 逐列，待裁决后由 scribe/implementer 追加）。ADR 编号取 0057（现存最大为 0056，见 `docs/DECISIONS/` 目录清单）。

## 0. 必读证据（path:line 原文锚点，先读后设计）

| # | 事实 | 证据 |
| --- | --- | --- |
| E1 | 当前是单管理员、**无用户名**，凭据只有 `auth.admin_password_hash`，非 PAM / 非系统账号 | `docs/DECISIONS/0043-login-gate-vs-passwordless-ops.md:14` |
| E2 | 当前登录页只有口令字段，标题「控制台 · 单管理员登录」；body 仅 `{password, otp}` | `web/app.js:499-519`、`:568-571` |
| E3 | 当前登录 `loginRequest` 仅 Password/OTP，限速 key 固定 `"admin"` 全局桶 | `internal/core/httpapi/handlers_auth.go:15-25` |
| E4 | 当前口令哈希存在 config（`auth.admin_password_hash`），PBKDF2-HMAC-SHA256/600000，安全文档明写「系统只有一个账号，不做用户枚举」 | `docs/SECURITY.md:63-71`、`internal/core/auth/password.go:27-37` |
| E5 | 安全文档曾明确「kore 固定不加用户名：单管理员下用户名不是秘密，固定值不增加安全性，随机值退化为第二个口令」——本 ADR **覆盖该口径**（用户新裁决优先） | `docs/SECURITY.md:75` |
| E6 | 首启凭据文件是 `<install>/data/initial-admin-credential`，0600、gitignore（`.gitignore:68`）、内容**只有明文口令一行**，改密后消费删除 | `cmd/kored/admin_password.go:325-348`、`docs/DECISIONS/0055-initial-admin-credential.md:40` |
| E7 | 首登 `must_change_password` 是**强制闸门**：受限会话只允许改密/登出，其余 `/api/v1/*` 403 | `internal/core/httpapi/handlers_password.go:22-37`、`internal/core/auth/session.go:103-107`、`docs/USABILITY.md:137-149` |
| E8 | 改密请求体仅 `current_password` / `new_password`，无账号字段 | `internal/core/httpapi/handlers_password.go:39-47` |
| E9 | 已有递增延时：5 次宽容后 1s→2s→…→30s；先校验口令后惩罚；正确口令 0 延迟；状态只在进程内存 | `internal/core/auth/ratelimit.go:9-23`、`docs/SECURITY.md:118-141`、`internal/core/httpapi/handlers_auth.go:35-43` |
| E10 | G-11 明令不做「多用户 RBAC」；G-02 依赖白名单上限 3；G-10 无联网/无遥测；G-30 明文凭据不得入库；G-24 禁 `any/object` 逃逸 | `kore/AGENTS.md:47`、`:38`、`:46`、`:66`、`:60` |
| E11 | ADR-0055 §4 已把「多用户 / 角色化凭据」判为命中 G-11 而否决 | `docs/DECISIONS/0055-initial-admin-credential.md:60`、`:76` |
| E12 | USABILITY 四原则：预设优先/自动发现/≤3 步/小白看得懂；错误给「怎么办」，不露内部术语 | `docs/USABILITY.md:22-69`、`:112-116` |
| E13 | 配置 `Auth` 结构体现有字段：hash / TTL / cookie / initialized / must_change；热更白名单含 hash 与 must_change | `internal/core/config/types.go:18-32`、`internal/core/config/reload.go:10,78-83` |
| E14 | 现有 2FA 是**默认关闭的 TOTP**（需用户自备 App），IP 白名单默认关；均非登录失败后的自动挑战 | `docs/SECURITY.md:145-153` |

## 1. 背景与问题陈述

用户新口径「登录应该是账号加密码」推翻了 ADR-0043 与 SECURITY §3.2 的「无用户名」设计前提；同期口径「一次错误后需要动态验证码 + 每次错误延时」要求在现有登录限速之外增加**自动触发的本地挑战**。两次变更都必须落在「单管理员、非 RBAC、零新依赖、无联网、明文凭据不入库」的既定边界内，且**已有安装不丢数据、不强制重新初始化**。

现状不是"缺一个输入框"这么简单：账号是身份标识，牵动配置结构、凭据文件格式、登录/改密契约、迁移路径、错误文案、审计 subject 与登录失败防护；因此开 ADR 而不是直接改表单。

## 2. 选项对比（多选一，含被否决项）

| 维度 | 方案 | 结论 |
| --- | --- | --- |
| 账号来源 | A1 固定账号名 `admin`（单管理员，账号是标识符不是秘密） | **采纳** |
| 账号来源 | A2 安装期随机账号名（与口令一起交付） | 否决：退化为"第二个口令"，多一份落盘/展示/迁移面；SECURITY:75 已论证过 |
| 账号来源 | A3 用户安装期自定义账号名 | 否决：单账号下无安全收益，却要新增输入/校验/改名/迁移链路；不符合「预设优先」（USABILITY §1） |
| 账号体系 | B1 单账号有名字（无用户表、无角色、无授权表、无用户枚举） | **采纳**：不命中 G-11 |
| 账号体系 | B2 允许多个账号但无角色权限 | 否决：命中 G-11「多用户 RBAC」的非目标（用户表 + 按账号鉴权 + 账号管理 API + per-user 会话与限速），退回提案阶段 |
| 账号存储 | C1 config 新字段 `auth.admin_username`，与 hash 同文件、0600 | **采纳**：与 ADR-0055「install 在打开 state.db 前只写 config」同构，避免配置/state 双源漂移 |
| 账号存储 | C2 state.db 新建 users 表 | 否决：引入用户表即接近 B2；且 install 期 state.db 被 serve 独占（ADR-0055 §3.1） |
| 验证码 | D1 本地生成 PNG 图形验证码（stdlib `image/png` + 内嵌点阵字形），答案仅内存存 sha256 | **采纳**：零新依赖、零联网、零账号体系 |
| 验证码 | D2 短信 / 邮箱 / 第三方 CAPTCHA 服务 | 否决：命中 G-10（联网/外部账号），引入新依赖踩 G-02 |
| 验证码 | D3 复用作废的 TOTP（默认关闭、依赖用户 App） | 否决：TOTP 是常开二次验证，不是"一次错误后的自动挑战"；用户未装 App 时无法完成登录 |
| must_change | E1 从强制闸门降级为**可选改密提示**（字段保留，语义降级） | **采纳**（用户明确否定强制项） |
| must_change | E2 维持强制 403 闸门 | 否决：与用户新裁决冲突 |

## 3. 裁决（ADR-0057 草案正文）

### 3.1 账号是怎么来的

1. **账号名 = 固定 `admin`**，安装期/首启自动生成、无需用户输入、不可随机化。定位为标识符而非秘密：安全性仍由口令承担（延续 SECURITY §3.1 的 PBKDF2 口径与 §3.5 的限速口径）。用户口径「账号加密码」要的是**登录表单有账号字段、请求体带账号**，不是"账号保密"。
2. **存储位置**：config 新字段 `auth.admin_username`，与 `auth.admin_password_hash` 同一个配置文件（0600 root:root），**不进 state.db**。理由：E6/ADR-0055 §3.1 的安装期写入时机在 state.db 打开之前；账号不是秘密，无需更高保护；单一事实源避免漂移。
3. **可改性**：账号名在 v1 **不可经 UI 修改**（无改名端点）。解析层对缺失字段一律归一为 `admin`；安装/首启统一入口把 `auth.admin_username: "admin"` 追加写回配置（幂等）。将来若要做改名，必须另开 ADR 并回答"是否变成多账号"（G-11）。
4. **凭据文件格式**（`install/data/initial-admin-credential`，从"一行口令"升级为**显式两行纯文本**）：

   ```text
   username: admin
   password: <REPLACE_WITH_ONE_TIME_PASSWORD>
   ```

   - 纯文本 key-value，不用 JSON（避免与 API body / `recordLoginFailed` 的字段口径混淆）；首行可选 `#` 注释；**不含哈希、不含副本、不含其它账号**。
   - 权限与边界不变：0600、`.gitignore:68:/data/initial-admin-credential` 已覆盖（不新增 gitignore 规则）、运行态资产（G-29）、不入库（G-30）、不进日志/审计、改密成功后由 `ConsumeInitialAdminCredential` 消费删除（`admin_password.go:341-348`）。
   - 报告与文档中的口令一律写占位符；secret-check 扫描 `docs/` 与 `.agents/verify/`（`scripts/secret-check.sh:20,34-39`），本格式模板用尖括号占位不会命中。

### 3.2 单账号还是多账号：G-11 边界

| 形态 | 是否命中 G-11 | 判定依据 |
| --- | --- | --- |
| **单账号有名字**（固定 `admin`，无用户表/无角色/无权限组/无用户枚举/无账号管理 API） | **不命中** | 只是给既有唯一管理员加一个标识符；与 ADR-0055 的 `must_change` 单管理员状态机同类（`0055:43`）；SECURITY §3.1「系统只有一个账号，不做用户枚举」（`docs/SECURITY.md:69`）仍成立 |
| **多个账号但无角色权限** | **命中** | 一旦允许 N 个账号，必然引入用户表、账号校验/枚举、按账号鉴权、账号管理端点、per-user 会话归属与限速分桶、审计 subject 分叉——这就是"多用户"，即使没有角色也是 G-11 的非目标；`0055:60,76` 已把"多用户 / 角色化凭据"判为否决 |

**裁决：只做 B1（单账号有名字）。** 任何"再加一个账号"的需求走 G-11 提案流程，不在本 ADR 打补丁。

### 3.3 迁移兼容（不丢数据、不重新初始化）

1. **已有安装（hash 存在、无 `auth.admin_username`）**：① 配置解析层把缺失的 `auth.admin_username` 归一为 `admin`（立即能登录，无需写盘）；② 下一次 install / serve bootstrap 由统一入口用行级 upsert（复用 `upsertAuthKey`，`admin_password.go:457-507`）把字段原子 0600 写回同一配置；**不重算 hash、不动 state.db/plugins/index、不要求重启或重新初始化**。
2. **老凭据文件（当前只有一行明文）**：读到单行且无 `username:` / `password:` 结构时，自动包装成 §3.1 两行格式（`username: admin` + 原明文），原子 0600 覆写；不校验明文与 hash 是否匹配（避免把恢复流程变成"读 hash + 比对"的新失败面），若用户用该文件登不上，沿用既有 `kored admin-password --set` 重置路径（`0055:46`）。已是新格式则不动（幂等）。
3. **凭据文件与配置哈希不一致的历史情形**（如 `.agents/verify/admin-credential-fix.md:19` 记录的离线 install 覆盖）：本 ADR 不自动重置口令（不可找回是设计前提）；原文件内容先原子备份为 `<install>/data/initial-admin-credential.legacy`（0600、gitignore 增补该确切路径），再按 §3.1 包装；提示用户 CLI 重置。**不删数据、不猜口令**。
4. **老会话**：账号字段不写入会话结构（`internal/core/auth/session.go:51-65` 不改），老 cookie 继续有效；无需全量踢下线。
5. **hash 为空的新装实例**：走 ADR-0055 的统一入口生成口令 + 账号 `admin` + 新格式凭据文件，一次原子写落 `auth.initialized=true`；`auth.must_change_password` 字段保留但语义按 §3.4 降级。

### 3.4 登录、改密与 must_change 降级

1. **登录表单**（`web/app.js:499-556`）：新增「账号」输入框（`id=kore-username` / `name=username` / `autocomplete=username`），**预填 `admin`** 并按 USABILITY 原则 2 标注「默认账号」；口令框与验证码框在其下。提交 body 扩展为 `{username, password, otp, captcha_id, captcha_answer}`（字段全部显式，G-24；OTP 仅在 2FA 开启时填）。
2. **登录校验**（`handlers_auth.go:43-167`）：先账号、后验证码（若处于挑战态）、再口令、再 OTP、最后签发会话。账号不等于配置值时统一回 **401「账号或口令错误」**（与口令错同文案，避免身份枚举）；账号为空回 400 白话「请输入账号」。限速 key 继续固定 `"admin"`，不按输入账号分桶（否则攻击者可用随机账号绕开全局限速）。
3. **改密端点**（`handlers_password.go:39-47`）：请求体新增 `username`（**必填**），与配置账号不符回 403「账号不匹配，无法修改口令」，缺省回 400「请输入账号」；会话 + 双提交 CSRF 两道门保留。单账号下没有真正的跨账号越权窗口，但显式账号让请求自描述、避免误投，并为审计 subject 留一致口径（不建用户表）。失败闭环顺序不变（先吊销会话 → 持久化 → 切内存，`handlers_password.go:52-56,108-124`）。
4. **must_change 从强制闸门降级为可选提示**：`auth.must_change_password` 键名与字段保留（兼容现有配置 / SIGHUP 链路 / 测试），但**不再把会话降权**：登录成功即签完整会话，`mustChangeBlocked` 对 `/api/v1/*` 的 403 取消（`handlers_password.go:22-37` 删除闸门调用，函数体可保留但不再挂中间件）。改为：登录响应附带 `password_change_hint: true`（显式 bool），面板顶部显示可关闭的白话提示「建议尽快把初始口令改成自己的口令」；用户可忽略，不影响任何操作。改密成功仍清标志、吊销旧会话、删一次性凭据文件、写审计（`handlers_password.go:122-135` 保留）。
5. **审计**：登录失败/成功复用现有事件与 IP/UA 脱敏口径（`docs/SECURITY.md:143`），新增 reason `captcha_required` / `captcha_invalid`；改密审计 subject 固定 `admin`。验证码答案、图形、口令一律不进审计（G-30）。

### 3.5 登录失败防护（用户新增口径：一次错误后验证码 + 每次错误延时）

> 目标：第一次口令错误后，**后续登录必须过一道本地图形验证码**；口令继续错误时按阶梯递增应答延时；正确口令始终 0 延迟（不得让攻击者把管理员锁死，延续 SECURITY §3.5）。

| 项 | 裁决 |
| --- | --- |
| 验证码何时触发 | 全局桶（key=`admin`）出现**第 1 次口令错误**即置 `captcha_required=true`。此后每次登录（含同一浏览器的下一次）必须带验证码；**只有登录成功**或管理员 CLI 重置凭据才清除；静默超时只清延时等级、不清验证码要求（fail-secure：一次错误后验证码要求持续到一次成功登录） |
| 如何生成 | 新增公开端点 `GET /api/v1/auth/captcha`：stdlib `crypto/rand` 取 5 位字符（去易混淆字符）→ 用 `image/png` + **代码内嵌 5×7 点阵字形**绘制 PNG（随机噪点/干扰线）→ base64 data URI。零第三方依赖、零字体文件、零网络请求（G-02/G-10）。无图形能力场景（终端/curl）提供同一 challenge 的**文本加法题**替代（`3 + 7 = ?` 形态），答案同样只在内存 |
| 存哪里 | **只在进程内存**：challenge 状态 = `{sha256(answer), expires_at}`，带互斥锁；一次性（校验后立即删除，无论对错），TTL 2 分钟；不落盘、不进 state.db、不进日志/审计、不回传明文答案。重启即失效，登录页重新拉取 |
| 校验顺序与失败口径 | 口令校验前：缺 / 过期 / 答案 hash 不符 → `428 E_CAPTCHA_REQUIRED`（缺）或 `401 E_CAPTCHA_INVALID`（错），**不计入口令失败计数**（防攻击者用错验证码推高延时 DoS 管理员）；验证码正确后口令仍错才记一次口令失败 |
| 递增延时 | 宽容次数从 5 降为 **1**：第 1 次口令错误 0s（但触发验证码）；第 2 次起 `min(30s, 1s×2^(n-2))` → **1s→2s→4s→8s→16s→30s 封顶**（复用 `PenaltyBase/PenaltyCap/penaltyFor`，`ratelimit.go:18-20,174-190`）。应答前施加延时，`Retry-After` 给下一次错误将延迟的秒数；正确口令 **0s 放行**。验证码端点另受轻量全局限流（10 次/分钟，超出 429），不与口令失败桶共用计数 |
| 失败计数与重置 | 单桶 key=`admin`；口令错误累加 strike；**登录成功清零**；静默超过 `security.login_rate_limit.lock`（默认 300s）清零 strike / 延时等级（`ratelimit.go:114-118`）；`captcha_required` 仅由成功登录或 CLI 重置清除（见上）。配置仍可热更 `attempts/window/lock`（`handlers_auth.go:169-176`）；因宽容降为 1，`attempts` 语义由"窗口内免延迟 5 次"改为"窗口内免延迟 1 次"，配置项保留但默认值改 1，文档同步 |
| 与 G-11 / G-10 边界 | 无用户表、无账号枚举、无按账号分桶 → 不命中多用户 RBAC；验证码本地生成、不发短信/邮件、不调外部服务 → 不命中联网/遥测；challenge 只在内存 → 不产生后台 goroutine / ticker（G-19） |
| fail-closed | 验证码状态读取失败 / 配置读取失败 / 解码失败一律拒绝登录（同现有 IP 白名单口径 `handlers_auth.go:52-66`）；验证码答案恒定时间比较（`crypto/subtle`，与口令校验同标准）；任何失败不回显答案、不回显口令、不区分"账号是否存在" |
| 审计口径 | 新增 `captcha.issued`（只记 challenge id 前缀 + 时间）、`captcha.failed`（reason=`missing/expired/wrong`）、`login.failed` 扩 reason=`captcha_required/captcha_invalid`；字段白名单沿用 `docs/SECURITY.md:298-302`，口令/验证码答案/图片不落库 |

**用户可感知文案（USABILITY §4 白话，错误给「怎么办」）**：

| 场景 | 文案 |
| --- | --- |
| 账号框 | 标签「账号」，预填 `admin`，旁注「默认账号，一般不用改」 |
| 第 1 次口令错误后 | 「口令不正确。为确认是您本人操作，请输入下面图片里的字符后再试。」同时展开验证码框并自动换一张图 |
| 验证码错 / 过期 | 「图片里的字符不对（或已过期），点『换一张』后再输入一次。」 |
| 进入延时 | 「尝试太频繁，请稍等 N 秒再试。」（N = Retry-After，白话倒计时，不写 `rate_limited` / `E_RATELIMIT`） |
| 账号错 | 「账号或口令不正确，请检查后再试。」（不单独说"账号不存在"） |
| 改密提示（可选） | 「建议尽快把初始口令改成自己的口令。」（可关闭，不挡任何操作） |

## 4. 后果与复审条件

**正确**：新装实例登录后看到「账号 = admin」+ 口令框；老实例升级后不需重新初始化即可用 `admin` + 原口令登录；一次口令错后验证码出现、继续错按阶梯变慢；改密提示可忽略。

**代价**：① 登录多一个字段与一次验证码步骤（用户明确要求，符合 USABILITY 原则 3 的"用户要求"例外）；② 验证码 challenge 只在内存，重启后需重新拉取（可接受，不影响安全）；③ 固定账号名 `admin` 是公开标识符，安全性完全由口令 + 限速承担（与现状同强度，未削弱）。

**复审条件**：
1. 出现"再加一个账号 / 按人分权"需求 → 命中 G-11，退回提案阶段。
2. 出现短信 / 邮件 / 第三方 CAPTCHA 需求 → 命中 G-10/G-02，退回提案阶段。
3. 面板默认暴露公网 → 与 SECURITY §3.1 的 Argon2id 复审一起重开（口令离线爆破前提变化）。
4. 验证码被自动化稳定识别或 challenge 内存态出现竞争/泄漏 → 复审生成算法与状态机。
5. 若把 `must_change_password` 重新变成强制闸门 → 与用户裁决冲突，须先取得新裁决。

## 5. 被否决选项与依据（汇总）

| 被否决 | 依据 |
| --- | --- |
| 随机 / 自定义账号名 | 无安全收益、多一份交付与迁移面；SECURITY:75 原论证 + USABILITY §1 预设优先 |
| 多账号（哪怕无角色） | G-11（AGENTS.md:47）+ 0055:60,76；必然引入用户表与账号管理 |
| state.db 存账号 | install 期 state.db 被独占（0055 §3.1）+ 双源漂移 |
| 短信/邮箱/第三方验证码 | G-10 无联网、G-02 依赖白名单 |
| TOTP 当失败挑战 | 默认关闭、依赖用户 App，未开启时无法完成登录；语义不同（SECURITY §3.6） |
| 维持 must_change 强制闸门 | 用户明确否定强制项 |
| 验证码错也计入口令失败计数 | 攻击者可用错验证码推高延时 DoS 管理员；与 SECURITY §3.5「不能锁死管理员」冲突 |
| 凭据文件用 JSON / 写哈希 | 与 API body 口径混淆、增加副本（G-30） |

## 6. G-11 六项不做 + 附加四项自检

| G-11 项 | 本 ADR 是否命中 | 说明 |
| --- | --- | --- |
| 多用户 RBAC | **否** | 固定单账号 `admin`，无用户表/角色/权限组/授权表/枚举 |
| 集群 / 多机 | 否 | 本机单实例，challenge 在进程内存 |
| 模板市场 | 否 | 无 |
| 厂商云存储深度集成 | 否 | 无 |
| 拖拽建站 | 否 | 无 |
| 多语言全量框架 | 否 | 文案仅中文白话，沿用既有 UI 骨架 |
| 容器编排 / 多租户 SaaS / 移动 App / 重型主题 | 否 | 无 |

其它门禁自检：G-02 零新依赖（stdlib only）、G-10 无联网/无遥测、G-19 零新增 ticker/goroutine、G-24 请求/响应显式字段、G-28 UI 交付需 PC+手机双端截图、G-29 测试走隔离实例不碰主配置与 state、G-30 报告与凭据文件占位/0600/gitignore。

## 7. 对现有 ADR 的修订（append-only，原文一字不动）

| 目标文件 | 追加位置 | 追加内容要点 |
| --- | --- | --- |
| `0043-login-gate-vs-passwordless-ops.md` | 新 §7「账号+密码口径覆盖（2026-11-25，ADR-0057）」 | ① §1 的「单管理员、无用户名」由本 ADR 覆盖为「单账号 `admin` + 口令」，登录门 / UDS 不跳过 / 7 天会话 / root 免密均不变；② §3/§6 的首启凭据描述补充"凭据文件两行格式 + 账号字段 + must_change 降级为可选提示"；③ 复审条件追加"多账号需求 → G-11 退回" |
| `0055-initial-admin-credential.md` | 新 §8「账号+密码与失败挑战覆盖（2026-11-25，ADR-0057）」 | ① §2 选项 C 的"首登强制改密"被用户否定，改为"可选改密提示"（键名保留、语义降级、闸门取消）；② §3.3 凭据文件格式由一行改为两行 `username` / `password`（占位写法），0600/gitignore/消费后删不变；③ §3.5 迁移补"老文件自动包装 + 不一致备份 .legacy + 不重置口令"；④ §5/§6 追加"多账号仍命中 G-11、验证码本地生成不破 G-10/G-02" |
| `docs/SECURITY.md` | §3.2 段末 + §3.5 段末追加修订注记（不改原句） | 「无用户名」口径被 ADR-0057 覆盖；限速宽容次数 5→1、验证码挑战、captcha 审计 reason；PBKDF2/KDF 复审条件不变 |
| `docs/USABILITY.md` | §8.1 后追加 | 账号框预填 `admin`、验证码白话文案、改密提示可关闭（不挡操作），四问自检更新 |
| `docs/DATA-MODEL.md` | 配置表追加 | `auth.admin_username`（string，默认 admin）、`security.login_rate_limit.attempts` 默认 1（语义变更注记）、captcha challenge 内存态不落库声明 |
| `docs/CORE.md` / `QUICKSTART.md` / `RUNBOOK-INSTALL.md` | 对应段落追加 | 登录 body 增 `username`，新增 `GET /api/v1/auth/captcha`，改密 body 增 `username`，凭据文件格式示例（占位） |
| `.agents/LOG/DECISIONS.md` | 追加条目 | 本 ADR 多选一裁决与被否决选项（G-23） |

## 8. 落地任务卡拆解（只写目标 / 写域 / 验收，不写实现代码）

> 依赖：T1 → T3；T4 可独立；T3+T4 → T5；T2 → T6；T3/T4/T5/T6 → T7。写域同层不相交（G-08）。每张卡均 **commit 不 push、不触发 CI**；涉及 UI 的卡按 G-28 交 PC + 手机双端截图。

| 卡 | 目标 | 写域（精确） | 验收 |
| --- | --- | --- | --- |
| **T1** | 账号身份进入配置：`config.Auth.AdminUsername`（默认 admin），解析/校验/冷字段策略（不进 SIGHUP 热更白名单），老配置缺省归一 | `internal/core/config/types.go` / `parse.go` / `validate.go` 及对应 `*_test.go` | `go test -timeout 200s ./internal/core/config/...` 绿；老配置无字段时解析得 `admin`；新字段不被热更白名单误收；无 `any/object`（G-24） |
| **T2** | 凭据文件新格式 + 迁移：两行 `username` / `password`（占位仅文档），老单行自动包装、不一致备份 `.legacy`、0600/gitignore/消费后删不改 | `cmd/kored/admin_password.go`、`cmd/kored/install.go`、`.gitignore`、`cmd/kored/admin_password_test.go` | 新格式两行、权限 0600、`git check-ignore -v` 命中；老文件升级幂等且不改 hash、不删数据；非 TTY 不打印明文；`go test ./cmd/kored/...` 绿 |
| **T3** | 登录 API 账号校验：`loginRequest.username`、统一 401 文案、限速 key 不按输入分桶、账号错不清零计数 | `internal/core/httpapi/handlers_auth.go` 及其测试 | 账号错 `401 {"message":"账号或口令错误"}`；`admin` + 正确口令 200；随机账号不能绕开全局限速；`go test ./internal/core/httpapi/...` 绿 |
| **T4** | 登录失败防护后端：本地 PNG 验证码端点 + 内存 challenge（sha256/TTL/一次性）+ 428/401 分支 + 1s→30s 阶梯 + 计数/重置 + captcha 审计；`attempts` 默认 1 | `internal/core/auth/ratelimit.go`、新增 captcha 状态/绘制文件及其测试、`internal/core/httpapi/` 新增 captcha handler 及其测试（**不碰 `web/app.js`**） | 第 1 次口令错后 `captcha_required`；无/错/过期验证码不进口令校验；口令错 2/3/4 次延时 1/2/4s、封顶 30s；正确口令 0s；challenge 内存不落盘、重启失效；`go vet` + `go test -timeout 200s ./internal/core/auth/... ./internal/core/httpapi/...` 绿；无新第三方依赖（G-02） |
| **T5** | 登录表单 UI：账号框预填 `admin` + 验证码框（图片/换一张/文本替代）+ 白话错误文案 + 延时倒计时；改密提示位 | `web/app.js`（登录表单段）、`web/style.css`、`web/settings.js`（仅提示位）、G-28 截图 | PC 1440×900 / 手机 390×844 双端截图入 `.agents/verify/screenshots/`；账号预填可见；验证码错误与延时文案为白话（USABILITY §4）；`make frontend` 首屏 ≤300KiB gzip 不变 |
| **T6** | 改密带账号 + must_change 降级：改密 body `username` 必填校验、403 闸门取消、可选提示（登录响应 bool）、清标志/吊销/删凭据/审计保留 | `internal/core/httpapi/handlers_password.go` / `middleware.go` 及其测试、`internal/core/auth/session.go`（仅闸门相关，若无需改则不写）、`cmd/kored/serve_signals.go`（如需） | 改密缺账号 400、错账号 403、正确账号 200；`must_change=true` 时普通 `/api/v1/*` 不再 403；改密成功旧会话失效、凭据文件删除、审计只记元数据；`go test` 绿 |
| **T7** | 文档同步与收口：按 §7 append-only 修订 ADR-0043/0055、SECURITY/USABILITY/DATA-MODEL/CORE/QUICKSTART/RUNBOOK、G-23 台账；全量门禁 | `docs/DECISIONS/0043-*` / `0055-*`（仅追加新节）、`docs/SECURITY.md` / `USABILITY.md` / `DATA-MODEL.md` / `CORE.md`、`QUICKSTART.md`、`RUNBOOK-INSTALL.md`、`.agents/LOG/DECISIONS.md`、本报告验收附录 | `bash scripts/docs-check.sh` 与 `bash scripts/secret-check.sh` exit 0；`make vet` / `make test` 绿；G-11 六项自检表逐条打勾；G-28 双端证据齐全；无 push、无 CI 触发 |

## 9. 纪律声明与一句话结论

本报告全程只读取源码/文档（全部为 `path:line` 原文锚点），只写入本报告文件；未改代码 / 配置 / 运行态（G-29），未读取或打印任何真实凭据（G-30），未 push、未触发 CI。报告内所有口令位置均为尖括号占位符。

**账号+密码模型定为：固定单账号 `admin` + 口令、账号存 `auth.admin_username`、凭据文件两行格式、must_change 降级为可选提示，并叠加"一次错误后本地图形验证码 + 1s→30s 递增延时"的失败防护；它不命中 G-11（单账号有名字 ≠ 多用户 RBAC），落地需要 7 张任务卡。**
