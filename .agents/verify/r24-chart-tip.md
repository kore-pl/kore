# R24 图表 tooltip 层级 + 下标补齐验收报告

Owner：`r24-charttip`（🔵 美团味）｜产品要求："图表都要注意 tip 的层级，不要被遮挡了"、"图表现在还是不全面，没有下标"

## 0. 结论先行

- **tip 遮挡**：全站 7 类图表逐一盘点。**真实风险 1 处**（拓扑关系图：tip 挂在 `overflow:auto` 的 stage 内 + 手机 stage 隐藏带走 tip），已修复；其余 6 类经 peer 实证核对为安全/已合规，**不动**（减少回归面）。
- **下标（轴刻度）缺失**：两张时序 Canvas 折线（监控历史曲线、进程趋势）此前只画 3 条水平网格线、**无任何 X 轴时间刻度 / Y 轴数值刻度**。已补齐，窄屏抽稀。
- **手机 tap 缺口**：拓扑手机端走列表 fallback，列表项此前无读数面板，已补 tap/hover 面板（G-32 §13-11 手机路径成立）。
- **规范落地**：`docs/FRONTEND.md §13` 新增第 12 条判据（tip 层级 + 坐标轴刻度），原文见 §5。

## 1. 全站图表 tip 盘点表（第一步：只读盘点结论）

| 图表 | tip 实现 file:line | 层级/挂载 | 遮挡风险 | 原因 |
| --- | --- | --- | --- | --- |
| 监控历史曲线（4 条折线） | CSS `web/monitor.js:88` / 定位 `:435-449` / 挂载 `:559` | DOM div，`position:absolute;z-index:2`，挂 `.mon-chart-box`（`position:relative`），父链无 overflow | **安全** | tip 在 box 内按指针 x/y 夹取（`bw=box.clientWidth`），box 无 overflow/transform，不会被裁；`pointer-events:none` |
| 进程趋势（CPU/内存） | CSS `web/process.js:164` / 定位 `:274-288` / 挂载 `:382` | DOM div，`absolute;z-index:3`，挂 `.proc-chart-box`（relative），抽屉 `.proc-drawer` 是 `overflow-y:auto` | **低风险（未改）** | 抽屉是纵向滚动容器，但 tip 垂直夹取在 canvas 高度内（`top<=c.h-th`），不溢出 canvas 底；抽屉打开时 tip 随内容滚动，不会被裁。抽屉 overlay 有更高 z-index 时 tip 会被盖，但 tip 与抽屉同源、鼠标在抽屉上时 tip 才显示，不构成实际问题 |
| 磁盘占比环 | CSS `web/disk-analysis.js:139` / 定位 `:224-230` / 挂载 `:306` | DOM div，`position:fixed;z-index:80`，挂 `document.body`，跟随指针 + 视口边界夹取 | **安全（正确范式）** | 已是 body+fixed+高 z-index+视口翻转，作为本次统一范式的参考实现，不动 |
| 日志命中占比环 | CSS `web/logs.js:82` / 定位 `:421-431` / 挂载 `:473` | DOM div，`position:absolute;z-index:5;top:0`，挂 `.logs-chart-body`（relative） | **安全（未改）** | peer `r10-logchart` 实证：`.logs-chart` 与 `.logs-out`（`max-height:56vh;overflow:auto`）是**兄弟节点**，tip 不在 overflow 子树内；且 `top:0` 垂直固定在图表区顶部（高 112px 环 vs ~50px tip），无裁切。改 body+fixed 反而会引入坐标系失效与 dispose 残留责任 |
| 监控卡片迷你图（磁盘环 / 网卡条 / 温度条） | CSS 复用 `.mon-tip`（`web/monitor.js:88`）/ 定位 `web/monitor-cards.js:163-181` / 挂载 `:150` | DOM div，`absolute;z-index:2`，挂 `.mon-cbox`（`position:relative`，`:105`） | **安全（未改）** | 面板卡片容器无 overflow 裁切，tip 按指针居中夹取在 box 宽度内；与 monitor 主图共享样式，语义一致 |
| 服务关系拓扑图 | CSS `web/topology.js:74` / 定位 `:304-318` / 挂载 `:461` | DOM div，原 `position:absolute;z-index:3`，挂 `.topo-stage`（`position:relative;overflow:auto`，`:63`） | **高风险（已修）** | ① 节点靠近 stage 右/下边缘时 tip 被 `overflow:auto` 裁切；② 手机 `@media(max-width:640px)` 下 `.topo-stage{display:none}`（`:87`），tip 随 stage 一起消失，手机 tap 完全无面板——直接击穿 G-32 §13-11 |
| SSH 失败柱状图（历史参考） | CSS `web/sshguard.js:669` / 定位 `:306-316` / 挂载 `:301` | DOM div，`absolute;z-index:2`，挂图表 box（relative） | **安全（不在写域，未改）** | 与 monitor/process 同构，垂直夹取在容器内；非本次写域 |
| 慢查询分析 | 无图表 tip（`web/slow-query.js` 的 `tips[]` 是 SQL 优化建议文本，非图表面板；无 `createElementNS`/`canvas`/图表 tip） | — | 不适用 | — |

