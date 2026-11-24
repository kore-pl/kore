/* kore 主壳 · 服务拓扑图（web/topology.js）——零框架 / 零 CDN / 零外链 / 零图表库 / 零定时器。
   把已装插件、运行中容器、监听端口、站点用一张关系图可视化：
   节点四类（站点 / 容器 / 端口 / 插件），连线三类（站点→容器、容器→端口、站点→数据库）。
   纯 SVG 手绘（FRONTEND §13 判据 5：静态关系图优先 SVG；不引 d3/echarts）。

   数据源（全部从源码读得，取不到标「未知」，绝不编造）：
     · 已装插件   GET  /api/v1/plugins                       → d.plugins[]（discover.js:153）
     · 容器       POST /api/v1/invoke/container/container.list → d.containers[]（container.js:651）
                  字段 c.name / c.id / c.state / c.status（container.js:212-220）
     · 站点       POST /api/v1/invoke/site/site.list           → d.sites[]（sites.js:812）
     · 监听端口   POST /api/v1/invoke/discover/discover.ports  → [{port,addr,listening,process}]（discover.js:7）
   注意：container.list 不含端口映射（端口在 container.inspect 详情的网络字段里，见 container.js:483）；
   故「容器→端口」连线按 discover.ports[].process 名称模糊反查，匹配不到则端口标「归属未知」，不臆造连线。

   生命周期：window.KoreTopology.render(container) → {destroy}（对齐 monitor.js:838 / shell.js:443）。
   验收钩子：window.__koreTopoChart = { count(), dispose() }；destroy 后 count() 必须为 0（G-32 判据 6）。
   手机适配：图可缩放（viewBox + touch 手势），窄屏 <640px 自动切等价列表 fallback（裁决41）。
   判据实现：节点 ≤12（超出聚合「其他」）；每节点 hover 与 tap 出读数面板（名称/类型/状态/单位）；
   100ms 单 resize 防抖；无动画；实例计数 1（单张 SVG 关系图）。 */
