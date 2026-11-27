# C9 告警桥接独立验收报告（G-09 / task-184）

> 状态: accepted · 归属: c9-bridge-verifier（独立 verifier，非 c9-bridge 实现者）· 更新: 2026-11-27 · 里程碑: R25 · 门禁关联: G-09 / G-10 / G-12 / G-19 / G-28 / G-29
>
> 复核对象：commit `d49f3b3d5bccc657283fa53d2b9f1c6e33a07b5a`（`[agent:c9-bridge] feat(core/web): 打通 monitor 阈值告警到告警中心与通知通道`）
>
> **总评：PASS**。五项复核范围（两断点修码、隔离三断言、门禁、G-28 双端截图、git 纪律）逐条成立；未发现任一项证据不成立。

## 0. 复核方法

全程只读复核：读 `d49f3b3` 源码/diff、`git archive`/`git show` 回读、以仓外隔离 GOMODCACHE/GOCACHE + `GOPROXY=off` 复跑门禁、`read_image` 实读双端 PNG、`identify` 读真实宽高。唯一写操作为本报告（`git commit -s`）；不 push、不联网、不执行主流程 CLI、不碰 `.kore-local-*`。所有验证命令与退出码见下文。

## 1. 两断点修复读码复核

### 1.1 断点二（写端点绕过派发）——后端

- `internal/core/httpapi/alerts.go:90-104` 新增 `recordAlertView`：唯一落库出口仍是 `s.alerts.PutAlert`（`:94`），落库成功后统一 `s.webhooks.dispatchAlert(severity, source, title, detail)`（`:102`）；失败仅 `slog.Warn` 并返回 err（`:95-98`），不打断主流程。`recordAlert`（`:79-85`）改为复用 `recordAlertView`，即内核检查点与显式写端点走同一出口。
- 全仓生产代码 `PutAlert` 调用点核对：`internal/core/httpapi` 内仅 `alerts.go:94`（经 `serve_alerts.go` 适配），`handlers_alerts.go` 已无直调 `sink.PutAlert`；`cmd/kored/serve_runtime.go:416` 的 `s.db.PutAlert` 是升级后置动作失败告警（与 webhook 派发无关的历史路径，未在本次任务范围，非新增绕过点）。
- `internal/core/httpapi/handlers_alerts.go:111-135` `handleAlertsWrite`：`s.requireAlerts` 仅做未装配检查（`:115`），第 `:129` 行改为 `s.recordAlertView(input.Severity, input.Source, input.Title, input.Detail)`，因此 `POST /api/v1/alerts` 现按「来源 + 级别」经 `dispatchAlert` 派发（通道启用且订阅匹配才投递）。受控词表校验（`:123-128`，severity=critical/warning/info，source=audit/plugin/resource/slot）与长度校验保持。
- `TestAlertsWriteDispatchesWebhook`（`handlers_alerts_test.go:210-262`）断言：未启用通道时 POST 后 150ms 内零 payload；启用订阅 `resource/critical` 通道后再 POST，收到 1 条 payload 且 `Source=resource`、`Severity=critical`、Title 与 detail 含指标值 `current=98.50`。

  复跑：`go test -count=1 -timeout 200s ./internal/core/httpapi/...` exit=0；`go test -count=1 -timeout 200s -run TestAlertsWriteDispatchesWebhook -v ./internal/core/httpapi/` → `--- PASS: TestAlertsWriteDispatchesWebhook (0.15s)` exit=0。

### 1.2 断点一（前端 alerts[] 无消费者）——web/monitor.js

