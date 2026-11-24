/* kore 主壳 · 一键运行报告（web/report.js，懒加载视图）
   纯增量前端功能：把散落在监控 / 告警 / 插件 / 备份 / 审计页的数据聚合成一份
   可存档的运维报告（Markdown + 可打印 HTML），浏览器 Blob 下载，不落库、不新增后端端点。

   数据契约（全部读自源码，不猜；取不到标「暂无数据」，绝不编造）：
     · 资源趋势  POST /api/v1/invoke/monitor/monitor.system  {per_cpu:false, thresholds:{cpu/memory/disk_percent:0}}
                 → SystemResult.history 列式数组：timestamps(ms) / cpu_percent / memory_percent /
                   disk_percent / load1 / interval_s。参数边界读自 kore-plugin-monitor/internal/monitor/params.go
                   （history_points 2..720、history_interval_s 1..3600），据此把 24h/7d 换算成
                   points=720 + interval_s=120/840；前端再按 timestamps 实际值过滤窗口。
     · 告警统计  GET  /api/v1/alerts?limit=500  → {alerts:[{id,ts,severity,source,title,detail,seen,count}],count,unread,limit}
                   端点只支持 limit/severity（handlers_alerts.go parseAlertsQuery），按 ts 前端过滤窗口。
     · 插件状态  GET  /api/v1/plugins → {plugins:[{name,id,state,restarts,...}]}（当前快照）；
                   变更记录取审计里 plugin.* 动作（插件端点无历史序列）。
     · 备份完成  POST /api/v1/invoke/backup/backup.jobs {limit:N} → {jobs:[{status,name,dimensions,started_at,entries,bytes,error}]}
     · 操作审计  GET  /api/v1/audit?since=<ISO>&limit=1000&order=desc → {records:[{at,subject,action,plugin,target,result,detail}]}
                   since 必填、无 offset、快照上限 1000（audit.js 契约）。

   纪律：零框架 / 零 CDN / 零外链 / 零轮询（G-19）；CSRF 双提交读非 HttpOnly 的 kore_csrf（写端点）；
   本模块自身不画图表（报告是文本 + 表格存档，天然不进 G-32 图表实例口径）；样式内联注入，不进首屏预算。
   对外暴露 window.KoreReport = { render, _test }；render(container) → {destroy}。 */
