> 状态: accepted · 归属: architect（architect-account-model）→ implementer（account-core / brute-force / account-ui / account-password）→ scribe（account-docs 收口）· 更新: 2026-11-25 · 里程碑: R25 · 门禁关联: G-06 / G-10 / G-11 / G-23 / G-28 / G-29 / G-30
> ADR 状态: accepted（2026-11-25 裁决落地，草案 draft 转正式）· 关联: [ADR-0043](./0043-login-gate-vs-passwordless-ops.md)、[ADR-0055](./0055-initial-admin-credential.md)、[ADR-0056](./0056-self-restart.md)、[SECURITY](../SECURITY.md) §3.2/§3.5、[CORE](../CORE.md) §2.3/§2.4、[设计草案](../../.agents/verify/login-account-model.md)
> 纪律: 只写文档 / 台账；commit 不 push、不触发 CI、不改运行态；正文与报告中口令一律占位（G-30）；对既有 ADR / 台账 append-only。

# ADR-0057：登录账号 + 密码模型与登录失败防护（覆盖「无用户名」旧口径）

> 定稿说明：本 ADR 正文来自 [architect 草案](../../.agents/verify/login-account-model.md)（commit `0b80dae`）的 ADR-0057 候选，状态由 draft 转 accepted。草案中与最终实现不一致的细节按实现复核注记（§6）修正——**以实现为准**；append-only 修订映射见 §7。

## 1. 背景与问题陈述

用户新口径「登录应该是账号加密码」推翻了 [ADR-0043](./0043-login-gate-vs-passwordless-ops.md) 与 [SECURITY](../SECURITY.md) §3.2 的「单管理员、无用户名」设计前提；同期口径「一次错误后需要动态验证码 + 每次错误延时」要求在既有登录限速之外增加**自动触发的本地挑战**。

现状不是「缺一个输入框」：账号是身份标识，牵动配置结构、凭据文件格式、登录 / 改密契约、迁移路径、错误文案、审计 subject 与登录失败防护。两次变更必须落在「单管理员、非 RBAC、零新依赖、无联网、明文凭据不入库」的既定边界内，且已有安装不丢数据、不强制重新初始化。

**必读证据**（草案 §0 逐条给出 path:line 原文锚点）：E1 旧模型单管理员无用户名、凭据仅 `auth.admin_password_hash`；E4 PBKDF2-HMAC-SHA256/600000；E6 首启凭据文件本为一行明文；E7 `must_change` 原为 403 强制闸门；E9 原限速 5 次宽容 + 1s→30s 递增；E10 G-11 不做多用户 RBAC / G-02 依赖上限 3 / G-10 无联网 / G-30 明文不入库；E12 USABILITY 四原则。

## 2. 选项对比（多选一，含被否决项）

| 维度 | 方案 | 结论 |
| --- | --- | --- |
| 账号来源 | A1 固定账号名 `admin`（账号是标识符不是秘密） | **采纳** |
| 账号来源 | A2 安装期随机账号名 | 否决：退化为「第二个口令」，多一份落盘 / 展示 / 迁移面 |
| 账号来源 | A3 用户自定义账号名 | 否决：单账号无安全收益，新增输入 / 校验 / 改名 / 迁移链路，违背「预设优先」 |
| 账号体系 | B1 单账号有名字（无用户表 / 角色 / 授权表 / 枚举） | **采纳**：不命中 G-11 |
| 账号体系 | B2 多个账号但无角色权限 | 否决：命中 G-11「多用户 RBAC」非目标，退回提案阶段 |
| 账号存储 | C1 config 新字段 `auth.admin_username`，与 hash 同文件 0600 | **采纳**：与 ADR-0055「install 在打开 state.db 前只写 config」同构 |
| 账号存储 | C2 state.db 新建 users 表 | 否决：引入用户表即接近 B2；install 期 state.db 被 serve 独占 |
| 验证码 | D1 本地生成 PNG 图形验证码（stdlib + 内嵌点阵字形），答案仅内存存 sha256 | **采纳**：零新依赖、零联网、零账号体系 |
| 验证码 | D2 短信 / 邮箱 / 第三方 CAPTCHA 服务 | 否决：命中 G-10（联网 / 外部账号）与 G-02（新依赖） |
| 验证码 | D3 复用作废的 TOTP（默认关闭、依赖用户 App） | 否决：TOTP 是常开二次验证，不是「一次错误后的自动挑战」 |
| must_change | E1 从强制闸门降级为可选改密提示（字段保留、语义降级） | **采纳**（用户明确否定强制项） |
| must_change | E2 维持强制 403 闸门 | 否决：与用户新裁决冲突 |

