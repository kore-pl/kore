/* kore 主壳 · 监控视图（web/monitor.js）——零框架 / 零 CDN / 零外链 / 零定时器。
   数据源优先级：monitor 插件（真实读 /proc 与 /sys）→ 内核 /api/v1/system/metrics 降级。
   插件未安装或调用失败时**不报错、不白屏**：降级渲染内核基础指标并在顶部标一条灰字提示。
   调用形态：POST /api/v1/invoke/monitor/monitor.<method>（方法段写完整限定名）。
   刷新：仅手动「刷新」按钮（G-19 禁止轮询：本文件不含 setInterval / 轮询定时器）；
   唯一的 setTimeout 是 100ms 的 resize 防抖，唯一的时间驱动是单帧 requestAnimationFrame。
   渲染构件在 web/monitor-cards.js，进入本视图时才注入，不进首屏。
   window.KoreMonitor.render(container) → {destroy}。
   图表：自研 Canvas 折线（零图表库 / 零动画），hover 与手机 tap 都出读数面板（时间 +
   数值 + 单位）；生命周期统一走本文件的 charts 注册表，验收断言入口
   window.__koreMonitorChart = {count, dispose}。 */
(function () {
  'use strict';

  var API = '/api/v1/invoke/monitor/monitor.';
  var METRICS = '/api/v1/system/metrics';
  var CARDS_URL = '/assets/monitor-cards.js';
  var STYLE_ID = 'kore-mon-style';
  var FALLBACK_NOTE = '当前使用内核基础指标，安装 monitor 插件可获得磁盘/网络/温度详情';
  /* monitor 0.3.0：system 返回 history（列式数组）与 alerts；阈值随调用传入（0 关闭）。 */
  var THRESHOLDS = { cpu_percent: 90, memory_percent: 90, disk_percent: 90 };
  /* 三条曲线：CPU / 内存 / 负载（负载不是百分比，按核数换算参照线）。
     ink 是主题色变量名（布局时只读一次 computedStyle），thr 指明参照线来源。 */
  var SERIES = [
    { key: 'cpu_percent', label: 'CPU', unit: '%', swatch: 'mon-swatch-cpu', ink: '--kore-info',
      pct: true, thr: 'cpu_percent' },
    { key: 'memory_percent', label: '内存', unit: '%', swatch: 'mon-swatch-mem', ink: '--kore-success',
      pct: true, thr: 'memory_percent' },
    { key: 'load1', label: '负载', unit: '', swatch: 'mon-swatch-load', ink: '--kore-text-3',
      pct: false, thr: 'cores' }
  ];
  /* 单序列点数硬上限；超出尾部截断（保留最近 MAX_POINTS 点），后端预聚合待办。 */
  var MAX_POINTS = 1000;
  /* 少于该点数时直接在点上标数值（G-32 §13 第 11 条：数据点少时标注比 tooltip 更直观）。 */
  var SMALL_POINTS = 12;
  var CHART_PAD = 22;
  var RESIZE_DEBOUNCE_MS = 100;
  var METRIC_LABEL = { cpu: 'CPU', memory: '内存', disk: '磁盘' };
  var S = { box: null, gen: 0, mode: '', sort: 'cpu', C: null, cardsReady: null,
    procs: null, procErr: '', refresh: null, src: null, tsEl: null, notice: null,
    cards: null, panels: null, warn: null, procBody: null, sortCpu: null, sortMem: null };
  /* 图表注册表（模块级，唯一真源）：charts 里的实例即 window.__koreMonitorChart.count()；
     chartPanelEl 是持久面板节点，刷新时复用同一个 canvas，不重建 DOM；
     resize 只在有实例时绑定一个监听（100ms 防抖），实例清零即解绑。 */
  var charts = [];
  var chartPanelEl = null;
  var legendTextEl = null;
  var resizeBound = false;
  var resizeTimer = 0;
  /* 读数面板的「点外部收起」监听全模块只绑一次。 */
  var tipOutsideBound = false;

  /* 本视图样式随模块注入（不修改 style.css）：卡片网格复用 .monitor-*，表格独立命名。 */
  var CSS = [
    '.mon-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}',
    '.mon-h2{margin:0;font-size:20px;font-weight:600}',
    '.mon-ts{font-size:12px;color:var(--kore-text-3);font-variant-numeric:tabular-nums}',
    '.mon-head .btn{margin-left:auto;min-height:44px}',
    '.mon-notice{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--kore-text-3)}',
    '.mon-notice:empty{display:none}',
    '.mon-fail{color:var(--kore-danger)}',
    '.mon-panels{display:flex;flex-direction:column;gap:16px}',
    '.mon-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}',
    '.mon-table{width:100%;min-width:520px;border-collapse:collapse;font-size:13px}',
    '.mon-table th{text-align:left;padding:8px 12px;font-weight:400;font-size:12px;color:var(--kore-text-2);border-bottom:1px solid var(--kore-border-2);white-space:nowrap}',
    '.mon-table td{padding:10px 12px;border-top:1px solid var(--kore-border-2);white-space:nowrap}',
    '.mon-table tbody tr:first-child td{border-top:0}',
    '.mon-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '.mon-barcell{display:flex;align-items:center;gap:8px;min-width:150px}',
    '.mon-bar{position:relative;flex:1;height:6px;min-width:90px;background:var(--kore-bg-0);border-radius:3px;overflow:hidden}',
    '.mon-bar-fill{height:100%;background:var(--kore-success)}',
    '.mon-bar-warn{background:var(--kore-warning)}',
    '.mon-bar-fail{background:var(--kore-danger)}',
    '.mon-pct{font-size:12px;color:var(--kore-text-2);font-variant-numeric:tabular-nums}',
    '.mon-temp{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px}',
    '.mon-proc-head{display:flex;gap:8px}',
    '.mon-sort{min-height:44px;padding:0 12px;font-size:12px}',
    '.mon-sort[aria-pressed="true"]{border-color:var(--kore-info);color:var(--kore-text-1)}',
    '.mon-proc-meta{padding:8px 12px;border-top:1px solid var(--kore-border-2);font-size:12px;color:var(--kore-text-3)}',
    '.mon-chart-body{padding:8px 16px 12px}',
    '.mon-chart-box{position:relative;display:block;padding-top:6px}',
    '.mon-chart{display:block;width:100%;height:132px;touch-action:pan-y}',
    '.mon-chart:focus-visible{outline:2px solid var(--kore-info);outline-offset:2px}',
    /* 读数面板（tooltip）：hover / tap 显示该 x 位置的时间与数值，pointer-events:none 不挡手势 */
    '.mon-tip{position:absolute;z-index:2;min-width:88px;padding:6px 8px;border-radius:6px;border:1px solid var(--kore-border-2);background:var(--kore-bg-1);box-shadow:0 4px 14px rgba(0,0,0,.28);font-size:12px;line-height:1.5;color:var(--kore-text-1);pointer-events:none;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.mon-tip[hidden]{display:none}',
    '.mon-tip-time{color:var(--kore-text-3);font-size:11px}',
    '.mon-tip-row{display:flex;align-items:center;gap:6px}',
    '.mon-tip-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}',
    '.mon-tip-val{color:var(--kore-text-1)}',
    '.mon-mini{padding:10px 16px 4px}',
    '.mon-mini-head{display:flex;align-items:baseline;gap:8px;font-size:13px;color:var(--kore-text-2)}',
    '.mon-mini-val{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--kore-text-1)}',
    '.mon-all{display:inline-block;min-height:44px;line-height:44px;padding:0 4px;color:var(--kore-info)}',
    '.mon-lock{margin-left:4px;font-size:11px;color:var(--kore-text-3)}',
    '.mon-empty-note{padding:12px 16px;color:var(--kore-text-3)}',
    '@media (max-width:640px){.mon-chart{height:96px}.mon-mini{padding:8px 12px 2px}}',
    '.mon-legend{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;font-size:12px;color:var(--kore-text-2);padding-top:8px}',
    '.mon-legend i{display:inline-block;width:10px;height:3px;margin-right:6px;vertical-align:middle;border-radius:2px}',
    '.mon-swatch-cpu{background:var(--kore-info)}',
    '.mon-swatch-mem{background:var(--kore-success)}',
    '.mon-swatch-load{background:var(--kore-text-3)}',
    '.mon-legend-note{color:var(--kore-text-3)}',
    '.mon-alert-body{padding:8px 16px 12px;display:flex;flex-direction:column;gap:8px}',
    '.mon-alert{padding:10px 12px;border-left:3px solid var(--kore-warning);background:var(--kore-bg-0);border-radius:4px}',
    '.mon-alert-critical{border-left-color:var(--kore-danger)}',
    '.mon-alert-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.mon-alert-val{margin-left:auto;font-size:13px;font-variant-numeric:tabular-nums}',
    '.mon-alert-hint{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--kore-text-2)}'
  ].join('\n');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function stale(gen) { return gen !== S.gen || !S.box; }

  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [], i, kv;
    for (i = 0; i < parts.length; i++) {
      kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }

  /* invoke：POST /api/v1/invoke/monitor/monitor.<method>；错误带 code/status 供降级判定。 */
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(API + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('HTTP ' + res.status)));
          err.code = data.code || ''; err.status = res.status; throw err;
        }
        return data;
      });
    });
  }

  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.text().then(function (raw) {
          var data = null;
          if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
          return { ok: res.ok, status: res.status, data: data };
        });
      });
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = el('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function chip(toneName, text) {
    var c = el('span', 'chip chip-' + toneName), dot = el('span', 'dot');
    if (toneName === 'ok' || toneName === 'warn' || toneName === 'fail') dot.classList.add(toneName);
    add(c, dot); add(c, el('span', null, text));
    return c;
  }

  /* 渲染构件按需注入：同一会话只插一次，失败给出可重试错误而不是白屏。 */
  function ensureCards() {
    if (window.KoreMonitorCards) { S.C = window.KoreMonitorCards; return Promise.resolve(S.C); }
    if (S.cardsReady) return S.cardsReady;
    S.cardsReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = CARDS_URL; s.defer = true;
      s.onload = function () {
        if (window.KoreMonitorCards) { S.C = window.KoreMonitorCards; resolve(S.C); return; }
        S.cardsReady = null;
        reject(new Error('monitor-cards.js 未导出 KoreMonitorCards'));
      };
      s.onerror = function () { S.cardsReady = null; reject(new Error('monitor-cards.js 加载失败')); };
      document.head.appendChild(s);
    });
    return S.cardsReady;
  }

  function setSource() {
    if (!S.src) return;
    S.src.textContent = '';
    S.src.appendChild(S.mode === 'plugin' ? chip('ok', '数据来源：monitor 插件 · /proc')
      : chip('na', '数据来源：内核基础指标'));
  }

  function notice(lines, fail) {
    if (!S.notice) return;
    S.notice.textContent = '';
    S.notice.classList.toggle('mon-fail', !!fail);
    (lines || []).forEach(function (line) { add(S.notice, line); });
  }

  function stamp() {
    if (S.tsEl) S.tsEl.textContent = '最后更新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function setBusy(busy) {
    if (!S.refresh) return;
    S.refresh.disabled = busy;
    S.refresh.textContent = busy ? '刷新中…' : '刷新';
  }

  /* 温度单独走 monitor.temperature：system 结果不含 thermal zone。 */
  function loadTemperature(host) {
    var gen = S.gen;
    invoke('temperature', {}).then(function (d) {
      if (stale(gen) || S.mode !== 'plugin') return;
      S.C.tempContent(host, d);
    }, function () {
      if (stale(gen) || S.mode !== 'plugin') return;
      host.textContent = '';
      add(host, el('span', 'muted', '温度读取失败（monitor.temperature）'));
    });
  }

  function paintSort() {
    if (!S.sortCpu || !S.sortMem) return;
    S.sortCpu.setAttribute('aria-pressed', S.sort === 'cpu' ? 'true' : 'false');
    S.sortMem.setAttribute('aria-pressed', S.sort === 'mem' ? 'true' : 'false');
  }

  function setSort(sort) {
    if (S.sort === sort) return;
    S.sort = sort; paintSort(); loadProcs();
  }

  function loadProcs() {
    if (S.mode !== 'plugin' || !S.box || !S.C) return;
    var gen = S.gen;
    S.procs = null; S.procErr = '';
    S.C.procTable(S.procBody, S.procs, S.procErr, { allHref: '#/process' });
    invoke('processes', { limit: 10, sort: S.sort }).then(function (d) {
      if (stale(gen) || S.mode !== 'plugin') return;
      S.procs = d || {};
      S.C.procTable(S.procBody, S.procs, '', { allHref: '#/process' });
    }, function (err) {
      if (stale(gen) || S.mode !== 'plugin') return;
      S.procs = null; S.procErr = err.message || '未知错误';
      S.C.procTable(S.procBody, S.procs, S.procErr, { allHref: '#/process' });
    });
  }

  /* ---------- 自研 Canvas 时序曲线（零图表库 / 零动画 / 零 hover / 零 tooltip） ----------
     数据契约：monitor.system.history 是**列式数组**——history.timestamps（ms，单调递增）
     与 history.cpu_percent / history.memory_percent / history.load1 等长；
     cpu/memory 为 0–100 的百分比，load1 是核归一负载（>100 也合法，纵轴按核数放大）。
     前端只保最近 MAX_POINTS 点（尾部截断）；点数超过可视宽度像素数时用 LTTB 抽样，
     单帧绘制点数 ≤ min(可视宽度, 1000)。后端预聚合待办：当前 60s 一点时 1000 点约 16.7 小时窗口。
     布局（量尺寸 / 取主题色 / 铺网格）只在创建与 resize 防抖后做；刷新只重绘数据层。 */

  /* LTTB（Largest Triangle Three Buckets）：纯函数、无 DOM 依赖。
     入参 xs/ys 等长且按 x 递增，target 为目标点数；返回保留点的下标数组，
     首点与尾点必然保留（曲线两端不会被抽样吃掉）。 */
  function lttbSample(xs, ys, target) {
    var n = ys.length, out = [], every, a = 0, i, j;
    if (n === 0 || target <= 0) return out;
    if (target >= n || target < 3) {
      for (i = 0; i < n; i++) out.push(i);
      return out;
    }
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
      out.push(pick);
      a = pick;
    }
    out.push(n - 1);
    return out;
  }

  function cssVar(cs, name, fallback) {
    var v = cs && cs.getPropertyValue ? cs.getPropertyValue(name) : '';
    v = v && v.trim();
    return v || fallback;
  }

  /* 布局：量一次 CSS 尺寸，按 devicePixelRatio 放大像素缓冲（CSS 尺寸与像素尺寸分离），
     把静态网格预渲染到离屏 canvas。只在创建与 resize 防抖后调用，刷新路径不量布局。 */
  function layoutChart(c) {
    if (!c.canvas) return;
    var rect = c.canvas.getBoundingClientRect();
    var w = Math.round(rect.width) || c.canvas.clientWidth || c.box.clientWidth || 320;
    var h = Math.round(rect.height) || 132;
    if (w < 40) w = 40;
    if (h < 40) h = 40;
    var dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (w === c.w && h === c.h && dpr === c.dpr && c.grid) return;
    c.w = w; c.h = h; c.dpr = dpr;
    c.canvas.width = Math.round(w * dpr);
    c.canvas.height = Math.round(h * dpr);
    var cs = window.getComputedStyle(c.canvas);
    c.ink = cssVar(cs, c.series.ink, '#4c8dff');
    c.gridInk = cssVar(cs, '--kore-border-2', 'rgba(148,163,184,.35)');
    c.refInk = cssVar(cs, '--kore-danger', '#e5484d');
    c.crossInk = cssVar(cs, '--kore-text-3', 'rgba(148,163,184,.75)');
    c.grid = document.createElement('canvas');
    c.grid.width = c.canvas.width;
    c.grid.height = c.canvas.height;
    var g = c.grid.getContext('2d');
    if (g) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.strokeStyle = c.gridInk;
      g.lineWidth = 1;
      var plot = Math.max(10, h - 2 * CHART_PAD), i, y;
      for (i = 0; i <= 2; i++) {
        y = Math.round(h - CHART_PAD - plot * (i / 2)) + 0.5;
        g.beginPath(); g.moveTo(CHART_PAD, y); g.lineTo(w - CHART_PAD, y); g.stroke();
      }
    }
    scheduleChart(c);
  }

  /* 数据层重绘：clearRect + 贴离屏网格 + 画一条折线。不新建任何 DOM / canvas。 */
  function drawChart(c) {
    c.raf = 0;
    var g = c.ctx;
    if (!g || !c.w || !c.h) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.canvas.width, c.canvas.height);
    if (c.grid) g.drawImage(c.grid, 0, 0);
    g.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
    var n = c.ys.length, plot = Math.max(10, c.h - 2 * CHART_PAD), i, idx;
    if (c.ref !== null && c.ref > 0) {
      var ty = Math.round(c.h - CHART_PAD - plot * Math.min(1, c.ref / c.max)) + 0.5;
      g.strokeStyle = c.refInk;
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(CHART_PAD, ty); g.lineTo(c.w - CHART_PAD, ty); g.stroke();
      g.setLineDash([]);
    }
    if (n < 2) return;
    /* 目标点数 = 可视宽度像素数，硬上限 MAX_POINTS；超出才抽样。 */
    var target = Math.min(MAX_POINTS, Math.max(2, Math.round(c.w)));
    var picks = n > target ? lttbSample(c.xs, c.ys, target) : null;
    g.strokeStyle = c.ink;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    for (i = 0; i < (picks ? picks.length : n); i++) {
      idx = picks ? picks[i] : i;
      var x = CHART_PAD + (c.w - 2 * CHART_PAD) * idx / Math.max(1, n - 1);
      var y = c.h - CHART_PAD - plot * Math.max(0, Math.min(c.max, c.ys[idx])) / c.max;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    /* 少点图直接把数值标在点上：不用悬停也能读出每个点（G-32 §13 第 11 条）。 */
    if (!picks && n > 0 && n <= SMALL_POINTS) {
      g.font = '10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillStyle = c.ink;
      for (i = 0; i < n; i++) {
        var lx = CHART_PAD + (c.w - 2 * CHART_PAD) * i / Math.max(1, n - 1);
        var ly = c.h - CHART_PAD - plot * Math.max(0, Math.min(c.max, c.ys[i])) / c.max;
        g.fillText(c.ys[i].toFixed(1) + (c.series.unit || ''), lx, Math.max(8, ly - 4));
      }
    }
    /* 悬停 / 点按读数：竖向准线 + 命中点实心圆；数值面板由 showTipAt 同步更新。 */
    if (c.hover !== null && c.hover >= 0 && c.hover < n) {
      var hx = CHART_PAD + (c.w - 2 * CHART_PAD) * c.hover / Math.max(1, n - 1);
      var hy = c.h - CHART_PAD - plot * Math.max(0, Math.min(c.max, c.ys[c.hover])) / c.max;
      g.strokeStyle = c.crossInk;
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(hx, CHART_PAD); g.lineTo(hx, c.h - CHART_PAD); g.stroke();
      g.setLineDash([]);
      g.fillStyle = c.ink;
      g.beginPath(); g.arc(hx, hy, 3.2, 0, Math.PI * 2); g.fill();
    }
  }

  /* 单帧调度：同一实例同时最多一个待绘制帧，避免刷新连点时堆帧。 */
  function scheduleChart(c) {
    if (c.raf) return;
    if (!window.requestAnimationFrame) { drawChart(c); return; }
    c.raf = window.requestAnimationFrame(function () { drawChart(c); });
  }

  /* 时间戳 → HH:MM:SS；非数字回退空串，避免面板出现 "NaN"。 */
  function clockText(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    function p2(v) { return v < 10 ? '0' + v : String(v); }
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }

  /* 指针 x → 最近数据点下标（按绘制区映射，边界夹取）。 */
  function indexAt(c, clientX) {
    var n = c.ys.length;
    if (!n) return -1;
    var rect = c.canvas.getBoundingClientRect();
    var plot = Math.max(1, c.w - 2 * CHART_PAD);
    var t = (clientX - rect.left - CHART_PAD) / plot;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return Math.round(t * (n - 1));
  }

  /* 显示读数面板：时间 + 系列名 + 数值 + 单位（单位来自 SERIES，如 %）。 */
  function showTipAt(c, idx, clientX) {
    if (!c.tip || idx < 0 || idx >= c.ys.length) return;
    c.hover = idx;
    var v = c.ys[idx];
    c.tipTime.textContent = clockText(c.xs[idx]);
    c.tipVal.textContent = v.toFixed(1) + (c.series.unit || '');
    c.tip.hidden = false;
    var plot = Math.max(10, c.h - 2 * CHART_PAD);
    var py = c.h - CHART_PAD - plot * Math.max(0, Math.min(c.max, v)) / c.max;
    var bw = c.box.clientWidth || c.w, tw = c.tip.offsetWidth || 96, th = c.tip.offsetHeight || 34;
    var x = clientX - c.canvas.getBoundingClientRect().left;
    var left = x + 14;
    if (left + tw > bw) left = Math.max(0, x - tw - 14);
    c.tip.style.left = Math.round(left) + 'px';
    c.tip.style.top = Math.round(Math.max(0, Math.min(c.h - th, py - th - 8))) + 'px';
    scheduleChart(c);
  }

  function hideTip(c) {
    c.pinned = false;
    c.hover = null;
    if (c.tip) c.tip.hidden = true;
    scheduleChart(c);
  }

  /* pointermove = 鼠标悬停；pointerdown = 手机 tap（tap 后钉住，点别处才收起）。 */
  function tipMove(c, ev, pin) {
    if (!c.ys.length) return;
    if (pin) c.pinned = true;
    showTipAt(c, indexAt(c, ev.clientX), ev.clientX);
  }

  /* 点在图表外 → 收起所有钉住的面板（每实例不各绑一份，模块级唯一监听）。 */
  function onOutsidePointer(ev) {
    for (var i = 0; i < charts.length; i++) {
      if (charts[i].canvas !== ev.target && charts[i].pinned) hideTip(charts[i]);
    }
  }

  function bindTip(c) {
    if (!c.tip || !c.canvas) return;
    c.canvas.addEventListener('pointermove', function (ev) { tipMove(c, ev, false); });
    c.canvas.addEventListener('pointerdown', function (ev) { tipMove(c, ev, true); });
    c.canvas.addEventListener('pointerleave', function () { if (!c.pinned) hideTip(c); });
    c.canvas.addEventListener('pointercancel', function () { if (!c.pinned) hideTip(c); });
    c.canvas.addEventListener('blur', function () { hideTip(c); });
    c.canvas.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      var n = c.ys.length;
      if (!n) return;
      ev.preventDefault();
      var idx = c.hover === null ? n - 1 : c.hover + (ev.key === 'ArrowRight' ? 1 : -1);
      idx = Math.max(0, Math.min(n - 1, idx));
      c.pinned = true;
      var rect = c.canvas.getBoundingClientRect();
      var plot = Math.max(1, c.w - 2 * CHART_PAD);
      showTipAt(c, idx, rect.left + CHART_PAD + plot * idx / Math.max(1, n - 1));
    });
    if (!tipOutsideBound) {
      document.addEventListener('pointerdown', onOutsidePointer, true);
      tipOutsideBound = true;
    }
  }

  /* 读数三条通道：图注文本、aria-label 摘要、hover/tap 读数面板（缺一不可，G-32 §13-11）。 */
  function chartSummary(c, latest, intervalS) {
    var n = c.ys.length, lo = null, hi = null, i;
    for (i = 0; i < n; i++) {
      if (lo === null || c.ys[i] < lo) lo = c.ys[i];
      if (hi === null || c.ys[i] > hi) hi = c.ys[i];
    }
    var span = lo === null ? '暂无数据'
      : lo.toFixed(1) + c.series.unit + ' ~ ' + hi.toFixed(1) + c.series.unit;
    return c.series.label + ' 历史曲线：' + n + ' 个点，区间 ' + span + '，最近 ' +
      (latest === null ? '—' : latest.toFixed(1) + c.series.unit) +
      (num(intervalS) === null ? '' : '，采样间隔 ' + intervalS + ' 秒') +
      '；悬停或点按曲线可读出该点时间与数值';
  }

  /* 刷新路径：只换数据 + 更新图注/aria，然后一帧内重绘数据层；不重建 canvas/DOM。 */
  function setChartData(c, ts, values, cores, intervalS) {
    if (!c.w) layoutChart(c);
    var n = Math.min(ts.length, values.length);
    var start = Math.max(0, n - MAX_POINTS);
    var xs = [], ys = [], i, v;
    for (i = start; i < n; i++) {
      v = num(values[i]);
      if (v === null) continue;
      xs.push(num(ts[i]) === null ? i : num(ts[i]));
      ys.push(v);
    }
    c.xs = xs; c.ys = ys;
    var latest = ys.length ? ys[ys.length - 1] : null;
    c.ref = c.series.thr === 'cores' ? (num(cores) || null) : THRESHOLDS[c.series.thr];
    c.max = c.series.pct ? 100
      : Math.max(1, (num(cores) || 1) * 1.5, latest === null ? 0 : latest * 1.2);
    c.valEl.textContent = latest === null ? '—' : latest.toFixed(1) + c.series.unit;
    c.noteEl.textContent = c.ref === null ? ''
      : (c.series.pct ? '阈值 ' + c.ref + '%' : '阈值 ' + c.ref + '（' + cores + ' 核）');
    c.canvas.setAttribute('aria-label', chartSummary(c, latest, intervalS));
    if (c.hover !== null && c.hover >= c.ys.length) {
      hideTip(c);
    } else if (c.hover !== null && c.tip && !c.tip.hidden) {
      /* 刷新时面板留在同一指针位置，只更新读数，不跳位。 */
      c.tipTime.textContent = clockText(c.xs[c.hover]);
      c.tipVal.textContent = c.ys[c.hover].toFixed(1) + (c.series.unit || '');
    }
    scheduleChart(c);
  }

  function makeChart(host, series) {
    var wrap = add(host, el('div', 'mon-mini'));
    var head = add(wrap, el('div', 'mon-mini-head'));
    add(head, el('span', null, series.label));
    var noteEl = add(head, el('span', 'muted'));
    var valEl = add(head, el('span', 'mon-mini-val', '—'));
    var box = add(wrap, el('div', 'mon-chart-box'));
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', series.label + ' 历史曲线');
    var canvas = add(box, el('canvas', 'mon-chart'));
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', series.label + ' 历史曲线：等待数据');
    /* 读数面板：时间 + 该点数值（带单位）。appended 在 canvas 之后，不参与画布尺寸。 */
    var tip = add(box, el('div', 'mon-tip'));
    tip.hidden = true;
    var tipTime = add(tip, el('div', 'mon-tip-time'));
    var tipRow = add(tip, el('div', 'mon-tip-row'));
    var tipDot = add(tipRow, el('i', 'mon-tip-dot'));
    tipDot.style.background = 'var(' + series.ink + ')';
    add(tipRow, el('span', 'muted', series.label));
    var tipVal = add(tipRow, el('span', 'mon-tip-val', '—'));
    var inst = { series: series, wrap: wrap, box: box, canvas: canvas,
      ctx: canvas.getContext('2d'), grid: null, w: 0, h: 0, dpr: 0,
      ink: '', gridInk: '', refInk: '', crossInk: '', xs: [], ys: [], max: 1, ref: null,
      raf: 0, noteEl: noteEl, valEl: valEl,
      hover: null, pinned: false, tip: tip, tipTime: tipTime, tipVal: tipVal };
    bindTip(inst);
    charts.push(inst);
    return inst;
  }

  function buildCharts(host) {
    charts.length = 0;
    bindResize();
    SERIES.forEach(function (series) { makeChart(host, series); });
  }

  function updateCharts(history, cores) {
    var ts = Array.isArray(history.timestamps) ? history.timestamps : [];
    charts.forEach(function (c) {
      var values = Array.isArray(history[c.series.key]) ? history[c.series.key] : [];
      setChartData(c, ts, values, cores, history.interval_s);
    });
  }

  function legendText(history) {
    var n = Array.isArray(history.timestamps) ? history.timestamps.length : 0;
    var iv = num(history.interval_s);
    return '共 ' + n + ' 点 · 间隔 ' + (iv === null ? '—' : iv) + 's · 单序列上限 ' +
      MAX_POINTS + ' 点（后端预聚合待办）· 悬停/点按读数 · 无动画';
  }

  /* 视图切走 / 卸载：取消待绘制帧 + 清引用 + 解绑唯一 resize 监听。幂等。 */
  function disposeCharts() {
    charts.forEach(function (c) {
      if (c.raf) {
        if (window.cancelAnimationFrame) window.cancelAnimationFrame(c.raf);
        c.raf = 0;
      }
      c.ctx = null;
      c.grid = null;
      c.xs = [];
      c.ys = [];
      c.hover = null;
      c.pinned = false;
      if (c.tip) c.tip.hidden = true;
      if (c.canvas) { c.canvas.width = 0; c.canvas.height = 0; }
    });
    charts.length = 0;
    if (tipOutsideBound) {
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      tipOutsideBound = false;
    }
    chartPanelEl = null;
    legendTextEl = null;
    unbindResize();
  }

  /* resize：模块内唯一监听 + 100ms 防抖；实例清零时解绑（切视图不残留监听）。 */
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = 0;
      charts.forEach(layoutChart);
    }, RESIZE_DEBOUNCE_MS);
  }
  function bindResize() {
    if (resizeBound) return;
    resizeBound = true;
    window.addEventListener('resize', onResize);
  }
  function unbindResize() {
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = 0; }
    if (!resizeBound) return;
    resizeBound = false;
    window.removeEventListener('resize', onResize);
  }

  function chartPanel(d) {
    var history = d.history || {};
    var ts = Array.isArray(history.timestamps) ? history.timestamps : [];
    if (ts.length < 2) {
      /* 空态 / 1 点态：保留原本文案语义，不建 canvas、不白屏。 */
      disposeCharts();
      var p0 = S.C.panel('历史曲线', null, 'mon-chart-body');
      var lack = 2 - ts.length;
      add(p0.body, el('p', 'mon-empty-note',
        '正在积累数据（还差 ' + lack + ' 个采样；默认 60s 一个点，点「刷新」后更新）'));
      return p0;
    }
    if (!chartPanelEl) {
      chartPanelEl = S.C.panel('历史曲线', null, 'mon-chart-body');
      buildCharts(chartPanelEl.body);
      var legend = add(chartPanelEl.body, el('div', 'mon-legend'));
      SERIES.forEach(function (s) {
        var item = add(legend, el('span'));
        add(item, el('i', s.swatch));
        add(item, el('span', null, s.label));
      });
      legendTextEl = add(legend, el('span', 'mon-legend-note'));
    }
    return chartPanelEl;
  }

  /* 数据灌入（面板已挂载后调用）：只更新数据 + 图注 + aria，一帧内重绘数据层。 */
  function paintCharts(d) {
    if (!charts.length) return;
    var history = d.history || {};
    updateCharts(history, d.cpu && d.cpu.cores);
    if (legendTextEl) legendTextEl.textContent = legendText(history);
  }

  /* 阈值告警：alerts 由后端按本次 thresholds 计算；级别色 + 人话 + 怎么办。 */
  function alertPanel(d) {
    var alerts = Array.isArray(d.alerts) ? d.alerts : [];
    var p = S.C.panel('阈值告警', null, 'mon-alert-body');
    if (!alerts.length) {
      var ok = add(p.body, el('div', 'mon-alert-head'));
      add(ok, S.C.chip('ok', '全部正常'));
      add(ok, el('span', 'muted', 'CPU / 内存 / 磁盘均低于 ' + THRESHOLDS.cpu_percent + '% / ' +
        THRESHOLDS.memory_percent + '% / ' + THRESHOLDS.disk_percent + '%；超过阈值时这里会出现告警与处理建议'));
      return p;
    }
    alerts.forEach(function (a) {
      var critical = a.level === 'critical';
      var row = el('div', 'mon-alert' + (critical ? ' mon-alert-critical' : ''));
      var head = add(row, el('div', 'mon-alert-head'));
      add(head, S.C.chip(critical ? 'fail' : 'warn',
        (critical ? '严重' : '警告') + ' · ' + (METRIC_LABEL[a.metric] || a.metric || '指标')));
      add(head, el('span', 'mon-alert-val',
        (num(a.current) === null ? '—' : a.current.toFixed(1)) + '% / 阈值 ' +
        (num(a.threshold) === null ? '—' : a.threshold) + '%'));
      add(row, el('p', 'mon-alert-hint', a.hint ? '怎么办：' + a.hint : '超过阈值，请检查对应资源占用'));
      add(p.body, row);
    });
    return p;
  }

  /* ---------- 插件数据：全部卡片 + 磁盘/网络/温度/进程 ---------- */
  function paintPlugin(d) {
    var C = S.C;
    S.cards.textContent = '';
    C.systemCards(d || {}).forEach(function (node) { S.cards.appendChild(node); });

    S.panels.textContent = '';
    S.panels.appendChild(alertPanel(d || {}));
    /* 先挂载再灌数据：canvas 必须在已连接状态下量一次尺寸，之后刷新不再测量。 */
    S.panels.appendChild(chartPanel(d || {}));
    paintCharts(d || {});
    S.panels.appendChild(C.diskPanel(d || {}));
    S.panels.appendChild(C.netPanel(d || {}));
    var temp = C.panel('温度', null, 'mon-temp');
    S.panels.appendChild(temp);

    var procHead = el('div', 'mon-proc-head');
    S.sortCpu = on(el('button', 'btn mon-sort', '按 CPU'), function () { setSort('cpu'); });
    S.sortMem = on(el('button', 'btn mon-sort', '按内存'), function () { setSort('mem'); });
    add(procHead, S.sortCpu); add(procHead, S.sortMem);
    var procPanel = C.panel('进程 Top10', procHead, 'mon-proc-body');
    S.panels.appendChild(procPanel);
    S.procBody = procPanel.body;
    paintSort();

    S.procs = null; S.procErr = '';
    C.procTable(S.procBody, S.procs, S.procErr, { allHref: '#/process' });
    loadTemperature(temp.body);
    C.warnings(S.warn, Array.isArray(d.warnings) ? d.warnings : []);
  }

  /* ---------- 内核降级数据：只用 /api/v1/system/metrics 字段 ---------- */
  function paintKernel(m) {
    var C = S.C;
    S.cards.textContent = '';
    C.kernelCards(m || {}).forEach(function (node) { S.cards.appendChild(node); });
    S.panels.textContent = '';
    /* 降级态没有 history：销毁图表实例，别让隐藏 canvas 计入活动实例数。 */
    disposeCharts();
    var p = C.panel('插件详情不可用', null, 'mon-temp');
    add(p.body, el('span', 'muted', '磁盘明细、网络收发、温度与进程 Top10 由 monitor 插件提供；安装后在软件商店启用再刷新本页。'));
    S.panels.appendChild(p);
    C.warnings(S.warn, []);
  }

  /* ---------- 加载流程 ---------- */
  function finish(gen) {
    if (stale(gen)) return;
    setBusy(false); stamp();
  }

  function failBoth(gen, message) {
    if (stale(gen)) return;
    S.cards.textContent = ''; S.panels.textContent = '';
    disposeCharts();
    var wrap = el('div', 'panel'), msg = add(wrap, el('p', 'panel-empty', message));
    msg.style.lineHeight = '1.7';
    add(S.panels, wrap);
    add(S.panels, el('p', 'panel-empty', '点右上角「刷新」重试；若会话过期请重新登录。'));
    notice([el('span', null, '监控数据读取失败')], true);
    setBusy(false);
  }

  function loadKernel(gen, pluginErr) {
    getJSON(METRICS).then(function (res) {
      if (stale(gen)) return;
      if (res.status === 401) { failBoth(gen, '会话已过期，请重新登录后刷新页面'); return; }
      if (!res.ok || !res.data) {
        failBoth(gen, '监控数据读取失败：' +
          (res.data && res.data.message ? res.data.message : 'HTTP ' + res.status));
        return;
      }
      S.mode = 'kernel';
      setSource();
      notice([
        el('span', 'mon-degraded', FALLBACK_NOTE),
        el('span', null, '降级原因：' + (pluginErr && pluginErr.message ? pluginErr.message : 'monitor 插件不可用'))
      ]);
      paintKernel(res.data);
      finish(gen);
    }, function () { failBoth(gen, '监控数据读取失败：接口不可达'); });
  }

  function loadAll() {
    if (!S.box) return;
    var gen = ++S.gen;
    setBusy(true);
    ensureCards().then(function () {
      if (stale(gen)) return;
      // 先试插件：成功即全量渲染；任何失败（未安装 / E_* / 超时 / 网络）都走内核降级。
      invoke('system', { per_cpu: false, thresholds: THRESHOLDS }).then(function (d) {
        if (stale(gen)) return;
        S.mode = 'plugin';
        setSource(); notice([]);
        paintPlugin(d || {});
        finish(gen);
        loadProcs();
      }, function (err) {
        if (stale(gen)) return;
        if (err && err.status === 401) { failBoth(gen, '会话已过期，请重新登录后刷新页面'); return; }
        loadKernel(gen, err);
      });
    }, function (err) {
      if (stale(gen)) return;
      failBoth(gen, '监控组件加载失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  /* 视图卸载：先停图表（cancelAnimationFrame + 清引用 + 解绑 resize），再放弃容器。 */
  function teardown() {
    S.gen++;
    disposeCharts();
    S.box = null; S.procs = null; S.procErr = '';
    S.refresh = null; S.tsEl = null; S.notice = null; S.cards = null; S.panels = null;
    S.warn = null; S.procBody = null; S.sortCpu = null; S.sortMem = null; S.src = null;
    S.C = null; S.cardsReady = null; S.mode = '';
  }

  function render(container) {
    if (!container || typeof container.appendChild !== 'function') return null;
    ensureStyle();
    teardown();
    S.box = container;
    container.classList.add('kore-monitor');
    container.textContent = '';

    var head = add(container, el('div', 'mon-head'));
    add(head, el('h2', 'mon-h2', '系统监控'));
    S.src = add(head, el('span', 'mon-src'));
    S.tsEl = add(head, el('span', 'mon-ts', '尚未刷新'));
    S.tsEl.setAttribute('aria-live', 'polite');
    S.refresh = add(head, el('button', 'btn', '刷新'));
    S.refresh.type = 'button';
    on(S.refresh, loadAll);

    S.notice = add(container, el('div', 'mon-notice'));
    S.cards = add(container, el('div', 'monitor-grid'));
    S.panels = add(container, el('div', 'mon-panels'));
    S.warn = add(container, el('div', 'monitor-mode'));

    loadAll();
    return { destroy: teardown };
  }

  window.KoreMonitor = {
    render: render,
    destroy: teardown,
    endpoints: { invoke: API, metrics: METRICS, cards: CARDS_URL },
    fallbackNote: FALLBACK_NOTE
  };

  /* 验收断言入口（G-32 / FRONTEND §13）：切走视图后 count() 必须为 0；
     连续刷新不增长（实例只在首次渲染时创建，刷新复用同一批 canvas）。
     dispose() 供冒烟脚本主动清场，正常路径由 teardown() 调用。 */
  window.__koreMonitorChart = {
    count: function () { return charts.length; },
    dispose: function () { disposeCharts(); }
  };
})();
