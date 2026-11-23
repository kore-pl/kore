/* kore 图表运行时封装（ESM，唯一收口点；FRONTEND §13 / ADR-0027）。

   职责：把 ECharts 的 vendor chunk 变成"按需、可销毁、可计数"的能力——
   - 懒加载：loadEcharts() 首次调用才 import('./charts-echarts.js')，首屏零请求、零体积；
   - 统一配置：createLineChart() 内部固定 Canvas 渲染器 + LTTB 采样 + 关动画 + 精简配置，
     页面不得自己写 ECharts option 的"性能三件套"；
   - 生命周期：disposeChart(host) / disposeAll()，实例注册表让 count() 可断言（验收口径）；
   - 防抖：全局唯一的 window resize 监听 + 100ms 防抖，不逐图各自绑定（§13 第 7 条）。

   加载方式：本文件是 ESM 模块，浏览器里只能经动态 import 进入（classic 脚本内合法）：
     import('/assets/charts.js').then(function (m) { return m.createLineChart(host, opts); })
   为了让现有 classic 脚本（视图模块）少写样板，模块求值时同时挂 window.KoreCharts。
   注意：**页面只经本文件建图，不得直接 import ECharts**（§13 第 1 条）。 */

// 单页实例硬上限（§13 第 2 条）：超限抛 E_CHART_LIMIT 并给用户可见提示，不静默降级。
const MAX_INSTANCES = 12;
// resize 防抖窗口（§13 第 7 条）：一个监听、一次合并。
const RESIZE_DEBOUNCE_MS = 100;
// 单图数据上限（§13 第 9 条）：超出时前端兜底截断到最近 1000 点（后端应预聚合）。
const MAX_POINTS = 1000;

let modulePromise = null;            // 懒加载的 vendor chunk（Promise<namespace>）
const instances = new Map();         // host -> echarts 实例（注册表，count() 的唯一真源）
const pending = new Map();           // host -> Promise，同一 host 并发建图共用一次
let resizeTimer = 0;
let resizeBound = false;
let noticeTimer = 0;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// X 轴时间戳：number 按本地 HH:MM:SS（秒级刷新图表的常规口径），字符串原样透传，
// 免得调用方为了标签再写一遍格式化。
function formatStamp(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v == null ? '' : v);
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// 尾部对齐切片：timestamps 与各 series.data 允许长度不齐，统一按"最近 N 点"窗口截取，
// 保证 X 轴与每条序列的最后一点对得上。
function tailWindow(timestamps, series) {
  let n = timestamps.length;
  for (const s of series) {
    if (s.data.length < n) n = s.data.length;
  }
  const win = Math.min(n, MAX_POINTS);
  const stamps = timestamps.slice(timestamps.length - win);
  const out = series.map(function (s) {
    return { name: s.name, data: s.data.slice(s.data.length - win) };
  });
  return { win: win, timestamps: stamps, series: out };
}

// 用户可见提示（超限 / 配置错误）：右上角小条，不拦截点击（pointer-events: none），
// 不依赖 style.css（该文件属监控改造轨写域），也不发请求。
function notify(text) {
  if (typeof document === 'undefined' || !document.body) return;
  const el = document.getElementById('kore-charts-notice') || document.createElement('div');
  el.id = 'kore-charts-notice';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'max-width:min(92vw,30rem)',
    'padding:10px 14px', 'border-radius:8px', 'background:#1f2430', 'color:#fff',
    'font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
    'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'z-index:2147483000',
    'pointer-events:none', 'text-align:left', 'word-break:break-word'
  ].join(';');
  el.textContent = text;
  if (!el.parentNode) document.body.appendChild(el);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 6000);
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// 全局唯一 resize 监听：实例表为空即解绑，避免"关掉图表页还在监听"。
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    resizeTimer = 0;
    instances.forEach(function (chart) {
      if (!chart.isDisposed()) chart.resize();
    });
  }, RESIZE_DEBOUNCE_MS);
}

function bindResize() {
  if (resizeBound || typeof window === 'undefined') return;
  window.addEventListener('resize', onResize);
  resizeBound = true;
}

function unbindResize() {
  if (!resizeBound || typeof window === 'undefined') return;
  window.removeEventListener('resize', onResize);
  clearTimeout(resizeTimer);
  resizeTimer = 0;
  resizeBound = false;
}

