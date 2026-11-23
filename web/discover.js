/* kore 主壳 · 本机服务发现（web/discover.js）——零框架 / 零 CDN / 无外链。
   调用形态（硬约束，docs/FRONTEND.md §业务方法调用形态）：POST /api/v1/invoke/discover/discover.<action>，
   方法名必须带域前缀（裸 summary 在老版本能用，但新内核按方法名路由，不带前缀不可依赖）。
   真实返回（2026-11-23 隔离实例 18869 实测，discover 0.3.1）：
   - discover.summary  {ready, web_server, db, conclusion, suggestions[{plugin,reason}]}
   - discover.services [{id,name,found,bin?,client_version?,server_version?,version_source,version_hint?,config_dir?,running,running_hint?,port,source?,install_hint?}]
   - discover.ports    [{port,addr,family,listening,process|null}]（process 为 null 是「非 root 看不到别的 uid 的 socket」）
   - discover.config.get {plugin,persisted,credential_requirements[],transport,hint}
   summary 不含计数：概览的数字一律由 services / ports 两份清单现算，不编造字段。
   本页不轮询（G-19）：进页各查一次，重查只由按钮触发（{refresh:true} 会绕过插件 30s 缓存）。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/discover/', TIMEOUT_MS = 12000;
  var S = fresh();

  function fresh() {
    return { root: null, destroyed: false, busy: false,
      summary: null, summaryError: '', summaryCode: '', summaryHint: '',
      services: null, servicesError: '', servicesCode: '',
      ports: null, portsError: '', portsCode: '', portsHint: '',
      config: null, configError: '',
      filter: '', phase: '' };
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn, type) { n.addEventListener(type || 'click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    } return '';
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
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        err.code = data.code || ''; err.hint = data.detail || data.hint || ''; err.status = res.status;
        throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }

  // ---- 降级分类：三态 + 平台不支持，一律按「下一步」给按钮，不做点了才报错的按钮 ----
  function classify(err) {
    var code = (err && err.code) || '';
    var msg = (err && err.message) || '';
    if (code === 'E_CONFLICT' || /未启用|未安装|not installed/i.test(msg)) return 'notinstalled';
    if (code === 'E_NOTFOUND' && /未知方法|unknown method/i.test(msg)) return 'unsupported';
    if (code === 'E_NOTFOUND') return 'notinstalled';
    if (code === 'E_NEED_ROOT' || code === 'E_PERM' || code === 'E_DENIED') return 'noperm';
    if (code === 'E_UNSUPPORTED') return 'platform';
    if (err && err.status === 403) return 'noperm';
    return 'error';
  }
  function describe(err) {
    var kind = classify(err), title = '', lines = [], cmds = [], btn = '';
    if (kind === 'notinstalled') {
      title = '还没有安装「服务发现」插件';
      lines = ['这个页面读的是 discover 插件探测到的本机服务与端口。装上它之后刷新本页，' +
        '概览、端口列表就会自动出现——不需要再配任何参数。'];
      btn = 'discover';
    } else if (kind === 'unsupported') {
      title = '当前插件版本不支持这个能力';
      lines = ['后端返回「未知方法」，说明已装的 discover 版本比本页面旧。升级插件后本页会自动恢复。'];
      btn = 'upgrade';
    } else if (kind === 'noperm') {
      title = '没有权限读取端口对应的进程名';
      lines = ['端口本身能看到，但「哪个进程占用了它」需要 root 才能读（普通用户只能看到同 uid 的进程）。',
        'kore 的设计是让内核代理 root 动作（ADR-0018）：以 root 启动 kored 后刷新本页即可看到进程名。'];
      cmds = ['sudo systemctl restart kore'];
      btn = 'refresh';
    } else if (kind === 'platform') {
      title = '这个平台暂不支持真实探测';
      lines = ['discover 插件只在 Linux 上提供真实实现（当前平台会返回「不支持」）。'];
      btn = 'refresh';
    } else {
      title = '读取失败';
      lines = ['后端返回了错误，这不是登录失效。稍后重试；持续失败请查看插件日志。'];
      btn = 'refresh';
    }
    return { kind: kind, title: title, lines: lines, cmds: cmds, btn: btn, hint: (err && err.hint) || '' };
  }
  function goStore() {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('store');
    else window.location.hash = '#/store';
  }
  function goPlugins() {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('plugins');
    else window.location.hash = '#/plugins';
  }
  function guideBlock(info, onRetry) {
    var box = el('div', 'disc-callout');
    box.setAttribute('role', 'status');
    add(box, el('div', 'disc-callout-title', info.title));
    info.lines.forEach(function (l) { add(box, el('p', 'disc-callout-text', l)); });
    (info.cmds || []).forEach(function (c) { add(box, el('pre', 'disc-cmd', c)); });
    var ops = add(box, el('div', 'disc-ops'));
    if (info.btn === 'discover') {
      var b = add(ops, el('button', 'btn btn-primary', '去软件商店安装'));
      b.type = 'button'; on(b, goStore);
    } else if (info.btn === 'upgrade') {
      var u = add(ops, el('button', 'btn btn-primary', '去已装插件升级'));
      u.type = 'button'; on(u, goPlugins);
    } else if (info.btn === 'plugins') {
      var p = add(ops, el('button', 'btn btn-primary', '查看已装插件'));
      p.type = 'button'; on(p, goPlugins);
    } else {
      var r = add(ops, el('button', 'btn btn-primary', '重新探测'));
      r.type = 'button'; on(r, onRetry || refreshAll);
    }
    if (info.hint) {
      var d = add(box, el('details', 'disc-details'));
      add(d, el('summary', null, '查看后端原始提示'));
      add(d, el('p', 'disc-callout-text', info.hint));
    }
    return box;
  }
  // ---- 「未知方法」不止一种情形，不能一律糊成「去升级」（appdeploy 犯过的错） ----
  // 先查已装列表：① 列表里没有 → 其实是没装；② 有新版 → 去升级真的能修；
  // ③ 已是最新仍缺方法 → 是主壳/页面与插件版本不配套，升级插件无从下手，如实说明。
  function getJSON(path) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(path, init).then(function (res) {
      if (timer !== null) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (e) { if (timer !== null) clearTimeout(timer); throw e; });
  }
  function loadInstalled() {
    return getJSON('/api/v1/plugins').then(function (d) { return (d && d.plugins) || []; },
      function () { return null; }); // null = 查询失败，不等于「未安装」
  }
  function describeUnsupported(err, rec, listed) {
    var base = describe(err);
    if (!listed) return base; // 查不到已装列表：保留原判据 + 原始提示，不猜
    if (!rec) {
      return { kind: 'notinstalled', title: '还没有安装「服务发现」插件',
        lines: ['后端返回「未知方法」，同时已装列表里没有 discover——说明这个插件还没装，不是版本旧。',
          '装上之后刷新本页，概览与端口列表就会自动出现。'],
        cmds: [], btn: 'discover', hint: base.hint };
    }
    if (rec.update_available && rec.latest_version) {
      return { kind: 'unsupported', title: '已装的 discover 比本页面旧',
        lines: ['后端返回「未知方法」——插件缺少本页面要调用的方法；软件商店已有新版本 v' +
          (rec.version || '?') + ' → v' + rec.latest_version + '。',
          '升级后本页自动恢复，插件配置与已有探测结果不受影响。'],
        cmds: [], btn: 'upgrade', hint: base.hint };
    }
    return { kind: 'unsupported', title: '插件已是最新，仍缺少本页面要调用的方法',
      lines: ['当前 discover v' + (rec.version || '?') + ' 已是索引里的最新版本，商店没有可升级的版本——所以「去升级」帮不上忙。',
        '这种情况意味着本页面与该插件版本不配套（主壳或页面比插件新）：请确认 kore 主壳是否也需要一起升级，或等待配套版本发布。',
        '在此之前本页保持不可用，不会显示半截数据。'],
      cmds: [], btn: 'plugins', hint: base.hint };
  }
  function gateUnsupported(err) {
    var host = S.gateHost;
    if (!host) return;
    host.textContent = ''; host.style.display = '';
    add(host, el('div', 'disc-loading', '正在确认已装插件版本…'));
    loadInstalled().then(function (list) {
      if (S.destroyed || S.gateHost !== host) return;
      var rec = null;
      if (list) { for (var i = 0; i < list.length; i++) if (list[i].id === 'discover') rec = list[i]; }
      host.textContent = '';
      host.appendChild(guideBlock(describeUnsupported(err, rec, list !== null), refreshAll));
    });
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function panel(title, metaText) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    return { panel: p, head: h, meta: add(h, el('span', 'panel-meta', metaText || '')) };
  }
  function metric(label, value, hint) {
    var c = el('div', 'disc-metric');
    add(c, el('span', 'disc-metric-label', label));
    add(c, el('span', 'disc-metric-value', value));
    if (hint) add(c, el('span', 'disc-metric-hint', hint));
    return c;
  }

  // ---- 数据派生（全部来自真实返回，不做二次猜测） ----
  function foundServices() {
    return (S.services || []).filter(function (s) { return !!s.found; });
  }
  function listeningPorts() {
    return (S.ports || []).filter(function (p) { return !!p.listening; });
  }
  // 归属：用 services[].port 反查（插件没有直接给「端口→插件」映射），匹配不到就留空。
  function ownerOf(port) {
    var list = foundServices(), best = '';
    for (var i = 0; i < list.length; i++) {
      if (list[i].port === port) {
        var label = list[i].name || list[i].id;
        if (list[i].running) return label + ' · 运行中';
        if (!best) best = label + ' · 未监听';
      }
    }
    return best;
  }
  function serviceVersion(s) {
    if (s.version_source === 'server' && s.server_version) return s.server_version;
    if (s.version_source === 'client' && s.client_version) return s.client_version;
    if (s.client_version) return s.client_version;
    if (s.server_version) return s.server_version;
    return '';
  }
  function familyText(f) {
    if (f === 'ipv4') return 'IPv4';
    if (f === 'ipv6') return 'IPv6';
    return f || '—';
  }
  function matchPort(p, q) {
    if (!q) return true;
    var hay = String(p.port) + ' ' + String(p.process || '') + ' ' + String(p.addr || '') + ' ' + ownerOf(p.port);
    return hay.toLowerCase().indexOf(q) >= 0;
  }

  // ---- ① 概览 ----
  function paintOverview() {
    if (!S.overviewHost) return;
    S.overviewHost.textContent = '';
    if (S.summaryError) { S.overviewHost.appendChild(guideBlock(describe(S.summaryError), refreshAll)); return; }
    if (!S.summary) { add(S.overviewHost, el('div', 'disc-loading', '正在读取本机服务发现结果…')); return; }
    var sm = S.summary, svc = foundServices(), ports = listeningPorts();
    var docker = (svc.filter(function (s) { return s.id === 'docker'; })[0]) || null;
    var top = add(S.overviewHost, el('div', 'disc-status-top'));
    top.appendChild(chip(sm.ready ? 'ok' : 'warn', sm.ready ? '本机已就绪' : '暂未检测到可用服务'));
    add(top, el('span', 'disc-conclusion', sm.conclusion || ''));
    var grid = add(S.overviewHost, el('div', 'disc-metrics'));
    add(grid, metric('已检测服务', String(svc.length) + ' 个', '共探测 ' + String((S.services || []).length) + ' 项'));
    add(grid, metric('在听端口', String(ports.length) + ' 个', '含 IPv4 / IPv6 双栈各自计数'));
    add(grid, metric('Web 服务器', sm.web_server || '未检测到', sm.web_server ? 'summary.web_server' : '可装 nginx / caddy'));
    add(grid, metric('数据库', sm.db || '未检测到', sm.db ? 'summary.db' : '可装 MySQL / PostgreSQL'));
    add(grid, metric('容器运行时', docker ? '已检测到 Docker' : '未检测到',
      docker ? (docker.running ? '运行中' : '已安装，未在监听') : '可装 Docker 后用容器插件管理'));
    // 建议：summary.suggestions 是插件的固定优先级建议，原样呈现，不加工。
    var sug = sm.suggestions || [];
    var box = add(S.overviewHost, el('div', 'disc-suggest'));
    add(box, el('div', 'disc-suggest-title', sug.length ? '接下来可以装这些插件（' + sug.length + ' 条建议）' : '暂时没有额外的安装建议'));
    if (sug.length) {
      var ul = add(box, el('ul', 'disc-suggest-list'));
      sug.forEach(function (s) {
        var li = add(ul, el('li', 'disc-suggest-item'));
        add(li, el('span', 'disc-suggest-plugin', s.plugin));
        add(li, el('span', 'disc-suggest-reason', s.reason));
      });
    }
    var ops = add(box, el('div', 'disc-ops'));
    var b = add(ops, el('button', 'btn btn-ghost', '去软件商店')); b.type = 'button'; on(b, goStore);
  }

  // ---- ② 端口表 ----
  function paintPorts() {
    if (!S.portsHost) return;
    S.portsHost.textContent = '';
    if (S.portsError) { S.portsHost.appendChild(guideBlock(describe(S.portsError), refreshAll)); return; }
    if (!S.ports) { add(S.portsHost, el('div', 'disc-loading', '正在读取监听端口…')); return; }
    var all = S.ports.filter(function (p) { return !!p.listening; });
    var q = S.filter.trim().toLowerCase();
    var rows = all.filter(function (p) { return matchPort(p, q); });
    if (S.portsMeta) S.portsMeta.textContent = '在听 ' + all.length + ' 个' + (q ? '，匹配 ' + rows.length + ' 个' : '');
    if (!all.length) {
      var empty = add(S.portsHost, el('div', 'disc-empty'));
      add(empty, el('span', null, '没有发现任何监听端口。可能刚启动、或服务都被防火墙挡住了。'));
      var rb = add(empty, el('button', 'btn btn-primary', '重新探测')); rb.type = 'button';
      on(rb, function () { refreshAll(true); });
      return;
    }
    if (!rows.length) {
      var none = add(S.portsHost, el('div', 'disc-empty'));
      add(none, el('span', null, '没有端口或进程名匹配「' + S.filter.trim() + '」。'));
      var cb = add(none, el('button', 'btn btn-ghost', '清空过滤')); cb.type = 'button';
      on(cb, function () { S.filter = ''; if (S.filterInput) S.filterInput.value = ''; paintPorts(); });
      return;
    }
    var wrap = add(S.portsHost, el('div', 'disc-table-wrap'));
    var table = add(wrap, el('table', 'plugin-table disc-table'));
    var thead = add(table, el('thead')), hr = add(thead, el('tr'));
    ['端口', '协议', '归属服务', '进程', '监听地址'].forEach(function (t) {
      var th = add(hr, el('th', null, t)); th.setAttribute('scope', 'col');
    });
    var tbody = add(table, el('tbody'));
    rows.forEach(function (p) {
      var tr = add(tbody, el('tr'));
      var tdPort = add(tr, el('td', 'disc-num', String(p.port))); tdPort.setAttribute('data-label', '端口');
      var tdFam = add(tr, el('td', null, familyText(p.family))); tdFam.setAttribute('data-label', '协议');
      var owner = ownerOf(p.port) || '未识别';
      var tdOwn = add(tr, el('td', null, owner)); tdOwn.setAttribute('data-label', '归属服务');
      var proc = add(tr, el('td', 'disc-mono'));
      proc.setAttribute('data-label', '进程');
      if (p.process) { proc.textContent = p.process; }
      else {
        proc.textContent = '—';
        proc.setAttribute('title', '非 root 运行时只能看到同 uid 进程的 socket，进程名可能为空');
        proc.classList.add('disc-muted');
      }
      var addr = add(tr, el('td', 'disc-mono', p.addr || '—')); addr.setAttribute('data-label', '监听地址');
    });
  }

  // ---- ③ 服务清单（概览之外的下钻，同一份 services 数据） ----
  function paintServices() {
    if (!S.servicesHost) return;
    S.servicesHost.textContent = '';
    if (S.servicesError) { S.servicesHost.appendChild(guideBlock(describe(S.servicesError), refreshAll)); return; }
    if (!S.services) { return; }
    var svc = foundServices();
    if (S.servicesMeta) S.servicesMeta.textContent = '已检测到 ' + svc.length + ' 个';
    if (!svc.length) {
      var empty = add(S.servicesHost, el('div', 'disc-empty'));
      add(empty, el('span', null, '本机没有检测到任何已知服务（nginx / MySQL / Redis / Docker 等）。'));
      var rb = add(empty, el('button', 'btn btn-primary', '重新探测')); rb.type = 'button';
      on(rb, function () { refreshAll(true); });
      return;
    }
    var wrap = add(S.servicesHost, el('div', 'disc-table-wrap'));
    var table = add(wrap, el('table', 'plugin-table disc-table'));
    var thead = add(table, el('thead')), hr = add(thead, el('tr'));
    ['服务', '版本', '运行', '默认端口', '配置目录'].forEach(function (t) {
      var th = add(hr, el('th', null, t)); th.setAttribute('scope', 'col');
    });
    var tbody = add(table, el('tbody'));
    svc.forEach(function (s) {
      var tr = add(tbody, el('tr'));
      var name = add(tr, el('td', null, s.name || s.id));
      name.setAttribute('data-label', '服务');
      var ver = add(tr, el('td', 'disc-mono', serviceVersion(s) || '未获取'));
      ver.setAttribute('data-label', '版本');
      if (s.version_hint) { ver.setAttribute('title', s.version_hint); ver.classList.add('disc-muted'); }
      var run = add(tr, el('td'));
      run.setAttribute('data-label', '运行');
      run.appendChild(chip(s.running ? 'ok' : 'warn', s.running ? '运行中' : '未监听'));
      if (s.running_hint) { run.setAttribute('title', s.running_hint); }
      var port = add(tr, el('td', 'disc-num', s.port ? String(s.port) : '—'));
      port.setAttribute('data-label', '默认端口');
      var cfg = add(tr, el('td', 'disc-mono', s.config_dir || '—'));
      cfg.setAttribute('data-label', '配置目录');
    });
  }

  function hideAll(show) {
    [S.overviewPanel, S.portsPanel, S.servicesPanel].forEach(function (p) {
      if (p) p.style.display = show ? '' : 'none';
    });
  }

  function refreshAll(force) {
    if (S.busy || S.destroyed) return;
    S.busy = true;
    S.summaryError = S.portsError = S.servicesError = '';
    S.summary = S.ports = S.services = null;
    paintOverview(); paintPorts(); paintServices();
    var params = force ? { refresh: true } : {};
    var calls = [
      invoke('discover.summary', params).then(function (d) { S.summary = d || {}; },
        function (e) { S.summaryError = e; }),
      invoke('discover.ports', params).then(function (d) { S.ports = Array.isArray(d) ? d : []; },
        function (e) { S.portsError = e; }),
      invoke('discover.services', params).then(function (d) { S.services = Array.isArray(d) ? d : []; },
        function (e) { S.servicesError = e; })
    ];
    return Promise.all(calls).then(function () {
      S.busy = false;
      if (S.destroyed) return;
      // 三态里有任一命中「未装 / 不支持」就整页收成单张空态，不展示半截数据。
      var firstErr = S.summaryError || S.portsError || S.servicesError;
      var kind = firstErr ? classify(firstErr) : '';
      if (kind === 'notinstalled') {
        hideAll(false);
        if (S.gateHost) { S.gateHost.textContent = ''; S.gateHost.style.display = ''; S.gateHost.appendChild(guideBlock(describe(firstErr), refreshAll)); }
        return;
      }
      if (kind === 'unsupported') { hideAll(false); gateUnsupported(firstErr); return; }
      hideAll(true);
      if (S.gateHost) { S.gateHost.textContent = ''; S.gateHost.style.display = 'none'; }
      paintOverview(); paintPorts(); paintServices();
    });
  }

  function injectCSS() {
    if (document.getElementById('kore-discover-css')) return;
    var css = buildCSS();
    var style = el('style', null, css); style.id = 'kore-discover-css';
    document.head.appendChild(style);
  }
  function buildCSS() {
    return [
      '.disc-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.disc-metric{display:flex;flex-direction:column;gap:2px;padding:var(--kore-space-3);background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-card,10px);}',
      '.disc-metric-label{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-metric-value{color:var(--kore-text-1);font-size:var(--kore-font-20,22px);font-weight:600;font-variant-numeric:tabular-nums;}',
      '.disc-metric-hint{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-status-top{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.disc-conclusion{color:var(--kore-text-2);font-size:var(--kore-font-13);flex:1 1 260px;}',
      '.disc-suggest{margin:var(--kore-space-3) var(--kore-space-4) var(--kore-space-4);padding:var(--kore-space-3);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);background:var(--kore-bg-1);}',
      '.disc-suggest-title{color:var(--kore-text-2);font-size:var(--kore-font-13);margin-bottom:var(--kore-space-2);}',
      '.disc-suggest-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--kore-space-1);}',
      '.disc-suggest-item{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);align-items:baseline;font-size:var(--kore-font-13);}',
      '.disc-suggest-plugin{flex:0 0 auto;padding:0 6px;border-radius:4px;background:var(--kore-bg-2);color:var(--kore-info);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.disc-suggest-reason{color:var(--kore-text-2);flex:1 1 240px;}',
      '.disc-callout{margin:var(--kore-space-3) var(--kore-space-4);padding:var(--kore-space-3);border:1px solid var(--kore-border-2);border-left:3px solid var(--kore-warn,#d9a441);border-radius:var(--kore-radius-control);background:var(--kore-bg-1);}',
      '.disc-callout-title{color:var(--kore-text-1);font-size:var(--kore-font-14);font-weight:600;margin-bottom:var(--kore-space-2);}',
      '.disc-callout-text{margin:0 0 var(--kore-space-1);color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.6;}',
      '.disc-cmd{margin:var(--kore-space-1) 0;padding:var(--kore-space-2) var(--kore-space-3);overflow-x:auto;color:var(--kore-term-cyan);background:var(--kore-bg-0);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.disc-ops{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);margin-top:var(--kore-space-2);}',
      '.disc-table-wrap{overflow-x:auto;padding:0 var(--kore-space-2) var(--kore-space-2);}',
      '.disc-table{width:100%;border-collapse:collapse;}',
      '.disc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.disc-num{font-variant-numeric:tabular-nums;}',
      '.disc-muted{color:var(--kore-text-3);}',
      '.disc-empty{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-4);color:var(--kore-text-3);font-size:var(--kore-font-13);}',
      '.disc-empty span{flex:1 1 260px;}',
      '.disc-loading{padding:var(--kore-space-4);color:var(--kore-text-3);font-size:var(--kore-font-13);}',
      '.disc-filter{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.disc-filter input{flex:1 1 240px;min-height:44px;}',
      '@media (max-width:639px){',
      '.disc-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}',
      '.disc-table,.disc-table tbody,.disc-table tr,.disc-table td{display:block;width:100%;}',
      '.disc-table tr{padding:var(--kore-space-2) 0 var(--kore-space-3);}',
      '.disc-table td{display:flex;gap:var(--kore-space-3);}',
      '.disc-table td::before{content:attr(data-label);flex:0 0 72px;color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-metrics{grid-template-columns:1fr;}',
      '.disc-ops .btn,.disc-empty .btn{min-height:44px;}',
      '}'
    ].join('\n');
  }

  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    injectCSS();
    S.root = add(container, el('section', 'discover'));
    var head = add(S.root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '服务发现'));
    add(head, el('p', 'view-sub', '看看这台机器上已经装了什么、在监听哪些端口——装插件之前先知道本机有什么。'));
    var headOps = add(head, el('div', 'actions'));
    var rf = add(headOps, el('button', 'btn btn-ghost', '重新探测')); rf.type = 'button';
    on(rf, function () { refreshAll(true); });
    S.gateHost = add(S.root, el('div', 'disc-gate')); S.gateHost.style.display = 'none';

    var ov = panel('概览', '插件 discover.summary + services + ports');
    add(S.root, ov.panel); S.overviewPanel = ov.panel;
    S.overviewHost = add(ov.panel, el('div', 'disc-overview'));

    var pt = panel('监听端口', '前端过滤，不轮询');
    add(S.root, pt.panel); S.portsPanel = pt.panel;
    S.portsMeta = add(pt.meta, el('span', null, ''));
    var filter = add(pt.panel, el('div', 'disc-filter'));
    var fl = add(filter, el('label', 'field'));
    add(fl, el('span', 'field-label', '按端口或进程名过滤'));
    S.filterInput = add(fl, el('input', 'field-input'));
    S.filterInput.type = 'search'; S.filterInput.placeholder = '例如 3306 / nginx / 127.0.0.1';
    S.filterInput.setAttribute('autocomplete', 'off');
    on(S.filterInput, function () { S.filter = S.filterInput.value; paintPorts(); }, 'input');
    S.portsHost = add(pt.panel, el('div', 'disc-ports'));

    var sv = panel('服务清单', 'discover.services');
    add(S.root, sv.panel); S.servicesPanel = sv.panel;
    S.servicesMeta = add(sv.meta, el('span', null, ''));
    S.servicesHost = add(sv.panel, el('div', 'disc-services'));

    refreshAll(false);
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreDiscover = { render: render };
})();
