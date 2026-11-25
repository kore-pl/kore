# 概览首页仪表盘（健康评分 / 关键指标 / 待办 / 快捷入口）· 验收报告

- 卡：overview-dashboard ｜ agent：`feat-overview-dashboard` ｜ 日期：2026-11-25
- 写域：`web/app.js`（仅概览段 `ov*` / `paintOv*` / `ovLoad*` / ensureAppCss 内的 `.ov-*` 规则）+ 本报告 + 双端截图
- 未改后端、未新增文件、未引依赖、未新增轮询（G-19）、未动其他插件仓 / `web/shell.js` / `web/onboarding.js` / 运行态资产（G-29）

## 1. 交付内容（依据 = 代码位置）

| # | 用户可见能力 | 实现位置 |
| --- | --- | --- |
| 1 | **健康状态卡**：健康分 + 正常/注意/异常/未采集 + 一句话结论 + 七项分项（CPU/内存/磁盘/负载/服务/证书/任务），异常与注意项整块可点直达 | `web/app.js:2193`（`ovHealth`）、`web/app.js:2364`（`paintOvHero`）、阈值 `web/app.js:1937` |
| 2 | **分项数据源**：服务＝告警＋插件失败（`web/app.js:2098`）、证书最少剩余天数（`web/app.js:2116`）、任务失败／路径失效（`web/app.js:2129`） | 同上 |
| 3 | **待办事项**：严重告警 / 告警待确认 / 插件运行失败 / 磁盘快满（≥85%）/ 证书 ≤30 天或过期 / 计划任务上次失败 / 任务指向程序不可用 / 内存偏高 / 插件可更新 / 推荐插件未装 / 监控插件未启用；每条右侧「去处理」直达；无待办显示「一切正常」 | `web/app.js:2280`（`ovTodoItems`）、`web/app.js:2434`（`paintOvTodos`） |
| 4 | **快捷入口**：新建网站 / 部署应用 / 查日志 / 打开终端（一键到对应视图，手机 2×2） | `web/app.js:2341`（`OV_ACTIONS`）、`web/app.js:2348`（`paintOvActions`） |
| 5 | **关键指标卡**：CPU / 内存 / 磁盘 / 负载 / **网络**（新增，累计收发 + 网卡错误），带迷你趋势 | `web/app.js:2610`（`ovNetCard`）、趋势 `web/app.js:2040`（`ovTrend`） |
| 6 | **迷你趋势**：优先用 monitor 插件 `history`（一次请求带回，不额外采样）；插件缺席退回会话内采样；点选/方向键读单点数值（G-32 数据点可读） | `web/app.js:2040`、采样 `web/app.js:2020` 附近（`ovPushSample`） |
| 7 | **装配**：首屏顺序 健康 → 快捷 → 待办 → 指标 → 服务/插件 → 最近告警 → 系统信息；多来源回填后按块重绘 | `web/app.js:2879`（`buildOverviewInto`）、`web/app.js:2952`（`loadOverview`）、`web/app.js:2945`（`repaintOvSummary`） |
| 8 | **修复**：概览首帧静态块（快捷入口/告警）因「先建后挂」被 `isConnected` 判活跳过；「查看全部告警」此前走 `ensureModule`（要求导出 `render`，而 `KoreAlerts` 只导出 `open`）必然失败 | `web/app.js:2966`（先挂后建）、`web/app.js:2827`（`openAlertCenter` 只认 `open()`） |

数据全部复用既有 API/插件方法（`system/metrics`、`invoke/monitor|site|ssl|discover`、`audit`、`cron.list`、`scheduler/tasks`、`store/presets`、`/plugins` 的 `update_available`），一次性拉取；任一来源失败只让对应分项显示「未采集/未启用」，不编 0。

## 2. 用户可见行为（隔离实例真机点击）

隔离实例：独立 `--config`（`127.0.0.1:18899`）、独立 state/run/log（工作区临时目录，测完已删），复制主实例 state 只读启动，**主实例 8787 与其运行态配置本轮零改动**（G-29）。

| 点击动作 | 观测结果 |
| --- | --- |
| 指标卡趋势条点击 | 读数由「近 24 次 · 低 6.1% 高 28.0% 最新 14.0%」变为「第 10 次采样 · 20.8%」 |
| 快捷入口「打开终端」 | hash → `#/terminal`，终端视图已挂载 |
| 待办「有 4 条告警待确认」 | 告警中心浮层可见（`.kore-alert-panel` visible=1），页面不跳走 |
| 待办「有 1 个计划任务上次执行失败」 | hash → `#/tasks` |
| 健康分项「服务 告警 4」 | 告警中心浮层可见（visible=1） |
| 手机 390×844 点待办 | hash → `#/tasks`；`document.scrollWidth 390 == innerWidth 390`（无横向滚动） |

