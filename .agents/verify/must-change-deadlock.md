> 元信息: 2026-11-25T20:40+08:00 · 执行者 resume-must-change · 接手 must-change-fix 半成品收尾 · 用户口径「首次登录请先设置新口令不能是必选项」· 隔离实例真浏览器双端验证（G-28）

# must_change 死锁解除验收

## 0. 一句话结论

**死锁已解除**：must_change 从访问闸门降级为非阻断提示——一次性凭据登录后直接进控制台、全部功能可用，首屏一条可关闭的「建议修改初始口令」（去修改 / 以后再说），改密仍可选且成功后清标志+吊销旧会话；用户当前若已被旧闸门卡空白页，按 §5 的 CLI 恢复法立即可进。PC 1440×1375（full-page）/ 手机 390×844 双端截图 + G-28 自评齐备，**双端验证通过**。

## 1. 半成品判定与续接

开工前只读 `git diff` 核实前一 agent 的半成品：`middleware.go` 已删掉 `mustChangeBlocked` 的 403 调用、改为 `s.notePasswordHint(w)`；`handlers_password.go` 已把闸门函数换成 `passwordHintHeader = "X-Kore-Password-Hint"` + `notePasswordHint`，改密端点及「RevokeAll→写配置→ApplyCredentialSnapshot(hash,false)→删凭据文件」闭环完整。**判定可用，直接续接**，未回滚。

续接补齐三处：
- `internal/core/auth/auth_test.go:175` `TestMustChangeGateViaAuthManager` 还断言 403 + 「首次登录请先设置新口令」，改为 `TestMustChangeIsNotAccessGateViaAuthManager`：must_change=true 时会话端点 200、无拦截文案。
- `internal/core/httpapi/handlers_password_test.go` 的同名旧测试（前 agent 已改一半）里 `/api/v1/plugins` 断言在没装配 Backend 的测试夹具下返 500「后端未装配」（非闸门问题），换成已装配端点 `system/info`/`auth/session` + 改密端点业务校验 400（证明写端点也过鉴权而非闸门）。
- 前端三文件落地提示 UI（见 §3）。

吸收他人未提交实现来源：`internal/core/httpapi/middleware.go` / `handlers_password.go` / `handlers_password_test.go`（前 agent 未提交的工作树改动，已并入本次提交）。

## 2. 后端新行为（path:line 证据）

- `internal/core/httpapi/middleware.go:62-68`——会话鉴权通过后只挂提示头，所有 `/api/v1/*` 业务端点一视同仁放行；API token / 插件 bearer 分支本就不经闸门，保持原样。
- `internal/core/httpapi/handlers_password.go:22-35`——`X-Kore-Password-Hint: 1` 只提示，不写状态码、不改鉴权、不泄露凭据（G-30）。
- `internal/core/httpapi/handlers_password.go:handleChangePassword`——改密端点保留；成功后 `ApplyCredentialSnapshot(hash,false)` 清标志、`RevokeAll` 已吊销全部旧会话、一次性凭据文件消费钩子保留，全部行为不变（仅由「必选」变「可选」）。

## 3. 前端新行为（非阻断提示）

- `web/app.js:request()` 保留响应头 `passwordHint` 字段（只消费这一个键，不进业务 JSON）。
- `web/app.js:passwordHintBar()/mountPasswordHint()`——首屏探测到标志才在内容区顶部挂一条黄框提示「建议修改初始口令 / 当前口令是安装时生成的初始口令。建议现在改一个只有你知道的口令；不改也能正常使用全部功能。」+「去修改」「以后再说」；「去修改」跳设置→账户与安全并直接打开改密弹层，「以后再说」本会话关闭后不再出现（不写 localStorage，下次登录仍按后端标志提示）。
- `web/settings.js` 导出 `openPasswordDialog`，「去修改」复用既有唯一改密表单，不另造第二套。
- `web/style.css` 新增 `.notice-advisory`（警告黄，区别于故障红）+ 手机端触摸目标 ≥44px。
- 存量登录文案（「控制台 · 单管理员登录」等）不动；账号+密码模型归另一 ADR。

## 4. 验证（命令 + 退出码 + 关键输出）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `GOCACHE=<仓内临时目录> GOWORK=off go vet ./...` | **0** | 无诊断 |
| `GOCACHE=<仓内临时目录> GOWORK=off go test -count=1 -timeout 200s ./...` | **0** | 18 包全绿（auth / httpapi 含新口径断言） |
| `node --check web/app.js && node --check web/settings.js && node --check web/shell.js` | **0** | 无输出 |
| `make web-dist` | **0** | 前端产物含本次改动 |
| `bash scripts/frontend-check.sh` | **0** | 首屏 gzip 84640 B ≤ 300 KiB，无漂移告警 |
| `make secret-check`（G-30） | **0** | 0 FAIL / 23 处匹配均合规占位 |
| `make docs-check`（G-4） | **0** | 5 pass / 1 warn（存量 docs/SECURITY.md 行数）/ 0 fail |

