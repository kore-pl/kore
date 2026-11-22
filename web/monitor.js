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
    '.mon-proc-meta{padding:8px 12px;border-top:1px solid var(--kore-border-2);font-size:12px;color:var(--kore-text-3)}'
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
    S.C.procTable(S.procBody, S.procs, S.procErr);
    invoke('processes', { limit: 10, sort: S.sort }).then(function (d) {
      if (stale(gen) || S.mode !== 'plugin') return;
      S.procs = d || {};
      S.C.procTable(S.procBody, S.procs, '');
    }, function (err) {
      if (stale(gen) || S.mode !== 'plugin') return;
      S.procs = null; S.procErr = err.message || '未知错误';
      S.C.procTable(S.procBody, S.procs, S.procErr);
    });
  }

  /* ---------- 插件数据：全部卡片 + 磁盘/网络/温度/进程 ---------- */
  function paintPlugin(d) {
    var C = S.C;
    S.cards.textContent = '';
    C.systemCards(d || {}).forEach(function (node) { S.cards.appendChild(node); });

    S.panels.textContent = '';
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
    C.procTable(S.procBody, S.procs, S.procErr);
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
      invoke('system', { per_cpu: false }).then(function (d) {
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
