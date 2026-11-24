/* kore 主壳 · 运维日历（web/calendar.js）——零框架 / 零 CDN / 无外链 / 不进首屏。
   目标：把散落在 cron 插件、内核 scheduler、backup.schedule、ssl 续期的定时任务
   聚合成一张「全局任务时间线」月视图，回答「下周有什么会自动跑」。

   数据源（全部现有端点，不改后端）：
     · GET  /api/v1/scheduler/tasks         内核 ADR-0019 —— 权威聚合点：
           cron 插件的 plugin 型任务 / backup.create+retention / builtin-cert-renew /
           builtin-audit-clean 全在这里，字段含 next_run_at / last_run_at / last_result。
     · POST /api/v1/invoke/cron/cron.list   crontab 的 shell/http 型任务（不写 scheduler），
           只有 5 段 cron 表达式，内核不提供下次/上次时间——详情里照实标「未知」，
           日历标记只按 cron 的日/周/月字段推算「哪天会跑」，不编造时分。

   纪律：懒加载脚本（由 app.js 的 SHELL_VIEWS 注册，用户切到本视图才注入）；不轮询（G-19）；
   下次/上次取不到标「未知」不编造；来源标注可点跳转对应页；手机窄屏可用；
   G-28 双端截图由后置专项卡统一做，本模块只交付功能与可验证证据。

   对外：window.KoreCalendar = { render(container), destroy() } */
