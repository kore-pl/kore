/* kore 主壳 · 凭据管理（web/credentials.js，设置页「凭据」tab 懒加载）
   ADR-0026：列表只回元数据，永不显示 secret；口令只在新建时提交一次，输入框不回显。
   端点（5 个）：GET/POST /api/v1/credentials、POST/DELETE grants、DELETE /credentials/{id}。
   对外只暴露 window.KoreCredentials = { render }。 */
(function () {
  'use strict';
  var EP = '/api/v1/credentials', PLUGINS = '/api/v1/plugins', TIMEOUT = 8000;
  var ENV_PRESETS = [
    ['MYSQL_PWD', 'MySQL 口令（MYSQL_PWD）'],
    ['PGPASSWORD', 'PostgreSQL 口令（PGPASSWORD）'],
    ['REDISCLI_AUTH', 'Redis 口令（REDISCLI_AUTH）']
  ];
  var S = { rows: [], plugins: [], error: '', notice: '', busy: false, host: null, confirm: null };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn) { n.addEventListener('click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function human(err) {
    if (err.code === 'E_NEED_GRANT') return '这个插件还没有被授权读取该凭据，先在下方「授权给插件」里授权。';
    if (err.code === 'E_AUDIT') return '审计写入失败，为安全起见本次操作没有生效；请检查磁盘空间和数据目录权限后重试。';
    if (err.code === 'E_UNAUTHORIZED') return '当前会话没有凭据管理权限，请重新登录后再试。';
    if (err.code === 'E_NOTFOUND') return '这条凭据已经不存在了，刷新列表看看。';
    return err.message || '操作没有完成，请稍后重试。';
  }
  function request(method, url, body) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT) : null;
    var headers = { Accept: 'application/json' };
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-Kore-CSRF'] = cookie('kore_csrf');
      init.body = JSON.stringify(body);
    }
    if (ctrl) init.signal = ctrl.signal;
    return fetch(url, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = {}; } }
        if (res.ok) return data;
        var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        err.code = data.code || ''; err.status = res.status; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
      throw err;
    });
  }
  function btn(text, cls) {
    var b = el('button', 'btn ' + (cls || ''), text); b.type = 'button'; return b;
  }
  function paintNotice(host) {
    host.textContent = '';
    if (S.error) { var e = add(host, el('div', 'cred-notice cred-error', S.error)); e.setAttribute('role', 'alert'); }
    if (S.notice) { var n = add(host, el('div', 'cred-notice cred-ok', S.notice)); n.setAttribute('role', 'status'); }
  }
  function options(select, list, value) {
    list.forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0];
      if (o[0] === value) op.selected = true;
      select.appendChild(op);
    });
  }
  function pluginLabel(id) {
    for (var i = 0; i < S.plugins.length; i++) if (S.plugins[i].id === id) return S.plugins[i].name || id;
    return id;
  }
  function load() {
    S.error = ''; paint();
    return Promise.all([
      request('GET', EP),
      request('GET', PLUGINS)
    ]).then(function (out) {
      S.rows = Array.isArray(out[0].credentials) ? out[0].credentials : [];
      var list = Array.isArray(out[1].plugins) ? out[1].plugins : [];
      S.plugins = list.filter(function (p) { return p && p.id; }).map(function (p) { return { id: p.id, name: p.name || p.id }; });
      S.plugins.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      paint();
    }, function (err) {
      S.error = human(err); paint();
    });
  }
  function afterWrite(notice) {
    S.notice = notice; S.busy = false;
    return load();
  }
  function createForm() {
    var box = add(S.host, el('section', 'panel cred-panel'));
    add(add(box, el('div', 'panel-head')), el('span', 'panel-title', '新建凭据'));
    add(box, el('p', 'cred-hint', '凭据只保存在本机；新建后不会显示口令，插件只有被授权后才能读取。'));
    var form = add(box, el('div', 'cred-form'));
    var owner = el('select', 'cred-select'); owner.setAttribute('aria-label', '所属插件');
    options(owner, S.plugins.length ? S.plugins.map(function (p) { return [p.id, p.id + (p.name !== p.id ? ' · ' + p.name : '')]; }) : [['', '没有已安装插件']], S.plugins[0] ? S.plugins[0].id : '');
    var name = el('input', 'cred-input'); name.id = 'cred-name-input'; name.placeholder = '例如 mysqlRoot'; name.maxLength = 64;
    var envVar = el('select', 'cred-select'); envVar.setAttribute('aria-label', '环境变量名');
    options(envVar, ENV_PRESETS.concat([['__custom__', '自定义…']]), 'MYSQL_PWD');
    var custom = el('input', 'cred-input cred-custom'); custom.placeholder = '自定义环境变量名（大写字母/数字/下划线）'; custom.hidden = true;
    var secret = el('input', 'cred-input'); secret.type = 'password'; secret.autocomplete = 'new-password';
    secret.placeholder = '口令（提交后不再显示）';
    [['所属插件', owner], ['名称', name], ['环境变量名', envVar], ['自定义变量名', custom], ['口令', secret]].forEach(function (f) {
      var label = add(form, el('label', 'cred-field'));
      add(label, el('span', 'cred-label', f[0])); add(label, f[1]);
    });
    envVar.addEventListener('change', function () { custom.hidden = envVar.value !== '__custom__'; });
    var ops = add(box, el('div', 'cred-ops'));
    var submit = add(ops, btn('创建凭据', 'btn-primary'));
    var hint = add(ops, el('span', 'cred-hint', '创建后请到下方把凭据授权给需要它的插件。'));
    on(submit, function () {
      if (S.busy) return;
      var env = envVar.value === '__custom__' ? custom.value.trim() : envVar.value;
      if (!name.value.trim()) { S.error = '请填写凭据名称（例如 mysqlRoot）'; S.notice = ''; paint(); return; }
      if (!env) { S.error = '请选择或填写环境变量名'; S.notice = ''; paint(); return; }
      if (!secret.value) { S.error = '请填写口令'; S.notice = ''; paint(); return; }
      S.busy = true; submit.disabled = true; hint.textContent = '正在保存…';
      request('POST', EP, { owner: owner.value, name: name.value.trim(), envVar: env, secret: secret.value }).then(function (data) {
        afterWrite('凭据已创建' + (data.id ? '（' + data.id + '）' : '') + '；记得授权给需要它的插件。');
      }, function (err) {
        S.busy = false; S.error = human(err); S.notice = ''; paint();
      });
    });
  }
  function revoke(row, grantee) {
    if (S.busy) return;
    S.confirm = { kind: 'revoke', row: row, grantee: grantee };
    paint();
  }
  function revokeNow(row, grantee) {
    if (S.busy) return;
    S.busy = true;
    request('DELETE', EP + '/' + encodeURIComponent(row.id) + '/grants/' + encodeURIComponent(grantee)).then(function () {
      S.confirm = null;
      afterWrite('已撤销「' + grantee + '」对 ' + row.name + ' 的读取权限。');
    }, function (err) { S.busy = false; S.error = human(err); S.notice = ''; paint(); });
  }
  function grant(row, select) {
    if (S.busy) return;
    if (!select.value) { S.error = '先选一个要授权的插件'; S.notice = ''; paint(); return; }
    S.busy = true;
    request('POST', EP + '/' + encodeURIComponent(row.id) + '/grants', { grantee: select.value }).then(function () {
      afterWrite('已允许「' + select.value + '」读取 ' + row.name + '。');
    }, function (err) { S.busy = false; S.error = human(err); S.notice = ''; paint(); });
  }
  function remove(row) {
    S.confirm = { kind: 'delete', row: row };
    paint();
  }
  function confirmDelete(row) {
    if (S.busy) return;
    S.busy = true;
    request('DELETE', EP + '/' + encodeURIComponent(row.id)).then(function () {
      S.confirm = null;
      afterWrite('已删除凭据 ' + row.name + '。');
    }, function (err) { S.busy = false; S.error = human(err); S.notice = ''; paint(); });
  }
  function confirmDialog() {
    if (!S.confirm) return null;
    var row = S.confirm.row, revoking = S.confirm.kind === 'revoke';
    var back = el('div', 'cred-backdrop'); back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true');
    var box = add(back, el('div', 'cred-dialog'));
    if (revoking) {
      add(box, el('h3', 'cred-dialog-title', '撤销「' + S.confirm.grantee + '」的授权？'));
      add(box, el('p', 'cred-dialog-hint', '撤销后「' + S.confirm.grantee + '」在下次重启时将取不到凭据 ' +
        row.name + '，相关功能可能不可用；需要时可重新授权。'));
    } else {
      add(box, el('h3', 'cred-dialog-title', '删除凭据 ' + row.name + '？'));
      add(box, el('p', 'cred-dialog-hint', '删除后不可恢复；依赖它的插件在下次重启时会取不到这个凭据，可能无法连接数据库/缓存。'));
    }
    var ops = add(box, el('div', 'cred-dialog-ops'));
    var cancel = add(ops, btn('取消', 'btn-ghost'));
    var ok = add(ops, btn(revoking ? '确认撤销' : '确认删除', 'cred-danger'));
    on(cancel, function () { S.confirm = null; paint(); });
    on(ok, function () {
      ok.disabled = true;
      if (revoking) revokeNow(row, S.confirm.grantee); else confirmDelete(row);
    });
    return back;
  }
  function rowCells(row, actions) {
    var cells = [
      ['ID', el('code', 'cred-mono', row.id || '—')],
      ['名称', el('span', 'cred-name', row.name || '—')],
      ['所属插件', el('span', 'cred-owner', row.owner || '—')],
      ['环境变量', el('code', 'cred-mono', row.envVar || '—')],
      ['已授权', el('span', 'cred-granted', (row.grantedTo || []).length ? (row.grantedTo || []).join('、') : '未授权')],
      ['创建时间', el('span', 'cred-time', '—')],
      ['操作', actions]
    ];
    return cells;
  }
  function rowActions(row) {
    var box = el('div', 'cred-actions');
    var granted = row.grantedTo || [];
    (granted.length ? granted : []).forEach(function (g) {
      var chip = add(box, el('span', 'cred-grant-chip'));
      add(chip, el('span', null, pluginLabel(g)));
      var x = add(chip, btn('撤销', 'cred-chip-btn'));
      on(x, function () { revoke(row, g); });
    });
    var select = el('select', 'cred-select cred-grant-select'); select.setAttribute('aria-label', '授权给插件');
    var available = S.plugins.filter(function (p) { return granted.indexOf(p.id) < 0 && p.id !== row.owner; });
    options(select, available.length ? available.map(function (p) { return [p.id, '授权给 ' + p.id]; }) : [['', '没有可授权的插件']], '');
    add(box, select);
    var gbtn = add(box, btn('授权', 'btn-ghost')); gbtn.disabled = !available.length;
    on(gbtn, function () { grant(row, select); });
    var del = add(box, btn('删除凭据', 'cred-danger'));
    on(del, function () { remove(row); });
    return box;
  }
  function listPanel() {
    var box = add(S.host, el('section', 'panel cred-panel'));
    var head = add(box, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', '已有凭据'));
    var refresh = add(head, btn('刷新', 'btn-ghost'));
    on(refresh, function () { load(); });
    if (!S.rows.length) {
      var empty = add(box, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-title', '还没有凭据'));
      add(empty, el('p', 'empty-state-text',
        '凭据让插件读取数据库/Redis 密码，不用在多个页面重复填；新建后再授权给需要它的插件即可。'));
      var first = add(empty, el('button', 'btn btn-primary', '新建第一条凭据'));
      first.type = 'button';
      on(first, function () {
        var input = document.getElementById('cred-name-input');
        if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); }
      });
      return;
    }
    var wrap = add(box, el('div', 'cred-table-wrap'));
    var table = add(wrap, el('table', 'cred-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['ID', '名称', '所属插件', '环境变量', '已授权', '创建时间', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.rows.forEach(function (row) {
      var tr = add(tbody, el('tr'));
      rowCells(row, rowActions(row)).forEach(function (pair) {
        var td = add(tr, el('td')); td.setAttribute('data-label', pair[0]); add(td, pair[1]);
      });
    });
  }
  function paint() {
    if (!S.host) return;
    S.host.textContent = '';
    var root = add(S.host, el('div', 'cred-root'));
    add(root, el('p', 'cred-hint', '在这里集中保存数据库/缓存口令，并按插件授权；列表永远不显示口令本身。'));
    paintNotice(add(root, el('div', 'cred-notices')));
    if (S.busy) add(root, el('p', 'cred-hint', '正在处理…'));
    createForm();
    listPanel();
    var dlg = confirmDialog();
    if (dlg) S.host.appendChild(dlg);
  }
  function render(container) {
    if (!container || container.nodeType !== 1) return null;
    S = { rows: [], plugins: [], error: '', notice: '', busy: false, host: container, confirm: null };
    container.textContent = '';
    var css = document.getElementById('kore-credentials-css');
    if (!css) {
      css = el('style'); css.id = 'kore-credentials-css';
      css.textContent = [
        '.cred-panel{margin-bottom:var(--kore-space-4)}',
        '.cred-hint{margin:0 0 var(--kore-space-3);color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.6}',
        '.cred-notice{padding:8px 12px;border-radius:var(--kore-radius-control);margin-bottom:var(--kore-space-2);font-size:var(--kore-font-13)}',
        '.cred-error{color:var(--kore-danger);background:var(--kore-danger-bg)}',
        '.cred-ok{color:var(--kore-success);background:var(--kore-bg-0);border:1px solid var(--kore-border-1)}',
        '.cred-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0 var(--kore-space-4) var(--kore-space-3)}',
        '.cred-field{display:flex;flex-direction:column;gap:4px}',
        '.cred-label{font-size:var(--kore-font-12);color:var(--kore-text-2)}',
        '.cred-input,.cred-select{min-height:38px;padding:0 var(--kore-space-2);color:var(--kore-text-1);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);font:inherit}',
        '.cred-ops{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:0 var(--kore-space-4) var(--kore-space-4)}',
        '.cred-table-wrap{overflow-x:auto}',
        '.cred-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-13)}',
        '.cred-table th{text-align:left;padding:8px 12px;color:var(--kore-text-2);font-weight:400;border-bottom:1px solid var(--kore-border-1);white-space:nowrap}',
        '.cred-table td{padding:10px 12px;border-top:1px solid var(--kore-border-1);vertical-align:top}',
        '.cred-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
        '.cred-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:220px}',
        '.cred-grant-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control)}',
        '.cred-chip-btn{min-height:28px;padding:0 8px;font-size:var(--kore-font-12)}',
        '.cred-danger{color:var(--kore-danger);border-color:var(--kore-danger)}',
        '.cred-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--kore-overlay)}',
        '.cred-dialog{width:100%;max-width:420px;padding:16px;background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container)}',
        '.cred-dialog-title{margin:0 0 8px;font-size:var(--kore-font-16);font-weight:600}',
        '.cred-dialog-hint{margin:0 0 12px;color:var(--kore-text-2);line-height:1.6;font-size:var(--kore-font-13)}',
        '.cred-dialog-ops{display:flex;justify-content:flex-end;gap:8px}',
        '@media (max-width:639px){.cred-form{grid-template-columns:1fr}' +
          '.cred-table thead{display:none}' +
          '.cred-table,.cred-table tbody,.cred-table tr,.cred-table td{display:block;width:100%}' +
          '.cred-table tr{margin-bottom:12px;border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container);overflow:hidden}' +
          '.cred-table td{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--kore-border-1);white-space:normal}' +
          '.cred-table td:first-child{border-top:0}' +
          '.cred-table td::before{content:attr(data-label);color:var(--kore-text-3);font-size:var(--kore-font-12);flex:0 0 auto}' +
          '.cred-actions{min-width:0;justify-content:flex-end}' +
          '.cred-input,.cred-select,.cred-ops .btn,.cred-dialog-ops .btn{min-height:var(--kore-touch)}' +
          '.cred-dialog-ops .btn{flex:1 1 auto}}'
      ].join('');
      document.head.appendChild(css);
    }
    paint();
    load();
    return { destroy: function () { S.host = null; } };
  }
  window.KoreCredentials = { render: render, endpoints: EP };
})();
