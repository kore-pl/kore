/* kore 主壳 · 防火墙（web/firewall.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/firewall/firewall.<action>（插件 id 与业务域名一致）。
   只读：firewall.status / firewall.rules；写：allowPort / denyPort / deleteRule。
   写操作两步走：先 dry_run=true 预览真实 argv，确认后再 dry_run=false 执行；
   available=false（非 root）时真实写按钮禁用，但保留只读状态与黄底说明。
   本页不启用/禁用防火墙，SSH 端口保护同时在前端提示与后端拒绝两层生效。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/firewall/', TIMEOUT_MS = 15000;
  // 提权说明锚点：docs/RUNBOOK.md §5「以 root 启动 kored 与提权通道（ADR-0018）」。
  var RUNBOOK_PRIV = 'docs/RUNBOOK.md#5-以-root-启动-kored-与提权通道adr-0018';
  function fresh() {
    return { root: null, status: null, statusError: '', rules: [], rulesError: '', rulesErrorCode: '', rulesErrorHint: '',
      rulesLoaded: false, canWrite: false, previewable: false, formLocked: true, preview: null, pending: null, previewError: '', busy: false,
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
        err.code = data.code || ''; err.hint = data.hint || ''; err.status = res.status; throw err;
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
  // rootGuide：非 root 的折叠提权指引。默认收起，标题只讲「需要 root 权限」，
  // 原始错误放在二级折叠里——不把 ERROR: You need to be root 直接铺在页面上。
  function rootGuide(hint, raw) {
    var box = el('div', 'fw-callout-warn fw-root-guide');
    box.setAttribute('role', 'status');
    add(box, el('div', 'fw-callout-title', '防火墙管理需要 root 权限'));
    add(box, el('p', 'fw-callout-text',
      '当前 kored 以非 root 身份运行，读不到也改不了 ufw 规则。这是权限限制，不是登录失效，无需重新登录。'));
    var details = add(box, el('details', 'fw-details'));
    add(details, el('summary', null, '查看如何配置'));
    add(details, el('p', 'fw-callout-text', '在服务器上以 root 重启 kored，然后刷新本页：'));
    add(details, el('pre', 'fw-cmd', 'sudo systemctl restart kore'));
    add(details, el('p', 'fw-callout-text',
      'systemd 部署用上面的命令；开发态直接启动可用 sudo ./bin/kored serve --config <你的配置>。' +
      'Kore 不会给单个请求加 sudo，也不会让插件自己提权；root 动作经内核 root-action 通道代理（ADR-0018）。'));
    if (hint) add(details, el('p', 'fw-callout-text', '后端提示：' + hint));
    if (raw) {
      var more = add(details, el('details', 'fw-details'));
      add(more, el('summary', null, '查看原始错误'));
      add(more, el('pre', null, raw));
    }
    return box;
  }
  function fmtPort(v) { return v === '' || v === null || v === undefined ? 'any' : String(v); }
  function actionKls(a) { return a === 'allow' ? 'is-allow' : (a === 'deny' ? 'is-deny' : 'is-reject'); }
  function paintNotice() {
    if (!S.noticeHost) return;
    S.noticeHost.textContent = ''; if (S.notice) S.noticeHost.appendChild(notice(S.notice, true));
  }
  // 表单权限门控：没有 root（available=false）或后端不是 ufw 时，输入控件也必须禁用，
  // 只保留只读展示 + 提权指引——不允许"能填、点提交才报错"。
  function setFormLocked(locked) {
    S.formLocked = !!locked;
    [S.actionSel, S.portInput, S.protoSel, S.fromInput, S.commentInput].forEach(function (n) {
      if (n) n.disabled = S.formLocked;
    });
    if (S.previewBtn) S.previewBtn.disabled = S.formLocked || !S.previewable;
    if (S.previewNote) {
      S.previewNote.textContent = S.formLocked
        ? (S.canWrite ? '当前没有 ufw 后端：表单已禁用，仅保留只读展示。'
          : '没有 root 权限：表单已禁用，仅保留只读展示；提权后刷新本页即可编辑。')
        : '预览只构造命令，确认后才真正执行。';
    }
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
    // 开关不在本页：firewall 0.2.4 仅暴露 status/rules/allowPort/denyPort/deleteRule，
    // 没有 enable/disable 方法。按状态给可操作指引，不伪造一个点了必然失败的按钮。
    if (st.available && st.backend === 'ufw') {
      if (!st.enabled) {
        var off = add(box, el('div', 'fw-callout-warn'));
        add(off, el('div', 'fw-callout-title', '防火墙当前未启用，规则不会生效'));
        add(off, el('p', 'fw-callout-text',
          '在服务器上执行下面的命令启用；启用前请确认 SSH 端口（默认 22/tcp）已放行，否则启用后可能断开远程连接。'));
        add(off, el('pre', 'fw-cmd', 'sudo ufw enable'));
        add(off, el('p', 'fw-callout-text', '本页暂不提供一键启用/停用；操作完成后点「刷新」查看最新状态。'));
      } else {
        var offGuide = add(box, el('details', 'fw-details'));
        add(offGuide, el('summary', null, '如何停用防火墙'));
        add(offGuide, el('p', 'fw-callout-text', '停用会影响全机出入站，执行前请确认 SSH 端口已放行：'));
        add(offGuide, el('pre', 'fw-cmd', 'sudo ufw disable'));
        add(offGuide, el('p', 'fw-callout-text', '本页暂不提供一键开关；操作完成后点「刷新」查看最新状态。'));
      }
    }
    if (!st.available) {
      if (st.error_code === 'E_NEED_ROOT') {
        // root 缺失是权限限制，不是登录失效：只给一条折叠指引，不铺原始英文错误。
        add(box, rootGuide(st.hint, st.error));
      } else {
        var call = add(box, el('div', 'fw-callout-warn'));
        add(call, el('div', 'fw-callout-title', '当前环境无法读取防火墙状态'));
        var p = add(call, el('p', 'fw-callout-text', '当前环境无法读取防火墙状态：' + (st.error || '原因未知') +
          '。表单已禁用，仅保留只读展示；排除原因后刷新本页。 '));
        var guide = add(p, el('a', 'fw-perm-link', '查看运行手册'));
        guide.href = RUNBOOK_PRIV; guide.target = '_blank'; guide.rel = 'noopener noreferrer';
      }
    }
    var can = S.canWrite;
    // 状态说了算：能写才解锁表单，否则一律禁用（非 root 时不再让用户白填一遍）。
    setFormLocked(!can);
    if (S.previewBtn) {
      S.previewBtn.disabled = !S.previewable || !can;
      S.previewNote.textContent = S.formLocked
        ? (can ? '当前没有 ufw 后端：表单已禁用，仅保留只读展示。'
          : '没有 root 权限：表单已禁用，仅保留只读展示；提权后刷新本页即可编辑。')
        : (can ? '预览只构造命令，确认后才真正执行。' : '没有 root 权限：可以预览命令，但无法真正执行。');
    }
  }
  function paintRules() {
    if (!S.rulesHost) return;
    S.rulesHost.textContent = ''; S.rulesCount.textContent = S.rulesLoaded ? S.rules.length + ' 条' : '';
    if (S.rulesError) {
      if (S.rulesErrorCode === 'E_NEED_ROOT') {
        S.rulesHost.appendChild(rootGuide(S.rulesErrorHint, S.rulesError));
        add(S.rulesHost, el('div', 'panel-empty', '规则列表在 root 权限下才能读取；提权后点「刷新」即可恢复。'));
      } else if (S.rulesErrorCode === 'E_UNAUTHORIZED') {
        S.rulesHost.appendChild(notice('登录已失效，请重新登录后再查看防火墙规则。'));
        add(S.rulesHost, el('div', 'panel-empty', '当前会话没有权限；重新登录后刷新本页。'));
      } else {
        S.rulesHost.appendChild(notice('读取规则失败：' + S.rulesError));
        add(S.rulesHost, el('div', 'panel-empty', '读取失败时页面保留只读状态并禁用写操作。'));
      }
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
    add(box, el('p', 'fw-preview-note', S.canWrite ? '预览模式，确认后执行删除；SSH 放行规则会被防火墙引擎拒绝。'
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
    if (S.formLocked) return;
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
    S.rulesLoaded = false; S.rulesError = ''; S.rulesErrorCode = ''; S.rulesErrorHint = ''; paintRules();
    invoke('firewall.rules', {}).then(function (data) {
      if (S.destroyed) return;
      S.rules = data.rules || []; S.rulesLoaded = true; paintRules();
    }, function (err) {
      if (S.destroyed) return;
      S.rulesError = err.message; S.rulesErrorCode = err.code || ''; S.rulesErrorHint = err.hint || '';
      S.rulesLoaded = true; paintRules();
    });
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    S.root = add(container, el('section', 'fw'));
    var head = add(S.root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '防火墙'));
    add(head, el('p', 'view-sub', '查看防火墙引擎与规则；放行/拒绝端口先预览真实命令，确认后再执行。'));
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
    // fail-closed：状态回来前先禁用表单，避免"打开就能填、点提交才知道没权限"。
    setFormLocked(true);
    paintStatus(); paintRules(); paintPreview(); loadStatus(); loadRules();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreFirewall = { render: render };
})();
