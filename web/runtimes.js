/* kore 主壳 · 运行环境（web/runtimes.js）—— Node.js / PHP / Python 三 tab 一页管理。
   调用形态：POST /api/v1/invoke/runtime-<lang>/runtime-<lang>.<action>（完整限定名，插件不认裸动词）。
   只读四动词：versions / info / projects / doctor（三 runtime 共用，保留不变）。
   Python 专属写操作（仅 runtime-python tab 显示）：venv.list / venv.create（path+版本+可选初始包）
   / pip.install / pip.list；写域限制在插件状态目录内，后端有路径白名单 + 软链逃逸防护 + 120s 超时。
   tab 切换只重绘本页，不换 hash、不重载；每 tab 的扫描根目录写 localStorage。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/', TIMEOUT = 20000, PY_TIMEOUT = 125000, LS = 'kore.runtimes.root.';
  var SRC = { path: 'PATH', known_path: tr('runtimes.src.known', '常用路径'), nvm: 'nvm', pyenv: 'pyenv', phpenv: 'phpenv', conda: 'conda' };
  var CHECK = { node: tr('runtimes.check.node', 'Node 安装'), npm: tr('runtimes.check.npm', 'npm 可用性'), global_packages_writable: tr('runtimes.check.globalWritable', '全局包目录可写'),
    node_env: tr('runtimes.check.nodeEnv', 'NODE_ENV 环境变量'), php: tr('runtimes.check.php', 'PHP 安装'), version_supported: tr('runtimes.check.versionSupport', '版本支持'), extensions: tr('runtimes.check.extensions', '扩展列表'),
    memory_limit: tr('runtimes.check.memoryLimit', '内存上限'), ini_loaded: tr('runtimes.check.iniLoaded', 'php.ini 加载'), python: tr('runtimes.check.python', 'Python 安装'), pip: tr('runtimes.check.pip', 'pip 可用性'),
    venv: tr('runtimes.check.venv', 'venv 支持'), site_packages: tr('runtimes.check.siteWritable', 'site-packages 可写') };
  var FIX = /(apt install [a-zA-Z0-9_.+-]+|export [A-Z_][A-Z0-9_]*=[^\s；;，,]+|nvm install --lts|pyenv install [0-9.]+|pip install [a-zA-Z0-9_.+-]+)/;
  // Python venv/pip 错误「怎么办」映射：后端 E_INVALID（路径越界/包名非法）、E_UPSTREAM（120s 超时）、
  // E_NOTFOUND（未装 Python/venv）、E_UNSUPPORTED（venv 无 pip）→ 人话动作；错误码折叠进 details 不铺首屏。
  function venvHint(err) {
    var code = err && err.code ? String(err.code) : '';
    var m = (err && err.backendMessage) || (err && err.message) || '';
    if (code === 'E_INVALID' || /越界|包名非法|参数非法|绝对路径|必填字段|版本|version/.test(m))
      return tr('runtimes.venv.hint.invalid', '检查填写内容：venv 路径须是插件允许目录内的绝对路径（不能含 ..），包名只字母数字和 . _ -、可带 ==版本；改好后重试。');
    if (/超时|timeout|DeadlineExceeded/i.test(m))
      return tr('runtimes.venv.hint.timeout', '命令超过 120 秒被中止：pip 联网装包较慢，检查网络或配置镜像源后重试；也可少装几个包分批执行。');
    if (code === 'E_NOTFOUND' || /未安装|不存在|not found/i.test(m))
      return tr('runtimes.venv.hint.notfound', '找不到目标：先确认已安装对应 Python 版本、且选择的 venv 仍存在（点「刷新环境列表」）。');
    if (code === 'E_UNSUPPORTED' || /pip/.test(m))
      return tr('runtimes.venv.hint.pip', 'pip 不可用：可用 python3 -m venv --upgrade-deps 重建该环境，再重试装包。');
    return tr('runtimes.venv.hint.generic', '请刷新页面重试；反复失败请把下方错误详情反馈给管理员。');
  }
  function venvErrorBox(err) {
    var box = el('div', 'rt-error'), msg = (err && err.backendMessage) || (err && err.message) || String(err);
    add(box, el('div', null, tr('runtimes.venv.err.title', '操作失败：') + msg));
    add(box, el('div', 'rt-fix', tr('runtimes.venv.err.howto', '怎么办：') + venvHint(err)));
    var det = add(box, el('details', 'rt-err-detail')), sum = add(det, el('summary', null, tr('runtimes.venv.err.detail', '错误详情')));
    add(det, el('code', 'rt-cmd', (err && err.code ? err.code + ' · ' : '') + msg));
    return box;
  }
  var CSS =
    '.rt-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.rt-title{margin:0;font-size:var(--kore-font-16);font-weight:600}.rt-sub{margin:4px 0 0;color:var(--kore-text-3);font-size:var(--kore-font-12)}.rt-tabs{display:flex;gap:4px;margin:12px 0;border-bottom:1px solid var(--kore-border-1)}.rt-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--kore-text-3);padding:8px 16px;font-size:var(--kore-font-14);cursor:pointer}.rt-tab:hover{color:var(--kore-text-1)}.rt-tab.is-active{color:var(--kore-text-1);border-bottom-color:var(--kore-info)}' +
    '.rt-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin-bottom:12px;background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:4px;font-size:var(--kore-font-13)}.rt-scroll{overflow-x:auto}' +
    '.rt-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-12);min-width:520px}.rt-table th{text-align:left;padding:8px 12px;color:var(--kore-text-3);font-weight:500;border-bottom:1px solid var(--kore-border-2);white-space:nowrap}.rt-table td{padding:8px 12px;border-bottom:1px solid var(--kore-border-2);vertical-align:top}' +
    '.rt-row{cursor:pointer}.rt-row:hover td{background:var(--kore-bg-2)}.rt-ver-btn{background:transparent;border:0;padding:0;color:var(--kore-info);font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}.rt-path{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.rt-muted{color:var(--kore-text-3)}.rt-detail-row td{background:var(--kore-bg-1)}' +
    '.rt-kv{display:grid;grid-template-columns:130px minmax(0,1fr);gap:6px 12px;margin:0;padding:8px 4px;font-size:var(--kore-font-12)}.rt-kv dt{color:var(--kore-text-3)}.rt-kv dd{margin:0;word-break:break-all}.rt-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--kore-border-2)}.rt-input{flex:1 1 220px;min-height:28px;padding:4px 8px;background:var(--kore-bg-0);border:1px solid var(--kore-border-2);border-radius:4px;color:var(--kore-text-1);font-size:var(--kore-font-13)}' +
    '.rt-check{display:flex;gap:10px;align-items:flex-start;padding:8px 12px;border-bottom:1px solid var(--kore-border-2)}.rt-check:last-child{border-bottom:0}.rt-check-main{flex:1;min-width:0;font-size:var(--kore-font-12)}.rt-check-name{display:block;color:var(--kore-text-1);font-weight:500;margin-bottom:2px}.rt-check-detail{display:block;color:var(--kore-text-2);word-break:break-word}.rt-fix{margin-top:4px;color:var(--kore-text-2)}.rt-note{padding:10px 12px;color:var(--kore-text-3);font-size:var(--kore-font-12)}.rt-error{padding:10px 12px;color:var(--kore-danger);font-size:var(--kore-font-12);word-break:break-word}' +
    '.rt-empty-title{margin:0;font-size:var(--kore-font-14);font-weight:600}.rt-cmds{display:flex;flex-direction:column;gap:6px}.rt-cmd-row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:var(--kore-font-12)}.rt-cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-radius:3px;padding:1px 5px;word-break:break-all}.rt-cmd-note{color:var(--kore-text-3)}.rt-link{color:var(--kore-info)}' +
    '.rt-venv-pkgs{margin:6px 0 0;padding:6px 10px;background:var(--kore-bg-1);border:1px solid var(--kore-border-2);border-radius:4px;font-size:var(--kore-font-12);color:var(--kore-text-2)}.rt-venv-pkgs code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.rt-row-btns{display:flex;gap:6px;flex-wrap:wrap}.rt-row-btns .btn{min-height:32px;padding:3px 10px;font-size:var(--kore-font-12)}.rt-venv-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;padding:10px 12px;border-bottom:1px solid var(--kore-border-2)}.rt-field{display:flex;flex-direction:column;gap:4px;font-size:var(--kore-font-12)}.rt-field label{color:var(--kore-text-3)}.rt-field .rt-input{flex:none;width:100%;min-height:36px}.rt-field-hint{color:var(--kore-text-3);font-size:11px}.rt-venv-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px}.rt-err-detail{margin-top:6px;font-size:var(--kore-font-12);color:var(--kore-text-3)}.rt-err-detail summary{cursor:pointer}.rt-ok{padding:10px 12px;color:var(--kore-success);font-size:var(--kore-font-12);word-break:break-word}' +
    '.rt-log{margin:0;padding:8px 12px;max-height:300px;overflow:auto;background:var(--kore-bg-0);border:1px solid var(--kore-border-2);border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all}.rt-guard-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px}.rt-guard-meta .btn{min-height:32px;padding:3px 10px;font-size:var(--kore-font-12)}' +
    '@media (max-width:639px){.rt-tab{flex:1 1 auto;min-height:var(--kore-touch);padding:8px 10px}.rt-title{font-size:var(--kore-font-14)}.rt-row-btns .btn{min-height:var(--kore-touch);flex:1 1 auto}.rt-venv-form{grid-template-columns:1fr}.rt-field .rt-input{min-height:var(--kore-touch)}}';

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
  function invoke(domain, action, params, timeoutMs) {
    var token = readCookie('kore_csrf');
    if (!token) return Promise.reject(new Error(tr('runtimes.err.noCsrf', '缺少 CSRF 令牌，请刷新页面或重新登录')));
    var limit = timeoutMs || TIMEOUT; // venv/pip 后端硬超时 120s，调用方需显式放宽，避免前端 20s 误掐断
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, limit) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(params || {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token } };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + domain + '/' + domain + '.' + action, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer) clearTimeout(timer);
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var msg = (data.code ? data.code + '：' : '') + (data.message || (tr('runtimes.err.http', '请求失败（HTTP ') + res.status + '）'));
        var e = new Error(msg); // 挂结构化字段给写操作做「怎么办」映射；message 格式与旧版一致，旧调用零影响
        e.code = data.code || ''; e.backendMessage = data.message || ''; e.detail = data.detail || null; e.hint = data.hint || '';
        throw e;
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error(tr('runtimes.err.timeoutPrefix', '请求超时（') + limit / 1000 + tr('runtimes.err.timeoutSuffix', ' 秒）'));
      throw err;
    });
  }

  var TABS = [
    { id: 'node', label: 'Node.js', domain: 'runtime-node', noun: 'Node', deps: 'dependencies_count', edge: 'app.js', cols: ['项目名', '路径', '依赖数', '锁文件'],
      cmds: [['apt install nodejs', tr('runtimes.cmd.debian', 'Debian / Ubuntu')], ['nvm install --lts', tr('runtimes.cmd.nvmInstalled', '已安装 nvm 时')], ['https://nodejs.org', tr('runtimes.cmd.official', '官方安装包')]] },
    { id: 'php', label: 'PHP', domain: 'runtime-php', noun: 'PHP', deps: 'dependencies_count', edge: 'index.php', cols: ['项目名', '路径', '依赖数', '框架', '锁文件'],
      cmds: [['apt install php-cli', tr('runtimes.cmd.debian', 'Debian / Ubuntu')], ['phpenv install 8.4.0', tr('runtimes.cmd.phpenvInstalled', '已安装 phpenv 时')], ['https://www.php.net/downloads', tr('runtimes.cmd.official', '官方安装包')]] },
    { id: 'python', label: 'Python', domain: 'runtime-python', noun: 'Python', deps: 'dependency_count', edge: 'app.py', cols: ['项目名', '路径', '依赖数', '锁文件', 'venv'],
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
    return { versions: null, defaultVersion: '', pinnedVersion: '', hint: '', error: '', loading: false, selected: '',
      info: {}, infoErrors: {}, infoLoading: '', root: root, projects: null, projectError: '',
      projectWarnings: [], scanning: false, doctor: null, doctorError: '', doctorLoading: false,
      // 版本默认（use）：钉住 / 取消钉住一个已装版本，供站点与守护启动时使用
      pinBusy: '', pinMsg: '', pinErr: null,
      // 进程守护（三 tab 共用）：列表 / 表单 / 忙碌项 / 日志
      guard: null, guardError: '', guardLoading: false, guardBusy: '', guardMsg: '', guardErr: null,
      gName: '', gDir: '', gScript: '', gVersion: '', gArgs: '', gShowForm: false,
      gLogFor: '', gLog: null, gLogLoading: false, gLogError: '',
      // Python venv/pip（仅 runtime-python tab 使用；node/php 这三组字段闲置、不影响其渲染）
      venvRoot: '', venvs: null, venvListError: '', venvListLoading: false,
      vPath: '', vVersion: '', vPkgs: '', vBusy: false, vMsg: null, vErr: null,
      pkgFor: '', pkgMode: '', pkgInput: '', pkgBusy: false, pkgResult: null, pkgErr: null };
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
      s.pinnedVersion = d.pinned_version || '';
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
    if (s.guard === null && !s.guardLoading) loadGuard(t, s);
    if (id === 'python' && s.venvs === null && !s.venvListLoading) loadVenvs(t, s);
  }
  // ---- Python venv / pip（仅 runtime-python）：契约源自后端 venv.go 的 *Params/*Result ----
  var PKG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(==[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
  function parsePkgs(raw) {
    return (raw || '').split(/[\s,，]+/).map(function (x) { return x.trim(); }).filter(function (x) { return !!x; });
  }
  function firstBadPkg(pkgs) {
    for (var i = 0; i < pkgs.length; i++) if (!PKG_RE.test(pkgs[i])) return pkgs[i];
    return null;
  }
  function loadVenvs(t, s) {
    s.venvListLoading = true; s.venvListError = '';
    invoke(t.domain, 'venv.list', {}, PY_TIMEOUT).then(function (d) {
      s.venvListLoading = false; s.venvs = Array.isArray(d.venvs) ? d.venvs : [];
      s.venvRoot = d.root || '';
      var suggested = s.venvRoot && s.venvRoot.charAt(0) === '/' ? s.venvRoot.replace(/\/+$/, '') + '/venvs/venv' : '';
      if (suggested && !s.vPath) s.vPath = suggested; // 自动填默认路径（仅绝对路径），用户不必知道 stateRoot 在哪
      if (tab === t.id) paintBody();
    }, function (err) { s.venvListLoading = false; s.venvListError = err; if (tab === t.id) paintBody(); });
  }
  function doVenvCreate(t, s) {
    var path = (s.vPath || '').trim(), ver = (s.vVersion || '').trim(), pkgs = parsePkgs(s.vPkgs);
    if (ver && !/^\d+\.\d+(\.\d+)?$/.test(ver)) {
      s.vErr = new Error(tr('runtimes.venv.hint.version', 'Python 版本要写成 3.11 或 3.11.2 这样的格式')); s.vMsg = null; paintBody(); return;
    }
    if (path && (path !== path.trim() || path.indexOf('..') >= 0 || path.indexOf('\\') >= 0 || path.charAt(0) !== '/')) {
      s.vErr = new Error(tr('runtimes.venv.hint.path', '路径必须是插件允许目录内的绝对路径，不能含 .. 或反斜杠；留空则用默认路径'));
      s.vMsg = null; paintBody(); return;
    }
    var bad = firstBadPkg(pkgs);
    if (bad) {
      s.vErr = new Error(tr('runtimes.venv.hint.pkgBad', '包名「{p}」不合法：只允许字母数字和 . _ -，可带 ==版本；不要写空格、分号或 -r 选项').replace('{p}', bad));
      s.vMsg = null; paintBody(); return;
    }
    s.vBusy = true; s.vErr = null; s.vMsg = null; paintBody();
    // 契约（venv.go venvCreateParams）：path / python_version / packages，严格拒绝未知字段
    invoke(t.domain, 'venv.create', { path: path, python_version: ver, packages: pkgs }, PY_TIMEOUT).then(function (d) {
      s.vBusy = false;
      s.vMsg = tr('runtimes.venv.done.create', '虚拟环境已就绪：') + (d.path || path) +
        (d.created ? tr('runtimes.venv.done.created', '（新建）') : tr('runtimes.venv.done.exists', '（已存在，未覆盖）')) +
        ((d.packages && d.packages.length) ? tr('runtimes.venv.done.withPkgs', '，已装 {n} 个初始包').replace('{n}', d.packages.length) : '');
      s.vPath = ''; s.vVersion = ''; s.vPkgs = '';
      loadVenvs(t, s); // 重建后刷新列表（loadVenvs 会 paintBody）
      if (tab === t.id) paintBody();
    }, function (err) { s.vBusy = false; s.vErr = err; if (tab === t.id) paintBody(); });
  }
  function doPipInstall(t, s, venvPath) {
    var pkgs = parsePkgs(s.pkgInput);
    if (!pkgs.length) { s.pkgErr = new Error(tr('runtimes.venv.hint.pkgEmpty', '请先填写要安装的包名，例如 requests 或 flask==3.0.0')); s.pkgResult = null; paintBody(); return; }
    var bad = firstBadPkg(pkgs);
    if (bad) { s.pkgErr = new Error(tr('runtimes.venv.hint.pkgBad', '包名「{p}」不合法：只允许字母数字和 . _ -，可带 ==版本；不要写空格、分号或 -r 选项').replace('{p}', bad)); s.pkgResult = null; paintBody(); return; }
    s.pkgBusy = true; s.pkgErr = null; s.pkgResult = null; paintBody();
    // 契约（venv.go pipInstallParams）：venv_path / packages
    invoke(t.domain, 'pip.install', { venv_path: venvPath, packages: pkgs }, PY_TIMEOUT).then(function (d) {
      s.pkgBusy = false; s.pkgMode = ''; s.pkgInput = '';
      s.pkgResult = tr('runtimes.venv.done.install', '已安装：') + (d.packages || pkgs).join('、') +
        tr('runtimes.venv.done.duration', '（耗时 ') + (d.duration_ms != null ? Math.round(d.duration_ms / 1000) + 's' : '—') + '）';
      if (d.truncated) s.pkgResult += tr('runtimes.venv.done.truncated', '；输出较长已截断');
      if (tab === t.id) paintBody();
    }, function (err) { s.pkgBusy = false; s.pkgErr = err; if (tab === t.id) paintBody(); });
  }
  function doPipList(t, s, venvPath) {
    s.pkgFor = venvPath; s.pkgMode = 'list'; s.pkgBusy = true; s.pkgErr = null; s.pkgResult = null; paintBody();
    // 契约（venv.go pipListParams）：venv_path
    invoke(t.domain, 'pip.list', { venv_path: venvPath }, PY_TIMEOUT).then(function (d) {
      s.pkgBusy = false;
      var ps = d.packages || [];
      s.pkgResult = ps.length ? ps.map(function (p) { return p.name + '==' + (p.version || '?'); }).join('、') : tr('runtimes.venv.pkg.empty', '这个环境还没有安装包');
      if (tab === t.id) paintBody();
    }, function (err) { s.pkgBusy = false; s.pkgErr = err; if (tab === t.id) paintBody(); });
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
    if (s.pinnedVersion) add(bar, el('span', 'rt-muted', tr('runtimes.pin.current', '默认版本（站点/守护用）：') + s.pinnedVersion));
    if (s.pinMsg) add(bar, el('span', 'rt-ok', s.pinMsg));
    if (s.pinErr) {
      var pe = add(bar, el('span', 'rt-error', tr('runtimes.pin.err.title', '设置默认版本失败：') + ((s.pinErr && s.pinErr.message) || s.pinErr)));
      add(pe, el('div', 'rt-fix', tr('runtimes.pin.err.howto', '怎么办：') + pinHint(s.pinErr)));
    }
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
    [tr('runtimes.col.version', '版本'), tr('runtimes.col.path', '路径'), tr('runtimes.col.source', '来源'), tr('runtimes.col.default', '默认'), tr('runtimes.col.actions', '操作')].forEach(function (h) { add(htr, el('th', null, h)); });
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
      if (v.is_default) td.appendChild(statusChip('ok', tr('runtimes.col.default', '默认')));
      else if (s.pinnedVersion && s.pinnedVersion === v.version) td.appendChild(statusChip('info', tr('runtimes.pin.badge', '已设为默认')));
      else add(td, el('span', 'rt-muted', '—'));
      // 「设为默认」：把站点与守护启动时用的版本钉住（不改宿主 PATH，零侵入）
      td = add(row, el('td'));
      var pinBtn = add(td, el('button', 'btn', s.pinBusy === v.version ? tr('runtimes.pin.saving', '保存中…')
        : (s.pinnedVersion === v.version ? tr('runtimes.pin.reset', '取消默认') : tr('runtimes.pin.set', '设为默认'))));
      pinBtn.type = 'button'; pinBtn.disabled = !!s.pinBusy;
      pinBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        pinVersion(t, s, s.pinnedVersion === v.version ? '' : v.version);
      });
      if (!open) return;
      td = add(add(tbody, el('tr', 'rt-detail-row')), el('td'));
      td.colSpan = 5; td.appendChild(detailBox(t, s, v.version));
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

  // Python 专属「虚拟环境」面板：venv.list + venv.create + pip.install + pip.list。
  // 只由 paintBody 按 domain==='runtime-python' 调用；node/php tab 完全不渲染、不会误调。
  function venvPanel(t, s) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', tr('runtimes.venv.panel.title', '虚拟环境')));
    add(h, el('span', 'panel-meta', tr('runtimes.venv.panel.meta', '建独立环境、装依赖；只写插件允许目录，不影响系统 Python')));
    var rf = add(h, el('button', 'btn', tr('runtimes.venv.btn.refresh', '刷新列表')));
    rf.type = 'button'; rf.disabled = !!s.venvListLoading;
    rf.addEventListener('click', function () { loadVenvs(t, s); });

    // 建环境表单（schema 自动填默认 path；版本/初始包可留空）
    var form = add(p, el('div', 'rt-venv-form'));
    function field(label, hintText, placeholder, value, onChange) {
      var wrap = add(form, el('div', 'rt-field'));
      add(wrap, el('label', null, label));
      var input = add(wrap, el('input', 'rt-input'));
      input.type = 'text'; input.placeholder = placeholder; input.value = value || '';
      input.addEventListener('change', function () { onChange(input.value); });
      if (hintText) add(wrap, el('div', 'rt-field-hint', hintText));
      return input;
    }
    field(tr('runtimes.venv.field.path', '环境路径'), tr('runtimes.venv.field.pathHint', '留空用默认的 <允许目录>/venvs/venv；必须是允许目录内的绝对路径'),
      (s.venvRoot ? s.venvRoot.replace(/\/+$/, '') + '/venvs/venv' : '/…/venvs/myenv'), s.vPath, function (v) { s.vPath = v; });
    field(tr('runtimes.venv.field.version', 'Python 版本'), tr('runtimes.venv.field.versionHint', '可留空用系统 python3；或填 3.11 / 3.11.2'),
      '3.11', s.vVersion, function (v) { s.vVersion = v; });
    field(tr('runtimes.venv.field.pkgs', '初始依赖（可选）'), tr('runtimes.venv.field.pkgsHint', '空格分隔，例如 requests flask==3.0.0'),
      'requests flask==3.0.0', s.vPkgs, function (v) { s.vPkgs = v; });
    var actions = add(p, el('div', 'rt-venv-actions')), createBtn = add(actions, el('button', 'btn btn-primary', s.vBusy ? tr('runtimes.venv.btn.creating', '创建中…') : tr('runtimes.venv.btn.create', '建虚拟环境')));
    createBtn.type = 'button'; createBtn.disabled = !!s.vBusy;
    createBtn.addEventListener('click', function () { doVenvCreate(t, s); });
    add(actions, el('span', 'rt-field-hint', tr('runtimes.venv.create.note', '已存在同路径环境不会覆盖；装包可在下方每行操作')));
    if (s.vErr) p.appendChild(venvErrorBox(s.vErr));
    if (s.vMsg) add(p, el('div', 'rt-ok', s.vMsg));

    // 装包 / 查看包 的内联结果与输入（挂在对应 venv 行下方）
    function pipTools(venvPath) {
      var box = el('div', 'rt-detail');
      if (s.pkgFor === venvPath && s.pkgMode === 'install') {
        var row = add(box, el('div', 'rt-toolbar'));
        add(row, el('label', 'rt-label', tr('runtimes.venv.field.installPkgs', '要装的包')));
        var inp = add(row, el('input', 'rt-input'));
        inp.type = 'text'; inp.placeholder = 'requests flask==3.0.0'; inp.value = s.pkgInput || '';
        inp.addEventListener('change', function () { s.pkgInput = inp.value; });
        var go = add(row, el('button', 'btn btn-primary', s.pkgBusy ? tr('runtimes.venv.btn.installing', '安装中…（最多 120 秒）') : tr('runtimes.venv.btn.installGo', '开始安装')));
        go.type = 'button'; go.disabled = !!s.pkgBusy;
        go.addEventListener('click', function () { s.pkgInput = inp.value; doPipInstall(t, s, venvPath); });
        var cancel = add(row, el('button', 'btn', tr('runtimes.btn.cancel', '取消')));
        cancel.type = 'button';
        cancel.addEventListener('click', function () { s.pkgMode = ''; s.pkgFor = ''; s.pkgErr = null; s.pkgResult = null; paintBody(); });
        add(box, el('div', 'rt-field-hint', tr('runtimes.venv.install.note', '包名只字母数字和 . _ -、可带 ==版本；pip 从 PyPI 联网下载，失败时检查网络或镜像源。')));
      }
      if (s.pkgFor === venvPath && s.pkgErr) box.appendChild(venvErrorBox(s.pkgErr));
      if (s.pkgFor === venvPath && s.pkgResult) add(box, el('div', 'rt-ok', s.pkgResult));
      return box;
    }

    if (s.venvListError) { p.appendChild(venvErrorBox(s.venvListError)); return p; }
    if (s.venvs === null) { add(p, el('div', 'stub', tr('runtimes.venv.status.loading', '正在读取虚拟环境列表…'))); return p; }
    if (!s.venvs.length) {
      add(p, el('div', 'rt-note', tr('runtimes.venv.empty', '还没有虚拟环境。填好上方路径（留空用默认）后点「建虚拟环境」，即可拥有独立依赖空间。')));
      return p;
    }
    var scroll = add(p, el('div', 'rt-scroll')), table = add(scroll, el('table', 'rt-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    [tr('runtimes.venv.col.name', '环境名'), tr('runtimes.venv.col.path', '路径'), tr('runtimes.venv.col.version', 'Python 版本'), tr('runtimes.venv.col.actions', '操作')].forEach(function (x) { add(htr, el('th', null, x)); });
    var tbody = add(table, el('tbody'));
    s.venvs.forEach(function (v) {
      var rowNode = add(tbody, el('tr')), td, opened = s.pkgFor === v.path && (s.pkgMode === 'install' || !!s.pkgResult || !!s.pkgErr);
      add(add(rowNode, el('td')), el('span', null, v.name || '—'));
      add(add(rowNode, el('td', 'rt-path')), el('span', null, v.path || '—'));
      add(add(rowNode, el('td')), el('span', null, v.version || '—'));
      td = add(rowNode, el('td')), btns = add(td, el('div', 'rt-row-btns'));
      var bi = add(btns, el('button', 'btn', tr('runtimes.venv.btn.install', '装包')));
      bi.type = 'button';
      bi.addEventListener('click', function () {
        if (s.pkgFor === v.path && s.pkgMode === 'install') { s.pkgMode = ''; s.pkgFor = ''; }
        else { s.pkgFor = v.path; s.pkgMode = 'install'; s.pkgInput = ''; s.pkgErr = null; s.pkgResult = null; }
        paintBody();
      });
      var bl = add(btns, el('button', 'btn', s.pkgFor === v.path && s.pkgMode === 'list' && s.pkgBusy ? tr('runtimes.venv.btn.reading', '读取中…') : tr('runtimes.venv.btn.listPkgs', '查看包')));
      bl.type = 'button'; bl.disabled = !!s.pkgBusy;
      bl.addEventListener('click', function () { doPipList(t, s, v.path); });
      if (opened) { var dtd = add(add(tbody, el('tr', 'rt-detail-row')), el('td')); dtd.colSpan = 4; dtd.appendChild(pipTools(v.path)); }
    });
    add(p, el('div', 'rt-note', tr('runtimes.venv.count', '共 ') + s.venvs.length + tr('runtimes.venv.countSuffix', ' 个虚拟环境')));
    return p;
  }

  // ---- 默认版本（use）：把某个已装版本钉住，站点与守护启动时优先用它 ----
  function pinVersion(t, s, version) {
    s.pinBusy = version; s.pinErr = null; s.pinMsg = ''; paintBody();
    invoke(t.domain, 'use', { version: version }).then(function (d) {
      s.pinBusy = '';
      s.pinMsg = d.cleared
        ? tr('runtimes.pin.cleared', '已恢复跟随系统默认版本（点「重新探测」刷新）')
        : tr('runtimes.pin.done', '已把 ') + (d.version || version) + tr('runtimes.pin.doneSuffix', ' 设为默认版本：站点与「进程守护」启动时优先使用它');
      loadVersions(t, s);
      if (tab === t.id) paintBody();
    }, function (err) { s.pinBusy = ''; s.pinErr = err; if (tab === t.id) paintBody(); });
  }
  function pinHint(err) {
    var code = err && err.code ? String(err.code) : '';
    var m = (err && err.backendMessage) || (err && err.message) || '';
    if (code === 'E_NOTFOUND' || /未检测到|未安装/.test(m))
      return tr('runtimes.pin.hint.notfound', '先装好运行时再设默认版本；可用上方「安装提示」里的命令装一个，然后点「重新探测」。');
    if (code === 'E_INVALID') return tr('runtimes.pin.hint.invalid', '要设默认的版本必须在「版本列表」里（已检测到的）；刷新后重新点这一行的「设为默认」。');
    return tr('runtimes.pin.hint.generic', '请刷新页面重试；反复失败把下方错误详情反馈给管理员。');
  }

  // ---- 进程守护（guard.*）：启动 / 停止 / 重启 / 状态 / 日志尾部 ----
  // 不自动重启：没有常驻 supervisor（G-05 无中间件、G-19 不自起 ticker），
  // 进程退出后由这里显示「已退出」并给出日志入口，用户点一次「重启」即拉起。
  var GUARD_META = {
    running: ['ok', '运行中', 'runtimes.guard.state.running'],
    stopped: ['na', '已停止', 'runtimes.guard.state.stopped'],
    crashed: ['fail', '已退出', 'runtimes.guard.state.crashed']
  };
  function guardHint(err) {
    var code = err && err.code ? String(err.code) : '';
    var m = (err && err.backendMessage) || (err && err.message) || '';
    if (code === 'E_UNSUPPORTED' || /不支持/.test(m))
      return tr('runtimes.guard.hint.platform', '当前系统不支持进程守护（Linux / macOS 可用；其他系统仍能看列表）。');
    if (code === 'E_INVALID') return tr('runtimes.guard.hint.invalid', '检查填写内容：应用名用小写字母/数字/连字符；目录必须在 /var/www、/opt、/home 或 Kore 状态目录内；入口脚本要在该目录里。');
    if (code === 'E_NOTFOUND' || /未找到该应用/.test(m)) return tr('runtimes.guard.hint.notfound', '该应用还没添加：先点「添加应用」填好名称、目录与入口脚本。');
    return tr('runtimes.guard.hint.generic', '请刷新重试；反复失败看「日志」里的最后几行，或把下方错误详情反馈给管理员。');
  }
  function guardErrBox(err) {
    var box = el('div', 'rt-error'), msg = (err && err.backendMessage) || (err && err.message) || String(err);
    add(box, el('div', null, tr('runtimes.guard.err.title', '操作失败：') + msg));
    add(box, el('div', 'rt-fix', tr('runtimes.guard.err.howto', '怎么办：') + guardHint(err)));
    var det = add(box, el('details', 'rt-err-detail'));
    add(det, el('summary', null, tr('runtimes.guard.err.detail', '错误详情')));
    add(det, el('code', 'rt-cmd', (err && err.code ? err.code + ' · ' : '') + msg));
    return box;
  }
  function guardStateChip(state) {
    var meta = GUARD_META[state] || GUARD_META.stopped;
    return statusChip(meta[0], tr(meta[2], meta[1]));
  }
  function loadGuard(t, s) {
    s.guardLoading = true; s.guardError = '';
    invoke(t.domain, 'guard.list', {}).then(function (d) {
      s.guardLoading = false;
      s.guard = Array.isArray(d.apps) ? d.apps : [];
      s.guardRoot = d.root || s.guardRoot;
      if (!s.gScript) s.gScript = t.edge;
      if (!s.gDir && s.root) s.gDir = s.root;
      if (tab === t.id) paintBody();
    }, function (err) { s.guardLoading = false; s.guardError = err; if (tab === t.id) paintBody(); });
  }
  function doGuard(t, s, action, name) {
    var params = {};
    if (action === 'restart' || action === 'remove') params = { name: name || '' };
    else if (name) params = { names: [name] };
    s.guardBusy = action + ':' + (name || '*'); s.guardErr = null; s.guardMsg = ''; paintBody();
    invoke(t.domain, 'guard.' + action, params, 30000).then(function (d) {
      s.guardBusy = '';
      if (Array.isArray(d.apps)) s.guard = d.apps;
      var failed = d.failed || 0;
      var first = (d.apps || []).filter(function (a) { return !!a.error; })[0];
      if (failed && first) s.guardErr = new Error(first.error);
      if (action === 'start') {
        s.guardMsg = d.started ? tr('runtimes.guard.msg.started', '已启动 ') + d.started + tr('runtimes.guard.msg.startedSuffix', ' 个应用')
          : (d.already_running ? tr('runtimes.guard.msg.already', '已在运行，无需重复启动') : '');
      } else if (action === 'stop') {
        s.guardMsg = d.stopped ? tr('runtimes.guard.msg.stopped', '已停止 ') + d.stopped + tr('runtimes.guard.msg.stoppedSuffix', ' 个应用') : '';
      } else if (action === 'restart') {
        s.guardMsg = tr('runtimes.guard.msg.restarted', '已重启；新日志从这次启动开始追加');
      } else if (action === 'remove') {
        s.guardMsg = tr('runtimes.guard.msg.removed', '已删除该应用（进程需先停止才能删）');
        loadGuard(t, s);
      }
      if (tab === t.id) paintBody();
    }, function (err) { s.guardBusy = ''; s.guardErr = err; if (tab === t.id) paintBody(); });
  }
  function doGuardAdd(t, s) {
    var name = (s.gName || '').trim(), dir = (s.gDir || '').trim(), script = (s.gScript || '').trim();
    if (!name || !dir || !script) {
      s.guardErr = new Error(tr('runtimes.guard.err.required', '请把应用名、目录、入口脚本都填上：目录可在「项目扫描」里复制，脚本通常是 app.js / app.py / index.php'));
      s.guardMsg = ''; paintBody(); return;
    }
    var args = (s.gArgs || '').split(/\s+/).filter(function (x) { return !!x; });
    s.guardBusy = 'add'; s.guardErr = null; s.guardMsg = ''; paintBody();
    invoke(t.domain, 'guard.add', { name: name, dir: dir, script: script, args: args, version: (s.gVersion || '') }).then(function () {
      s.guardBusy = ''; s.gName = ''; s.gArgs = ''; s.gShowForm = false;
      s.guardMsg = tr('runtimes.guard.added', '已添加；点行内「启动」即拉起进程（日志写到插件状态目录）。');
      loadGuard(t, s);
    }, function (err) { s.guardBusy = ''; s.guardErr = err; if (tab === t.id) paintBody(); });
  }
  function doGuardLogs(t, s, name) {
    if (s.gLogFor === name && s.gLog) { s.gLogFor = ''; s.gLog = null; paintBody(); return; }
    s.gLogFor = name; s.gLogLoading = true; s.gLogError = ''; s.gLog = null; paintBody();
    invoke(t.domain, 'guard.logs', { name: name, lines: 200 }, 25000).then(function (d) {
      s.gLogLoading = false; s.gLog = d;
      if (tab === t.id) paintBody();
    }, function (err) { s.gLogLoading = false; s.gLogError = err; if (tab === t.id) paintBody(); });
  }
  function guardPanel(t, s) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', tr('runtimes.guard.panel', '进程守护')));
    add(h, el('span', 'panel-meta', tr('runtimes.guard.meta', '启动 / 停止 / 重启单个进程，看日志尾部；不做集群与编排')));
    var tools = add(p, el('div', 'rt-guard-meta'));
    var refresh = add(tools, el('button', 'btn', tr('runtimes.guard.btn.refresh', '刷新状态')));
    refresh.type = 'button'; refresh.disabled = !!s.guardLoading;
    refresh.addEventListener('click', function () { loadGuard(t, s); });
    var addBtn = add(tools, el('button', 'btn btn-primary', s.gShowForm ? tr('runtimes.guard.btn.cancelAdd', '取消添加') : tr('runtimes.guard.btn.add', '添加应用')));
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () { s.gShowForm = !s.gShowForm; s.guardErr = null; paintBody(); });
    var startAll = add(tools, el('button', 'btn', tr('runtimes.guard.btn.startAll', '全部启动')));
    startAll.type = 'button'; startAll.disabled = !s.guard || !s.guard.length || !!s.guardBusy;
    startAll.addEventListener('click', function () { doGuard(t, s, 'start', ''); });
    var stopAll = add(tools, el('button', 'btn', tr('runtimes.guard.btn.stopAll', '全部停止')));
    stopAll.type = 'button'; stopAll.disabled = !s.guard || !s.guard.length || !!s.guardBusy;
    stopAll.addEventListener('click', function () { doGuard(t, s, 'stop', ''); });
    if (s.guardRoot) add(tools, el('span', 'rt-field-hint', tr('runtimes.guard.rootPrefix', '日志目录：') + s.guardRoot));

    if (s.gShowForm) {
      var form = add(p, el('div', 'rt-venv-form'));
      function field(label, hintText, placeholder, value, onChange) {
        var wrap = add(form, el('div', 'rt-field'));
        add(wrap, el('label', null, label));
        var input = add(wrap, el('input', 'rt-input'));
        input.type = 'text'; input.placeholder = placeholder; input.value = value || '';
        input.addEventListener('change', function () { onChange(input.value); });
        if (hintText) add(wrap, el('div', 'rt-field-hint', hintText));
        return input;
      }
      field(tr('runtimes.guard.field.name', '应用名'), tr('runtimes.guard.field.nameHint', '小写字母/数字/连字符，例如 my-api'), 'my-api', s.gName, function (v) { s.gName = v; });
      field(tr('runtimes.guard.field.dir', '目录'), tr('runtimes.guard.field.dirHint', '项目根目录，须在 /var/www、/opt、/home 或 Kore 状态目录内'), '/var/www/my-api', s.gDir, function (v) { s.gDir = v; });
      field(tr('runtimes.guard.field.script', '入口脚本'), tr('runtimes.guard.field.scriptHint', '相对目录的入口文件，例如 ' + t.edge), t.edge, s.gScript, function (v) { s.gScript = v; });
      field(tr('runtimes.guard.field.args', '附加参数（可选）'), tr('runtimes.guard.field.argsHint', '空格分隔，例如 --port 3000'), '--port 3000', s.gArgs, function (v) { s.gArgs = v; });
      var vs = add(form, el('div', 'rt-field'));
      add(vs, el('label', null, tr('runtimes.guard.field.version', '运行版本')));
      var select = add(vs, el('input', 'rt-input'));
      select.type = 'text'; select.placeholder = tr('runtimes.guard.field.versionPlaceholder', '留空 = 默认版本');
      select.value = s.gVersion || '';
      select.setAttribute('list', 'rt-guard-versions');
      select.addEventListener('change', function () { s.gVersion = select.value.trim(); });
      var dl = add(vs, el('datalist')); dl.id = 'rt-guard-versions';
      (s.versions || []).forEach(function (v) { add(dl, el('option')).value = v.version; });
      add(vs, el('div', 'rt-field-hint', tr('runtimes.guard.field.versionHint', '只能填「版本列表」里已有的版本；留空用默认版本')));
      var actions = add(p, el('div', 'rt-venv-actions'));
      var save = add(actions, el('button', 'btn btn-primary', s.guardBusy === 'add' ? tr('runtimes.guard.btn.adding', '添加中…') : tr('runtimes.guard.btn.save', '保存应用')));
      save.type = 'button'; save.disabled = s.guardBusy === 'add';
      save.addEventListener('click', function () { doGuardAdd(t, s); });
      add(actions, el('span', 'rt-field-hint', tr('runtimes.guard.add.note', '守护只在本机跑单进程；崩溃不会自动重启，会显示「已退出」并保留日志')));
    }

    if (s.guardErr) p.appendChild(guardErrBox(s.guardErr));
    if (s.guardMsg) add(p, el('div', 'rt-ok', s.guardMsg));
    if (s.guardError) { p.appendChild(guardErrBox(s.guardError)); return p; }
    if (s.guard === null) { add(p, el('div', 'stub', tr('runtimes.guard.loading', '正在读取守护列表…'))); return p; }
    if (!s.guard.length) {
      add(p, el('div', 'rt-note', tr('runtimes.guard.empty', '还没有被守护的应用。点「添加应用」填名称 / 目录 / 入口脚本，然后「启动」——适合常驻的 Node / Python / PHP 服务。')));
      return p;
    }
    var scroll = add(p, el('div', 'rt-scroll')), table = add(scroll, el('table', 'rt-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    [tr('runtimes.guard.col.name', '应用'), tr('runtimes.guard.col.dir', '目录 / 入口'), tr('runtimes.guard.col.state', '状态'),
      tr('runtimes.guard.col.version', '版本'), tr('runtimes.guard.col.actions', '操作')].forEach(function (x) { add(htr, el('th', null, x)); });
    var tbody = add(table, el('tbody'));
    s.guard.forEach(function (a) {
      var running = a.state === 'running';
      var row = add(tbody, el('tr')), td;
      var nameCell = add(row, el('td'));
      add(nameCell, el('span', null, a.name || '—'));
      if (a.pid) add(nameCell, el('span', 'rt-muted', tr('runtimes.guard.pid', ' · 进程 ') + a.pid));
      td = add(row, el('td', 'rt-path'));
      add(td, el('div', null, a.dir || '—'));
      add(td, el('div', 'rt-muted', a.script || '—'));
      td = add(row, el('td'));
      add(td, guardStateChip(a.state));
      if (running) add(td, el('div', 'rt-muted', tr('runtimes.guard.uptime', '已运行 ') + fmtDuration(a.uptime_s) + (a.rss_kb ? ' · 内存 ' + fmtKB(a.rss_kb) : '')));
      else if (a.error) add(td, el('div', 'rt-error', a.error));
      else if (a.last_error) add(td, el('div', 'rt-muted', a.last_error));
      add(add(row, el('td')), el('span', 'rt-muted', a.version || tr('runtimes.guard.defaultVersion', '默认')));
      td = add(row, el('td'));
      var btns = add(td, el('div', 'rt-row-btns'));
      function actionBtn(label, action, cls) {
        var b = add(btns, el('button', 'btn' + (cls ? ' ' + cls : ''), label));
        b.type = 'button'; b.disabled = !!s.guardBusy && s.guardBusy !== action + ':*';
        b.addEventListener('click', function () { doGuard(t, s, action, a.name); });
        return b;
      }
      if (running) {
        actionBtn(tr('runtimes.guard.btn.stop', '停止'), 'stop');
        actionBtn(tr('runtimes.guard.btn.restart', '重启'), 'restart');
      } else {
        actionBtn(tr('runtimes.guard.btn.start', '启动'), 'start', 'btn-primary');
      }
      var logBtn = add(btns, el('button', 'btn', s.gLogFor === a.name ? tr('runtimes.guard.btn.hideLog', '收起日志') : tr('runtimes.guard.btn.logs', '日志')));
      logBtn.type = 'button';
      logBtn.addEventListener('click', function () { doGuardLogs(t, s, a.name); });
      var del = add(btns, el('button', 'btn', tr('runtimes.guard.btn.remove', '删除')));
      del.type = 'button'; del.disabled = running;
      del.title = running ? tr('runtimes.guard.remove.running', '运行中的进程不能删除，先停止') : '';
      del.addEventListener('click', function () { doGuard(t, s, 'remove', a.name); });
      if (s.gLogFor !== a.name) return;
      var logRow = add(tbody, el('tr', 'rt-detail-row')), logCell = add(logRow, el('td'));
      logCell.colSpan = 5;
      if (s.gLogError) logCell.appendChild(guardErrBox(s.gLogError));
      else if (s.gLogLoading) add(logCell, el('div', 'rt-note', tr('runtimes.guard.logLoading', '正在读取日志…')));
      else if (s.gLog) {
        add(logCell, el('div', 'rt-note', tr('runtimes.guard.logPath', '日志文件：') + (s.gLog.path || '—')
          + (s.gLog.total_lines != null ? tr('runtimes.guard.logCount', ' · 最近 ') + s.gLog.returned + tr('runtimes.guard.logCountSuffix', ' 行') : '')
          + (s.gLog.truncated ? tr('runtimes.guard.logTruncated', ' · 太长已截断') : '')));
        if (s.gLog.hint) add(logCell, el('div', 'rt-note', s.gLog.hint));
        var pre = add(logCell, el('pre', 'rt-log'));
        pre.textContent = (s.gLog.lines && s.gLog.lines.length) ? s.gLog.lines.join('\n') : tr('runtimes.guard.logEmpty', '（日志为空）');
      }
    });
    return p;
  }
  function fmtDuration(seconds) {
    var s2 = typeof seconds === 'number' && seconds > 0 ? seconds : 0;
    if (s2 < 60) return s2 + 's';
    if (s2 < 3600) return Math.floor(s2 / 60) + tr('runtimes.unit.minutes', ' 分钟');
    if (s2 < 86400) return Math.floor(s2 / 3600) + tr('runtimes.unit.hours', ' 小时');
    return Math.floor(s2 / 86400) + tr('runtimes.unit.days', ' 天');
  }
  function fmtKB(kb) {
    if (typeof kb !== 'number' || !isFinite(kb) || kb <= 0) return '—';
    if (kb < 1024) return kb + ' KiB';
    if (kb < 1024 * 1024) return (kb / 1024).toFixed(1) + ' MiB';
    return (kb / 1024 / 1024).toFixed(1) + ' GiB';
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
    bodyBox.appendChild(guardPanel(t, s)); // 三 tab 共用：启动/停止/重启/状态/日志尾部
    // 仅 Python runtime 显示虚拟环境区；domain 是运行时变量、非常量，node/php 走不到这个分支
    if (t.domain === 'runtime-python') bodyBox.appendChild(venvPanel(t, s));
    if (s.versions && s.versions.length) bodyBox.appendChild(projectsPanel(t, s));
    bodyBox.appendChild(doctorPanel(t, s));
  }
  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    ensureCss();
    var page = el('div', 'rt-page'), head = add(page, el('div', 'rt-head')), left = add(head, el('div', 'rt-head-main')), refresh;
    add(left, el('h2', 'rt-title', tr('runtimes.title', '运行环境')));
    add(left, el('p', 'rt-sub', tr('runtimes.subtitle', 'Node.js / PHP / Python 的版本、详情、项目与健康检查；Python 另可建虚拟环境、装依赖（仅写插件允许目录）。')));
    refresh = add(add(head, el('div', 'rt-actions')), el('button', 'btn', tr('runtimes.btn.redetect', '重新探测')));
    refresh.type = 'button';
    refresh.addEventListener('click', function () {
      var s = state[tab];
      s.versions = null; s.error = ''; s.doctor = null; s.doctorError = ''; s.selected = '';
      s.guard = null; s.guardError = ''; s.gLogFor = ''; s.gLog = null; s.pinMsg = ''; s.pinErr = null;
      if (tab === 'python') { s.venvs = null; s.venvListError = ''; s.pkgFor = ''; s.pkgMode = ''; s.pkgResult = null; s.pkgErr = null; }
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
