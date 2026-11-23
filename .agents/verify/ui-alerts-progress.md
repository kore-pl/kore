# R5 · 告警中心 + 长任务真实进度（SSE）· 真机验收

> 元信息: 2026-11-23 09:04–09:26+08:00 · 执行者 r5-alert-progress · 主实例 `127.0.0.1:8787` · 报告 ≤80 行

## 0. 口径与运行态（G-29）

- 主实例旧 PID 1968048 → 新 PID 2099761；本轮为装载新 `bin/kored`（embed 前端）重启 4 次，**未改** `.kore-local.yaml` / state.db / 插件目录 / 索引。
- 旧进程 4 个 `KORE_*`（backup/ssl/logs）环境变量在重启时未能继承（读到名字时进程已退出）；重启后复核 `logs.sources`=2 源、`backup.list`=1 份、`ssl.list`=0 证书均正常；`paths.index_dir` 与索引一致（G-29 复核）。
- 告警聚合只读四端点，不落库、不加表；SSE 只推本进程安装/升级任务。

## 1. 任务 A：告警中心（`web/alerts.js`，278 行）

| 来源 | 数据 | 规则 |
| --- | --- | --- |
| 审计 | `GET /api/v1/audit?since=5min&order=desc&limit=200` | `result=denied` >5 条 → 1 条 warning「近期有 N 次被拒绝的操作」；`root.action` / `capability.denied` 各一条 critical |
| 插件 | `GET /api/v1/plugins` | `state=failed` → critical；`restarts>3` → warning |
| 资源 | `GET /api/v1/system/metrics` | `rss_kib>14336`(>14 MiB) / `goroutines>15` / `fds>56` → warning |
| 槽位 | `GET /api/v1/system/info` | `supervisor.resident ≥ 3`（G-03 同时常驻硬上限）→ warning |

- 入口：顶栏 `.conn` 内铃铛（搜索入口右侧，手机同一 `.conn` 位置、44px 触摸目标），内联 SVG + 红点数字；有严重告警红点，仅 warning/info 时黄点。
- 懒加载：首屏只注入约 1 KB CSS 与按钮；`alerts.js`（13,946 B）由 `mount` 后 800ms 懒探测或点铃铛时才注入，**不计首屏**。
- 展示：抽屉从顶栏下沿开始（铃铛红点与面板同屏可核对），critical 红 / warning 黄 / info 蓝，含来源与时间；有 `action` 的条目给「去处理」跳设置/插件/监控页；空态「一切正常 + 最近检查时间」。
- 无 `setInterval`；打开面板或首屏探测时现场聚合一次；单源失败降级为一条 info，不白屏。

## 2. 任务 B：SSE 真实进度

- 后端 `GET /api/v1/events`（`internal/core/httpapi/sse.go`）：`text/event-stream`，事件 `task.progress` / `task.done` / `task.failed`，`data={task_id,phase,percent,message}`，`task_id=<plugin-id>@<version>`。
- G-19：`TaskEvents` 是纯内存 `map[chan]` + 扇出，缓冲 16 帧、慢订阅丢帧不阻塞安装；无心跳定时器、无后台 goroutine；请求 ctx 结束即退订并关闭通道。
- installer 上报（`installer.Options.Progress`）：`download` 3–40（按 Content-Length 每 4% 一次）→ `verify` 40/45 → `extract` 60/72/78 → `register` 82/95 → `reload` 95 → `task.done` 100；失败时 `task.failed` 携带最后阶段。
- 前端 `store.js`：安装/升级/重装先开 EventSource（请求级连接），按 `task_id` 过滤并显示「正在下载… 28%」等真实阶段；失败显示「安装失败（正在校验签名…阶段）：…」；EventSource 缺失/401/501 → 关闭连接、保留 2.5s/7s 伪进度，不报错。

## 3. 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/alerts.js` | 0 | 语法通过 |
| `make frontend` | 0 | 26 文件；首屏 gzip **45,779 B** / 307,200 B |
| `make docs-check` | 0 | 5 pass / 1 warn（docs/PLUGIN-PROTOCOL.md 437 行，既有 WARN） |
| `make check` | 0 | 11/11 段全绿（含 frontend 与 secret-check） |
| `go test ./internal/core/installer ./internal/core/httpapi ./cmd/kored` | 0 | 3 包 ok |

