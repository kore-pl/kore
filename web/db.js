/* kore 主壳 · 数据库管理（web/db.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<plugin-id>/<plugin-id>.<action>。
   window.KoreDb.render(container) 支持两类实例，按页头的 MySQL / PostgreSQL 切换分派：
     MySQL      → db-mysql.instances / .databases / .query / .status（另有 db-l2 写操作）
     PostgreSQL → db-postgres.instances / .databases / .query / .status + L2 写操作（建库 / 用户与授权）
   协议（PLUGIN-PROTOCOL §7.2.1）：方法段必须带域前缀，裸动词（如 instances）直接
   E_NOTFOUND「未知方法」——本文件所有方法名都经 methodFor() 拼出完整限定名，不做裸名回退。
   空态：PG 的 instances 在 count=0 / 全部不可达时返回 hint，本页原样展示为「怎么办」引导。
   只读 SQL 由插件白名单拒绝写语句，本页原样展示 E_INVALID 全文，不在浏览器重做 SQL 解析。
   L2 管理（建库/删库/建用户/授权/改密；MySQL 另有导入导出）在 web/db-l2.js，首次执行写操作或展开
   「用户与授权」时才注入（/assets/db-l2.js）；删库/删用户必须手输名称后才解锁提交。
   易用性（USABILITY 原则 2）：打开页面先问 discover.discover.services，探测到本机
   MySQL/MariaDB 时给「自动检测横幅 + 一键连接」；host/port/user 由检测结果预填并标
   「已自动填入」，用户只需填密码。探测不到时给安装指引与手动配置入口。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/db-mysql/';
  var DISCOVER = '/api/v1/invoke/discover/';
  function fresh() {
    return { instances: [], selected: '', status: null, dbs: [], result: null, loadError: '',
      statusError: '', dbError: '', dbLoaded: false, queryError: '', busy: false, destroyed: false,
      discoveryState: 'loading', discovery: null, discoveryError: '',
      autoNotice: null, autoPending: false, selectedDb: '', includeSystem: false, l2Promise: null,
      dbType: 'mysql', instHint: '', container: null,
      l2UsersHost: null, l2UsersHandle: null, l2NoticeHost: null,
      // 慢查询分析（db-mysql.slowlog）：阈值/条数只存预设档位，schema 空串=全部库。
      slowlog: null, slowlogError: '', slowlogBusy: false, slowlogLoaded: false,
      slowlogSchema: '', slowlogMinMS: 500, slowlogLimit: 20, slowlogOpen: false,
      slowlogFormHost: null, slowlogMetaHost: null, slowlogHost: null };
  }
  var S = fresh();
  // 本地化（ADR-0021）：与 shell.js tr 同范式——当前语言→中文表→key，缺键回退中文。
  // i18n.t 缺键会返回 key 本身，用 hit !== key 拦截，保证中文态零裸键；params 支持 {x} 插值。
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
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function btn(cls, text, fn) {
    var b = add(cls.parent, el('button', 'btn ' + cls.cls, text));
    b.type = 'button';
    if (fn) on(b, fn);
    return b;
  }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function invokeAt(base, method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(base + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          // 保留 code + message 原文：只读白名单拒绝（E_INVALID）必须能一眼看到原因。
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || '';
          throw err;
        }
        return data;
      });
    });
  }
  // 方法名按当前实例类型拼完整限定名（<plugin-id>.<action>），裸方法名不会被后端接受。
  function isPg() { return S.dbType === 'postgres'; }
  function methodFor(action) { return (isPg() ? 'db-postgres.' : 'db-mysql.') + action; }
  function dbTitle() { return isPg() ? 'PostgreSQL' : 'MySQL'; }
  function defaultPort() { return isPg() ? 5432 : 3306; }
  // 沿用完整方法名的调用方（如 db-l2 的 db-mysql.createDatabase）按前缀选 base，避免写死 MySQL 入口。
  function invoke(method, params) {
    return invokeAt(String(method).indexOf('db-postgres.') === 0 ? '/api/v1/invoke/db-postgres/' : API, method, params);
  }
  // 实例类型选择记在本机（失败静默回默认），下次打开数据库页保持用户上次的选择。
  function loadTypePref() {
    try { return localStorage.getItem('kore.db.type') === 'postgres' ? 'postgres' : 'mysql'; } catch (e) { return 'mysql'; }
  }
  function saveTypePref(type) { try { localStorage.setItem('kore.db.type', type); } catch (e) { /* 隐私模式忽略 */ } }
  function isMissingPlugin(text) { return /E_NOTFOUND|未安装|未启用|未找到插件/.test(String(text || '')); }
  // PostgreSQL 侧的错误原文 → 「怎么办」；MySQL 继续用 hintFor。
  function pgHintFor(text) {
    var msg = String(text || '');
    if (isMissingPlugin(msg)) return tr('db.hint.pgMissingPlugin', 'PostgreSQL 插件（db-postgres）未安装或未启用：到「插件」页安装并启用后刷新本页。');
    if (/E_INVALID|配置|config/i.test(msg)) return tr('db.hint.pgConfig', '连接配置不完整或非法：点「配置连接」补齐 host/port/用户名与密码后再试。');
    if (/E_UPSTREAM|超时|refused|连接.*失败|不可达|no such host/i.test(msg)) {
      return tr('db.hint.pgUnreachable', '检查 PostgreSQL 是否已启动、端口是否监听、host 是否可达；容器部署请填宿主机的发布端口（如 15432）。');
    }
    return tr('db.hint.pgGeneric', '检查插件设置里的 host/port/用户名与密码，确认服务已启动并允许该账号从本机登录。');
  }
  function errHint(text) { return isPg() ? pgHintFor(text) : hintFor(text); }
  function fmtInt(n) { return typeof n === 'number' && isFinite(n) ? n.toLocaleString('zh-CN') : '—'; }
  function fmtPct(ratio) {
    return typeof ratio === 'number' && isFinite(ratio) && ratio >= 0 ? (ratio * 100).toFixed(1) + '%' : '—';
  }
  function fmtUptime(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '—';
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return d + ' 天 ' + h + ' 小时';
    return h ? h + ' 小时 ' + m + ' 分' : m + ' 分';
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone);
    c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function notice(text) {
    var n = el('div', 'db-notice', text);
    n.setAttribute('role', 'alert');
    return n;
  }
  var SYSTEM_DBS = ['mysql', 'information_schema', 'performance_schema', 'sys'];
  var PG_SYSTEM_DBS = ['postgres', 'template0', 'template1'];
  // ensureL2 只在首次执行写操作或展开用户区时注入 db-l2.js；失败清缓存，允许下次重试。
  function ensureL2() {
    if (window.KoreDbL2) return Promise.resolve(window.KoreDbL2);
    if (S.l2Promise) return S.l2Promise;
    S.l2Promise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/assets/db-l2.js'; script.async = true;
      script.onload = function () {
        if (!window.KoreDbL2) { S.l2Promise = null; reject(new Error('db-l2.js 未导出 KoreDbL2')); return; }
        resolve(window.KoreDbL2);
      };
      script.onerror = function () { S.l2Promise = null; reject(new Error('db-l2.js 加载失败')); };
      document.head.appendChild(script);
    });
    return S.l2Promise;
  }
  function l2Ctx() {
    return {
      instance: S.selected, isPg: isPg(), dbType: S.dbType, el: el, add: add, dbs: S.dbs.slice(),
      selectedDb: S.selectedDb || (S.dbs.length ? S.dbs[0] : ''),
      invoke: invoke,
      errText: function (err) { return err && err.message ? err.message : String(err); },
      hint: function (text) { return hintFor(text); },
      loadDbs: loadDbs, notice: l2Notice,
      onUsersChanged: function () { if (S.l2UsersHandle) S.l2UsersHandle.reload(); }
    };
  }
  function withL2(fn) {
    ensureL2().then(function (mod) { fn(mod, l2Ctx()); }, function (err) {
      l2Notice(tr('db.error.l2Load', 'L2 管理模块加载失败：') + err.message + tr('db.error.refreshRetry', '。刷新页面后重试。'), 'warn');
    });
  }
  function l2Notice(text, tone) {
    if (!S.l2NoticeHost) return;
    S.l2NoticeHost.textContent = '';
    S.l2NoticeHost.appendChild(el('p', 'db-l2-notice ' + (tone || 'ok'), text));
  }
  function l2Btn(label, fn) {
    var b = el('button', 'btn btn-ghost', label);
    b.type = 'button'; on(b, fn); return b;
  }
  // L2 的样式跟随 db.js（行布局在首屏绘制时就要生效），按选择器分组压到最少行数。
  var L2_CSS = '.db-toolbar{display:flex;align-items:center;gap:var(--kore-space-2);flex-wrap:wrap;padding:var(--kore-space-2) var(--kore-space-4) 0}' +
    '.db-toolbar .btn,.db-row-ops .btn,.db-l2-row-ops .btn{min-height:32px;padding:0 var(--kore-space-2);font-size:var(--kore-font-12)}' +
    '@media (min-width:1024px){.db-db-panel .db-db-op{display:none}}' +
    '.db-sys-toggle{min-height:32px;gap:var(--kore-space-1);color:var(--kore-text-2);font-size:var(--kore-font-12)}' +
    '.db-row{display:flex;align-items:center;gap:var(--kore-space-1);flex-wrap:wrap}' +
    '.db-row .db-db{flex:1 1 60px;width:auto;min-width:0}.db-row-ops{display:flex;gap:var(--kore-space-1);flex:0 0 auto}' +
    '.db-row .db-db-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.db-l2-notice{margin:0 var(--kore-space-4) var(--kore-space-2);padding:var(--kore-space-2) var(--kore-space-3);' +
    'border-radius:var(--kore-radius-control);font-size:var(--kore-font-13);word-break:break-word}' +
    '.db-l2-notice.ok{color:var(--kore-success);border:1px solid var(--kore-success)}' +
    '.db-l2-notice.warn{color:var(--kore-danger);border:1px solid var(--kore-danger)}' +
    '.db-l2-panel{margin-top:var(--kore-space-4)}' +
    '.db-l2-summary{display:flex;align-items:center;gap:var(--kore-space-2);cursor:pointer;' +
    'padding:var(--kore-space-3) var(--kore-space-4);list-style:none;min-height:var(--kore-touch)}' +
    '.db-l2-summary::-webkit-details-marker{display:none}.db-l2-summary::before{content:"▸";color:var(--kore-text-3)}' +
    '.db-l2-panel[open] .db-l2-summary::before{content:"▾"}' +
    '.db-l2-users{padding:0 var(--kore-space-4) var(--kore-space-3)}' +
    '.db-l2-users-head{display:flex;align-items:center;justify-content:space-between;gap:var(--kore-space-2);flex-wrap:wrap}' +
    '.db-l2-ops,.db-l2-row-ops{display:flex;gap:var(--kore-space-1);flex-wrap:wrap}' +
    '.db-l2-note{margin:0 0 var(--kore-space-2);color:var(--kore-text-3);font-size:var(--kore-font-12)}' +
    '.db-l2-users-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-13)}' +
    '.db-l2-users-table th{text-align:left;color:var(--kore-text-2);font-weight:600;padding:var(--kore-space-1) var(--kore-space-2)}' +
    '.db-l2-users-table td{padding:var(--kore-space-1) var(--kore-space-2);border-top:1px solid var(--kore-border-1)}' +
    '.db-l2-user,.db-l2-host{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}' +
    '.db-l2-locked{color:var(--kore-text-3);font-size:var(--kore-font-12)}' +
    '.db-l2-warn{margin:0;padding:var(--kore-space-2) var(--kore-space-3);color:var(--kore-danger);' +
    'border:1px solid var(--kore-danger);border-radius:var(--kore-radius-control);font-size:var(--kore-font-12);line-height:1.5}' +
    '.db-l2-input-row{display:flex;gap:var(--kore-space-2);align-items:center}' +
    '.db-l2-input-row .field-input{flex:1 1 auto;min-width:0}' +
    '.db-l2-checks{display:flex;flex-wrap:wrap;gap:var(--kore-space-1) var(--kore-space-3)}' +
    '.db-l2-checks .field-check{min-height:32px}.db-l2-copy{color:var(--kore-success)}.db-l2-error{padding:var(--kore-space-2) 0}' +
    '.db-type-switch{display:inline-flex;flex:0 0 auto;border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);overflow:hidden}' +
    '.db-type-switch .btn{border:0;border-radius:0;min-height:32px;padding:0 var(--kore-space-3);font-size:var(--kore-font-12);white-space:nowrap}' +
    '.db-type-switch .btn[aria-pressed="true"]{background:var(--kore-info);color:#fff}' +
    '.db-pg-note{margin:0 var(--kore-space-4) var(--kore-space-2);color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.6}' +
    '.db-type-row{display:flex;align-items:center;gap:var(--kore-space-2);flex-wrap:wrap;padding:0 var(--kore-space-3) var(--kore-space-2)}' +
    '.db-slow-form{display:flex;align-items:center;gap:var(--kore-space-2);flex-wrap:wrap;margin-bottom:var(--kore-space-2)}' +
    '.db-slow-form label{display:flex;align-items:center;gap:var(--kore-space-1);color:var(--kore-text-2);font-size:var(--kore-font-12)}' +
    '.db-slow-form select{min-height:32px}' +
    '.db-slow-meta{display:flex;align-items:center;gap:var(--kore-space-2);flex-wrap:wrap;margin:0 0 var(--kore-space-2);color:var(--kore-text-3);font-size:var(--kore-font-12)}' +
    '.db-slow-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-13)}' +
    '.db-slow-table th{text-align:left;color:var(--kore-text-2);font-weight:600;padding:var(--kore-space-1) var(--kore-space-2);white-space:nowrap}' +
    '.db-slow-table td{padding:var(--kore-space-1) var(--kore-space-2);border-top:1px solid var(--kore-border-1);vertical-align:top}' +
    '.db-slow-table td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}' +
    '.db-slow-sql{display:block;max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;cursor:help}' +
    '.db-slow-hint{margin:var(--kore-space-1) 0;padding:var(--kore-space-2) var(--kore-space-3);color:var(--kore-danger);border:1px solid var(--kore-danger);border-radius:var(--kore-radius-control);font-size:var(--kore-font-12);line-height:1.5}' +
    '.db-slow-raw{margin:var(--kore-space-1) 0 0;color:var(--kore-text-3);font-size:var(--kore-font-12);word-break:break-word}' +
    '@media (max-width:640px){.db-slow-table{display:block;overflow-x:auto}.db-slow-sql{max-width:18ch}}';
  function ensureL2Style() {
    if (document.getElementById('kore-db-l2-style')) return;
    var style = document.createElement('style');
    style.id = 'kore-db-l2-style'; style.textContent = L2_CSS;
    document.head.appendChild(style);
  }
  function currentInstance() {
    for (var i = 0; i < S.instances.length; i++) {
      if (S.instances[i].name === S.selected) return S.instances[i];
    }
    return null;
  }
  function dbLabel(svc) { return svc && svc.id === 'mariadb' ? 'MariaDB' : 'MySQL'; }
  function shortVersion(version) { return String(version || '').split(/[-~+]/)[0]; }
  function svcPort(svc) { return svc && svc.port ? svc.port : 3306; }
  // discover 0.2.0 起返回 client_version / server_version / version_source；0.1.0 只有
  // version（客户端 `--version` 输出）。旧字段一律按客户端版本归一——客户端版本绝不
  // 冒充服务端版本。旧版发现到服务却没探到版本时降级为 client（空版本），避免把
  // 「装在本机、正在运行」误判成「未检测到」。
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
  function isDbService(svc) { return svc && (svc.id === 'mariadb' || svc.id === 'mysql'); }
  // 三态优先级：① version_source=server（唯一可信的服务端版本）→ ② found && running
  // （可能只有客户端版本，连服务端还需要密码）→ ③ 空态。MariaDB 不再无条件压过
  // MySQL：3306 上探到 MySQL 9.7.1 的服务端版本时，即使本机只装了 MariaDB 客户端
  // 也会选中 MySQL 条目，而不是把 MariaDB 客户端版本当成服务端展示。
  function pickService(list) {
    var candidates = (list || []).map(normalizeService).filter(isDbService);
    var server = candidates.filter(function (s) { return s.version_source === 'server'; });
    if (server.length) return server[0];
    var running = candidates.filter(function (s) { return s.found && s.running; });
    for (var i = 0; i < running.length; i++) if (running[i].id === 'mysql') return running[i];
    return running.length ? running[0] : null;
  }
  // 已连通的实例：instances 的 reachable=true 表示"用配置里的凭据真实连上了服务端"，
  // 它的 version 就是服务端版本，可信度高于 discover（旧版 discover 只探得到客户端版本）。
  // 横幅真相优先级：已连通实例的服务端版本 > discover.server_version > discover.client_version。
  function connectedInstance() {
    for (var i = 0; i < S.instances.length; i++) {
      if (S.instances[i] && S.instances[i].reachable) return S.instances[i];
    }
    return null;
  }
  // 版本串自带 MariaDB 标记时以版本为准，否则沿用 discover 命中的实现名。
  function connectedLabel(inst, svc) {
    if (/mariadb/i.test(String((inst && inst.version) || ''))) return 'MariaDB';
    if (svc && isDbService(svc)) return dbLabel(svc);
    return 'MySQL';
  }
  // hintFor 把后端 error 原文翻译成「怎么办」；没有命中时给通用排查顺序。
  function hintFor(text) {
    var msg = String(text || '');
    if (/Access denied|1045|28000/i.test(msg)) {
      return tr('db.hint.accessDenied', '请确认用户名和密码。密码忘记可在服务器上重置：ALTER USER \'root\'@\'localhost\' IDENTIFIED BY \'<新密码>\'；' +
        '若只允许本机 socket 登录，请创建可远程登录的账号。');
    }
    if (/2002|2003|refused|Can\'t connect|连接.*失败/i.test(msg)) {
      return tr('db.hint.noListener', '服务没有在目标端口监听：确认数据库已启动（systemctl status mariadb 或 mysqld），或把端口改成实际监听端口。');
    }
    if (/Unknown MySQL server host|no such host|Name or service not known/i.test(msg)) {
      return tr('db.hint.badHost', '主机名无法解析：本机数据库请填 127.0.0.1，远程数据库请填可解析的 IP 或域名。');
    }
    if (/password env|密码环境变量/i.test(msg)) {
      return tr('db.hint.passwordEnv', '密码环境变量未设置：直接在设置里填写“密码”，或启动内核前导出该环境变量。');
    }
    return tr('db.hint.generic', '检查地址、端口、用户名和密码；确认数据库已启动并允许该账号从本机登录，然后重试。');
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
    function act(cls, label, fn) { add(actions, btn({ parent: actions, cls: cls }, label, fn)); }

    // PostgreSQL 没有 discover 自动探测：横幅直接用 instances 的 hint 与连通状态说话。
    if (isPg()) {
      var pgConn = connectedInstance();
      if (pgConn) {
        badge(tr('db.state.connected', '已连接'));
        title(tr('db.banner.pgConnected', '已连接 PostgreSQL ') + shortVersion(pgConn.version) + '（' + (pgConn.host || '127.0.0.1') + ':' + (pgConn.port || 5432) + '）');
        text('连接信息来自插件设置（db-postgres 配置契约），保存后下一次调用立即生效；要改地址或密码点「配置连接」。');
        if (S.autoNotice) add(main, el('p', 'db-auto-result ' + (S.autoNotice.tone || 'ok'), S.autoNotice.text));
        act('btn-primary', tr('db.action.configConn', '配置连接'), function () { openSettings(false); });
        act('btn-ghost', tr('db.action.retry', '重新读取'), function () { loadInstances(false); });
        return;
      }
      box.classList.add('is-none');
      badge('PostgreSQL');
      title(tr('db.banner.pgNotConfigured', 'PostgreSQL 数据库连接未配置或不可达'));
      text(S.instHint || (isMissingPlugin(S.loadError) ? pgHintFor(S.loadError) : '正在读取连接配置…'));
      if (S.autoNotice) add(main, el('p', 'db-auto-result ' + (S.autoNotice.tone || 'ok'), S.autoNotice.text));
      act('btn-primary', tr('db.action.configConn', '配置连接'), function () { openSettings(false); });
      act('btn-ghost', tr('db.action.retry', '重新读取'), function () { loadInstances(false); });
      return;
    }

    // 优先级①：只要有一个实例真的连通，横幅就以实例卡的服务端版本为准——
    // 即使 discover 是旧版、只探到客户端版本，也不再出现"横幅说没连上、实例卡说可达"的自相矛盾。
    var conn = connectedInstance();
    if (conn) {
      var connVersion = shortVersion(conn.version);
      badge(tr('db.state.connected', '已连接'));
      title('已连接 ' + connectedLabel(conn, S.discovery) + (connVersion ? ' ' + connVersion : '') +
        '（' + (conn.host || '127.0.0.1') + ':' + (conn.port || 3306) + '）');
      text('服务端版本来自已连通的连接（用配置里的凭据真实连上服务端），比本机自动检测更可信；' +
        '自动检测只探到客户端版本时以这里为准。连接信息可在右上角「设置」里修改。');
      if (S.autoNotice) {
        add(main, el('p', 'db-auto-result ' + (S.autoNotice.tone || 'ok'), S.autoNotice.text));
      }
      act('btn-primary', tr('db.action.editConn', '修改连接'), function () { openSettings(false); });
      act('btn-ghost', tr('db.action.redetect', '重新检测'), detect);
      return;
    }

    if (S.discoveryState === 'loading') {
      badge('自动检测');
      title(tr('db.banner.detecting', '正在检测本机 MySQL/MariaDB…'));
      text('检测只读本机命令与监听端口，不会安装或启动任何服务。');
      return;
    }
    if (S.discoveryState === 'error') {
      box.classList.add('is-none');
      badge(tr('db.banner.detectUnavailable', '自动检测不可用'));
      title(tr('db.banner.detectFailed', '未能完成自动检测'));
      text('原因：' + S.discoveryError + '。可以手动填写连接信息，或点“重新检测”。');
      act('btn-ghost', tr('db.action.redetect', '重新检测'), detect);
      act('btn-primary', tr('db.action.manualConfig', '手动配置'), function () { openSettings(false); });
      return;
    }
    var svc = S.discovery;
    if (!svc) {
      box.classList.add('is-none');
      badge('自动检测');
      title(tr('db.banner.notDetected', '未检测到本机 MySQL/MariaDB'));
      text('安装服务后刷新本页会自动识别。Debian/Ubuntu：sudo apt install mariadb-server；' +
        'RHEL：sudo dnf install mariadb-server。已有远程数据库可直接手动配置。');
      act('btn-ghost', tr('db.action.redetect', '重新检测'), detect);
      act('btn-primary', tr('db.action.manualConfig', '手动配置'), function () { openSettings(false); });
      return;
    }
    if (svc.version_source !== 'server' && svc.version_source !== 'client') {
      // unknown：不显示横幅，回落到空态（detect 已把 unknown 置空，这里只作收口）。
      S.discovery = null;
      autoBanner();
      return;
    }
    var label = dbLabel(svc);
    if (!svc.running) {
      box.classList.add('is-none');
      badge('自动检测');
      var stopped = shortVersion(svc.server_version || svc.client_version);
      title('检测到本机 ' + label + (stopped ? ' ' + stopped : '') + '，但服务未运行');
      text('启动服务后再点“重新检测”：systemctl start ' + (svc.id === 'mariadb' ? 'mariadb' : 'mysql') +
        '（不同发行版也可能是 mysqld）。');
      act('btn-ghost', tr('db.action.redetect', '重新检测'), detect);
      act('btn-primary', tr('db.action.manualConfig', '手动配置'), function () { openSettings(false); });
      return;
    }
    if (svc.version_source === 'server') {
      // server：服务端版本只来自真实连接（discover 的 SELECT VERSION()），可直接展示。
      var serverVersion = shortVersion(svc.server_version);
      badge('自动检测');
      title('检测到本机 ' + label + (serverVersion ? ' ' + serverVersion : '') +
        '（127.0.0.1:' + svcPort(svc) + '）');
      text(S.autoNotice && S.autoNotice.tone === 'ok'
        ? '已自动填入主机、端口、用户名并连接成功；可在右上角「设置」里修改连接信息。'
        : '已自动填入主机、端口、用户名；点“一键连接”后只需填写密码。');
      if (S.autoNotice) {
        add(main, el('p', 'db-auto-result ' + (S.autoNotice.tone || 'ok'), S.autoNotice.text));
      }
      act('btn-primary', tr('db.action.oneClickConn', '一键连接'), function () { openSettings(true); });
      act('btn-ghost', tr('db.action.redetect', '重新检测'), detect);
      return;
    }
    // client：只拿到客户端版本，服务端不可达/需要密码——绝不把 client_version 展示成服务端版本。
    var clientVersion = String(svc.client_version || '').trim();
    badge('自动检测');
    title('检测到本机 ' + label + ' 客户端（未连上服务端，需要密码）');
    text('本机只探测到' + (clientVersion ? '客户端版本 ' + clientVersion : '客户端，未拿到版本号') +
      '，没有连上服务端；连上真实服务端后这里会显示服务端版本。' +
      '已自动填入主机、端口、用户名；点“一键连接”后只需填写密码。');
    if (S.autoNotice) {
      add(main, el('p', 'db-auto-result ' + (S.autoNotice.tone || 'ok'), S.autoNotice.text));
    }
    act('btn-primary', tr('db.action.oneClickConn', '一键连接'), function () { openSettings(true); });
    act('btn-ghost', tr('db.action.redetect', '重新检测'), detect);
  }
  function paintInstances() {
    if (!S.instBody) return;
    S.instBody.textContent = '';
    S.instCount.textContent = S.instances.length ? S.instances.length + ' 个连接' : '';
    if (S.loadError) {
      var fail = add(S.instBody, el('div', 'empty-state db-empty'));
      add(fail, el('p', 'empty-state-title', tr('db.empty.loadError', '读取连接失败')));
      add(fail, el('p', 'empty-state-text', S.loadError));
      add(fail, el('p', 'empty-state-text', tr('db.prefix.howto', '怎么办：') + errHint(S.loadError)));
      var retry = add(fail, el('button', 'btn btn-primary', tr('db.action.retry', '重新读取')));
      retry.type = 'button'; on(retry, function () { loadInstances(false); });
      return;
    }
    if (!S.instances.length) {
      var empty = add(S.instBody, el('div', 'empty-state db-empty'));
      if (isPg()) {
        // 空态引导：优先用插件返回的 hint（count=0 与「全不可达」两种文案由后端决定）。
        add(empty, el('p', 'empty-state-title', tr('db.empty.noPgConnections', '还没有 PostgreSQL 连接')));
        add(empty, el('p', 'empty-state-text',
          S.instHint || (isMissingPlugin(S.loadError) ? pgHintFor(S.loadError)
            : '插件设置里还没有保存连接信息：请填写 host / port / 用户名 / 密码。')));
        var pgOps = add(empty, el('div', 'db-auto-actions'));
        add(pgOps, btn({ parent: pgOps, cls: 'btn-primary' }, '配置连接', function () { openSettings(false); }));
        add(pgOps, btn({ parent: pgOps, cls: 'btn-ghost' }, '重新读取', function () { loadInstances(false); }));
        add(empty, el('p', 'empty-state-text',
          '也可以先导出环境变量再重启内核：KORE_PG_HOST / KORE_PG_PORT / KORE_PG_USER / KORE_PG_PASSWORD_ENV。'));
        return;
      }
      add(empty, el('p', 'empty-state-title', tr('db.empty.noConnections', '还没有数据库连接')));
      var svc = S.discovery;
      var why;
      if (S.discoveryState === 'loading') {
        why = '正在检测本机数据库…检测完成后这里会出现一键连接入口。';
      } else if (svc && svc.running) {
        var detected = svc.version_source === 'server'
          ? ' ' + shortVersion(svc.server_version)
          : ' 客户端（未连上服务端，需要密码）';
        why = '已检测到本机 ' + dbLabel(svc) + detected + '。点上方“一键连接”，只需填写密码即可。';
      } else if (svc) {
        why = '检测到本机 ' + dbLabel(svc) + '，但服务未运行。启动服务后点上方“重新检测”。';
      } else {
        why = '未检测到本机 MySQL/MariaDB。安装后刷新本页会自动识别：' +
          'Debian/Ubuntu 用 sudo apt install mariadb-server，RHEL 用 sudo dnf install mariadb-server。';
      }
      add(empty, el('p', 'empty-state-text', why));
      var ops = add(empty, el('div', 'db-auto-actions'));
      if (svc && svc.running) {
        add(ops, btn({ parent: ops, cls: 'btn-primary' }, '一键连接', function () { openSettings(true); }));
      }
      add(ops, btn({ parent: ops, cls: 'btn-primary' }, '手动配置', function () { openSettings(false); }));
      add(ops, btn({ parent: ops, cls: 'btn-ghost' }, '重新检测', detect));
      var adv = add(empty, el('details', 'db-advanced'));
      add(adv, el('summary', null, tr('db.empty.envFaq', '已有环境变量配置？')));
      add(adv, el('p', 'empty-state-text',
        '旧路径 KORE_MYSQL_INSTANCES / KORE_MYSQL_CONFIG 仍然有效，本页不会覆盖它们；' +
        '本页保存的是“默认连接”。'));
      return;
    }
    var grid = add(S.instBody, el('div', 'db-instances'));
    S.instances.forEach(function (inst) {
      var active = inst.name === S.selected;
      var card = add(grid, el('button', 'db-instance' + (active ? ' is-active' : '')));
      card.type = 'button';
      card.setAttribute('aria-pressed', active ? 'true' : 'false');
      var top = add(card, el('div', 'db-inst-head'));
      add(top, el('span', 'db-inst-name', inst.name === 'default' ? tr('db.label.default', '默认连接') : inst.name));
      top.appendChild(chip(inst.reachable ? 'ok' : 'fail', inst.reachable ? tr('db.state.reachable', '可达') : tr('db.state.unreachable', '不可达')));
      add(card, el('div', 'db-inst-meta', (inst.host || '—') + ':' + (inst.port || defaultPort())));
      if (inst.reachable) {
        add(card, el('div', 'db-inst-version', inst.version || tr('db.unknown.version', '版本未知')));
      } else {
        add(card, el('div', 'db-inst-error', tr('db.error.connectFailed', '连接失败：') + (inst.error || tr('db.unknown.reason', '原因未知')))).title = inst.error || '';
        add(card, el('div', 'db-inst-hint', tr('db.prefix.howto', '怎么办：') + errHint(inst.error)));
      }
      on(card, function () { selectInstance(inst.name); });
    });
  }
  function paintStatus() {
    if (!S.statusHost) return;
    S.statusHost.textContent = '';
    if (S.statusError) { S.statusHost.appendChild(notice(tr('db.status.error', '状态读取失败：') + S.statusError)); return; }
    if (!S.status) { add(S.statusHost, el('div', 'db-status-loading muted', tr('db.status.loading', '正在读取连接状态…'))); return; }
    var d = S.status, grid = add(S.statusHost, el('div', 'db-stats'));
    var stats = isPg()
      ? [[tr('db.stat.connections', '连接数'), fmtInt(d.connections)], [tr('db.stat.databases', '数据库'), fmtInt(d.databases)], [tr('db.stat.uptime', '运行时长'), fmtUptime(d.uptime_s)],
        [tr('db.stat.cacheHit', '缓存命中率'), fmtPct(d.cache_hit_ratio)], [tr('db.stat.blocksHit', '命中块'), fmtInt(d.blocks_hit)], [tr('db.stat.version', '版本'), d.version || '—']]
      : [[tr('db.stat.threads', '连接线程'), fmtInt(d.threads_connected)], [tr('db.stat.uptime', '运行时长'), fmtUptime(d.uptime_s)], [tr('db.stat.queries', '查询总数'), fmtInt(d.queries)],
        [tr('db.stat.slowQueries', '慢查询'), fmtInt(d.slow_queries)], [tr('db.stat.maxConnections', '最大连接'), fmtInt(d.max_connections)], [tr('db.stat.version', '版本'), d.version || '—']];
    stats.forEach(function (item) {
      var cell = add(grid, el('div', 'db-stat'));
      add(cell, el('span', 'db-stat-label', item[0]));
      add(cell, el('span', 'db-stat-value', item[1]));
      if (item[0] === tr('db.stat.uptime', '运行时长') && typeof d.uptime_s === 'number') cell.title = d.uptime_s + tr('db.unit.seconds', ' 秒');
    });
  }
  function paintDbs() {
    if (!S.dbHost) return;
    S.dbHost.textContent = '';
    S.dbCount.textContent = S.dbs.length ? S.dbs.length + tr('db.unit.databases', ' 个库') : '';
    if (S.dbError) { S.dbHost.appendChild(notice(tr('db.db.error', '库列表读取失败：') + S.dbError)); return; }
    if (!S.dbLoaded) { add(S.dbHost, el('div', 'db-list-hint muted', tr('db.db.loading', '正在读取数据库…'))); return; }
    if (!S.dbs.length) { add(S.dbHost, el('div', 'db-list-hint muted', tr('db.db.emptyFiltered', '没有可展示的数据库（系统库已过滤）'))); return; }
    S.dbs.forEach(function (name) {
      var row = add(S.dbHost, el('div', 'db-row'));
      var main = add(row, el('button', 'db-db'));
      main.type = 'button';
      add(main, el('span', 'db-db-name', name));
      add(main, el('span', 'db-db-op', tr('db.db.showTables', 'SHOW TABLES')));
      on(main, function () { useDb(name); });
      var ops = add(row, el('div', 'db-row-ops'));
      if (!isPg()) { // export 是 db-mysql 专属：PG info.json 无该方法，不给必然失败的入口
        add(ops, l2Btn(tr('db.action.export', '导出'), function () {
          withL2(function (mod, ctx) { mod.openExport(ctx, name); });
        }));
      }
      // 系统库行不给删除入口：后端对各自的系统库在任何 confirm 下都返回 E_UNAUTHORIZED，
      // 前端先按域名单隐藏，避免留一条必然失败的路径（PG: postgres/template0/template1）。
      var systemDbs = isPg() ? PG_SYSTEM_DBS : SYSTEM_DBS;
      if (systemDbs.indexOf(name) < 0) {
        add(ops, l2Btn(tr('db.action.drop', '删除'), function () {
          withL2(function (mod, ctx) { mod.confirmDropDb(ctx, name); });
        }));
      }
    });
  }
  function paintQueryNotice() {
    if (!S.queryNoticeHost) return; S.queryNoticeHost.textContent = '';
    if (S.queryError) S.queryNoticeHost.appendChild(notice(S.queryError));
  }
  function paintRunState() {
    if (!S.run) return; S.run.disabled = S.busy;
    S.runState.textContent = S.busy ? tr('db.query.running', '执行中…') : '';
  }
  function paintResult() {
    if (!S.resultHost) return;
    var host = S.resultHost;
    host.textContent = '';
    if (!S.result) {
      add(host, el('div', 'db-result-empty muted', S.queryError ? tr('db.result.noRows', '查询未返回结果') : tr('db.result.hint', '执行 SQL 后在此查看结果')));
      return;
    }
    var r = S.result, rows = r.rows || [], cols = r.columns || [];
    var meta = add(host, el('div', 'db-result-meta'));
    add(meta, el('span', null, fmtInt(r.row_count != null ? r.row_count : rows.length) + tr('db.unit.rows', ' 行')));
    if (r.truncated) add(meta, el('span', 'db-truncated', tr('db.result.truncated', '已截断，仅显示前 {n} 行', { n: rows.length })));
    if (!cols.length) { add(host, el('div', 'db-result-empty muted', tr('db.result.noColumns', '查询未返回列'))); return; }
    var scroll = add(host, el('div', 'db-result-scroll'));
    var table = add(scroll, el('table', 'db-result-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    cols.forEach(function (c) { add(htr, el('th', null, c)); });
    var tbody = add(table, el('tbody'));
    if (!rows.length) {
      var td = add(add(tbody, el('tr')), el('td', 'db-result-empty muted', tr('db.result.zeroRows', '（0 行）')));
      td.colSpan = cols.length;
      return;
    }
    rows.forEach(function (row) {
      var rowNode = add(tbody, el('tr'));
      cols.forEach(function (c) {
        var value = row ? row[c] : null, cell = add(rowNode, el('td'));
        if (value === null || value === undefined) { cell.textContent = 'NULL'; cell.className = 'db-null'; }
        else cell.textContent = String(value);
      });
    });
  }
  // ── 慢查询分析（db-mysql.slowlog，仅 MySQL/MariaDB）──
  // 数据来自 performance_schema 的 digest 聚合：只读、不改服务端状态。
  // 阈值与条数只给预设档位（手填任意数字容易拉出大结果集，后端上限 100 条）。
  var SLOWLOG_MIN_MS = [100, 500, 1000];
  var SLOWLOG_LIMITS = [10, 20, 50];
  // stripErrCode 去掉 E_XXX：前缀，页面上不出现协议码。
  function stripErrCode(text) {
    return String(text || '').replace(/^E_[A-Z_]+[:：]\s*/, '');
  }
  // slowlogHintFor 把后端错误翻成「下一步做什么」。
  function slowlogHintFor(text) {
    var msg = String(text || '');
    if (/performance_schema/i.test(msg)) {
      return '慢查询统计需要数据库开启 performance_schema，见错误提示里的说明';
    }
    if (/Access denied|denied for user|权限/i.test(msg)) {
      return '当前账号没有 performance_schema 的读取权限：请让 DBA 授予 SELECT ON performance_schema.* 后再试';
    }
    if (/2002|2003|refused|Can't connect|连接|timed out|超时/i.test(msg)) {
      return '检查连接配置：数据库是否已启动、地址与端口（默认 3306）是否正确，再点「分析」重试';
    }
    return '先确认连接可用，再降低耗时阈值或换一个库重试；仍失败请把下方原始信息交给 DBA';
  }
  // fmtMS 把毫秒压成 1 位小数的 ms 或 2 位小数的 s。
  function fmtMS(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(1) + ' ms';
  }
  function paintSlowlog() {
    var formHost = S.slowlogFormHost, resultHost = S.slowlogHost;
    if (!formHost || !resultHost) return;
    formHost.textContent = '';
    if (S.slowlogMetaHost) S.slowlogMetaHost.textContent = '';
    resultHost.textContent = '';
    // 实例：下拉切换选中实例；切换后 databases / query / slowlog 都按新实例取数。
    var instWrap = add(formHost, el('label', null, tr('db.slow.connection', '数据库连接')));
    var instSel = add(instWrap, el('select', null));
    instSel.setAttribute('aria-label', '切换数据库连接');
    (S.instances || []).forEach(function (inst) {
      var opt = add(instSel, el('option', null,
        inst.name + (inst.reachable ? '' : '（不可达）')));
      opt.value = inst.name;
      if (inst.name === S.selected) opt.selected = true;
    });
    if (!(S.instances || []).length) {
      var only = add(instSel, el('option', null, S.selected || '未选择'));
      only.value = S.selected || '';
    }
    instSel.addEventListener('change', function () {
      var next = instSel.value;
      if (!next || next === S.selected) return;
      selectInstance(next);
    });
    // 当前实例不可达时给下一步，而不是只留一个报错。
    var activeInst = currentInstance();
    if (activeInst && !activeInst.reachable) {
      add(formHost, el('p', 'db-slow-raw',
        '当前连接不可达：点上方连接卡或右上角「设置」改一下地址 / 账号后重试，也可以切到其他可达的连接。'));
    }
    // 库：全部 + 已加载的库列表。
    var schemaWrap = add(formHost, el('label', null, tr('db.slow.schema', '库')));
    var schemaSel = add(schemaWrap, el('select', null));
    schemaSel.setAttribute('aria-label', '统计范围（库）');
    add(schemaSel, el('option', null, tr('db.slow.allSchemas', '全部库'))).value = '';
    (S.dbs || []).forEach(function (db) {
      // S.dbs 统一存库名字符串（loadDbs 已把 PG 的对象形态压平）；这里仍兼容对象。
      var name = typeof db === 'string' ? db : (db && db.name) || '';
      if (name) add(schemaSel, el('option', null, name)).value = name;
    });
    schemaSel.value = S.slowlogSchema || '';
    schemaSel.addEventListener('change', function () { S.slowlogSchema = schemaSel.value; });
    // 阈值：预设三档。
    var msWrap = add(formHost, el('label', null, tr('db.slow.threshold', '阈值')));
    var msSel = add(msWrap, el('select', null));
    msSel.setAttribute('aria-label', '慢查询耗时阈值');
    SLOWLOG_MIN_MS.forEach(function (ms) {
      add(msSel, el('option', null, '≥ ' + ms + ' ms')).value = String(ms);
    });
    msSel.value = String(S.slowlogMinMS || 500);
    msSel.addEventListener('change', function () { S.slowlogMinMS = parseInt(msSel.value, 10) || 500; });
    // 条数：预设三档，缺省 20。
    var limitWrap = add(formHost, el('label', null, tr('db.slow.limit', '条数')));
    var limitSel = add(limitWrap, el('select', null));
    limitSel.setAttribute('aria-label', '返回条数（按总耗时倒序）');
    SLOWLOG_LIMITS.forEach(function (n) {
      add(limitSel, el('option', null, String(n) + ' 条')).value = String(n);
    });
    limitSel.value = String(S.slowlogLimit || 20);
    limitSel.addEventListener('change', function () { S.slowlogLimit = parseInt(limitSel.value, 10) || 20; });
    var run = add(formHost, el('button', 'btn btn-primary', tr('db.action.analyze', '分析')));
    run.type = 'button';
    run.disabled = !!S.slowlogBusy || !S.selected;
    on(run, runSlowlog);

    if (S.slowlogError) {
      add(resultHost, el('p', 'db-slow-hint', slowlogHintFor(S.slowlogError)));
      add(resultHost, el('p', 'db-slow-raw', tr('db.slow.rawInfo', '原始信息：') + stripErrCode(S.slowlogError)));
      return;
    }
    if (S.slowlogBusy) { add(resultHost, el('p', 'muted', tr('db.slow.running', '正在分析慢查询…'))); return; }
    if (!S.slowlogLoaded) {
      add(resultHost, el('p', 'muted',
        '选好库与阈值后点「分析」；阈值越低、条数越多，聚合查询本身越慢（只读，不改服务端）。'));
      return;
    }
    var data = S.slowlog || {};
    // 后端已按总耗时倒序，这里再排一次，保证表格顺序不依赖后端实现。
    var queries = (data.queries || []).slice().sort(function (a, b) {
      return (Number(b.total_ms) || 0) - (Number(a.total_ms) || 0);
    });
    if (S.slowlogMetaHost) {
      S.slowlogMetaHost.textContent = fmtInt(data.count != null ? data.count : queries.length) + ' 条' +
        ' · ' + (data.schema ? '库 ' + data.schema : '全部库') +
        ' · 阈值 ≥ ' + fmtInt(data.min_ms || 0) + ' ms';
    }
    if (data.hint) add(resultHost, el('p', 'db-pg-note', String(data.hint)));
    if (!queries.length) {
      add(resultHost, el('p', 'muted', '当前阈值下没有聚合慢查询：把阈值调到 100 ms 或选「全部库」再看。'));
      return;
    }
    var table = add(resultHost, el('table', 'db-slow-table'));
    var headRow = add(add(table, el('thead')), el('tr'));
    [tr('db.slow.col.summary', 'SQL 摘要'), tr('db.slow.col.executions', '执行次数'), tr('db.slow.col.total', '总耗时'), tr('db.slow.col.avg', '平均'), tr('db.slow.col.max', '最大'), tr('db.slow.col.rowsExamined', '扫描行数')].forEach(function (title, index) {
      add(headRow, el('th', index > 0 ? 'num' : null, title));
    });
    var tbody = add(table, el('tbody'));
    queries.forEach(function (q) {
      var row = add(tbody, el('tr'));
      var cell = add(row, el('td'));
      var full = String(q.sql_text || q.digest || '').trim();
      var sql = add(cell, el('span', 'db-slow-sql', full.length > 120 ? full.slice(0, 120) + '…' : full));
      sql.title = full + (q.digest ? '\n\ndigest: ' + q.digest : '');
      if (q.schema) sql.title += '\n库: ' + q.schema;
      add(row, el('td', 'num', fmtInt(q.executions)));
      add(row, el('td', 'num', fmtMS(q.total_ms)));
      add(row, el('td', 'num', fmtMS(q.avg_ms)));
      add(row, el('td', 'num', fmtMS(q.max_ms)));
      add(row, el('td', 'num', typeof q.rows_examined_avg === 'number'
        ? fmtInt(Math.round(q.rows_examined_avg)) : '—'));
    });
    if (data.warnings && data.warnings.length) {
      add(resultHost, el('p', 'db-slow-raw', '有 ' + data.warnings.length + ' 行无法解析，已跳过（不影响其余结果）'));
    }
  }
  // runSlowlog 调 db-mysql.slowlog：参数固定为 instance/schema/min_ms/limit。
  function runSlowlog() {
    if (!S.selected || S.slowlogBusy || isPg()) return;
    var instance = S.selected;
    S.slowlogBusy = true; S.slowlogError = ''; S.slowlog = null; S.slowlogLoaded = false;
    paintSlowlog();
    var params = { instance: instance, min_ms: S.slowlogMinMS, limit: S.slowlogLimit };
    if (S.slowlogSchema) params.schema = S.slowlogSchema;
    invoke('db-mysql.slowlog', params).then(function (data) {
      if (S.destroyed || S.selected !== instance) return;
      S.slowlogBusy = false; S.slowlog = data; S.slowlogLoaded = true;
      paintSlowlog();
    }, function (err) {
      if (S.destroyed || S.selected !== instance) return;
      S.slowlogBusy = false; S.slowlogError = (err && err.message) || String(err);
      paintSlowlog();
    });
  }

  function paintDetail() {
    var host = S.detailHost;
    host.textContent = '';
    S.l2UsersHandle = null; S.l2NoticeHost = null;
    S.slowlogFormHost = null; S.slowlogMetaHost = null; S.slowlogHost = null;
    var inst = currentInstance();
    if (!inst) return;
    var statusPanel = add(host, el('section', 'panel'));
    var statusHead = add(statusPanel, el('div', 'panel-head'));
    add(statusHead, el('span', 'panel-title', tr('db.detail.title', '数据库连接详情')));
    add(statusHead, el('span', 'panel-meta', inst.name === 'default' ? tr('db.label.default', '默认连接') : inst.name));
    S.statusHost = add(statusPanel, el('div', 'db-status'));
    paintStatus();
    var layout = add(host, el('div', 'db-layout'));
    var dbPanel = add(layout, el('section', 'panel db-db-panel'));
    var dbHead = add(dbPanel, el('div', 'panel-head'));
    add(dbHead, el('span', 'panel-title', tr('db.panel.databases', '数据库')));
    S.dbCount = add(dbHead, el('span', 'panel-meta', ''));
    // 工具栏单独成行：库面板在桌面端只有 260px，塞进 panel-head 会把标题挤成竖排。
    var headOps = add(dbPanel, el('div', 'db-toolbar'));
    // 新建数据库两域都可用（db-l2.js 的 createDatabase 已按域拼方法名）；导入是 db-mysql 专属。
    headOps.appendChild(l2Btn(tr('db.action.createDb', '新建数据库'), function () {
      withL2(function (mod, ctx) { mod.openCreateDb(ctx); });
    }));
    if (!isPg()) {
      headOps.appendChild(l2Btn(tr('db.action.import', '导入'), function () {
        withL2(function (mod, ctx) { mod.openImport(ctx); });
      }));
    }
    // 系统库默认被插件过滤；需要核对系统库（并确认它们没有删除入口）时显式纳入。
    var sysToggle = add(headOps, el('label', 'field field-check db-sys-toggle'));
    var sysBox = add(sysToggle, el('input', null));
    sysBox.type = 'checkbox'; sysBox.checked = !!S.includeSystem;
    add(sysToggle, el('span', null, '显示系统库'));
    sysToggle.title = isPg()
      ? '勾选后包含 template0 / template1（postgres 维护库始终显示）'
      : '系统库（mysql / information_schema / performance_schema / sys）只读展示，不提供删除入口';
    if (isPg()) {
      add(dbPanel, el('p', 'db-pg-note',
        '写操作已开放（建库 / 用户与授权）；SQL 控制台仍只读，导入导出为 MySQL 专属。'));
    }
    sysToggle.addEventListener('change', function () {
      S.includeSystem = sysBox.checked;
      loadDbs();
    });
    S.l2NoticeHost = add(dbPanel, el('div', 'db-l2-notice-host'));
    S.dbHost = add(dbPanel, el('div', 'db-list'));
    paintDbs();
    var sqlPanel = add(layout, el('section', 'panel db-sql-panel'));
    var sqlHead = add(sqlPanel, el('div', 'panel-head'));
    add(sqlHead, el('span', 'panel-title', tr('db.sql.title', 'SQL 控制台'))); add(sqlHead, el('span', 'panel-meta', tr('db.sql.shortcut', 'Ctrl+Enter 执行')));
    add(sqlPanel, el('p', 'db-readonly', isPg()
      ? '仅支持 SELECT / SHOW / EXPLAIN / WITH（只读；查询在连接默认库执行）'
      : '仅支持 SELECT / SHOW / DESCRIBE / EXPLAIN'));
    S.sql = add(sqlPanel, el('textarea', 'db-sql'));
    S.sql.rows = 5; S.sql.spellcheck = false;
    S.sql.placeholder = isPg() ? 'SELECT version()' : 'SELECT * FROM kore_ui.demo LIMIT 20';
    S.sql.setAttribute('aria-label', isPg()
      ? 'SQL 输入（仅支持 SELECT / SHOW / EXPLAIN / WITH）'
      : 'SQL 输入（仅支持 SELECT / SHOW / DESCRIBE / EXPLAIN）');
    S.sql.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); runQuery(); }
    });
    var ops = add(sqlPanel, el('div', 'db-sql-ops'));
    S.run = add(ops, el('button', 'btn btn-primary', tr('db.action.run', '执行')));
    S.run.type = 'button';
    on(S.run, runQuery);
    S.runState = add(ops, el('span', 'muted db-run-state', ''));
    S.queryNoticeHost = add(sqlPanel, el('div', 'db-query-notice'));
    S.resultHost = add(sqlPanel, el('div', 'db-result'));
    paintQueryNotice(); paintRunState(); paintResult();
    // 慢查询分析放在折叠区：不展开就不发查询；PG 无 db-mysql.slowlog，不渲染。
    if (!isPg()) {
      var slow = add(host, el('details', 'panel db-l2-panel'));
      slow.open = !!S.slowlogOpen;
      var slowSum = add(slow, el('summary', 'db-l2-summary'));
      add(slowSum, el('span', 'panel-title', tr('db.slow.title', '慢查询分析')));
      S.slowlogMetaHost = add(slowSum, el('span', 'panel-meta', tr('db.slow.sortedBy', '按总耗时排序')));
      add(slow, el('p', 'db-pg-note',
        '基于 performance_schema 的 digest 聚合（只读）：需要 performance_schema=ON 且当前账号有读取权限；' +
        '不读 slow_query_log 文件。'));
      var slowBody = add(slow, el('div', 'db-l2-users'));
      S.slowlogFormHost = add(slowBody, el('div', 'db-slow-form'));
      S.slowlogHost = add(slowBody, el('div', 'db-slow-result'));
      slow.addEventListener('toggle', function () {
        S.slowlogOpen = slow.open;
        if (slow.open) paintSlowlog();
      });
      paintSlowlog();
    }
    // 用户管理放在折叠区：账号列表要额外查账号表，不展开就不发这次查询。
    // MySQL 查 mysql.user，PG 查 pg_roles；建用户 / 授权 / 改密 / 删除两域都已接好。
    var users = add(host, el('details', 'panel db-l2-panel'));
    var sum = add(users, el('summary', 'db-l2-summary'));
    add(sum, el('span', 'panel-title', tr('db.panel.users', '用户与授权')));
    add(sum, el('span', 'panel-meta', tr('db.panel.usersMeta', '创建账号 · 授权 · 删除')));
    S.l2UsersHost = add(users, el('div', 'db-l2-users'));
    users.addEventListener('toggle', function () {
      if (!users.open || !S.l2UsersHost) return;
      withL2(function (mod, ctx) {
        if (S.l2UsersHandle) S.l2UsersHandle.destroy();
        S.l2UsersHandle = mod.mountUsers(ctx, S.l2UsersHost);
      });
    });
  }
  function selectInstance(name) {
    if (!name || S.selected === name) return;
    S.selected = name; S.status = null; S.dbs = []; S.result = null; S.selectedDb = '';
    S.statusError = ''; S.dbError = ''; S.queryError = ''; S.dbLoaded = false; S.busy = false;
    S.slowlog = null; S.slowlogError = ''; S.slowlogBusy = false; S.slowlogLoaded = false;
    S.slowlogSchema = '';
    paintInstances();
    paintDetail();
    loadStatus();
    loadDbs();
  }
  function useDb(name) {
    if (!S.sql) return;
    S.selectedDb = name;
    if (isPg()) {
      // PG 插件在连接默认库上执行只读查询，没有跨库 USE；这里给可直接执行的库信息查询。
      S.sql.value = "SELECT datname AS database, pg_size_pretty(pg_database_size(datname)) AS size " +
        "FROM pg_database WHERE datname = '" + String(name).replace(/'/g, "''") + "'";
    } else {
      S.sql.value = 'SHOW TABLES FROM `' + String(name).replace(/`/g, '``') + '`';
    }
    S.sql.focus();
    runQuery();
  }
  function runQuery() {
    if (!S.selected || S.busy || !S.sql) return;
    var sql = S.sql.value.trim();
    if (!sql) { S.queryError = tr('db.query.emptyInput', '请输入 SQL 后再执行'); paintQueryNotice(); return; }
    var instance = S.selected;
    S.busy = true; S.queryError = ''; S.result = null;
    paintQueryNotice(); paintRunState(); paintResult();
    invoke(methodFor('query'), { instance: instance, sql: sql }).then(function (data) {
      if (S.destroyed || S.selected !== instance) return;
      S.busy = false; S.result = data;
      paintRunState(); paintResult();
    }, function (err) {
      if (S.destroyed || S.selected !== instance) return;
      S.busy = false; S.queryError = err.message;
      paintRunState(); paintQueryNotice(); paintResult();
    });
  }
  function loadStatus() {
    var name = S.selected;
    if (!name) return;
    invoke(methodFor('status'), { instance: name }).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      S.status = data; paintStatus();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.statusError = err.message; paintStatus();
    });
  }
  function loadDbs() {
    var name = S.selected;
    if (!name) return;
    S.dbLoaded = false; paintDbs();
    var params = { instance: name };
    if (S.includeSystem) params.include_system = true;
    invoke(methodFor('databases'), params).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      // MySQL 返回库名字符串数组，PostgreSQL 返回 [{name,size_bytes}]；这里统一成名字。
      S.dbs = (data.databases || []).map(function (db) {
        return typeof db === 'string' ? db : (db && db.name) || '';
      }).filter(function (dbName) { return dbName; });
      S.dbLoaded = true; paintDbs();
      if (S.slowlogFormHost) paintSlowlog();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.dbError = err.message; S.dbLoaded = true; paintDbs();
      if (S.slowlogFormHost) paintSlowlog();
    });
  }
  function loadInstances(reset) {
    if (reset) { S.selected = ''; S.status = null; S.dbs = []; S.dbLoaded = false; S.result = null; }
    S.loadError = '';
    paintInstances();
    invoke(methodFor('instances'), {}).then(function (data) {
      if (S.destroyed) return;
      S.instances = data.instances || [];
      S.instHint = data.hint || '';
      if (S.autoPending) {
        S.autoPending = false;
        var first = S.instances.length ? S.instances[0] : null;
        for (var i = 0; i < S.instances.length; i++) {
          if (S.instances[i].reachable) { first = S.instances[i]; break; }
        }
        if (first && first.reachable) {
          S.autoNotice = { tone: 'ok', text: '已连接「' + (first.name === 'default' ? '默认连接' : first.name) + '」' +
            (first.version ? ' · ' + first.version : '') + '（' + first.host + ':' + first.port + '）' };
        } else if (first) {
          S.autoNotice = { tone: 'warn', text: '保存成功，但连接失败：' + (first.error || '原因未知') +
            '。怎么办：' + errHint(first.error) };
        } else {
          S.autoNotice = { tone: 'warn', text: '保存成功，但没有可用的连接；请检查设置后重试。' };
        }
        autoBanner();
      }
      paintInstances();
      // 实例结果可能晚于 discover 到达：重绘横幅，让"已连通的服务端版本"按优先级立刻接管。
      autoBanner();
      if (!S.selected && S.instances.length) {
        // 默认选第一个可达实例，省一次点击；不可达实例仍可手动点开核对完整错误。
        var first = S.instances[0];
        for (var j = 0; j < S.instances.length; j++) {
          if (S.instances[j].reachable) { first = S.instances[j]; break; }
        }
        selectInstance(first.name);
      }
    }, function (err) {
      if (S.destroyed) return;
      S.loadError = err.message; paintInstances();
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
    var opts = { title: isPg() ? 'PostgreSQL 连接' : '数据库连接', focusKey: 'password' };
    if (!isPg() && fromDiscovery && svc && svc.running) {
      opts.prefill = { host: '127.0.0.1', port: svcPort(svc), user: 'root' };
      opts.autoKeys = { host: true, port: true, user: true };
      opts.autoNote = '已从本机检测结果自动填入主机、端口、用户名（标“已自动填入”），只需填写密码。';
    }
    opts.onSaved = function () {
      S.autoPending = true; S.autoNotice = null;
      loadInstances(true);
    };
    var pluginId = isPg() ? 'db-postgres' : 'db-mysql';
    if (window.KoreShell && typeof window.KoreShell.openConfig === 'function') {
      window.KoreShell.openConfig(S.root, pluginId, opts);
    } else if (window.KoreConfig && typeof window.KoreConfig.open === 'function') {
      window.KoreConfig.open(S.root, pluginId, opts);
    } else {
      S.instBody.insertBefore(notice(tr('db.settings.unavailable', '配置面板不可用，请刷新页面重试')), S.instBody.firstChild);
    }
  }
  // 切换实例类型：整页重绘，避免 MySQL 的 discover/L2 状态残留到 PostgreSQL 页。
  function switchType(type) {
    if (S.dbType === type || !S.container) return;
    saveTypePref(type);
    render(S.container);
  }
  function render(container) {
    if (!container) return null;
    S = fresh();
    S.dbType = loadTypePref();
    S.container = container;
    container.textContent = '';
    ensureL2Style();
    var root = add(container, el('section', 'db'));
    S.root = root;
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', tr('db.title', '数据库')));
    add(head, el('p', 'view-sub', 'MySQL / MariaDB 与 PostgreSQL 连接、库列表与只读 SQL 控制台；' +
      'MySQL 本机服务可自动检测并一键连接，PostgreSQL 走插件配置（空态会给下一步引导）。'));
    S.bannerHost = add(root, el('div', 'db-banner-host'));
    var instPanel = add(root, el('section', 'panel')), instHead = add(instPanel, el('div', 'panel-head'));
    add(instHead, el('span', 'panel-title', dbTitle() + ' 连接'));
    S.instCount = add(instHead, el('span', 'panel-meta', ''));
    var gear = add(instHead, el('button', 'btn btn-ghost', tr('db.action.settings', '设置')));
    gear.type = 'button'; on(gear, function () { openSettings(false); });
    // 实例类型切换放在独立一行：手机上标题/计数/设置已经占满 panel-head。
    var typeRow = add(instPanel, el('div', 'db-type-row'));
    var typeSwitch = add(typeRow, el('div', 'db-type-switch'));
    typeSwitch.setAttribute('role', 'group'); typeSwitch.setAttribute('aria-label', tr('db.label.connectionType', '连接类型'));
    [['mysql', 'MySQL'], ['postgres', 'PostgreSQL']].forEach(function (item) {
      var typeBtn = add(typeSwitch, el('button', 'btn btn-ghost', item[1]));
      typeBtn.type = 'button';
      typeBtn.setAttribute('aria-pressed', S.dbType === item[0] ? 'true' : 'false');
      on(typeBtn, function () { switchType(item[0]); });
    });
    S.instBody = add(instPanel, el('div', 'db-instance-body')); S.detailHost = add(root, el('div', 'db-detail'));
    autoBanner();
    if (!isPg()) detect();
    loadInstances(false);
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreDb = { render: render };
})();
