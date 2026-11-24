/* kore 主壳 · 慢查询分析看板（web/slow-query.js，R23 新功能6，纯增量懒加载视图）
   跨 MySQL / PostgreSQL 实例聚合慢查询，按总耗时 / 执行次数 / 扫描行数排序（TopN），
   展示 SQL 摘要 + 带单位指标 + 启发式优化建议，支持时间范围、执行计划入口与 CSV 导出。
   不新增后端、不改 db.js：全部复用已接的 db-mysql / db-postgres 方法。

   数据契约（全部读自源码，不猜；取不到标「—」，绝不编造）：
     · db-mysql.instances  {} → {instances:[{name,host,port,reachable,version,error,credential_source}],count}
                              （types.go InstanceStatus）
     · db-postgres.instances {} → 同形状（pgop/types.go InstanceStatus）
     · db-mysql.slowlog {instance,schema?,min_ms,limit} → {instance,source,min_ms,limit,count,
         queries:[{schema,digest,sql_text,executions,total_ms,avg_ms,max_ms,
                   rows_examined_avg,rows_sent_avg,first_seen,last_seen}],warnings,hint}
                              （mysqlop/slowlog.go SlowLogResult / SlowQueryItem）
     · db-postgres.slowlog {…} → {instance,source,available,count,
         queries:[{schema,digest,query,executions,total_time,mean,max,rows}],warnings,hint}
         PG 视图只有 rows（累计返回/影响行），无 rows_examined / 无时间列 → 该维度记 null，
         时间范围对 PG 不生效并在界面说明。available=false 是「扩展未就绪」空态，不是错误。
     · 执行计划 db-*.query {instance,sql:'EXPLAIN '+SQL,limit} → {columns,rows,row_count,truncated}
       只读白名单允许 EXPLAIN（mysqlop/sqlguard.go、pgop/sqlguard.go）；摘要 SQL 含 ? 占位符
       时不直接 EXPLAIN（会失败），给出人话提示，让用户去数据库页用完整 SQL 分析。

   纪律：零框架 / 零 CDN / 零外链 / 零轮询；CSRF 双提交读非 HttpOnly 的 kore_csrf；
   CSS 内联注入、不进首屏预算；本模块只画表格不画图表（G-32 图表口径不触发）。
   对外暴露 window.KoreSlowQuery = { render, _test }；render(container) → {destroy}。 */
