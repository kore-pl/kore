/* kore 主壳 · DNS 解析（web/dns.js）——零框架 / 零 CDN / 无外链。
   调用形态（硬约束，docs/FRONTEND.md §业务方法调用形态）：POST /api/v1/invoke/dns/dns.<action>，
   方法名必须带域前缀。读：dns.status / dns.zones / dns.records / dns.query；
   写：dns.record.add|update|delete（bind9 RFC 2136 动态更新，需要先在插件设置里配 TSIG 密钥——
   本页只读，不提供编辑入口，避免"点了才发现没配密钥"）。
   三种降级：没有 DNS 服务（E_NO_ENGINE）/ 区域文件读不到（E_NEED_ROOT）/ 插件未安装（E_NOTFOUND）。
   本页不轮询：状态与列表都是用户触发或进页时各查一次。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/dns/', TIMEOUT_MS = 12000;
  var RUNBOOK_PRIV = 'docs/RUNBOOK.md#5-以-root-启动-kored-与提权通道adr-0018';
  // 类型预设：覆盖日常 90% 的查询，不让人记类型表。
  var TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
  var TYPE_HINT = {
    A: 'IPv4 地址', AAAA: 'IPv6 地址', CNAME: '别名指向', MX: '邮件服务器',
    TXT: '文本记录（SPF / 校验）', NS: '权威域名服务器'
  };

  function fresh() {
    return { root: null, status: null, statusError: '', statusCode: '', statusHint: '',
      zones: [], zonesLoaded: false, zonesError: '', zonesCode: '', zonesHint: '', zonesWarnings: [],
      activeZone: '', records: [], recordsMeta: null, recordsLoaded: false, recordsError: '', recordsTruncated: false,
      qName: '', qType: 'A', qBusy: false, qResult: null, qError: '', qMsg: '',
      notInstalled: false, busy: false, destroyed: false };
  }
  var S = fresh();

  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn, type) { n.addEventListener(type || 'click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
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
        err.code = data.code || ''; err.hint = data.hint || ''; err.status = res.status; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }

  // ---- 文案 ----
  function engineText(id) {
    if (id === 'systemd-resolved') return 'systemd-resolved';
    if (id === 'dnsmasq') return 'dnsmasq';
    if (id === 'bind9') return 'BIND9（named）';
    if (id === 'coredns') return 'CoreDNS';
    return id || '未检测到';
  }
  function typeText(t) { return t ? (t + (TYPE_HINT[t] ? '（' + TYPE_HINT[t] + '）' : '')) : '—'; }
  function failureText(err, verb) {
    if (!err) return verb + '失败';
    if (err.code === 'E_NEED_ROOT') return verb + '失败：需要 root 权限读取区域文件。按状态卡片里的说明以 root 重启 kored 后重试。';
    if (err.code === 'E_NOTFOUND') return verb + '失败：DNS 插件还没装或没有这个方法。';
    if (err.code === 'E_NO_ENGINE') return '本机没有可用的 DNS 服务：' + (err.hint || '装上 BIND9 或 dnsmasq 后刷新本页。');
    if (err.code === 'E_INVALID') return '参数不合法：' + err.message;
    return verb + '失败：' + err.message + (err.hint ? '（' + err.hint + '）' : '');
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function notice(text, tone) {
    var cls = 'notice' + (tone === 'ok' ? ' redis-notice-ok' : '');
    var n = el('div', cls, text); n.setAttribute('role', 'alert'); return n;
  }
  function panel(title, metaText) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    return { panel: p, head: h, meta: add(h, el('span', 'panel-meta', metaText || '')) };
  }
  function emptyBlock(text, actionLabel, action) {
    var box = el('div', 'dns-empty');
    add(box, el('span', null, text));
    if (actionLabel) {
      var btn = add(box, el('button', 'btn btn-ghost', actionLabel)); btn.type = 'button';
      if (action) on(btn, action);
    }
    return box;
  }
  function cmdBlock(box, cmds) {
    cmds.forEach(function (c) { add(box, el('pre', 'dns-cmd', c)); });
  }
  function guideFor(title, lines, cmds, hint) {
    var box = el('div', 'dns-callout dns-callout-warn');
    box.setAttribute('role', 'status');
    add(box, el('div', 'dns-callout-title', title));
    lines.forEach(function (l) { add(box, el('p', 'dns-callout-text', l)); });
    cmdBlock(box, cmds || []);
    if (hint) {
      var d = add(box, el('details', 'dns-details'));
      add(d, el('summary', null, '查看后端原始提示'));
      add(d, el('p', 'dns-callout-text', hint));
    }
    return box;
  }
  function rootGuide(hint) {
    var box = el('div', 'dns-callout dns-callout-warn');
    add(box, el('div', 'dns-callout-title', '这一步需要 root 权限，当前没有可用的提权通道'));
    add(box, el('p', 'dns-callout-text',
      '区域文件（如 /etc/bind/named.conf.local、/var/lib/bind/*.zone）通常只有 root 可读。' +
      'kored 以普通用户身份启动时读不到，kore 的设计是让内核代理 root 动作（ADR-0018）。'));
    var d = add(box, el('details', 'dns-details'));
    add(d, el('summary', null, '查看如何配置'));
    add(d, el('p', 'dns-callout-text', '在服务器上以 root 重启 kored，然后刷新本页：'));
    add(d, el('pre', 'dns-cmd', 'sudo systemctl restart kore'));
    if (hint) add(d, el('p', 'dns-callout-text', '后端提示：' + hint));
    var p = add(d, el('p', 'dns-callout-text'));
    var a = add(p, el('a', 'dns-link', '查看运行手册'));
    a.href = RUNBOOK_PRIV; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return box;
  }
  function goStore() {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('store');
    else window.location.hash = '#/store';
  }
  function openConfig() {
    if (window.KoreShell && typeof window.KoreShell.openConfig === 'function') {
      window.KoreShell.openConfig(S.root, 'dns', { title: 'DNS 设置', onSaved: refreshAll });
    } else {
      S.zonesError = '配置面板未加载，请刷新页面后重试'; paintZones();
    }
  }

  // ---- ① 解析状态 ----
  function paintStatus() {
    if (!S.statusHost) return;
    S.statusHost.textContent = '';
    if (S.statusError) {
      if (S.statusCode === 'E_NOTFOUND') {
        S.notInstalled = true;
        hidePanels();
        S.statusHost.appendChild(emptyBlock('还没有安装 DNS 插件（页面先把「怎么装」给你，不留空白）。',
          '去软件商店安装', goStore));
      } else {
        S.statusHost.appendChild(notice('状态读取失败：' + S.statusError, 'fail'));
        if (S.statusHint) S.statusHost.appendChild(guideFor('状态读取失败', ['这是后端返回的原因，不是登录失效。'], [], S.statusHint));
      }
      return;
    }
    if (S.notInstalled) { S.notInstalled = false; hidePanels(false); }
    if (!S.status) { add(S.statusHost, el('div', 'dns-loading', '正在探测本机 DNS 服务…')); return; }
    var st = S.status, ok = !!st.available;
    var top = add(S.statusHost, el('div', 'dns-status-top'));
    top.appendChild(chip(ok ? 'ok' : 'warn', ok ? '已检测到 DNS 服务' : '未检测到 DNS 服务'));
    if (ok) top.appendChild(chip('na', '主引擎：' + engineText(st.engine)));
    var grid = add(S.statusHost, el('div', 'dns-grid'));
    [
      ['主引擎', ok ? engineText(st.engine) + (st.version ? ' · ' + st.version : '') : '未检测到'],
      ['监听地址', (st.listening || []).length
        ? (st.listening || []).map(function (l) { return l.addr + ':' + l.port + '/' + l.proto; }).join('；')
        : '未发现 53 端口监听'],
      ['上游 DNS', (st.upstreams || []).length ? (st.upstreams || []).join('、') : '未配置（跟随系统）'],
      ['系统解析器', (st.resolv_nameservers || []).length ? (st.resolv_nameservers || []).join('、') : '—'],
      ['探测时间', st.checked_at || '—'],
      ['候选项', String((st.engines || []).length) + ' 个引擎']
    ].forEach(function (item) {
      var cell = add(grid, el('div', 'dns-cell'));
      add(cell, el('span', 'dns-cell-label', item[0]));
      add(cell, el('span', 'dns-cell-value', item[1]));
    });
    if (!ok) {
      S.statusHost.appendChild(guideFor('本机没有可用的 DNS 服务（不影响你查询外部域名）',
        ['kore 不内置 DNS 服务：装了本插件也只是「读现有服务 + 真实查询」。要托管区域或本机解析，' +
        '装上下面任一服务后刷新本页；只想查域名的话，上面「即时查询」现在就能用。'],
        ['sudo apt install bind9      # Debian / Ubuntu', 'sudo dnf install bind      # RHEL / Fedora / CentOS'],
        st.hint || ''));
    }
    // 引擎明细：默认收起，排障时才展开。
    var details = add(S.statusHost, el('details', 'dns-details'));
    add(details, el('summary', null, '查看探测明细（' + ((st.engines || []).length) + ' 个引擎）'));
    (st.engines || []).forEach(function (e) {
      var row = add(details, el('div', 'dns-engine-row'));
      row.appendChild(chip(e.detected ? (e.primary ? 'ok' : 'na') : 'warn',
        engineText(e.engine) + (e.primary ? ' · 主引擎' : '') + (e.detected ? '' : ' · 未检测到')));
      add(row, el('span', 'dns-cell-label',
        (e.running ? '运行中' : '未运行') + (e.version ? ' · ' + e.version : '') +
        ((e.upstreams || []).length ? ' · 上游 ' + e.upstreams.join('、') : '') +
        (e.note ? ' · ' + e.note : '') + (e.error ? ' · ' + e.error : '')));
    });
  }
  function hidePanels(hidden) {
    var flag = hidden === undefined ? true : !!hidden;
    [S.queryPanel, S.zonesPanel, S.recordsPanel].forEach(function (p) { if (p) p.hidden = flag; });
  }

  // ---- ② 即时查询 ----
  function paintQuery() {
    if (!S.queryHost) return;
    S.queryHost.textContent = '';
    if (S.qError) { S.queryHost.appendChild(notice(S.qError, 'fail')); return; }
    if (!S.qResult) {
      S.queryHost.appendChild(emptyBlock('上面填一个域名、选好类型点「查询」就会显示结果（默认 A 记录，最常用）。'));
      return;
    }
    var r = S.qResult;
    var head = add(S.queryHost, el('div', 'dns-q-head'));
    head.appendChild(chip(r.rcode === 'NOERROR' && (r.answers || []).length ? 'ok' : 'warn',
      r.rcode === 'NOERROR' ? (r.answers || []).length + ' 条应答' : '响应码 ' + (r.rcode || '—')));
    add(head, el('span', 'dns-cell-label',
      '耗时 ' + (r.elapsed_ms || 0) + ' ms · 查询器 ' + (r.resolver || '—') +
      (r.note ? ' · ' + r.note : '')));
    if (!(r.answers || []).length) {
      S.queryHost.appendChild(emptyBlock(r.rcode === 'NXDOMAIN'
        ? '这个域名没有解析结果（NXDOMAIN：记录不存在）。换个类型或确认拼写。'
        : '查询没有返回应答。可以换类型再试；持续失败时检查上游 DNS 是否可达。'));
      return;
    }
    var wrap = add(S.queryHost, el('div', 'dns-table-wrap'));
    var table = add(wrap, el('table', 'dns-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['域名', '类型', '值', 'TTL'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    (r.answers || []).forEach(function (a) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', 'dns-mono', a.name || '—')).setAttribute('data-label', '域名');
      add(tr, el('td', 'dns-mono', a.type || '—')).setAttribute('data-label', '类型');
      add(tr, el('td', 'dns-value', a.value || '—')).setAttribute('data-label', '值');
      add(tr, el('td', 'dns-num', a.ttl ? a.ttl + ' 秒' : '—')).setAttribute('data-label', 'TTL');
    });
  }
  function submitQuery() {
    if (S.qBusy) return;
    var name = (S.qNameInput.value || '').trim();
    if (!name) { S.qError = '请先填要查询的域名（例如 example.com）'; S.qResult = null; paintQuery(); S.qNameInput.focus(); return; }
    if (!/^[0-9A-Za-z._*-]{1,253}$/.test(name)) { S.qError = '域名格式看起来不对：只允许字母、数字、点、连字符、下划线、星号'; S.qResult = null; paintQuery(); return; }
    S.qBusy = true; S.qBtn.disabled = true; S.qError = ''; S.qMsg = '正在查询…'; paintQuery();
    invoke('dns.query', { name: name, type: S.qType }).then(function (data) {
      if (S.destroyed) return;
      S.qBusy = false; S.qBtn.disabled = false;
      S.qResult = data; S.qMsg = ''; S.qName = name;
      paintQuery(); paintQueryMsg();
    }, function (err) {
      if (S.destroyed) return;
      S.qBusy = false; S.qBtn.disabled = false;
      S.qResult = null; S.qError = failureText(err, '查询'); S.qMsg = '';
      paintQuery(); paintQueryMsg();
    });
  }
  function paintQueryMsg() { if (S.qMsgHost) S.qMsgHost.textContent = S.qMsg || ''; }

  // ---- ③ 区域列表 ----
  function paintZones() {
    if (!S.zonesHost) return;
    S.zonesHost.textContent = '';
    S.zonesMeta.textContent = S.zonesLoaded ? ((S.zones || []).length + ' 个区域') : '';
    if (S.zonesError) {
      if (S.zonesCode === 'E_NEED_ROOT') {
        S.zonesHost.appendChild(emptyBlock('读不到区域文件（需要 root 权限）。按上方状态卡里的说明以 root 重启 kored 后刷新本页。'));
      } else {
        S.zonesHost.appendChild(notice('区域列表读取失败：' + S.zonesError, 'fail'));
      }
      return;
    }
    if (!S.zonesLoaded) { add(S.zonesHost, el('div', 'dns-loading', '正在读取区域列表…')); return; }
    if (!(S.zones || []).length) {
      S.zonesHost.appendChild(emptyBlock(
        '没有读到任何区域。systemd-resolved 不存区域表（只做转发），要托管区域请装 BIND9 或 dnsmasq；' +
        '已装但仍为空时，检查插件设置里的区域文件路径。', '打开 DNS 设置', openConfig));
      return;
    }
    if ((S.zonesWarnings || []).length) {
      var warn = add(S.zonesHost, el('div', 'dns-callout dns-callout-warn'));
      add(warn, el('div', 'dns-callout-title', '部分区域读不到'));
      (S.zonesWarnings || []).slice(0, 4).forEach(function (w) { add(warn, el('p', 'dns-callout-text', w)); });
    }
    var wrap = add(S.zonesHost, el('div', 'dns-table-wrap'));
    var table = add(wrap, el('table', 'dns-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['区域', '类型', '记录数', '所属引擎', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.zones.forEach(function (z) {
      var tr = add(tbody, el('tr', 'dns-row' + (z.name === S.activeZone ? ' is-active' : '')));
      add(tr, el('td', 'dns-mono', z.name)).setAttribute('data-label', '区域');
      add(tr, el('td', null, z.type || '—')).setAttribute('data-label', '类型');
      add(tr, el('td', 'dns-num', z.readable ? String(z.records_count || 0) : '读不到')).setAttribute('data-label', '记录数');
      add(tr, el('td', null, engineText(z.engine))).setAttribute('data-label', '所属引擎');
      var ops = add(tr, el('td', 'dns-ops')); ops.setAttribute('data-label', '操作');
      var btn = add(ops, el('button', 'btn btn-ghost', z.name === S.activeZone ? '已展开' : '查看记录'));
      btn.type = 'button'; btn.disabled = z.name === S.activeZone;
      on(btn, function () { selectZone(z.name); });
    });
  }
  function selectZone(name) {
    S.activeZone = name; paintZones(); loadRecords(name);
  }

  // ---- ④ 区域记录（只读）----
  function paintRecords() {
    if (!S.recordsHost) return;
    S.recordsHost.textContent = '';
    if (!S.activeZone) {
      S.recordsMeta.textContent = '';
      S.recordsHost.appendChild(emptyBlock('先在上面「区域」表里点「查看记录」，这里会列出该区域的记录（只读）。'));
      return;
    }
    S.recordsMeta.textContent = S.activeZone + (S.recordsMeta0 ? ' · ' + S.recordsMeta0 : '');
    if (S.recordsError) { S.recordsHost.appendChild(notice('记录读取失败：' + S.recordsError, 'fail')); return; }
    if (!S.recordsLoaded) { add(S.recordsHost, el('div', 'dns-loading', '正在读取 ' + S.activeZone + ' 的记录…')); return; }
    if (!S.records.length) {
      S.recordsHost.appendChild(emptyBlock('这个区域里没有读到记录。区域文件可能只有 SOA/NS，或路径配置不对。', '打开 DNS 设置', openConfig));
      return;
    }
    if (S.recordsTruncated) {
      S.recordsHost.appendChild(notice('记录较多，只显示前 ' + S.records.length + ' 条（单次上限 500 条）。', 'warn'));
    }
    var wrap = add(S.recordsHost, el('div', 'dns-table-wrap'));
    var table = add(wrap, el('table', 'dns-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['类型', '名称', 'TTL', '值'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.records.forEach(function (r) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', 'dns-mono', r.type || '—')).setAttribute('data-label', '类型');
      add(tr, el('td', 'dns-mono', r.name || '—')).setAttribute('data-label', '名称');
      add(tr, el('td', 'dns-num', (r.ttl || 0) + ' 秒')).setAttribute('data-label', 'TTL');
      add(tr, el('td', 'dns-value', r.value || '—')).setAttribute('data-label', '值');
    });
    var hint = add(S.recordsHost, el('p', 'field-hint',
      '只读视图：增删改记录走 BIND9 动态更新，需要先在「DNS 设置」里配好 TSIG 密钥，本页不提供编辑入口。'));
    hint.setAttribute('role', 'note');
  }

  // ---- 加载 ----
  function loadStatus() {
    S.statusError = ''; S.statusCode = ''; S.statusHint = ''; paintStatus();
    invoke('dns.status', {}).then(function (d) {
      if (S.destroyed) return; S.status = d; paintStatus();
    }, function (err) {
      if (S.destroyed) return;
      S.statusError = err.message; S.statusCode = err.code || ''; S.statusHint = err.hint || '';
      paintStatus();
    });
  }
  function loadZones() {
    S.zonesLoaded = false; S.zonesError = ''; S.zonesCode = ''; paintZones();
    invoke('dns.zones', {}).then(function (d) {
      if (S.destroyed) return;
      S.zones = (d && d.zones) || []; S.zonesWarnings = (d && d.warnings) || [];
      S.zonesLoaded = true; paintZones();
      if (!S.activeZone && S.zones.length && S.zones[0].readable) selectZone(S.zones[0].name);
    }, function (err) {
      if (S.destroyed) return;
      S.zonesError = err.message; S.zonesCode = err.code || ''; S.zonesHint = err.hint || '';
      S.zonesLoaded = true; paintZones();
    });
  }
  function loadRecords(zone) {
    S.records = []; S.recordsLoaded = false; S.recordsError = ''; S.recordsTruncated = false; paintRecords();
    invoke('dns.records', { zone: zone }).then(function (d) {
      if (S.destroyed) return;
      S.records = (d && d.records) || [];
      S.recordsTruncated = !!(d && d.truncated);
      S.recordsMeta0 = d && d.engine ? engineText(d.engine) : '';
      S.recordsLoaded = true; paintRecords();
    }, function (err) {
      if (S.destroyed) return;
      S.recordsError = failureText(err, '读取记录'); S.recordsLoaded = true; paintRecords();
    });
  }
  function refreshAll() { loadStatus(); loadZones(); }

  function injectCSS() {
    if (document.getElementById('kore-dns-css')) return;
    var css = [
      '.dns-loading{padding:var(--kore-space-3) var(--kore-space-4);color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.dns-status-top{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.dns-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) var(--kore-space-4);}',
      '.dns-cell{display:flex;flex-direction:column;gap:2px;min-width:0;padding:var(--kore-space-2) var(--kore-space-3);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);}',
      '.dns-cell-label{color:var(--kore-text-3);font-size:var(--kore-font-12);word-break:break-word;}',
      '.dns-cell-value{font-size:var(--kore-font-14);word-break:break-word;}',
      '.dns-callout{margin:0 var(--kore-space-4) var(--kore-space-3);padding:var(--kore-space-3);border-radius:var(--kore-radius-control);}',
      '.dns-callout-warn{color:var(--kore-text-1);background:var(--kore-warning-bg);border:1px solid var(--kore-warning);border-left:3px solid var(--kore-warning);}',
      '.dns-callout-title{margin-bottom:var(--kore-space-1);color:var(--kore-warning);font-weight:600;font-size:var(--kore-font-13);}',
      '.dns-callout-text{margin:0 0 var(--kore-space-1);color:var(--kore-text-2);font-size:var(--kore-font-13);word-break:break-word;}',
      '.dns-details{margin:var(--kore-space-2) var(--kore-space-4) var(--kore-space-3);color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.dns-details summary{cursor:pointer;}',
      '.dns-engine-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-1) 0;}',
      '.dns-cmd{margin:var(--kore-space-1) 0;padding:var(--kore-space-2) var(--kore-space-3);overflow-x:auto;color:var(--kore-term-cyan);background:var(--kore-bg-0);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.dns-link{color:var(--kore-info);}',
      '.dns-form{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:var(--kore-space-3);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.dns-form-ops{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);}',
      '.dns-msg{min-height:18px;color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.dns-q-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.dns-table-wrap{overflow-x:auto;}',
      '.dns-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-13);}',
      '.dns-table thead th{text-align:left;padding:var(--kore-space-2) var(--kore-space-3);color:var(--kore-text-2);font-size:var(--kore-font-12);font-weight:400;border-bottom:1px solid var(--kore-border-2);white-space:nowrap;}',
      '.dns-table tbody tr + tr{border-top:1px solid var(--kore-border-2);}',
      '.dns-table tbody tr.is-active{background:var(--kore-bg-2);}',
      '.dns-table td{padding:var(--kore-space-2) var(--kore-space-3);vertical-align:top;word-break:break-word;}',
      '.dns-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.dns-num{font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.dns-value{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);word-break:break-all;}',
      '.dns-ops{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);}',
      '.dns-empty{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-4);color:var(--kore-text-3);font-size:var(--kore-font-13);}',
      '.dns-empty span{flex:1 1 260px;}',
      '@media (max-width:639px){',
      '.dns-grid,.dns-form{grid-template-columns:1fr;}',
      '.dns-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}',
      '.dns-table,.dns-table tbody,.dns-table tr,.dns-table td{display:block;width:100%;}',
      '.dns-table tr{padding:var(--kore-space-2) 0 var(--kore-space-3);border-top:1px solid var(--kore-border-2);}',
      '.dns-table td{display:flex;gap:var(--kore-space-3);padding:var(--kore-space-1) var(--kore-space-4);}',
      '.dns-table td::before{content:attr(data-label);flex:0 0 72px;color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '}'
    ].join('\n');
    var style = el('style', null, css); style.id = 'kore-dns-css';
    document.head.appendChild(style);
  }

  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    injectCSS();
    S.root = add(container, el('section', 'dns'));
    var head = add(S.root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', 'DNS 解析'));
    add(head, el('p', 'view-sub', '查看本机 DNS 服务与区域记录，并直接查询任意域名的解析结果。'));

    // ① 状态
    var status = panel('解析状态', '只读探测，跟随宿主已装的 DNS 服务');
    add(S.root, status.panel);
    var sOps = add(status.meta, el('div', 'actions'));
    var cfg = add(sOps, el('button', 'btn btn-ghost', 'DNS 设置')); cfg.type = 'button'; on(cfg, openConfig);
    var rf = add(sOps, el('button', 'btn btn-ghost', '刷新')); rf.type = 'button'; on(rf, refreshAll);
    S.statusHost = add(status.panel, el('div', 'dns-status'));

    // ② 即时查询
    var query = panel('即时查询', '不需要先配区域，直接问任意域名');
    add(S.root, query.panel); S.queryPanel = query.panel;
    var form = add(query.panel, el('div', 'dns-form'));
    S.qNameInput = el('input', 'field-input'); S.qNameInput.type = 'text';
    S.qNameInput.placeholder = 'example.com 或 www.example.com'; S.qNameInput.maxLength = 253;
    S.qNameInput.setAttribute('autocomplete', 'off'); S.qNameInput.setAttribute('spellcheck', 'false');
    S.qTypeSel = el('select', 'field-input');
    TYPES.forEach(function (t) {
      var o = el('option', null, t + ' · ' + TYPE_HINT[t]); o.value = t; S.qTypeSel.appendChild(o);
    });
    S.qTypeSel.value = 'A';
    var nameField = add(form, el('label', 'field'));
    add(nameField, el('span', 'field-label', '域名')); add(nameField, S.qNameInput);
    var typeField = add(form, el('label', 'field'));
    add(typeField, el('span', 'field-label', '查询类型')); add(typeField, S.qTypeSel);
    var qOps = add(form, el('div', 'dns-form-ops'));
    S.qBtn = add(qOps, el('button', 'btn btn-primary', '查询')); S.qBtn.type = 'button'; on(S.qBtn, submitQuery);
    S.qMsgHost = add(qOps, el('span', 'dns-msg', ''));
    on(S.qNameInput, function (e) { if (e.key === 'Enter') submitQuery(); }, 'keydown');
    on(S.qTypeSel, function () { S.qType = S.qTypeSel.value; }, 'change');
    S.queryHost = add(query.panel, el('div', 'dns-query'));

    // ③ 区域
    var zones = panel('区域列表', '');
    add(S.root, zones.panel); S.zonesPanel = zones.panel;
    S.zonesMeta = add(zones.meta, el('span', null, ''));
    S.zonesHost = add(zones.panel, el('div', 'dns-zones'));

    // ④ 记录
    var records = panel('区域记录（只读）', '');
    add(S.root, records.panel); S.recordsPanel = records.panel;
    S.recordsMeta = add(records.meta, el('span', null, ''));
    S.recordsHost = add(records.panel, el('div', 'dns-records'));

    S.qType = 'A';
    paintStatus(); paintZones(); paintRecords(); paintQuery(); paintQueryMsg();
    refreshAll();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreDns = { render: render };
})();
