/* kore 主壳 · 本机服务发现（web/discover.js）——零框架 / 零 CDN / 无外链。
   调用形态（硬约束，docs/FRONTEND.md §业务方法调用形态）：POST /api/v1/invoke/discover/discover.<action>，
   方法名必须带域前缀（裸 summary 在老版本能用，但新内核按方法名路由，不带前缀不可依赖）。
   真实返回（2026-11-23 隔离实例 18869 实测，discover 0.3.1）：
   - discover.summary  {ready, web_server, db, conclusion, suggestions[{plugin,reason}]}
   - discover.services [{id,name,found,bin?,client_version?,server_version?,version_source,version_hint?,config_dir?,running,running_hint?,port,source?,install_hint?}]
   - discover.ports    [{port,addr,family,listening,process|null}]（process 为 null 是「非 root 看不到别的 uid 的 socket」）
   - discover.config.get {plugin,persisted,credential_requirements[],transport,hint}
   summary 不含计数：概览的数字一律由 services / ports 两份清单现算，不编造字段。
   本页不轮询（G-19）：进页各查一次，重查只由按钮触发（{refresh:true} 会绕过插件 30s 缓存）。

   关系视图 / 服务目录的增强数据（全部「取不到就整块省略」，不编造、不阻塞主清单）：
   - process.ports  {listeners:[{pid,name,protocol,address,port}]}  端口 → PID / 进程名（kore-plugin-process 0.3.0，process.js:1031）
   - process.list   {items:[{pid,rss_kib,cpu_pct,user,state,...}]}   PID → 内存 / CPU（process.js:1158）
   - process.detail {pid,started_at,elapsed_s,exe,cwd,threads}       PID → 运行时长（process.js:740）
   - container.list {containers:[{name,image,state,running_for,ports:"0.0.0.0:8080->80/tcp"}]}  容器 → 宿主端口（container.js:670、topology.js:8）
   跨插件只读调用先例：web/app.js:1839（概览页调 discover.services）、web/topology.js:8（拓扑调 container.list + discover.ports）。
   增强调用失败（插件没装 / 版本旧 / 无权限）只影响对应的那一列与那张卡，主清单照常渲染。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/', TIMEOUT_MS = 12000;
  // 有界上限：关系卡、变化提示、进程详情都不得随端口数无限增长（手机与慢机器都要能开）。
  var BASE_KEY = 'kore.discover.baseline.v1';
  var MAX_REL_PORTS = 6;    // 单张关系卡最多平铺 6 个端口，其余折叠成「另 N 个」
  var MAX_UNOWNED = 12;     // 「未归属端口」卡最多列 12 个
  var MAX_DIFF = 8;         // 变化提示每类最多列 8 个
  var MAX_DETAILS = 12;     // 按需补运行时长的最多 PID 数（只取归属到已知服务的前 12 个）
  var MAX_PROCS = 400;      // process.list 拉取上限（插件硬上限 500）
  var MAX_PORT_ROWS = 20;   // 端口表首屏行数（「显示更多」每点一次 +20，过滤器可直接定位任意端口）
  var S = fresh();

  function fresh() {
    return { root: null, destroyed: false, busy: false,
      summary: null, summaryError: '', summaryCode: '',
      services: null, servicesError: '', servicesCode: '',
      ports: null, portsError: '', portsCode: '',
      config: null, configError: '',
      filter: '', onlyNew: false, portsShown: MAX_PORT_ROWS,
      // 增强数据：listeners（process.ports）/ procs（process.list）/ containers（container.list）/ details（process.detail）
      listeners: null, procs: null, containers: null, byPort: null, details: {},
      enr: { processPorts: '', processList: '', containers: '' }, enrichBusy: false,
      diff: null, diffReady: false, baseNote: '' };
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn, type) { n.addEventListener(type || 'click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    } return '';
  }
  // invokeOf 是所有插件调用的唯一入口：<id>.<method> 由后端按域路由，这里只拼路径。
  function invokeOf(plugin, method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + plugin + '/' + method, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        err.code = data.code || ''; err.hint = data.detail || data.hint || ''; err.status = res.status;
        throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }
  function invoke(method, params) { return invokeOf('discover', method, params); }

  // ---- 降级分类：三态 + 平台不支持，一律按「下一步」给按钮，不做点了才报错的按钮 ----
  function classify(err) {
    var code = (err && err.code) || '';
    var msg = (err && err.message) || '';
    if (code === 'E_CONFLICT' || /未启用|未安装|not installed/i.test(msg)) return 'notinstalled';
    if (code === 'E_NOTFOUND' && /未知方法|unknown method/i.test(msg)) return 'unsupported';
    if (code === 'E_NOTFOUND') return 'notinstalled';
    if (code === 'E_NEED_ROOT' || code === 'E_PERM' || code === 'E_DENIED') return 'noperm';
    if (code === 'E_UNSUPPORTED') return 'platform';
    if (err && err.status === 403) return 'noperm';
    return 'error';
  }
  // quietKind 把增强调用的失败压成一个短标签：missing = 没装/版本旧（用户去装就有），error = 其它。
  function quietKind(err) {
    var k = classify(err);
    return (k === 'notinstalled' || k === 'unsupported' || k === 'noperm' || k === 'platform') ? 'missing' : 'error';
  }
  function describe(err) {
    var kind = classify(err), title = '', lines = [], cmds = [], btn = '';
    if (kind === 'notinstalled') {
      title = '还没有安装「服务发现」插件';
      lines = ['这个页面读的是 discover 插件探测到的本机服务与端口。装上它之后刷新本页，' +
        '概览、端口列表就会自动出现——不需要再配任何参数。'];
      btn = 'discover';
    } else if (kind === 'unsupported') {
      title = '当前插件版本不支持这个能力';
      lines = ['后端返回「未知方法」，说明已装的 discover 版本比本页面旧。升级插件后本页会自动恢复。'];
      btn = 'upgrade';
    } else if (kind === 'noperm') {
      title = '没有权限读取端口对应的进程名';
      lines = ['端口本身能看到，但「哪个进程占用了它」需要 root 才能读（普通用户只能看到同 uid 的进程）。',
        'kore 的设计是让内核代理 root 动作（ADR-0018）：以 root 启动 kored 后刷新本页即可看到进程名。'];
      cmds = ['sudo systemctl restart kore'];
      btn = 'refresh';
    } else if (kind === 'platform') {
      title = '这个平台暂不支持真实探测';
      lines = ['discover 插件只在 Linux 上提供真实实现（当前平台会返回「不支持」）。'];
      btn = 'refresh';
    } else {
      title = '读取失败';
      lines = ['后端返回了错误，这不是登录失效。稍后重试；持续失败请查看插件日志。'];
      btn = 'refresh';
    }
    return { kind: kind, title: title, lines: lines, cmds: cmds, btn: btn, hint: (err && err.hint) || '' };
  }
  function goStore() { goView('store'); }
  function goPlugins() { goView('store/plugins'); }
  // 一级导航已收敛成「任务 → tab」（app.js HUB_DEFS）：子视图必须带父级键（monitor/process），
  // 裸 'process' 在 shell 里不是已知一级项，会被静默回落到概览——跳转等于没跳。
  var ROUTE_OF = { store: 'store', plugins: 'store/plugins', process: 'monitor/process',
    container: 'sites/container', db: 'db/db', redis: 'db/redis', sites: 'sites/sites' };
  function goView(id) {
    var route = ROUTE_OF[id] || id;
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate(route);
    else window.location.hash = '#/' + route;
  }
  function guideBlock(info, onRetry) {
    var box = el('div', 'disc-callout');
    box.setAttribute('role', 'status');
    add(box, el('div', 'disc-callout-title', info.title));
    info.lines.forEach(function (l) { add(box, el('p', 'disc-callout-text', l)); });
    (info.cmds || []).forEach(function (c) { add(box, el('pre', 'disc-cmd', c)); });
    var ops = add(box, el('div', 'disc-ops'));
    if (info.btn === 'discover') {
      var b = add(ops, el('button', 'btn btn-primary', '去软件商店安装'));
      b.type = 'button'; on(b, goStore);
    } else if (info.btn === 'upgrade') {
      var u = add(ops, el('button', 'btn btn-primary', '去已装插件升级'));
      u.type = 'button'; on(u, goPlugins);
    } else if (info.btn === 'plugins') {
      var p = add(ops, el('button', 'btn btn-primary', '查看已装插件'));
      p.type = 'button'; on(p, goPlugins);
    } else {
      var r = add(ops, el('button', 'btn btn-primary', '重新探测'));
      r.type = 'button'; on(r, onRetry || refreshAll);
    }
    if (info.hint) {
      var d = add(box, el('details', 'disc-details'));
      add(d, el('summary', null, '查看后端原始提示'));
      add(d, el('p', 'disc-callout-text', info.hint));
    }
    return box;
  }
  // ---- 「未知方法」不止一种情形，不能一律糊成「去升级」（appdeploy 犯过的错） ----
  // 先查已装列表：① 列表里没有 → 其实是没装；② 有新版 → 去升级真的能修；
  // ③ 已是最新仍缺方法 → 是主壳/页面与插件版本不配套，升级插件无从下手，如实说明。
  function getJSON(path) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(path, init).then(function (res) {
      if (timer !== null) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (e) { if (timer !== null) clearTimeout(timer); throw e; });
  }
  function loadInstalled() {
    return getJSON('/api/v1/plugins').then(function (d) { return (d && d.plugins) || []; },
      function () { return null; }); // null = 查询失败，不等于「未安装」
  }
  function describeUnsupported(err, rec, listed) {
    var base = describe(err);
    if (!listed) return base; // 查不到已装列表：保留原判据 + 原始提示，不猜
    if (!rec) {
      return { kind: 'notinstalled', title: '还没有安装「服务发现」插件',
        lines: ['后端返回「未知方法」，同时已装列表里没有 discover——说明这个插件还没装，不是版本旧。',
          '装上之后刷新本页，概览与端口列表就会自动出现。'],
        cmds: [], btn: 'discover', hint: base.hint };
    }
    if (rec.update_available && rec.latest_version) {
      return { kind: 'unsupported', title: '已装的 discover 比本页面旧',
        lines: ['后端返回「未知方法」——插件缺少本页面要调用的方法；软件商店已有新版本 v' +
          (rec.version || '?') + ' → v' + rec.latest_version + '。',
          '升级后本页自动恢复，插件配置与已有探测结果不受影响。'],
        cmds: [], btn: 'upgrade', hint: base.hint };
    }
    return { kind: 'unsupported', title: '插件已是最新，仍缺少本页面要调用的方法',
      lines: ['当前 discover v' + (rec.version || '?') + ' 已是索引里的最新版本，商店没有可升级的版本——所以「去升级」帮不上忙。',
        '这种情况意味着本页面与该插件版本不配套（主壳或页面比插件新）：请确认 kore 主壳是否也需要一起升级，或等待配套版本发布。',
        '在此之前本页保持不可用，不会显示半截数据。'],
      cmds: [], btn: 'plugins', hint: base.hint };
  }
  function gateUnsupported(err) {
    var host = S.gateHost;
    if (!host) return;
    host.textContent = ''; host.style.display = '';
    add(host, el('div', 'disc-loading', '正在确认已装插件版本…'));
    loadInstalled().then(function (list) {
      if (S.destroyed || S.gateHost !== host) return;
      var rec = null;
      if (list) { for (var i = 0; i < list.length; i++) if (list[i].id === 'discover') rec = list[i]; }
      host.textContent = '';
      host.appendChild(guideBlock(describeUnsupported(err, rec, list !== null), refreshAll));
    });
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  // badge 是「关系卡里的小标签」：不带状态点，只承载 pid / 容器名 / 变化标记这类短语。
  function badge(tone, text, title) {
    var b = el('span', 'disc-badge disc-badge-' + tone, text);
    if (title) b.setAttribute('title', title);
    return b;
  }
  function panel(title, metaText) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    return { panel: p, head: h, meta: add(h, el('span', 'panel-meta', metaText || '')) };
  }
  function metric(label, value, hint) {
    var c = el('div', 'disc-metric');
    add(c, el('span', 'disc-metric-label', label));
    add(c, el('span', 'disc-metric-value', value));
    if (hint) add(c, el('span', 'disc-metric-hint', hint));
    return c;
  }
  function jumpBtn(text, route, title) {
    var b = el('button', 'btn btn-ghost disc-jump', text);
    b.type = 'button'; if (title) b.setAttribute('title', title);
    on(b, function () { goView(route); });
    return b;
  }

  // ---- 格式化（单位一律跟着数字走，G-32 判据 11 的口径同样适用于读数卡） ----
  function fmtMem(kib) {
    if (!kib || kib < 0) return '';
    if (kib < 1024) return kib + ' KiB';
    var mib = kib / 1024;
    if (mib < 1024) return (mib >= 100 ? Math.round(mib) : mib.toFixed(1)) + ' MiB';
    return (mib / 1024).toFixed(2) + ' GiB';
  }
  function fmtCPU(pct) {
    if (pct === null || pct === undefined || isNaN(pct)) return '';
    return (pct >= 10 ? String(Math.round(pct)) : pct.toFixed(1)) + '%';
  }
  function fmtDur(sec) {
    if (sec === null || sec === undefined || sec < 0) return '';
    if (sec < 60) return Math.round(sec) + ' 秒';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时 ' + Math.floor((sec % 3600) / 60) + ' 分';
    return Math.floor(sec / 86400) + ' 天 ' + Math.floor((sec % 86400) / 3600) + ' 小时';
  }
  function fmtClock(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '';
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function fmtDay(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + fmtClock(iso);
  }

  // ---- 数据派生（全部来自真实返回，不做二次猜测） ----
  function foundServices() {
    return (S.services || []).filter(function (s) { return !!s.found; });
  }
  function listeningPorts() {
    return (S.ports || []).filter(function (p) { return !!p.listening; });
  }
  function procNameOf(p) {
    if (p && p.process) return String(p.process);
    return '';
  }
  // 端口 → PID：来自 process.ports 的 listeners（按端口匹配；同一端口 v4/v6 两条 listener 取第一个有效 pid）。
  function pidOf(port) {
    var ls = S.listeners;
    if (!ls) return 0;
    for (var i = 0; i < ls.length; i++) {
      if (ls[i] && ls[i].port === port && ls[i].pid) return ls[i].pid;
    }
    return 0;
  }
  function procOf(pid) {
    if (!pid || !S.procs) return null;
    return S.procs[pid] || null;
  }
  function detailOf(pid) {
    if (!pid) return null;
    return S.details[pid] || null;
  }
  // 容器 → 宿主端口：container.list 的 ports 是 docker 的展示串（"0.0.0.0:8080->80/tcp"），
  // 取箭头左侧最后一段数字。解析不出来就当没有，不臆造连线。
  function hostPortsOf(str) {
    var out = [], parts = String(str || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].replace(/^\s+|\s+$/g, ''), arrow = seg.indexOf('->');
      if (arrow < 0) continue;
      var host = seg.slice(0, arrow), colon = host.lastIndexOf(':');
      var num = parseInt(host.slice(colon + 1), 10);
      if (num > 0 && out.indexOf(num) < 0) out.push(num);
    }
    return out;
  }
  function containerIndex(list) {
    var idx = {};
    (list || []).forEach(function (c) {
      var ports = hostPortsOf(c && c.ports);
      for (var i = 0; i < ports.length; i++) if (!idx[ports[i]]) idx[ports[i]] = c;
    });
    return idx;
  }
  function containerOf(port) {
    return (S.byPort && S.byPort[port]) || null;
  }
  // 服务分型：只用于「服务目录 / 关系视图」分组，未知服务一律进「其他服务」。
  var TYPE_ORDER = ['web', 'db', 'cache', 'mw', 'runtime', 'container', 'system', 'other'];
  var TYPE_LABEL = { web: 'Web 服务', db: '数据库', cache: '缓存与消息', mw: '搜索与中间件',
    runtime: '语言运行时', container: '容器引擎', system: '系统工具', other: '其他服务' };
  var SERVICE_TYPE = { nginx: 'web', caddy: 'web', apache2: 'web', httpd: 'web', traefik: 'web',
    mysql: 'db', mariadb: 'db', postgres: 'db', mongodb: 'db',
    redis: 'cache', memcached: 'cache', rabbitmq: 'cache',
    elasticsearch: 'mw',
    php: 'runtime', node: 'runtime', python3: 'runtime',
    docker: 'container', podman: 'container',
    crontab: 'system', systemctl: 'system', ufw: 'system', iptables: 'system', 'firewall-cmd': 'system' };
  // 进程名 → 服务 id：mysqld 同时可能是 MySQL 或 MariaDB，所以给候选组，
  // 只有「已检测到的服务里恰好命中一个」才归属，否则算未归属（不猜）。
  var PROC_ALIAS = { mysqld: ['mysql', 'mariadb'], mariadbd: ['mariadb'], 'redis-server': ['redis'],
    nginx: ['nginx'], caddy: ['caddy'], httpd: ['httpd', 'apache2'], apache2: ['apache2'],
    postgres: ['postgres'], dockerd: ['docker'], containerd: ['docker', 'podman'],
    'php-fpm': ['php'], memcached: ['memcached'], 'cron': ['crontab'], crond: ['crontab'] };
  function typeOf(s) { return SERVICE_TYPE[s.id] || 'other'; }
  function serviceOfPort(port, procName) {
    var list = foundServices(), cand = null, i;
    for (i = 0; i < list.length; i++) {
      if (list[i].port === port) { if (list[i].running) return list[i]; if (!cand) cand = list[i]; }
    }
    if (cand) return cand;
    var ids = PROC_ALIAS[String(procName || '').toLowerCase()];
    if (!ids) return null;
    var hits = [];
    for (i = 0; i < list.length; i++) {
      for (var j = 0; j < ids.length; j++) if (list[i].id === ids[j]) hits.push(list[i]);
    }
    return hits.length === 1 ? hits[0] : null;
  }
  function ownerLabel(port, procName) {
    var s = serviceOfPort(port, procName);
    if (s) return s.name || s.id;
    if (procName) return '进程 ' + procName;
    return '';
  }
  // 端口去重：同一端口 v4/v6 各一条 listener，列表里只算一个（计数仍保留双栈口径说明）。
  function uniqByPort(ports) {
    var seen = {}, out = [];
    (ports || []).forEach(function (p) {
      if (!p || seen[p.port]) return;
      seen[p.port] = 1; out.push(p);
    });
    return out;
  }
  function serviceVersion(s) {
    if (s.version_source === 'server' && s.server_version) return s.server_version;
    if (s.version_source === 'client' && s.client_version) return s.client_version;
    if (s.client_version) return s.client_version;
    if (s.server_version) return s.server_version;
    return '';
  }
  function familyText(f) {
    if (f === 'ipv4') return 'IPv4';
    if (f === 'ipv6') return 'IPv6';
    return f || '—';
  }
  function isNewPort(port) {
    if (!S.diff || !S.diff.newPorts) return false;
    return S.diff.newPorts.indexOf(port) >= 0;
  }
  function matchPort(p, q) {
    if (!q) return true;
    var pid = pidOf(p.port), c = containerOf(p.port);
    var hay = String(p.port) + ' ' + String(p.process || '') + ' ' + String(p.addr || '') +
      ' ' + ownerLabel(p.port, procNameOf(p)) + (pid ? ' ' + pid : '') + (c ? ' ' + (c.name || '') : '');
    return hay.toLowerCase().indexOf(q) >= 0;
  }

  // ---- 上次扫描基线（localStorage）：只存端口号与服务 id+名，不存任何凭据 ----
  function readBaseline() {
    try {
      var raw = window.localStorage.getItem(BASE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.at || !o.ports) return null;
      return o;
    } catch (e) { return null; }
  }
  function writeBaseline(snap) {
    try { window.localStorage.setItem(BASE_KEY, JSON.stringify(snap)); return true; }
    catch (e) { return false; }
  }
  function snapshotNow() {
    var ports = uniqByPort(listeningPorts()).map(function (p) { return p.port; });
    ports.sort(function (a, b) { return a - b; });
    var svcs = foundServices().map(function (s) { return { id: s.id, name: s.name || s.id }; });
    return { at: new Date().toISOString(), ports: ports.slice(0, 400), services: svcs.slice(0, 100) };
  }
  function computeDiff(prev, cur) {
    if (!prev) return { first: true, at: cur.at };
    var prevPorts = prev.ports || [], curPorts = cur.ports || [];
    var prevIds = (prev.services || []).map(function (s) { return s.id; });
    var curIds = cur.services.map(function (s) { return s.id; });
    var newPorts = [], gonePorts = [], newServices = [], goneServices = [];
    curPorts.forEach(function (p) { if (prevPorts.indexOf(p) < 0) newPorts.push(p); });
    prevPorts.forEach(function (p) { if (curPorts.indexOf(p) < 0) gonePorts.push(p); });
    cur.services.forEach(function (s) { if (prevIds.indexOf(s.id) < 0) newServices.push(s); });
    (prev.services || []).forEach(function (s) { if (curIds.indexOf(s.id) < 0) goneServices.push(s); });
    return { first: false, at: prev.at, newPorts: newPorts, gonePorts: gonePorts,
      newServices: newServices, goneServices: goneServices };
  }
  // ---- ① 概览 ----
  function paintOverview() {
    if (!S.overviewHost) return;
    S.overviewHost.textContent = '';
    if (S.summaryError) { S.overviewHost.appendChild(guideBlock(describe(S.summaryError), refreshAll)); return; }
    if (!S.summary) { add(S.overviewHost, el('div', 'disc-loading', '正在读取本机服务发现结果…')); return; }
    var sm = S.summary, svc = foundServices(), ports = uniqByPort(listeningPorts());
    var docker = (svc.filter(function (s) { return s.id === 'docker'; })[0]) || null;
    var top = add(S.overviewHost, el('div', 'disc-status-top'));
    top.appendChild(chip(sm.ready ? 'ok' : 'warn', sm.ready ? '本机已就绪' : '暂未检测到可用服务'));
    add(top, el('span', 'disc-conclusion', sm.conclusion || ''));
    var grid = add(S.overviewHost, el('div', 'disc-metrics'));
    add(grid, metric('已检测服务', String(svc.length) + ' 个', '共探测 ' + String((S.services || []).length) + ' 项'));
    add(grid, metric('在听端口', String(uniqByPort(listeningPorts()).length) + ' 个', '同一端口 IPv4 / IPv6 各一条 listener，这里按端口去重'));
    add(grid, metric('Web 服务器', sm.web_server || '未检测到', sm.web_server ? '来自本机探测结果' : '可装 nginx / caddy'));
    add(grid, metric('数据库', sm.db || '未检测到', sm.db ? '来自本机探测结果' : '可装 MySQL / PostgreSQL'));
    add(grid, metric('容器运行时', docker ? '已检测到 Docker' : '未检测到',
      docker ? (docker.running ? '运行中' : '已安装，未在监听') : '可装 Docker 后用容器插件管理'));
    // 归属识别率：真实反映「非 root 看不到别的 uid 进程」这一限制，而不是假装全都有归属。
    var withProc = 0;
    ports.forEach(function (p) { if (procNameOf(p) || pidOf(p.port)) withProc++; });
    add(grid, metric('已识别归属', String(withProc) + ' / ' + String(ports.length) + ' 个端口',
      withProc < ports.length ? '其余端口需要管理员权限（root）才能读取进程，这是系统权限的限制' : '全部端口都识别到了进程'));
    // 建议：summary.suggestions 是插件的固定优先级建议，原样呈现，不加工。
    var sug = sm.suggestions || [];
    var box = add(S.overviewHost, el('div', 'disc-suggest'));
    add(box, el('div', 'disc-suggest-title', sug.length ? '接下来可以装这些插件（' + sug.length + ' 条建议）' : '暂时没有额外的安装建议'));
    if (sug.length) {
      var ul = add(box, el('ul', 'disc-suggest-list'));
      sug.forEach(function (s) {
        var li = add(ul, el('li', 'disc-suggest-item'));
        add(li, el('span', 'disc-suggest-plugin', s.plugin));
        add(li, el('span', 'disc-suggest-reason', s.reason));
      });
    }
    var ops = add(box, el('div', 'disc-ops'));
    var b = add(ops, el('button', 'btn btn-ghost', '去软件商店')); b.type = 'button'; on(b, goStore);
  }

  // ---- ② 变化提示：与上次扫描对比（新增 / 消失的端口与服务） ----
  function paintChange() {
    if (!S.changeHost) return;
    S.changeHost.textContent = '';
    if (!S.diffReady) { add(S.changeHost, el('div', 'disc-loading', '正在与上次扫描结果对比…')); return; }
    var d = S.diff;
    if (!d) {
      var warn = add(S.changeHost, el('div', 'disc-note'));
      add(warn, el('span', null, '浏览器不允许本页保存扫描基线（可能是隐私模式或本地存储被禁用），' +
        '所以看不到和上次的变化；端口与服务清单照常可用。'));
      return;
    }
    var head = add(S.changeHost, el('div', 'disc-change-head'));
    if (d.first) {
      if (S.baseNote) {
        head.appendChild(chip('warn', '基线未保存'));
        add(head, el('span', 'disc-change-text',
          '浏览器不允许本页保存扫描基线（可能是隐私模式或本地存储被禁用），所以这次看不到「和上次相比」的变化；' +
          '端口、关系与服务目录照常可用。'));
        return;
      }
      head.appendChild(chip('ok', '已记录为基线'));
      add(head, el('span', 'disc-change-text',
        '本次扫描已记为基线：在听 ' + String((S.diffSnap ? S.diffSnap.ports.length : uniqByPort(listeningPorts()).length)) +
        ' 个端口、已检测 ' + String(foundServices().length) + ' 个服务。下次打开本页时，这里会列出新增和消失的端口与服务。'));
      return;
    }
    var total = d.newPorts.length + d.gonePorts.length + d.newServices.length + d.goneServices.length;
    head.appendChild(chip(total ? 'warn' : 'ok', total ? '有变化' : '无变化'));
    add(head, el('span', 'disc-change-text', total
      ? '与上次扫描（' + fmtDay(d.at) + '）相比：新增端口 ' + d.newPorts.length + ' 个、消失端口 ' + d.gonePorts.length +
        ' 个、新增服务 ' + d.newServices.length + ' 个、消失服务 ' + d.goneServices.length + ' 个。'
      : '与上次扫描（' + fmtDay(d.at) + '）相比没有变化：在听 ' + String(uniqByPort(listeningPorts()).length) + ' 个端口、已检测 ' +
        String(foundServices().length) + ' 个服务。'));
    if (!total) return;
    var box = add(S.changeHost, el('div', 'disc-change-groups'));
    function group(label, tone, items, fmt) {
      if (!items.length) return;
      var g = add(box, el('div', 'disc-change-group'));
      add(g, el('span', 'disc-change-label', label + '（' + items.length + '）'));
      var wrap = add(g, el('div', 'disc-change-chips'));
      items.slice(0, MAX_DIFF).forEach(function (it) { wrap.appendChild(badge(tone, fmt(it))); });
      if (items.length > MAX_DIFF) add(wrap, el('span', 'disc-change-more', '另 ' + (items.length - MAX_DIFF) + ' 个'));
    }
    function portText(p) { return ':' + p; }
    group('新增端口', 'new', d.newPorts, portText);
    group('消失端口', 'gone', d.gonePorts, portText);
    group('新增服务', 'new', d.newServices, function (s) { return s.name || s.id; });
    group('消失服务', 'gone', d.goneServices, function (s) { return s.name || s.id; });
    var ops = add(S.changeHost, el('div', 'disc-ops'));
    if (d.newPorts.length) {
      var onlyNew = add(ops, el('button', 'btn btn-ghost', '只看新增端口'));
      onlyNew.type = 'button';
      on(onlyNew, function () {
        S.onlyNew = true;
        if (S.onlyNewInput) S.onlyNewInput.checked = true;
        paintPorts();
        if (S.portsPanel && S.portsPanel.scrollIntoView) S.portsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    var rb = add(ops, el('button', 'btn btn-ghost', '重新探测'));
    rb.type = 'button'; on(rb, function () { refreshAll(true); });
    add(S.changeHost, el('div', 'disc-note disc-note-small',
      '基线会在每次成功扫描后自动更新为本次结果；对比只在浏览器本地进行，不上报任何数据。'));
  }

  // ---- ③ 关系视图：服务 → 监听端口 → 进程 / 容器（纯 HTML/CSS 关系卡，不引图表库） ----
  function portsOfService(s) {
    var out = [], ports = uniqByPort(listeningPorts());
    for (var i = 0; i < ports.length; i++) {
      if (serviceOfPort(ports[i].port, procNameOf(ports[i])) === s) out.push(ports[i]);
    }
    return out;
  }
  function relationCard(s) {
    var card = el('article', 'disc-rel-card');
    var head = add(card, el('div', 'disc-rel-head'));
    add(head, el('span', 'disc-rel-name', s.name || s.id));
    head.appendChild(chip(s.running ? 'ok' : 'warn', s.running ? '运行中' : '未监听'));
    var ver = serviceVersion(s);
    if (ver) add(head, el('span', 'disc-rel-ver', ver));
    var ports = portsOfService(s);
    var body = add(card, el('div', 'disc-rel-ports'));
    if (!ports.length) {
      var none = add(body, el('div', 'disc-rel-empty'));
      add(none, el('span', null, s.port ? ('默认端口 ' + s.port + ' 上没有监听') : '没有可判定的监听端口'));
    } else {
      var shown = ports.slice(0, MAX_REL_PORTS);
      shown.forEach(function (p) {
        var row = add(body, el('div', 'disc-rel-port'));
        var portChip = add(row, el('span', 'disc-rel-portnum', ':' + p.port));
        if (isNewPort(p.port)) portChip.appendChild(badge('new', '新增'));
        var pid = pidOf(p.port), proc = procOf(pid), c = containerOf(p.port);
        var chain = add(row, el('div', 'disc-rel-chain'));
        var procText = procNameOf(p) || (proc && proc.name) || (pid ? ('pid ' + pid) : '');
        if (procText) {
          var b1 = badge('proc', procText, '监听该端口的进程');
          if (pid) b1.appendChild(el('span', 'disc-badge-sub', ' pid ' + pid));
          chain.appendChild(b1);
        } else {
          chain.appendChild(badge('muted', '进程未识别', '非 root 运行时只能看到同 uid 进程的 socket'));
        }
        if (c) {
          add(chain, el('span', 'disc-arrow', '→'));
          chain.appendChild(badge('container', c.name || c.id || '容器',
            '容器 ' + (c.image || '') + (c.running_for ? ' · 已运行 ' + c.running_for : '')));
        }
        if (proc) {
          var res = [fmtMem(proc.rss_kib), fmtCPU(proc.cpu_pct)].filter(function (x) { return !!x; }).join(' · ');
          if (res) chain.appendChild(el('span', 'disc-rel-res', res));
        }
      });
      if (ports.length > MAX_REL_PORTS) {
        add(body, el('div', 'disc-rel-more', '另 ' + (ports.length - MAX_REL_PORTS) + ' 个端口（在下方「监听端口」里看全量）'));
      }
    }
    var ops = add(card, el('div', 'disc-ops disc-rel-ops'));
    var pid0 = ports.length ? pidOf(ports[0].port) : 0;
    if (pid0) ops.appendChild(jumpBtn('看进程', 'process', '在进程页查看 pid ' + pid0));
    if (ports.length && containerOf(ports[0].port)) ops.appendChild(jumpBtn('看容器', 'container', '在容器页查看这个端口背后的容器'));
    if (typeOf(s) === 'db') ops.appendChild(jumpBtn('打开数据库', 'db', '去数据库页连接这个数据库'));
    if (typeOf(s) === 'cache') ops.appendChild(jumpBtn('打开 Redis', 'redis', '去 Redis 页查看这个缓存服务'));
    if (typeOf(s) === 'web') ops.appendChild(jumpBtn('管理网站', 'sites', '去网站页配置由它承载的站点'));
    return card;
  }
  function paintRelations() {
    if (!S.relHost) return;
    S.relHost.textContent = '';
    if (S.servicesError) { S.relHost.appendChild(guideBlock(describe(S.servicesError), refreshAll)); return; }
    if (!S.services) { add(S.relHost, el('div', 'disc-loading', '正在整理服务与端口的关系…')); return; }
    var svc = foundServices();
    var ports = uniqByPort(listeningPorts());
    var unowned = ports.filter(function (p) { return !serviceOfPort(p.port, procNameOf(p)); });
    var byType = {};
    svc.forEach(function (s) { var t = typeOf(s); (byType[t] = byType[t] || []).push(s); });
    var hasAny = false;
    TYPE_ORDER.forEach(function (t) {
      var list = byType[t];
      if (!list || !list.length) return;
      hasAny = true;
      var group = add(S.relHost, el('section', 'disc-rel-group'));
      var gh = add(group, el('div', 'disc-rel-group-head'));
      add(gh, el('span', 'disc-rel-group-title', TYPE_LABEL[t] || t));
      add(gh, el('span', 'disc-rel-group-meta', list.length + ' 个服务 · ' +
        String(list.reduce(function (n, s) { return n + portsOfService(s).length; }, 0)) + ' 个监听端口'));
      var cards = add(group, el('div', 'disc-rel-cards'));
      list.forEach(function (s) { cards.appendChild(relationCard(s)); });
    });
    if (unowned.length) {
      hasAny = true;
      var g2 = add(S.relHost, el('section', 'disc-rel-group'));
      var h2 = add(g2, el('div', 'disc-rel-group-head'));
      add(h2, el('span', 'disc-rel-group-title', '其他监听端口'));
      add(h2, el('span', 'disc-rel-group-meta', unowned.length + ' 个端口没有匹配到已知服务'));
      var wrap = add(g2, el('div', 'disc-rel-chips'));
      unowned.slice(0, MAX_UNOWNED).forEach(function (p) {
        var c = add(wrap, el('span', 'disc-rel-chip'));
        add(c, el('span', 'disc-rel-portnum', ':' + p.port));
        var name = procNameOf(p) || (pidOf(p.port) ? ('pid ' + pidOf(p.port)) : '');
        if (name) c.appendChild(badge('proc', name));
        if (isNewPort(p.port)) c.appendChild(badge('new', '新增'));
        var cn = containerOf(p.port);
        if (cn) c.appendChild(badge('container', cn.name || '容器'));
      });
      if (unowned.length > MAX_UNOWNED) add(g2, el('div', 'disc-rel-more', '另 ' + (unowned.length - MAX_UNOWNED) + ' 个，见下方「监听端口」'));
      var ops2 = add(g2, el('div', 'disc-ops'));
      ops2.appendChild(jumpBtn('去进程页看全部端口', 'process'));
    }
    if (!hasAny) {
      var empty = add(S.relHost, el('div', 'disc-empty'));
      add(empty, el('span', null, '没有可画成关系的服务或端口：本机还没装已知服务，或在听端口都是未识别的进程。'));
      var rb = add(empty, el('button', 'btn btn-primary', '重新探测')); rb.type = 'button';
      on(rb, function () { refreshAll(true); });
      return;
    }
    add(S.relHost, el('div', 'disc-note disc-note-small', enrichmentNote()));
  }
  // enrichmentNote 如实说明增强数据的来源与降级：只写「装了 / 没装」，不装作全部都有。
  function enrichmentNote() {
    var missing = [];
    if (S.enr.processPorts === 'missing' || S.enr.processList === 'missing') missing.push('process');
    if (S.enr.containers === 'missing') missing.push('container');
    if (!missing.length) return '端口 → 进程 PID / 资源来自 process 插件，容器归属来自 container 插件（只读调用）。';
    var names = { process: '进程（process）', container: '容器（container）' };
    return '没装 ' + missing.map(function (m) { return names[m] || m; }).join(' / ') +
      ' 插件，所以对应列显示为「—」；装上之后本页自动补全，不需要重新配置。';
  }

  // ---- ④ 服务目录：按服务类型分组，端口 / 进程 / PID / 运行时长 / 资源占用 + 跳转 ----
  function serviceRows(s) {
    var ports = portsOfService(s);
    var pid = 0, proc = null, det = null, container = null;
    for (var i = 0; i < ports.length; i++) {
      pid = pidOf(ports[i].port);
      if (pid) break;
    }
    if (pid) { proc = procOf(pid); det = detailOf(pid); }
    for (var j = 0; j < ports.length; j++) {
      container = containerOf(ports[j].port);
      if (container) break;
    }
    var uptime = '';
    if (det && det.elapsed_s !== undefined && det.elapsed_s !== null) uptime = fmtDur(det.elapsed_s);
    else if (container && container.running_for) uptime = container.running_for;
    var res = proc ? [fmtMem(proc.rss_kib), fmtCPU(proc.cpu_pct)].filter(function (x) { return !!x; }).join(' · ') : '';
    return { ports: ports, pid: pid, proc: proc, det: det, container: container, uptime: uptime, res: res };
  }
  function portCell(ports) {
    if (!ports.length) return null;
    var wrap = el('span', 'disc-portlist');
    ports.slice(0, MAX_REL_PORTS).forEach(function (p, i) {
      if (i) add(wrap, el('span', 'disc-sep', '、'));
      var t = add(wrap, el('span', 'disc-portnum', String(p.port)));
      if (isNewPort(p.port)) t.appendChild(badge('new', '新增'));
    });
    if (ports.length > MAX_REL_PORTS) add(wrap, el('span', 'disc-sep', ' 另 ' + (ports.length - MAX_REL_PORTS) + ' 个'));
    return wrap;
  }
  function paintCatalog() {
    if (!S.catalogHost) return;
    S.catalogHost.textContent = '';
    if (S.servicesError) { S.catalogHost.appendChild(guideBlock(describe(S.servicesError), refreshAll)); return; }
    if (!S.services) { add(S.catalogHost, el('div', 'disc-loading', '正在读取本机服务目录…')); return; }
    var svc = foundServices();
    if (S.catalogMeta) S.catalogMeta.textContent = '已检测到 ' + svc.length + ' 个服务 / 共探测 ' + (S.services || []).length + ' 项';
    if (!svc.length) {
      var empty = add(S.catalogHost, el('div', 'disc-empty'));
      add(empty, el('span', null, '本机没有检测到任何已知服务（nginx / MySQL / Redis / Docker 等）。'));
      var rb = add(empty, el('button', 'btn btn-primary', '重新探测')); rb.type = 'button';
      on(rb, function () { refreshAll(true); });
      return;
    }
    var byType = {};
    svc.forEach(function (s) { var t = typeOf(s); (byType[t] = byType[t] || []).push(s); });
    TYPE_ORDER.forEach(function (t) {
      var list = byType[t];
      if (!list || !list.length) return;
      var group = add(S.catalogHost, el('section', 'disc-cat-group'));
      var gh = add(group, el('div', 'disc-cat-group-head'));
      add(gh, el('span', 'disc-cat-group-title', TYPE_LABEL[t] || t));
      add(gh, el('span', 'disc-cat-group-meta', list.length + ' 个'));
      var wrap = add(group, el('div', 'disc-table-wrap'));
      var table = add(wrap, el('table', 'plugin-table disc-table disc-cat-table'));
      table.setAttribute('aria-label', '服务目录：' + (TYPE_LABEL[t] || t));
      var thead = add(table, el('thead')), hr = add(thead, el('tr'));
      ['服务', '版本', '状态', '端口', '进程 / PID', '运行时长', '资源占用', '操作'].forEach(function (h) {
        var th = add(hr, el('th', null, h)); th.setAttribute('scope', 'col');
      });
      var tbody = add(table, el('tbody'));
      list.forEach(function (s) {
        var row = serviceRows(s);
        var tr = add(tbody, el('tr'));
        var tdName = add(tr, el('td', null, s.name || s.id)); tdName.setAttribute('data-label', '服务');
        var ver = add(tr, el('td', 'disc-mono', serviceVersion(s) || '未获取'));
        ver.setAttribute('data-label', '版本');
        if (s.version_hint) { ver.setAttribute('title', s.version_hint); ver.classList.add('disc-muted'); }
        var st = add(tr, el('td'));
        st.setAttribute('data-label', '状态');
        st.appendChild(chip(s.running ? 'ok' : 'warn', s.running ? '运行中' : '未监听'));
        if (s.running_hint) st.setAttribute('title', s.running_hint);
        var tdPort = add(tr, el('td', 'disc-num'));
        tdPort.setAttribute('data-label', '端口');
        var pc = portCell(row.ports);
        if (pc) tdPort.appendChild(pc); else tdPort.textContent = s.port ? String(s.port) + '（未监听）' : '—';
        var tdProc = add(tr, el('td', 'disc-mono'));
        tdProc.setAttribute('data-label', '进程 / PID');
        var pname = row.proc ? row.proc.name : '';
        if (row.pid) {
          tdProc.textContent = (pname || '进程') + ' · ' + row.pid;
        } else {
          tdProc.textContent = '—';
          tdProc.classList.add('disc-muted');
          tdProc.setAttribute('title', '非 root 运行时只能看到同 uid 进程的 socket，进程名与 PID 可能为空');
        }
        var tdUp = add(tr, el('td', 'disc-num', row.uptime || '—'));
        tdUp.setAttribute('data-label', '运行时长');
        if (row.container && row.uptime) tdUp.setAttribute('title', '运行时长来自容器状态：' + (row.container.status || ''));
        var tdRes = add(tr, el('td', 'disc-mono', row.res || '—'));
        tdRes.setAttribute('data-label', '资源占用');
        if (row.res) tdRes.setAttribute('title', '常驻内存 ' + fmtMem(row.proc && row.proc.rss_kib) + ' · CPU ' + fmtCPU(row.proc && row.proc.cpu_pct) + '（process.list 采样）');
        var tdOps = add(tr, el('td'));
        tdOps.setAttribute('data-label', '操作');
        var ops = add(tdOps, el('div', 'disc-row-ops'));
        if (row.pid) ops.appendChild(jumpBtn('看进程', 'process', '去进程页查看 pid ' + row.pid));
        if (row.container) ops.appendChild(jumpBtn('看容器', 'container', '去容器页查看 ' + (row.container.name || '容器')));
        if (t === 'db') ops.appendChild(jumpBtn('打开数据库', 'db'));
        if (t === 'cache') ops.appendChild(jumpBtn('打开 Redis', 'redis'));
        if (!ops.childNodes.length) add(ops, el('span', 'disc-muted', '—'));
      });
    });
    add(S.catalogHost, el('div', 'disc-note disc-note-small', enrichmentNote()));
  }

  // ---- ⑤ 端口表（前端过滤，不轮询；新增端口显著标记） ----
  function paintPorts() {
    if (!S.portsHost) return;
    S.portsHost.textContent = '';
    if (S.portsError) { S.portsHost.appendChild(guideBlock(describe(S.portsError), refreshAll)); return; }
    if (!S.ports) { add(S.portsHost, el('div', 'disc-loading', '正在读取监听端口…')); return; }
    var all = uniqByPort(S.ports.filter(function (p) { return !!p.listening; }));
    var q = S.filter.trim().toLowerCase();
    var rows = all.filter(function (p) { return matchPort(p, q); });
    if (S.onlyNew) rows = rows.filter(function (p) { return isNewPort(p.port); });
    var shown = rows.slice(0, S.portsShown);
    if (S.portsMeta) {
      S.portsMeta.textContent = '在听 ' + all.length + ' 个' + (q ? '，匹配 ' + rows.length + ' 个' : '') +
        (S.onlyNew ? '，只看新增' : '') + (rows.length > shown.length ? '，当前显示 ' + shown.length + ' 个' : '');
    }
    if (!all.length) {
      var empty = add(S.portsHost, el('div', 'disc-empty'));
      add(empty, el('span', null, '没有发现任何监听端口。可能刚启动、或服务都被防火墙挡住了。'));
      var rb = add(empty, el('button', 'btn btn-primary', '重新探测')); rb.type = 'button';
      on(rb, function () { refreshAll(true); });
      return;
    }
    if (!rows.length) {
      var none = add(S.portsHost, el('div', 'disc-empty'));
      add(none, el('span', null, S.onlyNew ? '这次扫描没有新增端口。' :
        ('没有端口或进程名匹配「' + S.filter.trim() + '」。')));
      var cb = add(none, el('button', 'btn btn-ghost', S.onlyNew ? '看全部端口' : '清空过滤')); cb.type = 'button';
      on(cb, function () {
        if (S.onlyNew) { S.onlyNew = false; if (S.onlyNewInput) S.onlyNewInput.checked = false; }
        else { S.filter = ''; if (S.filterInput) S.filterInput.value = ''; }
        paintPorts();
      });
      return;
    }
    var wrap = add(S.portsHost, el('div', 'disc-table-wrap'));
    var table = add(wrap, el('table', 'plugin-table disc-table'));
    table.setAttribute('aria-label', '监听端口列表');
    var thead = add(table, el('thead')), hr = add(thead, el('tr'));
    ['端口', '协议', '归属', '进程 / PID', '容器', '监听地址'].forEach(function (t) {
      var th = add(hr, el('th', null, t)); th.setAttribute('scope', 'col');
    });
    var tbody = add(table, el('tbody'));
    shown.forEach(function (p) {
      var tr = add(tbody, el('tr'));
      if (isNewPort(p.port)) tr.classList.add('disc-row-new');
      var tdPort = add(tr, el('td', 'disc-num')); tdPort.setAttribute('data-label', '端口');
      add(tdPort, el('span', null, String(p.port)));
      if (isNewPort(p.port)) tdPort.appendChild(badge('new', '新增'));
      var tdFam = add(tr, el('td', null, familyText(p.family))); tdFam.setAttribute('data-label', '协议');
      var owner = ownerLabel(p.port, procNameOf(p)) || '未识别';
      var tdOwn = add(tr, el('td', null, owner)); tdOwn.setAttribute('data-label', '归属');
      var pid = pidOf(p.port), proc = procOf(pid);
      var tdProc = add(tr, el('td', 'disc-mono')); tdProc.setAttribute('data-label', '进程 / PID');
      var pname = procNameOf(p) || (proc && proc.name) || '';
      if (pname || pid) tdProc.textContent = (pname || '进程') + (pid ? ' · ' + pid : '');
      else {
        tdProc.textContent = '—';
        tdProc.setAttribute('title', '非 root 运行时只能看到同 uid 进程的 socket，进程名可能为空');
        tdProc.classList.add('disc-muted');
      }
      var c = containerOf(p.port);
      var tdC = add(tr, el('td', 'disc-mono')); tdC.setAttribute('data-label', '容器');
      if (c) tdC.textContent = c.name || c.id || '容器';
      else { tdC.textContent = '—'; tdC.classList.add('disc-muted'); }
      var addr = add(tr, el('td', 'disc-mono', p.addr || '—')); addr.setAttribute('data-label', '监听地址');
    });
    // 有界：默认只渲染前 20 行（手机整页高度与 DOM 体积不随端口数膨胀），其余按需展开。
    if (rows.length > shown.length) {
      var more = add(S.portsHost, el('div', 'disc-more'));
      var mb = add(more, el('button', 'btn btn-ghost', '显示更多（还剩 ' + (rows.length - shown.length) + ' 个）'));
      mb.type = 'button';
      on(mb, function () { S.portsShown += MAX_PORT_ROWS; paintPorts(); });
    }
  }

  function hideAll(show) {
    [S.overviewPanel, S.changePanel, S.relPanel, S.catalogPanel, S.portsPanel].forEach(function (p) {
      if (p) p.style.display = show ? '' : 'none';
    });
  }
  function paintAll() {
    paintOverview(); paintChange(); paintRelations(); paintCatalog(); paintPorts();
  }

  function refreshAll(force) {
    if (S.busy || S.destroyed) return;
    S.busy = true;
    S.portsShown = MAX_PORT_ROWS;
    S.summaryError = S.portsError = S.servicesError = '';
    S.summary = S.ports = S.services = null;
    paintAll();
    var params = force ? { refresh: true } : {};
    var calls = [
      invoke('discover.summary', params).then(function (d) { S.summary = d || {}; },
        function (e) { S.summaryError = e; }),
      invoke('discover.ports', params).then(function (d) { S.ports = Array.isArray(d) ? d : []; },
        function (e) { S.portsError = e; }),
      invoke('discover.services', params).then(function (d) { S.services = Array.isArray(d) ? d : []; },
        function (e) { S.servicesError = e; })
    ];
    return Promise.all(calls).then(function () {
      S.busy = false;
      if (S.destroyed) return;
      // 三态里有任一命中「未装 / 不支持」就整页收成单张空态，不展示半截数据。
      var firstErr = S.summaryError || S.portsError || S.servicesError;
      var kind = firstErr ? classify(firstErr) : '';
      if (kind === 'notinstalled') {
        hideAll(false);
        if (S.gateHost) { S.gateHost.textContent = ''; S.gateHost.style.display = ''; S.gateHost.appendChild(guideBlock(describe(firstErr), refreshAll)); }
        return;
      }
      if (kind === 'unsupported') { hideAll(false); gateUnsupported(firstErr); return; }
      hideAll(true);
      if (S.gateHost) { S.gateHost.textContent = ''; S.gateHost.style.display = 'none'; }
      // 变化对比：读旧基线 → 算差异 → 写新基线。基线只存端口号 / 服务 id，存不进就如实说。
      var prev = readBaseline();
      var snap = snapshotNow();
      S.diffSnap = snap;
      S.diff = computeDiff(prev, snap);
      S.diffReady = true;
      S.baseNote = writeBaseline(snap) ? '' : 'localStorage 不可用';
      paintAll();
      return loadEnrich();
    });
  }

  // ---- 增强数据：process / container 插件（未装或版本旧 → 对应列整块降级，不阻塞主清单） ----
  function loadEnrich() {
    if (S.enrichBusy || S.destroyed) return Promise.resolve();
    S.enrichBusy = true;
    var jobs = [];
    jobs.push(invokeOf('process', 'process.ports', {}).then(function (r) {
      S.listeners = (r && Array.isArray(r.listeners)) ? r.listeners : [];
      S.enr.processPorts = 'ok';
    }, function (e) { S.listeners = null; S.enr.processPorts = quietKind(e); }));
    jobs.push(invokeOf('process', 'process.list', { sort: 'mem', limit: MAX_PROCS }).then(function (r) {
      var items = (r && Array.isArray(r.items)) ? r.items : [];
      var map = {};
      for (var i = 0; i < items.length; i++) map[items[i].pid] = items[i];
      S.procs = map;
      S.enr.processList = 'ok';
    }, function (e) { S.procs = null; S.enr.processList = quietKind(e); }));
    jobs.push(invokeOf('container', 'container.list', { all: false }).then(function (r) {
      var list = (r && Array.isArray(r.containers)) ? r.containers : [];
      S.containers = list; S.byPort = containerIndex(list);
      S.enr.containers = 'ok';
    }, function (e) { S.containers = null; S.byPort = null; S.enr.containers = quietKind(e); }));
    return Promise.all(jobs).then(function () {
      S.enrichBusy = false;
      if (S.destroyed) return;
      paintAll();
      return loadDetails();
    });
  }
  // 运行时长来自 process.detail；只对「归属到已知服务」的前 MAX_DETAILS 个 PID 发请求（有界，不逐端口打）。
  function ownerPids() {
    var ports = uniqByPort(listeningPorts()), out = [], seen = {};
    var ordered = ports.filter(function (p) { return !!serviceOfPort(p.port, procNameOf(p)); })
      .concat(ports.filter(function (p) { return !serviceOfPort(p.port, procNameOf(p)); }));
    for (var i = 0; i < ordered.length && out.length < MAX_DETAILS; i++) {
      var pid = pidOf(ordered[i].port);
      if (pid && !seen[pid]) { seen[pid] = 1; out.push(pid); }
    }
    return out;
  }
  function loadDetails() {
    var pids = ownerPids();
    if (!pids.length) return Promise.resolve();
    var jobs = pids.map(function (pid) {
      return invokeOf('process', 'process.detail', { pid: pid }).then(function (d) {
        if (d && !S.destroyed) S.details[pid] = d;
      }, function () { /* 单个 PID 读不到不影响其它行 */ });
    });
    return Promise.all(jobs).then(function () { if (!S.destroyed) paintAll(); });
  }

  function injectCSS() {
    if (document.getElementById('kore-discover-css')) return;
    var css = buildCSS();
    var style = el('style', null, css); style.id = 'kore-discover-css';
    document.head.appendChild(style);
  }
  function buildCSS() {
    return [
      '.disc-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.disc-metric{display:flex;flex-direction:column;gap:2px;padding:var(--kore-space-3);background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-card,10px);}',
      '.disc-metric-label{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-metric-value{color:var(--kore-text-1);font-size:var(--kore-font-20,22px);font-weight:600;font-variant-numeric:tabular-nums;}',
      '.disc-metric-hint{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-status-top{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.disc-conclusion{color:var(--kore-text-2);font-size:var(--kore-font-13);flex:1 1 260px;}',
      '.disc-suggest{margin:var(--kore-space-3) var(--kore-space-4) var(--kore-space-4);padding:var(--kore-space-3);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);background:var(--kore-bg-1);}',
      '.disc-suggest-title{color:var(--kore-text-2);font-size:var(--kore-font-13);margin-bottom:var(--kore-space-2);}',
      '.disc-suggest-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--kore-space-1);}',
      '.disc-suggest-item{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);align-items:baseline;font-size:var(--kore-font-13);}',
      '.disc-suggest-plugin{flex:0 0 auto;padding:0 6px;border-radius:4px;background:var(--kore-bg-2);color:var(--kore-info);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.disc-suggest-reason{color:var(--kore-text-2);flex:1 1 240px;}',
      '.disc-callout{margin:var(--kore-space-3) var(--kore-space-4);padding:var(--kore-space-3);border:1px solid var(--kore-border-2);border-left:3px solid var(--kore-warn,#d9a441);border-radius:var(--kore-radius-control);background:var(--kore-bg-1);}',
      '.disc-callout-title{color:var(--kore-text-1);font-size:var(--kore-font-14);font-weight:600;margin-bottom:var(--kore-space-2);}',
      '.disc-callout-text{margin:0 0 var(--kore-space-1);color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.6;}',
      '.disc-cmd{margin:var(--kore-space-1) 0;padding:var(--kore-space-2) var(--kore-space-3);overflow-x:auto;color:var(--kore-term-cyan);background:var(--kore-bg-0);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.disc-ops{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);margin-top:var(--kore-space-2);}',
      '.disc-table-wrap{overflow-x:auto;padding:0 var(--kore-space-2) var(--kore-space-2);}',
      '.disc-table{width:100%;border-collapse:collapse;}',
      '.disc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.disc-num{font-variant-numeric:tabular-nums;}',
      '.disc-muted{color:var(--kore-text-3);}',
      '.disc-empty{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-4);color:var(--kore-text-3);font-size:var(--kore-font-13);}',
      '.disc-empty span{flex:1 1 260px;}',
      '.disc-loading{padding:var(--kore-space-4);color:var(--kore-text-3);font-size:var(--kore-font-13);}',
      '.disc-filter{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.disc-filter input{flex:1 1 240px;min-height:44px;}',
      '.disc-filter .disc-check{display:inline-flex;align-items:center;gap:var(--kore-space-2);min-height:44px;color:var(--kore-text-2);font-size:var(--kore-font-13);}',
      '.disc-filter .disc-check input{flex:0 0 auto;min-height:0;width:18px;height:18px;}',
      // 变化提示
      '.disc-change-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.disc-change-text{color:var(--kore-text-2);font-size:var(--kore-font-13);flex:1 1 260px;line-height:1.6;}',
      '.disc-change-groups{display:flex;flex-direction:column;gap:var(--kore-space-2);padding:var(--kore-space-2) var(--kore-space-4) 0;}',
      '.disc-change-group{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);align-items:center;}',
      '.disc-change-label{color:var(--kore-text-3);font-size:var(--kore-font-12);flex:0 0 auto;}',
      '.disc-change-chips{display:flex;flex-wrap:wrap;gap:var(--kore-space-1);align-items:center;}',
      '.disc-change-more{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      // 小标签
      '.disc-badge{display:inline-flex;align-items:center;gap:2px;padding:0 6px;border-radius:4px;font-size:var(--kore-font-12);line-height:20px;border:1px solid transparent;white-space:nowrap;}',
      '.disc-badge-sub{color:var(--kore-text-3);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
      '.disc-badge-new{color:var(--kore-ok,#2ea86b);background:rgba(46,168,107,.12);border-color:rgba(46,168,107,.35);}',
      '.disc-badge-gone{color:var(--kore-text-3);background:var(--kore-bg-2);border-color:var(--kore-border-2);text-decoration:line-through;}',
      '.disc-badge-proc{color:var(--kore-text-2);background:var(--kore-bg-2);border-color:var(--kore-border-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
      '.disc-badge-container{color:var(--kore-info);background:rgba(64,140,255,.12);border-color:rgba(64,140,255,.35);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
      '.disc-badge-muted{color:var(--kore-text-3);background:var(--kore-bg-1);border-color:var(--kore-border-2);}',
      // 关系卡
      '.disc-rel-group{padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.disc-rel-group-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--kore-space-2);margin-bottom:var(--kore-space-2);}',
      '.disc-rel-group-title{color:var(--kore-text-1);font-size:var(--kore-font-14);font-weight:600;}',
      '.disc-rel-group-meta{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-rel-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:var(--kore-space-2);}',
      '.disc-rel-card{display:flex;flex-direction:column;gap:var(--kore-space-2);padding:var(--kore-space-3);background:var(--kore-bg-1);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-card,10px);}',
      '.disc-rel-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);}',
      '.disc-rel-name{color:var(--kore-text-1);font-size:var(--kore-font-13);font-weight:600;}',
      '.disc-rel-ver{color:var(--kore-text-3);font-size:var(--kore-font-12);margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
      '.disc-rel-ports{display:flex;flex-direction:column;gap:var(--kore-space-1);}',
      '.disc-rel-port{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:4px 0;border-top:1px dashed var(--kore-border-2);}',
      '.disc-rel-port:first-child{border-top:0;}',
      '.disc-rel-portnum{color:var(--kore-text-1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-13);font-variant-numeric:tabular-nums;}',
      '.disc-rel-chain{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-1);}',
      '.disc-arrow{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-rel-res{color:var(--kore-text-3);font-size:var(--kore-font-12);font-variant-numeric:tabular-nums;}',
      '.disc-rel-empty{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-rel-more{color:var(--kore-text-3);font-size:var(--kore-font-12);padding-top:4px;}',
      '.disc-rel-ops{margin-top:auto;}',
      '.disc-rel-chips{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);}',
      '.disc-rel-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;background:var(--kore-bg-1);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);}',
      // 服务目录
      '.disc-cat-group{padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.disc-cat-group-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--kore-space-2);margin-bottom:var(--kore-space-1);}',
      '.disc-cat-group-title{color:var(--kore-text-1);font-size:var(--kore-font-14);font-weight:600;}',
      '.disc-cat-group-meta{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-row-ops{display:flex;flex-wrap:wrap;gap:var(--kore-space-1);}',
      '.disc-row-ops .btn{min-height:32px;padding:0 8px;font-size:var(--kore-font-12);}',
      '.disc-portlist{display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px;}',
      '.disc-sep{color:var(--kore-text-3);}',
      '.disc-portnum{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums;}',
      '.disc-row-new{background:rgba(46,168,107,.06);}',
      '.disc-note{padding:var(--kore-space-2) var(--kore-space-4) var(--kore-space-3);color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.6;}',
      '.disc-note-small{font-size:var(--kore-font-12);}',
      '.disc-more{display:flex;justify-content:center;padding:0 var(--kore-space-4) var(--kore-space-3);}',
      // 手机：关系卡单列、目录表转卡片行、跳转按钮撑到 44px 触摸目标（裁决41）
      '@media (max-width:639px){',
      '.disc-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}',
      '.disc-table,.disc-table tbody,.disc-table tr,.disc-table td{display:block;width:100%;}',
      '.disc-table tr{padding:var(--kore-space-2) 0 var(--kore-space-3);}',
      '.disc-table td{display:flex;gap:var(--kore-space-3);}',
      '.disc-table td::before{content:attr(data-label);flex:0 0 72px;color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.disc-metrics{grid-template-columns:1fr;}',
      '.disc-rel-cards{grid-template-columns:1fr;}',
      '.disc-cat-group,.disc-rel-group{padding-left:var(--kore-space-3);padding-right:var(--kore-space-3);}',
      '.disc-row-ops .btn,.disc-ops .btn,.disc-empty .btn{min-height:44px;}',
      '}'
    ].join('\n');
  }

  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    injectCSS();
    S.root = add(container, el('section', 'discover'));
    var head = add(S.root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '服务发现'));
    add(head, el('p', 'view-sub', '这台机器上装了什么、谁在监听哪个端口、属于哪个服务或容器——一眼看清，还能看到和上次相比多了什么。'));
    var headOps = add(head, el('div', 'actions'));
    var rf = add(headOps, el('button', 'btn btn-ghost', '重新探测')); rf.type = 'button';
    on(rf, function () { refreshAll(true); });
    S.gateHost = add(S.root, el('div', 'disc-gate')); S.gateHost.style.display = 'none';

    // ① 概览
    var ov = panel('概览', '插件 discover.summary + services + ports');
    add(S.root, ov.panel); S.overviewPanel = ov.panel;
    S.overviewHost = add(ov.panel, el('div', 'disc-overview'));

    // ② 变化提示
    var ch = panel('与上次扫描对比', '本机浏览器记录，不上报');
    add(S.root, ch.panel); S.changePanel = ch.panel;
    S.changeHost = add(ch.panel, el('div', 'disc-change'));

    // ③ 关系视图
    var rel = panel('服务关系', '服务 → 端口 → 进程 / 容器');
    add(S.root, rel.panel); S.relPanel = rel.panel;
    S.relHost = add(rel.panel, el('div', 'disc-rel'));

    // ④ 服务目录
    var cat = panel('服务目录', '按服务类型分组');
    add(S.root, cat.panel); S.catalogPanel = cat.panel;
    S.catalogMeta = add(cat.meta, el('span', null, ''));
    S.catalogHost = add(cat.panel, el('div', 'disc-catalog'));

    // ⑤ 监听端口
    var pt = panel('监听端口', '前端过滤，不轮询');
    add(S.root, pt.panel); S.portsPanel = pt.panel;
    S.portsMeta = add(pt.meta, el('span', null, ''));
    var filter = add(pt.panel, el('div', 'disc-filter'));
    var fl = add(filter, el('label', 'field'));
    add(fl, el('span', 'field-label', '按端口或进程名过滤'));
    S.filterInput = add(fl, el('input', 'field-input'));
    S.filterInput.type = 'search'; S.filterInput.placeholder = '例如 3306 / nginx / 127.0.0.1';
    S.filterInput.setAttribute('autocomplete', 'off');
    S.filterInput.id = 'disc-port-filter';
    on(S.filterInput, function () { S.filter = S.filterInput.value; S.portsShown = MAX_PORT_ROWS; paintPorts(); }, 'input');
    var chk = add(filter, el('label', 'disc-check'));
    S.onlyNewInput = add(chk, el('input'));
    S.onlyNewInput.type = 'checkbox'; S.onlyNewInput.id = 'disc-only-new';
    on(S.onlyNewInput, function () { S.onlyNew = !!S.onlyNewInput.checked; S.portsShown = MAX_PORT_ROWS; paintPorts(); }, 'change');
    add(chk, el('span', null, '只看新增端口'));
    S.portsHost = add(pt.panel, el('div', 'disc-ports'));

    refreshAll(false);
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreDiscover = { render: render };
})();