- `:19` `var ALERTS_API = '/api/v1/alerts'`（站内路径，无外部 URL）。
- `:173-198` `bridgeAlerts(alerts)`：`Array` 与空数组短路；CSRF 从页面可读 `kore_csrf` cookie 取（`:175` `cookie()` 定义 `:135-142`），无 token 直接返回；severity 白名单仅接受 `warning|critical`（`:179`），`source` 固定 `resource`（`:195`），detail 含指标标签/当前值/阈值/hint（`:189-191`），`POST` 带 `X-Kore-CSRF` 双提交头（`:194`），`fetch(...).catch()` 失败静默（`:197`，旁路不破坏渲染）；title/detail 分别截断 200/512 字符，与后端校验口径一致。
- `:942` 唯一调用点：位于 `invoke('system', ...).then(function (d) {...})` 成功回调内，即"手动刷新/首次进入"的 `monitor.system` 成功返回时；失败路径无 bridge。全文件 `grep bridgeAlerts` 仅 `:173`（定义）与 `:942`（调用），无 ticker：`setInterval`/`NewTicker`/`AfterFunc` 零命中（`:8` 注释明确无轮询，唯一 `setTimeout` 是 `:745` 的 100ms resize 防抖）。
- `:812-815` UI 明示出站边界：`mon-alert-hint` 行文案「以下告警会记入告警中心；只有你在「设置 → 通知通道」显式启用后，才会向你配置的地址推送。」（截图肉眼可见，见 §4）。
- `node --check web/monitor.js` exit=0；`web/dist/monitor.js` 与源码 `diff -q` exit=0（embed 产物含同款 bridge）。

### 1.3 ADR-0054 六判据 / G-10

逐条对照 `docs/DECISIONS/0054-user-configured-webhook-egress.md` §2 六判据（报告 §4 表格与本轮读码一致）：

| # | 判据 | 本轮核验事实 |
| --- | --- | --- |
| 1 | 出站目标只来自用户配置 | 新增代码无硬编码外部 URL（`ALERTS_API` 为站内 `/api/v1/alerts`；`git show d49f3b3 -- web/monitor.js` 增益行无 `http://`/`https://`），真正出站目标仍只来自用户在「设置 → 通知通道」填写的地址 |
| 2 | 用户显式启用，默认无配置 | 通道默认 `enabled=false`（测试先未启用 POST → 零 payload；报告隔离断言 `:47` 默认 enabled=false deliveries=0）；bridge 不创建/启用通道 |
| 3 | 只告警触发、无 ticker | bridge 唯一调用点在成功回调，无 setInterval/AfterFunc/常驻队列；dispatchAlert 是短命 goroutine（webhook.go:714-737） |
| 4 | 无遥测 | payload 仅 source/severity/title/detail/time/test，detail 只含指标/阈值/建议；无 session/心跳/评分 |
| 5 | 凭据不落日志 | bridge 只用页面可读 CSRF 做请求头、不打印；webhook 派发脱敏口径未改 |
| 6 | UI 明示 | `mon-alert-hint` 行（`:812-815`）明示，双端截图均可见 |

G-10：`alerts.go`/`handlers_alerts.go`/`monitor.js` 新增代码禁词（`http.Client`/`net.Dial`/`telemetry`/`analytics`/`phone-home`）零命中；webhook 出站仍属 ADR-0054 已接受的用户显式出站例外，未越界为内置遥测。

## 2. 隔离三断言复核（报告 .agents/verify/c9-alert-bridge.md）

报告（commit 内 `:27-50`）证据链核对：