## 2. 修复内容（第二步）

### 2.1 拓扑 tip 层级（web/topology.js）

- CSS `:74`：`position:absolute;z-index:3` → `position:fixed;z-index:80`（脱离 stage 的 overflow 裁切与层叠上下文）。
- 挂载点 `:461`：`add(stage, ...)` → `add(document.body, ...)`。
- `showTip()` `:304-318`：坐标从「clientX - stageRect.left + clamp(stage.width)」改为**视口坐标直接定位** + 右/下超界翻转到指针左侧/上方 + 夹进 `window.innerWidth/innerHeight`（EDGE=8, GAP=14）。
- 手机列表项 `:drawList()`：`.topo-list-row` 新增 `tabindex=0` + `click`/`touchstart`/`focus` 事件，复用 `showTip(n, clientX, clientY)`；「查看详情」按钮 `stopPropagation` 防误触行、保留跳转语义；按钮文案「查看」→「查看详情」。手机 tap 面板保持可见，只有点「查看详情」才跳转。
- 生命周期 `:425 teardown()`：新增 `if (S.tip && S.tip.parentNode) S.tip.parentNode.removeChild(S.tip)`，防切走视图残留 fixed 幽灵面板。
- 业务逻辑（数据源聚合/节点/连线/空态/跳转）**零改动**（r22-topology 原 owner 确认交我改 tip 相关）。

### 2.2 下标补齐（web/monitor.js + web/process.js）

- 两张图各新增 `axisFmt(v, unit)`（Y 轴数值缩写：≥1000 用 k、带单位首字母如 `%`/`M`）与 `drawAxes(c, g)`。
- `drawAxes` 在 `drawChart()` 里于折线之前调用（画在折线下方不遮挡）：
  - **Y 轴**：沿 3 条水平网格线（i=0/1/2）画数值刻度 `c.max*(i/2)`，带单位，绘制在 `CHART_PAD` 左侧留白内（x=2），不压折线。
  - **X 轴**：图底画时间刻度（`clockText(xs[idx]).slice(0,5)` → `HH:MM`），按画布宽度抽稀：`w<360` 画 2 档 / `w<640` 画 3 档 / 否则 4 档；首末档分别 `left`/`right` 对齐防裁切。
- 刻度用数据层已有的 `c.crossInk`（monitor）/ 灰常量（process），10px 等宽字体，与现有少点数值标注风格一致。

## 3. 验收证据（命令 + 退出码 + 输出）

### 3.1 node --check（改动文件语法）
```
$ for f in web/monitor.js web/process.js web/topology.js; do node --check "$f"; done
exit 0（三文件全过）
```

### 3.2 首屏预算（tip/下标改动不进首屏）
```
$ bash scripts/frontend-check.sh
首屏合计（gzip -9）: 79797 字节 / 预算 307200 字节（300 KiB）
[OK] 首屏体积达标：79797 字节 ≤ 307200 字节，余量 227403 字节
[OK] i18n 增量达标：2922 字节 ≤ 3072 字节，余量 150 字节
exit 0
```
说明：三文件都是懒加载视图模块，不在首屏六件套内，首屏 gzip 未因本次改动增长。

### 3.3 双端截图（headless playwright + 隔离实例，端口 18903）

隔离方式：`git archive HEAD` → `/tmp/kore-charttip-verify` → 覆盖 3 个改动文件 → 构建专用 kored → 独立 config/state/run/log 全落 `/tmp` → `/-/healthz` 就绪 → 真登录（随机口令 + `admin-password --set --stdin`）→ playwright 注入 cookie → mock 图表数据 → 触发 tip → 双端截图 → 停实例删目录。**未碰主实例 8787 / 共享桌面**。

