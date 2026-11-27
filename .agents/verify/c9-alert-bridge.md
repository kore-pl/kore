# C9 告警桥接核实与最小接线验收（task-182 / round 17）

日期：2026-11-27（Asia/Shanghai）｜Owner：c9-bridge｜结论：**桥接原本缺失（两处断点），已补最小 bridge 并隔离实测三断言全过**。

## 0. 结论先行

`monitor.system` 返回的 `alerts[]` 原本只在 `web/monitor.js` 里展示，没有任何消费者写回告警中心；而且即便手工 `POST /api/v1/alerts`，写端点直接调 `sink.PutAlert`，**绕过** `recordAlert → dispatchAlert`，也不会触发通知通道。两处断点都已在本次补齐：

1. 内核：`POST /api/v1/alerts` 统一改走 `recordAlertView`（与 `recordAlert` 同一出口），落库成功即按「来源 + 级别」派发到用户显式启用的通道；
2. 前端：`monitor.js` 在手动刷新/首次进入的 `monitor.system` 成功回调里，把 `alerts[]` 逐条转成受控词表的 `POST /api/v1/alerts`（CSRF 双提交），并在阈值面板 UI 明示出站边界。

隔离实例（127.0.0.1:18931，独立 config/state/run/log，非 8787）真机浏览器 + 本地 HTTP 接收端实测：站内告警从 0 增到含 `source=resource/critical|warning`、接收端收到 8 条含指标值的 payload、未启用通道时出站 0。G-28 双端截图齐备，门禁全绿。

## 1. 桥接点 file:line 证据（改动前）

| 事实 | 证据（file:line） |
| --- | --- |
| 插件只把阈值告警放返回体、明确不发通知 | `kore-plugin-monitor/internal/monitor/alerts.go:5-6`「阈值告警只在返回体里标注 alerts[]：插件不发通知、不发邮件、不发 Webhook，通知归主壳告警中心」；`:27-35` Alert 结构；`collector.go:75` / `shell.go:195` 只做 `result.Alerts = evaluateAlerts(...)` |
| 内核 invoke 把插件结果**原样**透传、不消费 alerts | `internal/core/httpapi/handlers_invoke.go:54` `s.opts.Backend.Invoke(...)` → `:62-67` 直接 `w.Write(result)`，中间只有审计 `:57`，无 alerts 处理 |
| 前端只展示、不写回 | `web/monitor.js:769-793` `alertPanel(d)` 只读 `d.alerts` 渲染 DOM；`:802` `S.panels.appendChild(alertPanel(d))`；`:900` 唯一 `invoke('system', ...)` 调用点，无 POST /api/v1/alerts。全仓前端只有 `web/alert-rules.js:20,209` 用该端点（告警规则「测试触发」），与 monitor 无关 |
| 内核统一告警出口含 webhook 派发 | `internal/core/httpapi/alerts.go:79-91`（改动前）：`recordAlert` → `PutAlert` → `s.webhooks.dispatchAlert(...)`；`webhook.go:714` dispatchAlert 只投「启用 + 来源 + 级别」匹配的通道 |
| **断点一**：没有 bridge | grep `internal/core/httpapi/handlers_invoke.go` / `invoke_capability.go` / `cmd/kored/` 中 `alerts` 零命中；前端 monitor.js 无写端点调用 → invoke 返回的 alerts[] 无人写库 |
| **断点二**：写端点绕过派发 | 改动前 `handlers_alerts.go:128`（原）`sink.PutAlert(...)` 直接落库，不经 `recordAlert`，因此即便手工 POST 也不派发 webhook |

改动后关键行：`internal/core/httpapi/alerts.go:93-111`（新 `recordAlertView` 唯一落库 + 派发出口，`recordAlert` 复用它）；`handlers_alerts.go:107-135`（写端点改走 `recordAlertView`）；`web/monitor.js:18`（`ALERTS_API`）、`:164-198`（`bridgeAlerts`）、`:940-944`（invoke 成功回调调用点）、`:812-815`（UI 明示）。

## 2. 改动前隔离断言（证明确有断点）

隔离实例 127.0.0.1:18931（独立 config/state/run/log，全部落 `.agents/verify/.c9tmp/iso/`），monitor 0.5.1 经 `store/install` 安装并启用，本地接收端 127.0.0.1:18932，webhook 通道 `ch-1`（默认 `enabled=false`，后 PATCH 启用，订阅 `resource` + `critical/warning`）。阈值经 `config.set` 设为 cpu=1 / memory=1 / disk=0（用户显式配置路径）。