首屏布局实测（playwright）：桌面 1440×900 健康卡在首屏顶部（top≈112），快捷入口 4 列；手机 390×844 健康卡 top=145、高 338，快捷入口 2 列（每格 179×75 ≥44px 触摸目标），待办行 340×58。

## 3. 门禁与证据（命令 + 退出码）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `node --check web/app.js` | `NODE_EXIT=0` |
| 单测 | `GOCACHE=<tmp> make test` | `[OK] go test 通过（根 module + 嵌套 module pkg/pluginapi）`，exit 0 |
| 明文凭据（G-30） | `make secret-check` | `secret-check: 0 FAIL / 22 处匹配（占位写法均合规）`，exit 0 |
| 首屏体积（G-03） | `make frontend` | `95065 字节 / 预算 307200`，余量 212135，exit 0（另有一条 WARN：体积漂移 >基线+5%，为本次新功能本体，非阻断） |
| 改动范围（G-12） | `git status --short` | 提交仅 `web/app.js` + 本报告 + 3 张截图；其余 M/?? 属他人（`web/store.js`、`web/redis.js`、`web/runtimes.js`、`web/style.css`、`scripts/frontend-check.sh` 等）未触碰 |
| 双端截图（G-28） | `file` / `md5sum` | `overview-dashboard-desktop-01.png` 1440×1377、`-desktop-02.png` 1440×1377、`overview-dashboard-mobile-01.png` 390×2388；md5 见 §5 |

## 4. 产品定位自评（G-28 ③）

- **本页解决什么用户问题**：登录后第一屏 3 秒回答「我的服务器现在怎么样、有什么要处理」。以前概览只有 4 张指标卡 + 两个计数面板，用户得自己把 CPU/磁盘/证书/任务拼起来判断；现在给一个健康分与结论，并把要动手的事逐条列出且可点直达。
- **与宝塔 / 1Panel 同类功能的差距**：宝塔首页＝固定指标卡 + 软件推荐，1Panel 首页＝资源卡片 + 应用入口，二者都**不做「待办聚合」**（告警、证书到期、任务失败分散在各页）。本页把「健康评分 + 可点待办 + 快捷入口」合成一屏，弱项是：暂无历史曲线大图（只有迷你趋势）、无自定义卡片、待办阈值暂为固定值（磁盘 85%、证书 30 天）不可配置。
- **当前状态**：**可用**（数据源真机取数、7 项检查与 2 条待办均由真实后端数据生成，双端点击全部命中）。已知限制：①「新建网站」只到网站页，站点新建弹窗没有程序化入口，需再点一次「新建站点」（2 步，仍 ≤3）；②「推荐插件未装」依赖后端 `KORE_PRESETS_DIR` 装配，未装配时该条不出现（不臆造推荐）。

## 5. 截图与实测哈希

```
overview-dashboard-desktop-01.png  PNG 1440x1377  4e4cff180c77e7ac2bb5cc4315782584
overview-dashboard-desktop-02.png  PNG 1440x1377  e429a047563b45c1a6819f0da79e7dd8
overview-dashboard-mobile-01.png   PNG 390x2388   e5613589717d660617aa0ef8fe0582e9
```

## 6. 观测到的相邻问题（不在本卡写域，未改）

1. **告警中心会重复实例化**：`web/alerts.js` 由主壳首屏后懒探测加载，若在途时再被注入会二次执行出两套浮层（本次点击验证时命中过：一个隐藏、一个可见）。建议 `web/alerts.js` 加载侧按 `window.KoreAlerts` 幂等。
2. **`cron.runlog` 404**：打开告警中心时 `alerts.js` 会调 `/api/v1/invoke/cron/cron.runlog`，当前 cron 插件版本无此方法 → 每次开浮层两条 404（功能降级，不阻断）。属插件版本差，非本卡改动。
3. **首屏体积基线**：本次新功能令首屏 gzip 81.5KB → 95.1KB（+13.4KB，预算 300KB 的 30.9%），`scripts/frontend-check.sh` 的漂移 WARN 会因此常亮，已在与 perf-budget-guard 的沟通中说明来源。

## 7. 清理

隔离实例（18899）已停止；临时目录（复制 state / 二进制 / gocache / 截图脚本 / 口令哈希）已删除；主实例 `bin/kored`、`.kore-local.yaml`、`.kore-local-state/` 未改动。
