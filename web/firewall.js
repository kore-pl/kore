/* kore 主壳 · 防火墙（web/firewall.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/firewall/firewall.<action>（插件 id 与业务域名一致）。
   只读：firewall.status / firewall.rules；写：allowPort / denyPort / deleteRule / enable / disable。
   写操作两步走：先 dry_run=true 预览真实 argv，确认后再 dry_run=false 执行；
   available=false（非系统管理员）时真实写按钮禁用，但保留只读状态与可操作降级提示。
   一键启用/停用带 SSH 放行强校验：默认入站非放行且未放行 SSH 端口时，启用前强警告并要求确认，
   防止把自己锁在外面；SSH 保护同时在前端提示与服务端拦截两层生效。插件版本 0.2.6。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/firewall/', TIMEOUT_MS = 15000;
  // 提权说明锚点：docs/RUNBOOK.md §5「以 root 启动 kored 与提权通道（ADR-0018）」。
  var RUNBOOK_PRIV = 'docs/RUNBOOK.md#5-以-root-启动-kored-与提权通道adr-0018';
  function fresh() {
    return { root: null, status: null, statusError: '', statusCode: '', statusHint: '',
      rules: [], rulesError: '', rulesErrorCode: '', rulesErrorHint: '',
      rulesLoaded: false, canWrite: false, previewable: false, formLocked: true, preview: null, pending: null, previewError: '', busy: false,
      deletePreview: null, deleteTarget: null, deleteError: '', notice: '', destroyed: false,
      switchPreview: null, switchError: '', switchBusy: false, switchRiskAck: false, switchEnable: false,
      // IP 名单与防爆破（竞品条目 5）
      ipRules: [], ipLoaded: false, ipError: '', ipBusy: false,
      ipPreview: null, ipPending: null, ipErrorText: '', ipRemoveTarget: null,
      brute: { enabled: false, threshold: 5, ban_min: 10 }, bruteDirty: false, bruteMsg: '' };
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
        var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('请求失败（HTTP ' + res.status + '），请点「刷新」重试；反复失败时检查系统管理员权限或查看运行手册')));
        err.code = data.code || ''; err.detail = data.detail || ''; err.hint = data.hint || ''; err.status = res.status; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒），请检查网络后点「刷新」重试');
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
  // 错误文案唯一来源是主壳 KoreUI.errorText（web/app.js）：归一成「什么错了。怎么办：动作」白话单行串。
  // 它内部走 failureOf 的 ERROR_VIEW 映射表，未收录 code 回退通用「怎么办」——不会出现空白 / undefined，
  // 也不会把内部 err.message / detail 裸铺首屏。KoreUI 未挂载（独立测试）时回退本地白话串。
  function failureText(err, verb) {
    if (window.KoreUI && typeof window.KoreUI.errorText === 'function') {
      return window.KoreUI.errorText(err, verb + '失败');
    }
    var msg = String((err && err.message) || '原因未知').replace(/^E_[A-Z_]+[:：]\s*/, '');
    var hint = err && err.hint ? String(err.hint) : '';
    return (msg || verb + '失败') + '。怎么办：' + (hint || '请点「刷新」重试，反复失败时检查系统管理员权限或查看运行手册') + '。';
  }
  // failureBlock：状态 / 列表级错误卡片（统一标题 + 可执行下一步 + 原始错误折叠）。
  // 管理员权限缺失只给一条指引，不把原始英文错误铺在首屏；detail 只进折叠区，不直接上屏。
  function failureBlock(err, cmd) {
    var f = window.KoreUI && typeof window.KoreUI.failureOf === 'function'
      ? window.KoreUI.failureOf(err) : { mapped: false };
    var box = el('div', 'fw-callout-warn fw-root-guide');
    box.setAttribute('role', 'status');
    add(box, el('div', 'fw-callout-title', f.mapped ? f.title : '操作失败'));
    add(box, el('p', 'fw-callout-text', f.mapped ? f.action : failureText(err, '读取')));
    if (cmd) add(box, el('pre', 'fw-cmd', cmd));
    var raw = (err && err.message) ? String(err.message) : '';
    if (raw) {
      var details = add(box, el('details', 'fw-details'));
      add(details, el('summary', null, '查看原始错误'));
      add(details, el('pre', null, raw));
    }
    var p = add(box, el('p', 'fw-callout-text'));
    var a = add(p, el('a', 'fw-perm-link', '查看运行手册'));
    a.href = RUNBOOK_PRIV; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return box;
  }
  function fmtPort(v) { return v === '' || v === null || v === undefined ? 'any' : String(v); }
  function actionKls(a) { return a === 'allow' ? 'is-allow' : (a === 'deny' ? 'is-deny' : 'is-reject'); }
  // 防火墙工具的技术标识（内部值 ufw/none）→ 用户白话，只在状态徽标展示。
  function backendText(id) { return id === 'ufw' ? 'UFW（系统防火墙工具）' : (id || '未检测到'); }
  function paintNotice() {
    if (!S.noticeHost) return;
    S.noticeHost.textContent = ''; if (S.notice) S.noticeHost.appendChild(notice(S.notice, true));
  }
  // 表单权限门控：没有系统管理员权限（available=false）或防火墙工具不受支持时，输入控件也必须禁用，
  // 只保留只读展示 + 提权指引——不允许"能填、点提交才报错"。
  function setFormLocked(locked) {
    S.formLocked = !!locked;
    [S.actionSel, S.portInput, S.protoSel, S.fromInput, S.commentInput].forEach(function (n) {
      if (n) n.disabled = S.formLocked;
    });
    if (S.previewBtn) S.previewBtn.disabled = S.formLocked || !S.previewable;
    if (S.previewNote) {
      S.previewNote.textContent = S.formLocked
        ? (S.canWrite ? '当前系统防火墙工具不可用：表单已禁用，仅保留只读展示。'
          : '没有系统管理员权限：表单已禁用，仅保留只读展示；以管理员身份运行后刷新本页即可编辑。')
        : '预览只构造命令，确认后才真正执行。';
    }
  }
  function paintStatus() {
    if (!S.statusHost) return;
    S.statusHost.textContent = '';
    if (S.statusError) {
      S.statusHost.appendChild(failureBlock({ code: S.statusCode, message: S.statusError, hint: S.statusHint },
        S.statusCode === 'E_NEED_ROOT' ? 'sudo systemctl restart kore' : ''));
      return;
    }
    if (!S.status) { add(S.statusHost, el('div', 'muted fw-loading', '正在检测当前系统防火墙工具…')); return; }
    var st = S.status; S.canWrite = !!(st.available && st.backend === 'ufw'); S.previewable = st.backend === 'ufw';
    var box = add(S.statusHost, el('div', 'fw-status-body'));
    var top = add(box, el('div', 'fw-status-top'));
    add(top, el('span', 'fw-backend', backendText(st.backend)));
    top.appendChild(chip(st.available ? 'ok' : 'warn', st.available ? '状态可读' : '只读降级'));
    var grid = add(box, el('div', 'fw-stats'));
    [['启用状态', st.available ? (st.enabled ? '已启用' : '未启用') : '不可读'],
      ['默认入站', st.available ? (st.default_in || '—') : '不可读'],
      ['规则数', st.available ? String(st.rules_count) : '不可读']].forEach(function (item) {
      var cell = add(grid, el('div', 'fw-stat'));
      add(cell, el('span', 'fw-stat-label', item[0])); add(cell, el('span', 'fw-stat-value', item[1]));
    });
    // 一键启用/停用（firewall.enable / firewall.disable，0.2.6 已提供，system:admin）。
    // 两步走：点按钮先 dry_run=true 预览真实命令，确认后才 dry_run=false 执行。
    // SSH 保护：默认入站为拒绝且未检测到 SSH 放行规则时，启用前给强警告并要求勾选确认。
    if (st.available && st.backend === 'ufw') {
      var sw = add(box, el('div', 'fw-callout-warn fw-switch'));
      add(sw, el('div', 'fw-callout-title', st.enabled ? '防火墙已启用' : '防火墙未启用，规则不会生效'));
      add(sw, el('p', 'fw-callout-text', st.enabled
        ? '停用会失去全机包过滤保护。确认要停用请点下面的按钮，先看命令预览再决定是否执行。'
        : '启用会让规则开始生效。启用前必须确认 SSH 端口（默认 22/tcp）已放行，否则可能把你锁在外面、无法再连接服务器。'));
      var swOps = add(sw, el('div', 'fw-ops'));
      var swBtn = add(swOps, el('button', 'btn ' + (st.enabled ? 'fw-danger' : 'btn-primary'),
        st.enabled ? '一键停用防火墙' : '一键启用防火墙'));
      swBtn.type = 'button';
      swBtn.disabled = !S.canWrite || S.switchBusy;
      swBtn.title = S.canWrite ? '先预览命令，确认后才真正执行'
        : '需要系统管理员权限；下方有提权的可操作提示';
      on(swBtn, function () { startSwitch(!st.enabled); });
      if (!S.canWrite) {
        add(sw, el('p', 'fw-callout-text', '当前没有系统管理员权限，开关按钮已禁用；按下方提示提权后刷新即可使用。'));
      }
    }
    if (!st.available) {
      S.statusHost.appendChild(failureBlock({ code: st.error_code, message: st.error, hint: st.hint },
        st.error_code === 'E_NEED_ROOT' ? 'sudo systemctl restart kore' : ''));
      // 已知边界（ADR-0018）：非 root 且无 root-action 通道时状态不可读。不报缺口，给可操作降级提示。
      var down = add(S.statusHost, el('div', 'fw-callout-warn'));
      add(down, el('div', 'fw-callout-title', '只读降级：无法读取防火墙状态'));
      add(down, el('p', 'fw-callout-text', st.hint
        ? st.hint + ' 完成提权后点面板右上角「刷新」，即可读取状态并使用一键开关。'
        : '以管理员身份（root）运行 Kore 后，点面板右上角「刷新」即可读取状态并使用一键开关。'));
    }
    var can = S.canWrite;
    // 状态说了算：能写才解锁表单，否则一律禁用（权限不足时不再让用户白填一遍）。
    setFormLocked(!can);
    if (S.previewBtn) {
      S.previewBtn.disabled = !S.previewable || !can;
      S.previewNote.textContent = S.formLocked
        ? (can ? '当前系统防火墙工具不可用：表单已禁用，仅保留只读展示。'
          : '没有系统管理员权限：表单已禁用，仅保留只读展示；以管理员身份运行后刷新本页即可编辑。')
        : (can ? '预览只构造命令，确认后才真正执行。' : '没有系统管理员权限：可以预览命令，但无法真正执行；以管理员身份运行后可编辑。');
    }
  }
  function paintRules() {
    if (!S.rulesHost) return;
    S.rulesHost.textContent = ''; S.rulesCount.textContent = S.rulesLoaded ? S.rules.length + ' 条' : '';
    if (S.rulesError) {
      S.rulesHost.appendChild(failureBlock({ code: S.rulesErrorCode, message: S.rulesError, hint: S.rulesErrorHint },
        S.rulesErrorCode === 'E_NEED_ROOT' ? 'sudo systemctl restart kore' : ''));
      return;
    }
    if (!S.rulesLoaded) { add(S.rulesHost, el('div', 'muted fw-loading', '正在读取规则…')); return; }
    if (!S.rules.length) {
      S.rulesHost.appendChild(window.KoreUI.emptyBlock({
        title: '当前没有防火墙规则',
        text: '还没有读取到防火墙规则；可能是规则被清空，或防火墙还没初始化。点下面的按钮重新读取就能确认。',
        label: '重新读取规则', onClick: loadRules
      }));
      return;
    }
    var scroll = add(S.rulesHost, el('div', 'fw-rules-scroll'));
    var table = add(scroll, el('table', 'fw-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['编号', '动作', '方向', '协议', '端口', '来源', '备注', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.rules.forEach(function (rule) {
      var tr = add(tbody, el('tr'));
      // data-label：<640px 表格转卡片时由 CSS ::before 复原列名（裁决41，与 files/sites/tasks 同口径）
      function cell(label, cls, text) {
        var c = add(tr, el('td', cls, text));
        c.dataset.label = label;
        return c;
      }
      cell('编号', 'fw-index', '#' + rule.index);
      cell('动作', 'fw-action ' + actionKls(rule.action), rule.action || '—');
      cell('方向', null, rule.direction || 'in');
      cell('协议', null, rule.proto || 'any');
      cell('端口', 'fw-port', fmtPort(rule.port));
      cell('来源', 'fw-from', rule.from || '0.0.0.0/0');
      cell('备注', 'fw-comment', rule.comment || '');
      var td = cell('操作', 'fw-ops');
      var del = add(td, el('button', 'btn fw-danger', '删除')); del.type = 'button';
      del.disabled = !S.canWrite;
      del.title = S.canWrite ? '先预览命令，确认后再删除' : '需要系统管理员权限，且当前防火墙工具受支持';
      on(del, function () { startDelete(rule); });
    });
    paintDeleteConfirm();
  }
  function paintDeleteConfirm() {
    if (!S.deleteHost) return;
    S.deleteHost.textContent = '';
    if (S.deleteError) S.deleteHost.appendChild(notice(S.deleteError));
    if (!S.deletePreview) return;
    var r = S.deleteTarget || {}, box = add(S.deleteHost, el('div', 'fw-preview fw-delete-confirm'));
    add(box, el('div', 'fw-preview-title', '将删除规则 #' + (r.index || '?') + '：' +
      (r.action || '') + ' ' + (r.direction || 'in') + ' ' + (r.proto || 'any') + '/' + fmtPort(r.port) +
      ' from ' + (r.from || '0.0.0.0/0')));
    add(box, el('pre', 'fw-cmd', (S.deletePreview.command || []).join(' ')));
    add(box, el('p', 'fw-preview-note', S.canWrite ? '预览模式，确认后执行删除；SSH 放行规则会被防火墙工具拒绝。'
      : '当前没有系统管理员权限，只能预览，无法执行删除；请联系管理员或点「查看运行手册」了解提权步骤。'));
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
      S.deleteError = failureText(err, '删除'); paintDeleteConfirm();
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
      S.busy = false; S.deleteError = failureText(err, '删除'); paintDeleteConfirm();
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
    add(box, el('p', 'fw-preview-note', S.canWrite ? '确认后立即执行；如果执行被拒绝，原因会显示在这里。'
      : '当前没有系统管理员权限，只能预览，无法执行；请联系管理员或点「查看运行手册」了解提权步骤。'));
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
      S.previewError = failureText(err, '预览'); S.pending = null; paintPreview();
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
      S.busy = false; S.previewError = failureText(err, '执行'); paintPreview();
    });
  }
  function updateSSH() {
    var port = Math.trunc(Number(S.portInput.value));
    S.sshWarn.hidden = port !== 22;
  }
  // 检测 SSH 是否在规则里放行：22/tcp，或服务端 KORE_SSH_PORT 配置的端口。
  // 放行判定只看当前已读到的规则（in + allow + tcp + 端口覆盖 22）；读不到规则时按"未确认放行"处理（fail-closed）。
  function sshAllowed() {
    if (!S.rulesLoaded || S.rulesError) return false;
    return S.rules.some(function (r) {
      if (r.action !== 'allow' || r.direction === 'out') return false;
      if (r.proto && r.proto !== 'tcp' && r.proto !== 'any') return false;
      var raw = String(r.port === null || r.port === undefined ? '' : r.port).trim();
      if (raw === '' || raw === 'any') return true; // 全端口放行覆盖 22
      return raw.split(',').some(function (piece) {
        piece = piece.trim(); var range = piece.split(':');
        if (range.length === 2) { var lo = Number(range[0]), hi = Number(range[1]); return 22 >= lo && 22 <= hi; }
        return Number(piece) === 22;
      });
    });
  }
  // 一键开关：先 dry_run=true 预览真实 argv，展示给用户看，确认后才 dry_run=false 真执行。
  function startSwitch(enable) {
    if (!S.canWrite || S.switchBusy) return;
    S.switchError = ''; S.switchPreview = null; S.switchEnable = !!enable; S.switchRiskAck = false;
    paintSwitch();
    invoke(enable ? 'firewall.enable' : 'firewall.disable', { dry_run: true }).then(function (data) {
      if (S.destroyed) return;
      S.switchPreview = data; paintSwitch();
    }, function (err) {
      if (S.destroyed) return;
      S.switchError = failureText(err, enable ? '启用预览' : '停用预览'); paintSwitch();
    });
  }
  // 启用前的 SSH 强警告：默认入站非 allow 且未确认放行 22 时，必须勾选确认才能继续。
  function switchRisky() {
    return S.switchEnable && !!S.status && S.status.available && S.status.default_in !== 'allow' && !sshAllowed();
  }
  function paintSwitch() {
    if (!S.switchHost) return;
    S.switchHost.textContent = '';
    if (S.switchError) S.switchHost.appendChild(notice(S.switchError));
    if (!S.switchPreview) return;
    var enable = S.switchEnable;
    var box = add(S.switchHost, el('div', 'fw-preview ' + (enable ? '' : 'fw-delete-confirm')));
    add(box, el('div', 'fw-preview-title', (enable ? '一键启用' : '一键停用') + '：将执行的命令（预览，尚未执行）'));
    add(box, el('pre', 'fw-cmd', (S.switchPreview.command || []).join(' ')));
    if (enable) {
      if (switchRisky()) {
        var warn = add(box, el('div', 'fw-callout-warn'));
        add(warn, el('div', 'fw-callout-title', '高风险：SSH 端口可能未放行'));
        add(warn, el('p', 'fw-callout-text',
          '当前默认入站为「' + (S.status.default_in || '拒绝') + '」，且规则里未确认放行 SSH 端口（22/tcp）。' +
          '此时启用防火墙，很可能把你锁在服务器外面、远程连接立刻断开。强烈建议先在「添加规则」放行 22/tcp，再来启用。'));
        var lab = add(warn, el('label', 'field-check'));
        var ack = add(lab, el('input')); ack.type = 'checkbox'; ack.checked = S.switchRiskAck;
        add(lab, el('span', null, '我确认已有其它登录方式（如服务器控制台），仍要启用'));
        ack.addEventListener('change', function () {
          S.switchRiskAck = ack.checked;
          if (ok) ok.disabled = !S.canWrite || S.switchBusy || switchRisky();
        });
      } else {
        add(box, el('p', 'fw-preview-note', '已确认 SSH 端口放行，或默认入站为放行；启用后远程连接应保持可用。'));
      }
    } else {
      add(box, el('p', 'fw-preview-note', '停用会失去全机包过滤保护；确认后才执行。'));
    }
    var ops = add(box, el('div', 'fw-ops'));
    var ok = add(ops, el('button', 'btn ' + (enable ? 'btn-primary' : 'fw-danger'),
      enable ? '确认启用' : '确认停用'));
    ok.type = 'button'; ok.disabled = !S.canWrite || S.switchBusy || switchRisky();
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消'));
    cancel.type = 'button';
    on(cancel, function () { S.switchPreview = null; S.switchError = ''; S.switchRiskAck = false; paintSwitch(); });
    on(ok, function () { execSwitch(ok); });
  }
  function execSwitch(btn) {
    if (!S.canWrite || S.switchBusy || !S.switchPreview) return;
    if (switchRisky() && !S.switchRiskAck) return;
    S.switchBusy = true; btn.disabled = true; paintStatus();
    var enable = S.switchEnable, method = enable ? 'firewall.enable' : 'firewall.disable';
    invoke(method, { dry_run: false }).then(function (data) {
      if (S.destroyed) return;
      S.switchBusy = false;
      S.notice = (enable ? '已启用防火墙' : '已停用防火墙') + '：' + (data.command || []).join(' ');
      S.switchPreview = null; S.switchError = ''; S.switchRiskAck = false;
      paintNotice(); paintSwitch(); loadStatus(); loadRules();
    }, function (err) {
      if (S.destroyed) return;
      S.switchBusy = false;
      S.switchError = failureText(err, enable ? '启用' : '停用');
      paintSwitch(); paintStatus();
    });
  }
  function loadStatus() {
    S.statusError = ''; S.statusCode = ''; S.statusHint = ''; paintStatus();
    invoke('firewall.status', {}).then(function (data) {
      if (S.destroyed) return;
      S.status = data; paintStatus();
    }, function (err) {
      if (S.destroyed) return;
      S.statusError = err.message; S.statusCode = err.code || ''; S.statusHint = err.hint || ''; paintStatus();
    });
  }
  function loadRules() {
    S.rulesLoaded = false; S.rulesError = ''; S.rulesErrorCode = ''; S.rulesErrorHint = ''; paintRules();
    invoke('firewall.rules', {}).then(function (data) {
      if (S.destroyed) return;
      S.rules = data.rules || []; S.rulesLoaded = true; paintRules(); paintSwitch();
    }, function (err) {
      if (S.destroyed) return;
      S.rulesError = err.message; S.rulesErrorCode = err.code || ''; S.rulesErrorHint = err.hint || '';
      S.rulesLoaded = true; paintRules(); paintSwitch();
    });
  }

  // ==== IP 白名单/黑名单 与 防爆破（竞品清单条目 5）====
  // 用户流程（≤3 点击）：选预设或填 IP → 预览命令 → 确认执行；防爆破一次表单直接保存。
  function ipModeText(mode) { return mode === 'allow' ? '白名单' : (mode === 'deny' ? '黑名单' : '临时封禁'); }
  function ipModeKls(mode) { return mode === 'allow' ? 'is-allow' : (mode === 'deny' ? 'is-deny' : 'is-reject'); }
  function paintIPNotice() {
    if (!S.ipNoticeHost) return;
    S.ipNoticeHost.textContent = '';
    if (S.bruteMsg) S.ipNoticeHost.appendChild(notice(S.bruteMsg, true));
  }
  function loadIPList() {
    S.ipLoaded = false; S.ipError = ''; paintIPRules();
    invoke('firewall.ipList', {}).then(function (data) {
      if (S.destroyed) return;
      S.ipRules = data.rules || []; S.ipLoaded = true;
      if (data.brute) S.brute = data.brute;
      S.bruteDirty = false;
      paintIPRules(); paintBrute();
    }, function (err) {
      if (S.destroyed) return;
      S.ipError = failureText(err, '读取 IP 名单'); S.ipLoaded = true;
      paintIPRules();
    });
  }
  function paintIPRules() {
    if (!S.ipRulesHost) return;
    S.ipRulesHost.textContent = '';
    if (S.ipError) { S.ipRulesHost.appendChild(notice(S.ipError)); return; }
    if (!S.ipLoaded) { add(S.ipRulesHost, el('div', 'muted fw-loading', '正在读取 IP 名单…')); return; }
    if (!S.ipRules.length) {
      S.ipRulesHost.appendChild(window.KoreUI.emptyBlock({
        title: '还没有 IP 规则',
        text: '可以一键添加常用规则，或在下面填写 IP 后点「预览命令」。防爆破开启后，达到失败阈值的来源 IP 会自动出现在临时封禁里。',
        label: '重新读取 IP 名单', onClick: loadIPList
      }));
      return;
    }
    var scroll = add(S.ipRulesHost, el('div', 'fw-rules-scroll'));
    var table = add(scroll, el('table', 'fw-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['编号', '类型', 'IP / 网段', '来源', '到期', '备注', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.ipRules.forEach(function (rule, idx) {
      var tr = add(tbody, el('tr'));
      function cell(label, cls, text) { var c = add(tr, el('td', cls || null, text)); c.dataset.label = label; return c; }
      cell('编号', 'fw-index', '#' + (idx + 1));
      cell('类型', 'fw-action ' + ipModeKls(rule.mode), ipModeText(rule.mode) + (rule.expired ? '（已过期）' : ''));
      cell('IP / 网段', 'fw-from', rule.ip);
      cell('来源', null, rule.comment || '手工添加');
      cell('到期', 'fw-port', rule.expires_at ? String(rule.expires_at).replace('T', ' ').slice(0, 19) : '长期');
      cell('备注', 'fw-comment', rule.comment || '');
      var td = cell('操作', 'fw-ops');
      var del = add(td, el('button', 'btn fw-danger', '删除')); del.type = 'button';
      del.disabled = S.ipBusy;
      del.title = S.canWrite ? '从名单和防火墙规则中移除' : '需要 root 运行 kored 才能真正下发，后端会给出原因';
      on(del, function () { startIPRemove(rule); });
    });
    paintIPRemove();
  }
  function ipPreviewBox(host, title, cmd, note, canConfirm, onConfirm, onCancel) {
    host.textContent = '';
    var box = add(host, el('div', 'fw-preview'));
    add(box, el('div', 'fw-preview-title', title));
    add(box, el('pre', 'fw-cmd', (cmd || []).join(' ') || '（无命令：仅保存配置）'));
    add(box, el('p', 'fw-preview-note', note));
    var ops = add(box, el('div', 'fw-ops'));
    if (canConfirm) {
      var ok = add(ops, el('button', 'btn btn-primary', '确认执行')); ok.type = 'button';
      on(ok, function () { onConfirm(ok); });
    }
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    on(cancel, onCancel);
  }
  function startIPAdd(mode) {
    // IP 名单的预览只是构造 argv（dry_run），不需要 root：非 root 也要能看到命令。
    // 权限不足时把「确认执行」放行到后端，由后端回 E_NEED_ROOT + 指引（fail-closed 且可操作）。
    if (S.ipBusy) return;
    var ip = String(S.ipInput.value || '').trim();
    if (!ip) { S.ipErrorText = '请先填写 IP 或网段（如 203.0.113.7 / 10.0.0.0/8）'; paintIPPreview(); return; }
    S.ipErrorText = ''; S.ipPreview = null; S.ipPending = null;
    invoke('firewall.ip' + (mode === 'allow' ? 'Allow' : 'Deny'),
      { ip: ip, comment: String(S.ipComment.value || '').trim(), dry_run: true }).then(function (data) {
      if (S.destroyed) return;
      S.ipPreview = data; S.ipPending = { mode: mode, ip: ip, comment: String(S.ipComment.value || '').trim() };
      paintIPPreview();
    }, function (err) {
      if (S.destroyed) return;
      S.ipErrorText = failureText(err, '预览'); paintIPPreview();
    });
  }
  function execIPAdd(btn) {
    // 同 startIPAdd：执行权限由后端裁决（非 root 会回 E_NEED_ROOT + 指引），前端不提前挡掉，
    // 否则用户只看到一个「点了没反应」的按钮。
    if (!S.ipPending || S.ipBusy) return;
    S.ipBusy = true; btn.disabled = true;
    var p = S.ipPending, method = 'firewall.ip' + (p.mode === 'allow' ? 'Allow' : 'Deny');
    invoke(method, { ip: p.ip, comment: p.comment, dry_run: false }).then(function () {
      if (S.destroyed) return;
      S.ipBusy = false; S.bruteMsg = '已添加 IP ' + p.ip + ' 到' + ipModeText(p.mode);
      S.ipPreview = null; S.ipPending = null; S.ipErrorText = '';
      S.ipInput.value = ''; S.ipComment.value = '';
      paintIPNotice(); paintIPPreview(); loadIPList();
    }, function (err) {
      if (S.destroyed) return;
      S.ipBusy = false; S.ipErrorText = failureText(err, '执行'); paintIPPreview();
    });
  }
  function paintIPPreview() {
    if (!S.ipPreviewHost) return;
    S.ipPreviewHost.textContent = '';
    // 顺序不能反：ipPreviewBox 会清空宿主，先渲染命令再把错误追加在后面，
    // 否则「确认执行」失败的提示会被预览块整块擦掉（用户只看得到命令、看不到拒绝原因）。
    if (!S.ipPreview) {
      if (S.ipErrorText) S.ipPreviewHost.appendChild(notice(S.ipErrorText));
      return;
    }
    ipPreviewBox(S.ipPreviewHost, '将执行的命令（预览，尚未执行）', S.ipPreview.command,
      S.canWrite ? '确认后才会真正下发到防火墙。'
        : '确认后会尝试下发；当前 kored 非 root，预计会被拒绝并给出开启方式（需以 root 运行 kored）。',
      true, execIPAdd, function () { S.ipPreview = null; S.ipPending = null; S.ipErrorText = ''; paintIPPreview(); });
    if (S.ipErrorText) S.ipPreviewHost.appendChild(notice(S.ipErrorText));
  }
  function startIPRemove(rule) {
    if (S.ipBusy) return;
    S.ipError = '';
    invoke('firewall.ipRemove', { id: rule.id, dry_run: true }).then(function (data) {
      if (S.destroyed) return;
      S.ipRemoveTarget = { rule: rule, preview: data }; paintIPRemove();
    }, function (err) {
      if (S.destroyed) return;
      S.ipError = failureText(err, '删除预览'); paintIPRules();
    });
  }
  function paintIPRemove() {
    if (!S.ipRemoveHost) return;
    S.ipRemoveHost.textContent = '';
    if (!S.ipRemoveTarget) return;
    var r = S.ipRemoveTarget.rule;
    ipPreviewBox(S.ipRemoveHost, '将移除 ' + r.ip + ' 的' + ipModeText(r.mode) + '规则（预览，尚未执行）',
      (S.ipRemoveTarget.preview || {}).command,
      '确认后会从名单与防火墙规则中同时移除；非 root 时后端会回拒绝原因与开启方式。', !S.ipBusy,
      function (btn) {
        S.ipBusy = true; btn.disabled = true;
        invoke('firewall.ipRemove', { id: r.id, dry_run: false }).then(function () {
          if (S.destroyed) return;
          S.ipBusy = false; S.bruteMsg = '已移除规则 ' + r.ip;
          S.ipRemoveTarget = null; paintIPRemove(); paintIPNotice(); loadIPList();
        }, function (err) {
          if (S.destroyed) return;
          S.ipBusy = false; S.ipError = failureText(err, '执行删除'); paintIPRules();
        });
      },
      function () { S.ipRemoveTarget = null; paintIPRemove(); });
  }
  function applyPreset(name) {
    if (!S.ipInput || !S.ipComment) return;
    if (name === 'office') { S.ipInput.value = '10.0.0.0/8'; S.ipComment.value = '公司内网'; }
    if (name === 'home') { S.ipInput.value = '192.168.1.0/24'; S.ipComment.value = '家庭内网'; }
    if (name === 'example') { S.ipInput.value = '203.0.113.7'; S.ipComment.value = '示例 IP'; }
  }
  function paintBrute() {
    if (!S.bruteThreshold || !S.bruteBanMin || !S.bruteEnabled) return;
    S.bruteThreshold.value = String(S.brute.threshold);
    S.bruteBanMin.value = String(S.brute.ban_min);
    S.bruteEnabled.checked = !!S.brute.enabled;
    if (S.bruteState) S.bruteState.textContent = S.brute.enabled
      ? '已开启：失败 ' + S.brute.threshold + ' 次后封禁 ' + S.brute.ban_min + ' 分钟（到期自动解封）'
      : '未开启：登录失败不会触发封禁';
  }
  function saveBrute(btn) {
    var threshold = Math.trunc(Number(S.bruteThreshold.value));
    var banMin = Math.trunc(Number(S.bruteBanMin.value));
    if (!isFinite(threshold) || threshold < 1 || threshold > 1000) { S.bruteMsg = '失败次数须为 1–1000 的整数'; paintIPNotice(); return; }
    if (!isFinite(banMin) || banMin < 1 || banMin > 1440) { S.bruteMsg = '封禁时长须为 1–1440 分钟'; paintIPNotice(); return; }
    S.ipBusy = true; btn.disabled = true;
    invoke('firewall.bruteSet', { enabled: S.bruteEnabled.checked, threshold: threshold, ban_min: banMin }).then(function (data) {
      if (S.destroyed) return;
      S.ipBusy = false; S.brute = data; S.bruteDirty = true;
      S.bruteMsg = '已保存并设置成功：' + (data.enabled ? '开启，失败 ' + data.threshold + ' 次封禁 ' + data.ban_min + ' 分钟' : '已关闭');
      paintIPNotice(); paintBrute(); loadIPList();
    }, function (err) {
      if (S.destroyed) return;
      S.ipBusy = false; S.bruteMsg = failureText(err, '保存防爆破配置'); paintIPNotice();
    });
  }

  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    S.root = add(container, el('section', 'fw'));
    var head = add(S.root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '防火墙'));
    add(head, el('p', 'view-sub', '查看防火墙工具与规则；放行/拒绝端口先预览真实命令，确认后再执行。'));
    S.noticeHost = add(S.root, el('div', 'redis-notice-host'));
    var status = panel('状态', ''); add(S.root, status.panel);
    var refresh = add(status.meta, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, function () { loadStatus(); loadRules(); });
    S.statusHost = add(status.panel, el('div', 'fw-status'));
    S.switchHost = add(status.panel, el('div', 'fw-switch-host'));
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
    S.sshWarn.textContent = '屏蔽 SSH 端口会导致无法连接服务器，系统会阻止此操作。';
    S.portInput.addEventListener('input', updateSSH); S.actionSel.addEventListener('change', updateSSH);
    var ops = add(formP.panel, el('div', 'fw-form-ops'));
    S.previewBtn = add(ops, el('button', 'btn btn-primary', '预览命令')); S.previewBtn.type = 'button';
    on(S.previewBtn, previewRule);
    S.previewNote = add(ops, el('span', 'fw-preview-hint', '预览只构造命令，确认后才真正执行。'));
    S.previewHost = add(formP.panel, el('div', 'fw-preview-host'));

    // IP 名单与防爆破面板（竞品条目 5）。
    var ipP = panel('IP 白名单 / 黑名单 与 防爆破', '来源 IP 或网段，白名单优先'); add(S.root, ipP.panel);
    S.ipNoticeHost = add(ipP.panel, el('div', 'redis-notice-host'));
    var ipDesc = add(ipP.panel, el('p', 'fw-callout-text',
      '允许/拒绝指定来源 IPv4 地址或网段；登录失败达到阈值自动临时封禁。所有变更先预览命令，确认后才执行。',));
    ipDesc.style.padding = '12px 16px 0';
    // 预设（USABILITY §1）：常用内网网段一键填入，高级项折叠为手工填写。
    var presetOps = add(ipP.panel, el('div', 'fw-ops')); presetOps.style.padding = '8px 16px';
    [['公司内网', '10.0.0.0/8', 'office'], ['家庭内网', '192.168.1.0/24', 'home'], ['示例 IP', '203.0.113.7', 'example']].forEach(function (p) {
      var b = add(presetOps, el('button', 'btn btn-ghost', p[0])); b.type = 'button';
      b.title = '一键填入 ' + p[1];
      on(b, function () { applyPreset(p[2]); });
    });
    var ipForm = add(ipP.panel, el('div', 'fw-form'));
    S.ipInput = el('input', 'fw-input'); S.ipInput.type = 'text';
    S.ipInput.placeholder = '203.0.113.7 或 10.0.0.0/8'; S.ipInput.maxLength = 64;
    S.ipComment = el('input', 'fw-input'); S.ipComment.type = 'text';
    S.ipComment.placeholder = '备注（可选）'; S.ipComment.maxLength = 64;
    var ipFormHint = el('span', 'fw-preview-hint', '填写 IPv4 地址或网段 → 点下方「预览白名单/黑名单」→ 确认执行。不填高级项也能完成。');
    [['IP / 网段（必填）', S.ipInput], ['备注（可选）', S.ipComment]].forEach(function (f) {
      var label = add(ipForm, el('label', 'fw-field'));
      add(label, el('span', 'fw-label', f[0])); add(label, f[1]);
    });
    add(ipForm, ipFormHint);
    var ipOps = add(ipP.panel, el('div', 'fw-form-ops'));
    var allowBtn = add(ipOps, el('button', 'btn btn-primary', '预览白名单')); allowBtn.type = 'button';
    var denyBtn = add(ipOps, el('button', 'btn fw-danger', '预览黑名单')); denyBtn.type = 'button';
    on(allowBtn, function () { startIPAdd('allow'); });
    on(denyBtn, function () { startIPAdd('deny'); });
    S.ipPreviewHost = add(ipP.panel, el('div', 'fw-preview-host'));
    S.ipRemoveHost = add(ipP.panel, el('div', 'fw-delete-host'));
    var bruteBox = add(ipP.panel, el('div', 'fw-callout-warn')); bruteBox.style.margin = '0 16px 12px';
    add(bruteBox, el('div', 'fw-callout-title', '防爆破（登录失败自动封禁）'));
    add(bruteBox, el('p', 'fw-callout-text', '开启后，来自同一 IP 的登录失败累计达到阈值就临时封禁；到期自动解封，无需手工清理。默认失败 5 次封禁 10 分钟。',));
    var bruteForm = add(bruteBox, el('div', 'fw-form')); bruteForm.style.padding = '8px 0 0';
    var enabledLabel = add(bruteForm, el('label', 'field-check'));
    S.bruteEnabled = add(enabledLabel, el('input')); S.bruteEnabled.type = 'checkbox';
    add(enabledLabel, el('span', null, '开启防爆破'));
    S.bruteThreshold = el('input', 'fw-input'); S.bruteThreshold.type = 'number';
    S.bruteThreshold.min = '1'; S.bruteThreshold.max = '1000'; S.bruteThreshold.value = '5';
    S.bruteBanMin = el('input', 'fw-input'); S.bruteBanMin.type = 'number';
    S.bruteBanMin.min = '1'; S.bruteBanMin.max = '1440'; S.bruteBanMin.value = '10';
    [['失败几次后封禁（1–1000）', S.bruteThreshold], ['封禁时长（分钟，1–1440）', S.bruteBanMin]].forEach(function (f) {
      var label = add(bruteForm, el('label', 'fw-field'));
      add(label, el('span', 'fw-label', f[0])); add(label, f[1]);
    });
    S.bruteState = add(bruteBox, el('p', 'fw-callout-text', ''));
    var bruteOps = add(bruteBox, el('div', 'fw-ops')); bruteOps.style.marginTop = '8px';
    var bruteSave = add(bruteOps, el('button', 'btn btn-primary', '保存防爆破设置')); bruteSave.type = 'button';
    on(bruteSave, function () { saveBrute(bruteSave); });
    add(bruteOps, el('span', 'fw-preview-hint', '保存即生效，无需重启。',));
    var ipRulesPanel = panel('当前 IP 规则', ''); add(S.root, ipRulesPanel.panel);
    S.ipRulesHost = add(ipRulesPanel.panel, el('div', 'fw-rules'));
    // fail-closed：状态回来前先禁用表单，避免"打开就能填、点提交才知道没权限"。
    setFormLocked(true);
    paintStatus(); paintRules(); paintPreview(); paintSwitch(); loadStatus(); loadRules();
    paintBrute(); paintIPRules(); paintIPPreview(); paintIPRemove(); paintIPNotice(); loadIPList();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreFirewall = { render: render };
})();
