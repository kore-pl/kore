/* kore 主壳 · 日志查看（web/logs.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/logs/logs.tail）；
   方法段一律写完整限定名 logs.*，裸动词 sources/tail/search/stats/download 只是插件侧兼容，不得依赖。
   window.KoreLogs.render(container)：
   - 行配色：按行首级别 ERROR/WARN/INFO/DEBUG 着色 + 左侧 2px 色条（样式随视图注入本文件，不进 style.css）；
   - 搜索：输入即搜（防抖 300ms），logs.search query 字面匹配，命中词 <mark> 高亮 + 「命中 N 行 / 共 M 行」；
   - 级别筛选：ALL / ERROR / WARN / INFO 四个 chip（客户端过滤）；
   - 跟随：用户主动开关（默认关）——开启后每 3s 用 logs.follow 的游标（cursor）增量读取，
     只回新增完整行、最多保留 500 行；服务端重置（轮转/截断）时重新对齐。用户主动行为，非轮询默认态；
     document.hidden 时暂停。
   - 切割：logs.rotate（confirm=true）把当前文件重命名为同目录带时间戳文件，只保留最近 5 份；
     破坏性操作，先弹确认并说明「写入进程需重载后才会写回原路径」。
   - 设置：logs.config.get 读取表单 schema 与当前来源，logs.config.set 保存（每行「名称=绝对路径」或
     「名称=journal」），保存即生效、无需重启；来源白名单仍由插件侧校验。
   - 下载：logs.download 导出 <state>/exports/<source>-<ts>.log 并以 Blob 触发浏览器下载（同 file.download 通道）。
   - 统计图表（G-32 / FRONTEND §13）：logs.aggregate 最近命中按「来源 / 级别」画静态占比环。
     DOM 形态为 <svg viewBox="0 0 112 112">（背景环 + N 条 dasharray 弧 + 环心读数），
     每段有名称/条数/百分比直接标注，并有 hover / focus / tap 读数面板（数值带单位「条」）。
     零图表库、不进首屏；实例数结构上限 1，切视图 dispose 清零。
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
    '.logs-config-mask{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:var(--kore-space-3);}' +
    '.logs-config{width:min(560px,100%);max-height:86vh;overflow:auto;background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);padding:var(--kore-space-3) var(--kore-space-4);}' +
    '.logs-config h3{margin:0 0 var(--kore-space-1);font-size:var(--kore-font-14);}' +
    '.logs-config .logs-config-help{margin:0 0 var(--kore-space-2);color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.5;}' +
    '.logs-config textarea{width:100%;min-height:132px;resize:vertical;padding:var(--kore-space-2);color:var(--kore-text-1);background:var(--kore-bg-0);' +
    'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}' +
    '.logs-config-actions{display:flex;justify-content:flex-end;gap:var(--kore-space-2);margin-top:var(--kore-space-3);}' +
    '.logs-config-meta{margin-top:var(--kore-space-1);color:var(--kore-text-3);font-size:var(--kore-font-12);}' +
    /* G-32 占比图：SVG 环 + 图例 + 读数面板。样式随视图注入，不进 style.css / 首屏。 */
    '.logs-chart{margin-top:var(--kore-space-3);padding:var(--kore-space-2) 0;border-top:1px solid var(--kore-border-1);}' +
    '.logs-chart-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);margin-bottom:var(--kore-space-1);}' +
    '.logs-chart-title{font-size:var(--kore-font-12);font-weight:600;color:var(--kore-text-1);}' +
    '.logs-chart-tabs{display:inline-flex;gap:var(--kore-space-1);margin-left:auto;}' +
    '.logs-chart-tab{min-height:32px;padding:0 var(--kore-space-2);color:var(--kore-text-2);background:var(--kore-bg-0);' +
    'border:1px solid var(--kore-border-1);border-radius:999px;font:inherit;font-size:var(--kore-font-12);cursor:pointer;}' +
    '.logs-chart-tab.is-active{color:var(--kore-text-1);border-color:var(--kore-info);background:var(--kore-bg-2);font-weight:600;}' +
    '.logs-chart-note{font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.5;}' +
    '.logs-chart-body{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-3);}' +
    '.logs-chart-donut{flex:none;width:112px;height:112px;}' +
    '.logs-chart-legend{flex:1 1 160px;min-width:0;display:flex;flex-direction:column;gap:2px;}' +
    '.logs-chart-row{display:flex;align-items:center;gap:var(--kore-space-1);min-height:32px;padding:0 var(--kore-space-1);' +
    'border-radius:var(--kore-radius-control);font:inherit;font-size:var(--kore-font-12);color:var(--kore-text-2);' +
    'background:transparent;border:0;cursor:default;text-align:left;width:100%;}' +
    '.logs-chart-row.is-interactive{cursor:pointer;}' +
    '.logs-chart-row:hover,.logs-chart-row:focus-visible{background:var(--kore-bg-2);outline:none;}' +
    '.logs-chart-dot{flex:none;width:10px;height:10px;border-radius:2px;}' +
    '.logs-chart-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.logs-chart-val{flex:none;color:var(--kore-text-1);font-variant-numeric:tabular-nums;}' +
    '.logs-chart-empty{font-size:var(--kore-font-12);color:var(--kore-text-3);padding:var(--kore-space-2) 0;}' +
    '.logs-chart-tip{position:absolute;z-index:5;top:0;left:0;min-width:150px;max-width:min(280px,90vw);padding:var(--kore-space-1) var(--kore-space-2);' +
    'background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);' +
    'box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:var(--kore-font-12);color:var(--kore-text-1);' +
    'line-height:1.55;pointer-events:none;}' +
    '.logs-chart-tip[hidden]{display:none;}' +
    '.logs-chart-tip-title{font-weight:600;margin-bottom:2px;}' +
    '.logs-chart-tip-row{color:var(--kore-text-2);font-variant-numeric:tabular-nums;}' +
    '@media (pointer:coarse),(max-width:639px){.logs-chip,.logs-switch{min-height:44px;}.logs-config-actions .btn{min-height:44px;}' +
    '.logs-chart-tab,.logs-chart-row{min-height:44px;}.logs-chart-donut{width:96px;height:96px;}}';

  function fresh() {
    return { root: null, sources: [], selected: '', lines: 200, query: '', mode: 'tail',
      entries: [], matches: [], total: 0, position: 0, cursor: '',
      stats: null, count: 0, scanned: 0, truncated: false, lineTruncated: false,
      aggregate: null, chartMode: 'source', chartHost: null, chart: null,
      levelFilter: '', follow: false, followTimer: null, followBusy: false, configOpen: false,
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
    S.cursor = '';
    if (S.followTimer !== null) { clearInterval(S.followTimer); S.followTimer = null; }
    if (S.followBtn) S.followBtn.setAttribute('aria-checked', 'false');
  }
  function startFollow() {
    if (S.mode !== 'tail') { S.query = ''; S.searchInput.value = ''; }
    S.follow = true;
    S.cursor = '';
    if (S.followBtn) S.followBtn.setAttribute('aria-checked', 'true');
    followTick();
    S.followTimer = setInterval(followTick, FOLLOW_INTERVAL_MS);
  }
  function toggleFollow() {
    if (S.follow) { stopFollow(); paintFoot(); return; }
    if (!S.selected) return;
    startFollow(); paintFoot();
  }
  /* 增量拉取：用 logs.follow 的服务端游标（cursor），只回新增完整行、不重不漏；
     首次调用只建立游标（空 cursor 返回当前尾部窗口，不回填以免重复渲染），
     reset=true 表示文件轮转/截断，用服务端窗口重新对齐。隐藏页签与在途请求时跳过本轮。 */
  function followTick() {
    if (!S.follow || S.destroyed || S.followBusy || document.hidden || !S.selected) return;
    var name = S.selected;
    var boot = !S.cursor;
    S.followBusy = true;
    var params = { source: name, max_lines: FOLLOW_MAX_LINES };
    if (S.cursor) params.cursor = S.cursor;
    invoke('logs.follow', params).then(function (d) {
      S.followBusy = false;
      if (S.destroyed || !S.follow || S.selected !== name) return;
      S.cursor = d.cursor || '';
      S.position = d.position || 0;
      var freshEntries = d.entries || [];
      if (d.reset) {
        S.entries = freshEntries.slice(-FOLLOW_MAX_LINES);
        S.notice = '日志已轮转或被截断，已重新对齐到最新内容';
      } else if (!boot && freshEntries.length) {
        S.entries = S.entries.concat(freshEntries).slice(-FOLLOW_MAX_LINES);
      } else if (boot && !S.entries.length && freshEntries.length) {
        S.entries = freshEntries.slice(-FOLLOW_MAX_LINES);
      }
      S.count = S.entries.length;
      paintOutput(); paintNotices(); paintFoot();
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
  /* ===== G-32 占比图（静态 SVG，FRONTEND §13）：来源 / 级别分布 =====
     数据源 logs.aggregate：groups[].count（来源）、entries[].level（级别）。
     结构上限 1 实例；切来源 / 重渲染 / destroy 均 dispose；无 window 级监听，
     移除宿主 DOM 即解绑所有点事件。SVG viewBox 自适应，手机无需 JS resize。 */
  var CHART_SVG_NS = 'http://www.w3.org/2000/svg';
  var MAX_CHART_POINTS = 1000;      // §13-9：单图点数上限，超出合并为「其他」
  var AGG_DEBOUNCE_MS = 100;        // 快速切来源 / 切维度时只发最后一次请求（§13-7 口径）
  var CHART_TONES = {
    error: 'var(--kore-danger)', warn: 'var(--kore-warning)',
    info: 'var(--kore-info)', debug: 'var(--kore-text-3)', other: 'var(--kore-text-2)'
  };
  var SOURCE_TONES = ['var(--kore-info)', 'var(--kore-ok)', 'var(--kore-warning)',
    'var(--kore-danger)', 'var(--kore-text-3)', '#8b7cf6'];
  function chartSvg(tag, attrs) {
    var n = document.createElementNS(CHART_SVG_NS, tag), k;
    for (k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    return n;
  }
  function disposeChart() {
    if (S.chart) {
      if (S.chart.host) S.chart.host.textContent = '';
      S.chart = null;
    }
  }
  function stopAggTimer() {
    if (S.aggTimer !== null) { clearTimeout(S.aggTimer); S.aggTimer = null; }
  }
  /* 聚合为占比段：来源取 groups[].count；级别遍历 entries[].level。
     超过 MAX_CHART_POINTS 合并为「其他」，保证单图 ≤1000 点。 */
  function chartSegments() {
    var agg = S.aggregate, raw = [];
    if (!agg) return raw;
    if (S.chartMode === 'level') {
      var levels = {}, groups = agg.groups || [];
      for (var g = 0; g < groups.length; g++) {
        var entries = groups[g].entries || [];
        for (var e = 0; e < entries.length; e++) {
          var lv = String(entries[e].level || '').toLowerCase();
          var key = (lv === 'error' || lv === 'warn' || lv === 'info' || lv === 'debug') ? lv : 'other';
          levels[key] = (levels[key] || 0) + 1;
        }
      }
      ['error', 'warn', 'info', 'debug', 'other'].forEach(function (k) {
        if (levels[k]) raw.push({ name: k === 'other' ? '其他级别' : k.toUpperCase(), count: levels[k], tone: CHART_TONES[k] });
      });
    } else {
      (agg.groups || []).forEach(function (grp) {
        raw.push({ name: grp.source || '未命名', count: grp.count || 0,
          tone: grp.error ? 'var(--kore-text-3)' : SOURCE_TONES[raw.length % SOURCE_TONES.length] });
      });
    }
    raw = raw.filter(function (x) { return x.count > 0; });
    if (raw.length > MAX_CHART_POINTS) {
      var head = raw.slice(0, MAX_CHART_POINTS - 1), rest = 0;
      for (var i = MAX_CHART_POINTS - 1; i < raw.length; i++) rest += raw[i].count;
      head.push({ name: '其他（' + (raw.length - MAX_CHART_POINTS + 1) + ' 项）', count: rest, tone: 'var(--kore-text-3)' });
      return head;
    }
    return raw;
  }
  function paintTip(tip, host, seg, total, clientX) {
    tip.textContent = '';
    var pct = total > 0 ? (seg.count / total * 100).toFixed(1) : '0.0';
    add(tip, el('div', 'logs-chart-tip-title', seg.name));
    add(tip, el('div', 'logs-chart-tip-row', seg.count.toLocaleString('zh-CN') + ' 条 · ' + pct + '%'));
    tip.hidden = false;
    var hw = host.clientWidth || 0, tw = tip.offsetWidth || 0;
    var left = host.getBoundingClientRect().left;
    var x = typeof clientX === 'number' && isFinite(clientX) ? clientX - left : (hw - tw) / 2;
    x = Math.max(2, Math.min(x - tw / 2, Math.max(2, hw - tw - 2)));
    tip.style.left = x + 'px';
  }
  /* 一个段绑鼠标 hover、键盘 focus、手机 touchstart 三个读数入口；
     touchstart 用 passive，不夺滚动手势；tap 后面板保持可见。 */
  function bindPoint(node, tip, host, seg, total) {
    function show(ev) {
      var cx = null;
      if (ev && ev.touches && ev.touches[0]) cx = ev.touches[0].clientX;
      else if (ev && typeof ev.clientX === 'number') cx = ev.clientX;
      paintTip(tip, host, seg, total, cx);
    }
    node.addEventListener('mouseenter', show);
    node.addEventListener('focus', show);
    node.addEventListener('touchstart', show, { passive: true });
    node.addEventListener('mouseleave', function () { tip.hidden = true; });
    node.addEventListener('blur', function () { tip.hidden = true; });
  }
  function paintChart() {
    if (!S.chartHost) return;
    disposeChart();
    var host = S.chartHost;
    host.textContent = '';
    var wrap = add(host, el('div', 'logs-chart'));
    var head = add(wrap, el('div', 'logs-chart-head'));
    add(head, el('span', 'logs-chart-title', '最近命中分布'));
    var agg = S.aggregate;
    var scopeNote = agg && agg.truncated
      ? '最近 ' + (agg.count || 0) + ' 条（已达上限，仅样本）'
      : '最近 ' + (agg && agg.count ? agg.count : 0) + ' 条';
    add(head, el('span', 'logs-chart-note', scopeNote));
    var tabs = add(head, el('span', 'logs-chart-tabs'));
    tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '统计维度');
    [['source', '按来源'], ['level', '按级别']].forEach(function (t) {
      var b = add(tabs, el('button', 'logs-chart-tab' + (S.chartMode === t[0] ? ' is-active' : ''), t[1]));
      b.type = 'button';
      b.setAttribute('aria-pressed', S.chartMode === t[0] ? 'true' : 'false');
      on(b, function () {
        if (S.chartMode === t[0]) return;
        S.chartMode = t[0]; stopAggTimer(); loadAggregate();
      });
    });
    var body = add(wrap, el('div', 'logs-chart-body'));
    var tip = add(body, el('div', 'logs-chart-tip'));
    tip.hidden = true;
    var segs = chartSegments();
    if (!segs.length) {
      add(body, el('div', 'logs-chart-empty', '暂无可统计的命中数据（读取日志后显示来源 / 级别占比）'));
      S.chart = { host: host, svg: null, tip: tip };
      return;
    }
    var total = 0;
    segs.forEach(function (s) { total += s.count; });
    var R = 44, C = 2 * Math.PI * R, cx = 56, cy = 56;
    var svg = chartSvg('svg', { viewBox: '0 0 112 112', class: 'logs-chart-donut',
      role: 'img', 'aria-label': '最近命中' + (S.chartMode === 'source' ? '来源' : '级别') +
        '分布，共 ' + total + ' 条；' + segs.map(function (s) {
          return s.name + ' ' + s.count + ' 条';
        }).join('；') });
    svg.appendChild(chartSvg('circle', { cx: cx, cy: cy, r: R, fill: 'none',
      stroke: 'var(--kore-bg-0)', 'stroke-width': 14 }));
    var acc = 0;
    segs.forEach(function (s) {
      var len = total > 0 ? C * s.count / total : 0;
      var arc = chartSvg('circle', { cx: cx, cy: cy, r: R, fill: 'none',
        stroke: s.tone, 'stroke-width': 14,
        'stroke-dasharray': Math.max(0, len - 0.6).toFixed(2) + ' ' + C.toFixed(2),
        'stroke-dashoffset': (-acc).toFixed(2), transform: 'rotate(-90 ' + cx + ' ' + cy + ')' });
      svg.appendChild(arc);
      acc += len;
      bindPoint(arc, tip, body, s, total);
      /* SVG <title> 给无脚本兜底；桌面原生 tooltip + 自绘面板并存。 */
      var title = chartSvg('title');
      title.textContent = s.name + '：' + s.count + ' 条 · ' + (total ? (s.count / total * 100).toFixed(1) : '0.0') + '%';
      arc.appendChild(title);
    });
    var mid = chartSvg('text', { x: cx, y: cy - 3, 'text-anchor': 'middle',
      fill: 'var(--kore-text-1)', 'font-size': 16, 'font-weight': 600 });
    mid.textContent = total.toLocaleString('zh-CN');
    svg.appendChild(mid);
    var unit = chartSvg('text', { x: cx, y: cy + 13, 'text-anchor': 'middle',
      fill: 'var(--kore-text-3)', 'font-size': 9 });
    unit.textContent = '条命中';
    svg.appendChild(unit);
    body.appendChild(svg);
    var legend = add(body, el('div', 'logs-chart-legend'));
    legend.setAttribute('aria-label', '各段明细');
    segs.forEach(function (s) {
      var pct = total > 0 ? (s.count / total * 100).toFixed(1) : '0.0';
      var row = add(legend, el('div', 'logs-chart-row is-interactive'));
      row.tabIndex = 0;
      var dot = add(row, el('i', 'logs-chart-dot')); dot.style.background = s.tone;
      add(row, el('span', 'logs-chart-name', s.name));
      add(row, el('span', 'logs-chart-val', s.count.toLocaleString('zh-CN') + ' 条 · ' + pct + '%'));
      bindPoint(row, tip, body, s, total);
    });
    S.chart = { host: host, svg: svg, tip: tip };
  }
  function loadAggregate() {
    if (!S.selected || S.destroyed) return;
    var name = S.selected;
    stopAggTimer();
    S.aggTimer = setTimeout(function () {
      S.aggTimer = null;
      if (S.destroyed || S.selected !== name) return;
      invoke('logs.aggregate', { sources: [name], limit: 500 }).then(function (d) {
        if (S.destroyed || S.selected !== name) return;
        S.aggregate = d; paintChart();
      }, function (err) {
        if (S.destroyed || S.selected !== name) return;
        /* 聚合失败不影响 tail/search/download：图表给降级提示，不污染主流程。 */
        S.aggregate = null; paintChart();
        if (S.chartHost) add(add(S.chartHost, el('div', 'logs-chart-note')),
          el('span', null, '分布图加载失败：' + err.message));
      });
    }, AGG_DEBOUNCE_MS);
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
      (S.follow ? ' · 跟随中（每 ' + (FOLLOW_INTERVAL_MS / 1000) + 's，游标增量）' : '') +
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
    stopFollow(); stopSearchTimer(); stopAggTimer(); disposeChart();
    S.selected = name; S.mode = 'tail'; S.entries = []; S.matches = []; S.stats = null;
    S.aggregate = null;
    S.count = 0; S.total = 0; S.scanned = 0; S.position = 0; S.query = '';
    S.truncated = false; S.lineTruncated = false; S.levelFilter = '';
    S.notice = ''; S.error = '';
    if (S.searchInput) S.searchInput.value = '';
    paintLevelChips(); paintSources(); paintStats(); paintOutput(); paintNotices(); paintFoot(); paintChart();
    loadStats(); loadTail(); loadAggregate();
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
  function configSourceText(source) {
    if (source === 'file') return '来源：已保存的插件配置（config.json）';
    if (source === 'env') return '来源：环境变量 KORE_LOGS_SOURCES（保存后将以配置面板为准）';
    return '来源：尚未配置（保存后立即生效，无需重启）';
  }
  function closeConfig(mask) {
    S.configOpen = false;
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
  }
  /* 日志设置：logs.config.get 取 schema/当前值，logs.config.set 保存；每行「名称=绝对路径」或「名称=journal」。 */
  function openConfig() {
    if (!S.root || S.configOpen) return;
    S.configOpen = true; S.error = '';
    invoke('logs.config.get', {}).then(function (d) {
      if (S.destroyed) { S.configOpen = false; return; }
      var field = (d.schema && d.schema.fields && d.schema.fields[0]) || {};
      var values = (d.values && d.values.sources) || [];
      var mask = el('div', 'logs-config-mask');
      mask.setAttribute('role', 'dialog');
      mask.setAttribute('aria-modal', 'true');
      mask.setAttribute('aria-label', '日志设置');
      var dialog = add(mask, el('div', 'logs-config'));
      add(dialog, el('h3', null, '日志设置'));
      add(dialog, el('p', 'logs-config-help', field.help ||
        '每行一条 <名称>=<绝对路径>，或 <名称>=journal；例：syslog=/var/log/syslog、journal=journal'));
      var area = add(dialog, el('textarea'));
      area.value = values.join('\n');
      area.setAttribute('aria-label', '日志来源列表');
      area.placeholder = 'syslog=/var/log/syslog';
      add(dialog, el('div', 'logs-config-meta', configSourceText(d.source)));
      var actions = add(dialog, el('div', 'logs-config-actions'));
      var cancel = add(actions, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
      var save = add(actions, el('button', 'btn', '保存并生效')); save.type = 'button';
      on(cancel, function () { closeConfig(mask); });
      on(save, function () {
        var lines = String(area.value || '').split('\n').map(function (x) { return x.trim(); })
          .filter(function (x) { return x !== ''; });
        save.disabled = true; save.textContent = '保存中…';
        invoke('logs.config.set', { values: { sources: lines } }).then(function () {
          closeConfig(mask);
          stopFollow(); S.selected = ''; S.cursor = '';
          S.notice = '已保存并生效'; paintNotices();
          loadSources();
        }, function (err) {
          save.disabled = false; save.textContent = '保存并生效';
          S.error = '保存失败：' + err.message; paintNotices();
        });
      });
      document.body.appendChild(mask);
      area.focus();
    }, function (err) {
      S.configOpen = false;
      S.error = '设置读取失败：' + err.message; paintNotices();
    });
  }
  /* 切割：logs.rotate（破坏性）——先确认，保留最近 5 份；写明写入进程需重载。 */
  function rotateSource() {
    var name = S.selected;
    if (!name || S.busy) return;
    var ok = window.confirm('切割「' + name + '」的日志文件？\n\n' +
      '会把当前文件重命名为同目录下的时间戳文件，并只保留最近 5 份切割文件。\n' +
      '正在写入该文件的进程需要重载/重启后才会写回原路径。');
    if (!ok) return;
    S.busy = true; S.error = ''; S.notice = '';
    paintNotices(); paintFoot();
    invoke('logs.rotate', { source: name, confirm: true, keep: 5 }).then(function (d) {
      if (S.destroyed || S.selected !== name) return;
      S.busy = false;
      var base = String(d.rotated_to || '').split('/').pop();
      S.notice = '已切割为 ' + (base || d.file || '新文件') +
        (d.removed && d.removed.length ? '，清理 ' + d.removed.length + ' 份旧切割文件' : '');
      paintNotices(); paintFoot();
      loadSources(); loadStats(); loadTail();
    }, function (err) {
      if (S.destroyed || S.selected !== name) return;
      S.busy = false;
      S.error = '切割失败：' + err.message;
      paintNotices(); paintFoot();
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
    S.rotateBtn = add(tools, el('button', 'btn btn-ghost', '✂ 切割'));
    S.rotateBtn.type = 'button';
    S.rotateBtn.title = '把当前日志文件重命名为时间戳文件并保留最近 5 份（需确认）';
    S.rotateBtn.setAttribute('aria-label', '切割当前日志文件');
    on(S.rotateBtn, rotateSource);
    var refresh = add(tools, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    S.statHost = add(viewPanel, el('div', 'logs-stats'));
    S.chartHost = add(viewPanel, el('div', 'logs-chart-host'));
    paintChart();
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
      stopFollow(); stopSearchTimer(); stopAggTimer(); disposeChart();
      var mask = document.querySelector('.logs-config-mask');
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
      S.configOpen = false;
    } };
  }
  /* G-32 验收钩子：count() 返回当前实例数（结构上限 1），dispose() 供冒烟脚本清场。 */
  window.__koreLogsChart = {
    count: function () { return S.chart ? 1 : 0; },
    dispose: function () { stopAggTimer(); disposeChart(); }
  };
  window.KoreLogs = { render: render };
})();