| 断言 | 命令 | 退出码/结果 |
| --- | --- | --- |
| (i) alerts bucket 增量 | `curl GET /api/v1/alerts?limit=500` before/after | before=0 / after=0 / delta=0 → **FAIL**（应有 ≥1） |
| (ii) 通道收到含指标值 payload | invoke `monitor.system` 返回 2 条 alerts（cpu 6.05% / memory 32.89%），查看 `deliveries.log` | 只有 health 探测的 `{}`，真实 payload=0 → **FAIL** |
| (iii) 未配通道出站=0 | `ss -tnp \| grep kored` | 出站 0（但通道当时已启用，故此项仅证明无派发发生） |

补充决定性实验（改动前）：直接 `POST /api/v1/alerts {"severity":"critical","source":"resource","title":"CPU 使用率过高","detail":"current=98.50..."}` → 返回 200、alerts bucket +1，但接收端 0 条 → 证实**断点二**（写端点绕过派发）。

## 3. 改动后隔离断言（真实浏览器路径）

重建 kored（含修复后内核 + `make frontend` 后的 embed JS）并重启同一隔离实例；Playwright 用系统 Edge 真机登录 → `config.set` 低阈值 → 进入监控页 → 点「刷新」（唯一 invoke 触发点，无 ticker）→ 自动经 `bridgeAlerts` 写告警 → webhook 派发到本地接收端。

| 断言 | 命令 / 证据 | 退出码 / 结果 |
| --- | --- | --- |
| (i) alerts bucket 多一条 source=resource/critical\|warning | `curl -s -b cookies GET '/api/v1/alerts?limit=500'` + python 对比 before/after；最终 `count=9`，其中 `monitor_bridge_alerts=8`（逐条 `source=resource`、`severity=warning\|critical`、detail 含「来源：monitor 插件阈值告警；指标：CPU/内存；当前 xx%，阈值 xx%」） | **PASS**（delta ≥1，字段正确） |
| (ii) 通道收到 1 条含指标值 payload | `python3` 解析 `deliveries.log`：`total_deliveries=8`（两次视口 × 每次 2 条告警），逐条 `source=resource`、`severity=critical\|warning`、`test=false`，`detail` 含 `当前 32.89%` / `当前 6.49%` 等真实指标值 | **PASS** |
| (iii) 未配置/未启用通道出站=0 | 通道创建后默认 `enabled=false`，此时 invoke `monitor.system`（返回 2 alerts）→ `deliveries_while_disabled=0`、`ss -tnp \| grep kored \| grep -v 127.0.0.1:18931 \| wc -l` = 0 | **PASS** |
| 浏览器 UI 实证 | Playwright 双视口：`DISCLOSURE=true ALERT_VISIBLE=true PAGE_ERRORS=0`，`BROWSER_ASSERT=PASS`，`node browser-verify.js` exit=0 | **PASS** |

单次模拟 bridge POST 的精确断言（与浏览器路径同 payload 形状）：`ASSERT_I=PASS`（before=1 after=2，新记录 `source=resource severity=critical`），`ASSERT_II=PASS`（deliveries=1，`test=false`，detail 含 `32.89%`）。

## 4. ADR-0054 六判据复核（本次 bridge 仍全部成立）

| # | 判据 | 本次实现事实 |
| --- | --- | --- |
| 1 | 出站目标只来自用户配置 | 无任何新增 URL 常量；bridge 只 POST 站内 `/api/v1/alerts`，真正出站目标仍是用户在「设置 → 通知通道」显式填的地址 |
| 2 | 用户显式启用，默认无配置 | 通道默认 `enabled=false`（实测 create 返回 `enabled:false`）；未启用时实测出站 0；bridge 本身不创建/启用任何通道 |
| 3 | 只告警触发、无 ticker | bridge 调用点只在 `monitor.js:940-944` 的手动 `monitor.system` 成功回调；该文件仍无 `setInterval`，唯一 `setTimeout` 是 100ms resize 防抖；无 AfterFunc/常驻队列 |
| 4 | 无遥测 | detail 只有指标名/当前值/阈值/hint；无 session、心跳、评分、标识上报 |
| 5 | 凭据不落日志 | bridge 只从页面可读的 `kore_csrf` cookie 取 CSRF 做双提交头，不打印；内核 webhook 派发的脱敏口径未改 |
| 6 | UI 明示 | 阈值告警面板顶部新增一行：「以下告警会记入告警中心；只有你在『设置 → 通知通道』显式启用后，才会向你配置的地址推送。」（截图肉眼可见） |