## 3. 裁决

**采纳 A1 + B1 + C1 + D1 + E1**：固定单账号 `admin`，账号标识符存 config `auth.admin_username`，凭据文件两行，首登改密非阻断，一次口令错误后强制本地图形验证码 + 1s→30s 递增延时。A2/A3/B2/C2/D2/D3/E2 否决。

### 3.1 账号来源与存储

1. **账号名 = 固定 `admin`**，安装期 / 首启自动生成、无需用户输入、不可随机化。定位为标识符而非秘密：安全性仍由口令承担（PBKDF2 口径与限速口径不变）；用户口径要的是**登录表单有账号字段、请求体带账号**，不是「账号保密」。
2. **存储位置**：config 新字段 `auth.admin_username`，与 `auth.admin_password_hash` 同一配置文件（0600），**不进 state.db**；单一事实源避免配置 / state 漂移。
3. **可改性**：v1 不可经 UI 修改（无改名端点）；解析层对缺失字段归一为 `admin`；安装 / 首启统一入口幂等写回。将来改名必须另开 ADR 并回答「是否变成多账号」（G-11）。
4. **凭据文件格式**（`<install>/data/initial-admin-credential`，从「一行口令」升级为显式两行纯文本）：

   ```text
   username: admin
   password: <placeholder>
   ```

   纯文本 key-value，不用 JSON（避免与 API body 字段口径混淆）；首行可选 `#` 注释；不含哈希、不含副本、不含其它账号。权限 0600、gitignore（含 `.legacy` 备份路径）、运行态资产（G-29）、不入库（G-30）、改密成功后由 `ConsumeInitialAdminCredential` 消费删除，均沿用既有边界。

### 3.2 单账号边界（G-11）

| 形态 | 是否命中 G-11 | 判定依据 |
| --- | --- | --- |
| **单账号有名字**（固定 `admin`，无用户表 / 角色 / 权限组 / 用户枚举 / 账号管理 API） | **否** | 只是给既有唯一管理员加标识符；SECURITY §3.1「系统只有一个账号，不做用户枚举」仍成立 |
| 多个账号但无角色权限 | **是** | N 个账号必然带来用户表、账号校验 / 枚举、按账号鉴权、账号管理端点、per-user 会话与限速分桶、审计 subject 分叉——即使无角色也是「多用户」 |

任何「再加一个账号 / 按人分权」需求走 G-11 提案流程，不在本 ADR 打补丁。

### 3.3 迁移兼容（不丢数据、不重新初始化）

1. **已有安装**（hash 存在、无 `auth.admin_username`）：解析层把缺失字段归一为 `admin`（立即能登录，无需写盘）；下一次 install / serve bootstrap 由统一入口用行级 upsert 原子 0600 写回同一配置；**不重算 hash、不动 state.db / plugins / index、不要求重启**。
2. **老单行凭据文件**：读到单行且无两行结构时自动包装为 §3.1 格式（`username: admin` + 原明文），原子 0600 覆写；已是新格式则幂等不动。不因明文与 hash 不一致阻断迁移。
3. **不一致的历史情形**：先把原文原子备份为 `<install>/data/initial-admin-credential.legacy`（0600、gitignore），再包装；提示用 CLI 重置，**不删数据、不猜口令**。
4. **老会话**：账号字段不写入会话结构，老 cookie 继续有效，无需全量踢下线。
5. **凭据生命周期不变**（[ADR-0055 §8](./0055-initial-admin-credential.md)）：首次安装生成、更新 / 升级安装绝不覆盖。

