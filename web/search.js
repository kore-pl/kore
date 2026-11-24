/* kore 主壳 · 全局搜索命令面板（web/search.js，懒加载）
   六源：页面（16 视图 + 别名，本地常量）、站点（site.list 真实数据）、文件（file.search 按词实时查）、
        已装插件、商店未装插件、常用操作。
   交互：200ms 防抖、分组各 ≤5、↑↓/Enter/Esc；站点首次打开拉一次缓存，文件按输入词防抖查询并按词缓存。
   对外只暴露 window.KoreSearch = { open, close }；首屏只由 shell.js 放入口。 */
(function () {
  'use strict';
  var EP = { installed: '/api/v1/plugins', store: '/api/v1/store/plugins',
    invoke: '/api/v1/invoke/' };
  var PAGES = [
    ['dashboard', '概览', '主页 首页 控制台 总览 dashboard home overview'],
    ['monitor', '监控', '性能 资源 cpu 内存 monitor'],
    ['logs', '日志', '系统日志 运行日志 logs'],
    ['process', '进程', '进程管理 ps process'],
    ['terminal', '终端', '命令行 shell terminal'],
    ['sites', '网站', '站点 建站 site nginx web'],
    ['db', '数据库', 'mysql mariadb db database 数据库管理'],
    ['redis', 'Redis', '缓存 redis cache'],
    ['tasks', '计划任务', '任务 cron 定时 tasks'],
    ['files', '文件管理', '文件 上传 下载 files file'],
    ['backup', '备份', '备份 恢复 backup'],
    ['ssl', 'SSL', '证书 https ssl 证书管理'],
    ['store', '软件商店', '商店 市场 store 插件商店'],
    ['plugins', '已装插件', '插件 已安装 plugins'],
    ['firewall', '防火墙', 'firewall ufw 安全'],
    ['settings', '设置', '配置 参数 settings']
  ];
  // 插件 id → 用户常用中文别名（插件名未必含「数据」「缓存」，靠它补齐可检索性）。
  var ALIASES = { 'db-mysql': '数据库 数据 mysql mariadb', 'db-postgres': '数据库 数据 postgres',
    redis: '缓存 数据 redis', backup: '备份 恢复', cron: '计划任务 定时 任务', site: '网站 站点 建站',
    firewall: '防火墙 安全', ssl: '证书 https', file: '文件 上传 下载', logs: '日志', monitor: '监控 性能' };
  // [名称, 检索词, 落地视图, 跳转前钩子, 跳转后钩子]
  var ACTIONS = [
    ['新建数据库', '数据库 建库 创建 db', 'db', null, function () { clickText('.db-toolbar button', '新建数据库'); }],
    ['创建站点', '网站 站点 建站 sites', 'sites', null, function () { focusSel('.site-wizard-host input'); }],
    ['上传文件', '文件 上传 files', 'files', null, null],
    ['新建任务', '计划任务 定时 新增 cron', 'tasks', null, function () { focusSel('.task-form .field-input'); }],
    ['创建备份', '备份 新建 backup', 'backup', null, function () { focusSel('.bak-form input'); }],
    ['查看操作审计', '审计 记录 安全 settings', 'settings', function () { window.__koreSettingsTab = 'audit'; }, null],
    ['安装插件', '插件 商店 安装 store', 'store', null, null]
  ];
  var S = { open: false, sel: 0, items: [], nodes: [], timer: 0, root: null, input: null, list: null };
  var data = { installed: null, store: null, error: '', promise: null,
    sites: null, sitesError: '', fileCache: {}, fileError: '', fileLoading: false, fileQuery: '', fileToken: 0 };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
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
  function spotlight(sel) {
    waitFor(function () {
      var n = document.querySelector(sel); if (!n) return false;
      scrollTo(n); n.style.outline = '2px solid var(--kore-info)'; n.style.outlineOffset = '2px';
      setTimeout(function () { n.style.outline = ''; n.style.outlineOffset = ''; }, 2400);
      return true;
    });
  }
  function spotlightStore(id) {
    waitFor(function () {
      var q = document.querySelector('.store-search'); if (!q) return false;
      if (q.value !== id) { q.value = id; q.dispatchEvent(new Event('input', { bubbles: true })); }
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
          if (!res.ok) throw new Error('HTTP ' + res.status);
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
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error(tr('search.err.noCsrf', '缺少安全令牌，请刷新页面或重新登录')));
    return fetch(EP.invoke + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var body = {};
        if (raw) { try { body = JSON.parse(raw); } catch (e) { body = {}; } }
        if (!res.ok) throw new Error(body.message || (tr('search.err.http', '请求失败（HTTP ') + res.status + '）'));
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
    var key = q.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(data.fileCache, key)) return Promise.resolve();
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
  function openSite(domain) {
    go('sites');
    waitFor(function () {
      var links = document.querySelectorAll('button.site-link[data-site]');
      for (var i = 0; i < links.length; i++) {
        if (links[i].getAttribute('data-site') !== domain) continue;
        scrollTo(links[i]); links[i].click(); return true;
      }
      return false;
    });
  }
  function openFile(entry) {
    go('files');
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
        scrollTo(rows[i]);
        rows[i].style.outline = '2px solid var(--kore-info)';
        setTimeout(function () { rows[i].style.outline = ''; }, 2400);
        return true;
      }
      return false;
    }, 7000);
  }
  // 结果对象只带 title/sub/run：分组只影响展示顺序，执行逻辑与来源解耦。
  function buildGroups(q) {
    var n = q.toLowerCase(), installed = data.installed || [], storeList = data.store || [], ids = {};
    var pages = [], sites = [], files = [], plugins = [], store = [], acts = [];
    function hit(s) { return String(s || '').toLowerCase().indexOf(n) >= 0; }
    (data.sites || []).forEach(function (s) {
      if (!hit(s.domain)) return;
      sites.push({ title: tr('search.label.site', '站点 · ') + s.domain,
        sub: tr('search.label.site', '站点 · ') + (s.enabled ? tr('search.site.enabled', '已启用') : tr('search.site.disabled', '已停用')) + ' · ' + s.domain,
        run: function () { openSite(s.domain); } });
    });
    var cached = Object.prototype.hasOwnProperty.call(data.fileCache, n) ? data.fileCache[n] : null;
    (cached || []).forEach(function (entry) {
      var path = String(entry.path || '');
      if (!hit(path)) return;
      files.push({ title: (entry.is_dir ? tr('search.kind.dir', '目录') : tr('search.kind.file', '文件')) + ' · ' + path.split('/').pop(),
        sub: tr('search.label.file', '文件 · /') + path.replace(/^\/+/, ''),
        run: function () { openFile(entry); } });
    });
    PAGES.forEach(function (p) {
      if (hit(p[1] + ' ' + p[2])) pages.push({ title: tr('search.label.goto', '跳转到 ') + p[1], sub: tr('search.label.page', '页面 · ') + p[1],
        run: function () { go(p[0]); } });
    });
    installed.forEach(function (p) {
      ids[p.id] = 1;
      if (hit(p.id + ' ' + p.name + ' ' + (ALIASES[p.id] || ''))) plugins.push({
        title: tr('search.label.openPlugin', '打开插件详情 · ') + p.name, sub: tr('search.label.installed', '已装插件 · ') + p.id,
        run: function () { go('plugins'); spotlight('#view tr[data-plugin-id="' + p.id + '"]'); }
      });
    });
    storeList.forEach(function (s) {
      if (ids[s.id] || !hit(s.id + ' ' + s.name + ' ' + (ALIASES[s.id] || ''))) return;
      store.push({ title: tr('search.label.installFromStore', '去商店安装 · ') + s.name, sub: tr('search.label.storePlugin', '商店插件 · ') + s.id,
        run: function () { go('store'); spotlightStore(s.id); } });
    });
    ACTIONS.forEach(function (a) {
      if (!hit(a[0] + ' ' + a[1])) return;
      acts.push({ title: tr('search.label.execute', '执行：') + a[0], sub: tr('search.label.action', '操作 · ') + a[0], run: function () {
        if (a[3]) a[3](); go(a[2]); if (a[4]) a[4]();
      } });
    });
    return [[tr('search.group.sites', '站点'), sites.slice(0, 5)], [tr('search.group.files', '文件'), files.slice(0, 5)],
      [tr('search.group.pages', '页面'), pages.slice(0, 5)], [tr('search.group.plugins', '插件'), plugins.slice(0, 5)],
      [tr('search.group.store', '商店'), store.slice(0, 5)], [tr('search.group.acts', '操作'), acts.slice(0, 5)]];
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
  function paint() {
    var q = S.input.value.trim();
    var fk = q.toLowerCase();
    if (q && !Object.prototype.hasOwnProperty.call(data.fileCache, fk) && data.fileQuery !== fk) loadFiles(q);
    S.list.textContent = ''; S.items = []; S.nodes = []; S.sel = 0;
    if (!q) {
      S.list.appendChild(el('div', 'kore-search-note', tr('search.note.hint', '输入关键词：站点域名、文件名、页面名、插件 id/名称、动作（如 数据库 / 备份 / 新建）')));
      return;
    }
    buildGroups(q).forEach(function (grp) {
      if (!grp[1].length) return;
      S.list.appendChild(el('div', 'kore-search-group', grp[0]));
      grp[1].forEach(function (it) {
        var idx = S.items.length, btn = el('button', 'kore-search-item');
        btn.type = 'button'; btn.setAttribute('role', 'option'); btn.setAttribute('aria-selected', 'false');
        btn.appendChild(el('span', 'kore-search-item-title', it.title));
        btn.appendChild(el('span', 'kore-search-item-sub', it.sub));
        btn.addEventListener('mouseenter', function () { select(idx); });
        btn.addEventListener('click', function () { execute(it); });
        S.list.appendChild(btn); S.items.push(it); S.nodes.push(btn);
      });
    });
    if (!S.items.length) S.list.appendChild(el('div', 'kore-search-empty', tr('search.empty.prefix', '没找到「') + q + tr('search.empty.suffix', '」，试试：数据库 / 站点 / 备份')));
    else select(0);
    if (q) {
      var fk2 = q.toLowerCase(), hasFile = Object.prototype.hasOwnProperty.call(data.fileCache, fk2);
      if (data.fileLoading && data.fileQuery === fk2 && !hasFile) {
        S.list.appendChild(el('div', 'kore-search-note', tr('search.note.searchingPrefix', '正在按文件名搜索「') + q + tr('search.note.searchingSuffix', '」…')));
      } else if (data.fileError && !hasFile) {
        S.list.appendChild(el('div', 'kore-search-note', data.fileError));
      }
    }
    if (!data.sites && !data.sitesError) {
      S.list.appendChild(el('div', 'kore-search-note', tr('search.note.sitesLoading', '站点列表加载中…')));
    } else if (data.sitesError) {
      S.list.appendChild(el('div', 'kore-search-note', data.sitesError));
    }
    if ((!data.installed || !data.store) && !data.error) {
      S.list.appendChild(el('div', 'kore-search-note', tr('search.note.pluginsLoading', '插件与商店数据加载中…')));
    } else if (data.error && (!data.installed || !data.store)) {
      S.list.appendChild(el('div', 'kore-search-note', data.error + tr('search.note.partialOk', '（页面与操作仍可搜索）')));
    }
  }
  function execute(item) { close(); if (item && typeof item.run === 'function') item.run(); }
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
    '.kore-search-backdrop[hidden]{display:none}.kore-search-modal{width:min(620px,100%);max-height:72vh;display:flex;flex-direction:column;background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:8px;box-shadow:var(--kore-shadow);overflow:hidden}' +
    '.kore-search-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--kore-border-1)}.kore-search-bar svg{width:18px;height:18px;color:var(--kore-text-3);flex:0 0 auto}' +
    '.kore-search-input{flex:1 1 auto;min-width:0;background:transparent;border:0;outline:none;color:var(--kore-text-1);font-size:var(--kore-font-16)}.kore-search-kbd{font-size:11px;color:var(--kore-text-3);border:1px solid var(--kore-border-1);border-radius:4px;padding:1px 5px}' +
    '.kore-search-list{overflow-y:auto;padding:4px 0;min-height:80px}.kore-search-group{padding:8px 12px 4px;font-size:11px;color:var(--kore-text-3);letter-spacing:.04em}' +
    '.kore-search-item{display:block;width:100%;text-align:left;background:transparent;border:0;padding:7px 12px;cursor:pointer;color:var(--kore-text-1)}.kore-search-item.is-active{background:var(--kore-bg-2);box-shadow:inset 2px 0 0 var(--kore-info)}' +
    '.kore-search-item-title{display:block;font-size:var(--kore-font-14);word-break:break-word}.kore-search-item-sub{display:block;font-size:11px;color:var(--kore-text-3);margin-top:2px;word-break:break-word}' +
    '.kore-search-note,.kore-search-empty{padding:12px;color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.6}.kore-search-foot{padding:6px 12px;border-top:1px solid var(--kore-border-2);font-size:11px;color:var(--kore-text-3)}' +
    '.kore-search-lock{overflow:hidden}@media (max-width:639px){.kore-search-backdrop{padding:6vh 8px 8px}.kore-search-modal{max-height:80vh}.kore-search-kbd{display:none}.kore-search-item{padding:10px 12px;min-height:44px}}';
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
    input.type = 'search'; input.placeholder = tr('search.aria.placeholder', '搜索站点、文件、页面、插件与操作…');
    input.setAttribute('aria-label', tr('search.aria.keyword', '全局搜索关键词')); input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', function () { clearTimeout(S.timer); S.timer = setTimeout(paint, 200); });
    input.addEventListener('keydown', onKey);
    bar.appendChild(svg); bar.appendChild(input); bar.appendChild(el('span', 'kore-search-kbd', 'Esc'));
    var list = el('div', 'kore-search-list'); list.setAttribute('role', 'listbox');
    modal.appendChild(bar); modal.appendChild(list);
    modal.appendChild(el('div', 'kore-search-foot', tr('search.foot.keys', '↑↓ 选择 · Enter 执行 · Esc 关闭')));
    modal.addEventListener('click', function (ev) { ev.stopPropagation(); });
    backdrop.appendChild(modal); document.body.appendChild(backdrop);
    S.root = backdrop; S.input = input; S.list = list;
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
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && S.open) { ev.preventDefault(); close(); }
  });
  window.KoreSearch = { open: open, close: close };
})();
