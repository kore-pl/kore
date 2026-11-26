/* kore 主壳 · 全局搜索命令面板（web/search.js，懒加载）
   来源随输入按需加载，逐源降级（失败只在该源上说明，不影响其它源）：
     站点（site/site.list）· 文件（file/file.search）· 数据库（db-mysql|db-postgres 的 instances/databases/query）
     容器（container/container.list）· 进程（process/process.list）· 端口（process/process.ports）
     日志（logs/logs.sources + logs/logs.search）· 页面（本地路由表）· 已装插件 · 商店 · 操作
   智能理解：纯数字优先当端口 / PID；IPv4 查监听地址；域名优先站点；前缀限定
     site: file: db: ctr: proc: port: log: page: plugin: store: act:（大小写不敏感）
   交互：Ctrl/Cmd+K 唤起（再按或 Esc 关闭）· 200ms 防抖 · ↑↓ 选择 · Enter 跳转 ·
     最近搜索（localStorage，最多 6 条）· 空输入给「可以搜什么」引导 + 前缀示例。
   对外只暴露 window.KoreSearch = { open, close }；首屏只由 shell.js 放入口，本文件懒加载不进首屏预算。 */
(function () {
  'use strict';
  var EP = { installed: '/api/v1/plugins', store: '/api/v1/store/plugins', invoke: '/api/v1/invoke/' };
  // 页面源：与 app.js 的 HUB_DEFS 一一对应（route / 名称 / 检索词）。route 用二级键，跳转直达 tab。
  var PAGES = [
    ['dashboard', '概览', '主页 首页 控制台 总览 dashboard home overview'],
    ['sites/sites', '网站', '站点 建站 域名 nginx web sites'],
    ['sites/site-migrate', '站点迁移', '迁移 搬家 站点 site migrate'],
    ['sites/runtimes', '运行环境', 'node php python 运行环境 runtime 版本'],
    ['sites/appdeploy', '应用部署', '部署 应用 app 部署 deploy'],
    ['sites/container', '容器', 'docker 容器 镜像 container'],
    ['sites/batch', '批量操作', '批量 批处理 batch'],
    ['db/db', '数据库', 'mysql mariadb 数据库 库 表 db database'],
    ['db/redis', 'Redis', '缓存 redis cache'],
    ['db/slowquery', '慢查询分析', '慢查询 慢日志 slow query'],
    ['files/files', '文件管理', '文件 上传 下载 目录 files file'],
    ['files/backup', '备份', '备份 恢复 backup'],
    ['files/disk-analysis', '磁盘分析', '磁盘 空间 占用 disk'],
    ['store/store', '应用商店', '商店 市场 store 插件商店'],
    ['store/plugins', '插件管理', '插件 已安装 plugins'],
    ['monitor/monitor', '监控', '性能 资源 cpu 内存 monitor'],
    ['monitor/health', '系统体检', '体检 健康 health'],
    ['monitor/report', '运行报告', '报告 运行 report'],
    ['monitor/topology', '服务拓扑', '拓扑 服务 依赖 topology'],
    ['monitor/logs', '日志', '系统日志 运行日志 logs 日志'],
    ['monitor/process', '进程', '进程 端口 ps process'],
    ['monitor/alert-rules', '告警规则', '告警 规则 alert'],
    ['monitor/fault-drill', '故障演练', '演练 故障 drill'],
    ['monitor/log-alerts', '日志告警', '日志 告警 log alerts'],
    ['tasks/tasks', '计划任务', '任务 cron 定时 tasks'],
    ['tasks/calendar', '运维日历', '日历 排期 calendar'],
    ['tasks/macros', '操作宏', '宏 操作 macro macros'],
    ['security/firewall', '防火墙', 'firewall ufw 端口 安全'],
    ['security/waf', 'WAF', 'waf 防护 拦截'],
    ['security/sshguard', 'SSH 防护', 'ssh 登录 爆破 防护 sshguard'],
    ['security/dns', 'DNS', 'dns 解析 域名解析'],
    ['security/ssl', 'SSL 证书', '证书 https ssl 证书管理'],
    ['security/integrity', '完整性校验', '完整性 校验 篡改 integrity'],
    ['security/discover', '服务发现', '发现 监听 端口 资产 discover'],
    ['security/cert-lifecycle', '证书看板', '证书 续期 到期 lifecycle'],
    ['terminal/terminal', '终端', '命令行 shell terminal'],
    ['settings/settings', '设置', '配置 参数 settings'],
    ['settings/snapshot', '配置快照', '快照 snapshot'],
    ['settings/migrate', '配置迁移', '迁移 migrate'],
    ['settings/webhook', '通知通道', '通知 推送 webhook'],
    ['settings/config-drift', '配置漂移', '漂移 配置 drift']
  ];
  // 插件 id → 用户常用中文别名（插件名未必含「数据」「缓存」，靠它补齐可检索性）。
  var ALIASES = { 'db-mysql': '数据库 数据 mysql mariadb', 'db-postgres': '数据库 数据 postgres',
    redis: '缓存 数据 redis', backup: '备份 恢复', cron: '计划任务 定时 任务', site: '网站 站点 建站',
    firewall: '防火墙 安全', ssl: '证书 https', file: '文件 上传 下载 日志', logs: '日志', monitor: '监控 性能',
    container: '容器 docker 镜像', process: '进程 端口 端口占用', discover: '服务发现 监听 端口' };
  // [名称, 检索词, 落地视图, 跳转前钩子, 跳转后钩子]
  var ACTIONS = [
    ['新建数据库', '数据库 建库 创建 db', 'db/db', null, function () { clickText('.db-toolbar button', '新建数据库'); }],
    ['创建站点', '网站 站点 建站 sites', 'sites/sites', null, function () { focusSel('.site-wizard-host input'); }],
    ['上传文件', '文件 上传 files', 'files/files', null, function () { focusSel('.files-upload, .files-toolbar button'); }],
    ['新建任务', '计划任务 定时 新增 cron', 'tasks/tasks', null, function () { focusSel('.task-form .field-input'); }],
    ['创建备份', '备份 新建 backup', 'files/backup', null, function () { focusSel('.bak-form input'); }],
    ['查看操作审计', '审计 记录 安全 settings', 'settings/settings', function () { window.__koreSettingsTab = 'audit'; }, null],
    ['安装插件', '插件 商店 安装 store', 'store/store', null, null],
    ['扫描监听端口', '端口 监听 扫描 port', 'monitor/process', null, function () { focusSel('.proc-search'); }]
  ];
  // 前缀 → 来源键；大小写不敏感，只认 input 开头的 <word>: 形态。
  var SCOPE_ALIAS = { site: 'site', file: 'file', f: 'file', db: 'db', database: 'db', ctr: 'ctr',
    container: 'ctr', docker: 'ctr', proc: 'proc', ps: 'proc', process: 'proc', port: 'port', net: 'port',
    log: 'log', logs: 'log', page: 'page', p: 'page', plugin: 'plugin', plugins: 'plugin', store: 'store',
    act: 'action', action: 'action' };
  var GROUP_LABEL = {
    site: ['search.group.sites', '站点'], file: ['search.group.files', '文件'], db: ['search.group.db', '数据库'],
    ctr: ['search.group.containers', '容器'], proc: ['search.group.processes', '进程'],
    port: ['search.group.ports', '端口'], log: ['search.group.logs', '日志'],
    page: ['search.group.pages', '页面'], plugin: ['search.group.plugins', '插件'],
    store: ['search.group.store', '商店'], action: ['search.group.acts', '操作']
  };
  // 分组顺序即相关性：数字/IP 把端口与进程提到前面，域名把站点提到最前。
  var ORDER_DEFAULT = ['site', 'file', 'db', 'ctr', 'proc', 'log', 'page', 'plugin', 'store', 'action'];
  var ORDER_NUMBER = ['port', 'proc', 'ctr', 'db', 'site', 'file', 'log', 'page', 'plugin', 'store', 'action'];
  var ORDER_IP = ['port', 'site', 'proc', 'ctr', 'db', 'file', 'log', 'page', 'plugin', 'store', 'action'];
  var ORDER_DOMAIN = ['site', 'file', 'db', 'log', 'page', 'ctr', 'proc', 'plugin', 'store', 'action'];
  // 键必须与下面 src.* 的状态键同名（ports / logs），否则降级文案取到 undefined。
  var SRC_LABEL = { db: '数据库', ctr: '容器', proc: '进程', ports: '端口', logs: '日志' };
  // 库表枚举只走一条只读 SQL（information_schema）；系统库在前端过滤，不拼多语句。
  var TABLE_SQL = "SELECT table_schema AS db, table_name AS tbl FROM information_schema.tables " +
    "WHERE table_type = 'BASE TABLE' LIMIT 500";
  var SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys', 'pg_catalog', 'pg_toast'];
  var RECENT_KEY = 'kore_search_recent';
  // 新文案的英文表（en-US 语言包只覆盖既有 key；本文件懒加载，自带一份避免改共享语言包）。
  var EN = {
    'search.group.db': 'Databases',
    'search.group.containers': 'Containers',
    'search.group.processes': 'Processes',
    'search.group.ports': 'Ports',
    'search.group.logs': 'Logs',
    'search.group.more': 'More',
    'search.hint.scope': 'Scope: {scope}',
    'search.hint.scopeClear': 'Clear',
    'search.hint.number': 'Looking up port / PID {q} first',
    'search.hint.ip': 'Looking up listener on {q}',
    'search.hint.domain': 'Looking up site {q} first',
    'search.scope.prompt': 'Scope: {scope} — type a keyword to search',
    'search.scope.short': 'Type at least 2 characters in this scope',
    'search.guide.title': 'What can I search?',
    'search.guide.tip': 'Without a prefix every source is searched: numbers hit ports and PIDs first, domains hit sites first, IPs hit listeners.',
    'search.guide.site': 'site domain', 'search.guide.file': 'file name / path',
    'search.guide.db': 'database / table', 'search.guide.ctr': 'container / image',
    'search.guide.proc': 'process name / PID', 'search.guide.port': 'port number',
    'search.guide.log': 'log keyword', 'search.guide.page': 'page or feature',
    'search.recent.title': 'Recent searches', 'search.recent.clear': 'Clear all',
    'search.recent.hint': 'Press Enter to search again',
    'search.src.disabled': '{label} source is unavailable (plugin not installed or not enabled)',
    'search.src.fail': '{label} source failed: {msg}',
    'search.src.loading': 'Reading {label}…',
    'search.src.none': 'No {label} records yet',
    'search.item.site': 'Site · {state}',
    'search.item.file': 'File · {path}',
    'search.item.db': 'Database · {instance}',
    'search.item.table': 'Table · {db}',
    'search.item.container': 'Container · {extra}',
    'search.item.process': 'Process · PID {pid}',
    'search.item.port': 'Listening · {protocol} {address}',
    'search.item.portTitle': 'Port {port} · {name}',
    'search.item.portOwner': 'process {name} (PID {pid})',
    'search.item.log': 'Log · {source} line {line}',
    'search.item.page': 'Page · {label}',
    'search.item.plugin': 'Installed plugin · {id}',
    'search.item.store': 'Store plugin · {id}',
    'search.item.action': 'Action · {label}',
    'search.empty.scoped': 'Nothing in this source for "{q}" — try a different keyword or clear the scope.',
    'search.foot.keys': '↑↓ select · Enter open · Esc close',
    'search.note.prefixTitle': 'Prefixes',
    'search.note.dbEmpty': 'No database instance is configured, so this source has nothing to show yet.',
    'search.note.ctrEmpty': 'No containers found (Docker may not be installed on this host).',
    'search.note.procEmpty': 'No matching process.',
    'search.note.logNoSource': 'No readable log source is configured, so this source has nothing to show yet.'
  };
  var S = { open: false, sel: 0, items: [], nodes: [], timer: 0, root: null, input: null, list: null, hint: null, bg: null };
  var data = { installed: null, store: null, error: '', promise: null, sites: null, sitesError: '',
    fileCache: {}, fileError: '', fileLoading: false, fileQuery: '', fileToken: 0 };
  // 逐源状态机：idle → loading → ok / err。err 不自动重试（重开会话仍保留结论，避免反复打插件）。
  var src = {
    ctr: { st: 'idle', items: [], err: '' },
    proc: { st: 'idle', items: [], err: '' },
    ports: { st: 'idle', items: [], err: '' },
    db: { st: 'idle', dbs: [], tables: [], err: '', plugin: '' },
    logs: { st: 'idle', sources: null, err: '', cache: {}, token: 0, query: '' }
  };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function locale() {
    try { var i = window.KoreI18n; if (i && typeof i.locale === 'function') return i.locale(); } catch (e) { /* 无 i18n 时按中文 */ }
    return 'zh-CN';
  }
  // 本地化（ADR-0021）：英文态先查 en-US 语言包，再查本文件的 EN 表，最后回退中文常量；
  // 语言包缺键时 i18n.t 返回键名本身，这里以 hit !== key 拦截，不露裸键。
  function tr(key, fallback, params) {
    var i18n = window.KoreI18n;
    if (i18n && typeof i18n.t === 'function') {
      var hit = i18n.t(key, params);
      if (hit && hit !== key) return hit;
    }
    var out = (locale() === 'en-US' && EN[key]) ? EN[key] : (fallback === undefined || fallback === null ? key : String(fallback));
    if (params) {
      for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k)) out = out.split('{' + k + '}').join(String(params[k]));
      }
    }
    return out;
  }
  function groupLabel(key) {
    var d = GROUP_LABEL[key] || [key, key];
    return tr(d[0], d[1]);
  }
  function go(id) {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') { window.KoreShell.navigate(id); } else { window.location.hash = '#/' + id; }
  }
  function scrollTo(n) { if (n.scrollIntoView) n.scrollIntoView({ block: 'center' }); }
  // 视图模块是异步注入的：动作钩子轮询目标选择器，落地页失败也不报错（至少已到页面）。
  function waitFor(fn, ms) {
    var end = Date.now() + (ms || 5000);
    (function tick() {
      var done = false;
      try { done = fn(); } catch (e) { done = false; }
      if (done || Date.now() > end) return;
      setTimeout(tick, 100);
    })();
  }
  function focusSel(sel) {
    waitFor(function () { var n = document.querySelector(sel); if (!n) return false; scrollTo(n); if (n.focus) n.focus(); return true; });
  }
  function clickText(sel, text) {
    waitFor(function () {
      var ns = document.querySelectorAll(sel);
      for (var i = 0; i < ns.length; i++) if (ns[i].textContent.trim() === text) { ns[i].click(); return true; }
      return false;
    });
  }
  function spotlightNode(n) {
    if (!n) return;
    scrollTo(n); n.style.outline = '2px solid var(--kore-info)'; n.style.outlineOffset = '2px';
    var timer = setTimeout(function () { n.style.outline = ''; n.style.outlineOffset = ''; }, 2400);
    return timer;
  }
  function spotlight(sel) {
    waitFor(function () { var n = document.querySelector(sel); if (!n) return false; spotlightNode(n); return true; });
  }
  function findRow(sel, text) {
    var ns = document.querySelectorAll(sel), needle = String(text || '');
    for (var i = 0; i < ns.length; i++) {
      if (ns[i].textContent.indexOf(needle) >= 0) return ns[i];
    }
    return null;
  }
  function fireInput(n) {
    try { n.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {
      var ev = document.createEvent('HTMLEvents'); ev.initEvent('input', true, false); n.dispatchEvent(ev);
    }
  }
  function spotlightStore(id) {
    waitFor(function () {
      var q = document.querySelector('.store-search'); if (!q) return false;
      if (q.value !== id) { q.value = id; fireInput(q); }
      return !!document.querySelector('.store-card[data-plugin-id="' + id + '"]');
    });
    spotlight('.store-card[data-plugin-id="' + id + '"]');
  }
  function fetchJSON(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.text().then(function (raw) {
          var body = {};
          if (raw) { try { body = JSON.parse(raw); } catch (e) { body = {}; } }
          if (!res.ok) { var err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
          return body;
        });
      });
  }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  // 插件业务调用统一走 invoke POST + CSRF 双提交（与 sites.js / files.js 同口径）。
  // 失败时把 code / status 挂到 Error 上：来源降级文案要靠它区分「未启用」与「读失败了」。
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) {
      var nerr = new Error(tr('search.err.noCsrf', '缺少安全令牌，请刷新页面或重新登录'));
      nerr.code = 'E_NO_CSRF'; nerr.status = 0;
      return Promise.reject(nerr);
    }
    return fetch(EP.invoke + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var body = {};
        if (raw) { try { body = JSON.parse(raw); } catch (e) { body = {}; } }
        if (!res.ok) {
          var err = new Error(body.message || (tr('search.err.http', '请求失败（HTTP ') + res.status + '）'));
          err.code = body.code || ''; err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }
  function mapPlugins(b) { return (Array.isArray(b.plugins) ? b.plugins : []).map(function (p) { return { id: p.id, name: p.name || p.id }; }); }
  function mapSites(b) {
    return (Array.isArray(b.sites) ? b.sites : []).map(function (s) {
      return { domain: s.domain || '', enabled: !!s.enabled };
    }).filter(function (s) { return !!s.domain; });
  }
  function loadData() {
    if (data.installed && data.store && data.sites) return Promise.resolve();
    if (data.promise) return data.promise;
    data.promise = Promise.all([
      data.installed ? Promise.resolve(data.installed) : fetchJSON(EP.installed).then(mapPlugins,
        function () { data.error = tr('search.err.pluginsFail', '插件列表读取失败'); return []; }),
      data.store ? Promise.resolve(data.store) : fetchJSON(EP.store).then(mapPlugins,
        function () { data.error = tr('search.err.storeFail', '商店数据读取失败'); return []; }),
      data.sites ? Promise.resolve(data.sites) : invoke('site/site.list', {}).then(mapSites,
        function () { data.sitesError = tr('search.err.sitesFail', '站点列表没读到（站点插件可能还没装或没启用）：请到「软件商店」确认 site 插件已安装并启用，再重新搜索。'); return []; })
    ]).then(function (out) { data.installed = out[0]; data.store = out[1]; data.sites = out[2]; });
    return data.promise;
  }
  // 文件源按输入词实时查：裸词包 *…*（与 files.js 的 searchParams 同口径），按 query 缓存。
  function loadFiles(q) {
    if (!q) return;
    var key = q.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(data.fileCache, key)) return;
    if (data.fileQuery === key && data.fileLoading) return;
    var token = ++data.fileToken;
    data.fileQuery = key; data.fileLoading = true; data.fileError = '';
    var pattern = (/[*?]/.test(q) || q.indexOf('[') >= 0) ? q : '*' + q + '*';
    return invoke('file/file.search', { path: '.', pattern: pattern, max_results: 50 }).then(function (b) {
      if (token !== data.fileToken) return;
      data.fileCache[key] = (Array.isArray(b.entries) ? b.entries : []).slice(0, 20);
      data.fileLoading = false;
      if (S.open) paint();
    }, function (err) {
      if (token !== data.fileToken) return;
      data.fileLoading = false;
      data.fileError = tr('search.err.fileFailPrefix', '文件搜索没成功（') + (err && err.message ? err.message : tr('search.err.unknown', '未知原因')) +
        tr('search.err.fileFailSuffix', '）：请到「软件商店」确认「文件管理」插件已安装并启用，或换个关键词再试。');
      if (S.open) paint();
    });
  }
  // 来源降级文案：404 / E_NOTFOUND / 未启用 归为「该来源未启用」，其余原样带上原因。
  function srcErrText(key, err) {
    var label = SRC_LABEL[key] || key;
    var status = err && err.status ? err.status : 0;
    var msg = err && err.message ? String(err.message) : '';
    if (status === 404 || /未安装|未启用|not installed|not enabled|E_NOTFOUND|E_UNAVAILABLE|E_NO_PLUGIN/i.test(msg)) {
      return tr('search.src.disabled', '{label}来源未启用（插件未安装或未启用）', { label: label });
    }
    return tr('search.src.fail', '{label}来源读取失败：{msg}', { label: label, msg: msg || tr('search.err.unknown', '未知原因') });
  }
  function srcDone(key, ok) { src[key].st = ok ? 'ok' : 'err'; if (S.open) paint(); }
  function loadContainers() {
    var s = src.ctr;
    if (s.st !== 'idle') return;
    s.st = 'loading';
    invoke('container/container.list', { all: true }).then(function (b) {
      s.items = (Array.isArray(b.containers) ? b.containers : []).map(function (c) {
        return { id: String(c.id || ''), name: String(c.name || ''), image: String(c.image || ''),
          state: String(c.state || ''), ports: String(c.ports || '') };
      });
      srcDone('ctr', true);
    }, function (err) { s.err = srcErrText('ctr', err); srcDone('ctr', false); });
  }
  function loadProcesses() {
    var s = src.proc;
    if (s.st !== 'idle') return;
    s.st = 'loading';
    invoke('process/process.list', { sort: 'cpu', limit: 300 }).then(function (b) {
      s.items = (Array.isArray(b.items) ? b.items : []).map(function (p) {
        return { pid: Number(p.pid) || 0, name: String(p.name || ''), cmdline: String(p.cmdline || ''),
          user: String(p.user || ''), state: String(p.state || '') };
      });
      srcDone('proc', true);
    }, function (err) { s.err = srcErrText('proc', err); srcDone('proc', false); });
  }
  function loadPorts() {
    var s = src.ports;
    if (s.st !== 'idle') return;
    s.st = 'loading';
    invoke('process/process.ports', { pid: 0 }).then(function (b) {
      s.items = (Array.isArray(b.listeners) ? b.listeners : []).map(function (l) {
        return { pid: Number(l.pid) || 0, name: String(l.name || ''), protocol: String(l.protocol || ''),
          address: String(l.address || ''), port: Number(l.port) || 0 };
      });
      srcDone('ports', true);
    }, function (err) { s.err = srcErrText('ports', err); srcDone('ports', false); });
  }
  // 数据库：instances → databases + 一条 information_schema 只读查询（库名与表名一起拿）。
  // MySQL 优先；没实例或没数据时再探 PostgreSQL；单个实例失败只丢该实例，不整体降级。
  // 方法名必须完全限定（PLUGIN-PROTOCOL §7.2：<plugin-id>.<action>），
  // 裸动词会被插件按 E_NOTFOUND 拒绝（db-mysql 的 businessVerb 只认 'db-mysql.' 前缀）。
  function probeDb(plugin) {
    return invoke(plugin + '/' + plugin + '.instances', {}).then(function (b) {
      var list = (Array.isArray(b.instances) ? b.instances : []).filter(function (it) {
        return it && it.reachable !== false;
      }).slice(0, 2);
      if (!list.length) return { dbs: [], tables: [], plugin: plugin, hadInstance: false };
      return Promise.all(list.map(function (inst) {
        var name = String(inst.name || '');
        return invoke(plugin + '/' + plugin + '.databases', { instance: name }).then(function (d) {
          var dbs = (Array.isArray(d.databases) ? d.databases : []).map(function (n) {
            return { instance: name, db: String(n) };
          }).filter(function (x) { return SYSTEM_SCHEMAS.indexOf(x.db) < 0; });
          return invoke(plugin + '/' + plugin + '.query', { instance: name, sql: TABLE_SQL, limit: 500 }).then(function (r) {
            var tables = (Array.isArray(r.rows) ? r.rows : []).map(function (row) {
              var db = row ? String(row.db || row.table_schema || '') : '';
              var tbl = row ? String(row.tbl || row.table_name || '') : '';
              if (!tbl || SYSTEM_SCHEMAS.indexOf(db) >= 0) return null;
              return { instance: name, db: db, tbl: tbl };
            }).filter(function (x) { return !!x; });
            return { dbs: dbs, tables: tables };
          }, function () { return { dbs: dbs, tables: [] }; });
        }, function () { return { dbs: [], tables: [] }; });
      })).then(function (parts) {
        var out = { dbs: [], tables: [], plugin: plugin, hadInstance: true };
        parts.forEach(function (p) { out.dbs = out.dbs.concat(p.dbs); out.tables = out.tables.concat(p.tables); });
        return out;
      });
    });
  }
  function loadDatabases() {
    var s = src.db;
    if (s.st !== 'idle') return;
    s.st = 'loading';
    probeDb('db-mysql').then(function (a) {
      if (a.dbs.length || a.tables.length) return a;
      return probeDb('db-postgres').then(function (b) {
        if (!b.dbs.length && !b.tables.length) return a;
        return { dbs: a.dbs.concat(b.dbs), tables: a.tables.concat(b.tables), plugin: 'db-postgres', hadInstance: true };
      }, function () { return a; });
    }, function (errMysql) {
      return probeDb('db-postgres').then(function (b) {
        return { dbs: b.dbs, tables: b.tables, plugin: 'db-postgres', hadInstance: b.hadInstance };
      }, function () { throw errMysql; });
    }).then(function (out) {
      s.dbs = out.dbs; s.tables = out.tables; s.plugin = out.plugin || ''; s.hadInstance = !!out.hadInstance;
      srcDone('db', true);
    }, function (err) { s.err = srcErrText('db', err); srcDone('db', false); });
  }
  // 日志：sources 只取一次（可读的前两个来源），关键字按词缓存并带 token 丢弃过期响应。
  function loadLogSources() {
    var s = src.logs;
    if (s.sources !== null) return Promise.resolve(s.sources);
    if (s.st === 'loading') return s.promise || Promise.resolve([]);
    s.st = 'loading';
    s.promise = invoke('logs/logs.sources', {}).then(function (b) {
      s.sources = (Array.isArray(b.sources) ? b.sources : []).filter(function (x) {
        return x && x.readable !== false && x.exists !== false;
      }).slice(0, 2);
      s.st = 'ok';
      return s.sources;
    }, function (err) {
      s.sources = []; s.err = srcErrText('logs', err); s.st = 'err';
      return [];
    });
    return s.promise;
  }
  function loadLogs(q) {
    var key = String(q || '').toLowerCase();
    if (!key) return;
    var s = src.logs;
    if (Object.prototype.hasOwnProperty.call(s.cache, key)) return;
    if (s.st !== 'ok' && s.st !== 'idle') return;
    if (s.query === key && s.searching) return;
    var token = ++s.token;
    s.query = key; s.searching = true;
    loadLogSources().then(function (list) {
      if (token !== s.token) return;
      if (!list.length) { s.cache[key] = []; s.searching = false; if (S.open) paint(); return; }
      Promise.all(list.map(function (one) {
        return invoke('logs/logs.search', { source: String(one.name || ''), query: q, limit: 3 }).then(function (r) {
          return { source: String(r.source || one.name || ''), matches: (Array.isArray(r.matches) ? r.matches : []).slice(0, 3) };
        }, function () { return { source: String(one.name || ''), matches: [] }; });
      })).then(function (parts) {
        if (token !== s.token) return;
        s.cache[key] = parts; s.searching = false;
        if (S.open) paint();
      });
    });
  }
  function recentGet() {
    try {
      var raw = window.localStorage.getItem(RECENT_KEY);
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      return list.filter(function (x) { return typeof x === 'string' && x; }).slice(0, 6);
    } catch (e) { return []; }
  }
  function recentPush(q) {
    var v = String(q || '').trim();
    if (!v) return;
    try {
      var list = recentGet().filter(function (x) { return x !== v; });
      list.unshift(v);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6)));
    } catch (e) { /* 隐私模式禁写：最近搜索只是锦上添花，不阻断搜索 */ }
  }
  function recentClear() {
    try { window.localStorage.removeItem(RECENT_KEY); } catch (e) { /* 同上 */ }
  }
  function openSite(domain) {
    go('sites/sites');
    waitFor(function () {
      var links = document.querySelectorAll('button.site-link[data-site], [data-site]');
      for (var i = 0; i < links.length; i++) {
        if (links[i].getAttribute('data-site') !== domain) continue;
        scrollTo(links[i]); links[i].click(); return true;
      }
      return false;
    });
  }
  function openFile(entry) {
    go('files/files');
    waitFor(function () {
      var input = document.querySelector('.files-search-input');
      var btn = document.querySelector('[data-action="search"]');
      if (!input || !btn) return false;
      var name = String(entry.path || '').split('/').pop() || entry.path;
      input.value = name;
      btn.click();
      return true;
    });
    waitFor(function () {
      // 搜索结果视图行是 tr[data-path]，目录视图行是 tr[data-entry-path]（files.js 两种都渲染）。
      var rows = document.querySelectorAll('tr[data-path], tr[data-entry-path]');
      for (var i = 0; i < rows.length; i++) {
        var rowPath = rows[i].getAttribute('data-path') || rows[i].getAttribute('data-entry-path');
        if (rowPath !== entry.path) continue;
        spotlightNode(rows[i]);
        return true;
      }
      return false;
    }, 7000);
  }
  // 数据库跳转：点同名库触发表列表（db.js 的 useDb 会跑 SHOW TABLES），命中表再高亮该格。
  function openDb(hit) {
    go('db/db');
    waitFor(function () {
      var names = document.querySelectorAll('.db-row .db-db-name');
      for (var i = 0; i < names.length; i++) {
        if (names[i].textContent.trim() !== hit.db) continue;
        var btn = names[i].parentNode && names[i].parentNode.className.indexOf('db-db') >= 0 ? names[i].parentNode : names[i];
        btn.click();
        return true;
      }
      return false;
    }, 8000);
    if (!hit.tbl) return;
    waitFor(function () {
      var cells = document.querySelectorAll('.db-result-table td');
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].textContent.trim() !== hit.tbl) continue;
        spotlightNode(cells[i]);
        return true;
      }
      return false;
    }, 15000);
  }
  function openContainer(c) {
    go('sites/container');
    waitFor(function () {
      var row = document.querySelector('tr[data-id="' + String(c.id || '') + '"]');
      if (!row) row = findRow('tr', c.name || c.id);
      if (!row) return false;
      spotlightNode(row);
      return true;
    }, 9000);
  }
  // 进程跳转：进程页的过滤框输入 PID（进程列表一次拉 300 条，行一定在），再点开详情抽屉。
  function openProcess(pid, name) {
    go('monitor/process');
    waitFor(function () {
      var box = document.querySelector('.proc-search');
      if (!box) return false;
      var want = pid ? String(pid) : String(name || '');
      if (!want) return false;
      if (box.value !== want) { box.value = want; fireInput(box); }
      var row = findRow('tr.proc-row', want);
      if (!row) return false;
      scrollTo(row); row.click();
      return true;
    }, 9000);
  }
  function openLogs(keyword) {
    go('monitor/logs');
    waitFor(function () {
      var box = document.querySelector('.logs-toolbar input[type="search"]');
      if (!box) return false;
      if (box.value !== keyword) { box.value = keyword; fireInput(box); }
      scrollTo(box);
      return true;
    }, 9000);
  }
  function openPage(route) { go(route); }
  function clip(s, n) {
    var v = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
    if (v.length <= n) return v;
    return v.slice(0, n - 1) + '…';
  }
  function scoreOf(hay, n) {
    var h = String(hay === undefined || hay === null ? '' : hay).toLowerCase();
    var q = String(n || '').toLowerCase();
    if (!q) return 0;
    if (h === q) return 3;
    if (h.indexOf(q) === 0) return 2;
    return h.indexOf(q) >= 0 ? 1 : 0;
  }
  function best(fields, n) {
    var m = 0;
    for (var i = 0; i < fields.length; i++) {
      var s = scoreOf(fields[i], n);
      if (s > m) m = s;
      if (m === 3) return 3;
    }
    return m;
  }
  function take(list, n) {
    list.sort(function (a, b) {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      return String(a.title).localeCompare(String(b.title));
    });
    return list.slice(0, n);
  }
  function parseQuery(raw) {
    var v = String(raw === undefined || raw === null ? '' : raw).trim();
    var m = /^([A-Za-z]+):\s*([\s\S]*)$/.exec(v);
    var scope = '';
    if (m) {
      var hit = SCOPE_ALIAS[m[1].toLowerCase()];
      if (hit) { scope = hit; v = m[2]; }
    }
    var text = v.trim();
    return { scope: scope, text: text, smart: scope === 'port' ? 'number' : detectSmart(text) };
  }
  function detectSmart(text) {
    var t = String(text || '').trim();
    if (!t) return '';
    if (/^\d{1,5}$/.test(t)) return Number(t) >= 1 && Number(t) <= 65535 ? 'number' : '';
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(t)) return 'ip';
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(t)) return 'domain';
    return '';
  }
  function orderFor(p) {
    if (p.scope) return [p.scope];
    if (p.smart === 'number') return ORDER_NUMBER;
    if (p.smart === 'ip') return ORDER_IP;
    if (p.smart === 'domain') return ORDER_DOMAIN;
    return ORDER_DEFAULT;
  }
  function ensureSources(p) {
    var q = p.text;
    if (!q && !p.scope) return;
    loadData();
    if (!p.scope || p.scope === 'ctr') loadContainers();
    if (!p.scope || p.scope === 'proc') loadProcesses();
    if (!p.scope || p.scope === 'db') loadDatabases();
    if (p.scope === 'port' || (!p.scope && (p.smart === 'number' || p.smart === 'ip'))) loadPorts();
    // 文件与日志是按词查询的源：同一个词只发一次（成功写缓存、失败留错误文案），
    // 否则 loadXxx 的失败回调里再 paint 会变成「请求→失败→重绘→再请求」的死循环。
    if (!p.scope || p.scope === 'file') {
      var fk = q.toLowerCase();
      if (q && data.fileQuery !== fk && !Object.prototype.hasOwnProperty.call(data.fileCache, fk)) loadFiles(q);
    }
    if (p.scope === 'log') { if (q.length >= 2) loadLogs(q); }
    else if (!p.scope && q.length >= 3) loadLogs(q);
  }
  function siteItems(p) {
    var n = p.text, out = [];
    (data.sites || []).forEach(function (s) {
      var sc = best([s.domain], n);
      if (!sc) return;
      if (p.smart === 'domain' && s.domain.toLowerCase() === n.toLowerCase()) sc = 3;
      out.push({
        title: s.domain, score: sc,
        sub: tr('search.item.site', '网站 · {state}', { state: s.enabled ? tr('search.site.enabled', '已启用') : tr('search.site.disabled', '已停用') }),
        run: function () { openSite(s.domain); }
      });
    });
    return out;
  }
  function fileItems(p) {
    var n = p.text.toLowerCase();
    var cached = Object.prototype.hasOwnProperty.call(data.fileCache, n) ? data.fileCache[n] : null;
    var out = [];
    (cached || []).forEach(function (entry) {
      var path = String(entry.path || '');
      var sc = best([path], p.text);
      if (!sc) return;
      out.push({
        title: (entry.is_dir ? tr('search.kind.dir', '目录') : tr('search.kind.file', '文件')) + ' · ' + (path.split('/').pop() || path),
        score: sc,
        sub: tr('search.item.file', '文件 · /{path}', { path: path.replace(/^\/+/, '') }),
        run: function () { openFile(entry); }
      });
    });
    return out;
  }
  function dbItems(p) {
    var s = src.db, out = [];
    if (s.st !== 'ok') return out;
    s.dbs.forEach(function (d) {
      var sc = best([d.db, d.instance + ' ' + d.db], p.text);
      if (!sc) return;
      out.push({
        title: d.db, score: sc,
        sub: tr('search.item.db', '数据库 · {instance}', { instance: d.instance || s.plugin || 'MySQL' }),
        run: function () { openDb({ db: d.db }); }
      });
    });
    s.tables.forEach(function (t) {
      var sc = best([t.tbl, t.db + '.' + t.tbl, t.db], p.text);
      if (!sc) return;
      // 表名完全命中时提权，避免被同名库的大量表冲淡。
      if (String(t.tbl).toLowerCase() === String(p.text).toLowerCase()) sc = 3;
      out.push({
        title: t.tbl, score: sc,
        sub: tr('search.item.table', '数据库表 · {db}', { db: t.db || t.instance }),
        run: function () { openDb({ db: t.db, tbl: t.tbl }); }
      });
    });
    return out;
  }
  function ctrItems(p) {
    var s = src.ctr, out = [];
    if (s.st !== 'ok') return out;
    s.items.forEach(function (c) {
      var sc = best([c.name, c.image, c.id, c.ports, c.name + ' ' + c.image], p.text);
      if (!sc) return;
      out.push({
        title: c.name || c.id, score: sc,
        sub: tr('search.item.container', '容器 · {extra}', { extra: (c.image || '—') + (c.state ? ' · ' + c.state : '') }),
        run: function () { openContainer(c); }
      });
    });
    return out;
  }
  function procItems(p) {
    var s = src.proc, out = [];
    if (s.st !== 'ok') return out;
    s.items.forEach(function (it) {
      var sc = best([it.name, it.cmdline, String(it.pid), it.name + ' ' + it.cmdline], p.text);
      if (!sc) return;
      if (p.smart === 'number' && String(it.pid) === p.text) sc = 3;
      out.push({
        title: it.name + '（' + it.pid + '）', score: sc,
        sub: tr('search.item.process', '进程 · PID {pid}', { pid: it.pid }) + (it.cmdline ? ' · ' + clip(it.cmdline, 60) : ''),
        run: function () { openProcess(it.pid); }
      });
    });
    return out;
  }
  function portItems(p) {
    var s = src.ports, out = [];
    if (s.st !== 'ok') return out;
    var numeric = p.smart === 'number' || /^\d+$/.test(p.text);
    s.items.forEach(function (l) {
      var hay = [String(l.port), l.address, l.name, String(l.pid)];
      var sc = best(hay, p.text);
      if (!sc) return;
      if (numeric && String(l.port) === p.text) sc = 3;
      out.push({
        title: tr('search.item.portTitle', '端口 {port} · {name}', { port: l.port, name: l.name || '—' }), score: sc,
        sub: tr('search.item.port', '监听 · {protocol} {address}', { protocol: l.protocol || '—', address: l.address || '—' }) +
          ' · ' + tr('search.item.portOwner', '进程 {name}（PID {pid}）', { name: l.name || '—', pid: l.pid }),
        run: function () { openProcess(l.pid); }
      });
    });
    return out;
  }
  function logItems(p) {
    var s = src.logs, out = [];
    var key = String(p.text || '').toLowerCase();
    var cached = Object.prototype.hasOwnProperty.call(s.cache, key) ? s.cache[key] : null;
    (cached || []).forEach(function (one) {
      (one.matches || []).forEach(function (m) {
        out.push({
          title: clip(m.text, 90), score: 2,
          sub: tr('search.item.log', '日志 · {source} 第 {line} 行', { source: one.source, line: m.line_no }),
          run: function () { openLogs(p.text); }
        });
      });
    });
    return out;
  }
  function pageItems(p) {
    var out = [];
    PAGES.forEach(function (pg) {
      var sc = best([pg[1], pg[2]], p.text);
      if (!sc) return;
      out.push({
        title: tr('search.label.goto', '跳转到 ') + pg[1], score: sc,
        sub: tr('search.item.page', '页面 · {label}', { label: pg[1] }),
        run: function () { openPage(pg[0]); }
      });
    });
    return out;
  }
  function pluginItems(p) {
    var out = [];
    (data.installed || []).forEach(function (pl) {
      var sc = best([pl.id, pl.name, ALIASES[pl.id] || ''], p.text);
      if (!sc) return;
      out.push({
        title: tr('search.label.openPlugin', '打开插件详情 · ') + pl.name, score: sc,
        sub: tr('search.item.plugin', '已装插件 · {id}', { id: pl.id }),
        run: function () { go('store/plugins'); spotlight('#view tr[data-plugin-id="' + pl.id + '"]'); }
      });
    });
    return out;
  }
  function storeItems(p) {
    var out = [], ids = {};
    (data.installed || []).forEach(function (pl) { ids[pl.id] = 1; });
    (data.store || []).forEach(function (s) {
      if (ids[s.id]) return;
      var sc = best([s.id, s.name, ALIASES[s.id] || ''], p.text);
      if (!sc) return;
      out.push({
        title: tr('search.label.installFromStore', '去商店安装 · ') + s.name, score: sc,
        sub: tr('search.item.store', '商店插件 · {id}', { id: s.id }),
        run: function () { go('store/store'); spotlightStore(s.id); }
      });
    });
    return out;
  }
  function actionItems(p) {
    var out = [];
    ACTIONS.forEach(function (a) {
      var sc = best([a[0], a[1]], p.text);
      if (!sc) return;
      out.push({
        title: tr('search.label.execute', '执行：') + a[0], score: sc,
        sub: tr('search.item.action', '操作 · {label}', { label: a[0] }),
        run: function () { if (a[3]) a[3](); go(a[2]); if (a[4]) a[4](); }
      });
    });
    return out;
  }
  function collect(p) {
    return {
      site: siteItems(p), file: fileItems(p), db: dbItems(p), ctr: ctrItems(p), proc: procItems(p),
      port: portItems(p), log: logItems(p), page: pageItems(p), plugin: pluginItems(p),
      store: storeItems(p), action: actionItems(p)
    };
  }
  function select(i) {
    S.sel = i;
    S.nodes.forEach(function (n, k) {
      var on = k === i;
      n.classList.toggle('is-active', on);
      n.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) scrollTo(n);
    });
  }
  function paintHint(p) {
    if (!S.hint) return;
    S.hint.textContent = '';
    if (p.scope) {
      S.hint.appendChild(el('span', 'kore-search-hint-text', tr('search.hint.scope', '范围：{scope}', { scope: groupLabel(p.scope) })));
      var clear = el('button', 'kore-search-hint-clear', tr('search.hint.scopeClear', '清除'));
      clear.type = 'button';
      clear.addEventListener('click', function () { S.input.value = p.text; S.input.focus(); paint(); });
      S.hint.appendChild(clear);
    } else if (p.smart === 'number') {
      S.hint.appendChild(el('span', 'kore-search-hint-text', tr('search.hint.number', '优先按端口 / PID {q} 查找', { q: p.text })));
    } else if (p.smart === 'ip') {
      S.hint.appendChild(el('span', 'kore-search-hint-text', tr('search.hint.ip', '优先查这个 IP 上的监听', { q: p.text })));
    } else if (p.smart === 'domain') {
      S.hint.appendChild(el('span', 'kore-search-hint-text', tr('search.hint.domain', '优先按站点查找 {q}', { q: p.text })));
    }
    S.hint.hidden = !S.hint.childNodes.length;
  }
  function pushItem(it) {
    var idx = S.items.length, btn = el('button', 'kore-search-item');
    btn.type = 'button'; btn.setAttribute('role', 'option'); btn.setAttribute('aria-selected', 'false');
    btn.appendChild(el('span', 'kore-search-item-title', it.title));
    btn.appendChild(el('span', 'kore-search-item-sub', it.sub || ''));
    btn.appendChild(el('span', 'kore-search-item-go', '↗'));
    btn.addEventListener('mouseenter', function () { select(idx); });
    btn.addEventListener('click', function () { execute(it); });
    S.list.appendChild(btn);
    S.items.push(it); S.nodes.push(btn);
  }
  function paintEmpty(p) {
    var list = S.list;
    if (p.scope) {
      list.appendChild(el('div', 'kore-search-note',
        tr('search.scope.prompt', '范围：{scope} — 输入关键词开始搜索', { scope: groupLabel(p.scope) })));
      paintNotes(p);
      return;
    }
    var recent = recentGet();
    if (recent.length) {
      var head = el('div', 'kore-search-group kore-search-group-row');
      head.appendChild(el('span', null, tr('search.recent.title', '最近搜索')));
      var clear = el('button', 'kore-search-recent-clear', tr('search.recent.clear', '清空'));
      clear.type = 'button';
      clear.addEventListener('click', function () { recentClear(); paint(); });
      head.appendChild(clear);
      list.appendChild(head);
      recent.forEach(function (q) {
        pushItem({ title: q, sub: tr('search.recent.hint', '按 Enter 重新搜索'), refill: q, score: 0 });
      });
    }
    var guide = el('div', 'kore-search-guide');
    guide.appendChild(el('div', 'kore-search-group', tr('search.guide.title', '可以搜什么')));
    var grid = el('div', 'kore-search-chips');
    var TIPS = [
      ['site:', 'search.guide.site', '站点域名'],
      ['file:', 'search.guide.file', '文件名 / 路径'],
      ['db:', 'search.guide.db', '库名 / 表名'],
      ['ctr:', 'search.guide.ctr', '容器名 / 镜像'],
      ['proc:', 'search.guide.proc', '进程名 / PID'],
      ['port:', 'search.guide.port', '端口号'],
      ['log:', 'search.guide.log', '日志关键字'],
      ['page:', 'search.guide.page', '页面功能']
    ];
    TIPS.forEach(function (t) {
      var chip = el('button', 'kore-search-chip');
      chip.type = 'button';
      chip.appendChild(el('span', 'kore-search-chip-prefix', t[0]));
      chip.appendChild(el('span', 'kore-search-chip-label', tr(t[1], t[2])));
      chip.addEventListener('click', function () { S.input.value = t[0]; S.input.focus(); paint(); });
      grid.appendChild(chip);
    });
    guide.appendChild(grid);
    guide.appendChild(el('p', 'kore-search-guide-tip', tr('search.guide.tip',
      '不写前缀就全部来源一起搜：纯数字优先当端口与 PID，域名优先站点，IP 查监听地址。')));
    list.appendChild(guide);
    if (S.items.length) select(0);
    paintNotes(p);
  }
  // 备注区：文件源进度 / 各来源降级结论 / 插件与站点数据状态，各自独立一行，不互相顶掉。
  function paintNotes(p) {
    var notes = [];
    var fk = String(p.text || '').toLowerCase();
    var hasFile = Object.prototype.hasOwnProperty.call(data.fileCache, fk);
    if (data.fileLoading && data.fileQuery === fk && !hasFile) {
      notes.push(tr('search.note.searchingPrefix', '正在按文件名搜索「') + p.text + tr('search.note.searchingSuffix', '」…'));
    } else if (data.fileError && !hasFile) {
      notes.push(data.fileError);
    }
    if (!data.sites && !data.sitesError) notes.push(tr('search.note.sitesLoading', '站点列表加载中…'));
    else if (data.sitesError) notes.push(data.sitesError);
    if ((!data.installed || !data.store) && !data.error) notes.push(tr('search.note.pluginsLoading', '插件与商店数据加载中…'));
    else if (data.error) notes.push(data.error + tr('search.note.partialOk', '（页面与操作仍可搜索）'));
    // 只在本次真正尝试过的来源上报告「未启用 / 读取失败」。
    ['db', 'ctr', 'proc', 'ports', 'logs'].forEach(function (k) {
      var s = src[k];
      if (s.st === 'loading' && needsSource(p, k)) notes.push(tr('search.src.loading', '正在读取{label}…', { label: SRC_LABEL[k] }));
      if (s.st === 'err' && s.err) notes.push(s.err);
    });
    if (p.scope === 'db' && src.db.st === 'ok' && src.db.hadInstance === false) notes.push(tr('search.note.dbEmpty', '还没有添加数据库连接，这个来源暂时没有内容。'));
    if (p.scope === 'log' && src.logs.sources !== null && !src.logs.sources.length && !src.logs.err) notes.push(tr('search.note.logNoSource', '没有可读的日志来源，这个来源暂时没有内容。'));
    for (var i = 0; i < notes.length; i++) S.list.appendChild(el('div', 'kore-search-note', notes[i]));
  }
  // key 是 src.* 的状态键（ports / logs），前缀名是单数形式（port / log）。
  function needsSource(p, key) {
    if (p.scope === 'port') return key === 'ports';
    if (p.scope === 'log') return key === 'logs';
    if (p.scope) return p.scope === key;
    if (key === 'ctr' || key === 'proc' || key === 'db') return true;
    if (key === 'ports') return p.smart === 'number' || p.smart === 'ip';
    if (key === 'logs') return String(p.text || '').length >= 3;
    return false;
  }
  function paint() {
    var p = parseQuery(S.input.value);
    ensureSources(p);
    paintHint(p);
    S.list.textContent = ''; S.items = []; S.nodes = []; S.sel = 0;
    if (!p.text) { paintEmpty(p); return; }
    var groups = collect(p), order = orderFor(p), shown = 0;
    for (var i = 0; i < order.length; i++) {
      var key = order[i], items = groups[key] || [];
      if (!items.length) continue;
      var picked = take(items, i < 3 ? 5 : 3);
      S.list.appendChild(el('div', 'kore-search-group', groupLabel(key) + ' · ' + picked.length));
      for (var j = 0; j < picked.length; j++) { pushItem(picked[j]); shown++; }
    }
    if (!shown) {
      S.list.appendChild(el('div', 'kore-search-empty', p.scope
        ? tr('search.empty.scoped', '该来源没找到「{q}」：换个关键词，或清除范围再试。', { q: p.text })
        : tr('search.empty.prefix', '没找到「') + p.text + tr('search.empty.suffix', '」，试试：数据库 / 站点 / 备份 / 端口 8080')));
    }
    if (shown) select(0);
    paintNotes(p);
  }
  function execute(item) {
    if (!item) return;
    if (item.refill) { S.input.value = item.refill; S.input.focus(); paint(); return; }
    var q = S.input.value.trim();
    if (q) recentPush(q);
    close();
    if (typeof item.run === 'function') item.run();
  }
  function onKey(ev) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!S.items.length) return;
      ev.preventDefault();
      select((S.sel + (ev.key === 'ArrowDown' ? 1 : -1) + S.items.length) % S.items.length);
    } else if (ev.key === 'Enter') {
      if (S.items.length) { ev.preventDefault(); execute(S.items[S.sel]); }
    } else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  }
  var CSS = '.kore-search-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:10vh 16px 16px;background:var(--kore-overlay)}' +
    '.kore-search-backdrop[hidden]{display:none}.kore-search-modal{width:min(680px,100%);max-height:74vh;display:flex;flex-direction:column;background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:8px;box-shadow:var(--kore-shadow);overflow:hidden}' +
    '.kore-search-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--kore-border-1)}.kore-search-bar svg{width:18px;height:18px;color:var(--kore-text-3);flex:0 0 auto}' +
    '.kore-search-input{flex:1 1 auto;min-width:0;background:transparent;border:0;outline:none;color:var(--kore-text-1);font-size:var(--kore-font-16)}.kore-search-kbd{font-size:11px;color:var(--kore-text-3);border:1px solid var(--kore-border-1);border-radius:4px;padding:1px 5px}' +
    '.kore-search-hint{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--kore-border-2);background:var(--kore-bg-2);font-size:11px;color:var(--kore-text-2)}.kore-search-hint[hidden]{display:none}' +
    '.kore-search-hint-text{flex:1 1 auto;min-width:0}.kore-search-hint-clear{background:transparent;border:1px solid var(--kore-border-1);border-radius:4px;color:var(--kore-text-2);font:inherit;cursor:pointer;padding:1px 6px}' +
    '.kore-search-list{overflow-y:auto;padding:4px 0;min-height:80px}.kore-search-group{padding:8px 12px 4px;font-size:11px;color:var(--kore-text-3);letter-spacing:.04em}.kore-search-group-row{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '.kore-search-recent-clear{background:transparent;border:0;color:var(--kore-info);font:inherit;font-size:11px;cursor:pointer;padding:0}' +
    '.kore-search-item{display:block;width:100%;text-align:left;background:transparent;border:0;padding:7px 12px;cursor:pointer;color:var(--kore-text-1);position:relative}' +
    '.kore-search-item.is-active{background:var(--kore-bg-2);box-shadow:inset 2px 0 0 var(--kore-info)}' +
    '.kore-search-item-title{display:block;font-size:var(--kore-font-14);word-break:break-word;padding-right:18px}.kore-search-item-sub{display:block;font-size:11px;color:var(--kore-text-3);margin-top:2px;word-break:break-word}' +
    '.kore-search-item-go{position:absolute;right:10px;top:8px;font-size:11px;color:var(--kore-text-3);opacity:0}.kore-search-item.is-active .kore-search-item-go{opacity:1}' +
    '.kore-search-note,.kore-search-empty{padding:12px;color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.6}' +
    '.kore-search-guide{padding:2px 12px 8px}.kore-search-chips{display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 8px}' +
    '.kore-search-chip{display:inline-flex;align-items:center;gap:6px;background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-radius:999px;padding:4px 10px;color:var(--kore-text-2);font:inherit;font-size:12px;cursor:pointer}' +
    '.kore-search-chip:hover{color:var(--kore-text-1);border-color:var(--kore-text-3)}' +
    '.kore-search-chip-prefix{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--kore-info)}' +
    '.kore-search-guide-tip{margin:0;color:var(--kore-text-3);font-size:11px;line-height:1.6}' +
    '.kore-search-foot{padding:6px 12px;border-top:1px solid var(--kore-border-2);font-size:11px;color:var(--kore-text-3)}' +
    '.kore-search-lock{overflow:hidden}@media (max-width:639px){.kore-search-backdrop{padding:6vh 8px 8px}.kore-search-modal{max-height:82vh}.kore-search-kbd{display:none}' +
    '.kore-search-item{padding:10px 12px;min-height:44px}.kore-search-chip{min-height:36px}.kore-search-hint-clear{min-height:36px}}';
  function ensureDom() {
    if (S.root) return;
    var style = el('style'); style.id = 'kore-search-css'; style.textContent = CSS;
    document.head.appendChild(style);
    var backdrop = el('div', 'kore-search-backdrop');
    backdrop.hidden = true;
    backdrop.addEventListener('click', close);
    var modal = el('div', 'kore-search-modal');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', tr('search.aria.title', '全局搜索'));
    var bar = el('div', 'kore-search-bar'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6');
    var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', '8.5'); c.setAttribute('cy', '8.5'); c.setAttribute('r', '5');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M12.5 12.5 17 17');
    svg.appendChild(c); svg.appendChild(p);
    var input = el('input', 'kore-search-input');
    input.type = 'search';
    input.placeholder = tr('search.aria.placeholder', '搜索站点、文件、数据库、容器、进程、日志、页面…');
    input.setAttribute('aria-label', tr('search.aria.keyword', '全局搜索关键词')); input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', function () { clearTimeout(S.timer); S.timer = setTimeout(paint, 200); });
    input.addEventListener('keydown', onKey);
    bar.appendChild(svg); bar.appendChild(input); bar.appendChild(el('span', 'kore-search-kbd', 'Esc'));
    var hint = el('div', 'kore-search-hint'); hint.hidden = true;
    var list = el('div', 'kore-search-list'); list.setAttribute('role', 'listbox');
    modal.appendChild(bar); modal.appendChild(hint); modal.appendChild(list);
    modal.appendChild(el('div', 'kore-search-foot', tr('search.foot.keys', '↑↓ 选择 · Enter 跳转 · Esc 关闭')));
    modal.addEventListener('click', function (ev) { ev.stopPropagation(); });
    backdrop.appendChild(modal); document.body.appendChild(backdrop);
    S.root = backdrop; S.input = input; S.list = list; S.hint = hint;
  }
  function setTrigger(open) {
    var t = document.getElementById('kore-search-trigger'); if (t) t.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function open() {
    ensureDom();
    if (S.open) { S.input.focus(); return; }
    S.open = true;
    document.body.classList.add('kore-search-lock');
    S.root.hidden = false; setTrigger(true);
    S.input.value = ''; paint(); S.input.focus();
    loadData().then(function () { if (S.open) paint(); });
  }
  function close() {
    if (!S.open || !S.root) return;
    S.open = false; clearTimeout(S.timer);
    S.root.hidden = true; setTrigger(false);
    document.body.classList.remove('kore-search-lock');
    var t = document.getElementById('kore-search-trigger');
    if (t) t.focus();
  }
  // Ctrl/Cmd+K 由 shell.js 负责唤起；面板内再按一次就地关闭（同键位开合）。
  // 只处理「焦点在面板里」的第二次按键：shell.js 的监听先注册、先执行，
  // 若这里无条件关闭，会把刚被 shell 打开的同一事件又关掉（实测 Ctrl+K 只能开一次）。
  document.addEventListener('keydown', function (ev) {
    var mod = ev.metaKey || ev.ctrlKey;
    var inside = !!(S.root && ev.target && S.root.contains(ev.target));
    if (mod && !ev.altKey && String(ev.key || '').toLowerCase() === 'k' && S.open && inside) {
      ev.preventDefault(); close(); return;
    }
    if (ev.key === 'Escape' && S.open) { ev.preventDefault(); close(); }
  });
  window.KoreSearch = { open: open, close: close };
})();
