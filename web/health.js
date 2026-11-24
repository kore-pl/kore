/* kore 主壳 · 系统体检视图（web/health.js）——零框架 / 零 CDN / 零外链 / 零轮询。
   这是一个主动诊断入口：点「开始体检」→ 从各只读端点现场采集 → 0-100 健康分 +
   分项清单（绿/黄/红）+ 每项一句人话「怎么办」。Kore 之前只有被动监控数字，没有一键评分。

   ===== 健康分算法（owner 自定，唯一真源）=====
   共 8 个检查项，每项 0/50/100 三档（正常/警告/异常），健康分 = 8 项得分的算术平均，
   四舍五入到整数（0-100）。分项状态：100=绿、50=黄、0=红。
   总分分档：90-100=健康（绿）、70-89=基本正常（黄）、<70=需要关注（红）。
   任何单项取数失败 = 该项记黄（50）并在「怎么办」写明取数失败原因，绝不静默当成正常。

   ===== 分项判据（全部只读，来自源码核实的现有端点）=====
   1. 内核存活   GET /-/healthz → status=='ok' 绿，否则红。
   2. 资源占用   GET /api/v1/system/metrics → cpu_pct/rss_kib/fds/goroutines：
                 cpu_pct<80 且 rss_kib<16384 且 fds<64 且 goroutines<20 → 绿；
                 任一超警戒（cpu>=90 或 rss>=16384 或 fds>=64 或 goroutines>=20）→ 红；
                 介于之间 → 黄。（红线来自 AGENTS G-03）
   3. 插件状态   GET /api/v1/plugins → 按 state 统计 failed/starting：
                 无 failed 且无 starting 卡住 → 绿；有 starting（可能冷启动中）→ 黄；
                 有 failed → 红。
   4. 插件重启   GET /api/v1/plugins → restarts 之和：0 → 绿；1-3 → 黄；>=4 → 红。
   5. 告警中心   GET /api/v1/alerts?limit=500 → severity=critical 计数：
                 0 → 绿；1-2 → 黄；>=3 → 红。
   6. 定时任务   GET /api/v1/scheduler/tasks → 取数成功即绿（合规：内核不轮询、定时器仅
                 scheduler）。真实字段：last_result ∈ {ok,failed,timeout,skipped,missed}、
                 missed_count。存在 last_result 非 ok（排除 skipped）或 missed_count>0 → 黄；
                 取数失败 → 黄。
   7. 系统信息   GET /api/v1/system/info → supervisor.resident <= resident_max 且
                 demotion 段存在 → 绿；resident>=resident_max（槽位满）→ 黄；取数失败 → 红。
   8. 内核自升级 GET /api/v1/system/upgrade → 取数成功即绿（无进行中的失败升级），
                 取数失败/401（非管理员）→ 黄（不影响审计结论，写明需管理员复核）。

   数据源优先级：全部复用现有只读端点，前端聚合，不新增需登录口令/特权的端点，不改后端。
   CSRF：GET 请求免双提交（CORE §3 中间件链）；本模块只发 GET，不写运行态。
   生命周期：仅「开始体检」按钮触发一次并发采集；无 setInterval/轮询（G-19）；唯一
   setTimeout 是 100ms resize 防抖（若需），切走时 handle.destroy() 清监听器。
   移动端：CSS 媒体查询在 640px 以下改为单列、触摸目标≥44px（裁决41）。
   视图范式参照 web/monitor.js；window.KoreHealth.render(container) → {destroy}。 */
