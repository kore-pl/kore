/* kore 主壳 · 数据库管理（web/db.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>，本例 /api/v1/invoke/db-mysql/db-mysql.instances。
   window.KoreDb.render(container) 调 db-mysql 的 db-mysql.instances / .databases / .query / .status；
   插件 businessVerb 只剥 "db-mysql." 前缀，裸动词（如 instances）会 E_NOTFOUND「未知方法」——
   方法段必须写完整限定名，不得退化为裸动词。
   写操作由插件只读白名单拒绝，本页原样展示 E_INVALID 全文，不在浏览器重做 SQL 解析。
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
      autoNotice: null, autoPending: false };
  }
  var S = fresh();
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
  function invoke(method, params) { return invokeAt(API, method, params); }
  function fmtInt(n) { return typeof n === 'number' && isFinite(n) ? n.toLocaleString('zh-CN') : '—'; }
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
  function currentInstance() {
    for (var i = 0; i < S.instances.length; i++) {
      if (S.instances[i].name === S.selected) return S.instances[i];
    }
    return null;
  }
  function dbLabel(svc) { return svc && svc.id === 'mariadb' ? 'MariaDB' : 'MySQL'; }
  function shortVersion(version) { return String(version || '').split(/[-~+]/)[0]; }
  function svcPort(svc) { return svc && svc.port ? svc.port : 3306; }
  function pickService(list) {
    var candidates = (list || []).filter(function (s) {
      return s && (s.id === 'mariadb' || s.id === 'mysql');
    });
    if (!candidates.length) return null;
    var running = candidates.filter(function (s) { return s.running; });
    var pool = running.length ? running : candidates;
    for (var i = 0; i < pool.length; i++) if (pool[i].id === 'mariadb') return pool[i];
    return pool[0];
  }
  // hintFor 把后端 error 原文翻译成「怎么办」；没有命中时给通用排查顺序。
  function hintFor(text) {
    var msg = String(text || '');
    if (/Access denied|1045|28000/i.test(msg)) {
      return '请确认用户名和密码。密码忘记可在服务器上重置：ALTER USER \'root\'@\'localhost\' IDENTIFIED BY \'<新密码>\'；' +
        '若只允许本机 socket 登录，请创建可远程登录的账号。';
    }
    if (/2002|2003|refused|Can\'t connect|连接.*失败/i.test(msg)) {
      return '服务没有在目标端口监听：确认数据库已启动（systemctl status mariadb 或 mysqld），或把端口改成实际监听端口。';
    }
    if (/Unknown MySQL server host|no such host|Name or service not known/i.test(msg)) {
      return '主机名无法解析：本机数据库请填 127.0.0.1，远程数据库请填可解析的 IP 或域名。';
    }
    if (/password env|密码环境变量/i.test(msg)) {
      return '密码环境变量未设置：直接在设置里填写“密码”，或启动内核前导出该环境变量。';
    }
    return '检查地址、端口、用户名和密码；确认数据库已启动并允许该账号从本机登录，然后重试。';
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

    if (S.discoveryState === 'loading') {
      badge('自动检测');
      title('正在检测本机 MySQL/MariaDB…');
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
      title('未检测到本机 MySQL/MariaDB');
      text('安装服务后刷新本页会自动识别。Debian/Ubuntu：sudo apt install mariadb-server；' +
        'RHEL：sudo dnf install mariadb-server。已有远程数据库可直接手动配置。');
      act('btn-ghost', '重新检测', detect);
      act('btn-primary', '手动配置', function () { openSettings(false); });
      return;
    }
    if (!svc.running) {
      box.classList.add('is-none');
      badge('自动检测');
      title('检测到本机 ' + dbLabel(svc) + (svc.version ? ' ' + shortVersion(svc.version) : '') +
        '，但服务未运行');
      text('启动服务后再点“重新检测”：systemctl start ' + (svc.id === 'mariadb' ? 'mariadb' : 'mysql') +
        '（不同发行版也可能是 mysqld）。');
      act('btn-ghost', '重新检测', detect);
      act('btn-primary', '手动配置', function () { openSettings(false); });
      return;
    }
    var label = dbLabel(svc), version = shortVersion(svc.version);
    badge('自动检测');
    title('检测到本机 ' + label + (version ? ' ' + version : '') + '（127.0.0.1:' + svcPort(svc) + '）');
    text(S.autoNotice && S.autoNotice.tone === 'ok'
      ? '已自动填入主机、端口、用户名并连接成功；可在右上角「设置」里修改连接信息。'
      : '已自动填入主机、端口、用户名；点“一键连接”后只需填写密码。');
    if (S.autoNotice) {
      add(main, el('p', 'db-auto-result ' + (S.autoNotice.tone || 'ok'), S.autoNotice.text));
    }
    act('btn-primary', '一键连接', function () { openSettings(true); });
    act('btn-ghost', '重新检测', detect);
  }
  function paintInstances() {
    if (!S.instBody) return;
    S.instBody.textContent = '';
    S.instCount.textContent = S.instances.length ? S.instances.length + ' 个实例' : '';
    if (S.loadError) {
      var fail = add(S.instBody, el('div', 'empty-state db-empty'));
      add(fail, el('p', 'empty-state-title', '读取实例失败'));
      add(fail, el('p', 'empty-state-text', S.loadError));
      add(fail, el('p', 'empty-state-text', '怎么办：' + hintFor(S.loadError)));
      var retry = add(fail, el('button', 'btn btn-primary', '重新读取'));
      retry.type = 'button'; on(retry, function () { loadInstances(false); });
      return;
    }
    if (!S.instances.length) {
      var empty = add(S.instBody, el('div', 'empty-state db-empty'));
      add(empty, el('p', 'empty-state-title', '还没有数据库连接'));
      var svc = S.discovery;
      var why;
      if (S.discoveryState === 'loading') {
        why = '正在检测本机数据库…检测完成后这里会出现一键连接入口。';
      } else if (svc && svc.running) {
        why = '已检测到本机 ' + dbLabel(svc) + '。点上方“一键连接”，只需填写密码即可。';
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
      add(adv, el('summary', null, '已有环境变量配置？'));
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
      add(top, el('span', 'db-inst-name', inst.name === 'default' ? '默认连接' : inst.name));
      top.appendChild(chip(inst.reachable ? 'ok' : 'fail', inst.reachable ? '可达' : '不可达'));
      add(card, el('div', 'db-inst-meta', (inst.host || '—') + ':' + (inst.port || 3306)));
      if (inst.reachable) {
        add(card, el('div', 'db-inst-version', inst.version || '版本未知'));
      } else {
        add(card, el('div', 'db-inst-error', '连接失败：' + (inst.error || '原因未知'))).title = inst.error || '';
        add(card, el('div', 'db-inst-hint', '怎么办：' + hintFor(inst.error)));
      }
      on(card, function () { selectInstance(inst.name); });
    });
  }
  function paintStatus() {
    if (!S.statusHost) return;
    S.statusHost.textContent = '';
    if (S.statusError) { S.statusHost.appendChild(notice('状态读取失败：' + S.statusError)); return; }
    if (!S.status) { add(S.statusHost, el('div', 'db-status-loading muted', '正在读取实例状态…')); return; }
    var d = S.status, grid = add(S.statusHost, el('div', 'db-stats'));
    [['连接线程', fmtInt(d.threads_connected)], ['运行时长', fmtUptime(d.uptime_s)], ['查询总数', fmtInt(d.queries)],
      ['慢查询', fmtInt(d.slow_queries)], ['最大连接', fmtInt(d.max_connections)], ['版本', d.version || '—']].forEach(function (item) {
      var cell = add(grid, el('div', 'db-stat'));
      add(cell, el('span', 'db-stat-label', item[0]));
      add(cell, el('span', 'db-stat-value', item[1]));
      if (item[0] === '运行时长' && typeof d.uptime_s === 'number') cell.title = d.uptime_s + ' 秒';
    });
  }
  function paintDbs() {
    if (!S.dbHost) return;
    S.dbHost.textContent = '';
    S.dbCount.textContent = S.dbs.length ? S.dbs.length + ' 个库' : '';
    if (S.dbError) { S.dbHost.appendChild(notice('库列表读取失败：' + S.dbError)); return; }
    if (!S.dbLoaded) { add(S.dbHost, el('div', 'db-list-hint muted', '正在读取数据库…')); return; }
    if (!S.dbs.length) { add(S.dbHost, el('div', 'db-list-hint muted', '没有可展示的数据库（系统库已过滤）')); return; }
    S.dbs.forEach(function (name) {
      var row = add(S.dbHost, el('button', 'db-db'));
      row.type = 'button';
      add(row, el('span', 'db-db-name', name));
      add(row, el('span', 'db-db-op', 'SHOW TABLES'));
      on(row, function () { useDb(name); });
    });
  }
  function paintQueryNotice() {
    if (!S.queryNoticeHost) return; S.queryNoticeHost.textContent = '';
    if (S.queryError) S.queryNoticeHost.appendChild(notice(S.queryError));
  }
  function paintRunState() {
    if (!S.run) return; S.run.disabled = S.busy;
    S.runState.textContent = S.busy ? '执行中…' : '';
  }
  function paintResult() {
    if (!S.resultHost) return;
    var host = S.resultHost;
    host.textContent = '';
    if (!S.result) {
      add(host, el('div', 'db-result-empty muted', S.queryError ? '查询未返回结果' : '执行 SQL 后在此查看结果'));
      return;
    }
    var r = S.result, rows = r.rows || [], cols = r.columns || [];
    var meta = add(host, el('div', 'db-result-meta'));
    add(meta, el('span', null, fmtInt(r.row_count != null ? r.row_count : rows.length) + ' 行'));
    if (r.truncated) add(meta, el('span', 'db-truncated', '已截断，仅显示前 ' + rows.length + ' 行'));
    if (!cols.length) { add(host, el('div', 'db-result-empty muted', '查询未返回列')); return; }
    var scroll = add(host, el('div', 'db-result-scroll'));
    var table = add(scroll, el('table', 'db-result-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    cols.forEach(function (c) { add(htr, el('th', null, c)); });
    var tbody = add(table, el('tbody'));
    if (!rows.length) {
      var td = add(add(tbody, el('tr')), el('td', 'db-result-empty muted', '（0 行）'));
      td.colSpan = cols.length;
      return;
    }
    rows.forEach(function (row) {
      var tr = add(tbody, el('tr'));
      cols.forEach(function (c) {
        var value = row ? row[c] : null, cell = add(tr, el('td'));
        if (value === null || value === undefined) { cell.textContent = 'NULL'; cell.className = 'db-null'; }
        else cell.textContent = String(value);
      });
    });
  }
  function paintDetail() {
    var host = S.detailHost;
    host.textContent = '';
    var inst = currentInstance();
    if (!inst) return;
    var statusPanel = add(host, el('section', 'panel'));
    var statusHead = add(statusPanel, el('div', 'panel-head'));
    add(statusHead, el('span', 'panel-title', '实例详情'));
    add(statusHead, el('span', 'panel-meta', inst.name === 'default' ? '默认连接' : inst.name));
    S.statusHost = add(statusPanel, el('div', 'db-status'));
    paintStatus();
    var layout = add(host, el('div', 'db-layout'));
    var dbPanel = add(layout, el('section', 'panel db-db-panel'));
    var dbHead = add(dbPanel, el('div', 'panel-head'));
    add(dbHead, el('span', 'panel-title', '数据库'));
    S.dbCount = add(dbHead, el('span', 'panel-meta', ''));
    S.dbHost = add(dbPanel, el('div', 'db-list'));
    paintDbs();
    var sqlPanel = add(layout, el('section', 'panel db-sql-panel'));
    var sqlHead = add(sqlPanel, el('div', 'panel-head'));
    add(sqlHead, el('span', 'panel-title', 'SQL 控制台')); add(sqlHead, el('span', 'panel-meta', 'Ctrl+Enter 执行'));
    add(sqlPanel, el('p', 'db-readonly', '仅支持 SELECT / SHOW / DESCRIBE / EXPLAIN'));
    S.sql = add(sqlPanel, el('textarea', 'db-sql'));
    S.sql.rows = 5; S.sql.spellcheck = false;
    S.sql.placeholder = 'SELECT * FROM kore_ui.demo LIMIT 20';
    S.sql.setAttribute('aria-label', 'SQL 输入（仅支持 SELECT / SHOW / DESCRIBE / EXPLAIN）');
    S.sql.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); runQuery(); }
    });
    var ops = add(sqlPanel, el('div', 'db-sql-ops'));
    S.run = add(ops, el('button', 'btn btn-primary', '执行'));
    S.run.type = 'button';
    on(S.run, runQuery);
    S.runState = add(ops, el('span', 'muted db-run-state', ''));
    S.queryNoticeHost = add(sqlPanel, el('div', 'db-query-notice'));
    S.resultHost = add(sqlPanel, el('div', 'db-result'));
    paintQueryNotice(); paintRunState(); paintResult();
  }
  function selectInstance(name) {
    if (!name || S.selected === name) return;
    S.selected = name; S.status = null; S.dbs = []; S.result = null;
    S.statusError = ''; S.dbError = ''; S.queryError = ''; S.dbLoaded = false; S.busy = false;
    paintInstances();
    paintDetail();
    loadStatus();
    loadDbs();
  }
  function useDb(name) {
    if (!S.sql) return;
    S.sql.value = 'SHOW TABLES FROM `' + String(name).replace(/`/g, '``') + '`';
    S.sql.focus();
    runQuery();
  }
  function runQuery() {
    if (!S.selected || S.busy || !S.sql) return;
    var sql = S.sql.value.trim();
    if (!sql) { S.queryError = '请输入 SQL 后再执行'; paintQueryNotice(); return; }
    var instance = S.selected;
    S.busy = true; S.queryError = ''; S.result = null;
    paintQueryNotice(); paintRunState(); paintResult();
    invoke('db-mysql.query', { instance: instance, sql: sql }).then(function (data) {
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
    invoke('db-mysql.status', { instance: name }).then(function (data) {
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
    invoke('db-mysql.databases', { instance: name }).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      S.dbs = data.databases || []; S.dbLoaded = true; paintDbs();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.dbError = err.message; S.dbLoaded = true; paintDbs();
    });
  }
  function loadInstances(reset) {
    if (reset) { S.selected = ''; S.status = null; S.dbs = []; S.dbLoaded = false; S.result = null; }
    S.loadError = '';
    paintInstances();
    invoke('db-mysql.instances', {}).then(function (data) {
      if (S.destroyed) return;
      S.instances = data.instances || [];
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
            '。怎么办：' + hintFor(first.error) };
        } else {
          S.autoNotice = { tone: 'warn', text: '保存成功，但没有可用的连接；请检查设置后重试。' };
        }
        autoBanner();
      }
      paintInstances();
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
    var opts = { title: '数据库连接', focusKey: 'password' };
    if (fromDiscovery && svc && svc.running) {
      opts.prefill = { host: '127.0.0.1', port: svcPort(svc), user: 'root' };
      opts.autoKeys = { host: true, port: true, user: true };
      opts.autoNote = '已从本机检测结果自动填入主机、端口、用户名（标“已自动填入”），只需填写密码。';
    }
    opts.onSaved = function () {
      S.autoPending = true; S.autoNotice = null;
      loadInstances(true);
    };
    if (window.KoreShell && typeof window.KoreShell.openConfig === 'function') {
      window.KoreShell.openConfig(S.root, 'db-mysql', opts);
    } else if (window.KoreConfig && typeof window.KoreConfig.open === 'function') {
      window.KoreConfig.open(S.root, 'db-mysql', opts);
    } else {
      S.instBody.insertBefore(notice('配置面板不可用，请刷新页面重试'), S.instBody.firstChild);
    }
  }
  function render(container) {
    if (!container) return null;
    S = fresh();
    container.textContent = '';
    var root = add(container, el('section', 'db'));
    S.root = root;
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '数据库'));
    add(head, el('p', 'view-sub', 'MySQL / MariaDB 实例、库列表与只读 SQL 控制台；本机服务可自动检测并一键连接。'));
    S.bannerHost = add(root, el('div', 'db-banner-host'));
    var instPanel = add(root, el('section', 'panel')), instHead = add(instPanel, el('div', 'panel-head'));
    add(instHead, el('span', 'panel-title', 'MySQL 实例'));
    S.instCount = add(instHead, el('span', 'panel-meta', ''));
    var gear = add(instHead, el('button', 'btn btn-ghost', '设置'));
    gear.type = 'button'; on(gear, function () { openSettings(false); });
    S.instBody = add(instPanel, el('div', 'db-instance-body')); S.detailHost = add(root, el('div', 'db-detail'));
    autoBanner();
    detect();
    loadInstances(false);
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreDb = { render: render };
})();
