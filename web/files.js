/* kore 主壳 · 文件管理（web/files.js）
   入口 window.KoreFiles.render(container)，零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/file/file.list）；方法段写完整限定名。
   路径契约：file 插件只接受配置根目录内的相对路径，根目录用 "."；界面始终显示
   "/docs" 形式，绝不渲染宿主绝对路径。所有 invoke 走 POST + X-Kore-CSRF 双提交。
   L2/L3 操作（上传/下载/压缩/解压/权限/移动/复制/批量删除）在首次使用时才注入 files-l2.js，
   首屏请求数不随能力增加而增长；搜索、回收站与同目录改名直接走本文件的 invoke。
   删除语义：file.delete 默认把目标移入回收站（可在本页「回收站」里恢复），
   彻底删除只在回收站的「彻底删除」里发生，且必须二次确认。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/file/';
  var MAX_READ = 1048576;
  var MAX_INLINE = 5 * 1024 * 1024;
  var S = {
    path: '', entries: [], selected: null, checked: {}, l2: null, l2Ready: null,
    // view: files（目录列表）/ search（搜索结果）/ trash（回收站）
    view: 'files',
    search: { mode: 'name', query: '', result: null, active: false },
    trash: { total: 0, entries: [], checked: {}, loading: false },
    renaming: null
  };
  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
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
          // 后端 message 原文必须原样到达界面；code 与 detail 一并保留供排障。
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || ''; err.detail = data.detail || ''; throw err;
        }
        return data;
      });
    });
  }
  function errText(err) {
    var text = err && err.message ? String(err.message) : '未知错误';
    return err && err.detail && text.indexOf(err.detail) < 0 ? text + '（' + err.detail + '）' : text;
  }
  function hintFor(action, err) {
    var msg = err ? String(err.message || '') : '';
    if (/单帧|过大|超过.*上传|超过.*下载/.test(msg)) return '单帧上限 8 MiB，大文件请先压缩或用终端上传。';
    if (err && err.code === 'E_CONFLICT') return '目标已存在：勾选「覆盖」后重试，或换一个名称。';
    if (action === 'extract') return '解压先整包校验路径安全，含 .. / 绝对路径的条目会整包拒绝。';
    if (action === 'chmod') return 'mode 用八进制；目录必须保留执行位（如 0755）。';
    if (action === 'search') return '按文件名支持通配（如 *.log）；按内容只搜文本文件，单文件上限 1 MiB。';
    if (action === 'copy' && err && err.code === 'E_CONFLICT') return '目标已存在：勾选「覆盖同名」后重试，或换一个目录。';
    if (action === 'rename') return '只支持同目录改名；同名冲突时换个名字，要换目录请用「移动」。';
    if (action === 'batch') return '批量里单条失败不影响其他条目；失败项会逐条列出原因，可修好后重试。';
    if (action === 'restore') return '原路径已有同名项：确认覆盖恢复，或先移走它。';
    return '';
  }
  function showErr(action, err) {
    var hint = hintFor(action, err);
    setStatus('操作失败：' + errText(err) + (hint ? ' ' + hint : ''), 'fail');
  }
  function disp(path) { return path ? '/' + path : '/'; }
  function join(base, name) { return base ? base + '/' + name : name; }
  function fmtSize(n) {
    if (typeof n !== 'number') return '—'; if (n < 1024) return n + ' B';
    return n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(1) + ' MiB';
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function isArchive(name) { return /\.(zip|tar\.gz|tgz|tar)$/i.test(String(name || '')); }
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
      ev.preventDefault(); var value = input ? input.value.trim() : '';
      if (input && !value) { msg.textContent = '名称不能为空'; return; }
      ok.disabled = true; onSubmit(value, close, msg, ok);
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
        close(); setStatus('已创建 ' + disp(path), 'ok'); refresh();
      }, function (err) { msg.textContent = errText(err); ok.disabled = false; });
    });
  }
  // batchMove 走 file.batch 的 move：一条请求搬多个，逐项成功/失败分组交代。
  function batchMove() {
    var entries = checkedEntries();
    if (!entries.length) { setStatus('请先勾选要移动的条目', 'fail'); return; }
    ask('批量移动到', '目标目录（相对根目录，如 docs；不能为空）', null, function (value, close, msg, ok) {
      var target = String(value || '').trim();
      var items = entries.map(function (entry) { return { src: entry.path, dst: join(target, entry.name) }; });
      ok.disabled = true;
      invoke('file.batch', { op: 'move', items: items }).then(function (data) {
        var failed = (data.items || []).filter(function (item) { return !item.ok; })
          .map(function (item) { return disp(item.src || item.path) + '：' + (item.error ? (item.error.message || item.error.code) : '失败'); });
        S.checked = {};
        close();
        refresh();
        if (!failed.length) { setStatus('已移动 ' + data.succeeded + ' 项到 ' + (target ? '/' + target : '/'), 'ok'); return; }
        setStatus('批量移动：成功 ' + data.succeeded + ' 项 / 失败 ' + data.failed + ' 项', 'fail');
      }, function (err) {
        ok.disabled = false;
        msg.textContent = errText(err) + ' ' + hintFor('batch', err);
      });
    });
  }
  // removeEntry 走 file.delete 的默认语义：移入回收站（可恢复），不在这里提供彻底删除。
  function removeEntry(entry) {
    ask('移入回收站确认', null,
      '将把 ' + disp(entry.path) + ' 移入回收站，可在本页「回收站」里恢复。彻底删除需要到回收站里再操作一次。',
      function (_, close, msg, ok) {
        invoke('file.delete', { path: entry.path, recursive: false }).then(function (res) {
          close(); if (S.selected && S.selected.path === entry.path) S.selected = null;
          delete S.checked[entry.path];
          setStatus('已移入回收站：' + disp(entry.path) + '（可恢复）', 'ok');
          refresh(); loadTrashCount();
        }, function (err) { msg.textContent = errText(err); ok.disabled = false; });
      });
  }
  function checkedEntries() {
    return S.entries.filter(function (entry) { return S.checked[entry.path]; });
  }
  function pruneChecked() {
    var next = {};
    S.entries.forEach(function (entry) { if (S.checked[entry.path]) next[entry.path] = true; });
    S.checked = next;
  }
  function deps() {
    return {
      state: S, invoke: invoke, ui: { el: el, add: add, on: on }, refresh: refresh,
      setStatus: setStatus, errText: errText, hintFor: hintFor, disp: disp, join: join,
      fmtSize: fmtSize, isArchive: isArchive, maxInline: MAX_INLINE
    };
  }
  // ensureL2 只在首次 L2 动作时注入 files-l2.js；失败清缓存，允许下次重试。
  function ensureL2() {
    if (S.l2) return Promise.resolve(S.l2);
    if (!S.l2Ready) {
      S.l2Ready = new Promise(function (resolve, reject) {
        if (window.KoreFilesL2 && typeof window.KoreFilesL2.bind === 'function') { resolve(); return; }
        var script = document.createElement('script');
        script.src = '/assets/files-l2.js'; script.async = true;
        script.onload = function () {
          if (!window.KoreFilesL2 || typeof window.KoreFilesL2.bind !== 'function') { reject(new Error('files-l2.js 未导出 KoreFilesL2.bind')); return; }
          resolve();
        };
        script.onerror = function () { reject(new Error('files-l2.js 加载失败')); };
        document.head.appendChild(script);
      });
      S.l2Ready.catch(function () { S.l2Ready = null; });
    }
    return S.l2Ready.then(function () {
      if (!S.l2) S.l2 = window.KoreFilesL2.bind(deps());
      return S.l2;
    });
  }
  function runL2(action) {
    var args = Array.prototype.slice.call(arguments, 1);
    return ensureL2().then(function (mod) {
      if (typeof mod[action] !== 'function') throw new Error('files-l2 不支持 ' + action);
      return mod[action].apply(null, args);
    }).catch(function (err) { showErr(action, err); });
  }
  function updateSelection() {
    var list = checkedEntries();
    if (S.selLabel) S.selLabel.textContent = list.length ? '已选 ' + list.length + ' 项' : '';
    if (S.compressBtn) S.compressBtn.disabled = !list.length;
    if (S.batchDel) S.batchDel.disabled = !list.length;
    if (S.batchMove) S.batchMove.disabled = !list.length;
    var single = targetEntry();
    if (S.renameBtn) S.renameBtn.disabled = !single;
    if (S.copyBtn) S.copyBtn.disabled = !single;
    if (S.trashRestoreBtn) S.trashRestoreBtn.disabled = !trashCheckedIds().length;
    if (S.trashPurgeBtn) S.trashPurgeBtn.disabled = !trashCheckedIds().length;
    if (S.selectAll) {
      S.selectAll.checked = !!S.entries.length && list.length === S.entries.length;
      S.selectAll.indeterminate = list.length > 0 && list.length < S.entries.length;
    }
    // 只在目录列表视图回写勾选状态：回收站的勾选按 id 存在 S.trash.checked 里，
    // 这里若无差别回写会把回收站刚勾上的复选框立刻重置（P1，实测 checkbox 勾不上）。
    if (S.listHost && S.view !== 'trash') {
      var boxes = S.listHost.querySelectorAll('.files-checkbox[data-path]');
      for (var i = 0; i < boxes.length; i++) {
        boxes[i].checked = !!S.checked[boxes[i].getAttribute('data-path')];
      }
    }
  }
  function paintCrumbs() {
    var host = S.crumbs;
    if (!host) return;
    host.textContent = '';
    var root = add(host, el('button', 'files-crumb', '根目录'));
    root.type = 'button';
    on(root, function () { goPath(''); });
    var segs = S.path ? S.path.split('/') : [];
    var acc = [];
    for (var i = 0; i < segs.length; i++) {
      acc.push(segs[i]);
      add(host, el('span', 'files-sep', '/'));
      var target = acc.join('/');
      var crumb = add(host, el('button', 'files-crumb', segs[i])); crumb.type = 'button';
      if (i === segs.length - 1) crumb.setAttribute('aria-current', 'page');
      (function (path) { on(crumb, function () { goPath(path); }); })(target);
    }
  }
  function rowOp(ops, label, cls, action, entry) {
    var btn = add(ops, el('button', 'btn btn-ghost ' + cls, label));
    btn.type = 'button'; btn.setAttribute('data-action', action); btn.setAttribute('data-path', entry.path);
    btn.addEventListener('click', function (ev) { ev.stopPropagation(); runL2(action, entry); });
    return btn;
  }
  function paintList() {
    if (!S.listHost) return;
    var host = S.listHost;
    host.textContent = '';
    if (S.count) S.count.textContent = S.entries.length + ' 项';
    if (!S.entries.length) {
      var empty = add(host, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '这个目录还是空的，可用上方按钮新建目录、文件或上传'));
      updateSelection();
      return;
    }
    var table = add(host, el('table', 'files-table'));
    var head = add(table, el('thead'));
    var htr = add(head, el('tr'));
    var checkHead = add(htr, el('th', 'files-check-head'));
    S.selectAll = add(checkHead, el('input', 'files-checkbox files-check-all'));
    S.selectAll.type = 'checkbox'; S.selectAll.setAttribute('aria-label', '全选当前目录');
    S.selectAll.addEventListener('change', function () {
      S.checked = {};
      if (S.selectAll.checked) {
        for (var i = 0; i < S.entries.length; i++) S.checked[S.entries[i].path] = true;
      }
      paintList();
    });
    ['名称', '大小', '修改时间', '权限', '操作'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.entries.forEach(function (entry) {
      var tr = add(body, el('tr', 'files-row'));
      tr.setAttribute('data-entry-path', entry.path);
      tr.tabIndex = 0;
      function open() {
        if (entry.is_dir) { goPath(entry.path); return; }
        S.selected = entry; paintPreview(); updateSelection();
      }
      on(tr, open);
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      var sel = add(tr, el('td', 'files-check'));
      sel.dataset.label = '选择';
      var box = add(sel, el('input', 'files-checkbox'));
      box.type = 'checkbox'; box.setAttribute('data-path', entry.path);
      box.setAttribute('aria-label', '选择 ' + entry.name); box.checked = !!S.checked[entry.path];
      box.addEventListener('click', function (ev) { ev.stopPropagation(); });
      box.addEventListener('change', function () {
        if (box.checked) S.checked[entry.path] = true; else delete S.checked[entry.path];
        updateSelection();
      });
      var name = add(tr, el('td', 'files-name')); name.dataset.label = '名称';
      add(name, el('span', 'files-kind', entry.is_dir ? '目录' : '文件'));
      var nameText = add(name, el('span', 'files-name-text', entry.name + (entry.is_dir ? '/' : '')));
      nameText.title = '双击改名（只改同目录下的名字）';
      nameText.addEventListener('dblclick', function (ev) { ev.stopPropagation(); startRename(entry, name); });
      var size = add(tr, el('td', null, entry.is_dir ? '—' : fmtSize(entry.size))); size.dataset.label = '大小';
      var mod = add(tr, el('td', null, fmtTime(entry.mod_time))); mod.dataset.label = '修改时间';
      var mode = add(tr, el('td', null, entry.mode || '—')); mode.dataset.label = '权限';
      var ops = add(tr, el('td', 'cell-ops')); ops.dataset.label = '操作';
      // 行操作清单：桌面平铺；手机收进「⋯」菜单（每个菜单项 min-height 44px，满足触摸目标）。
      var opList = [];
      if (!entry.is_dir) opList.push(['下载', 'files-download', 'download', function () { runL2('download', entry); }]);
      if (!entry.is_dir && isArchive(entry.name)) opList.push(['解压', 'files-extract', 'extract', function () { runL2('extract', entry); }]);
      opList.push(['改名', 'files-rename', 'rename', function () { startRename(entry, name); }]);
      opList.push(['复制到…', 'files-copy', 'copy', function () { runL2('copy', entry); }]);
      opList.push(['权限', 'files-chmod', 'chmod', function () { runL2('chmod', entry); }]);
      opList.push(['移动', 'files-move', 'move', function () { runL2('move', entry); }]);
      opList.push(['删除', 'files-del', 'delete', function () { removeEntry(entry); }]);
      var narrow = window.matchMedia('(max-width: 639px)').matches;
      if (narrow) {
        ops.style.position = 'relative';
        var more = add(ops, el('button', 'btn btn-ghost files-more', '⋯'));
        more.type = 'button'; more.setAttribute('aria-label', '更多操作：' + entry.name);
        more.setAttribute('aria-haspopup', 'true'); more.setAttribute('aria-expanded', 'false');
        more.style.minHeight = '44px';
        var menu = add(ops, el('div', 'files-ops-menu'));
        menu.style.cssText = 'position:absolute;right:4px;top:100%;z-index:20;display:none;flex-direction:column;gap:4px;padding:6px;' +
          'background:var(--kore-bg-1);border:1px solid var(--kore-border-2);border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.35)';
        opList.forEach(function (def) {
          var item = add(menu, el('button', 'btn btn-ghost ' + def[1], def[0]));
          item.type = 'button'; item.style.minHeight = '44px'; item.setAttribute('data-action', def[2]);
          item.addEventListener('click', function (ev) { ev.stopPropagation(); menu.style.display = 'none'; def[3](); });
        });
        more.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var open = menu.style.display === 'flex';
          menu.style.display = open ? 'none' : 'flex';
          more.setAttribute('aria-expanded', open ? 'false' : 'true');
        });
      } else {
        opList.forEach(function (def) {
          var btn = add(ops, el('button', 'btn btn-ghost ' + def[1], def[0]));
          btn.type = 'button'; btn.setAttribute('data-action', def[2]); btn.setAttribute('data-path', entry.path);
          btn.addEventListener('click', function (ev) { ev.stopPropagation(); def[3](); });
        });
      }
    });
    updateSelection();
  }
  // b64ToBytes / bytesToB64 / sha256Hex 是编辑器的最小工具：
  // 后端 readRange/writeRange 用 base64 过协议，乐观锁摘要由浏览器 WebCrypto 计算（127.0.0.1/localhost 为安全上下文）。
  function b64ToBytes(b64) {
    var raw = atob(b64 || '');
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var chunks = [], step = 0x8000;
    for (var i = 0; i < bytes.length; i += step) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + step)));
    }
    return btoa(chunks.join(''));
  }
  function sha256Hex(bytes) {
    if (!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest)) return Promise.resolve(null);
    return window.crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      var view = new Uint8Array(buf), hex = '';
      for (var i = 0; i < view.length; i++) hex += (view[i] < 16 ? '0' : '') + view[i].toString(16);
      return hex;
    }, function () { return null; });
  }
  // startEdit 通过 readRange 一次性取回整文件（≤∞.95 MiB），做二进制判定并算乐观锁摘要。
  function startEdit(entry) {
    if (entry.size > MAX_INLINE) { setStatus('文件过大，仅支持预览，不支持在线编辑', 'fail'); return; }
    setStatus('正在加载编辑器…');
    invoke('file.readRange', { path: entry.path, offset: 0, limit: MAX_INLINE }).then(function (data) {
      var bytes = b64ToBytes(data.data_base64);
      for (var i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) { setStatus('二进制文件不支持编辑', 'fail'); return; }
      }
      var text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (err) { setStatus('文件不是 UTF-8 文本，暂不支持在线编辑', 'fail'); return; }
      return sha256Hex(bytes).then(function (sha) {
        S.editor = { path: entry.path, text: text, sha: sha, size: bytes.length };
        paintPreview();
        setStatus('已加载 ' + fmtSize(bytes.length) + (sha ? '，保存时校验摘要' : '（浏览器不支持摘要，关闭乐观锁）'), 'ok');
      });
    }, function (err) {
      setStatus('打开编辑器失败：' + errText(err), 'fail');
    });
  }
  // saveEdit 走 writeRange：整文件覆盖写 + expected_sha256 乐观锁；冲突给人话而不是 E_CONFLICT。
  function saveEdit(entry, editor, save, status) {
    var bytes = new TextEncoder().encode(editor.value);
    if (bytes.length > MAX_INLINE) { status.textContent = '内容超过单帧上限，请拆分文件'; return; }
    var params = { path: entry.path, offset: 0, data_base64: bytesToB64(bytes) };
    if (S.editor.sha) params.expected_sha256 = S.editor.sha;
    save.disabled = true;
    invoke('file.writeRange', params).then(function (res) {
      S.editor = null;
      status.className = 'row-note-ok';
      status.textContent = '已保存（' + fmtSize(res.size) + '）';
      refresh();
    }, function (err) {
      save.disabled = false;
      status.className = 'row-note-fail';
      if (err && err.code === 'E_CONFLICT') {
        status.textContent = '文件已被其他会话修改，请刷新后重试';
        return;
      }
      status.textContent = '保存失败：' + errText(err);
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
    if (S.editor && S.editor.path === entry.path) {
      var editor = add(body, el('textarea', 'files-editor'));
      editor.value = S.editor.text;
      editor.setAttribute('aria-label', '编辑文件：' + entry.name);
      var bar = add(body, el('div', 'files-save-bar'));
      var status = add(bar, el('span', 'muted', '保存会用乐观锁校验；被其他会话改过会提示刷新。'));
      var save = add(bar, el('button', 'btn btn-primary', '保存')); save.type = 'button';
      var cancel = add(bar, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
      on(save, function () { saveEdit(entry, editor, save, status); });
      on(cancel, function () { S.editor = null; paintPreview(); setStatus('已退出编辑', 'ok'); });
      return;
    }
    var ops = add(host, el('div', 'files-actions'));
    var editBtn = add(ops, el('button', 'btn', '编辑')); editBtn.type = 'button';
    editBtn.disabled = entry.is_dir || entry.size > MAX_INLINE;
    on(editBtn, function () { startEdit(entry); });
    if (entry.size > MAX_INLINE) add(ops, el('span', 'files-selected muted', '文件过大，仅支持预览，不支持在线编辑'));
    else if (!entry.is_dir) add(ops, el('span', 'files-selected muted', '在线编辑上限 ' + fmtSize(MAX_INLINE)));
    if (entry.is_dir) { add(body, el('div', 'panel-empty', '目录不预览；点击左侧进入。')); return; }
    invoke('file.read', { path: entry.path, max_bytes: MAX_READ }).then(function (data) {
      if (S.selected !== entry) return;
      if (data.is_binary) {
        add(body, el('div', 'panel-empty', '二进制文件，不支持预览；可用「下载」保存到本机'));
        return;
      }
      var view = add(body, el('textarea', 'files-editor')); view.value = data.content || '';
      view.readOnly = true;
      view.setAttribute('aria-label', '文件内容（只读预览）：' + entry.name);
      if (entry.size > MAX_READ) add(body, el('div', 'panel-empty muted', '仅预览前 ' + fmtSize(MAX_READ) + '；完整内容请下载'));
    }, function (err) {
      if (S.selected === entry) add(body, el('div', 'panel-empty', '读取失败：' + errText(err)));
    });
  }
  function refresh() {
    if (!S.listHost) return Promise.resolve();
    if (S.view === 'trash') return showTrash();
    if (S.view === 'search' && S.search.result) {
      setToolbars(true);
      paintCrumbs(); paintTabs(); paintSearchResults(); paintPreview();
      return Promise.resolve();
    }
    setToolbars(true);
    setStatus('正在读取 ' + disp(S.path) + '…');
    return invoke('file.list', { path: S.path || '.' }).then(function (data) {
      S.path = data.path === '.' ? '' : (data.path || '');
      S.entries = (data.entries || []).slice().sort(function (a, b) {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return String(a.name).localeCompare(String(b.name), 'zh-CN');
      });
      pruneChecked();
      if (S.pendingSelect) {
        S.selected = S.entries.filter(function (e) { return e.path === S.pendingSelect; })[0] || null;
        S.pendingSelect = null;
      } else if (S.selected) {
        S.selected = S.entries.filter(function (e) { return e.path === S.selected.path; })[0] || null;
      }
      paintCrumbs(); paintTabs(); paintList(); paintPreview();
      setStatus('共 ' + S.entries.length + ' 项 · ' + disp(S.path), 'ok');
    }, function (err) {
      setStatus('读取失败：' + errText(err), 'fail');
      paintCrumbs(); paintTabs(); paintList();
    });
  }
  // goPath 统一的目录跳转入口：任何导航都会退出搜索/回收站视图，避免"看着搜索结果却在操作目录"。
  function goPath(path) {
    S.view = 'files';
    S.search.active = false;
    S.path = path || '';
    S.selected = null; S.checked = {};
    if (S.searchClearBtn) S.searchClearBtn.hidden = true;
    refresh();
  }
  // targetEntry 是「改名 / 复制到」的作用对象：勾选 1 项优先，否则用右侧正在预览的条目。
  function targetEntry() {
    var checked = checkedEntries();
    if (checked.length === 1) return checked[0];
    return S.selected || null;
  }
  // setToolbars 隐藏目录工具条与搜索条：回收站是全局视图，留着「上传/压缩/当前目录」会误导。
  // 直接写 style.display——.files-toolbar 自带 display:flex，[hidden] 会被样式压掉（同 container 视图的 P0 教训）。
  function setToolbars(visible) {
    [S.filesToolbar, S.searchBar].forEach(function (node) {
      if (node) node.style.display = visible ? '' : 'none';
    });
  }
  function paintTabs() {
    if (!S.tabFiles) return;
    var filesOn = S.view === 'files' || S.view === 'search';
    S.tabFiles.className = 'btn files-tab ' + (filesOn ? 'btn-primary' : 'btn-ghost');
    S.tabTrash.className = 'btn files-tab ' + (S.view === 'trash' ? 'btn-primary' : 'btn-ghost');
    S.tabTrash.textContent = '回收站' + (S.trash.total ? '（' + S.trash.total + '）' : '');
    if (S.listTitle) {
      S.listTitle.textContent = S.view === 'trash' ? '回收站' : S.view === 'search' ? '搜索结果' : '目录内容';
    }
    updateSelection();
  }
  // markSeq 把命中的关键词包成 <mark>，不拼 innerHTML（内容来自宿主文件名/文件内容）。
  function markSeq(text, needle) {
    var frag = document.createDocumentFragment();
    var value = String(text === undefined || text === null ? '' : text);
    var query = String(needle || '');
    if (!query) { frag.appendChild(document.createTextNode(value)); return frag; }
    var lower = value.toLowerCase(), target = query.toLowerCase(), at = 0, idx;
    while ((idx = lower.indexOf(target, at)) >= 0) {
      if (idx > at) frag.appendChild(document.createTextNode(value.slice(at, idx)));
      frag.appendChild(el('mark', null, value.slice(idx, idx + query.length)));
      at = idx + query.length;
    }
    frag.appendChild(document.createTextNode(value.slice(at)));
    return frag;
  }
  function setSearchMode(mode) {
    S.search.mode = mode === 'content' ? 'content' : 'name';
    var nameMode = S.search.mode === 'name';
    if (S.searchInput) {
      S.searchInput.placeholder = nameMode ? '文件名，如 *.log 或 report' : '文件内容里的关键词，如 timeout';
      S.searchInput.setAttribute('aria-label', nameMode ? '按文件名搜索' : '按内容搜索');
    }
    if (S.searchHint) {
      S.searchHint.textContent = nameMode
        ? '按文件名：支持 * 通配；直接输入 report 会自动按 *report* 匹配'
        : '按内容：只搜文本文件，单文件 ≤ 1 MiB，二进制会跳过';
    }
    [[S.searchNameBtn, nameMode], [S.searchContentBtn, !nameMode]].forEach(function (pair) {
      var btn = pair[0]; if (!btn) return;
      btn.className = 'btn files-search-mode ' + (pair[1] ? 'btn-primary' : 'btn-ghost');
      btn.setAttribute('aria-pressed', pair[1] ? 'true' : 'false');
      btn.style.opacity = pair[1] ? '1' : '.65';
    });
  }
  // searchParams 把两种预设翻译成 file.search 的参数：裸关键词自动包 *…*，通配符原样使用。
  function searchParams() {
    var query = String(S.search.query || '').trim();
    if (!query) return null;
    if (S.search.mode === 'content') {
      return { path: S.path || '.', pattern: '*', content: query, ignore_case: true, max_results: 200 };
    }
    var pattern = /[*?]/.test(query) ? query : '*' + query + '*';
    return { path: S.path || '.', pattern: pattern, max_results: 200 };
  }
  function runSearch() {
    if (!S.searchInput) return;
    S.search.query = String(S.searchInput.value || '').trim();
    var params = searchParams();
    if (!params) { setStatus('搜索关键词不能为空：按文件名填 *.log 之类，按内容填要查的文字', 'fail'); S.searchInput.focus(); return; }
    setStatus('正在' + (S.search.mode === 'name' ? '按文件名' : '按内容') + '搜索「' + S.search.query + '」…');
    invoke('file.search', params).then(function (data) {
      S.view = 'search';
      S.search.result = data;
      S.search.active = true;
      S.selected = null; S.checked = {};
      if (S.searchClearBtn) S.searchClearBtn.hidden = false;
      paintTabs(); paintSearchResults(); paintPreview();
      var note = data.truncated ? '（结果较多，只显示前 ' + data.matched + ' 条，请进入子目录或换更精确的关键词）' : '';
      setStatus('搜索完成：' + data.matched + ' 项匹配，扫描 ' + data.scanned + ' 项' + (data.skipped ? '，跳过 ' + data.skipped + ' 项（二进制/超大文件）' : '') + note, 'ok');
    }, function (err) {
      setStatus('搜索失败：' + errText(err) + ' ' + hintFor('search', err), 'fail');
    });
  }
  function clearSearch() {
    S.search.query = '';
    S.search.result = null;
    S.search.active = false;
    if (S.searchInput) S.searchInput.value = '';
    if (S.searchClearBtn) S.searchClearBtn.hidden = true;
    S.view = 'files';
    refresh();
  }
  // narrowPreview 在手机上截短命中行（围绕关键词），避免窄列里一行字竖排成多行。
  function narrowPreview(text, query) {
    var value = String(text === undefined || text === null ? '' : text);
    if (window.innerWidth >= 640 || value.length <= 40) return value;
    var at = value.toLowerCase().indexOf(String(query || '').toLowerCase());
    if (at < 0) return value.slice(0, 40) + '…';
    var start = Math.max(0, at - 10);
    return (start > 0 ? '…' : '') + value.slice(start, start + 40) + (start + 40 < value.length ? '…' : '');
  }
  function paintSearchResults() {
    var host = S.listHost;
    if (!host) return;
    host.textContent = '';
    var data = S.search.result || { entries: [] };
    var entries = data.entries || [];
    if (S.count) S.count.textContent = entries.length + ' 项匹配';
    if (!entries.length) {
      var empty = add(host, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '没有找到匹配项。换个关键词，或切换「按文件名 / 按内容」；内容搜索会跳过二进制与超过 1 MiB 的文件。'));
      updateSelection();
      return;
    }
    var table = add(host, el('table', 'files-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['路径', '大小', '命中'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    entries.forEach(function (entry) {
      var tr = add(body, el('tr', 'files-row'));
      tr.tabIndex = 0;
      tr.dataset.path = entry.path;
      var pathCell = add(tr, el('td', 'files-name')); pathCell.dataset.label = '路径';
      add(pathCell, el('span', 'files-kind', entry.is_dir ? '目录' : '文件'));
      add(pathCell, el('span', 'files-name-text')).appendChild(markSeq(entry.path, S.search.query));
      var sizeCell = add(tr, el('td', null, entry.is_dir ? '—' : fmtSize(entry.size))); sizeCell.dataset.label = '大小';
      var hitCell = add(tr, el('td')); hitCell.dataset.label = '命中';
      if (entry.line > 0) {
        add(hitCell, el('span', 'muted', '第 ' + entry.line + ' 行 '));
        hitCell.appendChild(markSeq(narrowPreview(entry.preview, S.search.query), S.search.query));
      } else {
        add(hitCell, el('span', 'muted', '文件名匹配'));
      }
      function open() {
        if (entry.is_dir) { goPath(entry.path); return; }
        var slash = entry.path.lastIndexOf('/');
        S.pendingSelect = entry.path;
        goPath(slash >= 0 ? entry.path.slice(0, slash) : '');
      }
      on(tr, open);
      tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    });
    updateSelection();
  }
  // loadTrashCount 是「自动发现」入口：进视图时问一次回收站有多少项，非空就提示可恢复。
  function loadTrashCount() {
    return invoke('file.trash.list', { limit: 1 }).then(function (data) {
      S.trash.total = data.total || 0;
      paintTabs();
      if (S.trash.total > 0 && S.view === 'files') {
        setStatus('回收站有 ' + S.trash.total + ' 项可恢复：点上方「回收站」查看或还原', 'ok');
      }
    }, function () { /* 插件未装/旧版本无回收站：静默降级为无徽标 */ });
  }
  function trashCheckedIds() {
    return (S.trash.entries || []).filter(function (item) { return S.trash.checked[item.id]; })
      .map(function (item) { return item.id; });
  }
  function showTrash() {
    S.view = 'trash';
    S.search.active = false;
    if (S.searchClearBtn) S.searchClearBtn.hidden = true;
    setToolbars(false);
    if (S.trash.loading) return Promise.resolve();
    S.trash.loading = true;
    setStatus('正在读取回收站…');
    return invoke('file.trash.list', { limit: 200 }).then(function (data) {
      S.trash.loading = false;
      S.trash.entries = data.entries || [];
      S.trash.total = data.total || 0;
      S.trash.checked = {};
      paintCrumbs(); paintTabs(); paintTrash();
      var corrupt = data.skipped ? '（另有 ' + data.skipped + ' 项元数据损坏，未列出）' : '';
      setStatus('回收站共 ' + S.trash.total + ' 项' + (data.truncated ? '，仅显示最近 200 项' : '') + corrupt, 'ok');
    }, function (err) {
      S.trash.loading = false;
      setStatus('读取回收站失败：' + errText(err), 'fail');
      paintTabs();
    });
  }
  function paintTrash() {
    var host = S.listHost;
    if (!host) return;
    host.textContent = '';
    if (S.count) S.count.textContent = (S.trash.entries || []).length + ' 项';
    var ops = add(host, el('div', 'files-actions files-trash-ops'));
    S.trashRestoreBtn = add(ops, el('button', 'btn', '恢复所选')); S.trashRestoreBtn.type = 'button';
    S.trashRestoreBtn.disabled = true;
    on(S.trashRestoreBtn, function () { restoreTrash(trashCheckedIds()); });
    S.trashPurgeBtn = add(ops, el('button', 'btn btn-ghost files-del', '彻底删除所选')); S.trashPurgeBtn.type = 'button';
    S.trashPurgeBtn.disabled = true;
    on(S.trashPurgeBtn, function () { purgeTrash(trashCheckedIds(), false); });
    var purgeAll = add(ops, el('button', 'btn btn-ghost files-del', '清空回收站')); purgeAll.type = 'button';
    on(purgeAll, function () { purgeTrash([], true); });
    if (!S.trash.entries.length) {
      var empty = add(host, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '回收站是空的。删除文件时会先移到这里，随时可以恢复。'));
      updateSelection();
      return;
    }
    var table = add(host, el('table', 'files-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    add(htr, el('th', 'files-check-head', ''));
    ['原路径', '类型', '大小', '删除时间', '操作'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.trash.entries.forEach(function (item) {
      var tr = add(body, el('tr', 'files-row'));
      var checkCell = add(tr, el('td', 'files-check')); checkCell.dataset.label = '选择';
      var box = add(checkCell, el('input', 'files-checkbox')); box.type = 'checkbox';
      box.setAttribute('aria-label', '选择 ' + item.path);
      box.checked = !!S.trash.checked[item.id];
      box.addEventListener('change', function () {
        if (box.checked) S.trash.checked[item.id] = true; else delete S.trash.checked[item.id];
        updateSelection();
      });
      var pathCell = add(tr, el('td', 'files-name')); pathCell.dataset.label = '原路径';
      add(pathCell, el('span', null, disp(item.path)));
      var kindCell = add(tr, el('td', null, item.kind === 'dir' ? '目录' : item.kind === 'symlink' ? '链接' : '文件'));
      kindCell.dataset.label = '类型';
      var sizeCell = add(tr, el('td', null, item.kind === 'dir' ? '—' : fmtSize(item.size))); sizeCell.dataset.label = '大小';
      var timeCell = add(tr, el('td', null, fmtTime(item.deleted_at))); timeCell.dataset.label = '删除时间';
      var cellOps = add(tr, el('td', 'cell-ops')); cellOps.dataset.label = '操作';
      var restore = add(cellOps, el('button', 'btn btn-ghost', '恢复')); restore.type = 'button';
      restore.addEventListener('click', function (ev) { ev.stopPropagation(); restoreTrash([item.id]); });
      var purge = add(cellOps, el('button', 'btn btn-ghost files-del', '彻底删除')); purge.type = 'button';
      purge.addEventListener('click', function (ev) { ev.stopPropagation(); purgeTrash([item.id], false); });
    });
    updateSelection();
  }
  function finishRestore(failed, total) {
    return (S.view === 'trash' ? showTrash() : Promise.resolve()).then(function () {
      return loadTrashCount();
    }).then(function () {
      if (!failed.length) { setStatus('已恢复 ' + total + ' 项到原路径', 'ok'); return; }
      setStatus('恢复完成：成功 ' + (total - failed.length) + ' 项，失败 ' + failed.length + ' 项：' + failed.slice(0, 3).join('；'), 'fail');
    });
  }
  // restoreTrash 逐项恢复；原路径冲突时再给一次显式「覆盖恢复」确认（不静默覆盖）。
  function restoreTrash(ids) {
    if (!ids || !ids.length) { setStatus('请先勾选要恢复的项，或在行内点「恢复」', 'fail'); return Promise.resolve(); }
    setStatus('正在恢复 ' + ids.length + ' 项…');
    var failed = [], conflicts = [], chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return invoke('file.trash.restore', { id: id }).then(function () {}, function (err) {
          if (err && err.code === 'E_CONFLICT') conflicts.push(id);
          else failed.push(id + '：' + errText(err));
        });
      });
    });
    return chain.then(function () {
      if (!conflicts.length) return finishRestore(failed, ids.length);
      ask('覆盖恢复确认', null,
        conflicts.length + ' 项的原路径已被占用。可以先在原目录把同名项改名或移走，再回来恢复；也可以直接覆盖恢复（文件替换文件、空目录替换空目录）。',
        function (_, close, msg, ok) {
          var inner = Promise.resolve();
          var innerFailed = [];
          conflicts.forEach(function (id) {
            inner = inner.then(function () {
              return invoke('file.trash.restore', { id: id, overwrite: true }).then(function () {}, function (err) {
                innerFailed.push(id + '：' + errText(err));
              });
            });
          });
          inner.then(function () {
            close();
            return finishRestore(failed.concat(innerFailed), ids.length);
          }, function (err) { msg.textContent = errText(err); ok.disabled = false; });
        });
    });
  }
  // purgeConfirm 是彻底删除的唯一入口：必须勾选「不可恢复」才能提交（二次确认）。
  function purgeConfirm(count, all, onConfirm) {
    var mask = el('div', 'kore-modal');
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
    var box = add(mask, el('form', 'kore-modal-box'));
    add(box, el('div', 'kore-modal-title', '彻底删除确认（不可恢复）'));
    add(box, el('p', 'kore-modal-text',
      (all ? '将永久删除回收站里的全部 ' + count + ' 项。' : '将永久删除选中的 ' + count + ' 项。') +
      '彻底删除后无法恢复，也无法从本页找回。'));
    var line = add(box, el('label', 'field field-check'));
    var sure = add(line, el('input', 'files-checkbox')); sure.type = 'checkbox';
    add(line, el('span', null, '我已知晓：彻底删除后无法恢复'));
    var msg = add(box, el('div', 'kore-modal-msg')); msg.setAttribute('role', 'alert');
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary files-del', '彻底删除')); ok.type = 'submit'; ok.disabled = true;
    sure.addEventListener('change', function () { ok.disabled = !sure.checked; });
    function close() { document.removeEventListener('keydown', esc); if (mask.parentNode) mask.parentNode.removeChild(mask); }
    function esc(ev) { if (ev.key === 'Escape') close(); }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', esc);
    box.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!sure.checked) return;
      ok.disabled = true;
      Promise.resolve().then(function () { return onConfirm(close, msg, ok); }).then(function () {
        ok.disabled = false;
      }, function (err) { ok.disabled = false; msg.textContent = errText(err); });
    });
    document.body.appendChild(mask);
    sure.focus();
    return close;
  }
  function purgeTrash(ids, all) {
    var count = all ? S.trash.total : (ids ? ids.length : 0);
    if (!count) { setStatus('没有可彻底删除的项：请先勾选，或回收站本身是空的', 'fail'); return Promise.resolve(); }
    purgeConfirm(count, all, function (close, msg, ok) {
      var failed = [];
      var task = all
        ? invoke('file.trash.purge', { all: true }).then(function () {}, function (err) { failed.push(errText(err)); })
        : ids.reduce(function (chain, id) {
            return chain.then(function () {
              return invoke('file.trash.purge', { id: id }).then(function () {}, function (err) { failed.push(id + '：' + errText(err)); });
            });
          }, Promise.resolve());
      return task.then(function () {
        close();
        return showTrash().then(loadTrashCount).then(function () {
          if (!failed.length) { setStatus('已彻底删除 ' + count + ' 项，无法恢复', 'ok'); return; }
          msg.textContent = '失败明细：' + failed.slice(0, 3).join('；');
          setStatus('彻底删除完成：成功 ' + (count - failed.length) + ' 项，失败 ' + failed.length + ' 项', 'fail');
        });
      });
    });
    return Promise.resolve();
  }
  // startRename 行内改名（不弹窗）：Enter 保存、Esc 取消，只允许同目录单段名字。
  function startRename(entry, cell) {
    if (!cell || S.renaming) return;
    S.renaming = entry.path;
    cell.textContent = '';
    add(cell, el('span', 'files-kind', entry.is_dir ? '目录' : '文件'));
    var input = add(cell, el('input', 'field-input files-rename-input'));
    input.type = 'text'; input.value = entry.name;
    input.setAttribute('aria-label', '新名称（同目录改名）');
    var ops = add(cell, el('span', 'files-rename-ops'));
    var save = add(ops, el('button', 'btn btn-primary', '保存')); save.type = 'button';
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    function done() { S.renaming = null; paintList(); }
    function commit() {
      var name = String(input.value || '').trim();
      if (badName(name) || name === '.trash') {
        setStatus('名称不合法：不能为空、不能含 / 或 \\，也不能是保留名 .trash', 'fail'); input.focus(); return;
      }
      if (name === entry.name) { done(); return; }
      save.disabled = true;
      invoke('file.rename', { path: entry.path, name: name }).then(function (res) {
        S.renaming = null;
        setStatus('已改名：' + disp(res.from) + ' → ' + disp(res.to), 'ok');
        refresh();
      }, function (err) {
        save.disabled = false;
        if (err && err.code === 'E_CONFLICT') { setStatus('同名已存在，换个名字', 'fail'); input.focus(); input.select(); return; }
        setStatus('改名失败：' + errText(err) + ' ' + hintFor('rename', err), 'fail');
      });
    }
    save.addEventListener('click', commit);
    cancel.addEventListener('click', done);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); done(); }
    });
    input.focus(); input.select();
  }

  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '文件管理'));
    add(head, el('p', 'view-sub', '浏览、上传、下载、压缩、解压、改权限与移动；路径始终以根目录相对形式显示。'));
    var bar = add(root, el('div', 'files-toolbar'));
    S.filesToolbar = bar;
    S.crumbs = add(bar, el('nav', 'files-crumbs'));
    S.crumbs.setAttribute('aria-label', '当前路径');
    var actions = add(bar, el('div', 'files-actions'));
    var up = add(actions, el('button', 'btn btn-primary', '上传'));
    up.type = 'button'; up.setAttribute('data-action', 'upload');
    S.fileInput = add(actions, el('input', 'files-file-input'));
    S.fileInput.type = 'file'; S.fileInput.multiple = true; S.fileInput.hidden = true;
    S.fileInput.setAttribute('aria-hidden', 'true');
    S.fileInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(S.fileInput.files || []);
      S.fileInput.value = '';
      if (files.length) runL2('uploadFiles', files);
    });
    on(up, function () { S.fileInput.click(); });
    S.compressBtn = add(actions, el('button', 'btn', '压缩'));
    S.compressBtn.type = 'button'; S.compressBtn.disabled = true;
    S.compressBtn.setAttribute('data-action', 'compress');
    on(S.compressBtn, function () { runL2('compress', checkedEntries()); });
    S.batchDel = add(actions, el('button', 'btn btn-ghost files-del', '批量删除'));
    S.batchDel.type = 'button'; S.batchDel.disabled = true;
    S.batchDel.setAttribute('data-action', 'batch-delete');
    S.batchMove = add(actions, el('button', 'btn btn-ghost', '批量移动'));
    S.batchMove.type = 'button'; S.batchMove.disabled = true;
    S.batchMove.setAttribute('data-action', 'batch-move');
    on(S.batchMove, batchMove);
    on(S.batchDel, function () { runL2('removeMany', checkedEntries()); });
    S.selLabel = add(actions, el('span', 'files-selected muted', ''));
    var mk = add(actions, el('button', 'btn', '新建目录')); mk.type = 'button';
    on(mk, function () { newEntry(true); });
    var nf = add(actions, el('button', 'btn', '新建文件')); nf.type = 'button';
    on(nf, function () { newEntry(false); });
    var rf = add(actions, el('button', 'btn btn-ghost', '刷新')); rf.type = 'button';
    on(rf, refresh);
    // 工具栏「改名 / 复制到」：作用于勾选 1 项（或右侧预览的条目），与行内按钮同一套逻辑。
    S.renameBtn = add(actions, el('button', 'btn btn-ghost', '改名'));
    S.renameBtn.type = 'button'; S.renameBtn.disabled = true;
    S.renameBtn.setAttribute('data-action', 'rename-selected');
    on(S.renameBtn, function () {
      var entry = targetEntry();
      if (!entry) { setStatus('请先勾选或点选一个文件，再点「改名」', 'fail'); return; }
      var rows = S.listHost ? S.listHost.querySelectorAll('tr.files-row') : [];
      for (var i = 0; i < rows.length; i++) {
        var rowPath = rows[i].getAttribute('data-entry-path') || rows[i].dataset.path;
        if (rowPath !== entry.path) continue;
        var cell = rows[i].querySelector('td.files-name');
        if (cell) startRename(entry, cell);
        return;
      }
    });
    S.copyBtn = add(actions, el('button', 'btn btn-ghost', '复制到'));
    S.copyBtn.type = 'button'; S.copyBtn.disabled = true;
    S.copyBtn.setAttribute('data-action', 'copy-selected');
    on(S.copyBtn, function () {
      var entry = targetEntry();
      if (!entry) { setStatus('请先勾选或点选一个文件，再点「复制到」', 'fail'); return; }
      runL2('copy', entry);
    });

    // 搜索：两个预设（按文件名 / 按内容），不让人写复杂语法。
    // 按文件名把裸关键词自动包成 *关键词*；只有写了通配符（* ? [）才原样使用。
    var searchBar = add(root, el('div', 'files-toolbar files-searchbar'));
    S.searchBar = searchBar;
    var searchOps = add(searchBar, el('div', 'files-actions'));
    S.searchNameBtn = add(searchOps, el('button', 'btn btn-primary files-search-mode', '按文件名'));
    S.searchNameBtn.type = 'button'; S.searchNameBtn.setAttribute('data-action', 'search-mode-name');
    S.searchContentBtn = add(searchOps, el('button', 'btn btn-ghost files-search-mode', '按内容'));
    S.searchContentBtn.type = 'button'; S.searchContentBtn.setAttribute('data-action', 'search-mode-content');
    on(S.searchNameBtn, function () { setSearchMode('name'); });
    on(S.searchContentBtn, function () { setSearchMode('content'); });
    S.searchInput = add(searchOps, el('input', 'field-input files-search-input'));
    S.searchInput.type = 'search'; S.searchInput.autocomplete = 'off';
    S.searchInput.setAttribute('aria-label', '搜索关键词');
    S.searchInput.placeholder = '文件名，如 *.log 或 report';
    S.searchInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); runSearch(); } });
    var searchGo = add(searchOps, el('button', 'btn', '搜索')); searchGo.type = 'button';
    searchGo.setAttribute('data-action', 'search');
    on(searchGo, runSearch);
    S.searchClearBtn = add(searchOps, el('button', 'btn btn-ghost', '清除搜索'));
    S.searchClearBtn.type = 'button'; S.searchClearBtn.hidden = true;
    on(S.searchClearBtn, clearSearch);
    S.searchHint = add(searchBar, el('span', 'files-selected muted', '按文件名：支持 * 通配；按内容：在文本文件里找关键词（单文件 ≤ 1 MiB）'));
    S.status = add(root, el('div', 'files-status muted')); S.status.setAttribute('role', 'status');
    var layout = add(root, el('div', 'files-layout'));
    var listPanel = add(layout, el('section', 'panel files-list-panel'));
    var listHead = add(listPanel, el('div', 'panel-head'));
    S.listTitle = add(listHead, el('span', 'panel-title', '目录内容'));
    var headMeta = add(listHead, el('div', 'panel-meta actions'));
    S.tabFiles = add(headMeta, el('button', 'btn btn-primary files-tab', '文件'));
    S.tabFiles.type = 'button'; S.tabFiles.setAttribute('data-action', 'tab-files');
    S.tabTrash = add(headMeta, el('button', 'btn btn-ghost files-tab', '回收站'));
    S.tabTrash.type = 'button'; S.tabTrash.setAttribute('data-action', 'tab-trash');
    on(S.tabFiles, function () {
      S.view = 'files'; S.search.active = false; S.search.query = ''; S.search.result = null;
      if (S.searchInput) S.searchInput.value = '';
      if (S.searchClearBtn) S.searchClearBtn.hidden = true;
      setToolbars(true); refresh();
    });
    on(S.tabTrash, showTrash);
    S.count = add(headMeta, el('span', 'panel-meta', ''));
    S.listHost = add(listPanel, el('div', 'files-list-host'));
    var previewPanel = add(layout, el('section', 'panel files-preview-panel'));
    var previewHead = add(previewPanel, el('div', 'panel-head'));
    add(previewHead, el('span', 'panel-title', '文件预览'));
    S.previewMeta = add(previewHead, el('span', 'panel-meta', ''));
    S.previewHost = add(previewPanel, el('div', 'files-preview-host'));
  }
  function render(container) {
    if (!container) return null;
    S.path = ''; S.entries = []; S.selected = null; S.checked = {}; S.renaming = null;
    S.view = 'files';
    S.search = { mode: S.search && S.search.mode === 'content' ? 'content' : 'name', query: '', result: null, active: false };
    S.trash = { total: 0, entries: [], checked: {}, loading: false };
    container.textContent = '';
    var root = add(container, el('section', 'files'));
    build(root); setSearchMode(S.search.mode);
    refresh().then(loadTrashCount);
  }
  window.KoreFiles = { render: render };
})();
