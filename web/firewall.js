/* kore 主壳 · 防火墙（web/firewall.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/firewall/firewall.<action>（插件 id 与业务域名一致）。
   只读：firewall.status / firewall.rules；写：allowPort / denyPort / deleteRule。
   写操作两步走：先 dry_run=true 预览真实 argv，确认后再 dry_run=false 执行；
   available=false（非 root）时真实写按钮禁用，但保留只读状态与黄底说明。
   本页不启用/禁用防火墙，SSH 端口保护同时在前端提示与后端拒绝两层生效。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/firewall/', TIMEOUT_MS = 15000;
  function fresh() {
    return { root: null, status: null, statusError: '', rules: [], rulesError: '', rulesLoaded: false,
      canWrite: false, previewable: false, preview: null, pending: null, previewError: '', busy: false,
      deletePreview: null, deleteTarget: null, deleteError: '', notice: '', destroyed: false };
  }
  var S = fresh();
  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn) { n.addEventListener('click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    } return '';
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf'); if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token }, body: JSON.stringify(params || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + method, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('请求失败（HTTP ' + res.status + '）')));
        err.code = data.code || ''; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function notice(text, ok) {
    var n = el('div', 'db-notice' + (ok ? ' redis-notice-ok' : ''), text);
    n.setAttribute('role', 'alert'); return n;
  }
  function panel(title, metaText) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    return { panel: p, head: h, meta: add(h, el('span', 'panel-meta', metaText || '')) };
  }
  function fmtPort(v) { return v === '' || v === null || v === undefined ? 'any' : String(v); }
  function actionKls(a) { return a === 'allow' ? 'is-allow' : (a === 'deny' ? 'is-deny' : 'is-reject'); }
  function paintNotice() {
    if (!S.noticeHost) return;
    S.noticeHost.textContent = ''; if (S.notice) S.noticeHost.appendChild(notice(S.notice, true));
  }
  function paintStatus() {
    if (!S.statusHost) return;
    S.statusHost.textContent = '';
    if (S.statusError) { S.statusHost.appendChild(notice('状态读取失败：' + S.statusError)); return; }
    if (!S.status) { add(S.statusHost, el('div', 'muted fw-loading', '正在探测防火墙后端…')); return; }
    var st = S.status; S.canWrite = !!(st.available && st.backend === 'ufw'); S.previewable = st.backend === 'ufw';
    var box = add(S.statusHost, el('div', 'fw-status-body'));
    var top = add(box, el('div', 'fw-status-top'));
    add(top, el('span', 'fw-backend', st.backend || 'none'));
    top.appendChild(chip(st.available ? 'ok' : 'warn', st.available ? '状态可读' : '只读降级'));
    var grid = add(box, el('div', 'fw-stats'));
    [['启用状态', st.available ? (st.enabled ? '已启用' : '未启用') : '不可读'],
      ['默认入站', st.available ? (st.default_in || '—') : '不可读'],
      ['规则数', st.available ? String(st.rules_count) : '不可读']].forEach(function (item) {
      var cell = add(grid, el('div', 'fw-stat'));
      add(cell, el('span', 'fw-stat-label', item[0])); add(cell, el('span', 'fw-stat-value', item[1]));
    });
    if (!st.available) {
      var call = add(box, el('div', 'fw-callout-warn'));
      add(call, el('div', 'fw-callout-title', '当前环境无法读取防火墙状态'));
      add(call, el('p', 'fw-callout-text', '当前环境无法读取防火墙状态：' + (st.error || '原因未知') +
        '。防火墙管理需要 root 权限（kored 需以 root 运行或配置 systemd 权限）。'));
      var details = add(call, el('details', 'fw-details'));
      add(details, el('summary', null, '查看原始错误'));
      add(details, el('pre', null, st.error || '（无更多信息）'));
    }
    var can = S.canWrite;
    if (S.previewBtn) {
      S.previewBtn.disabled = !S.previewable;
      S.previewNote.textContent = S.previewable
        ? (can ? '预览只构造命令，确认后才真正执行。' : '没有 root 权限：可以预览命令，但无法真正执行。')
        : '当前没有 ufw 后端，无法预览或执行端口规则。';
    }
  }
  function paintRules() {
    if (!S.rulesHost) return;
    S.rulesHost.textContent = ''; S.rulesCount.textContent = S.rulesLoaded ? S.rules.length + ' 条' : '';
    if (S.rulesError) {
      S.rulesHost.appendChild(notice('读取规则失败：' + S.rulesError));
      add(S.rulesHost, el('div', 'panel-empty', '非 root 时 ufw 规则不可读，页面保留只读状态并禁用写操作。'));
      return;
    }
    if (!S.rulesLoaded) { add(S.rulesHost, el('div', 'muted fw-loading', '正在读取规则…')); return; }
    if (!S.rules.length) { add(S.rulesHost, el('div', 'panel-empty', '当前后端没有可展示的规则。')); return; }
    var scroll = add(S.rulesHost, el('div', 'fw-rules-scroll'));
    var table = add(scroll, el('table', 'fw-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['编号', '动作', '方向', '协议', '端口', '来源', '备注', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.rules.forEach(function (rule) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', 'fw-index', '#' + rule.index));
      add(tr, el('td', 'fw-action ' + actionKls(rule.action), rule.action || '—'));
      add(tr, el('td', null, rule.direction || 'in'));
      add(tr, el('td', null, rule.proto || 'any'));
      add(tr, el('td', 'fw-port', fmtPort(rule.port)));
      add(tr, el('td', 'fw-from', rule.from || '0.0.0.0/0'));
      add(tr, el('td', 'fw-comment', rule.comment || ''));
      var td = add(tr, el('td', 'fw-ops'));
      var del = add(td, el('button', 'btn fw-danger', '删除')); del.type = 'button';
      del.disabled = !S.canWrite;
      del.title = S.canWrite ? '先预览命令，确认后再删除' : '需要 root 权限且后端为 ufw';
      on(del, function () { startDelete(rule); });
    });
    paintDeleteConfirm();
  }
  function paintDeleteConfirm() {
    if (!S.deleteHost) return;
    S.deleteHost.textContent = '';
    if (S.deleteError) S.deleteHost.appendChild(notice('删除失败：' + S.deleteError));
    if (!S.deletePreview) return;
    var r = S.deleteTarget || {}, box = add(S.deleteHost, el('div', 'fw-preview fw-delete-confirm'));
    add(box, el('div', 'fw-preview-title', '将删除规则 #' + (r.index || '?') + '：' +
      (r.action || '') + ' ' + (r.direction || 'in') + ' ' + (r.proto || 'any') + '/' + fmtPort(r.port) +
      ' from ' + (r.from || '0.0.0.0/0')));
    add(box, el('pre', 'fw-cmd', (S.deletePreview.command || []).join(' ')));
    add(box, el('p', 'fw-preview-note', S.canWrite ? '预览模式，确认后执行删除；SSH 放行规则会被后端拒绝。'
      : '当前环境没有 root 权限，只能预览，无法执行删除。'));
    var ops = add(box, el('div', 'fw-ops'));
    var ok = add(ops, el('button', 'btn fw-danger', '确认删除')); ok.type = 'button'; ok.disabled = !S.canWrite;
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    on(cancel, function () { S.deletePreview = null; S.deleteTarget = null; S.deleteError = ''; paintDeleteConfirm(); });
    on(ok, function () { execDelete(ok); });
  }
  function startDelete(rule) {
    if (!S.canWrite) return;
    S.deleteError = ''; S.deletePreview = null; S.deleteTarget = rule;
    invoke('firewall.deleteRule', { index: rule.index, dry_run: true }).then(function (data) {
      if (S.destroyed) return;
      S.deletePreview = data; paintDeleteConfirm();
    }, function (err) {
      if (S.destroyed) return;
      S.deleteError = err.message; paintDeleteConfirm();
    });
  }
  function execDelete(btn) {
    if (!S.canWrite || S.busy) return;
    S.busy = true; btn.disabled = true;
    invoke('firewall.deleteRule', { index: S.deleteTarget.index, dry_run: false }).then(function (data) {
      if (S.destroyed) return;
      S.busy = false; S.notice = '已删除规则 #' + (S.deleteTarget ? S.deleteTarget.index : '') +
        '：' + (data.command || []).join(' ');
      S.deletePreview = null; S.deleteTarget = null; S.deleteError = '';
      paintNotice(); paintDeleteConfirm(); loadStatus(); loadRules();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.deleteError = err.message; paintDeleteConfirm();
    });
  }
  function formParams(dryRun) {
    var method = S.actionSel.value === 'deny' ? 'firewall.denyPort' : 'firewall.allowPort';
    var params = { port: Math.trunc(Number(S.portInput.value)), proto: S.protoSel.value,
      from: S.fromInput.value.trim() || 'any', dry_run: dryRun };
    if (method === 'firewall.allowPort') params.comment = S.commentInput.value.trim();
    return { method: method, params: params };
  }
  function paintPreview() {
    if (!S.previewHost) return;
    S.previewHost.textContent = '';
    if (S.previewError) S.previewHost.appendChild(notice(S.previewError));
    if (!S.preview) return;
    var box = add(S.previewHost, el('div', 'fw-preview'));
    add(box, el('div', 'fw-preview-title', '将执行的命令（预览，尚未执行）'));
    add(box, el('pre', 'fw-cmd', (S.preview.command || []).join(' ')));
    add(box, el('p', 'fw-preview-note', S.canWrite ? '确认后立即执行；后端拒绝原因会原样显示。'
      : '当前环境没有 root 权限，只能预览，无法执行。'));
    var ops = add(box, el('div', 'fw-ops'));
    var ok = add(ops, el('button', 'btn btn-primary', '确认执行')); ok.type = 'button'; ok.disabled = !S.canWrite;
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    on(cancel, function () { S.preview = null; S.pending = null; S.previewError = ''; paintPreview(); });
    on(ok, function () { execPreview(ok); });
  }
  function previewRule() {
    var port = Math.trunc(Number(S.portInput.value));
    if (!isFinite(port) || port < 1 || port > 65535) { S.previewError = '端口必须是 1–65535 的整数'; S.preview = null; paintPreview(); return; }
    var req = formParams(true);
    S.previewError = ''; S.preview = null; S.pending = { method: req.method, params: formParams(false).params };
    invoke(req.method, req.params).then(function (data) {
      if (S.destroyed) return;
      S.preview = data; paintPreview();
    }, function (err) {
      if (S.destroyed) return;
      S.previewError = err.message; S.pending = null; paintPreview();
    });
  }
  function execPreview(btn) {
    if (!S.canWrite || !S.pending || S.busy) return;
    S.busy = true; btn.disabled = true;
    invoke(S.pending.method, S.pending.params).then(function (data) {
      if (S.destroyed) return;
      S.busy = false; S.notice = '已执行：' + (data.command || []).join(' ');
      S.preview = null; S.pending = null; S.previewError = '';
      paintNotice(); paintPreview(); loadStatus(); loadRules();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.previewError = err.message; paintPreview();
    });
  }
  function updateSSH() {
    var port = Math.trunc(Number(S.portInput.value));
    S.sshWarn.hidden = port !== 22;
  }
  function loadStatus() {
    S.statusError = ''; paintStatus();
    invoke('firewall.status', {}).then(function (data) {
      if (S.destroyed) return;
      S.status = data; paintStatus();
    }, function (err) {
      if (S.destroyed) return;
      S.statusError = err.message; paintStatus();
    });
  }
  function loadRules() {
    S.rulesLoaded = false; S.rulesError = ''; paintRules();
    invoke('firewall.rules', {}).then(function (data) {
      if (S.destroyed) return;
      S.rules = data.rules || []; S.rulesLoaded = true; paintRules();
    }, function (err) {
      if (S.destroyed) return;
      S.rulesError = err.message; S.rulesLoaded = true; paintRules();
    });
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    S.root = add(container, el('section', 'fw'));
    var head = add(S.root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '防火墙'));
    add(head, el('p', 'view-sub', '查看后端与规则；放行/拒绝端口先预览真实命令，确认后再执行。'));
    S.noticeHost = add(S.root, el('div', 'redis-notice-host'));
    var status = panel('状态', ''); add(S.root, status.panel);
    var refresh = add(status.meta, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, function () { loadStatus(); loadRules(); });
    S.statusHost = add(status.panel, el('div', 'fw-status'));
    var rules = panel('规则（只读）', ''); add(S.root, rules.panel); S.rulesCount = add(rules.meta, el('span', null, ''));
    S.rulesHost = add(rules.panel, el('div', 'fw-rules')); S.deleteHost = add(rules.panel, el('div', 'fw-delete-host'));
    var formP = panel('添加规则', '先预览，再执行'); add(S.root, formP.panel);
    var form = add(formP.panel, el('div', 'fw-form'));
    S.actionSel = el('select', 'fw-select'); [['allow', '放行 (allow)'], ['deny', '拒绝 (deny)']].forEach(function (o) {
      var opt = el('option', null, o[1]); opt.value = o[0]; S.actionSel.appendChild(opt);
    });
    S.portInput = el('input', 'fw-input'); S.portInput.type = 'number'; S.portInput.min = '1'; S.portInput.max = '65535';
    S.portInput.placeholder = '18080'; S.protoSel = el('select', 'fw-select');
    [['tcp', 'tcp'], ['udp', 'udp']].forEach(function (o) { var opt = el('option', null, o[1]); opt.value = o[0]; S.protoSel.appendChild(opt); });
    S.fromInput = el('input', 'fw-input'); S.fromInput.value = 'any'; S.fromInput.placeholder = 'any / 10.0.0.0/8';
    S.commentInput = el('input', 'fw-input'); S.commentInput.placeholder = 'kore-web'; S.commentInput.maxLength = 64;
    [['动作', S.actionSel], ['端口', S.portInput], ['协议', S.protoSel], ['来源', S.fromInput], ['备注', S.commentInput]].forEach(function (f) {
      var label = el('label', 'fw-field'); add(label, el('span', 'fw-label', f[0])); add(label, f[1]); add(form, label);
    });
    S.sshWarn = add(form, el('div', 'fw-ssh-warn'));
    S.sshWarn.hidden = true;
    S.sshWarn.textContent = '屏蔽 SSH 端口会导致无法连接服务器，后端将拒绝此操作。';
    S.portInput.addEventListener('input', updateSSH); S.actionSel.addEventListener('change', updateSSH);
    var ops = add(formP.panel, el('div', 'fw-form-ops'));
    S.previewBtn = add(ops, el('button', 'btn btn-primary', '预览命令')); S.previewBtn.type = 'button';
    on(S.previewBtn, previewRule);
    S.previewNote = add(ops, el('span', 'fw-preview-hint', '预览只构造命令，确认后才真正执行。'));
    S.previewHost = add(formP.panel, el('div', 'fw-preview-host'));
    paintStatus(); paintRules(); paintPreview(); loadStatus(); loadRules();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreFirewall = { render: render };
})();
