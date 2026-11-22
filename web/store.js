// web/store.js — kore 软件商店：卡片网格 + 内联图标 + 分类筛选 + 搜索 + 安装/停用。
// 零框架 / 零 CDN / 无外链，图标全部内联 emoji，对外只暴露 window.KoreStore.render(container)。
// 数据：商店索引 / 预设 / 已安装列表；写：安装、停用（X-Kore-CSRF 双提交）。
// 安装需要 package_path 时才在该卡片内展开路径输入，不在页面顶部常驻技术字段；
// 卸载端点未实现时只提供「停用」，并用「待支持」轻量标签说明，不假装卸载成功。
(function () {
  'use strict';
  var U = { plugins: '/api/v1/store/plugins', presets: '/api/v1/store/presets',
    install: '/api/v1/store/install', installed: '/api/v1/plugins', disable: '/api/v1/plugins/' };
  // 图标映射：按 id 固定 emoji，21 个插件两两可区分（无外链、无字体依赖）。
  var ICONS = { echo: '🔁', site: '🌐', file: '📁', ssl: '🔒', integrity: '🧾', cron: '⏰',
    'ssh-guard': '🔑', monitor: '📈', logs: '📜', dns: '🧭', 'runtime-php': '🧩', 'runtime-node': '🟢',
    'runtime-python': '🐍', 'db-mysql': '🗄️', 'db-postgres': '🐘', redis: '⚡', backup: '💾',
    firewall: '🛡️', waf: '🚧', container: '📦', 'app-deploy': '🚀' };
  // 分类按 scenario_tags 映射；多标签插件会出现在多个分类（file = ops + data）。
  var CATS = [{ id: 'all', label: '全部', tags: [] }, { id: 'site', label: '站点与运行时', tags: ['web', 'app'] },
    { id: 'data', label: '数据库', tags: ['data'] }, { id: 'ops', label: '运维', tags: ['ops'] },
    { id: 'sec', label: '安全', tags: ['sec'] }];
  var CN = { web: '站点', app: '运行时', data: '数据库', ops: '运维', sec: '安全' };
  var S = { plugins: [], presets: [], installed: Object.create(null), status: Object.create(null),
    cat: 'all', q: '', grid: null, empty: null, stats: null, notice: null };
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
    if (b.detail) msg += '（' + b.detail + '）';
    return msg;
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
  function visible() {
    var q = S.q.trim().toLowerCase();
    return S.plugins.filter(function (p) {
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
    var icon = add(top, el('span', 'store-icon', ICONS[p.id] || '📦'));
    icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', (p.name || p.id) + ' 图标');
    var head = add(top, el('div', 'store-card-head'));
    add(head, el('div', 'store-card-name', p.name || p.id));
    var sub = add(head, el('div', 'store-card-sub'));
    add(sub, el('span', 'store-card-ver', 'v' + (p.version || '?')));
    var badges = add(card, el('div', 'store-badges'));
    var depth = p.depth_level === 'production' ? 'production' : 'basic';
    add(badges, el('span', 'store-badge ' + depth, depth === 'production' ? 'production · 生产级' : 'basic · 基础级'));
    if (ins) add(badges, el('span', 'store-badge installed', '已安装 ✅'));
    add(card, el('p', 'store-desc', descOf(p)));
    var st = S.status[p.id];
    var status = add(card, el('div', 'store-card-status' + (st ? ' is-' + st.kind : ''), st ? st.text : ''));
    status.setAttribute('role', 'status');
    var ops = add(card, el('div', 'store-ops'));
    if (ins) {
      var unsupported = add(ops, el('span', 'tag tag-muted', '待支持'));
      unsupported.title = '当前版本暂不支持卸载，可先停用插件';
      var off = add(ops, el('button', 'btn store-btn-danger', '停用'));
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

  function renderGrid() {
    if (!S.grid) return;
    var list = visible();
    S.grid.textContent = '';
    list.forEach(function (p) { S.grid.appendChild(renderCard(p)); });
    S.empty.hidden = list.length !== 0;
    S.stats.textContent = (S.plugins.length
      ? '共 ' + S.plugins.length + ' 个插件 · 已安装 ' + Object.keys(S.installed).length + ' 个'
      : '索引暂不可用') + ' · 当前显示 ' + list.length + ' 个';
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

  // 安装默认走索引自动下载（download:true）；后端未就绪时降级为本地包路径。
  // 进度按请求耗时给出阶段提示（后端当前无分阶段事件），结束后立刻收敛为成功/失败。
  function beginProgress(id) {
    setStatus(id, 'busy', '下载中…');
    var timers = [
      setTimeout(function () {
        var st = S.status[id];
        if (st && st.kind === 'busy' && st.text === '下载中…') setStatus(id, 'busy', '校验中…');
      }, 2500),
      setTimeout(function () {
        var st = S.status[id];
        if (st && st.kind === 'busy' && st.text === '校验中…') setStatus(id, 'busy', '安装中…');
      }, 7000)
    ];
    return function stop() {
      for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    };
  }

  function doInstall(p, card, path) {
    var stop = beginProgress(p.id);
    var body = { id: p.id, version: p.version };
    if (path) body.package_path = path;
    else body.download = true;
    postJson(U.install, body).then(function (res) {
      stop();
      if (res.status === 401) return setStatus(p.id, 'fail', '登录已过期，请重新登录');
      if (!res.ok) {
        if (!path && needsPackagePath(res)) {
          setStatus(p.id, 'note', '当前版本需从本地包安装');
          showPkgPrompt(card, p);
          return;
        }
        return setStatus(p.id, 'fail', '安装失败：' + errText(res));
      }
      setStatus(p.id, 'ok', '安装成功 ✅');
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
    root.appendChild(renderPresets());
    var bar = add(root, el('div', 'store-bar'));
    var search = add(bar, input('store-search', '按 id / 名称搜索插件', '搜索插件', 'search'));
    search.addEventListener('input', function () { S.q = search.value; renderGrid(); });
    var cats = add(bar, el('div', 'store-cats'));
    cats.setAttribute('role', 'group'); cats.setAttribute('aria-label', '按分类筛选');
    CATS.forEach(function (c) {
      var b = add(cats, on(el('button', 'store-cat', c.label), function () {
        S.cat = c.id;
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
      var bad = null;
      if (out[0].ok && out[0].data && out[0].data.plugins) S.plugins = out[0].data.plugins;
      else { S.plugins = []; bad = '商店索引读取失败：' + errText(out[0]); }
      if (out[1].ok && out[1].data && out[1].data.presets) S.presets = out[1].data.presets;
      else { S.presets = []; bad = bad || '预设读取失败：' + errText(out[1]); }
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
