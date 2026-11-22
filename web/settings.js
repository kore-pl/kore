/* kore 设置视图 —— 零框架、零 CDN、零外部资源；对外只暴露 window.KoreSettings.render(container)。
   数据只来自已存在端点（会话、系统信息、退出）；没端点的能力一律标「待支持」，不伪造；
   写请求统一带 X-Kore-CSRF 双提交头。界面不展示接口路径与文档章节，只给用户能读懂的一句话。
   本文件不自行挂载、不改 index.html：壳在「设置」被激活时调 render(container)。 */
(function () {
  'use strict';

  var EP = {
    info: '/api/v1/system/info',
    session: '/api/v1/auth/session',
    logout: '/api/v1/auth/logout'
  };
  var TIMEOUT = 5000;
  // 资源预算（MiB）：展示常量，来源 AGENTS.md G-03 与 docs/DECISIONS/0016；改预算必须同步本表。
  var BUDGET = [
    ['主壳空载 VmRSS', '≤ 16 MiB', '8 MiB'],
    ['单常驻插件', '≤ 24 MiB', '12 MiB'],
    ['常驻合计', '≤ 48 MiB', '24 MiB'],
    ['同时常驻插件数', '≤ 3 个', '1–2 个']
  ];
  // 关于页常量：来源 docs/ROADMAP.md §5、docs/SCENARIOS.md §2、pkg/pluginapi.Protocol、LICENSE。
  var ABOUT = {
    protocol: 'kore.plugin.v1', license: 'MIT',
    repo: 'https://github.com/pengtang1024/kore',
    plugins: '21 个插件仓库（20 产品 + echo 验证件）', presets: '8 个场景预设'
  };
  // 视图缓存：先按缓存出骨架再拉真值重绘；单块读取失败只降级该块。
  var cache = { session: null, info: null, error: '' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  // 读非 HttpOnly 的 kore_csrf（双提交要求前端可读；会话 cookie 仍 HttpOnly）。
  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function request(url, init, timeoutMs) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var opts = {
      method: (init && init.method) || 'GET', credentials: 'same-origin',
      headers: (init && init.headers) || {}, cache: 'no-store'
    };
    if (ctrl) opts.signal = ctrl.signal;
    if (init && init.body !== undefined) opts.body = init.body;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || TIMEOUT) : null;
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (raw) {
        if (timer) clearTimeout(timer);
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        return { status: res.status, ok: res.ok, data: data };
      });
    }, function (err) { if (timer) clearTimeout(timer); throw err; });
  }
  // RFC3339 → 本地可读；解析失败原样返回，不编造。
  function fmtExpiry(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var ms = d.getTime() - Date.now();
    var tail = ms <= 0 ? '（已过期）'
      : '（剩约 ' + Math.floor(ms / 3600000) + ' 小时 ' + Math.floor((ms % 3600000) / 60000) + ' 分）';
    return d.toLocaleString('zh-CN', { hour12: false }) + ' ' + tail;
  }
  function flag(text, tone) { return el('span', 'settings-flag ' + (tone || 'off'), text); }
  function ro(text) { return el('span', 'settings-ro', text); }
  function row(label, value) {
    var tr = el('tr');
    tr.appendChild(el('th', null, label));
    var td = el('td');
    if (value && value.nodeType === 1) td.appendChild(value);
    else td.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    tr.appendChild(td);
    return tr;
  }
  function card(title, meta, rows, extra, wide) {
    var box = el('section', 'panel' + (wide ? ' panel-wide' : ''));
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', title));
    if (meta) head.appendChild(el('span', 'panel-meta', meta));
    box.appendChild(head);
    var table = el('table', 'rows');
    for (var i = 0; i < rows.length; i++) table.appendChild(rows[i]);
    box.appendChild(table);
    for (var j = 0; extra && j < extra.length; j++) box.appendChild(extra[j]);
    return box;
  }
  function hint(text) { return el('div', 'settings-hint', text); }

  /* ===== 账户：会话状态 + 退出登录 ===== */
  function buildAccount() {
    var s = cache.session, authed = !!(s && s.authenticated === true);
    var rows = [
      row('会话状态', flag(authed ? '会话有效' : (s ? '会话无效' : '会话状态未知（读取中或失败）'), authed ? 'ok' : 'warn')),
      row('认证主体', 'admin · 单管理员内核'),
      row('过期时刻', ro(fmtExpiry(s && s.expires_at)))
    ];
    var actions = el('div', 'settings-actions');
    var out = el('button', 'btn btn-primary', '退出登录');
    out.type = 'button';
    out.setAttribute('data-kore-action', 'logout');
    out.addEventListener('click', function () { logout(out); });
    actions.appendChild(out);
    actions.appendChild(el('span', 'settings-hint', '退出后会清除本机会话并回到登录页'));
    return card('账户', '会话', rows, [actions]);
  }

  /* ===== 安全：CSRF 只读展示 + 缺失端点明确禁用 ===== */
  function buildSecurity() {
    var csrf = readCookie('kore_csrf');
    var rows = [
      row('CSRF 机制', '写操作需要页面内令牌校验，防止跨站伪造请求'),
      row('kore_csrf cookie', flag(csrf ? '存在（只读展示，前端不可改写）' : '缺失（写请求会被 401 拒绝）', csrf ? 'ok' : 'warn')),
      row('会话 cookie', '登录凭证保存在浏览器 Cookie 中，页面脚本不可读取'),
      row('会话有效期', '随使用自动续期，默认 12 小时（以配置文件为准）')
    ];
    var actions = el('div', 'settings-actions');
    var pw = el('button', 'btn', '修改口令');
    pw.type = 'button';
    pw.disabled = true;
    pw.setAttribute('aria-describedby', 'kore-pw-missing');
    actions.appendChild(pw);
    actions.appendChild(el('span', 'tag tag-muted', '待支持'));
    var note = el('div', 'settings-hint');
    note.id = 'kore-pw-missing';
    note.textContent = '当前版本暂不支持在线修改口令；如需更换，请编辑配置文件后重启内核。';
    return card('安全', 'CSRF · 会话', rows, [actions, note]);
  }

  /* ===== 运行参数：只读预算表 + 当前生效值 ===== */
  function buildRuntime() {
    var info = cache.info || {};
    var sup = info.supervisor || {};
    var table = el('table', 'settings-table');
    var thead = el('thead'), htr = el('tr');
    htr.appendChild(el('th', null, '资源项'));
    htr.appendChild(el('th', null, '硬红线（判未完成）'));
    htr.appendChild(el('th', null, '目标（争取）'));
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el('tbody');
    for (var i = 0; i < BUDGET.length; i++) {
      var tr = el('tr');
      tr.appendChild(el('th', null, BUDGET[i][0]));
      tr.appendChild(el('td', null, BUDGET[i][1]));
      tr.appendChild(el('td', null, BUDGET[i][2]));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    var box = card('运行参数', '只读 · 修改需改配置文件后重启', [], [
      el('div', 'settings-hint', '当前版本未暴露运行参数（GOGC、内存上限、数据目录等）；如需调整，请编辑配置文件后重启内核。'),
      el('div', 'settings-hint', '资源预算（硬红线 / 目标）：'), table,
      hint('当前主壳 ' + (info.version || '—') + ' · 常驻插件 ' + (sup.resident === undefined ? '—' : sup.resident) +
        ' · 重启计数 ' + (sup.restarts === undefined ? '—' : sup.restarts))
    ], true);
    return box;
  }

  /* ===== 关于：版本 / 协议 / 许可 / 仓库 / 统计 ===== */
  function buildAbout() {
    var info = cache.info || {};
    var link = el('a', 'settings-link', 'github.com/pengtang1024/kore');
    link.href = ABOUT.repo;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return card('关于', '版本与许可', [
      row('kore 版本', el('span', 'mono', info.version || '—')),
      row('协议版本', el('span', 'mono', ABOUT.protocol)),
      row('许可证', ABOUT.license + '（LICENSE）'),
      row('代码仓库', link),
      row('插件仓库', ABOUT.plugins),
      row('场景预设', ABOUT.presets),
      row('前端', '原生 JS · 零框架 · 零 CDN（不加载任何外部资源）')
    ], null, true);
  }

  /* ===== 退出登录：成功后回登录页，失败也不把用户困在面板里 ===== */
  function logout(btn) {
    var csrf = readCookie('kore_csrf');
    var headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-Kore-CSRF'] = csrf;
    btn.disabled = true;
    btn.textContent = '正在退出…';
    request(EP.logout, { method: 'POST', headers: headers, body: '{}' }, 8000)
      .then(backToLogin, backToLogin);
  }
  function backToLogin() {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      window.KoreShell.navigate('/');
      return;
    }
    window.location.assign('/');
  }

  /* ===== 渲染与取数 ===== */
  function paint(container) {
    var root = el('div', 'settings-root');
    root.appendChild(buildAccount());
    root.appendChild(buildSecurity());
    root.appendChild(buildRuntime());
    root.appendChild(buildAbout());
    if (cache.error) root.insertBefore(el('div', 'settings-hint settings-hint-error', cache.error), root.firstChild);
    if (container.replaceChildren) container.replaceChildren(root);
    else { container.textContent = ''; container.appendChild(root); }
  }
  function load() {
    var p1 = request(EP.session).then(function (res) {
      if (res.ok && res.data && res.data.authenticated === true) {
        cache.session = { authenticated: true, expires_at: res.data.expires_at || '' };
      } else if (res.status === 401) {
        cache.session = { authenticated: false, expires_at: '' };
        cache.error = '会话已失效：请重新登录后再查看设置';
      } else {
        cache.session = null;
        cache.error = '设置读取失败，请稍后刷新重试';
      }
    }, function () { cache.session = null; cache.error = '网络不太顺畅，稍后再试一次'; });
    var p2 = request(EP.info).then(function (res) {
      cache.info = res.ok && res.data ? res.data : null;
    }, function () { cache.info = null; });
    return Promise.all([p1, p2]);
  }
  function render(container) {
    if (!container || container.nodeType !== 1) return Promise.resolve(false);
    cache.error = '';
    paint(container);
    return load().then(function () { paint(container); return true; });
  }

  window.KoreSettings = { render: render, endpoints: EP };
})();