### 3.4 登录、改密与 must_change 降级

1. **登录表单**：新增「账号」输入框（`id=kore-username` / `name=username` / `autocomplete=username`），预填 `admin` 并标「已自动检测」；口令框与验证码框在其下。提交 body 扩展为 `{username, password, otp, captcha_id, captcha_answer}`（字段全部显式，G-24；OTP 仅 2FA 开启时填）。
2. **登录校验顺序**：账号 → IP 白名单 → 验证码（挑战态才要）→ 口令 → OTP → 签发。账号不等于配置值时统一回 401「账号或口令错误」（与口令错同文案，防枚举）；账号错不动限速桶与挑战态；限速 key 继续固定 `"admin"`，不按输入账号分桶（否则随机账号可绕开全局限速）。
3. **改密端点**：请求体新增 `username`（必填，实现口径见 §6.1），与配置账号不符回 403「账号不匹配，无法修改口令」，缺省回 400「请输入账号」；会话 + 双提交 CSRF 两道门保留；失败闭环顺序不变（先吊销会话 → 持久化 → 切内存）。
4. **must_change 非阻断**：键名与字段保留（兼容现有配置 / SIGHUP 链路 / 测试），但**不再降权会话**：登录成功即签完整会话，403 闸门取消；改为响应头 `X-Kore-Password-Hint: 1` + 面板顶部可关闭的白话提示「建议尽快修改初始口令」，用户可忽略。改密成功仍清标志、吊销旧会话、删一次性凭据文件、写审计。
5. **审计**：登录失败 / 成功复用既有事件与 IP / UA 脱敏口径，新增 `captcha.issued` / `captcha.failed` / `captcha.passed`，`login.failed` 扩 reason=`captcha_required` / `captcha_invalid`；验证码答案、图片、口令一律不进审计（G-30）。

### 3.5 登录失败防护

> 目标：第一次口令错误后，**后续登录必须过一道本地图形验证码**；口令继续错误时按阶梯递增应答延时；正确口令始终 0 延迟（不得让攻击者把管理员锁死）。

| 项 | 裁决 |
| --- | --- |
| 触发 | 全局桶 key=`admin` 出现第 1 次口令错误即置 `captcha_required=true`；此后每次登录必须带验证码；**只有登录成功或 CLI 重置凭据才清除**；静默超时只清延时等级、不清验证码要求（fail-secure） |
| 生成 | 新增公开端点 `GET /api/v1/auth/captcha`：stdlib `crypto/rand` + `image/png` + 内嵌 5×7 点阵字形，去易混字符，随机噪点 / 干扰线，base64 data URI；同一 challenge 提供文本加法题替代（终端 / curl）。零第三方依赖、零字体、零联网（G-02 / G-10） |
| 存储 | **只在进程内存**：`sha256(answer)` + `expiresAt`，TTL 2 分钟，一次性（校验后立即删除，无论对错）；不落盘、不进 state.db / 日志 / 审计，不回传明文答案；重启即失效 |
| 校验顺序 | 缺 / 过期 / 答案不符 → 428 `E_CAPTCHA_REQUIRED` / 401 `E_CAPTCHA_INVALID`，**不计入口令失败计数**（防攻击者用错验证码推高延时 DoS 管理员）；验证码正确后口令仍错才记一次口令失败 |
| 延时 | 宽容次数 5→1：第 1 次口令错误 0s（但触发验证码）；第 2 次起 `min(30s, 1s×2^(n-2))` → **1s→2s→4s→8s→16s→30s 封顶**；`Retry-After` 给下一次错误将延迟的秒数；正确口令 0s。验证码端点另受 10 次/分钟轻量限流，不与口令失败桶共用计数 |
| 计数与重置 | 单桶 key=`admin`；口令错误累加 strike，登录成功清零；静默超过 `security.login_rate_limit.lock`（默认 300s）清 strike / 延时等级，不清挑战态。`attempts` 默认值由 5 改 1（配置项保留） |
| fail-closed | 状态读取 / 配置 / 解码失败一律拒绝登录；答案用 `crypto/subtle` 恒定时间比较；任何失败不回显答案、不回显口令、不区分账号是否存在 |
| 边界 | 无用户表 / 账号枚举 / 按账号分桶（G-11）；验证码本地生成、无短信 / 邮件 / 外部服务（G-10 / G-02）；challenge 只在内存、无新增 ticker / goroutine（G-19） |

