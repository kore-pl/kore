> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M2
> ADR 状态: accepted · 日期: 2026-11-23 · 决策者: lead · 关联: ../FRONTEND.md §13、./0016-resource-budget-final.md、./0021-i18n.md

# ADR-0027: 图表渲染方案选型——优先 ECharts5（按需 ESM + 懒加载 vendor chunk），允许等效替代

## 背景

M2 的主壳前端是**零依赖静态产物**：没有打包器、没有 `node_modules`，`web/*.js` 直接由 `go:embed` 进单二进制，首屏六件套 gzip 合计 ≤ 300 KiB（[FRONTEND](../FRONTEND.md) §7、[ADR-0016](./0016-resource-budget-final.md)）。这个形态是薄壳定位的一部分。

主壳的监控 / 概览 / 数据库 / Redis 等页面需要**趋势折线**与**静态占比图**，且要求秒级刷新。手写 SVG 的问题是：多序列、tooltip、缩放、坐标轴刻度、刷新时的增量更新全都要自研，代码量与回归面随图表数线性增长——那等于在工具链上省下的复杂度全部转嫁到业务代码里。

用户 2026-11-23 明确口径：**ECharts 是优先，不是唯一方案，也不是硬指标**。因此本 ADR 记录的是「首选默认 + 判据兜底」：ECharts 作为默认落地省掉重复造轮子，但**允许等效替代**（自研 Canvas/SVG、其它轻量库），只要逐条满足 [FRONTEND](../FRONTEND.md) §13。具体十条判据在 §13，本 ADR 不复述。

## 决策

| 项 | 裁决 |
| --- | --- |
| 定位 | **首选默认方案，非唯一 / 非硬指标**：先按 ECharts 落地；替代实现只要满足 §13 即可合入 |
| 版本与形态 | ECharts 5，**按需 ESM**：唯一入口 `web/charts/echarts-entry.js` 显式 import 所需图表 / 组件 / 渲染器；构建为 `web/dist/charts-echarts.js`（vendor chunk） |
| 运行时封装 | `web/charts.js`：ESM，导出 `loadEcharts` / `createLineChart` / `disposeChart` / `disposeAll` / `count()`（活动实例数）；同一 host 复用实例，页面只经它建图，不直接 import ECharts |
| 构建 | `scripts/build-charts.sh` + `Makefile` 的 `make charts`；产物 `web/dist/charts.js` 与 `web/dist/charts-echarts.js`，**必须平铺**（静态路由 `/assets/{file}` 只接受单段文件名） |
| 首屏 | 图表不进首屏：`scripts/frontend-check.sh` 的 `FILES` 仍只列六件套，`d(首屏)/d(图表数)=0`；300 KiB gzip 预算不因图表增长 |
| 二进制 | vendor chunk 是否进 `web/embed.go` 由实现方按 §13 / 本 ADR 落定；一旦纳入，仍受单二进制 ≤ 25 MiB 门禁（G-03 / ADR-0016），且禁 `*.map` |
| 工程细则 | 十条判定条文统一在 FRONTEND §13，实现与验收只认 §13 |
| **替代方案** | 可自研 Canvas/SVG 或换轻量库，前提是**逐条满足 FRONTEND §13**；选型理由、体积与实例证据须另开 ADR 或在本文追加「备选实施记录」。**ECharts 不是唯一方案、不是硬指标** |

**当前状态（2026-11-23）**：首选方案的基础设施已落地并经验收——`web/charts.js` + `web/charts/echarts-entry.js` + `scripts/build-charts.sh` + `make charts` + `web/embed.go` 两行 + `frontend-check` 图表卡口，提交 `cc47bac`（chunk 443910 B / gzip 149053；二进制 +471040 → 10477730 B，红线 26214400）。**该实现已就绪，但当前无页面消费者**：监控页历史曲线走**自研 Canvas + LTTB**（用户裁决 2026-11-23）。若后续二进制预算收紧，首个裁剪动作是**移除 embed 两行并暂缓 vendor chunk**，不需要改判据。若 `cc47bac` 被回退，以 `git log -- web/charts.js` 的实际状态为准。

**边界声明**：本 ADR 论证的是「首选方案为什么值得一个首屏 / 体积例外」，不构成"以后前端可以随便引第三方运行时"的先例——新增第二个前端运行时依赖必须另开 ADR；替代实现不需要重开本 ADR，但必须在 ADR 或本文留下选型记录，且不得破首屏与二进制预算。

## 备选方案对比

