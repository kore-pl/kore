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
      switchPreview: null, switchError: '', switchBusy: false, switchRiskAck: false, switchEnable: false };
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
    // fail-closed：状态回来前先禁用表单，避免"打开就能填、点提交才知道没权限"。
    setFormLocked(true);
    paintStatus(); paintRules(); paintPreview(); paintSwitch(); loadStatus(); loadRules();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreFirewall = { render: render };
})();
