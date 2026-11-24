/* kore 主壳 · 容器管理（web/container.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/container/container.<action>；方法段写完整限定名。
   数据：container.list（含 protected 标记）/ logs（tail 200 + since）/ stats / inspect（关键字段，
   含重启策略/健康）/ start / stop / restart（stop/restart 需 confirm=true）。分页 20 行 + 加载更多；
   行操作开日志/详情抽屉（日志等宽字体）；停止/重启手输容器名确认；保护名单行锁标 + 禁用操作。
   镜像管理页签：container.images（列表三态）/ pull（手输镜像名 confirm）/ rmi（手输镜像名 +
   可选 force）/ update（容器行资源限额：memory_bytes 或 cpus + 手输容器名 confirm）——
   四方法入参出参以 ../kore-plugin-container/internal/containerop/types.go 为唯一真源。 */
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
    '.ctr-exec-actions .btn{min-height:44px;width:100%}.ctr-exec-out-label .btn{min-height:44px}}' +
    // 镜像管理：页签 / 拉取输入 / 镜像行 / 通用确认弹层字段（手机端复用 ctr-table 卡片化，触摸≥44px）
    '.ctr-tabs{display:flex;gap:4px;border-bottom:1px solid var(--kore-border-2);margin-bottom:12px}' +
    '.ctr-tab{min-height:44px;padding:0 16px;background:none;border:0;border-bottom:2px solid transparent;color:var(--kore-text-2);font-size:var(--kore-font-13);cursor:pointer}' +
    '.ctr-tab[aria-selected="true"]{color:var(--kore-text-1);border-bottom-color:var(--kore-text-1)}' +
    '.ctr-pull{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}' +
    '.ctr-pull .ctr-field{flex:1;min-width:220px;margin:0}' +
    '.ctr-pull .btn{min-height:44px}' +
    '.ctr-pull-result{margin:8px 0;padding:8px 10px;border-radius:4px;font-size:var(--kore-font-13);line-height:1.6}' +
    '.ctr-pull-result[hidden]{display:none}.ctr-pull-result.is-ok{color:var(--kore-success)}.ctr-pull-result.is-fail{color:var(--kore-danger)}' +
    '.img-ref{font-family:ui-monospace,Menlo,Consolas,monospace}.img-dangling{color:var(--kore-warning);font-size:var(--kore-font-12)}' +
    '.ctr-dlg-extra{margin:10px 0}.ctr-dlg-extra[hidden]{display:none}.ctr-dlg-extra .ctr-field{margin:8px 0}' +
    '.ctr-dlg-check{display:flex;align-items:center;gap:8px;min-height:44px;font-size:var(--kore-font-13);margin:8px 0}' +
    '@media (max-width:639px){.ctr-tabs{overflow-x:auto}.ctr-tab{flex:1 1 0;min-width:96px}' +
    '.ctr-pull{flex-direction:column;align-items:stretch}.ctr-pull .ctr-field{min-width:0;width:100%}.ctr-pull .btn{width:100%}}';
  function fresh() {
    return { items: [], all: false, loadError: '', loadFail: null, shown: PAGE, destroyed: false, stats: {}, statsBusy: false,
      drawer: null, drawerEl: null, drawerId: '', drawerData: null, drawerError: '', drawerFail: null, since: '', sinceInput: null, confirm: null, notice: '',
      execFor: '', exec: { cmd: '', workdir: '', user: '', confirm: false, busy: false, result: null, error: '' },
      tab: 'containers', busyPull: false, pullResult: '', pullRef: '',
      images: [], imagesLoaded: false, imagesError: '', imagesFail: null,
      imgConfirmRule: '', imgConfirmRef: '', imgForce: false, updateFor: '' };
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
    if (/镜像引用|E_INVALID/.test(msg)) return '镜像名格式不对：须以字母或数字开头，只能用字母数字与 . _ / : @ -，不能带空格、引号或 $()；例如 nginx:latest、registry.example.com/app:v1。';
    return '请确认 Docker 已启动且当前用户可访问 docker socket（或把用户加入 docker 组），然后重试。';
  }
  // 镜像页四类操作的「怎么办」：按错误码 + 关键词给可执行的下一步，不显示裸英文码了事。
  function imageHint(rule, err) {
    var msg = String((err && err.message) || err || '');
    var code = (err && err.code) || '';
    if (/E_INVALID/.test(code)) {
      if (rule === 'update') return '内存要在 6 MiB～1 TiB、CPU 要在 0.01～1024 核之间；至少填一项，改完再确认。';
      if (rule === 'pull') return '检查镜像名：如 nginx:latest、redis:7；仓库地址要写全（如 registry.example.com/app:v1），不要带空格或协议头 http://。';
      return '镜像名不对：用列表里显示的「仓库:标签」或镜像 ID，别手输十六进制短名；需要强删时勾「强制删除」。';
    }
    if (/E_NOTFOUND/.test(code)) return '镜像可能已被删掉或改名：回到镜像列表点「刷新」，从列表里复制完整引用再试。';
    if (/E_UPSTREAM|超时|pull/.test(msg) && rule === 'pull') return '检查网络连接与镜像仓库地址：私有仓库要先 docker login；确认磁盘空间充足，然后重试。';
    if (/E_UPSTREAM|被占用|in use|超时/.test(msg) && rule === 'rmi') return '镜像正被容器占用：先到「容器」页停掉并删除相关容器，或勾「强制删除」再确认。';
    if (/E_UNAUTHORIZED|保护名单/.test(msg)) return '该容器在保护名单内，不允许修改资源限额；联系管理员从 KORE_PROTECTED_CONTAINERS 移除后再试。';
    return hintFor(msg);
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
    if (S.tab === 'images') return paintImages();
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
      ['停止', askStop, c.state !== 'running'], ['重启', askRestart, c.state !== 'running'],
      ['限额', function () { askImgConfirm('update', c.id, c); }, false]].forEach(function (op) {
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

  // ---------- 镜像管理页（container.images / pull / rmi / update） ----------
  // 三态：未加载显示「正在读取…」；失败显示人话 + 怎么办 + 重试；成功空列表给下一步按钮。
  function paintImages() {
    var host = S.listHost; host.textContent = '';
    if (S.countMeta) S.countMeta.textContent = '';
    if (S.imagesError) {
      var view = errorView(S.imagesFail || { message: S.imagesError });
      var fail = add(host, el('div', 'empty-state'));
      add(fail, el('p', 'empty-state-title', view.title || '镜像列表读取失败'));
      add(fail, el('p', 'empty-state-text', view.detail || S.imagesError));
      add(fail, el('p', 'empty-state-text', '怎么办：' + (view.action || hintFor(S.imagesError))));
      add(fail, smallBtn('重新读取', loadImages)); return;
    }
    if (!S.imagesLoaded) { add(host, el('p', 'muted', '正在读取镜像…')); return; }
    if (!S.images.length) {
      var empty = add(host, el('div', 'empty-state'));
      add(empty, el('p', 'empty-state-title', '本机还没有镜像'));
      add(empty, el('p', 'empty-state-text', '在上方输入镜像名（如 nginx:latest）点「拉取镜像」，拉取成功后就会出现在这里。'));
      add(empty, smallBtn('刷新镜像列表', loadImages)); return;
    }
    S.countMeta.textContent = '共 ' + S.images.length + ' 个镜像';
    var table = add(host, el('table', 'ctr-table')), htr = add(add(table, el('thead')), el('tr'));
    ['仓库', '标签', '大小', '创建时间', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var body = add(table, el('tbody'));
    S.images.forEach(function (img) { body.appendChild(imageRowOf(img)); });
  }
  function imageRowOf(img) {
    var tr = el('tr'), ref = imageRefOf(img);
    var repo = add(tr, el('td', 'img-ref', img.dangling ? '<none>' : (img.repository || '—'))); repo.setAttribute('data-label', '仓库');
    var tag = add(tr, el('td', null, img.dangling ? '<none>' : (img.tag || '—'))); tag.setAttribute('data-label', '标签');
    var size = add(tr, el('td', null, img.size || '—')); size.setAttribute('data-label', '大小');
    var created = add(tr, el('td', null, img.created || '—')); created.setAttribute('data-label', '创建时间');
    var ops = add(tr, el('td', 'ctr-ops')); ops.setAttribute('data-label', '操作');
    var del = smallBtn('删除', function () { askImgConfirm('rmi', ref, null); });
    del.title = '删除镜像（需手输镜像名确认，不可撤销）'; del.style.color = 'var(--kore-danger)';
    ops.appendChild(del);
    if (img.dangling) add(ops, el('span', 'img-dangling', '悬空镜像'));
    return tr;
  }
  // 镜像引用优先「仓库:标签」；悬空镜像没有 tag，只能按 id 删除（后端 ref 支持镜像 ID）。
  function imageRefOf(img) {
    if (img.dangling || !img.repository) return img.id || '';
    return img.repository + (img.tag ? ':' + img.tag : '');
  }
  function loadImages() {
    S.imagesError = ''; S.imagesFail = null; S.imagesLoaded = false; S.images = []; paintImages();
    invoke('container.images', {}).then(function (d) {
      if (S.destroyed) return;
      S.images = d.images || []; S.imagesLoaded = true; paintImages();
    }, function (err) { if (S.destroyed) return; S.imagesError = err.message; S.imagesFail = err; S.imagesLoaded = true; paintImages(); });
  }
  function paintPull() {
    if (!S.pullHost) return;
    var host = S.pullHost; host.textContent = '';
    var form = add(host, el('form', 'ctr-pull'));
    var label = add(form, el('label', 'ctr-field'));
    add(label, el('span', null, '镜像名（如 nginx:latest、redis:7；私有仓库写全地址）'));
    var input = add(label, el('input')); input.value = S.pullRef; input.placeholder = 'nginx:latest';
    input.setAttribute('aria-label', '要拉取的镜像名'); input.autocomplete = 'off';
    var btn = add(form, el('button', 'btn btn-primary', S.busyPull ? '正在拉取…' : '拉取镜像'));
    btn.type = 'submit'; btn.disabled = S.busyPull || input.value.trim() === '';
    input.addEventListener('input', function () { S.pullRef = input.value; btn.disabled = S.busyPull || input.value.trim() === ''; });
    var result = add(host, el('div', 'ctr-pull-result')); result.hidden = !S.pullResult; result.setAttribute('role', 'status');
    if (S.pullResult) result.textContent = S.pullResult;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var ref = input.value.trim(); if (!ref || S.busyPull) return;
      askImgConfirm('pull', ref, null);
    });
  }
  function doPull(ref) {
    S.busyPull = true; S.pullResult = ''; paintPull();
    invoke('container.pull', { ref: ref, confirm: true }).then(function (d) {
      if (S.destroyed) return;
      S.busyPull = false; S.pullRef = '';
      S.pullResult = '已拉取「' + (d.ref || ref) + '」' + (d.truncated ? '（输出已截断，仅显示摘要）' : '') +
        (d.message ? '：' + d.message : '');
      paintPull(); loadImages();
    }, function (err) {
      if (S.destroyed) return;
      var av = errorView(err), hint = imageHint('pull', err);
      S.busyPull = false;
      S.pullResult = '拉取失败：' + (av.detail || err.message) + '。怎么办：' + (av.mapped ? av.action : hint);
      paintPull();
    });
  }
  function doRmi(ref, force) {
    invoke('container.rmi', { ref: ref, confirm: true, force: !!force }).then(function () {
      if (S.destroyed) return;
      S.notice = '已删除镜像「' + ref + '」'; closeConfirm(); paintNotice(); loadImages();
    }, function (err) {
      if (S.destroyed) return;
      var av = errorView(err);
      if (S.confirm) { S.confirmMsg.textContent = (av.mapped ? av.title + '：' + av.action : err.message) + '。怎么办：' + imageHint('rmi', err); S.confirmMsg.setAttribute('role', 'alert'); return; }
      S.notice = err.message; paintNotice();
    });
  }
  function doUpdate(id, memoryBytes, cpus, name) {
    var params = { id: id, confirm: true };
    if (memoryBytes !== null) params.memory_bytes = memoryBytes;
    if (cpus !== null) params.cpus = cpus;
    invoke('container.update', params).then(function () {
      if (S.destroyed) return;
      S.notice = '已更新「' + name + '」的资源限额'; closeConfirm(); paintNotice();
      if (S.drawerId === id) closeDrawer();
    }, function (err) {
      if (S.destroyed) return;
      var av = errorView(err);
      if (S.confirm) { S.confirmMsg.textContent = (av.mapped ? av.title + '：' + av.action : err.message) + '。怎么办：' + imageHint('update', err); S.confirmMsg.setAttribute('role', 'alert'); return; }
      S.notice = err.message; paintNotice();
    });
  }
  // 通用二次确认层：pull/rmi 手输镜像名解锁，update 手输容器名解锁；force 复选框仅 rmi 显示。
  // 复用既有 S.confirm 状态与确认 DOM（askConfirm 同款），不新建第二套弹层。
  function askImgConfirm(rule, ref, c) {
    S.confirm = { action: rule, ref: ref, name: c ? (c.name || c.id) : ref, updateFor: c ? c.id : '' };
    S.imgConfirmRule = rule; S.imgForce = false;
    if (rule === 'update') {
      S.confirmTitle.textContent = '修改容器资源限额';
      S.confirmName.textContent = '容器：' + S.confirm.name + '；请手动输入容器名确认：';
      S.confirmLabel.textContent = '容器名（与上面完全一致才解锁确认按钮，防误操作）';
      S.confirmInput.placeholder = '输入上面的容器名';
    } else {
      S.confirmTitle.textContent = rule === 'rmi' ? '删除镜像（不可撤销）' : '拉取镜像（会联网）';
      S.confirmName.textContent = '镜像：' + ref + '；请手动输入完整镜像名确认：';
      S.confirmLabel.textContent = '镜像名（与上面完全一致才解锁确认按钮，防误操作）';
      S.confirmInput.placeholder = '输入上面的镜像名';
    }
    S.confirmInput.value = ''; S.confirmMsg.textContent = ''; S.confirmOk.disabled = true;
    paintConfirmExtra(rule);
    S.confirmMask.hidden = false; S.confirmInput.focus();
  }
  // 确认弹层里的额外表单：update 的内存/CPU 两个可选输入；rmi 的 force 勾选。
  function paintConfirmExtra(rule) {
    if (!S.confirmExtra) return;
    S.confirmExtra.textContent = '';
    S.confirmExtra.hidden = rule === 'pull';
    if (rule === 'rmi') {
      var chk = add(S.confirmExtra, el('label', 'ctr-dlg-check'));
      var box = add(chk, el('input')); box.type = 'checkbox'; box.checked = S.imgForce;
      box.addEventListener('change', function () { S.imgForce = box.checked; });
      add(chk, el('span', null, '强制删除（镜像被容器占用时才需要，可能导致容器无法启动）'));
    } else if (rule === 'update') {
      var mf = add(S.confirmExtra, el('label', 'ctr-field'));
      add(mf, el('span', null, '内存上限（MiB，留空=不改；范围 6 MiB～1 TiB）'));
      S.updateMem = add(mf, el('input')); S.updateMem.type = 'number'; S.updateMem.min = '6'; S.updateMem.placeholder = '如 512';
      var cf = add(S.confirmExtra, el('label', 'ctr-field'));
      add(cf, el('span', null, 'CPU 核数（留空=不改；范围 0.01～1024）'));
      S.updateCpu = add(cf, el('input')); S.updateCpu.type = 'number'; S.updateCpu.min = '0.01'; S.updateCpu.step = '0.01'; S.updateCpu.placeholder = '如 1.5';
      add(S.confirmExtra, el('p', 'ctr-exec-hint', '至少填一项；只改填了的那一项，另一项保持原样。'));
    }
  }
  function submitImgConfirm() {
    var c = S.confirm; if (!c) return;
    if (c.action === 'pull') { closeConfirm(); doPull(c.ref); return; }
    if (c.action === 'rmi') { doRmi(c.ref, S.imgForce); return; }
    if (c.action === 'update') {
      var memRaw = S.updateMem ? S.updateMem.value.trim() : '', cpuRaw = S.updateCpu ? S.updateCpu.value.trim() : '';
      var mem = memRaw === '' ? null : Math.round(Number(memRaw) * 1048576);
      var cpu = cpuRaw === '' ? null : Number(cpuRaw);
      if (mem === null && cpu === null) { S.confirmMsg.textContent = '请至少填写内存或 CPU 中的一项。'; S.confirmMsg.setAttribute('role', 'alert'); return; }
      if ((mem !== null && !isFinite(mem)) || (cpu !== null && !isFinite(cpu))) { S.confirmMsg.textContent = '请输入有效的数字。'; S.confirmMsg.setAttribute('role', 'alert'); return; }
      doUpdate(c.updateFor, mem, cpu, c.name);
    }
  }
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
    S.imgConfirmRule = ''; // 与镜像确认层共用 DOM：先清规则，submit 才不会误走镜像分支
    S.confirm = { action: action, id: c.id, name: c.name || c.id };
    S.confirmTitle.textContent = action === 'stop' ? '停止容器' : '重启容器';
    S.confirmName.textContent = '容器名：' + S.confirm.name;
    S.confirmLabel.textContent = '容器名（与上面完全一致才解锁确认按钮，防误操作）';
    S.confirmInput.value = ''; S.confirmMsg.textContent = ''; S.confirmOk.disabled = true;
    if (S.confirmExtra) { S.confirmExtra.textContent = ''; S.confirmExtra.hidden = true; }
    S.confirmMask.hidden = false; S.confirmInput.focus();
  }
  function askStop(c) { askConfirm('stop', c); }
  function askRestart(c) { askConfirm('restart', c); }
  function doStart(c) { act('start', c, false); }
  function closeConfirm() { S.confirmMask.hidden = true; S.confirm = null; S.imgConfirmRule = ''; }
  // 页签切换：只切当前页，抽屉/确认层留在 root 上不动；首次切到镜像页才真正拉取列表。
  function switchTab(tab) {
    if (S.tab === tab) return;
    S.tab = tab;
    if (S.tabs) {
      var all = S.tabs.querySelectorAll('.ctr-tab');
      for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-selected', all[i].dataset.tab === tab ? 'true' : 'false');
    }
    if (S.pullHost) S.pullHost.hidden = tab !== 'images';
    if (S.moreHost) S.moreHost.hidden = tab === 'images';
    if (S.toggleAllBtn) S.toggleAllBtn.hidden = tab === 'images';
    if (S.refreshBtn) S.refreshBtn.textContent = '刷新';
    if (S.panelTitle) S.panelTitle.textContent = tab === 'images' ? '镜像列表' : '容器列表';
    if (S.panelMeta) S.panelMeta.textContent = tab === 'images' ? '拉取 / 删除本机镜像' : '点行看日志与详情';
    if (tab === 'images') { paintPull(); if (!S.imagesLoaded && !S.imagesError) loadImages(); else paintImages(); }
    else { paintPull(); load(); }
  }
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
    var head = add(root, el('header', 'view-head')); add(head, el('h2', 'view-title', '容器')); add(head, el('p', 'view-sub', '本机 Docker 容器：列表、日志、统计、启停与资源限额；切到「镜像」页可拉取/删除镜像。核心服务容器带锁标不可操作。'));
    S.noticeHost = add(root, el('div', 'ctr-notice-host'));
    // 两个页签：容器 / 镜像。切换只重绘当前页，不销毁抽屉/确认层（它们挂在 root 上）。
    S.tabs = add(root, el('div', 'ctr-tabs')); S.tabs.setAttribute('role', 'tablist');
    [['containers', '容器'], ['images', '镜像']].forEach(function (t) {
      var b = add(S.tabs, el('button', 'ctr-tab', t[1])); b.type = 'button'; b.dataset.tab = t[0];
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', S.tab === t[0] ? 'true' : 'false');
      on(b, function () { switchTab(t[0]); });
    });
    var panel = add(root, el('section', 'panel'));
    // 拉取入口只在镜像页出现（容器页不常驻技术输入框，符合易用性四原则③）
    S.pullHost = add(panel, el('div', 'ctr-pull-host')); S.pullHost.hidden = S.tab !== 'images';
    var ph = add(panel, el('div', 'panel-head'));
    S.panelTitle = add(ph, el('span', 'panel-title', S.tab === 'images' ? '镜像列表' : '容器列表'));
    S.panelMeta = add(ph, el('span', 'panel-meta', S.tab === 'images' ? '拉取 / 删除本机镜像' : '点行看日志与详情'));
    var metaBtns = add(ph, el('span', 'panel-meta actions'));
    S.toggleAllBtn = add(metaBtns, smallBtn(S.all ? '只看运行中' : '包含已停止的容器', toggleAll));
    S.refreshBtn = add(metaBtns, smallBtn('刷新', function () { S.tab === 'images' ? loadImages() : load(); }));
    S.toggleAllBtn.hidden = S.tab === 'images';
    S.countMeta = add(ph, el('span', 'panel-meta', ''));
    S.listHost = add(panel, el('div', 'ctr-list-host')); S.moreHost = add(panel, el('div', 'ctr-more'));
    S.moreHost.hidden = S.tab === 'images';
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
    S.confirmLabel = add(f, el('span', null, '容器名（与上面完全一致才解锁确认按钮，防误操作）'));
    S.confirmInput = add(f, el('input')); S.confirmInput.autocomplete = 'off'; S.confirmInput.placeholder = '输入上面的容器名';
    S.confirmInput.addEventListener('input', function () { S.confirmOk.disabled = S.confirmInput.value !== S.confirm.name; });
    S.confirmExtra = add(form, el('div', 'ctr-dlg-extra')); S.confirmExtra.hidden = true;
    S.confirmMsg = add(form, el('div', 'kore-modal-msg'));
    var acts = add(form, el('div', 'kore-modal-actions'));
    var cancel = add(acts, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button'; on(cancel, closeConfirm);
    S.confirmOk = add(acts, el('button', 'btn', '确认执行')); S.confirmOk.type = 'submit'; S.confirmOk.disabled = true;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault(); if (S.confirmOk.disabled) return;
      if (S.confirm && S.imgConfirmRule) submitImgConfirm();
      else act(S.confirm.action, { id: S.confirm.id, name: S.confirm.name }, true);
    });
    paintPull(); // 容器页隐藏也先生成结构，切到镜像页直接可用
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