(function () {
  'use strict';

  var SCHED_API = '/api/v1/scheduler/tasks';
  var CRON_API = '/api/v1/invoke/cron/';
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  var RESULT_TEXT = {
    ok: '成功', failed: '失败', timeout: '超时',
    skipped: '跳过（上次未完成）', missed: '错过（停机未补跑）'
  };

  // 会话状态：单实例；切走视图由 destroy() 清监听，不残留。
  var S = { root: null, year: 0, month: 0, tasks: [], groups: {}, byId: {},
    loading: false, loaded: false, error: '', sourceNotes: [], detail: null,
    clickHandler: null, navHandler: null, destroyed: false };

  /* ---------- 小工具 ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function readResponse(res) {
    return res.text().then(function (raw) {
      var data = {};
      if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
      if (!res.ok) {
        var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        err.code = data.code || '';
        throw err;
      }
      return data;
    });
  }
  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json' } }).then(readResponse);
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(CRON_API + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(readResponse);
  }
  function fmtLocal(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dateKey(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function keyFromISO(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return dateKey(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /* ---------- cron 表达式：只判断「某天是否会跑」，不产生精确时分 ---------- */
  function fieldHas(field, value) {
    if (!field || field === '*') return true;
    var groups = String(field).split(',');
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i], step = 1, base = g, slash = g.indexOf('/');
      if (slash >= 0) { base = g.slice(0, slash); step = parseInt(g.slice(slash + 1), 10) || 1; }
      if (base === '*') {
        if ((value % step) === 0) return true;
      } else if (base.indexOf('-') >= 0) {
        var ab = base.split('-'), lo = parseInt(ab[0], 10), hi = parseInt(ab[1], 10);
        if (value >= lo && value <= hi && ((value - lo) % step) === 0) return true;
      } else {
        var one = parseInt(base, 10);
        if (!isNaN(one) && value === one) return true;
      }
    }
    return false;
  }
  // 标准 cron：日(month-day) 与 周(day-of-week) 都受限时取 OR；都 '*' 时每天。
  function cronRunsOn(expr, date) {
    if (!expr || typeof expr !== 'string') return false;
    var p = expr.trim().split(/\s+/);
    if (p.length !== 5) return false;
    if (!fieldHas(p[3], date.getMonth() + 1)) return false;
    var dom = p[2], dow = p[4];
    var domAny = (dom === '*'), dowAny = (dow === '*');
    var jsDow = date.getDay(); // 0=周日；cron 也用 0=周日
    if (domAny && dowAny) return true;
    if (!domAny && fieldHas(dom, date.getDate())) return true;
    if (!dowAny && fieldHas(dow, jsDow)) return true;
    return false;
  }
  function humanCron(expr) {
    var map = {
      '* * * * *': '每分钟', '0 * * * *': '每小时', '0 0 * * *': '每天 00:00',
      '0 3 * * *': '每天 03:00', '0 * * * 0': '每小时（周日）',
      '0 2 * * 0': '每周日 02:00', '0 6 1 * *': '每月 1 日 06:00',
      '0 0 1 * *': '每月 1 日 00:00'
    };
    if (map[expr]) return map[expr];
    if (!expr || expr.split(/\s+/).length !== 5) return '';
    return ''; // 看不懂就不猜，详情里原样显示表达式
  }

  /* ---------- 归一化 + 来源标注 + 跳转映射 ---------- */
  function sourceOf(t) {
    if (t.sourceType === 'crontab') return { label: '系统计划任务', kind: 'crontab' };
    if (t.plugin === 'kore') {
      if (t.method === 'cert.renew_due') return { label: '内核 · 证书续期', kind: 'kernel' };
      if (t.method === 'audit.clean') return { label: '内核 · 审计清理', kind: 'kernel' };
      return { label: '内核任务', kind: 'kernel' };
    }
    if (t.plugin === 'backup') return { label: '备份插件', kind: 'plugin' };
    if (t.plugin === 'ssl') return { label: 'SSL 插件', kind: 'plugin' };
    if (t.plugin === 'cron') return { label: '计划任务插件', kind: 'plugin' };
    return { label: t.plugin ? ('插件 · ' + t.plugin) : '未知来源', kind: 'plugin' };
  }
  function targetOf(t) {
    if (t.sourceType === 'crontab' || t.plugin === 'cron') return '#/tasks';
    if (t.plugin === 'backup') return '#/files/backup';
    if (t.plugin === 'ssl' || (t.method || '').indexOf('cert.') === 0) return '#/security/ssl';
    if (t.plugin === 'kore') return '#/settings';
    return '#/store';
  }
  function normalizeScheduler(t) {
    var raw = t || {};
    var n = {
      id: raw.id || '', name: raw.name || raw.method || raw.id || '(未命名任务)',
      plugin: raw.plugin || '', method: raw.method || '',
      schedule: raw.schedule || '', intervalS: raw.interval_s || 0,
      enabled: raw.enabled !== false,
      nextAt: raw.next_run_at || '', lastAt: raw.last_run_at || '',
      lastResult: raw.last_result || '', sourceType: 'scheduler'
    };
    n.source = sourceOf(n); n.target = targetOf(n);
    n.period = n.schedule || (n.intervalS ? ('每 ' + n.intervalS + ' 秒') : '未知');
    return n;
  }
  function normalizeCrontab(e) {
    var raw = e || {};
    var n = {
      id: 'cron-' + raw.index, name: raw.comment || raw.command || '系统计划任务',
      plugin: 'cron', method: '', schedule: raw.schedule || '', intervalS: 0,
      enabled: raw.enabled !== false,
      nextAt: '', lastAt: '', lastResult: '', sourceType: 'crontab'
    };
    n.source = sourceOf(n); n.target = targetOf(n);
    n.period = n.schedule; n.command = raw.command || ''; n.index = raw.index;
    return n;
  }
  function reindex() {
    S.groups = {}; S.byId = {};
    function place(task, key) {
      if (!key) return;
      if (!S.groups[key]) S.groups[key] = [];
      // 同一任务同日只标一次（next_at 精确格与 cron 递推格可能重合）。
      for (var i = 0; i < S.groups[key].length; i++) if (S.groups[key][i].id === task.id) return;
      S.groups[key].push(task);
    }
    S.tasks.forEach(function (t) {
      S.byId[t.id] = t;
      if (t.sourceType === 'scheduler') {
        // 下次执行日总是精确落格（来自内核权威字段）。
        place(t, keyFromISO(t.nextAt));
        // 重复任务按 cron 在「当前显示月」递推标日——这才是「未来时间线」。
        // 无 cron 的 interval 任务只标 next_at 那一格（内核不提供历史序列，不臆造）。
        if (t.schedule && t.schedule.split(/\s+/).length === 5) {
          var daysC = new Date(S.year, S.month + 1, 0).getDate();
          for (var c = 1; c <= daysC; c++) {
            if (cronRunsOn(t.schedule, new Date(S.year, S.month, c))) {
              place(t, dateKey(S.year, S.month, c));
            }
          }
        }
      } else if (t.sourceType === 'crontab') {
        // crontab 无 next/last 字段：只在当前月按 cron 日/周/月字段标日期，不编造时分。
        var days = new Date(S.year, S.month + 1, 0).getDate();
        for (var d = 1; d <= days; d++) {
          if (cronRunsOn(t.schedule, new Date(S.year, S.month, d))) {
            place(t, dateKey(S.year, S.month, d));
          }
        }
      }
    });
  }

  /* ---------- 数据加载：两源独立成败，一个失败不影响另一个 ---------- */
  function load() {
    if (S.loading) return Promise.resolve();
    S.loading = true; S.error = ''; S.sourceNotes = [];
    var sched = getJSON(SCHED_API).then(function (data) {
      var list = (data && data.tasks) || [];
      list.forEach(function (t) { S.tasks.push(normalizeScheduler(t)); });
      S.sourceNotes.push('内核调度任务 ' + list.length + ' 条');
    }).catch(function (err) {
      S.sourceNotes.push('内核调度任务读取失败：' + (err && err.message ? err.message : '未知'));
    });
    var cron = invoke('cron.list', {}).then(function (data) {
      var list = (data && data.tasks) || (data && data.entries) || [];
      list.forEach(function (e) { S.tasks.push(normalizeCrontab(e)); });
      S.sourceNotes.push('系统计划任务 ' + list.length + ' 条');
    }).catch(function () {
      // 插件未装 / 无 crontab 权限：不报错给用户，空态自然会说明。
      S.sourceNotes.push('系统计划任务不可用（插件未装或无权读取）');
    });
    return Promise.all([sched, cron]).then(function () {
      S.loading = false; S.loaded = true;
      reindex(); paint();
    });
  }

  /* ---------- 月视图渲染 ---------- */
  function monthLabel() { return S.year + ' 年 ' + (S.month + 1) + ' 月'; }
  function shiftMonth(delta) {
    var d = new Date(S.year, S.month + delta, 1);
    S.year = d.getFullYear(); S.month = d.getMonth();
    reindex(); paint();
  }
  function goToday() {
    var now = new Date();
    S.year = now.getFullYear(); S.month = now.getMonth();
    reindex(); paint();
  }
  function chipFor(task) {
    var chip = el('button', 'kcal-chip kcal-chip-' + task.source.kind, task.name);
    chip.type = 'button';
    chip.title = task.source.label + ' · ' + (task.period || '周期未知');
    chip.setAttribute('data-task', task.id);
    return chip;
  }
  function paint() {
    if (!S.root || S.destroyed) return;
    S.root.textContent = '';
    var head = add(S.root, el('div', 'kcal-head'));
    var titleBox = add(head, el('div', 'kcal-title-box'));
    add(titleBox, el('h2', 'kcal-title', '运维日历'));
    add(titleBox, el('p', 'kcal-sub', '所有会自动跑的任务，一张图看完 · 点任务看详情与跳转'));
    var nav = add(head, el('div', 'kcal-nav'));
    var prev = add(nav, el('button', 'btn btn-ghost', '‹ 上月')); prev.type = 'button';
    var today = add(nav, el('button', 'btn btn-ghost', '今天')); today.type = 'button';
    var next = add(nav, el('button', 'btn btn-ghost', '下月 ›')); next.type = 'button';
    add(nav, el('span', 'kcal-month', monthLabel()));
    prev.setAttribute('data-nav', 'prev'); today.setAttribute('data-nav', 'today'); next.setAttribute('data-nav', 'next');

    var legend = add(S.root, el('div', 'kcal-legend'));
    [['kernel', '内核任务'], ['plugin', '插件任务'], ['crontab', '系统计划任务']].forEach(function (pair) {
      var item = add(legend, el('span', 'kcal-legend-item'));
      add(item, el('i', 'kcal-dot kcal-dot-' + pair[0]));
      add(item, el('span', null, pair[1]));
    });

    if (S.loading) { add(S.root, el('p', 'kcal-hint', '正在读取任务…')); return; }

    var total = S.tasks.length;
    if (!total) {
      var empty = add(S.root, el('div', 'panel-empty empty-state kcal-empty'));
      add(empty, el('p', 'empty-state-text',
        '还没有任何定时任务。创建后，它们会自动出现在这张日历上。'));
      var btn = add(empty, el('button', 'btn kcal-empty-btn', '去创建计划任务'));
      btn.type = 'button'; btn.setAttribute('data-nav', 'tasks');
      var noteBox = add(empty, el('p', 'kcal-source-note', S.sourceNotes.join('；')));
      noteBox.title = '数据源读取情况';
      return;
    }

    var grid = add(S.root, el('div', 'kcal-grid'));
    WEEK.forEach(function (w) { add(grid, el('div', 'kcal-week', w)); });
    var firstDow = new Date(S.year, S.month, 1).getDay();
    var days = new Date(S.year, S.month + 1, 0).getDate();
    var todayKey = dateKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    function cell(day) {
      var c = add(grid, el('div', 'kcal-cell'));
      if (!day) { c.className = 'kcal-cell kcal-cell-out'; return c; }
      var key = dateKey(S.year, S.month, day);
      if (key === todayKey) c.className = 'kcal-cell kcal-cell-today';
      add(c, el('span', 'kcal-daynum', String(day)));
      var list = S.groups[key] || [];
      list.forEach(function (t) { add(c, chipFor(t)); });
      return c;
    }
    for (var b = 0; b < firstDow; b++) cell(0);
    for (var d = 1; d <= days; d++) cell(d);
    var tail = (7 - ((firstDow + days) % 7)) % 7;
    for (var e = 0; e < tail; e++) cell(0);

    var foot = add(S.root, el('p', 'kcal-foot',
      '共 ' + total + ' 条任务 · ' + S.sourceNotes.join('；') +
      ' · 下次执行/上次结果取自内核，取不到标「未知」'));
    foot.title = '只聚合现有端点，不新增后端';

    if (S.detail) paintDetail();
  }

  function closeDetail() { S.detail = null; var old = document.getElementById('kore-calendar-detail'); if (old) old.remove(); }
  function paintDetail() {
    var old = document.getElementById('kore-calendar-detail'); if (old) old.remove();
    var t = S.byId[S.detail]; if (!t) return;
    var mask = el('div', 'kcal-mask'); mask.id = 'kore-calendar-detail';
    var box = add(mask, el('div', 'kcal-dialog'));
    add(box, el('h3', 'kcal-dialog-title', t.name));
    function row(label, value) {
      var r = add(box, el('div', 'kcal-row'));
      add(r, el('span', 'kcal-row-k', label));
      add(r, el('span', 'kcal-row-v', value));
    }
    row('任务来源', t.source.label + (t.plugin ? '（' + t.plugin + (t.method ? ' / ' + t.method : '') + '）' : ''));
    row('重复周期', humanCron(t.schedule) || t.period || '未知');
    row('下次执行', fmtLocal(t.nextAt) || '未知' +
      (t.sourceType === 'crontab' ? '（系统 crontab 调度，内核不提供精确时间）' : ''));
    var res = t.lastResult ? (RESULT_TEXT[t.lastResult] || t.lastResult) : '未知';
    row('上次结果', res + (t.lastAt ? ' · ' + fmtLocal(t.lastAt) : ''));
    row('当前状态', t.enabled ? '已启用' : '已停用');
    if (t.command) row('执行命令', t.command);
    var actions = add(box, el('div', 'kcal-dialog-actions'));
    var go = add(actions, el('button', 'btn', '去对应页面'));
    go.type = 'button'; go.setAttribute('data-nav', 'goto'); go.setAttribute('data-target', t.target);
    var close = add(actions, el('button', 'btn btn-ghost', '关闭'));
    close.type = 'button'; close.setAttribute('data-nav', 'close');
    document.body.appendChild(mask);
  }

  function onClick(e) {
    var nav = e.target && e.target.getAttribute ? e.target.getAttribute('data-nav') : '';
    if (nav) {
      if (nav === 'prev') return shiftMonth(-1);
      if (nav === 'next') return shiftMonth(1);
      if (nav === 'today') return goToday();
      if (nav === 'tasks') return navigate('#/tasks');
      if (nav === 'close') return closeDetail();
      if (nav === 'goto') {
        var target = e.target.getAttribute('data-target');
        closeDetail(); return navigate(target);
      }
    }
    var id = e.target && e.target.getAttribute ? e.target.getAttribute('data-task') : '';
    if (id) { S.detail = id; paintDetail(); }
  }
  function navigate(hash) {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      window.KoreShell.navigate(hash);
    } else if (window.location) {
      window.location.hash = hash;
    }
  }

  /* ---------- CSS：内联注入，不额外发请求、不进首屏 ---------- */
  var CSS = '#kore-calendar{--kcal-line:var(--kore-border-1,#e3e8ef)}' +
    '.kcal-head{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin-bottom:12px}' +
    '.kcal-title{margin:0;font-size:20px;font-weight:650;color:var(--kore-text-1,#1f2937)}' +
    '.kcal-sub{margin:4px 0 0;font-size:13px;color:var(--kore-text-2,#6b7280)}' +
    '.kcal-nav{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
    '.kcal-month{min-width:110px;text-align:center;font-weight:600;color:var(--kore-text-1,#1f2937)}' +
    '.kcal-legend{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:12px;font-size:12px;color:var(--kore-text-2,#6b7280)}' +
    '.kcal-legend-item{display:inline-flex;align-items:center;gap:6px}' +
    '.kcal-dot{width:9px;height:9px;border-radius:50%;display:inline-block}' +
    '.kcal-dot-kernel{background:#7c3aed}.kcal-dot-plugin{background:#2563eb}.kcal-dot-crontab{background:#0891b2}' +
    '.kcal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;' +
    'background:var(--kcal-line);border:1px solid var(--kcal-line);border-radius:8px;overflow:hidden}' +
    '.kcal-week{padding:8px 4px;text-align:center;font-size:12px;font-weight:600;' +
    'background:var(--kore-surface-2,#f8fafc);color:var(--kore-text-2,#6b7280)}' +
    '.kcal-cell{min-height:96px;padding:6px;background:var(--kore-surface-1,#fff);display:flex;' +
    'flex-direction:column;gap:4px;min-width:0}' +
    '.kcal-cell-out{background:var(--kore-surface-2,#f8fafc);opacity:.5}' +
    '.kcal-cell-today{outline:2px solid var(--kore-primary,#2563eb);outline-offset:-2px}' +
    '.kcal-daynum{font-size:12px;color:var(--kore-text-2,#6b7280);font-weight:600}' +
    '.kcal-chip{display:block;width:100%;min-height:24px;padding:3px 5px;border:0;border-radius:4px;' +
    'font:inherit;font-size:11px;line-height:1.2;text-align:left;cursor:pointer;overflow:hidden;' +
    'text-overflow:ellipsis;white-space:nowrap;color:#fff}' +
    '.kcal-chip-kernel{background:#7c3aed}.kcal-chip-plugin{background:#2563eb}.kcal-chip-crontab{background:#0891b2}' +
    '.kcal-chip:hover{filter:brightness(1.12)}' +
    '.kcal-hint,.kcal-foot{font-size:12px;color:var(--kore-text-2,#6b7280)}' +
    '.kcal-foot{margin-top:10px}' +
    '.kcal-empty{padding:32px 16px;text-align:center}' +
    '.kcal-empty-btn{min-height:44px;margin-top:10px}' +
    '.kcal-source-note{font-size:11px;color:var(--kore-text-2,#9ca3af);margin-top:12px;word-break:break-all}' +
    '.kcal-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;' +
    'padding:16px;background:rgba(15,23,42,.5)}' +
    '.kcal-dialog{width:100%;max-width:440px;max-height:86vh;overflow:auto;padding:20px;border-radius:12px;' +
    'background:var(--kore-surface-1,#fff);box-shadow:0 18px 48px rgba(0,0,0,.25)}' +
    '.kcal-dialog-title{margin:0 0 14px;font-size:17px;color:var(--kore-text-1,#1f2937)}' +
    '.kcal-row{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--kcal-line);font-size:13px}' +
    '.kcal-row-k{flex:0 0 76px;color:var(--kore-text-2,#6b7280)}' +
    '.kcal-row-v{flex:1;min-width:0;word-break:break-word;color:var(--kore-text-1,#1f2937)}' +
    '.kcal-dialog-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}' +
    '.kcal-dialog-actions .btn{min-height:44px}' +
    '@media (max-width:639px){' +
    '.kcal-head{align-items:stretch}.kcal-nav{justify-content:space-between}' +
    '.kcal-nav .btn{min-height:44px;flex:1}' +
    '.kcal-grid{gap:1px}.kcal-cell{min-height:76px;padding:4px}' +
    '.kcal-chip{font-size:10px;min-height:22px;padding:2px 3px}' +
    '.kcal-row{flex-direction:column;gap:2px}.kcal-row-k{flex:auto}' +
    '}';
  function injectCss() {
    if (document.getElementById('kore-calendar-css')) return;
    var s = el('style'); s.id = 'kore-calendar-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ---------- 生命周期 ---------- */
  function render(container) {
    if (!container) return;
    destroy();
    S.destroyed = false;
    var now = new Date();
    S.year = now.getFullYear(); S.month = now.getMonth();
    S.tasks = []; S.groups = {}; S.byId = {}; S.detail = null;
    S.loading = true; S.loaded = false;
    S.root = el('div', 'kore-calendar'); S.root.id = 'kore-calendar';
    container.appendChild(S.root);
    injectCss();
    S.clickHandler = onClick;
    S.root.addEventListener('click', S.clickHandler);
    paint();
    load();
  }
  function destroy() {
    S.destroyed = true;
    closeDetail();
    if (S.root && S.clickHandler) { try { S.root.removeEventListener('click', S.clickHandler); } catch (e) {} }
    if (S.root && S.root.parentNode) { try { S.root.parentNode.removeChild(S.root); } catch (e) {} }
    S.root = null; S.clickHandler = null; S.tasks = []; S.groups = {}; S.byId = {};
  }

  window.KoreCalendar = { render: render, destroy: destroy };
})();