**用户可感知文案**（USABILITY 原则 4，错误给「怎么办」）：账号框「账号」预填 `admin` + 旁注「已自动检测，一般不用改」；首次口令错「密码错误，请输入右侧验证码」并展开验证码框 / 自动换图；验证码错「验证码不对或已过期，请点『换一张』后再输入一次」；延时「请 N 秒后再试」并有逐秒倒计时；账号错「账号或口令错误」（不单独说账号不存在）；改密提示可关闭、不挡操作。

## 4. 后果与复审条件

**正确**：新装实例登录页显示「账号 = admin」+ 密码框；老实例升级后无需重新初始化即可用 `admin` + 原口令登录；一次口令错后验证码出现、继续错按阶梯变慢；改密提示可忽略。

**代价**：① 登录多一个字段与一次验证码步骤（用户明确要求）；② challenge 只在内存，重启后需重新拉取（可接受，不影响安全）；③ 固定账号名 `admin` 是公开标识符，安全性完全由口令 + 限速承担（与现状同强度，未削弱）。

**复审条件**：① 出现「再加一个账号 / 按人分权」→ 命中 G-11，退回提案阶段；② 出现短信 / 邮件 / 第三方 CAPTCHA → 命中 G-10 / G-02，退回提案阶段；③ 面板默认暴露公网 → 与 SECURITY §3.1 的 Argon2id 复审一起重开；④ 验证码被自动化稳定识别或 challenge 内存态出现竞争 / 泄漏 → 复审生成算法与状态机；⑤ 把 `must_change_password` 重新变成强制闸门 → 须先取得新裁决。

## 5. 被否决选项与依据

| 被否决 | 依据 |
| --- | --- |
| 随机 / 自定义账号名 | 无安全收益、多一份交付与迁移面；SECURITY 原论证 + USABILITY §1 预设优先 |
| 多账号（哪怕无角色） | G-11 + ADR-0055 §4；必然引入用户表与账号管理 |
| state.db 存账号 | install 期 state.db 被独占（ADR-0055 §3.1）+ 双源漂移 |
| 短信 / 邮箱 / 第三方验证码 | G-10 无联网、G-02 依赖白名单 |
| TOTP 当失败挑战 | 默认关闭、依赖用户 App，未开启时无法完成登录；语义不同（SECURITY §3.6） |
| 维持 must_change 强制闸门 | 用户明确否定强制项 |
| 验证码错也计入口令失败计数 | 攻击者可用错验证码推高延时 DoS 管理员；与「不能锁死管理员」冲突 |
| 凭据文件用 JSON / 写哈希 | 与 API body 口径混淆、增加副本（G-30） |

## 6. 实现复核注记（2026-11-25）

### 6.1 任务卡 → 实现 → commit 对照

