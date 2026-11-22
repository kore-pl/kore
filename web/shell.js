/* kore 主壳布局壳：左侧导航 + 视图路由（零框架、零 CDN、无外链）。
   对外只暴露 window.KoreShell = { mount, navigate, current, openConfig }：
     mount(routes)  routes = [{ id, label, render(container) }]（图标按 id 内置为内联 SVG）
     navigate(id)   切视图并写 URL hash（#/<id>），接受 'store' / '#/store' / '/store'
     current()      当前视图 id（未挂载时返回 ''）
     openConfig(host, pluginId, opts)  按需加载 config-panel.js 并打开插件设置
   设计纪律（FRONTEND §3）：断点是 CSS 的事，JS 不做视口分支；切视图前先给上一个视图
   一次 destroy() 机会（monitor 的轮询必须停），状态用 class + aria-current 双通道，
   不只靠颜色。hash 是唯一真源：前进/后退由 hashchange 驱动，不另存内存栈。 */
(function () {
  'use strict';

  var DEFAULT_ID = 'dashboard';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  // 导航图标只用内联 SVG path（20×20，currentColor，stroke-width 1.5）：
  // 不依赖 emoji 字体、不引图标库、不发额外请求，避免部分环境把 emoji 渲染成色块。
  var ICONS = {
    dashboard: ['M3 3h6v6H3z', 'M11 3h6v6h-6z', 'M3 11h6v6H3z', 'M11 11h6v6h-6z'],
    store: ['M3 7h14', 'M4 7l1.4-3.4h9.2L16 7', 'M5 7v9h10V7', 'M8.5 16v-4.5h3V16'],
    plugins: ['M4 8l6-4 6 4v7l-6 3.5L4 15z', 'M4 8l6 3.5L16 8', 'M10 11.5V18.5'],
    files: ['M3 6a2 2 0 0 1 2-2h3l1.5 1.5H15a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 8h14'],
    sites: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M3 10h14',
      'M10 3c2 2.2 3 4.5 3 7s-1 4.8-3 7c-2-2.2-3-4.5-3-7s1-4.8 3-7'],
    tasks: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M10 6v4.2l2.6 1.5'],
    more: ['M4 10h.01', 'M10 10h.01', 'M16 10h.01'],
    monitor: ['M3 16V4', 'M3 16h14', 'M6 12.5l3-4 3 2 4-6'],
    settings: ['M3 6h14', 'M3 10h14', 'M3 14h14', 'M7 4v4', 'M13 8v4', 'M9 12v4'],
    // 终端：窗口外壳 + 提示符折线 + 光标横线（20×20、currentColor、stroke-width 1.5）
    terminal: ['M3 4h14v12H3z', 'M6 8.5l2.5 1.75L6 12', 'M11 12h3'],
    // 数据库：圆柱顶盖 + 两侧母线 + 中间一道盘面（20×20、currentColor、stroke-width 1.5）
    db: ['M4 5.5c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5-2.7 2.5-6 2.5-6-1.1-6-2.5z',
      'M4 5.5v9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-9', 'M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5'],
    // 日志：文档外框 + 折角 + 三条横线（20×20、currentColor、stroke-width 1.5）
    logs: ['M5 3h6l4 4v10H5z', 'M11 3v4h4', 'M7 10h6', 'M7 13h6'],
    // 进程：方框内两条横条 + 左侧状态点（20×20、currentColor、stroke-width 1.5）
    process: ['M3 4h14v12H3z', 'M6 8h8', 'M6 12h5', 'M6 16h3'],
    // SSL：锁梁 + 锁体 + 锁孔（20×20、currentColor、stroke-width 1.5）
    ssl: ['M6 9V7a4 4 0 0 1 8 0v2', 'M4.5 9h11v8.5h-11z', 'M10 12.5v2.5'],
    // 备份：向下箭头入方框（20×20、currentColor、stroke-width 1.5）
    backup: ['M3 12.5V16h14v-3.5', 'M10 3v8', 'M6.8 8 10 11.2 13.2 8'],
    // Redis：堆叠数据块（顶面菱形 + 两道层线，20×20、currentColor、stroke-width 1.5）
    redis: ['M4 6.5 10 3l6 3.5-6 3.5z', 'M4 10l6 3.5L16 10', 'M4 13.5 10 17l6-3.5'],
    // 防火墙：盾牌 + 对勾（20×20、currentColor、stroke-width 1.5）
    firewall: ['M10 3l6 2v5c0 3.6-2.4 6.2-6 7-3.6-.8-6-3.4-6-7V5z', 'M7.5 10l1.8 1.8 3.4-3.4']
  };
  // 导航按使用频率分四组（16 项）：运维是日常入口，常驻手机底部 5 个 tab；
  // 其余 11 项进「更多」抽屉并按组展示，组标题不增加点击层级（仍 ≤2 次点击）。
  var NAV_GROUPS = [
    { title: '运维', ids: ['dashboard', 'monitor', 'logs', 'process', 'terminal'] },
    { title: '业务', ids: ['sites', 'db', 'redis', 'tasks'] },
    { title: '资源', ids: ['files', 'backup', 'ssl'] },
    { title: '平台', ids: ['store', 'plugins', 'firewall', 'settings'] }
  ];
  function groupTitle(id) {
    for (var i = 0; i < NAV_GROUPS.length; i++) {
      if (NAV_GROUPS[i].ids.indexOf(id) >= 0) return NAV_GROUPS[i].title;
    }
    return '其他';
  }
  // 按组顺序重排路由，未知 id 保序落到末尾「其他」；手机前 5 项因此固定为「运维」组。
  function orderRoutes(list) {
    var out = [], seen = Object.create(null);
    for (var i = 0; i < NAV_GROUPS.length; i++) {
      for (var j = 0; j < NAV_GROUPS[i].ids.length; j++) {
        var id = NAV_GROUPS[i].ids[j];
        for (var k = 0; k < list.length; k++) {
          if (list[k].id === id && !seen[id]) { out.push(list[k]); seen[id] = true; break; }
        }
      }
    }
    for (var m = 0; m < list.length; m++) if (!seen[list[m].id]) { out.push(list[m]); seen[list[m].id] = true; }
    return out;
  }
  function groupLabel(title, drawer) {
    var n = el('div', drawer ? 'kore-nav-drawer-group' : 'kore-nav-group', title);
    n.setAttribute('role', 'presentation'); return n;
  }
  var byId = Object.create(null);
  var currentId = '';
  var viewBox = null;
  var navButtons = Object.create(null);
  var moreBtn = null;
  var drawer = null;
  var backdrop = null;
  var drawerOpen = false;
  var handle = null;
  var listening = false;
  var drawerListening = false;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // 'store' / '#/store' / '/store' / '#/store?x' 统一成 'store'；空值回默认视图。
  function normalize(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw);
    s = s.replace(/^#/, '').replace(/^\//, '');
    if (s.indexOf('?') >= 0) s = s.slice(0, s.indexOf('?'));
    if (s.indexOf('/') >= 0) s = s.slice(0, s.indexOf('/')); // 只认一级视图，插件子路由不归此层
    return s || DEFAULT_ID;
  }

  // 显式回到站点根（''、'/'、'#/'）不算「概览」：它是退出/失效后的归位意图，
  // 由持有鉴权状态的 app.js 决定渲染登录还是面板。壳只发信号，不猜会话。
  function isRoot(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw);
    s = s.replace(/^#/, '').replace(/^\//, '');
    if (s.indexOf('?') >= 0) s = s.slice(0, s.indexOf('?'));
    return s === '' || s.indexOf('/') === 0;
  }

  function rootIntent() {
    if (window.location.hash && window.location.hash !== '#/' && window.location.hash !== '#') {
      window.location.hash = '';
    }
    window.dispatchEvent(new CustomEvent('kore:root'));
  }

  function hashView() {
    return normalize(window.location.hash);
  }

  // 手机底部 tab bar 的「更多」抽屉：前 5 项常驻，其余路由收进抽屉。
  // 只在 <640px 由 CSS 显示；桌面侧栏始终展示全部导航项（断点归 CSS，不做视口探测）。
  function setDrawer(open, focusBack) {
    drawerOpen = !!open;
    if (!drawer || !backdrop) return;
    drawer.hidden = !drawerOpen;
    backdrop.hidden = !drawerOpen;
    drawer.classList.toggle('is-open', drawerOpen);
    backdrop.classList.toggle('is-open', drawerOpen);
    if (moreBtn) moreBtn.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
    if (drawerOpen) {
      var first = drawer.querySelector('button');
      if (first) first.focus();
    } else if (focusBack && moreBtn) {
      moreBtn.focus();
    }
  }

  function onDrawerKey(ev) {
    if (ev.key === 'Escape' && drawerOpen) setDrawer(false, true);
  }

  // 模块渲染可返回 handle；handle.destroy() 是清理钩子（定时器 / 监听器）。
  function releaseHandle() {
    if (handle && typeof handle.destroy === 'function') {
      try { handle.destroy(); } catch (err) { /* 模块清理失败不该阻断切视图 */ }
    }
    handle = null;
  }

  function paint(id) {
    var route = byId[id] || byId[DEFAULT_ID];
    if (!route || !viewBox) return null;
    releaseHandle();
    for (var key in navButtons) {
      var nodes = navButtons[key];
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].classList.remove('is-active');
        nodes[i].removeAttribute('aria-current');
      }
    }
    var active = navButtons[route.id] || [];
    for (var j = 0; j < active.length; j++) {
      active[j].classList.add('is-active');
      active[j].setAttribute('aria-current', 'page');
    }
    if (moreBtn) {
      moreBtn.classList.toggle('is-active', !!route.extra);
      if (route.extra) moreBtn.setAttribute('aria-current', 'page');
      else moreBtn.removeAttribute('aria-current');
    }
    setDrawer(false, false);
    currentId = route.id;
    viewBox.setAttribute('data-view', route.id);
    // 视图模块会给容器加自己的类（如 monitor 加 .kore-monitor）；切走时必须还原，
    // 否则上一个视图的类会残留、污染下一个视图的样式与选择器。
    viewBox.className = 'view';
    viewBox.textContent = '';
    try {
      handle = route.render(viewBox) || null;
    } catch (err) {
      viewBox.appendChild(el('div', 'stub', '视图渲染失败：' + (err && err.message ? err.message : err)));
    }
    return route;
  }

  // navigate 是唯一入口：先写 hash（可分享 / 可后退），再同步重绘。
  // hashchange 再进来时 compare currentId 已相等 → 不重复 paint，避免双份请求。
  function navigate(id) {
    if (isRoot(id)) { rootIntent(); return ''; }
    setDrawer(false, false);
    var next = normalize(id);
    if (!byId[next]) next = byId[DEFAULT_ID] ? DEFAULT_ID : '';
    if (!next) return '';
    var target = '#/' + next;
    if (window.location.hash !== target) window.location.hash = target;
    paint(next);
    return next;
  }

  function onHash() {
    var raw = window.location.hash;
    setDrawer(false, false);
    if (isRoot(raw)) { rootIntent(); return; }
    var id = normalize(raw);
    if (id === currentId) return;
    paint(id);
  }

  function navIcon(id) {
    var span = el('span', 'kore-nav-icon');
    span.setAttribute('aria-hidden', 'true'); // 图标是装饰，语义靠文字标签
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var paths = ICONS[id] || ['M10 4v12', 'M4 10h12'];
    for (var i = 0; i < paths.length; i++) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', paths[i]);
      svg.appendChild(path);
    }
    span.appendChild(svg);
    return span;
  }

  function navItem(route, isDrawerItem) {
    var btn = el('button', 'kore-nav-item' + (route.extra && !isDrawerItem ? ' kore-nav-extra' : '') +
      (isDrawerItem ? ' kore-nav-drawer-item' : ''));
    btn.type = 'button';
    btn.setAttribute('data-view', route.id);
    btn.appendChild(navIcon(route.id));
    btn.appendChild(el('span', 'kore-nav-label', route.label));
    if (isDrawerItem) btn.setAttribute('role', 'menuitem');
    btn.addEventListener('click', function () {
      if (drawerOpen) setDrawer(false, false);
      navigate(route.id);
    });
    return btn;
  }

  // 终端 / 数据库 / 日志 / 进程 / SSL / 备份 / Redis / 防火墙是壳内置的第 9–16 项：
  // index.html 不引脚本，首次切到该视图才注入 /assets/<模块>.js。口径与 app.js 的 ensureModule
  // 一致：只注入一次、失败可重试。
  var lazyModules = Object.create(null);
  function ensureLazy(url, globalName, ready) {
    var ok = ready || function (mod) { return mod && typeof mod.render === 'function'; };
    if (window[globalName] && ok(window[globalName])) {
      return Promise.resolve(window[globalName]);
    }
    if (lazyModules[url]) return lazyModules[url];
    lazyModules[url] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = function () {
        var mod = window[globalName];
        if (!ok(mod)) {
          delete lazyModules[url];
          reject(new Error(url + ' 未导出可用的 ' + globalName));
          return;
        }
        resolve(mod);
      };
      script.onerror = function () {
        delete lazyModules[url];
        reject(new Error(url + ' 加载失败（HTTP 错误或网络中断）'));
      };
      document.head.appendChild(script);
    });
    return lazyModules[url];
  }
  // lazyView 返回 shell 需要的 render(container)：异步等模块就绪后再渲染；切走时
  // handle.destroy() 把"迟到的渲染"挡在已卸载容器外，并让模块停掉自己的轮询。
  function lazyView(globalName, url, label) {
    return function (box) {
      var live = { destroyed: false, handle: null };
      box.appendChild(el('div', 'stub', '正在加载' + label + '…'));
      ensureLazy(url, globalName).then(function (mod) {
        if (live.destroyed) return;
        box.textContent = '';
        try {
          var handle = mod.render(box);
          if (handle && typeof handle.destroy === 'function') live.handle = handle;
        } catch (err) {
          box.textContent = '';
          box.appendChild(el('div', 'stub', label + '渲染失败：' + (err && err.message ? err.message : err)));
        }
      }, function (err) {
        if (live.destroyed) return;
        box.textContent = '';
        box.appendChild(el('div', 'stub', label + '不可用：' + (err && err.message ? err.message : '模块加载失败')));
      });
      return {
        destroy: function () {
          live.destroyed = true;
          if (live.handle && typeof live.handle.destroy === 'function') {
            try { live.handle.destroy(); } catch (err) { /* 模块清理失败不阻断切视图 */ }
          }
          live.handle = null;
        }
      };
    };
  }

  /* ===== 全局搜索入口：首屏只放按钮 + Ctrl/Cmd+K，search.js 首次唤起才注入 =====
     app.js 会整体替换 #kore-topbar 内容，故用 MutationObserver 把入口重新挂回 .conn 首位；
     入口放在连接状态组内，手机端只显示 44px 图标，不额外占顶栏一行。 */
  var searchTrigger = null;
  var searchObserver = null;
  var searchListening = false;
  var SEARCH_CSS = '.kore-search-trigger{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px;' +
    'border:1px solid var(--kore-border-1);border-radius:4px;background:var(--kore-bg-2);color:var(--kore-text-2);' +
    'font-size:12px;cursor:pointer}' +
    '.kore-search-trigger:hover{color:var(--kore-text-1);border-color:var(--kore-text-3)}' +
    '.kore-search-trigger svg{width:16px;height:16px;flex:0 0 auto}' +
    '.kore-search-trigger kbd{font-size:10px;color:var(--kore-text-3);border:1px solid var(--kore-border-1);' +
    'border-radius:3px;padding:0 4px}' +
    '@media (max-width:639px){.kore-search-trigger-label,.kore-search-trigger kbd{display:none}' +
    '.kore-search-trigger{min-width:44px;min-height:44px;justify-content:center;padding:0}}';
  function ensureSearchCss() {
    if (document.getElementById('kore-search-trigger-css')) return;
    var s = el('style'); s.id = 'kore-search-trigger-css'; s.textContent = SEARCH_CSS;
    document.head.appendChild(s);
  }
  function openSearch() {
    ensureLazy('/assets/search.js', 'KoreSearch', function (mod) { return mod && typeof mod.open === 'function'; })
      .then(function (mod) { mod.open(); }, function (err) {
        var t = document.getElementById('kore-search-trigger');
        if (t) t.title = '全局搜索不可用：' + (err && err.message ? err.message : '模块加载失败');
      });
  }
  function buildSearchTrigger() {
    if (searchTrigger) return searchTrigger;
    searchTrigger = el('button', 'kore-search-trigger');
    searchTrigger.type = 'button';
    searchTrigger.id = 'kore-search-trigger';
    searchTrigger.setAttribute('aria-label', '全局搜索（Ctrl+K）');
    searchTrigger.setAttribute('aria-haspopup', 'dialog');
    searchTrigger.setAttribute('aria-expanded', 'false');
    searchTrigger.title = '全局搜索（Ctrl+K）';
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6');
    var c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '8.5'); c.setAttribute('cy', '8.5'); c.setAttribute('r', '5');
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M12.5 12.5 17 17');
    svg.appendChild(c); svg.appendChild(p);
    searchTrigger.appendChild(svg);
    searchTrigger.appendChild(el('span', 'kore-search-trigger-label', '搜索'));
    searchTrigger.appendChild(el('kbd', null, 'Ctrl K'));
    searchTrigger.addEventListener('click', openSearch);
    return searchTrigger;
  }
  function placeSearchTrigger() {
    var top = document.getElementById('kore-topbar');
    if (!top) return;
    var conn = top.querySelector('.conn');
    if (!conn) { setTimeout(placeSearchTrigger, 60); return; }
    var btn = buildSearchTrigger();
    if (btn.parentNode !== conn) conn.insertBefore(btn, conn.firstChild);
  }
  function watchTopbar() {
    ensureSearchCss();
    placeSearchTrigger();
    if (!window.MutationObserver) return;
    if (searchObserver) searchObserver.disconnect();
    var top = document.getElementById('kore-topbar');
    if (!top) return;
    searchObserver = new MutationObserver(placeSearchTrigger);
    searchObserver.observe(top, { childList: true, subtree: true });
  }
  function onGlobalKey(ev) {
    var key = ev.key ? String(ev.key).toLowerCase() : '';
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && key === 'k') {
      if (!document.getElementById('kore-topbar')) return; // 登录页不响应
      ev.preventDefault();
      openSearch();
    }
  }

  function mount(list) {
    var items = [];
    for (var i = 0; list && i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.id !== 'string' || !r.id || typeof r.render !== 'function') continue;
      items.push(r);
    }
    var hasTerminal = false, hasDb = false, hasLogs = false, hasProcess = false, hasSsl = false, hasBackup = false,
      hasRedis = false, hasFirewall = false;
    for (var t = 0; t < items.length; t++) {
      if (items[t].id === 'terminal') hasTerminal = true;
      if (items[t].id === 'db') hasDb = true;
      if (items[t].id === 'logs') hasLogs = true;
      if (items[t].id === 'process') hasProcess = true;
      if (items[t].id === 'ssl') hasSsl = true;
      if (items[t].id === 'backup') hasBackup = true;
      if (items[t].id === 'redis') hasRedis = true;
      if (items[t].id === 'firewall') hasFirewall = true;
    }
    if (!hasTerminal) items.push({ id: 'terminal', label: '终端', render: lazyView('KoreTerminal', '/assets/terminal.js', '终端') });
    if (!hasDb) items.push({ id: 'db', label: '数据库', render: lazyView('KoreDb', '/assets/db.js', '数据库') });
    if (!hasLogs) items.push({ id: 'logs', label: '日志', render: lazyView('KoreLogs', '/assets/logs.js', '日志') });
    if (!hasProcess) items.push({ id: 'process', label: '进程', render: lazyView('KoreProcess', '/assets/process.js', '进程') });
    if (!hasSsl) items.push({ id: 'ssl', label: 'SSL', render: lazyView('KoreSsl', '/assets/ssl.js', 'SSL') });
    if (!hasBackup) items.push({ id: 'backup', label: '备份', render: lazyView('KoreBackup', '/assets/backups.js', '备份') });
    if (!hasRedis) items.push({ id: 'redis', label: 'Redis', render: lazyView('KoreRedis', '/assets/redis.js', 'Redis') });
    if (!hasFirewall) items.push({ id: 'firewall', label: '防火墙', render: lazyView('KoreFirewall', '/assets/firewall.js', '防火墙') });
    items = orderRoutes(items);
    var host = document.getElementById('app');
    if (!items.length || !host) return null;

    byId = Object.create(null);
    navButtons = Object.create(null);
    releaseHandle();
    moreBtn = null; drawer = null; backdrop = null; drawerOpen = false;
    currentId = '';

    var shell = el('div', 'kore-shell');
    var nav = el('nav', 'kore-nav');
    nav.setAttribute('aria-label', '主导航');
    var brand = el('div', 'kore-nav-brand');
    brand.appendChild(el('span', 'kore-nav-brand-name', 'kore'));
    brand.appendChild(el('span', 'kore-nav-brand-sub', '控制台'));
    nav.appendChild(brand);

    var lastGroup = '';
    for (var j = 0; j < items.length; j++) {
      var route = {
        id: items[j].id,
        label: items[j].label || items[j].id,
        render: items[j].render,
        extra: j >= 5
      };
      byId[route.id] = route;
      var group = groupTitle(route.id);
      if (group !== lastGroup) { nav.appendChild(groupLabel(group, false)); lastGroup = group; }
      var btn = navItem(route, false);
      navButtons[route.id] = [btn];
      nav.appendChild(btn);
    }
    var extras = items.slice(5);
    if (extras.length) {
      moreBtn = el('button', 'kore-nav-item kore-nav-more');
      moreBtn.type = 'button';
      moreBtn.setAttribute('aria-haspopup', 'true');
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.setAttribute('aria-controls', 'kore-more-drawer');
      moreBtn.appendChild(navIcon('more'));
      moreBtn.appendChild(el('span', 'kore-nav-label', '更多'));
      moreBtn.addEventListener('click', function () { setDrawer(!drawerOpen, false); });
      nav.appendChild(moreBtn);
    }

    var col = el('div', 'kore-col');
    var topbar = el('div', 'kore-topbar');
    topbar.id = 'kore-topbar'; // app.js 把连接状态 / 退出按钮挂在这里，壳不持有业务
    col.appendChild(topbar);
    viewBox = el('main', 'view');
    viewBox.id = 'view';
    col.appendChild(viewBox);

    shell.appendChild(nav);
    shell.appendChild(col);
    if (extras.length) {
      backdrop = el('div', 'kore-nav-backdrop');
      backdrop.hidden = true;
      backdrop.addEventListener('click', function () { setDrawer(false, true); });
      drawer = el('div', 'kore-nav-drawer');
      drawer.id = 'kore-more-drawer';
      drawer.hidden = true;
      drawer.setAttribute('role', 'menu');
      drawer.setAttribute('aria-label', '更多导航');
      var lastDrawerGroup = '';
      for (var k = 0; k < extras.length; k++) {
        var extraRoute = byId[extras[k].id], drawerGroup = groupTitle(extraRoute.id);
        if (drawerGroup !== lastDrawerGroup) { drawer.appendChild(groupLabel(drawerGroup, true)); lastDrawerGroup = drawerGroup; }
        var extraBtn = navItem(extraRoute, true);
        navButtons[extraRoute.id].push(extraBtn);
        drawer.appendChild(extraBtn);
      }
      shell.appendChild(backdrop);
      shell.appendChild(drawer);
    }
    if (host.replaceChildren) host.replaceChildren(shell);
    else { host.textContent = ''; host.appendChild(shell); }

    if (!listening) {
      window.addEventListener('hashchange', onHash);
      listening = true;
    }
    if (!searchListening) {
      document.addEventListener('keydown', onGlobalKey);
      searchListening = true;
    }
    watchTopbar();
    if (!drawerListening) {
      document.addEventListener('keydown', onDrawerKey);
      drawerListening = true;
    }
    paint(hashView()); // 深链接：登录后打开 #/store 直接落到该视图
    return shell;
  }

  function current() {
    return currentId;
  }

  // 通用配置面板按需注入：插件视图只挂「设置」入口，不各自实现表单（PLUGIN-CONFIG §9）。
  function openConfig(host, pluginId, opts) {
    var box = host || viewBox;
    if (!box) return null;
    if (window.KoreConfig && typeof window.KoreConfig.open === 'function') {
      return window.KoreConfig.open(box, pluginId, opts);
    }
    ensureLazy('/assets/config-panel.js', 'KoreConfig', function (mod) {
      return mod && typeof mod.open === 'function';
    }).then(function (mod) {
      mod.open(box, pluginId, opts);
    }, function (err) {
      box.appendChild(el('div', 'stub', '配置面板不可用：' + (err && err.message ? err.message : '模块加载失败')));
    });
    return null;
  }

  window.KoreShell = { mount: mount, navigate: navigate, current: current, openConfig: openConfig };
})();
