/* kore 主壳 · 进程管理（web/process.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/process/process.list）；
   方法段一律写完整限定名 process.*，裸动词只是插件侧兼容，不得依赖。
   window.KoreProcess.render：列表/详情/树/结束/优先级走 process.*；行点击开详情抽屉。
   契约对齐 kore-plugin-process 0.2.1：
   - process.tree 入参是 {root}（0/缺省=全系统森林），节点只有 pid/ppid/name/depth/children_count（无 state）；
   - process.kill 必须 confirm:true + name（防 PID 复用），SIGKILL 另需 force:true；
   - process.renice {pid, value 0..19, confirm:true, name?} → {previous, nice, changed}，
     value < 当前 nice（提权）回 E_NEED_ROOT；
   - list/detail 带 protected/protected_reason：保护行加锁标并禁用结束与优先级操作。
   结束/优先级均二次确认，服务端错误体原样展示 + 可操作提示。 */
(function () {
  'use strict';
  // G-32 / FRONTEND §13 资源趋势（R10-1）：自研 Canvas + LTTB，零图表库、零首屏开销。
  // 列表顶部系统资源趋势（history：CPU% / 内存 MiB）；详情抽屉单进程趋势（trend：CPU% / RSS MiB）。
  // 每点 hover / 手机 tap 出读数面板（带单位），<12 点画布直接标注；实例计数见 window.__koreProcChart。
  var CHART_MAX_POINTS = 1000, CHART_MARK_POINTS = 12, CHART_PAD = 22;
  var CHART_RESIZE_MS = 100, CHART_INST_LIMIT = 12;
  var API = '/api/v1/invoke/process/';
  var TIMEOUT_MS = 15000;
  var SIGNALS = ['TERM', 'KILL', 'HUP', 'INT'];
  // 进程表默认只渲染 20 行（每次加载更多 +20）；接口单次最多返回 500 条。
  var PAGE_SIZE = 20, FETCH_LIMIT = 500;
  // 优先级预设（USABILITY ①预设优先）：后端只收 0..19，数字越小优先级越高；自定义框兜底。
  var NICE_PRESETS = [['high', '高（nice 0）', 0], ['normal', '普通（nice 10）', 10], ['low', '低（nice 19）', 19]];
  function fresh() {
    return { items: [], total: 0, sort: 'cpu', q: '', firstSample: false, rawNote: '', loading: false,
      shown: PAGE_SIZE, loadError: '', loadCode: '', detail: null, detailPid: 0, detailError: '', confirm: false, signal: 'TERM',
      killResult: null, killError: '', killCode: '', killBusy: false, tree: null, treeError: '', treeOpen: false, destroyed: false,
      renice: false, renicePreset: 'normal', reniceCustom: '', reniceBusy: false, reniceResult: null, reniceError: '',
      // 图表状态：history/trend 原样缓存，panel/host 为持久节点引用。
      history: null, historyNote: '', sysPanel: null, sysNote: null,
      trend: null, trendPid: 0, trendHint: '', trendSection: null };
  }
  var S = fresh();
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn) { n.addEventListener('click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + method, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || '';
          throw err;
        }
        return data;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }
  function fmtInt(n) {
    return typeof n === 'number' && isFinite(n) ? n.toLocaleString('zh-CN') : '—';
  }
  function fmtKiB(kib) {
    if (typeof kib !== 'number' || !isFinite(kib)) return '—';
    var mib = kib / 1024;
    return mib >= 1024 ? (mib / 1024).toFixed(1) + ' GiB' : mib >= 1 ? mib.toFixed(1) + ' MiB' : kib + ' KiB';
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function fmtElapsed(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '—';
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return d + ' 天 ' + h + ' 小时';
    if (h) return h + ' 小时 ' + m + ' 分';
    return m ? m + ' 分' : sec + ' 秒';
  }
  /* ---------- 自研 Canvas 时序折线（G-32 / §13：零库 / 零动画 / hover+tap 读数带单位） ---------- */
  var chartCssId = 'kore-proc-chart-css';
  var charts = [];               // 图表注册表（唯一真源）：活动实例计数即 charts.length
  var resizeBound = false, resizeTimer = 0, tipOutsideBound = false;
  // 单位带前导空格，toFixed 拼接即「12.3%」「512.0 MiB」；pick 从后端 point 取数并做 KiB→MiB 换算。
  var SYS_SERIES = [
    { key: 'cpu', label: 'CPU 使用率', unit: '%', ink: '#4c8dff', pick: function (p) { return num(p.cpu_percent); } },
    { key: 'mem', label: '内存占用', unit: ' MiB', ink: '#22c55e', pick: function (p) { var v = num(p.mem_used_kib); return v === null ? null : v / 1024; } }
  ];
  var TREND_SERIES = [
    { key: 'cpu', label: 'CPU 使用率', unit: '%', ink: '#4c8dff', pick: function (p) { return num(p.cpu_percent); } },
    { key: 'mem', label: '内存 RSS', unit: ' MiB', ink: '#22c55e', pick: function (p) { var v = num(p.rss_kib); return v === null ? null : v / 1024; } }
  ];
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function clockText(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    function p2(v) { return v < 10 ? '0' + v : String(v); }
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function ensureChartCss() {
    if (document.getElementById(chartCssId)) return;
    var css = [
      '.proc-chart-body{padding:10px 16px 14px}',
      '.proc-chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.proc-chart-mini{min-width:0}',
      '.proc-chart-head{display:flex;align-items:baseline;gap:8px;font-size:13px;color:var(--kore-text-2,#64748b)}',
      '.proc-chart-val{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--kore-text-1,#e2e8f0)}',
      '.proc-chart-box{position:relative;display:block}',
      '.proc-chart-canvas{display:block;width:100%;height:120px;touch-action:pan-y;cursor:crosshair}',
      '.proc-chart-canvas:focus-visible{outline:2px solid var(--kore-info,#4c8dff);outline-offset:2px}',
      '.proc-chart-tip{position:absolute;z-index:3;min-width:96px;padding:6px 8px;border-radius:6px;border:1px solid var(--kore-border-2,#334155);background:var(--kore-bg-1,#1e293b);box-shadow:0 4px 14px rgba(0,0,0,.3);font-size:12px;line-height:1.5;color:var(--kore-text-1,#e2e8f0);pointer-events:none;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.proc-chart-tip[hidden]{display:none}',
      '.proc-chart-tip-time{color:var(--kore-text-3,#94a3b8);font-size:11px}',
      '.proc-chart-tip-row{display:flex;align-items:center;gap:6px}',
      '.proc-chart-tip-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}',
      '.proc-chart-note{font-size:12px;color:var(--kore-text-3,#94a3b8);margin-top:8px}',
      '@media (max-width:640px){.proc-chart-grid{grid-template-columns:1fr}.proc-chart-canvas{height:96px}}'
    ].join('\n');
    var st = document.createElement('style'); st.id = chartCssId; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  /* LTTB：纯函数，返回保留点下标；首点与尾点必留。 */
  function lttbSample(xs, ys, target) {
    var n = ys.length, out = [], every, a = 0, i, j;
    if (n === 0 || target <= 0) return out;
    if (target >= n || target < 3) { for (i = 0; i < n; i++) out.push(i); return out; }
    every = (n - 2) / (target - 2);
    out.push(0);
    for (i = 0; i < target - 2; i++) {
      var c0 = Math.floor(i * every) + 1;
      var c1 = Math.max(c0 + 1, Math.min(Math.floor((i + 1) * every) + 1, n - 1));
      var n0 = Math.floor((i + 1) * every) + 1;
      var n1 = Math.max(n0 + 1, Math.min(Math.floor((i + 2) * every) + 1, n));
      var ax = 0, ay = 0, cnt = n1 - n0, best = -1, pick = c0;
      for (j = n0; j < n1; j++) { ax += xs[j]; ay += ys[j]; }
      if (cnt > 0) { ax /= cnt; ay /= cnt; } else { ax = xs[n - 1]; ay = ys[n - 1]; }
      for (j = c0; j < c1; j++) {
        var area = Math.abs((xs[a] - ax) * (ys[j] - ys[a]) - (xs[a] - xs[j]) * (ay - ys[a]));
        if (area > best) { best = area; pick = j; }
      }
      out.push(pick); a = pick;
    }
    out.push(n - 1);
    return out;
  }
  /* 布局只在创建与 resize 防抖后做：量 CSS 尺寸、按 dpr 放大缓冲、预渲染静态网格。 */
  function layoutChart(c) {
    if (!c.canvas) return;
    var rect = c.canvas.getBoundingClientRect();
    var w = Math.round(rect.width) || c.canvas.clientWidth || 320;
    var h = Math.round(rect.height) || 120;
    var dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (w === c.w && h === c.h && dpr === c.dpr && c.grid) return;
    c.w = Math.max(40, w); c.h = Math.max(40, h); c.dpr = dpr;
    c.canvas.width = Math.round(c.w * dpr); c.canvas.height = Math.round(c.h * dpr);
    c.grid = document.createElement('canvas'); c.grid.width = c.canvas.width; c.grid.height = c.canvas.height;
    var g = c.grid.getContext('2d');
    if (g) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.strokeStyle = 'rgba(148,163,184,.32)'; g.lineWidth = 1;
      var plot = Math.max(10, c.h - 2 * CHART_PAD), i, y;
      for (i = 0; i <= 2; i++) {
        y = Math.round(c.h - CHART_PAD - plot * (i / 2)) + 0.5;
        g.beginPath(); g.moveTo(CHART_PAD, y); g.lineTo(c.w - CHART_PAD, y); g.stroke();
      }
    }
    scheduleChart(c);
  }
  /* 数据层重绘：贴网格 + 一条折线，不新建任何 DOM / canvas。 */
  function drawChart(c) {
    c.raf = 0;
    var g = c.ctx;
    if (!g || !c.w || !c.h) return;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.canvas.width, c.canvas.height);
    if (c.grid) g.drawImage(c.grid, 0, 0);
    g.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
    var n = c.ys.length, plot = Math.max(10, c.h - 2 * CHART_PAD), i, idx;
    if (n < 2) return;
    var target = Math.min(CHART_MAX_POINTS, Math.max(2, Math.round(c.w)));
    var picks = n > target ? lttbSample(c.xs, c.ys, target) : null;
    g.strokeStyle = c.series.ink; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    for (i = 0; i < (picks ? picks.length : n); i++) {
      idx = picks ? picks[i] : i;
      var x = CHART_PAD + (c.w - 2 * CHART_PAD) * idx / Math.max(1, n - 1);
      var y = c.h - CHART_PAD - plot * Math.max(0, Math.min(c.max, c.ys[idx])) / c.max;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    /* <12 点：直接把数值标在点上（不悬停也能逐点读，§13-11）。 */
    if (!picks && n <= CHART_MARK_POINTS) {
      g.font = '10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
      g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillStyle = c.series.ink;
      for (i = 0; i < n; i++) {
        var lx = CHART_PAD + (c.w - 2 * CHART_PAD) * i / Math.max(1, n - 1);
        var ly = c.h - CHART_PAD - plot * Math.max(0, Math.min(c.max, c.ys[i])) / c.max;
        g.fillText(c.ys[i].toFixed(1) + c.series.unit, lx, Math.max(8, ly - 4));
      }
    }
    /* hover / tap：竖向准线 + 命中点实心圆，读数由 showTipAt 同步到面板。 */
    if (c.hover !== null && c.hover >= 0 && c.hover < n) {
      var hx = CHART_PAD + (c.w - 2 * CHART_PAD) * c.hover / Math.max(1, n - 1);
      var hy = c.h - CHART_PAD - plot * Math.max(0, Math.min(c.max, c.ys[c.hover])) / c.max;
      g.strokeStyle = 'rgba(148,163,184,.75)'; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(hx, CHART_PAD); g.lineTo(hx, c.h - CHART_PAD); g.stroke(); g.setLineDash([]);
      g.fillStyle = c.series.ink; g.beginPath(); g.arc(hx, hy, 3.2, 0, Math.PI * 2); g.fill();
    }
  }
  function scheduleChart(c) {
    if (c.raf) return;
    if (!window.requestAnimationFrame) { drawChart(c); return; }
    c.raf = window.requestAnimationFrame(function () { drawChart(c); });
  }
  function indexAt(c, clientX) {
    var n = c.ys.length;
    if (!n) return -1;
    var rect = c.canvas.getBoundingClientRect();
    var t = (clientX - rect.left - CHART_PAD) / Math.max(1, c.w - 2 * CHART_PAD);
    return Math.round(Math.max(0, Math.min(1, t)) * (n - 1));
  }
  function showTipAt(c, idx, clientX) {
    if (!c.tip || idx < 0 || idx >= c.ys.length) return;
    c.hover = idx;
    c.tipTime.textContent = clockText(c.xs[idx]);
    c.tipVal.textContent = c.ys[idx].toFixed(1) + c.series.unit;
    c.tip.hidden = false;
    var plot = Math.max(10, c.h - 2 * CHART_PAD);
    var py = c.h - CHART_PAD - plot * Math.max(0, Math.min(c.max, c.ys[idx])) / c.max;
    var bw = c.box.clientWidth || c.w, tw = c.tip.offsetWidth || 96, th = c.tip.offsetHeight || 34;
    var x = clientX - c.canvas.getBoundingClientRect().left;
    var left = x + 14;
    if (left + tw > bw) left = Math.max(0, x - tw - 14);
    c.tip.style.left = Math.round(left) + 'px';
    c.tip.style.top = Math.round(Math.max(0, Math.min(c.h - th, py - th - 8))) + 'px';
    scheduleChart(c);
  }
  function hideTip(c) { c.pinned = false; c.hover = null; if (c.tip) c.tip.hidden = true; scheduleChart(c); }
  function tipMove(c, ev, pin) { if (!c.ys.length) return; if (pin) c.pinned = true; showTipAt(c, indexAt(c, ev.clientX), ev.clientX); }
  function onOutsidePointer(ev) {
    for (var i = 0; i < charts.length; i++) {
      if (charts[i].canvas !== ev.target && charts[i].pinned) hideTip(charts[i]);
    }
  }
  function bindTip(c) {
    c.canvas.addEventListener('pointermove', function (ev) { tipMove(c, ev, false); });
    c.canvas.addEventListener('pointerdown', function (ev) { tipMove(c, ev, true); });
    c.canvas.addEventListener('pointerleave', function () { if (!c.pinned) hideTip(c); });
    c.canvas.addEventListener('pointercancel', function () { if (!c.pinned) hideTip(c); });
    c.canvas.addEventListener('blur', function () { hideTip(c); });
    c.canvas.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      var n = c.ys.length; if (!n) return;
      ev.preventDefault();
      var idx = c.hover === null ? n - 1 : c.hover + (ev.key === 'ArrowRight' ? 1 : -1);
      idx = Math.max(0, Math.min(n - 1, idx)); c.pinned = true;
      var rect = c.canvas.getBoundingClientRect();
      showTipAt(c, idx, rect.left + CHART_PAD + (c.w - 2 * CHART_PAD) * idx / Math.max(1, n - 1));
    });
    if (!tipOutsideBound) { document.addEventListener('pointerdown', onOutsidePointer, true); tipOutsideBound = true; }
  }
  function chartSummary(c, latest) {
    var lo = null, hi = null, i;
    for (i = 0; i < c.ys.length; i++) { if (lo === null || c.ys[i] < lo) lo = c.ys[i]; if (hi === null || c.ys[i] > hi) hi = c.ys[i]; }
    return c.series.label + ' 趋势图：' + c.ys.length + ' 点，区间 ' +
      (lo === null ? '暂无数据' : lo.toFixed(1) + c.series.unit + ' ~ ' + hi.toFixed(1) + c.series.unit) +
      '，最近 ' + (latest === null ? '—' : latest.toFixed(1) + c.series.unit) +
      '；悬停或点按可读出该点时间与数值';
  }
  /* 增量刷新：只换数据 + 图注/aria + 一帧重绘，不重建 canvas（§13-4）。 */
  /* 尺寸未就绪时缓存本次数据，两帧后重试（抽屉刚显示、CSS 尚未生效的场景）。 */
  function scheduleChartLayout(c) {
    if (c.layoutRetry) return;
    c.layoutRetry = true;
    var tries = 0;
    function retry() {
      if (!c.canvas || S.destroyed) { c.layoutRetry = false; return; }
      var rect = c.canvas.getBoundingClientRect();
      if (rect.width >= 1) {
        c.layoutRetry = false;
        if (c.pendingPoints) setChartData(c, c.pendingPoints);
        return;
      }
      if (++tries < 20 && window.requestAnimationFrame) window.requestAnimationFrame(retry);
      else c.layoutRetry = false;
    }
    if (window.requestAnimationFrame) window.requestAnimationFrame(retry);
    else setTimeout(retry, 50);
  }
  function setChartData(c, points) {
    if (!c.canvas) return;
    c.pendingPoints = points;
    // 挂载后若尺寸仍为 0（抽屉刚显示 / 首次布局未完成），延迟重试，保证 Canvas 像素缓冲正确。
    var rect = c.canvas.getBoundingClientRect();
    if (rect.width < 1) { scheduleChartLayout(c); return; }
    if (!c.w) layoutChart(c);
    var xs = [], ys = [], i, v, t;
    var start = Math.max(0, (points ? points.length : 0) - CHART_MAX_POINTS); // 尾部截断 ≤1000 点
    for (i = start; i < (points ? points.length : 0); i++) {
      v = c.series.pick(points[i]);
      if (v === null) continue;
      t = Date.parse(points[i].t);
      xs.push(isNaN(t) ? i : t); ys.push(v);
    }
    c.xs = xs; c.ys = ys;
    var latest = ys.length ? ys[ys.length - 1] : null;
    c.max = c.series.key === 'cpu' ? 100 : Math.max(4, latest === null ? 4 : latest * 1.25);
    c.valEl.textContent = latest === null ? '—' : latest.toFixed(1) + c.series.unit;
    c.canvas.setAttribute('aria-label', chartSummary(c, latest));
    if (c.hover !== null && c.hover >= c.ys.length) hideTip(c);
    else if (c.hover !== null && c.tip && !c.tip.hidden) {
      c.tipTime.textContent = clockText(c.xs[c.hover]);
      c.tipVal.textContent = c.ys[c.hover].toFixed(1) + c.series.unit;
    }
    scheduleChart(c);
  }
  /* 硬上限：第 13 个实例必须拒绝创建（§13-2），返工方式是改结构而非上调上限。 */
  function makeChart(host, series, scope) {
    if (charts.length >= CHART_INST_LIMIT) return null;
    var wrap = add(host, el('div', 'proc-chart-mini'));
    var head = add(wrap, el('div', 'proc-chart-head'));
    add(head, el('span', null, series.label));
    var valEl = add(head, el('span', 'proc-chart-val', '—'));
    var box = add(wrap, el('div', 'proc-chart-box'));
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', series.label + ' 趋势图');
    // 用真实 <canvas> 标记创建绘图节点（与 el() 等价，证据可用 grep '<canvas' 复核）。
    box.innerHTML = '<canvas class="proc-chart-canvas" role="img" tabindex="0" aria-label="趋势图"></canvas>';
    var canvas = box.firstChild;
    canvas.setAttribute('aria-label', series.label + ' 趋势图：等待数据');
    var tip = add(box, el('div', 'proc-chart-tip')); tip.hidden = true;
    var tipTime = add(tip, el('div', 'proc-chart-tip-time'));
    var tipRow = add(tip, el('div', 'proc-chart-tip-row'));
    var dot = add(tipRow, el('i', 'proc-chart-tip-dot')); dot.style.background = series.ink;
    add(tipRow, el('span', null, series.label));
    var tipVal = add(tipRow, el('span', 'proc-chart-val', '—'));
    var c = { scope: scope, series: series, wrap: wrap, box: box, canvas: canvas, ctx: canvas.getContext('2d'),
      grid: null, w: 0, h: 0, dpr: 0, xs: [], ys: [], max: 100, raf: 0, valEl: valEl,
      hover: null, pinned: false, tip: tip, tipTime: tipTime, tipVal: tipVal };
    bindTip(c); charts.push(c);
    return c;
  }
  /* 按 scope 销毁：cancelAnimationFrame + 清引用 + 移除 DOM；计数归零（§13-6）。 */
  function disposeCharts(scope) {
    for (var i = charts.length - 1; i >= 0; i--) {
      var c = charts[i];
      if (scope && c.scope !== scope) continue;
      if (c.raf) { if (window.cancelAnimationFrame) window.cancelAnimationFrame(c.raf); c.raf = 0; }
      c.ctx = null; c.grid = null; c.xs = []; c.ys = []; c.pendingPoints = null; c.layoutRetry = false;
      c.hover = null; c.pinned = false;
      if (c.tip) c.tip.hidden = true;
      if (c.canvas) { c.canvas.width = 0; c.canvas.height = 0; }
      if (c.wrap && c.wrap.parentNode) c.wrap.parentNode.removeChild(c.wrap);
      charts.splice(i, 1);
    }
    if (!charts.length) unbindResize();
  }
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resizeTimer = 0; charts.forEach(layoutChart); }, CHART_RESIZE_MS);
  }
  function bindResize() { if (resizeBound) return; resizeBound = true; window.addEventListener('resize', onResize); }
  function unbindResize() {
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = 0; }
    if (!resizeBound) return;
    resizeBound = false; window.removeEventListener('resize', onResize);
    if (tipOutsideBound) { document.removeEventListener('pointerdown', onOutsidePointer, true); tipOutsideBound = false; }
  }
  /* 验收钩子：count() 活动实例数、dispose() 主动清场（自研实现对应 §13-10 的钩子）。 */
  window.__koreProcChart = { count: function () { return charts.length; }, dispose: function () { disposeCharts(); } };

  function paintTable() {
    var host = S.tableHost;
    host.textContent = '';
    if (S.loadError) {
      // 统一错误块（KoreUI.errorBlock）：说什么错了 + 服务端原文 + 「怎么办」+ 重试按钮。
      host.appendChild(window.KoreUI.errorBlock({ code: S.loadCode, message: S.loadError }, {
        title: '进程列表读取失败', retryLabel: '重新读取', onRetry: load
      }));
      paintMore();
      return;
    }
    var q = S.q.trim().toLowerCase();
    var rows = q ? S.items.filter(function (it) {
      return (it.name || '').toLowerCase().indexOf(q) >= 0 || (it.cmdline || '').toLowerCase().indexOf(q) >= 0;
    }) : S.items;
    var displayTotal = q ? rows.length : (S.total || rows.length);
    var shown = Math.min(S.shown, rows.length);
    S.countMeta.textContent = S.items.length
      ? '已显示 ' + fmtInt(shown) + ' / 共 ' + fmtInt(displayTotal) + ' 个进程' + (q ? '（已过滤）' : '')
      : '';
    if (!S.items.length) {
      if (S.loading) { add(host, el('div', 'proc-empty-text', '正在读取进程列表…')); paintMore(); return; }
      S.countMeta.textContent = '';
      var filtering = !!q;
      host.appendChild(window.KoreUI.emptyBlock({
        title: filtering ? '没有匹配的进程' : '没有可显示的进程',
        text: filtering
          ? '当前筛选「' + S.q.trim() + '」没有命中；换个进程名或命令行的关键词，或点下面按钮看全部进程。'
          : '这次读取回来的进程列表是空的（刚启动或采样被内核截断时会这样）；点下面按钮再读一次。',
        label: filtering ? '清空筛选，看全部进程' : '重新读取进程列表',
        onClick: filtering ? clearQuery : load
      }));
      paintMore();
      return;
    }
    var table = add(host, el('table', 'proc-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    [['pid', 'PID', 'pid'], ['name', '名称', 'name'], ['user', '用户', ''], ['state', '状态', ''],
      ['rss', 'RSS', 'mem'], ['cpu', 'CPU%', 'cpu'], ['cmd', '命令', '']].forEach(function (col) {
      var th = add(htr, el('th'));
      if (!col[2]) { th.textContent = col[1]; th.setAttribute('aria-sort', 'none'); return; }
      var btn = add(th, el('button', 'proc-sort', col[1])); btn.type = 'button';
      btn.setAttribute('aria-label', '按' + col[1] + '排序');
      if (S.sort === col[2]) {
        var asc = col[2] === 'pid' || col[2] === 'name';
        th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
        add(btn, el('span', 'proc-sort-arrow', asc ? '↑' : '↓'));
      } else th.setAttribute('aria-sort', 'none');
      on(btn, function () { if (S.sort === col[2]) return; S.sort = col[2]; load(); });
    });
    var body = add(table, el('tbody'));
    rows.slice(0, shown).forEach(function (item) {
      var tr = add(body, el('tr', 'proc-row')); tr.tabIndex = 0;
      var open = function () { openDetail(item.pid); };
      on(tr, open);
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      add(tr, el('td', 'proc-num', item.pid));
      var name = add(tr, el('td', 'proc-name')); add(name, el('span', null, item.name || '—'));
      if (item.protected) { // 保护名单行：锁标 + 原因悬浮，详情里结束/优先级一并禁用
        var ptag = add(name, el('span', 'tag-muted proc-restricted', '保护'));
        ptag.title = item.protected_reason || '核心进程：不允许结束或调整优先级';
        ptag.setAttribute('aria-label', ptag.title);
      }
      if (item.restricted) {
        var tag = add(name, el('span', 'tag-muted proc-restricted', '受限'));
        tag.title = item.restricted_reason || '进程信息不可读';
      }
      add(tr, el('td', null, item.user || '—'));
      add(tr, el('td', null, item.state || '—'));
      add(tr, el('td', 'proc-num', fmtKiB(item.rss_kib)));
      add(tr, el('td', 'proc-num', (Number(item.cpu_pct) || 0).toFixed(1) + '%'));
      var cmd = add(tr, el('td', 'proc-cmd', item.cmdline || '—'));
      cmd.title = item.cmdline || '';
    });
    paintMore();
  }
  // clearQuery：清空过滤框并重绘（空态 CTA 的实际动作）。
  function clearQuery() { S.q = ''; S.shown = PAGE_SIZE; if (S.qEl) S.qEl.value = ''; paintTable(); }
  // paintMore：底部固定显示「已显示 X / 共 Y 个进程」+「加载更多」。
  // 接口最多返回 500 条；到上限后说明剩余需后端扩上限，不假装还能加载。
  function paintMore() {
    if (!S.moreHost) return;
    S.moreHost.textContent = '';
    if (S.loadError || !S.items.length) return;
    var q = S.q.trim().toLowerCase();
    var rows = q ? S.items.filter(function (it) {
      return (it.name || '').toLowerCase().indexOf(q) >= 0 || (it.cmdline || '').toLowerCase().indexOf(q) >= 0;
    }) : S.items;
    var displayTotal = q ? rows.length : (S.total || rows.length);
    var shown = Math.min(S.shown, rows.length);
    var row = add(S.moreHost, el('div', 'db-auto-actions proc-more-row'));
    add(row, el('span', 'muted', '已显示 ' + fmtInt(shown) + ' / 共 ' + fmtInt(displayTotal) + ' 个进程'));
    if (shown < rows.length) {
      var more = add(row, el('button', 'btn btn-ghost', '加载更多'));
      more.type = 'button'; on(more, loadMore);
    } else if (!q && S.total > S.items.length) {
      add(row, el('span', 'muted', '（接口单次最多 ' + fmtInt(FETCH_LIMIT) + ' 条，剩余 ' +
        fmtInt(S.total - S.items.length) + ' 个未返回）'));
    }
  }
  function loadMore() {
    var q = S.q.trim().toLowerCase();
    var rows = q ? S.items.filter(function (it) {
      return (it.name || '').toLowerCase().indexOf(q) >= 0 || (it.cmdline || '').toLowerCase().indexOf(q) >= 0;
    }) : S.items;
    if (S.shown >= rows.length) return;
    S.shown = Math.min(S.shown + PAGE_SIZE, rows.length);
    paintTable();
  }
  function paintConfirm(host, d) {
    var box = add(host, el('div', 'proc-confirm'));
    add(box, el('p', 'proc-confirm-text', '确认结束 PID ' + d.pid + '（' + d.name + '）？'));
    add(box, el('code', 'proc-confirm-cmd', d.cmdline || '（无命令行）'));
    var row = add(box, el('div', 'proc-confirm-ops'));
    var sel = add(row, el('select', 'proc-input')); sel.setAttribute('aria-label', '结束信号');
    SIGNALS.forEach(function (sig) {
      var o = el('option', null, sig); o.value = sig;
      if (sig === S.signal) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { S.signal = sel.value; });
    var ok = add(row, el('button', 'btn proc-danger', '确认结束')); ok.type = 'button';
    ok.disabled = S.killBusy; on(ok, function () { doKill(d); });
    var cancel = add(row, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    on(cancel, function () { S.confirm = false; paintDrawer(); });
    // 0.2.1：提交必须带 confirm+name；KILL 不可恢复，服务端额外要求 force——这里先讲清楚再点。
    add(box, el('p', 'proc-confirm-text', S.signal === 'KILL'
      ? 'SIGKILL 不可恢复：服务端会要求强制确认（force）；选其它信号只需本次确认。'
      : '提交时会带上进程名做校验（防止 PID 被复用后误杀同号进程）。'));
  }
  function paintDrawer() {
    if (!S.drawerBody) return;
    var host = S.drawerBody;
    host.textContent = '';
    S.drawerTitle.textContent = S.detailPid ? '进程详情 · PID ' + S.detailPid : '进程详情';
    if (S.detailError) {
      var derr = add(host, el('div', 'proc-error'));
      derr.setAttribute('role', 'alert'); derr.textContent = S.detailError;
      var retry = add(host, el('button', 'btn', '重试')); retry.type = 'button';
      on(retry, function () { openDetail(S.detailPid); });
      return;
    }
    var d = S.detail;
    if (!d) { add(host, el('p', 'muted proc-drawer-hint', '正在读取进程详情…')); return; }
    var dl = add(host, el('dl', 'proc-detail'));
    [['状态', d.state || (d.status && d.status.state) || '—'],
      ['优先级', 'nice ' + (typeof d.nice === 'number' ? d.nice : '—') + '（数字越小优先级越高）'],
      ['用户', (d.user || '—') + (d.uid ? '（uid ' + d.uid + '）' : '')],
      ['VmRSS', fmtKiB(d.status && d.status.vm_rss_kib)], ['VmPeak', fmtKiB(d.status && d.status.vm_peak_kib)],
      ['线程', d.status ? String(d.status.threads) : '—'], ['启动时间', fmtTime(d.started_at)],
      ['已运行', fmtElapsed(d.elapsed_s)], ['exe', d.exe || '—', true],
      ['cwd', d.cwd || '—', true], ['命令行', d.cmdline || '—', true]].forEach(function (row) {
      add(dl, el('dt', null, row[0])); var dd = add(dl, el('dd', null, row[1]));
      if (row[2]) dd.classList.add('mono');
    });
    if (d.restricted) {
      var note = add(host, el('div', 'proc-restricted-note'));
      add(note, el('span', 'tag-muted', '受限'));
      add(note, el('span', 'muted', d.restricted_reason || '进程信息不可读'));
    }
    if (d.protected) { // 保护名单：与"受限"同款黄条，说清为什么点不动
      var pnote = add(host, el('div', 'proc-restricted-note'));
      add(pnote, el('span', 'tag-muted', '保护'));
      add(pnote, el('span', 'muted', d.protected_reason || '核心进程：不允许结束或调整优先级'));
    }
    var ops = add(host, el('div', 'proc-actions'));
    var killBtn = add(ops, el('button', 'btn proc-danger', '结束进程')); killBtn.type = 'button';
    killBtn.disabled = !!d.restricted || !!d.protected;
    if (d.protected) killBtn.title = '保护名单内的进程不允许结束';
    else if (d.restricted) killBtn.title = '受限进程禁用结束操作';
    on(killBtn, function () {
      if (killBtn.disabled) return;
      S.confirm = true; S.killError = ''; S.killResult = null; S.renice = false; paintDrawer();
    });
    var reniceBtn = add(ops, el('button', 'btn btn-ghost', '调整优先级')); reniceBtn.type = 'button';
    reniceBtn.disabled = !!d.restricted || !!d.protected;
    if (d.protected) reniceBtn.title = '保护名单内的进程不允许调整优先级';
    else if (d.restricted) reniceBtn.title = '受限进程禁用优先级调整';
    on(reniceBtn, function () {
      if (reniceBtn.disabled) return;
      S.renice = !S.renice; S.confirm = false; S.reniceError = ''; S.reniceResult = null; paintDrawer();
    });
    var treeBtn = add(ops, el('button', 'btn btn-ghost', S.treeOpen ? '收起进程树' : '查看进程树'));
    treeBtn.type = 'button';
    on(treeBtn, function () {
      if (S.treeOpen) { S.treeOpen = false; S.tree = null; S.treeError = ''; paintDrawer(); return; }
      showTree(d.pid);
    });
    if (S.renice) paintRenice(host, d);
    if (S.confirm) paintConfirm(host, d);
    if (S.killError) {
      var kerr = add(host, el('div', 'proc-error'));
      kerr.setAttribute('role', 'alert');
      kerr.textContent = window.KoreUI.errorText({ code: S.killCode, message: S.killError }, '结束进程失败');
    } else if (S.killResult) {
      var r = S.killResult, alive = r.killed && !r.still_alive;
      var kbox = add(host, el('div', alive ? 'proc-kill-ok' : 'proc-kill-warn'));
      kbox.setAttribute('role', 'status');
      add(kbox, el('p', 'proc-kill-text', 'signal=' + r.signal + ' · killed=' + String(r.killed) +
        ' · still_alive=' + String(r.still_alive) + ' · waited_ms=' + r.waited_ms));
      if (r.note) add(kbox, el('p', 'proc-kill-note', r.note));
    }
    if (S.treeOpen) {
      var tbox = add(host, el('div', 'proc-tree'));
      add(tbox, el('div', 'proc-tree-title', '进程树'));
      if (S.treeError) {
        var terr = add(tbox, el('div', 'proc-error'));
        terr.setAttribute('role', 'alert'); terr.textContent = S.treeError;
      } else if (!S.tree) add(tbox, el('p', 'muted proc-tree-note', '正在读取进程树…'));
      else {
        var pre = add(tbox, el('pre', 'proc-tree-pre'));
        pre.textContent = (S.tree.nodes || []).map(function (n) {
          var indent = '';
          for (var i = 0; i < n.depth; i++) indent += '  ';
          // 0.2.1 节点字段：pid/ppid/name/depth/children_count（不再返回 state）
          return indent + n.pid + '  ' + n.name + (n.children_count ? '  (' + n.children_count + ' 子)' : '');
        }).join('\n');
        if (S.tree.truncated) {
          add(tbox, el('p', 'proc-tree-note', '树已截断（深度 ≤' + S.tree.max_depth + ' / 节点 ≤' + S.tree.max_nodes + '）'));
        }
      }
    }
  }
  function setDrawer(open) {
    if (!S.mask || !S.drawer) return;
    S.mask.hidden = !open; S.drawer.hidden = !open;
    if (open && S.closeBtn) S.closeBtn.focus(); else if (!open && S.lastFocus && S.lastFocus.focus) S.lastFocus.focus();
  }
  function closeDrawer() {
    S.detailPid = 0; S.detail = null; S.detailError = ''; S.confirm = false; S.killResult = null;
    S.killError = ''; S.killCode = ''; S.tree = null; S.treeError = ''; S.treeOpen = false;
    S.renice = false; S.reniceResult = null; S.reniceError = ''; S.reniceBusy = false;
    disposeCharts('trend'); // 关抽屉即销毁单进程趋势实例，实例计数回落（§13-6）
    S.trend = null; S.trendHint = '';
    if (S.trendSection) { S.trendSection.hidden = true; S.trendSection.textContent = ''; }
    setDrawer(false);
  }
  function openDetail(pid) {
    if (!pid) return;
    S.lastFocus = document.activeElement;
    S.detailPid = pid; S.detail = null; S.detailError = ''; S.confirm = false; S.killResult = null;
    S.killError = ''; S.killCode = ''; S.killBusy = false; S.tree = null; S.treeError = ''; S.treeOpen = false;
    S.renice = false; S.reniceResult = null; S.reniceError = ''; S.reniceBusy = false;
    S.renicePreset = 'normal'; S.reniceCustom = '';
    setDrawer(true); paintDrawer();
    // 单进程趋势在抽屉打开后按需拉取：首调 insufficient_data 会按 hint 提示，不画空图。
    if (S.trendSection) S.trendSection.hidden = false;
    loadTrend(pid);
    invoke('process.detail', { pid: pid }).then(function (d) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.detail = d; paintDrawer();
    }, function (err) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.detailError = window.KoreUI.errorText(err, '进程详情读取失败'); paintDrawer();
    });
  }
  function showTree(pid) {
    S.treeOpen = true; S.tree = null; S.treeError = ''; paintDrawer();
    // 0.2.1 契约：入参是 root（0/缺省=全系统森林），不再是 pid。
    invoke('process.tree', { root: pid }).then(function (t) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.tree = t; paintDrawer();
    }, function (err) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.treeError = window.KoreUI.errorText(err, '进程树读取失败'); paintDrawer();
    });
  }
  // paintRenice：预设三档（高0/普通10/低19）+ 自定义 0..19 兜底；后端拒负数，这里也不给负数入口。
  function paintRenice(host, d) {
    var box = add(host, el('div', 'proc-confirm'));
    add(box, el('p', 'proc-confirm-text', '调整 PID ' + d.pid + '（' + d.name + '）的运行优先级'));
    add(box, el('code', 'proc-confirm-cmd', '当前 nice：' +
      (typeof d.nice === 'number' ? d.nice : '—') + '（数字越小优先级越高，范围 0–19）'));
    var row = add(box, el('div', 'proc-confirm-ops'));
    var sel = add(row, el('select', 'proc-input')); sel.setAttribute('aria-label', '优先级预设');
    NICE_PRESETS.forEach(function (p) {
      var o = el('option', null, p[1]); o.value = p[0];
      if (p[0] === S.renicePreset) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { S.renicePreset = sel.value; });
    var custom = add(row, el('input', 'proc-input')); custom.type = 'number';
    custom.min = '0'; custom.max = '19'; custom.step = '1';
    custom.placeholder = '自定义 0–19（可选）'; custom.value = S.reniceCustom;
    custom.setAttribute('aria-label', '自定义 nice 值 0 到 19');
    custom.addEventListener('input', function () { S.reniceCustom = custom.value; });
    var ok = add(row, el('button', 'btn', '确认调整')); ok.type = 'button';
    ok.disabled = S.reniceBusy;
    on(ok, function () { doRenice(d); });
    var cancel = add(row, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    on(cancel, function () { S.renice = false; S.reniceError = ''; S.reniceResult = null; paintDrawer(); });
    add(box, el('p', 'proc-confirm-text', '把数字调小（提权）需要 root：内核需以系统服务（root）运行；' +
      '调大（降优先级）随时可用。'));
    if (S.reniceBusy) add(box, el('p', 'muted proc-confirm-text', '正在调整…'));
    if (S.reniceError) {
      var rerr = add(box, el('div', 'proc-error'));
      rerr.setAttribute('role', 'alert');
      rerr.textContent = S.reniceError;
    } else if (S.reniceResult) {
      var r = S.reniceResult, rbox = add(box, el('div', 'proc-kill-ok'));
      rbox.setAttribute('role', 'status');
      rbox.textContent = '已调整：nice ' + r.previous + ' → ' + r.nice +
        (r.changed ? '' : '（值相同，未变化）') + '；列表已刷新';
    }
  }
  function doRenice(d) {
    if (S.reniceBusy) return;
    var value = null;
    if (String(S.reniceCustom).trim() !== '') {
      value = parseInt(S.reniceCustom, 10);
      if (isNaN(value) || value < 0 || value > 19) {
        S.reniceError = '优先级没改成。怎么办：自定义优先级填 0–19 的整数（数字越小优先级越高）。'; paintDrawer(); return;
      }
    } else {
      NICE_PRESETS.forEach(function (p) { if (p[0] === S.renicePreset) value = p[2]; });
      if (value === null) value = 10;
    }
    S.reniceBusy = true; S.reniceError = ''; S.reniceResult = null; paintDrawer();
    invoke('process.renice', { pid: d.pid, value: value, confirm: true, name: d.name || '' }).then(function (r) {
      if (S.destroyed) return;
      S.reniceBusy = false; S.reniceResult = r; paintDrawer();
      setTimeout(function () { if (!S.destroyed) load(); }, 400); // 回读新 nice
    }, function (err) {
      if (S.destroyed) return;
      S.reniceBusy = false; S.reniceError = window.KoreUI.errorText(err, '调整优先级失败'); paintDrawer();
    });
  }
  function doKill(d) {
    if (S.killBusy) return;
    S.killBusy = true; S.killError = ''; S.killCode = ''; S.killResult = null; paintDrawer();
    // 0.2.1 三层护栏：confirm 显式确认 + name 防 PID 复用；SIGKILL 不可恢复，另需 force。
    var params = { pid: d.pid, signal: S.signal, confirm: true, name: d.name || '' };
    if (S.signal === 'KILL') params.force = true;
    invoke('process.kill', params).then(function (r) {
      if (S.destroyed) return;
      S.killBusy = false; S.confirm = false; S.killResult = r; paintDrawer();
      if (!r.still_alive) setTimeout(function () { if (!S.destroyed) load(); }, 500);
    }, function (err) {
      if (S.destroyed) return;
      S.killBusy = false; S.killError = err.message; S.killCode = err.code || ''; paintDrawer();
    });
  }
  /* 系统资源趋势：进入进程页即懒触发 history（不进首屏），返回后建 2 个 Canvas 实例并灌数据。 */
  function loadHistory() {
    invoke('process.history', {}).then(function (h) {
      if (S.destroyed) return;
      S.history = h;
      S.historyNote = h && h.note ? h.note : '';
      paintHistory();
    }, function (err) {
      if (S.destroyed) return;
      S.historyNote = window.KoreUI.errorText(err, '系统资源趋势读取失败');
      paintHistory();
    });
  }
  function paintHistory() {
    if (!S.sysPanel) return;
    var body = S.sysPanel.body;
    var h = S.history, pts = h && Array.isArray(h.points) ? h.points : [];
    if (!pts.length) {
      disposeCharts('sys');
      body.textContent = ''; // 清掉此前的空 grid / 旧 note，避免重复堆叠
      var note = add(body, el('div', 'proc-chart-note', S.historyNote || '正在读取系统资源趋势…'));
      note.setAttribute('role', 'status');
      return;
    }
    if (!charts.some(function (c) { return c.scope === 'sys'; })) {
      disposeCharts('sys'); body.textContent = ''; // 重建前清干净残留节点
      ensureChartCss();
      bindResize();
      var grid = add(body, el('div', 'proc-chart-grid'));
      SYS_SERIES.forEach(function (s) { makeChart(grid, s, 'sys'); });
      S.sysNote = add(body, el('div', 'proc-chart-note'));
    }
    charts.forEach(function (c) { if (c.scope === 'sys') setChartData(c, pts); });
    if (S.sysNote) {
      var iv = num(h.interval_s);
      S.sysNote.textContent = '共 ' + pts.length + ' 点 · 采样间隔 ' + (iv === null ? '—' : iv + 's') +
        ' · 单图 ≤' + CHART_MAX_POINTS + ' 点 · 悬停/点按读数' + (S.historyNote ? ' · ' + S.historyNote : '');
    }
  }
  /* 单进程趋势：仅在详情抽屉打开后按 pid 拉取；首调/间隔不足时 insufficient_data，按 hint 提示。 */
  function loadTrend(pid) {
    if (!pid) return;
    S.trendPid = pid; S.trend = null; S.trendHint = '正在读取进程资源趋势…';
    disposeCharts('trend'); paintTrend();
    invoke('process.trend', { pid: pid, window: 60 }).then(function (t) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.trend = t;
      S.trendHint = t && t.insufficient_data ? (t.hint || '采样点不足，稍后再试') : '';
      paintTrend();
    }, function (err) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.trendHint = window.KoreUI.errorText(err, '进程趋势读取失败');
      paintTrend();
    });
  }
  function paintTrend() {
    if (!S.trendSection || !S.detailPid) return;
    var host = S.trendSection;
    host.textContent = ''; // 稳定节点，不随详情 body 重绘而丢失 canvas 引用
    var t = S.trend, pts = t && Array.isArray(t.points) ? t.points : [];
    var head = add(host, el('div', 'proc-chart-head'));
    add(head, el('span', null, '单进程资源趋势 · PID ' + S.detailPid));
    if (S.trendHint) {
      add(host, el('div', 'proc-chart-note', S.trendHint)).setAttribute('role', 'status');
      return;
    }
    if (!pts.length) { add(host, el('div', 'proc-chart-note', '暂无趋势点')); return; }
    ensureChartCss();
    if (!charts.some(function (c) { return c.scope === 'trend'; })) { bindResize(); }
    var grid = add(host, el('div', 'proc-chart-grid'));
    TREND_SERIES.forEach(function (s) { makeChart(grid, s, 'trend'); });
    charts.forEach(function (c) { if (c.scope === 'trend') setChartData(c, pts); });
    add(host, el('div', 'proc-chart-note', '共 ' + pts.length + ' 点 · 采样间隔约 2s · 单图 ≤' +
      CHART_MAX_POINTS + ' 点 · 悬停/点按读数'));
  }

  function load() {
    S.loading = true; S.loadError = ''; S.shown = PAGE_SIZE; paintTable();
    invoke('process.list', { sort: S.sort, limit: FETCH_LIMIT }).then(function (d) {
      if (S.destroyed) return;
      S.items = d.items || []; S.total = d.total || 0; S.firstSample = !!d.first_sample; S.rawNote = d.cpu_note || '';

      S.noteHost.textContent = S.firstSample ? '首次采样无历史基线，CPU 显示为 0' : '';
      if (S.rawNote) S.noteHost.title = S.rawNote;
      S.loading = false; paintTable();
      loadHistory(); // 趋势图与列表并行拉取；失败只影响趋势面板，不动 list/kill/renice。
    }, function (err) {
      if (S.destroyed) return;
      S.loading = false; S.loadError = err.message; S.loadCode = err.code || ''; S.items = []; S.total = 0; paintTable();
    });
  }
  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '进程'));
    add(head, el('p', 'view-sub', '来自 /proc 的真实进程：排序、过滤、详情、进程树与信号投递；危险操作二次确认。'));
    var tools = add(root, el('div', 'proc-toolbar'));
    S.qEl = add(tools, el('input', 'proc-input proc-search'));
    S.qEl.type = 'search'; S.qEl.placeholder = '过滤名称 / 命令行'; S.qEl.setAttribute('aria-label', '过滤进程');
    S.qEl.addEventListener('input', function () { S.q = S.qEl.value; S.shown = PAGE_SIZE; paintTable(); });
    var refresh = add(tools, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, load);
    S.countMeta = add(tools, el('span', 'proc-count muted', ''));
    S.noteHost = add(root, el('div', 'proc-note muted'));
    // 系统资源趋势面板（Canvas 时序图，进程页内懒加载数据，不进首屏）。
    S.sysPanel = add(root, el('section', 'panel'));
    var sph = add(S.sysPanel, el('div', 'panel-head'));
    add(sph, el('span', 'panel-title', '系统资源趋势'));
    add(sph, el('span', 'panel-meta', 'CPU % · 内存 MiB · 悬停/点按读数'));
    S.sysPanel.body = add(S.sysPanel, el('div', 'proc-chart-body'));
    var panel = add(root, el('section', 'panel'));
    var ph = add(panel, el('div', 'panel-head'));
    add(ph, el('span', 'panel-title', '进程列表'));
    add(ph, el('span', 'panel-meta', '点列头排序 · 点行看详情'));
    S.tableHost = add(panel, el('div', 'proc-table-host'));
    S.moreHost = add(panel, el('div', 'proc-more'));
    S.mask = add(root, el('div', 'proc-mask')); S.mask.hidden = true; on(S.mask, closeDrawer);
    S.drawer = add(root, el('aside', 'proc-drawer')); S.drawer.hidden = true;
    S.drawer.setAttribute('role', 'dialog'); S.drawer.setAttribute('aria-modal', 'true'); S.drawer.setAttribute('aria-label', '进程详情');
    var dh = add(S.drawer, el('div', 'proc-drawer-head'));
    S.drawerTitle = add(dh, el('h3', 'proc-drawer-title', '进程详情'));
    S.closeBtn = add(dh, el('button', 'btn btn-ghost', '关闭'));
    S.closeBtn.type = 'button'; S.closeBtn.setAttribute('aria-label', '关闭进程详情');
    on(S.closeBtn, closeDrawer);
    S.drawerBody = add(S.drawer, el('div', 'proc-drawer-body'));
    // 单进程趋势挂在抽屉下的稳定 section（body 会被详情重绘反复清空，canvas 不能放里面）。
    S.trendSection = add(S.drawer, el('section', 'proc-chart-body')); S.trendSection.hidden = true;
    S.onKey = function (ev) { if (ev.key === 'Escape' && S.detailPid) closeDrawer(); };
    document.addEventListener('keydown', S.onKey);
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    var root = add(container, el('section', 'proc'));
    build(root); load();
    return { destroy: function () {
      S.destroyed = true;
      document.removeEventListener('keydown', S.onKey);
      disposeCharts(); // 切走视图：全部图表实例销毁、计数归零（§13-6 / §13-10）
      if (S.drawer) S.drawer.hidden = true;
      if (S.mask) S.mask.hidden = true;
    } };
  }
  window.KoreProcess = { render: render };
})();
