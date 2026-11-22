/* kore 主壳 · 进程管理（web/process.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/process/process.list）；
   方法段一律写完整限定名 process.*，裸动词只是插件侧兼容，不得依赖。
   window.KoreProcess.render：列表/详情/树/结束走 process.*；行点击开详情抽屉，
   kill 需二次确认（pid + 名称 + 命令行）并可选信号，服务端错误体原样展示。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/process/';
  var TIMEOUT_MS = 15000;
  var SIGNALS = ['TERM', 'KILL', 'HUP', 'INT'];
  function fresh() {
    return { items: [], total: 0, sort: 'cpu', q: '', firstSample: false, rawNote: '', loading: false,
      loadError: '', detail: null, detailPid: 0, detailError: '', confirm: false, signal: 'TERM',
      killResult: null, killError: '', killBusy: false, tree: null, treeError: '', treeOpen: false, destroyed: false };
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
  function paintTable() {
    var host = S.tableHost;
    host.textContent = '';
    if (S.loadError) {
      var box = add(host, el('div', 'proc-empty'));
      add(box, el('p', 'proc-empty-text', '进程列表加载失败：' + S.loadError));
      var retry = add(box, el('button', 'btn', '重试')); retry.type = 'button';
      on(retry, load);
      return;
    }
    var q = S.q.trim().toLowerCase();
    var rows = q ? S.items.filter(function (it) {
      return (it.name || '').toLowerCase().indexOf(q) >= 0 || (it.cmdline || '').toLowerCase().indexOf(q) >= 0;
    }) : S.items;
    S.countMeta.textContent = S.items.length ? rows.length + ' / ' + S.total + ' 个进程' : '';
    if (!S.items.length) { add(host, el('div', 'proc-empty-text', S.loading ? '正在读取进程列表…' : '没有可显示的进程')); return; }
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
    rows.forEach(function (item) {
      var tr = add(body, el('tr', 'proc-row')); tr.tabIndex = 0;
      var open = function () { openDetail(item.pid); };
      on(tr, open);
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      add(tr, el('td', 'proc-num', item.pid));
      var name = add(tr, el('td', 'proc-name')); add(name, el('span', null, item.name || '—'));
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
    ok.disabled = S.killBusy; on(ok, function () { doKill(d.pid); });
    var cancel = add(row, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    on(cancel, function () { S.confirm = false; paintDrawer(); });
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
    var ops = add(host, el('div', 'proc-actions'));
    var killBtn = add(ops, el('button', 'btn proc-danger', '结束进程')); killBtn.type = 'button';
    killBtn.disabled = !!d.restricted; if (d.restricted) killBtn.title = '受限进程禁用结束操作';
    on(killBtn, function () {
      if (killBtn.disabled) return;
      S.confirm = true; S.killError = ''; S.killResult = null; paintDrawer();
    });
    var treeBtn = add(ops, el('button', 'btn btn-ghost', S.treeOpen ? '收起进程树' : '查看进程树'));
    treeBtn.type = 'button';
    on(treeBtn, function () {
      if (S.treeOpen) { S.treeOpen = false; S.tree = null; S.treeError = ''; paintDrawer(); return; }
      showTree(d.pid);
    });
    if (S.confirm) paintConfirm(host, d);
    if (S.killError) {
      var kerr = add(host, el('div', 'proc-error'));
      kerr.setAttribute('role', 'alert'); kerr.textContent = '结束失败：' + S.killError;
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
          return indent + n.pid + '  ' + n.name + '  [' + n.state + ']';
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
    S.killError = ''; S.tree = null; S.treeError = ''; S.treeOpen = false; setDrawer(false);
  }
  function openDetail(pid) {
    if (!pid) return;
    S.lastFocus = document.activeElement;
    S.detailPid = pid; S.detail = null; S.detailError = ''; S.confirm = false; S.killResult = null;
    S.killError = ''; S.killBusy = false; S.tree = null; S.treeError = ''; S.treeOpen = false;
    setDrawer(true); paintDrawer();
    invoke('process.detail', { pid: pid }).then(function (d) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.detail = d; paintDrawer();
    }, function (err) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.detailError = err.message; paintDrawer();
    });
  }
  function showTree(pid) {
    S.treeOpen = true; S.tree = null; S.treeError = ''; paintDrawer();
    invoke('process.tree', { pid: pid }).then(function (t) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.tree = t; paintDrawer();
    }, function (err) {
      if (S.destroyed || S.detailPid !== pid) return;
      S.treeError = err.message; paintDrawer();
    });
  }
  function doKill(pid) {
    if (S.killBusy) return;
    S.killBusy = true; S.killError = ''; S.killResult = null; paintDrawer();
    invoke('process.kill', { pid: pid, signal: S.signal }).then(function (r) {
      if (S.destroyed) return;
      S.killBusy = false; S.confirm = false; S.killResult = r; paintDrawer();
      if (!r.still_alive) setTimeout(function () { if (!S.destroyed) load(); }, 500);
    }, function (err) {
      if (S.destroyed) return;
      S.killBusy = false; S.killError = err.message; paintDrawer();
    });
  }
  function load() {
    S.loading = true; S.loadError = ''; paintTable();
    invoke('process.list', { sort: S.sort, limit: 100 }).then(function (d) {
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
    S.qEl.addEventListener('input', function () { S.q = S.qEl.value; paintTable(); });
    var refresh = add(tools, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, load);
    S.countMeta = add(tools, el('span', 'proc-count muted', ''));
    S.noteHost = add(root, el('div', 'proc-note muted'));
    var panel = add(root, el('section', 'panel'));
    var ph = add(panel, el('div', 'panel-head'));
    add(ph, el('span', 'panel-title', '进程列表'));
    add(ph, el('span', 'panel-meta', '点列头排序 · 点行看详情'));
    S.tableHost = add(panel, el('div', 'proc-table-host'));
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
