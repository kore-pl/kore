/* kore 主壳 · Redis 管理（web/redis.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/redis/redis.<action>（插件 id 与业务域名一致，
   方法段写完整限定名；裸动词只是插件侧兼容，不得依赖）。
   数据：redis.instances / redis.info / redis.keys / redis.get / redis.delete
        + 运维四方法 redis.persistence / redis.memory / redis.slowlog / redis.keyInfo。
   交互：键表行点开先看「键详情」（类型/编码/TTL/内存，keyInfo，O(1)），
   点「读取值」才真正 redis.get——不再对未知键盲目取值；连接配置复用通用面板。
   本视图新增样式（redis-ops-* / redis-detail-* / redis-slow-*）随视图注入，
   不改 style.css；界面只把键名/类型/值写 textContent，不拼 HTML。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/redis/', DISCOVER = '/api/v1/invoke/discover/', TIMEOUT_MS = 15000;
  function fresh() {
    return { root: null, instances: [], selected: '', loadError: '', info: null, infoError: '',
      keys: [], pattern: '*', limit: 200, scanned: 0, truncated: false, keysLoaded: false, keysError: '',
      shown: 50, step: 50, totalKeys: 0, loadingMore: false,
      activeKey: null, value: null, valueError: '', valueAsked: false, checked: Object.create(null), notice: '',
      persist: null, persistError: '', memory: null, memoryError: '',
      slowlog: null, slowlogError: '', slowlogLoaded: false, keyInfo: null, keyInfoError: '',
      busy: false, destroyed: false, discoveryState: 'loading', discovery: null, discoveryError: '',
      autoNotice: null, autoPending: false,
      // 写入键（redis.set）：类型/键/文本/行数据/TTL 预设；值按类型由 buildSetValue 组装。
      setKey: '', setType: 'string', setText: '', setTTL: 0, setBusy: false, setError: '', setNotice: '',
      setFormHost: null, setResultHost: null, writePanel: null,
      // 服务端配置（redis.serverConfig.get/set）：三个白名单参数。
      cfg: null, cfgError: '', cfgBusy: false, cfgNotice: '', cfgHost: null, cfgPanel: null, bgBusy: false };
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
  function invokeAt(base, method, params) {
    var token = cookie('kore_csrf'); if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token }, body: JSON.stringify(params || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(base + method, init).then(function (res) {
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
  function invoke(method, params) { return invokeAt(API, method, params); }
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
  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'], v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i ? v.toFixed(v < 10 ? 2 : 1) : String(v)) + ' ' + units[i];
  }
  function fmtDurUS(us) {
    if (typeof us !== 'number' || !isFinite(us) || us < 0) return '—';
    if (us < 1000) return us + ' µs';
    if (us < 1000000) return (us / 1000).toFixed(us < 10000 ? 2 : 1) + ' ms';
    return (us / 1000000).toFixed(2) + ' s';
  }
  function fmtClock(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return '—';
    var d = new Date(sec * 1000);
    return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour12: false });
  }
  function fmtAgo(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return '—';
    var diff = Math.max(0, Math.floor(Date.now() / 1000) - sec);
    if (diff < 90) return diff + ' 秒前';
    if (diff < 90000) return Math.floor(diff / 60) + ' 分前';
    return Math.floor(diff / 86400) + ' 天前';
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
  function dbLabel(svc) { return svc && svc.id === 'redis' ? 'Redis' : 'Redis'; }
  function shortVersion(version) { return String(version || '').split(/[-~+]/)[0]; }
  function svcPort(svc) { return svc && svc.port ? svc.port : 6379; }
  // 与 db.js 同一口径：0.2.0 起用 client_version / server_version / version_source，
  // 0.1.0 只有 version（客户端 `--version` 输出）。旧字段按客户端版本归一，绝不当服务端；
  // 旧版发现到运行中的服务却没有版本时降级为 client（空版本），不误判成「未检测到」。
  function normalizeService(svc) {
    if (!svc) return null;
    if (!svc.version_source) {
      if (svc.version) {
        svc.client_version = svc.version;
        svc.version_source = 'client';
      } else if (svc.found && svc.running) {
        svc.version_source = 'client';
      } else {
        svc.version_source = 'unknown';
      }
    }
    return svc;
  }
  // 三态优先级：server（真实服务端版本）→ found && running（可能只有客户端版本）→ 空态。
  function pickService(list) {
    var candidates = (list || []).map(normalizeService).filter(function (s) {
      return s && s.id === 'redis';
    });
    var server = candidates.filter(function (s) { return s.version_source === 'server'; });
    if (server.length) return server[0];
    var running = candidates.filter(function (s) { return s.found && s.running; });
    return running.length ? running[0] : null;
  }
  // 已连通的实例：instances 的 reachable=true 表示"用配置里的凭据真实连上服务端"，
  // 它的 version 就是服务端版本：优先级 已连通实例 > discover.server_version > discover.client_version。
  function connectedInstance() {
    for (var i = 0; i < S.instances.length; i++) {
      if (S.instances[i] && S.instances[i].reachable) return S.instances[i];
    }
    return null;
  }
  // hintFor 把后端 error 原文翻译成「怎么办」；NOAUTH 直接给出 requirepass 位置。
  function hintFor(text) {
    var msg = String(text || '');
    if (/NOAUTH|WRONGPASS|AUTH|invalid password|认证/i.test(msg)) {
      return '请确认 Redis 密码，可在 /etc/redis/redis.conf 的 requirepass 查看；' +
        'Docker 启动的 Redis 看容器命令里的 --requirepass 或 REDIS_PASSWORD 环境变量。';
    }
    if (/refused|连接.*失败|dial tcp/i.test(msg)) {
      return 'Redis 未在目标端口监听：确认服务已启动（systemctl status redis-server），' +
        'Docker 用 docker ps 核对端口映射。';
    }
    if (/no such host|Name or service not known/i.test(msg)) {
      return '主机名无法解析：本机 Redis 请填 127.0.0.1，远程服务请填可解析的 IP 或域名。';
    }
    return '检查地址、端口和密码，确认 Redis 已启动并允许从本机连接，然后重试。';
  }
  function autoBanner() {
    if (!S.bannerHost) return;
    var host = S.bannerHost;
    host.textContent = '';
    var box = add(host, el('section', 'db-autodetect'));
    box.setAttribute('role', 'status');
    var main = add(box, el('div', 'db-auto-main'));
    var actions = add(box, el('div', 'db-auto-actions'));
    function badge(text) { add(main, el('span', 'db-auto-badge', text)); }
    function title(text) { add(main, el('p', 'db-auto-title', text)); }
    function text(value) { add(main, el('p', 'db-auto-text', value)); }
    function act(cls, label, fn) { add(actions, btn(cls, label, fn)); }

    // 优先级①：实例已连通时以实例的服务端版本为准，避免"横幅说没连上、实例卡说可达"。
    var conn = connectedInstance();
    if (conn) {
      var connVersion = shortVersion(conn.version);
      badge('已连接');
      title('已连接 Redis' + (connVersion ? ' ' + connVersion : '') +
        '（' + (conn.host || '127.0.0.1') + ':' + (conn.port || 6379) + '）');
      text('服务端版本来自已连通的连接（用配置里的凭据真实连上服务端），比本机自动检测更可信；' +
        '自动检测只探到客户端版本时以这里为准。连接信息可在右上角「设置」里修改。');
      if (S.autoNotice) {
        add(main, el('p', 'db-auto-result ' + (S.autoNotice.tone || 'ok'), S.autoNotice.text));
      }
      act('btn-primary', '修改连接', function () { openSettings(false); });
      act('btn-ghost', '重新检测', detect);
      return;
    }

    if (S.discoveryState === 'loading') {
      badge('自动检测');
      title('正在检测本机 Redis…');
      text('检测只读本机命令与监听端口，不会安装或启动任何服务。');
      return;
    }
    if (S.discoveryState === 'error') {
      box.classList.add('is-none');
      badge('自动检测不可用');
      title('未能完成自动检测');
      text('原因：' + S.discoveryError + '。可以手动填写连接信息，或点“重新检测”。');
      act('btn-ghost', '重新检测', detect);
      act('btn-primary', '手动配置', function () { openSettings(false); });
      return;
    }
    var svc = S.discovery;
    if (!svc) {
      box.classList.add('is-none');
      badge('自动检测');
      title('未检测到本机 Redis');
      text('安装服务后刷新本页会自动识别。Debian/Ubuntu：sudo apt install redis-server；' +
        'RHEL：sudo dnf install redis。已有远程 Redis 可直接手动配置。');
      act('btn-ghost', '重新检测', detect);
      act('btn-primary', '手动配置', function () { openSettings(false); });
      return;
    }
    if (svc.version_source !== 'server' && svc.version_source !== 'client') {
      // unknown：不显示横幅，回落到空态（detect 已把 unknown 置空，这里只作收口）。
      S.discovery = null;
      autoBanner();
      return;
    }
    if (!svc.running) {
      box.classList.add('is-none');
      badge('自动检测');
      var stopped = shortVersion(svc.server_version || svc.client_version);
      title('检测到本机 Redis' + (stopped ? ' ' + stopped : '') + '，但服务未运行');
      text('启动服务后再点“重新检测”：systemctl start redis-server（或 redis）。');
      act('btn-ghost', '重新检测', detect);
      act('btn-primary', '手动配置', function () { openSettings(false); });
      return;
    }
    if (svc.version_source === 'server') {
      // server：版本来自真实服务端 INFO（可能带密码），可以放心展示。
      var serverVersion = shortVersion(svc.server_version);
      badge('自动检测');
      title('检测到本机 Redis' + (serverVersion ? ' ' + serverVersion : '') +
        '（127.0.0.1:' + svcPort(svc) + '）');
      text(S.autoNotice && S.autoNotice.tone === 'ok'
        ? '已自动填入主机、端口并连接成功；可在右上角「设置」里修改连接信息。'
        : '已自动填入主机、端口；点“一键连接”后只需填写密码。');
      if (S.autoNotice) {
        add(main, el('p', 'db-auto-result ' + (S.autoNotice.tone || 'ok'), S.autoNotice.text));
      }
      act('btn-primary', '一键连接', function () { openSettings(true); });
      act('btn-ghost', '重新检测', detect);
      return;
    }
    // client：只拿到客户端版本，服务端不可达/需要密码——绝不把 client_version 当服务端版本。
    var clientVersion = String(svc.client_version || '').trim();
    badge('自动检测');
    title('检测到本机 Redis 客户端（未连上服务端，需要密码）');
    text('本机只探测到' + (clientVersion ? '客户端版本 ' + clientVersion : '客户端，未拿到版本号') +
      '，没有连上服务端；连上真实服务端后这里会显示服务端版本。' +
      '已自动填入主机、端口；点“一键连接”后只需填写密码。');
    if (S.autoNotice) {
      add(main, el('p', 'db-auto-result ' + (S.autoNotice.tone || 'ok'), S.autoNotice.text));
    }
    act('btn-primary', '一键连接', function () { openSettings(true); });
    act('btn-ghost', '重新检测', detect);
  }
  function btn(cls, label, fn) {
    var b = el('button', 'btn ' + cls, label); b.type = 'button';
    if (fn) on(b, fn);
    return b;
  }
  function paintNotice() {
    if (!S.noticeHost) return;
    S.noticeHost.textContent = ''; if (S.notice) S.noticeHost.appendChild(notice(S.notice, true)); }
  function paintInstances() {
    if (!S.instBody) return;
    S.instBody.textContent = ''; S.instCount.textContent = S.instances.length ? S.instances.length + ' 个连接' : '';
    if (S.loadError) {
      var fail = add(S.instBody, el('div', 'empty-state'));
      add(fail, el('p', 'empty-state-title', '读取连接失败'));
      add(fail, el('p', 'empty-state-text', S.loadError));
      add(fail, el('p', 'empty-state-text', '怎么办：' + hintFor(S.loadError)));
      var retry = add(fail, el('button', 'btn btn-primary', '重新读取'));
      retry.type = 'button'; on(retry, function () { loadInstances(false); });
      return;
    }
    if (!S.instances.length) {
      var empty = add(S.instBody, el('div', 'empty-state'));
      add(empty, el('p', 'empty-state-title', '还没有 Redis 连接'));
      var svc = S.discovery, why;
      if (S.discoveryState === 'loading') {
        why = '正在检测本机 Redis…检测完成后这里会出现一键连接入口。';
      } else if (svc && svc.running) {
        var detected = svc.version_source === 'server'
          ? ' ' + shortVersion(svc.server_version)
          : ' 客户端（未连上服务端，需要密码）';
        why = '已检测到本机 Redis' + detected + '。点上方“一键连接”，只需填写密码即可。';
      } else if (svc) {
        why = '检测到本机 Redis，但服务未运行。启动服务后点上方“重新检测”。';
      } else {
        why = '未检测到本机 Redis。安装后刷新本页会自动识别：Debian/Ubuntu 用 sudo apt install redis-server，RHEL 用 sudo dnf install redis。';
      }
      add(empty, el('p', 'empty-state-text', why));
      var ops = add(empty, el('div', 'db-auto-actions'));
      if (svc && svc.running) {
        var one = add(ops, el('button', 'btn btn-primary', '一键连接')); one.type = 'button';
        on(one, function () { openSettings(true); });
      }
      var addBtn = add(ops, el('button', 'btn btn-primary', '手动配置'));
      addBtn.type = 'button'; on(addBtn, function () { openSettings(false); });
      var re = add(ops, el('button', 'btn btn-ghost', '重新检测')); re.type = 'button'; on(re, detect);
      return;
    }
    var grid = add(S.instBody, el('div', 'redis-instances'));
    S.instances.forEach(function (inst) {
      var active = inst.name === S.selected, card = add(grid, el('button', 'redis-instance' + (active ? ' is-active' : '')));
      card.type = 'button'; card.setAttribute('aria-pressed', active ? 'true' : 'false');
      var top = add(card, el('div', 'redis-inst-head')); add(top, el('span', 'redis-inst-name', inst.name === 'default' ? '默认连接' : inst.name));
      top.appendChild(chip(inst.reachable ? 'ok' : 'fail', inst.reachable ? '可达' : '不可达'));
      add(card, el('div', 'redis-inst-meta', (inst.host || '—') + ':' + (inst.port || 6379)));
      if (inst.reachable) add(card, el('div', 'redis-inst-version', (inst.version || '版本未知') + ' · 运行 ' + fmtUptime(inst.uptime_s)));
      else {
        add(card, el('div', 'redis-inst-error', '连接失败：' + (inst.error || '原因未知'))).title = inst.error || '';
        add(card, el('div', 'db-inst-hint', '怎么办：' + hintFor(inst.error)));
      }
      on(card, function () { selectInstance(inst.name); });
    });
  }
  // keyspaceTotal 汇总 INFO keyspace 各 db 的键数：分页的「共 N 个键」用它，
  // 不用 SCAN 返回的 scanned（那是本次扫描到的条数，不是键空间总量）。
  function keyspaceTotal(info) {
    var ks = (info && info.keyspace) || {}, total = 0, found = false;
    Object.keys(ks).forEach(function (name) {
      var m = /keys=(\d+)/.exec(String(ks[name] || ''));
      if (!m) return;
      total += parseInt(m[1], 10) || 0;
      found = true;
    });
    return found ? total : 0;
  }
  function paintInfo() {
    if (!S.infoHost) return;
    S.totalKeys = keyspaceTotal(S.info);
    paintKeyFooter();
    S.infoPanel.hidden = !S.selected; S.infoHost.textContent = '';
    if (!S.selected) return;
    if (S.infoError) { S.infoHost.appendChild(notice('信息读取失败：' + S.infoError)); return; }
    if (!S.info) { add(S.infoHost, el('div', 'muted redis-loading', '正在读取连接信息…')); return; }
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
  function paintKeyFooter() {
    if (!S.keysMoreHost) return;
    S.keysMoreHost.textContent = '';
    if (!S.keysLoaded || S.keysError) return;
    var total = S.totalKeys, unknown = total <= 0;
    if (unknown) total = S.keys.length;
    var shown = Math.min(S.shown, S.keys.length);
    var row = add(S.keysMoreHost, el('div', 'db-auto-actions redis-key-more'));
    add(row, el('span', 'muted', (unknown && S.truncated ? '已显示 ' + fmtInt(shown) + ' / 至少 ' + fmtInt(total)
      : '已显示 ' + fmtInt(shown) + ' / 共 ' + fmtInt(total)) + ' 个键'));
    var canMore = S.shown < total && (S.shown < S.keys.length || S.truncated);
    if (canMore) {
      var more = add(row, el('button', 'btn btn-ghost', S.loadingMore ? '加载中…' : '加载更多'));
      more.type = 'button'; more.disabled = S.loadingMore;
      on(more, loadMoreKeys);
    } else if (S.truncated && S.totalKeys > S.keys.length) {
      add(row, el('span', 'muted', '（已达查询上限，可调大「上限」后重新查询）'));
    }
  }
  function paintKeys() {
    if (!S.keysHost) return;
    S.keysHost.textContent = '';
    S.keyCount.textContent = S.keysLoaded ? ('已加载 ' + fmtInt(S.keys.length) + ' 个') : '';
    if (S.truncated) S.keyCount.appendChild(el('span', 'db-truncated', '（结果被截断）'));
    paintDeleteBtn();
    if (S.keysError) { S.keysHost.appendChild(notice('扫描键失败：' + S.keysError)); paintKeyFooter(); return; }
    if (!S.keysLoaded) { add(S.keysHost, el('div', 'muted redis-loading', '正在扫描键…')); paintKeyFooter(); return; }
    if (!S.keys.length) {
      S.keysHost.appendChild(window.KoreUI.emptyBlock({
        title: S.pattern ? '没有匹配的键' : '这个库是空的',
        text: S.pattern ? '当前匹配「' + S.pattern + '」没有命中；换个通配符，或清空匹配看全部键。' : '当前 DB 里一个键也没有；写入数据后这里会自动出现。',
        label: '重新读取键列表', onClick: loadKeys
      }));
      paintKeyFooter();
      return;
    }
    // 只渲染前 shown 行：键空间可能有数千个键，全量渲染会让页面长到十几屏。
    var rows = S.keys.slice(0, S.shown);
    var scroll = add(S.keysHost, el('div', 'redis-key-host')), table = add(scroll, el('table', 'redis-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    var checkAll = add(add(htr, el('th', 'redis-check-cell')), el('input', 'redis-check'));
    checkAll.type = 'checkbox'; checkAll.setAttribute('aria-label', '全选当前页键');
    checkAll.checked = rows.length > 0 && rows.every(function (e) { return !!S.checked[e.key]; });
    checkAll.addEventListener('change', function () {
      rows.forEach(function (e) {
        if (checkAll.checked) S.checked[e.key] = true; else delete S.checked[e.key];
      });
      paintKeys();
    });
    ['键名', '类型', 'TTL'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    rows.forEach(function (entry) {
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
      add(tr, el('td', 'redis-ttl', fmtTTL(entry.ttl_s))); on(tr, function () { loadKeyDetail(entry); });
      tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); loadKeyDetail(entry); } });
    });
    paintKeyFooter();
  }
  // loadMoreKeys：每次 +step；已加载的行用完且后端还有剩余时，按更大 limit 重新拉取。
  // 「上限」输入框仍是初始上限，加载更多在此基础上按需上调，不静默丢数据。
  function loadMoreKeys() {
    if (S.loadingMore) return;
    var next = S.shown + S.step;
    if (next <= S.keys.length) { S.shown = next; paintKeys(); return; }
    if (!S.truncated) { S.shown = Math.min(next, S.keys.length); paintKeys(); return; }
    var name = S.selected; if (!name) return;
    var want = Math.min(10000, Math.max(next, S.keys.length + S.step, S.limit));
    if (want <= S.keys.length) {
      S.shown = S.keys.length; paintKeyFooter();
      return;
    }
    S.loadingMore = true; paintKeyFooter();
    invoke('redis.keys', { instance: name, pattern: S.pattern, limit: want }).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      S.loadingMore = false;
      S.keys = data.keys || []; S.scanned = data.scanned || 0; S.truncated = !!data.truncated;
      S.keysLoaded = true; S.shown = Math.min(next, S.keys.length);
      var keep = Object.create(null);
      S.keys.forEach(function (e) { if (S.checked[e.key]) keep[e.key] = true; });
      S.checked = keep; paintKeys();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.loadingMore = false; S.keysError = err.message; paintKeys();
    });
  }
  // ── 运维面板：4 张指标卡（persistence/memory/slowlog）+ 慢查询表 + 键详情侧栏 ──
  var OPS_SLOWLOG_WINDOW_S = 86400; // 指标卡口径：最近 24h 慢查询条数
  function paintOpsCards() {
    if (!S.opsHost) return;
    S.opsHost.hidden = !S.selected;
    S.opsHost.textContent = '';
    if (!S.selected) return;
    var grid = add(S.opsHost, el('div', 'redis-ops-grid'));
    // 卡 1：内存用量（进度条 + used/maxmemory）
    var memCard = add(grid, el('div', 'redis-ops-card'));
    add(memCard, el('span', 'redis-ops-label', '内存用量'));
    if (S.memoryError) {
      var errV = add(memCard, el('div', 'redis-ops-value', '—'));
      errV.title = S.memoryError; add(memCard, el('div', 'redis-ops-sub', '读取失败'));
    } else if (!S.memory) {
      add(memCard, el('div', 'redis-ops-value', '…'));
    } else {
      var used = S.memory.used, max = S.memory.maxmemory, pct = max > 0 ? Math.min(100, used / max * 100) : 0;
      var big = add(memCard, el('div', 'redis-ops-value', fmtBytes(used)));
      if (S.memory.maxmemory_policy) big.title = '淘汰策略：' + S.memory.maxmemory_policy;
      var fill = add(add(memCard, el('div', 'redis-ops-bar')), el('div', 'redis-ops-bar-fill' + (max > 0 && pct >= 80 ? ' is-hot' : '')));
      if (max > 0) fill.style.width = pct.toFixed(1) + '%'; else fill.classList.add('is-none');
      add(memCard, el('div', 'redis-ops-sub', max > 0
        ? fmtBytes(used) + ' / ' + fmtBytes(max) + '（' + pct.toFixed(1) + '%）'
        : '未设上限（maxmemory=0）' + (S.memory.maxmemory_policy ? ' · ' + S.memory.maxmemory_policy : '')));
    }
    // 卡 2：碎片率（mem_fragmentation_ratio；≥1.5 提示关注）
    var fragCard = add(grid, el('div', 'redis-ops-card'));
    add(fragCard, el('span', 'redis-ops-label', '内存碎片率'));
    if (S.memoryError) { fragV(fragCard, '—', '读取失败', S.memoryError); }
    else if (!S.memory) { add(fragCard, el('div', 'redis-ops-value', '…')); }
    else if (S.memory.fragmentation_ratio > 0) {
      var ratio = S.memory.fragmentation_ratio;
      var fv = add(fragCard, el('div', 'redis-ops-value', ratio.toFixed(2)));
      fv.classList.add(ratio >= 1.5 ? 'is-warn' : 'is-ok');
      add(fragCard, el('div', 'redis-ops-sub', ratio >= 1.5 ? '偏高（≥1.5），关注淘汰与内存交换' : '正常（<1.5）'));
    } else fragV(fragCard, '—', '服务端未返回碎片率', '');
    // 卡 3：AOF / RDB 状态点
    var persCard = add(grid, el('div', 'redis-ops-card'));
    add(persCard, el('span', 'redis-ops-label', 'AOF / RDB'));
    if (S.persistError) { fragV(persCard, '—', '读取失败', S.persistError); }
    else if (!S.persist) { add(persCard, el('div', 'redis-ops-value', '…')); }
    else {
      var dots = add(persCard, el('div', 'redis-ops-dots'));
      var aofOn = S.persist.aof_enabled, aofOK = S.persist.aof_last_write_status === 'ok';
      dots.appendChild(opDot(aofOn ? (aofOK ? 'ok' : 'fail') : 'na',
        'AOF ' + (aofOn ? (aofOK ? '开启 · 写入正常' : '开启 · 写入异常') : '关闭'),
        aofOn && !aofOK ? 'AOF 最近一次写入状态异常，可能丢数据' : ''));
      if (S.persist.rdb_bgsave_in_progress) dots.appendChild(opDot('warn', 'RDB BGSAVE 进行中', ''));
      else dots.appendChild(opDot('ok', 'RDB 上次保存 ' + fmtAgo(S.persist.rdb_last_save_time), '上次保存时刻 ' + fmtClock(S.persist.rdb_last_save_time)));
      add(persCard, el('div', 'redis-ops-sub', '未落盘变更 ' + fmtInt(S.persist.rdb_changes_since_save) + ' 个键'));
      var saveNow = add(persCard, el('button', 'btn btn-ghost redis-ops-action', S.bgBusy ? '触发中…' : '立即落盘（BGSAVE）'));
      saveNow.type = 'button'; saveNow.disabled = !!S.bgBusy; on(saveNow, runBgsave);
    }
    // 卡 4：慢查询（24h）
    var slowCard = add(grid, el('div', 'redis-ops-card'));
    add(slowCard, el('span', 'redis-ops-label', '慢查询（24h）'));
    if (S.slowlogError) { fragV(slowCard, '—', '读取失败', S.slowlogError); }
    else if (!S.slowlogLoaded) { add(slowCard, el('div', 'redis-ops-value', '…')); }
    else {
      var cutoff = Math.floor(Date.now() / 1000) - OPS_SLOWLOG_WINDOW_S;
      var recent = (S.slowlog.entries || []).filter(function (e) { return e && e.ts >= cutoff; }).length;
      var sv = add(slowCard, el('div', 'redis-ops-value', fmtInt(recent)));
      sv.classList.add(recent > 0 ? 'is-warn' : 'is-ok');
      add(slowCard, el('div', 'redis-ops-sub', '缓冲区共 ' + fmtInt(S.slowlog.count || 0) + ' 条 · 明细见下方「慢查询」'));
    }
  }
  function fragV(card, text, sub, title) {
    var v = add(card, el('div', 'redis-ops-value', text));
    if (title) v.title = title;
    add(card, el('div', 'redis-ops-sub', sub));
  }
  function opDot(tone, text, title) {
    var row = el('div', 'redis-ops-dot-row');
    if (title) row.title = title;
    var dot = add(row, el('span', 'dot ' + tone));
    if (tone === 'na') dot.classList.add('dot-na'); // 注入样式补灰色（style.css 的 dot 无 na 档）
    add(row, el('span', null, text));
    return row;
  }
  function paintSlowlog() {
    if (!S.slowHost) return;
    S.slowPanel.hidden = !S.selected; S.slowHost.textContent = '';
    if (!S.selected) return;
    add(S.slowHost, el('p', 'redis-slow-note',
      '仅记录执行时间超过 slowlog-log-slower-than（默认 10000µs = 10ms）的命令；缓冲区上限 slowlog-max-len（默认 128）条，读取时可能被截断。本页只读，不改动慢日志配置。'));
    if (S.slowlogError) { S.slowHost.appendChild(notice('慢查询读取失败：' + S.slowlogError)); return; }
    if (!S.slowlogLoaded) { add(S.slowHost, el('div', 'muted redis-loading', '正在读取慢查询…')); return; }
    var entries = S.slowlog.entries || [];
    if (!entries.length) { add(S.slowHost, el('div', 'panel-empty', '暂无慢查询记录——所有命令都在阈值之内。')); return; }
    var scroll = add(S.slowHost, el('div', 'redis-key-host'));
    var table = add(scroll, el('table', 'redis-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['#', '时间', '耗时', '命令 / 参数'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    entries.forEach(function (entry) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', 'redis-slow-id', fmtInt(entry.id)));
      add(tr, el('td', 'redis-slow-time', fmtClock(entry.ts)));
      add(tr, el('td', 'redis-slow-dur', fmtDurUS(entry.duration_us)));
      var full = entry.command + (entry.args_summary ? ' ' + entry.args_summary : '');
      var cmd = add(tr, el('td', 'redis-slow-cmd', full));
      cmd.title = full; cmd.setAttribute('title', full);
    });
  }
  function loadOps() {
    var name = S.selected; if (!name) return;
    S.persist = null; S.persistError = ''; S.memory = null; S.memoryError = '';
    S.slowlog = null; S.slowlogError = ''; S.slowlogLoaded = false;
    paintOpsCards(); paintSlowlog(); loadServerConfig();
    invoke('redis.persistence', { instance: name }).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      S.persist = data; paintOpsCards();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.persistError = err.message; paintOpsCards();
    });
    invoke('redis.memory', { instance: name }).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      S.memory = data; paintOpsCards();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.memoryError = err.message; paintOpsCards();
    });
    invoke('redis.slowlog', { instance: name, limit: 128 }).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      S.slowlog = data; S.slowlogLoaded = true; paintOpsCards(); paintSlowlog();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.slowlogError = err.message; S.slowlogLoaded = true; paintOpsCards(); paintSlowlog();
    });
  }
  // loadKeyDetail：键行点开 → 键详情（redis.keyInfo，O(1)），值改为显式点「读取值」。
  function loadKeyDetail(entry) {
    if (!S.selected) return;
    S.activeKey = entry; S.keyInfo = null; S.keyInfoError = '';
    S.value = null; S.valueError = ''; S.valueAsked = false;
    paintKeys(); paintKeyDetail(); paintValue();
    var name = S.selected;
    invoke('redis.keyInfo', { instance: name, key: entry.key }).then(function (data) {
      if (S.destroyed || S.selected !== name || !S.activeKey || S.activeKey.key !== entry.key) return;
      S.keyInfo = data; paintKeyDetail();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.keyInfoError = err.message; paintKeyDetail();
    });
  }
  function paintKeyDetail() {
    if (!S.detailHost) return;
    S.detailPanel.hidden = !S.activeKey; S.detailHost.textContent = '';
    if (!S.activeKey) return;
    S.detailMeta.textContent = S.activeKey.key;
    if (S.keyInfoError) {
      S.detailHost.appendChild(notice('键详情读取失败：' + S.keyInfoError + '。怎么办：' + hintFor(S.keyInfoError)));
      return;
    }
    if (!S.keyInfo) { add(S.detailHost, el('div', 'muted redis-loading', '正在读取键详情…')); return; }
    var ki = S.keyInfo, grid = add(S.detailHost, el('div', 'redis-detail-kv'));
    [['类型', ki.type || '—'], ['编码', ki.encoding || '（服务端未返回）'], ['TTL', fmtTTL(ki.ttl_s)],
      ['内存占用', ki.memory_bytes > 0 ? fmtBytes(ki.memory_bytes) : '—']].forEach(function (item) {
      add(grid, el('span', 'redis-detail-label', item[0]));
      add(grid, el('span', 'redis-detail-value', item[1]));
    });
    add(S.detailHost, el('div', 'redis-detail-hint', ki.memory_bytes > 0
      ? '内存占用含键与值的结构与数据（MEMORY USAGE 采样估算）。'
      : '服务端未返回内存占用（MEMORY USAGE 需 Redis ≥ 4.0）。'));
    var actions = add(S.detailHost, el('div', 'redis-actions'));
    actions.appendChild(btn(S.value ? 'btn-ghost' : 'btn-primary', S.value ? '重新读取值' : '读取值', function () { loadValue(S.activeKey); }));
    // TTL 预设：1h / 1d / 7d + 清除过期（persist）；不让人填任意秒数。
    var ttlOps = add(S.detailHost, el('div', 'redis-actions redis-ttl-ops'));
    add(ttlOps, el('span', 'redis-detail-label', '过期时间'));
    [[3600, '1 小时'], [86400, '1 天'], [604800, '7 天']].forEach(function (item) {
      ttlOps.appendChild(btn('btn-ghost', item[1], function () { runKeyTTL(item[0]); }));
    });
    ttlOps.appendChild(btn('btn-ghost', '永久（清除过期）', runKeyPersist));
    add(S.detailHost, el('div', 'redis-detail-note', S.valueAsked ? '' : '读取值可能带来大对象传输，默认不自动执行。'));
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
    S.valueHost.textContent = '';
    if (!S.activeKey) return;
    if (!S.valueAsked) { add(S.valueHost, el('div', 'muted redis-loading', '未读取值——点上方「读取值」查看内容。')); return; }
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
  // ── 写入键 / TTL / 持久化 / 服务端配置 ──────────────────────────────────────
  // 前端只做「类型 + 数据」表单：类型决定 value 形状，绝不让人直接拼 Redis 命令。
  // 后端（redis 0.5.0）负责 RESET/覆盖语义、元素数与字节上限校验。
  var REDIS_SET_TYPES = [
    { value: 'string', label: '字符串 string', hint: '整段文本，写入即 SET（覆盖原值）' },
    { value: 'hash', label: '哈希 hash', hint: '每行「字段=值」，写入 HSET' },
    { value: 'list', label: '列表 list', hint: '每行一个元素，追加到 RPUSH 尾部' },
    { value: 'set', label: '集合 set', hint: '每行一个成员，SADD' },
    { value: 'zset', label: '有序集合 zset', hint: '每行「成员=分值」，分值必须是数字' }
  ];
  var REDIS_TTL_PRESETS = [
    { value: 0, label: '不设置过期' }, { value: 3600, label: '1 小时' },
    { value: 86400, label: '1 天' }, { value: 604800, label: '7 天' }
  ];
  // splitPairs 把 textarea 的「A=B」行拆成二元组；任一行缺分隔符即报错（不静默丢行）。
  function splitPairs(text) {
    var lines = String(text || '').split('\n'), pairs = [], bad = 0;
    lines.forEach(function (line, index) {
      if (!line.trim()) return;
      var at = line.indexOf('=');
      if (at <= 0) { bad = index + 1; return; }
      pairs.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    });
    return { pairs: pairs, badLine: bad };
  }
  // buildSetValue 按当前类型把表单内容组装成后端 value 形状。
  function buildSetValue() {
    var type = S.setType;
    if (type === 'string') return { ok: true, value: S.setText };
    if (type === 'list' || type === 'set') {
      var items = String(S.setText || '').split('\n').filter(function (line) { return line.length > 0; });
      if (!items.length) return { ok: false, error: '至少填一个元素（每行一个）' };
      return { ok: true, value: items };
    }
    var parsed = splitPairs(S.setText);
    if (parsed.badLine) return { ok: false, error: '第 ' + parsed.badLine + ' 行缺少「=」：格式是「字段=值」' };
    if (!parsed.pairs.length) return { ok: false, error: type === 'zset' ? '至少填一个「成员=分值」' : '至少填一个「字段=值」' };
    if (type === 'hash') {
      return { ok: true, value: parsed.pairs.map(function (pair) { return { field: pair[0], value: pair[1] }; }) };
    }
    for (var i = 0; i < parsed.pairs.length; i++) {
      if (!isFinite(Number(parsed.pairs[i][1])) || String(parsed.pairs[i][1]).trim() === '') {
        return { ok: false, error: '第 ' + (i + 1) + ' 个分值不是数字：zset 的「成员=分值」右侧必须是数字' };
      }
    }
    return { ok: true, value: parsed.pairs.map(function (pair) { return { member: pair[0], score: pair[1] }; }) };
  }
  function setTypeMeta(type) {
    for (var i = 0; i < REDIS_SET_TYPES.length; i++) if (REDIS_SET_TYPES[i].value === type) return REDIS_SET_TYPES[i];
    return REDIS_SET_TYPES[0];
  }
  function paintSetForm() {
    var host = S.setFormHost, result = S.setResultHost;
    if (!host) return;
    S.writePanel.hidden = !S.selected;
    host.textContent = ''; result.textContent = ''; result.hidden = true;
    if (!S.selected) return;
    var grid = add(host, el('div', 'redis-set-grid'));
    // 键名
    var keyWrap = add(grid, el('label', 'redis-field'));
    add(keyWrap, el('span', 'redis-label', '键名'));
    var keyInput = add(keyWrap, el('input', 'redis-input'));
    keyInput.value = S.setKey; keyInput.spellcheck = false; keyInput.placeholder = '例如 kore:demo:cache';
    keyInput.addEventListener('input', function () { S.setKey = keyInput.value; });
    // 类型：五档预设下拉
    var typeWrap = add(grid, el('label', 'redis-field'));
    add(typeWrap, el('span', 'redis-label', '类型'));
    var typeSel = add(typeWrap, el('select', 'redis-input'));
    REDIS_SET_TYPES.forEach(function (item) {
      var opt = add(typeSel, el('option', null, item.label)); opt.value = item.value;
      if (item.value === S.setType) opt.selected = true;
    });
    typeSel.addEventListener('change', function () {
      S.setType = typeSel.value; S.setError = ''; paintSetForm();
    });
    // TTL 预设
    var ttlWrap = add(grid, el('label', 'redis-field'));
    add(ttlWrap, el('span', 'redis-label', '过期时间'));
    var ttlSel = add(ttlWrap, el('select', 'redis-input'));
    REDIS_TTL_PRESETS.forEach(function (item) {
      var opt = add(ttlSel, el('option', null, item.label)); opt.value = String(item.value);
      if (item.value === S.setTTL) opt.selected = true;
    });
    ttlSel.addEventListener('change', function () { S.setTTL = parseInt(ttlSel.value, 10) || 0; });
    // 值：单行提示随类型变化（USABILITY：不解释命令，只解释数据形状）
    var valueWrap = add(host, el('label', 'redis-field redis-set-value'));
    add(valueWrap, el('span', 'redis-label', '值 · ' + setTypeMeta(S.setType).hint));
    var area = add(valueWrap, el('textarea', 'redis-input redis-set-text'));
    area.rows = 4; area.spellcheck = false;
    area.value = S.setText;
    area.placeholder = S.setType === 'string' ? '任意文本'
      : (S.setType === 'hash' ? 'name=alice\nage=30'
      : (S.setType === 'zset' ? 'alice=1\nbob=2'
      : '每行一个元素'));
    area.addEventListener('input', function () { S.setText = area.value; });
    var ops = add(host, el('div', 'redis-actions'));
    var submit = add(ops, el('button', 'btn btn-primary', S.setBusy ? '写入中…' : '写入'));
    submit.type = 'button'; submit.disabled = !!S.setBusy || !S.selected;
    on(submit, runSet);
    add(host, el('p', 'redis-set-note',
      '写入会覆盖同键的旧值（字符串 SET / 集合增量写）；一次写入的元素数与单值字节由后端上限约束。' +
      (S.setTTL > 0 ? ' 写入后设置过期：' + fmtTTL(S.setTTL) + '。' : '')));
    result.hidden = !(S.setError || S.setNotice);
    if (S.setError) result.appendChild(notice('写入失败：' + S.setError + '。怎么办：' + redisWriteHint(S.setError)));
    if (S.setNotice) result.appendChild(notice(S.setNotice, true));
  }
  // redisWriteHint 把写方法的错误翻成下一步（不展示 E_* 码）。
  function redisWriteHint(text) {
    var msg = String(text || '');
    if (/READONLY/i.test(msg)) return '当前连到的是只读副本（replica）：请切换到主节点再写';
    if (/NOAUTH|WRONGPASS|NO_PERM|ACL/i.test(msg)) return '当前账号没有写权限：请用有 SET/HSET/RPUSH/SADD/ZADD 权限的账号连接';
    if (/OOM|maxmemory/i.test(msg)) return 'Redis 内存已满（maxmemory）：先扩容或在「服务端配置」里调整淘汰策略';
    if (/E_INVALID|非法|不得为空|超过上限/i.test(msg)) return '键名或值不合法：键名不能为空，元素数与单值字节需在后端上限内';
    return hintFor(msg);
  }
  function runSet() {
    if (!S.selected || S.setBusy) return;
    var key = String(S.setKey || '').trim();
    S.setError = ''; S.setNotice = '';
    if (!key) { S.setError = '键名不能为空'; paintSetForm(); return; }
    var built = buildSetValue();
    if (!built.ok) { S.setError = built.error; paintSetForm(); return; }
    var params = { instance: S.selected, key: key, type: S.setType, value: built.value };
    if (S.setTTL > 0) params.ttl_s = S.setTTL;
    S.setBusy = true; paintSetForm();
    invoke('redis.set', params).then(function (data) {
      if (S.destroyed) return;
      S.setBusy = false;
      S.setNotice = '已写入 ' + (data.key || key) + '（' + (data.type || S.setType) + '，TTL ' + fmtTTL(data.ttl_s) + '）';
      paintSetForm(); loadKeys(); loadInfo();
      if (S.activeKey && S.activeKey.key === key) loadKeyDetail({ key: key });
    }, function (err) {
      if (S.destroyed) return;
      S.setBusy = false; S.setError = (err && err.message) || String(err);
      paintSetForm();
    });
    paintSetForm();
  }
  // runKeyTTL 改 TTL（expire）或清除过期（persist），成功后刷新键详情。
  function runKeyTTL(seconds) {
    if (!S.selected || !S.activeKey) return;
    var key = S.activeKey.key;
    invoke('redis.expire', { instance: S.selected, key: key, ttl_s: seconds }).then(function () {
      if (S.destroyed) return;
      S.notice = '键「' + key + '」过期时间已设为 ' + fmtTTL(seconds);
      paintNotice(); loadKeyDetail({ key: key }); loadInfo();
    }, function (err) {
      if (S.destroyed) return;
      S.noticeHost.appendChild(notice('设置过期失败：' + err.message + '。怎么办：' + redisWriteHint(err.message)));
    });
  }
  function runKeyPersist() {
    if (!S.selected || !S.activeKey) return;
    var key = S.activeKey.key;
    invoke('redis.persist', { instance: S.selected, key: key }).then(function (data) {
      if (S.destroyed) return;
      S.notice = data.persisted ? '键「' + key + '」已清除过期（永久保留）' : '键「' + key + '」本来就没有过期时间';
      paintNotice(); loadKeyDetail({ key: key }); loadInfo();
    }, function (err) {
      if (S.destroyed) return;
      S.noticeHost.appendChild(notice('清除过期失败：' + err.message + '。怎么办：' + redisWriteHint(err.message)));
    });
  }
  // runBgsave 触发后台 RDB 落盘，随后回读 persistence（bgsave 是异步的，稍后再刷一次）。
  function runBgsave() {
    if (!S.selected || S.bgBusy) return;
    S.bgBusy = true; paintOpsCards();
    invoke('redis.bgsave', { instance: S.selected }).then(function (data) {
      if (S.destroyed) return;
      S.bgBusy = false;
      S.notice = '已触发 BGSAVE：' + (data.message || '后台落盘已开始') + '（完成状态见 AOF/RDB 卡片）';
      paintNotice(); loadOps();
      setTimeout(function () { if (!S.destroyed) loadOps(); }, 1500);
    }, function (err) {
      if (S.destroyed) return;
      S.bgBusy = false; paintOpsCards();
      S.noticeHost.appendChild(notice('触发 BGSAVE 失败：' + err.message + '。怎么办：' + redisWriteHint(err.message)));
    });
  }
  // ── 服务端配置面板（maxmemory / maxmemory_policy / timeout）──
  var REDIS_MAXMEMORY_POLICIES = ['volatile-lru', 'allkeys-lru', 'volatile-lfu', 'allkeys-lfu',
    'volatile-random', 'allkeys-random', 'volatile-ttl', 'noeviction'];
  function loadServerConfig() {
    var name = S.selected; if (!name) return;
    S.cfg = null; S.cfgError = ''; S.cfgNotice = ''; paintServerConfig();
    invoke('redis.serverConfig.get', { instance: name }).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      S.cfg = data; paintServerConfig();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.cfgError = err.message; paintServerConfig();
    });
  }
  // cfgHint 把 CONFIG 相关错误翻成「怎么办」，重点回答「为什么这个参数改不了」。
  function cfgHint(text) {
    var msg = String(text || '');
    if (/E_UNSUPPORTED/.test(msg) || /redis\.conf|不支持的参数|危险/.test(msg)) {
      return '该参数需改 redis.conf：本页只允许热改 maxmemory / maxmemory_policy / timeout，' +
        'dir / appendonly / requirepass / save 等必须写配置文件并重启 Redis';
    }
    if (/E_INVALID/.test(msg)) {
      return '值不合法：maxmemory 只接受字节整数或 kb/mb/gb 后缀（0 = 不限制），策略必须是 8 种之一，' +
        'timeout 必须是非负整数秒（0 = 不断开空闲连接）';
    }
    if (/CONFIG|disabled|rename-command|unknown command/i.test(msg)) {
      return 'Redis 禁用了 CONFIG 命令（rename-command 或 ACL）：请在 redis.conf 里启用 CONFIG，' +
        '或改用允许 CONFIG 的管理账号';
    }
    return hintFor(msg);
  }
  function paintServerConfig() {
    var host = S.cfgHost;
    if (!host) return;
    S.cfgPanel.hidden = !S.selected;
    host.textContent = '';
    if (!S.selected) return;
    if (S.cfgError) {
      add(host, el('div', 'db-notice', '服务端配置读取失败：' + S.cfgError + '。怎么办：' + cfgHint(S.cfgError)));
      return;
    }
    if (!S.cfg) { add(host, el('div', 'muted redis-loading', '正在读取服务端配置…')); return; }
    var cfg = S.cfg.config || {};
    var grid = add(host, el('div', 'redis-cfg-grid'));
    function cfgField(labelText, helpText, control) {
      var wrap = add(grid, el('label', 'redis-field'));
      add(wrap, el('span', 'redis-label', labelText));
      add(wrap, control);
      add(wrap, el('span', 'redis-set-note', helpText));
      return control;
    }
    var maxInput = el('input', 'redis-input');
    maxInput.value = cfg.maxmemory || '';
    maxInput.placeholder = '例如 256mb 或 268435456；0 = 不限制';
    cfgField('最大内存 maxmemory', '写入后立即生效（CONFIG SET maxmemory）', maxInput);
    var policySel = el('select', 'redis-input');
    REDIS_MAXMEMORY_POLICIES.forEach(function (name) {
      var opt = add(policySel, el('option', null, name)); opt.value = name;
      if (name === cfg.maxmemory_policy) opt.selected = true;
    });
    cfgField('淘汰策略 maxmemory-policy', '内存达到上限时按该策略淘汰键', policySel);
    var timeoutInput = el('input', 'redis-input');
    timeoutInput.value = cfg.timeout || '';
    timeoutInput.placeholder = '空闲连接超时秒数；0 = 不断开';
    cfgField('空闲超时 timeout', '客户端空闲多少秒后断开；0 = 不断开', timeoutInput);
    var ops = add(host, el('div', 'redis-actions'));
    var save = add(ops, el('button', 'btn btn-primary', S.cfgBusy ? '保存中…' : '保存配置'));
    save.type = 'button'; save.disabled = !!S.cfgBusy;
    on(save, function () { saveServerConfig(maxInput.value, policySel.value, timeoutInput.value); });
    if (S.cfgNotice) add(host, el('div', 'db-notice redis-notice-ok', S.cfgNotice));
    add(host, el('p', 'redis-set-note',
      '只热改三个白名单参数；其它参数请改 redis.conf 并重启。maxmemory 需带单位或字节数，' +
      '策略见下拉，timeout 为秒。'));
  }
  function saveServerConfig(maxmemory, policy, timeout) {
    if (!S.selected || S.cfgBusy) return;
    S.cfgNotice = '';
    var patch = { instance: S.selected };
    if (!/^[0-9]+(kb|mb|gb)?$/i.test(String(maxmemory || '').trim())) {
      S.cfgError = ''; paintServerConfig();
      S.cfgHost.appendChild(notice('maxmemory 格式不对：只允许字节整数或 kb/mb/gb 后缀（0 表示不限制）'));
      return;
    }
    patch.maxmemory = String(maxmemory).trim();
    patch.maxmemory_policy = policy;
    if (!/^[0-9]+$/.test(String(timeout || '').trim())) {
      S.cfgHost.appendChild(notice('timeout 必须是 0 或正整数秒'));
      return;
    }
    patch.timeout = String(timeout).trim();
    S.cfgBusy = true; paintServerConfig();
    invoke('redis.serverConfig.set', patch).then(function (data) {
      if (S.destroyed) return;
      S.cfgBusy = false;
      S.cfg = { instance: data.instance, config: data.config };
      S.cfgNotice = '已保存：' + ((data.changed || []).join(' / ') || '无变化') + '（已回读生效值）';
      paintServerConfig(); loadOps();
    }, function (err) {
      if (S.destroyed) return;
      S.cfgBusy = false; S.cfgError = (err && err.message) || String(err);
      paintServerConfig();
      S.cfgHost.appendChild(notice('保存失败：' + S.cfgError + '。怎么办：' + cfgHint(S.cfgError)));
    });
  }

  function selectInstance(name) {
    if (!name || S.selected === name) return;
    S.selected = name; S.info = null; S.infoError = ''; S.keys = []; S.keysLoaded = false;
    S.keysError = ''; S.activeKey = null; S.value = null; S.valueError = ''; S.valueAsked = false;
    S.keyInfo = null; S.keyInfoError = '';
    S.persist = null; S.persistError = ''; S.memory = null; S.memoryError = '';
    S.slowlog = null; S.slowlogError = ''; S.slowlogLoaded = false;
    S.notice = ''; S.truncated = false; S.scanned = 0;
    S.shown = S.step; S.totalKeys = 0; S.loadingMore = false;
    S.checked = Object.create(null);
    S.setKey = ''; S.setText = ''; S.setTTL = 0; S.setError = ''; S.setNotice = ''; S.setBusy = false;
    S.cfg = null; S.cfgError = ''; S.cfgNotice = ''; S.cfgBusy = false;
    paintInstances(); paintNotice(); paintInfo(); paintKeys(); paintKeyDetail(); paintValue(); paintOpsCards(); paintSlowlog(); paintSetForm(); paintServerConfig();
    loadInfo(); loadKeys(); loadOps();
  }  function loadInstances(reset) {
    if (reset) { S.selected = ''; S.info = null; S.keys = []; S.keysLoaded = false; S.autoNotice = null; }
    S.loadError = ''; paintInstances();
    invoke('redis.instances', {}).then(function (data) {
      if (S.destroyed) return;
      S.instances = data.instances || [];
      if (S.autoPending) {
        S.autoPending = false;
        var pick = S.instances.length ? S.instances[0] : null;
        for (var k = 0; k < S.instances.length; k++) {
          if (S.instances[k].reachable) { pick = S.instances[k]; break; }
        }
        if (pick && pick.reachable) {
          S.autoNotice = { tone: 'ok', text: '已连接「' + (pick.name === 'default' ? '默认连接' : pick.name) + '」' +
            (pick.version ? ' · Redis ' + pick.version : '') + '（' + pick.host + ':' + pick.port + '）' };
        } else if (pick) {
          S.autoNotice = { tone: 'warn', text: '保存成功，但连接失败：' + (pick.error || '原因未知') +
            '。怎么办：' + hintFor(pick.error) };
        } else {
          S.autoNotice = { tone: 'warn', text: '保存成功，但没有可用的连接；请检查设置后重试。' };
        }
        autoBanner();
      }
      paintInstances();
      // 实例结果可能晚于 discover 到达：重绘横幅，让"已连通的服务端版本"按优先级立刻接管。
      autoBanner();
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
    S.keysLoaded = false; S.keysError = ''; S.truncated = false; S.scanned = 0;
    // 搜索 / pattern 变化一律回到第一页：默认只渲染 50 行，避免页面长度失控。
    S.shown = S.step; S.loadingMore = false; paintKeys();
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
    if (!S.selected || !entry) return;
    S.valueAsked = true; S.value = null; S.valueError = ''; paintValue();
    var name = S.selected;
    invoke('redis.get', { instance: name, key: entry.key }).then(function (data) {
      if (S.destroyed || S.selected !== name || !S.activeKey || S.activeKey.key !== entry.key) return;
      S.value = data; paintValue();
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
      if (S.activeKey && keys.indexOf(S.activeKey.key) >= 0) { S.activeKey = null; S.value = null; S.valueAsked = false; S.keyInfo = null; }
      paintNotice(); paintKeys(); paintKeyDetail(); paintValue(); loadInfo(); loadKeys(); loadOps();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.notice = ''; paintDeleteBtn(); S.confirmHost.textContent = '';
      S.confirmHost.appendChild(notice('删除失败：' + err.message));
    });
  }
  function detect() {
    S.discoveryState = 'loading'; S.discoveryError = '';
    autoBanner(); paintInstances();
    invokeAt(DISCOVER, 'discover.services', {}).then(function (data) {
      if (S.destroyed) return;
      S.discovery = pickService(data);
      // version_source=unknown：没有任何可信版本来源 → 不显示横幅，走空态。
      if (S.discovery && S.discovery.version_source === 'unknown') S.discovery = null;
      S.discoveryState = 'ready';
      autoBanner(); paintInstances();
    }, function (err) {
      if (S.destroyed) return;
      S.discovery = null; S.discoveryState = 'error'; S.discoveryError = err.message;
      autoBanner(); paintInstances();
    });
  }
  function openSettings(fromDiscovery) {
    if (!S.root) return;
    var svc = S.discovery;
    var opts = { title: 'Redis 连接', focusKey: 'password' };
    if (fromDiscovery && svc && svc.running) {
      opts.prefill = { host: '127.0.0.1', port: svcPort(svc) };
      opts.autoKeys = { host: true, port: true };
      opts.autoNote = '已从本机检测结果自动填入主机、端口（标“已自动填入”），只需填写密码。';
    }
    opts.onSaved = function () {
      S.autoPending = true; S.autoNotice = null;
      loadInstances(true);
    };
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
    add(head, el('h2', 'view-title', 'Redis')); add(head, el('p', 'view-sub', '连接一个已有的 Redis 服务：查看连接与内存、浏览键、读取值、批量删除。'));
    S.noticeHost = add(S.root, el('div', 'redis-notice-host'));
    S.bannerHost = add(S.root, el('div', 'db-banner-host'));
    var inst = panel('Redis 连接', ''); add(S.root, inst.panel); S.instCount = add(inst.meta, el('span', null, ''));
    var gear = add(inst.meta, el('button', 'btn btn-ghost', '设置')); gear.type = 'button'; on(gear, function () { openSettings(false); });
    S.instBody = add(inst.panel, el('div', 'redis-instance-body'));
    var info = panel('连接信息', '内存 / 连接 / 命中率 / keyspace');
    S.infoPanel = info.panel; S.infoPanel.hidden = true; add(S.root, S.infoPanel); S.infoHost = add(S.infoPanel, el('div', 'redis-info'));
    // 运维指标卡：内存用量 / 碎片率 / AOF·RDB / 慢查询（选中实例后加载）。
    S.opsHost = add(S.root, el('div', 'redis-ops-host')); S.opsHost.hidden = true;
    var keys = panel('键浏览', '');
    var value = panel('键详情', '');
    var columns = add(S.root, el('div', 'redis-columns'));
    add(columns, keys.panel); S.keyCount = add(keys.meta, el('span', null, ''));
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
    S.keysHost = add(keys.panel, el('div', 'redis-keys')); S.keysMoreHost = add(keys.panel, el('div', 'redis-keys-more')); S.confirmHost = add(keys.panel, el('div', 'redis-confirm-host'));
    // 键详情侧栏：keyInfo（类型/编码/TTL/内存）+ 显式「读取值」；替代旧的行点击即盲取值。
    S.detailPanel = value.panel; S.detailPanel.hidden = true; add(columns, S.detailPanel);
    S.detailMeta = add(value.meta, el('span', null, ''));
    S.detailHost = add(S.detailPanel, el('div', 'redis-detail'));
    S.valueHost = add(S.detailPanel, el('div', 'redis-value'));
    var slow = panel('慢查询', 'SLOWLOG');
    S.slowPanel = slow.panel; S.slowPanel.hidden = true; add(S.root, slow.panel);
    S.slowHost = add(slow.panel, el('div', 'redis-slowlog'));
    // 写入键：类型下拉 + 对应数据形状 + TTL 预设（不暴露 Redis 命令）。
    var write = panel('写入键', 'SET / HSET / RPUSH / SADD / ZADD');
    S.writePanel = write.panel; S.writePanel.hidden = true; add(S.root, write.panel);
    S.setFormHost = add(write.panel, el('div', 'redis-set-form'));
    S.setResultHost = add(write.panel, el('div', 'redis-set-result'));
    // 服务端配置：三个白名单参数（其余需改 redis.conf）。
    var cfgPanel = panel('服务端配置', 'maxmemory / maxmemory-policy / timeout');
    S.cfgPanel = cfgPanel.panel; S.cfgPanel.hidden = true; add(S.root, cfgPanel.panel);
    S.cfgHost = add(cfgPanel.panel, el('div', 'redis-cfg'));
    injectStyles();
    autoBanner();
    detect();
    paintInstances(); paintInfo(); paintKeys(); paintKeyDetail(); paintValue(); paintOpsCards(); paintSlowlog(); paintSetForm(); paintServerConfig(); loadInstances();
    return { destroy: function () { S.destroyed = true; } };
  }
  // injectStyles 把本视图新增样式随视图注入 S.root；不改 web/style.css。
  function injectStyles() {
    if (!S.root) return;
    var css = [
      '.redis-ops-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--kore-space-3);padding:var(--kore-space-3) var(--kore-space-4)}',
      '.redis-ops-card{display:flex;flex-direction:column;gap:var(--kore-space-1);padding:var(--kore-space-3);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control)}',
      '.redis-ops-label{color:var(--kore-text-3);font-size:var(--kore-font-12)}',
      '.redis-ops-value{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;word-break:break-word}',
      '.redis-ops-value.is-ok{color:var(--kore-success)}',
      '.redis-ops-value.is-warn{color:var(--kore-warning)}',
      '.redis-ops-sub{color:var(--kore-text-3);font-size:var(--kore-font-12);word-break:break-word}',
      '.redis-ops-bar{height:6px;margin-top:2px;background:var(--kore-bg-2);border-radius:3px;overflow:hidden}',
      '.redis-ops-bar-fill{height:100%;background:var(--kore-info);transition:width .3s ease}',
      '.redis-ops-bar-fill.is-hot{background:var(--kore-danger)}',
      '.redis-ops-bar-fill.is-none{width:100%;background:var(--kore-text-3);opacity:.25}',
      '.redis-ops-dots{display:flex;flex-direction:column;gap:6px;margin-top:2px}',
      '.redis-ops-dot-row{display:flex;align-items:center;gap:6px;font-size:var(--kore-font-12);color:var(--kore-text-2)}',
      '.redis .dot.na{background:var(--kore-text-3)}',
      '.redis-ops-host[hidden]{display:none}',
      '.redis-columns{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:var(--kore-space-3);align-items:start}',
      '.redis-columns > .panel:last-child{position:sticky;top:var(--kore-space-3)}',
      '.redis-detail{padding:var(--kore-space-3) var(--kore-space-4) 0}',
      '.redis-detail-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:var(--kore-font-13)}',
      '.redis-detail-label{color:var(--kore-text-3)}',
      '.redis-detail-value{font-variant-numeric:tabular-nums;word-break:break-word;text-align:right}',
      '.redis-detail-hint{margin-top:var(--kore-space-2);color:var(--kore-text-3);font-size:var(--kore-font-12)}',
      '.redis-detail-note{margin-top:var(--kore-space-2);color:var(--kore-text-3);font-size:var(--kore-font-12)}',
      '.redis-detail .redis-actions{margin-top:var(--kore-space-2);display:flex;gap:var(--kore-space-2)}',
      '.redis-value{padding:var(--kore-space-3) var(--kore-space-4) var(--kore-space-4)}',
      '.redis-slow-note{margin:0;padding:var(--kore-space-3) var(--kore-space-4) 0;color:var(--kore-text-3);font-size:var(--kore-font-12)}',
      '.redis-slow-id{font-variant-numeric:tabular-nums}',
      '.redis-slow-time{font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.redis-slow-dur{font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.redis-slow-cmd{word-break:break-all;max-width:520px}',
      '.redis-set-form{padding:var(--kore-space-3) var(--kore-space-4) 0}',
      '.redis-set-grid{display:grid;grid-template-columns:minmax(0,1fr) 180px 160px;gap:var(--kore-space-2);align-items:end}',
      '.redis-set-value{margin-top:var(--kore-space-2)}',
      '.redis-set-text{width:100%;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.redis-set-note{margin:var(--kore-space-1) 0 0;color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.5}',
      '.redis-set-result{padding:0 var(--kore-space-4) var(--kore-space-3)}',
      '.redis-cfg{padding:var(--kore-space-3) var(--kore-space-4)}',
      '.redis-cfg-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--kore-space-3)}',
      '.redis-ops-action{margin-top:var(--kore-space-2);align-self:flex-start}',
      '@media (max-width:960px){',
      '  .redis-set-grid{grid-template-columns:1fr 1fr}',
      '  .redis-cfg-grid{grid-template-columns:1fr}',
      '  .redis-ops-grid{grid-template-columns:repeat(2,minmax(0,1fr));padding:var(--kore-space-3)}',
      '  .redis-columns{grid-template-columns:1fr}',
      '  .redis-columns > .panel:last-child{position:static}',
      '  .redis-slow-cmd{max-width:none}',
      '}'
    ].join('\n');
    var style = document.createElement('style');
    style.setAttribute('data-kore-view', 'redis');
    style.textContent = css;
    add(S.root, style);
  }
  window.KoreRedis = { render: render };
})();