## 4. 真机证据（管理员会话登录，口令不落盘；20 已装插件）

- 告警制造：已登录页面内 6 次 `POST /api/v1/plugins/firewall/root-action {"action_id":"ufw-status"}` → **403 ×6**（非 root 提权被拒，落 `root.action denied`）；铃铛 badge=**2**，面板为「严重 提权动作被拒绝（6 次）」+「警告 近期有 6 次被拒绝的操作」。
- 资源来源同屏（`alerts-resource-desktop.png`）：`rss_kib=14572`（14.3 MiB）> 14 MiB → 「警告 主壳内存接近红线」；三源同屏，条数 3。
- 空态：09:19:55 聚合结果为空 → 「一切正常 / 最近检查时间 09:19:55」。
- 真实进度：商店页点「重装 firewall 0.2.3」（索引下载 2.8 MB）→ 桌面「正在下载… **28%**」、移动「正在下载… **16%**」，最终「重装成功 ✅（restarted）」；期间 SSE 帧含 download/verify/extract/register/reload 全阶段（curl 旁证，事件字节与截图一致）。
- SSE 降级：页面内 `window.EventSource=undefined` 后重装 → 状态「重装中…」（无阶段/百分比）→「重装成功 ✅」；`window.__errs=[]`，控制台 0 错误。
- 双端截图前后断言：`.kore-shell` 存在、`#kore-password` 不存在、铃铛/面板/卡片状态文本命中；控制台 0 error、0 unhandledrejection。

## 5. 截图（PNG IHDR 实测 + sha256 前 12 位）

| 文件 | 尺寸 | 字节 | sha12 | 内容 |
| --- | --- | --- | --- | --- |
| `alerts-desktop.png` | 1440×900 | 99792 | `0e4abf58dd5f` | 铃铛红点 2 + 两条审计告警 + 去处理 |
| `alerts-mobile.png` | 390×844 | 35173 | `0a3d81820917` | 手机抽屉同内容 |
| `alerts-empty-desktop.png` | 1440×900 | 81469 | `edd43b326b60` | 一切正常 + 最近检查时间 |
| `alerts-resource-desktop.png` | 1440×900 | 108498 | `d5f30472da56` | 审计 2 条 + 内存接近红线（三源） |
| `progress-desktop.png` | 1440×900 | 86609 | `0700b8bfaa43` | 正在下载… 32%（真实阶段） |
| `progress-mobile.png` | 390×844 | 56919 | `df0cf4847ff7` | 正在下载… 16% |
| `progress-fallback-desktop.png` | 1440×900 | 85879 | `4ba2e6b5c8e8` | 无 SSE 时伪进度、无百分比、不报错 |

## 6. G-28 产品定位自评

1. **解决什么问题**：排障入口分散在审计/插件/资源/槽位四个页面，告警中心用一次聚合回答「现在有没有事、点哪里处理」；安装进度从「猜耗时」变成真实阶段，失败能指出卡在下载/校验/解包/登记/重载哪一步。
2. **与宝塔 / 1Panel 差距**：宝塔有消息中心、1Panel 有外部通知渠道；本轮是无持久化、无外发、无历史的本地聚合（v1 范围），能力弱于它们的通知体系，但零配置、零新增表、不改后端存储。
3. **当前状态**：**可用**（告警四源与 SSE 进度均真机跑通）；限制是告警只在打开面板/首屏探测时计算、没有历史与通知外发，SSE 仅覆盖本进程安装任务。

## 7. 遗留/风险

- 主壳 RSS 实测 14.2–14.3 MiB，已越过 14 MiB 告警阈值（未越 16 MiB 红线）——告警按设计会持续提示，属真实观测而非误报。
- 桌面截图浏览器为 headless chromium（1440×900 / 390×844），非人工点击；动作链路为真实 DOM click + 真实后端请求。
- 本轮重启主实例属装载新二进制的必要动作，G-29 已声明；未提交 `bin/kored` / `web/dist` / 运行态文件。