(function () {
  'use strict';

  var EP = {
    mysql: '/api/v1/invoke/db-mysql/',
    pg: '/api/v1/invoke/db-postgres/'
  };
  var STYLE_ID = 'kore-slow-query-css';
  // 时间范围：slowlog 接口无时间参数，MySQL 按 last_seen 在前端过滤；PG 无时间列不过滤。
  var RANGES = [
    { key: '1h', label: '最近 1 小时', ms: 3600000 },
    { key: '24h', label: '最近 24 小时', ms: 24 * 3600000 },
    { key: '7d', label: '最近 7 天', ms: 7 * 24 * 3600000 },
    { key: 'all', label: '全部', ms: 0 }
  ];
  var TOPS = [10, 20, 50];
  // 阈值档位与 db.js 保持一致（后端 min_ms 上限 1 小时、limit 上限 100）。
  var MIN_MS = [100, 500, 1000, 5000];
  var SORTS = [
    { key: 'totalMs', label: '总耗时' },
    { key: 'executions', label: '执行次数' },
    { key: 'rowsExamined', label: '扫描行数' }
  ];

  var S = {
    box: null, gen: 0, busy: false, msg: '', msgErr: false,
    instances: [], picked: {},        // picked key = engine + ':' + name
    range: '24h', top: 20, minMs: 500, sortKey: 'totalMs',
    rows: [], failed: [], loaded: false,
    planFor: null, plan: null, planBusy: false, planErr: ''
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function stale(gen) { return gen !== S.gen || !S.box; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function invokeAt(base, method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(base + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
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
    });
  }

  // ---- 带单位格式化（G-32：每个指标都带单位，不只靠颜色） ----
  function fmtMS(ms) {
    var v = num(ms);
    if (v === null) return '—';
    return v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v.toFixed(1) + ' ms';
  }
  function fmtCount(v) {
    var n = num(v);
    return n === null ? '—' : Math.round(n).toLocaleString('zh-CN') + ' 次';
  }
  function fmtRows(v) {
    var n = num(v);
    return n === null ? '—' : Math.round(n).toLocaleString('zh-CN') + ' 行';
  }
  function stripErr(text) {
    return String(text || '').replace(/^E_[A-Z_]+[:：]\s*/, '');
  }

  // ---- 归一化：MySQL / PG 字段形状不同，在此一处收口成统一显式结构（G-24） ----
  function normalizeMysql(item, instance) {
    return {
      instance: instance, engine: 'mysql',
      schema: String(item.schema || ''), sql: String(item.sql_text || item.digest || ''),
      digest: String(item.digest || ''),
      executions: num(item.executions) || 0, totalMs: num(item.total_ms),
      avgMs: num(item.avg_ms), maxMs: num(item.max_ms),
      rowsExamined: num(item.rows_examined_avg), rowsReturned: num(item.rows_sent_avg),
      firstSeen: String(item.first_seen || ''), lastSeen: String(item.last_seen || '')
    };
  }
  function normalizePg(item, instance) {
    return {
      instance: instance, engine: 'pg',
      schema: String(item.schema || ''), sql: String(item.query || item.digest || ''),
      digest: String(item.digest || ''),
      executions: num(item.executions) || 0, totalMs: num(item.total_time),
      avgMs: num(item.mean), maxMs: num(item.max),
      rowsExamined: num(item.rows), rowsReturned: null,
      firstSeen: '', lastSeen: ''
    };
  }

  // ---- 启发式优化建议：只给「检查方向」，不臆造具体索引名（诚实边界） ----
  function advice(row) {
    var tips = [];
    var scan = num(row.rowsExamined), ret = num(row.rowsReturned);
    var exec = num(row.executions) || 0, avg = num(row.avgMs), max = num(row.maxMs);
    if (scan !== null && ret !== null && scan > 1000 && scan > ret * 10) {
      tips.push('扫描行数远大于返回行数，检查 WHERE / JOIN 条件是否命中合适索引');
    } else if (scan !== null && scan > 10000) {
      tips.push('单次扫描行数偏高，检查是否存在全表扫描、能否缩小查询范围');
    }
    if (exec > 100 && avg !== null && avg > 100) {
      tips.push('执行频繁且单次偏慢，优先优化这条 SQL 的访问路径');
    }
    if (max !== null && avg !== null && avg > 0 && max > avg * 10 && max > 500) {
      tips.push('存在明显慢的长尾执行，检查数据倾斜或偶发锁等待');
    }
    if (!tips.length) tips.push('暂无明显信号，可点「执行计划」查看访问路径');
    return tips.join('；');
  }

  // ---- 时间范围：仅 MySQL 的 last_seen 可判定（PG 视图无时间列） ----
  function withinRange(row, rangeKey) {
    var r = RANGES.filter(function (x) { return x.key === rangeKey; })[0] || RANGES[3];
    if (!r.ms || row.engine !== 'mysql' || !row.lastSeen) return true;
    var t = Date.parse(row.lastSeen.replace(' ', 'T'));
    if (!isFinite(t)) return true; // 解析不了就保留，不误删数据
    return t >= Date.now() - r.ms;
  }

  function sortedRows() {
    var key = S.sortKey;
    return S.rows.filter(function (r) { return withinRange(r, S.range); }).slice().sort(function (a, b) {
      return (num(b[key]) || 0) - (num(a[key]) || 0);
    }).slice(0, S.top);
  }

  // ---- CSV 导出：复用 audit.js 三件套（RFC4180 转义 + UTF-8 BOM + Blob 下载） ----
  function csvCell(value) {
    var s = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  var CSV_COLUMNS = [
    ['实例', function (r) { return r.instance; }],
    ['引擎', function (r) { return r.engine === 'pg' ? 'PostgreSQL' : 'MySQL'; }],
    ['库', function (r) { return r.schema; }],
    ['SQL 摘要', function (r) { return r.sql; }],
    ['执行次数', function (r) { return r.executions; }],
    ['总耗时(ms)', function (r) { return r.totalMs === null ? '' : r.totalMs; }],
    ['平均耗时(ms)', function (r) { return r.avgMs === null ? '' : r.avgMs; }],
    ['最大耗时(ms)', function (r) { return r.maxMs === null ? '' : r.maxMs; }],
    ['扫描行数', function (r) { return r.rowsExamined === null ? '' : r.rowsExamined; }],
    ['返回行数', function (r) { return r.rowsReturned === null ? '' : r.rowsReturned; }],
    ['优化建议', function (r) { return advice(r); }]
  ];
  function buildCsv(rows) {
    var lines = [CSV_COLUMNS.map(function (c) { return csvCell(c[0]); }).join(',')];
    rows.forEach(function (r) {
      lines.push(CSV_COLUMNS.map(function (c) { return csvCell(c[1](r)); }).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  function exportFilename() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : String(n); };
    return 'slow-query-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.csv';
  }
  function download() {
    var rows = sortedRows();
    if (!rows.length) { S.msg = '当前结果为空，没有可导出的记录'; S.msgErr = true; paint(); return; }
    var name = exportFilename();
    try {
      var blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = el('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      S.msg = '已导出 ' + rows.length + ' 条记录（' + name + '）'; S.msgErr = false;
    } catch (e) {
      S.msg = '导出失败，请重试'; S.msgErr = true;
    }
    paint();
  }

  // ---- 样式内联注入，不进首屏预算；窄屏表格横向滚动 + 触摸目标 ≥44px ----
  var CSS = [
    '.sq-wrap{font-size:13px;color:var(--kore-text, #222)}',
    '.sq-toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin:12px 0;padding:12px;border:1px solid var(--kore-border-2,#ddd);border-radius:8px;background:var(--kore-bg-2,#fafafa)}',
    '.sq-group{display:flex;flex-direction:column;gap:5px;min-width:130px}',
    '.sq-group>span,.sq-group>label{font-size:12px;color:var(--kore-text-2,#666)}',
    '.sq-group select{min-height:36px;padding:5px 8px;border:1px solid var(--kore-border-2,#ccc);border-radius:5px;background:var(--kore-bg,#fff);color:inherit}',
    '.sq-inst-list{display:flex;flex-wrap:wrap;gap:8px 16px;max-height:120px;overflow:auto}',
    '.sq-inst{display:inline-flex;align-items:center;gap:6px;min-height:36px;font-size:12px;white-space:nowrap}',
    '.sq-inst input{width:16px;height:16px;accent-color:var(--kore-info,#2b7) }',
    '.sq-msg{padding:8px 12px;border-radius:6px;margin:8px 0;font-size:12px}',
    '.sq-msg.err{background:var(--kore-danger-bg,#fdecea);color:var(--kore-danger,#b3261e)}',
    '.sq-msg.ok{background:var(--kore-ok-bg,#e8f5e9);color:var(--kore-ok,#1b7f3a)}',
    '.sq-note{color:var(--kore-text-3,#888);font-size:12px;margin:6px 0;line-height:1.6}',
    '.sq-fail{border-left:3px solid var(--kore-warn,#c77);padding-left:10px;margin:8px 0;color:var(--kore-text-2,#666);font-size:12px;line-height:1.7}',
    '.sq-table-scroll{overflow-x:auto;border:1px solid var(--kore-border-2,#ddd);border-radius:8px}',
    '.sq-table{width:100%;min-width:900px;border-collapse:collapse;font-size:12px}',
    '.sq-table th,.sq-table td{border-bottom:1px solid var(--kore-border-2,#eee);padding:8px 10px;text-align:left;vertical-align:top;word-break:break-word}',
    '.sq-table th{background:var(--kore-bg-2,#fafafa);font-weight:600;white-space:nowrap;position:sticky;top:0;z-index:1}',
    '.sq-table th.num,.sq-table td.num{text-align:right;white-space:nowrap}',
    '.sq-sort{cursor:pointer;user-select:none;color:var(--kore-info,#267)}',
    '.sq-sort.active{font-weight:700;text-decoration:underline}',
    '.sq-sql{max-width:340px;display:block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.5}',
    '.sq-advice{min-width:230px;color:var(--kore-text-2,#555);line-height:1.5}',
    '.sq-plan-btn{min-height:36px;padding:5px 10px;border:1px solid var(--kore-info,#267);border-radius:5px;background:transparent;color:var(--kore-info,#267);cursor:pointer;font-size:12px}',
    '.sq-plan-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.sq-plan{margin-top:12px;padding:12px;border:1px solid var(--kore-border-2,#ddd);border-radius:8px;background:var(--kore-bg-2,#fafafa)}',
    '.sq-plan h4{margin:0 0 8px;font-size:13px}',
    '.sq-plan pre{margin:0;overflow:auto;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word}',
    '.sq-empty{text-align:center;padding:32px 16px;color:var(--kore-text-3,#888);font-size:13px;line-height:1.8}',
    '.sq-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--kore-border-2,#ccc);border-top-color:var(--kore-info,#267);border-radius:50%;animation:sq-rot .8s linear infinite;vertical-align:-2px;margin-right:6px}',
    '@keyframes sq-rot{to{transform:rotate(360deg)}}',
    '@media(max-width:639px){.sq-toolbar{gap:10px;padding:10px}.sq-group{flex-basis:100%}.sq-group select{min-height:44px;width:100%}.sq-inst{min-height:44px}.sq-plan-btn{min-height:44px}.sq-table{min-width:760px}}'
  ].join('\n');
  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = el('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s);
  }

  // ---- 渲染 ----
  function paint() {
    if (!S.box) return;
    var host = S.box;
    host.textContent = '';
    ensureCss();
    var wrap = add(host, el('div', 'sq-wrap'));

    // 工具栏：实例多选 + 时间范围 + TopN + 阈值 + 操作
    var bar = add(wrap, el('div', 'sq-toolbar'));
    var instGroup = add(bar, el('div', 'sq-group'));
    add(instGroup, el('span', null, '选择数据库实例（可多选）'));
    var instList = add(instGroup, el('div', 'sq-inst-list'));
    if (!S.instances.length) {
      add(instList, el('span', 'sq-note', '正在读取数据库连接…'));
    } else {
      S.instances.forEach(function (inst) {
        var key = inst.engine + ':' + inst.name;
        var label = add(instList, el('label', 'sq-inst'));
        var cb = add(label, el('input'));
        cb.type = 'checkbox'; cb.checked = !!S.picked[key];
        cb.disabled = !inst.reachable;
        cb.setAttribute('aria-label', (inst.engine === 'pg' ? 'PostgreSQL' : 'MySQL') + ' ' + inst.name);
        cb.addEventListener('change', function () { S.picked[key] = cb.checked; });
        add(label, el('span', null,
          (inst.engine === 'pg' ? 'PG' : 'MySQL') + ' · ' + inst.name +
          (inst.reachable ? '' : '（不可达）')));
      });
    }

    var rangeGroup = add(bar, el('div', 'sq-group'));
    add(rangeGroup, el('label', null, '时间范围'));
    var rangeSel = add(rangeGroup, el('select'));
    rangeSel.setAttribute('aria-label', '时间范围');
    RANGES.forEach(function (r) {
      var o = add(rangeSel, el('option', null, r.label)); o.value = r.key;
      if (r.key === S.range) o.selected = true;
    });
    rangeSel.addEventListener('change', function () { S.range = rangeSel.value; paint(); });

    var topGroup = add(bar, el('div', 'sq-group'));
    add(topGroup, el('label', null, '显示条数（TopN）'));
    var topSel = add(topGroup, el('select'));
    topSel.setAttribute('aria-label', '显示条数');
    TOPS.forEach(function (n) {
      var o = add(topSel, el('option', null, n + ' 条')); o.value = String(n);
      if (n === S.top) o.selected = true;
    });
    topSel.addEventListener('change', function () { S.top = parseInt(topSel.value, 10) || 20; paint(); });

    var minGroup = add(bar, el('div', 'sq-group'));
    add(minGroup, el('label', null, '耗时阈值'));
    var minSel = add(minGroup, el('select'));
    minSel.setAttribute('aria-label', '慢查询耗时阈值');
    MIN_MS.forEach(function (ms) {
      var o = add(minSel, el('option', null, '≥ ' + ms + ' ms')); o.value = String(ms);
      if (ms === S.minMs) o.selected = true;
    });
    minSel.addEventListener('change', function () { S.minMs = parseInt(minSel.value, 10) || 500; });

    var actions = add(bar, el('div', 'sq-group'));
    var run = add(actions, el('button', 'btn btn-primary', S.busy ? '正在分析…' : '开始分析'));
    run.type = 'button'; run.disabled = S.busy;
    run.addEventListener('click', analyze);
    var exp = add(actions, el('button', 'btn', '导出 CSV'));
    exp.type = 'button'; exp.disabled = S.busy || !S.rows.length;
    exp.addEventListener('click', download);

    if (S.msg) add(wrap, el('p', 'sq-msg ' + (S.msgErr ? 'err' : 'ok'), S.msg));

    // 口径说明：时间范围对 PG 不生效，必须说清（诚实边界）
    add(wrap, el('p', 'sq-note',
      '数据来自各实例的只读聚合视图：MySQL 为 performance_schema（需开启），PostgreSQL 为 pg_stat_statements（需安装并预加载）。' +
      '时间范围按 MySQL 的最近执行时间过滤；PostgreSQL 聚合视图不含时间列，时间范围对其不生效。' +
      '阈值与条数只影响读取量，分析过程不修改数据库。'));

    if (S.failed.length) {
      var fb = add(wrap, el('div', 'sq-fail'));
      add(fb, el('div', null, '有 ' + S.failed.length + ' 个连接未能读取慢查询，其余连接结果照常展示：'));
      S.failed.forEach(function (f) {
        add(fb, el('div', null, '· ' + f.name + '：' + f.reason));
      });
    }

    var rows = sortedRows();
    if (S.busy) {
      var busy = add(wrap, el('p', 'sq-empty'));
      add(busy, el('span', 'sq-spin'));
      add(busy, el('span', null, '正在读取各实例的慢查询并聚合…'));
    } else if (!S.loaded) {
      add(wrap, el('p', 'sq-empty',
        '勾选要分析的数据库连接（默认已选可达的连接），选好时间范围后点「开始分析」；' +
        '耗时阈值越低、条数越多，读取本身越慢。'));
    } else if (!rows.length) {
      add(wrap, el('p', 'sq-empty',
        '所选时间范围与阈值下没有慢查询。试着放宽时间范围、降低耗时阈值，或确认数据库已开启慢查询统计视图。'));
    } else {
      add(wrap, el('p', 'sq-note',
        '共 ' + rows.length + ' 条（按' + (SORTS.filter(function (x) { return x.key === S.sortKey; })[0] || SORTS[0]).label +
        '从高到低）。点指标名可切换排序；「执行计划」会向数据库发一条只读 EXPLAIN。'));
      var scroll = add(wrap, el('div', 'sq-table-scroll'));
      var table = add(scroll, el('table', 'sq-table'));
      var thead = add(table, el('thead')), hr = add(thead, el('tr'));
      add(hr, el('th', null, '实例 / 库'));
      add(hr, el('th', null, 'SQL 摘要'));
      SORTS.forEach(function (s) {
        var th = add(hr, el('th', 'num'));
        var btn = add(th, el('span', 'sq-sort' + (S.sortKey === s.key ? ' active' : ''), s.label));
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.addEventListener('click', function () { S.sortKey = s.key; paint(); });
        btn.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.sortKey = s.key; paint(); }
        });
      });
      add(hr, el('th', null, '优化建议'));
      add(hr, el('th', null, '操作'));

      var tbody = add(table, el('tbody'));
      rows.forEach(function (r) {
        var tr = add(tbody, el('tr'));
        var c0 = add(tr, el('td'));
        add(c0, el('span', null, (r.engine === 'pg' ? 'PG' : 'MySQL') + ' · ' + r.instance));
        if (r.schema) add(c0, el('span', 'sq-note', '库 ' + r.schema));
        var c1 = add(tr, el('td'));
        var sql = add(c1, el('span', 'sq-sql', r.sql.length > 160 ? r.sql.slice(0, 160) + '…' : r.sql));
        sql.title = r.sql + (r.digest ? '\n\ndigest: ' + r.digest : '');
        add(tr, el('td', 'num', fmtCount(r.executions)));
        add(tr, el('td', 'num', fmtMS(r.totalMs)));
        add(tr, el('td', 'num', fmtRows(r.rowsExamined)));
        add(tr, el('td', 'sq-advice', advice(r)));
        var cop = add(tr, el('td'));
        var pb = add(cop, el('button', 'sq-plan-btn', '执行计划'));
        pb.type = 'button';
        pb.addEventListener('click', function () { showPlan(r); });
      });

      // 执行计划面板（选中某行后出现）
      if (S.planFor) {
        var panel = add(wrap, el('div', 'sq-plan'));
        add(panel, el('h4', null, '执行计划 · ' + S.planFor.instance));
        if (S.planBusy) {
          add(panel, el('p', 'sq-note', '正在获取只读执行计划…'));
        } else if (S.planErr) {
          add(panel, el('p', 'sq-note', S.planErr));
        } else if (S.plan && S.plan.rows && S.plan.rows.length) {
          var cols = S.plan.columns || [];
          var preLines = [cols.join(' | ')];
          S.plan.rows.forEach(function (row) {
            preLines.push(cols.map(function (c) { return row[c] === null || row[c] === undefined ? '' : String(row[c]); }).join(' | '));
          });
          if (S.plan.truncated) preLines.push('（结果已截断，仅展示前若干行）');
          add(panel, el('pre', null, preLines.join('\n')));
        } else {
          add(panel, el('p', 'sq-note', '执行计划没有返回可展示的行。'));
        }
        var close = add(panel, el('button', 'sq-plan-btn', '关闭'));
        close.type = 'button';
        close.addEventListener('click', function () {
          S.planFor = null; S.plan = null; S.planErr = ''; paint();
        });
      }
    }
  }

  function showPlan(row) {
    if (/\?/.test(row.sql)) {
      S.planFor = row; S.plan = null; S.planBusy = false;
      S.planErr = '这条是归一化后的 SQL 摘要（含 ? 参数占位符），无法直接生成执行计划。' +
        '请到「数据库」页用带上实际参数的完整 SQL 做 EXPLAIN 分析。';
      paint();
      return;
    }
    var gen = S.gen;
    S.planFor = row; S.plan = null; S.planBusy = true; S.planErr = '';
    paint();
    var base = row.engine === 'pg' ? EP.pg : EP.mysql;
    var method = (row.engine === 'pg' ? 'db-postgres.query' : 'db-mysql.query');
    invokeAt(base, method, { instance: row.instance, sql: 'EXPLAIN ' + row.sql, limit: 50 }).then(function (data) {
      if (stale(gen)) return;
      S.planBusy = false; S.plan = data || {};
      paint();
    }, function (err) {
      if (stale(gen)) return;
      S.planBusy = false;
      S.planErr = '生成执行计划失败：' + stripErr((err && err.message) || String(err)) +
        '。可到「数据库」页重试，或确认账号有 EXPLAIN 权限。';
      paint();
    });
  }

  function loadInstances() {
    var gen = S.gen;
    Promise.all([
      invokeAt(EP.mysql, 'db-mysql.instances', {}).then(function (d) { return { d: d, engine: 'mysql' }; },
        function (e) { return { e: e, engine: 'mysql' }; }),
      invokeAt(EP.pg, 'db-postgres.instances', {}).then(function (d) { return { d: d, engine: 'pg' }; },
        function (e) { return { e: e, engine: 'pg' }; })
    ]).then(function (res) {
      if (stale(gen)) return;
      var insts = [], notes = [];
      res.forEach(function (r) {
        var list = (r.d && r.d.instances) || [];
        list.forEach(function (x) {
          insts.push({
            engine: r.engine, name: String(x.name || ''),
            reachable: !!x.reachable,
            error: String(x.error || '')
          });
        });
        if (r.e) notes.push((r.engine === 'pg' ? 'PostgreSQL' : 'MySQL') + ' 连接列表读取失败：' + stripErr((r.e && r.e.message) || String(r.e)));
      });
      S.instances = insts;
      S.picked = {};
      insts.forEach(function (x) { if (x.reachable) S.picked[x.engine + ':' + x.name] = true; });
      if (notes.length) { S.msg = notes.join('；'); S.msgErr = true; }
      paint();
    });
  }

  function analyze() {
    if (S.busy) return;
    var chosen = S.instances.filter(function (x) { return S.picked[x.engine + ':' + x.name] && x.reachable; });
    if (!chosen.length) {
      S.msg = '请先勾选至少一个可达的数据库连接再分析'; S.msgErr = true;
      paint(); return;
    }
    var gen = S.gen;
    S.busy = true; S.loaded = false; S.msg = ''; S.msgErr = false;
    S.rows = []; S.failed = []; S.planFor = null; S.plan = null;
    paint();
    var jobs = chosen.map(function (inst) {
      var base = inst.engine === 'pg' ? EP.pg : EP.mysql;
      var method = (inst.engine === 'pg' ? 'db-postgres.slowlog' : 'db-mysql.slowlog');
      return invokeAt(base, method, {
        instance: inst.name, min_ms: S.minMs, limit: S.top
      }).then(function (data) {
        return { inst: inst, data: data || {} };
      }, function (err) {
        return { inst: inst, err: (err && err.message) || String(err) };
      });
    });
    Promise.all(jobs).then(function (results) {
      if (stale(gen)) return;
      var rows = [], failed = [];
      results.forEach(function (r) {
        var inst = r.inst;
        if (r.err) {
          var reason = /performance_schema/i.test(r.err)
            ? '未开启 performance_schema 或无读取权限'
            : /pg_stat_statements|shared_preload/i.test(r.err)
              ? 'pg_stat_statements 扩展未就绪'
              : /refused|连接|timeout|超时|Can't connect/i.test(r.err)
                ? '连接不可用，请检查地址与账号'
                : stripErr(r.err);
          failed.push({ name: (inst.engine === 'pg' ? 'PG' : 'MySQL') + ' · ' + inst.name, reason: reason });
          return;
        }
        var d = r.data;
        if (inst.engine === 'pg' && d.available === false) {
          failed.push({ name: 'PG · ' + inst.name, reason: 'pg_stat_statements 扩展未就绪（已安装并预加载后重启实例再试）' });
          return;
        }
        var qs = d.queries || [];
        qs.forEach(function (q) {
          rows.push(inst.engine === 'pg' ? normalizePg(q, inst.name) : normalizeMysql(q, inst.name));
        });
        if (d.warnings && d.warnings.length) {
          failed.push({ name: (inst.engine === 'pg' ? 'PG' : 'MySQL') + ' · ' + inst.name,
            reason: '有 ' + d.warnings.length + ' 行无法解析已跳过（不影响其余结果）' });
        }
      });
      S.rows = rows; S.failed = failed; S.loaded = true; S.busy = false;
      paint();
    });
  }

  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    S.gen++; S.box = container;
    S.busy = false; S.msg = ''; S.msgErr = false;
    S.instances = []; S.picked = {}; S.rows = []; S.failed = []; S.loaded = false;
    S.planFor = null; S.plan = null; S.planBusy = false; S.planErr = '';
    S.range = '24h'; S.top = 20; S.minMs = 500; S.sortKey = 'totalMs';
    paint();
    loadInstances();
    var myGen = S.gen;
    return { destroy: function () { S.gen++; if (S.box === container) S.box = null; void myGen; } };
  }

  window.KoreSlowQuery = {
    render: render,
    _test: {
      normalizeMysql: normalizeMysql, normalizePg: normalizePg, advice: advice,
      withinRange: withinRange, sortedRows: sortedRows, buildCsv: buildCsv,
      csvCell: csvCell, fmtMS: fmtMS, fmtCount: fmtCount, fmtRows: fmtRows,
      RANGES: RANGES, TOPS: TOPS, SORTS: SORTS, S: S
    }
  };
})();
