/* kore 主壳 · 站点迁移（web/site-migrate.js）——零框架 / 零 CDN / 无外链。
   window.KoreSiteMigrate.render(container) → { destroy }，由主壳懒加载（不进首屏预算）。

   【这个页面解决什么】
   从宝塔面板 / 1Panel 换到 Kore 时，最贵的不是"装 Kore"，而是"把现有站点搬过来"。
   本页只读解析对方面板写下的 nginx 站点配置 → 一次看清"哪些能搬、哪些不能、为什么、怎么办"
   → 勾选后逐条建站（调 site 插件自己的 site.create / bindSSL）→ 建完回读校验（nginx -t 若可用，
   否则如实标注"未校验：本机没有 nginx"）。

   【边界（为什么这样切）】
   · 只读：本页不写源面板一个字节（后端也只有 os.ReadFile），源面板必须保持可用；
   · 不自己写 nginx：建站走 site 插件方法，权限 / 审计 / nginx -t / 回滚都在插件侧；
   · 显式确认：导入前列出将创建什么，点「确认导入」才落地（危险操作的可逆性优先于点击次数）；
   · 不猜：解析不出的一律进「不能搬」并写清原因，不静默跳过一个站。
   数据形状（后端 DTO，G-24 显式字段）见 internal/core/httpapi/handlers_site_import.go。 */
