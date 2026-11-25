# perf-frontend · 前端性能（懒加载 / 大列表 / 图表生命周期 / 首屏预算）

> 状态: verified · owner: perf-frontend · 日期: 2026-11-25 · 范围: 只读审计 + `web/files.js` / `web/backups.js` 两处改动
> 不碰：`web/shell.js`、`web/onboarding.js`、他人写域（`search.js` / `settings.js` / `config-panel.js` / `discover.js` / `integrity.js`）、Go 后端、GOMEMLIMIT/GOGC 与预算数字（用户已裁决延后）。

## 1. 结论

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 懒加载核对 | **已达标**：首屏只拉 4 个 JS + 1 个 CSS，所有视图模块首屏零请求；首屏后组件（theme/shortcuts/onboarding/alerts）也是首屏之后才注入 | 运行时抓包见 §3；`web/index.html:19-24`、`web/app.js:1646` / `:1693` / `:2423`、`web/shell.js:415` / `:445` |
| 大列表渲染 | **2 处无上限已修**（文件目录列表、备份列表）；其余页面审计后已有上限/分页，如实不改 | §2 |
| 图表生命周期 | **已达标**（自研 Canvas/SVG，无图表库）：实例上限、硬拒绝、100ms 单监听防抖、切走 dispose 全部兑现；运行时 4 实例 → 切走 0 | §4 + `web/monitor.js:40,643,922`、`web/process.js:18,416,440,466` |
| 首屏预算 | 改前 81528 B / 改后 81528 B（预算 307200，余量 225672） | §5 `make frontend` exit 0 |

## 2. 大列表审计与改动（用户可感）

### 2.1 改前 / 改后（同一份 2000 项目录 / 600 份备份，mock 数据，同一浏览器）

| 指标 | 文件目录列表 改前 | 改后 | 备份列表 改前 | 改后 |
| --- | --- | --- | --- | --- |
| 渲染行数 | **2000** | **200**（-90%） | **600** | **50**（-91.7%） |
| 页面 DOM 节点 | **34215** | **3618**（-89.4%） | **11205** | **1308**（-88.3%） |
| 「全选」触发整表重绘的主线程阻塞（3 次） | 110.9 / 103.9 / 114.8 ms | 12.8 / 20.2 / 13.7 ms | — | — |
| 「加载更多」行为 | 无 | 200→400→…→2000，9 次点完按钮消失 | 无 | 50 行/批 + 剩余计数 |
| 手机 390×844 渲染行数 | 2000 | 200 | 600 | 50 |

### 2.2 改动位置

- `web/files.js:18`（`LIST_PAGE = 200`）、`:369`（按 `listShown` 切片渲染）、`:450-462`（底部「已显示 X / 共 Y 项 + 加载更多（剩余 N 项）」）、`:593` / `:1115`（换目录 / 重进视图回到首批）、`:1126`（验收钩子 `__koreFilesList`）。
- `web/backups.js:15`（`LIST_PAGE = 50`）、`:900`（切片渲染）、`:927-939`（底部条 + 加载更多，焦点回填）、`:1129`（`loadList` 重置批次）、`:1202-1203`（视图注入 CSS，**不进首屏 `style.css`**）、`:1390`（验收钩子 `__koreBackupList`）。
- 行为保持：`checkedEntries()` 仍按 `S.entries` 全量计算，批量操作语义不变；「全选当前目录」仍是整目录（不因分批渲染而缩小选择范围）；预览、改名、搜索、回收站路径未动。
- 不引入新依赖、不改后端（`file.list` / `backup.list` 无 limit 参数，故分批只在渲染层做）。

### 2.3 审计后不改（已有上限 / 分页）

| 页面 | 现有上限 | 证据 |
| --- | --- | --- |
| 进程 | 默认 20 行 + 加载更多；接口单次 ≤500 | `web/process.js:22`、`:548-570` |
| 日志 | 跟随窗口 500 行；搜索 200 行 + 截断提示；单行 8 KiB | `web/logs.js:30`、`:239`、`:626`、`:685` |
| 审计 | 每页 50 + 加载更多，快照上限 1000 | `web/audit.js:4`、`:254` |
| 容器 | 每页 20 + 加载更多 | `web/container.js:11`、`:234-236` |
| Redis 键 | 按 limit 拉取 + 加载更多（上调 limit 重取，不静默丢数据） | `web/redis.js:404-462` |
| 完整性 | 最多 400 行 | `web/integrity.js:532` |
| 文件搜索 | 后端 `max_results` 200 + truncated 提示 | `web/files.js`（searchParams） |
| WAF 日志 | limit 200 | `web/waf.js:551` |

## 3. 懒加载核对（首屏请求实测）

隔离实例 + Playwright 抓 `/assets/*.js` 请求序列（登录后首屏）：

```
i18n-zh-CN.js, i18n.js, shell.js, app.js        ← 首屏四件（+ style.css 由 <link> 引入）
theme.js, shortcuts.js, onboarding.js, alerts.js ← 首屏之后才注入（shell.js:592/876/965-976），不计首屏预算
```