**隔离实例（G-29）**：未改主实例运行态配置，未碰 8787 / `.kore-local.yaml` / `.kore-local-state/` / state/plugins；二进制从当前工作树归档编译（含未提交改动 + `make web-dist`），独立 config/state/run/log 全落仓内 `.tmp-mc-e2e.*`、随机端口、0600 配置，口令仅存内存与临时文件（退出即删，G-30）。CLI `admin-password --set` 写 `must_change_password: true`；因现有装配路径（`serve_runtime.go`）启动时只装哈希、标志由 SIGHUP 经 `ApplyCredentialSnapshot` 同步，验证时向隔离实例发 SIGHUP 复现用户当前态。收尾：临时二进制 / 临时脚本 / 临时配置状态目录全删。

**API 实测**：登录后 `GET /api/v1/system/info` 与 `GET /api/v1/auth/session` 均 **200** + `X-Kore-Password-Hint: 1`，响应体无「首次登录请先设置新口令」。

**真浏览器（playwright-core，缓存已有）**：
- PC 1440×900 与手机 390×844 两轮：首屏渲染控制台（导航/指标/插件卡齐全）、**无「系统信息读取失败」红条**、无旧拦截文案；改密提示出现且含三要素；不改密切换导航正常；点「以后再说」后提示 DOM 消失。
- 第三轮（桌面）：点「去修改」→ 设置弹层 → 填当前/新口令 → 确认 → 回登录页（改密成功、旧会话已吊销）；新口令登录**直接进控制台且不再提示**（标志已清）。
- 两轮页面 JS 错误均为 0（`pageerror` 监听，未打印 WARN）。

## 5. 用户当前怎么恢复（供 lead 转述，明文口令用占位）

用户当前被旧闸门卡在空白页/强制改密页时，**最快恢复（当前口令不变、不用重启 8787）**：

1. 在服务器终端编辑实例配置文件，把 `auth.must_change_password` 改为 `false`（或用内核已支持的 SIGHUP 热更路径：确认配置里该键为 `false` 后发 `sudo systemctl kill -s HUP kore` / `kill -HUP <kored PID>`）；
2. 回浏览器**刷新页面 / 重新登录**——旧闸门立即消失，用原口令直接进入控制台，全部功能可用；
3. 若升级到本次修复后的二进制，则**无需第 1 步**：即使标志仍为 `true`，登录后也只是首屏一条可关闭的「建议修改初始口令」，点「以后再说」即可，不影响任何功能。

> 备选（愿意换口令时）：`kored admin-password --set --config <你的配置文件路径>` 输入新口令（占位：`***`），再发 SIGHUP 同步，用新口令登录即可——这是 ADR-0055 原有 CLI 路径，改完同样不会被拦截。明文一次性凭据请用占位 `***` 转述，切勿贴进报告/日志/对话（G-30）。

## 6. G-28 双端截图与自评

| 文件 | `file` / `identify` 实测 | 证据点 |
| --- | --- | --- |
| `screenshots/must-change-hint-desktop-01.png` | **1440×1375**（full-page，宽 1440 高 ≥900） | 首屏黄框提示「建议修改初始口令」+ 去修改/以后再说；控制台指标卡/插件卡/导航完整；无红条 |
| `screenshots/must-change-hint-mobile-01.png` | **390×844** | 同提示响应式：按钮换行、触摸目标 ≥44px、底部 tab 导航可见；无红条 |

两张来自同一次隔离实例真浏览器会话的不同 viewport（非同图缩放），md5 全异（desktop `c4a83a3a…` / mobile 另值；`file` 实测见命令输出）。

### 产品定位自评（G-28 三问）

**① 解决什么问题**：一次性初始口令用户以前被强制拦在改密页、甚至空白页，无法先看系统状态；现在登录后直接进控制台，改密降级为可关闭的建议，既不丢安全提醒也不阻断使用。

**② 与宝塔 / 1Panel 的差距**：它们一般在首次登录用向导强制改默认口令；本实现刻意改成非阻断建议（用户明确口径），代价是用户可能长期沿用初始口令——用「以后再说」可关闭但下次登录仍提示来平衡；差距在缺少口令强度/复用检测的实时反馈（当前只在设置页展示修改时间与强度评估，属后续能力）。

**③ 可用还是占位**：**可用（非占位）**。真浏览器实测改密提示出现、可关闭、不改密全功能可用、点「去修改」真打开改密弹层并完成修改、改后标志清除且旧会话失效。

## 7. 写域与提交

- 源码改：`internal/core/httpapi/{middleware.go,handlers_password.go,handlers_password_test.go}`、`internal/core/auth/auth_test.go`、`web/{app.js,settings.js,style.css}`（`web/shell.js` 未改，提示挂在主壳内容区由 app.js 负责）；报告 + 2 张截图。
- **未碰**：`cmd/kored/install.go` / `admin_password.go` / ADR-0055 文档（credential-lifecycle owner 写域）；登录失败验证码/延时（account-model 写域）；8787 运行态任何资产。
- 提交：精确 pathspec + `[agent:resume-must-change]` 前缀，commit 不 push。