| 截图 | file 实测 | identify 尺寸 | md5 | tip 状态（运行时 TIP_INFO） | 目视确认 |
| --- | --- | --- | --- | --- | --- |
| `chart-tip-desktop-monitor-01.png` | PNG 1440×1987 RGB | 1440×1987 | `81dc4f90046c461cb113c342a64956e4` | `{"text":"20:00:20\nCPU\n45.0%","w":96,"h":49,"pos":"absolute","z":"2"}` | CPU 曲线 hover 面板完整可见（20:00:20 / CPU 45.0%），不被卡片/表格压住；X 轴 19:57/19:59/20:00/20:02 + Y 轴 100%/50%/0.0% 刻度清晰 |
| `chart-tip-mobile-topo-01.png` | PNG 390×844 RGB | 390×844 | `9f9684ebfa67048db9df411130e27531` | `{"text":"echo（插件）\n状态：未知\n版本：0.1.0 · 深度：未知\n查看详情 →","x":46,"y":338,"w":162,"h":116,"pos":"fixed","z":"80"}` | 手机 tap 列表项弹出面板完整显示，浮在列表之上不被遮挡、不出视口；底部导航/顶栏未压住面板 |

**md5 注释**：桌面图首拍含 onboarding 引导遮罩（挡住 tip），已重拍（关遮罩）覆盖；上表为最终文件实测 md5。

**产品定位自评（G-28 三问）**：
1. 本页解决什么用户问题：图表读数面板被遮挡/被裁 + 无坐标刻度导致"图表看不懂/看不全"——现在桌面 hover、手机 tap 都能读到准确数值与单位，时序图有 X 时间/Y 数值刻度。
2. 与宝塔/1Panel 同类功能差距：同类面板图表多依赖 ECharts 默认 tooltip（层级常出问题、手机 tap 不支持）；本实现自研 Canvas + body/fixed 范式，手机 tap 与窄屏刻度抽稀更稳，但无缩放/框选等高级交互（非本期范围）。
3. 当前"可用"还是"占位"：**可用**——双端截图证实 tip 与下标真实显示、不被遮挡。

## 4. 桩数据声明

双端截图使用 mock 数据（隔离实例内 playwright route 拦截），**非真实插件数据**：
- 监控曲线：`monitor.system` 返回 6 点列式 history（timestamps + cpu/memory/load/disk_percent），非真实 /proc 采样。
- 拓扑：`/api/v1/plugins` + container.list + site.list + discover.ports 返回桩节点（echo 插件 / example.com 站点 / web 容器 / :8080 端口），因隔离实例未装对应插件。
用途仅为触发 tip 与下标渲染，证明层级/定位正确；数值非真实监控值。

## 5. docs/FRONTEND.md §13 新增判据原文

新增第 12 条（同步"十一条"→"十二条"）：

> **12｜tip 层级与坐标轴刻度（下标）**：读数面板 / tip 不得被卡片、表格、滚动容器遮挡或裁切；时序图必须有 X 轴时间刻度与 Y 轴数值刻度（**带单位**），不能只画网格线不给刻度值。
>
> 判据：① tip 的挂载祖先链上不得有 `overflow:hidden/auto/scroll` 或新建层叠上下文的 `transform/filter/opacity`；② 有风险的 tip 统一挂 `document.body` + `position:fixed` + 高 z-index（≥80）+ 跟随指针 + 右/下超界翻转并夹进视口；③ 手机有 SVG fallback 列表的图，列表项同样要绑 tap/hover 出面板；④ 挂 body 的 tip 必须在 teardown 里显式 removeChild；⑤ 时序图画网格线的同时必须绘 Y 轴≥3 档数值刻度（带单位）与 X 轴≥2 档时间刻度，刻度落在 padding 内不压折线；⑥ 窄屏 X 轴刻度抽稀到 ≤3 档且首末不被裁。缺任一项即返工。

**G-32 同步待办（不在本卡写域）**：根 `AGENTS.md` G-32 行的"§13 十一条判据"需 lead 后续同步为"十二条"——我未改 AGENTS.md（明文禁止）。

## 6. 写域与并行隔离

- 本次只改：`web/monitor.js`、`web/process.js`、`web/topology.js`（tip 层级/定位 + 下标）、`docs/FRONTEND.md` §13、本报告与两张截图。
- 未碰：`web/alerts.js`（r24-alertlayout）、`web/store.js`、`web/app.js`、`web/config-panel.js`、各插件仓，及 `web/logs.js`（peer 实证安全，主动不改）。
- 横向交流：`r24-alertlayout`（写域确认无交叠）、`r22-topology`（topology 原 owner，授权 tip 相关改动 + 指出手机 stage 隐藏缺口）、`r10-logchart`（logs 原 owner，实证 tip 安全不改）、`r24-topstatus`（顶栏 tip 范式对齐）。

## 7. 复现方式

```
# 隔离构建（HEAD + 我的 3 个文件）
git archive HEAD | tar -x -C /tmp/kore-charttip-verify
cp web/{monitor,process,topology}.js /tmp/kore-charttip-verify/web/
cd /tmp/kore-charttip-verify && make -s web-dist && \
  CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kored-charttip ./cmd/kored
# 隔离实例 + 真登录 + mock + 触发 tip + 双端截图（脚本用完即删，未留工作区）
```
