/* kore 主壳 · Redis 管理（web/redis.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/redis/redis.<action>（插件 id 与业务域名一致，
   方法段写完整限定名；裸动词只是插件侧兼容，不得依赖）。
   数据：redis.instances / redis.info / redis.keys / redis.get / redis.delete；
   连接配置复用通用面板（redis.config.get/set），密码只保存环境变量名。
   界面只把键名/类型/值写 textContent，不拼 HTML；删除是页面内二次确认并列出键名。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/redis/', TIMEOUT_MS = 15000;
  function fresh() {
    return { root: null, instances: [], selected: '', loadError: '', info: null, infoError: '',
      keys: [], pattern: '*', limit: 200, scanned: 0, truncated: false, keysLoaded: false, keysError: '',
      activeKey: null, value: null, valueError: '', checked: Object.create(null), notice: '',
      busy: false, destroyed: false };
  }
  var S = fresh();
  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn) { n.addEventListener('click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    } return '';
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf'); if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token }, body: JSON.stringify(params || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + method, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('请求失败（HTTP ' + res.status + '）')));
        err.code = data.code || ''; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }
  function fmtInt(n) { return typeof n === 'number' && isFinite(n) ? n.toLocaleString('zh-CN') : '—'; }
  function fmtUptime(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '—';
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return d + ' 天 ' + h + ' 小时'; return h ? h + ' 小时 ' + m + ' 分' : m + ' 分';
  }
  function fmtTTL(sec) {
    if (sec === -1) return '永不过期';
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '—';
    if (sec < 60) return sec + ' 秒'; if (sec < 3600) return Math.floor(sec / 60) + ' 分';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时'; return Math.floor(sec / 86400) + ' 天';
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c; }
  function notice(text, ok) {
    var n = el('div', 'db-notice' + (ok ? ' redis-notice-ok' : ''), text); n.setAttribute('role', 'alert'); return n; }
  function panel(title, metaText) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    return { panel: p, head: h, meta: add(h, el('span', 'panel-meta', metaText || '')) }; }
  function paintNotice() {
    if (!S.noticeHost) return;
    S.noticeHost.textContent = ''; if (S.notice) S.noticeHost.appendChild(notice(S.notice, true)); }
  function paintInstances() {
    if (!S.instBody) return;
    S.instBody.textContent = ''; S.instCount.textContent = S.instances.length ? S.instances.length + ' 个连接' : '';
    if (S.loadError) { S.instBody.appendChild(notice('读取实例失败：' + S.loadError)); return; }
    if (!S.instances.length) {
      var empty = add(S.instBody, el('div', 'empty-state'));
      add(empty, el('p', 'empty-state-title', '还没有 Redis 连接'));
      add(empty, el('p', 'empty-state-text', '先添加一个 Redis 连接：只需主机与端口；密码只读环境变量名，不写入配置文件。'));
      var addBtn = add(empty, el('button', 'btn btn-primary', '添加连接'));
      addBtn.type = 'button'; on(addBtn, openSettings); return;
    }
    var grid = add(S.instBody, el('div', 'redis-instances'));
    S.instances.forEach(function (inst) {
      var active = inst.name === S.selected, card = add(grid, el('button', 'redis-instance' + (active ? ' is-active' : '')));
      card.type = 'button'; card.setAttribute('aria-pressed', active ? 'true' : 'false');
      var top = add(card, el('div', 'redis-inst-head')); add(top, el('span', 'redis-inst-name', inst.name));
      top.appendChild(chip(inst.reachable ? 'ok' : 'fail', inst.reachable ? '可达' : '不可达'));
      add(card, el('div', 'redis-inst-meta', (inst.host || '—') + ':' + (inst.port || 6379)));
      if (inst.reachable) add(card, el('div', 'redis-inst-version', (inst.version || '版本未知') + ' · 运行 ' + fmtUptime(inst.uptime_s)));
      else add(card, el('div', 'redis-inst-error', '连接失败：' + (inst.error || '原因未知'))).title = inst.error || '';
      on(card, function () { selectInstance(inst.name); });
    });
  }
  function paintInfo() {
    if (!S.infoHost) return;
    S.infoPanel.hidden = !S.selected; S.infoHost.textContent = '';
    if (!S.selected) return;
    if (S.infoError) { S.infoHost.appendChild(notice('信息读取失败：' + S.infoError)); return; }
    if (!S.info) { add(S.infoHost, el('div', 'muted redis-loading', '正在读取实例信息…')); return; }
    var info = S.info, server = info.server || {}, clients = info.clients || {}, memory = info.memory || {}, stats = info.stats || {};
    var hits = stats.keyspace_hits || 0, misses = stats.keyspace_misses || 0, total = hits + misses;
    var grid = add(S.infoHost, el('div', 'redis-stats'));
    [['服务版本', server.version || '—'], ['运行时长', fmtUptime(server.uptime_s)], ['客户端连接', fmtInt(clients.connected)],
      ['TCP 端口', fmtInt(server.tcp_port)], ['内存使用', memory.used_memory_human || '—'],
      ['内存峰值', memory.used_memory_peak_human || '—'], ['最大内存', memory.maxmemory_human || '不限制'],
      ['命中率', total ? (hits / total * 100).toFixed(1) + '%' : '—']
    ].forEach(function (item) {
      var cell = add(grid, el('div', 'redis-stat'));
      add(cell, el('span', 'redis-stat-label', item[0])); add(cell, el('span', 'redis-stat-value', item[1]));
    });
    var ks = info.keyspace || {}, names = Object.keys(ks).sort(), ksRow = add(S.infoHost, el('div', 'redis-keyspace'));
    add(ksRow, el('span', 'redis-stat-label', 'keyspace'));
    if (!names.length) { add(ksRow, el('span', 'muted', '没有任何键')); return; }
    names.forEach(function (name) {
      var m = /keys=(\d+)/.exec(String(ks[name] || ''));
      add(ksRow, el('span', 'redis-ks-chip', name + ' · ' + (m ? m[1] : '?') + ' 个键'));
    });
  }
  function checkedKeys() {
    var out = [];
    for (var i = 0; i < S.keys.length; i++) if (S.checked[S.keys[i].key]) out.push(S.keys[i].key);
    return out; }
  function paintDeleteBtn() {
    var n = checkedKeys().length; if (!S.delBtn) return;
    S.delBtn.disabled = S.busy || !n;
    S.delBtn.textContent = n ? '删除选中（' + n + '）' : '删除选中';
  }
  function paintKeys() {
    if (!S.keysHost) return;
    S.keysHost.textContent = '';
    S.keyCount.textContent = S.keysLoaded ? ('扫描 ' + fmtInt(S.scanned) + ' 个') : '';
    if (S.truncated) S.keyCount.appendChild(el('span', 'db-truncated', '（已达上限，结果被截断）'));
    paintDeleteBtn();
    if (S.keysError) { S.keysHost.appendChild(notice('扫描键失败：' + S.keysError)); return; }
    if (!S.keysLoaded) { add(S.keysHost, el('div', 'muted redis-loading', '正在扫描键…')); return; }
    if (!S.keys.length) { add(S.keysHost, el('div', 'panel-empty', '没有匹配的键。')); return; }
    var scroll = add(S.keysHost, el('div', 'redis-key-host')), table = add(scroll, el('table', 'redis-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    var checkAll = add(add(htr, el('th', 'redis-check-cell')), el('input', 'redis-check'));
    checkAll.type = 'checkbox'; checkAll.setAttribute('aria-label', '全选当前键'); checkAll.checked = S.keys.every(function (e) { return !!S.checked[e.key]; });
    checkAll.addEventListener('change', function () {
      S.checked = Object.create(null);
      if (checkAll.checked) S.keys.forEach(function (e) { S.checked[e.key] = true; });
      paintKeys();
    });
    ['键名', '类型', 'TTL'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.keys.forEach(function (entry) {
      var active = S.activeKey && S.activeKey.key === entry.key;
      var tr = add(tbody, el('tr', 'redis-row' + (active ? ' is-active' : ''))); tr.tabIndex = 0;
      if (active) tr.setAttribute('aria-current', 'true');
      var box = add(add(tr, el('td', 'redis-check-cell')), el('input', 'redis-check'));
      box.type = 'checkbox'; box.checked = !!S.checked[entry.key]; box.setAttribute('aria-label', '选择键 ' + entry.key);
      box.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (box.checked) S.checked[entry.key] = true; else delete S.checked[entry.key];
        tr.classList.toggle('is-selected', box.checked); paintDeleteBtn();
      });
      add(tr, el('td', 'redis-key', entry.key)); add(tr, el('td', 'redis-type', entry.type || '—'));
      add(tr, el('td', 'redis-ttl', fmtTTL(entry.ttl_s))); on(tr, function () { loadValue(entry); });
      tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); loadValue(entry); } });
    });
  }
  function valueTable(headers, rows) {
    var table = el('table', 'redis-value-table'), htr = add(add(table, el('thead')), el('tr'));
    headers.forEach(function (h) { add(htr, el('th', null, h)); });
    var tbody = add(table, el('tbody'));
    rows.forEach(function (row) {
      var tr = add(tbody, el('tr'));
      row.forEach(function (cell) { add(tr, el('td', null, cell)); });
    });
    return table;
  }
  function paintValue() {
    if (!S.valueHost) return;
    S.valuePanel.hidden = !S.activeKey; S.valueHost.textContent = '';
    if (!S.activeKey) return;
    S.valueMeta.textContent = (S.activeKey.type || '—') + ' · ' + fmtTTL(S.activeKey.ttl_s);
    if (S.valueError) { S.valueHost.appendChild(notice('读取值失败：' + S.valueError)); return; }
    if (!S.value) { add(S.valueHost, el('div', 'muted redis-loading', '正在读取值…')); return; }
    var v = S.value, value = v.value;
    if (v.type === 'string') add(S.valueHost, el('pre', 'redis-value-pre', typeof value === 'string' ? value : (value == null ? '（空值）' : JSON.stringify(value))));
    else if (v.type === 'hash') {
      var keys = value && typeof value === 'object' ? Object.keys(value).sort() : [];
      add(S.valueHost, keys.length ? valueTable(['字段', '值'], keys.map(function (k) { return [k, value[k]]; })) : el('div', 'panel-empty', '（空 hash）'));
    } else if (v.type === 'list' || v.type === 'set') {
      var arr = Array.isArray(value) ? value : [], rows = v.type === 'list' ? arr.map(function (x, i) { return [i, x]; }) : arr.map(function (x) { return [x]; });
      add(S.valueHost, arr.length ? valueTable(v.type === 'list' ? ['#', '值'] : ['成员'], rows) : el('div', 'panel-empty', '（空 ' + v.type + '）'));
    } else if (v.type === 'zset') {
      var zs = Array.isArray(value) ? value : [];
      add(S.valueHost, zs.length ? valueTable(['成员', '分值'], zs.map(function (x) { return [x.member, x.score]; })) : el('div', 'panel-empty', '（空 zset）'));
    } else add(S.valueHost, el('pre', 'redis-value-pre', JSON.stringify(value, null, 2)));
    if (v.truncated) add(S.valueHost, el('div', 'db-truncated', '集合类最多显示前 100 项'));
  }
  function selectInstance(name) {
    if (!name || S.selected === name) return;
    S.selected = name; S.info = null; S.infoError = ''; S.keys = []; S.keysLoaded = false;
    S.keysError = ''; S.activeKey = null; S.value = null; S.valueError = ''; S.notice = ''; S.truncated = false; S.scanned = 0;
    S.checked = Object.create(null); paintInstances(); paintNotice(); paintInfo(); paintKeys(); paintValue(); loadInfo(); loadKeys(); }
  function loadInstances(reset) {
    if (reset) { S.selected = ''; S.info = null; S.keys = []; S.keysLoaded = false; }
    S.loadError = ''; paintInstances();
    invoke('redis.instances', {}).then(function (data) {
      if (S.destroyed) return;
      S.instances = data.instances || []; paintInstances();
      if (!S.selected && S.instances.length) {
        var first = S.instances[0];
        for (var i = 0; i < S.instances.length; i++) if (S.instances[i].reachable) { first = S.instances[i]; break; }
        selectInstance(first.name);
      }
    }, function (err) { if (!S.destroyed) { S.loadError = err.message; paintInstances(); } });
  }
  function loadInfo() {
    var name = S.selected; if (!name) return;
    S.info = null; S.infoError = ''; paintInfo();
    invoke('redis.info', { instance: name }).then(function (data) {
      if (!S.destroyed && S.selected === name) { S.info = data; paintInfo(); }
    }, function (err) { if (!S.destroyed && S.selected === name) { S.infoError = err.message; paintInfo(); } });
  }
  function loadKeys() {
    var name = S.selected; if (!name) return;
    S.keysLoaded = false; S.keysError = ''; S.truncated = false; S.scanned = 0; paintKeys();
    invoke('redis.keys', { instance: name, pattern: S.pattern, limit: S.limit }).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      S.keys = data.keys || []; S.scanned = data.scanned || 0; S.truncated = !!data.truncated; S.keysLoaded = true;
      var next = Object.create(null);
      for (var i = 0; i < S.keys.length; i++) if (S.checked[S.keys[i].key]) next[S.keys[i].key] = true;
      S.checked = next; paintKeys();
    }, function (err) {
      if (!S.destroyed && S.selected === name) { S.keysError = err.message; S.keysLoaded = true; paintKeys(); }
    });
  }
  function loadValue(entry) {
    if (!S.selected) return;
    S.activeKey = entry; S.value = null; S.valueError = ''; paintKeys(); paintValue();
    var name = S.selected;
    invoke('redis.get', { instance: name, key: entry.key }).then(function (data) {
      if (S.destroyed || S.selected !== name || !S.activeKey || S.activeKey.key !== entry.key) return;
      S.value = data; paintValue(); paintKeys();
    }, function (err) { if (!S.destroyed && S.selected === name) { S.valueError = err.message; paintValue(); } });
  }
  function askDelete() {
    var keys = checkedKeys(); if (!keys.length) return;
    S.confirmHost.textContent = '';
    var box = add(S.confirmHost, el('div', 'redis-confirm'));
    add(box, el('p', 'redis-confirm-title', '将删除以下 ' + keys.length + ' 个键，操作不可恢复：'));
    var list = add(box, el('ul', 'redis-confirm-list'));
    keys.forEach(function (key) { add(list, el('li', null, key)); });
    var ops = add(box, el('div', 'redis-actions'));
    var ok = add(ops, el('button', 'btn redis-danger', '确认删除')), cancel = add(ops, el('button', 'btn btn-ghost', '取消'));
    ok.type = 'button'; cancel.type = 'button';
    on(cancel, function () { S.confirmHost.textContent = ''; }); on(ok, function () { doDelete(keys, ok); }); ok.focus();
  }
  function doDelete(keys, btn) {
    if (S.busy) return;
    S.busy = true; btn.disabled = true; paintDeleteBtn();
    invoke('redis.delete', { instance: S.selected, keys: keys }).then(function (data) {
      if (S.destroyed) return;
      S.busy = false; S.confirmHost.textContent = ''; S.checked = Object.create(null);
      S.notice = '已删除 ' + fmtInt(data.deleted || 0) + ' 个键';
      if (S.activeKey && keys.indexOf(S.activeKey.key) >= 0) { S.activeKey = null; S.value = null; }
      paintNotice(); paintKeys(); paintValue(); loadInfo(); loadKeys();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.notice = ''; paintDeleteBtn(); S.confirmHost.textContent = '';
      S.confirmHost.appendChild(notice('删除失败：' + err.message));
    });
  }
  function openSettings() {
    if (!S.root) return;
    var opts = { title: 'Redis 连接', onSaved: function () { loadInstances(true); } };
    if (window.KoreShell && typeof window.KoreShell.openConfig === 'function') window.KoreShell.openConfig(S.root, 'redis', opts);
    else if (window.KoreConfig && typeof window.KoreConfig.open === 'function') window.KoreConfig.open(S.root, 'redis', opts);
    else S.noticeHost.appendChild(notice('配置面板不可用，请刷新页面重试')); }
  function field(label, input, extraCls) {
    var f = el('label', 'redis-field' + (extraCls || ''));
    add(f, el('span', 'redis-label', label)); add(f, input); return f;
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    S.root = add(container, el('section', 'redis'));
    var head = add(S.root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', 'Redis')); add(head, el('p', 'view-sub', '连接已有 Redis 实例：查看实例与内存、浏览键、读取值、批量删除。'));
    S.noticeHost = add(S.root, el('div', 'redis-notice-host'));
    var inst = panel('Redis 实例', ''); add(S.root, inst.panel); S.instCount = add(inst.meta, el('span', null, ''));
    var gear = add(inst.meta, el('button', 'btn btn-ghost', '设置')); gear.type = 'button'; on(gear, openSettings);
    S.instBody = add(inst.panel, el('div', 'redis-instance-body'));
    var info = panel('实例信息', '内存 / 连接 / 命中率 / keyspace');
    S.infoPanel = info.panel; S.infoPanel.hidden = true; add(S.root, S.infoPanel); S.infoHost = add(S.infoPanel, el('div', 'redis-info'));
    var keys = panel('键浏览', ''); add(S.root, keys.panel); S.keyCount = add(keys.meta, el('span', null, ''));
    S.delBtn = add(keys.meta, el('button', 'btn redis-danger', '删除选中'));
    S.delBtn.type = 'button'; S.delBtn.disabled = true; on(S.delBtn, askDelete);
    var bar = add(keys.panel, el('div', 'redis-toolbar'));
    S.patternInput = el('input', 'redis-input'); S.patternInput.value = '*'; S.patternInput.spellcheck = false;
    S.patternInput.setAttribute('aria-label', '键匹配模式'); add(bar, field('匹配模式', S.patternInput));
    S.limitInput = el('input', 'redis-input redis-limit-input'); S.limitInput.type = 'number';
    S.limitInput.min = '1'; S.limitInput.max = '10000'; S.limitInput.value = '200'; S.limitInput.setAttribute('aria-label', '最多返回键数');
    add(bar, field('上限', S.limitInput, ' redis-limit'));
    var query = add(bar, el('button', 'btn btn-primary', '查询')); query.type = 'button';
    function runSearch() {
      var pattern = S.patternInput.value.trim() || '*', limit = Math.trunc(Number(S.limitInput.value));
      if (!isFinite(limit) || limit < 1 || limit > 10000) { S.keysError = '上限必须是 1–10000 的整数'; S.keysLoaded = true; paintKeys(); return; }
      S.pattern = pattern; S.limit = limit; loadKeys();
    }
    on(query, runSearch);
    S.patternInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') runSearch(); });
    S.keysHost = add(keys.panel, el('div', 'redis-keys')); S.confirmHost = add(keys.panel, el('div', 'redis-confirm-host'));
    var value = panel('值', ''); S.valuePanel = value.panel; S.valuePanel.hidden = true; add(S.root, S.valuePanel);
    S.valueMeta = add(value.meta, el('span', null, '')); add(value.meta, el('span', null, '点击任意键查看'));
    S.valueHost = add(S.valuePanel, el('div', 'redis-value'));
    paintInstances(); paintInfo(); paintKeys(); paintValue(); loadInstances();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreRedis = { render: render };
})();