| 卡 | 实现事实 | commit / 证据 |
| --- | --- | --- |
| 设计草案 | ADR-0057 候选 + 7 张任务卡拆解 | `0b80dae` [agent:architect-account-model]，[草案](../../.agents/verify/login-account-model.md) |
| T1 配置账号 | `Auth.AdminUsername` 显式 string，默认 `admin`，老配置归一；`coldChanged` 收 `auth.admin_username`（SIGHUP 不热更）；`Attempts` 默认 5→1 | `b1f7e59` [agent:account-core]，[T1–T3 报告](../../.agents/verify/account-t123.md) §2 |
| T2 凭据文件 | 两行 `username` / `password`；老单行幂等包装；不一致备份 `.legacy`；0600 / gitignore / 消费后删不变；更新安装绝不覆盖 | `ee724d5` [agent:account-core]，同报告 §3 |
| T3 登录账号 + UI | `auth.CheckAdminUsername` 常量时间比较；登录体 `{username,password,otp,captcha_id,captcha_answer}`；账号错 401 统一文案、不动限速桶；账号框预填 + 白话文案 + 验证码 UI 接线 | `b5480a6` [agent:account-core]；验收报告与 PC / 手机双端截图 `445e2e0`；接手独立复核附录 `4805511` |
| T4 失败防护 | `auth/captcha.go` 本地 PNG + 文本替代 + 内存 challenge；`handlers_captcha.go` 公开端点；428 / 401 / 429 + `Retry-After`；1s→30s；captcha 审计；`Attempts=1` | `7af792f` [agent:brute-force]，[T4 报告](../../.agents/verify/account-t4-bruteforce.md) |
| must_change 降级 | 403 闸门取消，改 `X-Kore-Password-Hint: 1` 非阻断提示；`X-Kore-CSRF` 双提交与会话保留；启动时从配置初始化标志 | `b6e091b` [agent:resume-must-change]、`5697b3c` [agent:must-change-tail]，[复核报告](../../.agents/verify/must-change-deadlock.md) |
| T5 UI 文案 / 双端 | 标签统一「账号 / 密码 / 验证码」，账号标「已自动检测」，验证码触发 / 延时白话文案，390px 不挤压、触控 ≥44px | 见 [.agents/LOG/DISPATCH.md](../../.agents/LOG/DISPATCH.md) T5 行（commit 与截图落点按实现报告登记） |
| T6 改密带账号 | 请求体显式 `{username,current_password,new_password}`；缺账号 400 / 错账号 403；会话 + CSRF 保留；成功后清标志 / 吊销 / 删凭据 / 审计只记元数据 | 见 [.agents/LOG/DISPATCH.md](../../.agents/LOG/DISPATCH.md) T6 行（commit 按实现报告登记） |
| T7 文档收口 | 本 ADR 正式落盘 + append-only 修订 + G-23 台账 + HANDOFF 快照 + 三门禁 | [验收报告](../../.agents/verify/account-t7-docs.md)；本批 commit（未 push） |

### 6.2 草案 → 实现的事实差异（以实现为准）

| 草案表述 | 最终实现事实 |
| --- | --- |
| §3.4.3 改密 body「新增 `username`（必填）」 | T6 落为显式三字段 `{username,current_password,new_password}`；400 / 403 白话文案与草案一致 |
| §3.4.4 登录响应附带 `password_change_hint: true`（body bool） | 实现改为响应头 `X-Kore-Password-Hint: 1`（会话鉴权通过后由 `notePasswordHint` 写入），前端据此显示可关闭提示；**仍是提示、不是闸门** |
| §3.5「验证码 5 位字符 + 文本加法题」 | 图形 5 字符点阵图 + 同一 challenge 的文本加法题双通道，答案只存摘要，常量时间比较 |
| §3.5「`attempts` 默认值改 1」 | 已落：`config/types.go` `Attempts: 1` 与 `auth.DefaultMaxFailures=1` 对齐；配置键保留、可热更 |
| §3.4.5 审计 reason `captcha_invalid` / `captcha_required` | 实现细分 `captcha.failed.reason` = `missing` / `expired` / `invalid`，`login.failed.reason` 扩 `captcha_required` / `captcha_invalid` |
| §7 原计划同步 DATA-MODEL / RUNBOOK-INSTALL | 本轮按任务卡写域收敛到 ADR-0043 / 0055 / SECURITY / CORE / USABILITY / QUICKSTART + 台账；DATA-MODEL 的 `auth.admin_username` 与端点计数由 T3 commit `b5480a6` 已同步，不重复改写 |

### 6.3 验证证据（命令 + 退出码）

实现卡原文口径（本卡未复跑 Go 测试，证据以各报告为准）：