(function () {
  'use strict';

  var ENDPOINTS = {
    healthz: '/-/healthz',
    metrics: '/api/v1/system/metrics',
    plugins: '/api/v1/plugins',
    alerts: '/api/v1/alerts?limit=500',
    scheduler: '/api/v1/scheduler/tasks',
    info: '/api/v1/system/info',
    upgrade: '/api/v1/system/upgrade'
  };
  var STYLE_ID = 'kore-health-style';
  var S = { box: null, gen: 0, running: false, lastRun: null, results: [], score: null };

  var CSS = [
    '.hlth-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}',
    '.hlth-h2{margin:0;font-size:20px;font-weight:600}',
    '.hlth-sub{font-size:12px;color:var(--kore-text-3);line-height:1.6}',
    '.hlth-head .btn{margin-left:auto;min-height:44px}',
    '.hlth-score{display:flex;align-items:center;gap:20px;padding:20px 24px;margin:16px 0;border-radius:10px;border:1px solid var(--kore-border-2);background:var(--kore-bg-1);flex-wrap:wrap}',
    '.hlth-score-num{font-size:52px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}',
    '.hlth-score-unit{font-size:16px;color:var(--kore-text-3);font-weight:400}',
    '.hlth-score-good{color:var(--kore-success)}',
    '.hlth-score-warn{color:var(--kore-warning)}',
    '.hlth-score-bad{color:var(--kore-danger)}',
    '.hlth-score-meta{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--kore-text-2)}',
    '.hlth-score-label{font-size:17px;font-weight:600;color:var(--kore-text-1)}',
    '.hlth-score-bar{flex:1;min-width:160px;height:10px;border-radius:5px;background:var(--kore-bg-0);overflow:hidden}',
    '.hlth-score-fill{height:100%;border-radius:5px;transition:width .3s ease}',
    '.hlth-list{display:flex;flex-direction:column;gap:10px;margin-top:8px}',
    '.hlth-item{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:8px;border:1px solid var(--kore-border-2);background:var(--kore-bg-1)}',
    '.hlth-dot{flex:none;width:12px;height:12px;border-radius:50%;margin-top:3px}',
    '.hlth-dot-ok{background:var(--kore-success)}',
    '.hlth-dot-warn{background:var(--kore-warning)}',
    '.hlth-dot-bad{background:var(--kore-danger)}',
    '.hlth-body{min-width:0;flex:1}',
    '.hlth-item-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
    '.hlth-item-name{font-size:14px;font-weight:600;color:var(--kore-text-1)}',
    '.hlth-item-badge{font-size:11px;padding:1px 8px;border-radius:10px;background:var(--kore-bg-0);color:var(--kore-text-3)}',
    '.hlth-item-detail{font-size:13px;color:var(--kore-text-2);margin:6px 0 0;line-height:1.6;word-break:break-word}',
    '.hlth-item-fix{font-size:13px;color:var(--kore-text-1);margin:6px 0 0;line-height:1.6}',
    '.hlth-fix-tag{color:var(--kore-info);font-weight:600;margin-right:4px}',
    '.hlth-empty{padding:28px 16px;text-align:center;color:var(--kore-text-3);font-size:13px;line-height:1.8}',
    '.hlth-ts{font-size:12px;color:var(--kore-text-3);font-variant-numeric:tabular-nums}',
    '@media (max-width:640px){',
    '.hlth-score{padding:16px;gap:12px}.hlth-score-num{font-size:44px}',
    '.hlth-score-bar{min-width:100%;order:3}',
    '.hlth-head .btn{margin-left:0;width:100%}',
    '.hlth-item{padding:12px}',
    '}'
  ].join('\n');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function button(label) { return el('button', 'btn btn-primary', label); } // G-33 A5：空状态按钮入口
  function stale(gen) { return gen !== S.gen || !S.box; }

  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.text().then(function (raw) {
          var data = null;
          if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
          if (!res.ok) {
            var msg = (data && (data.message || data.code)) || ('HTTP ' + res.status);
            var err = new Error(msg); err.status = res.status; throw err;
          }
          return data;
        });
      });
  }

  // 三档得分 → 状态文案/类名。每项返回 {score, detail, fix}。
  function result(score, detail, fix) { return { score: score, detail: detail, fix: fix }; }

  function checkHealthz(data) {
    if (data && data.status === 'ok') return result(100, '内核进程存活，健康检查返回 ok。', '无需处理。');
    return result(0, '健康检查未返回 ok，内核可能不可用。', '检查 kored 是否运行：systemctl status kore，必要时重启服务。');
  }
  function checkMetrics(data) {
    if (!data) return result(50, '资源采样端点未返回数据（Tier B 平台可能不支持）。', '确认平台是否支持资源采样；Tier B 降级属正常，可忽略。');
    var cpu = typeof data.cpu_pct === 'number' ? data.cpu_pct : 0;
    var rss = typeof data.rss_kib === 'number' ? data.rss_kib : 0;
    var fds = typeof data.fds === 'number' ? data.fds : 0;
    var gor = typeof data.goroutines === 'number' ? data.goroutines : 0;
    var detail = 'CPU ' + cpu.toFixed(1) + '% · 内存 ' + rss + ' KiB · fd ' + fds + ' · goroutine ' + gor + '。';
    if (cpu >= 90 || rss >= 16384 || fds >= 64 || gor >= 20)
      return result(0, detail + ' 某项已达资源红线。', '资源占用触顶：到「监控」页查看是什么占满，按 AGENTS G-03 红线（主壳 RSS≤16MiB / fd≤64 / goroutine≤20）排查。');
    if (cpu >= 80 || rss >= 12288 || fds >= 48 || gor >= 16)
      return result(50, detail + ' 接近警戒线。', '资源接近警戒，建议到「监控」页观察趋势，暂不必处理。');
    return result(100, detail + ' 资源占用健康。', '无需处理。');
  }
  function checkPlugins(data) {
    if (!data || !Array.isArray(data.plugins)) return result(50, '插件列表取数失败。', '刷新页面重试；仍失败到「软件商店 → 插件管理」查看。');
    var failed = [], starting = [];
    data.plugins.forEach(function (p) {
      if (p.state === 'failed') failed.push(p.id);
      else if (p.state === 'starting') starting.push(p.id);
    });
    if (failed.length)
      return result(0, '异常插件：' + failed.join('、') + '。', '这些插件处于 failed：到「软件商店 → 插件管理」重启或卸载它们，必要时看插件日志。');
    if (starting.length)
      return result(50, '启动中插件：' + starting.join('、') + '。', '这些插件正在冷启动，稍后刷新体检即可；若长期卡住到插件管理重启。');
    return result(100, '已装插件状态均正常（无 failed / 卡住的 starting）。', '无需处理。');
  }
  function checkRestarts(data) {
    if (!data || !Array.isArray(data.plugins)) return result(50, '插件列表取数失败，无法统计重启次数。', '刷新页面重试。');
    var total = 0;
    data.plugins.forEach(function (p) { total += (typeof p.restarts === 'number' ? p.restarts : 0); });
    if (total >= 4) return result(0, '插件累计重启 ' + total + ' 次，存在反复崩溃。', '重启次数偏高：到「监控 → 日志」查插件为何反复重启，必要时卸载重装。');
    if (total >= 1) return result(50, '插件累计重启 ' + total + ' 次。', '少量重启可能是升级导致，观察即可；持续增长再到日志排查。');
    return result(100, '插件累计重启 0 次。', '无需处理。');
  }
  function checkAlerts(data) {
    if (!data || !Array.isArray(data.alerts)) return result(50, '告警列表取数失败。', '刷新页面重试；需要 system:read 权限。');
    var crit = data.alerts.filter(function (a) { return a.severity === 'critical'; });
    if (crit.length >= 3) return result(0, '有 ' + crit.length + ' 条严重告警。', '到「监控 → 告警中心」逐条处理 critical 告警，处理完再体检。');
    if (crit.length >= 1) return result(50, '有 ' + crit.length + ' 条严重告警。', '到「监控 → 告警中心」查看这 ' + crit.length + ' 条告警，确认是否需要处理。');
    return result(100, '无严重告警。', '无需处理。');
  }
  function checkScheduler(data) {
    if (!data) return result(50, '定时任务列表取数失败。', '刷新页面重试；此端点需要管理员权限，普通用户可忽略本项。');
    var tasks = Array.isArray(data.tasks) ? data.tasks : [];
    // 真实字段（scheduler.Task）：last_result ∈ ok/failed/timeout/skipped/missed，missed_count。
    var bad = tasks.filter(function (t) {
      var r = t.last_result;
      return (r && r !== 'ok' && r !== 'skipped') || (typeof t.missed_count === 'number' && t.missed_count > 0);
    });
    if (bad.length)
      return result(50, '有 ' + bad.length + ' 个定时任务最近执行异常（共 ' + tasks.length + ' 个）。', '到「计划任务」查看这些任务的最近结果并修正；内核定时器合规（仅 scheduler 单 ticker）。');
    return result(100, '定时任务端点正常（共 ' + tasks.length + ' 个任务，最近执行均正常，定时器合规）。', '无需处理。');
  }
  function checkInfo(data) {
    if (!data || !data.supervisor) return result(0, '系统信息取数失败，无法判断常驻槽位与降权状态。', '刷新页面重试；仍失败检查 kored 状态。');
    var sup = data.supervisor;
    var resident = typeof sup.resident === 'number' ? sup.resident : 0;
    var max = typeof sup.resident_max === 'number' ? sup.resident_max : 2;
    var detail = '常驻插件 ' + resident + '/' + max + '。';
    if (resident >= max) return result(50, detail + ' 常驻槽位已满。', '常驻插件已达上限，新的常驻插件将以按需方式启动；如需常驻到「插件管理」停用不用的插件。');
    return result(100, detail + ' 槽位充足。' + (data.demotion && data.demotion.enabled === false ? ' 插件降权未生效（内核非 root，属合法降级）。' : ''), '无需处理。');
  }
  function checkUpgrade(data) {
    if (data === null || data === undefined) return result(50, '自升级状态取数失败（可能无管理员权限）。', '此项需管理员复核；普通用户可忽略，不影响其它结论。');
    return result(100, '内核自升级状态可读，无阻塞。', '无需处理。');
  }

  var CHECKS = [
    { id: 'healthz', name: '内核存活', url: ENDPOINTS.healthz, check: checkHealthz },
    { id: 'metrics', name: '资源占用', url: ENDPOINTS.metrics, check: checkMetrics },
    { id: 'plugins', name: '插件状态', url: ENDPOINTS.plugins, check: checkPlugins },
    { id: 'restarts', name: '插件重启', url: ENDPOINTS.plugins, check: checkRestarts },
    { id: 'alerts', name: '告警中心', url: ENDPOINTS.alerts, check: checkAlerts },
    { id: 'scheduler', name: '定时任务合规', url: ENDPOINTS.scheduler, check: checkScheduler },
    { id: 'info', name: '系统信息与槽位', url: ENDPOINTS.info, check: checkInfo },
    { id: 'upgrade', name: '内核自升级', url: ENDPOINTS.upgrade, check: checkUpgrade }
  ];

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style'); s.id = STYLE_ID;
    s.textContent = CSS; document.head.appendChild(s);
  }

  function renderScore(gen, score, results) {
    var total = Math.round(results.reduce(function (a, r) { return a + r.score; }, 0) / results.length);
    var tone = total >= 90 ? 'good' : (total >= 70 ? 'warn' : 'bad');
    var label = total >= 90 ? '健康' : (total >= 70 ? '基本正常' : '需要关注');
    var card = el('div', 'hlth-score');
    var num = el('div', 'hlth-score-num hlth-score-' + tone, String(total));
    add(num, el('span', 'hlth-score-unit', ' / 100'));
    add(card, num);
    var meta = el('div', 'hlth-score-meta');
    add(meta, el('span', 'hlth-score-label hlth-score-' + tone, label));
    add(meta, el('span', 'hlth-sub', '共 8 项检查：' +
      results.filter(function (r) { return r.score === 100; }).length + ' 项正常 · ' +
      results.filter(function (r) { return r.score === 50; }).length + ' 项警告 · ' +
      results.filter(function (r) { return r.score === 0; }).length + ' 项异常'));
    add(card, meta);
    var bar = el('div', 'hlth-score-bar');
    var fill = el('div', 'hlth-score-fill hlth-score-' + tone);
    fill.style.width = total + '%'; add(bar, fill); add(card, bar);
    return card;
  }

  function renderList(results) {
    var list = el('div', 'hlth-list');
    CHECKS.forEach(function (c, i) {
      var r = results[i];
      var tone = r.score === 100 ? 'ok' : (r.score === 50 ? 'warn' : 'bad');
      var item = el('div', 'hlth-item');
      add(item, el('span', 'hlth-dot hlth-dot-' + tone));
      var body = el('div', 'hlth-body');
      var top = el('div', 'hlth-item-top');
      add(top, el('span', 'hlth-item-name', c.name));
      add(top, el('span', 'hlth-item-badge', tone === 'ok' ? '正常' : (tone === 'warn' ? '警告' : '异常')));
      add(body, top);
      add(body, el('p', 'hlth-item-detail', r.detail));
      var fix = el('p', 'hlth-item-fix');
      add(fix, el('span', 'hlth-fix-tag', '怎么办：'));
      fix.appendChild(document.createTextNode(r.fix));
      add(body, fix);
      add(item, body);
      add(list, item);
    });
    return list;
  }

  function paintResults(gen, results) {
    if (stale(gen)) return;
    var box = S.box; box.textContent = '';
    add(box, el('div', 'hlth-sub', '体检完成于 ' + new Date().toLocaleString() + '（数据现场采集，不改动任何设置）'));
    add(box, renderScore(gen, null, results));
    add(box, renderList(results));
  }

  function run(gen) {
    if (S.running) return;
    S.running = true;
    var box = S.box;
    if (stale(gen)) return;
    box.textContent = '';
    add(box, el('div', 'hlth-sub', '正在采集 8 项只读指标，请稍候…'));
    var fetches = CHECKS.map(function (c) {
      return getJSON(c.url).then(
        function (data) { return c.check(data); },
        function (err) {
          // 取数失败：记黄，写明原因，绝不静默当正常。
          return result(50, '取数失败：' + (err && err.message ? err.message : err),
            '刷新页面重试；若持续失败检查网络或登录状态。' + (c.id === 'upgrade' ? '（此项需管理员权限，普通用户可忽略）' : ''));
        }
      );
    });
    Promise.all(fetches).then(function (results) {
      S.running = false;
      if (stale(gen)) return;
      S.results = results;
      S.lastRun = new Date().toISOString();
      paintResults(gen, results);
    });
  }

  function render(container) {
    S.gen++; var gen = S.gen;
    S.box = container; S.running = false; S.results = [];
    ensureStyle();
    var head = el('div', 'hlth-head');
    add(head, el('h2', 'hlth-h2', '系统体检'));
    var btn = button('开始体检');
    btn.type = 'button';
    btn.addEventListener('click', function () { run(gen); });
    add(head, btn);
    add(container, head);
    add(container, el('p', 'hlth-sub',
      '一键从各只读数据源采集资源占用、插件状态、告警、定时任务与系统信息等指标，给出健康分和每项「怎么办」。' +
      '只读取、不改动任何设置；点「开始体检」即刻采集。'));
    var empty = el('div', 'hlth-empty empty-state', '还没有体检结果。点下面的按钮生成一份系统健康报告。');
    add(container, empty);
    var emptyBtn = button('开始体检');
    emptyBtn.type = 'button';
    emptyBtn.addEventListener('click', function () { run(gen); });
    add(empty, emptyBtn);
    return {
      destroy: function () {
        S.gen++; S.box = null; S.running = false;
      }
    };
  }

  window.KoreHealth = { render: render };
})();