/** 懒加载 ECharts vendor chunk（幂等；失败不缓存，允许重试）。 */
export function loadEcharts() {
  if (!modulePromise) {
    modulePromise = import('./charts-echarts.js').then(function (mod) {
      return mod && mod.default ? mod.default : mod;
    }, function (err) {
      modulePromise = null;
      throw fail('E_CHART_LOAD', '图表组件加载失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }
  return modulePromise;
}

/** 当前活动图表实例数（验收断言用；dispose 后必须回落）。 */
export function count() {
  return instances.size;
}

/**
 * 建 / 更新一张 Canvas 时序折线图。
 * @param {HTMLElement} host 容器（需有非零尺寸；同一 host 复用同一实例，走 setOption 增量）
 * @param {{timestamps: Array<number|string>, series: Array<{name: string, data: number[]}>,
 *          unit?: string, min?: number, max?: number}} opts
 *   timestamps 与 series.data 尾部对齐；unit 只用于 Y 轴标签后缀。
 * @returns {Promise<object>} ECharts 实例（复用 host 时即既有实例）
 */
export function createLineChart(host, opts) {
  if (!host || host.nodeType !== 1) {
    return Promise.reject(fail('E_CHART_HOST', '图表容器不是有效元素'));
  }
  const config = opts || {};
  const timestamps = Array.isArray(config.timestamps) ? config.timestamps : null;
  const rawSeries = Array.isArray(config.series) ? config.series : null;
  if (!timestamps || timestamps.length === 0 || !rawSeries || rawSeries.length === 0) {
    return Promise.reject(fail('E_CHART_OPTS', '图表配置缺少 timestamps 或 series（不能为空）'));
  }
  for (const s of rawSeries) {
    if (!s || !Array.isArray(s.data)) {
      return Promise.reject(fail('E_CHART_OPTS', 'series 每项都需要 data 数组'));
    }
  }
  // 复用优先：同一 host 已有实例时不再计数、不再 init（§13 第 6 条的反面：禁重复 init）。
  if (instances.has(host)) {
    return updateExisting(host, buildOption(config));
  }
  // 并发保护：同一 host 上一个 createLineChart 还没完成时共用同一 Promise。
  if (pending.has(host)) return pending.get(host);
  if (instances.size >= MAX_INSTANCES) {
    const err = fail('E_CHART_LIMIT',
      '图表数量已达上限（' + MAX_INSTANCES + ' 个），请先关闭部分图表或改用 Tab 分页');
    notify(err.message);
    return Promise.reject(err);
  }

  const option = buildOption(config);
  const task = loadEcharts().then(function (echarts) {
    // 外来实例（例如别处 init 过同一容器）先销毁，避免 ECharts 双实例告警与内存泄漏。
    const stale = echarts.getInstanceByDom(host);
    if (stale) stale.dispose();
    const chart = echarts.init(host, null, { renderer: 'canvas' });
    chart.setOption(option, { lazyUpdate: true });
    instances.set(host, chart);
    bindResize();
    return chart;
  }).then(function (chart) {
    pending.delete(host);
    return chart;
  }, function (err) {
    pending.delete(host);
    throw err;
  });
  pending.set(host, task);
  return task;
}

function updateExisting(host, option) {
  return loadEcharts().then(function () {
    const chart = instances.get(host);
    if (!chart || chart.isDisposed()) {
      instances.delete(host);
      throw fail('E_CHART_GONE', '图表实例已销毁，请重新创建');
    }
    chart.setOption(option, { lazyUpdate: true });
    return chart;
  });
}

// 精简配置（§13 第 4、8 条）：animation 关、tooltip 关、只有一对必要坐标轴、
// 逐序列关 emphasis / markPoint / markLine / markArea，LTTB 采样 + 无符号点。
function buildOption(config) {
  const w = tailWindow(config.timestamps, config.series);
  const unit = typeof config.unit === 'string' ? config.unit : '';
  const yAxis = {
    type: 'value',
    min: typeof config.min === 'number' ? config.min : null,
    max: typeof config.max === 'number' ? config.max : null,
    splitNumber: 2,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { show: true, lineStyle: { color: 'rgba(120,132,150,.22)' } },
    axisLabel: unit ? { formatter: '{value}' + unit, fontSize: 10 } : { fontSize: 10 }
  };
  return {
    animation: false,
    backgroundColor: 'transparent',
    tooltip: { show: false },
    grid: { left: 6, right: 8, top: 8, bottom: 2, containLabel: true },
    xAxis: {
      type: 'category',
      data: w.timestamps.map(formatStamp),
      boundaryGap: false,
      axisLine: { show: true, lineStyle: { color: 'rgba(120,132,150,.35)' } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: true, fontSize: 10, interval: 'auto' }
    },
    yAxis: yAxis,
    series: w.series.map(function (s) {
      return {
        type: 'line',
        name: s.name || '',
        data: s.data,
        showSymbol: false,
        smooth: false,
        sampling: 'lttb',
        emphasis: { disabled: true },
        markPoint: { data: [] },
        markLine: { data: [] },
        markArea: { data: [] },
        lineStyle: { width: 1.5 }
      };
    })
  };
}

/** 销毁单个 host 的图表；返回是否真的销毁了实例（幂等）。 */
export function disposeChart(host) {
  if (!host || !instances.has(host)) return false;
  const chart = instances.get(host);
  instances.delete(host);
  pending.delete(host);
  if (!chart.isDisposed()) chart.dispose();
  if (instances.size === 0) unbindResize();
  return true;
}

/** 销毁全部实例（视图 teardown / 切 Tab 必须调；§13 第 6 条）。 */
export function disposeAll() {
  let n = 0;
  instances.forEach(function (chart) {
    if (!chart.isDisposed()) chart.dispose();
    n += 1;
  });
  instances.clear();
  pending.clear();
  unbindResize();
  return n;
}

// classic 脚本（现有视图模块）经动态 import 拿到模块后可直接用 window.KoreCharts，
// 避免每个调用点各写一遍 import('/assets/charts.js') 的样板。命名导出仍是契约本体。
const api = {
  loadEcharts: loadEcharts,
  createLineChart: createLineChart,
  disposeChart: disposeChart,
  disposeAll: disposeAll,
  count: count,
  MAX_INSTANCES: MAX_INSTANCES,
  RESIZE_DEBOUNCE_MS: RESIZE_DEBOUNCE_MS,
  MAX_POINTS: MAX_POINTS
};
if (typeof window !== 'undefined') window.KoreCharts = api;
export default api;
