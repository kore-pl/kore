# UI P1 双端自证（G-28）· 2026-11-26

Owner：`ui-p1`（task-114）｜方案真源：`docs/DESIGN-REDUCTION.md` §2.1 / §2.2｜
隔离实例：`127.0.0.1:18931`（独立 config / state / run / log / data，非 8787；收工已关闭）。
**G-29 声明**：本轮未改动主实例 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` /
`bin/kored`，未重启 8787；隔离实例 config / state / log / 截图脚本 / 浏览器 profile 与二进制
在收尾时删除。第一次启动因相对 config 路径回退到默认 8787 端口（未写入主实例状态，
只见登录页，后立即 kill 并以绝对路径重启到 18931），未对 8787 做任何写操作。

## 截图清单（真实 headless 浏览器，非设计稿、非同图缩放）

工具：本地缓存 `playwright` 1.49.1 + `chrome-headless-shell-1255`，`--headless`，
PC 1440×900 / 手机 390×844 视口，`deviceScaleFactor=1`，手机 `isMobile/hasTouch=true`。
登录走真实表单（`#kore-password` + `MonitorTest!2026`），首屏后关掉新手引导弹层。

| 文件 | `identify -format '%wx%h'` 实测 | 场景 |
| --- | --- | --- |
| `screenshots/ui-p1-desktop-01-dashboard-full.png` | 1440×900 | PC 概览 full-page（焦点 1 + 快捷 3 + 待办 1） |
| `screenshots/ui-p1-desktop-01-dashboard-viewport.png` | 1440×900 | PC 概览精确视口 |
| `screenshots/ui-p1-desktop-02-monitor-full.png` | 1440×900 | PC 监控 hub full-page（4 tab + 5 分区，KPI 下沉可见） |
| `screenshots/ui-p1-desktop-02-monitor-viewport.png` | 1440×900 | PC 监控 hub 精确视口 |
| `screenshots/ui-p1-mobile-01-dashboard-full.png` | 390×897 | 手机概览 full-page |
| `screenshots/ui-p1-mobile-01-dashboard-viewport.png` | 390×844 | 手机概览精确视口 |
| `screenshots/ui-p1-mobile-02-monitor-full.png` | 390×1387 | 手机监控 hub full-page |
| `screenshots/ui-p1-mobile-02-monitor-viewport.png` | 390×844 | 手机监控 hub 精确视口 |

`file` 复核示例：
`ui-p1-desktop-01-dashboard-full.png: PNG image data, 1440 x 900, 8-bit/color RGB`
`ui-p1-mobile-01-dashboard-full.png: PNG image data, 390 x 897, 8-bit/color RGB`

## DOM 实测（PC / 手机一致）

概览 `#kore-overview` 根子节点 5：`ov-head` + `ov-hero`（焦点 1）+ `ov-actions`（快捷 3）
+ `ov-todo-panel`（待办，实测 2 条，上限改为 3）+ `ov-note`（降级提示）。
`.ov-action` = **3**（新建网站 / 查日志 / 打开终端），`.ov-todo` = 2（≤3），
`.ov-todo-all` 存在（查看全部 → 告警中心抽屉），hero 内 `.ov-hero-details .ov-check` = 7
（7 项明细收进折叠区，异常项仍直接可见）。
首页 KPI 卡 `.ov-card` = **0**，服务 / 插件计数面板 `.ov-status` = **0**，
最近告警面板 `.ov-alert-panel` = **0**，系统信息 `.ov-sysinfo` = **0**
（已下沉：KPI/容量 → 监控 hub，服务计数 → sites，插件计数 → store，最近告警 → 告警中心，
系统信息 → 设置页既有同数据源）。

监控 hub 顶层 tab = **4**（监控 / 日志 / 进程 / 告警，脚本全站计数 8 hub / 20 tab），
监控 tab 内分区 5（监控 / 系统体检 / 运行报告 / 服务拓扑 / 磁盘分析），
默认落在「监控」分区，真实显示 CPU 11.8% / 负载 5.86 / 磁盘 547.6GiB 等内核基础指标
并附「安装 monitor 插件可获得更多详情」降级说明。

旧 hash 深链重定向实测（全部落到新 tab + `?section=` 指定分区）：
`#/monitor/fault-drill` → `#/monitor/alert?section=fault-drill`（故障演练分区）；
`#/settings/snapshot` → `#/settings/governance?section=snapshot`（配置快照分区）；
`#/sites/site-migrate` → `#/sites/sites?section=site-migrate`（站点迁移分区）；
`#/security/dns` → `#/security/network?section=dns`（DNS 解析分区）。

## 自评三问（原文）

**问 1：本页解决什么用户问题？**
解决首页「21 块平铺、眼睛无处落下」与「tab 40 个、手机端 tab 条一屏放不下」两件事。
改后首页只有焦点（健康分 + 一句结论 + 1 个主按钮）、3 个高频快捷和最多 3 条待办，
「现在怎么样 / 有什么要处理 / 我要做点什么」一屏答完；KPI 与服务计数下沉到对应 hub，
首页不再和监控抢焦点。tab 按 §2.1 的 17 项映射合并到 20（监控 9→4、安全 8→3、
设置 6→3、网站 6→3、数据库 3→2、文件 3→2、计划任务 3→1），每个被移走的 tab
都有明确分区 / 上下文态归宿，旧 hash 深链重定向到对应分区，功能未删。

**问 2：与宝塔、1Panel 同类功能的差距？**
宝塔 / 1Panel 的首页是功能入口宫格 + 实时指标卡同屏，用户习惯一屏拿到「全部数字」；
Kore 把详细指标收进监控 hub，从首页看 CPU / 内存要多 1 次点击，这是本期动线变化
（已登记在 §2.2）。它们的侧栏常按「网站 / 数据库 / 文件 / 安全 / 设置」平铺大量二级项；
Kore 用 hub 内分区替代独立 tab，tab 名不再在 tab 条常显，前几次使用需要学习「先点 tab
再点分区」，但全局搜索与旧 hash 深链仍可直达。客观差距：磁盘分析从「文件」跨到
「监控」、故障演练进告警折叠区、通知通道进设置分区（均为 1 层点击变 2 层）；
插件行 5 按钮（P2）和手机隐藏帮助补丁（P2）尚未处理。Kore 的优势不变：薄壳、零框架、
首屏 gzip 90,924 B，远低于 300 KiB 预算，没有为界面增加常驻进程。

**问 3：当前「可用」还是「占位」？**
**可用。** 判据：双端截图来自隔离实例真实浏览器与真实登录；DOM 实测首页 3 快捷 /
待办 ≤3 / KPI 卡 0、监控 hub 4 tab + 真实指标；旧 hash 深链重定向四个样例都落到正确分区；
所有分区走既有 `KoreSites` / `KoreMonitor` / `KoreHealth` / `KoreFaultDrill` 等懒加载视图，
后端方法、CSRF 双提交、二次确认均未改动，不是演示壳。A6 硬判据原文未动、exit 仍由存量
违规决定；tab 计数只 INFO/WARN。`make frontend` exit 0（首屏 90,924 B ≤ 300 KiB，
但有体积漂移 WARN，`scripts/` 不在本期写域，登记后续期）；`go test ./cmd/kored/...` exit 0。
按用户裁决的渐进口径，所有设计目标点数均已达到（tab 20 ≤20、单 hub ≤4 ≤5、
首页焦点 1 + 快捷 3 + 待办 1），无未达项需转后续期，除首屏体积漂移 WARN。
