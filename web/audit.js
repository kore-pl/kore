/* kore 主壳 · 操作审计（web/audit.js，设置页「操作审计」tab 懒加载）
   数据契约以 handlers_audit.go 为准：since 必填、limit ≤1000、order=asc|desc；
   本轮后端只加只读筛选（subject / plugin / result / target / q / offhours / offset）与 total，
   存储结构、写入路径与既有参数语义一律不变。
   前端：服务端筛选 + 50 条/页翻页 + 关键字检索 + 「值得关注」异常聚合
   （失败 / 高频 / 非工作时间 / 异常 IP）+ 单条详情关键字段 + 按当前筛选分页导出 CSV。
   对外暴露 window.KoreAudit = { render, _csv, _analyze }（后两者为纯函数测试钩子）。 */
(function () {
  'use strict';
  var EP = '/api/v1/audit', PAGE = 50, INSIGHT_LIMIT = 1000, EXPORT_CHUNK = 1000, EXPORT_MAX = 10000;
  var BURST_WINDOW_MS = 60000, BURST_MIN = 5, IP_FAIL_MIN = 3;
  var S = {
    rows: [], total: 0, offset: 0, seq: 0,
    f: { q: '', subject: '', action: '', result: '', target: '', range: '7d', offhours: false },
    facets: { actions: [], subjects: [] },
    insightRows: null, insightTotal: 0, insightRange: '', insightLoading: false,
    loading: false, error: '', container: null,
    exporting: false, exportMsg: '', exportErr: false, exportEmpty: false
  };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function req(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.text().then(function (raw) {
          var d = {};
          if (raw) { try { d = JSON.parse(raw); } catch (e) { d = {}; } }
          return { ok: res.ok, status: res.status, data: d };
        });
      });
  }
  /* ---- 时间与筛选 ---- */
  function sinceOf(range) {
    if (range === 'all') return '1970-01-01T00:00:00Z';
    var d = new Date();
    if (range === 'today') d.setHours(0, 0, 0, 0);
    else if (range === '30d') d.setTime(d.getTime() - 30 * 86400000);
    else d.setTime(d.getTime() - 7 * 86400000);
    return d.toISOString();
  }
  function atOf(row) {
    var t = row && row.at ? Date.parse(row.at) : NaN;
    return isNaN(t) ? 0 : t;
  }
  function fmtTime(at) {
    if (!at) return '—';
    var d = new Date(at);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
  }
  // 与后端 auditOffHoursAt 同一口径（主机本地时间；前端只用于展示与聚合，筛选仍走后端）。
  function isOffHours(t) {
    if (!t) return false;
    var d = new Date(t), day = d.getDay(), hour = d.getHours();
    return day === 0 || day === 6 || hour < 9 || hour >= 18;
  }
  function detailMap(r) {
    var m = Object.create(null);
    var list = Array.isArray(r && r.detail) ? r.detail : [];
    list.forEach(function (kv) {
      if (kv && kv.key !== undefined && kv.key !== null) m[String(kv.key)] = kv.value === undefined || kv.value === null ? '' : String(kv.value);
    });
    return m;
  }
  function requestKey(m) {
    var keys = ['request_id', 'requestId', 'req_id', 'request-id'];
    for (var i = 0; i < keys.length; i++) { if (m[keys[i]]) return m[keys[i]]; }
    return '';
  }
  function hasFilter() {
    return !!(S.f.q || S.f.subject || S.f.action || S.f.result || S.f.target || S.f.offhours);
  }
  function query(opt) {
    opt = opt || {};
    var filtered = opt.filtered !== false;
    var p = ['since=' + encodeURIComponent(sinceOf(S.f.range)), 'order=desc'];
    p.push('limit=' + (opt.limit || PAGE));
    if (opt.offset) p.push('offset=' + opt.offset);
    if (filtered) {
      if (S.f.action) p.push('action=' + encodeURIComponent(S.f.action));
      if (S.f.subject) p.push('subject=' + encodeURIComponent(S.f.subject));
      if (S.f.result) p.push('result=' + encodeURIComponent(S.f.result));
      if (S.f.target) p.push('target=' + encodeURIComponent(S.f.target));
      if (S.f.q) p.push('q=' + encodeURIComponent(S.f.q));
      if (S.f.offhours) p.push('offhours=1');
    }
    return p.join('&');
  }
  /* ---- CSV 导出：纯函数 + Blob 下载（不碰查询逻辑与后端） ---- */
  // RFC4180 基本转义：字段含逗号 / 双引号 / CR / LF 必须整体加双引号，内部双引号翻倍。
  function csvCell(value) {
    var s = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // detail 是 [{key,value}]，摊平成「键：值」多行，保留原始字符交给 csvCell 转义。
  function detailText(r) {
    var list = Array.isArray(r && r.detail) ? r.detail : [];
    return list.map(function (kv) {
      var k = kv && kv.key !== undefined && kv.key !== null ? String(kv.key) : '';
      var v = kv && kv.value !== undefined && kv.value !== null ? String(kv.value) : '';
      return k ? k + '：' + v : v;
    }).join('\n');
  }
  function durationText(r) {
    var m = detailMap(r);
    if (!m.duration_ms) return '';
    return m.duration_ms + ' ms';
  }
  // at 用原始值（ISO8601，便于对账排序），不用 fmtTime 的本地化展示值。
  var CSV_COLUMNS = [
    ['时间', function (r) { return r.at; }],
    ['操作者', function (r) { return r.subject; }],
    ['动作', function (r) { return r.action; }],
    ['插件', function (r) { return r.plugin; }],
    ['目标', function (r) { return r.target; }],
    ['结果', function (r) { return r.result; }],
    ['来源 IP', function (r) { return detailMap(r).ip || ''; }],
    ['耗时', function (r) { return durationText(r); }],
    ['请求编号', function (r) { return requestKey(detailMap(r)); }],
    ['详情', detailText]
  ];
  // 返回带 UTF-8 BOM 的 CSV 字符串：Excel 双击打开中文不乱码，CRLF 行尾符合 RFC4180。
  function buildCsv(rows) {
    var lines = [CSV_COLUMNS.map(function (c) { return csvCell(c[0]); }).join(',')];
    rows.forEach(function (r) {
      lines.push(CSV_COLUMNS.map(function (c) { return csvCell(c[1](r)); }).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  // 文件名带本地时间戳（YYYYMMDD-HHmmss），多次导出不互相覆盖。
  function exportFilename() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : String(n); };
    return 'audit-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.csv';
  }
  // 结果三色：文字同时写原始值（不只靠颜色，FRONTEND §6 红线 9）。
  function resultBadge(v) {
    var tone = v === 'ok' ? 'ok' : v === 'denied' ? 'denied' : 'error';
    var label = v === 'ok' ? '成功' : v === 'denied' ? '被拒' : v === 'error' ? '失败' : (v || '—');
    return el('span', 'audit-result audit-' + tone, label);
  }
  /* ---- 「值得关注」聚合：同一份纯函数给渲染与测试用 ---- */
  function topN(counts, n) {
    return Object.keys(counts).map(function (k) { return { name: k, count: counts[k] }; })
      .sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); })
      .slice(0, n);
  }
  // analyze 只看传入窗口（调用方明确窗口大小），不臆断全量。
  function analyze(rows) {
    var list = (Array.isArray(rows) ? rows : []).slice().sort(function (a, b) { return atOf(a) - atOf(b); });
    var out = { window: list.length, fails: 0, failGroups: [], bursts: [], off: 0, ips: [] };
    var failByAction = Object.create(null), timesByAction = Object.create(null), ipMap = Object.create(null);
    list.forEach(function (r) {
      var result = String(r.result || '');
      var action = String(r.action || '未知动作');
      if (result !== 'ok') {
        out.fails++;
        failByAction[action] = (failByAction[action] || 0) + 1;
      }
      if (isOffHours(atOf(r))) out.off++;
      var m = detailMap(r);
      if (m.ip) {
        var ip = ipMap[m.ip] || (ipMap[m.ip] = { ip: m.ip, fails: 0, total: 0 });
        ip.total++;
        if (result !== 'ok') ip.fails++;
      }
      (timesByAction[action] || (timesByAction[action] = [])).push(atOf(r));
    });
    out.failGroups = topN(failByAction, 3);
    Object.keys(timesByAction).forEach(function (action) {
      var ts = timesByAction[action], j = 0, max = 0;
      for (var i = 0; i < ts.length; i++) {
        while (j < ts.length && ts[j] - ts[i] <= BURST_WINDOW_MS) j++;
        if (j - i > max) max = j - i;
      }
      if (max >= BURST_MIN) out.bursts.push({ action: action, max: max });
    });
    out.bursts.sort(function (a, b) { return b.max - a.max; });
    out.bursts = out.bursts.slice(0, 3);
    Object.keys(ipMap).forEach(function (ip) {
      if (ipMap[ip].fails >= IP_FAIL_MIN) out.ips.push(ipMap[ip]);
    });
    out.ips.sort(function (a, b) { return b.fails - a.fails; });
    out.ips = out.ips.slice(0, 3);
    return out;
  }
  /* ---- 取数 ---- */
  function load() {
    var my = ++S.seq;
    S.loading = true; S.error = '';
    paint();
    req(EP + '?' + query({ limit: PAGE, offset: S.offset })).then(function (res) {
      if (my !== S.seq) return;
      S.loading = false;
      if (res.status === 401) { S.rows = []; S.total = 0; S.error = '会话已失效：请重新登录后再查看审计'; paint(); return; }
      if (!res.ok) {
        var b = res.data || {};
        S.rows = []; S.total = 0;
        S.error = b.message ? String(b.message) : ('审计读取失败（HTTP ' + res.status + '）');
        paint(); return;
      }
      var body = res.data || {};
      S.rows = Array.isArray(body.records) ? body.records : [];
      S.total = typeof body.total === 'number' ? body.total : S.rows.length;
      // 记录被清理导致当前页越界：回退到最后一页再取一次（只回退一次）。
      if (!S.rows.length && S.total > 0 && S.offset > 0) {
        S.offset = Math.floor((S.total - 1) / PAGE) * PAGE;
        load();
        return;
      }
      if (!S.insightRows) deriveFacets(S.rows);
      paint();
    }, function (err) {
      if (my !== S.seq) return;
      S.loading = false; S.rows = []; S.total = 0;
      S.error = err && err.name === 'AbortError' ? '请求超时，请稍后重试' : '网络不太顺畅，审计记录没有读到';
      paint();
    });
  }
  function loadInsights() {
    if (S.insightRows && S.insightRange === S.f.range) { paint(); return; }
    S.insightLoading = true;
    req(EP + '?' + query({ limit: INSIGHT_LIMIT, filtered: false })).then(function (res) {
      S.insightLoading = false;
      if (!res.ok) { S.insightRows = S.insightRows || []; paint(); return; }
      var body = res.data || {};
      S.insightRows = Array.isArray(body.records) ? body.records : [];
      S.insightTotal = typeof body.total === 'number' ? body.total : S.insightRows.length;
      S.insightRange = S.f.range;
      deriveFacets(S.insightRows);
      paint();
    }, function () {
      S.insightLoading = false;
      if (!S.insightRows) S.insightRows = [];
      paint();
    });
  }
  function deriveFacets(rows) {
    var actions = Object.create(null), subjects = Object.create(null);
    (rows || []).forEach(function (r) {
      if (r.action) actions[r.action] = true;
      if (r.subject) subjects[r.subject] = true;
    });
    S.facets.actions = Object.keys(actions).sort();
    S.facets.subjects = Object.keys(subjects).sort();
  }
  /* ---- 控件 ---- */
  function selectEl(label, options, value, onChange, cls) {
    var wrap = el('label', 'audit-field' + (cls ? ' ' + cls : ''));
    wrap.appendChild(el('span', 'audit-field-label', label));
    var s = el('select', 'audit-select');
    s.setAttribute('aria-label', label);
    options.forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0];
      if (o[0] === value) op.selected = true;
      s.appendChild(op);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    wrap.appendChild(s);
    return wrap;
  }
  function inputEl(label, placeholder, value, onInput, cls) {
    var wrap = el('label', 'audit-field' + (cls ? ' ' + cls : ''));
    wrap.appendChild(el('span', 'audit-field-label', label));
    var input = el('input', 'audit-input');
    input.type = 'search';
    input.placeholder = placeholder;
    input.value = value || '';
    input.setAttribute('aria-label', label);
    var timer = null;
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; onInput(input.value.trim()); }, 250);
    });
    wrap.appendChild(input);
    return wrap;
  }
  function setFilter(name, value) {
    S.f[name] = value; S.offset = 0; load();
  }
  function applyPatch(patch) {
    Object.keys(patch).forEach(function (k) { S.f[k] = patch[k]; });
    S.offset = 0;
    load();
  }
  function clearFilters() {
    S.f.q = ''; S.f.subject = ''; S.f.action = ''; S.f.result = ''; S.f.target = ''; S.f.offhours = false;
    S.offset = 0; S.exportMsg = ''; S.exportEmpty = false;
    paint(); load();
  }
  function toolbar() {
    var bar = el('div', 'audit-toolbar');
    var fields = el('div', 'audit-fields');
    fields.appendChild(inputEl('关键字', '搜索动作、目标、操作者或 IP', S.f.q, function (v) { setFilter('q', v); }));
    var subjects = [['', '全部操作者']].concat(S.facets.subjects.map(function (s) { return [s, s]; }));
    fields.appendChild(selectEl('操作者', subjects, S.f.subject, function (v) { setFilter('subject', v); }));
    var acts = [['', '全部动作']].concat(S.facets.actions.map(function (a) { return [a, a]; }));
    fields.appendChild(selectEl('动作', acts, S.f.action, function (v) { setFilter('action', v); }, 'audit-field-action'));
    fields.appendChild(selectEl('结果', [['', '全部结果'], ['failed', '失败（含被拒）'], ['ok', '成功'], ['denied', '被拒'], ['error', '失败']],
      S.f.result, function (v) { setFilter('result', v); }));
    fields.appendChild(selectEl('时间范围', [['today', '今天'], ['7d', '最近 7 天'], ['30d', '最近 30 天'], ['all', '全部']], S.f.range,
      function (v) { S.f.range = v; S.offset = 0; loadInsights(); load(); }));
    fields.appendChild(inputEl('目标资源', '如 site/create、/etc/nginx', S.f.target, function (v) { setFilter('target', v); }));
    var off = el('label', 'audit-field audit-check');
    var offWrap = el('label', 'audit-check-row');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!S.f.offhours;
    cb.setAttribute('aria-label', '只看非工作时间（18:00–次日 09:00 或周末）');
    cb.addEventListener('change', function () { setFilter('offhours', cb.checked); });
    offWrap.appendChild(cb);
    offWrap.appendChild(el('span', 'audit-check-text', '只看非工作时间'));
    off.appendChild(offWrap);
    fields.appendChild(off);
    bar.appendChild(fields);
    var actions = el('div', 'audit-actions');
    var refresh = el('button', 'btn btn-ghost', '刷新');
    refresh.type = 'button';
    refresh.addEventListener('click', load);
    actions.appendChild(refresh);
    if (hasFilter()) {
      var clear = el('button', 'btn btn-ghost audit-clear', '清除筛选');
      clear.type = 'button';
      clear.addEventListener('click', clearFilters);
      actions.appendChild(clear);
    }
    var exportBtn = el('button', 'btn btn-ghost audit-export', S.exporting ? '导出中…' : '导出 CSV');
    exportBtn.type = 'button';
    exportBtn.disabled = S.exporting;
    exportBtn.setAttribute('aria-label', '导出当前筛选结果为 CSV 文件');
    exportBtn.addEventListener('click', doExport);
    actions.appendChild(exportBtn);
    bar.appendChild(actions);
    return bar;
  }
  /* ---- 「值得关注」区块 ---- */
  function insightCard(tone, num, label, sub, onClick) {
    var card = el('button', 'audit-insight-card audit-tone-' + tone);
    card.type = 'button';
    card.disabled = !num;
    card.setAttribute('aria-label', label + '：' + num + '；' + sub);
    card.appendChild(el('span', 'audit-insight-num', String(num)));
    card.appendChild(el('span', 'audit-insight-label', label));
    card.appendChild(el('span', 'audit-insight-sub', sub));
    if (num && onClick) card.addEventListener('click', onClick);
    return card;
  }
  function insightsSection() {
    var sec = el('div', 'audit-insight');
    var head = el('div', 'audit-insight-head');
    head.appendChild(el('span', 'audit-insight-title', '值得关注'));
    var meta;
    if (S.insightLoading && !S.insightRows) meta = '正在统计最近记录…';
    else if (!S.insightRows || !S.insightRows.length) meta = '最近窗口内暂无记录';
    else meta = '基于最近 ' + S.insightRows.length + ' 条' + (S.insightTotal > S.insightRows.length ? '（共 ' + S.insightTotal + ' 条）' : '');
    head.appendChild(el('span', 'audit-insight-meta', meta));
    sec.appendChild(head);
    var a = analyze(S.insightRows || []);
    var cards = el('div', 'audit-insight-cards');
    var failSub = a.failGroups.length ? a.failGroups.map(function (g) { return g.name + ' ×' + g.count; }).join(' · ') : '最近窗口内没有失败或被拒操作';
    cards.appendChild(insightCard('bad', a.fails, '失败 / 被拒', failSub, function () {
      applyPatch({ result: 'failed' });
    }));
    var burstSub = a.bursts.length ? a.bursts[0].action + ' · 60 秒内最多 ' + a.bursts[0].max + ' 次' : '没有 60 秒内重复 5 次以上的动作';
    cards.appendChild(insightCard('warn', a.bursts.length, '高频操作', burstSub, function () {
      applyPatch({ action: a.bursts[0].action });
    }));
    var offSub = a.off ? '18:00–次日 09:00 或周末发生的操作' : '没有非工作时间操作';
    cards.appendChild(insightCard('warn', a.off, '非工作时间', offSub, function () {
      applyPatch({ offhours: true });
    }));
    var ipSub = a.ips.length ? a.ips.map(function (g) { return g.ip + ' 失败 ' + g.fails + ' 次'; }).join(' · ') : '没有同一来源连续失败 3 次以上';
    cards.appendChild(insightCard('bad', a.ips.length, '异常来源 IP', ipSub, function () {
      applyPatch({ q: a.ips[0].ip, result: 'failed' });
    }));
    sec.appendChild(cards);
    return sec;
  }
  /* ---- 表格与详情 ---- */
  function detailCell(r) {
    var td = el('td'); td.dataset.label = '详情';
    var list = Array.isArray(r.detail) ? r.detail : [];
    if (!list.length) { td.textContent = '—'; return td; }
    var box = el('details', 'audit-detail');
    box.appendChild(el('summary', null, '详情（' + list.length + '）'));
    var m = detailMap(r);
    var kv = el('div', 'audit-kv');
    [['来源 IP', m.ip || '未记录'], ['耗时', durationText(r) || '未记录'], ['请求编号', requestKey(m) || '未记录']].forEach(function (item) {
      kv.appendChild(el('span', 'audit-kv-item', item[0] + '：' + item[1]));
    });
    box.appendChild(kv);
    list.forEach(function (item) { box.appendChild(el('div', 'audit-detail-row', item.key + '：' + item.value)); });
    td.appendChild(box);
    return td;
  }
  function table(rows) {
    var t = el('table', 'audit-table');
    var thead = el('thead'), htr = el('tr');
    ['时间', '操作者', '动作', '目标', '结果', '耗时', '详情'].forEach(function (h) { htr.appendChild(el('th', null, h)); });
    thead.appendChild(htr); t.appendChild(thead);
    var body = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr', r.result && r.result !== 'ok' ? 'audit-row audit-row-fail' : 'audit-row');
      var timeTd = el('td'); timeTd.dataset.label = '时间';
      timeTd.appendChild(el('span', null, fmtTime(r.at)));
      if (isOffHours(atOf(r))) timeTd.appendChild(el('span', 'audit-badge audit-badge-off', '非工作时间'));
      tr.appendChild(timeTd);
      [['操作者', r.subject || '—'], ['动作', r.action || '—'], ['目标', r.target || '—']].forEach(function (c) {
        var td = el('td', c[0] === '动作' ? 'audit-action mono' : null, c[1]);
        td.dataset.label = c[0]; tr.appendChild(td);
      });
      var res = el('td'); res.dataset.label = '结果'; res.appendChild(resultBadge(r.result)); tr.appendChild(res);
      var dur = el('td', 'audit-duration', durationText(r) || '—'); dur.dataset.label = '耗时'; tr.appendChild(dur);
      tr.appendChild(detailCell(r));
      body.appendChild(tr);
    });
    t.appendChild(body);
    return t;
  }
  function pager() {
    var box = el('div', 'audit-pager');
    var from = S.total ? S.offset + 1 : 0, to = Math.min(S.offset + S.rows.length, S.total);
    var prev = el('button', 'btn btn-ghost', '上一页');
    prev.type = 'button'; prev.disabled = S.offset <= 0;
    prev.addEventListener('click', function () { S.offset = Math.max(0, S.offset - PAGE); load(); });
    var next = el('button', 'btn btn-ghost', '下一页');
    next.type = 'button'; next.disabled = S.offset + PAGE >= S.total;
    next.addEventListener('click', function () { S.offset = S.offset + PAGE; load(); });
    box.appendChild(prev);
    box.appendChild(el('span', 'audit-pager-info', '第 ' + from + '–' + to + ' 条 / 共 ' + S.total + ' 条'));
    box.appendChild(next);
    return box;
  }
  /* ---- 导出：按当前筛选分页拉全量（单请求上限 1000，硬上限 10000 条） ---- */
  function doExport() {
    if (S.exporting) return;
    S.exporting = true; S.exportMsg = '正在按当前筛选收集记录…'; S.exportErr = false; S.exportEmpty = false;
    paint();
    var collected = [], offset = 0, pages = 0, total = 0;
    function fail(msg) {
      S.exporting = false; S.exportMsg = msg || '导出失败，请重试'; S.exportErr = true; paint();
    }
    function done(truncated) {
      if (!collected.length) {
        S.exporting = false;
        S.exportMsg = '当前筛选下没有记录可导出'; S.exportErr = true; S.exportEmpty = hasFilter();
        paint(); return;
      }
      var name = exportFilename();
      try {
        var csv = buildCsv(collected);
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = el('a');
        a.href = url; a.download = name; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        S.exportMsg = '已导出 ' + collected.length + ' 条记录（' + name + '）' +
          (truncated ? '；共 ' + total + ' 条，本次只导出了前 ' + collected.length + ' 条，请缩小时间范围分批导出' : '');
        S.exportErr = false;
      } catch (e) {
        S.exportMsg = '导出失败，请重试'; S.exportErr = true;
      }
      S.exporting = false; paint();
    }
    function step() {
      req(EP + '?' + query({ limit: EXPORT_CHUNK, offset: offset })).then(function (res) {
        if (!res.ok) { fail(res.data && res.data.message ? String(res.data.message) : '导出读取失败（HTTP ' + res.status + '）'); return; }
        var body = res.data || {};
        var rows = Array.isArray(body.records) ? body.records : [];
        total = typeof body.total === 'number' ? body.total : rows.length;
        collected = collected.concat(rows);
        pages++;
        if (!rows.length || collected.length >= total) { done(false); return; }
        if (pages >= 10 || collected.length >= EXPORT_MAX) { done(true); return; }
        offset += rows.length;
        step();
      }, function () { fail('网络不太顺畅，导出没有完成'); });
    }
    step();
  }
  /* ---- 渲染 ---- */
  function paint() {
    var box = S.container;
    if (!box) return;
    box.textContent = '';
    var panel = el('section', 'panel audit-panel');
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', '操作审计'));
    var meta;
    if (S.loading && !S.rows.length) meta = '正在读取…';
    else if (S.total) meta = '共 ' + S.total + ' 条' + (hasFilter() ? '（已筛选）' : '');
    else meta = hasFilter() ? '没有匹配的记录' : '暂无记录';
    head.appendChild(el('span', 'panel-meta', meta));
    panel.appendChild(head);
    panel.appendChild(insightsSection());
    panel.appendChild(toolbar());
    if (S.exportMsg) {
      var em = el('div', S.exportErr ? 'audit-export-msg audit-export-err' : 'audit-export-msg');
      em.appendChild(el('span', null, S.exportMsg));
      if (S.exportEmpty) {
        var clearBtn = el('button', 'btn btn-ghost audit-export-clear', '清除筛选');
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', clearFilters);
        em.appendChild(clearBtn);
      }
      panel.appendChild(em);
    }
    if (S.error) {
      var err = el('div', 'panel-empty empty-state');
      err.appendChild(el('p', 'empty-state-text', S.error));
      var retry = el('button', 'btn', '重试'); retry.type = 'button'; retry.addEventListener('click', load);
      err.appendChild(retry); panel.appendChild(err);
    } else if (S.loading && !S.rows.length) {
      panel.appendChild(el('div', 'audit-hint', '正在读取审计记录…'));
    } else if (!S.rows.length) {
      var empty = el('div', 'panel-empty empty-state');
      if (hasFilter()) {
        empty.appendChild(el('p', 'empty-state-title', '没有符合筛选条件的记录'));
        empty.appendChild(el('p', 'empty-state-text', '换个关键字，或放宽时间范围、关掉筛选再看看'));
        var reset = el('button', 'btn', '清除筛选'); reset.type = 'button';
        reset.addEventListener('click', clearFilters);
        empty.appendChild(reset);
      } else {
        empty.appendChild(el('p', 'empty-state-title', '还没有审计记录'));
        empty.appendChild(el('p', 'empty-state-text', '登录、写操作或权限被拒时，Kore 会自动记录在这里。'));
        var refresh = el('button', 'btn', '刷新'); refresh.type = 'button';
        refresh.addEventListener('click', load);
        empty.appendChild(refresh);
      }
      panel.appendChild(empty);
    } else {
      panel.appendChild(table(S.rows));
      if (S.total > PAGE) panel.appendChild(pager());
    }
    box.appendChild(panel);
  }
  var CSS = '.audit-toolbar{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;border-bottom:1px solid var(--kore-border-2)}' +
    '.audit-fields{display:flex;flex-wrap:wrap;gap:8px;flex:1 1 100%}' +
    '.audit-field{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--kore-text-3);flex:0 1 150px}' +
    '.audit-field-label{font-size:11px;color:var(--kore-text-3)}' +
    '.audit-field-action{flex:0 1 190px}' +
    '.audit-input,.audit-select{background:var(--kore-bg-2);color:var(--kore-text-1);border:1px solid var(--kore-border-1);border-radius:4px;padding:6px 8px;font-size:var(--kore-font-12);min-height:32px;width:100%;box-sizing:border-box}' +
    '.audit-check{flex:0 0 auto}.audit-check-row{display:flex;align-items:center;gap:6px;min-height:32px;color:var(--kore-text-2);font-size:var(--kore-font-12)}' +
    '.audit-check-row input{width:16px;height:16px}' +
    '.audit-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}' +
    '.audit-insight{border-bottom:1px solid var(--kore-border-2);padding:12px 16px}' +
    '.audit-insight-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px;flex-wrap:wrap}' +
    '.audit-insight-title{font-size:var(--kore-font-13);font-weight:600;color:var(--kore-text-1)}' +
    '.audit-insight-meta{font-size:11px;color:var(--kore-text-3)}' +
    '.audit-insight-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}' +
    '.audit-insight-card{text-align:left;background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-radius:4px;padding:8px 10px;color:var(--kore-text-1);min-height:44px;cursor:pointer;display:flex;flex-direction:column;gap:2px}' +
    '.audit-insight-card:disabled{cursor:default;opacity:.72}' +
    '.audit-insight-card:not(:disabled):hover{border-color:var(--kore-info)}' +
    '.audit-tone-bad{border-left:3px solid var(--kore-danger)}.audit-tone-warn{border-left:3px solid var(--kore-warning)}' +
    '.audit-insight-num{font-size:20px;font-weight:600;line-height:1.1}' +
    '.audit-tone-bad .audit-insight-num{color:var(--kore-danger)}.audit-tone-warn .audit-insight-num{color:var(--kore-warning)}' +
    '.audit-insight-label{font-size:var(--kore-font-12);color:var(--kore-text-2)}' +
    '.audit-insight-sub{font-size:11px;color:var(--kore-text-3);word-break:break-word}' +
    '.audit-hint{padding:8px 16px;color:var(--kore-text-3);font-size:var(--kore-font-12)}' +
    '.audit-export-msg{padding:8px 16px;font-size:var(--kore-font-12);color:var(--kore-success);display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
    '.audit-export-clear{padding:4px 12px;font-size:var(--kore-font-12)}' +
    '.audit-export-msg.audit-export-err{color:var(--kore-danger)}' +
    '.audit-panel .empty-state-title{margin:0;font-size:var(--kore-font-14);font-weight:600}' +
    '.audit-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-12)}' +
    '.audit-table th{text-align:left;padding:8px 12px;color:var(--kore-text-3);font-weight:400;border-bottom:1px solid var(--kore-border-2);white-space:nowrap}' +
    '.audit-table td{padding:8px 12px;color:var(--kore-text-1);border-top:1px solid var(--kore-border-2);vertical-align:top;word-break:break-word}' +
    '.audit-row-fail td:first-child{box-shadow:inset 3px 0 0 var(--kore-danger)}' +
    '.audit-badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;border:1px solid currentColor;font-size:11px}' +
    '.audit-badge-off{color:var(--kore-warning)}' +
    '.audit-duration{white-space:nowrap;color:var(--kore-text-2)}' +
    '.audit-result{display:inline-block;padding:0 6px;border-radius:4px;border:1px solid currentColor;font-size:11px}' +
    '.audit-result.audit-ok{color:var(--kore-success)}.audit-result.audit-denied{color:var(--kore-warning)}.audit-result.audit-error{color:var(--kore-danger)}' +
    '.audit-detail summary{cursor:pointer;color:var(--kore-info);font-size:11px}' +
    '.audit-kv{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
    '.audit-kv-item{font-size:11px;color:var(--kore-text-2);background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-radius:4px;padding:2px 6px;word-break:break-all}' +
    '.audit-detail-row{color:var(--kore-text-2);font-size:11px;margin-top:4px;word-break:break-all}' +
    '.audit-pager{display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 16px;border-top:1px solid var(--kore-border-2);flex-wrap:wrap}' +
    '.audit-pager-info{font-size:var(--kore-font-12);color:var(--kore-text-3)}' +
    '@media (max-width:639px){.audit-insight-cards{grid-template-columns:1fr}' +
    '.audit-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.audit-table,.audit-table tbody,.audit-table tr{display:block;width:100%}' +
    '.audit-table tr{padding:8px 0;border-top:1px solid var(--kore-border-2)}.audit-table td{display:flex;gap:12px;padding:4px 16px;border:0}' +
    '.audit-table td::before{content:attr(data-label);flex:0 0 64px;color:var(--kore-text-3)}' +
    '.audit-row-fail td:first-child{box-shadow:inset 3px 0 0 var(--kore-danger)}' +
    '.audit-field{flex:1 1 45%}.audit-field-action{flex:1 1 100%}' +
    '.audit-input,.audit-select,.audit-check-row{min-height:44px}' +
    '.audit-actions{width:100%}.audit-actions .btn{flex:1 1 auto;min-height:44px}' +
    '.audit-pager .btn{min-height:44px}}';
  function ensureCss() {
    if (document.getElementById('kore-audit-css')) return;
    var s = el('style'); s.id = 'kore-audit-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    ensureCss();
    S.container = container;
    paint();
    loadInsights();
    load();
    return {
      destroy: function () {
        if (S.container === container) S.container = null;
        S.seq++;
      }
    };
  }
  window.KoreAudit = {
    render: render,
    // 纯函数测试钩子：供 node 级 CSV 转义 / BOM / 异常聚合自检，不参与渲染、不新增网络 API。
    _csv: { buildCsv: buildCsv, csvCell: csvCell, detailText: detailText },
    _analyze: analyze
  };
})();
