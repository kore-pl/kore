/* kore 主壳 · 操作审计（web/audit.js，设置页「操作审计」tab 懒加载）
   数据契约以源码为准（handlers_audit.go / store/audit.go）：since 必填、无 offset、
   记录本身无时间字段；本轮给响应增加由键派生的 at 与 order=desc（只加字段，不改 bbolt 存储）。
   筛选：动作（从数据聚合 distinct）、结果、时间范围；每页 50 + 加载更多（快照上限 1000）。
   对外暴露 window.KoreAudit = { render, _csv（纯函数测试钩子） }。 */
(function () {
  'use strict';
  var EP = '/api/v1/audit', SNAP = 1000, PAGE = 50;
  var S = { rows: [], actions: [], action: '', result: '', range: '7d', shown: PAGE,
    error: '', note: '', loading: false, container: null,
    exporting: false, exportMsg: '', exportErr: false, exportEmpty: false };
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
  function since(range) {
    if (range === 'all') return '1970-01-01T00:00:00Z';
    var d = new Date();
    if (range === 'today') d.setHours(0, 0, 0, 0);
    else d.setTime(d.getTime() - 7 * 86400000);
    return d.toISOString();
  }
  function fmtTime(at) {
    if (!at) return '—';
    var d = new Date(at);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
  }
  /* ---- CSV 导出：纯函数 + Blob 下载（不碰查询逻辑与后端） ---- */
  // RFC4180 基本转义：字段含逗号 / 双引号 / CR / LF 必须整体加双引号，内部双引号翻倍。
  function csvCell(value) {
    var s = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // detail 是 [{key,value}]，摊平成「键：值」多行，保留原始字符交给 csvCell 转义。
  function detailText(r) {
    var list = Array.isArray(r.detail) ? r.detail : [];
    return list.map(function (kv) {
      var k = kv && kv.key !== undefined && kv.key !== null ? String(kv.key) : '';
      var v = kv && kv.value !== undefined && kv.value !== null ? String(kv.value) : '';
      return k ? k + '：' + v : v;
    }).join('\n');
  }
  // at 用原始值（ISO8601，便于对账排序），不用 fmtTime 的本地化展示值。
  var CSV_COLUMNS = [
    ['时间', function (r) { return r.at; }],
    ['操作者', function (r) { return r.subject; }],
    ['动作', function (r) { return r.action; }],
    ['插件', function (r) { return r.plugin; }],
    ['目标', function (r) { return r.target; }],
    ['结果', function (r) { return r.result; }],
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
    return el('span', 'audit-result audit-' + tone, v || '—');
  }
  function filtered() {
    return S.rows.filter(function (r) {
      return (!S.action || r.action === S.action) && (!S.result || r.result === S.result);
    });
  }
  function load() {
    S.loading = true; S.error = ''; paint();
    var url = EP + '?since=' + encodeURIComponent(since(S.range)) + '&limit=' + SNAP + '&order=desc';
    req(url).then(function (res) {
      S.loading = false;
      if (res.status === 401) { S.rows = []; S.error = '会话已失效：请重新登录后再查看审计'; paint(); return; }
      if (!res.ok) {
        var b = res.data || {};
        S.rows = []; S.error = b.message ? String(b.message) : ('审计读取失败（HTTP ' + res.status + '）');
        paint(); return;
      }
      var body = res.data || {};
      S.rows = Array.isArray(body.records) ? body.records : [];
      S.note = S.rows.length >= SNAP ? '仅显示最近 ' + SNAP + ' 条（接口上限）；缩小时间范围可查看更早记录。' : '';
      S.rows.forEach(function (r) { if (r.action && S.actions.indexOf(r.action) < 0) S.actions.push(r.action); });
      S.actions.sort();
      paint();
    }, function (err) {
      S.loading = false; S.rows = [];
      S.error = err && err.name === 'AbortError' ? '请求超时，请稍后重试' : '网络不太顺畅，审计记录没有读到';
      paint();
    });
  }
  function selectEl(label, options, value, onChange) {
    var s = el('select', 'audit-select');
    s.setAttribute('aria-label', label);
    options.forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; if (o[0] === value) op.selected = true; s.appendChild(op);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  function toolbar() {
    var bar = el('div', 'audit-toolbar');
    var acts = [['', '全部动作']].concat(S.actions.map(function (a) { return [a, a]; }));
    bar.appendChild(selectEl('动作类型', acts, S.action, function (v) { S.action = v; S.shown = PAGE; paint(); }));
    bar.appendChild(selectEl('结果', [['', '全部结果'], ['ok', '成功（ok）'], ['denied', '被拒（denied）'], ['error', '失败（error）']],
      S.result, function (v) { S.result = v; S.shown = PAGE; paint(); }));
    bar.appendChild(selectEl('时间范围', [['today', '今天'], ['7d', '最近 7 天'], ['all', '全部']], S.range,
      function (v) { S.range = v; S.shown = PAGE; load(); }));
    var refresh = el('button', 'btn btn-ghost', '刷新'); refresh.type = 'button';
    refresh.addEventListener('click', load);
    bar.appendChild(refresh);
    var exportBtn = el('button', 'btn btn-ghost audit-export', S.exporting ? '导出中…' : '导出 CSV');
    exportBtn.type = 'button';
    exportBtn.disabled = S.exporting;
    exportBtn.style.minHeight = '44px'; // 触摸目标 ≥44px（裁决41），写域内内联不依赖公共 CSS
    exportBtn.setAttribute('aria-label', '导出当前筛选结果为 CSV 文件');
    exportBtn.addEventListener('click', doExport);
    bar.appendChild(exportBtn);
    return bar;
  }
  // 导出当前筛选下的全部已加载记录（不是当前页），纯前端生成 CSV 并触发下载。
  function doExport() {
    if (S.exporting) return;
    var rows = filtered();
    if (!rows.length) {
      S.exportMsg = '当前筛选下无记录可导出'; S.exportErr = true;
      S.exportEmpty = !!(S.action || S.result); // 有筛选条件才给「清除筛选」下一步
      paint(); return;
    }
    S.exporting = true; S.exportMsg = '正在生成 CSV…'; S.exportErr = false;
    S.exportEmpty = false;
    paint();
    // 让浏览器先把 loading 态绘制出来，再做同步的 CSV 拼装与下载。
    setTimeout(function () {
      var name = exportFilename();
      try {
        var csv = buildCsv(rows);
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = el('a');
        a.href = url; a.download = name; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        S.exportMsg = '已导出 ' + rows.length + ' 条记录（' + name + '）';
        S.exportErr = false;
      } catch (e) {
        S.exportMsg = '导出失败，请重试'; S.exportErr = true;
      }
      S.exporting = false;
      paint();
    }, 0);
  }
  function detailCell(r) {
    var td = el('td'); td.dataset.label = '详情';
    var list = Array.isArray(r.detail) ? r.detail : [];
    if (!list.length) { td.textContent = '—'; return td; }
    var box = el('details', 'audit-detail');
    box.appendChild(el('summary', null, '详情（' + list.length + '）'));
    list.forEach(function (kv) { box.appendChild(el('div', 'audit-detail-row', kv.key + '：' + kv.value)); });
    td.appendChild(box);
    return td;
  }
  function table(rows) {
    var t = el('table', 'audit-table');
    var thead = el('thead'), htr = el('tr');
    ['时间', '操作者', '动作', '目标', '结果', '详情'].forEach(function (h) { htr.appendChild(el('th', null, h)); });
    thead.appendChild(htr); t.appendChild(thead);
    var body = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      [['时间', fmtTime(r.at)], ['操作者', r.subject || '—'], ['动作', r.action || '—'], ['目标', r.target || '—']].forEach(function (c) {
        var td = el('td', c[0] === '动作' ? 'audit-action mono' : null, c[1]);
        td.dataset.label = c[0]; tr.appendChild(td);
      });
      var res = el('td'); res.dataset.label = '结果'; res.appendChild(resultBadge(r.result)); tr.appendChild(res);
      tr.appendChild(detailCell(r));
      body.appendChild(tr);
    });
    t.appendChild(body);
    return t;
  }
  function paint() {
    var box = S.container;
    if (!box) return;
    box.textContent = '';
    var panel = el('section', 'panel audit-panel');
    var head = el('div', 'panel-head');
    var f = filtered();
    head.appendChild(el('span', 'panel-title', '操作审计'));
    head.appendChild(el('span', 'panel-meta', '匹配 ' + f.length + ' 条 · 显示 ' + Math.min(S.shown, f.length) + ' 条'));
    panel.appendChild(head);
    panel.appendChild(toolbar());
    if (S.exportMsg) {
      var em = el('div', S.exportErr ? 'audit-export-msg audit-export-err' : 'audit-export-msg');
      em.appendChild(el('span', null, S.exportMsg));
      if (S.exportEmpty) {
        var clearBtn = el('button', 'btn btn-ghost audit-export-clear', '清除筛选');
        clearBtn.type = 'button'; clearBtn.style.minHeight = '44px';
        clearBtn.addEventListener('click', function () {
          S.action = ''; S.result = ''; S.exportMsg = ''; S.exportEmpty = false;
          S.shown = PAGE; paint();
        });
        em.appendChild(clearBtn);
      }
      panel.appendChild(em);
    }
    if (S.note) panel.appendChild(el('div', 'audit-hint', S.note));
    if (S.error) {
      var err = el('div', 'panel-empty empty-state');
      err.appendChild(el('p', 'empty-state-text', S.error));
      var retry = el('button', 'btn', '重试'); retry.type = 'button'; retry.addEventListener('click', load);
      err.appendChild(retry); panel.appendChild(err);
    } else if (S.loading && !S.rows.length) {
      panel.appendChild(el('div', 'audit-hint', '正在读取审计记录…'));
    } else if (!f.length) {
      var empty = el('div', 'panel-empty empty-state');
      if (S.rows.length && (S.action || S.result)) {
        empty.appendChild(el('p', 'empty-state-title', '没有符合筛选条件的记录'));
        empty.appendChild(el('p', 'empty-state-text', '换一个动作 / 结果或放宽时间范围再看看'));
        var reset = el('button', 'btn', '清除筛选'); reset.type = 'button';
        reset.addEventListener('click', function () { S.action = ''; S.result = ''; S.shown = PAGE; paint(); });
        empty.appendChild(reset);
      } else {
        empty.appendChild(el('p', 'empty-state-title', '还没有审计记录'));
        empty.appendChild(el('p', 'empty-state-text', '有写操作或权限拒绝时会自动记录在这里。'));
        var refresh = el('button', 'btn', '刷新'); refresh.type = 'button';
        refresh.addEventListener('click', function () { load(); });
        empty.appendChild(refresh);
      }
      panel.appendChild(empty);
    } else {
      panel.appendChild(table(f.slice(0, S.shown)));
      if (f.length > S.shown) {
        var more = el('div', 'audit-more'), btn = el('button', 'btn', '加载更多（剩余 ' + (f.length - S.shown) + ' 条）');
        btn.type = 'button';
        btn.addEventListener('click', function () { S.shown += PAGE; paint(); });
        more.appendChild(btn); panel.appendChild(more);
      }
    }
    box.appendChild(panel);
  }
  var CSS = '.audit-toolbar{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;border-bottom:1px solid var(--kore-border-2)}' +
    '.audit-select{background:var(--kore-bg-2);color:var(--kore-text-1);border:1px solid var(--kore-border-1);border-radius:4px;padding:6px 8px;font-size:var(--kore-font-12)}' +
    '.audit-hint{padding:8px 16px;color:var(--kore-text-3);font-size:var(--kore-font-12)}' +
    '.audit-export-msg{padding:8px 16px;font-size:var(--kore-font-12);color:var(--kore-success);display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
    '.audit-export-clear{padding:4px 12px;font-size:var(--kore-font-12)}' +
    '.audit-export-msg.audit-export-err{color:var(--kore-danger)}' +
    '.audit-panel .empty-state-title{margin:0;font-size:var(--kore-font-14);font-weight:600}' +
    '.audit-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-12)}' +
    '.audit-table th{text-align:left;padding:8px 12px;color:var(--kore-text-3);font-weight:400;border-bottom:1px solid var(--kore-border-2);white-space:nowrap}' +
    '.audit-table td{padding:8px 12px;color:var(--kore-text-1);border-top:1px solid var(--kore-border-2);vertical-align:top;word-break:break-word}' +
    '.audit-result{display:inline-block;padding:0 6px;border-radius:4px;border:1px solid currentColor;font-size:11px}' +
    '.audit-result.audit-ok{color:var(--kore-success)}.audit-result.audit-denied{color:var(--kore-warning)}.audit-result.audit-error{color:var(--kore-danger)}' +
    '.audit-detail summary{cursor:pointer;color:var(--kore-info);font-size:11px}.audit-detail-row{color:var(--kore-text-2);font-size:11px;margin-top:4px;word-break:break-all}' +
    '.audit-more{padding:12px 16px;border-top:1px solid var(--kore-border-2);text-align:center}' +
    '@media (max-width:639px){.audit-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.audit-table,.audit-table tbody,.audit-table tr{display:block;width:100%}' +
    '.audit-table tr{padding:8px 0;border-top:1px solid var(--kore-border-2)}.audit-table td{display:flex;gap:12px;padding:4px 16px;border:0}' +
    '.audit-table td::before{content:attr(data-label);flex:0 0 64px;color:var(--kore-text-3)}.audit-toolbar .audit-select{flex:1 1 40%}}';
  function ensureCss() {
    if (document.getElementById('kore-audit-css')) return;
    var s = el('style'); s.id = 'kore-audit-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    ensureCss();
    S.container = container;
    paint();
    load();
    return { destroy: function () { if (S.container === container) S.container = null; } };
  }
  window.KoreAudit = {
    render: render,
    // 纯函数测试钩子：供 node 级 CSV 转义/BOM 自检，不参与渲染、不新增网络 API。
    _csv: { buildCsv: buildCsv, csvCell: csvCell, detailText: detailText }
  };
})();
