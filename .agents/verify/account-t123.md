> 状态: implementer 验收报告 · 归属: account-core（ADR-0057 T1+T2+T3）· 日期: 2026-11-25 · 工作区: /home/pt/Work/GolandProjects/kore-pl/kore
> 纪律: commit 不 push、不触发 CI、不碰运行态；报告与日志中所有口令为占位/REDACTED，未记录任何真实凭据。
> 一句话结论: **T1/T2/T3 三块均已落地；登录为账号+密码（账号错 401「账号或口令错误」、口令错 401 提示验证码）；老单行凭据实例升级后自动包装为两行且原口令仍能 200 登录。**

# ADR-0057 T1+T2+T3 实现与验收报告

## 1. 写域与协作

| 项 | 内容 |
| --- | --- |
| 我的写域 | `internal/core/config/{types,parse,validate,reload}.go` + 新 `admin_username_test.go`；`internal/core/auth/username.go` + `username_test.go`；`cmd/kored/admin_password.go` + `admin_password_test.go` + 新 `credential_format.go` / `credential_format_test.go`；`.gitignore`；`web/app.js` / `web/style.css`；`docs/CORE.md` / `docs/DATA-MODEL.md`；本报告与双端截图 |
| 明确不碰 | `cmd/kored/serve_runtime.go`、`internal/core/auth/session.go`（must-change-tail 写域）；`internal/core/httpapi/handlers_auth.go`、`ratelimit.go`、`server.go`（brute-force 写域） |
| 跨卡协商 | 与 brute-force 约定：`web/app.js` 由我统一落账号框/口令框/验证码框/提交接线；他提供接口契约（`GET /api/v1/auth/captcha` 返回 `captcha_id/image/text_question/expires_in`；登录体 `{username,password,otp,captcha_id,captcha_answer}`；428 `E_CAPTCHA_REQUIRED` / 401 `E_CAPTCHA_INVALID` / 429 `E_RATELIMIT` + `Retry-After`），他只改后端并接入 `auth.CheckAdminUsername`。底层函数签名 `func auth.CheckAdminUsername(username, configured string) bool` + `const auth.DefaultAdminUsername = "admin"` 已消息确认并由他接入 |
| 越界代改（已横向确认） | `internal/core/httpapi/middleware.go:154` 的 `isPublicPath` 加 `|| path == "/api/v1/auth/captcha"` 一行（brute-force 写域不含 middleware.go，由我代改，已在对话中告知）；`cmd/kored/serve_boot.go` 的 `httpapi.Options{AdminUsername: ...}` 由 brute-force 接 T4 Options 时自行加，我不碰 |

## 2. T1：账号身份进入配置（config）

| 落地 | 证据 |
| --- | --- |
| `Auth.AdminUsername string` 显式类型字段（无 `any/object`，G-24） | `internal/core/config/types.go` Auth 结构 |
| 默认 `admin` | `types.go` `defaultsFor()`：`AdminUsername: "admin"` |
| 解析/别名 | `parse.go` `authKeys` 增 `admin_username`，`decodeAuth` 用 `p.str()` 显式 string |
| 老配置缺省归一 | `validate.go` `validateAuth`：空/空白归一 `admin`（无写盘即可登录）；显式值 2–32 位小写字母开头的字母/数字/中划线/下划线，`usernameError` 显式校验 |
| 冷字段不热更 | `reload.go` `coldChanged` 增 `auth.admin_username`（SIGHUP 不应用，提示重启）；`mergeHot` 不含该字段 |
| 首启写回配置 | `admin_password.go` `writeAdminBootstrapHash` 用 `upsertAuthKey(doc, "admin_username", quoteYAML("admin"))` 幂等写回，与 hash/initialized/must_change 同一次原子 0600 写 |
| 不进 state.db | 全文检索 `state.db` / bbolt bucket 无账号字段；账号只在 config 与内存 |
| 单测 | `internal/core/config/admin_username_test.go`：缺省/显式/空值归一/非法大写/非法类型 5 类 + 冷字段断言 |

