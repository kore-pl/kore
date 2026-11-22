/* kore 主壳布局壳：左侧导航 + 视图路由（零框架、零 CDN、无外链）。
   对外只暴露 window.KoreShell = { mount, navigate, current }：
     mount(routes)  routes = [{ id, label, render(container) }]（图标按 id 内置为内联 SVG）
     navigate(id)   切视图并写 URL hash（#/<id>），接受 'store' / '#/store' / '/store'
     current()      当前视图 id（未挂载时返回 ''）
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
    monitor: ['M3 16V4', 'M3 16h14', 'M6 12.5l3-4 3 2 4-6'],
    settings: ['M3 6h14', 'M3 10h14', 'M3 14h14', 'M7 4v4', 'M13 8v4', 'M9 12v4']
  };
  var byId = Object.create(null);
  var currentId = '';
  var viewBox = null;
  var activeBtn = null;
  var handle = null;
  var listening = false;

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
    if (activeBtn && activeBtn !== route.btn) {
      activeBtn.classList.remove('is-active');
      activeBtn.removeAttribute('aria-current');
    }
    activeBtn = route.btn || null;
    if (activeBtn) {
      activeBtn.classList.add('is-active');
      activeBtn.setAttribute('aria-current', 'page');
    }
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

  function navItem(route) {
    var btn = el('button', 'kore-nav-item');
    btn.type = 'button';
    btn.setAttribute('data-view', route.id);
    btn.appendChild(navIcon(route.id));
    btn.appendChild(el('span', 'kore-nav-label', route.label));
    btn.addEventListener('click', function () { navigate(route.id); });
    return btn;
  }

  function mount(list) {
    var items = [];
    for (var i = 0; list && i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.id !== 'string' || !r.id || typeof r.render !== 'function') continue;
      items.push(r);
    }
    var host = document.getElementById('app');
    if (!items.length || !host) return null;

    byId = Object.create(null);
    releaseHandle();
    activeBtn = null;
    currentId = '';

    var shell = el('div', 'kore-shell');
    var nav = el('nav', 'kore-nav');
    nav.setAttribute('aria-label', '主导航');
    var brand = el('div', 'kore-nav-brand');
    brand.appendChild(el('span', 'kore-nav-brand-name', 'kore'));
    brand.appendChild(el('span', 'kore-nav-brand-sub', '控制台'));
    nav.appendChild(brand);

    for (var j = 0; j < items.length; j++) {
      var route = {
        id: items[j].id,
        label: items[j].label || items[j].id,
        render: items[j].render,
        btn: null
      };
      byId[route.id] = route;
      route.btn = navItem(route);
      nav.appendChild(route.btn);
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
    if (host.replaceChildren) host.replaceChildren(shell);
    else { host.textContent = ''; host.appendChild(shell); }

    if (!listening) {
      window.addEventListener('hashchange', onHash);
      listening = true;
    }
    paint(hashView()); // 深链接：登录后打开 #/store 直接落到该视图
    return shell;
  }

  function current() {
    return currentId;
  }

  window.KoreShell = { mount: mount, navigate: navigate, current: current };
})();