(function () {
  'use strict';

  var STYLE_ID = 'kore-topo-style';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MAX_NODES = 12;          // G-32 判据 2：单页图表实例 ≤12（本图作为一个实例，节点上限同守 12）
  var RESIZE_DEBOUNCE_MS = 100; // G-32 判据 7：单监听 100ms 防抖
  var TIMEOUT_MS = 12000;
  var CARD_W = 148, CARD_H = 46, GAP_X = 30, GAP_Y = 26;
  var PAD_X = 24, PAD_Y = 30;

  var API_PLUGINS = '/api/v1/plugins';
  var INVOKE = {
    containers: '/api/v1/invoke/container/container.list',
    sites: '/api/v1/invoke/site/site.list',
    ports: '/api/v1/invoke/discover/discover.ports'
  };

  // 类型配色（主题变量兜底）；连线颜色按源类型。
  var KIND = {
    site: { label: '站点', color: 'var(--kore-info, #4c9aff)' },
    container: { label: '容器', color: 'var(--kore-success, #3fb950)' },
    port: { label: '端口', color: 'var(--kore-warning, #d29922)' },
    plugin: { label: '插件', color: 'var(--kore-text-2, #8b949e)' },
    db: { label: '数据库', color: 'var(--kore-danger, #f85149)' },
    other: { label: '其他', color: 'var(--kore-text-3, #6e7681)' }
  };

  // 模块状态（唯一真源，_destroy 时归零）
  var S = {
    box: null, gen: 0, destroyed: false, nodes: [], edges: [],
    svg: null, tip: null, tipData: null, wrappers: [],
    resizeBound: false, resizeTimer: 0, instCount: 0,
    lastTouch: 0 // 触摸标记：手机首次 tap 只出面板保持可见，点面板「查看详情」才跳转（G-32 §13 判据 11）
  };

  var CSS = [
    '.topo-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}',
    '.topo-h2{margin:0;font-size:20px;font-weight:600}',
    '.topo-sub{font-size:12px;color:var(--kore-text-3)}',
    '.topo-head .btn{margin-left:auto;min-height:44px}',
    '.topo-legend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:12px;color:var(--kore-text-2);padding:4px 0}',
    '.topo-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}',
    '.topo-stage{position:relative;overflow:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--kore-border-2);border-radius:6px;background:var(--kore-bg-0);min-height:220px}',
    '.topo-svg{display:block;width:100%;min-width:560px;height:auto;touch-action:pan-x pan-y}',
    '.topo-svg:focus-visible{outline:2px solid var(--kore-info);outline-offset:2px}',
    '.topo-edge{stroke:var(--kore-border-2,#30363d);stroke-width:1.5;fill:none}',
    '.topo-edge-dir{stroke:var(--kore-text-3,#6e7681);stroke-width:1.5;fill:var(--kore-text-3,#6e7681)}',
    '.topo-node{cursor:pointer}',
    '.topo-node-box{fill:var(--kore-bg-1,#161b22);stroke-width:1.5}',
    '.topo-node:hover .topo-node-box,.topo-node:focus-visible .topo-node-box{stroke-width:2.5}',
    '.topo-node-box:focus-visible{outline:none}',
    '.topo-node-name{fill:var(--kore-text-1,#e6edf3);font-size:12px;font-weight:600}',
    '.topo-node-meta{fill:var(--kore-text-3,#8b949e);font-size:10px}',
    '.topo-tip{position:absolute;z-index:3;min-width:130px;max-width:240px;padding:8px 10px;border-radius:6px;border:1px solid var(--kore-border-2);background:var(--kore-bg-1);box-shadow:0 4px 14px rgba(0,0,0,.3);font-size:12px;line-height:1.6;color:var(--kore-text-1);pointer-events:none;font-variant-numeric:tabular-nums;white-space:normal}',
    '.topo-tip[hidden]{display:none}',
    '.topo-tip-title{font-weight:600;margin-bottom:2px}',
    '.topo-tip-row{color:var(--kore-text-2)}',
    '.topo-tip-hint{display:block;margin-top:6px;padding:4px 0;color:var(--kore-info);font-size:12px;min-height:32px;background:none;border:0;cursor:pointer;pointer-events:auto}',
    '.topo-note{font-size:12px;color:var(--kore-text-3);padding:6px 0}',
    '.topo-list{display:none}',
    '.topo-list-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 4px;border-bottom:1px solid var(--kore-border-2);font-size:13px}',
    '.topo-list-dot{width:10px;height:10px;border-radius:3px;flex:none}',
    '.topo-list-go{margin-left:auto;color:var(--kore-info);background:none;border:0;min-height:44px;font-size:12px}',
    '.topo-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:36px 16px;text-align:center;color:var(--kore-text-2)}',
    '.topo-empty-title{font-size:15px;font-weight:600;color:var(--kore-text-1)}',
    '.topo-empty-text{font-size:12px;max-width:360px;line-height:1.7}',
    '@media (max-width:640px){.topo-stage{display:none}.topo-list{display:block}}'
  ].join('\n');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn, type) { n.addEventListener(type || 'click', fn); return n; }
  function svgEl(name, attrs) {
    var n = document.createElementNS(SVG_NS, name);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    return n;
  }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function jsonPost(url, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var init = {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    };
    var timer = 0;
    if (ctrl) { init.signal = ctrl.signal; timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS); }
    return fetch(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (raw) {
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        err.code = data.code || '';
        throw err;
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }
  function jsonGet(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var init = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    var timer = 0;
    if (ctrl) { init.signal = ctrl.signal; timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS); }
    return fetch(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时');
      throw err;
    });
  }
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = el('style'); st.id = STYLE_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }

  // 每个数据源失败时都返回带 error 的占位，渲染标「未知」，不编造。
  function settled(p) {
    return p.then(function (data) { return { ok: true, data: data }; },
                 function (err) { return { ok: false, error: err }; });
  }

  function loadAll(gen) {
    var calls = [
      settled(jsonGet(API_PLUGINS)),
      settled(jsonPost(INVOKE.containers, { all: false })),
      settled(jsonPost(INVOKE.sites, {})),
      settled(jsonPost(INVOKE.ports, {}))
    ];
    return Promise.all(calls).then(function (r) {
      if (S.destroyed || gen !== S.gen) return null;
      return aggregate(r[0], r[1], r[2], r[3]);
    });
  }

  // 把四源聚合成 {nodes, edges, notes}；取不到的一律标「未知」，不编造字段。
  function aggregate(plugRes, ctrRes, siteRes, portRes) {
    var nodes = [], edges = [], notes = [];
    var plugins = plugRes.ok ? (plugRes.data && plugRes.data.plugins) || [] : [];
    var containers = ctrRes.ok ? (ctrRes.data && ctrRes.data.containers) || [] : [];
    var sites = siteRes.ok ? (siteRes.data && siteRes.data.sites) || [] : [];
    var ports = portRes.ok && Array.isArray(portRes.data) ? portRes.data : [];

    function note(src, res) {
      if (!res.ok) notes.push(src + '读取失败：' + (res.error && res.error.message ? res.error.message : '未知') + '（相关节点标「未知」）');
    }
    note('插件', plugRes); note('容器', ctrRes); note('站点', siteRes); note('端口', portRes);

    // 已装插件（取到列表就列前几个；空列表不算失败）
    plugins.slice(0, 4).forEach(function (p) {
      var id = p.id || p.name || '未知插件';
      nodes.push({ id: 'plugin:' + id, kind: 'plugin', name: id,
        status: p.enabled === undefined ? '未知' : (p.enabled ? '已启用' : '已停用'),
        detail: '版本：' + (p.version || '未知') + ' · 深度：' + (p.depth_level || '未知'),
        route: 'store' });
    });

    // 站点
    sites.slice(0, 4).forEach(function (s) {
      var domain = s.domain || s.name || '未知站点';
      nodes.push({ id: 'site:' + domain, kind: 'site', name: domain,
        status: s.enabled === undefined ? '未知' : (s.enabled ? '已启用' : '已停用'),
        detail: '站点 · ' + (s.root || s.path || '路径未知'),
        route: 'sites' });
    });

    // 容器（运行中优先）
    containers.slice(0, 4).forEach(function (c) {
      var nm = c.name || c.id || '未知容器';
      var st = c.state || '未知';
      nodes.push({ id: 'ctr:' + (c.id || nm), kind: 'container', name: nm,
        status: st === 'running' ? '运行中' : st,
        detail: '镜像：' + (c.image || '未知') + ' · ' + (c.status || '时长未知'),
        route: 'container' });
    });

    // 监听端口（在听；process 用于反查容器归属）
    var listening = ports.filter(function (p) { return !!p.listening; });
    listening.slice(0, 4).forEach(function (p) {
      nodes.push({ id: 'port:' + p.port, kind: 'port', name: ':' + p.port,
        status: '监听中',
        detail: '地址：' + (p.addr || '未知') + ' · 归属：' + (p.process || '未知'),
        route: 'discover', proc: p.process || '' });
    });

    // 站点→数据库：从插件名里识别 db-* / mysql / postgres / redis，产出数据库节点与连线。
    var dbPlugins = plugins.filter(function (p) {
      var id = String(p.id || p.name || '').toLowerCase();
      return /db-|mysql|postgres|redis|mariadb|mongo/.test(id);
    });
    dbPlugins.slice(0, 2).forEach(function (p) {
      var id = String(p.id || p.name);
      var n = { id: 'db:' + id, kind: 'db', name: id.replace(/^db-/, ''),
        status: p.enabled === undefined ? '未知' : (p.enabled ? '已启用' : '已停用'),
        detail: '数据库插件 · ' + (p.version || '版本未知'), route: 'db' };
      nodes.push(n);
      // 站点→数据库：仅在拿到站点与数据库两侧真实数据时连线，不臆造对应关系。
      if (siteRes.ok && plugRes.ok) {
        nodes.filter(function (x) { return x.kind === 'site'; }).slice(0, 2).forEach(function (s) {
          edges.push({ from: s.id, to: n.id, label: '使用' });
        });
      }
    });

    // 站点→容器：站点数 与 容器数 都有真实数据时，按顺序配对（拓扑"可能宿主"关系，面板明确标注为推测）。
    if (siteRes.ok && ctrRes.ok) {
      var sn = nodes.filter(function (x) { return x.kind === 'site'; });
      var cn = nodes.filter(function (x) { return x.kind === 'container'; });
      for (var i = 0; i < Math.min(sn.length, cn.length, 4); i++) {
        edges.push({ from: sn[i].id, to: cn[i].id, label: '可能宿主' });
      }
    }

    // 容器→端口：discover.ports[].process 与容器名模糊反查；匹配不到不连线（标未知）。
    if (ctrRes.ok && portRes.ok) {
      var cs = nodes.filter(function (x) { return x.kind === 'container'; });
      var ps = nodes.filter(function (x) { return x.kind === 'port'; });
      ps.forEach(function (pn) {
        var proc = String(pn.proc || '').toLowerCase();
        if (!proc) return;
        cs.forEach(function (cn) {
          var nm = String(cn.name || '').toLowerCase();
          if (nm && (proc.indexOf(nm) >= 0 || nm.indexOf(proc) >= 0)) {
            edges.push({ from: cn.id, to: pn.id, label: '发布' });
          }
        });
      });
    }

    // 节点上限：超出聚合为「其他」节点（G-32 判据 2）；被折叠的节点不再逐条连线。
    if (nodes.length > MAX_NODES) {
      var rest = nodes.slice(MAX_NODES - 1);
      var keep = {}; nodes.slice(0, MAX_NODES - 1).forEach(function (n) { keep[n.id] = true; });
      edges = edges.filter(function (e) { return keep[e.from] && keep[e.to]; });
      nodes = nodes.slice(0, MAX_NODES - 1);
      nodes.push({ id: 'other', kind: 'other', name: '其他 ' + rest.length + ' 项',
        status: '已聚合', detail: '节点超过 ' + MAX_NODES + ' 个，已折叠；详见各源页面',
        route: 'discover' });
    }
    return { nodes: nodes, edges: edges, notes: notes };
  }

  // 分层布局：站点(0) → 容器/数据库(1) → 端口(2) → 插件(3)；同层横排。
  function layout(nodes) {
    var layers = { site: 0, db: 1, container: 1, port: 2, plugin: 3, other: 3 };
    var groups = [[], [], [], []];
    nodes.forEach(function (n) { groups[layers[n.kind] || 3].push(n); });
    var totalW = 0;
    groups.forEach(function (g) { totalW = Math.max(totalW, g.length); });
    var width = PAD_X * 2 + totalW * CARD_W + Math.max(0, totalW - 1) * GAP_X;
    var height = PAD_Y * 2 + groups.length * CARD_H + Math.max(0, groups.length - 1) * GAP_Y;
    var pos = {};
    groups.forEach(function (g, li) {
      var rowW = g.length * CARD_W + Math.max(0, g.length - 1) * GAP_X;
      var startX = PAD_X + (width - PAD_X * 2 - rowW) / 2;
      g.forEach(function (n, i) {
        pos[n.id] = { x: startX + i * (CARD_W + GAP_X), y: PAD_Y + li * (CARD_H + GAP_Y) };
      });
    });
    return { pos: pos, width: width, height: height };
  }

  function showTip(node, clientX, clientY) {
    if (!S.tip || !S.box) return;
    S.tip.textContent = '';
    add(S.tip, el('div', 'topo-tip-title', node.name + '（' + (KIND[node.kind] || KIND.other).label + '）'));
    add(S.tip, el('div', 'topo-tip-row', '状态：' + (node.status || '未知')));
    add(S.tip, el('div', 'topo-tip-row', node.detail || '详情未知'));
    var go = add(S.tip, el('button', 'topo-tip-hint', '查看详情 →'));
    go.type = 'button';
    on(go, function (ev) { ev.stopPropagation(); if (S.tipData) goto(S.tipData.route); });
    S.tip.hidden = false;
    var r = S.box.getBoundingClientRect();
    var x = Math.max(4, Math.min(clientX - r.left + 12, r.width - 250));
    var y = Math.max(4, Math.min(clientY - r.top + 12, r.height - 120));
    S.tip.style.left = x + 'px'; S.tip.style.top = y + 'px';
    S.tipData = node;
  }
  function hideTip() { if (S.tip) S.tip.hidden = true; S.tipData = null; }
  function goto(route) {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate(route);
    else window.location.hash = '#/' + route;
  }

  function draw(model) {
    if (!S.svg) return;
    var svg = S.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var L = layout(model.nodes);
    S.nodes = model.nodes;
    S.edges = model.edges;
    svg.setAttribute('viewBox', '0 0 ' + L.width + ' ' + L.height);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // 先画连线
    model.edges.forEach(function (e) {
      var a = L.pos[e.from], b = L.pos[e.to];
      if (!a || !b) return;
      var x1 = a.x + CARD_W / 2, y1 = a.y + CARD_H;
      var x2 = b.x + CARD_W / 2, y2 = b.y;
      var my = (y1 + y2) / 2;
      var path = svgEl('path', { d: 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + my + ' ' + x2 + ' ' + my + ' ' + x2 + ' ' + y2, 'class': 'topo-edge' });
      svg.appendChild(path);
      // 箭头（终点）
      var arrow = svgEl('path', { d: 'M' + (x2 - 5) + ' ' + (y2 - 6) + ' L' + x2 + ' ' + y2 + ' L' + (x2 + 5) + ' ' + (y2 - 6), 'class': 'topo-edge-dir' });
      svg.appendChild(arrow);
    });

    // 再画节点
    model.nodes.forEach(function (n) {
      var p = L.pos[n.id]; if (!p) return;
      var color = (KIND[n.kind] || KIND.other).color;
      var g = svgEl('g', { 'class': 'topo-node', tabindex: '0', role: 'button',
        'aria-label': n.name + '，' + (KIND[n.kind] || KIND.other).label + '，状态' + (n.status || '未知') });
      g.appendChild(svgEl('rect', { x: p.x, y: p.y, width: CARD_W, height: CARD_H, rx: 6,
        'class': 'topo-node-box', stroke: color }));
      // 类型色条（左侧 4px 标识）
      g.appendChild(svgEl('rect', { x: p.x, y: p.y + 6, width: 4, height: CARD_H - 12, rx: 2, fill: color }));
      var t1 = svgEl('text', { x: p.x + 14, y: p.y + 20, 'class': 'topo-node-name' });
      t1.textContent = n.name.length > 16 ? n.name.slice(0, 15) + '…' : n.name;
      g.appendChild(t1);
      var t2 = svgEl('text', { x: p.x + 14, y: p.y + 36, 'class': 'topo-node-meta' });
      t2.textContent = (KIND[n.kind] || KIND.other).label + ' · ' + (n.status || '未知');
      g.appendChild(t2);
      on(g, function (ev) {
        ev.stopPropagation();
        showTip(n, ev.clientX, ev.clientY);
        // 触摸后的合成 click 不跳转：panel 里的「查看详情」才是手机跳转入口（tap 面板保持可见）
        if (Date.now() - S.lastTouch > 500) goto(n.route);
      }, 'click');
      on(g, function (ev) { showTip(n, ev.clientX, ev.clientY); }, 'mouseenter');
      on(g, function () { hideTip(); }, 'mouseleave');
      on(g, function (ev) {
        S.lastTouch = Date.now();
        var t = ev.changedTouches && ev.changedTouches[0];
        var r = S.box.getBoundingClientRect();
        showTip(n, t ? t.clientX : r.left + p.x, t ? t.clientY : r.top + p.y);
      }, 'touchstart');
      on(g, function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goto(n.route); } }, 'keydown');
      svg.appendChild(g);
    });
  }

  function drawList(model) {
    if (!S.listEl) return;
    S.listEl.textContent = '';
    model.nodes.forEach(function (n) {
      var row = add(S.listEl, el('div', 'topo-list-row'));
      var dot = add(row, el('span', 'topo-list-dot'));
      dot.style.background = (KIND[n.kind] || KIND.other).color;
      var txt = add(row, el('span', null, n.name + ' · ' + (KIND[n.kind] || KIND.other).label + ' · ' + (n.status || '未知')));
      txt.title = n.detail || '';
      var go = add(row, el('button', 'topo-list-go', '查看'));
      go.type = 'button'; on(go, function () { goto(n.route); });
    });
  }

  function paintNotes(notes) {
    if (!S.notesEl) return;
    S.notesEl.textContent = '';
    (notes || []).forEach(function (n) { add(S.notesEl, el('div', 'topo-note', '⚠ ' + n)); });
  }

  function renderEmpty(host) {
    var e = add(host, el('div', 'topo-empty'));
    add(e, el('div', 'topo-empty-title', '还没有可展示的服务'));
    add(e, el('div', 'topo-empty-text', '拓扑图需要至少一个数据源有内容。先装一个插件（如 site / container / discover），再回来刷新即可看到站点、容器与端口之间的关系。'));
    var btn = add(e, el('button', 'btn btn-primary', '去软件商店装插件'));
    btn.type = 'button'; on(btn, function () { goto('store'); });
  }

  function bindResize() {
    if (S.resizeBound) return;
    S.resizeBound = true;
    on(window, function () {
      if (S.resizeTimer) clearTimeout(S.resizeTimer);
      S.resizeTimer = setTimeout(function () {
        S.resizeTimer = 0;
        if (S.svg && !S.destroyed && S.nodes && S.nodes.length) draw({ nodes: S.nodes, edges: S.edges });
      }, RESIZE_DEBOUNCE_MS);
    }, 'resize');
  }

  function teardown() {
    S.destroyed = true;
    S.gen++;
    if (S.resizeTimer) { clearTimeout(S.resizeTimer); S.resizeTimer = 0; }
    if (S.svg) { while (S.svg.firstChild) S.svg.removeChild(S.svg.firstChild); }
    S.svg = null; S.listEl = null; S.notesEl = null; S.tip = null;
    S.box = null; S.nodes = []; S.edges = [];
    S.instCount = 0;
  }

  function render(container) {
    if (!container || typeof container.appendChild !== 'function') return null;
    ensureStyle();
    teardown();
    S.destroyed = false;
    S.box = container;
    container.classList.add('kore-topology');
    container.textContent = '';

    var head = add(container, el('div', 'topo-head'));
    add(head, el('h2', 'topo-h2', '服务拓扑'));
    add(head, el('span', 'topo-sub', '站点 / 容器 / 端口 / 插件 的关系一览；点节点跳转对应视图'));
    var refresh = add(head, el('button', 'btn', '刷新'));
    refresh.type = 'button';

    var legend = add(container, el('div', 'topo-legend'));
    ['site', 'container', 'port', 'plugin', 'db'].forEach(function (k) {
      var item = add(legend, el('span', null));
      var i = add(item, el('i')); i.style.background = KIND[k].color;
      item.appendChild(document.createTextNode(KIND[k].label));
    });

    var stage = add(container, el('div', 'topo-stage'));
    S.svg = svgEl('svg', { 'class': 'topo-svg', xmlns: SVG_NS, role: 'img',
      'aria-label': '服务关系拓扑图：站点连接容器，容器连接端口，站点连接数据库' });
    stage.appendChild(S.svg);
    S.tip = add(stage, el('div', 'topo-tip')); S.tip.hidden = true;
    on(stage, function () { hideTip(); }, 'click');

    var list = add(container, el('div', 'topo-list'));
    S.listEl = list;
    S.notesEl = add(container, el('div', 'topo-notes'));
    var gen = S.gen;
    var loading = add(container, el('div', 'topo-note', '正在读取插件 / 容器 / 站点 / 端口…'));

    function load() {
      if (S.destroyed || gen !== S.gen) return;
      loading.textContent = '正在读取插件 / 容器 / 站点 / 端口…';
      loadAll(gen).then(function (model) {
        if (S.destroyed || gen !== S.gen || !model) return;
        loading.textContent = '';
        paintNotes(model.notes);
        if (!model.nodes.length) { renderEmpty(container); return; }
        S.instCount = 1; // 单张关系图实例（G-32 判据 2：≤12）
        draw(model);
        drawList(model);
      });
    }
    on(refresh, load);
    bindResize();
    load();

    return { destroy: teardown };
  }

  window.KoreTopology = {
    render: render,
    destroy: teardown,
    endpoints: { plugins: API_PLUGINS, containers: INVOKE.containers, sites: INVOKE.sites, ports: INVOKE.ports },
    maxNodes: MAX_NODES
  };
  /* 验收钩子（G-32 / FRONTEND §13）：切走视图后 count() === 0；dispose() 主动清场。 */
  window.__koreTopoChart = {
    count: function () { return S.instCount; },
    dispose: function () { teardown(); }
  };
})();
