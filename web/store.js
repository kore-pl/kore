// web/store.js — kore 软件商店：卡片网格 + 内联图标 + 分类筛选 + 搜索 + 安装/停用。
// 零框架 / 零 CDN / 无外链，图标全部内联线性 SVG（禁 emoji，FRONTEND 红线 8），对外只暴露 window.KoreStore.render(container)。
// 数据：商店索引 / 预设 / 已安装列表；写：安装、停用（X-Kore-CSRF 双提交）。
// 调用形态：POST /api/v1/invoke/<id>/<id>.<action> —— 本视图不调 invoke，只走下方管理端点；
// 一旦引入插件业务方法，方法段必须写 <id>.<action>，不得用裸动词。
// 安装需要 package_path 时才在该卡片内展开路径输入，不在页面顶部常驻技术字段；
// 卸载端点未实现时只提供「停用」，并用「待支持」轻量标签说明，不假装卸载成功。
(function () {
  'use strict';
  var U = { plugins: '/api/v1/store/plugins', presets: '/api/v1/store/presets',
    install: '/api/v1/store/install', installed: '/api/v1/plugins', disable: '/api/v1/plugins/' };
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
  var CATS = [{ id: 'all', label: '全部', tags: [] }, { id: 'site', label: '站点与运行时', tags: ['web', 'app'] },
    { id: 'data', label: '数据库', tags: ['data'] }, { id: 'ops', label: '运维', tags: ['ops'] },
    { id: 'sec', label: '安全', tags: ['sec'] }];
  var CN = { web: '站点', app: '运行时', data: '数据库', ops: '运维', sec: '安全' };
  // 商店每页 12 个卡片（24 个插件正好 2 页），避免分类筛选后某类很多时页面无限拉长。
  var PAGE_SIZE = 12;
  var S = { plugins: [], presets: [], installed: Object.create(null), status: Object.create(null),
    cat: 'all', q: '', page: 1, grid: null, empty: null, stats: null, notice: null,
    summary: null, batchStatus: null,
    batch: { running: false, done: 0, total: 0, failed: [], message: '' },
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
  function visible() {
    var q = S.q.trim().toLowerCase();
    return allCards().filter(function (p) {
      if (!inCat(p, S.cat)) return false;
      if (!q) return true;
      return [p.id, p.name].concat(p.scenario_tags || []).join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  function setStatus(id, kind, text) { S.status[id] = { kind: kind, text: text }; renderGrid(); }
  function input(cls, ph, label, type) {
    var i = el('input', 'field-input ' + cls);
    i.type = type || 'text'; i.placeholder = ph; i.setAttribute('autocomplete', 'off');
    if (label) i.setAttribute('aria-label', label);
    return i;
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
    var depth = p.depth_level === 'production' ? 'production' : 'basic';
    add(badges, el('span', 'store-badge ' + depth, depth === 'production' ? 'production · 生产级' : 'basic · 基础级'));
    var state = cardState(ins, p.version);
    if (state === 'latest') {
      var installedBadge = add(badges, el('span', 'store-badge installed'));
      installedBadge.appendChild(checkSvg());
      add(installedBadge, el('span', null, '已安装'));
      add(badges, el('span', 'store-badge muted', '已是最新'));
    } else if (state === 'upgradable') {
      add(badges, el('span', 'store-badge installed', '已安装'));
      add(badges, el('span', 'store-badge upgrade', '可升级 v' + ins.version + ' → v' + p.version));
    } else if (state === 'unindexed') {
      add(badges, el('span', 'store-badge installed', '已安装'));
      add(badges, el('span', 'store-badge muted', '索引未收录'));
    }
    add(card, el('p', 'store-desc', descOf(p)));
    var st = S.status[p.id];
    var status = add(card, el('div', 'store-card-status' + (st ? ' is-' + st.kind : '')));
    if (st && st.kind === 'ok') status.appendChild(checkSvg()); // 成功勾用 SVG，不用 emoji
    if (st) add(status, el('span', null, st.text));
    status.setAttribute('role', 'status');
    var ops = add(card, el('div', 'store-ops'));
    if (ins) {
      var unsupported = add(ops, el('span', 'tag tag-muted', '待支持'));
      unsupported.title = '当前版本暂不支持卸载，可先停用插件';
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
      // 「停用」可逆 → 中性灰（C7 危险色通胀治理），类名同步去 danger 语义
      var off = add(ops, el('button', 'btn store-btn-muted', '停用'));
      off.title = unsupported.title;
      on(off, function () { doDisable(p.id); });
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
    btn.title = '逐个升级可升级插件；失败项会在下方列出';
    on(btn, doUpgradeAll);
    S.batchStatus = add(S.summary, el('span', 'store-upgrade-status'));
    S.batchStatus.setAttribute('role', 'status');
    if (S.batch.running) {
      S.batchStatus.textContent = '正在升级 ' + Math.min(S.batch.done + 1, S.batch.total) +
        '/' + S.batch.total + '…';
    } else if (S.batch.message) {
      S.batchStatus.textContent = S.batch.message;
      S.batchStatus.className = 'store-upgrade-status' +
        (S.batch.failed.length ? ' is-fail' : ' is-ok');
    }
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
    S.empty.hidden = list.length !== 0;
    renderPager(list.length, pages);
    var up = upgradable().length;
    S.stats.textContent = (S.plugins.length
      ? '共 ' + S.plugins.length + ' 个插件 · 已安装 ' + Object.keys(S.installed).length + ' 个' +
        (up ? ' · ' + up + ' 个可升级' : ' · 全部已是最新')
      : '索引暂不可用') + ' · 匹配 ' + list.length + ' 个 · 第 ' + S.page + '/' + pages +
      ' 页（每页 ' + PAGE_SIZE + ' 个）';
    renderSummary();
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
    add(box, el('p', 'store-pkg-inline-label',
      '当前 v' + ins.version + ' → 新 v' + target + '；升级会保留配置与启用状态。'));
    var actions = add(box, el('div', 'store-pkg-inline-actions'));
    var ok = add(actions, el('button', 'btn btn-primary', '确认升级'));
    ok.type = 'button';
    var cancel = add(actions, el('button', 'btn btn-ghost', '取消'));
    cancel.type = 'button';
    function close() { if (box.parentNode) box.parentNode.removeChild(box); }
    on(ok, function () {
      close();
      runUpgrade(p, ins).then(function (upgraded) { if (upgraded) loadInstalled(); });
    });
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
          return false;
        }
        if (res.status === 401) { setStatus(p.id, 'fail', '登录已过期，请重新登录'); return false; }
        if (!res.ok) { setStatus(p.id, 'fail', '升级失败：' + upgradeFailText(res)); return false; }
        var data = res.data || {};
        var reenabled = ins.desired !== 'disabled' && ins.enabled !== false;
        var msg = '已升级到 v' + target + (reenabled ? ' · 已重新启用' : ' · 保持停用');
        if (data.reload) msg += '（' + data.reload + '）';
        if (data.stale_versions && data.stale_versions.length) {
          msg += ' · 旧版本 ' + data.stale_versions.join('、') + ' 目录保留，可手动清理';
        }
        setStatus(p.id, 'ok', msg);
        return true;
      }, function (err) {
        stop();
        setStatus(p.id, 'fail', '升级失败：' + (err && err.message ? err.message : '网络错误'));
        return false;
      });
  }

  // 一键全部升级：固定清单逐个升级（串行，避免并发安装争 state.db 与同一插件目录）。
  // 进度 N/M 写在汇总条；失败项收集后一次性列出，不中断剩余升级。
  function doUpgradeAll() {
    if (S.batch.running) return;
    var list = upgradable();
    if (!list.length) return;
    S.batch = { running: true, done: 0, total: list.length, failed: [], message: '' };
    renderSummary();
    var index = 0;
    function step() {
      if (index >= list.length) {
        var okCount = list.length - S.batch.failed.length;
        S.batch.running = false;
        S.batch.message = '批量升级完成：成功 ' + okCount + ' 个' +
          (S.batch.failed.length ? '，失败 ' + S.batch.failed.length + ' 个（' +
            S.batch.failed.join('、') + '）' : '');
        loadInstalled();
        return;
      }
      var item = list[index];
      if (S.batchStatus) {
        S.batchStatus.textContent = '正在升级 ' + (index + 1) + '/' + S.batch.total +
          ' · ' + (item.p.name || item.p.id) + '（v' + item.ins.version + ' → v' + item.p.version + '）';
      }
      runUpgrade(item.p, item.ins).then(function (ok) {
        if (ok) S.batch.done++;
        else S.batch.failed.push(item.p.id + '（v' + item.ins.version + '）');
        index++;
        step();
      });
    }
    step();
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
      loadInstalled();
    }).catch(function (err) {
      stop();
      setStatus(p.id, 'fail', '安装失败：' + (err && err.message ? err.message : '网络错误'));
    });
  }
  // 无卸载能力：走停用，并明确说明当前版本只支持停用，不假装卸载成功。

  function doDisable(id) {
    setStatus(id, 'busy', '停用中…');
    postJson(U.disable + encodeURIComponent(id) + '/disable', {}).then(function (res) {
      if (!res.ok) return setStatus(id, 'fail', '停用失败：' + errText(res));
      setStatus(id, 'note', '已停用（当前版本暂不支持卸载）'); return loadInstalled();
    }).catch(function (err) { setStatus(id, 'fail', '停用失败：' + (err && err.message ? err.message : '网络错误')); });
  }
  function loadInstalled() {
    return request(U.installed).then(function (res) {
      S.installed = Object.create(null);
      if (res.ok && res.data && res.data.plugins) res.data.plugins.forEach(function (p) { S.installed[p.id] = p; });
      renderGrid();
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
    root.appendChild(renderPresets());
    var bar = add(root, el('div', 'store-bar'));
    var search = add(bar, input('store-search', '按 id / 名称搜索插件', '搜索插件', 'search'));
    search.addEventListener('input', function () { S.q = search.value; S.page = 1; renderGrid(); });
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
    S.empty = add(root, el('p', 'store-empty', '没有匹配的插件'));
    S.empty.hidden = true;
  }

  function render(container) {
    if (!container) return Promise.reject(new Error('KoreStore.render 需要容器元素'));
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