- 视图模块（store/files/sites/tasks/monitor/settings/terminal/db/logs/process/ssl/backups/redis/firewall/waf/dns/sshguard/runtimes/integrity/container/appdeploy/discover + 20+ 子视图）**首屏零请求**；切到文件页才出现 `files.js`，切到备份才出现 `backups.js`。
- 路由注册：`web/app.js:2423 shellRoutes()` 把 `SHELL_VIEWS[sub]` 全部包成 `KoreShell.view(...)`（= `shell.js:445 lazyView`）或 `moduleView`（`app.js:1693`），没有任何一处直接 `<script>` 引用视图。
- `web/index.html:19-24` 只有 4 个 defer 脚本；`scripts/frontend-check.sh:32` 的 `FILES` 只计六件套，`d(首屏)/d(视图数)=0` 成立。
- **结论：无「被首屏拖入的大文件」可改**；大文件是 `app.js`（gzip 39163 B）里的概览页本体，本身就是登录后首屏内容，拆出去只会多一个串行请求，不改。

## 4. 图表生命周期（G-32 / FRONTEND §13）

当前树内**没有 ECharts**（`git cat-file -e HEAD:web/charts.js` → 不存在；`web/*.js` 无 `from 'echarts'`），图表是自研 Canvas + LTTB 与 SVG：

| 判据 | 结论 | 证据 |
| --- | --- | --- |
| 懒加载 / 不进首屏 | 达标（monitor.js 等均为视图模块） | §3 抓包 |
| 实例 ≤12 + 第 13 个硬拒绝 | 达标（`CHART_INST_LIMIT = 12`，`charts.length >= 12` 直接 `return null`） | `web/process.js:18`、`:416` |
| dispose（切视图/Tab 销毁） | 达标：monitor `teardown`、process `destroy`、logs `disposeChart`、topology `teardown`、disk-analysis `disposer` 均销毁并清引用 | `web/monitor.js:643,879`、`web/process.js:440,1227`、`web/logs.js:384,634`、`web/topology.js:447`、`web/disk-analysis.js:198` |
| 100ms 单监听防抖 | 达标：唯一 `window.resize` 在封装内，实例清零即解绑 | `web/monitor.js:40,674`、`web/process.js:456`、`web/topology.js:26,443` |
| 单图 ≤1000 点 + 采样 | 达标（`MAX_POINTS=1000` 尾部截断 + LTTB 目标=可视宽度） | `web/monitor.js:36,277,410,562` |
| 运行时实例数 | 监控页 **4**（≤12）→ 切走 **0** | 本轮实测 `__koreMonitorChart.count()` |

## 5. 首屏预算（改前 / 改后）

`make frontend`（首屏六件套 gzip -9）：

```
index.html 1006 · style.css 19422 · app.js 39163 · shell.js 19015 · i18n.js 1594 · i18n-zh-CN.js 1328
首屏合计 81528 B / 预算 307200 B，余量 225672 B
i18n 增量 2922 B / 预算 3072 B
```

改前基线同为 **81528 B**（两处改动都在懒加载视图模块与视图注入 CSS 内，首屏文件零改动）；i18n 增量余量 150 B 为既有事实，本轮未动。

## 6. 门禁（命令 + 退出码）

| 命令 | 结果 |
| --- | --- |
| `make frontend` | **exit 0**，首屏 81528 ≤ 307200，dist 无 map/.vite/字体 |
| `make secret-check` | **exit 0**，0 FAIL |
| `GOCACHE=.gocache go test -timeout 200s ./...` | **exit 0**（16 包全 ok） |
| `node --check web/files.js` / `web/backups.js` | **exit 0** |

## 7. 双端截图（G-28）

| 场景 | 文件 | 实际尺寸 |
| --- | --- | --- |
| 文件目录 2000 项（加载更多可见） | `.agents/verify/screenshots/files-list-big-dir-desktop-01.png` | 1440×18377（full-page） |
| 同上（视口，底部条可见） | `.agents/verify/screenshots/files-list-big-dir-desktop-viewport-01.png` | 1440×900 |
| 同上（手机） | `.agents/verify/screenshots/files-list-big-dir-mobile-01.png` | 390×844 |
| 备份 600 份（加载更多可见） | `.agents/verify/screenshots/backups-list-many-desktop-01.png` | 1440×5217（full-page） |
| 同上（视口） | `.agents/verify/screenshots/backups-list-many-desktop-viewport-01.png` | 1440×900 |
| 同上（手机） | `.agents/verify/screenshots/backups-list-many-mobile-01.png` | 390×844 |

**产品定位自评（三问）**

1. **本页解决什么用户问题**：文件管理页在「大目录」（如 `node_modules`、日志目录、站点根）下打开即卡；备份页在历史备份累积后整表铺开。改动让「打开即用」恢复：首屏只画 200/50 行，其余按需追加。
2. **与宝塔 / 1Panel 的差距**：同类面板大目录同样整表渲染（浏览器端 DOM 数成正比），Kore 现在是「分批 + 明确总数 + 加载更多」，在超长列表上响应更稳；分段只影响渲染，不影响批量操作语义。
3. **当前状态**：**可用**（非占位）。分批阈值 200/50 与「已显示 X / 共 Y」计数可见，加载更多可键盘操作（重绘后焦点回填）。

## 8. 边界与未做

- 未改 `style.css`：底部条样式走各视图注入，避免首屏 gzip 增长（§5 数字前后一致即证据）。
- 未给 `file.list` / `backup.list` 加分页参数：属于后端/插件协议改动，本轮划出范围；渲染层分批已解决用户可感卡顿。
- 未动 `shell.js` / `onboarding.js` / 他人视图（审查期间 `settings.js`/`config-panel.js`/`integrity.js` 有并发改动，未触碰）。
- 本报告全部量测在隔离实例（`--config` + state/run/log 落 `.tmp/`，随机端口与口令，测完删除）上完成，**未改动主实例运行态配置**（G-29）。
