/* kore 主壳 · 告警中心（web/alerts.js，懒加载）
   两条数据线：
     1) 历史：GET /api/v1/alerts——内核各检查点服务端埋点落库（alerts bucket，
        保留 500 条、5 分钟去重合并、seen 已读标记），关掉面板也不丢，可回溯。
     2) 本地现场聚合（原四源逻辑保留）：audit / plugins / metrics / info 现算。
   打开面板或铃铛探测时：先读历史，再叠加本地聚合，两边按 title+分钟去重；
   后端告警端点失败时静默回退纯本地聚合（现状），不报错。
   铃铛红点数 = 后端未读（seen=false）条数 + 本地实时告警数（去重后）。
   纪律：不轮询（G-19）；对外 window.KoreAlerts = { open, probe, close, refresh }。
   每次聚齐后向 document 派发 kore:alerts-count，由 shell.js 更新铃铛红点。 */
(function () {
  'use strict';
  var EP = { alerts: '/api/v1/alerts', audit: '/api/v1/audit', plugins: '/api/v1/plugins',
    metrics: '/api/v1/system/metrics', info: '/api/v1/system/info' };
  // 同时常驻硬上限（G-03：resident + 活跃 lazy ≤ 3，即 MAX_PLUGINS）。
  // resources.resident_max（默认 2）是 lazy 槽位保护配额，不是「槽位用尽」口径，故不取它。
  var MAX_SLOTS = 3;
  var RSS_WARN_KIB = 14 * 1024; // 主壳红线 16 MiB，14 MiB 视为「接近」
  var GOROUTINE_WARN = 15;
  var FD_WARN = 56;             // 红线 64
  var DENIED_BURST = 5;         // 5 分钟内 denied > 5 条算激增
  var AUDIT_WINDOW_MS = 5 * 60 * 1000;
  var HIGH_RISK = { 'root.action': '提权动作被拒绝', 'capability.denied': '权限不足被拒绝' };
  var SEV = { critical: '严重', warning: '警告', info: '提示' };
  var HISTORY_LIMIT = 100;
  var S = { root: null, backdrop: null, panel: null, body: null, head: null,
    seenBtn: null, history: [], historyUnread: 0, busy: false };

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
    '.kore-alert-dot{width:8px;height:8px;border-radius:50%;background:var(--kore-danger);flex:none}' +
    '.kore-alert-countn{font-size:var(--kore-font-12);color:var(--kore-text-3)}' +
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
  // 与 store.js 同口径：永不因 HTTP 状态码 reject；网络错误 reject 由调用方兜住。
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
  // cookie 读取（kore_csrf 非 HttpOnly；写请求双提交头）。
  function readCookie(name) {
    var hit = document.cookie.split(';').map(function (p) { return p.trim(); })
      .filter(function (p) { return p.indexOf(name + '=') === 0; })[0];
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
  }
  // 标记一条已读：失败静默（历史刷新时以服务端状态为准）。
  function postSeen(id) {
    var token = readCookie('kore_csrf');
    return fetch(EP.alerts + '/' + encodeURIComponent(id) + '/seen', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Kore-CSRF': token }, body: '{}'
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
  // 去重键：title + 分钟（两边同一事件在同一分钟内只显示一条，历史记录优先——它带 seen 状态）。
  function dedupKey(a) { return (a.title || '') + '|' + String(a.time || '').slice(0, 16); }

  // 历史：后端 alerts bucket；失败返回 ok=false（回退纯本地，不报错）。
  function fetchHistory() {
    return req(EP.alerts + '?limit=' + HISTORY_LIMIT).catch(function () { return null; })
      .then(function (res) {
        if (!res || !res.ok || !res.data || !Array.isArray(res.data.alerts)) {
          return { ok: false, items: [], unread: 0 };
        }
        var items = res.data.alerts.map(function (r) {
          return { history: true, id: r.id, seen: !!r.seen, count: Number(r.count) || 1,
            severity: r.severity || 'info', source: r.source || '', title: r.title || '',
            detail: r.detail || '', time: r.ts || '', action: '' };
        });
        return { ok: true, items: items, unread: Number(res.data.unread) || 0 };
      });
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
      var detail = '涉及：' + who;
      if (action === 'capability.denied') detail = '内核按插件声明在安装/升级时授予能力，没有逐项授权开关；该操作需要管理员账号，请用管理员登录。' + detail;
      push(alerts, 'critical', HIGH_RISK[action] + '（' + hits.length + ' 次）',
        detail, hits[0].at, 'settings');
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
      push(alerts, 'warning', '常驻名额已满（最多 ' + MAX_SLOTS + ' 个插件同时常驻）',
        '已达到同时常驻上限，启用新插件需先停用一个', now(), 'plugins');
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
      return alerts;
    });
  }

  // 合并：历史在前（带 id/seen/count），本地仅补历史没有的键；本地时间用分钟级去重。
  function mergeItems(history, local) {
    var seenKeys = Object.create(null);
    history.forEach(function (a) { seenKeys[dedupKey(a)] = true; });
    var extra = local.filter(function (a) { return !seenKeys[dedupKey(a)]; });
    return history.concat(extra);
  }

  // 红点数 = 后端未读 + 本地实时告警中未与历史合并的条数；critical 取两路任一。
  function emitCounts(history, local, mergedCount) {
    var localExtra = local.filter(function (a) {
      return !history.some(function (h) { return dedupKey(h) === dedupKey(a); });
    });
    var count = S.historyUnread + localExtra.length;
    var critical = history.some(function (a) { return a.severity === 'critical' && !a.seen; }) ||
      localExtra.some(function (a) { return a.severity === 'critical'; });
    document.dispatchEvent(new CustomEvent('kore:alerts-count',
      { detail: { count: count, critical: critical } }));
    return count;
  }

  function unreadCount(items) {
    return items.filter(function (a) { return a.history && !a.seen; }).length;
  }

  function render(items, historyOk) {
    if (!S.body) return;
    S.body.textContent = '';
    var unread = unreadCount(items);
    if (S.seenBtn) {
      S.seenBtn.hidden = unread === 0;
    }
    if (S.head) {
      var bits = [];
      if (items.length) bits.push('共 ' + items.length + ' 条');
      if (unread) bits.push('未读 ' + unread);
      S.head.textContent = bits.join(' · ');
    }
    if (!items.length) {
      var box = el('div', 'kore-alert-empty');
      box.appendChild(el('b', null, '一切正常'));
      box.appendChild(el('div', null, '最近检查时间 ' + fmtTime(now())));
      box.appendChild(el('small', null, historyOk ?
        '打开面板会检查历史记录与四类告警来源' : '告警历史不可用（已回退本地检查）；打开面板会重新检查'));
      S.body.appendChild(box);
      return;
    }
    items.forEach(function (a) {
      var item = el('div', 'kore-alert-item is-' + a.severity);
      var main = el('div', 'kore-alert-main');
      var line = el('div', 'kore-alert-line');
      line.appendChild(el('span', 'kore-alert-sev is-' + a.severity, SEV[a.severity] || '提示'));
      line.appendChild(el('span', 'kore-alert-what', a.title));
      if (a.count > 1) line.appendChild(el('span', 'kore-alert-countn', '×' + a.count + ' 次'));
      line.appendChild(el('span', 'kore-alert-time', fmtTime(a.time)));
      if (a.history && !a.seen) line.appendChild(el('span', 'kore-alert-dot'));
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
  // 全部标为已读：对当前历史里未读的逐条 POST seen，随后重查刷新。
  function markAllSeen() {
    var unseen = S.history.filter(function (a) { return !a.seen; });
    if (!unseen.length) return Promise.resolve();
    return Promise.all(unseen.map(function (a) {
      return postSeen(a.id).catch(function () { return null; });
    })).then(refresh);
  }
  function refresh() {
    if (S.busy) return Promise.resolve();
    S.busy = true;
    if (S.body) S.body.textContent = '正在检查…';
    return Promise.all([fetchHistory(), collect()]).then(function (out) {
      S.busy = false;
      var history = out[0], local = out[1];
      S.history = history.items;
      S.historyUnread = history.unread;
      var items = mergeItems(history.items, local);
      render(items, history.ok);
      emitCounts(history.items, local, items.length);
      return items;
    }, function () {
      // 网络级失败（四源全断）：不报错，按空态处理（端点失败降级已在上游兜住）。
      S.busy = false;
      S.body.textContent = '';
      S.body.appendChild(el('div', 'kore-alert-empty', '检查失败：网络错误'));
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
    S.seenBtn = el('button', 'btn btn-ghost', '全部标为已读');
    S.seenBtn.type = 'button';
    S.seenBtn.hidden = true;
    S.seenBtn.addEventListener('click', markAllSeen);
    head.appendChild(S.seenBtn);
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
  // probe 只更新铃铛数字，不建面板（供 shell 首屏后懒探测）：
  // 数 = 后端未读 + 本地实时告警（未与历史合并部分）；历史不可用时退本地口径。
  function probe() {
    return Promise.all([fetchHistory(), collect()]).then(function (out) {
      var history = out[0], local = out[1];
      S.history = history.items;
      S.historyUnread = history.unread;
      return emitCounts(history.items, local, 0);
    }, function () { return 0; });
  }

  window.KoreAlerts = { open: open, close: close, probe: probe, refresh: refresh };
})();