```text
go test -count=1 -timeout 200s ./internal/core/config/... ./internal/core/auth/... ./cmd/kored/...   → exit 0（T1–T3 报告 §5）
go vet ./internal/core/auth/... ./internal/core/httpapi/... ./cmd/kored/...                          → exit 0（T4 报告 §2）
go test -count=1 -timeout 200s ./internal/core/auth/... ./internal/core/httpapi/...                  → exit 0（T4 报告 §2）
node --check web/app.js                                                                              → exit 0（T3 / T4 报告）
隔离实例真机：401 → captcha 200 → 缺验证码 428 → 正确 200 → 继续错 429 + Retry-After:2（T4 报告 §3）
G-28 双端截图：login-account-desktop-01.png（1440×900）/ login-account-mobile-01.png（390×844）（T3 报告 §6）
```

本卡实跑（见 [验收报告](../../.agents/verify/account-t7-docs.md)）：`make docs-check` / `make secret-check` / `make log-check` 三条门禁均 exit 0。

### 6.4 未验证项

- 真实 systemd 实例下的验证码挑战跨进程重启行为只按「内存态重启失效」设计验证，未碰主实例运行态（G-29）。
- Gitea Actions 服务端启用 / act_runner 注册属服务端前置，与 ADR-0056 相同，本 ADR 不验证、不执行 CI。

## 7. 对现有 ADR / 文档的 append-only 修订（原文一字不动）

| 目标文件 | 追加位置 | 追加内容 |
| --- | --- | --- |
| [ADR-0043](./0043-login-gate-vs-passwordless-ops.md) | 新 §7 | 「单管理员、无用户名」由本 ADR 覆盖为「单账号 `admin` + 口令」；登录门 / UDS 不跳过 / 7 天会话 / root 免密均不变；凭据两行 + must_change 降级；复审追加「多账号需求 → G-11 退回」 |
| [ADR-0055](./0055-initial-admin-credential.md) | §8.6 之后新 §8.7 | 「首登强制改密」覆盖为「可选改密提示」（键名保留、闸门取消）；凭据文件两行格式（占位）；老文件包装 + `.legacy` 备份 + 不重置口令；更新安装绝不覆盖不变 |
| [SECURITY](../SECURITY.md) | 新 §16 | `auth.admin_username` 纳入凭据边界（标识符非秘密、0600、不进 state.db / 日志 / 审计）；§3.2「无用户名」旧口径被覆盖；限速 5→1 + 验证码挑战 + 审计 reason；PBKDF2 复审条件不变 |
| [CORE](../CORE.md) | 新 §12 | `auth.admin_username` 字段与冷字段策略；登录 / 改密 body 增 `username`；新增 `GET /api/v1/auth/captcha` 与 428 / 401 / 429；端点计数 70→71 |
| [USABILITY](../USABILITY.md) | 新 §9 | 账号框预填「已自动检测」、验证码 / 延时白话文案、改密提示可关闭；四问自检更新 |
| [QUICKSTART](../../QUICKSTART.md) | 新附录 B | 登录页填账号（默认 admin）+ 密码；两行凭据文件示例（占位）；密码错后验证码 / 换一张 / 文本题 / 延时提示 |
| [.agents/LOG/DECISIONS.md](../../.agents/LOG/DECISIONS.md) | 追加裁决行 | 多选一裁决 + 被否决选项（多账号 / 无用户名 / 短信验证码 / 外部服务） |
| [.agents/LOG/DISPATCH.md](../../.agents/LOG/DISPATCH.md) | 追加派发行 | T1–T7 的 task / owner / 写域 / 依赖 / 交付 / commit |
| [.agents/HANDOFF.md](../../.agents/HANDOFF.md) | 追加 T7 快照 | 交付清单、门禁证据、残留授权边界 |

## 8. 一句话结论

**登录模型定为：固定单账号 `admin` + 密码，账号存 `auth.admin_username`，凭据文件两行，首登改密降为可选提示，并叠加「一次错误后本地图形验证码 + 1s→30s 递增延时」的失败防护；不命中 G-11（单账号有名字 ≠ 多用户 RBAC），T1–T7 全部落地并保留被否决选项与实现复核证据。**
