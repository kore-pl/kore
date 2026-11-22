/* kore 主壳 · 数据库管理（web/db.js）——零框架 / 零 CDN / 无外链。
   window.KoreDb.render(container) 调 db-mysql 的 instances / databases / query / status；
   写操作由插件只读白名单拒绝，本页原样展示 E_INVALID 全文，不在浏览器重做 SQL 解析。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/db-mysql/';
  function fresh() {
    return { instances: [], selected: '', status: null, dbs: [], result: null, loadError: '',
      statusError: '', dbError: '', dbLoaded: false, queryError: '', busy: false, destroyed: false };
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
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(API + method, {
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
  function paintInstances() {
    if (!S.instBody) return;
    S.instBody.textContent = '';
    S.instCount.textContent = S.instances.length ? S.instances.length + ' 个实例' : '';
    if (S.loadError) { S.instBody.appendChild(notice('读取实例失败：' + S.loadError)); return; }
    if (!S.instances.length) {
      var empty = add(S.instBody, el('div', 'empty-state db-empty'));
      add(empty, el('p', 'empty-state-title', '未配置 MySQL 实例'));
      add(empty, el('p', 'empty-state-text',
        '内核从环境变量 KORE_MYSQL_INSTANCES 读取实例 JSON 数组，每项含 name / host / port / user / password_env；' +
        '密码只写环境变量名，启动内核时注入该变量的值。也可用 KORE_MYSQL_CONFIG 指向 JSON 配置文件。修改后需重启内核。'));
      return;
    }
    var grid = add(S.instBody, el('div', 'db-instances'));
    S.instances.forEach(function (inst) {
      var active = inst.name === S.selected;
      var card = add(grid, el('button', 'db-instance' + (active ? ' is-active' : '')));
      card.type = 'button';
      card.setAttribute('aria-pressed', active ? 'true' : 'false');
      var top = add(card, el('div', 'db-inst-head'));
      add(top, el('span', 'db-inst-name', inst.name));
      top.appendChild(chip(inst.reachable ? 'ok' : 'fail', inst.reachable ? '可达' : '不可达'));
      add(card, el('div', 'db-inst-meta', (inst.host || '—') + ':' + (inst.port || 3306)));
      if (inst.reachable) add(card, el('div', 'db-inst-version', inst.version || '版本未知'));
      else add(card, el('div', 'db-inst-error', '连接失败：' + (inst.error || '原因未知'))).title = inst.error || '';

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
    add(statusHead, el('span', 'panel-meta', inst.name));
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
    invoke('query', { instance: instance, sql: sql }).then(function (data) {
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
    invoke('status', { instance: name }).then(function (data) {
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
    invoke('databases', { instance: name }).then(function (data) {
      if (S.destroyed || S.selected !== name) return;
      S.dbs = data.databases || []; S.dbLoaded = true; paintDbs();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.dbError = err.message; S.dbLoaded = true; paintDbs();
    });
  }
  function loadInstances() {
    S.loadError = '';
    paintInstances();
    invoke('instances', {}).then(function (data) {
      if (S.destroyed) return;
      S.instances = data.instances || [];
      paintInstances();
      if (!S.selected && S.instances.length) {
        // 默认选第一个可达实例，省一次点击；不可达实例仍可手动点开核对完整错误。
        var first = S.instances[0];
        for (var i = 0; i < S.instances.length; i++) {
          if (S.instances[i].reachable) { first = S.instances[i]; break; }
        }
        selectInstance(first.name);
      }
    }, function (err) {
      if (S.destroyed) return;
      S.loadError = err.message; paintInstances();
    });
  }
  function render(container) {
    if (!container) return null;
    S = fresh();
    container.textContent = '';
    var root = add(container, el('section', 'db'));
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '数据库'));
    add(head, el('p', 'view-sub', 'MySQL / MariaDB 实例、库列表与只读 SQL 控制台。'));
    var instPanel = add(root, el('section', 'panel')), instHead = add(instPanel, el('div', 'panel-head'));
    add(instHead, el('span', 'panel-title', 'MySQL 实例'));
    S.instCount = add(instHead, el('span', 'panel-meta', ''));
    S.instBody = add(instPanel, el('div', 'db-instance-body')); S.detailHost = add(root, el('div', 'db-detail'));
    loadInstances();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreDb = { render: render };
})();
