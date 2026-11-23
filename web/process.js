/* kore 主壳 · 进程管理（web/process.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/process/process.list）；
   方法段一律写完整限定名 process.*，裸动词只是插件侧兼容，不得依赖。
   window.KoreProcess.render：列表/详情/树/结束/优先级走 process.*；行点击开详情抽屉。
   契约对齐 kore-plugin-process 0.2.1：
   - process.tree 入参是 {root}（0/缺省=全系统森林），节点只有 pid/ppid/name/depth/children_count（无 state）；
   - process.kill 必须 confirm:true + name（防 PID 复用），SIGKILL 另需 force:true；
   - process.renice {pid, value 0..19, confirm:true, name?} → {previous, nice, changed}，
     value < 当前 nice（提权）回 E_NEED_ROOT；
   - list/detail 带 protected/protected_reason：保护行加锁标并禁用结束与优先级操作。
   结束/优先级均二次确认，服务端错误体原样展示 + 可操作提示。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/process/';
  var TIMEOUT_MS = 15000;
  var SIGNALS = ['TERM', 'KILL', 'HUP', 'INT'];
  // 进程表默认只渲染 20 行（每次加载更多 +20）；接口单次最多返回 500 条。
  var PAGE_SIZE = 20, FETCH_LIMIT = 500;
  // 优先级预设（USABILITY ①预设优先）：后端只收 0..19，数字越小优先级越高；自定义框兜底。
  var NICE_PRESETS = [['high', '高（nice 0）', 0], ['normal', '普通（nice 10）', 10], ['low', '低（nice 19）', 19]];
  function fresh() {
    return { items: [], total: 0, sort: 'cpu', q: '', firstSample: false, rawNote: '', loading: false,
      shown: PAGE_SIZE, loadError: '', detail: null, detailPid: 0, detailError: '', confirm: false, signal: 'TERM',
      killResult: null, killError: '', killCode: '', killBusy: false, tree: null, treeError: '', treeOpen: false, destroyed: false,
      renice: false, renicePreset: 'normal', reniceCustom: '', reniceBusy: false, reniceResult: null, reniceError: '' };
  }
  var S = fresh();
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
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
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || '';
          throw err;
        }
        return data;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }
  function fmtInt(n) {
    return typeof n === 'number' && isFinite(n) ? n.toLocaleString('zh-CN') : '—';
  }
  function fmtKiB(kib) {
    if (typeof kib !== 'number' || !isFinite(kib)) return '—';
    var mib = kib / 1024;
    return mib >= 1024 ? (mib / 1024).toFixed(1) + ' GiB' : mib >= 1 ? mib.toFixed(1) + ' MiB' : kib + ' KiB';
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function fmtElapsed(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '—';
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return d + ' 天 ' + h + ' 小时';
    if (h) return h + ' 小时 ' + m + ' 分';
    return m ? m + ' 分' : sec + ' 秒';
  }
  // hintFor：服务端 message 已含可操作提示时不再重复；否则按错误码补一句"怎么办"。
  function hintFor(err) {
    var msg = (err && err.message) || '';
    if (/root|刷新后重试/.test(msg)) return '';
    var code = (err && err.code) || '';
    if (code === 'E_NEED_ROOT') return '（需要内核以系统服务（root）运行：把 kore 配成 systemd 服务后重启，再重试）';
    if (code === 'E_UNAUTHORIZED') return '（该进程在保护名单内，不允许此操作）';
    if (code === 'E_NOTFOUND') return '（进程可能已退出：点「刷新」重新拉取）';
    if (code === 'E_CONFLICT') return '（进程名不符，可能 PID 已复用：点「刷新」后重试）';
    return '';
  }
  function paintTable() {
    var host = S.tableHost;
    host.textContent = '';
    if (S.loadError) {
      var box = add(host, el('div', 'proc-empty'));
      add(box, el('p', 'proc-empty-text', '进程列表加载失败：' + S.loadError));
      var retry = add(box, el('button', 'btn', '重试')); retry.type = 'button';
      on(retry, load);
      paintMore();
      return;
    }
    var q = S.q.trim().toLowerCase();
    var rows = q ? S.items.filter(function (it) {
      return (it.name || '').toLowerCase().indexOf(q) >= 0 || (it.cmdline || '').toLowerCase().indexOf(q) >= 0;
    }) : S.items;
    var displayTotal = q ? rows.length : (S.total || rows.length);
    var shown = Math.min(S.shown, rows.length);
    S.countMeta.textContent = S.items.length
      ? '已显示 ' + fmtInt(shown) + ' / 共 ' + fmtInt(displayTotal) + ' 个进程' + (q ? '（已过滤）' : '')
      : '';
    if (!S.items.length) { add(host, el('div', 'proc-empty-text', S.loading ? '正在读取进程列表…' : '没有可显示的进程')); paintMore(); return; }
    var table = add(host, el('table', 'proc-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    [['pid', 'PID', 'pid'], ['name', '名称', 'name'], ['user', '用户', ''], ['state', '状态', ''],
      ['rss', 'RSS', 'mem'], ['cpu', 'CPU%', 'cpu'], ['cmd', '命令', '']].forEach(function (col) {
      var th = add(htr, el('th'));
      if (!col[2]) { th.textContent = col[1]; th.setAttribute('aria-sort', 'none'); return; }
      var btn = add(th, el('button', 'proc-sort', col[1])); btn.type = 'button';
      btn.setAttribute('aria-label', '按' + col[1] + '排序');
      if (S.sort === col[2]) {
        var asc = col[2] === 'pid' || col[2] === 'name';
        th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
        add(btn, el('span', 'proc-sort-arrow', asc ? '↑' : '↓'));
      } else th.setAttribute('aria-sort', 'none');
      on(btn, function () { if (S.sort === col[2]) return; S.sort = col[2]; load(); });
    });
    var body = add(table, el('tbody'));
    rows.slice(0, shown).forEach(function (item) {
      var tr = add(body, el('tr', 'proc-row')); tr.tabIndex = 0;
      var open = function () { openDetail(item.pid); };
      on(tr, open);
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      add(tr, el('td', 'proc-num', item.pid));
      var name = add(tr, el('td', 'proc-name')); add(name, el('span', null, item.name || '—'));
      if (item.protected) { // 保护名单行：锁标 + 原因悬浮，详情里结束/优先级一并禁用
        var ptag = add(name, el('span', 'tag-muted proc-restricted', '保护'));
        ptag.title = item.protected_reason || '核心进程：不允许结束或调整优先级';
        ptag.setAttribute('aria-label', ptag.title);
      }
      if (item.restricted) {
        var tag = add(name, el('span', 'tag-muted proc-restricted', '受限'));
        tag.title = item.restricted_reason || '进程信息不可读';
      }
      add(tr, el('td', null, item.user || '—'));
      add(tr, el('td', null, item.state || '—'));
      add(tr, el('td', 'proc-num', fmtKiB(item.rss_kib)));
      add(tr, el('td', 'proc-num', (Number(item.cpu_pct) || 0).toFixed(1) + '%'));
      var cmd = add(tr, el('td', 'proc-cmd', item.cmdline || '—'));
      cmd.title = item.cmdline || '';
    });
    paintMore();
  }
  // paintMore：底部固定显示「已显示 X / 共 Y 个进程」+「加载更多」。
  // 接口最多返回 500 条；到上限后说明剩余需后端扩上限，不假装还能加载。
  function paintMore() {
    if (!S.moreHost) return;
    S.moreHost.textContent = '';
    if (S.loadError || !S.items.length) return;
    var q = S.q.trim().toLowerCase();
    var rows = q ? S.items.filter(function (it) {
      return (it.name || '').toLowerCase().indexOf(q) >= 0 || (it.cmdline || '').toLowerCase().indexOf(q) >= 0;
    }) : S.items;
    var displayTotal = q ? rows.length : (S.total || rows.length);
    var shown = Math.min(S.shown, rows.length);
    var row = add(S.moreHost, el('div', 'db-auto-actions proc-more-row'));
    add(row, el('span', 'muted', '已显示 ' + fmtInt(shown) + ' / 共 ' + fmtInt(displayTotal) + ' 个进程'));
    if (shown < rows.length) {
      var more = add(row, el('button', 'btn btn-ghost', '加载更多'));
      more.type = 'button'; on(more, loadMore);
    } else if (!q && S.total > S.items.length) {
      add(row, el('span', 'muted', '（接口单次最多 ' + fmtInt(FETCH_LIMIT) + ' 条，剩余 ' +
        fmtInt(S.total - S.items.length) + ' 个未返回）'));
    }
  }
  function loadMore() {
    var q = S.q.trim().toLowerCase();
    var rows = q ? S.items.filter(function (it) {
      return (it.name || '').toLowerCase().indexOf(q) >= 0 || (it.cmdline || '').toLowerCase().indexOf(q) >= 0;
    }) : S.items;
    if (S.shown >= rows.length) return;
    S.shown = Math.min(S.shown + PAGE_SIZE, rows.length);
    paintTable();
  }
  function paintConfirm(host, d) {
    var box = add(host, el('div', 'proc-confirm'));
    add(box, el('p', 'proc-confirm-text', '确认结束 PID ' + d.pid + '（' + d.name + '）？'));
    add(box, el('code', 'proc-confirm-cmd', d.cmdline || '（无命令行）'));
    var row = add(box, el('div', 'proc-confirm-ops'));
    var sel = add(row, el('select', 'proc-input')); sel.setAttribute('aria-label', '结束信号');
    SIGNALS.forEach(function (sig) {
      var o = el('option', null, sig); o.value = sig;
      if (sig === S.signal) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { S.signal = sel.value; });
    var ok = add(row, el('button', 'btn proc-danger', '确认结束')); ok.type = 'button';
    ok.disabled = S.killBusy; on(ok, function () { doKill(d); });
    var cancel = add(row, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    on(cancel, function () { S.confirm = false; paintDrawer(); });
    // 0.2.1：提交必须带 confirm+name；KILL 不可恢复，服务端额外要求 force——这里先讲清楚再点。
    add(box, el('p', 'proc-confirm-text', S.signal === 'KILL'
      ? 'SIGKILL 不可恢复：服务端会要求强制确认（force）；选其它信号只需本次确认。'
      : '提交时会带上进程名做校验（防止 PID 被复用后误杀同号进程）。'));
  }
  function paintDrawer() {
    if (!S.drawerBody) return;
    var host = S.drawerBody;
    host.textContent = '';
    S.drawerTitle.textContent = S.detailPid ? '进程详情 · PID ' + S.detailPid : '进程详情';
    if (S.detailError) {
      var derr = add(host, el('div', 'proc-error'));
      derr.setAttribute('role', 'alert'); derr.textContent = '详情读取失败：' + S.detailError;
      var retry = add(host, el('button', 'btn', '重试')); retry.type = 'button';
      on(retry, function () { openDetail(S.detailPid); });
      return;
    }
    var d = S.detail;
    if (!d) { add(host, el('p', 'muted proc-drawer-hint', '正在读取进程详情…')); return; }
    var dl = add(host, el('dl', 'proc-detail'));
    [['状态', d.state || (d.status && d.status.state) || '—'],
      ['优先级', 'nice ' + (typeof d.nice === 'number' ? d.nice : '—') + '（数字越小优先级越高）'],
      ['用户', (d.user || '—') + (d.uid ? '（uid ' + d.uid + '）' : '')],
      ['VmRSS', fmtKiB(d.status && d.status.vm_rss_kib)], ['VmPeak', fmtKiB(d.status && d.status.vm_peak_kib)],
      ['线程', d.status ? String(d.status.threads) : '—'], ['启动时间', fmtTime(d.started_at)],
      ['已运行', fmtElapsed(d.elapsed_s)], ['exe', d.exe || '—', true],
      ['cwd', d.cwd || '—', true], ['命令行', d.cmdline || '—', true]].forEach(function (row) {
      add(dl, el('dt', null, row[0])); var dd = add(dl, el('dd', null, row[1]));
      if (row[2]) dd.classList.add('mono');
    });
    if (d.restricted) {
      var note = add(host, el('div', 'proc-restricted-note'));
      add(note, el('span', 'tag-muted', '受限'));
      add(note, el('span', 'muted', d.restricted_reason || '进程信息不可读'));
    }
    if (d.protected) { // 保护名单：与"受限"同款黄条，说清为什么点不动
      var pnote = add(host, el('div', 'proc-restricted-note'));
      add(pnote, el('span', 'tag-muted', '保护'));
      add(pnote, el('span', 'muted', d.protected_reason || '核心进程：不允许结束或调整优先级'));
    }
    var ops = add(host, el('div', 'proc-actions'));
    var killBtn = add(ops, el('button', 'btn proc-danger', '结束进程')); killBtn.type = 'button';
    killBtn.disabled = !!d.restricted || !!d.protected;
    if (d.protected) killBtn.title = '保护名单内的进程不允许结束';
    else if (d.restricted) killBtn.title = '受限进程禁用结束操作';
    on(killBtn, function () {
      if (killBtn.disabled) return;
      S.confirm = true; S.killError = ''; S.killResult = null; S.renice = false; paintDrawer();
    });
    var reniceBtn = add(ops, el('button', 'btn btn-ghost', '调整优先级')); reniceBtn.type = 'button';
    reniceBtn.disabled = !!d.restricted || !!d.protected;
    if (d.protected) reniceBtn.title = '保护名单内的进程不允许调整优先级';
    else if (d.restricted) reniceBtn.title = '受限进程禁用优先级调整';
    on(reniceBtn, function () {
      if (reniceBtn.disabled) return;
      S.renice = !S.renice; S.confirm = false; S.reniceError = ''; S.reniceResult = null; paintDrawer();
    });
    var treeBtn = add(ops, el('button', 'btn btn-ghost', S.treeOpen ? '收起进程树' : '查看进程树'));
    treeBtn.type = 'button';
    on(treeBtn, function () {
      if (S.treeOpen) { S.treeOpen = false; S.tree = null; S.treeError = ''; paintDrawer(); return; }
      showTree(d.pid);
    });
    if (S.renice) paintRenice(host, d);
    if (S.confirm) paintConfirm(host, d);
    if (S.killError) {
      var kerr = add(host, el('div', 'proc-error'));
      kerr.setAttribute('role', 'alert'); kerr.textContent = '结束失败：' + S.killError + hintFor({ message: S.killError, code: S.killCode });
    } else if (S.killResult) {
      var r = S.killResult, alive = r.killed && !r.still_alive;
      var kbox = add(host, el('div', alive ? 'proc-kill-ok' : 'proc-kill-warn'));
      kbox.setAttribute('role', 'status');
      add(kbox, el('p', 'proc-kill-text', 'signal=' + r.signal + ' · killed=' + String(r.killed) +
        ' · still_alive=' + String(r.still_alive) + ' · waited_ms=' + r.waited_ms));
      if (r.note) add(kbox, el('p', 'proc-kill-note', r.note));
    }
    if (S.treeOpen) {
      var tbox = add(host, el('div', 'proc-tree'));
      add(tbox, el('div', 'proc-tree-title', '进程树'));
      if (S.treeError) {
        var terr = add(tbox, el('div', 'proc-error'));
        terr.setAttribute('role', 'alert'); terr.textContent = '进程树读取失败：' + S.treeError;
      } else if (!S.tree) add(tbox, el('p', 'muted proc-tree-note', '正在读取进程树…'));
      else {
        var pre = add(tbox, el('pre', 'proc-tree-pre'));
        pre.textContent = (S.tree.nodes || []).map(function (n) {
          var indent = '';
          for (var i = 0; i < n.depth; i++) indent += '  ';
          // 0.2.1 节点字段：pid/ppid/name/depth/children_count（不再返回 state）
          return indent + n.pid + '  ' + n.name + (n.children_count ? '  (' + n.children_count + ' 子)' : '');
        }).join('\n');
        if (S.tree.truncated) {
          add(tbox, el('p', 'proc-tree-note', '树已截断（深度 ≤' + S.tree.max_depth + ' / 节点 ≤' + S.tree.max_nodes + '）'));
        }
      }
    }
  }
  function setDrawer(open) {
    if (!S.mask || !S.drawer) return;
    S.mask.hidden = !open; S.drawer.hidden = !open;
    if (open && S.closeBtn) S.closeBtn.focus(); else if (!open && S.lastFocus && S.lastFocus.focus) S.lastFocus.focus();
  }
  function closeDrawer() {
    S.detailPid = 0; S.detail = null; S.detailError = ''; S.confirm = false; S.killResult = null;
    S.killError = ''; S.killCode = ''; S.tree = null; S.treeError = ''; S.treeOpen = false;
    S.renice = false; S.reniceResult = null; S.reniceError = ''; S.reniceBusy = false; setDrawer(false);
  }
  function openDetail(pid) {
    if (!pid) return;
    S.lastFocus = document.activeElement;
    S.detailPid = pid; S.detail = null; S.detailError = ''; S.confirm = false; S.killResult = null;
    S.killError = ''; S.killCode = ''; S.killBusy = false; S.tree = null; S.treeError = ''; S.treeOpen = false;
    S.renice = false; S.reniceResult = null; S.reniceError = ''; S.reniceBusy = false;
    S.renicePreset = 'normal'; S.reniceCustom = '';
    setDrawer(true); paintDrawer();
    invoke('process.detail', { pid: pid }).then(function (d) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.detail = d; paintDrawer();
    }, function (err) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.detailError = err.message + hintFor(err); paintDrawer();
    });
  }
  function showTree(pid) {
    S.treeOpen = true; S.tree = null; S.treeError = ''; paintDrawer();
    // 0.2.1 契约：入参是 root（0/缺省=全系统森林），不再是 pid。
    invoke('process.tree', { root: pid }).then(function (t) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.tree = t; paintDrawer();
    }, function (err) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.treeError = err.message + hintFor(err); paintDrawer();
    });
  }
  // paintRenice：预设三档（高0/普通10/低19）+ 自定义 0..19 兜底；后端拒负数，这里也不给负数入口。
  function paintRenice(host, d) {
    var box = add(host, el('div', 'proc-confirm'));
    add(box, el('p', 'proc-confirm-text', '调整 PID ' + d.pid + '（' + d.name + '）的运行优先级'));
    add(box, el('code', 'proc-confirm-cmd', '当前 nice：' +
      (typeof d.nice === 'number' ? d.nice : '—') + '（数字越小优先级越高，范围 0–19）'));
    var row = add(box, el('div', 'proc-confirm-ops'));
    var sel = add(row, el('select', 'proc-input')); sel.setAttribute('aria-label', '优先级预设');
    NICE_PRESETS.forEach(function (p) {
      var o = el('option', null, p[1]); o.value = p[0];
      if (p[0] === S.renicePreset) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { S.renicePreset = sel.value; });
    var custom = add(row, el('input', 'proc-input')); custom.type = 'number';
    custom.min = '0'; custom.max = '19'; custom.step = '1';
    custom.placeholder = '自定义 0–19（可选）'; custom.value = S.reniceCustom;
    custom.setAttribute('aria-label', '自定义 nice 值 0 到 19');
    custom.addEventListener('input', function () { S.reniceCustom = custom.value; });
    var ok = add(row, el('button', 'btn', '确认调整')); ok.type = 'button';
    ok.disabled = S.reniceBusy;
    on(ok, function () { doRenice(d); });
    var cancel = add(row, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    on(cancel, function () { S.renice = false; S.reniceError = ''; S.reniceResult = null; paintDrawer(); });
    add(box, el('p', 'proc-confirm-text', '把数字调小（提权）需要 root：内核需以系统服务（root）运行；' +
      '调大（降优先级）随时可用。'));
    if (S.reniceBusy) add(box, el('p', 'muted proc-confirm-text', '正在调整…'));
    if (S.reniceError) {
      var rerr = add(box, el('div', 'proc-error'));
      rerr.setAttribute('role', 'alert');
      rerr.textContent = '调整失败：' + S.reniceError;
    } else if (S.reniceResult) {
      var r = S.reniceResult, rbox = add(box, el('div', 'proc-kill-ok'));
      rbox.setAttribute('role', 'status');
      rbox.textContent = '已调整：nice ' + r.previous + ' → ' + r.nice +
        (r.changed ? '' : '（值相同，未变化）') + '；列表已刷新';
    }
  }
  function doRenice(d) {
    if (S.reniceBusy) return;
    var value = null;
    if (String(S.reniceCustom).trim() !== '') {
      value = parseInt(S.reniceCustom, 10);
      if (isNaN(value) || value < 0 || value > 19) {
        S.reniceError = '自定义优先级必须是 0–19 的整数（数字越小优先级越高）'; paintDrawer(); return;
      }
    } else {
      NICE_PRESETS.forEach(function (p) { if (p[0] === S.renicePreset) value = p[2]; });
      if (value === null) value = 10;
    }
    S.reniceBusy = true; S.reniceError = ''; S.reniceResult = null; paintDrawer();
    invoke('process.renice', { pid: d.pid, value: value, confirm: true, name: d.name || '' }).then(function (r) {
      if (S.destroyed) return;
      S.reniceBusy = false; S.reniceResult = r; paintDrawer();
      setTimeout(function () { if (!S.destroyed) load(); }, 400); // 回读新 nice
    }, function (err) {
      if (S.destroyed) return;
      S.reniceBusy = false; S.reniceError = err.message + hintFor(err); paintDrawer();
    });
  }
  function doKill(d) {
    if (S.killBusy) return;
    S.killBusy = true; S.killError = ''; S.killCode = ''; S.killResult = null; paintDrawer();
    // 0.2.1 三层护栏：confirm 显式确认 + name 防 PID 复用；SIGKILL 不可恢复，另需 force。
    var params = { pid: d.pid, signal: S.signal, confirm: true, name: d.name || '' };
    if (S.signal === 'KILL') params.force = true;
    invoke('process.kill', params).then(function (r) {
      if (S.destroyed) return;
      S.killBusy = false; S.confirm = false; S.killResult = r; paintDrawer();
      if (!r.still_alive) setTimeout(function () { if (!S.destroyed) load(); }, 500);
    }, function (err) {
      if (S.destroyed) return;
      S.killBusy = false; S.killError = err.message; S.killCode = err.code || ''; paintDrawer();
    });
  }
  function load() {
    S.loading = true; S.loadError = ''; S.shown = PAGE_SIZE; paintTable();
    invoke('process.list', { sort: S.sort, limit: FETCH_LIMIT }).then(function (d) {
      if (S.destroyed) return;
      S.items = d.items || []; S.total = d.total || 0; S.firstSample = !!d.first_sample; S.rawNote = d.cpu_note || '';

      S.noteHost.textContent = S.firstSample ? '首次采样无历史基线，CPU 显示为 0' : '';
      if (S.rawNote) S.noteHost.title = S.rawNote;
      S.loading = false; paintTable();
    }, function (err) {
      if (S.destroyed) return;
      S.loading = false; S.loadError = err.message; S.items = []; S.total = 0; paintTable();
    });
  }
  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '进程'));
    add(head, el('p', 'view-sub', '来自 /proc 的真实进程：排序、过滤、详情、进程树与信号投递；危险操作二次确认。'));
    var tools = add(root, el('div', 'proc-toolbar'));
    S.qEl = add(tools, el('input', 'proc-input proc-search'));
    S.qEl.type = 'search'; S.qEl.placeholder = '过滤名称 / 命令行'; S.qEl.setAttribute('aria-label', '过滤进程');
    S.qEl.addEventListener('input', function () { S.q = S.qEl.value; S.shown = PAGE_SIZE; paintTable(); });
    var refresh = add(tools, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, load);
    S.countMeta = add(tools, el('span', 'proc-count muted', ''));
    S.noteHost = add(root, el('div', 'proc-note muted'));
    var panel = add(root, el('section', 'panel'));
    var ph = add(panel, el('div', 'panel-head'));
    add(ph, el('span', 'panel-title', '进程列表'));
    add(ph, el('span', 'panel-meta', '点列头排序 · 点行看详情'));
    S.tableHost = add(panel, el('div', 'proc-table-host'));
    S.moreHost = add(panel, el('div', 'proc-more'));
    S.mask = add(root, el('div', 'proc-mask')); S.mask.hidden = true; on(S.mask, closeDrawer);
    S.drawer = add(root, el('aside', 'proc-drawer')); S.drawer.hidden = true;
    S.drawer.setAttribute('role', 'dialog'); S.drawer.setAttribute('aria-modal', 'true'); S.drawer.setAttribute('aria-label', '进程详情');
    var dh = add(S.drawer, el('div', 'proc-drawer-head'));
    S.drawerTitle = add(dh, el('h3', 'proc-drawer-title', '进程详情'));
    S.closeBtn = add(dh, el('button', 'btn btn-ghost', '关闭'));
    S.closeBtn.type = 'button'; S.closeBtn.setAttribute('aria-label', '关闭进程详情');
    on(S.closeBtn, closeDrawer);
    S.drawerBody = add(S.drawer, el('div', 'proc-drawer-body'));
    S.onKey = function (ev) { if (ev.key === 'Escape' && S.detailPid) closeDrawer(); };
    document.addEventListener('keydown', S.onKey);
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    var root = add(container, el('section', 'proc'));
    build(root); load();
    return { destroy: function () {
      S.destroyed = true;
      document.removeEventListener('keydown', S.onKey);
      if (S.drawer) S.drawer.hidden = true;
      if (S.mask) S.mask.hidden = true;
    } };
  }
  window.KoreProcess = { render: render };
})();