- **改动前**（报告 §2）：(i) alerts bucket before=0/after=0/delta=0 → FAIL；(ii) 接收端真实 payload=0（只有 health 探测 `{}`）→ FAIL；决定性实验（`:37`）直接 POST 返回 200、bucket+1 但接收端 0 → 证明断点二存在。逻辑自洽，与 §1 读码结论一致。
- **改动后**（报告 §3）：(i) `GET /api/v1/alerts?limit=500` count=9、其中 `monitor_bridge_alerts=8`，逐条 `source=resource`、`severity=warning|critical`、detail 含「来源：monitor 插件阈值告警；指标：CPU/内存；当前 xx%，阈值 xx%」→ PASS；(ii) 本地接收端 `total_deliveries=8`（两次视口×每次 2 条告警），逐条 source=resource、test=false、detail 含真实指标值（当前 32.89%/6.49%）→ PASS；(iii) 默认 `enabled=false` 时 `deliveries_while_disabled=0`、`ss -tnp | grep kored | grep -v 127.0.0.1:18931 | wc -l`=0 → PASS。
- 浏览器实证：`DISCLOSURE=true ALERT_VISIBLE=true PAGE_ERRORS=0`，`BROWSER_ASSERT=PASS`，`node browser-verify.js` exit=0（报告 `:48`、`:50`）。原始一次性脚本已删、原始 stdout 未另存，无法本轮重跑浏览器路径（隔离实例已销毁），但断言形状与 §1 读码 + §1 复跑的 `TestAlertsWriteDispatchesWebhook`（未启用零出站/启用后 1 条含指标值 payload）一致，构成独立交叉印证。
- 隔离环境：127.0.0.1:18931 + 127.0.0.1:18932 独立 config/state/run/log，非 8787；`ss -ltnp` 本轮只读复核仅见 8787 在听，18931/18932 已停（符合"隔离实例用完销毁"）。
- G-29 主实例：`.kore-local.yaml` mtime=2026-11-25 20:15:44、`.kore-local-state/` mtime=2026-11-23 20:08:29、`.kore-local-run/` 与 `bin/kored` mtime=2026-11-27 13:49（早于 commit 14:22，属此前轮次），本轮与 c9-bridge 轮次均未改动主实例；报告 §7 声明一致。
- 临时脚本删净：`.agents/verify/.c9tmp`、`.c9tmp/iso`、仓外 `.c9tmp-caches`、`receiver.py`、`browser-verify.js`、`deliveries.log` 等逐一探测均 GONE；`find` 全仓无残留。

## 3. 门禁复跑（GOPROXY=off + 仓外隔离 GOMODCACHE/GOCACHE，全 exit=0）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `go test -count=1 -timeout 200s ./internal/core/httpapi/...` | 0 | `ok ...httpapi 4.945s` |
| `go test -count=1 -timeout 200s -run TestAlertsWriteDispatchesWebhook -v ./internal/core/httpapi/` | 0 | `--- PASS: TestAlertsWriteDispatchesWebhook (0.15s)` |
| `go test -count=1 -timeout 300s ./...` | 0 | 18 包全 ok（cmd/kored 9.019s、httpapi 4.984s、supervisor 8.852s 等） |
| `go vet ./internal/core/httpapi/... ./cmd/kored/...` | 0 | 无输出 |
| `node --check web/monitor.js` | 0 | 无输出 |
| `bash scripts/frontend-check.sh`（只读版 `make frontend` 体积判据，web/dist 已含同款 bridge 且与源 diff=0） | 0 | `[OK] 首屏体积达标：91092 字节 ≤ 307200 字节，余量 216108 字节`；仅 1 条既有体积漂移 WARN（非本轮新增 FAIL） |
| `make docs-check` | 0 | `docs-check: 5 pass, 1 warn, 0 fail` |
| `make check`（21 段，仓外隔离缓存，GOPROXY=off） | 0 | 21/21 段全跑，`[OK] 门禁全部通过`（含 17/21 五目标交叉编译、18/21 race、19/21 全仓 -race、21/21 pluginapi -race 全绿） |

说明：为遵守只读纪律，未在主树执行会 `rm -rf web/dist` 的 `make frontend` 目标本体，而直接复跑其体积判据本体 `scripts/frontend-check.sh`；`web/dist/monitor.js` 与源码 `diff -q` exit=0，证明已构建产物就是本 commit 源码，故体积数字与报告一致（91092B）。`make check` 第 10 段自身仍跑 `make frontend` 且 exit=0，产物为 gitignored 目录、`git status` 前后无变化。

