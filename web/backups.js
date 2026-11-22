/* kore 主壳 · 备份管理（web/backups.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/backup/backup.list）；
   方法段一律写完整限定名 backup.*，裸动词只是插件侧兼容，不得依赖。
   window.KoreBackup.render(container) 调 backup 插件：backup.create / .list / .verify / .restore / .delete。
   恢复与删除一律走页面内二次确认面板（不用 window.confirm）：先展示完整参数，再允许提交。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/backup/';
  function fresh() {
    return { root: null, backups: [], destroyed: false, status: null, result: null, resultHost: null,
      confirm: null, confirmHost: null, confirmMsg: null, busy: false, name: null, paths: null,
      exclude: null, compression: null, submit: null };
  }
  var S = fresh();
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
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
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || ''; throw err;
        }
        return data;
      });
    });
  }
  function fmtSize(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MiB';
    return (n / 1073741824).toFixed(2) + ' GiB';
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function setStatus(text, tone) {
    if (!S.status) return;
    S.status.textContent = text;
    S.status.className = 'bak-status ' + (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function panel(parent, title, meta) {
    var p = add(parent, el('section', 'panel')), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    if (meta) add(h, el('span', 'panel-meta', meta));
    return p;
  }
  function kv(parent, label, value) {
    add(parent, el('dt', null, label));
    var dd = add(parent, el('dd', null, value === undefined || value === null || value === '' ? '—' : value));
    return dd;
  }
  function field(form, label, control, span) {
    var box = add(form, el('label', 'field' + (span ? ' ' + span : '')));
    add(box, el('span', 'field-label', label)); box.appendChild(control); return box;
  }
  function input(type, cls, ph) {
    var n = el('input', 'field-input' + (cls ? ' ' + cls : ''));
    n.type = type; if (ph) n.placeholder = ph;
    n.autocomplete = 'off'; n.spellcheck = false; return n;
  }
  function textarea(rows, ph) {
    var n = el('textarea', 'bak-textarea');
    n.rows = rows; n.placeholder = ph || ''; n.autocomplete = 'off'; n.spellcheck = false; return n;
  }
  function paintList() {
    if (!S.listHost) return;
    S.listHost.textContent = ''; S.count.textContent = S.backups.length ? S.backups.length + ' 个' : '';
    if (!S.backups.length) {
      var empty = add(S.listHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '还没有备份；建议先备份站点目录'));
      return;
    }
    var scroll = add(S.listHost, el('div', 'bak-table-host'));
    var table = add(scroll, el('table', 'bak-table')); table.setAttribute('aria-label', '备份列表');
    var htr = add(add(table, el('thead')), el('tr'));
    ['名称', '创建时间', '大小', '条目', 'SHA256', '状态', '操作'].forEach(function (label) {
      add(htr, el('th', null, label));
    });
    var body = add(table, el('tbody'));
    S.backups.forEach(function (b) {
      var tr = add(body, el('tr'));
      var name = add(tr, el('td', 'bak-name-cell')); name.dataset.label = '名称';
      add(name, el('span', 'bak-name', b.name || '—'));
      if (b.id) add(name, el('span', 'bak-id', b.id));
      var created = add(tr, el('td', null, fmtTime(b.created_at))); created.dataset.label = '创建时间';
      var size = add(tr, el('td', null, fmtSize(b.size_bytes))); size.dataset.label = '大小';
      var entries = add(tr, el('td', null, typeof b.entries === 'number' ? b.entries : '—'));
      entries.dataset.label = '条目';
      var sha = b.sha256 || '', shaCell = add(tr, el('td')); shaCell.dataset.label = 'SHA256';
      var code = add(shaCell, el('code', 'bak-sha', sha ? sha.slice(0, 12) : '—')); code.title = sha;
      var state = add(tr, el('td')); state.dataset.label = '状态';
      state.appendChild(b.corrupted ? chip('fail', 'corrupted') : chip('ok', '正常'));
      var ops = add(tr, el('td', 'cell-ops bak-ops')); ops.dataset.label = '操作';
      var v = add(ops, el('button', 'btn btn-ghost', '校验')); v.type = 'button';
      on(v, function () { verify(b); });
      var r = add(ops, el('button', 'btn btn-ghost', '恢复')); r.type = 'button';
      on(r, function () { openConfirm('restore', b); });
      var d = add(ops, el('button', 'btn btn-ghost bak-danger', '删除')); d.type = 'button';
      on(d, function () { openConfirm('delete', b); });
    });
  }
  function resultTitle(kind) {
    return { create: '创建结果', verify: '校验结果', restore: '恢复结果', delete: '删除结果' }[kind] || '操作结果';
  }
  function paintResult() {
    if (!S.resultHost) return;
    S.resultHost.textContent = '';
    if (!S.result) return;
    var r = S.result, d = r.data || {};
    var p = panel(S.resultHost, resultTitle(r.kind), r.id || ''), dl = add(p, el('dl', 'bak-kv bak-result-body'));
    if (r.kind === 'create') {
      kv(dl, 'size_bytes', fmtSize(d.size_bytes) + '（' + (d.size_bytes != null ? d.size_bytes : '—') + ' B）');
      kv(dl, 'entries', d.entries); kv(dl, 'sha256', d.sha256); kv(dl, 'duration_ms', d.duration_ms);
    } else if (r.kind === 'verify') {
      kv(dl, 'sha_match', String(d.sha_match)); kv(dl, 'entries', d.entries);
      kv(dl, 'size_bytes', fmtSize(d.size_bytes)); kv(dl, 'uncompressed_bytes', fmtSize(d.uncompressed_bytes));
      kv(dl, 'sha256', d.sha256); kv(dl, 'corrupted', String(d.corrupted)); kv(dl, 'duration_ms', d.duration_ms);
    } else if (r.kind === 'restore') {
      kv(dl, 'restored_entries', d.restored_entries); kv(dl, 'target_dir', d.target_dir);
      kv(dl, 'failed', (d.failed || []).length); kv(dl, 'duration_ms', d.duration_ms);
      if (d.failed && d.failed.length) {
        var fl = add(p, el('ul', 'bak-failed'));
        d.failed.forEach(function (item) { add(fl, el('li', null, item)); });
      }
    } else {
      kv(dl, 'id', d.id); kv(dl, 'deleted', String(d.deleted)); kv(dl, 'duration_ms', d.duration_ms);
    }
    if (d.skipped && d.skipped.length) add(p, el('p', 'field-hint', '跳过：' + d.skipped.join('、')));
    if (d.warnings && d.warnings.length) add(p, el('p', 'field-hint', '警告：' + d.warnings.join('、')));
  }
  function openConfirm(kind, b) { S.confirm = { kind: kind, backup: b, target: '', msg: null };
    paintConfirm();
    if (S.confirmHost) S.confirmHost.scrollIntoView({ block: 'nearest' });
  }
  function paintConfirm() {
    if (!S.confirmHost) return;
    S.confirmHost.textContent = ''; S.confirmMsg = null;
    if (!S.confirm) return;
    var c = S.confirm, b = c.backup || {};
    var p = add(S.confirmHost, el('section', 'panel bak-confirm'));
    var h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', c.kind === 'restore' ? '恢复确认' : '删除确认'));
    add(h, el('span', 'panel-meta', '二次确认 · 页面内'));
    var dl = add(p, el('dl', 'bak-kv bak-confirm-body'));
    kv(dl, 'id', b.id); kv(dl, 'name', b.name); kv(dl, 'created_at', fmtTime(b.created_at));
    kv(dl, 'size_bytes', fmtSize(b.size_bytes)); kv(dl, 'entries', b.entries);
    kv(dl, 'sha256', b.sha256);
    if (c.kind === 'restore') {
      add(p, el('p', 'bak-warn', '目标目录必须不存在，或存在且为空目录；非空目标会被插件拒绝（E_CONFLICT），不会覆盖已有文件。'));
      var f = add(p, el('form', 'bak-confirm-form'));
      c.targetInput = input('text', 'span2', '/tmp/restore-target');
      field(f, '目标目录', c.targetInput, 'span2');
      var ops = add(f, el('div', 'bak-confirm-ops span2'));
      var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button'; on(cancel, closeConfirm);
      var ok = add(ops, el('button', 'btn btn-primary', '确认恢复')); ok.type = 'submit';
      f.addEventListener('submit', function (ev) { ev.preventDefault(); doRestore(c, ok); });
    } else {
      add(p, el('p', 'bak-warn', '删除会同时移除备份包与 .sha256 / .meta.json sidecar，不可恢复。'));
      var ops2 = add(p, el('div', 'bak-confirm-ops'));
      var cancel2 = add(ops2, el('button', 'btn btn-ghost', '取消')); cancel2.type = 'button'; on(cancel2, closeConfirm);
      var ok2 = add(ops2, el('button', 'btn bak-danger', '确认删除')); ok2.type = 'button'; on(ok2, function () { doDelete(c, ok2); });
    }
    S.confirmMsg = add(p, el('div', 'bak-confirm-msg'));
  }
  function closeConfirm() { S.confirm = null; paintConfirm(); }
  function doRestore(c, btn) {
    var target = c.targetInput.value.trim();
    if (!target) { if (S.confirmMsg) S.confirmMsg.textContent = '请填写恢复目标目录'; return; }
    btn.disabled = true; if (S.confirmMsg) S.confirmMsg.textContent = '';
    setStatus('正在恢复 ' + c.backup.id + ' 到 ' + target + '…');
    invoke('backup.restore', { id: c.backup.id, target_dir: target }).then(function (data) {
      S.result = { kind: 'restore', id: c.backup.id, data: data };
      S.confirm = null; paintConfirm(); paintResult();
      var failed = (data.failed || []).length;
      setStatus('恢复完成：' + data.restored_entries + ' 个条目' + (failed ? '，失败 ' + failed + ' 个' : '，无失败'),
        failed ? 'fail' : 'ok');
      loadList(true);
    }, function (err) {
      btn.disabled = false;
      if (S.confirmMsg) S.confirmMsg.textContent = '恢复失败：' + err.message;
      setStatus('恢复失败：' + err.message, 'fail');
    });
  }
  function doDelete(c, btn) {
    btn.disabled = true; if (S.confirmMsg) S.confirmMsg.textContent = '';
    invoke('backup.delete', { id: c.backup.id }).then(function (data) {
      S.result = { kind: 'delete', id: c.backup.id, data: data };
      S.confirm = null; paintConfirm(); paintResult();
      setStatus('已删除备份 ' + data.id + '（deleted=' + data.deleted + '，' + data.duration_ms + 'ms）', 'ok');
      loadList(true);
    }, function (err) {
      btn.disabled = false;
      if (S.confirmMsg) S.confirmMsg.textContent = '删除失败：' + err.message;
      setStatus('删除失败：' + err.message, 'fail');
    });
  }
  function verify(b) {
    setStatus('正在校验 ' + b.id + '…');
    invoke('backup.verify', { id: b.id }).then(function (data) {
      S.result = { kind: 'verify', id: b.id, data: data }; paintResult();
      setStatus('校验完成：sha_match=' + data.sha_match + ' · entries=' + data.entries +
        ' · uncompressed=' + fmtSize(data.uncompressed_bytes), data.sha_match ? 'ok' : 'fail');
      loadList(true);
    }, function (err) {
      setStatus('校验失败：' + err.message, 'fail');
    });
  }
  function loadList(quiet) {
    if (!quiet) setStatus('正在读取备份列表…');
    invoke('backup.list', {}).then(function (data) {
      if (S.destroyed) return;
      S.backups = data.backups || []; paintList();
      if (!quiet) setStatus('共 ' + S.backups.length + ' 个备份', 'ok');
    }, function (err) {
      if (S.destroyed) return;
      setStatus('读取失败：' + err.message, 'fail'); S.backups = []; paintList();
    });
  }
  function submitCreate(ev) {
    ev.preventDefault();
    var name = S.name.value.trim(), paths = S.paths.value.split('\n').map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
    var exclude = S.exclude.value.split(/[\n,]/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
    if (!name) { setStatus('请填写备份名称', 'fail'); return; }
    if (!paths.length) { setStatus('请至少填写一个备份路径（每行一个）', 'fail'); return; }
    S.busy = true; S.submit.disabled = true;
    setStatus('正在打包 ' + name + '（' + paths.length + ' 个路径，' + S.compression.value + '）…');
    invoke('backup.create', { name: name, paths: paths, exclude: exclude, compression: S.compression.value })
      .then(function (data) {
        S.busy = false; S.submit.disabled = false;
        S.result = { kind: 'create', id: data.id, data: data }; paintResult();
        setStatus('备份已创建：' + data.id + ' · ' + fmtSize(data.size_bytes) + ' · ' + data.entries +
          ' 条目 · sha ' + String(data.sha256 || '').slice(0, 12) + ' · ' + data.duration_ms + 'ms', 'ok');
        S.paths.value = ''; loadList(true);
      }, function (err) {
        S.busy = false; S.submit.disabled = false;
        setStatus('创建失败：' + err.message, 'fail');
      });
  }
  function openConfig() {
    if (!S.root) return;
    if (!window.KoreShell || typeof window.KoreShell.openConfig !== 'function') {
      setStatus('配置面板未加载，请刷新页面后重试', 'fail'); return;
    }
    window.KoreShell.openConfig(S.root, 'backup', {
      title: '备份设置',
      onSaved: function () { loadList(true); }
    });
  }
  function build(root) {
    S.root = root;
    var head = add(root, el('header', 'view-head view-head-split'));
    var headMain = add(head, el('div', 'view-head-main'));
    add(headMain, el('h2', 'view-title', '备份'));
    add(headMain, el('p', 'view-sub', '打包目录、校验完整性、恢复到空目录；恢复与删除都需要页面内二次确认。'));
    var gear = add(head, el('button', 'btn btn-ghost cfg-gear', '⚙ 设置'));
    gear.type = 'button';
    gear.setAttribute('aria-label', '备份设置');
    on(gear, openConfig);
    S.status = add(root, el('div', 'bak-status muted')); S.status.setAttribute('role', 'status');
    S.confirmHost = add(root, el('div', 'bak-confirm-host'));
    var create = panel(root, '新建备份', 'gzip 或无压缩 tar'), form = add(create, el('form', 'bak-form'));
    S.name = input('text', 'span2', 'site-20261122'); field(form, '名称', S.name, 'span2');
    S.paths = textarea(4, '/var/www/site\n/etc/kore'); field(form, '路径列表（每行一个）', S.paths, 'span2');
    S.exclude = input('text', 'span2', '*.log, node_modules（可选，glob）'); field(form, '排除 glob（可选）', S.exclude, 'span2');
    S.compression = el('select', 'field-input');
    [['gzip', 'gzip 压缩'], ['none', '不压缩（tar）']].forEach(function (o) {
      var opt = el('option', null, o[1]); opt.value = o[0]; S.compression.appendChild(opt);
    });
    field(form, '压缩', S.compression);
    S.submit = add(form, el('button', 'btn btn-primary bak-submit', '创建备份')); S.submit.type = 'submit';
    add(form, el('p', 'field-hint span2', '路径必须在「设置」里的允许根路径之下；点右上角设置可改备份目录与白名单。符号链接按链接记录。'));
    form.addEventListener('submit', submitCreate);
    var list = panel(root, '备份列表');
    S.count = list.querySelector('.panel-head').appendChild(el('span', 'panel-meta', ''));
    S.listHost = add(list, el('div', 'bak-list'));
    S.resultHost = add(root, el('div', 'bak-result-host'));
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    var root = add(container, el('section', 'backups'));
    build(root); loadList(false);
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreBackup = { render: render };
})();
