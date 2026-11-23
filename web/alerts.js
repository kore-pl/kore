/* kore 主壳 · 告警中心（web/alerts.js，懒加载）
   四类来源（本地现场聚合，不落库、不新增表）：
     1) 操作审计 GET /api/v1/audit?since=5min：denied 激增（>5 条）+ 高危动作（root.action / capability.denied）
     2) 插件 GET /api/v1/plugins：state=failed 或 restarts>3
     3) 资源 GET /api/v1/system/metrics：RSS 接近红线（>14 MiB）、goroutine>15、fd>56
     4) 槽位 GET /api/v1/system/info：supervisor.resident 达到硬上限 3
   纪律：打开面板或铃铛探测时聚合一次，不轮询（G-19）；对外 window.KoreAlerts = { open, probe, close }。
   每次聚合后向 document 派发 kore:alerts-count，由 shell.js 更新铃铛红点。 */
(function () {
  'use strict';
  var EP = { audit: '/api/v1/audit', plugins: '/api/v1/plugins',
    metrics: '/api/v1/system/metrics', info: '/api/v1/system/info' };
  // 同时常驻硬上限（G-03：resident + 活跃 lazy ≤ 3，即 MAX_PLUGINS）。
  // resources.resident_max（默认 2）是 lazy 槽位保护配额，不是「槽位用尽」口径，故不取它。
  var MAX_SLOTS = 3;
  var RSS_WARN_KIB = 14 * 1024; // 主壳红线 16 MiB，14 MiB 视为「接近」
  var GOROUTINE_WARN = 15;
  var FD_WARN = 56;             // 红线 64
  var DENIED_BURST = 5;         // 5 分钟内 denied > 5 条算激增
  var AUDIT_WINDOW_MS = 5 * 60 * 1000;
  var HIGH_RISK = { 'root.action': '提权动作被拒绝', 'capability.denied': '能力校验被拒绝' };
  var SEV = { critical: '严重', warning: '警告', info: '提示' };
  var S = { root: null, backdrop: null, panel: null, body: null, head: null, busy: false };

  // 遮罩与面板从顶栏下沿开始：顶栏保持可见（铃铛红点与面板同屏可核对）。
  var CSS = '.kore-alert-backdrop{position:fixed;inset:var(--kore-topbar-h) 0 0 0;z-index:70;' +
    'background:var(--kore-overlay)}' +
    '.kore-alert-panel{position:fixed;top:var(--kore-topbar-h);right:0;bottom:0;z-index:71;width:400px;max-width:100%;' +
    'display:flex;flex-direction:column;background:var(--kore-bg-1);border-left:1px solid var(--kore-border-1);' +
    'box-shadow:var(--kore-shadow)}' +
    '.kore-alert-head{display:flex;align-items:center;gap:var(--kore-space-2);' +
    'padding:var(--kore-space-3) var(--kore-space-4);border-bottom:1px solid var(--kore-border-1)}' +
    '.kore-alert-title{font-size:var(--kore-font-16);font-weight:600;flex:1}' +
    '.kore-alert-count{font-size:var(--kore-font-12);color:var(--kore-text-3)}' +
    '.kore-alert-body{flex:1;overflow:auto;padding:var(--kore-space-3) var(--kore-space-4)}' +
    '.kore-alert-item{display:flex;gap:var(--kore-space-3);padding:var(--kore-space-3);margin-bottom:var(--kore-space-2);' +
    'background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-left:4px solid var(--kore-text-3);' +
    'border-radius:var(--kore-radius-control)}' +
    '.kore-alert-item.is-critical{border-left-color:var(--kore-danger)}' +
    '.kore-alert-item.is-warning{border-left-color:var(--kore-warning)}' +
    '.kore-alert-item.is-info{border-left-color:var(--kore-info)}' +
    '.kore-alert-main{flex:1;min-width:0}' +
    '.kore-alert-line{display:flex;align-items:baseline;gap:var(--kore-space-2);flex-wrap:wrap}' +
    '.kore-alert-sev{font-size:var(--kore-font-12);font-weight:600}' +
    '.kore-alert-sev.is-critical{color:var(--kore-danger)}.kore-alert-sev.is-warning{color:var(--kore-warning)}' +
    '.kore-alert-sev.is-info{color:var(--kore-info)}' +
    '.kore-alert-what{font-weight:600}.kore-alert-time{font-size:var(--kore-font-12);color:var(--kore-text-3)}' +
    '.kore-alert-detail{margin-top:var(--kore-space-1);font-size:var(--kore-font-12);color:var(--kore-text-2);' +
    'overflow-wrap:anywhere}' +
    '.kore-alert-act{align-self:flex-start;min-height:32px}' +
    '.kore-alert-empty{text-align:center;padding:var(--kore-space-6) var(--kore-space-3);color:var(--kore-text-2)}' +
    '.kore-alert-empty b{display:block;font-size:var(--kore-font-16);color:var(--kore-success);margin-bottom:var(--kore-space-2)}' +
    '.kore-alert-empty small{color:var(--kore-text-3)}' +
    '@media (max-width:639px){.kore-alert-panel{top:auto;height:calc(100% - var(--kore-topbar-h));width:100%;border-left:0}' +
    '.kore-alert-act{min-height:var(--kore-touch)}}';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function ensureCss() {
    if (document.getElementById('kore-alert-css')) return;
    var s = el('style'); s.id = 'kore-alert-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }
  // 与 store.js 同口径：永不因 HTTP 状态码 reject；网络错误 reject 由 aggregate 兜住。
  function req(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json' } }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = {}; } }
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '—';
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function mib(kib) { return (Number(kib) / 1024).toFixed(1) + ' MiB'; }
  function now() { return new Date().toISOString(); }
  function push(list, severity, title, detail, time, action) {
    list.push({ severity: severity, title: title, detail: detail, time: time || now(), action: action || '' });
  }

  // 审计：denied 激增（一条汇总）+ 高危动作（按动作类型各一条）。
  function fromAudit(res, alerts) {
    if (!res.ok || !res.data || !Array.isArray(res.data.records)) return false;
    var denied = res.data.records.filter(function (r) { return r.result === 'denied'; });
    if (denied.length > DENIED_BURST) {
      var acts = Object.create(null), sample = '';
      denied.forEach(function (r) {
        var key = r.action || 'unknown';
        acts[key] = (acts[key] || 0) + 1;
        if (!sample) sample = (r.subject || 'unknown') + ' → ' + (r.plugin || r.target || 'system');
      });
      var top = Object.keys(acts).sort(function (a, b) { return acts[b] - acts[a]; }).slice(0, 3)
        .map(function (k) { return k + ' ×' + acts[k]; }).join('、');
      push(alerts, 'warning', '近期有 ' + denied.length + ' 次被拒绝的操作',
        '最近 5 分钟：' + top + '；示例 ' + sample, denied[0].at, 'settings');
    }
    Object.keys(HIGH_RISK).forEach(function (action) {
      var hits = denied.filter(function (r) { return r.action === action; });
      if (!hits.length) return;
      var who = hits.slice(0, 3).map(function (r) {
        return (r.subject || 'unknown') + ' → ' + (r.plugin || '') + (r.target ? '/' + r.target : '');
      }).join('；');
      push(alerts, 'critical', HIGH_RISK[action] + '（' + hits.length + ' 次）',
        '涉及：' + who, hits[0].at, 'settings');
    });
    return true;
  }

  function fromPlugins(res, alerts) {
    if (!res.ok || !res.data || !Array.isArray(res.data.plugins)) return false;
    res.data.plugins.forEach(function (p) {
      var name = p.name || p.id;
      if (p.state === 'failed') {
        push(alerts, 'critical', '插件 ' + name + ' 运行失败',
          'id=' + p.id + '；已重启 ' + (p.restarts || 0) + ' 次，可到「已装插件」停用或重装', now(), 'plugins');
      } else if (Number(p.restarts) > 3) {
        push(alerts, 'warning', '插件 ' + name + ' 反复重启（' + p.restarts + ' 次）',
          'id=' + p.id + '；检查插件日志或升级到新版本', now(), 'plugins');
      }
    });
    return true;
  }

  function fromMetrics(res, alerts) {
    if (!res.ok || !res.data) return false;
    var m = res.data;
    if (m.rss_kib > RSS_WARN_KIB) {
      push(alerts, 'warning', '主壳内存接近红线', '当前 ' + mib(m.rss_kib) + '，红线 16.0 MiB', now(), 'monitor');
    }
    if (m.goroutines > GOROUTINE_WARN) {
      push(alerts, 'warning', 'goroutine 数偏高（' + m.goroutines + '）', '红线 20；持续增长可能是泄漏', now(), 'monitor');
    }
    if (m.fds > FD_WARN) {
      push(alerts, 'warning', '打开文件描述符偏高（' + m.fds + '）', '红线 64；检查是否有连接或文件未关闭', now(), 'monitor');
    }
    return true;
  }

  function fromInfo(res, alerts) {
    if (!res.ok || !res.data || !res.data.supervisor) return false;
    var resident = Number(res.data.supervisor.resident || 0);
    if (resident >= MAX_SLOTS) {
      push(alerts, 'warning', '常驻槽位已满（' + resident + ' / ' + MAX_SLOTS + '）',
        '同时常驻已达硬上限，启用新插件需先停用一个', now(), 'plugins');
    }
    return true;
  }

  // 四源并行聚合：单源失败降级为 info，不让整块面板不可用。
  function collect() {
    var since = new Date(Date.now() - AUDIT_WINDOW_MS).toISOString();
    var urls = [EP.audit + '?since=' + encodeURIComponent(since) + '&order=desc&limit=200',
      EP.plugins, EP.metrics, EP.info];
    var tasks = urls.map(function (u) { return req(u).catch(function () { return null; }); });
    return Promise.all(tasks).then(function (out) {
      var alerts = [];
      var bad = [];
      if (out[0] && !fromAudit(out[0], alerts)) bad.push('操作审计');
      if (out[1] && !fromPlugins(out[1], alerts)) bad.push('插件状态');
      if (out[2] && !fromMetrics(out[2], alerts)) bad.push('资源采样');
      if (out[3] && !fromInfo(out[3], alerts)) bad.push('槽位统计');
      if (bad.length) push(alerts, 'info', '部分检查暂不可用', bad.join('、') + '读取失败；其余来源已检查', now(), '');
      var rank = { critical: 0, warning: 1, info: 2 };
      alerts.sort(function (a, b) { return rank[a.severity] - rank[b.severity]; });
      var critical = alerts.some(function (a) { return a.severity === 'critical'; });
      document.dispatchEvent(new CustomEvent('kore:alerts-count',
        { detail: { count: alerts.length, critical: critical } }));
      return alerts;
    });
  }

  function render(alerts) {
    if (!S.body) return;
    S.body.textContent = '';
    if (!alerts.length) {
      var box = el('div', 'kore-alert-empty');
      box.appendChild(el('b', null, '一切正常'));
      box.appendChild(el('div', null, '最近检查时间 ' + fmtTime(now())));
      box.appendChild(el('small', null, '打开面板会重新检查四类告警来源'));
      S.body.appendChild(box);
      return;
    }
    alerts.forEach(function (a) {
      var item = el('div', 'kore-alert-item is-' + a.severity);
      var main = el('div', 'kore-alert-main');
      var line = el('div', 'kore-alert-line');
      line.appendChild(el('span', 'kore-alert-sev is-' + a.severity, SEV[a.severity] || '提示'));
      line.appendChild(el('span', 'kore-alert-what', a.title));
      line.appendChild(el('span', 'kore-alert-time', fmtTime(a.time)));
      main.appendChild(line);
      if (a.detail) main.appendChild(el('div', 'kore-alert-detail', a.detail));
      item.appendChild(main);
      if (a.action) {
        var btn = el('button', 'btn btn-primary kore-alert-act', '去处理');
        btn.type = 'button';
        btn.addEventListener('click', function () { go(a.action); });
        item.appendChild(btn);
      }
      S.body.appendChild(item);
    });
  }
  function go(view) {
    close();
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate(view);
    else window.location.hash = '#/' + view;
  }
  function refresh() {
    if (S.busy) return Promise.resolve();
    S.busy = true;
    if (S.body) S.body.textContent = '正在检查…';
    return collect().then(function (alerts) {
      S.busy = false;
      if (S.head) S.head.textContent = alerts.length ? '共 ' + alerts.length + ' 条' : '';
      render(alerts);
      return alerts;
    }, function (err) {
      S.busy = false;
      if (S.body) {
        S.body.textContent = '';
        S.body.appendChild(el('div', 'kore-alert-empty', '检查失败：' + (err && err.message ? err.message : '网络错误')));
      }
    });
  }
  function build() {
    ensureCss();
    S.backdrop = el('div', 'kore-alert-backdrop');
    S.backdrop.addEventListener('click', close);
    S.panel = el('div', 'kore-alert-panel');
    S.panel.setAttribute('role', 'dialog');
    S.panel.setAttribute('aria-modal', 'true');
    S.panel.setAttribute('aria-label', '告警中心');
    var head = el('div', 'kore-alert-head');
    head.appendChild(el('span', 'kore-alert-title', '告警中心'));
    S.head = el('span', 'kore-alert-count', '');
    head.appendChild(S.head);
    var again = el('button', 'btn btn-ghost', '重新检查');
    again.type = 'button';
    again.addEventListener('click', refresh);
    head.appendChild(again);
    var shut = el('button', 'btn btn-ghost', '关闭');
    shut.type = 'button';
    shut.addEventListener('click', close);
    head.appendChild(shut);
    S.panel.appendChild(head);
    S.body = el('div', 'kore-alert-body');
    S.panel.appendChild(S.body);
    S.root = el('div');
    S.root.appendChild(S.backdrop);
    S.root.appendChild(S.panel);
    document.body.appendChild(S.root);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && S.root && S.root.parentNode) close();
    });
  }
  function open() {
    if (!S.root) build();
    S.root.hidden = false;
    S.backdrop.hidden = false;
    S.panel.hidden = false;
    refresh();
    return S.root;
  }
  function close() {
    if (S.root) S.root.hidden = true;
  }
  // probe 只更新铃铛数字，不建面板（供 shell 首屏后懒探测）。
  function probe() { return collect().then(function (a) { return a.length; }, function () { return 0; }); }

  window.KoreAlerts = { open: open, close: close, probe: probe, refresh: refresh };
})();
