/* kore 主壳 · 监控视图（零框架 / 零图表库 / 零 CDN / 零外链）
   入口 window.KoreMonitor.render(container)，不改 app.js / shell.js。数据纪律：不伪造监控数据。
   已支持：系统信息（版本 / 常驻 / 重启 / 平台 / cgroup / 告警）与插件列表。
   资源指标：轮询系统指标接口，字段就绪即自动展示；未就绪时卡片显示「未采集 / 等待采样…」。
   技术原因只在本页底部一个可折叠「技术说明」里讲一次，不再逐卡重复接口契约。
   轮询：页面内 setInterval 5s，非内核轮询；pagehide / beforeunload / 容器失联 / 401 均 clearInterval。 */
(function () {
  'use strict';

  var POLL_MS = 5000, SERIES_MAX = 60;
  var API_INFO = '/api/v1/system/info', API_PLUGINS = '/api/v1/plugins';
  var API_METRICS = '/api/v1/system/metrics';
  var RSS_RED_KIB = 16 * 1024, RSS_GOAL_KIB = 8 * 1024;  // 红线 16 / 目标 8 MiB
  var RESIDENT_MAX = 3;                                   // 同时常驻硬上限（推荐 ≤2）
  var PRIV_CAPS = ['system:', 'net:', 'proc:'];
  var S = { timer: null, box: null, resident: [], plugins: [], cpu: [], rss: [], disk: [], load: [],
    list: null, sig: null, ts: '' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function push(a, v) { a.push(v); if (a.length > SERIES_MAX) a.shift(); }

  /* sparkline：数值数组 → SVG 字符串。无数据画虚线基线，绝不画假折线。 */
  function sparkline(points, w, h, color, opts) {
    opts = opts || {};
    var pad = 2, iw = Math.max(1, w - pad * 2), ih = Math.max(1, h - pad * 2), i, vals = [], v;
    for (i = 0; i < (points || []).length; i++) { v = num(points[i]); if (v !== null) vals.push(v); }
    var lo = opts.min, hi = opts.max;
    if (lo === undefined || lo === null) lo = vals.length ? Math.min.apply(null, vals) : 0;
    if (hi === undefined || hi === null) hi = vals.length ? Math.max.apply(null, vals) : 1;
    if (hi - lo < 1e-9) hi = lo + 1;
    function y(val) { return (h - pad - ((val - lo) / (hi - lo)) * ih).toFixed(2); }
    var head = '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">', body = '';
    if (opts.threshold !== undefined && opts.threshold !== null) {
      var over = vals.length > 0 && vals[vals.length - 1] >= opts.threshold, ty = y(opts.threshold);
      body += '<line x1="' + pad + '" y1="' + ty + '" x2="' + (w - pad) + '" y2="' + ty +
        '" stroke="var(--kore-' + (over ? 'danger' : 'warning') + ')" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>';
    }
    var baseY = (h / 2).toFixed(2);
    if (!vals.length) return head + body + '<line x1="' + pad + '" y1="' + baseY + '" x2="' + (w - pad) + '" y2="' + baseY +
      '" stroke="var(--kore-border-1)" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/></svg>';
    var pts = [];
    for (i = 0; i < vals.length; i++) {
      var x = vals.length === 1 ? w - pad : pad + (i * iw) / (vals.length - 1);
      pts.push(x.toFixed(2) + ',' + y(vals[i]));
    }
    return head + body + '<polyline fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" ' +
      'stroke-linecap="round" vector-effect="non-scaling-stroke" points="' + pts.join(' ') + '"/></svg>';
  }

  /* 预算占用条：< 目标绿 / 目标~红线黄 / ≥ 红线红；无数据不填充。 */
  function budgetBar(usedKib, redKib, goalKib) {
    var wrap = el('div', 'budget'), track = el('div', 'budget-track');
    var fill = el('div', 'budget-fill'), goal = el('div', 'budget-goal'), used = num(usedKib), legend;
    goal.style.left = Math.min(100, (goalKib / redKib) * 100) + '%';
    if (used === null) {
      track.classList.add('budget-track-na');
      legend = '未采样 · 目标 ' + goalKib / 1024 + ' MiB / 红线 ' + redKib / 1024 + ' MiB';
    } else {
      fill.style.width = Math.min(100, Math.max(0, (used / redKib) * 100)).toFixed(1) + '%';
      fill.classList.add(used >= redKib ? 'budget-fill-red' : used >= goalKib ? 'budget-fill-warn' : 'budget-fill-ok');
      legend = (used / 1024).toFixed(1) + ' MiB 已用 · 目标 ' + goalKib / 1024 + ' / 红线 ' + redKib / 1024 + ' MiB';
    }
    track.appendChild(fill); track.appendChild(goal); wrap.appendChild(track);
    wrap.appendChild(el('div', 'budget-legend muted', legend)); return wrap;
  }

  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    if (tone === 'ok' || tone === 'warn' || tone === 'fail') dot.classList.add(tone);
    c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }

  /* 卡片：idle 时只留标题 + 值 + 一句等待提示，不画空折线、不占半屏。 */
  function card(s) {
    var box = el('article', 'monitor-card' + (s.idle ? ' is-idle' : '')), head = el('div', 'monitor-head');
    var val = el('div', 'monitor-value'), sw = el('div', 'spark-wrap');

    head.appendChild(el('span', 'monitor-title', s.title)); head.appendChild(chip(s.tone, s.toneText));
    box.appendChild(head);
    val.appendChild(el('span', 'monitor-num', s.value));
    if (s.unit) val.appendChild(el('span', 'monitor-unit', s.unit));
    box.appendChild(val);
    if (!s.idle) {
      sw.innerHTML = sparkline(s.series, 100, 32, s.color || 'var(--kore-info)', { min: s.min, max: s.max, threshold: s.threshold });
      box.appendChild(sw);
      if (s.extra) box.appendChild(s.extra);
    }
    if (s.note) box.appendChild(el('p', 'monitor-note', s.note));
    return box;
  }

  function stateTone(st) { return st === 'ready' ? 'ok' : st === 'starting' ? 'warn' : st === 'failed' ? 'fail' : 'na'; }
  function pctTone(v) { return v === null ? 'na' : v >= 90 ? 'fail' : v >= 80 ? 'warn' : 'ok'; }
  function pctText(v) { return v === null ? '未采集' : v >= 90 ? '偏高' : v >= 80 ? '注意' : '实时'; }
  function rssTone(v) { return v === null ? 'na' : v >= RSS_RED_KIB ? 'fail' : v >= RSS_GOAL_KIB ? 'warn' : 'ok'; }
  function rssText(v) { return v === null ? '未采集' : v >= RSS_RED_KIB ? '超红线' : v >= RSS_GOAL_KIB ? '超目标' : '正常'; }
  function loadTone(v) { return v === null ? 'na' : v >= 2 ? 'warn' : 'ok'; }
  function loadText(v) { return v === null ? '未采集' : v >= 2 ? '偏高' : '实时'; }

  function getJSON(url) {
    var opt = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
    return fetch(url, opt).then(function (res) {
      return res.json().then(
        function (b) { return { ok: res.ok, status: res.status, data: b }; },
        function () { return { ok: res.ok, status: res.status, data: null }; });
    });
  }

  function renderTable(list) {
    var host = S.box && S.box.querySelector('.monitor-table-host');
    if (!host) return;
    host.textContent = '';
    if (!list.length) { host.appendChild(el('p', 'panel-empty', '暂无已安装插件，去软件商店安装。')); return; }
    var t = el('table', 'monitor-table'), heads = ['插件 id', '生命周期', '状态', '授权能力'];
    var thead = el('thead'), htr = el('tr'), tb = el('tbody'), i, h;
    for (h = 0; h < heads.length; h++) htr.appendChild(el('th', null, heads[h]));
    thead.appendChild(htr); t.appendChild(thead);
    for (i = 0; i < list.length; i++) {
      var p = list[i], tr = el('tr'), c, caps = p.granted_capabilities || [];
      var td1 = el('td'), td2 = el('td'), td3 = el('td'), td4 = el('td'); td1.setAttribute('data-label', '插件 id');
      td1.appendChild(el('div', 'monitor-plugin-id', p.id || '—'));
      td1.appendChild(el('div', 'monitor-plugin-meta muted',
        [p.version, p.pid ? 'pid ' + p.pid : 'pid —', '重启 ' + (num(p.restarts) || 0)].join(' · ')));
      tr.appendChild(td1);
      td2.setAttribute('data-label', '生命周期');
      td2.appendChild(el('span', 'mono', p.lifecycle || '—')); tr.appendChild(td2);
      td3.setAttribute('data-label', '状态');
      td3.appendChild(chip(stateTone(p.state), p.state || '—')); tr.appendChild(td3);
      td4.setAttribute('data-label', '授权能力');
      if (!caps.length) td4.appendChild(el('span', 'muted', '—（未授予）'));
      for (c = 0; c < caps.length; c++) {
        var cap = caps[c], isPriv = PRIV_CAPS.some(function (pre) { return cap.indexOf(pre) === 0; });
        td4.appendChild(el('code', 'cap' + (isPriv ? ' cap-priv' : ''), cap));
      }
      tr.appendChild(td4); tb.appendChild(tr);
    }
    t.appendChild(tb); host.appendChild(t);
  }

  function setStatus(tone, text) {
    var host = S.box && S.box.querySelector('.monitor-status');
    if (!host) return;
    host.textContent = ''; host.appendChild(chip(tone, text));
    if (S.ts) host.appendChild(el('span', 'muted monitor-ts', '最后刷新 ' + S.ts));
  }

  function paint(info, plugs, metrics) {
    if (info.status === 401) {
      setStatus('fail', '会话已过期，请重新登录后刷新页面');
      stopPolling(); return;
    }
    if (!info.ok || !info.data) {
      setStatus('fail', '系统信息读取失败，保留上次趋势'); return;
    }
    var d = info.data, sup = d.supervisor || {}, resident = num(sup.resident), i;
    var grid = S.box && S.box.querySelector('.monitor-grid'), mode = S.box && S.box.querySelector('.monitor-mode');
    var real = S.box && S.box.querySelector('.monitor-real'); if (!grid) return;
    if (plugs && plugs.ok && plugs.data && Array.isArray(plugs.data.plugins)) S.list = plugs.data.plugins;
    if (resident !== null) push(S.resident, resident);
    if (S.list) push(S.plugins, S.list.length);

    // 指标端点由后端补齐；当前 404/501 时 md 为 null，卡片走「等待采样」而不是报错红屏。
    var md = metrics && metrics.ok && metrics.data ? (metrics.data.metrics || metrics.data) : null;
    var cpu = num(md && md.cpu_pct), rss = num(md && md.rss_kib);
    var used = num(md && md.disk_used_kib), total = num(md && md.disk_total_kib);
    var load = num(md && md.load1), gor = num(md && md.goroutines), fds = num(md && md.fds);
    if (cpu !== null) push(S.cpu, cpu);
    if (rss !== null) push(S.rss, rss);
    if (used !== null) push(S.disk, used);
    if (load !== null) push(S.load, load);

    S.ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setStatus(md ? 'ok' : 'warn', md ? '实时采样 · 每 5 秒自动刷新' : '等待采样 · 每 5 秒自动重试');

    var wait = '等待采样…';
    var resTone = resident === null ? 'na' : resident > RESIDENT_MAX ? 'fail' : resident >= RESIDENT_MAX ? 'warn' : 'ok';
    var resText = resident === null ? '未采集' : resident > RESIDENT_MAX ? '超配额' : resident >= RESIDENT_MAX ? '已用满' : '正常';
    var diskNote = used === null ? wait : (total === null ? '' : '共 ' + (total / 1048576).toFixed(1) + ' GiB');
    var cards = [
      card({ title: 'CPU 使用率', value: cpu === null ? '—' : cpu.toFixed(1), unit: '%',
        tone: pctTone(cpu), toneText: pctText(cpu), series: S.cpu, min: 0, max: 100, threshold: 80, idle: cpu === null,
        note: cpu === null ? wait : '' }),
      card({ title: '内存 VmRSS', value: rss === null ? '—' : (rss / 1024).toFixed(1), unit: 'MiB',
        tone: rssTone(rss), toneText: rssText(rss), series: S.rss, min: 0, max: RSS_RED_KIB, threshold: RSS_RED_KIB,
        extra: budgetBar(rss, RSS_RED_KIB, RSS_GOAL_KIB), idle: rss === null, note: rss === null ? wait : '' }),
      card({ title: '磁盘占用', value: used === null ? '—' : (used / 1048576).toFixed(1), unit: 'GiB',
        tone: used === null ? 'na' : 'ok', toneText: used === null ? '未采集' : '实时',
        series: S.disk, min: 0, idle: used === null, note: diskNote }),
      card({ title: '负载 load1', value: load === null ? '—' : load.toFixed(2),
        tone: loadTone(load), toneText: loadText(load), series: S.load, min: 0, idle: load === null,
        note: load === null ? wait : '' }),
      card({ title: '常驻插件数', value: resident === null ? '—' : String(resident), unit: '/' + RESIDENT_MAX,
        tone: resTone, toneText: resText, series: S.resident, min: 0, max: RESIDENT_MAX + 1, threshold: RESIDENT_MAX,
        note: '内核报告的常驻进程数 · 上限 ' + RESIDENT_MAX + '（推荐 ≤2）' }),
      card({ title: '插件总数', value: S.list ? String(S.list.length) : '—', unit: '个', tone: S.list ? 'ok' : 'na',
        toneText: S.list ? '已采样' : '未采集', series: S.plugins, min: 0, note: '已安装插件数' })
    ];
    grid.textContent = '';
    for (i = 0; i < cards.length; i++) grid.appendChild(cards[i]);

    real.textContent = '';
    var facts = ['内核版本 ' + (d.version || '—'), '平台 ' + ([d.os, d.arch].filter(Boolean).join(' · ') || '—'),
      'cgroup ' + (d.cgroup_mode || '—'), '重启计数 ' + (num(sup.restarts) || 0)];
    if (gor !== null) facts.push('goroutine ' + gor);
    if (fds !== null) facts.push('文件句柄 ' + fds);
    for (i = 0; i < facts.length; i++) real.appendChild(el('span', null, facts[i]));

    mode.textContent = '';
    var warn = Array.isArray(d.warnings) ? d.warnings : [], seen = {}, delegDup = false;
    for (i = 0; i < warn.length; i++) delegDup = delegDup || String(warn[i]).indexOf('委派') !== -1;
    /* warnings 常含同一事实原文：已覆盖就不再叠加同义告警 */
    if (d.delegation === false && !delegDup) mode.appendChild(chip('warn', '当前为监控模式：cgroup 委派不可写（delegation=false），限额不生效'));
    for (i = 0; i < warn.length; i++) {
      if (!seen[warn[i]]) { seen[warn[i]] = 1; mode.appendChild(chip('warn', warn[i])); }
    }

    if (S.list) {
      var sig = S.list.map(function (p) {
        return [p.id, p.lifecycle, p.state, p.pid, p.restarts, (p.granted_capabilities || []).join(',')].join('|');
      }).join(';');
      if (sig !== S.sig) { renderTable(S.list); S.sig = sig; }
    }
  }

  function tick() {
    if (!S.box) return;
    if (S.box.isConnected === false) { stopPolling(); return; }  // 容器被壳移除：不留定时器
    Promise.all([
      getJSON(API_INFO).then(null, function () { return { ok: false, status: 0, data: null }; }),
      getJSON(API_PLUGINS).then(null, function () { return { ok: false, status: 0, data: null }; }),
      getJSON(API_METRICS).then(null, function () { return { ok: false, status: 0, data: null }; })
    ]).then(function (out) { if (S.box) paint(out[0], out[1], out[2]); },
      function () { setStatus('fail', '刷新失败：接口不可达'); });
  }

  /* clearInterval 收口：pagehide / beforeunload / 401 / 容器失联 / 重复挂载全走这里。 */
  function stopPolling() { if (S.timer !== null) { clearInterval(S.timer); S.timer = null; } }

  function render(container) {
    if (!container || typeof container.appendChild !== 'function') return null;
    stopPolling();  // 重复挂载先清旧定时器，避免叠加
    S.box = container; container.classList.add('kore-monitor'); container.textContent = '';
    S.sig = null;   // 新容器里的表格宿主是空的：强制下一次 paint 重画插件表

    container.appendChild(el('div', 'monitor-status'));
    container.appendChild(el('div', 'monitor-real muted'));
    container.appendChild(el('div', 'monitor-grid'));
    container.appendChild(el('div', 'monitor-mode'));

    var panel = el('section', 'panel'), head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', '插件资源表'));
    panel.appendChild(head);
    panel.appendChild(el('div', 'monitor-table-host'));
    container.appendChild(panel);

    // 整页只有这一处技术说明：讲清"为什么是「未采集」"以及数据会自己出现。
    var details = el('details', 'tech-note');
    details.appendChild(el('summary', 'tech-note-summary', '技术说明'));
    details.appendChild(el('p', 'tech-note-text',
      '资源指标（CPU、内存、磁盘、负载、goroutine、文件句柄）需要内核采集支持；接口未就绪时显示「未采集」，' +
      '就绪后本页会自动展示，无需刷新。趋势每 5 秒在浏览器内刷新，关闭页面即停止。'));
    container.appendChild(details);

    tick();
    S.timer = setInterval(tick, POLL_MS);
    return { destroy: stopPolling };
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', stopPolling); window.addEventListener('beforeunload', stopPolling);
  }
  window.KoreMonitor = {
    render: render, destroy: stopPolling, sparkline: sparkline, pollMs: POLL_MS,
    infoEndpoint: API_INFO, pluginsEndpoint: API_PLUGINS, metricsEndpoint: API_METRICS
  };
})();