| 方案 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- |
| A. 全量引入（`import * as echarts from 'echarts'` / `echarts/index`） | 写起来最快，不用逐个挑模块 | tree-shaking 失效，整包进 vendor；与「按需」约束直接冲突 | **否决**（违反 §13 第 1 条） |
| B. 继续手写 SVG / 自研 Canvas | 零依赖、零新增体积，与现有静态产物形态完全一致 | 多序列 / tooltip / 缩放 / 刷新增量全自研，秒级刷新场景下维护成本随图表数线性增长 | **保留为可行替代**（判断点是多图秒级刷新下的维护成本，不是「必须用 ECharts」） |
| C. 运行时 CDN（`<script src="https://cdn...">`） | 首屏与二进制都不增加体积 | 破「离线可用 / 无联网校验」前提（G-10），离线或内网面板直接失效；供应链与版本漂移不可控 | **否决**（与产品前提冲突） |
| D. 按需 ESM + 懒加载 vendor chunk（**选**） | 体积可控；图表与首屏隔离；封装单点收口 dispose / 防抖 / 实例计数 | 引入首个前端第三方运行时依赖；多一个构建脚本与产物 | **首选默认**（省掉自研成本；替代实现按 §13 另行评估） |

## 后果

**正面**：图表能力与首屏彻底隔离，图表数与首屏 gzip 无关；按需入口把体积控制在「用到的图表类型」范围内；`web/charts.js` 成为 dispose / resize / 实例计数的唯一收口点；判据与厂商解耦后，后续换实现不需要推翻规范。

**负面**：首选方案带来一个前端第三方运行时依赖与构建步骤；「零依赖」表述需限定为「零构建依赖 + 图表 vendor chunk 例外」；判据与实现解耦后，各页面可能用不同实现，必须靠 ADR / 台账记录每次换方案的选型理由，否则后人无从判断为什么这里用 ECharts、那里用自研。

**技术债**：若图表页实例持续逼近上限（12），说明页面信息架构该拆（Tab / 折叠），不应通过调参或加大实例上限解决；ECharts 大版本升级另开 ADR。

**体积累计：见 `make frontend` 输出**（实现方落地后回填；本 ADR 不写未实测数字）。

## 验证方式

```bash
bash scripts/docs-check.sh        # 文档门禁（本 ADR 与 §13 同轮生效）
make charts                       # 首选方案产物存在、平铺、无 *.map
make frontend                     # 首屏六件套 gzip 仍 ≤300 KiB（FILES 只列六件套）
make budget-check                 # 单二进制 ≤25 MiB（纳入 embed 后）
```

图表页性能验收按 [FRONTEND](../FRONTEND.md) §13 第 10 条的**短窗口多轮**口径：满载 12 实例、秒级刷新 60s 计 1 轮、重复 3 轮（总约 3 分钟），每 5s 采样 `JSHeapUsedSize` 与实例计数（ECharts：`count()`；自研：如 `window.__koreMonitorChart.count()`），按「后 10s 均值 ≤ 前 10s 均值 ×1.05 / 切走后计数归零且 heap 回落 ≥20% / longtask 不累积」判定；**不做 10 分钟级 continuous soak**（用户口径：不跑长任务）。

## 复审条件

任一条件出现即复审本 ADR，不靠「下次注意」：

1. **首屏预算被侵入**：图表相关改动让首屏 gzip 增长，或 `d(首屏)/d(图表数) ≠ 0` → 立即回退懒加载边界并复审。
2. **vendor chunk 超预算**（首选方案）：`web/dist/charts-echarts.js` 的 gzip 体积超出实现方在 §9 落定的预算，或单二进制逼近 25 MiB → 复审裁剪范围（减图表类型 / 拆 chunk / 换轻量库）。
3. **实例规模失控**：图表页单页实例 > 12，或需要同时刷新超过 12 个图 → 按 §13 第 2 条用 Tab / 折叠拆分；若拆分后仍不够，复审「是否该换渲染方案」，而不是上调上限。
4. **替代实施**：若出现更轻、满足 §13 的实现（含自研），**允许替换**；替换须走 ADR——在本文追加「备选实施记录」（选型理由、体积、实例证据）或另开新 ADR，并同步 §13 / §9 对应句子。
5. **需要 WebGL / 大数据集渲染**：超出 Canvas 渲染器与 1000 点上限的设计前提 → 新开 ADR 评估，不在本 ADR 内扩权。
6. **新增第二个前端运行时依赖**：本 ADR 的例外不可类推，必须独立 ADR。
