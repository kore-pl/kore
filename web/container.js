/* kore 主壳 · 容器管理（web/container.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/container/container.<action>；方法段写完整限定名。
   数据：container.list（含 protected 标记）/ logs（tail 200 + since）/ stats / inspect（关键字段，
   含重启策略/健康）/ start / stop / restart（stop/restart 需 confirm=true）。分页 20 行 + 加载更多；
   行操作开日志/详情抽屉（日志等宽字体）；停止/重启手输容器名确认；保护名单行锁标 + 禁用操作。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/container/', PAGE = 20, TIMEOUT_MS = 20000;
  var CSS = '.ctr-table{width:100%;border-collapse:collapse}.ctr-table th,.ctr-table td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--kore-border-2);font-size:var(--kore-font-13);word-break:break-word}' +
    '.ctr-table th{color:var(--kore-text-3);font-weight:400;font-size:var(--kore-font-12)}.ctr-name{font-weight:600}.ctr-lock{display:inline-flex;vertical-align:-3px;margin-left:4px;color:var(--kore-warning)}' +
    '.ctr-bar{position:relative;width:90px;height:8px;background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-radius:4px;overflow:hidden}' +
    '.ctr-bar-fill{position:absolute;inset:0 auto 0 0;background:var(--kore-success)}.ctr-bar-warn .ctr-bar-fill{background:var(--kore-warning)}.ctr-bar-high .ctr-bar-fill{background:var(--kore-danger)}' +
    '.ctr-ops{display:flex;gap:4px;flex-wrap:wrap}.ctr-ops .btn{min-height:26px;padding:0 8px;font-size:var(--kore-font-12)}.ctr-ops .btn[disabled]{cursor:not-allowed;opacity:.55}' +
    '.ctr-drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,92vw);z-index:30;background:var(--kore-bg-1);border-left:1px solid var(--kore-border-1);box-shadow:-8px 0 24px rgba(0,0,0,.35);display:flex;flex-direction:column}' +
    '.ctr-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--kore-border-2)}' +
    '.ctr-drawer-title{margin:0;font-size:var(--kore-font-15);font-weight:600}.ctr-drawer-body{flex:1;overflow:auto;padding:12px 16px}' +
    '.ctr-log{margin:8px 0 0;padding:12px;background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all}' +
    '.ctr-detail dt{margin-top:10px;color:var(--kore-text-3);font-size:var(--kore-font-12)}' +
    '.ctr-detail dd{margin:2px 0 0;font-size:var(--kore-font-13);word-break:break-word}.ctr-detail .mono{font-family:ui-monospace,Menlo,Consolas,monospace}' +
    '.ctr-mask{position:fixed;inset:0;z-index:29;background:var(--kore-overlay)}' +
    '.ctr-list-host .empty-state-title{margin:0;font-size:var(--kore-font-15);font-weight:600}' +
    '.ctr-confirm-title{margin:0 0 6px;font-size:var(--kore-font-14);font-weight:600;color:var(--kore-danger)}' +
    '.ctr-field{display:block;margin:10px 0}.ctr-field span{display:block;color:var(--kore-text-2);font-size:var(--kore-font-12);margin-bottom:4px}' +
    '.ctr-field input{width:100%;box-sizing:border-box;min-height:32px;padding:0 8px;background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-radius:4px;color:var(--kore-text-1);font-size:var(--kore-font-13)}' +
    '@media (max-width:639px){.ctr-drawer{width:100vw}.ctr-bar{width:64px}' +
    // 手机端表格转卡片行（与 files/sites/tasks 同口径）：列名走 data-label，操作按钮与输入框 ≥44px（裁决41）
    '.ctr-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}' +
    '.ctr-table,.ctr-table tbody,.ctr-table tr,.ctr-table td{display:block;width:100%}' +
    '.ctr-table tr{padding:var(--kore-space-2) 0;border-top:1px solid var(--kore-border-2)}' +
    '.ctr-table td{display:flex;align-items:center;gap:var(--kore-space-3);padding:3px 0;border-bottom:0}' +
    '.ctr-table td::before{content:attr(data-label);flex:0 0 68px;color:var(--kore-text-3);font-size:var(--kore-font-12)}' +
    '.ctr-ops{width:100%}.ctr-ops .btn{flex:1 1 auto;min-height:var(--kore-touch)}' +
    '.ctr-field input{min-height:var(--kore-touch)}}' +
    // 抽屉/遮罩/确认层都靠 hidden 属性开关，而 .ctr-drawer 与 .kore-modal 自带 display:flex——
    // 不补 [hidden]{display:none}，hidden 会被作者样式压掉，弹层常驻并挡住整页点击（P0）。
    '.ctr-drawer[hidden],.ctr-mask[hidden],.ctr-confirm[hidden]{display:none}' +
    '.ctr-exec{margin-top:14px;border-top:1px solid var(--kore-border-1);padding-top:10px}' +
    '.ctr-exec-warn{margin:0 0 6px;font-size:var(--kore-font-12);color:var(--kore-danger);line-height:1.6}' +
    '.ctr-exec-hint{margin:0 0 6px;font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.6}' +
    '.ctr-exec-cmd{width:100%;box-sizing:border-box;min-height:96px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--kore-font-13);padding:8px 10px;border:1px solid var(--kore-border-1);border-radius:6px;background:var(--kore-bg-0);color:var(--kore-text-1);resize:vertical}' +
    '.ctr-exec-opts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:flex-end}' +
    '.ctr-exec-opts .ctr-field{flex:1;min-width:150px;display:flex;flex-direction:column;gap:4px}' +
    '.ctr-exec-opts .ctr-field input,.ctr-exec-opts .ctr-field select{min-height:36px}' +
    '.ctr-exec-check{display:flex;align-items:center;gap:6px;font-size:var(--kore-font-13);margin-top:8px;min-height:44px}' +
    '.ctr-exec-check[hidden]{display:none}' +
    '.ctr-exec-actions{display:flex;gap:8px;margin-top:8px}' +
    '.ctr-exec-result{margin-top:10px;border:1px solid var(--kore-border-1);border-radius:6px;padding:10px;background:var(--kore-bg-0)}' +
    '.ctr-exec-result[hidden]{display:none}' +
    '.ctr-exec-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:var(--kore-font-12);margin-bottom:8px}' +
    '.ctr-exec-out-label{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:var(--kore-font-12);color:var(--kore-text-2);margin:6px 0 4px}' +
    '.ctr-exec-out{margin:0 0 6px;padding:8px 10px;border-radius:4px;background:var(--kore-bg-0);border:1px solid var(--kore-border-1);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:var(--kore-font-12);max-height:260px;overflow:auto}' +
    '@media (max-width:640px){.ctr-exec-opts{flex-direction:column;align-items:stretch}' +
    '.ctr-exec-opts .ctr-field{min-width:0}.ctr-exec-actions{flex-direction:column}' +
    '.ctr-exec-actions .btn{min-height:44px;width:100%}.ctr-exec-out-label .btn{min-height:44px}}';
  function fresh() {
    return { items: [], all: false, loadError: '', loadFail: null, shown: PAGE, destroyed: false, stats: {}, statsBusy: false,
      drawer: null, drawerEl: null, drawerId: '', drawerData: null, drawerError: '', drawerFail: null, since: '', sinceInput: null, confirm: null, notice: '',
      execFor: '', exec: { cmd: '', workdir: '', user: '', confirm: false, busy: false, result: null, error: '' } };
  }
  var S = fresh();
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn) { n.addEventListener('click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) { var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1)); }
    return '';
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null, timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token }, body: JSON.stringify(params || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + method, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('请求失败（HTTP ' + res.status + '）')));
        err.code = data.code || '';
        err.detail = data.detail || '';
        err.hint = data.hint || '';
        err.reason = reasonOfDetail(data.detail);
        throw err;
      });
    }, function (err) { if (timer !== null) clearTimeout(timer); if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）'); throw err; });
  }
  function ensureCss() {
    if (document.getElementById('kore-container-css')) return;
    var s = el('style'); s.id = 'kore-container-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    var u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i ? v.toFixed(1) : v) + ' ' + u[i];
  }
  // detail 是 HTTP 错误体里的原始 JSON 字符串（如 {"reason":"need_root"}）；
  // 按 reason 判别而不是猜 message，才分得清「内核不是 root 服务」和「缺 docker」。
  function reasonOfDetail(detail) {
    if (!detail) return '';
    if (typeof detail === 'object') return detail.reason ? String(detail.reason) : '';
    try { var d = JSON.parse(String(detail)); return d && d.reason ? String(d.reason) : ''; } catch (e) { return ''; }
  }
  // 文案映射唯一来源是主壳 KoreUI.failureOf（显式 map）；未收录的 code 回退到既有 hintFor。
  function errorView(err) {
    var f = window.KoreUI && window.KoreUI.failureOf ? window.KoreUI.failureOf(err) : { mapped: false };
    var msg = String((err && err.message) || err || '');
    if (f.mapped) return f;
    return { mapped: false, title: '', action: hintFor(msg), detail: msg.replace(/^E_[A-Z_]+[:：]\s*/, '') };
  }
  function hintFor(text) {
    var msg = String(text || '');
    if (/插件.*未安装|插件不存在|未 enable/.test(msg)) return '容器插件还没装：到左侧「软件商店」搜索 container 安装，装好后回本页点「刷新」。';
    if (/E_UNSUPPORTED|daemon 不可达|未找到 docker|无法执行 docker/.test(msg)) return 'Docker 未安装或未启动：Debian/Ubuntu 用 curl -fsSL https://get.docker.com | sh 安装，RHEL 用 sudo dnf install docker；装好后 systemctl enable --now docker，再刷新本页。';
    if (/E_UNAUTHORIZED|保护名单/.test(msg)) return '该容器在保护名单（KORE_PROTECTED_CONTAINERS）内，属于核心服务，不允许在此操作。';
    if (/E_NOTFOUND|容器不存在/.test(msg)) return '容器可能已被删除：点「刷新」重新拉取列表。';
    if (/E_UPSTREAM|超时/.test(msg)) return 'docker 命令执行失败或超时：确认 daemon 运行中、磁盘未满，稍后重试。';
    return '请确认 Docker 已启动且当前用户可访问 docker socket（或把用户加入 docker 组），然后重试。';
  }
  function noticeBox(text) { var n = el('div', 'db-notice', text); n.setAttribute('role', 'alert'); return n; }
  function stateChip(state) {
    var ok = state === 'running', warn = state === 'restarting' || state === 'paused';
    var label = ok ? '运行中' : state === 'exited' ? '已停止' : state === 'restarting' ? '重启中' : state === 'paused' ? '已暂停' : state === 'created' ? '已创建' : state || '未知';
    var chip = el('span', 'chip chip-' + (ok ? 'ok' : warn ? 'warn' : state === 'exited' ? 'na' : 'fail'));
    chip.appendChild(el('span', 'dot ' + (ok ? 'ok' : warn ? 'warn' : state === 'exited' ? '' : 'fail')));
    chip.appendChild(el('span', null, label)); return chip;
  }
  function memBar(percent) {
    var p = Math.max(0, Math.min(100, percent || 0));
    var bar = el('span', 'ctr-bar' + (p >= 90 ? ' ctr-bar-high' : p >= 70 ? ' ctr-bar-warn' : ''));
    bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(Math.round(p)));
    add(bar, el('span', 'ctr-bar-fill')).style.width = p.toFixed(1) + '%'; return bar;
  }
  function lockIcon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
    ['M6 9V7a4 4 0 0 1 8 0v2', 'M4.5 9h11v8.5h-11z', 'M10 12.5v2.5'].forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); svg.appendChild(p);
    }); return svg; }
  function smallBtn(label, fn) { var b = el('button', 'btn btn-ghost', label); b.type = 'button'; if (fn) on(b, fn); return b; }
  function paintList() {
    var host = S.listHost; host.textContent = '';
    if (S.countMeta) S.countMeta.textContent = ''; // 失败/空态先清掉上一次的计数，避免残留误导
    if (S.loadError) {
      var view = errorView(S.loadFail || { message: S.loadError });
      var fail = add(host, el('div', 'empty-state'));
      add(fail, el('p', 'empty-state-title', view.title || '容器列表读取失败'));
      add(fail, el('p', 'empty-state-text', view.detail || S.loadError));
      add(fail, el('p', 'empty-state-text', '怎么办：' + (view.action || hintFor(S.loadError))));
      add(fail, smallBtn('重新读取', load)); return;
    }
    if (!S.items.length) {
      var empty = add(host, el('div', 'empty-state'));
      add(empty, el('p', 'empty-state-title', S.all ? '没有任何容器' : '没有运行中的容器'));
      add(empty, el('p', 'empty-state-text', S.all ? '本机没有任何 Docker 容器。' : '当前没有运行中的容器；点上方「包含已停止的容器」可看全部。'));
      add(empty, el('p', 'empty-state-text', '还没有 Docker？Debian/Ubuntu：curl -fsSL https://get.docker.com | sh；RHEL：sudo dnf install docker。装好并 systemctl enable --now docker 后刷新本页。')); return;
    }
    S.countMeta.textContent = '已显示 ' + Math.min(S.shown, S.items.length) + ' / 共 ' + S.items.length + ' 个容器' + (S.all ? '（含已停止）' : '');
    var table = add(host, el('table', 'ctr-table')), htr = add(add(table, el('thead')), el('tr'));
    ['名称', '镜像', '状态', 'CPU', '内存', '运行时长', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var body = add(table, el('tbody'));
    S.items.slice(0, S.shown).forEach(function (c) {
      body.appendChild(rowOf(c));
      // 重绘会整表重建：已缓存的 stats 必须回填，否则「加载更多」后老行的 CPU/内存永远是 —
      if (S.stats[c.id] !== undefined) paintStatsCell(c.id);
    });
    paintMore(); fetchStats();
  }
  function rowOf(c) {
    var tr = el('tr'); tr.setAttribute('data-id', c.id);
    var nameTd = add(tr, el('td', 'ctr-name', c.name || c.id)); nameTd.setAttribute('data-label', '名称');
    if (c.protected) {
      var lock = add(nameTd, el('span', 'ctr-lock')); lock.title = '核心服务容器，不允许在此操作'; lock.setAttribute('aria-label', lock.title); lock.appendChild(lockIcon());
    }
    var imgTd = add(tr, el('td', null, c.image || '—')); imgTd.setAttribute('data-label', '镜像');
    var stTd = add(tr, el('td')); stTd.setAttribute('data-label', '状态'); stTd.appendChild(stateChip(c.state));
    var cpuTd = add(tr, el('td', null, '—')); cpuTd.setAttribute('data-label', 'CPU');
    var memTd = add(tr, el('td', null, '—')); memTd.setAttribute('data-label', '内存'); // CPU / 内存：stats 到达后回填
    var durTd = add(tr, el('td', null, c.status || '—')); durTd.setAttribute('data-label', '运行时长');
    var ops = add(tr, el('td', 'ctr-ops')); ops.setAttribute('data-label', '操作');
    if (c.protected) ops.title = '核心服务容器，不允许在此操作';
    // [标签, 动作, 禁用条件]：保护名单行全部禁用；非运行中禁停止/重启，运行中禁启动。
    [['日志', openLogs, false], ['详情', openDetail, false], ['启动', doStart, c.state === 'running'],
      ['停止', askStop, c.state !== 'running'], ['重启', askRestart, c.state !== 'running']].forEach(function (op) {
        var b = smallBtn(op[0], function () { op[1](c); }); if (c.protected || op[2]) b.disabled = true; ops.appendChild(b);
      });
    return tr;
  }
  function paintMore() {
    if (!S.moreHost) return;
    S.moreHost.textContent = '';
    if (!S.loadError && S.items.length && S.shown < S.items.length) add(S.moreHost, smallBtn('加载更多', loadMore));
  }
  function loadMore() { S.shown += PAGE; paintList(); }
  function toggleAll() { S.all = !S.all; load(); }
  // fetchStats：只为可见的运行中行补一次 stats（docker stats --no-stream 较慢，串行拉取）。
  function fetchStats() {
    if (S.statsBusy || S.destroyed) return;
    var ids = S.items.slice(0, S.shown).filter(function (c) { return c.state === 'running' && S.stats[c.id] === undefined; });
    if (!ids.length) return; S.statsBusy = true; var chain = Promise.resolve();
    ids.forEach(function (c) {
      chain = chain.then(function () {
        if (S.destroyed || S.stats[c.id] !== undefined) return;
        return invoke('container.stats', { id: c.id }).then(function (d) {
          if (S.destroyed) return;
          S.stats[c.id] = d; paintStatsCell(c.id);
        }, function () { if (!S.destroyed) { S.stats[c.id] = null; paintStatsCell(c.id); } });
      });
    });
    chain.then(function () {
      if (S.destroyed) return;
      S.statsBusy = false;
      fetchStats(); // 链跑完再补一次：期间 load() 换过列表的话，新行的 stats 还没人拉
    });
  }
  function paintStatsCell(id) {
    var tr = S.listHost.querySelector('tr[data-id="' + id + '"]'); if (!tr) return;
    var d = S.stats[id], cells = tr.querySelectorAll('td');
    if (!d) { cells[3].textContent = '—'; cells[4].textContent = '—'; return; }
    cells[3].textContent = (d.cpu_percent || 0).toFixed(1) + '%';
    cells[4].textContent = ''; add(cells[4], memBar(d.memory && d.memory.percent)); add(cells[4], el('div', 'muted', fmtBytes(d.memory && d.memory.usage)));
  }
  // drawer 是抽屉模式（'logs' | 'detail' | null），drawerEl 才是 <aside> 节点——两者分开存，
  // 否则 openDrawer 把模式字符串写进 S.drawer 后，setDrawer 对字符串设 .hidden 在严格模式下抛 TypeError。
  function setDrawer(open) {
    if (!S.mask || !S.drawerEl) return;
    S.mask.hidden = !open; S.drawerEl.hidden = !open; if (open && S.closeBtn) S.closeBtn.focus();
  }
  function closeDrawer() { S.drawer = null; S.drawerId = ''; S.drawerData = null; S.drawerError = ''; S.drawerFail = null; setDrawer(false); }
  function openDrawer(mode, c, loader) {
    S.drawer = mode; S.drawerId = c.id; S.drawerData = null; S.drawerError = ''; S.drawerFail = null; S.since = '';
    S.drawerTitle.textContent = (mode === 'logs' ? '日志 · ' : '详情 · ') + (c.name || c.id);
    setDrawer(true); paintDrawer(); loader();
  }
  function openLogs(c) { openDrawer('logs', c, fetchLogs); }
  function openDetail(c) {
    openDrawer('detail', c, function () {
      invoke('container.inspect', { id: c.id }).then(function (d) { if (!S.destroyed && S.drawerId === c.id && S.drawer === 'detail') { S.drawerData = d; paintDrawer(); } },
        function (err) { if (!S.destroyed && S.drawerId === c.id) { S.drawerError = err.message; S.drawerFail = err; paintDrawer(); } });
    });
  }
  function fetchLogs() {
    var id = S.drawerId, params = { id: id, tail: 200 };
    if (S.since) params.since = S.since;
    invoke('container.logs', params).then(function (d) { if (!S.destroyed && S.drawerId === id && S.drawer === 'logs') { S.drawerData = d; paintDrawer(); } },
      function (err) { if (!S.destroyed && S.drawerId === id) { S.drawerError = err.message; S.drawerFail = err; paintDrawer(); } });
  }
  function paintDrawer() {
    if (!S.drawerBody) return;
    var host = S.drawerBody; host.textContent = '';
    if (S.drawerError) {
      var dview = errorView(S.drawerFail || { message: S.drawerError });
      host.appendChild(noticeBox((dview.title ? dview.title + '：' : '读取失败：') + (dview.detail || S.drawerError)));
      host.appendChild(el('p', 'empty-state-text', '怎么办：' + (dview.action || hintFor(S.drawerError)))); return;
    }
    if (!S.drawerData) { add(host, el('p', 'muted', '正在读取…')); return; }
    if (S.drawer === 'logs') {
      var box = add(host, el('label', 'ctr-field')); add(box, el('span', null, '起始时间（可选，如 10m 或 2026-11-23T08:00:00）'));
      S.sinceInput = add(box, el('input')); S.sinceInput.value = S.since; S.sinceInput.placeholder = '留空 = 不限';
      add(host, smallBtn('重新拉取', function () { S.since = S.sinceInput.value.trim(); S.drawerData = null; S.drawerError = ''; paintDrawer(); fetchLogs(); }));
      var d = S.drawerData;
      if (!d.lines || !d.lines.length) add(host, el('p', 'muted', '该容器最近没有日志输出。'));
      else add(host, el('pre', 'ctr-log', d.lines.join('\n')));
      if (d.truncated) add(host, el('p', 'muted', '（输出超过 2 MiB 预算，已截断显示尾部）'));
      return;
    }
    var v = S.drawerData, res = v.resources || {}, dl = add(host, el('dl', 'ctr-detail'));
    [['镜像', v.image], ['状态', v.state && v.state.status], ['健康检查', v.health || '未配置'],
      ['重启策略', res.restart_policy || '—'], ['重启次数', v.state && String(v.state.restart_count)],
      ['启动时间', v.state && v.state.started_at], ['网络 IP', v.network && v.network.ip],
      ['资源限额', res.memory_limit ? fmtBytes(res.memory_limit) : '不限制']].forEach(function (row) {
        add(dl, el('dt', null, row[0])); var dd = add(dl, el('dd', null, row[1] || '—'));
        if (/IP|时间|策略|镜像/.test(row[0])) dd.classList.add('mono');
      });
    var ports = (v.network && v.network.ports) || [];
    add(dl, el('dt', null, '端口映射（' + ports.length + '）'));
    if (!ports.length) add(dl, el('dd', null, '未发布端口'));
    else ports.forEach(function (p) { add(dl, el('dd', 'mono', (p.host_ip || '0.0.0.0') + ':' + (p.host_port || '—') + ' → ' + p.container_port + '/' + p.protocol)); });
    var mounts = v.mounts || [];
    add(dl, el('dt', null, '挂载 / 卷（' + mounts.length + '）'));
    if (!mounts.length) add(dl, el('dd', null, '无挂载'));
    else mounts.forEach(function (m) { add(dl, el('dd', 'mono', (m.type === 'volume' ? '卷 ' : '绑定 ') + m.source + ' → ' + m.destination + (m.rw ? '（读写）' : '（只读）'))); });
    paintExecSection(host);
  }
  // ---------- 执行命令（container.exec：argv 数组、固定 argv 不经 shell） ----------
  function isRootUserValue(v) {
    var parts = String(v || '').trim().toLowerCase().split(':');
    for (var i = 0; i < parts.length; i++) if (parts[i] === 'root' || parts[i] === '0') return true;
    return false;
  }
  // 错误翻人话：拒绝清单命中（后端 E_INVALID + 「被拒绝：」）→ 安全策略拒绝且不建议重试；
  // root 未确认 → 引导勾确认框；E_UNSUPPORTED 在本方法语境是 docker CLI 缺失 → 走安装指引。
  function execErrorText(err) {
    var code = err && err.code ? err.code : '';
    var mapped = errorView(err);
    if (mapped.mapped) return mapped.title + '：' + mapped.action;
    var msg = String(err && err.message ? err.message : err || '').replace(/^E_[A-Z_]+[:：]\s*/, '');
    if (/被拒绝：/.test(msg)) return '该命令被安全策略拒绝：' + msg + '。这是策略拦截而非临时故障，请换一种方式完成，不需要重试。';
    if (code === 'E_INVALID' && /confirm|root/i.test(msg)) return '以 root 执行需要先勾选「我确认以 root 执行」：' + msg;
    if (code === 'E_INVALID') return '参数有误：' + msg;
    if (code === 'E_UNSUPPORTED') return '无法执行（' + msg + '）。' + hintFor(err && err.message ? err.message : '');
    return msg;
  }
  function copyExecText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
  }
  function paintExecSection(host) {
    if (S.execFor !== S.drawerId) { // 换容器即重置表单，避免上一个容器的输入残留
      S.execFor = S.drawerId;
      S.exec = { cmd: '', workdir: '', user: '', confirm: false, busy: false, result: null, error: '' };
    }
    var st = S.exec;
    var sec = add(host, el('section', 'ctr-exec'));
    add(sec, el('p', 'ctr-exec-warn', '在这里执行的命令会以容器内身份运行，可能修改容器内容。'));
    add(sec, el('p', 'ctr-exec-hint', '每个参数一行，不经过 shell：没有管道、&&、重定向；第一行是程序名，后续每行是它的参数。'));
    var cmd = add(sec, el('textarea', 'ctr-exec-cmd'));
    cmd.value = st.cmd; cmd.placeholder = 'ls\n-l\n/var/log';
    cmd.setAttribute('aria-label', '命令参数，每行一个');
    var opts = add(sec, el('div', 'ctr-exec-opts'));
    var wdF = add(opts, el('label', 'ctr-field')); add(wdF, el('span', null, '工作目录（可选）'));
    var wd = add(wdF, el('input')); wd.value = st.workdir; wd.placeholder = '留空 = 容器默认目录';
    var uF = add(opts, el('label', 'ctr-field')); add(uF, el('span', null, '容器内身份'));
    var uSel = add(uF, el('select'));
    [['', '默认（容器内非 root）'], ['root', 'root（需确认）'], ['__custom', '自定义…']].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; uSel.appendChild(op);
    });
    uSel.value = st.user === 'root' ? 'root' : (st.user ? '__custom' : '');
    var uInput = add(uF, el('input')); uInput.placeholder = '如 nginx 或 1000:1000';
    uInput.hidden = uSel.value !== '__custom'; uInput.value = uSel.value === '__custom' ? st.user : '';
    function currentUser() { return uSel.value === '__custom' ? uInput.value.trim() : uSel.value; }
    var chk = add(sec, el('label', 'ctr-exec-check'));
    var chkIn = add(chk, el('input')); chkIn.type = 'checkbox'; chkIn.checked = st.confirm;
    add(chk, el('span', null, '我确认以 root 执行'));
    var acts = add(sec, el('div', 'ctr-exec-actions'));
    var run = add(acts, el('button', 'btn btn-primary', '执行命令')); run.type = 'button';
    var msg = add(sec, el('div', 'kore-modal-msg')); msg.setAttribute('role', 'alert');
    var out = add(sec, el('div', 'ctr-exec-result')); out.hidden = true;
    function syncExec() {
      var root = isRootUserValue(currentUser());
      chk.hidden = !root;
      if (!root && chkIn.checked) { chkIn.checked = false; st.confirm = false; }
      run.disabled = st.busy || cmd.value.trim() === '' || (root && !chkIn.checked);
      run.textContent = st.busy ? '执行中…' : '执行命令';
    }
    cmd.addEventListener('input', function () { st.cmd = cmd.value; syncExec(); });
    wd.addEventListener('input', function () { st.workdir = wd.value; });
    uSel.addEventListener('change', function () { uInput.hidden = uSel.value !== '__custom'; st.user = currentUser(); syncExec(); });
    uInput.addEventListener('input', function () { st.user = currentUser(); syncExec(); });
    chkIn.addEventListener('change', function () { st.confirm = chkIn.checked; syncExec(); });
    function renderResult() {
      out.textContent = '';
      if (st.error) { add(out, noticeBox(st.error)); out.hidden = false; return; } // 策略拒绝不提供「重试」按钮
      var r = st.result;
      if (!r) { out.hidden = true; return; }
      var meta = add(out, el('div', 'ctr-exec-meta'));
      meta.appendChild(el('span', 'chip chip-' + (r.exit_code === 0 ? 'ok' : 'fail'), '退出码 ' + r.exit_code));
      if (r.timed_out) meta.appendChild(el('span', 'chip chip-warn', '超时已终止（后端上限 30 秒）'));
      if (typeof r.duration_ms === 'number') meta.appendChild(el('span', 'muted', (r.duration_ms / 1000).toFixed(1) + ' 秒'));
      if (r.stdout_truncated || r.stderr_truncated) {
        meta.appendChild(el('span', 'chip chip-warn', '输出已截断'));
        add(out, el('p', 'ctr-exec-hint', '输出过大已截断，建议缩小范围（加 head/tail 或减少输出行数）后再看。'));
      }
      [['标准输出 stdout', r.stdout], ['标准错误 stderr', r.stderr]].forEach(function (pair) {
        var head = add(out, el('div', 'ctr-exec-out-label')); add(head, el('span', null, pair[0]));
        add(head, smallBtn('复制', function () { copyExecText(pair[1] || ''); }));
        add(out, el('pre', 'ctr-exec-out', pair[1] || '（空）'));
      });
      out.hidden = false;
    }
    on(run, function () {
      var argv = cmd.value.split('\n').map(function (t) { return t.replace(/\r$/, '').trim(); })
        .filter(function (t) { return t !== ''; });
      if (!argv.length) return;
      var params = { id: S.drawerId, cmd: argv };
      if (st.workdir.trim()) params.workdir = st.workdir.trim();
      var user = currentUser();
      if (user) params.user = user;
      if (isRootUserValue(user)) params.confirm = true; // 对应后端 root 需 confirm:true
      st.busy = true; st.result = null; st.error = ''; msg.textContent = '';
      syncExec();
      invoke('container.exec', params).then(function (d) {
        st.busy = false; st.result = d; st.error = ''; renderResult();
      }, function (err) {
        st.busy = false; st.result = null; st.error = execErrorText(err); renderResult();
      }).then(function () { syncExec(); });
    });
    renderResult();
    syncExec();
  }
  function askConfirm(action, c) {
    S.confirm = { action: action, id: c.id, name: c.name || c.id };
    S.confirmTitle.textContent = action === 'stop' ? '停止容器' : '重启容器';
    S.confirmName.textContent = '容器名：' + S.confirm.name;
    S.confirmInput.value = ''; S.confirmMsg.textContent = ''; S.confirmOk.disabled = true;
    S.confirmMask.hidden = false; S.confirmInput.focus();
  }
  function askStop(c) { askConfirm('stop', c); }
  function askRestart(c) { askConfirm('restart', c); }
  function doStart(c) { act('start', c, false); }
  function closeConfirm() { S.confirmMask.hidden = true; S.confirm = null; }
  function act(action, c, confirm) {
    var params = { id: c.id };
    if (confirm) params.confirm = true;
    invoke('container.' + action, params).then(function () {
      if (S.destroyed) return;
      if (S.confirm) closeConfirm();
      if (S.drawerId === c.id) closeDrawer();
      S.notice = '已' + (action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启') + '「' + (c.name || c.id) + '」';
      delete S.stats[c.id]; paintNotice(); load();
    }, function (err) {
      if (S.destroyed) return;
      var av = errorView(err);
      if (S.confirm) { S.confirmMsg.textContent = av.mapped ? av.title + '：' + av.action : err.message; S.confirmMsg.setAttribute('role', 'alert'); return; }
      S.notice = av.mapped ? av.title + '：' + av.action : err.message; paintNotice();
    });
  }
  function paintNotice() {
    if (!S.noticeHost) return;
    S.noticeHost.textContent = ''; if (S.notice) S.noticeHost.appendChild(noticeBox(S.notice));
  }
  function load() {
    S.loadError = ''; S.loadFail = null; S.shown = PAGE; S.stats = {}; paintList();
    invoke('container.list', { all: S.all }).then(function (d) {
      if (S.destroyed) return;
      S.items = d.containers || []; paintList();
    }, function (err) { if (S.destroyed) return; S.loadError = err.message; S.loadFail = err; S.items = []; paintList(); });
  }
  function build(root) {
    var head = add(root, el('header', 'view-head')); add(head, el('h2', 'view-title', '容器')); add(head, el('p', 'view-sub', '本机 Docker 容器：列表、日志、统计与启停；核心服务容器带锁标不可操作。'));
    S.noticeHost = add(root, el('div', 'ctr-notice-host'));
    var panel = add(root, el('section', 'panel')), ph = add(panel, el('div', 'panel-head'));
    add(ph, el('span', 'panel-title', '容器列表')); add(ph, el('span', 'panel-meta', '点行看日志与详情'));
    var metaBtns = add(ph, el('span', 'panel-meta actions'));
    add(metaBtns, smallBtn(S.all ? '只看运行中' : '包含已停止的容器', toggleAll)); add(metaBtns, smallBtn('刷新', load));
    S.countMeta = add(ph, el('span', 'panel-meta', ''));
    S.listHost = add(panel, el('div', 'ctr-list-host')); S.moreHost = add(panel, el('div', 'ctr-more'));
    S.mask = add(root, el('div', 'ctr-mask')); S.mask.hidden = true; on(S.mask, closeDrawer);
    S.drawerEl = add(root, el('aside', 'ctr-drawer')); S.drawerEl.hidden = true;
    S.drawerEl.setAttribute('role', 'dialog'); S.drawerEl.setAttribute('aria-modal', 'true'); S.drawerEl.setAttribute('aria-label', '容器详情');
    var dh = add(S.drawerEl, el('div', 'ctr-drawer-head')); S.drawerTitle = add(dh, el('h3', 'ctr-drawer-title', ''));
    S.closeBtn = add(dh, el('button', 'btn btn-ghost', '关闭')); S.closeBtn.type = 'button'; S.closeBtn.setAttribute('aria-label', '关闭'); on(S.closeBtn, closeDrawer);
    S.drawerBody = add(S.drawerEl, el('div', 'ctr-drawer-body'));
    // 停止/重启确认弹层：手输容器名解锁（db.js 删库确认模式）。
    S.confirmMask = add(root, el('div', 'kore-modal ctr-confirm')); S.confirmMask.hidden = true;
    S.confirmMask.setAttribute('role', 'dialog'); S.confirmMask.setAttribute('aria-modal', 'true');
    var form = add(S.confirmMask, el('form', 'kore-modal-box')); S.confirmTitle = add(form, el('div', 'ctr-confirm-title', ''));
    S.confirmName = add(form, el('p', 'kore-modal-text', '容器名将在下方显示；请手动输入完整容器名确认：'));
    var f = add(form, el('label', 'ctr-field'));
    add(f, el('span', null, '容器名（与上面完全一致才解锁确认按钮，防误操作）'));
    S.confirmInput = add(f, el('input')); S.confirmInput.autocomplete = 'off'; S.confirmInput.placeholder = '输入上面的容器名';
    S.confirmInput.addEventListener('input', function () { S.confirmOk.disabled = S.confirmInput.value !== S.confirm.name; });
    S.confirmMsg = add(form, el('div', 'kore-modal-msg'));
    var acts = add(form, el('div', 'kore-modal-actions'));
    var cancel = add(acts, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button'; on(cancel, closeConfirm);
    S.confirmOk = add(acts, el('button', 'btn', '确认执行')); S.confirmOk.type = 'submit'; S.confirmOk.disabled = true;
    form.addEventListener('submit', function (ev) { ev.preventDefault(); if (S.confirmOk.disabled) return; act(S.confirm.action, { id: S.confirm.id, name: S.confirm.name }, true); });
    S.onKey = function (ev) { if (ev.key !== 'Escape') return; if (S.confirm && !S.confirmMask.hidden) closeConfirm(); else if (S.drawerId) closeDrawer(); };
    document.addEventListener('keydown', S.onKey);
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    ensureCss();
    var root = add(container, el('section', 'ctr'));
    build(root); load();
    return { destroy: function () { S.destroyed = true; document.removeEventListener('keydown', S.onKey); if (S.drawerEl) S.drawerEl.hidden = true; if (S.mask) S.mask.hidden = true; if (S.confirmMask) S.confirmMask.hidden = true;
    } };
  }
  window.KoreContainer = { render: render };
})();
