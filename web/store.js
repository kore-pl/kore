// web/store.js — kore 软件商店：卡片网格 + 内联图标 + 分类筛选 + 搜索 + 安装/停用。
// 零框架 / 零 CDN / 无外链，图标全部内联线性 SVG（禁 emoji，FRONTEND 红线 8），对外只暴露 window.KoreStore.render(container)。
// 数据：商店索引 / 预设 / 已安装列表；写：安装、停用（X-Kore-CSRF 双提交）。
// 调用形态：POST /api/v1/invoke/<id>/<id>.<action> —— 本视图不调 invoke，只走下方管理端点；
// 一旦引入插件业务方法，方法段必须写 <id>.<action>，不得用裸动词。
// 安装需要 package_path 时才在该卡片内展开路径输入，不在页面顶部常驻技术字段；
// 卸载走 DELETE /api/v1/plugins/{id}（停进程 + 删程序文件，幂等）；老内核（404/405/501）直接禁用按钮，不做点了才报错的假按钮。
(function () {
  'use strict';
  // 装完之后最该去的下一步：给直达入口，别让用户自己找（USABILITY 原则 4「成功后给下一个动作」）。
  var NEXT_VIEW = {
    site: { href: '#/sites', label: '去创建第一个站点' },
    file: { href: '#/files', label: '去管理文件' },
    'db-mysql': { href: '#/db', label: '去连接数据库' },
    redis: { href: '#/db/redis', label: '去连接 Redis' },
    backup: { href: '#/files/backup', label: '去配置备份' }
  };
  var U = { plugins: '/api/v1/store/plugins', presets: '/api/v1/store/presets',
    install: '/api/v1/store/install', installed: '/api/v1/plugins', disable: '/api/v1/plugins/',
    enable: '/api/v1/plugins/', uninstall: '/api/v1/plugins/' };
  // 图标映射：按 id 固定线性 SVG 路径（viewBox 20×20，stroke 1.6 圆角，与 shell.js 导航同线型），
  // 21 个插件两两可区分（无外链、无字体依赖、颜色继承 --kore-text-2）。
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICON_PATHS = {
    echo: ['M16 9a6 6 0 0 0-10.9-2.1', 'M4 3.5V8h4.5', 'M4 11a6 6 0 0 0 10.9 2.1', 'M16 16.5V12h-4.5'],
    site: ['M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z', 'M2 10h16', 'M10 2c2.7 2 2.7 14 0 16', 'M10 2c-2.7 2-2.7 14 0 16'],
    file: ['M4 4h5l2 3h5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z'],
    ssl: ['M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9', 'M5 9h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z', 'M10 12.5v2'],
    integrity: ['M5 2.5h10v15l-2.5-1.6L10 17.5l-2.5-1.6L5 17.5z', 'M8 7h4', 'M8 10.5h4'],
    cron: ['M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z', 'M10 5.5V10l3 1.8'],
    'ssh-guard': ['M16.5 6.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M11.5 9.5 4.5 16.5v2h2.5v-2h2v-2h2l1.6-1.6'],
    monitor: ['M3.5 3.5v13h13', 'M6.5 12.5l3-3.5 2.5 2.5 4-5'],
    logs: ['M4.5 3a1 1 0 0 1 1-1H12l3.5 3.5V17a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z', 'M12 2v4h3.5', 'M7.5 9.5h5', 'M7.5 12.5h5', 'M7.5 15.5h3'],
    dns: ['M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z', 'M13.8 6.2 11.7 11.7 6.2 13.8 8.3 8.3z'],
    'runtime-php': ['M7 5.5 2.5 10 7 14.5', 'M13 5.5 17.5 10 13 14.5', 'M11.2 4 8.8 16'],
    'runtime-node': ['M10 2.5 16.5 6.2v7.6L10 17.5 3.5 13.8V6.2z'],
    'runtime-python': ['M13.5 4.5c0-1.2-1.2-2-3.5-2s-3.5 1-3.5 3 1.5 2.8 3.5 2.8 3.5 1 3.5 3-1.2 3-3.5 3-3.5-.8-3.5-2'],
    'db-mysql': ['M3.5 5.5c0-1.4 2.9-2.5 6.5-2.5s6.5 1.1 6.5 2.5-2.9 2.5-6.5 2.5-6.5-1.1-6.5-2.5z', 'M3.5 5.5v9c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-9', 'M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5'],
    'db-postgres': ['M3.5 4.5c0-1.2 2.9-2 6.5-2s6.5.8 6.5 2-2.9 2-6.5 2-6.5-.8-6.5-2z', 'M3.5 4.5v11c0 1.2 2.9 2 6.5 2s6.5-.8 6.5-2v-11', 'M3.5 8.5c0 1.2 2.9 2 6.5 2s6.5-.8 6.5-2', 'M3.5 12.5c0 1.2 2.9 2 6.5 2s6.5-.8 6.5-2'],
    redis: ['M11.5 2.5 5 11h4.2l-1.2 6.5L14.5 9h-4.2z'],
    backup: ['M4.5 3.5h9.2l2.8 2.8V16.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z', 'M7 3.5V8h6V3.5', 'M6.5 17v-5.5h7V17'],
    firewall: ['M10 2.5 16 4.8V10c0 3.9-2.5 6.4-6 7.5-3.5-1.1-6-3.6-6-7.5V4.8z'],
    waf: ['M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z', 'M4.7 4.7l10.6 10.6'],
    container: ['M3.5 6.7 10 3l6.5 3.7v6.6L10 17l-6.5-3.7z', 'M3.5 6.7 10 10.4l6.5-3.7', 'M10 10.4V17'],
    'app-deploy': ['M10 12.5V4', 'M6.5 7.5 10 4l3.5 3.5', 'M4 12.5v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3']
  };
  // 内联 SVG 工厂：线性风格统一（stroke 继承 currentColor），成功勾复用同一线型。
  function iconSvg(paths) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < paths.length; i++) {
      var pa = document.createElementNS(SVG_NS, 'path');
      pa.setAttribute('d', paths[i]);
      svg.appendChild(pa);
    }
    return svg;
  }
  function storeIcon(id) { return iconSvg(ICON_PATHS[id] || ICON_PATHS.container); }
  function checkSvg() { return iconSvg(['M4.5 10.5l3.5 3.5 7.5-8']); }
  // 分类按 scenario_tags 映射；多标签插件会出现在多个分类（file = ops + data）。
  var CATS = [{ id: 'all', label: '全部分类', tags: [] }, { id: 'site', label: '站点与运行时', tags: ['web', 'app'] },
    { id: 'data', label: '数据库', tags: ['data'] }, { id: 'ops', label: '运维', tags: ['ops'] },
    { id: 'sec', label: '安全', tags: ['sec'] }];
  // 安装状态轴（与「分类」正交）：商店必须自己回答「我装了什么 / 哪些能升级」，
  // 否则用户只能切到另一个「已装插件」页面去看——那正是重复菜单的来源。
  var SCOPES = [{ id: 'all', label: '全部' }, { id: 'installed', label: '已安装' }, { id: 'upgradable', label: '可更新' }];
  var CN = { web: '站点', app: '运行时', data: '数据库', ops: '运维', sec: '安全' };
  // 商店每页 12 个卡片（24 个插件正好 2 页），避免分类筛选后某类很多时页面无限拉长。
  var PAGE_SIZE = 12;
  var S = { plugins: [], presets: [], installed: Object.create(null), status: Object.create(null),
    cat: 'all', scope: 'all', q: '', page: 1, grid: null, empty: null, stats: null, notice: null,
    container: null, searchInput: null,
    summary: null, batchStatus: null, pickbar: null,
    // 升级中心状态：selected = 勾选的可升级插件 id；notes = 展开过「更新说明」的 id
    // （details 原生开合，但列表重绘会重建节点，故把开合状态存在这里，重绘后还原）。
    // batch 记录一次批量升级的进度与逐项结果：ok / fail / restart（需重启 kored 才能继续）。
    selected: Object.create(null), notes: Object.create(null), batchConfirm: null,
    batch: { running: false, done: 0, total: 0, failed: [], results: [], message: '', current: '' },
    restart: null, restartCode: null };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function add(parent, child) { parent.appendChild(child); return child; }
  // 读非 HttpOnly 的 kore_csrf（双提交要求前端可读；会话 cookie 仍 HttpOnly）。
  function readCookie(name) {
    var parts = (document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  // 永不因 HTTP 状态码 reject（401/5xx 交给调用方读 code/message），只有网络错误 reject。
  function request(url, init) {
    var o = init || {};
    o.credentials = 'same-origin'; o.cache = 'no-store'; o.headers = o.headers || {};
    if (!o.headers.Accept) o.headers.Accept = 'application/json';
    return fetch(url, o).then(function (res) {
      return res.text().then(function (raw) {
        var d = {};
        if (raw) { try { d = JSON.parse(raw); } catch (e) { d = { raw: raw }; } }
        return { ok: res.ok, status: res.status, data: d };
      });
    });
  }
  function errText(res) {
    var b = (res && res.data) || {}, msg = b.message ? String(b.message) : '请求未完成';
    if (/package_path/i.test(msg)) msg = '需要填写本地包路径';
    if (typeof b.detail === 'string' && b.detail) msg += '（' + b.detail + '）';
    return msg;
  }
  // 验签失败的结构化提示：后端在错误体里给 requires_restart:true（顶层或 detail 内）。
  // 命中时不显示普通错误条，改显示「需重启 kored」醒目提示条。
  function restartRequired(res) {
    var b = (res && res.data) || {};
    if (b.requires_restart === true) return true;
    if (b.detail && typeof b.detail === 'object' && b.detail.requires_restart === true) return true;
    return b.code === 'E_UNAUTHORIZED' && /索引签名/.test(String(b.message || ''));
  }
  function errCode(res) {
    var b = (res && res.data) || {}, parts = [];
    if (b.code) parts.push(String(b.code));
    if (b.message) parts.push(String(b.message));
    return parts.join(' · ');
  }
  // 醒目提示条：索引重签/换公钥后旧进程仍持旧公钥，唯一恢复动作是重启 kored。
  function showRestartNotice(res) {
    if (!S.restart) return;
    S.restart.hidden = false;
    S.restart.style.display = 'block';
    if (S.restartCode) S.restartCode.textContent = errCode(res) || 'E_UNAUTHORIZED';
    if (S.notice) S.notice.hidden = true;
  }
  function postJson(url, body) {
    var token = readCookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌（kore_csrf），请刷新页面或重新登录'));
    return request(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(body || {}) });
  }
  // 索引无 description 字段：用 scenario_tags 合成一句话用途（不编造功能，也不再重复体积/按需字样）。
  function descOf(p) {
    var tags = (p.scenario_tags || []).map(function (t) { return CN[t] || t; }).join(' / ');
    return (tags || '通用') + '场景';
  }
  function inCat(p, catId) {
    if (catId === 'all') return true;
    var tags = p.scenario_tags || [];
    for (var i = 0; i < CATS.length; i++) {
      if (CATS[i].id !== catId) continue;
      for (var j = 0; j < tags.length; j++) if (CATS[i].tags.indexOf(tags[j]) !== -1) return true;
    }
    return false;
  }
  // 语义化版本比较：只认 MAJOR.MINOR.PATCH 三段数字（与内核接受范围一致），
  // 返回 -1/0/1。升级方向由前端判定，内核只提供 latest_version 原始数据（G-01）。
  function cmpVer(left, right) {
    var a = String(left || '').split('.'), b = String(right || '').split('.');
    for (var i = 0; i < 3; i++) {
      var x = parseInt(a[i], 10), y = parseInt(b[i], 10);
      if (!isFinite(x)) x = 0;
      if (!isFinite(y)) y = 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  // 卡片四态：missing（未安装）/ latest（已安装最新）/ upgradable（可升级）/
  // unindexed（已安装，但索引无此版本或索引版本更旧）。
  function cardState(ins, indexVersion) {
    if (!ins) return 'missing';
    if (!indexVersion) return 'unindexed';
    var cmp = cmpVer(indexVersion, ins.version);
    if (cmp > 0) return 'upgradable';
    if (cmp === 0) return 'latest';
    return 'unindexed';
  }
  // 可升级清单：索引版本严格高于已装版本。一键升级与顶部汇总共用同一口径。
  function upgradable() {
    var out = [];
    S.plugins.forEach(function (p) {
      var ins = S.installed[p.id];
      if (ins && cardState(ins, p.version) === 'upgradable') out.push({ p: p, ins: ins });
    });
    return out;
  }
  // 大版本号：0.x → 1.x 这类跨大版本升级，插件行为/配置项可能不兼容，必须单独提示。
  function majorOf(v) { var n = parseInt(String(v || '').split('.')[0], 10); return isFinite(n) ? n : 0; }
  function isMajorJump(from, to) { return majorOf(to) > majorOf(from); }
  // 更新说明：索引里若带 changelog / release_notes / update_notes / notes 就展示，
  // 没有就如实说「未提供」——不编造版本变化（G-30 同源的诚实原则，宁缺毋假）。
  function noteItems(p) {
    var raw = p && (p.changelog || p.release_notes || p.update_notes || p.notes);
    if (!raw) return [];
    if (typeof raw === 'string') raw = raw.split(/\r?\n/);
    if (!Array.isArray(raw)) return [];
    var out = [];
    raw.forEach(function (item) {
      if (item === null || item === undefined) return;
      var line = '';
      if (typeof item === 'string') line = item;
      else if (typeof item === 'object') {
        var body = item.items || item.notes || item.changes;
        if (Array.isArray(body)) line = body.join('；');
        else line = item.text || item.summary || item.title || '';
      } else { line = String(item); }
      line = String(line).replace(/^\s*[-*·]\s*/, '').trim();
      if (line) out.push(line);
    });
    return out.slice(0, 12);
  }
  // 风险提示：升级一定会重启该插件（先停后拉起），期间调用会短暂失败；
  // 跨大版本再追加一条更强提示。批量确认与单个确认共用同一段文案。
  function upgradeRiskLines(ins, target) {
    var lines = ['升级会重启该插件，重启期间可能短暂不可用（通常几秒到几十秒）；配置与启用状态会保留。'];
    if (isMajorJump(ins.version, target)) {
      lines.push('这是一次跨大版本升级（v' + ins.version + ' → v' + target +
        '）：功能与配置项可能有变化，建议先展开「更新说明」确认后再升级。');
    }
    if (ins.enabled === true || ins.desired === 'enabled') {
      lines.push('该插件当前处于启用状态，升级时会先停一次再重新拉起。');
    }
    return lines;
  }
  function selectedUpgradable() {
    return upgradable().filter(function (item) { return S.selected[item.p.id] === true; });
  }
  // 升级完成后插件不再可升级：清掉已失效的勾选，避免批量条显示「已选 3 个」却只剩 1 张卡片。
  function pruneSelection(list) {
    var live = Object.create(null);
    list.forEach(function (item) { live[item.p.id] = true; });
    Object.keys(S.selected).forEach(function (id) { if (!live[id]) delete S.selected[id]; });
  }
  // 升级中心自己的样式：写域不含 style.css（多人并行），按外壳同一做法注入一次 scoped 样式；
  // 只引用设计令牌（无硬编码色值），<640px 触摸目标走 --kore-touch。
  function ensureUpgradeStyle() {
    if (document.getElementById('kore-store-upgrade-css')) return;
    var css = [
      '.store-pick{display:flex;align-items:center;gap:var(--kore-space-2);min-height:32px}',
      '.store-pick-cb{width:18px;height:18px;margin:0;flex:0 0 auto;accent-color:var(--kore-info);cursor:pointer}',
      '.store-pick-text{font-size:var(--kore-font-12);color:var(--kore-text-2)}',
      '.store-notes{border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);background:var(--kore-bg-2)}',
      '.store-notes[open] summary{color:var(--kore-text-1)}',
      '.store-notes>summary{display:flex;align-items:center;gap:var(--kore-space-2);min-height:32px;' +
        'padding:0 var(--kore-space-3);cursor:pointer;font-size:var(--kore-font-12);color:var(--kore-info)}',
      '.store-notes>summary:focus-visible{outline:2px solid var(--kore-info);outline-offset:2px}',
      '.store-notes-body{padding:0 var(--kore-space-3) var(--kore-space-2)}',
      '.store-notes-list{max-height:160px;overflow:auto;margin:0;padding-left:18px;' +
        'font-size:var(--kore-font-12);color:var(--kore-text-2)}',
      '.store-notes-list li{margin:2px 0;overflow-wrap:anywhere}',
      '.store-notes-empty{margin:0;font-size:var(--kore-font-12);color:var(--kore-text-3)}',
      '.store-batch{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2) var(--kore-space-3);' +
        'margin:0 0 var(--kore-space-3);padding:var(--kore-space-2) var(--kore-space-3);' +
        'background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-left:3px solid var(--kore-info);' +
        'border-radius:var(--kore-radius-container)}',
      '.store-batch[hidden]{display:none}',
      '.store-pick-all{display:inline-flex;align-items:center;gap:var(--kore-space-2);min-height:32px;' +
        'font-size:var(--kore-font-12);color:var(--kore-text-2)}',
      '.store-batch-count{font-size:var(--kore-font-12);color:var(--kore-text-2)}',
      '.store-batch-actions{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);margin-left:auto}',
      '.store-batch-note{flex:1 1 100%;font-size:var(--kore-font-12);color:var(--kore-text-3)}',
      '.store-batch-confirm{flex:1 1 100%;display:flex;flex-direction:column;gap:var(--kore-space-2)}',
      '.store-risk{margin:0;font-size:var(--kore-font-12);color:var(--kore-text-2);overflow-wrap:anywhere}',
      '.store-risk.is-major{color:var(--kore-warning);font-weight:600}',
      '.store-batch-results{display:flex;flex-direction:column;gap:var(--kore-space-1);flex:1 1 100%}',
      '.store-batch-result-list{max-height:180px;overflow:auto;margin:0;padding-left:18px;' +
        'font-size:var(--kore-font-12);color:var(--kore-text-2)}',
      '.store-batch-result-list li{overflow-wrap:anywhere}',
      '.store-batch-result-ok{color:var(--kore-success)}',
      '.store-batch-result-fail{color:var(--kore-danger)}',
      '.store-batch-result-restart{color:var(--kore-warning)}',
      '@media (max-width:639px){',
      '.store-pick{min-height:var(--kore-touch)}',
      '.store-pick-cb{width:22px;height:22px}',
      '.store-notes>summary{min-height:var(--kore-touch)}',
      '.store-pick-all{min-height:var(--kore-touch)}',
      '.store-batch-actions{width:100%;margin-left:0}',
      '.store-batch-actions .btn{flex:1 1 auto;min-height:var(--kore-touch)}',
      '}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'kore-store-upgrade-css';
    st.textContent = css;
    document.head.appendChild(st);
  }
  // 已安装但索引未收录的插件也要有卡片——否则四态里的「索引未收录」永远不可见。
  function allCards() {
    var list = S.plugins.slice();
    var known = Object.create(null);
    S.plugins.forEach(function (p) { known[p.id] = true; });
    Object.keys(S.installed).forEach(function (id) {
      if (known[id]) return;
      var ins = S.installed[id];
      list.push({
        id: id, name: ins.name || id, version: ins.version,
        depth_level: ins.depth_level || 'basic', scenario_tags: [], _installedOnly: true
      });
    });
    return list;
  }
  function inScope(p, scope) {
    if (scope === 'all') return true;
    var ins = S.installed[p.id];
    if (!ins) return false;
    if (scope === 'installed') return true;
    return cardState(ins, p.version) === 'upgradable'; // 与 upgradable()/顶部汇总同一口径
  }
  function visible() {
    var q = S.q.trim().toLowerCase();
    return allCards().filter(function (p) {
      if (!inScope(p, S.scope)) return false;
      if (!inCat(p, S.cat)) return false;
      if (!q) return true;
      return [p.id, p.name].concat(p.scenario_tags || []).join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  // 空态三件套：当前没有 X + 一句话说明 + 下一步按钮（易用性四原则④ / G-33 A5）。
  // 三种「空」的下一步完全不同：索引空 → 重新读索引；已装空 → 去全部；筛选空 → 清空筛选。
  // 清理筛选复用页面上已有的筛选按钮（state 单一真源），改完把结果区带回视野（手机端列表可能已滚出屏幕）。
  function clearFilters() {
    if (S.searchInput) S.searchInput.value = '';
    S.q = ''; S.cat = 'all'; S.scope = 'all'; S.page = 1;
    var scopes = document.querySelectorAll('.store-scope');
    for (var i = 0; i < scopes.length; i++) {
      scopes[i].setAttribute('aria-pressed', scopes[i].dataset.scope === 'all' ? 'true' : 'false');
    }
    var cats = document.querySelectorAll('.store-cat');
    for (var j = 0; j < cats.length; j++) {
      cats[j].setAttribute('aria-pressed', cats[j].dataset.cat === 'all' ? 'true' : 'false');
    }
    renderGrid();
    if (S.grid && S.grid.scrollIntoView) S.grid.scrollIntoView({ block: 'start' });
  }
  function paintEmpty(count) {
    if (!S.empty) return;
    S.empty.textContent = '';
    if (count) { S.empty.hidden = true; return; }
    S.empty.hidden = false;
    var opts;
    if (!S.plugins.length) {
      opts = {
        title: '商店索引里还没有插件',
        text: '索引为空通常是索引文件没读到或还没同步；内核重启后旧进程可能仍持有旧公钥，重新读取一次即可恢复。',
        label: '重新读取索引', onClick: reload
      };
    } else if (S.scope === 'installed') {
      opts = { title: '还没有安装任何插件', text: '把状态切回「全部」，挑一个点「安装」；装完就会出现在这里。', label: '去全部插件里挑一个', onClick: clearFilters };
    } else if (S.scope === 'upgradable') {
      opts = { title: '暂时没有可更新的插件', text: '已装插件都是最新版本；有新版本时会出现在这里。', label: '查看全部插件', onClick: clearFilters };
    } else {
      opts = { title: '没有找到匹配的插件', text: '换个关键词，或把分类/状态切回「全部」。', label: '清空筛选', onClick: clearFilters };
    }
    var block = window.KoreUI.emptyBlock(opts);
    block.classList.add('store-empty-state');
    S.empty.appendChild(block);
  }
  function setStatus(id, kind, text, href, linkText) {
    S.status[id] = { kind: kind, text: text, href: href || '', linkText: linkText || '' };
    renderGrid();
  }
  function input(cls, ph, label, type) {
    var i = el('input', 'field-input ' + cls);
    i.type = type || 'text'; i.placeholder = ph; i.setAttribute('autocomplete', 'off');
    if (label) i.setAttribute('aria-label', label);
    return i;
  }
  // 文案优先走 i18n 表（新键 store.uninstall.*），缺项回退中文，不显示键名。
  function T(key, fallback) {
    var fn = window.KoreI18n && window.KoreI18n.t;
    var v = fn ? fn(key) : '';
    return v || fallback;
  }
  // 危险操作按钮：卸载不可撤销 → 红边红字，与「停用」（中性灰）视觉区分。
  // 只用既有设计令牌，不新增 CSS（写域不含 style.css）。
  function dangerBtn(text, cls) {
    var b = el('button', 'btn store-btn-danger' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.style.color = 'var(--kore-danger)';
    b.style.borderColor = 'var(--kore-danger)';
    return b;
  }

  function renderPresets() {
    var box = el('section', 'store-presets');
    var head = add(box, el('div', 'store-presets-head'));
    add(head, el('h3', 'store-presets-title', '场景预设'));
    add(head, el('span', 'store-presets-meta', S.presets.length ? S.presets.length + ' 个预设' : '预设未装配'));
    var row = add(box, el('div', 'store-preset-row'));
    if (!S.presets.length) add(row, el('p', 'store-preset-empty', '当前没有可用的场景预设。'));
    S.presets.forEach(function (p) {
      var c = add(row, el('article', 'store-preset'));
      add(c, el('div', 'store-preset-name', p.name || p.id));
      add(c, el('div', 'store-preset-sub', (p.plugins ? p.plugins.length : 0) + ' 个插件 · ' +
        (p.out_of_box ? '开箱可用' : '需按需启用')));
      var tag = add(c, el('span', 'tag tag-muted', '待支持'));
      tag.title = '当前版本暂不支持批量安装，可在下方逐个安装';
      var b = add(c, el('button', 'btn store-preset-btn', '一键安装'));
      b.disabled = true; // 无批量安装能力：禁用而非伪造成功
      b.title = tag.title;
    });
    return box;
  }

  // 深度枚举值白话化（USABILITY §4 / G-33 A4）：英文值只作 CSS class，文案给中文；未知值原值 + 提示不空白。
  var DEPTH_LABELS = { production: '生产级', basic: '基础级' };
  function depthInfo(v) {
    if (DEPTH_LABELS[v]) return { cls: v, text: DEPTH_LABELS[v] };
    return { cls: 'basic', text: (v ? String(v) : '') + '（未知深度）' };
  }

  function renderCard(p) {
    var ins = S.installed[p.id];
    var card = el('article', 'store-card' + (ins ? ' is-installed' : ''));
    card.setAttribute('data-plugin-id', p.id);
    var top = add(card, el('div', 'store-card-top'));
    var icon = add(top, el('span', 'store-icon'));
    icon.appendChild(storeIcon(p.id));
    icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', (p.name || p.id) + ' 图标');
    var head = add(top, el('div', 'store-card-head'));
    add(head, el('div', 'store-card-name', p.name || p.id));
    var sub = add(head, el('div', 'store-card-sub'));
    add(sub, el('span', 'store-card-ver', 'v' + (p.version || '?')));
    var badges = add(card, el('div', 'store-badges'));
    var depth = depthInfo(p.depth_level);
    add(badges, el('span', 'store-badge ' + depth.cls, depth.text));
    var state = cardState(ins, p.version);
    if (state === 'latest') {
      var installedBadge = add(badges, el('span', 'store-badge installed'));
      installedBadge.appendChild(checkSvg());
      add(installedBadge, el('span', null, '已安装'));
      add(badges, el('span', 'store-badge muted', '已是最新'));
    } else if (state === 'upgradable') {
      add(badges, el('span', 'store-badge installed', '已安装'));
      add(badges, el('span', 'store-badge upgrade', '可升级 v' + ins.version + ' → v' + p.version));
      // 跨大版本（0.x → 1.x）在卡片上就可见，不用等点升级才知道。
      if (isMajorJump(ins.version, p.version)) {
        var majorBadge = add(badges, el('span', 'store-badge upgrade', '跨大版本'));
        majorBadge.title = '这次升级跨越大版本，功能与配置项可能有变化';
      }
    } else if (state === 'unindexed') {
      add(badges, el('span', 'store-badge installed', '已安装'));
      add(badges, el('span', 'store-badge muted', '索引未收录'));
    }
    add(card, el('p', 'store-desc', descOf(p)));
    // 可升级卡片才给勾选与更新说明：不可升级项多这两个控件只会制造无效操作。
    if (state === 'upgradable') {
      card.appendChild(buildPickRow(p));
      card.appendChild(buildNotes(p));
    }
    var st = S.status[p.id];
    var status = add(card, el('div', 'store-card-status' + (st ? ' is-' + st.kind : '')));
    if (st && st.kind === 'ok') status.appendChild(checkSvg()); // 成功勾用 SVG，不用 emoji
    if (st) {
      add(status, el('span', null, st.text));
      if (st.href) {
        var go = add(status, el('a', 'store-status-link', st.linkText || '去处理'));
        go.href = st.href;
      }
    }
    status.setAttribute('role', 'status');
    var ops = add(card, el('div', 'store-ops'));
    if (ins) {
      // 设置：复用统一配置面板（PLUGIN-CONFIG §9 / shell.openConfig），不为每个插件重复写页面。
      // host 用 S.container（视图根容器）而非卡片内元素：面板按 insertBefore(children[1]) 定位，
      // 挂到根容器才不会把设置面板插进卡片网格里打乱布局。
      var setting = add(ops, el('button', 'btn btn-ghost store-btn-setting', '设置'));
      setting.type = 'button';
      setting.title = '打开「' + (p.name || p.id) + '」的设置，改完立即生效';
      on(setting, function () {
        if (window.KoreShell && typeof window.KoreShell.openConfig === 'function') {
          window.KoreShell.openConfig(S.container, p.id, { title: (p.name || p.id) + ' 设置' });
        }
      });
      // 卸载：DELETE /api/v1/plugins/{id}。老内核已探测到不支持时按钮直接禁用。
      var uni = add(ops, dangerBtn(T('store.uninstall.btn', '卸载'), 'store-btn-uninstall'));
      if (S.uninstallOff) {
        uni.disabled = true;
        uni.title = T('store.uninstall.unsupported', '当前内核版本不支持卸载插件');
      } else {
        uni.title = '卸载插件：停止进程并删除程序文件，业务数据保留（需二次确认）';
        on(uni, function () { showUninstallConfirm(card, p); });
      }
      if (state === 'upgradable') {
        // 可升级：主按钮从「重装」改为「升级到 vX」，走 force 覆盖 + 保留期望态。
        var upgrade = add(ops, el('button', 'btn btn-primary store-btn-upgrade',
          '升级到 v' + p.version));
        upgrade.title = '下载索引版本并升级，配置与启用状态保留';
        on(upgrade, function () { showUpgradeConfirm(card, p, ins, p.version); });
      } else if (state === 'latest') {
        var reinstall = add(ops, el('button', 'btn btn-ghost store-btn-reinstall', '重装'));
        reinstall.title = '覆盖当前安装目录重装（配置保留）';
        on(reinstall, function () { showReinstallConfirm(card, p); });
      } else {
        var noReinstall = add(ops, el('button', 'btn btn-ghost store-btn-reinstall', '重装'));
        noReinstall.disabled = true;
        noReinstall.title = '索引未收录该版本，无法重装；可停用插件';
      }
      // 启用/停用成对出现：装完自动启用后显示「停用」，被停用时直接给「启用」。
      var active = ins.enabled === true || ins.desired === 'enabled';
      if (active) {
        // 「停用」可逆 → 中性灰（C7 危险色通胀治理），类名同步去 danger 语义
        var off = add(ops, el('button', 'btn store-btn-muted', '停用'));
        off.title = '停用插件（可随时再启用）';
        off.type = 'button';
        on(off, function () { doDisable(p.id); });
      } else {
        var onBtn = add(ops, el('button', 'btn btn-primary store-btn-enable', '启用'));
        onBtn.title = '启用该插件（装完默认会自动启用）';
        onBtn.type = 'button';
        on(onBtn, function () { doEnable(p.id); });
      }
    } else {
      var offline = add(ops, el('button', 'btn btn-ghost store-btn-offline', '离线安装'));
      offline.title = '从服务器本地包安装';
      on(offline, function () { showPkgPrompt(card, p); });
      var install = add(ops, el('button', 'btn btn-primary store-btn-install', '安装'));
      install.title = '从商店索引下载并安装';
      on(install, function () { doInstall(p, card); });
    }
    return card;
  }

  // 可升级卡片的勾选行：勾不勾只影响批量条，不触发任何请求（勾选 ≠ 升级）。
  function buildPickRow(p) {
    var row = el('label', 'store-pick');
    var cb = add(row, el('input', 'store-pick-cb'));
    cb.type = 'checkbox';
    cb.checked = S.selected[p.id] === true;
    cb.setAttribute('aria-label', '选择升级 ' + (p.name || p.id) + ' 到 v' + p.version);
    add(row, el('span', 'store-pick-text', '勾选后可批量升级'));
    cb.addEventListener('change', function () {
      if (cb.checked) S.selected[p.id] = true; else delete S.selected[p.id];
      renderPickbar();
    });
    return row;
  }

  // 更新说明折叠：原生 details（键盘可达、无需 JS 开合），开合状态存 S.notes 以便列表重绘后保持。
  // 索引没有说明时如实写「未提供」，不编造版本变化。
  function buildNotes(p) {
    var notes = el('details', 'store-notes');
    var sum = add(notes, el('summary', 'store-notes-summary'));
    add(sum, el('span', null, '更新说明（v' + p.version + '）'));
    if (S.notes[p.id]) notes.open = true;
    notes.addEventListener('toggle', function () {
      if (notes.open) S.notes[p.id] = true; else delete S.notes[p.id];
    });
    var body = add(notes, el('div', 'store-notes-body'));
    var items = noteItems(p);
    if (!items.length) {
      add(body, el('p', 'store-notes-empty',
        '该插件未提供更新说明（商店索引只记录了版本号）。升级后可在「已装插件」里查看实际变化。'));
      return notes;
    }
    var ul = add(body, el('ul', 'store-notes-list'));
    items.forEach(function (line) { add(ul, el('li', null, line)); });
    return notes;
  }

  // 顶部升级汇总：已安装总数 + 可升级数 + 一键全部升级。批量进度就地更新，
  // 不重绘整页（重绘会打断用户对卡片状态的观察）。
  function renderSummary() {
    if (!S.summary) return;
    S.summary.textContent = '';
    var total = Object.keys(S.installed).length;
    if (!total) { S.summary.hidden = true; return; }
    S.summary.hidden = false;
    var up = upgradable();
    var text = add(S.summary, el('span', 'store-upgrade-text'));
    text.textContent = total + ' 个已安装，' + up.length + ' 个可升级';
    var btn = add(S.summary, el('button', 'btn btn-primary store-upgrade-all',
      S.batch.running ? '升级中…' : '一键全部升级'));
    btn.type = 'button';
    btn.disabled = S.batch.running || up.length === 0;
    if (!up.length) btn.textContent = '全部已是最新';
    btn.title = '逐个升级全部可升级插件；升级会重启插件，失败项会在下方列出';
    on(btn, function () { confirmBatch(upgradable(), 'all'); });
    S.batchStatus = add(S.summary, el('span', 'store-upgrade-status'));
    S.batchStatus.setAttribute('role', 'status');
    if (S.batch.running) {
      S.batchStatus.textContent = '正在升级 ' + Math.min(S.batch.done + 1, S.batch.total) +
        '/' + S.batch.total + '…';
    } else if (S.batch.message) {
      S.batchStatus.textContent = S.batch.message;
      var bad = S.batch.failed.length > 0 ||
        S.batch.results.some(function (it) { return it.state === 'restart'; });
      S.batchStatus.className = 'store-upgrade-status' + (bad ? ' is-fail' : ' is-ok');
    }
  }

  // 升级中心操作带：勾选 / 全选 / 升级所选 / 批量确认 / 进度 / 逐项结果。
  // 与顶部汇总分工：汇总说「有多少」，这里说「选哪些、现在到哪、结果如何」。
  function renderPickbar() {
    if (!S.pickbar) return;
    var up = upgradable();
    var hasResults = S.batch.results.length > 0;
    if (!up.length && !S.batch.running && !hasResults && !S.batchConfirm) {
      S.pickbar.hidden = true;
      return;
    }
    S.pickbar.hidden = false;
    S.pickbar.textContent = '';

    // 进度态：逐项串行，用户能看到当前正在升哪一个。
    if (S.batch.running) {
      var box = add(S.pickbar, el('div', 'store-batch-results'));
      var prog = add(box, el('p', 'store-batch-note',
        '正在升级 ' + Math.min(S.batch.done + 1, S.batch.total) + '/' + S.batch.total +
        (S.batch.current ? ' · ' + S.batch.current : '') + '…'));
      prog.setAttribute('role', 'status');
      add(box, el('p', 'store-risk',
        '升级期间该插件会短暂不可用；请勿关闭本页，全部完成后会逐项列出结果。'));
      return;
    }

    // 确认态：把「升级什么、有什么风险」摆明，确认后才开始。
    if (S.batchConfirm) { renderBatchConfirm(); return; }

    // 结果态：成功 / 失败 / 需重启 三态逐项列出，失败项可一键重试。
    if (hasResults) {
      var out = add(S.pickbar, el('div', 'store-batch-results'));
      var okN = 0, failN = 0, restartN = 0;
      S.batch.results.forEach(function (it) {
        if (it.state === 'ok') okN++;
        else if (it.state === 'restart') restartN++;
        else failN++;
      });
      var head = add(out, el('p', 'store-batch-note',
        '逐项结果：成功 ' + okN + ' 个' + (failN ? ' · 失败 ' + failN + ' 个' : '') +
        (restartN ? ' · 需重启 kored ' + restartN + ' 个' : '')));
      head.setAttribute('role', 'status');
      var ul = add(out, el('ul', 'store-batch-result-list'));
      S.batch.results.forEach(function (it) {
        var li = add(ul, el('li', null, ''));
        var state = it.state === 'restart' ? '需重启 kored' : (it.state === 'ok' ? '成功' : '失败');
        var cls = it.state === 'restart' ? 'store-batch-result-restart'
          : (it.state === 'ok' ? 'store-batch-result-ok' : 'store-batch-result-fail');
        add(li, el('span', cls, it.name + ' v' + it.from + ' → v' + it.to + '：' + state));
        if (it.message && it.state !== 'ok') add(li, el('span', 'store-risk', '（' + it.message + '）'));
      });
      var acts = add(S.pickbar, el('div', 'store-batch-actions'));
      var retry = retryList();
      if (retry.length) {
        var rb = add(acts, el('button', 'btn btn-primary', '重试失败项（' + retry.length + '）'));
        rb.type = 'button';
        on(rb, function () { confirmBatch(retry, 'retry'); });
      }
      var close = add(acts, el('button', 'btn btn-ghost', '关闭结果'));
      close.type = 'button';
      on(close, function () { S.batch.results = []; S.batch.message = ''; renderPickbar(); });
      return;
    }

    // 勾选条：全选 + 已选数 + 升级所选。
    var sel = selectedUpgradable();
    var allBox = add(S.pickbar, el('label', 'store-pick-all'));
    var allCb = add(allBox, el('input', 'store-pick-cb'));
    allCb.type = 'checkbox';
    allCb.checked = up.length > 0 && sel.length === up.length;
    allCb.indeterminate = sel.length > 0 && sel.length < up.length;
    allCb.setAttribute('aria-label', '全选可升级插件（共 ' + up.length + ' 个）');
    add(allBox, el('span', null, '全选 ' + up.length + ' 个可升级'));
    allCb.addEventListener('change', function () {
      S.selected = Object.create(null);
      if (allCb.checked) up.forEach(function (item) { S.selected[item.p.id] = true; });
      renderGrid();
    });
    add(S.pickbar, el('span', 'store-batch-count', '已选 ' + sel.length + ' 个'));
    var actions = add(S.pickbar, el('div', 'store-batch-actions'));
    var go = add(actions, el('button', 'btn btn-primary', '升级所选（' + sel.length + '）'));
    go.type = 'button';
    go.disabled = sel.length === 0;
    go.title = sel.length ? '逐个升级已勾选插件（串行，失败不中断其余）'
      : '先在卡片上勾选要升级的插件';
    on(go, function () { confirmBatch(selectedUpgradable(), 'selected'); });
    if (sel.length) {
      var clear = add(actions, el('button', 'btn btn-ghost', '清空选择'));
      clear.type = 'button';
      on(clear, function () { S.selected = Object.create(null); renderGrid(); });
    }
    add(S.pickbar, el('p', 'store-batch-note',
      '勾选多个可升级插件后一次升级；升级会重启插件，期间可能短暂不可用。'));
  }

  // 失败/需重启项：按当前索引重新解析成可升级项；已升级成功或已下架的不再重试。
  function retryList() {
    var byId = Object.create(null);
    upgradable().forEach(function (item) { byId[item.p.id] = item; });
    var out = [];
    S.batch.results.forEach(function (it) {
      if (it.state !== 'ok' && byId[it.id]) out.push(byId[it.id]);
    });
    return out;
  }

  function confirmBatch(list, mode) {
    if (S.batch.running || !list || !list.length) return;
    S.batchConfirm = { list: list, mode: mode };
    renderPickbar();
  }

  function renderBatchConfirm() {
    var list = S.batchConfirm.list;
    var box = add(S.pickbar, el('div', 'store-batch-confirm'));
    add(box, el('p', 'store-batch-count', '确认升级下面 ' + list.length + ' 个插件：'));
    var ul = add(box, el('ul', 'store-batch-result-list'));
    var majorNames = [];
    list.forEach(function (item) {
      add(ul, el('li', null, (item.p.name || item.p.id) + ' v' + item.ins.version +
        ' → v' + item.p.version));
      if (isMajorJump(item.ins.version, item.p.version)) majorNames.push(item.p.name || item.p.id);
    });
    add(box, el('p', 'store-risk',
      '升级会重启这些插件，期间可能短暂不可用（通常几秒到几十秒）；配置与启用状态会保留。'));
    if (majorNames.length) {
      add(box, el('p', 'store-risk is-major',
        '其中 ' + majorNames.join('、') + ' 属于跨大版本升级（如 0.x → 1.x），' +
        '功能与配置项可能有变化，建议先展开各自的「更新说明」确认。'));
    }
    var actions = add(box, el('div', 'store-batch-actions'));
    var ok = add(actions, el('button', 'btn btn-primary', '确认升级'));
    ok.type = 'button';
    on(ok, function () { startBatch(list, S.batchConfirm.mode); });
    var cancel = add(actions, el('button', 'btn btn-ghost', '取消'));
    cancel.type = 'button';
    on(cancel, function () { S.batchConfirm = null; renderPickbar(); });
    if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
  }

  // 串行批量升级：固定清单逐个跑（并发安装会争 state.db 与同一插件目录），
  // 单个失败不中断队列；最后统一给出成功 / 失败 / 需重启三态。
  function startBatch(list, mode) {
    if (S.batch.running || !list.length) return;
    S.batchConfirm = null;
    S.batch = { running: true, done: 0, total: list.length, failed: [], results: [],
      message: '', current: '' };
    renderSummary();
    renderPickbar();
    var index = 0;
    function step() {
      if (index >= list.length) {
        var okN = 0, failN = 0, restartN = 0;
        S.batch.results.forEach(function (it) {
          if (it.state === 'ok') okN++;
          else if (it.state === 'restart') restartN++;
          else failN++;
        });
        S.batch.running = false;
        S.batch.current = '';
        var scope = mode === 'retry' ? '重试失败项' : (mode === 'selected' ? '所选' : '全部');
        S.batch.message = '批量升级完成（' + scope + '）：成功 ' + okN + ' 个' +
          (failN ? '，失败 ' + failN + ' 个' : '') +
          (restartN ? '，需重启 kored ' + restartN + ' 个' : '');
        S.selected = Object.create(null);
        renderSummary();
        loadInstalled();
        return;
      }
      var item = list[index];
      S.batch.current = (item.p.name || item.p.id) + '（v' + item.ins.version +
        ' → v' + item.p.version + '）';
      renderPickbar();
      runUpgrade(item.p, item.ins).then(function (res) {
        S.batch.done++;
        S.batch.results.push({ id: item.p.id, name: item.p.name || item.p.id,
          from: item.ins.version, to: item.p.version, state: res.state, message: res.message || '' });
        if (res.state === 'fail') S.batch.failed.push(item.p.id + '（v' + item.ins.version + '）');
        index++;
        step();
      });
    }
    step();
  }

  function renderGrid() {
    if (!S.grid) return;
    var list = visible();
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (S.page > pages) S.page = pages;
    if (S.page < 1) S.page = 1;
    var start = (S.page - 1) * PAGE_SIZE;
    var pageList = list.slice(start, start + PAGE_SIZE);
    S.grid.textContent = '';
    pageList.forEach(function (p) { S.grid.appendChild(renderCard(p)); });
    S.empty.textContent = '';
    paintEmpty(list.length);
    renderPager(list.length, pages);
    var up = upgradable().length;
    S.stats.textContent = (S.plugins.length
      ? '共 ' + S.plugins.length + ' 个插件 · 已安装 ' + Object.keys(S.installed).length + ' 个' +
        (up ? ' · ' + up + ' 个可升级' : ' · 全部已是最新')
      : '索引暂不可用') + ' · 匹配 ' + list.length + ' 个 · 第 ' + S.page + '/' + pages +
      ' 页（每页 ' + PAGE_SIZE + ' 个）';
    renderSummary();
    renderPickbar();
  }
  // renderPager：上一页 / 页码 / 下一页；只有一页时不渲染多余控件。
  function renderPager(total, pages) {
    if (!S.pager) return;
    S.pager.textContent = '';
    if (!total) return;
    var row = add(S.pager, el('div', 'db-auto-actions store-pager'));
    var prev = add(row, el('button', 'btn btn-ghost', '上一页'));
    prev.type = 'button'; prev.disabled = S.page <= 1;
    on(prev, function () { if (S.page > 1) { S.page--; renderGrid(); } });
    add(row, el('span', 'muted', '第 ' + S.page + ' / ' + pages + ' 页 · 共 ' + total + ' 个插件'));
    var next = add(row, el('button', 'btn btn-ghost', '下一页'));
    next.type = 'button'; next.disabled = S.page >= pages;
    on(next, function () { if (S.page < pages) { S.page++; renderGrid(); } });
  }

  // 安装端点要求本地包路径：只有后端明确要求时才在卡片内展开，页面不常驻技术输入框。
  function needsPackagePath(res) {
    var b = (res && res.data) || {};
    return /package_path/i.test(String(b.message || '') + ' ' + String(b.detail || ''));
  }

  function showPkgPrompt(card, p) {
    // setStatus 会重绘网格：按插件 id 取当前在 DOM 里的卡片，避免把输入框插进已分离的旧节点。
    if (S.grid) {
      var live = S.grid.querySelector('.store-card[data-plugin-id="' + p.id + '"]');
      if (live) card = live;
    }
    var old = card.querySelector('.store-pkg-inline');
    if (old) { old.querySelector('input').focus(); return; }
    var box = el('div', 'store-pkg-inline');
    var label = add(box, el('label', 'store-pkg-inline-label', '安装本地插件包需要填写服务器上的包路径'));
    var pkgInput = add(label, input('store-pkg-inline-input', '/path/to/plugin-0.1.0.tar.gz', '本地包路径'));
    var actions = add(box, el('div', 'store-pkg-inline-actions'));
    var ok = add(actions, el('button', 'btn btn-primary', '确认安装'));
    ok.type = 'button';
    var cancel = add(actions, el('button', 'btn btn-ghost', '取消'));
    cancel.type = 'button';
    function close() { if (box.parentNode) box.parentNode.removeChild(box); }
    on(ok, function () {
      var path = pkgInput.value.trim();
      if (!path) { pkgInput.focus(); return; }
      close();
      doInstall(p, card, path);
    });
    on(cancel, function () { close(); setStatus(p.id, '', ''); });
    pkgInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); ok.click(); }
    });
    var status = card.querySelector('.store-card-status');
    card.insertBefore(box, status);
    pkgInput.focus();
  }

  // 重装二次确认：覆盖安装目录但保留配置，不静默执行。
  function showReinstallConfirm(card, p) {
    if (S.grid) {
      var live = S.grid.querySelector('.store-card[data-plugin-id="' + p.id + '"]');
      if (live) card = live;
    }
    if (card.querySelector('.store-confirm')) return;
    var box = el('div', 'store-pkg-inline store-confirm');
    add(box, el('p', 'store-pkg-inline-label', '重装会覆盖当前安装目录，配置保留。'));
    var actions = add(box, el('div', 'store-pkg-inline-actions'));
    var ok = add(actions, el('button', 'btn btn-primary', '确认重装'));
    ok.type = 'button';
    var cancel = add(actions, el('button', 'btn btn-ghost', '取消'));
    cancel.type = 'button';
    function close() { if (box.parentNode) box.parentNode.removeChild(box); }
    on(ok, function () { close(); doReinstall(p, card); });
    on(cancel, function () { close(); });
    var status = card.querySelector('.store-card-status');
    card.insertBefore(box, status);
  }

  // 升级二次确认：明确当前 → 目标版本，并说明 force 覆盖不丢配置与启用状态。
  function showUpgradeConfirm(card, p, ins, target) {
    if (S.grid) {
      var live = S.grid.querySelector('.store-card[data-plugin-id="' + p.id + '"]');
      if (live) card = live;
    }
    if (card.querySelector('.store-confirm')) return;
    var box = el('div', 'store-pkg-inline store-confirm');
    add(box, el('p', 'store-pkg-inline-label', '当前 v' + ins.version + ' → 新 v' + target + '。'));
    // 风险提示与批量确认同一口径：升级会重启插件、跨大版本另有强提示。
    upgradeRiskLines(ins, target).forEach(function (line, idx) {
      add(box, el('p', 'store-risk' + (idx === 1 ? ' is-major' : ''), line));
    });
    var actions = add(box, el('div', 'store-pkg-inline-actions'));
    var ok = add(actions, el('button', 'btn btn-primary', '确认升级'));
    ok.type = 'button';
    var cancel = add(actions, el('button', 'btn btn-ghost', '取消'));
    cancel.type = 'button';
    function close() { if (box.parentNode) box.parentNode.removeChild(box); }
    on(ok, function () {
      close();
      runUpgrade(p, ins).then(function (res) { if (res.state === 'ok') loadInstalled(); });
    });
    on(cancel, function () { close(); });
    var status = card.querySelector('.store-card-status');
    card.insertBefore(box, status);
  }

  // 卸载二次确认：插件名 + 删除范围 + 不可撤销；确认键用危险色，正文可折行不溢出。
  function showUninstallConfirm(card, p) {
    if (S.grid) {
      var live = S.grid.querySelector('.store-card[data-plugin-id="' + p.id + '"]');
      if (live) card = live;
    }
    if (card.querySelector('.store-confirm')) return;
    var name = p.name || p.id;
    var box = el('div', 'store-pkg-inline store-confirm');
    box.style.maxWidth = '100%';
    var title = add(box, el('strong', 'store-confirm-title',
      T('store.uninstall.confirmTitle', '确认卸载 {name}').replace('{name}', name)));
    title.style.display = 'block';
    var body = add(box, el('p', 'store-pkg-inline-label',
      T('store.uninstall.confirmBody', '将停止该插件并删除其程序文件（data/plugins/' + p.id +
        '/ 下所有版本）。插件业务数据（安装目录外）不受影响。此操作不可撤销。')));
    body.style.wordBreak = 'break-word';
    var actions = add(box, el('div', 'store-pkg-inline-actions'));
    var cancel = add(actions, el('button', 'btn btn-ghost', T('store.uninstall.cancel', '取消')));
    cancel.type = 'button';
    var ok = dangerBtn(T('store.uninstall.confirmOk', '确认卸载'), 'store-confirm-ok');
    actions.insertBefore(ok, cancel);
    function close() { if (box.parentNode) box.parentNode.removeChild(box); }
    on(ok, function () { close(); doUninstall(p, p.id); });
    on(cancel, function () { close(); });
    var status = card.querySelector('.store-card-status');
    card.insertBefore(box, status);
  }

  // 失败文案：后端 message + detail 之外，按错误码补一条可执行的下一步。
  function upgradeFailText(res) {
    var code = (res && res.data && res.data.code) || '';
    var msg = errText(res);
    if (code === 'E_CONFLICT') msg += ' · 可先点「重装」再试';
    else if (code === 'E_UPSTREAM') msg += ' · 检查网络或镜像后重试';
    else if (code === 'E_UNAUTHORIZED') msg += ' · 索引刚更新时需重启 kored';
    return msg;
  }

  // 单个升级：download=true + force=true（同 id 更换版本），后端保留 desired_state 并重载。
  // 返回 Promise<boolean>；同时把进度写进卡片状态条，批量与单点共用。
  function runUpgrade(p, ins) {
    var target = p.version;
    var stop = beginProgress(p.id, target);
    setStatus(p.id, 'busy', '升级中…');
    return postJson(U.install, { id: p.id, version: target, download: true, force: true })
      .then(function (res) {
        stop();
        if (restartRequired(res)) {
          setStatus(p.id, 'fail', '索引已更新，需重启 kored');
          showRestartNotice(res);
          return { state: 'restart', message: '索引刚更新，需重启 kored 后才能继续升级' };
        }
        if (res.status === 401) {
          setStatus(p.id, 'fail', '登录已过期，请重新登录');
          return { state: 'fail', message: '登录已过期，请重新登录' };
        }
        if (!res.ok) {
          var why = upgradeFailText(res);
          setStatus(p.id, 'fail', '升级失败：' + why);
          return { state: 'fail', message: why };
        }
        var data = res.data || {};
        var reenabled = ins.desired !== 'disabled' && ins.enabled !== false;
        var msg = '已升级到 v' + target + (reenabled ? ' · 已重新启用' : ' · 保持停用');
        if (data.reload) msg += '（' + data.reload + '）';
        if (data.stale_versions && data.stale_versions.length) {
          msg += ' · 旧版本文件仍占用磁盘，可稍后手动删除 data/plugins/' + p.id + '/' +
            data.stale_versions.join('、data/plugins/' + p.id + '/') + '。';
        }
        setStatus(p.id, 'ok', msg);
        return { state: 'ok', message: msg };
      }, function (err) {
        stop();
        var net = err && err.message ? err.message : '网络错误';
        setStatus(p.id, 'fail', '升级失败：' + net);
        return { state: 'fail', message: net };
      });
  }

  // 重装：download=true + force=true，允许覆盖已装同版本；仍走索引摘要与包校验。
  function doReinstall(p, card) {
    var stop = beginProgress(p.id, p.version);
    setStatus(p.id, 'busy', '重装中…');
    var body = { id: p.id, version: p.version, download: true, force: true };
    postJson(U.install, body).then(function (res) {
      stop();
      if (restartRequired(res)) {
        setStatus(p.id, 'fail', '索引已更新，需重启 kored');
        showRestartNotice(res);
        return;
      }
      if (res.status === 401) return setStatus(p.id, 'fail', '登录已过期，请重新登录');
      if (!res.ok) return setStatus(p.id, 'fail', '重装失败：' + errText(res));
      var reload = (res.data && res.data.reload) ? '（' + res.data.reload + '）' : '';
      setStatus(p.id, 'ok', '重装成功' + reload);
      loadInstalled();
    }).catch(function (err) {
      stop();
      setStatus(p.id, 'fail', '重装失败：' + (err && err.message ? err.message : '网络错误'));
    });
  }

  // 安装/升级进度：优先订阅 GET /api/v1/events（SSE，请求级连接），显示真实阶段 + 百分比；
  // SSE 不可用（浏览器不支持 / 401 / 501 / 断网）时静默降级为按耗时的伪进度，不报错。
  var SSE_URL = '/api/v1/events';
  var PHASES = { download: '正在下载…', verify: '正在校验签名…', extract: '正在解包…',
    register: '正在登记插件…', reload: '正在重载插件…' };
  function phaseLabel(phase) { return PHASES[phase] || '安装中…'; }
  function parseEvent(raw) {
    try { return JSON.parse(raw || '{}'); } catch (e) { return null; }
  }
  // task_id 与后端同口径：<plugin-id>@<version>，用于过滤并发安装事件。
  function beginProgress(id, version) {
    var taskId = String(id) + '@' + String(version);
    var real = false, stopped = false, es = null;
    var timers = [
      setTimeout(function () { if (!real && !stopped) setStatus(id, 'busy', '校验中…'); }, 2500),
      setTimeout(function () { if (!real && !stopped) setStatus(id, 'busy', '安装中…'); }, 7000)
    ];
    function clearFake() {
      for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
      timers = [];
    }
    function show(text) {
      var st = S.status[id];
      if (st && st.kind === 'busy') setStatus(id, 'busy', text);
    }
    if (window.EventSource) {
      try {
        es = new window.EventSource(SSE_URL);
        es.addEventListener('task.progress', function (ev) {
          var d = parseEvent(ev.data);
          if (!d || d.task_id !== taskId) return;
          real = true;
          clearFake();
          show(phaseLabel(d.phase) + ' ' + (typeof d.percent === 'number' ? d.percent : 0) + '%');
        });
        es.addEventListener('task.failed', function (ev) {
          var d = parseEvent(ev.data);
          if (!d || d.task_id !== taskId) return;
          real = true;
          clearFake();
          var where = d.phase ? '（' + phaseLabel(d.phase) + '阶段）' : '';
          setStatus(id, 'fail', '安装失败' + where + '：' + (d.message || '未知错误'));
          if (es) { es.close(); es = null; }
        });
        es.addEventListener('error', function () {
          // 未收到任何真实事件就出错：判定 SSE 不可用，关闭连接并让伪进度继续。
          if (real || stopped) return;
          if (es) { es.close(); es = null; }
        });
      } catch (err) {
        es = null;
      }
    }
    return function stop() {
      stopped = true;
      clearFake();
      if (es) { es.close(); es = null; }
    };
  }

  function doInstall(p, card, path) {
    var stop = beginProgress(p.id, p.version);
    var body = { id: p.id, version: p.version };
    if (path) body.package_path = path;
    else body.download = true;
    postJson(U.install, body).then(function (res) {
      stop();
      if (restartRequired(res)) {
        setStatus(p.id, 'fail', '索引已更新，需重启 kored');
        showRestartNotice(res);
        return;
      }
      if (res.status === 401) return setStatus(p.id, 'fail', '登录已过期，请重新登录');
      if (!res.ok) {
        if (!path && needsPackagePath(res)) {
          setStatus(p.id, 'note', '当前版本需从本地包安装');
          showPkgPrompt(card, p);
          return;
        }
        return setStatus(p.id, 'fail', '安装失败：' + errText(res));
      }
      setStatus(p.id, 'ok', '安装成功');
      autoEnableAfterInstall(p);
    }).catch(function (err) {
      stop();
      setStatus(p.id, 'fail', '安装失败：' + (err && err.message ? err.message : '网络错误'));
    });
  }
  // 卸载：后端没有 DELETE /api/v1/plugins 端点，只保留停用，不假装卸载成功。
  function doEnable(id) {
    setStatus(id, 'busy', '启用中…');
    postJson(U.enable + encodeURIComponent(id) + '/enable', {}).then(function (res) {
      if (!res.ok) return setStatus(id, 'fail', '启用失败：' + errText(res));
      setStatus(id, 'ok', '已启用');
      loadInstalled();
    }, function (err) {
      setStatus(id, 'fail', '启用失败：' + (err && err.message ? err.message : '网络错误'));
    });
  }

  // 安装成功后默认启用；失败保留已安装状态，并把原因和「去处理」留在卡片上。
  function autoEnableAfterInstall(p) {
    setStatus(p.id, 'busy', '安装成功 · 正在启用…');
    postJson(U.enable + encodeURIComponent(p.id) + '/enable', {}).then(function (res) {
      if (!res.ok) {
        setStatus(p.id, 'fail', '安装成功，但启用失败：' + errText(res) + ' · 去「已装插件」处理',
          '#/plugins', '去处理');
        loadInstalled();
        return;
      }
      var next = NEXT_VIEW[p.id];
      setStatus(p.id, 'ok', '安装成功 · 已自动启用', next ? next.href : '', next ? next.label : '');
      loadInstalled();
    }, function (err) {
      setStatus(p.id, 'fail', '安装成功，但启用失败：' +
        (err && err.message ? err.message : '网络错误') + ' · 去「已装插件」处理', '#/plugins', '去处理');
      loadInstalled();
    });
  }

  function doDisable(id) {
    setStatus(id, 'busy', '停用中…');
    postJson(U.disable + encodeURIComponent(id) + '/disable', {}).then(function (res) {
      if (!res.ok) return setStatus(id, 'fail', '停用失败：' + errText(res));
      setStatus(id, 'note', '已停用（可随时再启用）'); return loadInstalled();
    }).catch(function (err) { setStatus(id, 'fail', '停用失败：' + (err && err.message ? err.message : '网络错误')); });
  }
  // DELETE 写请求：CSRF 双提交与 POST 同一条中间件链，不做 POST 伪装。
  function deleteJson(url) {
    var token = readCookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌（kore_csrf），请刷新页面或重新登录'));
    return request(url, { method: 'DELETE', headers: { 'X-Kore-CSRF': token } });
  }
  // 一次性能力探测（G-19：无定时器、无轮询）：用永不安装的 id 探 DELETE，
  // 老内核回 404/405/501 → 直接禁用按钮；新内核回 200 already_absent（无副作用）。
  function probeUninstall() {
    if (S.probedUninstall) return;
    S.probedUninstall = true;
    deleteJson(U.uninstall + 'kore-uninstall-probe').then(function (res) {
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        S.uninstallOff = true;
        renderGrid();
      }
    }, function () { /* 网络故障不降级：避免把暂时性错误误判为内核不支持 */ });
  }
  // 卸载结果六种人话：成功 / 已不在（非错误）/ 409 停不下来（原状未变）/ 503 已整体回滚 /
  // 400 原样 message / 501 内核不支持；404·405 视为老内核并禁用按钮。
  function doUninstall(p, id) {
    setStatus(id, 'busy', '卸载中…');
    deleteJson(U.uninstall + encodeURIComponent(id)).then(function (res) {
      var d = res.data || {};
      if (res.ok && res.status === 200) {
        if (d.already_absent === true) setStatus(id, 'ok', T('store.uninstall.absent', '该插件已不在，列表已同步'));
        else setStatus(id, 'ok', T('store.uninstall.ok', '已卸载 {name}').replace('{name}', p.name || id));
        return loadInstalled(); // 复用既有刷新函数，不新增轮询
      }
      if (res.status === 404 || res.status === 405) {
        S.uninstallOff = true;
        return setStatus(id, 'fail', T('store.uninstall.unsupported', '当前内核版本不支持卸载插件'));
      }
      if (res.status === 409) {
        return setStatus(id, 'fail', T('store.uninstall.conflict',
          '插件停不下来，未做任何删除；请查看插件日志或稍后重试'));
      }
      if (res.status === 503) {
        return setStatus(id, 'fail', T('store.uninstall.audit',
          '审计写入失败，操作已整体回滚，插件仍完好'));
      }
      if (res.status === 501) {
        S.uninstallOff = true;
        return setStatus(id, 'fail', T('store.uninstall.unsupportedHint', '当前内核版本不支持卸载'));
      }
      if (res.status === 401) return setStatus(id, 'fail', '登录已过期，请重新登录');
      return setStatus(id, 'fail', '卸载失败：' + errText(res)); // 400 等输入错误原样显示
    }, function (err) {
      setStatus(id, 'fail', '卸载失败：' + (err && err.message ? err.message : '网络错误'));
    });
  }

  function loadInstalled() {
    return request(U.installed).then(function (res) {
      S.installed = Object.create(null);
      if (res.ok && res.data && res.data.plugins) res.data.plugins.forEach(function (p) { S.installed[p.id] = p; });
      // 升级完成后插件不再可升级：清掉失效勾选，避免「已选 3 个」却只剩 1 张可升级卡片。
      pruneSelection(upgradable());
      renderGrid();
      probeUninstall(); // 首轮加载探一次卸载能力（只读语义的幂等 DELETE，不轮询）
    }, function () { /* 已安装列表失败不阻塞商店主视图 */ });
  }

  function buildShell(root) {
    var head = add(root, el('header', 'store-head'));
    var titleBox = add(head, el('div'));
    add(titleBox, el('h2', 'store-title', '软件商店'));
    S.stats = add(titleBox, el('p', 'store-sub', '正在读取索引…'));
    S.stats.setAttribute('aria-live', 'polite');
    S.notice = add(root, el('div', 'notice store-notice'));
    S.notice.hidden = true;
    // 验签失败专用提示条：醒目、常驻，错误码折叠在 details 内（不淹没结论）。
    S.restart = add(root, el('div', 'notice store-restart'));
    S.restart.hidden = true;
    S.restart.style.cssText = 'display:none;border-left:4px solid #d97706;background:#fff7e6;color:#7a4b00;padding:10px 14px;margin:12px 0;';
    var restartTitle = add(S.restart, el('strong', 'store-restart-title',
      '索引已更新，需重启 kored 才能载入新公钥'));
    restartTitle.style.display = 'block';
    add(S.restart, el('div', 'store-restart-hint',
      '重启 kored 后刷新本页即可恢复商店；旧进程仍持有旧公钥，重试安装不会自动恢复。'));
    var detail = add(S.restart, el('details', 'store-restart-detail'));
    add(detail, el('summary', '', '错误码'));
    S.restartCode = add(detail, el('code', 'store-restart-code', ''));
    // 顶部升级汇总：先占位，已安装数据返回后由 renderSummary 填充。
    S.summary = add(root, el('div', 'store-upgrade-summary'));
    S.summary.hidden = true;
    // 勾选批量操作带：可升级项 > 0 或有批量结果时由 renderPickbar 填充。
    S.pickbar = add(root, el('div', 'store-batch'));
    S.pickbar.hidden = true;
    root.appendChild(renderPresets());
    var bar = add(root, el('div', 'store-bar'));
    var search = add(bar, input('store-search', '按 id / 名称搜索插件', '搜索插件', 'search'));
    S.searchInput = search;
    search.addEventListener('input', function () { S.q = search.value; S.page = 1; renderGrid(); });
    // 状态筛选（全部 / 已安装 / 可更新）：放在分类前面，因为它回答的是更前置的问题
    // 「我关心的是哪个范围」；复用 .store-cat 的既有样式，不新增 CSS。
    var scopes = add(bar, el('div', 'store-scopes'));
    scopes.setAttribute('role', 'group'); scopes.setAttribute('aria-label', '按安装状态筛选');
    SCOPES.forEach(function (sc) {
      var b = add(scopes, on(el('button', 'store-cat store-scope', sc.label), function () {
        S.scope = sc.id;
        S.page = 1;
        var all = scopes.querySelectorAll('.store-scope');
        for (var i = 0; i < all.length; i++) {
          all[i].setAttribute('aria-pressed', all[i].dataset.scope === sc.id ? 'true' : 'false');
        }
        renderGrid();
      }));
      b.type = 'button'; b.dataset.scope = sc.id;
      b.setAttribute('aria-pressed', sc.id === S.scope ? 'true' : 'false');
    });
    var cats = add(bar, el('div', 'store-cats'));
    cats.setAttribute('role', 'group'); cats.setAttribute('aria-label', '按分类筛选');
    CATS.forEach(function (c) {
      var b = add(cats, on(el('button', 'store-cat', c.label), function () {
        S.cat = c.id;
        S.page = 1;
        var all = cats.querySelectorAll('.store-cat');
        for (var i = 0; i < all.length; i++) {
          all[i].setAttribute('aria-pressed', all[i].dataset.cat === c.id ? 'true' : 'false');
        }
        renderGrid();
      }));
      b.type = 'button'; b.dataset.cat = c.id;
      b.setAttribute('aria-pressed', c.id === S.cat ? 'true' : 'false');
    });
    S.grid = add(root, el('div', 'store-grid'));
    S.pager = add(root, el('div', 'store-pager-host'));
    S.empty = add(root, el('div', 'store-empty'));
    // .store-empty 是居中式旧样式；空态块左对齐更好读（标题/说明/按钮一条竖线），故就地覆盖。
    S.empty.style.textAlign = 'left';
    S.empty.hidden = true;
  }

  // reload 给空态的「重新读取索引」用：整页重挂一次，拿到最新索引/已装列表。
  function reload() {
    if (S.container) return render(S.container);
    return Promise.resolve(false);
  }

  function render(container) {
    if (!container) return Promise.reject(new Error('KoreStore.render 需要容器元素'));
    S.container = container;
    ensureUpgradeStyle();
    container.textContent = '';
    var root = add(container, el('section', 'store'));
    buildShell(root);
    renderGrid();
    return Promise.all([request(U.plugins), request(U.presets), request(U.installed)]).then(function (out) {
      // 列表错误不白屏：提示条如实显示 code+message（索引缺失时 502 是真实状态）。
      var bad = null, needsRestart = null;
      if (out[0].ok && out[0].data && out[0].data.plugins) S.plugins = out[0].data.plugins;
      else {
        S.plugins = [];
        if (restartRequired(out[0])) needsRestart = out[0];
        else bad = '商店索引读取失败：' + errText(out[0]);
      }
      if (out[1].ok && out[1].data && out[1].data.presets) S.presets = out[1].data.presets;
      else {
        S.presets = [];
        if (restartRequired(out[1])) needsRestart = needsRestart || out[1];
        else bad = bad || '预设读取失败：' + errText(out[1]);
      }
      if (needsRestart) showRestartNotice(needsRestart);
      if (bad) { S.notice.hidden = false; S.notice.textContent = bad; }
      S.installed = Object.create(null);
      if (out[2].ok && out[2].data && out[2].data.plugins) {
        out[2].data.plugins.forEach(function (p) { S.installed[p.id] = p; });
      }
      var old = root.querySelector('.store-presets');
      if (old) root.replaceChild(renderPresets(), old);
      renderGrid();
      return { plugins: S.plugins.length, presets: S.presets.length };
    });
  }
  window.KoreStore = { render: render };
})();
