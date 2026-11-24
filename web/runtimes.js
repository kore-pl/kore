/* kore 主壳 · 运行环境（web/runtimes.js）—— Node.js / PHP / Python 三 tab 一页管理。
   调用形态：POST /api/v1/invoke/runtime-<lang>/runtime-<lang>.<action>（完整限定名，插件不认裸动词）。
   方法：versions / info / projects / doctor，全部只读探测；tab 切换只重绘本页，不换 hash、不重载。
   每 tab 的扫描根目录写 localStorage；doctor 的 detail 原样展示，不编造结论。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/', TIMEOUT = 20000, LS = 'kore.runtimes.root.';
  var SRC = { path: 'PATH', known_path: tr('runtimes.src.known', '常用路径'), nvm: 'nvm', pyenv: 'pyenv', phpenv: 'phpenv', conda: 'conda' };
  var CHECK = { node: tr('runtimes.check.node', 'Node 安装'), npm: tr('runtimes.check.npm', 'npm 可用性'), global_packages_writable: tr('runtimes.check.globalWritable', '全局包目录可写'),
    node_env: tr('runtimes.check.nodeEnv', 'NODE_ENV 环境变量'), php: tr('runtimes.check.php', 'PHP 安装'), version_supported: tr('runtimes.check.versionSupport', '版本支持'), extensions: tr('runtimes.check.extensions', '扩展列表'),
    memory_limit: tr('runtimes.check.memoryLimit', '内存上限'), ini_loaded: tr('runtimes.check.iniLoaded', 'php.ini 加载'), python: tr('runtimes.check.python', 'Python 安装'), pip: tr('runtimes.check.pip', 'pip 可用性'),
    venv: tr('runtimes.check.venv', 'venv 支持'), site_packages: tr('runtimes.check.siteWritable', 'site-packages 可写') };
  var FIX = /(apt install [a-zA-Z0-9_.+-]+|export [A-Z_][A-Z0-9_]*=[^\s；;，,]+|nvm install --lts|pyenv install [0-9.]+|pip install [a-zA-Z0-9_.+-]+)/;
  var CSS =
    '.rt-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.rt-title{margin:0;font-size:var(--kore-font-16);font-weight:600}.rt-sub{margin:4px 0 0;color:var(--kore-text-3);font-size:var(--kore-font-12)}.rt-tabs{display:flex;gap:4px;margin:12px 0;border-bottom:1px solid var(--kore-border-1)}.rt-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--kore-text-3);padding:8px 16px;font-size:var(--kore-font-14);cursor:pointer}.rt-tab:hover{color:var(--kore-text-1)}.rt-tab.is-active{color:var(--kore-text-1);border-bottom-color:var(--kore-info)}' +
    '.rt-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin-bottom:12px;background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:4px;font-size:var(--kore-font-13)}.rt-scroll{overflow-x:auto}' +
    '.rt-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-12);min-width:520px}.rt-table th{text-align:left;padding:8px 12px;color:var(--kore-text-3);font-weight:500;border-bottom:1px solid var(--kore-border-2);white-space:nowrap}.rt-table td{padding:8px 12px;border-bottom:1px solid var(--kore-border-2);vertical-align:top}' +
    '.rt-row{cursor:pointer}.rt-row:hover td{background:var(--kore-bg-2)}.rt-ver-btn{background:transparent;border:0;padding:0;color:var(--kore-info);font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}.rt-path{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.rt-muted{color:var(--kore-text-3)}.rt-detail-row td{background:var(--kore-bg-1)}' +
    '.rt-kv{display:grid;grid-template-columns:130px minmax(0,1fr);gap:6px 12px;margin:0;padding:8px 4px;font-size:var(--kore-font-12)}.rt-kv dt{color:var(--kore-text-3)}.rt-kv dd{margin:0;word-break:break-all}.rt-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--kore-border-2)}.rt-input{flex:1 1 220px;min-height:28px;padding:4px 8px;background:var(--kore-bg-0);border:1px solid var(--kore-border-2);border-radius:4px;color:var(--kore-text-1);font-size:var(--kore-font-13)}' +
    '.rt-check{display:flex;gap:10px;align-items:flex-start;padding:8px 12px;border-bottom:1px solid var(--kore-border-2)}.rt-check:last-child{border-bottom:0}.rt-check-main{flex:1;min-width:0;font-size:var(--kore-font-12)}.rt-check-name{display:block;color:var(--kore-text-1);font-weight:500;margin-bottom:2px}.rt-check-detail{display:block;color:var(--kore-text-2);word-break:break-word}.rt-fix{margin-top:4px;color:var(--kore-text-2)}.rt-note{padding:10px 12px;color:var(--kore-text-3);font-size:var(--kore-font-12)}.rt-error{padding:10px 12px;color:var(--kore-danger);font-size:var(--kore-font-12);word-break:break-word}' +
    '.rt-empty-title{margin:0;font-size:var(--kore-font-14);font-weight:600}.rt-cmds{display:flex;flex-direction:column;gap:6px}.rt-cmd-row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:var(--kore-font-12)}.rt-cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-radius:3px;padding:1px 5px;word-break:break-all}.rt-cmd-note{color:var(--kore-text-3)}.rt-link{color:var(--kore-info)}' +
    '@media (max-width:639px){.rt-tab{flex:1 1 auto;min-height:var(--kore-touch);padding:8px 10px}.rt-title{font-size:var(--kore-font-14)}}';

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; }
  function add(p, c) { p.appendChild(c); return c; }
  // 本地化（ADR-0021）：切英文后本页用户可见文案走 en-US 表；语言包未就绪/缺键时
  // i18n.t 返回键名本身，这里以 hit !== key 拦截并回退到原中文，中文态零影响、不露裸键。
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
  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) { var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1)); }
    return '';
  }
  function fmtInt(n) { return typeof n === 'number' && isFinite(n) ? n.toLocaleString('zh-CN') : '—'; }
  function statusChip(tone, text) { var c = el('span', 'chip chip-' + tone); add(c, el('span', 'dot ' + tone)); add(c, el('span', null, text)); return c; }
  function invoke(domain, action, params) {
    var token = readCookie('kore_csrf');
    if (!token) return Promise.reject(new Error(tr('runtimes.err.noCsrf', '缺少 CSRF 令牌，请刷新页面或重新登录')));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(params || {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token } };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + domain + '/' + domain + '.' + action, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer) clearTimeout(timer);
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        throw new Error((data.code ? data.code + '：' : '') + (data.message || (tr('runtimes.err.http', '请求失败（HTTP ') + res.status + '）')));
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error(tr('runtimes.err.timeoutPrefix', '请求超时（') + TIMEOUT / 1000 + tr('runtimes.err.timeoutSuffix', ' 秒）'));
      throw err;
    });
  }

  var TABS = [
    { id: 'node', label: 'Node.js', domain: 'runtime-node', noun: 'Node', deps: 'dependencies_count', cols: ['项目名', '路径', '依赖数', '锁文件'],
      cmds: [['apt install nodejs', tr('runtimes.cmd.debian', 'Debian / Ubuntu')], ['nvm install --lts', tr('runtimes.cmd.nvmInstalled', '已安装 nvm 时')], ['https://nodejs.org', tr('runtimes.cmd.official', '官方安装包')]] },
    { id: 'php', label: 'PHP', domain: 'runtime-php', noun: 'PHP', deps: 'dependencies_count', cols: ['项目名', '路径', '依赖数', '框架', '锁文件'],
      cmds: [['apt install php-cli', tr('runtimes.cmd.debian', 'Debian / Ubuntu')], ['phpenv install 8.4.0', tr('runtimes.cmd.phpenvInstalled', '已安装 phpenv 时')], ['https://www.php.net/downloads', tr('runtimes.cmd.official', '官方安装包')]] },
    { id: 'python', label: 'Python', domain: 'runtime-python', noun: 'Python', deps: 'dependency_count', cols: ['项目名', '路径', '依赖数', '锁文件', 'venv'],
      cmds: [['apt install python3', tr('runtimes.cmd.debian', 'Debian / Ubuntu')], ['pyenv install 3.13.0', tr('runtimes.cmd.pyenvInstalled', '已安装 pyenv 时')], ['https://www.python.org/downloads', tr('runtimes.cmd.official', '官方安装包')]] }
  ];
  function detailRows(t, i) {
    if (t.id === 'node') return [[tr('runtimes.detail.npmVersion', 'npm 版本'), i.npm_version || '—'], [tr('runtimes.detail.v8', 'V8 引擎'), i.v8 || '—'],
      [tr('runtimes.detail.openssl', 'OpenSSL'), i.openssl || '—'], [tr('runtimes.detail.globalPkgs', '全局包'), i.global_packages == null ? '—' : fmtInt(i.global_packages) + tr('runtimes.unit.count', ' 个')]];
    if (t.id === 'php') {
      var ext = i.extensions || [], s = i.ini_settings || {};
      return [[tr('runtimes.detail.iniPath', '配置文件'), i.ini_path || tr('runtimes.detail.iniNone', '未加载 php.ini')], [tr('runtimes.detail.extensions', '扩展'), ext.length ? ext.length + tr('runtimes.unit.countColon', ' 个：') + ext.slice(0, 6).join(' / ') + (ext.length > 6 ? ' …' : '') : '—'],
        ['memory_limit', s.memory_limit || '—'], ['upload_max_filesize', s.upload_max_filesize || '—'],
        ['post_max_size', s.post_max_size || '—'], ['max_execution_time', s.max_execution_time === '0' ? tr('runtimes.detail.noLimit', '0（不限制）') : (s.max_execution_time || '—')]];
    }
    return [[tr('runtimes.detail.pipVersion', 'pip 版本'), i.pip_version || '—'], [tr('runtimes.detail.sitePackages', 'site-packages'), i.site_packages || '—'],
      [tr('runtimes.detail.installedPkgs', '已安装包'), i.installed_packages == null ? '—' : fmtInt(i.installed_packages) + tr('runtimes.unit.count', ' 个')], [tr('runtimes.detail.venvOK', 'venv 可用'), i.venv_available ? tr('runtimes.yes', '是') : tr('runtimes.no', '否')]];
  }
  // cols 是 projectValue 的判别键，必须保留中文；这里只翻译表头显示。
  function colText(c) {
    var m = { '项目名': ['runtimes.col.project', '项目名'], '路径': ['runtimes.col.path', '路径'],
      '依赖数': ['runtimes.col.deps', '依赖数'], '锁文件': ['runtimes.col.lock', '锁文件'],
      '框架': ['runtimes.col.framework', '框架'], 'venv': ['runtimes.col.venv', 'venv'] };
    var x = m[c]; return x ? tr(x[0], x[1]) : c;
  }
  function projectValue(t, label, p) {
    if (label === '项目名') return p.name || '—';
    if (label === '路径') return p.path || '—';
    if (label === '依赖数') { var v = p[t.deps]; return v == null ? '—' : String(v); }
    if (label === '锁文件') return p.has_lock ? tr('runtimes.has', '有') : tr('runtimes.none', '无');
    if (label === '框架') return p.framework || '—';
    if (label === 'venv') return p.has_venv ? tr('runtimes.has', '有') : tr('runtimes.none', '无');
    return '—';
  }
  function blank(id) {
    var root = ''; try { root = localStorage.getItem(LS + id) || ''; } catch (e) { root = ''; }
    return { versions: null, defaultVersion: '', hint: '', error: '', loading: false, selected: '',
      info: {}, infoErrors: {}, infoLoading: '', root: root, projects: null, projectError: '',
      projectWarnings: [], scanning: false, doctor: null, doctorError: '', doctorLoading: false };
  }
  var state = {}, byId = {}, tab = 'node', bodyBox = null, barBox = null;
  TABS.forEach(function (t) { byId[t.id] = t; state[t.id] = blank(t.id); });
  function ensureCss() {
    if (document.getElementById('kore-runtimes-css')) return;
    var s = el('style'); s.id = 'kore-runtimes-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function saveRoot(id, root) { try { localStorage.setItem(LS + id, root || ''); } catch (e) { /* 隐私模式不持久化，不阻断 */ } }
  function loadVersions(t, s) {
    s.loading = true;
    invoke(t.domain, 'versions', {}).then(function (d) {
      s.loading = false; s.error = ''; s.versions = Array.isArray(d.versions) ? d.versions : [];
      s.defaultVersion = d.default_version || ''; s.hint = d.hint || '';
      if (tab === t.id) paintBody();
    }, function (err) { s.loading = false; s.error = err.message; if (tab === t.id) paintBody(); });
  }
  function loadDoctor(t, s) {
    s.doctorLoading = true;
    invoke(t.domain, 'doctor', {}).then(function (d) {
      s.doctorLoading = false; s.doctor = Array.isArray(d.checks) ? d.checks : [];
      if (tab === t.id) paintBody();
    }, function (err) { s.doctorLoading = false; s.doctorError = err.message; if (tab === t.id) paintBody(); });
  }
  function loadInfo(t, s, version) {
    if (s.info[version] || s.infoLoading === version) return;
    s.infoLoading = version;
    invoke(t.domain, 'info', { version: version }).then(function (d) {
      s.infoLoading = ''; s.info[version] = d; if (tab === t.id) paintBody();
    }, function (err) { s.infoLoading = ''; s.infoErrors[version] = err.message; if (tab === t.id) paintBody(); });
  }
  function ensureLoaded(id) {
    var s = state[id], t = byId[id];
    if (s.versions === null && !s.loading) loadVersions(t, s);
    if (s.doctor === null && !s.doctorLoading) loadDoctor(t, s);
  }
  function toggleVersion(t, s, version) {
    if (s.selected === version) s.selected = ''; else { s.selected = version; loadInfo(t, s, version); }
    paintBody();
  }

  function summary(t, s) {
    var bar = el('div', 'rt-summary'), has = !!(s.versions && s.versions.length);
    add(bar, el('span', null, s.versions === null ? tr('runtimes.status.detecting', '正在探测 ') + t.noun + tr('runtimes.ellipsis', '…')
      : (has ? '检测到 ' + s.versions.length + tr('runtimes.unit.countSpaced', ' 个 ') + t.noun + tr('runtimes.status.defaultSuffix', '，默认 ') + (s.defaultVersion || '—') : tr('runtimes.status.notDetected', '未检测到 ') + t.noun)));
    if (s.versions !== null) bar.appendChild(has ? statusChip('ok', tr('runtimes.badge.installed', '已安装')) : statusChip('na', tr('runtimes.badge.notInstalled', '未安装')));
    return bar;
  }
  function emptyGuide(t, s) {
    var box = el('div', 'empty-state'), cmds;
    add(box, el('p', 'rt-empty-title', tr('runtimes.status.notDetected', '未检测到 ') + t.noun));
    add(box, el('p', 'empty-state-text', s.hint || tr('runtimes.empty.hint', '安装后点「重新探测」即可看到版本。')));
    cmds = add(box, el('div', 'rt-cmds'));
    t.cmds.forEach(function (c) {
      var row = add(cmds, el('div', 'rt-cmd-row')), a;
      if (/^https?:/.test(c[0])) { a = add(row, el('a', 'rt-link', c[0])); a.href = c[0]; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      else add(row, el('code', 'rt-cmd', c[0]));
      add(row, el('span', 'rt-cmd-note', c[1]));
    });
    return box;
  }
  function detailBox(t, s, version) {
    var box = el('div', 'rt-detail'), info = s.info[version], dl;
    if (s.infoErrors[version]) { add(box, el('div', 'rt-error', s.infoErrors[version])); return box; }
    if (!info) { add(box, el('div', 'rt-note', s.infoLoading === version ? tr('runtimes.status.reading', '正在读取 ') + version + tr('runtimes.status.readingSuffix', ' 的详情…') : tr('runtimes.detail.expandHint', '展开后读取详情…'))); return box; }
    dl = add(box, el('dl', 'rt-kv'));
    detailRows(t, info).forEach(function (pair) { add(dl, el('dt', null, pair[0])); add(dl, el('dd', null, pair[1])); });
    return box;
  }
  function versionsTable(t, s) {
    var scroll = el('div', 'rt-scroll'), table = add(scroll, el('table', 'rt-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    [tr('runtimes.col.version', '版本'), tr('runtimes.col.path', '路径'), tr('runtimes.col.source', '来源'), tr('runtimes.col.default', '默认')].forEach(function (h) { add(htr, el('th', null, h)); });
    var tbody = add(table, el('tbody'));
    s.versions.forEach(function (v) {
      var open = s.selected === v.version, td;
      var row = add(tbody, el('tr', 'rt-row' + (open ? ' is-open' : '')));
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
      row.addEventListener('click', function () { toggleVersion(t, s, v.version); });
      var btn = add(add(row, el('td')), el('button', 'rt-ver-btn', v.version || '—'));
      btn.type = 'button'; btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.addEventListener('click', function (ev) { ev.stopPropagation(); toggleVersion(t, s, v.version); });
      add(row, el('td', 'rt-path', v.path || '—'));
      var src = add(row, el('td', null, v.source || '—'));
      if (SRC[v.source]) src.title = SRC[v.source];
      td = add(row, el('td'));
      if (v.is_default) td.appendChild(statusChip('ok', tr('runtimes.col.default', '默认'))); else add(td, el('span', 'rt-muted', '—'));
      if (!open) return;
      td = add(add(tbody, el('tr', 'rt-detail-row')), el('td'));
      td.colSpan = 4; td.appendChild(detailBox(t, s, v.version));
    });
    return scroll;
  }
  function versionsPanel(t, s) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', tr('runtimes.panel.versions', '版本列表')));
    if (s.versions && s.versions.length) add(h, el('span', 'panel-meta', tr('runtimes.panel.versionsMeta', '点击版本行展开该版本的详情')));
    if (s.error) { add(p, el('div', 'rt-error', tr('runtimes.err.versionFail', '版本探测失败：') + s.error)); return p; }
    if (s.versions === null) { add(p, el('div', 'stub', tr('runtimes.status.detecting', '正在探测 ') + t.noun + tr('runtimes.ellipsis', '…'))); return p; }
    if (s.versions.length) p.appendChild(versionsTable(t, s)); else p.appendChild(emptyGuide(t, s));
    return p;
  }
  function projectTable(t, s) {
    var scroll = el('div', 'rt-scroll'), table = add(scroll, el('table', 'rt-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    t.cols.forEach(function (c) { add(htr, el('th', null, colText(c))); });
    var tbody = add(table, el('tbody'));
    s.projects.forEach(function (p) {
      var rowNode = add(tbody, el('tr'));
      t.cols.forEach(function (c) {
        var td = add(rowNode, el('td'));
        if (c === '路径') td.className = 'rt-path';
        td.textContent = projectValue(t, c, p);
      });
    });
    return scroll;
  }
  function projectsPanel(t, s) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', tr('runtimes.panel.projects', '项目扫描')));
    add(h, el('span', 'panel-meta', tr('runtimes.panel.projectsMeta', '深度 ≤3 · 条目 ≤200 · 只读清单')));
    var tools = add(p, el('div', 'rt-toolbar')), input, dl, btn;
    add(tools, el('label', 'rt-label', tr('runtimes.label.root', '根目录')));
    input = add(tools, el('input', 'rt-input'));
    input.type = 'text'; input.placeholder = '/var/www'; input.value = s.root;
    input.setAttribute('list', 'rt-roots');
    input.addEventListener('change', function () { s.root = input.value.trim(); saveRoot(t.id, s.root); });
    dl = add(tools, el('datalist')); dl.id = 'rt-roots';
    ['/var/www', '/opt', '/home'].forEach(function (r) { add(dl, el('option')).value = r; });
    btn = add(tools, el('button', 'btn btn-primary', s.scanning ? tr('runtimes.btn.scanning', '扫描中…') : tr('runtimes.btn.scan', '扫描')));
    btn.type = 'button'; btn.disabled = !!s.scanning;
    btn.addEventListener('click', function () {
      s.root = input.value.trim(); saveRoot(t.id, s.root);
      if (!s.root) { s.projectError = tr('runtimes.err.rootEmpty', '请先填写根目录（预设 /var/www、/opt、/home）'); paintBody(); return; }
      s.scanning = true; s.projectError = ''; paintBody();
      invoke(t.domain, 'projects', { root: s.root }).then(function (d) {
        s.scanning = false; s.projects = Array.isArray(d.projects) ? d.projects : [];
        s.projectWarnings = Array.isArray(d.warnings) ? d.warnings : [];
        if (tab === t.id) paintBody();
      }, function (err) { s.scanning = false; s.projectError = err.message; if (tab === t.id) paintBody(); });
    });
    if (s.projectError) { add(p, el('div', 'rt-error', s.projectError)); return p; }
    if (s.projects === null) { add(p, el('div', 'rt-note', tr('runtimes.projects.hint', '输入根目录后点「扫描」；只读项目清单，不执行项目脚本。'))); return p; }
    if (!s.projects.length) {
      add(p, el('div', 'rt-note', tr('runtimes.projects.foundPrefix', '在 ') + s.root + tr('runtimes.projects.noneMid', ' 下没有发现 ') + t.noun + tr('runtimes.projects.noneSuffix', ' 项目；可换 /opt 或 /home 再试，项目需在 3 层目录内。')));
      return p;
    }
    add(p, el('div', 'rt-note', tr('runtimes.projects.found', '共找到 ') + s.projects.length + tr('runtimes.unit.countSpaced', ' 个 ') + t.noun + ' 项目'));
    p.appendChild(projectTable(t, s));
    if (s.projectWarnings.length) add(p, el('div', 'rt-note', tr('runtimes.projects.skipped', '已跳过 ') + s.projectWarnings.length + tr('runtimes.projects.skippedSuffix', ' 个条目：') + s.projectWarnings.slice(0, 3).join('；')));
    return p;
  }
  function doctorPanel(t, s) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head')), fail = 0, warn = 0;
    add(h, el('span', 'panel-title', tr('runtimes.panel.doctor', '健康检查')));
    if (s.doctorLoading) add(h, el('span', 'panel-meta', tr('runtimes.status.checking', '正在体检…')));
    else if (s.doctor && s.doctor.length) {
      s.doctor.forEach(function (c) { if (c.status === 'fail') fail++; else if (c.status === 'warn') warn++; });
      add(h, fail ? statusChip('fail', fail + tr('runtimes.doctor.failCount', ' 项失败')) : (warn ? statusChip('warn', warn + tr('runtimes.doctor.warnCount', ' 项警告')) : statusChip('ok', tr('runtimes.doctor.allPass', '全部通过'))));
    }
    if (s.doctorError) { add(p, el('div', 'rt-error', tr('runtimes.err.doctorFail', '健康检查失败：') + s.doctorError)); return p; }
    if (s.doctor === null) { add(p, el('div', 'stub', '正在体检 ' + t.noun + tr('runtimes.ellipsis', '…'))); return p; }
    if (!s.doctor.length) { add(p, el('div', 'rt-note', tr('runtimes.doctor.empty', '没有返回检查项。'))); return p; }
    var list = add(p, el('div', 'rt-checks'));
    s.doctor.forEach(function (c) {
      var tone = c.status === 'fail' ? 'fail' : (c.status === 'warn' ? 'warn' : 'ok'), m, fix;
      var item = add(list, el('div', 'rt-check'));
      add(item, statusChip(tone, c.status === 'fail' ? tr('runtimes.doctor.fail', '失败') : (c.status === 'warn' ? tr('runtimes.doctor.warn', '警告') : tr('runtimes.doctor.pass', '通过'))));
      var main = add(item, el('div', 'rt-check-main'));
      add(main, el('span', 'rt-check-name', CHECK[c.name] || c.name));
      add(main, el('span', 'rt-check-detail', c.detail || '—'));
      m = c.status !== 'pass' ? FIX.exec(c.detail || '') : null;
      if (m) {
        fix = add(main, el('div', 'rt-fix'));
        add(fix, el('span', 'rt-fix-label', tr('runtimes.doctor.fixLabel', '修复命令：')));
        add(fix, el('code', 'rt-cmd', m[1]));
      }
    });
    return p;
  }

  function paintBar() {
    if (!barBox) return;
    barBox.textContent = '';
    TABS.forEach(function (t) {
      var b = add(barBox, el('button', 'rt-tab' + (tab === t.id ? ' is-active' : ''), t.label));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', tab === t.id ? 'true' : 'false');
      b.addEventListener('click', function () { if (tab === t.id) return; tab = t.id; paintBar(); ensureLoaded(tab); paintBody(); });
    });
  }
  function paintBody() {
    if (!bodyBox) return;
    bodyBox.textContent = '';
    var t = byId[tab], s = state[tab];
    bodyBox.appendChild(summary(t, s));
    bodyBox.appendChild(versionsPanel(t, s));
    if (s.versions && s.versions.length) bodyBox.appendChild(projectsPanel(t, s));
    bodyBox.appendChild(doctorPanel(t, s));
  }
  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    ensureCss();
    var page = el('div', 'rt-page'), head = add(page, el('div', 'rt-head')), left = add(head, el('div', 'rt-head-main')), refresh;
    add(left, el('h2', 'rt-title', tr('runtimes.title', '运行环境')));
    add(left, el('p', 'rt-sub', tr('runtimes.subtitle', 'Node.js / PHP / Python 的版本、单版本详情、项目依赖与健康检查；只读探测，不修改宿主文件。')));
    refresh = add(add(head, el('div', 'rt-actions')), el('button', 'btn', tr('runtimes.btn.redetect', '重新探测')));
    refresh.type = 'button';
    refresh.addEventListener('click', function () {
      var s = state[tab];
      s.versions = null; s.error = ''; s.doctor = null; s.doctorError = ''; s.selected = '';
      ensureLoaded(tab); paintBody();
    });
    barBox = add(page, el('div', 'rt-tabs'));
    barBox.setAttribute('role', 'tablist');
    barBox.setAttribute('aria-label', tr('runtimes.aria.tablist', '运行时切换'));
    bodyBox = add(page, el('div', 'rt-body'));
    container.textContent = '';
    container.appendChild(page);
    paintBar(); ensureLoaded(tab); paintBody();
    return { destroy: function () { barBox = null; bodyBox = null; } };
  }

  window.KoreRuntimes = { render: render };
})();
