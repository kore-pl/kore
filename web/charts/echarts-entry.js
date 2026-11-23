/* kore 图表 vendor chunk 入口（FRONTEND §13 / ADR-0027）。

   这是**整个仓库唯一允许 import ECharts 的文件**：只显式引入「时序折线」用到的最小集合，
   由 scripts/build-charts.sh 用 esbuild 以 ESM 树摇打包成 web/dist/charts-echarts.js
   （懒加载 chunk，不进首屏、不占首屏 gzip 预算）。

   规则（违反即返工，见 §13 第 1 条）：
   - 只 import 具体图表 / 组件 / 渲染器；禁止命名空间式的全量导入，禁止引 echarts 主包 /
     index / dist 深路径（树摇会失效、整包进 chunk）。
   - 新增图表类型（例如后续静态饼图 PieChart + SVGRenderer）必须在此显式追加 import 与 use()，
     并同轮给出 chunk 体积变化；本期只需要折线，不预埋未用组件。
   - 对外只暴露 init / getInstanceByDom / use：dispose 走实例方法，避免页面各有各的销毁路径。 */
import { init, use, getInstanceByDom } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

use([LineChart, GridComponent, CanvasRenderer]);

export { init, use, getInstanceByDom };
export default { init, use, getInstanceByDom };
