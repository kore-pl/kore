/* kore 主壳 · DNS 解析（web/dns.js）——零框架 / 零 CDN / 无外链。
   调用形态（硬约束，docs/FRONTEND.md §业务方法调用形态）：POST /api/v1/invoke/dns/dns.<action>，
   方法名必须带域前缀。读：dns.status / dns.zones / dns.records / dns.query；
   写：dns.record.add / record.update / record.delete（bind9 RFC 2136 动态更新，零 root；
   需一次性配好 TSIG 密钥），dns.reload（手工改过 zone 文件后重载，非记录写入所需）。
   三种降级：没有 DNS 服务（E_NO_ENGINE）/ 区域文件读不到（E_NEED_ROOT）/ 插件未安装（E_NOTFOUND）。
   本页不轮询：状态与列表都是用户触发或进页时各查一次。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/dns/', TIMEOUT_MS = 12000;
  var RUNBOOK_PRIV = 'docs/RUNBOOK.md';
  // 类型预设：覆盖日常 90% 的查询，不让人记类型表。
  var TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
  // 可写类型比可查询类型少 NS（区域结构记录，改错会破坏整个区域）；SRV 可写但不常查。
  var WRITE_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV'];
  var TYPE_HINT = {
    A: 'IPv4 地址', AAAA: 'IPv6 地址', CNAME: '别名指向', MX: '邮件服务器',
    TXT: '文本记录（SPF / 校验）', NS: '权威域名服务器', SRV: '服务定位'
  };
  var WRITE_VALUE_HINT = {
    A: '例如 192.0.2.10（IPv4 地址）',
    AAAA: '例如 2001:db8::10（IPv6 地址）',
    CNAME: '例如 target.example.com（域名）',
    MX: '例如 10 mail.example.com（优先级 空格 域名）',
    TXT: '例如 v=spf1 -all（文本内容）',
    SRV: '例如 0 5 443 srv.example.com（优先级 权重 端口 目标）'
  };

  function fresh() {
    return { root: null, status: null, statusError: '', statusCode: '', statusHint: '',
      zones: [], zonesLoaded: false, zonesError: '', zonesCode: '', zonesHint: '', zonesWarnings: [],
      activeZone: '', records: [], recordsMeta: null, recordsLoaded: false, recordsError: '', recordsTruncated: false,
      qName: '', qType: 'A', qBusy: false, qResult: null, qError: '', qMsg: '',
      wMode: 'add', wOldValue: '', wBusy: false, wMsg: '', wTone: '', wConfirm: null,
      reloadBusy: false, reloadMsg: '', reloadTone: '',
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
        var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '），请刷新页面后重试；如果反复失败，检查网络连接后重新登录'));
        err.code = data.code || ''; err.detail = data.detail || ''; err.hint = data.hint || ''; err.status = res.status; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒），请检查网络后点「刷新」重试');
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
  // 错误文案唯一来源是主壳 KoreUI.failureOf（web/app.js 的 ERROR_VIEW 映射表）。
  // 未收录的 code 原样回退本视图既有通用文案，保证映射表没跟上时不会空白 / undefined。
  function errorView(err) {
    var f = window.KoreUI && window.KoreUI.failureOf ? window.KoreUI.failureOf(err) : null;
    if (!f || !f.mapped) {
      return { mapped: false, title: '', action: '', detail: String((err && err.message) || err || '') };
    }
    return f;
  }
  function failureText(err, verb) {
    if (!err) return verb + '失败';
    var f = errorView(err);
    if (f.mapped) return f.title; // 同一 code 在任何页面都是这一句
    return verb + '失败：' + (err.message || '原因未知') + (err.hint ? '，' + err.hint : '') + '。请点「刷新」重试，反复失败时打开「DNS 设置」检查配置';
  }
  // failureBlock：状态 / 列表级错误卡片（统一标题 + 可执行下一步 + 原始错误折叠）。
  function failureBlock(err, cmd) {
    var f = errorView(err), box = el('div', 'dns-callout dns-callout-warn');
    box.setAttribute('role', 'status');
    add(box, el('div', 'dns-callout-title', f.mapped ? f.title : '操作失败'));
    add(box, el('p', 'dns-callout-text', f.mapped
      ? f.action
      : '原因：' + ((err && err.message) || '原因未知') + (err && err.hint ? '，' + err.hint : '') + '。请点「刷新」重试，反复失败时打开「DNS 设置」检查配置'));
    if (cmd) add(box, el('pre', 'dns-cmd', cmd));
    var raw = (err && err.message) ? String(err.message) : '';
    if (raw) {
      var details = add(box, el('details', 'dns-details'));
      add(details, el('summary', null, '查看原始错误'));
      add(details, el('pre', null, raw));
    }
    var p = add(box, el('p', 'dns-callout-text'));
    var a = add(p, el('a', 'dns-link', '查看运行手册'));
    a.href = RUNBOOK_PRIV; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return box;
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function notice(text, tone) {
    var cls = 'notice' + (tone === 'ok' ? ' dns-notice-ok' : '');
    var n = el('div', cls, text); n.setAttribute('role', 'alert'); return n;
  }
  // 写操作失败：后端 E_UNSUPPORTED / E_NEED_ROOT 自带「怎么办」hint，优先展示给用户。
  function writeFailure(err, verb) {
    if (!err) return verb + '失败，请点「刷新」后重试';
    var f = errorView(err);
    if (f.mapped) return f.title + (f.action ? '：' + f.action : '');
    var detailHint = (err.detail && typeof err.detail === 'object' && err.detail.hint) ? err.detail.hint : '';
    var h = (err.hint || '') + (detailHint ? ' ' + detailHint : '');
    return verb + '失败：' + (err.message || '原因未知') + (h ? '。' + h : '') + '。修好后点「刷新」核对记录';
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
      add(d, el('summary', null, '查看原始提示（排障用）'));
      add(d, el('p', 'dns-callout-text', hint));
    }
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
        var missing = errorView({ code: S.statusCode, message: S.statusError, hint: S.statusHint });
        S.statusHost.appendChild(emptyBlock(missing.mapped ? missing.title + '：' + missing.action
          : '还没有安装 DNS 插件（页面先把「怎么装」给你，不留空白）。',
          '去软件商店安装', goStore));
      } else {
        S.statusHost.appendChild(failureBlock({ code: S.statusCode, message: S.statusError, hint: S.statusHint },
          S.statusCode === 'E_NEED_ROOT' ? 'sudo systemctl restart kore' : ''));
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
        ['Kore 面板不内置 DNS 服务：装了本插件也只是「读现有服务 + 真实查询」。要托管区域或本机解析，' +
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
    [S.queryPanel, S.zonesPanel, S.recordsPanel, S.writePanel].forEach(function (p) { if (p) p.hidden = flag; });
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
      S.zonesHost.appendChild(failureBlock({ code: S.zonesCode, message: S.zonesError, hint: S.zonesHint },
        S.zonesCode === 'E_NEED_ROOT' ? 'sudo systemctl restart kore' : ''));
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
    S.activeZone = name;
    if (S.wZoneInput) S.wZoneInput.value = name;
    if (S.wZoneAuto) S.wZoneAuto.textContent = '已从上方区域自动填入';
    paintZones(); loadRecords(name); paintWriteMsg();
  }

  // ---- ④ 区域记录（只读）----
  function paintRecords() {
    if (!S.recordsHost) return;
    S.recordsHost.textContent = '';
    if (!S.activeZone) {
      S.recordsMeta.textContent = '';
      S.recordsHost.appendChild(emptyBlock('先在上面「区域」表里点「查看记录」，这里会列出该区域的记录；点每条记录的按钮可改值或删除。'));
      return;
    }
    S.recordsMeta.textContent = S.activeZone + (S.recordsMeta0 ? ' · ' + S.recordsMeta0 : '');
    if (S.recordsError) { S.recordsHost.appendChild(notice('记录读取失败：' + S.recordsError + '。请点「刷新」重试，或打开「DNS 设置」检查区域文件路径', 'fail')); return; }
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
    // 每条记录提供「改值 / 删除」快捷入口：点一下把下方表单填好，减少手抄出错。
    var ops = add(S.recordsHost, el('div', 'dns-record-ops'));
    add(ops, el('span', 'field-hint', '点记录上的按钮可把下方表单自动填好；写入走 BIND9 动态更新，立即生效、无需 reload。'));
    S.records.forEach(function (r) {
      if (r.type === 'NS' || r.type === 'SOA') return; // 区域结构记录不可写，不给按钮误导
      var bar = add(ops, el('div', 'dns-record-bar'));
      add(bar, el('span', 'dns-mono', r.type + ' ' + (r.name || '—') + ' → ' + (r.value || '—')));
      var eb = add(bar, el('button', 'btn btn-ghost', '改值')); eb.type = 'button';
      on(eb, function () { fillWriteForm('update', r); });
      var db = add(bar, el('button', 'btn btn-ghost', '删除')); db.type = 'button';
      on(db, function () { fillWriteForm('delete', r); });
    });
  }

  // ---- ⑤ 记录写入（BIND9 动态更新，零 root）----
  function paintWriteMsg() {
    if (!S.wMsgHost) return;
    S.wMsgHost.textContent = S.wMsg || '';
    S.wMsgHost.className = 'dns-msg' + (S.wTone === 'ok' ? ' dns-msg-ok' : (S.wTone === 'fail' ? ' dns-msg-fail' : ''));
    var box = S.wConfirmHost;
    if (!box) return;
    box.textContent = '';
    if (!S.wConfirm) return;
    var p = add(box, el('p', 'dns-callout-text',
      '确认' + (S.wConfirm.op === 'delete' ? '删除' : (S.wConfirm.op === 'update' ? '修改' : '新增')) +
      '记录：' + S.wConfirm.type + ' ' + S.wConfirm.name + (S.wConfirm.op === 'delete' ? '' : ' → ' + S.wConfirm.value) +
      '（区域 ' + S.wConfirm.zone + '）。删除/覆盖已有值不可直接撤销，确认无误后再点。'));
    var yes = add(p, el('button', 'btn btn-primary', '确认写入')); yes.type = 'button'; on(yes, function () { doWrite(S.wConfirm); });
    var no = add(p, el('button', 'btn btn-ghost', '取消')); no.type = 'button'; on(no, function () { S.wConfirm = null; paintWriteMsg(); });
  }
  function fillWriteForm(op, r) {
    if (!S.wNameInput) return;
    S.wMode = op; S.wTypeSel.value = WRITE_TYPES.indexOf(r.type) >= 0 ? r.type : 'A';
    S.wNameInput.value = r.name || ''; S.wValueInput.value = r.value || '';
    S.wOldInput.value = r.value || ''; S.wTtlInput.value = r.ttl || '';
    S.wZoneInput.value = S.activeZone || '';
    syncWriteMode();
    S.wConfirm = null; S.wMsg = '已填入 ' + (r.name || '') + ' 的记录，核对后点「' +
      (op === 'delete' ? '删除记录' : '保存修改') + '」'; S.wTone = ''; paintWriteMsg();
    if (S.writePanel && S.writePanel.scrollIntoView) S.writePanel.scrollIntoView({ block: 'nearest' });
  }
  function syncWriteMode() {
    var op = S.wMode;
    var isDel = op === 'delete';
    if (S.wOpSel) S.wOpSel.value = op;
    if (S.wValueField) S.wValueField.hidden = isDel;
    if (S.wOldField) S.wOldField.hidden = op !== 'update';
    if (S.wSaveBtn) S.wSaveBtn.textContent = isDel ? '删除记录' : (op === 'update' ? '保存修改' : '新增记录');
    if (S.wValueHint) S.wValueHint.textContent = WRITE_VALUE_HINT[S.wTypeSel.value] || '请按所选类型填写记录值';
  }
  function submitWrite() {
    if (S.wBusy) return;
    var zone = (S.wZoneInput.value || '').trim().replace(/^\.+/, '').toLowerCase();
    var name = (S.wNameInput.value || '').trim().replace(/^\.+/, '').toLowerCase();
    var type = S.wTypeSel.value;
    var value = (S.wValueInput.value || '').trim();
    var oldValue = (S.wOldInput.value || '').trim();
    var ttl = parseInt(S.wTtlInput.value, 10); if (!isFinite(ttl) || ttl < 0) ttl = 0;
    if (!zone || !/^[a-z0-9._-]+$/.test(zone)) { S.wMsg = '请填区域名（例如 example.com，可在上方「区域」表点「查看记录」自动填入）'; S.wTone = 'fail'; S.wZoneInput.focus(); paintWriteMsg(); return; }
    if (!name || !/^[a-z0-9._*-]+$/.test(name)) { S.wMsg = '请填完整记录名（例如 www.example.com，只能含小写字母、数字、点、连字符、星号）'; S.wTone = 'fail'; S.wNameInput.focus(); paintWriteMsg(); return; }
    if (name !== zone && name.slice(-(zone.length + 1)) !== '.' + zone) { S.wMsg = '记录名必须属于区域 ' + zone + '：请以 .' + zone + ' 结尾，或等于区域名本身'; S.wTone = 'fail'; S.wNameInput.focus(); paintWriteMsg(); return; }
    if (S.wMode !== 'delete' && !value) { S.wMsg = '请填记录值：' + (WRITE_VALUE_HINT[type] || '按所选类型填写'); S.wTone = 'fail'; S.wValueInput.focus(); paintWriteMsg(); return; }
    S.wConfirm = { op: S.wMode, zone: zone, name: name, type: type, value: value, old_value: oldValue, ttl: ttl };
    S.wMsg = ''; S.wTone = ''; paintWriteMsg();
  }
  function doWrite(p) {
    if (S.wBusy) return;
    var method = p.op === 'add' ? 'dns.record.add' : (p.op === 'update' ? 'dns.record.update' : 'dns.record.delete');
    var params = { zone: p.zone, name: p.name, type: p.type };
    if (p.op !== 'delete') params.value = p.value;
    if (p.op === 'update' && p.old_value) params.old_value = p.old_value;
    if (p.op !== 'delete' && p.ttl) params.ttl = p.ttl;
    S.wBusy = true; S.wSaveBtn.disabled = true; S.dBtn.disabled = true;
    S.wConfirm = null; S.wMsg = '正在' + (p.op === 'delete' ? '删除' : '写入') + ' ' + p.type + ' ' + p.name + '…'; S.wTone = ''; paintWriteMsg();
    invoke(method, params).then(function (d) {
      if (S.destroyed) return;
      S.wBusy = false; S.wSaveBtn.disabled = false; S.dBtn.disabled = false;
      var extra = [];
      if (d && d.changed === false) extra.push('目标已是该值（未重复写入）');
      if (d && d.verified) extra.push('已回读确认生效');
      if (d && d.rolled_back) extra.push('校验失败已自动回滚，请点「刷新」核对');
      if (d && d.reload_required) extra.push('需要重载服务才生效');
      S.wMsg = '已' + (p.op === 'delete' ? '删除' : '写入') + '记录 ' + p.type + ' ' + p.name +
        (extra.length ? '（' + extra.join('；') + '）' : '') + '。';
      S.wTone = (d && d.rolled_back) ? 'fail' : 'ok';
      paintWriteMsg(); loadRecords(p.zone);
    }, function (err) {
      if (S.destroyed) return;
      S.wBusy = false; S.wSaveBtn.disabled = false; S.dBtn.disabled = false;
      S.wMsg = writeFailure(err, p.op === 'delete' ? '删除' : '写入'); S.wTone = 'fail'; paintWriteMsg();
    });
  }
  function paintReload() {
    if (!S.reloadMsgHost) return;
    S.reloadMsgHost.textContent = S.reloadMsg || '';
    S.reloadMsgHost.className = 'dns-msg' + (S.reloadTone === 'ok' ? ' dns-msg-ok' : (S.reloadTone === 'fail' ? ' dns-msg-fail' : ''));
  }
  function submitReload() {
    if (S.reloadBusy) return;
    var zone = (S.reloadZoneInput.value || '').trim().replace(/^\.+/, '').toLowerCase();
    var params = zone ? { zone: zone } : {};
    S.reloadBusy = true; S.reloadBtn.disabled = true;
    S.reloadMsg = zone ? '正在重载区域 ' + zone + '…' : '正在重载 DNS 服务…'; S.reloadTone = ''; paintReload();
    invoke('dns.reload', params).then(function (d) {
      if (S.destroyed) return;
      S.reloadBusy = false; S.reloadBtn.disabled = false;
      if (d && d.reload_required) {
        S.reloadMsg = '插件不启停宿主服务：请在服务器上执行 ' + (d.command || '对应服务的重载命令') + ' 后点「刷新」';
        S.reloadTone = 'warn';
      } else {
        S.reloadMsg = '已重载' + (d && d.engine ? '（' + engineText(d.engine) + '）' : '') +
          (d && d.command ? '：' + d.command : '') + '。记录写入不需要这一步，只有手工改过区域文件才需要。';
        S.reloadTone = 'ok';
      }
      paintReload();
    }, function (err) {
      if (S.destroyed) return;
      S.reloadBusy = false; S.reloadBtn.disabled = false;
      S.reloadMsg = writeFailure(err, '重载'); S.reloadTone = 'fail'; paintReload();
    });
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
    S.records = []; S.recordsLoaded = false; S.recordsError = ''; S.recordsTruncated = false;
    S.wConfirm = null; paintRecords();
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
      '.dns-msg-ok{color:var(--kore-success);}',
      '.dns-msg-fail{color:var(--kore-danger);}',
      '.dns-notice-ok{color:var(--kore-success);}',
      '.dns-record-ops{display:flex;flex-direction:column;gap:var(--kore-space-1);padding:0 var(--kore-space-4) var(--kore-space-3);}',
      '.dns-record-bar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);}',
      '.dns-record-bar .dns-mono{flex:1 1 260px;color:var(--kore-text-2);}',
      '.dns-write-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--kore-space-3);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.dns-write-ops{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);}',
      '.dns-confirm{margin:0 var(--kore-space-4) var(--kore-space-3);padding:var(--kore-space-3);border:1px solid var(--kore-warning);border-left:3px solid var(--kore-warning);border-radius:var(--kore-radius-control);background:var(--kore-warning-bg);}',
      '.dns-confirm p{margin:0 0 var(--kore-space-2);color:var(--kore-text-1);font-size:var(--kore-font-13);}',
      '.dns-write-note{margin:var(--kore-space-2) var(--kore-space-4) var(--kore-space-3);}',
      '.dns-reload-form{display:flex;flex-wrap:wrap;align-items:end;gap:var(--kore-space-3);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.dns-reload-form .field{flex:1 1 240px;}',
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
      '.dns-grid,.dns-form,.dns-write-form{grid-template-columns:1fr;}',
      '.dns .panel-head{flex-wrap:wrap;row-gap:var(--kore-space-1);}',
      '.dns .panel-meta{white-space:normal;}',
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
    var status = panel('解析状态', '只读探测');
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
    var records = panel('区域记录', '点击记录可把下方表单自动填好');
    add(S.root, records.panel); S.recordsPanel = records.panel;
    S.recordsMeta = add(records.meta, el('span', null, ''));
    S.recordsHost = add(records.panel, el('div', 'dns-records'));

    // ⑤ 写记录（bind9 动态更新）
    var write = panel('增删记录', 'BIND9 动态更新 · 立即生效 · 无需 reload');
    add(S.root, write.panel); S.writePanel = write.panel;
    var wform = add(write.panel, el('div', 'dns-write-form'));
    S.wZoneInput = el('input', 'field-input'); S.wZoneInput.type = 'text';
    S.wZoneInput.placeholder = 'example.com'; S.wZoneInput.setAttribute('autocomplete', 'off');
    var zoneField = add(wform, el('label', 'field'));
    add(zoneField, el('span', 'field-label', '区域')); add(zoneField, S.wZoneInput);
    S.wZoneAuto = add(zoneField, el('span', 'field-hint', '选择区域后自动填入，可手改'));
    S.wNameInput = el('input', 'field-input'); S.wNameInput.type = 'text';
    S.wNameInput.placeholder = 'www.example.com'; S.wNameInput.setAttribute('autocomplete', 'off');
    var nameField = add(wform, el('label', 'field'));
    add(nameField, el('span', 'field-label', '记录名')); add(nameField, S.wNameInput);
    S.wTypeSel = el('select', 'field-input');
    WRITE_TYPES.forEach(function (t) {
      var o = el('option', null, t + ' · ' + (TYPE_HINT[t] || t)); o.value = t; S.wTypeSel.appendChild(o);
    });
    S.wTypeSel.value = 'A';
    var typeField = add(wform, el('label', 'field'));
    add(typeField, el('span', 'field-label', '类型')); add(typeField, S.wTypeSel);
    S.wValueInput = el('input', 'field-input'); S.wValueInput.type = 'text';
    S.wValueInput.setAttribute('autocomplete', 'off');
    S.wValueField = add(wform, el('label', 'field'));
    add(S.wValueField, el('span', 'field-label', '记录值')); add(S.wValueField, S.wValueInput);
    S.wValueHint = add(S.wValueField, el('span', 'field-hint', WRITE_VALUE_HINT.A));
    S.wOldInput = el('input', 'field-input'); S.wOldInput.type = 'text';
    S.wOldInput.placeholder = '留空则用快照旧值作前置条件';
    S.wOldField = add(wform, el('label', 'field'));
    add(S.wOldField, el('span', 'field-label', '旧值（改记录时可选）')); add(S.wOldField, S.wOldInput);
    S.wTtlInput = el('input', 'field-input'); S.wTtlInput.type = 'number';
    S.wTtlInput.min = '0'; S.wTtlInput.max = '86400'; S.wTtlInput.value = '300';
    var ttlField = add(wform, el('label', 'field'));
    add(ttlField, el('span', 'field-label', 'TTL（秒，0=默认）')); add(ttlField, S.wTtlInput);
    S.wOpSel = el('select', 'field-input');
    [['add', '新增记录'], ['update', '修改记录'], ['delete', '删除记录']].forEach(function (pair) {
      var o = el('option', null, pair[1]); o.value = pair[0]; S.wOpSel.appendChild(o);
    });
    var opField = add(wform, el('label', 'field'));
    add(opField, el('span', 'field-label', '操作')); add(opField, S.wOpSel);
    on(S.wOpSel, function () { S.wMode = S.wOpSel.value; syncWriteMode(); }, 'change');
    on(S.wTypeSel, function () { syncWriteMode(); }, 'change');
    var wOps = add(wform, el('div', 'dns-write-ops'));
    S.wSaveBtn = add(wOps, el('button', 'btn btn-primary', '新增记录')); S.wSaveBtn.type = 'button'; on(S.wSaveBtn, submitWrite);
    S.dBtn = add(wOps, el('button', 'btn btn-ghost', '删除记录')); S.dBtn.type = 'button';
    on(S.dBtn, function () { S.wMode = 'delete'; syncWriteMode(); submitWrite(); });
    S.wMsgHost = add(wOps, el('span', 'dns-msg', ''));
    S.wConfirmHost = add(write.panel, el('div', ''));
    on(S.wNameInput, function (e) { if (e.key === 'Enter') submitWrite(); }, 'keydown');
    var wPrereq = add(write.panel, el('p', 'field-hint dns-write-note',
      '首次使用需一次性配置：bind9 区域开启 allow-update，生成 TSIG 密钥并让 kore 用户可读，' +
      '在「DNS 设置」填上密钥路径与权威服务器。写入不经 root、不改区域文件；失败会自动回滚。'));
    wPrereq.setAttribute('role', 'note');

    // ⑥ 重载（手工改 zone 文件后才需要；记录写入不走这里）
    var reload = panel('重新加载 DNS 服务', '只用于手工改过区域文件 / 配置之后');
    add(S.root, reload.panel);
    var rform = add(reload.panel, el('div', 'dns-reload-form'));
    S.reloadZoneInput = el('input', 'field-input'); S.reloadZoneInput.type = 'text';
    S.reloadZoneInput.placeholder = '留空 = 重载整个引擎'; S.reloadZoneInput.setAttribute('autocomplete', 'off');
    var rzField = add(rform, el('label', 'field'));
    add(rzField, el('span', 'field-label', '区域（可选）')); add(rzField, S.reloadZoneInput);
    S.reloadBtn = add(rform, el('button', 'btn btn-ghost', '重新加载')); S.reloadBtn.type = 'button'; on(S.reloadBtn, submitReload);
    S.reloadMsgHost = add(rform, el('span', 'dns-msg', ''));
    add(reload.panel, el('p', 'field-hint', '记录增删改立即生效，不需要重新加载。此按钮仅在你手工编辑过区域文件后使用。'));

    S.qType = 'A'; S.wMode = 'add';
    paintStatus(); paintZones(); paintRecords(); paintQuery(); paintQueryMsg(); paintWriteMsg(); paintReload();
    refreshAll();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreDns = { render: render };
})();
