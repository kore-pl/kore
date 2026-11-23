/* kore 主壳 · 监控视图（web/monitor.js）——零框架 / 零 CDN / 零外链 / 零定时器。
   数据源优先级：monitor 插件（真实读 /proc 与 /sys）→ 内核 /api/v1/system/metrics 降级。
   插件未安装或调用失败时**不报错、不白屏**：降级渲染内核基础指标并在顶部标一条灰字提示。
   调用形态：POST /api/v1/invoke/monitor/monitor.<method>（方法段写完整限定名）。
   刷新：仅手动「刷新」按钮（G-19 禁止轮询/定时器；本文件不含 setInterval / setTimeout）。
   渲染构件在 web/monitor-cards.js，进入本视图时才注入，不进首屏。
   window.KoreMonitor.render(container) → {destroy}。 */
(function () {
  'use strict';

  var API = '/api/v1/invoke/monitor/monitor.';
  var METRICS = '/api/v1/system/metrics';
  var CARDS_URL = '/assets/monitor-cards.js';
  var STYLE_ID = 'kore-mon-style';
  var FALLBACK_NOTE = '当前使用内核基础指标，安装 monitor 插件可获得磁盘/网络/温度详情';
  /* monitor 0.3.0：system 返回 history（列式数组）与 alerts；阈值随调用传入（0 关闭）。 */
  var THRESHOLDS = { cpu_percent: 90, memory_percent: 90, disk_percent: 90 };
  /* 三条迷你折线：CPU / 内存 / 负载（负载不是百分比，按核数换算参照线）。 */
  var SERIES = [
    { key: 'cpu_percent', label: 'CPU', unit: '%', cls: 'mon-line-cpu', pct: true },
    { key: 'memory_percent', label: '内存', unit: '%', cls: 'mon-line-mem', pct: true },
    { key: 'load1', label: '负载', unit: '', cls: 'mon-line-load', pct: false }
  ];
  var METRIC_LABEL = { cpu: 'CPU', memory: '内存', disk: '磁盘' };
  var S = { box: null, gen: 0, mode: '', sort: 'cpu', C: null, cardsReady: null,
    procs: null, procErr: '', refresh: null, src: null, tsEl: null, notice: null,
    cards: null, panels: null, warn: null, procBody: null, sortCpu: null, sortMem: null };

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
    '.mon-chart{display:block;width:100%;height:132px}',
    '.mon-mini{padding:10px 16px 4px}',
    '.mon-mini-head{display:flex;align-items:baseline;gap:8px;font-size:13px;color:var(--kore-text-2)}',
    '.mon-mini-val{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--kore-text-1)}',
    '.mon-line-load{stroke:var(--kore-text-3)}',
    '.mon-threshold{stroke:var(--kore-danger);stroke-width:1;stroke-dasharray:4 3;opacity:.7}',
    '.mon-all{display:inline-block;min-height:44px;line-height:44px;padding:0 4px;color:var(--kore-info)}',
    '.mon-lock{margin-left:4px;font-size:11px;color:var(--kore-text-3)}',
    '.mon-empty-note{padding:12px 16px;color:var(--kore-text-3)}',
    '@media (max-width:640px){.mon-chart{height:96px}.mon-mini{padding:8px 12px 2px}}',
    '.mon-chart .mon-grid{stroke:var(--kore-border-2);stroke-width:1}',
    '.mon-chart .mon-line{fill:none;stroke-width:2;vector-effect:non-scaling-stroke}',
    '.mon-line-cpu{stroke:var(--kore-info)}',
    '.mon-line-mem{stroke:var(--kore-success)}',
    '.mon-line-disk{stroke:var(--kore-warning)}',
    '.mon-legend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:12px;color:var(--kore-text-2);padding-top:8px}',
    '.mon-legend i{display:inline-block;width:10px;height:3px;margin-right:6px;vertical-align:middle;border-radius:2px}',
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

  function svgEl(tag, cls) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (cls) n.setAttribute('class', cls);
    return n;
  }

  /* 历史曲线：monitor.system.history 是列式数组（timestamps + cpu_percent/memory_percent/load1），
     三条迷你 SVG 折线自研绘制，不引任何第三方图表库；悬停用 SVG <title> 显示该点数值与时间。 */
  function fmtPointTime(ms) {
    var d = new Date(num(ms) === null ? Date.now() : ms);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }
  function chartInto(host, history, cores) {
    var ts = history && Array.isArray(history.timestamps) ? history.timestamps : [];
    if (ts.length < 2) {
      var lack = 2 - ts.length;
      add(host, el('p', 'mon-empty-note', '正在积累数据（还差 ' + lack + ' 个采样；默认 60s 一个点，点「刷新」后更新）'));
      return;
    }
    SERIES.forEach(function (series) {
      var values = Array.isArray(history[series.key]) ? history[series.key] : [];
      if (!values.length) return;
      var latest = num(values[values.length - 1]);
      var max = series.pct ? 100 : Math.max(1, (num(cores) || 1) * 1.5, latest !== null ? latest * 1.2 : 0);
      var ref = series.pct ? THRESHOLDS.cpu_percent : (num(cores) || null);
      var wrap = add(host, el('div', 'mon-mini'));
      var head = add(wrap, el('div', 'mon-mini-head'));
      add(head, el('span', null, series.label));
      var refText = ref === null ? '' : (series.pct ? '阈值 ' + ref + '%' : '阈值 ' + ref + '（' + cores + ' 核）');
      if (refText) add(head, el('span', 'muted', refText));
      add(head, el('span', 'mon-mini-val', (latest === null ? '—' : latest.toFixed(1)) + series.unit));

      var W = 640, H = 132, PAD = 22, PLOT = H - 2 * PAD;
      var svg = svgEl('svg', 'mon-chart');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', series.label + ' 历史曲线，最近 ' + ts.length + ' 个采样点');
      [0, 0.5, 1].forEach(function (frac) {
        var y = H - PAD - PLOT * frac, line = svgEl('line', 'mon-grid');
        line.setAttribute('x1', PAD); line.setAttribute('x2', W - PAD);
        line.setAttribute('y1', y.toFixed(1)); line.setAttribute('y2', y.toFixed(1));
        svg.appendChild(line);
      });
      if (ref !== null) {
        var ty = H - PAD - PLOT * Math.min(1, ref / max), tl = svgEl('line', 'mon-threshold');
        tl.setAttribute('x1', PAD); tl.setAttribute('x2', W - PAD);
        tl.setAttribute('y1', ty.toFixed(1)); tl.setAttribute('y2', ty.toFixed(1));
        svg.appendChild(tl);
      }
      var pts = [], i, v;
      for (i = 0; i < values.length && i < ts.length; i++) {
        v = num(values[i]);
        if (v === null) continue;
        var x = PAD + (W - 2 * PAD) * i / Math.max(1, values.length - 1);
        var y2 = H - PAD - PLOT * Math.max(0, Math.min(max, v)) / max;
        pts.push(x.toFixed(1) + ',' + y2.toFixed(1));
        var hit = svgEl('circle', 'mon-hit');
        hit.setAttribute('cx', x.toFixed(1)); hit.setAttribute('cy', y2.toFixed(1));
        hit.setAttribute('r', '8'); hit.setAttribute('fill', 'transparent'); hit.setAttribute('pointer-events', 'all');
        var title = svgEl('title');
        title.textContent = fmtPointTime(ts[i]) + ' · ' + v.toFixed(1) + series.unit;
        hit.appendChild(title); svg.appendChild(hit);
      }
      if (pts.length >= 2) {
        var poly = svgEl('polyline', 'mon-line ' + series.cls);
        poly.setAttribute('points', pts.join(' '));
        svg.appendChild(poly);
      }
      add(wrap, svg);
    });
    var legend = add(host, el('div', 'mon-legend'));
    add(legend, el('span', null, '共 ' + ts.length + ' 点 · 间隔 ' +
      (num(history.interval_s) === null ? '—' : history.interval_s) + 's · 悬停折线查看数值与时间'));
  }

  function chartPanel(d) {
    var p = S.C.panel('历史曲线', null, 'mon-chart-body');
    chartInto(p.body, d.history || {}, d.cpu && d.cpu.cores);
    return p;
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
    S.panels.appendChild(chartPanel(d || {}));
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

  function render(container) {
    if (!container || typeof container.appendChild !== 'function') return null;
    ensureStyle();
    S.gen++;
    S.box = container; S.mode = ''; S.procs = null; S.procErr = '';
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
    return { destroy: function () { S.gen++; S.box = null; S.procs = null; } };
  }

  window.KoreMonitor = {
    render: render,
    destroy: function () { S.gen++; S.box = null; S.procs = null; },
    endpoints: { invoke: API, metrics: METRICS, cards: CARDS_URL },
    fallbackNote: FALLBACK_NOTE
  };
})();
