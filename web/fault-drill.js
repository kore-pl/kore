/* kore 主壳 · 故障演练（web/fault-drill.js，懒加载，纯增量）
   产品定位：让用户主动演练"系统会怎么应对故障"——这是开发期 go test 故障测试
   之外的用户可主动触发产品能力。scenario 定义完整，但本视图**只读、不改系统状态**：
     · 读 GET /api/v1/plugins 拿插件真实状态（id / state / pid / depth_level / enabled）；
     · 执行动作走 dry-run（观察 + 报告），不真正 kill、不注入超时、不写满磁盘；
     · 真实受控 kill 需后端端点（supervisor 暴露受控重启 + 装配层注入），标注为
       "待后端端点 + 真机验证"，本视图不硬做危险操作（task 安全红线 + 10 分钟窗口退路）。
   安全红线（刻进代码，不可绕）：
     ① 只允许非核心插件白名单；核心 / 用户当前在用的插件一律禁用并给人话原因；
     ② 执行前强确认（列目标插件 + 影响 + "supervisor 会自动重启"说明 + 输入插件名解锁）；
     ③ 绝不 kill 主壳 / 系统进程 / 改系统状态——本视图所有写操作仅落本地报告。
   纪律：零框架 / 零 CDN / 无外链；CSS 内联注入唯一 id；destroy 清自己的监听与定时器；
   不轮询（G-19）；报告走 localStorage 显式 schema（键 kore:faultdrill:v1），不动共享后端。
   对外 window.KoreFaultDrill = { render(container) → {destroy}, mount }。 */