## 3. T2：凭据文件两行格式 + 升级迁移

| 落地 | 证据 |
| --- | --- |
| 新格式 | `cmd/kored/credential_format.go` `credentialFileContent`：固定 `username: <账号>\npassword: <明文>\n`，纯文本 key-value，不含哈希/副本/其它账号 |
| 首启写两行 | `admin_password.go` `writeInitialAdminCredentialFile(stateDir, username, plain)` 调 `credentialFileContent`；`ensureInitialAdminCredential` 传 `auth.DefaultAdminUsername` |
| TTY / 非 TTY 文案 | TTY 打印账号行 + 口令行 + 文件路径；非 TTY 只打印文件路径，不打印任何明文（G-30） |
| 0600 / gitignore / 消费后删 | `atomicWrite0600` 不变；`.gitignore` 增 `/data/initial-admin-credential.legacy`；`ConsumeInitialAdminCredential` 不变 |
| 老单行自动包装 | `migrateInitialAdminCredential`：读文件 → 检测 `username:`/`password:` 前缀 → 老格式 trim 后包装为两行原子覆写；已是新格式幂等不动。**在 `credentialInitialized` 命中后、return 前调用**——更新安装绝不重新生成、不改哈希、不写配置 |
| 不一致备份 `.legacy` | 配置有 hash 且 `auth.VerifyPassword(hash, plain)` 失败时，原文原子备份到 `<cred>.legacy`（0600，gitignore 增补），stderr 提示 CLI 重置；不删数据、不猜口令 |
| 三判据守门不动 | `credentialInitialized` 原逻辑不变（hash / initialized / 凭据文件任一存在即跳过生成）；迁移只在凭据文件已存在时做 |
| 单测 | `credential_format_test.go` 3 用例：新格式 0600、老单行包装幂等且口令不变、不一致备份 `.legacy`；`admin_password_test.go` 既有生命周期/非 TTY/首装用例已按新格式更新 |

## 4. T3：登录账号+密码 + UI

| 落地 | 证据 |
| --- | --- |
| 底层账号校验 | `internal/core/auth/username.go`：`CheckAdminUsername` trim 后 `subtle.ConstantTimeCompare`；configured 空归一 admin；大小写敏感；无用户表、无枚举 |
| 登录 API 接入 | brute-force 在 `handlers_auth.go` `loginRequest` 加 `Username`、`Server.adminUsername` 与 `auth.CheckAdminUsername` 分支（我的报告只声明底层函数已提供并由他接入，不改他的文件） |
| 限速 key 不按输入分桶 | 账号错不 RecordFailure/RecordSuccess、桶不变（brute-force 实现）；key 仍固定 `admin` |
| 登录表单账号框 | `web/app.js` `renderLogin`：`id=kore-username` / `name=username` / `autocomplete=username` / 预填 `admin`，帮助文案「已自动检测：默认账号 admin，一般不用改」（USABILITY 原则②） |
| 口令框与文案 | label「口令」；副标题「控制台 · 账号登录」；底部注释「口令连续输错后需要输入验证码并逐步等待」；错误文案「账号或口令不正确，请检查后再试」（账号错）/ 服务端返回的「密码错误，请输入右侧验证码」 |
| 验证码 UI | `web/app.js` login 段新增隐藏验证码框（图片 + 换一张 + 输入框 + 文本替代提示），首次口令错/428/401 提示验证码时展开并自动换图；429 用 `Retry-After` 白话倒计时。CSS 在 `web/style.css`（`.field-help` / `.kore-captcha-img` / `.kore-captcha-swap`） |
| 品牌口径 | 展示文案一律 Kore（首字母大写）；代码标识 `kore` 小写 |

## 5. 验证命令 + 退出码（证据先行）

