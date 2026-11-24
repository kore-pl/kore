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
  // 未知 hash 的兜底路由 id：只进 byId 供路由查找，永远不进导航菜单。
  // 用固定 id 而非每次回概览，是为了让 app.js 的 navigate(current()) 刷新不弹走 404 页（G-33）。
  var NOT_FOUND_ID = '404';
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
    firewall: ['M10 3l6 2v5c0 3.6-2.4 6.2-6 7-3.6-.8-6-3.4-6-7V5z', 'M7.5 10l1.8 1.8 3.4-3.4'],
    // 安全（一级项）：盾牌 + 锁孔（防火墙 / WAF / SSH / 证书 / 完整性 / 服务发现 的共同入口）
    security: ['M10 3l6 2v5c0 3.6-2.4 6.2-6 7-3.6-.8-6-3.4-6-7V5z',
      'M10 7.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2', 'M10 10.6v2.2'],
    // WAF：盾牌 + 三道筛条（与 firewall 的对勾、integrity 的双层盾区分，20×20、currentColor、stroke-width 1.5）
    waf: ['M10 3l6 2v5c0 3.6-2.4 6.2-6 7-3.6-.8-6-3.4-6-7V5z', 'M7.4 7.6h5.2', 'M7.4 10h5.2', 'M7.4 12.4h3.2'],
    // DNS：地球经纬（与 sites 的球区分：多一道横纬线 + 中部节点，20×20、currentColor、stroke-width 1.5）
    dns: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M3 10h14', 'M10 3c1.8 2 2.7 4.4 2.7 7s-.9 5-2.7 7c-1.8-2-2.7-4.4-2.7-7S8.2 5 10 3', 'M5 6.2h10', 'M5 13.8h10'],
    // 服务发现：雷达圆 + 扫描指针（与 dns 的地球经纬区分，20×20、currentColor、stroke-width 1.5）
    discover: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M10 10l4.3-3.3', 'M10 6.4v3.6h3.6'],
    // SSH 防护：盾牌 + 钥匙孔（与 waf 的筛条、firewall 的对勾区分，20×20、currentColor、stroke-width 1.5）
    sshguard: ['M10 3l6 2v5c0 3.6-2.4 6.2-6 7-3.6-.8-6-3.4-6-7V5z', 'M10 7.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6', 'M10 10.8v2.9'],
    // 运行环境：三层堆叠（Node / PHP / Python 共用一页切换，20×20、currentColor、stroke-width 1.5）
    runtimes: ['M10 3 4 6l6 3 6-3z', 'M4 10l6 3 6-3', 'M4 14l6 3 6-3'],
    // 容器：集装箱外框 + 两道竖筋（20×20、currentColor、stroke-width 1.5）
    container: ['M3 5h14v10H3z', 'M7 5v10', 'M13 5v10'],
    // 应用部署：上传箭头入托盘（与 store 卡片图标一致，20×20、currentColor、stroke-width 1.5）
    appdeploy: ['M10 12.5V4', 'M6.5 7.5 10 4l3.5 3.5', 'M4 12.5v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3'],
    // 完整性：双层盾牌 + 对勾（内层轮廓把它与单盾的 firewall 区分开，20×20、currentColor、stroke-width 1.5）
    integrity: ['M10 2.6l5.6 2.1v5.2c0 3.5-2.3 6-5.6 6.9-3.3-.9-5.6-3.4-5.6-6.9V4.7z',
      'M10 4.9l3.5 1.3v3.7c0 2.1-1.4 3.7-3.5 4.3-2.1-.6-3.5-2.2-3.5-4.3V6.2z',
      'M8.4 9.6l1.3 1.3 2.2-2.4'],
    // R22 新功能图标（sub tab 由 hubView 渲染、不直接取图标；此处登记供导航键统一与将来提升为一级项时使用）
    health: ['M3 11h3l2-4 3 7 2.2-4.5 1.3 1.5H17'], // 体检：心电脉冲折线
    report: ['M5 3h6l4 4v10H5z', 'M11 3v4h4', 'M7 11h6', 'M7 14h6'], // 报告：文档 + 折角 + 横线
    topology: ['M4 5h4v4H4z', 'M12 5h4v4h-4z', 'M8 13h4v4H8z', 'M6 9v2h4v2', 'M14 9v2h-4'], // 拓扑：三节点连线
    calendar: ['M4 5h12v12H4z', 'M4 8h12', 'M7 3v4', 'M13 3v4'], // 日历：方框 + 顶栏 + 挂环
    batch: ['M4 4h9v9H4z', 'M7 7h9v9H7z'], // 批量：叠放方块
    snapshot: ['M4 8a6 6 0 1 0 1.2-3.6', 'M4 4v4h4', 'M10 7v3l2 1.4'], // 快照：回环箭头 + 时钟
    migrate: ['M3 10h14', 'M13 6l4 4-4 4', 'M7 6l-4 4 4 4'], // 迁移：双向箭头
    webhook: ['M10 3a3 3 0 0 1 3 3 3 3 0 0 1-.5 1.7A4 4 0 0 1 15 11h2v3h-3.4a4 4 0 0 1-7.2 0H3v-3h2a4 4 0 0 1 2.5-3.3A3 3 0 0 1 7 6a3 3 0 0 1 3-3z'], // 通知：铃铛
    // R23 故障演练：闪电（20×20、currentColor、stroke-width 1.5）；其余 7 项 sub 复用所属 hub 图标。
    faultdrill: ['M11 2 4 11h5l-1 7 7-9h-5z']
  };
  /* 导航不再分组：收敛到 ≤10 项后一层平铺就够读，组标题只会制造视觉噪音。
     一级菜单只表达「用户要干的事」，插件视图降到一级项内部的 tab（见下方 hubView）。
     顺序即优先级：桌面侧栏全量按此顺序；手机底部 tab bar 固定取前 5 项，其余进「更多」抽屉。 */

  /* ===== 一级项 = 任务 → 子视图 = tab（24 → ≤10 的实现机制） =====
     一个 hub 只产生一个一级菜单项；它下面的 tab 各自仍是原来的懒加载模块，
     能力一个不少（可达性由 tab 承担，不是删除），但侧栏不再被插件清单线性撑长。
     为什么二级用 tab 而不是第二根侧栏：侧栏再加一层等于把刚收敛掉的层级又长回去，
     且 tab 单行可横向滚动，640px 以下天然可用（触摸目标 ≥44px），不需要视口分支。 */
  var HUB_CSS = '.kore-hub{display:flex;flex-direction:column;gap:var(--kore-space-3,12px);min-width:0}' +
    '.kore-hub-tabs{display:flex;gap:var(--kore-space-1,4px);overflow-x:auto;border-bottom:1px solid var(--kore-border-1);' +
    'scrollbar-width:thin;-webkit-overflow-scrolling:touch}' +
    '.kore-hub-tab{flex:0 0 auto;min-height:36px;padding:0 12px;border:0;border-bottom:2px solid transparent;' +
    'background:transparent;color:var(--kore-text-2);font:inherit;font-size:var(--kore-font-13,13px);' +
    'cursor:pointer;white-space:nowrap}' +
    '.kore-hub-tab:hover{color:var(--kore-text-1)}' +
    '.kore-hub-tab[aria-selected="true"]{color:var(--kore-text-1);border-bottom-color:var(--kore-primary,#2563eb);font-weight:600}' +
    '.kore-hub-tab:focus-visible{outline:2px solid var(--kore-primary,#2563eb);outline-offset:-2px}' +
    '.kore-hub-body{min-width:0}' +
    '@media (max-width:639px){.kore-hub-tab{min-height:44px;padding:0 10px}}';

  function injectHubCss() {
    if (document.getElementById('kore-hub-css')) return;
    var s = el('style');
    s.id = 'kore-hub-css';
    s.textContent = HUB_CSS;
    document.head.appendChild(s);
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

  /* ===== i18n 绑定（ADR-0021）=====
     文案统一走 window.KoreI18n.t；缺 i18n.js / 缺 key / 键名原样返回时，一律回退到
     硬编码中文兜底——保证脚本加载失败也绝不把 key 名显示给用户。
     绑定表按 mount 重建，语言切换后由 relabel() 原地重写文字，不重建导航、不丢视图。 */
  var labelBindings = [];  // { node, key, fallback }
  var attrBindings = [];   // { node, attr, key, fallback }
  var i18nListening = false;

  function tr(key, fallback, params) {
    var i18n = window.KoreI18n;
    if (i18n && typeof i18n.t === 'function') {
      var hit = i18n.t(key, params);
      if (hit && hit !== key) return hit;
    }
    var out = fallback === undefined || fallback === null ? key : String(fallback);
    if (params) {
      for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k)) out = out.split('{' + k + '}').join(String(params[k]));
      }
    }
    return out;
  }
  function bindLabel(node, key, fallback) {
    node.textContent = tr(key, fallback);
    labelBindings.push({ node: node, key: key, fallback: fallback });
    return node;
  }
  function bindAttr(node, attr, key, fallback) {
    node.setAttribute(attr, tr(key, fallback));
    attrBindings.push({ node: node, attr: attr, key: key, fallback: fallback });
    return node;
  }
  function relabel() {
    for (var i = 0; i < labelBindings.length; i++) {
      var b = labelBindings[i];
      if (b.node.isConnected !== false) b.node.textContent = tr(b.key, b.fallback);
    }
    for (var j = 0; j < attrBindings.length; j++) {
      var a = attrBindings[j];
      if (a.node.isConnected !== false) a.node.setAttribute(a.attr, tr(a.key, a.fallback));
    }
  }
  function watchLocale() {
    if (i18nListening || !window.KoreI18n || typeof window.KoreI18n.onChange !== 'function') return;
    window.KoreI18n.onChange(relabel);
    i18nListening = true;
  }

  // 'store' / '#/store' / '/store' / '#/store?x' 统一成 'store'；空值回默认视图。
  // 二级路由 '#/security/dns' 只取一级 'security'（子视图另由 subOf 解析）。
  function normalize(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw);
    s = s.replace(/^#/, '').replace(/^\//, '');
    if (s.indexOf('?') >= 0) s = s.slice(0, s.indexOf('?'));
    if (s.indexOf('/') >= 0) s = s.slice(0, s.indexOf('/')); // 只认一级视图，插件子路由不归此层
    return s || DEFAULT_ID;
  }

  // 二级路由：'#/security/dns' → 'dns'；没有第二段 → ''（由 hub 落默认 tab）。
  function subOf(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw);
    s = s.replace(/^#/, '').replace(/^\//, '');
    if (s.indexOf('?') >= 0) s = s.slice(0, s.indexOf('?'));
    var i = s.indexOf('/');
    return i >= 0 ? s.slice(i + 1) : '';
  }

  // 路由键 = 一级 + 可选二级（'security' / 'security/dns'）。它是「当前视图」的唯一标识：
  // 同一个 hub 内换 tab 必须改变路由键，否则 onHash 会因为「一级没变」直接返回、tab 不重绘。
  function routeKey(raw) {
    var parent = normalize(raw), child = subOf(raw);
    return child ? parent + '/' + child : parent;
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
    if (ev.key !== 'Escape') return;
    if (helpMask && !helpMask.hidden) { closeHelp(); return; }
    if (drawerOpen) setDrawer(false, true);
  }

  // 模块渲染可返回 handle；handle.destroy() 是清理钩子（定时器 / 监听器）。
  function releaseHandle() {
    if (handle && typeof handle.destroy === 'function') {
      try { handle.destroy(); } catch (err) { /* 模块清理失败不该阻断切视图 */ }
    }
    handle = null;
  }

  /* ===== 友好 404（G-33 错误边界）=====
     未知 hash 不再是空白页/静默回概览：给白话说明 + 两个下一步按钮（返回概览 / 去搜索）。
     样式内联注入一次（不进首屏 CSS 预算）；触摸目标 ≥44px；按钮只走既有 navigate/openSearch，
     不新增路由逻辑、不碰 Ctrl+K。文案人话，不出现 hash/route 等内部术语。 */
  var NOT_FOUND_CSS = '.kore-notfound{max-width:560px;margin:clamp(24px,8vh,80px) auto;padding:24px 20px;' +
    'text-align:center;color:var(--kore-text-1)}' +
    '.kore-notfound-code{font-size:clamp(48px,12vw,88px);line-height:1;font-weight:700;' +
    'color:var(--kore-primary,#2563eb);margin:0 0 12px}' +
    '.kore-notfound h2{font-size:var(--kore-font-18,18px);margin:0 0 10px}' +
    '.kore-notfound p{font-size:var(--kore-font-14,14px);line-height:1.7;color:var(--kore-text-2);' +
    'margin:0 0 24px;overflow-wrap:anywhere}' +
    '.kore-notfound-path{color:var(--kore-text-3);font-size:var(--kore-font-12,12px)}' +
    '.kore-notfound-actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}' +
    '.kore-notfound-actions button{display:inline-flex;align-items:center;justify-content:center;' +
    'min-width:132px;min-height:44px;padding:0 18px;border-radius:6px;font:inherit;font-size:14px;' +
    'cursor:pointer;border:1px solid var(--kore-border-1)}' +
    '.kore-notfound-home{background:var(--kore-primary,#2563eb);color:#fff;border-color:var(--kore-primary,#2563eb)}' +
    '.kore-notfound-search{background:var(--kore-bg-2);color:var(--kore-text-1)}';
  function ensureNotFoundCss() {
    if (document.getElementById('kore-notfound-css')) return;
    var s = el('style'); s.id = 'kore-notfound-css'; s.textContent = NOT_FOUND_CSS;
    document.head.appendChild(s);
  }
  function renderNotFound(box) {
    ensureNotFoundCss();
    var wrap = el('div', 'kore-notfound');
    wrap.setAttribute('role', 'alert');
    wrap.appendChild(el('div', 'kore-notfound-code', '404'));
    wrap.appendChild(el('h2', null, tr('common.notFoundTitle', '这个页面不存在')));
    var desc = el('p', null,
      tr('common.notFoundDesc', '地址可能输错了，或者页面已经搬走了。别急，用下面的按钮回到正轨。'));
    var path = el('span', 'kore-notfound-path', window.location.hash || '');
    desc.appendChild(el('br'));
    desc.appendChild(path);
    wrap.appendChild(desc);
    var actions = el('div', 'kore-notfound-actions');
    var home = el('button', 'kore-notfound-home', tr('common.notFoundHome', '返回概览'));
    home.type = 'button';
    home.addEventListener('click', function () { navigate(DEFAULT_ID); });
    var search = el('button', 'kore-notfound-search', tr('common.notFoundSearch', '去搜索'));
    search.type = 'button';
    search.addEventListener('click', openSearch);
    actions.appendChild(home);
    actions.appendChild(search);
    wrap.appendChild(actions);
    box.appendChild(wrap);
    return null;
  }

  function paint(key) {
    var k = String(key === undefined || key === null ? '' : key);
    var cut = k.indexOf('/');
    var parentId = cut >= 0 ? k.slice(0, cut) : k;
    // 未知一级 id 落到 404（而不是静默回概览）；二级子路由失效仍由 hub 自己兜默认 tab。
    var route = byId[parentId] || byId[NOT_FOUND_ID] || byId[DEFAULT_ID];
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
    // currentId 记完整路由键（含二级）：同一个 hub 换 tab 时 hashchange 必须能识别出差异。
    currentId = cut >= 0 && k.length > cut + 1 ? route.id + '/' + k.slice(cut + 1) : route.id;
    viewBox.setAttribute('data-view', route.id);
    // 视图模块会给容器加自己的类（如 monitor 加 .kore-monitor）；切走时必须还原，
    // 否则上一个视图的类会残留、污染下一个视图的样式与选择器。
    viewBox.className = 'view';
    viewBox.textContent = '';
    try {
      handle = route.render(viewBox) || null;
    } catch (err) {
      viewBox.appendChild(el('div', 'stub', tr('common.viewRenderFailed', '视图渲染失败：{error}',
        { error: err && err.message ? err.message : err })));
    }
    return route;
  }

  // navigate 是唯一入口：先写 hash（可分享 / 可后退），再同步重绘。
  // hashchange 再进来时 compare currentId 已相等 → 不重复 paint，避免双份请求。
  // 接受一级 id（'store'）与二级路由（'store/installed'）；二级缺省由 hub 落第一个 tab。
  function navigate(id) {
    if (isRoot(id)) { rootIntent(); return ''; }
    setDrawer(false, false);
    var raw = String(id === undefined || id === null ? '' : id);
    var parent = normalize(raw), child = subOf(raw);
    if (!byId[parent]) { parent = byId[DEFAULT_ID] ? DEFAULT_ID : ''; child = ''; }
    if (!parent) return '';
    var key = child ? parent + '/' + child : parent;
    var target = '#/' + key;
    if (window.location.hash !== target) window.location.hash = target;
    paint(key);
    return key;
  }

  function onHash() {
    var raw = window.location.hash;
    setDrawer(false, false);
    if (isRoot(raw)) { rootIntent(); return; }
    var key = routeKey(raw);
    // 未知路由不再改写成概览：保留原 hash 交给 paint 落 404 页（用户能看到自己输错了什么）。
    if (!byId[normalize(key)] && !byId[NOT_FOUND_ID]) key = byId[DEFAULT_ID] ? DEFAULT_ID : '';
    if (!key) return;
    if (key === currentId) return;
    paint(key);
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
    btn.appendChild(bindLabel(el('span', 'kore-nav-label'), 'nav.' + route.id, route.label));
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
  // labelKey / label 是该视图的文案键与中文兜底；加载态与失败态用通用键（common.*）。
  function lazyView(globalName, url, labelKey, label) {
    var labelOf = function () { return tr(labelKey, label); };
    return function (box) {
      var live = { destroyed: false, handle: null };
      box.appendChild(el('div', 'stub', tr('common.loadingNamed', '正在加载{name}…', { name: labelOf() })));
      ensureLazy(url, globalName).then(function (mod) {
        if (live.destroyed) return;
        box.textContent = '';
        try {
          var handle = mod.render(box);
          if (handle && typeof handle.destroy === 'function') live.handle = handle;
        } catch (err) {
          box.textContent = '';
          box.appendChild(el('div', 'stub', tr('common.renderFailed', '{name}渲染失败：{error}',
            { name: labelOf(), error: err && err.message ? err.message : err })));
        }
      }, function (err) {
        if (live.destroyed) return;
        box.textContent = '';
        box.appendChild(el('div', 'stub', tr('common.unavailable', '{name}不可用：{error}',
          { name: labelOf(), error: err && err.message ? err.message : tr('common.moduleLoadFailed', '模块加载失败') })));
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

  // hubView 生成一级项 render：渲染 tab 条 + 只挂载当前 tab 的子视图。
  // 子视图全部保持懒加载语义（children[i].render 通常是 view()/moduleView() 包过的），
  // 首次切到某个 tab 才注入它的脚本，首屏请求数与 tab 数无关（FRONTEND §7）。
  function hubView(parentId, children) {
    return function (box) {
      injectHubCss();
      var wrap = el('div', 'kore-hub');
      var tabbar = el('div', 'kore-hub-tabs');
      tabbar.setAttribute('role', 'tablist');
      var body = el('div', 'kore-hub-body');
      wrap.appendChild(tabbar);
      wrap.appendChild(body);
      box.appendChild(wrap);
      var childById = Object.create(null), i;
      for (i = 0; i < children.length; i++) childById[children[i].id] = children[i];
      // 当前 tab 由 hash 第二段决定；不合法（含直接打开一级项）落第一个 tab，
      // 但**不改写 hash**——深链接 #/security 保持干净，用户点 tab 后才出现第二段。
      var activeId = subOf(window.location.hash);
      if (!childById[activeId]) activeId = children[0].id;
      for (i = 0; i < children.length; i++) {
        (function (child) {
          var b = el('button', 'kore-hub-tab');
          b.type = 'button';
          b.setAttribute('role', 'tab');
          b.setAttribute('data-sub', child.id);
          b.setAttribute('aria-selected', child.id === activeId ? 'true' : 'false');
          if (child.id === activeId) b.className += ' is-active';
          b.appendChild(bindLabel(el('span'), child.labelKey || ('nav.' + parentId + '.' + child.id),
            child.label || child.id));
          b.addEventListener('click', function () {
            if (child.id === activeId) return;
            window.location.hash = '#/' + parentId + '/' + child.id; // 只写 hash，重绘交给 onHash 单一路径
          });
          tabbar.appendChild(b);
        })(children[i]);
      }
      var handle = null;
      try {
        handle = childById[activeId].render(body) || null;
      } catch (err) {
        body.appendChild(el('div', 'stub', tr('common.viewRenderFailed', '视图渲染失败：{error}',
          { error: err && err.message ? err.message : err })));
      }
      return {
        destroy: function () {
          if (handle && typeof handle.destroy === 'function') {
            try { handle.destroy(); } catch (err) { /* 子视图清理失败不阻断切视图 */ }
          }
          handle = null;
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
  /* ===== 告警中心入口：首屏只放铃铛 + 红点，alerts.js 懒加载（不进首屏预算） =====
     与搜索入口同一挂点（.conn），app.js 重绘顶栏后由同一 MutationObserver 重新挂回。
     红点只表达「有告警 / 有严重告警」，具体条数与四类来源由 alerts.js 聚合后回传。 */
  var BELL_CSS = '.kore-alert-trigger{position:relative;display:inline-flex;align-items:center;justify-content:center;' +
    'min-width:32px;min-height:32px;padding:0 6px;border:1px solid var(--kore-border-1);border-radius:4px;' +
    'background:var(--kore-bg-2);color:var(--kore-text-2);cursor:pointer}' +
    '.kore-alert-trigger:hover{color:var(--kore-text-1);border-color:var(--kore-text-3)}' +
    '.kore-alert-trigger svg{width:16px;height:16px;flex:0 0 auto}' +
    '.kore-alert-badge{position:absolute;top:-6px;right:-6px;min-width:16px;height:16px;padding:0 4px;' +
    'border-radius:8px;background:var(--kore-danger);color:var(--kore-text-1);font-size:var(--kore-font-12);' +
    'line-height:16px;text-align:center;font-variant-numeric:tabular-nums;' +
    'z-index:var(--z-badge);box-shadow:0 0 0 2px var(--kore-bg-0)}' +
    '.kore-alert-badge.is-warn{background:var(--kore-warning);color:var(--kore-bg-0)}' +
    '.kore-alert-badge[hidden]{display:none}' +
    '@media (max-width:639px){.kore-alert-trigger{min-width:44px;min-height:44px}}';
  function ensureBellCss() {
    if (document.getElementById('kore-alert-trigger-css')) return;
    var s = el('style'); s.id = 'kore-alert-trigger-css'; s.textContent = BELL_CSS;
    document.head.appendChild(s);
  }
  var alertTrigger = null;
  var alertCount = 0;
  var alertCritical = false;
  var alertListening = false;
  function updateAlertBadge(count, critical) {
    alertCount = count || 0;
    alertCritical = !!critical;
    if (!alertTrigger) return;
    var dot = alertTrigger.querySelector('.kore-alert-badge');
    if (!dot) return;
    if (alertCount > 0) {
      dot.hidden = false;
      dot.textContent = alertCount > 99 ? '99+' : String(alertCount);
      dot.className = 'kore-alert-badge' + (alertCritical ? '' : ' is-warn');
      alertTrigger.setAttribute('aria-label', '告警中心（' + alertCount + ' 条，点击查看）');
      alertTrigger.title = alertCount + ' 条告警' + (alertCritical ? '（含严重）' : '');
    } else {
      dot.hidden = true;
      dot.textContent = '';
      alertTrigger.setAttribute('aria-label', '告警中心（无告警）');
      alertTrigger.title = '告警中心';
    }
  }
  function openAlerts() {
    ensureLazy('/assets/alerts.js', 'KoreAlerts', function (mod) {
      return mod && typeof mod.open === 'function';
    }).then(function (mod) {
      mod.open();
    }, function (err) {
      if (alertTrigger) alertTrigger.title = '告警中心不可用：' + (err && err.message ? err.message : '模块加载失败');
    });
  }
  // 首屏之后才加载 alerts.js 探测一次：不占首屏预算，也不做定时轮询。
  function probeAlerts() {
    ensureLazy('/assets/alerts.js', 'KoreAlerts', function (mod) {
      return mod && typeof mod.probe === 'function';
    }).then(function (mod) {
      mod.probe();
    }, function () { /* 探测失败保持无红点，不打扰用户 */ });
  }
  function buildAlertTrigger() {
    if (alertTrigger) return alertTrigger;
    alertTrigger = el('button', 'kore-alert-trigger');
    alertTrigger.type = 'button';
    alertTrigger.id = 'kore-alert-trigger';
    alertTrigger.setAttribute('aria-label', '告警中心（无告警）');
    alertTrigger.setAttribute('aria-haspopup', 'dialog');
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var bell = document.createElementNS(SVG_NS, 'path');
    bell.setAttribute('d', 'M5 8a5 5 0 0 1 10 0c0 4 1.5 5 1.5 5h-13S5 12 5 8z');
    var clapper = document.createElementNS(SVG_NS, 'path');
    clapper.setAttribute('d', 'M8.5 16a1.5 1.5 0 0 0 3 0');
    svg.appendChild(bell);
    svg.appendChild(clapper);
    alertTrigger.appendChild(svg);
    var dot = el('span', 'kore-alert-badge');
    dot.hidden = true;
    alertTrigger.appendChild(dot);
    alertTrigger.addEventListener('click', openAlerts);
    updateAlertBadge(alertCount, alertCritical);
    return alertTrigger;
  }
  function placeAlertTrigger() {
    var top = document.getElementById('kore-topbar');
    if (!top) return;
    var conn = top.querySelector('.conn');
    if (!conn) { setTimeout(placeAlertTrigger, 60); return; }
    var btn = buildAlertTrigger();
    if (btn.parentNode === conn) return;
    // 紧跟在搜索入口之后（同一 .conn 组，手机端与桌面端同一位置）。
    var anchor = searchTrigger && searchTrigger.parentNode === conn ? searchTrigger.nextSibling : conn.firstChild;
    conn.insertBefore(btn, anchor);
  }
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
    searchTrigger.setAttribute('aria-label', tr('common.searchShortcut', '搜索（Ctrl+K）'));
    searchTrigger.setAttribute('aria-haspopup', 'dialog');
    searchTrigger.setAttribute('aria-expanded', 'false');
    searchTrigger.title = tr('common.searchShortcut', '搜索（Ctrl+K）');
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6');
    var c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '8.5'); c.setAttribute('cy', '8.5'); c.setAttribute('r', '5');
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M12.5 12.5 17 17');
    svg.appendChild(c); svg.appendChild(p);
    searchTrigger.appendChild(svg);
    searchTrigger.appendChild(bindLabel(el('span', 'kore-search-trigger-label'), 'common.search', '搜索'));
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
  /* ===== 帮助入口（R8-3）=====
     新用户遇到问题有处求助：顶栏「帮助」按钮打开内置小面板，列常用操作入口 + 下一步。
     不臆造文档站外链——只链仓库里真实存在的文档地址（settings.js 已在用的 repo）；
     面板自包含、首屏不加载（首次点开才建 DOM + 注入样式），手机触摸目标 ≥44px。
     入口复用 .conn 挂点与同一个 MutationObserver，不新增观察器、不碰 Ctrl+K。 */
  var HELP_CSS = '#kore-help-trigger{display:inline-flex;align-items:center;justify-content:center;' +
    'min-width:32px;min-height:32px;padding:0 8px;border:1px solid var(--kore-border-1);border-radius:4px;' +
    'background:var(--kore-bg-2);color:var(--kore-text-2);font:inherit;font-size:12px;cursor:pointer;' +
    'white-space:nowrap}' +
    '#kore-help-trigger:hover{color:var(--kore-text-1);border-color:var(--kore-text-3)}' +
    '#kore-help-trigger svg{width:16px;height:16px;flex:0 0 auto}' +
    '.kore-help-mask{position:fixed;inset:0;z-index:var(--z-modal,1000);background:rgba(0,0,0,.42);' +
    'display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.kore-help-mask[hidden]{display:none}' +
    '.kore-help-panel{width:min(480px,100%);max-height:min(80vh,640px);overflow:auto;' +
    'background:var(--kore-bg-1);color:var(--kore-text-1);border:1px solid var(--kore-border-1);' +
    'border-radius:10px;padding:22px 24px;box-shadow:0 12px 40px rgba(0,0,0,.25)}' +
    '.kore-help-panel h2{font-size:var(--kore-font-18,18px);margin:0 0 16px}' +
    '.kore-help-panel ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}' +
    '.kore-help-panel li button,.kore-help-panel li a{display:flex;align-items:center;justify-content:space-between;' +
    'width:100%;min-height:44px;padding:10px 14px;border:1px solid var(--kore-border-1);border-radius:6px;' +
    'background:var(--kore-bg-2);color:var(--kore-text-1);font:inherit;font-size:14px;text-align:left;' +
    'text-decoration:none;cursor:pointer}' +
    '.kore-help-panel li button:hover,.kore-help-panel li a:hover{border-color:var(--kore-primary,#2563eb)}' +
    '.kore-help-panel li span{color:var(--kore-text-3);font-size:12px}' +
    '.kore-help-foot{margin:18px 0 0;font-size:12px;color:var(--kore-text-3);line-height:1.6}' +
    '@media (max-width:639px){#kore-help-trigger{min-width:44px;min-height:44px}}';
  var helpTrigger = null;
  var helpMask = null;
  function ensureHelpCss() {
    if (document.getElementById('kore-help-css')) return;
    var s = el('style'); s.id = 'kore-help-css'; s.textContent = HELP_CSS;
    document.head.appendChild(s);
  }
  function closeHelp() {
    if (helpMask) helpMask.hidden = true;
    if (helpTrigger) helpTrigger.setAttribute('aria-expanded', 'false');
  }
  function buildHelpPanel() {
    if (helpMask) return;
    ensureHelpCss();
    helpMask = el('div', 'kore-help-mask');
    helpMask.id = 'kore-help-mask';
    helpMask.hidden = true;
    var panel = el('div', 'kore-help-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', tr('common.helpTitle', '帮助与常用操作'));
    panel.appendChild(el('h2', null, tr('common.helpTitle', '帮助与常用操作')));
    var list = el('ul');
    var items = [
      [tr('common.helpOverview', '回到概览'), tr('common.helpOverviewHint', '看本机整体状态'), function () { closeHelp(); navigate(DEFAULT_ID); }],
      [tr('common.helpSearch', '搜索功能或设置'), tr('common.helpSearchHint', '快捷键 Ctrl+K'), function () { closeHelp(); openSearch(); }],
      [tr('common.helpNav', '查看所有功能'), tr('common.helpNavHint', '左侧导航 / 手机「更多」'), function () { closeHelp(); var m = document.querySelector('.kore-nav-more'); if (m) m.click(); }]
    ];
    for (var i = 0; i < items.length; i++) {
      var li = el('li');
      var btn = el('button', null, items[i][0]);
      btn.type = 'button';
      btn.appendChild(el('span', null, items[i][1]));
      btn.addEventListener('click', items[i][2]);
      li.appendChild(btn);
      list.appendChild(li);
    }
    // 外链只用仓库里真实存在的文档地址（与 settings.js 的 repo 一致），不臆造文档站。
    var docLi = el('li');
    var doc = el('a', null, tr('common.helpDocs', '查看项目文档'));
    doc.href = 'https://github.com/pengtang1024/kore';
    doc.target = '_blank';
    doc.rel = 'noopener noreferrer';
    doc.appendChild(el('span', null, 'GitHub'));
    docLi.appendChild(doc);
    list.appendChild(docLi);
    panel.appendChild(list);
    panel.appendChild(el('p', 'kore-help-foot',
      tr('common.helpFoot', '找不到想要的功能？试试搜索，或到概览页查看本机状态。')));
    helpMask.appendChild(panel);
    helpMask.addEventListener('click', function (ev) { if (ev.target === helpMask) closeHelp(); });
    document.body.appendChild(helpMask);
  }
  function openHelp() {
    ensureHelpCss();
    buildHelpPanel();
    if (helpMask) helpMask.hidden = false;
    if (helpTrigger) helpTrigger.setAttribute('aria-expanded', 'true');
  }
  function buildHelpTrigger() {
    if (helpTrigger) return helpTrigger;
    ensureHelpCss();
    helpTrigger = el('button', 'kore-help-trigger');
    helpTrigger.type = 'button';
    helpTrigger.id = 'kore-help-trigger';
    helpTrigger.setAttribute('aria-label', tr('common.helpTitle', '帮助与常用操作'));
    helpTrigger.setAttribute('aria-haspopup', 'dialog');
    helpTrigger.setAttribute('aria-expanded', 'false');
    helpTrigger.title = tr('common.helpTitle', '帮助与常用操作');
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6');
    var c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '10'); c.setAttribute('cy', '10'); c.setAttribute('r', '7.2');
    var q = document.createElementNS(SVG_NS, 'path');
    q.setAttribute('d', 'M8.2 8a1.9 1.9 0 1 1 2.6 1.8c-.8.4-1 1-1 1.8');
    var dot = document.createElementNS(SVG_NS, 'path');
    dot.setAttribute('d', 'M9.8 14h.01');
    svg.appendChild(c); svg.appendChild(q); svg.appendChild(dot);
    helpTrigger.appendChild(svg);
    helpTrigger.appendChild(bindLabel(el('span', null), 'common.help', '帮助'));
    helpTrigger.addEventListener('click', openHelp);
    return helpTrigger;
  }
  function placeHelpTrigger() {
    var top = document.getElementById('kore-topbar');
    if (!top) return;
    var conn = top.querySelector('.conn');
    if (!conn) { setTimeout(placeHelpTrigger, 60); return; }
    var btn = buildHelpTrigger();
    // 紧跟体验入口之后（连接器组末尾），手机端宽度不足时由 .conn 横向滚动兜住。
    if (btn.parentNode !== conn) conn.appendChild(btn);
  }

  /* ===== 个性化体验入口：主题三选一 / 快捷键帮助 / 新手引导（R6-4/5/6 接线）=====
     三组件懒加载、不进首屏六件套。主壳首屏渲染后按 theme → shortcuts → onboarding 顺序注入
     （文件头对齐结论：onboarding 外观步骤调 KoreTheme.toggle()、shortcuts 帮助面板引用
     KoreTheme 与 KoreOnboarding，故 theme 最先、onboarding 最后；各引用均作存在性判断）。
     入口控件与搜索/告警共用 .conn 挂点，app.js 重绘顶栏后由同一 MutationObserver 重新挂回。 */
  var EXPERIENCE_CSS = '.kore-theme-select{height:32px;padding:0 6px;border:1px solid var(--kore-border-1);' +
    'border-radius:4px;background:var(--kore-bg-2);color:var(--kore-text-2);font-size:12px;cursor:pointer}' +
    '#kore-shortcut-trigger,.kore-onboarding-trigger{display:inline-flex;align-items:center;justify-content:center;' +
    'min-width:32px;min-height:32px;padding:0 8px;border:1px solid var(--kore-border-1);border-radius:4px;' +
    'background:var(--kore-bg-2);color:var(--kore-text-2);font-size:12px;cursor:pointer;white-space:nowrap}' +
    '#kore-shortcut-trigger:hover,.kore-onboarding-trigger:hover{color:var(--kore-text-1);border-color:var(--kore-text-3)}' +
    '.kore-experience-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:var(--z-modal,1000);' +
    'padding:10px 18px;border:1px solid var(--kore-border-1);border-radius:6px;background:var(--kore-bg-1);' +
    'color:var(--kore-text-1);font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.2)}' +
    '.kore-experience-toast[hidden]{display:none}' +
    '@media (max-width:639px){.kore-theme-select{max-width:88px}' +
    '#kore-shortcut-trigger,.kore-onboarding-trigger{min-width:44px;min-height:44px}}';
  var themeSelect = null;
  var expTrigger = null;
  var onboardTrigger = null;
  var experienceListening = false;
  var experienceBooted = false;

  function ensureExperienceCss() {
    if (document.getElementById('kore-experience-css')) return;
    var s = el('style'); s.id = 'kore-experience-css'; s.textContent = EXPERIENCE_CSS;
    document.head.appendChild(s);
  }
  // 组件 CSS 按需注入（theme.css 不在首屏六件套；shortcuts/onboarding 各自会注入自身样式）。
  function injectCssOnce(url, id) {
    if (document.getElementById(id)) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = url; link.id = id;
    document.head.appendChild(link);
  }
  function koreToast(msg) {
    var t = document.getElementById('kore-experience-toast');
    if (!t) { t = el('div', 'kore-experience-toast'); t.id = 'kore-experience-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    if (koreToast._timer) clearTimeout(koreToast._timer);
    koreToast._timer = setTimeout(function () { t.hidden = true; }, 2200);
  }
  // 打开引导：onboarding 可能尚未就绪（帮助面板里的回调可先于其加载完成触发），按需懒加载。
  // 安装一次性引导的权威状态在服务端（/-/onboarding，公开只读），不在 localStorage。
  // 首屏探测一次：清缓存 / 换浏览器 / 重登都改不到服务端标记，因此不会重复自动弹。
  // 读取失败一律按"不自动弹"处理，绝不因网络抖动误触发；手动 open() 入口不受影响。
  function fetchInstallState() {
    return new Promise(function (resolve) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 4000) : null;
      var init = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
      if (ctrl) init.signal = ctrl.signal;
      fetch('/-/onboarding', init).then(function (res) {
        return res.ok ? res.json() : null;
      }).then(function (body) {
        if (timer !== null) clearTimeout(timer);
        resolve(body && body.data ? body.data : null);
      }, function () {
        if (timer !== null) clearTimeout(timer);
        resolve(null);
      });
    });
  }

  function openOnboarding(reset) {
    ensureLazy('/assets/onboarding.js', 'KoreOnboarding', function (m) { return m && typeof m.mount === 'function'; })
      .then(function (ob) {
        if (reset && typeof ob.reset === 'function') ob.reset();
        else if (typeof ob.open === 'function') ob.open();
      }, function () { koreToast('新手引导暂时无法加载，请稍后再试'); });
  }
  // 三个入口各自幂等懒建：任一组件先加载完就先建自己那个，不被其它组件缺席阻塞。
  function buildThemeSelect() {
    if (themeSelect || !window.KoreTheme) return;
    var theme = window.KoreTheme;
    themeSelect = el('select', 'kore-theme-select');
    themeSelect.id = 'kore-theme-select';
    themeSelect.setAttribute('aria-label', '外观');
    themeSelect.title = '外观设置';
    var opts = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']];
    for (var i = 0; i < opts.length; i++) {
      var o = document.createElement('option');
      o.value = opts[i][0]; o.textContent = opts[i][1];
      themeSelect.appendChild(o);
    }
    themeSelect.value = typeof theme.get === 'function' ? theme.get() : 'system';
    themeSelect.addEventListener('change', function () {
      if (typeof theme.set === 'function') theme.set(themeSelect.value);
    });
    if (typeof theme.onChange === 'function') {
      theme.onChange(function (p) { if (p && p.mode) themeSelect.value = p.mode; });
    }
  }
  function buildShortcutTrigger() {
    if (expTrigger || !window.KoreShortcuts) return;
    if (typeof window.KoreShortcuts.createTrigger !== 'function') return;
    expTrigger = window.KoreShortcuts.createTrigger(); // 组件自带「快捷键」文案 + 点击开帮助
  }
  function buildOnboardTrigger() {
    if (onboardTrigger || !window.KoreOnboarding) return;
    onboardTrigger = el('button', 'kore-onboarding-trigger', '新手引导');
    onboardTrigger.type = 'button';
    onboardTrigger.id = 'kore-onboarding-trigger';
    onboardTrigger.title = '重新查看新手引导';
    onboardTrigger.setAttribute('aria-label', '重新查看新手引导');
    onboardTrigger.addEventListener('click', function () { openOnboarding(true); });
  }
  function buildExperienceEntries() {
    buildThemeSelect(); buildShortcutTrigger(); buildOnboardTrigger();
  }
  function placeExperienceEntries() {
    var top = document.getElementById('kore-topbar');
    if (!top) return;
    var conn = top.querySelector('.conn');
    if (!conn) { setTimeout(placeExperienceEntries, 60); return; }
    buildExperienceEntries();
    if (themeSelect && themeSelect.parentNode !== conn) conn.appendChild(themeSelect);
    if (expTrigger && expTrigger.parentNode !== conn) conn.appendChild(expTrigger);
    if (onboardTrigger && onboardTrigger.parentNode !== conn) conn.appendChild(onboardTrigger);
  }
  // shortcuts 派发的三个事件：做实际动作或明确降级，杜绝"按了没反应"。
  function installShortcutEvents() {
    if (experienceListening) return;
    experienceListening = true;
    // Mod+S：Kore 各视图表单即时保存、无全局草稿；给可见反馈即为明确降级。
    document.addEventListener('kore:shortcut-save', function () {
      koreToast('当前页面内容已自动保存，无需手动保存');
    });
    // Mod+Shift+X：依次关引导 / 帮助浮层 / 抽屉（各自幂等）；无面板可关时给提示。
    document.addEventListener('kore:shortcut-close', function () {
      var acted = false;
      if (window.KoreOnboarding && typeof window.KoreOnboarding.isOpen === 'function' && window.KoreOnboarding.isOpen()) {
        window.KoreOnboarding.close(); acted = true;
      }
      if (window.KoreShortcuts && typeof window.KoreShortcuts.closeHelp === 'function') {
        window.KoreShortcuts.closeHelp(); acted = true;
      }
      if (drawerOpen) { setDrawer(false, true); acted = true; }
      if (!acted) koreToast('当前没有需要关闭的面板');
    });
    // 帮助浮层开/关：仅同步顶栏触发按钮的 aria-expanded，不改浮层自身行为。
    document.addEventListener('kore:shortcut-help', function (ev) {
      if (!expTrigger) return;
      var open = !!(ev && ev.detail && ev.detail.open);
      expTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  // 主壳渲染后按 theme → shortcuts → onboarding 顺序 mount；每步失败只降级该组件，不阻断后续。
  function bootExperience() {
    if (experienceBooted) return;
    experienceBooted = true;
    ensureExperienceCss();
    installShortcutEvents();
    var noop = function () {};
    ensureLazy('/assets/theme.js', 'KoreTheme', function (m) { return m && typeof m.set === 'function'; })
      .then(function () { injectCssOnce('/assets/theme.css', 'kore-theme-css'); }, noop)
      .then(function () { return ensureLazy('/assets/shortcuts.js', 'KoreShortcuts', function (m) { return m && typeof m.mount === 'function'; }); }, noop)
      .then(function (sc) {
        if (sc && typeof sc.mount === 'function') sc.mount({
          onboardingAction: function () { openOnboarding(false); },
          onboardingLabel: '重新查看新手引导'
        });
      }, noop)
      .then(function () { return ensureLazy('/assets/onboarding.js', 'KoreOnboarding', function (m) { return m && typeof m.mount === 'function'; }); }, noop)
      .then(function (ob) {
        return fetchInstallState().then(function (st) {
          if (ob && typeof ob.mount === 'function') ob.mount({ autoOpen: true, installState: st });
        });
      }, noop)
      .then(function () { buildExperienceEntries(); placeExperienceEntries(); }, noop);
  }

  function watchTopbar() {
    ensureSearchCss();
    ensureBellCss();
    ensureExperienceCss();
    placeSearchTrigger();
    placeAlertTrigger();
    placeExperienceEntries();
    placeHelpTrigger();
    if (!window.MutationObserver) return;
    if (searchObserver) searchObserver.disconnect();
    var top = document.getElementById('kore-topbar');
    if (!top) return;
    searchObserver = new MutationObserver(function () {
      placeSearchTrigger(); placeAlertTrigger(); placeExperienceEntries(); placeHelpTrigger();
    });
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
      // 带 children 的一级项自己没有 render（render 由下方 hubView 生成），不能在这一步被筛掉；
      // 否则「任务 → tab」的 hub 会整体从导航消失（只剩有 render 的几项）。
      var hasChildren = !!(r && r.children && r.children.length);
      if (!r || typeof r.id !== 'string' || !r.id || (typeof r.render !== 'function' && !hasChildren)) continue;
      items.push(r);
    }
    // 一级项自报 children 时，把 render 包成 hub（tab 条 + 当前 tab 子视图）。
    // 这里不再内置任何插件视图：以前 mount 会补 16 个「免得漏项」的兜底路由，
    // 导致导航=插件清单的线性投影（24 项）。现在清单由 app.js 一处声明，漏项在 code review 就暴露。
    for (var c = 0; c < items.length; c++) {
      var it = items[c];
      if (it && it.children && it.children.length) {
        it.render = hubView(it.id, it.children);
      }
    }
    var host = document.getElementById('app');
    if (!items.length || !host) return null;

    byId = Object.create(null);
    navButtons = Object.create(null);
    labelBindings = [];
    attrBindings = [];
    watchLocale();
    releaseHandle();
    moreBtn = null; drawer = null; backdrop = null; drawerOpen = false;
    currentId = '';

    var shell = el('div', 'kore-shell');
    var nav = el('nav', 'kore-nav');
    bindAttr(nav, 'aria-label', 'nav.mainLabel', '主导航');
    var brand = el('div', 'kore-nav-brand');
    brand.appendChild(el('span', 'kore-nav-brand-name', 'Kore'));
    brand.appendChild(bindLabel(el('span', 'kore-nav-brand-sub'), 'nav.brandSub', '控制台'));
    nav.appendChild(brand);

    for (var j = 0; j < items.length; j++) {
      var route = {
        id: items[j].id,
        label: items[j].label || items[j].id,
        render: items[j].render,
        extra: j >= 5
      };
      byId[route.id] = route;
      var btn = navItem(route, false);
      navButtons[route.id] = [btn];
      nav.appendChild(btn);
    }
    // 友好 404：隐藏路由（不在 items、不进导航），专收未知一级视图；render 每次重画错误页。
    // 关键：注册后 byId['404'] 存在，app.js 的 navigate(current()) 刷新会留在 404 而非弹回概览。
    byId[NOT_FOUND_ID] = { id: NOT_FOUND_ID, label: '页面不存在', render: renderNotFound, extra: false };

    var extras = items.slice(5);
    if (extras.length) {
      moreBtn = el('button', 'kore-nav-item kore-nav-more');
      moreBtn.type = 'button';
      moreBtn.setAttribute('aria-haspopup', 'true');
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.setAttribute('aria-controls', 'kore-more-drawer');
      moreBtn.appendChild(navIcon('more'));
      moreBtn.appendChild(bindLabel(el('span', 'kore-nav-label'), 'nav.more', '更多'));
      bindAttr(moreBtn, 'aria-label', 'nav.more', '更多');
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
      bindAttr(drawer, 'aria-label', 'nav.drawerLabel', '更多导航');
      // 手机端侧栏品牌块让位给底部 tab bar，抽屉里补一处品牌标题，产品名仍是「Kore」。
      var drawerHead = el('div', 'kore-nav-drawer-head');
      drawerHead.appendChild(el('span', 'kore-nav-brand-name', 'Kore'));
      drawerHead.appendChild(bindLabel(el('span', 'kore-nav-brand-sub'), 'nav.moreTitle', '更多导航'));
      drawer.appendChild(drawerHead);
      for (var k = 0; k < extras.length; k++) {
        var extraRoute = byId[extras[k].id];
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
    if (!alertListening) {
      document.addEventListener('kore:alerts-count', function (ev) {
        var d = (ev && ev.detail) || {};
        updateAlertBadge(d.count, d.critical);
      });
      alertListening = true;
    }
    watchTopbar();
    // 首屏渲染完成后按顺序懒加载并 mount 三组件（theme→shortcuts→onboarding），
    // 再挂顶栏入口；全程不进首屏六件套，失败只降级对应组件。
    bootExperience();
    // 首屏渲染完成后懒探测一次告警；不做 setInterval，打开面板时 alerts.js 会再查。
    setTimeout(probeAlerts, 800);
    if (!drawerListening) {
      document.addEventListener('keydown', onDrawerKey);
      drawerListening = true;
    }
    paint(routeKey(window.location.hash)); // 深链接：登录后打开 #/store 或 #/security/dns 直接落到该视图
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

  // view 是一级项 children 的渲染工厂：与内置 lazyView 同语义（懒注入 / 失败可重试 / destroy 兑现），
  // 供 app.js 在声明「任务 → tab」时复用，避免导航清单再分裂成 shell 与 app 两处。
  window.KoreShell = { mount: mount, navigate: navigate, current: current, openConfig: openConfig, view: lazyView };
})();
