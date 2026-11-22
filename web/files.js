/* kore 主壳 · 文件管理（web/files.js）
   入口 window.KoreFiles.render(container)，零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/file/file.list）；方法段写完整限定名。
   路径契约：file 插件只接受配置根目录内的相对路径，根目录用 "."；界面始终显示
   "/docs" 形式，绝不渲染宿主绝对路径。所有 invoke 走 POST + X-Kore-CSRF 双提交。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/file/';
  var MAX_READ = 1048576;
  var S = { path: '', entries: [], selected: null };
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
        if (!res.ok) throw new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        return data;
      });
    });
  }
  function disp(path) { return path ? '/' + path : '/'; }
  function join(base, name) { return base ? base + '/' + name : name; }
  function fmtSize(n) {
    if (typeof n !== 'number') return '—';
    if (n < 1024) return n + ' B';
    return n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(1) + ' MiB';
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function setStatus(text, tone) {
    if (!S.status) return;
    S.status.textContent = text;
    S.status.className = 'files-status ' + (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function ask(title, label, text, onSubmit) {
    var mask = el('div', 'kore-modal');
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
    var box = add(mask, el('form', 'kore-modal-box'));
    add(box, el('div', 'kore-modal-title', title));
    var input = null;
    if (label) {
      var field = add(box, el('label', 'field'));
      add(field, el('span', 'field-label', label));
      input = add(field, el('input', 'field-input'));
      input.type = 'text'; input.autocomplete = 'off';
    } else {
      add(box, el('p', 'kore-modal-text', text || ''));
    }
    var msg = add(box, el('div', 'kore-modal-msg'));
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary', '确定')); ok.type = 'submit';
    function close() { document.removeEventListener('keydown', esc); if (mask.parentNode) mask.parentNode.removeChild(mask); }
    function esc(ev) { if (ev.key === 'Escape') close(); }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', esc);
    box.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var value = input ? input.value.trim() : '';
      if (input && !value) { msg.textContent = '名称不能为空'; return; }
      ok.disabled = true;
      onSubmit(value, close, msg, ok);
    });
    document.body.appendChild(mask);
    if (input) input.focus();
  }
  function badName(name) { return !name || name === '.' || name === '..' || /[\/\\]/.test(name); }
  function newEntry(isDir) {
    var title = isDir ? '新建目录' : '新建文件';
    ask(title, '名称（相对当前路径 ' + disp(S.path) + '）', '', function (name, close, msg, ok) {
      if (badName(name)) { msg.textContent = '名称不能为空，且不能包含 / 或 \\'; ok.disabled = false; return; }
      var path = join(S.path, name);
      var task = isDir ? invoke('file.mkdir', { path: path, mode: '0755' }) : invoke('file.write', { path: path, content: '', create_if_missing: true });
      task.then(function () {
        close();
        setStatus('已创建 ' + disp(path), 'ok');
        refresh();
      }, function (err) { msg.textContent = err.message; ok.disabled = false; });
    });
  }
  function removeEntry(entry) {
    ask('删除确认', null, '将删除 ' + disp(entry.path) + '，此操作不可撤销。', function (_, close, msg, ok) {
      invoke('file.delete', { path: entry.path, recursive: false }).then(function () {
        close();
        if (S.selected && S.selected.path === entry.path) S.selected = null;
        setStatus('已删除 ' + disp(entry.path), 'ok');
        refresh();
      }, function (err) { msg.textContent = err.message; ok.disabled = false; });
    });
  }
  function paintCrumbs() {
    var host = S.crumbs;
    if (!host) return;
    host.textContent = '';
    var root = add(host, el('button', 'files-crumb', '根目录'));
    root.type = 'button';
    on(root, function () { S.path = ''; S.selected = null; refresh(); });
    var segs = S.path ? S.path.split('/') : [];
    var acc = [];
    for (var i = 0; i < segs.length; i++) {
      acc.push(segs[i]);
      add(host, el('span', 'files-sep', '/'));
      var target = acc.join('/');
      var crumb = add(host, el('button', 'files-crumb', segs[i]));
      crumb.type = 'button';
      if (i === segs.length - 1) crumb.setAttribute('aria-current', 'page');
      (function (path) {
        on(crumb, function () { S.path = path; S.selected = null; refresh(); });
      })(target);
    }
  }
  function paintList() {
    if (!S.listHost) return;
    var host = S.listHost;
    host.textContent = '';
    if (S.count) S.count.textContent = S.entries.length + ' 项';
    if (!S.entries.length) {
      var empty = add(host, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '这个目录还是空的，可用上方按钮新建目录或文件'));
      return;
    }
    var table = add(host, el('table', 'files-table'));
    var head = add(table, el('thead'));
    var htr = add(head, el('tr'));
    ['名称', '大小', '修改时间', '权限', '操作'].forEach(function (label) {
      add(htr, el('th', null, label));
    });
    var body = add(table, el('tbody'));
    S.entries.forEach(function (entry) {
      var tr = add(body, el('tr', 'files-row'));
      tr.tabIndex = 0;
      function open() {
        if (entry.is_dir) { S.path = entry.path; S.selected = null; refresh(); }
        else { S.selected = entry; paintPreview(); }
      }
      on(tr, open);
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      var name = add(tr, el('td', 'files-name'));
      name.dataset.label = '名称';
      add(name, el('span', 'files-kind', entry.is_dir ? '目录' : '文件'));
      add(name, el('span', null, entry.name + (entry.is_dir ? '/' : '')));
      var size = add(tr, el('td', null, entry.is_dir ? '—' : fmtSize(entry.size)));
      size.dataset.label = '大小';
      var mod = add(tr, el('td', null, fmtTime(entry.mod_time)));
      mod.dataset.label = '修改时间';
      var mode = add(tr, el('td', null, entry.mode || '—'));
      mode.dataset.label = '权限';
      var ops = add(tr, el('td', 'cell-ops'));
      ops.dataset.label = '操作';
      var del = add(ops, el('button', 'btn btn-ghost files-del', '删除'));
      del.type = 'button';
      del.addEventListener('click', function (ev) { ev.stopPropagation(); removeEntry(entry); });
    });
  }
  function paintPreview() {
    if (!S.previewHost) return;
    var host = S.previewHost;
    host.textContent = '';
    if (S.previewMeta) S.previewMeta.textContent = S.selected ? disp(S.selected.path) : '';
    if (!S.selected) {
      add(host, el('div', 'panel-empty', '点击左侧文件预览内容；目录请点击进入。'));
      return;
    }
    var entry = S.selected;
    var meta = add(host, el('div', 'files-meta'));
    add(meta, el('span', 'tag-muted', entry.mode || '—'));
    var metaSize = add(meta, el('span', 'muted', fmtSize(entry.size) + ' · ' + fmtTime(entry.mod_time)));
    var body = add(host, el('div', 'files-preview-body'));
    invoke('file.read', { path: entry.path, max_bytes: MAX_READ }).then(function (data) {
      if (S.selected !== entry) return;
      if (data.is_binary) {
        add(body, el('div', 'panel-empty', '二进制文件，不支持预览'));
        return;
      }
      var editor = add(body, el('textarea', 'files-editor')); editor.value = data.content || '';
      editor.setAttribute('aria-label', '文件内容：' + entry.name);
      var bar = add(body, el('div', 'files-save-bar'));
      var status = add(bar, el('span', 'muted', '可编辑后保存；单次读取上限 1 MiB。'));
      var save = add(bar, el('button', 'btn btn-primary', '保存'));
      save.type = 'button';
      on(save, function () {
        save.disabled = true;
        invoke('file.write', { path: entry.path, content: editor.value, create_if_missing: false })
          .then(function (res) {
            entry.size = res.size; entry.mod_time = res.mod_time;
            metaSize.textContent = fmtSize(res.size) + ' · ' + fmtTime(res.mod_time);
            save.disabled = false;
            status.textContent = '已保存 ' + disp(entry.path) + '（' + fmtSize(res.size) + '）';
            status.className = 'row-note-ok';
            paintList();
          }, function (err) {
            save.disabled = false;
            status.textContent = '保存失败：' + err.message;
            status.className = 'row-note-fail';
          });
      });
    }, function (err) {
      if (S.selected === entry) add(body, el('div', 'panel-empty', '读取失败：' + err.message));
    });
  }
  function refresh() {
    if (!S.listHost) return;
    setStatus('正在读取 ' + disp(S.path) + '…');
    invoke('file.list', { path: S.path || '.' }).then(function (data) {
      S.path = data.path === '.' ? '' : (data.path || '');
      S.entries = (data.entries || []).slice().sort(function (a, b) {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return String(a.name).localeCompare(String(b.name), 'zh-CN');
      });
      if (S.selected) S.selected = S.entries.filter(function (e) { return e.path === S.selected.path; })[0] || null;
      paintCrumbs(); paintList(); paintPreview();
      setStatus('共 ' + S.entries.length + ' 项 · ' + disp(S.path), 'ok');
    }, function (err) {
      setStatus('读取失败：' + err.message, 'fail');
      paintCrumbs(); paintList();
    });
  }
  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '文件管理'));
    add(head, el('p', 'view-sub', '浏览、预览与编辑文件根目录内容；路径始终以根目录相对形式显示。'));
    var bar = add(root, el('div', 'files-toolbar'));
    S.crumbs = add(bar, el('nav', 'files-crumbs'));
    S.crumbs.setAttribute('aria-label', '当前路径');
    var actions = add(bar, el('div', 'files-actions'));
    var mk = add(actions, el('button', 'btn', '新建目录')); mk.type = 'button';
    on(mk, function () { newEntry(true); });
    var nf = add(actions, el('button', 'btn', '新建文件')); nf.type = 'button';
    on(nf, function () { newEntry(false); });
    var rf = add(actions, el('button', 'btn btn-ghost', '刷新')); rf.type = 'button';
    on(rf, refresh);
    S.status = add(root, el('div', 'files-status muted'));
    S.status.setAttribute('role', 'status');
    var layout = add(root, el('div', 'files-layout'));
    var listPanel = add(layout, el('section', 'panel files-list-panel'));
    var listHead = add(listPanel, el('div', 'panel-head'));
    add(listHead, el('span', 'panel-title', '目录内容'));
    S.count = add(listHead, el('span', 'panel-meta', ''));
    S.listHost = add(listPanel, el('div', 'files-list-host'));
    var previewPanel = add(layout, el('section', 'panel files-preview-panel'));
    var previewHead = add(previewPanel, el('div', 'panel-head'));
    add(previewHead, el('span', 'panel-title', '文件预览'));
    S.previewMeta = add(previewHead, el('span', 'panel-meta', ''));
    S.previewHost = add(previewPanel, el('div', 'files-preview-host'));
  }
  function render(container) {
    if (!container) return null;
    S.path = ''; S.entries = []; S.selected = null;
    container.textContent = '';
    var root = add(container, el('section', 'files'));
    build(root); refresh();
  }
  window.KoreFiles = { render: render };
})();
