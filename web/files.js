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
  // 目录列表分批渲染：一次最多 200 行，其余按需「加载更多」。
  // 后端 file.list 一次返回整目录（无 limit 参数），上万条目的目录若整表渲染，
  // 每行还带复选框 + 手机端 8 项操作菜单，主线程会被卡住（实测 2000 行 ≈ 1.2 万 DOM 节点）。
  var LIST_PAGE = 200;
  var S = {
    path: '', entries: [], selected: null, checked: {}, l2: null, l2Ready: null,
    listShown: LIST_PAGE, moreBtn: null,
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
  // 本地化（ADR-0021）：切英文后本页用户可见文案走 en-US 表；语言包未就绪/缺键时
  // i18n.t 返回键名本身，这里以 hit !== key 拦截并回退到原中文，中文态零影响、不露裸键。
  function tr(key, fallback, params) {
    var i18n = window.KoreI18n;
    if (i18n && typeof i18n.t === 'function') {
      var hit = i18n.t(key, params);
      if (hit && hit !== key) return hit;
    }
    // 缺键回退中文时由调用方内联兜底，params 需在此补齐插值，
    // 否则中文态会露出 "{name}" 占位符（对齐 shell.js:131 的 tr 实现）。
    var out = fallback === undefined || fallback === null ? key : String(fallback);
    if (params) {
      for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k)) out = out.split('{' + k + '}').join(String(params[k]));
      }
    }
    return out;
  }
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
    var text = err && err.message ? String(err.message) : tr('files.err.unknown', '未知错误');
    return err && err.detail && text.indexOf(err.detail) < 0 ? text + '（' + err.detail + '）' : text;
  }
  function hintFor(action, err) {
    var msg = err ? String(err.message || '') : '';
    if (/单帧|过大|超过.*上传|超过.*下载/.test(msg)) return tr('files.hint.frameLimit', '单帧上限 8 MiB，大文件请先压缩或用终端上传。');
    if (err && err.code === 'E_CONFLICT') return tr('files.hint.conflict', '目标已存在：勾选「覆盖」后重试，或换一个名称。');
    if (action === 'extract') return tr('files.hint.extract', '解压先整包校验路径安全，含 .. / 绝对路径的条目会整包拒绝。');
    if (action === 'chmod') return tr('files.hint.chmod', 'mode 用八进制；目录必须保留执行位（如 0755）。');
    if (action === 'search') return tr('files.hint.search', '按文件名支持通配（如 *.log）；按内容只搜文本文件，单文件上限 1 MiB。');
    if (action === 'copy' && err && err.code === 'E_CONFLICT') return tr('files.hint.copyConflict', '目标已存在：勾选「覆盖同名」后重试，或换一个目录。');
    if (action === 'rename') return tr('files.hint.rename', '只支持同目录改名；同名冲突时换个名字，要换目录请用「移动」。');
    if (action === 'batch') return tr('files.hint.batch', '批量里单条失败不影响其他条目；失败项会逐条列出原因，可修好后重试。');
    if (action === 'restore') return tr('files.hint.restore', '原路径已有同名项：确认覆盖恢复，或先移走它。');
    return '';
  }
  function showErr(action, err) {
    var hint = hintFor(action, err);
    setStatus(tr('files.err.operationFailed', '操作失败：') + errText(err) + (hint ? ' ' + hint : ''), 'fail');
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
      // 手机键盘默认句首大写 + 自动纠错，会把 "var" 改成 "Var"、把路径纠成英文单词；文件名/路径必须关掉
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('spellcheck', 'false');
    } else {
      add(box, el('p', 'kore-modal-text', text || ''));
    }
    var msg = add(box, el('div', 'kore-modal-msg'));
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', tr('files.action.cancel', '取消'))); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary', tr('files.action.ok', '确定'))); ok.type = 'submit';
    function close() { document.removeEventListener('keydown', esc); if (mask.parentNode) mask.parentNode.removeChild(mask); }
    function esc(ev) { if (ev.key === 'Escape') close(); }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', esc);
    box.addEventListener('submit', function (ev) {
      ev.preventDefault(); var value = input ? input.value.trim() : '';
      if (input && !value) { msg.textContent = tr('files.err.nameEmpty', '名称不能为空'); return; }
      ok.disabled = true; onSubmit(value, close, msg, ok);
    });
    document.body.appendChild(mask);
    if (input) input.focus();
  }
  function badName(name) { return !name || name === '.' || name === '..' || /[\/\\]/.test(name); }
  function newEntry(isDir) {
    var title = isDir ? tr('files.newFolder', '新建目录') : tr('files.newFile', '新建文件');
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
  // showInfo 走 file.stat 后端真实属性（size/mode/owner/mod_time/is_dir/is_symlink），
  // 一次请求把条目详情摆到用户面前；不重复造表，只读、零副作用。
  function showInfo(entry) {
    var path = entry && entry.path ? entry.path : (S.path || '.');
    var mask = el('div', 'kore-modal');
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
    var box = add(mask, el('div', 'kore-modal-box'));
    add(box, el('div', 'kore-modal-title', tr('files.info.title', '文件属性')));
    var body = add(box, el('div', 'kore-modal-text'));
    add(body, el('p', null, tr('files.info.loading', '正在读取属性：{path}…', { path: disp(path) })));
    var ops = add(box, el('div', 'kore-modal-actions'));
    var closeBtn = add(ops, el('button', 'btn btn-primary', tr('files.action.close', '关闭')));
    closeBtn.type = 'button';
    function close() { document.removeEventListener('keydown', esc); if (mask.parentNode) mask.parentNode.removeChild(mask); }
    function esc(ev) { if (ev.key === 'Escape') close(); }
    on(closeBtn, close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(mask);
    invoke('file.stat', { path: path }).then(function (data) {
      if (!mask.parentNode) return;
      body.textContent = '';
      var rows = [
        [tr('files.info.path', '路径'), disp(data.path || path)],
        [tr('files.info.type', '类型'), data.is_dir ? tr('files.kind.dir', '目录') : (data.is_symlink ? tr('files.kind.link', '链接') : tr('files.kind.file', '文件'))],
        [tr('files.col.size', '大小'), fmtSize(data.size)],
        [tr('files.col.mode', '权限'), data.mode || '—'],
        [tr('files.info.owner', '所有者'), data.owner ? (data.owner.uid + ':' + data.owner.gid) : '—'],
        [tr('files.col.modified', '修改时间'), fmtTime(data.mod_time)]
      ];
      var table = add(body, el('table', 'files-info-table'));
      rows.forEach(function (row) {
        var trNode = add(table, el('tr'));
        add(trNode, el('th', null, row[0])); add(trNode, el('td', null, row[1]));
      });
    }, function (err) {
      if (!mask.parentNode) return;
      body.textContent = tr('files.info.fail', '读取属性失败：') + errText(err) + ' ' + hintFor('stat', err);
    });
  }
  function batchMove() {
    var entries = checkedEntries();
    if (!entries.length) { setStatus(tr('files.batch.moveTo.noSel', '请先勾选要移动的条目'), 'fail'); return; }
    ask(tr('files.batch.moveTo.title', '批量移动到'), tr('files.batch.moveTo.label', '目标目录（相对根目录，如 docs；不能为空）'), null, function (value, close, msg, ok) {
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
    ask(tr('files.trash.moveConfirm', '移入回收站确认'), null,
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
    var contextual = list.length > 0 || !!S.selected;
    // P0 §2.4：勾选后上下文栏替换默认三按钮；取消勾选/预览即恢复默认态。
    if (S.contextBar) S.contextBar.hidden = !contextual;
    if (S.defaultBar) S.defaultBar.hidden = contextual;
    if (S.selLabel) S.selLabel.textContent = list.length ? tr('files.selected', '已选 {n} 项', { n: list.length })
      : (S.selected ? tr('files.selectedOne', '已选 1 项') : '');
    if (S.compressBtn) S.compressBtn.disabled = !list.length;
    if (S.batchDel) S.batchDel.disabled = !list.length;
    if (S.batchMove) S.batchMove.disabled = !list.length;
    var single = targetEntry();
    if (S.renameBtn) S.renameBtn.disabled = !single;
    if (S.copyBtn) S.copyBtn.disabled = !single;
    if (S.infoBtn) S.infoBtn.disabled = !single;
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
      // 空态三件套：当前没有 X + 一句话说明 + 下一步按钮（AGENTS.md §7 ④ / G-33 A5）。
      // 这里要两个并列动作（上传 / 新建文件夹），主壳 emptyBlock 只支持一个 CTA，故按同款结构手拼：
      // 主动作「上传文件」先把工具条带回视野（手机端可能已滚出屏幕），再弹系统文件选择框；
      // 次动作「新建文件夹」直达命名弹层——两条都是真实可用动作，不做点了才报错的假按钮。
      var empty = add(host, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-title', tr('files.empty.title', '这个目录是空的')));
      add(empty, el('p', 'empty-state-text', tr('files.empty.text', '可以上传文件或新建文件夹；也可以先用上方「新建文件」建一个空文件再编辑。')));
      var upBtn = add(empty, el('button', 'btn btn-primary', tr('files.empty.upload', '上传文件')));
      upBtn.type = 'button';
      on(upBtn, function () {
        if (S.filesToolbar && S.filesToolbar.scrollIntoView) S.filesToolbar.scrollIntoView({ block: 'nearest' });
        if (S.fileInput) S.fileInput.click();
      });
      var mkDir = add(empty, el('button', 'btn btn-ghost', tr('files.empty.newFolder', '新建文件夹')));
      mkDir.type = 'button';
      on(mkDir, function () { newEntry(true); });
      updateSelection();
      return;
    }
    var table = add(host, el('table', 'files-table'));
    var head = add(table, el('thead'));
    var htr = add(head, el('tr'));
    var checkHead = add(htr, el('th', 'files-check-head'));
    S.selectAll = add(checkHead, el('input', 'files-checkbox files-check-all'));
    S.selectAll.type = 'checkbox'; S.selectAll.setAttribute('aria-label', tr('files.selectAll', '全选当前目录'));
    S.selectAll.addEventListener('change', function () {
      S.checked = {};
      if (S.selectAll.checked) {
        for (var i = 0; i < S.entries.length; i++) S.checked[S.entries[i].path] = true;
      }
      paintList();
    });
    [tr('files.col.name', '名称'), tr('files.col.size', '大小'), tr('files.col.modified', '修改时间'), tr('files.col.mode', '权限'), tr('files.col.actions', '操作')].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    var shown = Math.min(S.listShown || LIST_PAGE, S.entries.length);
    S.entries.slice(0, shown).forEach(function (entry) {
      var row = add(body, el('tr', 'files-row'));
      row.setAttribute('data-entry-path', entry.path);
      row.tabIndex = 0;
      function open() {
        if (entry.is_dir) { goPath(entry.path); return; }
        S.selected = entry; paintPreview(); updateSelection();
      }
      on(row, open);
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      var sel = add(row, el('td', 'files-check'));
      sel.dataset.label = tr('files.select', '选择');
      var box = add(sel, el('input', 'files-checkbox'));
      box.type = 'checkbox'; box.setAttribute('data-path', entry.path);
      box.setAttribute('aria-label', tr('files.selectItem', '选择 {name}', { name: entry.name })); box.checked = !!S.checked[entry.path];
      box.addEventListener('click', function (ev) { ev.stopPropagation(); });
      box.addEventListener('change', function () {
        if (box.checked) S.checked[entry.path] = true; else delete S.checked[entry.path];
        updateSelection();
      });
      var name = add(row, el('td', 'files-name')); name.dataset.label = tr('files.col.name', '名称');
      add(name, el('span', 'files-kind', entry.is_dir ? tr('files.kind.dir', '目录') : tr('files.kind.file', '文件')));
      var nameText = add(name, el('span', 'files-name-text', entry.name + (entry.is_dir ? '/' : '')));
      nameText.title = tr('files.name.dblclick', '双击改名（只改同目录下的名字）');
      nameText.addEventListener('dblclick', function (ev) { ev.stopPropagation(); startRename(entry, name); });
      var size = add(row, el('td', null, entry.is_dir ? '—' : fmtSize(entry.size))); size.dataset.label = tr('files.col.size', '大小');
      var mod = add(row, el('td', null, fmtTime(entry.mod_time))); mod.dataset.label = tr('files.col.modified', '修改时间');
      var mode = add(row, el('td', null, entry.mode || '—')); mode.dataset.label = tr('files.col.mode', '权限');
      var ops = add(row, el('td', 'cell-ops')); ops.dataset.label = tr('files.col.actions', '操作');
      // P2 §2.4 行减法：桌面/手机统一「≤2 行内按钮 + ⋯ 菜单」——
      // 文件行：[下载][⋯]（2）；目录行：[⋯]（1）。其余 6–7 个操作全部进 ⋯ 菜单，
      // 与勾选后的 context 栏（改名 / 复制到 / 属性 / 权限 / 移动 / 批量删除）双通道可达。
      // 不用「隐藏关键操作」的 ... 菜单：下载作为文件主操作仍行内可见（FRONTEND §6 判据）。
      var opList = [];
      if (!entry.is_dir) opList.push([tr('files.op.download', '下载'), 'files-download', 'download', function () { runL2('download', entry); }]);
      if (!entry.is_dir && isArchive(entry.name)) opList.push([tr('files.op.extract', '解压'), 'files-extract', 'extract', function () { runL2('extract', entry); }]);
      opList.push([tr('files.op.rename', '改名'), 'files-rename', 'rename', function () { startRename(entry, name); }]);
      opList.push([tr('files.op.copyToMenu', '复制到…'), 'files-copy', 'copy', function () { runL2('copy', entry); }]);
      opList.push([tr('files.info.title', '属性'), 'files-info', 'stat', function () { showInfo(entry); }]);
      opList.push([tr('files.op.chmod', '权限'), 'files-chmod', 'chmod', function () { runL2('chmod', entry); }]);
      opList.push([tr('files.op.move', '移动'), 'files-move', 'move', function () { runL2('move', entry); }]);
      // 删除=移入回收站（可恢复）→ 中性灰，不占危险色；彻底删除（不可恢复）仍用 .files-del 红+确认。
      opList.push([tr('files.op.delete', '删除（进回收站）'), 'files-trash-btn', 'delete', function () { removeEntry(entry); }]);

      // 文件行的下载作为唯一行内高频操作（目录没有下载 → 目录行只有 ⋯）。
      if (!entry.is_dir) {
        var dl = add(ops, el('button', 'btn btn-ghost files-quick-download', tr('files.op.download', '下载')));
        dl.type = 'button'; dl.setAttribute('data-action', 'download'); dl.setAttribute('data-path', entry.path);
        dl.title = tr('files.op.download', '下载') + '（其余操作在「⋯」里）';
        dl.addEventListener('click', function (ev) { ev.stopPropagation(); runL2('download', entry); });
      }
      ops.style.position = 'relative';
      var more = add(ops, el('button', 'btn btn-ghost files-more', '⋯'));
      more.type = 'button'; more.setAttribute('aria-label', tr('files.more', '更多操作：{name}', { name: entry.name }));
      more.setAttribute('aria-haspopup', 'true'); more.setAttribute('aria-expanded', 'false');
      more.style.minHeight = '44px';
      var menu = add(ops, el('div', 'files-ops-menu'));
      // 菜单用 fixed 定位：表格容器 overflow-x:auto 会裁剪 absolute 子元素（实测菜单不可见）。
      menu.style.cssText = 'position:fixed;z-index:40;display:none;flex-direction:column;gap:4px;padding:6px;width:200px;' +
        'background:var(--kore-bg-1);border:1px solid var(--kore-border-2);border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.35)' +
        ';max-height:min(70vh,420px);overflow:auto';
      opList.forEach(function (def) {
        var item = add(menu, el('button', 'btn btn-ghost ' + def[1], def[0]));
        item.type = 'button'; item.style.minHeight = '44px'; item.setAttribute('data-action', def[2]);
        item.setAttribute('data-path', entry.path);
        item.addEventListener('click', function (ev) { ev.stopPropagation(); menu.style.display = 'none'; more.setAttribute('aria-expanded', 'false'); def[3](); });
      });
      more.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var open = menu.style.display === 'flex';
        if (!open) {
          var rect = more.getBoundingClientRect();
          menu.style.left = Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208)) + 'px';
          menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 260) + 'px';
        }
        menu.style.display = open ? 'none' : 'flex';
        more.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
      // 点空白处收起菜单（桌面也需要；避免菜单在表格重绘后残留）。
      if (!S.filesMenuCloseBound) {
        document.addEventListener('click', function (ev) {
          var open = document.querySelectorAll('.files-ops-menu');
          for (var i = 0; i < open.length; i++) {
            if (open[i].style.display === 'flex' && !open[i].contains(ev.target)) {
              open[i].style.display = 'none';
              var trigger = open[i].parentNode ? open[i].parentNode.querySelector('.files-more') : null;
              if (trigger) trigger.setAttribute('aria-expanded', 'false');
            }
          }
        });
        S.filesMenuCloseBound = true;
      }
    });
    S.moreBtn = null;
    if (shown < S.entries.length) {
      // 「加载更多」按整批追加，不重置已缓存的选择；焦点在按钮上时重绘后回填，
      // 否则键盘用户点一次就掉到 body（列表重绘会销毁旧按钮节点）。
      var more = add(host, el('div', 'files-list-more'));
      more.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:var(--kore-space-3,12px);padding:var(--kore-space-3,12px) 0;flex-wrap:wrap;';
      add(more, el('span', 'panel-meta', tr('files.list.shown', '已显示 {shown} / 共 {total} 项', { shown: shown, total: S.entries.length })));
      var moreBtn = add(more, el('button', 'btn', tr('files.list.loadMore', '加载更多（剩余 {n} 项）', { n: S.entries.length - shown })));
      moreBtn.type = 'button';
      S.moreBtn = moreBtn;
      on(moreBtn, function () {
        S.listShown = shown + LIST_PAGE;
        paintList();
        if (S.moreBtn) S.moreBtn.focus();
      });
    }
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
    if (entry.size > MAX_INLINE) { setStatus(tr('files.edit.tooLarge', '文件过大，仅支持预览，不支持在线编辑'), 'fail'); return; }
    setStatus(tr('files.edit.loading', '正在加载编辑器…'));
    invoke('file.readRange', { path: entry.path, offset: 0, limit: MAX_INLINE }).then(function (data) {
      var bytes = b64ToBytes(data.data_base64);
      for (var i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) { setStatus(tr('files.edit.binaryNoEdit', '二进制文件不支持编辑'), 'fail'); return; }
      }
      var text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (err) { setStatus(tr('files.edit.notUtf8', '文件不是 UTF-8 文本，暂不支持在线编辑'), 'fail'); return; }
      return sha256Hex(bytes).then(function (sha) {
        S.editor = { path: entry.path, text: text, sha: sha, size: bytes.length };
        paintPreview();
        setStatus(tr('files.edit.loaded', '已加载 {size}{note}', { size: fmtSize(bytes.length), note: sha ? tr('files.edit.shaNote', '，保存时校验摘要') : tr('files.edit.noShaNote', '（浏览器不支持摘要，关闭乐观锁）') }), 'ok');
      });
    }, function (err) {
      setStatus(tr('files.edit.openFail', '打开编辑器失败：') + errText(err), 'fail');
    });
  }
  // saveEdit 走 writeRange：整文件覆盖写 + expected_sha256 乐观锁；冲突给人话而不是 E_CONFLICT。
  function saveEdit(entry, editor, save, status) {
    var bytes = new TextEncoder().encode(editor.value);
    if (bytes.length > MAX_INLINE) { status.textContent = tr('files.edit.contentTooLarge', '内容超过单帧上限，请拆分文件'); return; }
    var params = { path: entry.path, offset: 0, data_base64: bytesToB64(bytes) };
    if (S.editor.sha) params.expected_sha256 = S.editor.sha;
    save.disabled = true;
    invoke('file.writeRange', params).then(function (res) {
      S.editor = null;
      status.className = 'row-note-ok';
      status.textContent = tr('files.edit.saved', '已保存（{size}）', { size: fmtSize(res.size) });
      refresh();
    }, function (err) {
      save.disabled = false;
      status.className = 'row-note-fail';
      if (err && err.code === 'E_CONFLICT') {
        status.textContent = tr('files.edit.conflict', '文件已被其他会话修改，请刷新后重试');
        return;
      }
      status.textContent = tr('files.edit.saveFail', '保存失败：') + errText(err);
    });
  }
  function paintPreview() {
    if (!S.previewHost) return;
    var host = S.previewHost;
    host.textContent = '';
    if (S.previewMeta) S.previewMeta.textContent = S.selected ? disp(S.selected.path) : '';
    if (!S.selected) {
      add(host, el('div', 'panel-empty', tr('files.preview.hint', '点击左侧文件预览内容；目录请点击进入。')));
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
      editor.setAttribute('aria-label', tr('files.preview.editAria', '编辑文件：{name}', { name: entry.name }));
      var bar = add(body, el('div', 'files-save-bar'));
      var status = add(bar, el('span', 'muted', tr('files.preview.saveHint', '保存会用乐观锁校验；被其他会话改过会提示刷新。')));
      var save = add(bar, el('button', 'btn btn-primary', tr('files.action.save', '保存'))); save.type = 'button';
      var cancel = add(bar, el('button', 'btn btn-ghost', tr('files.action.cancel', '取消'))); cancel.type = 'button';
      on(save, function () { saveEdit(entry, editor, save, status); });
      on(cancel, function () { S.editor = null; paintPreview(); setStatus(tr('files.edit.exited', '已退出编辑'), 'ok'); });
      return;
    }
    var ops = add(host, el('div', 'files-actions'));
    var editBtn = add(ops, el('button', 'btn', tr('files.preview.edit', '编辑'))); editBtn.type = 'button';
    editBtn.disabled = entry.is_dir || entry.size > MAX_INLINE;
    on(editBtn, function () { startEdit(entry); });
    if (entry.size > MAX_INLINE) add(ops, el('span', 'files-selected muted', tr('files.edit.tooLarge', '文件过大，仅支持预览，不支持在线编辑')));
    else if (!entry.is_dir) add(ops, el('span', 'files-selected muted', tr('files.edit.maxInline', '在线编辑上限 {size}', { size: fmtSize(MAX_INLINE) })));
    if (entry.is_dir) { add(body, el('div', 'panel-empty', tr('files.preview.dirNoPreview', '目录不预览；点击左侧进入。'))); return; }
    invoke('file.read', { path: entry.path, max_bytes: MAX_READ }).then(function (data) {
      if (S.selected !== entry) return;
      if (data.is_binary) {
        add(body, el('div', 'panel-empty', tr('files.preview.binaryNoPreview', '二进制文件，不支持预览；可用「下载」保存到本机')));
        return;
      }
      var view = add(body, el('textarea', 'files-editor')); view.value = data.content || '';
      view.readOnly = true;
      view.setAttribute('aria-label', tr('files.preview.readonlyAria', '文件内容（只读预览）：{name}', { name: entry.name }));
      if (entry.size > MAX_READ) add(body, el('div', 'panel-empty muted', tr('files.preview.partial', '仅预览前 {size}；完整内容请下载', { size: fmtSize(MAX_READ) })));
    }, function (err) {
      if (S.selected === entry) add(body, el('div', 'panel-empty', tr('files.preview.readFail', '读取失败：') + errText(err)));
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
    setStatus(tr('files.status.loading', '正在读取 {path}…', { path: disp(S.path) }));
    return invoke('file.list', { path: S.path || '.' }).then(function (data) {
      S.path = data.path === '.' ? '' : (data.path || '');
      S.entries = (data.entries || []).slice().sort(function (a, b) {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return String(a.name).localeCompare(String(b.name), 'zh-CN');
      });
      S.listShown = LIST_PAGE; // 换目录回到首批，避免上一目录的「已显示」数带过来
      pruneChecked();
      if (S.pendingSelect) {
        S.selected = S.entries.filter(function (e) { return e.path === S.pendingSelect; })[0] || null;
        S.pendingSelect = null;
      } else if (S.selected) {
        S.selected = S.entries.filter(function (e) { return e.path === S.selected.path; })[0] || null;
      }
      paintCrumbs(); paintTabs(); paintList(); paintPreview();
      setStatus(tr('files.status.total', '共 {n} 项 · {path}', { n: S.entries.length, path: disp(S.path) }), 'ok');
    }, function (err) {
      setStatus(tr('files.status.readFail', '读取失败：') + errText(err), 'fail');
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
    S.tabTrash.textContent = tr('files.tab.trash', '回收站') + (S.trash.total ? '（' + S.trash.total + '）' : '');
    if (S.listTitle) {
      S.listTitle.textContent = S.view === 'trash' ? tr('files.tab.trash', '回收站') : S.view === 'search' ? tr('files.search.result', '搜索结果') : tr('files.dirContent', '目录内容');
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
      S.searchInput.placeholder = nameMode ? tr('files.search.placeholderName', '文件名，如 *.log 或 report') : tr('files.search.placeholderContent', '文件内容里的关键词，如 timeout');
      S.searchInput.setAttribute('aria-label', nameMode ? tr('files.search.ariaName', '按文件名搜索') : tr('files.search.ariaContent', '按内容搜索'));
    }
    if (S.searchHint) {
      S.searchHint.textContent = nameMode
        ? tr('files.search.hintName', '按文件名：支持 * 通配；直接输入 report 会自动按 *report* 匹配')
        : tr('files.search.hintContent', '按内容：只搜文本文件，单文件 ≤ 1 MiB，二进制会跳过');
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
    if (!params) { setStatus(tr('files.search.emptyQuery', '搜索关键词不能为空：按文件名填 *.log 之类，按内容填要查的文字'), 'fail'); S.searchInput.focus(); return; }
    setStatus(tr('files.search.searching', '正在{mode}搜索「{q}」…', { mode: S.search.mode === 'name' ? tr('files.search.byName', '按文件名') : tr('files.search.byContent', '按内容'), q: S.search.query }));
    invoke('file.search', params).then(function (data) {
      S.view = 'search';
      S.search.result = data;
      S.search.active = true;
      S.selected = null; S.checked = {};
      if (S.searchClearBtn) S.searchClearBtn.hidden = false;
      paintTabs(); paintSearchResults(); paintPreview();
      var note = data.truncated ? tr('files.search.truncated', '（结果较多，只显示前 {n} 条，请进入子目录或换更精确的关键词）', { n: data.matched }) : '';
      setStatus(tr('files.search.done', '搜索完成：{matched} 项匹配，扫描 {scanned} 项{skip}{note}', { matched: data.matched, scanned: data.scanned, skip: data.skipped ? tr('files.search.skipped', '，跳过 {n} 项（二进制/超大文件）', { n: data.skipped }) : '', note: note }), 'ok');
    }, function (err) {
      setStatus(tr('files.search.fail', '搜索失败：') + errText(err) + ' ' + hintFor('search', err), 'fail');
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
    if (S.count) S.count.textContent = tr('files.search.countMatch', '{n} 项匹配', { n: entries.length });
    if (!entries.length) {
      host.appendChild(window.KoreUI.emptyBlock({
        title: tr('files.search.emptyTitle', '没有找到匹配项'),
        text: tr('files.search.emptyText', '换个关键词，或切换「按文件名 / 按内容」；内容搜索会跳过二进制与超过 1 MiB 的文件。'),
        label: tr('files.search.clearEmpty', '清空搜索'), onClick: clearSearch
      }));
      updateSelection();
      return;
    }
    var table = add(host, el('table', 'files-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    [tr('files.search.colPath', '路径'), tr('files.col.size', '大小'), tr('files.search.colHit', '命中')].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    entries.forEach(function (entry) {
      var row = add(body, el('tr', 'files-row'));
      row.tabIndex = 0;
      row.dataset.path = entry.path;
      var pathCell = add(row, el('td', 'files-name')); pathCell.dataset.label = tr('files.search.colPath', '路径');
      add(pathCell, el('span', 'files-kind', entry.is_dir ? tr('files.kind.dir', '目录') : tr('files.kind.file', '文件')));
      add(pathCell, el('span', 'files-name-text')).appendChild(markSeq(entry.path, S.search.query));
      var sizeCell = add(row, el('td', null, entry.is_dir ? '—' : fmtSize(entry.size))); sizeCell.dataset.label = tr('files.col.size', '大小');
      var hitCell = add(row, el('td')); hitCell.dataset.label = tr('files.search.colHit', '命中');
      if (entry.line > 0) {
        add(hitCell, el('span', 'muted', tr('files.search.line', '第 {line} 行 ', { line: entry.line })));
        hitCell.appendChild(markSeq(narrowPreview(entry.preview, S.search.query), S.search.query));
      } else {
        add(hitCell, el('span', 'muted', tr('files.search.nameMatch', '文件名匹配')));
      }
      function open() {
        if (entry.is_dir) { goPath(entry.path); return; }
        var slash = entry.path.lastIndexOf('/');
        S.pendingSelect = entry.path;
        goPath(slash >= 0 ? entry.path.slice(0, slash) : '');
      }
      on(row, open);
      row.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    });
    updateSelection();
  }
  // loadTrashCount 是「自动发现」入口：进视图时问一次回收站有多少项，非空就提示可恢复。
  function loadTrashCount() {
    return invoke('file.trash.list', { limit: 1 }).then(function (data) {
      S.trash.total = data.total || 0;
      paintTabs();
      if (S.trash.total > 0 && S.view === 'files') {
        setStatus(tr('files.trash.available', '回收站有 {n} 项可恢复：点上方「回收站」查看或还原', { n: S.trash.total }), 'ok');
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
    setStatus(tr('files.trash.loading', '正在读取回收站…'));
    return invoke('file.trash.list', { limit: 200 }).then(function (data) {
      S.trash.loading = false;
      S.trash.entries = data.entries || [];
      S.trash.total = data.total || 0;
      S.trash.checked = {};
      paintCrumbs(); paintTabs(); paintTrash();
      var corrupt = data.skipped ? tr('files.trash.corrupt', '（另有 {n} 项元数据损坏，未列出）', { n: data.skipped }) : '';
      setStatus(tr('files.trash.total', '回收站共 {n} 项{limit}{corrupt}', { n: S.trash.total, limit: data.truncated ? tr('files.trash.limit', '，仅显示最近 200 项') : '', corrupt: corrupt }), 'ok');
    }, function (err) {
      S.trash.loading = false;
      setStatus(tr('files.trash.readFail', '读取回收站失败：') + errText(err), 'fail');
      paintTabs();
    });
  }
  function paintTrash() {
    var host = S.listHost;
    if (!host) return;
    host.textContent = '';
    if (S.count) S.count.textContent = (S.trash.entries || []).length + ' 项';
    // 回收站为空时不渲染一排全禁用的操作按钮——那只会让人怀疑「是不是坏了」。
    if (!S.trash.entries.length) {
      host.appendChild(window.KoreUI.emptyBlock({
        title: tr('files.trash.emptyTitle', '回收站是空的'),
        text: tr('files.trash.emptyText', '在文件列表里删除项目时不会立刻销毁，会先移到这里，随时可以恢复。'),
        label: tr('files.trash.back', '返回文件列表'), onClick: function () { goPath(''); }
      }));
      updateSelection();
      return;
    }
    var ops = add(host, el('div', 'files-actions files-trash-ops'));
    S.trashRestoreBtn = add(ops, el('button', 'btn', tr('files.trash.restoreSelected', '恢复所选'))); S.trashRestoreBtn.type = 'button';
    S.trashRestoreBtn.disabled = true;
    on(S.trashRestoreBtn, function () { restoreTrash(trashCheckedIds()); });
    S.trashPurgeBtn = add(ops, el('button', 'btn btn-ghost files-del', tr('files.trash.purgeSelected', '彻底删除所选'))); S.trashPurgeBtn.type = 'button';
    S.trashPurgeBtn.disabled = true;
    on(S.trashPurgeBtn, function () { purgeTrash(trashCheckedIds(), false); });
    var purgeAll = add(ops, el('button', 'btn btn-ghost files-del', tr('files.trash.empty', '清空回收站'))); purgeAll.type = 'button';
    on(purgeAll, function () { purgeTrash([], true); });
    var table = add(host, el('table', 'files-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    add(htr, el('th', 'files-check-head', ''));
    [tr('files.col.originalPath', '原路径'), tr('files.trash.colType', '类型'), tr('files.col.size', '大小'), tr('files.trash.colDeletedAt', '删除时间'), tr('files.col.actions', '操作')].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.trash.entries.forEach(function (item) {
      var row = add(body, el('tr', 'files-row'));
      var checkCell = add(row, el('td', 'files-check')); checkCell.dataset.label = tr('files.select', '选择');
      var box = add(checkCell, el('input', 'files-checkbox')); box.type = 'checkbox';
      box.setAttribute('aria-label', tr('files.selectItem', '选择 {name}', { name: item.path }));
      box.checked = !!S.trash.checked[item.id];
      box.addEventListener('change', function () {
        if (box.checked) S.trash.checked[item.id] = true; else delete S.trash.checked[item.id];
        updateSelection();
      });
      var pathCell = add(row, el('td', 'files-name')); pathCell.dataset.label = tr('files.col.originalPath', '原路径');
      add(pathCell, el('span', null, disp(item.path)));
      var kindCell = add(row, el('td', null, item.kind === 'dir' ? tr('files.kind.dir', '目录') : item.kind === 'symlink' ? tr('files.trash.kindLink', '链接') : tr('files.kind.file', '文件')));
      kindCell.dataset.label = tr('files.trash.colType', '类型');
      var sizeCell = add(row, el('td', null, item.kind === 'dir' ? '—' : fmtSize(item.size))); sizeCell.dataset.label = tr('files.col.size', '大小');
      var timeCell = add(row, el('td', null, fmtTime(item.deleted_at))); timeCell.dataset.label = tr('files.trash.colDeletedAt', '删除时间');
      var cellOps = add(row, el('td', 'cell-ops')); cellOps.dataset.label = tr('files.col.actions', '操作');
      var restore = add(cellOps, el('button', 'btn btn-ghost', tr('files.trash.restore', '恢复'))); restore.type = 'button';
      restore.addEventListener('click', function (ev) { ev.stopPropagation(); restoreTrash([item.id]); });
      var purge = add(cellOps, el('button', 'btn btn-ghost files-del', tr('files.trash.purge', '彻底删除'))); purge.type = 'button';
      purge.addEventListener('click', function (ev) { ev.stopPropagation(); purgeTrash([item.id], false); });
    });
    updateSelection();
  }
  function finishRestore(failed, total) {
    return (S.view === 'trash' ? showTrash() : Promise.resolve()).then(function () {
      return loadTrashCount();
    }).then(function () {
      if (!failed.length) { setStatus(tr('files.trash.restored', '已恢复 {n} 项到原路径', { n: total }), 'ok'); return; }
      setStatus(tr('files.trash.restoreDone', '恢复完成：成功 {ok} 项，失败 {fail} 项：{detail}', { ok: total - failed.length, fail: failed.length, detail: failed.slice(0, 3).join('；') }), 'fail');
    });
  }
  // restoreTrash 逐项恢复；原路径冲突时再给一次显式「覆盖恢复」确认（不静默覆盖）。
  function restoreTrash(ids) {
    if (!ids || !ids.length) { setStatus(tr('files.trash.restoreNoSel', '请先勾选要恢复的项，或在行内点「恢复」'), 'fail'); return Promise.resolve(); }
    setStatus(tr('files.trash.restoring', '正在恢复 {n} 项…', { n: ids.length }));
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
      ask(tr('files.trash.overwriteConfirm', '覆盖恢复确认'), null,
        tr('files.trash.overwriteText', '{n} 项的原路径已被占用。可以先在原目录把同名项改名或移走，再回来恢复；也可以直接覆盖恢复（文件替换文件、空目录替换空目录）。', { n: conflicts.length }),
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
    add(box, el('div', 'kore-modal-title', tr('files.purge.title', '彻底删除确认（不可恢复）')));
    add(box, el('p', 'kore-modal-text',
      (all ? tr('files.purge.all', '将永久删除回收站里的全部 {n} 项。', { n: count }) : tr('files.purge.selected', '将永久删除选中的 {n} 项。', { n: count })) +
      tr('files.purge.warn', '彻底删除后无法恢复，也无法从本页找回。')));
    var line = add(box, el('label', 'field field-check'));
    var sure = add(line, el('input', 'files-checkbox')); sure.type = 'checkbox';
    add(line, el('span', null, tr('files.purge.ack', '我已知晓：彻底删除后无法恢复')));
    var msg = add(box, el('div', 'kore-modal-msg')); msg.setAttribute('role', 'alert');
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', tr('files.action.cancel', '取消'))); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary files-del', tr('files.purge.confirm', '彻底删除'))); ok.type = 'submit'; ok.disabled = true;
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
    if (!count) { setStatus(tr('files.purge.noItems', '没有可彻底删除的项：请先勾选，或回收站本身是空的'), 'fail'); return Promise.resolve(); }
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
          if (!failed.length) { setStatus(tr('files.purge.done', '已彻底删除 {n} 项，无法恢复', { n: count }), 'ok'); return; }
          msg.textContent = tr('files.purge.failDetail', '失败明细：') + failed.slice(0, 3).join('；');
          setStatus(tr('files.purge.doneSummary', '彻底删除完成：成功 {ok} 项，失败 {fail} 项', { ok: count - failed.length, fail: failed.length }), 'fail');
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
    add(cell, el('span', 'files-kind', entry.is_dir ? tr('files.kind.dir', '目录') : tr('files.kind.file', '文件')));
    var input = add(cell, el('input', 'field-input files-rename-input'));
    input.type = 'text'; input.value = entry.name;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', tr('files.rename.newNameAria', '新名称（同目录改名）'));
    var ops = add(cell, el('span', 'files-rename-ops'));
    var save = add(ops, el('button', 'btn btn-primary', tr('files.action.save', '保存'))); save.type = 'button';
    var cancel = add(ops, el('button', 'btn btn-ghost', tr('files.action.cancel', '取消'))); cancel.type = 'button';
    function done() { S.renaming = null; paintList(); }
    function commit() {
      var name = String(input.value || '').trim();
      if (badName(name) || name === '.trash') {
        setStatus(tr('files.rename.invalid', '名称不合法：不能为空、不能含 / 或 \\，也不能是保留名 .trash'), 'fail'); input.focus(); return;
      }
      if (name === entry.name) { done(); return; }
      save.disabled = true;
      invoke('file.rename', { path: entry.path, name: name }).then(function (res) {
        S.renaming = null;
        setStatus(tr('files.rename.done', '已改名：{from} → {to}', { from: disp(res.from), to: disp(res.to) }), 'ok');
        refresh();
      }, function (err) {
        save.disabled = false;
        if (err && err.code === 'E_CONFLICT') { setStatus(tr('files.rename.conflict', '同名已存在，换个名字'), 'fail'); input.focus(); input.select(); return; }
        setStatus(tr('files.rename.fail', '改名失败：') + errText(err) + ' ' + hintFor('rename', err), 'fail');
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

  // P0 工具栏局部样式：只作用于本视图；[hidden] 必须压过 .files-actions 的 display:flex。
  function ensureToolbarCss() {
    if (document.getElementById('kore-files-toolbar-css')) return;
    var style = document.createElement('style');
    style.id = 'kore-files-toolbar-css';
    style.textContent = '.files-toolbar [hidden]{display:none!important}' +
      '.files-context-actions{background:var(--kore-bg-2);border:1px solid var(--kore-border-1);' +
      'border-radius:6px;padding:6px 10px}' +
      '.files-new-menu{position:absolute;z-index:30;display:flex;flex-direction:column;gap:4px;' +
      'padding:6px;border:1px solid var(--kore-border-1);border-radius:6px;' +
      'background:var(--kore-bg-1);box-shadow:0 6px 18px rgba(0,0,0,.22)}' +
      '.files-new-menu .btn{min-height:44px;white-space:nowrap;text-align:left}' +
      '.files-default-actions{position:relative}';
    document.head.appendChild(style);
  }
  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', tr('files.title', '文件管理')));
    add(head, el('p', 'view-sub', tr('files.subtitle', '浏览、上传、下载、压缩、解压、改权限与移动；路径始终以根目录相对形式显示。')));
    var bar = add(root, el('div', 'files-toolbar'));
    S.filesToolbar = bar;
    S.crumbs = add(bar, el('nav', 'files-crumbs'));
    S.crumbs.setAttribute('aria-label', tr('files.crumbs.aria', '当前路径'));
    ensureToolbarCss();
    var actions = add(bar, el('div', 'files-actions files-default-actions'));
    S.defaultBar = actions;
    var up = add(actions, el('button', 'btn btn-primary', tr('files.upload', '上传')));
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
    // P0 §2.4：默认态只留上传 / 新建 / 刷新 3 个按钮；其余 7 个进勾选后的上下文栏。
    var context = add(bar, el('div', 'files-actions files-context-actions'));
    context.hidden = true;
    S.contextBar = context;
    S.compressBtn = add(context, el('button', 'btn', tr('files.compress', '压缩')));
    S.compressBtn.type = 'button'; S.compressBtn.disabled = true;
    S.compressBtn.setAttribute('data-action', 'compress');
    on(S.compressBtn, function () { runL2('compress', checkedEntries()); });
    // 批量删除=移入回收站（可恢复）→ 中性灰，不占危险色（C7 治理）；不可恢复的彻底删除仍在回收站保留红+确认。
    S.batchDel = add(context, el('button', 'btn btn-ghost files-batch-trash', tr('files.batch.delete', '批量删除（进回收站）')));
    S.batchDel.type = 'button'; S.batchDel.disabled = true;
    S.batchDel.title = '移入回收站，可恢复；彻底删除请到回收站里再操作一次（需二次确认）';
    S.batchDel.setAttribute('data-action', 'batch-delete');
    S.batchMove = add(context, el('button', 'btn btn-ghost', tr('files.batch.move', '批量移动')));
    S.batchMove.type = 'button'; S.batchMove.disabled = true;
    S.batchMove.setAttribute('data-action', 'batch-move');
    on(S.batchMove, batchMove);
    on(S.batchDel, function () { runL2('removeMany', checkedEntries()); });
    S.selLabel = add(context, el('span', 'files-selected muted', ''));
    var mk = add(actions, el('button', 'btn', tr('files.new', '新建'))); mk.type = 'button';
    mk.id = 'files-new-entry';
    mk.setAttribute('aria-label', tr('files.newFolder', '新建目录 / 文件'));
    mk.setAttribute('aria-expanded', 'false');
    var newMenu = el('div', 'files-new-menu');
    newMenu.hidden = true;
    [[tr('files.newFolder', '新建目录'), true], [tr('files.newFile', '新建文件'), false]].forEach(function (pair) {
      var item = el('button', 'btn btn-ghost', pair[0]); item.type = 'button';
      item.addEventListener('click', function (ev) { ev.stopPropagation(); newMenu.hidden = true; mk.setAttribute('aria-expanded', 'false'); newEntry(pair[1]); });
      newMenu.appendChild(item);
    });
    actions.appendChild(newMenu);
    on(mk, function (ev) {
      ev.stopPropagation();
      newMenu.hidden = !newMenu.hidden;
      mk.setAttribute('aria-expanded', newMenu.hidden ? 'false' : 'true');
    });
    document.addEventListener('click', function (ev) {
      if (newMenu.hidden || newMenu.contains(ev.target) || ev.target === mk) return;
      newMenu.hidden = true; mk.setAttribute('aria-expanded', 'false');
    });
    var rf = add(actions, el('button', 'btn btn-ghost', tr('files.refresh', '刷新'))); rf.type = 'button';
    on(rf, refresh);
    // 工具栏「改名 / 复制到」：作用于勾选 1 项（或右侧预览的条目），与行内按钮同一套逻辑。
    S.renameBtn = add(context, el('button', 'btn btn-ghost', tr('files.op.rename', '改名')));
    S.renameBtn.type = 'button'; S.renameBtn.disabled = true;
    S.renameBtn.setAttribute('data-action', 'rename-selected');
    on(S.renameBtn, function () {
      var entry = targetEntry();
      if (!entry) { setStatus(tr('files.selectForRename', '请先勾选或点选一个文件，再点「改名」'), 'fail'); return; }
      var rows = S.listHost ? S.listHost.querySelectorAll('tr.files-row') : [];
      for (var i = 0; i < rows.length; i++) {
        var rowPath = rows[i].getAttribute('data-entry-path') || rows[i].dataset.path;
        if (rowPath !== entry.path) continue;
        var cell = rows[i].querySelector('td.files-name');
        if (cell) startRename(entry, cell);
        return;
      }
    });
    S.copyBtn = add(context, el('button', 'btn btn-ghost', tr('files.op.copyTo', '复制到')));
    S.copyBtn.type = 'button'; S.copyBtn.disabled = true;
    S.copyBtn.setAttribute('data-action', 'copy-selected');
    on(S.copyBtn, function () {
      var entry = targetEntry();
      if (!entry) { setStatus(tr('files.selectForCopy', '请先勾选或点选一个文件，再点「复制到」'), 'fail'); return; }
      runL2('copy', entry);
    });
    // 单条操作「属性」：只读展示后端真实属性，点选一条即可（勾选或预览条目）。
    S.infoBtn = add(context, el('button', 'btn btn-ghost', tr('files.info.title', '属性')));
    S.infoBtn.type = 'button'; S.infoBtn.disabled = true;
    S.infoBtn.setAttribute('data-action', 'stat-selected');
    on(S.infoBtn, function () { showInfo(targetEntry()); });

    // 搜索：两个预设（按文件名 / 按内容），不让人写复杂语法。
    // 按文件名把裸关键词自动包成 *关键词*；只有写了通配符（* ? [）才原样使用。
    var searchBar = add(root, el('div', 'files-toolbar files-searchbar'));
    S.searchBar = searchBar;
    var searchOps = add(searchBar, el('div', 'files-actions'));
    S.searchNameBtn = add(searchOps, el('button', 'btn btn-primary files-search-mode', tr('files.search.byName', '按文件名')));
    S.searchNameBtn.type = 'button'; S.searchNameBtn.setAttribute('data-action', 'search-mode-name');
    S.searchContentBtn = add(searchOps, el('button', 'btn btn-ghost files-search-mode', tr('files.search.byContent', '按内容')));
    S.searchContentBtn.type = 'button'; S.searchContentBtn.setAttribute('data-action', 'search-mode-content');
    on(S.searchNameBtn, function () { setSearchMode('name'); });
    on(S.searchContentBtn, function () { setSearchMode('content'); });
    S.searchInput = add(searchOps, el('input', 'field-input files-search-input'));
    S.searchInput.type = 'search'; S.searchInput.autocomplete = 'off';
    S.searchInput.setAttribute('aria-label', tr('files.search.inputAria', '搜索关键词'));
    S.searchInput.placeholder = tr('files.search.placeholderName', '文件名，如 *.log 或 report');
    S.searchInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); runSearch(); } });
    var searchGo = add(searchOps, el('button', 'btn', tr('files.search.go', '搜索'))); searchGo.type = 'button';
    searchGo.setAttribute('data-action', 'search');
    on(searchGo, runSearch);
    S.searchClearBtn = add(searchOps, el('button', 'btn btn-ghost', tr('files.search.clear', '清除搜索')));
    S.searchClearBtn.type = 'button'; S.searchClearBtn.hidden = true;
    on(S.searchClearBtn, clearSearch);
    S.searchHint = add(searchBar, el('span', 'files-selected muted', tr('files.search.hint', '按文件名：支持 * 通配；按内容：在文本文件里找关键词（单文件 ≤ 1 MiB）')));
    S.status = add(root, el('div', 'files-status muted')); S.status.setAttribute('role', 'status');
    var layout = add(root, el('div', 'files-layout'));
    var listPanel = add(layout, el('section', 'panel files-list-panel'));
    var listHead = add(listPanel, el('div', 'panel-head'));
    S.listTitle = add(listHead, el('span', 'panel-title', tr('files.dirContent', '目录内容')));
    var headMeta = add(listHead, el('div', 'panel-meta actions'));
    S.tabFiles = add(headMeta, el('button', 'btn btn-primary files-tab', tr('files.tab.files', '文件')));
    S.tabFiles.type = 'button'; S.tabFiles.setAttribute('data-action', 'tab-files');
    S.tabTrash = add(headMeta, el('button', 'btn btn-ghost files-tab', tr('files.tab.trash', '回收站')));
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
    add(previewHead, el('span', 'panel-title', tr('files.preview.title', '文件预览')));
    S.previewMeta = add(previewHead, el('span', 'panel-meta', ''));
    S.previewHost = add(previewPanel, el('div', 'files-preview-host'));
  }
  function render(container) {
    if (!container) return null;
    S.path = ''; S.entries = []; S.selected = null; S.checked = {}; S.renaming = null;
    S.listShown = LIST_PAGE; S.moreBtn = null;
    S.view = 'files';
    S.search = { mode: S.search && S.search.mode === 'content' ? 'content' : 'name', query: '', result: null, active: false };
    S.trash = { total: 0, entries: [], checked: {}, loading: false };
    container.textContent = '';
    var root = add(container, el('section', 'files'));
    build(root); setSearchMode(S.search.mode);
    refresh().then(loadTrashCount);
  }
  /* G-32 同款验收钩子（列表渲染，非图表）：count() = 已渲染行数，total() = 后端返回总数，
     page = 单批行数上限。冒烟脚本据此断言「大目录不整表渲染」。 */
  window.__koreFilesList = {
    count: function () {
      var host = S.listHost;
      return host ? host.querySelectorAll('tr.files-row').length : 0;
    },
    total: function () { return S.entries.length; },
    page: LIST_PAGE
  };
  window.KoreFiles = { render: render };
})();
