// web/store.js — kore 软件商店：卡片网格 + 内联图标 + 分类筛选 + 搜索 + 安装/停用。
// 零框架 / 零 CDN / 无外链，图标全部内联 emoji，对外只暴露 window.KoreStore.render(container)。
// 数据：GET /store/plugins、/store/presets、/plugins；写：POST /store/install（X-Kore-CSRF 双提交）。
// 后端事实（实测，不伪造）：install 必填 id+version+package_path（缺则 400），故提供包路径输入；
// DELETE /store/plugins/{id} 当前 501，故"卸载"降级为 POST /plugins/{id}/disable 并标注端点待补。
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
  var LIFE = { resident: '常驻', lazy: '按需', oneshot: '一次性' };
  var S = { plugins: [], presets: [], installed: Object.create(null), status: Object.create(null),
    cat: 'all', q: '', pkgPath: '', grid: null, empty: null, stats: null, notice: null };
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
    var b = (res && res.data) || {}, code = b.code ? String(b.code) : 'HTTP ' + (res ? res.status : '?');
    return code + ' · ' + (b.message ? String(b.message) : '请求失败') + (b.detail ? '（' + b.detail + '）' : '');
  }
  function postJson(url, body) {
    var token = readCookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌（kore_csrf），请刷新页面或重新登录'));
    return request(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(body || {}) });
  }
  function sizeText(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '体积未知';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  }
  // 索引无 description 字段：用 scenario_tags + lifecycle + size 合成（不编造功能）。
  function descOf(p) {
    var tags = (p.scenario_tags || []).map(function (t) { return CN[t] || t; }).join(' / ');
    return (tags || '通用') + '场景 · ' + (LIFE[p.lifecycle] || p.lifecycle || '未知') + ' · ' + sizeText(p.size_bytes);
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
    if (!S.presets.length) add(row, el('p', 'store-preset-empty',
      '后端未装配预设目录（KORE_PRESETS_DIR 为空），预设列表为空。'));
    S.presets.forEach(function (p) {
      var c = add(row, el('article', 'store-preset'));
      add(c, el('div', 'store-preset-name', p.name || p.id));
      add(c, el('div', 'store-preset-sub', (p.plugins ? p.plugins.length : 0) + ' 个插件 · ' +
        (p.out_of_box ? '开箱可用' : '需按需启用')));
      var b = add(c, el('button', 'btn store-preset-btn', '一键安装'));
      b.disabled = true; // 无批量安装端点：禁用而非伪造成功
      b.title = '批量安装端点待补（store 无批量子集安装 API）';
      add(c, el('div', 'store-preset-note', '批量安装待补'));
    });
    return box;
  }

  function renderCard(p) {
    var ins = S.installed[p.id];
    var card = el('article', 'store-card' + (ins ? ' is-installed' : ''));
    var top = add(card, el('div', 'store-card-top'));
    var icon = add(top, el('span', 'store-icon', ICONS[p.id] || '📦'));
    icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', (p.name || p.id) + ' 图标');
    var head = add(top, el('div', 'store-card-head'));
    add(head, el('div', 'store-card-name', p.name || p.id));
    var sub = add(head, el('div', 'store-card-sub'));
    add(sub, el('span', 'store-card-id mono', p.id));
    add(sub, el('span', 'store-card-ver', 'v' + (p.version || '?')));
    var badges = add(card, el('div', 'store-badges'));
    var depth = p.depth_level === 'production' ? 'production' : 'basic';
    add(badges, el('span', 'store-badge ' + depth, depth === 'production' ? 'production · 生产级' : 'basic · 基础级'));
    add(badges, el('span', 'store-badge lifecycle', LIFE[p.lifecycle] || p.lifecycle || '未知'));
    if (ins) add(badges, el('span', 'store-badge installed', '已安装 ✅'));
    add(card, el('p', 'store-desc', descOf(p)));
    var st = S.status[p.id];
    var status = add(card, el('div', 'store-card-status' + (st ? ' is-' + st.kind : ''), st ? st.text : ''));
    status.setAttribute('role', 'status');
    var ops = add(card, el('div', 'store-ops'));
    if (ins) {
      var off = add(ops, el('button', 'btn store-btn-danger', '卸载'));
      off.title = '卸载端点未实现（DELETE /store/plugins/{id} 返回 501），此处执行停用';
      on(off, function () { doDisable(p.id); });
    } else {
      on(add(ops, el('button', 'btn btn-primary store-btn-install', '安装')), function () { doInstall(p); });
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
      : '索引不可用') + ' · 当前显示 ' + list.length + ' 个';
  }

  function doInstall(p) {
    setStatus(p.id, 'busy', '安装中…');
    var body = { id: p.id, version: p.version };
    if (S.pkgPath) body.package_path = S.pkgPath;
    postJson(U.install, body).then(function (res) {
      if (!res.ok) return setStatus(p.id, 'fail', '安装失败：' + errText(res));
      setStatus(p.id, 'ok', '安装成功 ✅'); return loadInstalled();
    }).catch(function (err) { setStatus(p.id, 'fail', '安装失败：' + (err && err.message ? err.message : '网络错误')); });
  }
  // 无卸载端点：走 disable，并在状态条标注"卸载端点待补"，不假装卸载成功。

  function doDisable(id) {
    setStatus(id, 'busy', '停用中…');
    postJson(U.disable + encodeURIComponent(id) + '/disable', {}).then(function (res) {
      if (!res.ok) return setStatus(id, 'fail', '停用失败：' + errText(res));
      setStatus(id, 'note', '已停用（卸载端点待补：DELETE /store/plugins 当前 501）'); return loadInstalled();
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
    // install 端点强制 package_path：不预填会必然 400，故给显式输入框而不是静默失败。
    var pkg = add(head, el('label', 'store-pkg'));
    add(pkg, el('span', 'store-pkg-label', '本地包路径（install 必填 package_path）'));
    var pkgInput = add(pkg, input('store-pkg-input', '/path/to/plugin-0.1.0.tar.gz', '本地包路径'));
    pkgInput.addEventListener('input', function () { S.pkgPath = pkgInput.value.trim(); });
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