**缓存误放归因核实**：报告 `:88` 记录首次 `make check` 因隔离 Go 缓存误放在 kore 仓内，被 G-26 许可证扫描（`scripts/oss-check.sh` 第 8 段扫描工作区 `*.go` 头且只 `-prune` 白名单目录）当作第三方源码（323 条非 MIT 头）+ 兄弟仓 `GOPROXY=off` 缺依赖 exit=2；移出缓存树并预下载依赖后重跑 exit=0。此归因与脚本实现一致（`oss-check.sh:102-119` 明确排除 `.gocache-*`、`.tmp`、`web/dist` 等 gitignored 目录，缓存误放仓内不在排除名单）且属环境问题而非代码回归；本轮复跑以仓外缓存 + GOPROXY=off 一次通过，印证该归因。

## 4. G-28 双端截图实读（read_image）

| 文件 | file/identify 实测 | read_image 实读结论 |
| --- | --- | --- |
| `.agents/verify/screenshots/c9-alert-bridge-desktop-01.png` | PNG 1440×3328 RGB 302220B；sha256=`a8a22d809…` | 实读图像：PC full-page，左栏导航（概览/网站/数据库/…/设置），主区「系统监控」+「阈值告警」面板；**出站明示行肉眼可见**：「以下告警会记入告警中心；只有你在『设置 → 通知通道』显式启用后，才会向你配置的地址推送。」；两条告警「警告 · CPU 6.5% / 阈值1%」「严重 · 内存 33.0% / 阈值1%」含「怎么办」建议；下方 CPU/内存/负载/磁盘历史曲线、磁盘容量、网络累计收发、温度、进程 Top10。非伪造。 |
| `.agents/verify/screenshots/c9-alert-bridge-mobile-01.png` | PNG 390×4236 RGB 269064B；sha256=`c5b4d62df…` | 实读图像：手机单列卡片布局，底部 tab 条（概览/网站/数据库/文件管理/软件商店/更多）；同款出站明示行 + 两条告警（CPU 7.1% / 阈值1%、内存 33.0% / 阈值1%）及历史曲线等，无横向溢出。与桌面图 sha256 不同、视口不同、布局不同，非同图缩放。 |

自评三问原文见报告 `c9-alert-bridge.md:70-74`：①此前阈值告警关页即消失，现在每次手动刷新写站内告警并按用户配置推送；②与宝塔/1Panel 差距是实时性依赖手动刷新（坚持默认零出站、无轮询），优势是零常驻/零遥测；③结论「可用」——真机双视口 + 本地接收端含指标值 payload + 门禁全绿，非占位。三问齐备且与实际截图/断言一致。

## 5. git 纪律复核

- `git rev-parse HEAD` = `d49f3b3d5bccc657283fa53d2b9f1c6e33a07b5a` = 本轮 commit；`git show -s --format=%B` 首行 `[agent:c9-bridge]` 前缀、第三行 `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` → DCO 完整。
- `git diff-tree --name-status -r d49f3b3` **精确 7 文件**：A `.agents/verify/c9-alert-bridge.md`、A 两张 G-28 截图、M `alerts.go`/`handlers_alerts.go`/`handlers_alerts_test.go`/`web/monitor.js`，无多余路径。
- 未 push：`git branch -r --contains d49f3b3` 输出为空；四个远端 main ref（gitea=812f9fc…/gitee=github=origin=c3620da…）均不含该 commit。
- `git worktree list` 仅主工作树一行；无临时 worktree/分支残留。
- 他人 dirty 原样：`git status --short` 仍为 ` M scripts/usability-pending.txt` 及 `?? .agents/verify/e2e-*.md`、`?? .agents/verify/local-update-plan.md`、`?? data/`、`?? dist/` 等，提交未夹带。
- 本 verifier 仅写本报告，精确 `git add .agents/verify/c9-bridge-verification.md` + `git commit -s`（`[agent:c9-bridge-verifier]`），不 push。

## 6. 结论

五项复核范围全部成立，未发现伪造/绕过/遗漏；唯一非本轮可重跑项是浏览器三断言（隔离实例已按纪律删除，原始 stdout 未留档），但代码读码 + 后端新测试独立复跑 + 报告内一次性实测证据相互印证，判据充分。

**总评：PASS**（G-09 验收成立）。