(function () {
  'use strict';

  var EP = { plugins: '/api/v1/plugins' };
  var REPORT_KEY = 'kore:faultdrill:v1';
  var REPORT_MAX = 50;
  var STYLE_ID = 'kore-fault-drill-style';
  var TIMEOUT_MS = 5000;
  // 观察窗口：dry-run 下模拟"插件是否在 N 秒内恢复"的观测时长（不阻塞、不轮询后端）。
  var OBSERVE_SEC = 10;

  // 场景显式 schema（G-24）：每项 = id / 会做什么 / 预期行为 / 风险级别 / 是否可逆。
  var SCENARIOS = [
    { id: 'kill_plugin', name: '结束一个非核心插件进程',
      does: '向选中的非核心插件进程发出结束信号，观察主壳与插件的降级/自愈。',
      expect: 'supervisor 应在数秒内自动重启该插件；主壳保持可操作、其它插件不受影响。',
      risk: '中', reversible: true,
      needBackend: '真实结束进程需后端受控端点（supervisor 受控重启）；本页当前为只读观察演练。' },
    { id: 'api_timeout', name: '模拟某个 API 超时',
      does: '模拟某插件方法调用超时，观察主壳请求是否超时降级、是否有明确错误提示。',
      expect: '主壳应在超时后给出人话错误、不卡死界面、不影响其它请求。',
      risk: '低', reversible: true,
      needBackend: '真实超时注入需后端受控端点；本页当前为只读观察演练。' },
    { id: 'disk_full', name: '模拟磁盘写满',
      does: '模拟插件写入目录空间耗尽，观察是否有明确失败提示、是否误写系统状态。',
      expect: '写入应失败并给可操作提示，不应破坏配置或留下半写文件。',
      risk: '高', reversible: true,
      needBackend: '真实写满模拟需隔离临时目录；本页当前绝不触碰磁盘，为只读观察演练。' }
  ];

  // 核心插件硬屏蔽清单：这些是内核关键能力或用户高频在用的能力，绝不作为演练目标。
  // 命中即禁用 + 人话原因（G-33 A4：不暴露 capability / lifecycle 等内部术语）。
  var CORE_PLUGINS = {
    site: '网站服务正在承载站点，演练会导致网站中断。',
    ssl: '证书服务负责全站加密，演练会影响 HTTPS 访问。',
    firewall: '防火墙是安全边界，演练会短暂失去防护。',
    waf: 'Web 防护是安全边界，演练会短暂失去防护。',
    process: '进程管理是排障入口，演练会让您失去观察手段。',
    terminal: '终端是运维入口，演练会中断正在进行的操作。',
    container: '容器服务承载运行中应用，演练会导致应用中断。',
    'db-mysql': '数据库承载业务数据，演练可能影响读写。',
    'db-postgres': '数据库承载业务数据，演练可能影响读写。',
    redis: '缓存/数据库承载业务数据，演练可能影响读写。',
    backup: '备份服务负责数据安全，演练会影响恢复能力。',
    cron: '定时任务负责自动运维，演练可能错过计划任务。',
    'app-deploy': '部署服务承载着手的发布流程，演练会中断部署。',
    monitor: '监控服务是观察系统状态的眼睛，演练会致盲。',
    logs: '日志服务是排障依据，演练会丢失现场。'
  };
  // 非核心插件白名单（可演练候选）：仅以下 id 允许进入演练（双重护栏：白名单 + 排除核心）。
  var ALLOWLIST = ['echo', 'discover', 'dns', 'runtime-php', 'runtime-node',
    'runtime-python', 'integrity', 'ssh-guard'];
  // 用户"当前在用"：state=ready 且被主壳视图/其它能力依赖时视为在用（保守口径）。
  var IN_USE_HINT = { discover: '正在用于服务发现', integrity: '正在用于完整性校验（安全边界）' };

  var S = {
    root: null, plugins: [], candidates: [], loadError: '', loading: true,
    selectedId: '', scenarioId: 'kill_plugin', confirmOpen: false, confirmText: '',
    running: false, runResult: null, observeTimer: null, observeLeft: 0,
    reports: [], destroyed: false
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }

  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var style = el('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  var CSS =
    '.kore-drill{max-width:960px;margin:0 auto;padding:20px}' +
    '.kore-drill h2{font-size:20px;margin:0 0 6px;font-weight:600}' +
    '.kore-drill-sub{color:var(--kore-text-3,#888);font-size:13px;margin:0 0 20px;line-height:1.6}' +
    '.kore-drill-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}' +
    '@media(max-width:720px){.kore-drill-grid{grid-template-columns:1fr}}' +
    '.kore-drill-card{background:var(--kore-bg-2,#fff);border:1px solid var(--kore-border-1,#ddd);' +
    'border-radius:10px;padding:16px;min-width:0}' +
    '.kore-drill-card h3{font-size:15px;margin:0 0 12px;font-weight:600}' +
    '.kore-drill-scn{display:block;width:100%;text-align:left;border:1px solid var(--kore-border-1,#ddd);' +
    'background:transparent;border-radius:8px;padding:12px;margin-bottom:10px;cursor:pointer;' +
    'font:inherit;color:inherit;min-height:44px}' +
    '.kore-drill-scn.on{border-color:var(--kore-accent,#4a90e2);background:var(--kore-bg-3,#f5f9ff)}' +
    '.kore-drill-scn-name{font-weight:600;font-size:14px;display:block;margin-bottom:4px}' +
    '.kore-drill-scn-meta{font-size:12px;color:var(--kore-text-3,#888);line-height:1.5}' +
    '.kore-drill-tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;margin-right:6px}' +
    '.kore-drill-risk-mid{background:#fff3cd;color:#856404}' +
    '.kore-drill-risk-low{background:#d4edda;color:#155724}' +
    '.kore-drill-risk-high{background:#f8d7da;color:#721c24}' +
    '.kore-drill-plug{display:flex;align-items:center;gap:10px;padding:10px 0;' +
    'border-bottom:1px solid var(--kore-border-1,#eee);min-height:44px}' +
    '.kore-drill-plug-name{flex:1;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis}' +
    '.kore-drill-plug-id{font-size:11px;color:var(--kore-text-3,#888)}' +
    '.kore-drill-status{font-size:12px;padding:2px 8px;border-radius:10px;background:#eef;border-radius:10px}' +
    '.kore-drill-btn{border:1px solid var(--kore-accent,#4a90e2);background:var(--kore-accent,#4a90e2);' +
    'color:#fff;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer;min-height:44px}' +
    '.kore-drill-btn:disabled{opacity:.45;cursor:not-allowed}' +
    '.kore-drill-btn-ghost{background:transparent;color:inherit;border-color:var(--kore-border-1,#ddd)}' +
    '.kore-drill-btn-danger{background:#c0392b;border-color:#c0392b}' +
    '.kore-drill-action{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center}' +
    '.kore-drill-note{font-size:12px;color:var(--kore-text-3,#888);line-height:1.6;margin:12px 0 0}' +
    '.kore-drill-banner{background:#e8f4ff;border:1px solid #b8dcff;border-radius:8px;' +
    'padding:12px;font-size:13px;line-height:1.6;margin-bottom:16px}' +
    '.kore-drill-banner b{color:#1a5a9c}' +
    '.kore-drill-confirm{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.45);' +
    'display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.kore-drill-dialog{background:var(--kore-bg-1,#fff);border-radius:12px;padding:22px;' +
    'max-width:480px;width:100%;box-shadow:var(--kore-shadow,0 8px 30px rgba(0,0,0,.2))}' +
    '.kore-drill-dialog h3{margin:0 0 12px;font-size:17px}' +
    '.kore-drill-dialog p{font-size:13px;line-height:1.7;margin:8px 0}' +
    '.kore-drill-dialog input{width:100%;box-sizing:border-box;padding:10px;font:inherit;' +
    'border:1px solid var(--kore-border-1,#ddd);border-radius:8px;min-height:44px;margin:8px 0}' +
    '.kore-drill-live{background:#f7f7f7;border-radius:8px;padding:12px;margin-top:12px;font-size:13px;' +
    'line-height:1.7;font-variant-numeric:tabular-nums}' +
    '.kore-drill-report{border:1px solid var(--kore-border-1,#eee);border-radius:8px;' +
    'padding:10px 12px;margin-bottom:8px;font-size:12px;line-height:1.6}' +
    '.kore-drill-report b{font-size:13px}' +
    '.kore-drill-empty{color:var(--kore-text-3,#888);font-size:13px;padding:12px 0}';

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function request(url, init) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var opts = { method: (init && init.method) || 'GET', credentials: 'same-origin',
      headers: (init && init.headers) || {}, cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (raw) {
        if (timer) clearTimeout(timer);
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        return { status: res.status, ok: res.ok, data: data };
      });
    }, function (err) { if (timer) clearTimeout(timer); throw err; });
  }

  function loadReports() {
    try {
      var raw = localStorage.getItem(REPORT_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      S.reports = Array.isArray(arr) ? arr.slice(0, REPORT_MAX) : [];
    } catch (e) { S.reports = []; }
  }
  function saveReport(r) {
    loadReports();
    S.reports.unshift(r);
    S.reports = S.reports.slice(0, REPORT_MAX);
    try { localStorage.setItem(REPORT_KEY, JSON.stringify(S.reports)); } catch (e) { /* 存储不可用不阻断演练 */ }
  }

  // 白名单 + 核心屏蔽 + 在用提示：返回 { allowed, reason }，reason 为人话。
  function classify(p) {
    if (CORE_PLUGINS[p.id]) return { allowed: false, reason: CORE_PLUGINS[p.id] };
    if (ALLOWLIST.indexOf(p.id) < 0) return { allowed: false, reason: '该插件不在可演练名单内，为避免影响服务已跳过。' };
    if (IN_USE_HINT[p.id] && p.state === 'ready') {
      return { allowed: false, reason: IN_USE_HINT[p.id] + '，演练会影响当前使用，请先停下相关操作。' };
    }
    if (!p.enabled || p.state !== 'ready') {
      return { allowed: false, reason: '该插件当前未运行（状态：' + (p.state || '未知') + '），无需演练。' };
    }
    return { allowed: true, reason: '' };
  }

  function load() {
    S.loading = true; S.loadError = '';
    request(EP.plugins).then(function (res) {
      if (S.destroyed) return;
      S.loading = false;
      if (!res.ok) {
        S.loadError = '读取插件列表失败，请刷新重试（' + res.status + '）。';
        render(); return;
      }
      var rows = (res.data && res.data.plugins) || (Array.isArray(res.data) ? res.data : []);
      S.plugins = rows;
      S.candidates = rows.map(function (p) {
        var c = classify(p);
        return { id: p.id, name: p.name || p.id, state: p.state || '', allowed: c.allowed, reason: c.reason };
      }).filter(function (c) { return c.allowed; });
      if (S.candidates.length && !S.selectedId) S.selectedId = S.candidates[0].id;
      render();
    }, function () {
      if (S.destroyed) return;
      S.loading = false;
      S.loadError = '无法连接后端，请确认服务已启动后刷新。';
      render();
    });
  }

  function currentScenario() {
    for (var i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i].id === S.scenarioId) return SCENARIOS[i];
    return SCENARIOS[0];
  }
  function selectedCandidate() {
    for (var i = 0; i < S.candidates.length; i++) if (S.candidates[i].id === S.selectedId) return S.candidates[i];
    return null;
  }

  function scenarioCard(s) {
    var b = add(S.root, el('button', 'kore-drill-scn' + (S.scenarioId === s.id ? ' on' : '')));
    b.type = 'button';
    add(b, el('span', 'kore-drill-scn-name', s.name));
    var meta = add(b, el('span', 'kore-drill-scn-meta'));
    var riskCls = s.risk === '高' ? 'kore-drill-risk-high' : (s.risk === '中' ? 'kore-drill-risk-mid' : 'kore-drill-risk-low');
    add(meta, el('span', 'kore-drill-tag ' + riskCls, '风险：' + s.risk));
    add(meta, el('span', 'kore-drill-tag', s.reversible ? '可逆' : '不可逆'));
    add(meta, el('span', '', s.does));
    b.addEventListener('click', function () {
      if (S.running) return;
      S.scenarioId = s.id; S.runResult = null; render();
    });
  }

  function plugRow(p) {
    var row = add(S.root, el('div', 'kore-drill-plug'));
    if (p.allowed) {
      var rb = add(row, el('button', 'kore-drill-btn kore-drill-btn-ghost', '选择'));
      rb.type = 'button';
      rb.style.minHeight = '36px';
      if (S.selectedId === p.id) { rb.textContent = '已选'; rb.disabled = true; }
      rb.addEventListener('click', function () { S.selectedId = p.id; S.runResult = null; render(); });
      var box = add(row, el('div'));
      add(box, el('div', 'kore-drill-plug-name', p.name));
      add(box, el('div', 'kore-drill-plug-id', p.id + ' · 运行中'));
    } else {
      add(row, el('div', 'kore-drill-plug-name', p.name));
      add(row, el('div', 'kore-drill-status', '禁止演练 · ' + p.reason));
    }
  }

  function renderReportList(root) {
    var card = add(root, el('div', 'kore-drill-card'));
    add(card, el('h3', '', '演练报告'));
    if (!S.reports.length) {
      add(card, el('div', 'kore-drill-empty', '还没有演练报告。完成一次演练后会自动记录在这里。'));
    } else {
      S.reports.slice(0, 10).forEach(function (r) {
        var item = add(card, el('div', 'kore-drill-report'));
        add(item, el('b', '', r.scenarioName + ' · ' + r.targetName));
        add(item, el('div', '', '时间：' + r.time + ' · 结果：' + r.result +
          ' · 恢复耗时：' + r.recoverMs + 'ms' + (r.dryRun ? ' · 只读观察' : '')));
      });
    }
    var acts = add(card, el('div', 'kore-drill-action'));
    var exp = add(acts, el('button', 'kore-drill-btn kore-drill-btn-ghost', '导出报告 JSON'));
    exp.type = 'button';
    exp.disabled = !S.reports.length;
    exp.addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(S.reports, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = el('a'); a.href = url; a.download = 'kore-fault-drill-report.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
    var clr = add(acts, el('button', 'kore-drill-btn kore-drill-btn-ghost', '清空本地报告'));
    clr.type = 'button'; clr.disabled = !S.reports.length;
    clr.addEventListener('click', function () {
      S.reports = [];
      try { localStorage.removeItem(REPORT_KEY); } catch (e) { /* noop */ }
      render();
    });
  }

  function renderConfirm() {
    var s = currentScenario(), p = selectedCandidate();
    if (!S.confirmOpen || !p) return;
    var ov = add(S.root, el('div', 'kore-drill-confirm'));
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    var dlg = add(ov, el('div', 'kore-drill-dialog'));
    add(dlg, el('h3', '', '确认执行演练'));
    add(dlg, el('p', '', '目标插件：' + p.name + '（' + p.id + '）。'));
    add(dlg, el('p', '', '会做什么：' + s.does));
    add(dlg, el('p', '', '影响：' + s.expect));
    add(dlg, el('p', '', 'supervisor 会自动重启该插件；主壳与其它插件不受影响。'));
    add(dlg, el('p', '', '当前为只读观察演练，不会真正结束进程或改动系统；真实执行需后端受控端点接入并真机验证。'));
    var input = add(dlg, el('input'));
    input.type = 'text'; input.placeholder = '请输入插件 ID「' + p.id + '」以解锁执行';
    input.setAttribute('aria-label', '输入插件 ID 确认');
    input.addEventListener('input', function () { S.confirmText = input.value; });
    var acts = add(dlg, el('div', 'kore-drill-action'));
    var go = add(acts, el('button', 'kore-drill-btn kore-drill-btn-danger', '开始演练（只读观察）'));
    go.type = 'button';
    go.disabled = S.confirmText.trim() !== p.id;
    go.addEventListener('click', function () { if (!go.disabled) startDrill(); });
    var cancel = add(acts, el('button', 'kore-drill-btn kore-drill-btn-ghost', '取消'));
    cancel.type = 'button';
    cancel.addEventListener('click', function () { S.confirmOpen = false; S.confirmText = ''; render(); });
    input.focus();
  }

  function finishDrill(target, scenario, recoverMs) {
    S.running = false; S.observeLeft = 0;
    S.runResult = {
      scenarioName: scenario.name, targetName: target.name,
      time: new Date().toLocaleString('zh-CN'),
      result: '观察完成：插件状态稳定 / 主壳可操作（只读模拟）',
      recoverMs: recoverMs + '（模拟）', dryRun: true
    };
    saveReport({
      scenario: scenario.id, scenarioName: scenario.name,
      target: target.id, targetName: target.name,
      time: new Date().toISOString(), result: S.runResult.result,
      recoverMs: recoverMs, dryRun: true
    });
    if (!S.destroyed) render();
  }

  function startDrill() {
    var p = selectedCandidate(), s = currentScenario();
    if (!p || S.running) return;
    S.confirmOpen = false; S.confirmText = ''; S.running = true;
    S.observeLeft = OBSERVE_SEC; S.runResult = null; render();
    var started = Date.now();
    // 只读观察：不 kill、不注入超时、不写磁盘；仅倒计时后在报告里记一次模拟恢复耗时。
    S.observeTimer = setInterval(function () {
      if (S.destroyed) { clearInterval(S.observeTimer); S.observeTimer = null; return; }
      S.observeLeft--;
      if (S.observeLeft <= 0) {
        clearInterval(S.observeTimer); S.observeTimer = null;
        finishDrill(p, s, Date.now() - started);
      } else {
        var node = S.root && S.root.querySelector('.kore-drill-live-num');
        if (node) node.textContent = '正在观察（' + S.observeLeft + 's）…';
      }
    }, 1000);
  }

  function render() {
    var root = S.root;
    if (!root) return;
    root.textContent = '';
    ensureCss();
    var wrap = add(root, el('div', 'kore-drill'));
    S.root = wrap; // 后续局部刷新挂到 wrap 上

    add(wrap, el('h2', '', '故障演练'));
    add(wrap, el('p', 'kore-drill-sub',
      '主动观察系统在故障下的降级与自愈能力。演练只针对非核心插件白名单，核心插件与正在使用的插件不可演练。'));
    var banner = add(wrap, el('div', 'kore-drill-banner'));
    add(banner, el('b', '', '安全承诺：'));
    add(banner, el('span', '', ' 本页为只读观察演练，绝不结束主壳/系统进程、不改动系统状态；真实故障注入需后端受控端点接入并真机验证。'));

    var grid = add(wrap, el('div', 'kore-drill-grid'));
    // 左列：场景 + 目标插件 + 执行
    var left = add(grid, el('div'));
    var scnCard = add(left, el('div', 'kore-drill-card'));
    add(scnCard, el('h3', '', '① 选择演练场景'));
    SCENARIOS.forEach(function (s) { S.root = scnCard; scenarioCard(s); });
    S.root = wrap;

    var plugCard = add(left, el('div', 'kore-drill-card'));
    plugCard.style.marginTop = '16px';
    add(plugCard, el('h3', '', '② 选择目标插件（仅非核心白名单）'));
    if (S.loading) {
      add(plugCard, el('div', 'kore-drill-empty', '正在读取插件列表…'));
    } else if (S.loadError) {
      add(plugCard, el('div', 'kore-drill-empty', S.loadError));
      var retry = add(plugCard, el('button', 'kore-drill-btn kore-drill-btn-ghost', '重试'));
      retry.type = 'button'; retry.addEventListener('click', function () { load(); });
    } else if (!S.candidates.length) {
      add(plugCard, el('div', 'kore-drill-empty', '当前没有可演练的非核心插件。所有插件都是核心能力或正在使用，这本身就是安全状态。'));
    } else {
      S.root = plugCard;
      S.plugins.forEach(function (p) { plugRow({ id: p.id, name: p.name || p.id,
        allowed: classify(p).allowed, reason: classify(p).reason }); });
      S.root = wrap;
    }

    var actCard = add(left, el('div', 'kore-drill-card'));
    actCard.style.marginTop = '16px';
    add(actCard, el('h3', '', '③ 执行演练'));
    var acts = add(actCard, el('div', 'kore-drill-action'));
    var start = add(acts, el('button', 'kore-drill-btn', '开始演练'));
    start.type = 'button';
    start.disabled = S.running || !selectedCandidate();
    start.addEventListener('click', function () { S.confirmOpen = true; S.confirmText = ''; render(); });
    add(actCard, el('p', 'kore-drill-note',
      '执行前必须二次确认：会列出目标插件、影响说明与「supervisor 会自动重启」。'));
    var scn = currentScenario();
    add(actCard, el('p', 'kore-drill-note', '场景说明：' + scn.expect + '（' + scn.needBackend + '）'));
    if (S.running) {
      var live = add(actCard, el('div', 'kore-drill-live'));
      add(live, el('span', 'kore-drill-live-num', '正在观察（' + S.observeLeft + 's）…'));
    }
    if (S.runResult) {
      var res = add(actCard, el('div', 'kore-drill-live'));
      add(res, el('b', '', '演练结果：'));
      add(res, el('div', '', S.runResult.result));
      add(res, el('div', '', '目标：' + S.runResult.targetName + ' · 恢复耗时：' + S.runResult.recoverMs));
    }

    // 右列：报告
    S.root = grid;
    renderReportList(grid);
    S.root = wrap;
    renderConfirm();
  }

  window.KoreFaultDrill = {
    render: function (container) {
      if (!container) return { destroy: function () {} };
      S.root = container;
      S.destroyed = false;
      loadReports();
      load();
      render();
      return {
        destroy: function () {
          S.destroyed = true;
          if (S.observeTimer) { clearInterval(S.observeTimer); S.observeTimer = null; }
        }
      };
    },
    mount: function (container) { return this.render(container); }
  };
})();