## 5. G-28 双端截图与自评

| 文件 | `identify -format '%f %wx%h %b'` | `read_image` 实读 |
| --- | --- | --- |
| `.agents/verify/screenshots/c9-alert-bridge-desktop-01.png` | 1440×3328，302220B | PC full-page：阈值告警面板含明示行 + CPU 警告 / 内存严重两条告警（6.49% / 32.99% 对比阈值 1%）+ 四条曲线 + 磁盘/网络/温度/进程，典型桌面布局 |
| `.agents/verify/screenshots/c9-alert-bridge-mobile-01.png` | 390×4236，269064B | 手机 full-page：单列卡片、底部 tab 条、同款明示行与两条告警、无横向溢出；与桌面图为不同视口（sha256 不同），非同图缩放 |

自评三问：

1. **解决什么用户问题**：此前监控页阈值告警只是页面上的红点/彩条，关掉页面就消失，也不会进入告警中心或通知通道；现在每次手动刷新触发阈值时同步写一条站内告警，并按用户配置推到外部通道，值班人不必盯着监控页。
2. **与宝塔/1Panel 差距**：宝塔/1Panel 的监控告警默认即站内 + 通道推送；Kore 沿 G-10/G-19 坚持「默认零出站、只在用户显式启用后触发」，且刷新为手动（无轮询）。差距是实时性依赖用户手动刷新或页面进入，不是后台持续监测；优势是零常驻进程、零遥测、凭据不落盘。
3. **可用还是占位**：**可用**——真机浏览器双视口触发 + 真实本地 HTTP 接收端拿到含指标值的 payload + 站内告警可查 + 三门禁全绿，非占位。

## 6. 门禁证据

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `go test -count=1 -timeout 300s ./...`（隔离 GOMODCACHE/GOCACHE，GOPROXY=off） | 0 | 全部包 ok（含 `internal/core/httpapi` 4.950s） |
| `go test -count=1 -timeout 200s ./internal/core/httpapi/...`（含新测试 `TestAlertsWriteDispatchesWebhook`） | 0 | `ok ... 4.931s` |
| `go vet ./internal/core/httpapi/... ./cmd/kored/...` | 0 | 无输出 |
| `node --check web/monitor.js` | 0 | 无输出 |
| `make frontend` | 0 | `[OK] 首屏体积达标：91092 字节 ≤ 307200`；仅 1 条既有体积漂移 WARN（非本轮新增 FAIL） |
| `make docs-check` | 0 | `docs-check: 5 pass, 1 warn, 0 fail` |
| `make check`（隔离缓存置于 kore 仓**外**，21 段） | 0 | `[OK] 门禁全部通过`（含 18/21 race、19/21 全仓 -race、21/21 pluginapi -race 全绿） |

说明：首次 `make check` 因隔离 Go 缓存误放在 kore 仓内，被 G-26 许可证扫描当作第三方源码（323 条非 MIT 头）+ 兄弟仓 `GOPROXY=off` 缺依赖而 exit=2；将缓存移出仓库树并预下载依赖后重跑 exit=0。此为环境问题，非代码回归。

## 7. 运行态与仓库卫生（G-29 / G-12）

- 主实例 8787 / `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / `bin/kored` **零改动**；全部验证在隔离实例 127.0.0.1:18931 + 127.0.0.1:18932 本地接收端完成，无外网连接。
- 一次性脚本（`receiver.py` / `browser-verify.js`）、隔离 config/state/run/log、临时二进制、Go 缓存均已删除（仓库树内 `.agents/verify/.c9tmp/iso` 与仓外 `.c9tmp-caches` 同轮清理；报告与双端截图保留）。
- 精确提交：`internal/core/httpapi/alerts.go`、`internal/core/httpapi/handlers_alerts.go`、`internal/core/httpapi/handlers_alerts_test.go`、`web/monitor.js`、本报告与两张 G-28 截图；他人 dirty（`scripts/usability-pending.txt` 等）不提交。
- 发版（版本 bump / tag / push / Release）由 lead 统一组织；本卡只 commit、不 push/tag/Release。

## 8. 一句话

确认并修复了两处真实断点（frontend alerts[] 无消费者 + 写端点绕过 webhook 派发），隔离实例真机浏览器 + 本地接收端三断言全过、双端截图与自评齐备、门禁全绿；ADR-0054 六判据逐条成立。
