/* kore 主壳 · 日志查看（web/logs.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/logs/logs.tail）；
   方法段一律写完整限定名 logs.*，裸动词 sources/tail/search/stats/download 只是插件侧兼容，不得依赖。
   window.KoreLogs.render(container)：
   - 行配色：按行首级别 ERROR/WARN/INFO/DEBUG 着色 + 左侧 2px 色条（样式随视图注入本文件，不进 style.css）；
   - 搜索：输入即搜（防抖 300ms），logs.search query 字面匹配，命中词 <mark> 高亮 + 「命中 N 行 / 共 M 行」；
   - 级别筛选：ALL / ERROR / WARN / INFO 四个 chip（客户端过滤）；
   - 跟随：用户主动开关（默认关）——开启后每 3s 带 position 增量 tail，最多保留 500 行，关闭即停；
     用户主动行为，非轮询默认态；document.hidden 时暂停。
   - 下载：logs.download 导出 <state>/exports/<source>-<ts>.log 并以 Blob 触发浏览器下载（同 file.download 通道）。
   安全口径：日志正文一律 textContent / createTextNode，不拼 HTML、不 innerHTML；
   界面只显示来源名与文件名，绝不渲染宿主绝对路径。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/logs/';
  var TIMEOUT_MS = 15000;
  var SEARCH_DEBOUNCE_MS = 300;
  var FOLLOW_INTERVAL_MS = 3000;
  var FOLLOW_MAX_LINES = 500;
  var STYLE_ID = 'kore-logs-style';

  /* 行级样式随视图注入：级别色条 2px + 文字色；mark 高亮；chip 选中态；触屏 44px。 */
  var STYLE_TEXT =
    '.logs-out{margin:var(--kore-space-3) var(--kore-space-4) 0;padding:var(--kore-space-2) 0;min-height:220px;max-height:56vh;overflow:auto;' +
    'color:var(--kore-text-1);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);line-height:1.55;}' +
    '.logs-line{padding:0 var(--kore-space-2);border-left:2px solid transparent;white-space:pre-wrap;word-break:break-all;min-height:1.55em;}' +
    '.logs-line.lv-error{border-left-color:var(--kore-danger);color:var(--kore-danger);}' +
    '.logs-line.lv-warn{border-left-color:var(--kore-warning);color:var(--kore-warning);}' +
    '.logs-line.lv-debug{border-left-color:var(--kore-text-3);color:var(--kore-text-3);}' +
    '.logs-line mark{background:rgba(210,153,34,.35);color:inherit;border-radius:2px;padding:0 1px;}' +
    '.logs-line .logs-no{display:inline-block;min-width:52px;margin-right:var(--kore-space-2);color:var(--kore-text-3);text-align:right;user-select:none;}' +
    '.logs-chips{display:inline-flex;flex-wrap:wrap;gap:var(--kore-space-1);align-items:flex-end;}' +
    '.logs-chip{min-height:32px;padding:0 var(--kore-space-2);color:var(--kore-text-2);background:var(--kore-bg-0);' +
    'border:1px solid var(--kore-border-1);border-radius:999px;font:inherit;font-size:var(--kore-font-12);cursor:pointer;}' +
    '.logs-chip:hover{border-color:var(--kore-info);}' +
    '.logs-chip.is-active{color:var(--kore-text-1);border-color:var(--kore-info);background:var(--kore-bg-2);font-weight:600;}' +
    '.logs-chip.chip-error.is-active{border-color:var(--kore-danger);color:var(--kore-danger);}' +
    '.logs-chip.chip-warn.is-active{border-color:var(--kore-warning);color:var(--kore-warning);}' +
    '.logs-switch{display:inline-flex;align-items:center;gap:var(--kore-space-1);min-height:32px;padding:0 var(--kore-space-2);' +
    'color:var(--kore-text-2);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:999px;font:inherit;font-size:var(--kore-font-12);cursor:pointer;}' +
    '.logs-switch[aria-checked="true"]{color:var(--kore-text-1);border-color:var(--kore-ok,var(--kore-info));background:var(--kore-bg-2);}' +
    '.logs-switch .dot{flex:none;}' +
    '@media (pointer:coarse),(max-width:639px){.logs-chip,.logs-switch{min-height:44px;}}';

  function fresh() {
    return { root: null, sources: [], selected: '', lines: 200, query: '', mode: 'tail',
      entries: [], matches: [], total: 0, position: 0,
      stats: null, count: 0, scanned: 0, truncated: false, lineTruncated: false,
      levelFilter: '', follow: false, followTimer: null, followBusy: false,
      searchTimer: null, notice: '', error: '', busy: false, destroyed: false };
  }
  var S = fresh();
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn) { n.addEventListener('click', fn); return n; }
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
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + method, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || '';
          throw err;
        }
        return data;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }
  function fmtSize(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtInt(n) { return typeof n === 'number' && isFinite(n) ? n.toLocaleString('zh-CN') : '—'; }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function chipEl(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }
  function stopFollow() {
    S.follow = false;
    if (S.followTimer !== null) { clearInterval(S.followTimer); S.followTimer = null; }
    if (S.followBtn) S.followBtn.setAttribute('aria-checked', 'false');
  }
  function startFollow() {
    if (S.mode !== 'tail') { S.query = ''; S.searchInput.value = ''; }
    S.follow = true;
    if (S.followBtn) S.followBtn.setAttribute('aria-checked', 'true');
    followTick();
    S.followTimer = setInterval(followTick, FOLLOW_INTERVAL_MS);
  }
  function toggleFollow() {
    if (S.follow) { stopFollow(); paintFoot(); return; }
    if (!S.selected) return;
    startFollow(); paintFoot();
  }
  /* 增量拉取：带 position 只取新行；隐藏页签与在途请求时跳过本轮，不堆积。 */
  function followTick() {
    if (!S.follow || S.destroyed || S.followBusy || document.hidden || !S.selected) return;
    var name = S.selected;
    S.followBusy = true;
    invoke('logs.tail', { source: name, lines: S.lines, position: S.position }).then(function (d) {
      S.followBusy = false;
      if (S.destroyed || !S.follow || S.selected !== name) return;
      var freshEntries = d.entries || [];
      if (freshEntries.length) {
        if (!d.position) { S.entries = freshEntries; }
        else { S.entries = S.entries.concat(freshEntries).slice(-FOLLOW_MAX_LINES); }
        paintOutput();
      }
      S.position = d.position || S.position;
      S.count = S.entries.length;
      paintFoot();
    }, function (err) {
      S.followBusy = false;
      if (S.destroyed || !S.follow || S.selected !== name) return;
      S.error = '跟随读取失败：' + err.message; paintNotices();
      stopFollow(); paintFoot();
    });
  }
  function paintSources() {
    if (!S.srcHost) return;
    S.srcHost.textContent = '';
    S.srcCount.textContent = S.sources.length ? S.sources.length + ' 个来源' : '';
    if (!S.sources.length) {
      var empty = add(S.srcHost, el('div', 'empty-state'));
      add(empty, el('p', 'logs-empty-title', '未配置日志来源'));
      add(empty, el('p', 'empty-state-text',
        '点击右上角「设置」添加日志来源，保存后立即生效、无需重启；也兼容环境变量 KORE_LOGS_SOURCES。'));
      return;
    }
    S.sources.forEach(function (src) {
      var active = src.name === S.selected;
      var btn = add(S.srcHost, el('button', 'logs-src' + (active ? ' is-active' : '')));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      var top = add(btn, el('div', 'logs-src-head'));
      add(top, el('span', 'logs-src-name', src.name));
      var tags = add(top, el('span', 'logs-src-tags'));
      if (src.type === 'journal') add(tags, el('span', 'tag-muted', 'journal')).title = 'systemd journal 来源';
      tags.appendChild(chipEl(src.readable ? 'ok' : 'fail', src.readable ? '可读' : '不可读'));
      add(btn, el('div', 'logs-src-file mono', src.type === 'journal' ? 'systemd journal' : (src.file || '—')));
      add(btn, el('div', 'logs-src-meta', fmtSize(src.size_bytes) + ' · ' + fmtTime(src.modified_at)));
      if (src.note) add(btn, el('div', 'logs-src-note', src.note));
      on(btn, function () { selectSource(src.name); });
    });
  }
  function paintStats() {
    if (!S.statHost) return;
    var host = S.statHost, d = S.stats;
    host.textContent = '';
    if (!d) return;
    var lines = d.lines === null || d.lines === undefined ? '文件过大，未统计行数' : fmtInt(d.lines) + ' 行';
    [['总大小', fmtSize(d.size_bytes)], ['行数', lines], ['修改时间', fmtTime(d.modified_at)]].forEach(function (it) {
      var cell = add(host, el('div', 'logs-stat'));
      add(cell, el('span', 'logs-stat-label', it[0]));
      add(cell, el('span', 'logs-stat-value', it[1]));
    });
    if (d.readable === false) {
      var badge = add(host, el('div', 'logs-stat'));
      add(badge, el('span', 'logs-stat-label', '可读性'));
      badge.appendChild(chipEl('fail', '不可读'));
    }
    if (d.note) add(host, el('div', 'logs-stat-note', d.note));
  }
  function levelOf(item) {
    var lv = item.level || '';
    return lv === 'error' || lv === 'warn' || lv === 'debug' ? lv : '';
  }
  function passFilter(item) {
    return !S.levelFilter || levelOf(item) === S.levelFilter;
  }
  /* 行渲染：一律 textNode，不拼 HTML；搜索模式下把命中片段包进 <mark>。 */
  function lineEl(item, lineNo) {
    var lv = levelOf(item);
    var row = el('div', 'logs-line' + (lv ? ' lv-' + lv : ''));
    if (lineNo != null) add(row, el('span', 'logs-no', String(lineNo)));
    var text = String(item.text != null ? item.text : item);
    var query = S.mode === 'search' && S.query ? S.query.toLowerCase() : '';
    if (!query) { row.appendChild(document.createTextNode(text)); return row; }
    var lower = text.toLowerCase(), from = 0, idx;
    while ((idx = lower.indexOf(query, from)) !== -1) {
      if (idx > from) row.appendChild(document.createTextNode(text.slice(from, idx)));
      add(row, el('mark', null, text.slice(idx, idx + query.length)));
      from = idx + query.length;
    }
    if (from < text.length) row.appendChild(document.createTextNode(text.slice(from)));
    return row;
  }
  function paintOutput() {
    if (!S.out) return;
    S.out.textContent = '';
    if (S.mode === 'search') {
      var shown = S.matches.filter(passFilter);
      if (!shown.length) {
        add(S.out, el('div', 'logs-line', S.matches.length ? '（当前级别筛选下无命中行）' : '无命中行'));
        return;
      }
      shown.forEach(function (m) { S.out.appendChild(lineEl(m, m.line_no)); });
      return;
    }
    var shownTail = S.entries.filter(passFilter);
    if (!shownTail.length) {
      add(S.out, el('div', 'logs-line', S.entries.length ? '（当前级别筛选下无日志行）' : '暂无日志行'));
      return;
    }
    shownTail.forEach(function (e) { S.out.appendChild(lineEl(e, null)); });
  }
  function totalLinesText() {
    var d = S.stats;
    return d && d.lines !== null && d.lines !== undefined ? fmtInt(d.lines) : '≥' + fmtInt(Math.max(S.scanned, 0));
  }
  function paintFoot() {
    if (!S.foot) return;
    if (S.busy) { S.foot.textContent = '读取中…'; return; }
    if (S.mode === 'search') {
      S.foot.textContent = '命中 ' + fmtInt(S.total) + ' 行 / 共 ' + totalLinesText() + ' 行 · 扫描 ' + fmtSize(S.scanned) +
        (S.notice ? ' · ' + S.notice : '');
      return;
    }
    S.foot.textContent = '显示 ' + S.count + ' 行' +
      (S.follow ? ' · 跟随中（每 ' + (FOLLOW_INTERVAL_MS / 1000) + 's，position ' + fmtInt(S.position) + '）' : '') +
      ' · 扫描 ' + fmtSize(S.scanned);
  }
  function paintNotices() {
    var host = S.noticeHost;
    if (!host) return;
    host.textContent = '';
    if (S.error) {
      var err = add(host, el('div', 'logs-error'));
      err.setAttribute('role', 'alert');
      err.textContent = S.error;
    }
    if (S.truncated) add(host, el('div', 'logs-notice', S.mode === 'search' ? '命中超过上限，仅显示前 ' + S.count + ' 行' : '结果已截断（扫描上限 64 MiB）'));
    if (S.lineTruncated) add(host, el('div', 'logs-notice', '部分超长行已截断（单行上限 8 KiB）'));
  }
  function stopSearchTimer() {
    if (S.searchTimer !== null) { clearTimeout(S.searchTimer); S.searchTimer = null; }
  }
  function selectSource(name) {
    if (!name) return;
    stopFollow(); stopSearchTimer();
    S.selected = name; S.mode = 'tail'; S.entries = []; S.matches = []; S.stats = null;
    S.count = 0; S.total = 0; S.scanned = 0; S.position = 0; S.query = '';
    S.truncated = false; S.lineTruncated = false; S.levelFilter = '';
    S.notice = ''; S.error = '';
    if (S.searchInput) S.searchInput.value = '';
    paintLevelChips(); paintSources(); paintStats(); paintOutput(); paintNotices(); paintFoot();
    loadStats(); loadTail();
  }
  function loadStats() {
    var name = S.selected;
    if (!name) return;
    invoke('logs.stats', { source: name }).then(function (d) {
      if (S.destroyed || S.selected !== name) return;
      S.stats = d; paintStats(); paintFoot();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.error = '统计读取失败：' + err.message; paintNotices();
    });
  }
  function loadTail() {
    var name = S.selected;
    S.error = ''; S.notice = ''; paintNotices();
    if (!name) return;
    S.busy = true; paintFoot();
    invoke('logs.tail', { source: name, lines: S.lines }).then(function (d) {
      if (S.destroyed || S.selected !== name) return;
      S.mode = 'tail';
      S.entries = d.entries || [];
      S.position = d.position || 0;
      S.count = d.count || 0;
      S.scanned = d.scanned_bytes || 0;
      S.truncated = !!d.truncated; S.lineTruncated = !!d.line_truncated;
      S.busy = false; paintOutput(); paintNotices(); paintFoot();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.busy = false; S.entries = []; S.count = 0;
      S.error = '读取失败：' + err.message;
      paintOutput(); paintNotices(); paintFoot();
    });
  }
  function loadSearch() {
    var name = S.selected;
    if (!name) return;
    var query = String(S.searchInput ? S.searchInput.value : S.query).trim();
    if (!query) { S.mode = 'tail'; loadTail(); return; }
    S.query = query; S.error = ''; S.notice = '';
    S.busy = true; paintFoot(); paintNotices();
    invoke('logs.search', { source: name, query: query, limit: 200 }).then(function (d) {
      if (S.destroyed || S.selected !== name) return;
      stopFollow();
      S.mode = 'search';
      S.matches = d.matches || [];
      S.total = d.total || 0;
      S.count = d.count || 0;
      S.scanned = d.scanned_bytes || 0;
      S.truncated = !!d.truncated;
      S.lineTruncated = false; S.notice = d.note || '';
      S.busy = false; paintOutput(); paintNotices(); paintFoot();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.busy = false; S.matches = []; S.count = 0; S.total = 0;
      S.error = '搜索失败：' + err.message;
      paintOutput(); paintNotices(); paintFoot();
    });
  }
  function onSearchInput() {
    stopSearchTimer();
    S.searchTimer = setTimeout(function () {
      S.searchTimer = null;
      if (S.destroyed) return;
      var query = S.searchInput.value.trim();
      if (!query) { S.query = ''; S.mode = 'tail'; loadTail(); return; }
      loadSearch();
    }, SEARCH_DEBOUNCE_MS);
  }
  /* 级别筛选 chip：客户端过滤显示行，不打扰请求。 */
  function paintLevelChips() {
    if (!S.chipHost) return;
    S.chipHost.textContent = '';
    var defs = [['', 'ALL'], ['error', 'ERROR'], ['warn', 'WARN'], ['info', 'INFO']];
    defs.forEach(function (def) {
      var active = S.levelFilter === def[0];
      var cls = 'logs-chip' + (def[0] ? ' chip-' + def[0] : '') + (active ? ' is-active' : '');
      var chip = add(S.chipHost, el('button', cls, def[1]));
      chip.type = 'button';
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      on(chip, function () {
        S.levelFilter = def[0];
        paintLevelChips(); paintOutput();
      });
    });
  }
  function loadSources() {
    invoke('logs.sources', {}).then(function (d) {
      if (S.destroyed) return;
      S.sources = d.sources || [];
      paintSources();
      if (S.selected || !S.sources.length) return;
      var pick = S.sources[0];
      for (var i = 0; i < S.sources.length; i++) {
        if (S.sources[i].readable) { pick = S.sources[i]; break; }
      }
      selectSource(pick.name);
    }, function (err) {
      if (S.destroyed) return;
      S.error = '来源读取失败：' + err.message;
      paintNotices(); paintSources();
    });
  }
  function field(labelText, control) {
    var label = el('label', 'logs-field');
    add(label, el('span', 'logs-field-label', labelText));
    label.appendChild(control);
    return label;
  }
  /* 浏览器下载：data_base64 → Blob → <a download>（与 files 插件下载同通道）。 */
  function triggerDownload(data) {
    var raw = atob(data.data_base64 || '');
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([bytes], { type: 'text/plain' }));
    var a = document.createElement('a');
    a.href = url; a.download = data.filename || 'log-export.log'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    S.notice = '已导出 ' + data.filename + '（' + fmtSize(data.size_bytes) + ' · ' + fmtInt(data.lines) + ' 行）';
  }
  function downloadLog() {
    var name = S.selected;
    if (!name || S.busy) return;
    S.busy = true; S.error = ''; S.notice = ''; paintNotices(); paintFoot();
    invoke('logs.download', { source: name }).then(function (d) {
      if (S.destroyed || S.selected !== name) return;
      S.busy = false;
      triggerDownload(d);
      paintNotices(); paintFoot();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.busy = false;
      S.error = '导出失败：' + err.message;
      paintNotices(); paintFoot();
    });
  }
  function openConfig() {
    if (!S.root) return;
    if (!window.KoreShell || typeof window.KoreShell.openConfig !== 'function') {
      S.error = '配置面板未加载，请刷新页面后重试'; paintNotices(); return;
    }
    window.KoreShell.openConfig(S.root, 'logs', {
      title: '日志设置',
      onSaved: function () { stopFollow(); S.selected = ''; loadSources(); }
    });
  }
  function build(root) {
    ensureStyles();
    S.root = root;
    var head = add(root, el('header', 'view-head view-head-split'));
    var headMain = add(head, el('div', 'view-head-main'));
    add(headMain, el('h2', 'view-title', '日志'));
    add(headMain, el('p', 'view-sub', '按来源查看尾部日志、关键字搜索与级别筛选；支持跟随与导出，只读不暴露宿主路径。'));
    var gear = add(head, el('button', 'btn btn-ghost cfg-gear', '⚙ 设置'));
    gear.type = 'button';
    gear.setAttribute('aria-label', '日志设置');
    on(gear, openConfig);
    var layout = add(root, el('div', 'logs-layout'));
    var srcPanel = add(layout, el('section', 'panel logs-src-panel'));
    var srcHead = add(srcPanel, el('div', 'panel-head'));
    add(srcHead, el('span', 'panel-title', '日志来源'));
    S.srcCount = add(srcHead, el('span', 'panel-meta', ''));
    S.srcHost = add(srcPanel, el('div', 'logs-src-list'));
    var viewPanel = add(layout, el('section', 'panel logs-view-panel'));
    var viewHead = add(viewPanel, el('div', 'panel-head'));
    add(viewHead, el('span', 'panel-title', '日志内容'));
    add(viewHead, el('span', 'panel-meta', '只读 · 单行上限 8 KiB'));
    var tools = add(viewPanel, el('div', 'logs-toolbar'));
    S.linesSel = el('select', 'logs-input');
    [100, 200, 500].forEach(function (n) {
      var opt = el('option', null, n + ' 行'); opt.value = String(n);
      if (n === S.lines) opt.selected = true;
      S.linesSel.appendChild(opt);
    });
    tools.appendChild(field('行数', S.linesSel));
    S.searchInput = el('input', 'logs-input');
    S.searchInput.type = 'search';
    S.searchInput.placeholder = '搜索关键字（输入即搜，字面匹配）';
    S.searchInput.autocomplete = 'off';
    S.searchInput.setAttribute('aria-label', '搜索关键字');
    tools.appendChild(field('搜索', S.searchInput));
    S.chipHost = add(tools, el('div', 'logs-chips'));
    S.chipHost.setAttribute('role', 'group');
    S.chipHost.setAttribute('aria-label', '级别筛选');
    S.followBtn = add(tools, el('button', 'logs-switch'));
    S.followBtn.type = 'button';
    S.followBtn.setAttribute('role', 'switch');
    S.followBtn.setAttribute('aria-checked', 'false');
    var followDot = add(S.followBtn, el('span', 'dot'));
    add(S.followBtn, el('span', null, '跟随'));
    on(S.followBtn, toggleFollow);
    S.downloadBtn = add(tools, el('button', 'btn btn-ghost', '⬇ 下载'));
    S.downloadBtn.type = 'button';
    S.downloadBtn.setAttribute('aria-label', '导出日志片段并下载');
    on(S.downloadBtn, downloadLog);
    var refresh = add(tools, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    S.statHost = add(viewPanel, el('div', 'logs-stats'));
    S.noticeHost = add(viewPanel, el('div', 'logs-notices'));
    S.out = add(viewPanel, el('div', 'logs-out'));
    S.out.setAttribute('aria-label', '日志行'); S.out.tabIndex = 0;
    S.foot = add(viewPanel, el('div', 'logs-foot muted'));
    on(S.linesSel, function () {
      S.lines = Number(S.linesSel.value) || 200;
      if (S.mode === 'search' && S.query) loadSearch(); else loadTail();
    });
    S.searchInput.addEventListener('input', onSearchInput);
    S.searchInput.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      stopSearchTimer();
      if (S.searchInput.value.trim()) loadSearch();
    });
    on(refresh, function () { loadStats(); if (S.mode === 'search' && S.query) loadSearch(); else loadTail(); });
    paintLevelChips();
  }
  function render(container) {
    if (!container) return null;
    stopSearchTimer();
    S = fresh(); container.textContent = '';
    ensureStyles();
    var root = add(container, el('section', 'logs'));
    build(root); loadSources();
    return { destroy: function () {
      S.destroyed = true;
      stopFollow(); stopSearchTimer();
    } };
  }
  window.KoreLogs = { render: render };
})();
