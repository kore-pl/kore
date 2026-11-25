# ADR-0057 T6 · 改密带账号 + must_change 非闸门验收报告

> 状态：DONE · 归属：account-password（implementer） · 日期：2026-11-25 · 工作区：/home/pt/Work/GolandProjects/kore-pl/kore
> 纪律：commit 不 push、不触发 CI、不碰运行态、明文不进报告/日志/对话、临时脚本即用即删。
> 写域（精确）：`internal/core/httpapi/handlers_password.go`、`internal/core/httpapi/handlers_password_test.go`、`cmd/kored/admin_password.go`、`cmd/kored/admin_password_test.go`、`web/settings.js`、`web/dist/settings.js`（gitignored 产物）、本报告。
> 未写（写域协商）：`handlers_auth.go` / `ratelimit.go` / `middleware.go`（T3/T4 既有）、`web/app.js` / `web/style.css`（account-ui 独占，commit 9aa08cb）、docs/ 与 .agents/LOG/ 台账（account-docs 独占）。

## 一句话结论

改密端点已强制请求体账号字段（缺→400、不匹配→403），成功后清 must_change 标志/吊销旧会话/删 state_dir 一次性凭据/写审计（无明文）；must_change 仍为非阻断提示（未恢复任何 403 闸门）；前端改密弹层传 `username: admin`。**隔离实例真机全流程通过**：账号不匹配 403、缺账号 400、正确改密 200、旧会话 401、旧口令 401、新口令 200、凭据文件删除、审计 1 条零明文。

## 1. 实现要点（path:line 锚点）

| 项 | 落点 | 口径 |
| --- | --- | --- |
| 请求体账号字段 | `internal/core/httpapi/handlers_password.go:45` | `changePasswordRequest` 增 `Username string \`json:"username"\``（显式三字段，G-24）；只活内存，不写日志/审计/响应 |
| 账号必填 | `handlers_password.go:86-89` | 空白 → 400 `E_INVALID`「请输入账号」；先于任何口令校验 |
| 账号匹配 | `handlers_password.go:90-94` | 复用登录侧 `auth.CheckAdminUsername(req.Username, s.adminUsername)` 常量时间比对；不匹配 → 403 `E_UNAUTHORIZED`「账号不匹配，无法修改口令」；不查库/不枚举/审计 subject 仍固定 admin（G-11） |
| 失败闭环不变 | `handlers_password.go:106-124` | 仍按「先吊销全部会话 → 持久化配置 → 切内存哈希 → 删凭据 → 审计 → 清 cookie」顺序；失败不改内存、不伪造成功 |
| must_change 非闸门 | 未改 T3/T4 | `notePasswordHint` 只挂 `X-Kore-Password-Hint: 1` 头；无 403 拦截恢复；成功改密经 `ApplyCredentialSnapshot(hash, false)` 清标志 |
| 凭据消费按 state_dir | `cmd/kored/admin_password.go:399-415, 586-594` | 新增 `consumeInitialAdminCredential(stateDir)`；`passwordWriterFor` 注入钩子时绑定 `cfg.snapshot.Paths.StateDir`，与生成侧 6a31b34 的 `<state_dir>/initial-admin-credential` 落点一致。原无参 `ConsumeInitialAdminCredential()` 保留供测试/CLI 兼容（解析安装根） |
| 前端传账号 | `web/settings.js:907, 1012` | 增 `PW_USERNAME = 'admin'`（与登录表单预填账号同口径）；POST body = `{username, current_password, new_password}`；`web/dist/settings.js` 同步（gitignored 产物，diff -q 一致） |
| 测试覆盖 | `handlers_password_test.go`、`admin_password_test.go` | 新增 `TestChangePasswordUsernameValidation`（缺/空白/错账号 → 400/400/403，零写回、会话仍在、旧口令仍可登录）+`TestConsumeInitialAdminCredentialUsesStateDir`（绑定 state_dir 删除、无参漏删反例）；既有 10 处改密 body 全补 username |

## 2. 门禁证据（命令 + 退出码）

| 命令 | 结果 |
| --- | --- |
| `GOCACHE=<workspace>/.tmp/gocache-t6 go vet ./...` | exit **0**（无输出） |
| `GOCACHE=<workspace>/.tmp/gocache-t6 go test -count=1 -timeout 200s ./...` | exit **0**：16 包 ok（cmd/kored 9.6s、httpapi 4.7s、auth 1.2s 等），web 无测试文件 |
| `node --check web/settings.js` | exit **0** |
| `node --check web/dist/settings.js` | exit **0** |
| `diff -q web/settings.js web/dist/settings.js` | exit **0**（两份逐字一致） |
| `bash scripts/secret-check.sh` | exit **0**：0 FAIL / 23 处匹配（占位写法均合规） |

> 注：系统默认 GOCACHE 不可写，所有 Go 命令显式指定工作区内临时 GOCACHE（`.tmp/gocache-t6`，收尾已删）。构建隔离二进制的 stat-cache warning 为只读模块缓存告警，不影响产物（build=ok）。

## 3. 隔离实例真机验证（G-29）

- 独立二进制 `/tmp/kore-t6-e2e2-*/bin/kored`，端口 **127.0.0.1:8898**（主实例 8787 未碰）；独立 `--config` + `KORE_CONFIG` + state/run/log/index 全落 `/tmp`，全部为 gitignored 临时资产。
- **本轮未改动主实例运行态配置**（`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` 均未触碰）；隔离实例已停服、临时目录与一次性脚本已删。
- 一次性凭据由隔离实例首启生成（两行 `username: admin` / `password: <REDACTED>`，0600），口令只进 shell 变量与 curl -d，不进报告/日志/对话。