(function () {
  'use strict';
  var SCAN_URL = '/api/v1/site-import/scan';
  var CSS_ID = 'kore-site-migrate-css';

  var state = {
    root: null, gen: 0, destroyed: false,
    scanning: false, importing: false,
    scan: null,               // 后端扫描结果
    existing: null,           // site.list 结果（冲突检测用）
    existingErr: '',          // site 插件不可用时的说明（不阻断导入，只降级）
    selected: {},             // site.id -> true
    panel: 'auto',            // 面板过滤
    customRoot: '',           // 自定义目录
    advancedOpen: false,
    confirmOpen: false,
    results: [],              // 逐条导入结果
    progress: null,           // { done, total, current }
    verifyNote: '',
    msgText: '', msgTone: '', msgEl: null
  };

  // ── 小工具 ──────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function button(parent, label, cls, fn) {
    var b = add(parent, el('button', 'btn' + (cls ? ' ' + cls : ''), label));
    b.type = 'button';
    if (fn) b.addEventListener('click', fn);
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
  function alive(gen) { return !state.destroyed && state.gen === gen; }
  function setMsg(text, tone) {
    state.msgText = text || '';
    state.msgTone = tone || '';
    paintMsg();
  }
  function clearMsg() { setMsg('', ''); }

  // 读接口：GET 带 CSRF 头也无副作用，cookie 缺失时照常发（后端只校验会话）。
  function apiGet(url) {
    var token = cookie('kore_csrf');
    var headers = { Accept: 'application/json' };
    if (token) headers['X-Kore-CSRF'] = token;
    return fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: headers })
      .then(function (res) {
        return res.text().then(function (raw) {
          var data = {};
          if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
          if (!res.ok) {
            var err = new Error(data.message || ('读取失败（HTTP ' + res.status + '）'));
            err.code = data.code || '';
            err.detail = data.detail || '';
            throw err;
          }
          return data;
        });
      });
  }

  // 插件方法调用（建站 / 绑定证书 / 回读状态），与 sites.js 同一入口。
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少安全令牌，请刷新页面或重新登录后再试'));
    return fetch('/api/v1/invoke/site/' + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        'X-Kore-CSRF': token
      },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error(data.message || ('操作失败（HTTP ' + res.status + '）'));
          err.code = data.code || '';
          err.detail = data.detail || '';
          throw err;
        }
        return data;
      });
    });
  }

  function errText(err) {
    if (!err) return '未知原因';
    var text = err.message ? String(err.message) : '未知原因';
    if (err.detail && text.indexOf(err.detail) < 0) text += '（' + err.detail + '）';
    return text;
  }

  // ── 样式（私有前缀 smg-，只注入一次）────────────────────────────────────
  function injectCSS() {
    if (document.getElementById(CSS_ID)) return;
    var s = el('style'); s.id = CSS_ID;
    s.textContent = [
      '.smg-wrap{display:grid;grid-template-columns:1fr;gap:var(--kore-space-3,12px);padding:var(--kore-space-4,16px);}',
      '.smg-wrap>*{min-width:0;}',
      '.smg-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2,8px);}',
      '.smg-h2{margin:0;font-size:var(--kore-font-16,16px);font-weight:600;flex:1 1 240px;}',
      '.smg-sub{margin:0;color:var(--kore-text-2);font-size:var(--kore-font-12,12px);line-height:1.7;}',
      '.smg-msg{min-height:20px;font-size:var(--kore-font-12,12px);word-break:break-word;}',
      '.smg-msg.warn{color:var(--kore-warning-text,inherit);}',
      '.smg-msg.err{color:var(--kore-danger-text,#b3261e);}',
      '.smg-card{border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-container,8px);',
      'padding:var(--kore-space-3,12px);display:grid;gap:var(--kore-space-2,8px);min-width:0;}',
      '.smg-card>*{min-width:0;}',
      '.smg-step{display:flex;align-items:center;gap:8px;margin:0;font-size:var(--kore-font-14,14px);font-weight:600;}',
      '.smg-step-num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;',
      'border-radius:50%;background:var(--kore-accent,#2b6cb0);color:#fff;font-size:12px;font-weight:600;}',
      '.smg-chips{display:flex;flex-wrap:wrap;gap:8px;}',
      '.smg-chip{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:4px 10px;max-width:100%;',
      'border:1px solid var(--kore-border-2);border-radius:999px;font-size:var(--kore-font-12,12px);',
      'word-break:break-all;overflow-wrap:anywhere;}',
      '.smg-chip.ok{border-color:var(--kore-success-border,#2f855a);}',
      '.smg-chip.miss{color:var(--kore-text-3);}',
      '.smg-ops{display:flex;flex-wrap:wrap;gap:var(--kore-space-2,8px);align-items:center;}',
      '.smg-btn{min-height:44px;padding:8px 16px;touch-action:manipulation;}',
      '.smg-btn.primary{font-weight:600;}',
      '.smg-adv{border-top:1px dashed var(--kore-border-2);padding-top:8px;display:grid;gap:8px;}',
      '.smg-field{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:var(--kore-font-12,12px);}',
      '.smg-field input[type=text]{min-height:44px;padding:8px 10px;flex:1 1 320px;min-width:0;',
      'border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-container,6px);',
      'font-family:ui-monospace,monospace;font-size:var(--kore-font-12,12px);}',
      '.smg-field select{min-height:44px;padding:8px;border:1px solid var(--kore-border-2);',
      'border-radius:var(--kore-radius-container,6px);}',
      '.smg-hint{color:var(--kore-text-3);font-size:var(--kore-font-12,12px);line-height:1.6;}',
      '.smg-table-host{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch;}',
      '.smg-table{width:100%;min-width:820px;border-collapse:collapse;font-size:var(--kore-font-13,13px);}',
      '.smg-table th{text-align:left;padding:8px 10px;color:var(--kore-text-2);font-weight:400;',
      'font-size:var(--kore-font-12,12px);white-space:nowrap;border-bottom:1px solid var(--kore-border-2);}',
      '.smg-table td{padding:8px 10px;vertical-align:top;word-break:break-word;}',
      '.smg-table td.smg-nowrap{white-space:nowrap;word-break:normal;}',
      '.smg-table tbody tr + tr{border-top:1px solid var(--kore-border-2);}',
      '.smg-table tr.off td{opacity:.72;}',
      '.smg-mono{font-family:ui-monospace,monospace;font-size:var(--kore-font-12,12px);',
      'word-break:break-all;overflow-wrap:anywhere;}',
      '.smg-tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;',
      'border:1px solid var(--kore-border-2);}',
      '.smg-tag.ok{border-color:var(--kore-success-border,#2f855a);color:var(--kore-success-text,#2f855a);}',
      '.smg-tag.no{border-color:var(--kore-danger-border,#b3261e);color:var(--kore-danger-text,#b3261e);}',
      '.smg-why{margin:6px 0 0;padding:8px 10px;background:var(--kore-warning-bg,rgba(255,193,7,.12));',
      'border-radius:6px;font-size:var(--kore-font-12,12px);line-height:1.7;}',
      '.smg-why b{font-weight:600;}',
      '.smg-why ul{margin:4px 0 0;padding-left:18px;word-break:break-word;overflow-wrap:anywhere;}',
      '.smg-why li{margin:2px 0;}',
      '.smg-notes{margin:6px 0 0;padding-left:18px;color:var(--kore-text-2);',
      'font-size:var(--kore-font-12,12px);line-height:1.7;}',
      '.smg-check{display:inline-flex;align-items:center;gap:6px;min-height:44px;cursor:pointer;}',
      '.smg-check input{width:20px;height:20px;}',
      '.smg-confirm{margin-top:8px;padding:10px 12px;border:1px solid var(--kore-warning-border,#c98a00);',
      'border-radius:8px;display:grid;gap:8px;font-size:var(--kore-font-12,12px);line-height:1.7;}',
      '.smg-empty{border:1px dashed var(--kore-border-2);border-radius:8px;padding:16px;',
      'display:grid;gap:8px;justify-items:start;font-size:var(--kore-font-13,13px);}',
      '.smg-empty p{margin:0;color:var(--kore-text-2);font-size:var(--kore-font-12,12px);line-height:1.7;}',
      '.smg-result{border:1px solid var(--kore-border-2);border-radius:8px;padding:8px 10px;',
      'display:grid;gap:4px;font-size:var(--kore-font-12,12px);line-height:1.7;}',
      '.smg-result.ok{border-left:3px solid var(--kore-success-border,#2f855a);}',
      '.smg-result.bad{border-left:3px solid var(--kore-danger-border,#b3261e);}',
      '.smg-result .smg-result-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-weight:600;}',
      '@media (max-width:639px){.smg-field input[type=text]{flex:1 1 100%;}',
      '.smg-field select{width:100%;}.smg-table{min-width:720px;}}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── 渲染骨架 ────────────────────────────────────────────────────────────
  function render(container) {
    state.gen++;
    state.root = container;
    state.destroyed = false;
    state.scanning = false;
    state.importing = false;
    state.scan = null;
    state.existing = null;
    state.existingErr = '';
    state.selected = {};
    state.panel = 'auto';
    state.customRoot = '';
    state.advancedOpen = false;
    state.confirmOpen = false;
    state.results = [];
    state.progress = null;
    state.verifyNote = '';
    state.msgText = '';
    state.msgTone = '';
    injectCSS();
    container.textContent = '';

    var wrap = add(container, el('div', 'smg-wrap'));
    var head = add(wrap, el('div', 'smg-head'));
    add(head, el('h2', 'smg-h2', '站点迁移'));
    button(head, '打开网站页', 'smg-btn', function () { window.location.hash = '#/sites/sites'; });
    add(wrap, el('p', 'smg-sub',
      '从宝塔面板 / 1Panel 换成 Kore 时，先把对方的站点配置读清楚：哪些站点能直接搬、哪些不能、为什么、怎么办。' +
      '全程只读对方配置（不改对方一个字节），点「确认导入」才真正建站；建完会回读校验。'));

    state.msgEl = add(wrap, el('div', 'smg-msg'));
    var gen = state.gen;

    // 第 1 步：识别来源
    var card1 = add(wrap, el('div', 'smg-card'));
    var step1 = add(card1, el('div', 'smg-step'));
    add(step1, el('span', 'smg-step-num', '1'));
    add(step1, el('span', null, '识别来源'));
    state.sourceHost = add(card1, el('div', 'smg-chips'));
    var ops1 = add(card1, el('div', 'smg-ops'));
    state.scanBtn = button(ops1, '开始扫描', 'smg-btn primary', function () { doScan('', ''); });
    button(ops1, '自定义目录', 'smg-btn', function () {
      state.advancedOpen = !state.advancedOpen;
      paintAdvanced();
    });
    state.advancedHost = add(card1, el('div'));
    add(card1, el('p', 'smg-hint',
      '自动扫描会查宝塔（/www/server/panel/vhost/nginx）与 1Panel（/opt/1panel/apps/openresty/openresty/conf/conf.d）。' +
      '面板装在别处时点「自定义目录」，指向它的站点配置目录即可。'));

    // 第 2 步：预览
    var card2 = add(wrap, el('div', 'smg-card'));
    var step2 = add(card2, el('div', 'smg-step'));
    add(step2, el('span', 'smg-step-num', '2'));
    add(step2, el('span', null, '预览并勾选'));
    state.previewHost = add(card2, el('div'));

    // 第 3 步：导入结果
    var card3 = add(wrap, el('div', 'smg-card'));
    var step3 = add(card3, el('div', 'smg-step'));
    add(step3, el('span', 'smg-step-num', '3'));
    add(step3, el('span', null, '导入与校验'));
    state.resultHost = add(card3, el('div'));

    paintMsg();
    paintSources();
    paintAdvanced();
    paintPreview();
    paintResults();

    // 打开页面即自动检测（原则 2：不让人先填环境细节）
    doScan('', '');
    return {
      destroy: function () {
        state.gen++;
        state.destroyed = true;
        state.root = null;
        state.scan = null;
        state.existing = null;
        state.results = [];
        state.sourceHost = null;
        state.advancedHost = null;
        state.previewHost = null;
        state.resultHost = null;
        state.msgEl = null;
      }
    };
  }

  function paintMsg() {
    if (!state.msgEl) return;
    state.msgEl.textContent = state.msgText || '';
    state.msgEl.className = 'smg-msg' + (state.msgTone ? ' ' + state.msgTone : '');
  }

  // ── 第 1 步：来源 ──────────────────────────────────────────────────────
  function paintSources() {
    var host = state.sourceHost;
    if (!host) return;
    host.textContent = '';
    var list = (state.scan && state.scan.detected) || [];
    if (!list.length) {
      add(host, el('span', 'smg-chip miss', '正在检测本机是否装有宝塔面板 / 1Panel…'));
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var chip = add(host, el('span', 'smg-chip' + (d.available ? ' ok' : ' miss')));
      add(chip, el('span', null, (d.label || d.panel) + (d.available ? ' 已找到' : ' 未发现')));
      if (d.available && d.conf_dir) add(chip, el('span', 'smg-mono', d.conf_dir));
    }
    if (state.scan && state.scan.panel && state.scan.panel !== 'none') {
      var cur = add(host, el('span', 'smg-chip'));
      add(cur, el('span', null, '本次扫描：' + (state.scan.panel_label || state.scan.panel)));
    }
  }

  function paintAdvanced() {
    var host = state.advancedHost;
    if (!host) return;
    host.textContent = '';
    if (!state.advancedOpen) return;
    var box = add(host, el('div', 'smg-adv'));
    var field = add(box, el('label', 'smg-field'));
    add(field, el('span', null, '站点配置目录'));
    var input = add(field, el('input'));
    input.type = 'text';
    input.placeholder = '例：/www/server/panel/vhost/nginx';
    input.value = state.customRoot;
    input.setAttribute('aria-label', '站点配置目录');
    input.addEventListener('input', function () { state.customRoot = input.value.trim(); });
    var sel = add(field, el('select'));
    sel.setAttribute('aria-label', '源面板类型');
    var opts = [['auto', '自动识别'], ['bt', '宝塔面板'], ['1panel', '1Panel']];
    for (var i = 0; i < opts.length; i++) {
      var o = add(sel, el('option', null, opts[i][1]));
      o.value = opts[i][0];
      if (state.panel === opts[i][0]) o.selected = true;
    }
    sel.addEventListener('change', function () { state.panel = sel.value; });
    button(field, '扫描该目录', 'smg-btn', function () {
      var dir = state.customRoot;
      if (!dir) { setMsg('请先填站点配置目录，例：/www/server/panel/vhost/nginx', 'warn'); return; }
      doScan(dir, state.panel === 'auto' ? '' : state.panel);
    });
    add(box, el('p', 'smg-hint',
      '目录里放的就是对方面板生成的 *.conf 站点配置。图省事可以直接指向面板根目录，' +
      'Kore 会自己往下找 vhost/nginx（宝塔）或 apps/openresty/openresty/conf/conf.d（1Panel）。'));
  }

  // ── 扫描 ────────────────────────────────────────────────────────────────
  function doScan(root, panel) {
    if (state.scanning) return;
    state.scanning = true;
    state.confirmOpen = false;
    var gen = state.gen;
    if (state.scanBtn) { state.scanBtn.disabled = true; state.scanBtn.textContent = '正在读取配置…'; }
    setMsg(root ? ('正在读取 ' + root + ' 下的站点配置…') : '正在检测本机面板并读取站点配置…', '');
    loadExisting().then(function () {
      var url = SCAN_URL;
      var qs = [];
      if (root) qs.push('root=' + encodeURIComponent(root));
      if (panel) qs.push('panel=' + encodeURIComponent(panel));
      if (qs.length) url += '?' + qs.join('&');
      return apiGet(url);
    }).then(function (data) {
      if (!alive(gen)) return;
      state.scan = data;
      state.selected = {};
      state.results = [];
      state.verifyNote = '';
      var sites = data.sites || [];
      for (var i = 0; i < sites.length; i++) {
        if (sites[i].importable) state.selected[sites[i].id] = true;
      }
      state.scanning = false;
      if (state.scanBtn) { state.scanBtn.disabled = false; state.scanBtn.textContent = '开始扫描'; }
      var n = sites.length;
      if (n === 0) {
        setMsg(data.note || '没有找到可导入的站点。可以换一个目录再扫一次，或直接到「网站」页手工创建。', 'warn');
      } else {
        setMsg('读取完成：找到 ' + n + ' 个站点，其中 ' + countImportable() + ' 个可导入。', '');
      }
      paintSources(); paintPreview(); paintResults();
    }, function (err) {
      if (!alive(gen)) return;
      state.scanning = false;
      if (state.scanBtn) { state.scanBtn.disabled = false; state.scanBtn.textContent = '开始扫描'; }
      setMsg('扫描没成功：' + errText(err) + '。请确认目录存在且当前账号可读，或留空让 Kore 自动检测。', 'err');
      paintPreview();
    });
  }

  // 读现有站点（冲突检测）。site 插件不可用不阻断迁移，只降级为"不检测冲突"。
  function loadExisting() {
    return invoke('site.list', {}).then(function (data) {
      state.existing = data || { sites: [] };
      state.existingErr = '';
    }, function (err) {
      state.existing = null;
      state.existingErr = errText(err);
    });
  }

  function existingDomains() {
    var map = {};
    var list = (state.existing && state.existing.sites) || [];
    for (var i = 0; i < list.length; i++) {
      var d = (list[i] && list[i].domain) ? String(list[i].domain).toLowerCase() : '';
      if (d) map[d] = true;
    }
    return map;
  }

  function countImportable() {
    var sites = (state.scan && state.scan.sites) || [];
    var n = 0;
    for (var i = 0; i < sites.length; i++) if (sites[i].importable) n++;
    return n;
  }

  // ── 第 2 步：预览表 ────────────────────────────────────────────────────
  function paintPreview() {
    var host = state.previewHost;
    if (!host) return;
    host.textContent = '';
    var scan = state.scan;
    if (!scan) {
      add(host, el('p', 'smg-hint', '点上面「开始扫描」后，这里会列出每个站点能不能搬、为什么。'));
      return;
    }
    var sites = scan.sites || [];
    var skipped = scan.skipped || [];
    if (!sites.length && !skipped.length) {
      var empty = add(host, el('div', 'smg-empty empty-state'));
      add(empty, el('strong', null, '这里还没有可导入的站点'));
      add(empty, el('p', null, scan.note || '本机没找到宝塔面板或 1Panel 的站点配置目录。'));
      var eops = add(empty, el('div', 'smg-ops'));
      button(eops, '重新扫描', 'smg-btn', function () { doScan('', ''); });
      button(eops, '去网站页手工建站', 'smg-btn', function () { window.location.hash = '#/sites/sites'; });
      paintSkipped(host, skipped);
      return;
    }

    var conflicts = existingDomains();
    var sum = add(host, el('p', 'smg-sub',
      '共 ' + sites.length + ' 个站点配置，可导入 ' + countImportable() + ' 个' +
      (state.existingErr ? '；现有站点读取失败（' + state.existingErr + '），本次不做重复域名检查' :
        '；已与现有 ' + ((state.existing && state.existing.sites) || []).length + ' 个站点比对域名')));
    if (scan.partial) sum.className = 'smg-sub smg-msg warn';

    var ops = add(host, el('div', 'smg-ops'));
    button(ops, '全选可导入', 'smg-btn', function () {
      for (var i = 0; i < sites.length; i++) if (sites[i].importable) state.selected[sites[i].id] = true;
      paintPreview();
    });
    button(ops, '全不选', 'smg-btn', function () { state.selected = {}; paintPreview(); });
    var selCount = countSelected();
    var importBtn = button(ops, '导入选中（' + selCount + ' 个）', 'smg-btn primary', function () {
      if (!selCount) { setMsg('请先勾选要导入的站点，可点「全选可导入」。', 'warn'); return; }
      state.confirmOpen = true;
      paintPreview();
    });
    importBtn.disabled = selCount === 0 || state.importing;

    var tableHost = add(host, el('div', 'smg-table-host'));
    var table = add(tableHost, el('table', 'smg-table'));
    var thead = add(table, el('thead'));
    var htr = add(thead, el('tr'));
    var cols = ['选择', '域名', '类型', '网站根目录', 'PHP', 'HTTPS', '状态'];
    for (var c = 0; c < cols.length; c++) add(htr, el('th', null, cols[c]));
    var tbody = add(table, el('tbody'));
    for (var i = 0; i < sites.length; i++) {
      tbody.appendChild(previewRow(sites[i], conflicts));
    }

    if (state.confirmOpen) host.appendChild(confirmBox());

    paintSkipped(host, skipped);
    var warns = scan.warnings || [];
    for (var w = 0; w < warns.length; w++) add(host, el('p', 'smg-hint', '· ' + warns[w]));
  }

  function previewRow(site, conflicts) {
    var conflict = !!conflicts[(site.primary_domain || '').toLowerCase()] && !!site.primary_domain;
    var rows = [];
    var tr = el('tr');
    if (!site.importable || conflict) tr.className = 'off';
    var tdCheck = add(tr, el('td'));
    if (site.importable && !conflict) {
      var label = add(tdCheck, el('label', 'smg-check'));
      var cb = add(label, el('input'));
      cb.type = 'checkbox';
      cb.checked = !!state.selected[site.id];
      cb.setAttribute('aria-label', '导入 ' + (site.primary_domain || site.id));
      cb.addEventListener('change', function () {
        if (cb.checked) state.selected[site.id] = true;
        else delete state.selected[site.id];
        paintPreview();
      });
    } else {
      add(tdCheck, el('span', 'smg-tag no', '不导入'));
    }

    var tdDomain = add(tr, el('td'));
    add(tdDomain, el('span', null, site.primary_domain || '（无域名）'));
    var alias = site.aliases || [];
    if (alias.length) add(tdDomain, el('div', 'smg-hint', '另有 ' + alias.length + ' 个别名：' + alias.join('、')));

    add(tr, el('td', 'smg-nowrap', site.kind_label || site.kind || '未识别'));
    var tdRoot = add(tr, el('td', 'smg-mono', site.root || '（未写，用默认目录）'));
    add(tr, el('td', 'smg-nowrap', site.php_version || '—'));
    add(tr, el('td', 'smg-nowrap', site.https ? (site.ssl_ready ? '有证书' : '配置有') : '无'));

    var tdState = add(tr, el('td'));
    var blockers = (site.blockers || []).slice(0);
    if (conflict) {
      blockers.unshift({
        reason: 'Kore 里已经有域名 ' + site.primary_domain + ' 的站点',
        hint: '直接导入会互相覆盖；请先到「网站」页改名或删掉旧站点，或跳过这一条'
      });
    }
    if (!blockers.length) {
      add(tdState, el('span', 'smg-tag ok', '可导入'));
    } else {
      add(tdState, el('span', 'smg-tag no', '需先处理'));
      var why = add(tdState, el('div', 'smg-why'));
      add(why, el('b', null, '为什么不支持：'));
      var ul = add(why, el('ul'));
      for (var i = 0; i < blockers.length; i++) {
        var li = add(ul, el('li'));
        add(li, el('span', null, blockers[i].reason || ''));
        if (blockers[i].hint) add(li, el('span', 'smg-hint', ' → 怎么办：' + blockers[i].hint));
      }
    }
    var notes = site.notes || [];
    if (notes.length) {
      var noteList = add(tdState, el('ul', 'smg-notes'));
      for (var j = 0; j < notes.length; j++) add(noteList, el('li', null, notes[j]));
    }
    return tr;
  }

  function paintSkipped(host, skipped) {
    if (!skipped || !skipped.length) return;
    var box = add(host, el('div', 'smg-why'));
    add(box, el('b', null, '这些文件没有变成站点（' + skipped.length + ' 个）：'));
    var ul = add(box, el('ul'));
    for (var i = 0; i < skipped.length; i++) {
      var li = add(ul, el('li'));
      add(li, el('span', 'smg-mono', skipped[i].path));
      add(li, el('span', null, '：' + skipped[i].reason));
      if (skipped[i].hint) add(li, el('span', 'smg-hint', ' → 怎么办：' + skipped[i].hint));
    }
  }

  function confirmBox() {
    var box = el('div', 'smg-confirm');
    var selCount = countSelected();
    add(box, el('div', null, '将创建 ' + selCount + ' 个站点：写入 nginx 站点配置（不改对方面板的任何文件），' +
      '证书可读的会顺手绑定 HTTPS。建完会逐条回读校验。'));
    var ops = add(box, el('div', 'smg-ops'));
    button(ops, '确认导入', 'smg-btn primary', doImport);
    button(ops, '取消', 'smg-btn', function () { state.confirmOpen = false; paintPreview(); });
    return box;
  }

  function countSelected() {
    var n = 0;
    for (var k in state.selected) {
      if (Object.prototype.hasOwnProperty.call(state.selected, k) && state.selected[k]) n++;
    }
    return n;
  }

  // ── 第 3 步：导入 ──────────────────────────────────────────────────────
  function doImport() {
    if (state.importing) return;
    var sites = (state.scan && state.scan.sites) || [];
    var queue = [];
    for (var i = 0; i < sites.length; i++) {
      if (state.selected[sites[i].id]) queue.push(sites[i]);
    }
    if (!queue.length) { setMsg('没有勾选任何站点。', 'warn'); return; }
    state.importing = true;
    state.confirmOpen = false;
    state.results = [];
    state.verifyNote = '';
    var gen = state.gen;
    paintPreview();
    paintResults();

    var idx = 0;
    function next() {
      if (!alive(gen)) return;
      if (idx >= queue.length) {
        state.importing = false;
        state.progress = null;
        var ok = 0;
        for (var i = 0; i < state.results.length; i++) if (state.results[i].ok) ok++;
        setMsg('导入完成：成功 ' + ok + ' 个，失败 ' + (state.results.length - ok) + ' 个。' +
          (ok ? '可以点「校验导入结果」回读 nginx 状态。' : '失败原因见下方逐条说明。'),
          ok === state.results.length ? '' : 'warn');
        paintPreview();
        paintResults();
        if (ok) verifyResults();
        return;
      }
      var site = queue[idx];
      state.progress = { done: idx, total: queue.length, current: site.primary_domain || site.id };
      paintResults();
      importOne(site).then(function (result) {
        if (!alive(gen)) return;
        state.results.push(result);
        idx++;
        next();
      }, function (err) {
        if (!alive(gen)) return;
        state.results.push({
          domain: site.primary_domain, ok: false, steps: [],
          message: errText(err), hint: '到「网站」页确认没有同名站点，或先手工创建该站点'
        });
        idx++;
        next();
      });
    }
    next();
  }

  // importOne 建一个站点：site.create（PHP 失败降级为静态）→ 可读证书时 bindSSL。
  function importOne(site) {
    var result = { domain: site.primary_domain, ok: false, steps: [], message: '', hint: '' };
    var params = { domain: site.primary_domain };
    if (site.root) params.root = site.root;
    if (site.php_version) params.php_version = site.php_version;
    function afterCreate(created, downgraded) {
      result.steps.push({
        step: downgraded ? '创建站点（PHP 不可用，已按静态站导入）' : '创建站点',
        ok: true,
        detail: (created.vhost_path || '已写入站点配置') +
          '；nginx 语法校验 ' + (created.test_skipped ? '未校验（本机没有 nginx）' :
            typeof created.test_passed === 'boolean' ? (created.test_passed ? '通过' : '未通过') : '未执行') +
          '；重载 ' + (created.reload_skipped ? '未执行' :
            typeof created.reloaded === 'boolean' ? (created.reloaded ? '已执行' : '未执行') : '未执行')
      });
      // 原站是 PHP 站点：回读"PHP 到底开了没有"，不把"建了站"当成"PHP 也搬过来了"。
      if (site.php_version && created.php_enabled !== true) {
        result.steps.push({
          step: '启用 PHP ' + site.php_version, ok: false,
          detail: '建站回读没有 PHP 配置：本机缺 PHP ' + site.php_version +
            ' 或当前站点插件不支持建站时自动开 PHP。到站点详情「PHP」里选一次版本即可（先到「运行环境」装 PHP ' +
            site.php_version + '）'
        });
      }
      if (!site.ssl_ready || !site.ssl_cert || !site.ssl_key) return Promise.resolve();
      return invoke('site.bindSSL', {
        domain: site.primary_domain, cert_path: site.ssl_cert, key_path: site.ssl_key, force_https: true
      }).then(function (r) {
        result.steps.push({ step: '绑定原站证书', ok: true, detail: '强制 HTTPS=' + (r && r.force_https ? '是' : '否') });
      }, function (err) {
        result.steps.push({ step: '绑定原站证书', ok: false, detail: errText(err) });
      });
    }
    return invoke('site.create', params).then(function (created) {
      return afterCreate(created, false);
    }, function (err) {
      var msg = errText(err);
      var phpProblem = site.php_version && /php|PHP|PHP-FPM|socket|FPM/.test(msg);
      if (!phpProblem) throw err;
      var plain = { domain: site.primary_domain };
      if (site.root) plain.root = site.root;
      return invoke('site.create', plain).then(function (created) {
        return afterCreate(created, true);
      });
    }).then(function () {
      result.ok = true;
      return result;
    });
  }

  // verifyResults 回读每个已导入站点的真实状态（配置是否在、nginx 是否校验）。
  function verifyResults() {
    var gen = state.gen;
    var targets = [];
    for (var i = 0; i < state.results.length; i++) {
      if (state.results[i].ok && state.results[i].domain) targets.push(state.results[i]);
    }
    if (!targets.length) return;
    var done = 0, skipped = 0;
    targets.forEach(function (item) {
      invoke('site.status', { domain: item.domain }).then(function (st) {
        if (!alive(gen)) return;
        item.verified = {
          confExists: !!st.conf_exists,
          testPassed: !!st.test_passed,
          testSkipped: !!st.test_skipped,
          siteDirState: st.site_dir_state || '',
          nginxMode: st.nginx_mode || '',
          nginxReason: st.nginx_reason || ''
        };
        if (st.test_skipped) skipped++;
        done++;
        if (done === targets.length) {
          state.verifyNote = skipped === targets.length
            ? '本机没有可用的 nginx：配置已写入，语法校验与重载未执行（装的 nginx 生效后再回读一次即可）。'
            : '已回读 ' + done + ' 个站点的真实状态。';
          paintResults();
        }
      }, function (err) {
        if (!alive(gen)) return;
        item.verifyError = errText(err);
        done++;
        if (done === targets.length) paintResults();
      });
    });
  }

  function paintResults() {
    var host = state.resultHost;
    if (!host) return;
    host.textContent = '';
    if (state.importing && state.progress) {
      add(host, el('p', 'smg-sub', '正在导入 ' + (state.progress.done + 1) + '/' + state.progress.total +
        '：' + state.progress.current + '…'));
    }
    if (!state.results.length && !state.verifyNote) {
      var empty = add(host, el('div', 'smg-empty empty-state'));
      add(empty, el('strong', null, '还没有导入任何站点'));
      add(empty, el('p', null, '在上面第 2 步勾选要搬的站点，点「导入选中」→「确认导入」后，这里逐条显示结果。'));
      var ops = add(empty, el('div', 'smg-ops'));
      button(ops, '去勾选站点', 'smg-btn', function () {
        if (state.previewHost && state.previewHost.scrollIntoView) state.previewHost.scrollIntoView({ block: 'start' });
      });
      return;
    }
    var list = add(host, el('div'));
    list.style.display = 'grid';
    list.style.gap = '8px';
    for (var i = 0; i < state.results.length; i++) {
      list.appendChild(resultCard(state.results[i]));
    }
    if (state.verifyNote) add(host, el('p', 'smg-hint', state.verifyNote));
    if (state.results.length) {
      var ops2 = add(host, el('div', 'smg-ops'));
      button(ops2, '校验导入结果', 'smg-btn', function () { state.verifyNote = ''; verifyResults(); });
      button(ops2, '去网站页看站点', 'smg-btn primary', function () { window.location.hash = '#/sites/sites'; });
    }
  }

  function resultCard(item) {
    var card = el('div', 'smg-result ' + (item.ok ? 'ok' : 'bad'));
    var head = add(card, el('div', 'smg-result-head'));
    add(head, el('span', null, item.ok ? '✓ ' : '✕ '));
    add(head, el('span', null, item.domain || '（无域名）'));
    add(head, el('span', 'smg-tag ' + (item.ok ? 'ok' : 'no'), item.ok ? '已创建' : '未创建'));
    var steps = item.steps || [];
    for (var i = 0; i < steps.length; i++) {
      add(card, el('div', null, '· ' + steps[i].step + '：' + steps[i].detail));
    }
    if (!item.ok) {
      add(card, el('div', null, '原因：' + item.message));
      if (item.hint) add(card, el('div', 'smg-hint', '怎么办：' + item.hint));
    }
    if (item.verifyError) add(card, el('div', 'smg-hint', '回读失败：' + item.verifyError + '；可点「校验导入结果」重试'));
    if (item.verified) {
      var v = item.verified;
      var line = '回读：站点配置' + (v.confExists ? '已写入' : '未找到') +
        '；语法校验 ' + (v.testSkipped ? '未执行（本机没有 nginx）' : v.testPassed ? '通过' : '未通过');
      if (!v.confExists) line += '；到「网站」页刷新一次看站点是否在列表里';
      if (v.siteDirState === 'present') line += '；网站目录存在';
      else if (v.siteDirState === 'absent') line += '；网站目录不存在（把站点文件放进去即可）';
      add(card, el('div', null, line));
      if (v.nginxReason) add(card, el('div', 'smg-hint', 'nginx 情况：' + v.nginxReason));
    }
    return card;
  }

  window.KoreSiteMigrate = { render: render };
})();