(function () {
  'use strict';

  var EP = {
    monitorSystem: '/api/v1/invoke/monitor/monitor.system',
    backupJobs: '/api/v1/invoke/backup/backup.jobs',
    alerts: '/api/v1/alerts',
    plugins: '/api/v1/plugins',
    audit: '/api/v1/audit'
  };
  var RANGES = [
    { key: '24h', label: '最近 24 小时', ms: 24 * 3600000, points: 720, interval: 120 },
    { key: '7d', label: '最近 7 天', ms: 7 * 24 * 3600000, points: 720, interval: 840 }
  ];
  // 数据源定义：key 既是勾选状态键，也是数据模型键。
  var SOURCES = [
    { key: 'metrics', label: '资源使用趋势', hint: 'CPU / 内存 / 磁盘（monitor.history）' },
    { key: 'alerts', label: '告警统计', hint: '告警中心历史记录' },
    { key: 'plugins', label: '插件状态变更', hint: '当前状态 + 审计里的启停记录' },
    { key: 'backups', label: '备份完成情况', hint: 'backup.jobs 作业记录' },
    { key: 'audit', label: '操作审计摘要', hint: '写操作与权限拒绝记录' }
  ];
  var STYLE_ID = 'kore-report-css';
  var S = { box: null, gen: 0, range: '24h', picked: {}, data: null, busy: false, msg: '', msgErr: false,
    downloadBusy: false };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function stale(gen) { return gen !== S.gen || !S.box; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function localTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function fileStamp(d) {
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }
  function pct(v) { var n = num(v); return n === null ? '—' : n.toFixed(1) + '%'; }
  function bytes(n) {
    var v = num(n);
    if (v === null) return '—';
    if (v < 1024) return Math.round(v) + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KiB';
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MiB';
    return (v / 1073741824).toFixed(2) + ' GiB';
  }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [], i, kv;
    for (i = 0; i < parts.length; i++) {
      kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function rangeDef() {
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].key === S.range) return RANGES[i];
    return RANGES[0];
  }

  // GET：永不因 HTTP 状态码 reject；网络错误 reject 由调用方兜住并标「读取失败」。
  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.text().then(function (raw) {
          var data = {};
          if (raw) { try { data = JSON.parse(raw); } catch (e) { data = {}; } }
          return { ok: res.ok, status: res.status, data: data };
        });
      });
  }
  // POST invoke：CSRF 双提交（kore_csrf 非 HttpOnly，前端可读）。
  function invoke(url, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少安全令牌，请刷新页面或重新登录'));
    return fetch(url, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('HTTP ' + res.status)));
          err.status = res.status; throw err;
        }
        return data;
      });
    });
  }

  /* ---------- 纯聚合函数（可被 _test 在 node 下自检，不依赖 DOM） ---------- */

  // 从 monitor.system.history 列式数组里按窗口取数并算 min/max/avg/latest。
  function summarizeHistory(history, since, labels) {
    var ts = history && Array.isArray(history.timestamps) ? history.timestamps : [];
    var out = { available: false, points: 0, intervalS: num(history && history.interval_s),
      coverageFrom: '', coverageTo: '', rows: [] };
    var kept = [];
    var i, j;
    for (i = 0; i < ts.length; i++) {
      var t = Number(ts[i]);
      if (isFinite(t) && t >= since) kept.push(i);
    }
    if (!kept.length) return out;
    out.available = true;
    out.points = kept.length;
    out.coverageFrom = localTime(ts[kept[0]]);
    out.coverageTo = localTime(ts[kept[kept.length - 1]]);
    var defs = [
      { key: 'cpu_percent', label: labels.cpu, unit: '%', pct: true },
      { key: 'memory_percent', label: labels.memory, unit: '%', pct: true },
      { key: 'disk_percent', label: labels.disk, unit: '%', pct: true }
    ];
    defs.forEach(function (def) {
      var arr = history[def.key];
      if (!Array.isArray(arr)) {
        out.rows.push({ label: def.label, unit: def.unit, min: null, max: null, avg: null, latest: null });
        return;
      }
      var min = null, max = null, sum = 0, cnt = 0, latest = null;
      kept.forEach(function (idx) {
        var v = num(arr[idx]);
        if (v === null) return;
        if (min === null || v < min) min = v;
        if (max === null || v > max) max = v;
        sum += v; cnt++; latest = v;
      });
      out.rows.push({ label: def.label, unit: def.unit,
        min: cnt ? min : null, max: cnt ? max : null, avg: cnt ? sum / cnt : null, latest: latest });
    });
    return out;
  }

  // 告警按严重度计数 + 按时间窗口过滤（端点不支持 since，只能前端过滤）。
  function summarizeAlerts(alerts, since, until) {
    var out = { available: false, total: 0, unread: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, rows: [] };
    if (!alerts || !Array.isArray(alerts.alerts)) return out;
    out.available = true;
    out.unread = num(alerts.unread) || 0;
    alerts.alerts.forEach(function (a) {
      var t = Date.parse(a.ts);
      if (!isFinite(t) || t < since || t > until) return;
      out.total++;
      var sev = a.severity === 'critical' || a.severity === 'warning' ? a.severity : 'info';
      out.bySeverity[sev]++;
      out.rows.push({ ts: a.ts, severity: sev, source: a.source || '', title: a.title || '',
        count: num(a.count) || 1, seen: !!a.seen });
    });
    return out;
  }

  // 插件当前状态快照 + 审计里的插件变更动作（插件端点无历史序列，如实标注）。
  function summarizePlugins(plugins, auditRecords, since, until) {
    var out = { available: false, snapshot: { total: 0, active: 0, failed: 0, idle: 0 }, changes: [] };
    if (plugins && Array.isArray(plugins.plugins)) {
      out.available = true;
      plugins.plugins.forEach(function (p) {
        out.snapshot.total++;
        var st = p.state || '';
        if (st === 'failed') out.snapshot.failed++;
        else if (st === 'active' || st === 'running' || st === 'resident') out.snapshot.active++;
        else out.snapshot.idle++;
      });
    }
    if (auditRecords && Array.isArray(auditRecords.records)) {
      auditRecords.records.forEach(function (r) {
        var t = Date.parse(r.at);
        if (!isFinite(t) || t < since || t > until) return;
        var action = String(r.action || '');
        if (action.indexOf('plugin') < 0) return;
        out.changes.push({ at: r.at, subject: r.subject || '', action: action,
          target: r.target || r.plugin || '', result: r.result || '' });
      });
      if (out.changes.length) out.available = true;
    }
    return out;
  }

  // 备份作业按 started_at 过滤窗口并统计终态。
  function summarizeBackups(data, since, until) {
    var out = { available: false, total: 0, succeeded: 0, failed: 0, running: 0, rows: [] };
    if (!data || !Array.isArray(data.jobs)) return out;
    out.available = true;
    data.jobs.forEach(function (j) {
      var t = Date.parse(j.started_at);
      if (!isFinite(t) || t < since || t > until) return;
      out.total++;
      var st = j.status || '';
      if (st === 'succeeded') out.succeeded++;
      else if (st === 'failed') out.failed++;
      else out.running++;
      out.rows.push({ started: j.started_at, status: st, name: j.name || '',
        dimensions: Array.isArray(j.dimensions) ? j.dimensions.join(' + ') : '',
        entries: num(j.entries), bytes: num(j.bytes), error: j.error || '' });
    });
    return out;
  }

  // 审计摘要：按 result 计数 + 动作分布，明细留最近 20 条。
  function summarizeAudit(data, since, until) {
    var out = { available: false, total: 0, byResult: { ok: 0, denied: 0, error: 0 },
      topActions: [], rows: [] };
    if (!data || !Array.isArray(data.records)) return out;
    out.available = true;
    var acts = Object.create(null);
    data.records.forEach(function (r) {
      var t = Date.parse(r.at);
      if (!isFinite(t) || t < since || t > until) return;
      out.total++;
      var res = r.result === 'denied' || r.result === 'error' ? r.result : 'ok';
      out.byResult[res]++;
      var a = r.action || 'unknown';
      acts[a] = (acts[a] || 0) + 1;
      if (out.rows.length < 20) {
        var detail = Array.isArray(r.detail) ? r.detail.map(function (kv) {
          return (kv && kv.key ? String(kv.key) + '：' : '') + (kv && kv.value !== undefined ? String(kv.value) : '');
        }).join('；') : '';
        out.rows.push({ at: r.at, subject: r.subject || '', action: a, target: r.target || '',
          result: r.result || '', detail: detail });
      }
    });
    out.topActions = Object.keys(acts).sort(function (a, b) { return acts[b] - acts[a]; }).slice(0, 5)
      .map(function (k) { return { action: k, count: acts[k] }; });
    return out;
  }

  function statusOf(avail, failed) { return failed ? 'fail' : (avail ? 'ok' : 'empty'); }
  function statusText(st) {
    return st === 'ok' ? '已获取' : st === 'fail' ? '读取失败（详见下方说明）' : '暂无数据';
  }

  /* ---------- 报告文本生成（Markdown / 可打印 HTML，同一数据模型） ---------- */

  function mdTable(headers, rows) {
    var lines = ['| ' + headers.join(' | ') + ' |',
      '| ' + headers.map(function () { return '---'; }).join(' | ') + ' |'];
    rows.forEach(function (r) { lines.push('| ' + r.map(function (c) {
      return String(c === undefined || c === null || c === '' ? '—' : c).replace(/\|/g, '\\|');
    }).join(' | ') + ' |'); });
    return lines.join('\n');
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildMarkdown(model) {
    var m = model.meta, s = model.sections, L = [];
    L.push('# Kore 运维报告');
    L.push('');
    L.push('- 生成时间：' + m.generatedLocal + '（' + m.generatedISO + '）');
    L.push('- 数据范围：' + m.sinceLocal + ' ～ ' + m.untilLocal + '（' + m.rangeLabel + '）');
    L.push('- 报告说明：本报告由 Kore 控制台一键生成，数据来自下列现有端点，未做任何估算或补全。');
    L.push('');
    L.push('## 一、数据来源与口径');
    L.push('');
    L.push(mdTable(['数据项', '端点', '口径与局限', '状态'], model.sources.map(function (x) {
      return [x.label, x.endpoint, x.note, statusText(x.status)];
    })));
    L.push('');
    L.push('> 取不到的项目一律标注「暂无数据」或「读取失败」，不以 0 或推测值代替。' +
      '告警端点只保留最近 500 条并按 5 分钟去重合并；审计为最近 1000 条快照；' +
      '历史曲线为插件环形缓冲，实际覆盖范围以「采样区间」为准。');
    L.push('');

    L.push('## 二、资源使用趋势');
    if (s.metrics.status === 'ok' && s.metrics.data.available) {
      var d = s.metrics.data;
      L.push('采样区间：' + d.coverageFrom + ' ～ ' + d.coverageTo +
        '；采样点 ' + d.points + ' 个' + (d.intervalS ? '，间隔 ' + d.intervalS + ' 秒' : '') + '。');
      L.push('');
      L.push(mdTable(['指标', '最小', '最大', '平均', '最新', '单位'], d.rows.map(function (r) {
        return [r.label, pct(r.min), pct(r.max), pct(r.avg), pct(r.latest), r.unit];
      })));
    } else {
      L.push('暂无数据（' + (s.metrics.status === 'fail' ? s.metrics.error : 'monitor 插件未提供历史曲线') + '）。');
    }
    L.push('');

    L.push('## 三、告警统计');
    if (s.alerts.status === 'ok' && s.alerts.data.available) {
      var a = s.alerts.data;
      L.push('窗口内共 ' + a.total + ' 条告警（严重 ' + a.bySeverity.critical + ' / 警告 ' +
        a.bySeverity.warning + ' / 提示 ' + a.bySeverity.info + '）；全库未读 ' + a.unread + ' 条。');
      L.push('');
      L.push(mdTable(['时间', '级别', '来源', '标题', '合并次数'], a.rows.slice(0, 40).map(function (r) {
        return [localTime(r.ts), r.severity, r.source, r.title, r.count];
      })));
      if (a.rows.length > 40) L.push('');
      if (a.rows.length > 40) L.push('（仅列出最近 40 条，共 ' + a.rows.length + ' 条。）');
    } else {
      L.push('暂无数据（' + (s.alerts.status === 'fail' ? s.alerts.error : '告警历史未装配或无记录') + '）。');
    }
    L.push('');

    L.push('## 四、插件状态变更');
    if (s.plugins.status === 'ok' && s.plugins.data.available) {
      var p = s.plugins.data;
      L.push('当前快照：已装 ' + p.snapshot.total + ' 个（运行 ' + p.snapshot.active +
        ' / 空闲 ' + p.snapshot.idle + ' / 异常 ' + p.snapshot.failed + '）。');
      L.push('');
      if (p.changes.length) {
        L.push(mdTable(['时间', '操作者', '动作', '目标', '结果'], p.changes.slice(0, 30).map(function (r) {
          return [localTime(r.at), r.subject, r.action, r.target, r.result];
        })));
      } else {
        L.push('窗口内没有插件启停变更记录（插件状态端点只提供当前快照，历史变更取审计）。');
      }
    } else {
      L.push('暂无数据（' + (s.plugins.status === 'fail' ? s.plugins.error : '插件列表不可读') + '）。');
    }
    L.push('');

    L.push('## 五、备份完成情况');
    if (s.backups.status === 'ok' && s.backups.data.available) {
      var b = s.backups.data;
      L.push('窗口内作业 ' + b.total + ' 个：成功 ' + b.succeeded + ' / 失败 ' + b.failed +
        ' / 进行中 ' + b.running + '。');
      L.push('');
      L.push(mdTable(['开始时间', '名称', '维度', '状态', '条目', '大小', '错误'], b.rows.slice(0, 30).map(function (r) {
        return [localTime(r.started), r.name, r.dimensions, r.status,
          r.entries === null ? '—' : r.entries, bytes(r.bytes), r.error];
      })));
    } else {
      L.push('暂无数据（' + (s.backups.status === 'fail' ? s.backups.error : 'backup 插件未提供作业记录') + '）。');
    }
    L.push('');

    L.push('## 六、操作审计摘要');
    if (s.audit.status === 'ok' && s.audit.data.available) {
      var u = s.audit.data;
      L.push('窗口内记录 ' + u.total + ' 条（成功 ' + u.byResult.ok + ' / 拒绝 ' + u.byResult.denied +
        ' / 失败 ' + u.byResult.error + '）。');
      if (u.topActions.length) {
        L.push('');
        L.push('高频动作：' + u.topActions.map(function (x) { return x.action + ' ×' + x.count; }).join('、') + '。');
      }
      L.push('');
      L.push(mdTable(['时间', '操作者', '动作', '目标', '结果', '详情'], u.rows.map(function (r) {
        return [localTime(r.at), r.subject, r.action, r.target, r.result, r.detail];
      })));
    } else {
      L.push('暂无数据（' + (s.audit.status === 'fail' ? s.audit.error : '审计无记录') + '）。');
    }
    L.push('');
    L.push('---');
    L.push('');
    L.push('*由 Kore 控制台生成 · ' + m.generatedISO + '*');
    return L.join('\n') + '\n';
  }

  function htmlTable(headers, rows) {
    var h = '<table><thead><tr>' + headers.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr>' + r.map(function (c) { return '<td>' + esc(c === undefined || c === null || c === '' ? '—' : c) + '</td>'; }).join('') + '</tr>';
    });
    return h + '</tbody></table>';
  }
  function buildHtml(model) {
    var m = model.meta, s = model.sections, P = [];
    P.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">');
    P.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
    P.push('<title>Kore 运维报告 · ' + esc(m.generatedLocal) + '</title>');
    P.push('<style>');
    P.push('*{box-sizing:border-box}body{margin:0 auto;padding:32px 24px;max-width:960px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans CJK SC","Microsoft YaHei",sans-serif;color:#1f2430;background:#fff}');
    P.push('h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid #e3e8ef}');
    P.push('h3{font-size:15px;margin:0}.meta{color:#5b6472;font-size:13px;margin:2px 0}');
    P.push('table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}th,td{border:1px solid #dfe5ee;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word}');
    P.push('th{background:#f2f5f9;white-space:nowrap}blockquote{margin:12px 0;padding:10px 14px;background:#f7f9fc;border-left:3px solid #5b8def;color:#4a5464;font-size:13px}');
    P.push('.foot{margin-top:32px;color:#8a93a1;font-size:12px}');
    P.push('@media print{body{padding:0;max-width:none;font-size:11px}h2{page-break-after:avoid}table{page-break-inside:auto}tr{page-break-inside:avoid}a{text-decoration:none}}');
    P.push('@media(max-width:639px){body{padding:16px 12px}table{display:block;overflow-x:auto;white-space:nowrap}th,td{padding:5px 6px}}');
    P.push('</style></head><body>');
    P.push('<h1>Kore 运维报告</h1>');
    P.push('<p class="meta">生成时间：' + esc(m.generatedLocal) + '（' + esc(m.generatedISO) + '）</p>');
    P.push('<p class="meta">数据范围：' + esc(m.sinceLocal) + ' ～ ' + esc(m.untilLocal) + '（' + esc(m.rangeLabel) + '）</p>');
    P.push('<p class="meta">数据来源：下列现有端点；取不到标注「暂无数据」，未做估算或补全。</p>');
    P.push('<h2>一、数据来源与口径</h2>');
    P.push(htmlTable(['数据项', '端点', '口径与局限', '状态'], model.sources.map(function (x) {
      return [x.label, x.endpoint, x.note, statusText(x.status)];
    })));
    P.push('<blockquote>告警端点只保留最近 500 条并按 5 分钟去重合并；审计为最近 1000 条快照；历史曲线为插件环形缓冲，实际覆盖范围以「采样区间」为准。</blockquote>');
    P.push('<h2>二、资源使用趋势</h2>');
    if (s.metrics.status === 'ok' && s.metrics.data.available) {
      var d = s.metrics.data;
      P.push('<p class="meta">采样区间：' + esc(d.coverageFrom) + ' ～ ' + esc(d.coverageTo) +
        '；采样点 ' + d.points + ' 个' + (d.intervalS ? '，间隔 ' + d.intervalS + ' 秒' : '') + '。</p>');
      P.push(htmlTable(['指标', '最小', '最大', '平均', '最新', '单位'], d.rows.map(function (r) {
        return [r.label, pct(r.min), pct(r.max), pct(r.avg), pct(r.latest), r.unit];
      })));
    } else P.push('<p>暂无数据（' + esc(s.metrics.status === 'fail' ? s.metrics.error : 'monitor 插件未提供历史曲线') + '）。</p>');
    P.push('<h2>三、告警统计</h2>');
    if (s.alerts.status === 'ok' && s.alerts.data.available) {
      var a = s.alerts.data;
      P.push('<p class="meta">窗口内共 ' + a.total + ' 条（严重 ' + a.bySeverity.critical + ' / 警告 ' +
        a.bySeverity.warning + ' / 提示 ' + a.bySeverity.info + '）；全库未读 ' + a.unread + ' 条。</p>');
      P.push(htmlTable(['时间', '级别', '来源', '标题', '合并次数'], a.rows.slice(0, 40).map(function (r) {
        return [localTime(r.ts), r.severity, r.source, r.title, r.count];
      })));
    } else P.push('<p>暂无数据（' + esc(s.alerts.status === 'fail' ? s.alerts.error : '告警历史未装配或无记录') + '）。</p>');
    P.push('<h2>四、插件状态变更</h2>');
    if (s.plugins.status === 'ok' && s.plugins.data.available) {
      var p = s.plugins.data;
      P.push('<p class="meta">当前快照：已装 ' + p.snapshot.total + ' 个（运行 ' + p.snapshot.active +
        ' / 空闲 ' + p.snapshot.idle + ' / 异常 ' + p.snapshot.failed + '）。</p>');
      if (p.changes.length) {
        P.push(htmlTable(['时间', '操作者', '动作', '目标', '结果'], p.changes.slice(0, 30).map(function (r) {
          return [localTime(r.at), r.subject, r.action, r.target, r.result];
        })));
      } else P.push('<p>窗口内没有插件启停变更记录（插件端点只提供当前快照，历史变更取审计）。</p>');
    } else P.push('<p>暂无数据（' + esc(s.plugins.status === 'fail' ? s.plugins.error : '插件列表不可读') + '）。</p>');
    P.push('<h2>五、备份完成情况</h2>');
    if (s.backups.status === 'ok' && s.backups.data.available) {
      var b = s.backups.data;
      P.push('<p class="meta">窗口内作业 ' + b.total + ' 个：成功 ' + b.succeeded + ' / 失败 ' + b.failed +
        ' / 进行中 ' + b.running + '。</p>');
      P.push(htmlTable(['开始时间', '名称', '维度', '状态', '条目', '大小', '错误'], b.rows.slice(0, 30).map(function (r) {
        return [localTime(r.started), r.name, r.dimensions, r.status,
          r.entries === null ? '—' : r.entries, bytes(r.bytes), r.error];
      })));
    } else P.push('<p>暂无数据（' + esc(s.backups.status === 'fail' ? s.backups.error : 'backup 插件未提供作业记录') + '）。</p>');
    P.push('<h2>六、操作审计摘要</h2>');
    if (s.audit.status === 'ok' && s.audit.data.available) {
      var u = s.audit.data;
      P.push('<p class="meta">窗口内记录 ' + u.total + ' 条（成功 ' + u.byResult.ok + ' / 拒绝 ' +
        u.byResult.denied + ' / 失败 ' + u.byResult.error + '）。</p>');
      if (u.topActions.length) {
        P.push('<p class="meta">高频动作：' + esc(u.topActions.map(function (x) {
          return x.action + ' ×' + x.count;
        }).join('、')) + '。</p>');
      }
      P.push(htmlTable(['时间', '操作者', '动作', '目标', '结果', '详情'], u.rows.map(function (r) {
        return [localTime(r.at), r.subject, r.action, r.target, r.result, r.detail];
      })));
    } else P.push('<p>暂无数据（' + esc(s.audit.status === 'fail' ? s.audit.error : '审计无记录') + '）。</p>');
    P.push('<p class="foot">由 Kore 控制台生成 · ' + esc(m.generatedISO) + ' · 可直接用浏览器打印为 PDF 存档</p>');
    P.push('</body></html>');
    return P.join('\n');
  }

  /* ---------- 采集：5 个数据源各自独立容错，失败不拖垮整份报告 ---------- */

  function sourceNote(key) {
    var notes = {
      metrics: 'monitor.system.history（24h=720 点×120s；7d=720 点×840s）+ 窗口过滤',
      alerts: 'GET /api/v1/alerts?limit=500，仅前端按 ts 过滤（端点无 since）',
      plugins: 'GET /api/v1/plugins 当前快照 + 审计 plugin.* 动作（无历史序列）',
      backups: 'POST backup.jobs，按 started_at 过滤窗口',
      audit: 'GET /api/v1/audit?since=<ISO>&limit=1000&order=desc（上限 1000 条）'
    };
    return notes[key] || '';
  }
  function sourceEndpoint(key) {
    return { metrics: EP.monitorSystem, alerts: EP.alerts + '?limit=500', plugins: EP.plugins,
      backups: EP.backupJobs, audit: EP.audit + '?since=<ISO>&limit=1000' }[key] || '';
  }
  function errText(err) { return err && err.message ? err.message : '未知错误'; }

  function collect(gen, def, since, until) {
    var picked = S.picked;
    var tasks = {};
    var defs = {
      metrics: function () {
        return invoke(EP.monitorSystem, { per_cpu: false, thresholds: { cpu_percent: 0, memory_percent: 0, disk_percent: 0 },
          history_points: def.points, history_interval_s: def.interval }).then(function (d) {
          return { status: 'ok', data: summarizeHistory(d && d.history, since,
            { cpu: 'CPU', memory: '内存', disk: '磁盘' }) };
        }, function (err) { return { status: 'fail', error: errText(err), data: summarizeHistory(null, since, {}) }; });
      },
      alerts: function () {
        return getJSON(EP.alerts + '?limit=500').then(function (res) {
          if (!res.ok) return { status: 'fail', error: 'HTTP ' + res.status, data: summarizeAlerts(null, since, until) };
          return { status: 'ok', data: summarizeAlerts(res.data, since, until) };
        }, function (err) { return { status: 'fail', error: errText(err), data: summarizeAlerts(null, since, until) }; });
      },
      plugins: function () {
        // 插件端点只有当前快照，变更历史取审计 plugin.* 动作；这里独立读一次，
        // 不与 audit 源共用，避免「只勾插件」时拿不到变更、「两者都勾」时又要互相等待。
        var auditTask = getJSON(EP.audit + '?since=' + encodeURIComponent(new Date(since).toISOString()) +
          '&limit=1000&order=desc').then(function (res) { return res.ok ? res.data : null; }, function () { return null; });
        return Promise.all([getJSON(EP.plugins).catch(function () { return null; }), auditTask])
          .then(function (out) {
            if (!out[0] || !out[0].ok) return { status: 'fail', error: '插件列表读取失败',
              data: summarizePlugins(null, out[1], since, until) };
            return { status: 'ok', data: summarizePlugins(out[0].data, out[1], since, until) };
          });
      },
      backups: function () {
        // backup.jobs 的 limit 上限为 50（读自 backupop/jobs.go MaxJobsLimit），不猜、不越界。
        return invoke(EP.backupJobs, { limit: 50 }).then(function (d) {
          return { status: 'ok', data: summarizeBackups(d, since, until) };
        }, function (err) { return { status: 'fail', error: errText(err), data: summarizeBackups(null, since, until) }; });
      },
      audit: function () {
        return getJSON(EP.audit + '?since=' + encodeURIComponent(new Date(since).toISOString()) +
          '&limit=1000&order=desc').then(function (res) {
          if (!res.ok) return { status: 'fail', error: 'HTTP ' + res.status, data: summarizeAudit(null, since, until) };
          return { status: 'ok', data: summarizeAudit(res.data, since, until) };
        }, function (err) { return { status: 'fail', error: errText(err), data: summarizeAudit(null, since, until) }; });
      }
    };
    SOURCES.forEach(function (s) { if (picked[s.key]) tasks[s.key] = defs[s.key](); });
    var keys = Object.keys(tasks);
    if (!keys.length) return Promise.resolve(null);
    return Promise.all(keys.map(function (k) { return tasks[k]; })).then(function (out) {
      if (stale(gen)) return null;
      var sections = {}, sources = [];
      keys.forEach(function (k, i) {
        sections[k] = out[i];
        var st = statusOf(out[i].data && out[i].data.available, out[i].status === 'fail');
        sources.push({ key: k, label: (function () {
          for (var j = 0; j < SOURCES.length; j++) if (SOURCES[j].key === k) return SOURCES[j].label;
          return k;
        })(), endpoint: sourceEndpoint(k), note: sourceNote(k), status: st });
      });
      var now = new Date();
      return {
        meta: { generatedLocal: localTime(now), generatedISO: now.toISOString(),
          sinceLocal: localTime(since), untilLocal: localTime(until), rangeLabel: def.label },
        sources: sources, sections: sections
      };
    });
  }

  /* ---------- 下载（复用 audit.js 的 Blob + a.download 范式） ---------- */
  function download(text, filename, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = el('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------- 渲染 ---------- */
  var CSS = [
    '.rp-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:4px 0 12px}',
    '.rp-h2{margin:0;font-size:20px;font-weight:600}',
    '.rp-sub{font-size:12px;color:var(--kore-text-3);flex-basis:100%}',
    '.rp-toolbar{display:flex;flex-wrap:wrap;gap:10px 16px;padding:12px 16px;border:1px solid var(--kore-border-2);border-radius:6px;background:var(--kore-bg-1)}',
    '.rp-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.rp-group-title{font-size:12px;color:var(--kore-text-3)}',
    '.rp-select{min-height:44px;background:var(--kore-bg-2);color:var(--kore-text-1);border:1px solid var(--kore-border-1);border-radius:4px;padding:6px 8px;font-size:14px}',
    '.rp-check{display:inline-flex;align-items:center;gap:6px;min-height:44px;font-size:13px;cursor:pointer}',
    '.rp-check input{width:16px;height:16px;accent-color:var(--kore-info);cursor:pointer}',
    '.rp-btn{min-height:44px;padding:0 16px;border:1px solid var(--kore-info);border-radius:4px;background:var(--kore-info);color:#fff;font-size:14px;cursor:pointer}',
    '.rp-btn:disabled{opacity:.55;cursor:not-allowed}',
    '.rp-btn-ghost{background:transparent;color:var(--kore-info)}',
    '.rp-msg{padding:8px 16px;font-size:12px;color:var(--kore-text-3);min-height:20px}',
    '.rp-msg.rp-err{color:var(--kore-danger)}',
    '.rp-preview{margin-top:14px;border:1px solid var(--kore-border-2);border-radius:6px;overflow:hidden}',
    '.rp-preview-head{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--kore-bg-2);border-bottom:1px solid var(--kore-border-2)}',
    '.rp-preview-title{font-size:14px;font-weight:600;flex:1}',
    '.rp-preview-body{padding:14px 16px;font-size:13px;line-height:1.7;overflow-x:auto}',
    '.rp-preview h3{font-size:15px;margin:18px 0 6px}',
    '.rp-preview h3:first-child{margin-top:0}',
    '.rp-preview p{margin:6px 0;color:var(--kore-text-2)}',
    '.rp-preview table{width:100%;min-width:520px;border-collapse:collapse;font-size:12px;margin:8px 0}',
    '.rp-preview th,.rp-preview td{border:1px solid var(--kore-border-2);padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word}',
    '.rp-preview th{background:var(--kore-bg-2);color:var(--kore-text-2);font-weight:600;white-space:nowrap}',
    '.rp-note{color:var(--kore-text-3);font-size:12px;border-left:3px solid var(--kore-info);padding-left:10px;margin:8px 0}',
    '.rp-empty{text-align:center;padding:28px 16px;color:var(--kore-text-3);font-size:13px}',
    '@media(max-width:639px){.rp-toolbar{gap:8px}.rp-group-title{flex-basis:100%}.rp-preview-body{padding:10px 12px}}'
  ].join('\n');
  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = el('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s);
  }

  function sectionBlock(title, htmlRows, headers, note) {
    var box = el('div');
    add(box, el('h3', null, title));
    if (note) add(box, el('p', 'rp-note', note));
    if (htmlRows && htmlRows.length) {
      var table = add(box, el('table'));
      var thead = add(table, el('thead')), tr = add(thead, el('tr'));
      headers.forEach(function (h) { add(tr, el('th', null, h)); });
      var tbody = add(table, 'tbody');
      htmlRows.forEach(function (cells) {
        var r = add(tbody, el('tr'));
        cells.forEach(function (c) { add(r, el('td', null, c === null || c === undefined || c === '' ? '—' : c)); });
      });
    } else {
      add(box, el('p', null, '暂无数据'));
    }
    return box;
  }

  function previewRows(model) {
    var s = model.sections, boxes = [];
    boxes.push(sectionBlock('一、数据来源与口径',
      model.sources.map(function (x) { return [x.label, x.endpoint, x.note, statusText(x.status)]; }),
      ['数据项', '端点', '口径与局限', '状态'],
      '取不到的项目一律标注「暂无数据」或「读取失败」，不以 0 或推测值代替。'));
    var m = s.metrics;
    var mrows = (m.status === 'ok' && m.data.available) ? m.data.rows.map(function (r) {
      return [r.label, pct(r.min), pct(r.max), pct(r.avg), pct(r.latest), r.unit];
    }) : [];
    boxes.push(sectionBlock('二、资源使用趋势', mrows,
      ['指标', '最小', '最大', '平均', '最新', '单位'],
      (m.status === 'ok' && m.data.available) ?
        ('采样区间 ' + m.data.coverageFrom + ' ～ ' + m.data.coverageTo + '；' + m.data.points + ' 点' +
          (m.data.intervalS ? '，间隔 ' + m.data.intervalS + ' 秒' : '')) :
        (m.status === 'fail' ? '读取失败：' + m.error : 'monitor 插件未提供历史曲线')));
    var a = s.alerts;
    boxes.push(sectionBlock('三、告警统计',
      (a.status === 'ok' && a.data.available) ? a.data.rows.slice(0, 40).map(function (r) {
        return [localTime(r.ts), r.severity, r.source, r.title, r.count];
      }) : [],
      ['时间', '级别', '来源', '标题', '合并次数'],
      (a.status === 'ok' && a.data.available) ?
        ('窗口内 ' + a.data.total + ' 条（严重 ' + a.data.bySeverity.critical + ' / 警告 ' +
          a.data.bySeverity.warning + ' / 提示 ' + a.data.bySeverity.info + '）') :
        (a.status === 'fail' ? '读取失败：' + a.error : '告警历史未装配或无记录')));
    var p = s.plugins;
    boxes.push(sectionBlock('四、插件状态变更',
      (p.status === 'ok' && p.data.available) ? p.data.changes.slice(0, 30).map(function (r) {
        return [localTime(r.at), r.subject, r.action, r.target, r.result];
      }) : [],
      ['时间', '操作者', '动作', '目标', '结果'],
      (p.status === 'ok' && p.data.available) ?
        ('当前快照：已装 ' + p.data.snapshot.total + '（运行 ' + p.data.snapshot.active +
          ' / 异常 ' + p.data.snapshot.failed + '）；变更取审计 plugin.* 动作') :
        (p.status === 'fail' ? '读取失败：' + p.error : '插件列表不可读')));
    var b = s.backups;
    boxes.push(sectionBlock('五、备份完成情况',
      (b.status === 'ok' && b.data.available) ? b.data.rows.slice(0, 30).map(function (r) {
        return [localTime(r.started), r.name, r.dimensions, r.status,
          r.entries === null ? '—' : r.entries, bytes(r.bytes), r.error];
      }) : [],
      ['开始时间', '名称', '维度', '状态', '条目', '大小', '错误'],
      (b.status === 'ok' && b.data.available) ?
        ('窗口内 ' + b.data.total + ' 个作业：成功 ' + b.data.succeeded + ' / 失败 ' + b.data.failed) :
        (b.status === 'fail' ? '读取失败：' + b.error : 'backup 插件未提供作业记录')));
    var u = s.audit;
    boxes.push(sectionBlock('六、操作审计摘要',
      (u.status === 'ok' && u.data.available) ? u.data.rows.map(function (r) {
        return [localTime(r.at), r.subject, r.action, r.target, r.result, r.detail];
      }) : [],
      ['时间', '操作者', '动作', '目标', '结果', '详情'],
      (u.status === 'ok' && u.data.available) ?
        ('窗口内 ' + u.data.total + ' 条（成功 ' + u.data.byResult.ok + ' / 拒绝 ' + u.data.byResult.denied + '）') :
        (u.status === 'fail' ? '读取失败：' + u.error : '审计无记录')));
    return boxes;
  }

  function paint() {
    var box = S.box;
    if (!box) return;
    box.textContent = '';
    ensureCss();
    var panel = add(box, el('section', 'panel rp-panel'));
    var head = add(panel, el('div', 'rp-head'));
    add(head, el('h2', 'rp-h2', '运行报告'));
    add(head, el('span', 'rp-sub', '一键汇总资源趋势、告警、插件、备份与审计，导出可存档的运维报告。'));

    var bar = add(panel, el('div', 'rp-toolbar'));
    var rangeGroup = add(bar, el('div', 'rp-group'));
    add(rangeGroup, el('span', 'rp-group-title', '时间范围'));
    var sel = add(rangeGroup, el('select', 'rp-select'));
    sel.setAttribute('aria-label', '报告时间范围');
    RANGES.forEach(function (r) {
      var o = add(sel, el('option', null, r.label)); o.value = r.key; if (r.key === S.range) o.selected = true;
    });
    sel.addEventListener('change', function () { S.range = sel.value; });

    var srcGroup = add(bar, el('div', 'rp-group'));
    add(srcGroup, el('span', 'rp-group-title', '数据项（可多选）'));
    SOURCES.forEach(function (src) {
      var label = add(srcGroup, el('label', 'rp-check'));
      var cb = add(label, el('input'));
      cb.type = 'checkbox'; cb.checked = !!S.picked[src.key];
      cb.setAttribute('aria-label', src.label);
      cb.title = src.hint;
      add(label, el('span', null, src.label));
      cb.addEventListener('change', function () { S.picked[src.key] = cb.checked; });
    });

    var actGroup = add(bar, el('div', 'rp-group'));
    var gen = add(actGroup, el('button', 'rp-btn', S.busy ? '正在生成…' : '生成报告'));
    gen.type = 'button'; gen.disabled = S.busy; gen.style.minHeight = '44px';
    gen.addEventListener('click', function () { S.gen++; generate(S.gen); });

    var mdBtn = add(actGroup, el('button', 'rp-btn rp-btn-ghost', '下载 Markdown'));
    mdBtn.type = 'button'; mdBtn.style.minHeight = '44px'; mdBtn.disabled = !S.data || S.downloadBusy;
    mdBtn.addEventListener('click', function () { doDownload('md'); });
    var htmlBtn = add(actGroup, el('button', 'rp-btn rp-btn-ghost', '下载 HTML'));
    htmlBtn.type = 'button'; htmlBtn.style.minHeight = '44px'; htmlBtn.disabled = !S.data || S.downloadBusy;
    htmlBtn.addEventListener('click', function () { doDownload('html'); });

    if (S.msg) add(panel, el('div', S.msgErr ? 'rp-msg rp-err' : 'rp-msg', S.msg));

    var preview = add(panel, el('div', 'rp-preview'));
    var ph = add(preview, el('div', 'rp-preview-head'));
    add(ph, el('span', 'rp-preview-title', '报告预览'));
    if (S.data) {
      add(ph, el('span', 'rp-msg', S.data.meta.generatedLocal + ' · ' + S.data.meta.rangeLabel));
    }
    var body = add(preview, 'rp-preview-body');
    if (!S.data) {
      add(body, el('div', 'rp-empty', '选择时间范围与数据项，点「生成报告」后在这里预览，再下载 Markdown 或可打印 HTML。'));
    } else {
      previewRows(S.data).forEach(function (node) { add(body, node); });
    }
  }

  function generate(gen) {
    var chosen = SOURCES.filter(function (s) { return S.picked[s.key]; }).map(function (s) { return s.key; });
    if (!chosen.length) {
      S.msg = '请至少勾选一个数据项。'; S.msgErr = true; paint(); return;
    }
    S.busy = true; S.msg = '正在汇总数据…'; S.msgErr = false; S.data = null; paint();
    var def = rangeDef();
    var until = Date.now(), since = until - def.ms;
    setTimeout(function () {
      collect(gen, def, since, until).then(function (model) {
        if (stale(gen)) return;
        S.busy = false;
        if (!model) { paint(); return; }
        S.data = model;
        var failed = model.sources.filter(function (x) { return x.status === 'fail'; }).length;
        S.msg = '报告已生成：' + model.sources.length + ' 个数据项' +
          (failed ? '（' + failed + ' 项读取失败，已如实标注）' : '') + '。可下载 Markdown 或 HTML。';
        S.msgErr = false;
        paint();
      }, function (err) {
        if (stale(gen)) return;
        S.busy = false; S.data = null;
        S.msg = '生成失败：' + errText(err) + '，请重试。'; S.msgErr = true; paint();
      });
    }, 0);
  }

  function doDownload(kind) {
    if (!S.data || S.downloadBusy) return;
    S.downloadBusy = true; paint();
    setTimeout(function () {
      var d = new Date(), stamp = fileStamp(d);
      try {
        if (kind === 'md') {
          download(buildMarkdown(S.data), 'kore-report-' + stamp + '.md', 'text/markdown;charset=utf-8');
        } else {
          download(buildHtml(S.data), 'kore-report-' + stamp + '.html', 'text/html;charset=utf-8');
        }
        S.msg = '已下载 kore-report-' + stamp + '.' + (kind === 'md' ? 'md' : 'html') + '。';
        S.msgErr = false;
      } catch (e) {
        S.msg = '下载失败：' + errText(e) + '，请重试。'; S.msgErr = true;
      }
      S.downloadBusy = false; paint();
    }, 0);
  }

  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    S.gen++; S.box = container; S.data = null; S.busy = false;
    S.msg = ''; S.msgErr = false; S.downloadBusy = false;
    SOURCES.forEach(function (s) { S.picked[s.key] = true; }); // 默认全选：预设优先（产品原则①）
    paint();
    return { destroy: function () { S.gen++; if (S.box === container) S.box = null; } };
  }

  window.KoreReport = {
    render: render,
    // 纯函数自检钩子：供 node 级验证报告生成逻辑，不参与渲染、不新增网络 API。
    _test: { summarizeHistory: summarizeHistory, summarizeAlerts: summarizeAlerts,
      summarizePlugins: summarizePlugins, summarizeBackups: summarizeBackups,
      summarizeAudit: summarizeAudit, buildMarkdown: buildMarkdown, buildHtml: buildHtml,
      RANGES: RANGES, SOURCES: SOURCES, EP: EP }
  };
})();
