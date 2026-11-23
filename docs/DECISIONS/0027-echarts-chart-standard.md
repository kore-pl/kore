> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M2
> ADR 状态: accepted · 日期: 2026-11-23 · 决策者: lead · 关联: ../FRONTEND.md §13、./0016-resource-budget-final.md、./0021-i18n.md

# ADR-0027: 引入 ECharts 5 作为「零依赖静态产物」形态的例外——按需 ESM + 懒加载 vendor chunk

## 背景

M2 的主壳前端是**零依赖静态产物**：没有打包器、没有 `node_modules`，`web/*.js` 直接由 `go:embed` 进单二进制，首屏六件套 gzip 合计 ≤ 300 KiB（[FRONTEND](../FRONTEND.md) §7、[ADR-0016](./0016-resource-budget-final.md)）。这个形态是薄壳定位的一部分，不是临时状态。

但主壳的监控 / 概览 / 数据库 / Redis 等页面需要**趋势折线**与**静态占比图**，且要求秒级刷新。继续手写 SVG 的问题是：多序列、tooltip、缩放、坐标轴刻度、刷新时的增量更新全都要自研，代码量与回归面随图表数线性增长——那等于在工具链上省下的复杂度全部转嫁到业务代码里。

因此要引入 ECharts 5，而它天然与「零依赖」冲突。本 ADR 只回答一件事：**在什么边界内允许这个例外**，以及边界被突破时如何复审。具体工程条文（十条）落在 [FRONTEND](../FRONTEND.md) §13，本 ADR 不复述。

用户随需求下达的硬约束（按需 ESM、单页实例上限、迷你卡不用 ECharts、渲染器分型、dispose、统一防抖、精简配置、单图数据上限、验收口径）已逐条转为 §13 的判定条文。

## 决策

| 项 | 裁决 |
| --- | --- |
| 版本与形态 | ECharts 5，**按需 ESM**：唯一入口 `web/charts/echarts-entry.js` 显式 import 所需图表 / 组件 / 渲染器；构建为 `web/dist/charts-echarts.js`（vendor chunk） |
| 运行时封装 | `web/charts.js`：ESM，导出 `loadEcharts` / `createLineChart` / `disposeChart` / `disposeAll` / `count()`（活动实例数）；同一 host 复用实例，页面只经它建图，不直接 import ECharts |
| 构建 | `scripts/build-charts.sh` + `Makefile` 的 `make charts`；产物 `web/dist/charts.js` 与 `web/dist/charts-echarts.js`，**必须平铺**（静态路由 `/assets/{file}` 只接受单段文件名） |
| 首屏 | 图表不进首屏：`scripts/frontend-check.sh` 的 `FILES` 仍只列六件套，`d(首屏)/d(图表数)=0`；300 KiB gzip 预算不因图表增长 |
| 二进制 | vendor chunk 是否进 `web/embed.go` 由实现方按 §13 / 本 ADR 落定；一旦纳入，仍受单二进制 ≤ 25 MiB 门禁（G-03 / ADR-0016），且禁 `*.map` |
| 工程细则 | 十条判定条文统一在 FRONTEND §13，实现与验收只认 §13 |

**边界声明**：这是「零依赖」的**第一条例外，也是目前唯一一条**。例外只覆盖"图表渲染"这一类能力，不构成"以后前端可以随便引第三方运行时"的先例——新增第二个前端运行时依赖必须另开 ADR。

## 备选方案对比

| 方案 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- |
| A. 全量引入（`import * as echarts from 'echarts'` / `echarts/index`） | 写起来最快，不用逐个挑模块 | tree-shaking 失效，整包进 vendor；与"按需"约束直接冲突；体积数值以构建输出为准，不在本 ADR 写预估值 | **否决**（违反用户第 1 条约束） |
| B. 继续手写 SVG | 零依赖、零新增体积，与现有静态产物形态完全一致 | 多序列 / tooltip / 缩放 / 刷新增量全自研，秒级刷新场景下维护成本随图表数线性增长；等于自造图表库 | **否决**（成本转嫁到业务代码，长期更贵） |
| C. 运行时 CDN（`<script src="https://cdn...">`） | 首屏与二进制都不增加体积 | 破"离线可用 / 无联网校验"前提（G-10），离线或内网面板直接失效；供应链与版本漂移不可控；首屏多一个外部请求 | **否决**（与产品前提冲突） |
| D. 按需 ESM + 懒加载 vendor chunk（**选**） | 体积可控；图表与首屏隔离；封装单点收口 dispose / 防抖 / 实例计数 | 引入首个前端第三方运行时依赖，破"零依赖"的绝对表述；多一个构建脚本与产物；必须靠 §13 纪律防实例与内存膨胀 | **采纳**，并配复审条件 |

## 后果

**正面**：图表能力与首屏彻底隔离，装多少图表、开多少图表页都不影响首屏 gzip 与首屏请求数；按需入口把体积控制在"用到的图表类型"范围内；`web/charts.js` 成为 dispose / resize / 实例计数的唯一收口点，页面不会各写一套。

**负面**：项目第一次有了前端第三方运行时依赖，README / 文档里"零依赖"的表述需要限定为"零构建依赖 + 图表 vendor chunk 例外"；`make charts` 与 `web/charts/` 源码目录是新增的构建面；vendor chunk 的体积与升级节奏从此需要纳入 §9 的复核。

**技术债**：若图表页实例持续逼近上限（12），说明页面信息架构该拆（Tab / 折叠），不应通过调参或加大实例上限解决；ECharts 大版本升级另开 ADR，不在本 ADR 授权范围内。

**体积累计：见 `make frontend` 输出**（实现方落地后回填；本 ADR 不写未实测数字）。

## 验证方式

```bash
bash scripts/docs-check.sh        # 文档门禁（本 ADR 与 §13 同轮生效）
make charts                       # 产物存在、平铺、无 *.map（实现落地后）
make frontend                     # 首屏六件套 gzip 仍 ≤300 KiB（FILES 只列六件套）
make budget-check                 # 单二进制 ≤25 MiB（纳入 embed 后）
```

## 复审条件

任一条件出现即复审本 ADR，不靠"下次注意"：

1. **首屏预算被侵入**：图表相关改动让首屏 gzip 增长，或 `d(首屏)/d(图表数) ≠ 0` → 立即回退懒加载边界并复审。
2. **vendor chunk 超预算**：`web/dist/charts-echarts.js` 的 gzip 体积超出实现方在 §9 落定的预算，或单二进制逼近 25 MiB → 复审裁剪范围（减图表类型 / 拆 chunk / 换轻量库）。
3. **实例规模失控**：图表页单页实例 > 12，或需要同时刷新超过 12 个图 → 按 §13 第 2 条用 Tab / 折叠拆分；若拆分后仍不够，复审"是否该换渲染方案"，而不是上调上限。
4. **需要 WebGL / 大数据集渲染**：超出 Canvas 渲染器与 1000 点上限的设计前提 → 新开 ADR 评估，不在本 ADR 内扩权。
5. **新增第二个前端运行时依赖**：本 ADR 的例外不可类推，必须独立 ADR。