```text
GOWORK=off GOCACHE=<workspace>/.tmp-acct-gocache go test -count=1 -timeout 200s ./internal/core/config/... ./internal/core/auth/...  → ok config 0.009s / ok auth 1.162s  [exit 0]
GOWORK=off GOCACHE=<workspace>/.tmp-acct-gocache go test -count=1 -timeout 200s ./cmd/kored/...                            → ok cmd/kored 9.212s  [exit 0]
GOWORK=off GOCACHE=<workspace>/.tmp-acct-gocache go vet ./...                                                            → VET_EXIT=0
GOWORK=off GOCACHE=<workspace>/.tmp-acct-gocache go test -count=1 -timeout 200s ./...                                    → 17 包全 ok（含 brute-force 修复后的 httpapi）  [exit 0]
node --check web/app.js                                                                                                  → NODE_CHECK_OK
bash scripts/secret-check.sh                                                                                             → SECRET_EXIT=0（0 FAIL / 23 占位合规）
bash scripts/docs-check.sh                                                                                               → DOCS_EXIT=0（5 pass / 1 WARN / 0 fail）
```

### 5.1 隔离实例真机（全新安装，127.0.0.1:18887，独立 config/state/run/log 全在 /tmp）

```text
healthz                               → HTTP=200
credential 权限/内容                   → 600 <tmp>/data/initial-admin-credential；username: admin / password: <REDACTED>
config 键                              → admin_username: "admin" / initialized: true / must_change_password: true
POST login {username:"admin",password:<正确>} → HTTP=200 {"authenticated":true,...}
POST login {username:"root", password:<正确>} → HTTP=401 {"code":"E_UNAUTHORIZED","message":"账号或口令错误"}
POST login {username:"admin",password:"definitely-wrong"} → HTTP=401 {"code":"E_UNAUTHORIZED","message":"密码错误，请输入右侧验证码"}
```

### 5.2 隔离实例真机（老单行凭据升级，127.0.0.1:18888）

```text
前置：CLI 生成的口令写成单行明文凭据文件；config 删掉 admin_username 键模拟老配置
healthz                               → HTTP=200
升级后凭据                             → 600，两行 username: admin / password: <REDACTED>（原口令未变）
POST login {username:"admin",password:<原口令>} → HTTP=200 {"authenticated":true,...}
```

## 6. G-28 双端截图 + 产品定位三问

| 项 | 证据 |
| --- | --- |
| PC 截图 | [login-account-desktop-01.png](screenshots/login-account-desktop-01.png)，`file`: PNG 1440×900 |
| 手机截图 | [login-account-mobile-01.png](screenshots/login-account-mobile-01.png)，`file`: PNG 390×844 |
| 截图方式 | Playwright headless（`chromium` 缓存），隔离实例 127.0.0.1:18890，登录页真实渲染；两图来自不同 viewport，非同图缩放 |

**G-28 三问（产品定位自评）**：

1. **本页解决什么用户问题**：把「只有一个口令、用户不知道该填什么」的登录页改成显式的账号+口令；账号预填 `admin` 并标「已自动检测」，小白打开就能填口令登录，不再猜「是不是只填口令」。
2. **与宝塔 / 1Panel 同类功能的差距**：本页是单账号本地面板登录，不做多用户/角色/第三方登录（G-11 非目标）；与同类面板相比缺少验证码自动化之外的账号管理与找回能力，但换来零外部依赖、无联网、无用户表，符合 Kore 薄壳边界。当前定位是「本机运维面板的最小安全登录门」，不是通用身份平台。
3. **当前可用还是占位**：**可用**——账号框/口令框/验证码框、错误白话文案、双端响应式均已落地并在隔离实例真机验证（含账号错/口令错）；验证码框由服务端触发，未触发时默认隐藏，不是占位。

## 7. G-30 / G-29 自检