| 步骤 | 期望 | 实测 |
| --- | --- | --- |
| healthz | 200 | `200` |
| 首启凭据文件 | 存在、0600、两行格式 | `cred_before=yes mode=600`；`old_pw_len=24` |
| 正确账号+原口令登录 | 200 | `login=200` |
| must_change=true 下 `/api/v1/auth/session` | 200 且带非阻断提示头 | `session_with_mustchange=200`、`hint=X-Kore-Password-Hint: 1` |
| must_change=true 下 `/api/v1/system/info` | 200（不 403） | `system_info_with_mustchange=200` |
| 改密 body 账号 `root` | 403 + 固定文案 | `change_wrong_account=403`；`{"code":"E_UNAUTHORIZED","message":"账号不匹配，无法修改口令","detail":""}` |
| 改密缺账号字段 | 400 + 固定文案 | `change_missing_account=400`；`{"code":"E_INVALID","message":"请输入账号","detail":""}` |
| 正确账号+口令改密 | 200，响应 `authenticated=false` | `change_ok=200`；`{"authenticated":false,"expires_at":""}` |
| 改密后旧会话 | 401 | `old_session_after=401` |
| 改密后配置标志 | must_change=false | `must_change_password: false` |
| 改密后凭据文件（state_dir 落点） | 删除 | `cred_after=no` |
| 新口令登录 | 200 | `new_pw_login=200` |
| 旧口令登录 | 401 | `old_pw_login=401` |
| 审计（HTTP `GET /api/v1/audit` 新会话查询） | `auth.password_initial_changed` 1 条、零明文 | `audit_http=200`、`audit_change_events=1`、`audit_leak=0` |

> 审计专测用 HTTP 端点而非 CLI：CLI 的 `audit` 子命令与运行中的服务同开 bbolt 会因锁冲突失败（stderr 已丢弃），HTTP 走服务内已打开的 db，证据有效。首次 e2e 曾观测 `cred_exists_after=yes`，定位为凭据消费钩子按安装根解析、漏删自定义 state_dir 文件；按 6a31b34 落点修正后复测 `cred_after=no`，并由 `TestConsumeInitialAdminCredentialUsesStateDir` 固化回归。

## 4. G-28 双端截图说明

本卡前端改动仅为改密弹层 POST body 增加一个不可见字段（`username`），**不改变任何视觉/交互**——弹层 DOM、按钮、文案、响应式样式一字未动，账号标识也不展示给用户；G-28 的 PC/手机双端截图由 T5 登录页 UI 卡（account-ui，commit 9aa08cb，`login-t5-*-desktop/mobile-01.png` 等）覆盖，本卡不重复截图、不伪造证据。T6 验收以 HTTP 真链路断言为准。

**G-28 三问（本卡无视觉改动，仅说明同页定位）**：
1. **本页解决什么用户问题**：改密请求显式携带账号，避免误投/越权；用户仍只需在弹层填当前口令+新口令两次，账号由前端自动带入，不增加操作步骤（USABILITY 原则 3）。
2. **与宝塔 / 1Panel 同类功能的差距**：本项目按 G-11 只做固定单账号 admin，改密页无账号选择/多用户切换；这是 ADR-0057 明确裁决的非目标，不是本卡缺陷。
3. **当前「可用」还是「占位」**：**可用**——隔离实例真机 400/403/200/401/401/200 全链路实测通过、凭据删除与审计落库均已验证；前端弹层沿用既有可用实现，仅补请求字段。

## 5. 写域协商与冲突处置

| 事项 | 结论 |
| --- | --- |
| T3/T4 既有实现 | `handlers_auth.go` / `ratelimit.go` / `middleware.go` 一字未改；must_change 非闸门（T3/T4 已落地）保持原样，未恢复任何 403 拦截 |
| account-ui（T5） | 对方确认只写 `web/app.js` / `web/style.css` / 报告 / 截图，commit 9aa08cb；我未碰其文件，其 `make frontend` 已重跑、首屏 87258 B ≤ 300KiB；我随后只同步了 `web/dist/settings.js`（gitignored） |
| account-docs（T7） | 已提前告知写域与最终端点契约（`{username, current_password, new_password}`、400/403、非闸门提示头、凭据 state_dir 落点）；对方独占 docs/ 与 .agents/LOG/ 台账，我未写 |
| `cmd/kored/admin_password.go` | 属 T2 原 owner 文件，但本卡仅在「密码变更相关处」做最小增量（凭据消费绑定 state_dir），不碰生成/迁移/首启三判据逻辑；该文件在我编辑前 git status 干净，无并发在途改动 |

## 6. 临时资产收尾

- 一次性脚本 `.tmp/t6-e2e.sh` / `.tmp/t6-e2e2.sh` / `.tmp/t6-audit.sh` 与 `.tmp/gocache-t6` 已删；隔离实例 `/tmp/kore-t6-e2e*` 全停服并清理；工作区无临时脚本残留。
- 报告与日志中口令位置均为 `<REDACTED>` / 占位；真机输出在终端已脱敏；secret-check exit 0。
- 未 push、未触发 CI；提交为精确 pathspec + `[agent:account-password]` 前缀。

## 7. 一句话结论

**T6 全部目标达成：改密带账号（缺 400 / 错 403 / 对 200）、must_change 保持非闸门、成功后清标志/吊销/删 state_dir 凭据/审计零明文、前端传账号；go vet/test、node --check、secret-check 全绿，隔离实例真机全流程通过。**
