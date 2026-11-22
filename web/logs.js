/* kore 主壳 · 日志查看（web/logs.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/logs/logs.tail）；
   方法段一律写完整限定名 logs.*，裸动词 stats/tail/search/sources 只是插件侧兼容，不得依赖。
   window.KoreLogs.render(container)：来源只认 logs.sources 白名单；日志正文全部写
   <pre>.textContent，不拼 HTML；界面只显示来源名与文件名，绝不渲染宿主绝对路径。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/logs/';
  var TIMEOUT_MS = 15000;
  function fresh() {
    return { root: null, sources: [], selected: '', lines: 200, keyword: '', since: '', mode: 'tail', entries: [],
      matches: [], stats: null, count: 0, scanned: 0, truncated: false, lineTruncated: false,
      notice: '', error: '', busy: false, destroyed: false };
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
  function pad(n, width) { var s = String(n); while (s.length < width) s = ' ' + s; return s; }
  function toRFC3339(value) {
    if (!value) return '';
    var d = new Date(value);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
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
      tags.appendChild(chip(src.readable ? 'ok' : 'fail', src.readable ? '可读' : '不可读'));
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
      badge.appendChild(chip('fail', '不可读'));
    }
    if (d.note) add(host, el('div', 'logs-stat-note', d.note));
  }
  function paintOutput() {
    if (!S.pre) return;
    S.pre.textContent = S.mode === 'search'
      ? S.matches.map(function (m) { return pad(m.line_no, 6) + '  ' + m.text; }).join('\n')
      : S.entries.map(function (e) { return e.text; }).join('\n');
  }
  function paintFoot() {
    if (!S.foot) return;
    if (S.busy) { S.foot.textContent = '读取中…'; return; }
    S.foot.textContent = S.mode === 'search'
      ? '匹配 ' + S.count + ' 行 · 扫描 ' + fmtSize(S.scanned) + (S.notice ? ' · ' + S.notice : '')
      : '显示 ' + S.count + ' 行 · 扫描 ' + fmtSize(S.scanned);
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
    if (S.truncated) add(host, el('div', 'logs-notice', '结果已截断（扫描上限 64 MiB）'));
    if (S.lineTruncated) add(host, el('div', 'logs-notice', '部分超长行已截断（单行上限 8 KiB）'));
  }
  function selectSource(name) {
    if (!name) return;
    S.selected = name; S.mode = 'tail'; S.entries = []; S.matches = []; S.stats = null;
    S.count = 0; S.scanned = 0; S.truncated = false; S.lineTruncated = false;
    S.notice = ''; S.error = '';
    paintSources(); paintStats(); paintOutput(); paintNotices(); paintFoot();
    loadStats(); loadTail();
  }
  function loadStats() {
    var name = S.selected;
    if (!name) return;
    invoke('logs.stats', { source: name }).then(function (d) {
      if (S.destroyed || S.selected !== name) return;
      S.stats = d; paintStats();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.error = '统计读取失败：' + err.message; paintNotices();
    });
  }
  function loadTail() {
    var name = S.selected;
    S.error = ''; S.notice = ''; paintNotices();
    if (!name) return;
    var params = { source: name, lines: S.lines };
    if (S.keyword) params.keyword = S.keyword;
    if (S.since) params.since = S.since;
    S.busy = true; paintFoot();
    invoke('logs.tail', params).then(function (d) {
      if (S.destroyed || S.selected !== name) return;
      S.mode = 'tail'; S.entries = d.entries || []; S.count = d.count || 0;
      S.scanned = d.scanned_bytes || 0; S.truncated = !!d.truncated; S.lineTruncated = !!d.line_truncated;
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
    if (!name) { S.notice = '请先选择日志来源'; paintFoot(); return; }
    var keyword = String(S.kw ? S.kw.value : S.keyword).trim();
    if (!keyword) { S.notice = '请输入关键字后再搜索'; paintFoot(); S.kw.focus(); return; }
    S.keyword = keyword; S.error = ''; S.notice = ''; paintNotices();
    S.busy = true; paintFoot();
    invoke('logs.search', { source: name, keyword: keyword, limit: S.lines }).then(function (d) {
      if (S.destroyed || S.selected !== name) return;
      S.mode = 'search'; S.matches = d.matches || []; S.count = d.count || 0;
      S.scanned = d.scanned_bytes || 0; S.truncated = !!d.truncated;
      S.lineTruncated = false; S.notice = d.note || '';
      S.busy = false; paintOutput(); paintNotices(); paintFoot();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.busy = false; S.matches = []; S.count = 0;
      S.error = '搜索失败：' + err.message;
      paintOutput(); paintNotices(); paintFoot();
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
  function openConfig() {
    if (!S.root) return;
    if (!window.KoreShell || typeof window.KoreShell.openConfig !== 'function') {
      S.error = '配置面板未加载，请刷新页面后重试'; paintNotices(); return;
    }
    window.KoreShell.openConfig(S.root, 'logs', {
      title: '日志设置',
      onSaved: function () { S.selected = ''; loadSources(); }
    });
  }
  function build(root) {
    S.root = root;
    var head = add(root, el('header', 'view-head view-head-split'));
    var headMain = add(head, el('div', 'view-head-main'));
    add(headMain, el('h2', 'view-title', '日志'));
    add(headMain, el('p', 'view-sub', '按配置来源查看尾部日志、关键字过滤与全文件搜索；只读，不暴露宿主路径。'));
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
    [100, 200, 500, 1000].forEach(function (n) {
      var opt = el('option', null, n + ' 行'); opt.value = String(n);
      if (n === S.lines) opt.selected = true;
      S.linesSel.appendChild(opt);
    });
    tools.appendChild(field('行数', S.linesSel));
    S.kw = el('input', 'logs-input');
    S.kw.type = 'text'; S.kw.placeholder = '关键字（ASCII 大小写不敏感）'; S.kw.autocomplete = 'off';
    tools.appendChild(field('关键字', S.kw));
    S.search = add(tools, el('button', 'btn', '搜索')); S.search.type = 'button';
    S.sinceEl = el('input', 'logs-input'); S.sinceEl.type = 'datetime-local';
    S.sinceEl.setAttribute('aria-label', '时间起点');
    tools.appendChild(field('时间起点', S.sinceEl));
    var refresh = add(tools, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    S.statHost = add(viewPanel, el('div', 'logs-stats'));
    S.noticeHost = add(viewPanel, el('div', 'logs-notices'));
    S.pre = add(viewPanel, el('pre', 'logs-pre'));
    S.pre.setAttribute('aria-label', '日志行'); S.pre.tabIndex = 0;
    S.foot = add(viewPanel, el('div', 'logs-foot muted'));
    on(S.linesSel, function () {
      S.lines = Number(S.linesSel.value) || 200;
      if (S.mode === 'search' && S.keyword) loadSearch(); else loadTail();
    });
    S.kw.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault(); S.keyword = S.kw.value.trim(); loadTail();
    });
    on(S.search, function () { loadSearch(); });
    S.sinceEl.addEventListener('change', function () { S.since = toRFC3339(S.sinceEl.value); loadTail(); });
    on(refresh, function () { loadStats(); loadTail(); });
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    var root = add(container, el('section', 'logs'));
    build(root); loadSources();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreLogs = { render: render };
})();