- G-30：报告与文档中口令均为 `<REDACTED>` / `<placeholder>`；真机输出在终端已用 sed 脱敏；凭据文件 0600 + gitignore；未读/未打印真实口令到报告/日志/对话。secret-check exit 0。
- G-29：全程未改主实例运行态（`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 均未触碰）；所有真机测试走独立 `--config` + `/tmp` 隔离实例，测完 kill；`web/dist` 仅为截图刷新了 app.js/style.css 两份 gitignored 产物，不影响源码或运行态。
- 临时脚本：`/tmp/kore-acct-*` 与截图用 `shot.mjs` 均为一次性，随 /tmp 生命周期清理；工作区无临时脚本残留。

## 8. 未验证项 / 边界

- `must_change` 降级为可选提示由 must-change-tail / resume-must-change 两卡落地，不在本报告声称为我所改；我只在首启配置里保留写 `must_change_password=true` 的既有行为。
- T4 验证码后端、T5 改密带账号、T7 文档全量同步分别由 brute-force / 后续卡 / scribe 负责；本报告只覆盖 T1/T2/T3 与我在 app.js 的验证码 UI 接线。
- 未 push、未触发 CI；提交均为精确 pathspec + `[agent:account-core]` 前缀。

## 9. 一句话结论

**T1（config 账号+冷字段+默认 admin）、T2（两行凭据+老格式迁移+三判据守门）、T3（账号校验底层函数+登录表单账号框+白话文案）三块全部落地；登录已改为账号+密码且账号错/口令错分文案；老单行凭据实例升级后自动包装为两行、原口令仍能 200 登录——全部门禁与隔离实例真机证据见第 5 节。**

## 10. resume-account-core 接手复核附录（2026-11-25）

> 归属: resume-account-core · 背景: 接手失败卡 account-core 的半成品；核实过程中发现原 account-core 并发完成了同名提交（`b1f7e59` T1 / `ee724d5` T2 / `b5480a6` T3 / `445e2e0` 本报告+截图），其工作树内容与我的续接修改一致，无需改写历史或追加重复提交。本附录补录独立复核证据并明确写域协商结果。

| 复核项 | 结果（命令 + 退出码） |
| --- | --- |
| T1 半成品 | `git diff` 核实 config 4 文件字段解析/校验/归一本就完整；`go test -timeout 200s ./internal/core/config/...` exit 0；`Attempts` 默认 5→1 由原卡补入 HEAD（`git show HEAD:internal/core/config/types.go` 确认） |
| T2 半成品 | 核实 `admin_password.go` + 未跟踪 `credential_format.go` 属账号核心（非 brute-force）；编译错误 `too many arguments in call to writeInitialAdminCredentialFile` 已在 HEAD 修好（`git show HEAD:cmd/kored/admin_password.go` 确认为完整内容写入）；`go test ./cmd/kored/...` exit 0 |
| T3 半成品 | `web/app.js` 在接手时已是 M（原卡未提交改动），brute-force 明确确认从未写它；我按契约对齐 DOM id（`kore-captcha-image` / `kore-captcha-refresh` / `kore-captcha-answer`）、`res.retryAfter` 取值、账号框「已自动检测」标注；HEAD 已含全部改动，工作树本写域干净 |
| 最终门禁（HEAD） | `go test -timeout 200s ./internal/core/config/... ./internal/core/auth/... ./cmd/kored/...` exit 0（3 包 ok）；`go vet` 三包 exit 0；`node --check web/app.js` exit 0；`bash scripts/secret-check.sh` exit 0；`bash scripts/docs-check.sh` exit 0（1 WARN 不阻断） |
| 隔离真机（我独立复跑） | 全新安装 18899：凭据两行 0600 + `admin` + 口令 **200**、错账号 **401**「账号或口令错误」、错口令 **401**「密码错误，请输入右侧验证码」、captcha 端点 **200**；老一行凭据 18898：升级后两行 0600、hash 字节未变、`admin` + 原口令 **200**。两实例均已停，临时目录/脚本已删（G-29/G-30） |
| 写域协商 | 开工 `send_message` brute-force，约定 web/app.js 由我统一合并账号框+验证码 UI、它只做 httpapi/ 与 auth 验证码/限速；它确认从未写 app.js、给出接口契约并委托我改 config `Attempts` 默认 5→1；账号错 message 口径双方核对一致。我的提交不含 httpapi/**、auth/captcha.go、auth/ratelimit.go、serve_boot.go |

**结论：三块均已落地；登录为账号+密码；老凭据迁移通过；与 brute-force 写域协商完毕、无重叠冲突。**
