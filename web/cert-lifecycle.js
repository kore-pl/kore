/* kore 主壳 · 证书生命周期看板（web/cert-lifecycle.js）——零框架 / 零 CDN / 无外链。
   纯增量新视图：把「全部已签发证书 + 过期风险」集中到一张按到期时间排序的表，
   顶部四个概览卡（总数 / 即将过期 / 已过期 / 自动续期开启），点行展开详情（SAN / 指纹 / 链）。
   对外契约：window.KoreCertLifecycle.render(container) → { destroy: function(){} }。
   本模块由主壳 SHELL_VIEWS 懒加载，不进首屏；CSS 内联注入，不改 style.css。
   只复用现有 ssl 插件方法（info.json v0.7.1，method_capabilities 已声明），不新增后端：
     ssl.list         (system:read)  → certs[]：domain/domains/not_after/days_left/issuer/
                                       fingerprint_sha256/chain_length/self_signed/source/expired/expiring_soon
     ssl.bind.list    (system:read)  → bindings[]：cert/site/note/cert_exists
     ssl.verify       (system:read)  → 详情：fingerprint_sha256/chain_length/serial/issuer/subject
     ssl.renew        (system:admin) → 续期（覆盖前插件自动备份旧证书）
     ssl.bind.remove  (system:admin) → 解绑站点归属登记（不写 web 服务器配置）
   自动续期状态来自内核 GET /api/v1/scheduler/tasks，按任务 name 关联证书域名（继承 ssl.js 范式；
   插件无权自建定时任务，ADR-0019）。ssl.verify 返回里没有 SAN 字段，SAN 取 ssl.list.domains，
   不从 verify 里凭空造字段——事实驱动，两个数据源各取其所长。
   危险操作（续期 / 解绑）都有 window.confirm 二次确认，取消不发任何请求。
   手机适配：表格在 ≤639px 转卡片（data-label 伪元素显示字段名），触摸目标 ≥44px（--kore-touch）。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/ssl/';
  var SCHED = '/api/v1/scheduler/tasks';
  var CSS_ID = 'kore-certlife-css';

  var CSS =
    '.kcl{color:var(--kore-text-1,#1f2937);font-size:14px}' +
    '.kcl-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px;margin:0 0 16px}' +
    '.kcl-head h2{margin:0;font-size:20px;font-weight:600}' +
    '.kcl-sub{color:var(--kore-text-2,#6b7280);font-size:13px;flex:1 1 320px;line-height:1.5}' +
    '.kcl-btn{min-height:var(--kore-touch,44px);min-width:var(--kore-touch,44px);padding:6px 14px;' +
      'border:1px solid var(--kore-border,#d1d5db);border-radius:6px;background:var(--kore-surface,#fff);' +
      'color:inherit;cursor:pointer;font-size:13px}' +
    '.kcl-btn:hover{border-color:var(--kore-accent,#2563eb)}' +
    '.kcl-btn-primary{background:var(--kore-accent,#2563eb);border-color:var(--kore-accent,#2563eb);color:#fff}' +
    '.kcl-btn-danger{color:#b91c1c;border-color:#fca5a5}' +
    '.kcl-status{min-height:20px;margin:4px 0 12px;font-size:13px;line-height:1.5}' +
    '.kcl-status.ok{color:#15803d}.kcl-status.fail{color:#b91c1c}.kcl-status.muted{color:var(--kore-text-2,#6b7280)}' +
    '.kcl-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 18px}' +
    '.kcl-card{border:1px solid var(--kore-border,#e5e7eb);border-radius:10px;padding:14px 16px;' +
      'background:var(--kore-surface,#fff);min-width:0}' +
    '.kcl-card-k{font-size:12px;color:var(--kore-text-2,#6b7280);margin-bottom:6px}' +
    '.kcl-card-v{font-size:26px;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums}' +
    '.kcl-card-v.warn{color:#b45309}.kcl-card-v.fatal{color:#b91c1c}.kcl-card-v.good{color:#15803d}' +
    '.kcl-card-hint{font-size:11px;color:var(--kore-text-2,#9ca3af);margin-top:4px}' +
    '.kcl-note{font-size:12px;color:var(--kore-text-2,#6b7280);margin:0 0 12px;line-height:1.5}' +
    '.kcl-table-host{overflow-x:auto;border:1px solid var(--kore-border,#e5e7eb);border-radius:10px}' +
    '.kcl-table{width:100%;border-collapse:collapse;font-size:13px}' +
    '.kcl-table th,.kcl-table td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--kore-border,#eef2f7);vertical-align:top}' +
    '.kcl-table th{background:var(--kore-bg-2,#f9fafb);font-weight:600;white-space:nowrap;color:var(--kore-text-2,#4b5563)}' +
    '.kcl-table tbody tr:last-child td{border-bottom:0}' +
    '.kcl-row{cursor:pointer}' +
    '.kcl-row:hover{background:var(--kore-bg-2,#f9fafb)}' +
    '.kcl-row.soon{background:#fef2f2}.kcl-row.soon:hover{background:#fee2e2}' +
    '.kcl-row.expired{background:#fee2e2}' +
    '.kcl-domain{font-weight:600;word-break:break-all}' +
    '.kcl-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}' +
    '.kcl-muted{color:var(--kore-text-2,#6b7280)}' +
    '.kcl-days{display:inline-block;padding:2px 8px;border-radius:999px;font-variant-numeric:tabular-nums;' +
      'background:#ecfdf5;color:#15803d;font-weight:600;white-space:nowrap}' +
    '.kcl-days.warn{background:#fef3c7;color:#b45309}.kcl-days.fatal{background:#fee2e2;color:#b91c1c}' +
    '.kcl-pill{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;margin:1px 3px 1px 0;' +
      'background:var(--kore-bg-2,#f3f4f6);color:var(--kore-text-2,#4b5563)}' +
    '.kcl-pill.ok{background:#dcfce7;color:#15803d}.kcl-pill.off{background:#f3f4f6;color:#6b7280}' +
    '.kcl-ops{display:flex;flex-wrap:wrap;gap:6px}' +
    '.kcl-ops .kcl-btn{padding:4px 9px;min-height:36px;font-size:12px}' +
    '.kcl-detail td{background:var(--kore-bg-2,#f9fafb);padding:14px 18px}' +
    '.kcl-detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 18px}' +
    '.kcl-detail-item{min-width:0}' +
    '.kcl-detail-k{font-size:11px;color:var(--kore-text-2,#6b7280);margin-bottom:3px}' +
    '.kcl-detail-v{font-size:13px;word-break:break-all;line-height:1.5}' +
    '.kcl-empty{padding:44px 20px;text-align:center;border:1px dashed var(--kore-border,#d1d5db);' +
      'border-radius:10px;background:var(--kore-surface,#fff)}' +
    '.kcl-empty-title{font-size:16px;font-weight:600;margin:0 0 8px}' +
    '.kcl-empty-text{color:var(--kore-text-2,#6b7280);font-size:13px;margin:0 0 18px;line-height:1.6}' +
    '@media (max-width:639px){' +
    '.kcl-cards{grid-template-columns:repeat(2,1fr)}' +
    '.kcl-card{padding:10px 12px}.kcl-card-v{font-size:21px}' +
    '.kcl-table,.kcl-table tbody,.kcl-table tr,.kcl-table td{display:block;width:100%;box-sizing:border-box}' +
    '.kcl-table thead{display:none}' +
    '.kcl-table-host{border:0;overflow:visible}' +
    '.kcl-table tbody tr{border:1px solid var(--kore-border,#e5e7eb);border-radius:10px;margin-bottom:10px;padding:6px 0;' +
      'background:var(--kore-surface,#fff)}' +
    '.kcl-table tbody tr.soon{border-color:#fca5a5}.kcl-table tbody tr.expired{border-color:#ef4444}' +
    '.kcl-table td{border:0;padding:7px 14px;display:flex;gap:10px;align-items:flex-start;font-size:13px}' +
    '.kcl-table td::before{content:attr(data-label);flex:0 0 74px;color:var(--kore-text-2,#6b7280);font-size:11px;padding-top:2px}' +
    '.kcl-table td.kcl-detail{padding:10px 14px}' +
    '.kcl-table td.kcl-detail::before{content:none}' +
    '.kcl-ops .kcl-btn{min-height:44px;flex:1}' +
    '.kcl-head .kcl-btn{min-height:44px}' +
    '}';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function fresh() {
    return { root: null, status: null, cardsHost: null, tableHost: null, gen: 0, destroyed: true,
      loaded: false, loading: false, certs: [], bindings: [], tasks: [], expiring: null,
      error: '', detailOf: '', detail: null, detailError: '', detailLoading: false, clickHandler: null };
  }
  var S = fresh();
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function decode(res, raw) {
    var data = {};
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
    if (!res.ok) {
      var err = new Error((data.code ? data.code + '：' : '') +
        (data.message || ('请求失败（HTTP ' + res.status + '）')));
      err.code = data.code || '';
      err.hint = data.hint || '';
      throw err;
    }
    return data;
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(API + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) { return res.text().then(function (raw) { return decode(res, raw); }); });
  }
  function request(url, method, body) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var init = { method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Kore-CSRF': token } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) { return res.text().then(function (raw) { return decode(res, raw); }); });
  }
  function errText(err) {
    return err && err.hint ? err.message + '｜' + err.hint : (err ? err.message : '未知错误');
  }
  function setStatus(text, tone) {
    if (!S.status) return;
    S.status.textContent = text || '';
    S.status.className = 'kcl-status ' + (tone === 'fail' ? 'fail' : tone === 'ok' ? 'ok' : 'muted');
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = el('style'); s.id = CSS_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  function navigate(hash) {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      window.KoreShell.navigate(hash);
    } else if (window.location) {
      window.location.hash = hash;
    }
  }
  // ---- 数据关联：证书 → 站点 / 自动续期任务 ----
  function sitesFor(domain) {
    var hit = [];
    (S.bindings || []).forEach(function (b) {
      if (b.cert === domain) hit.push(b);
    });
    return hit;
  }
  function autoRenewFor(domain) {
    var found = null;
    (S.tasks || []).forEach(function (t) {
      if (t.name === domain || (t.name && t.name.indexOf(domain) !== -1)) found = t;
    });
    return found;
  }
  function daysOf(c) { return typeof c.days_left === 'number' ? c.days_left : null; }
  function severity(c) {
    var d = daysOf(c);
    if (c.expired || (d !== null && d < 0)) return 'expired';
    if (c.expiring_soon || (d !== null && d <= 30)) return 'soon';
    return 'ok';
  }
  function sortedCerts() {
    return (S.certs || []).slice().sort(function (a, b) {
      var da = Date.parse(a.not_after || ''), db = Date.parse(b.not_after || '');
      var va = isNaN(da) ? Infinity : da, vb = isNaN(db) ? Infinity : db;
      return va - vb; // 无法解析有效期（如解析失败条目）沉底，不伪装成最早过期
    });
  }
  // ---- 概览卡 ----
  function card(host, key, value, hint, tone) {
    var c = add(host, el('div', 'kcl-card'));
    add(c, el('div', 'kcl-card-k', key));
    add(c, el('div', 'kcl-card-v' + (tone ? ' ' + tone : ''), value));
    if (hint) add(c, el('div', 'kcl-card-hint', hint));
  }
  function paintCards() {
    if (!S.cardsHost) return;
    S.cardsHost.textContent = '';
    var total = S.certs.length, soon = 0, expired = 0, auto = 0;
    S.certs.forEach(function (c) {
      var lv = severity(c);
      if (lv === 'soon') soon++;
      if (lv === 'expired') expired++;
      if (autoRenewFor(c.domain)) auto++;
    });
    card(S.cardsHost, '证书总数', total, '本机已纳入管理的证书');
    card(S.cardsHost, '即将过期', soon, '30 天内到期', soon ? 'warn' : 'good');
    card(S.cardsHost, '已过期', expired, '需要立即处理', expired ? 'fatal' : 'good');
    card(S.cardsHost, '自动续期开启', auto, '内核定时任务已登记', auto ? 'good' : '');
  }
  // ---- 证书表 ----
  function cell(tr, label, cls) {
    var td = add(tr, el('td', cls || ''));
    td.setAttribute('data-label', label);
    return td;
  }
  function paintTable() {
    if (!S.tableHost) return;
    S.tableHost.textContent = '';
    if (!S.certs.length) {
      var empty = add(S.tableHost, el('div', 'kcl-empty'));
      add(empty, el('h3', 'kcl-empty-title', '还没有证书'));
      add(empty, el('p', 'kcl-empty-text',
        '证书到期会导致网站 HTTPS 告警。先签发一张证书，它就会出现在这里，临近过期会自动标红提醒。'));
      add(empty, el('button', 'kcl-btn kcl-btn-primary', '去签发证书'))
        .setAttribute('data-act', 'goto-ssl');
      return;
    }
    var host = add(S.tableHost, el('div', 'kcl-table-host'));
    var table = add(host, el('table', 'kcl-table'));
    table.setAttribute('aria-label', '证书生命周期列表，按到期时间从早到晚排序');
    var htr = add(add(table, el('thead')), el('tr'));
    ['域名', '颁发者', '过期倒计时', '绑定站点', '自动续期', '快捷操作'].forEach(function (label) {
      add(htr, el('th', null, label));
    });
    var body = add(table, el('tbody'));
    sortedCerts().forEach(function (c) {
      var lv = severity(c);
      var tr = add(body, el('tr', 'kcl-row' + (lv === 'expired' ? ' expired' : lv === 'soon' ? ' soon' : '')));
      tr.setAttribute('data-domain', c.domain || '');
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', '查看 ' + (c.domain || '证书') + ' 详情');
      var domain = cell(tr, '域名');
      add(domain, el('span', 'kcl-domain', c.domain || '—'));
      if (c.error) add(domain, el('div', 'kcl-muted', '解析失败：' + c.error));
      var src = [];
      if (c.self_signed) src.push('自签');
      else if (c.source) src.push(c.source);
      if (src.length) add(domain, el('span', 'kcl-pill', src.join(' · ')));
      cell(tr, '颁发者', '').textContent = c.issuer || '—';
      var dayCell = cell(tr, '过期倒计时');
      var d = daysOf(c);
      var dtone = lv === 'expired' || lv === 'soon' ? ' fatal' : d !== null && d <= 60 ? ' warn' : '';
      add(dayCell, el('span', 'kcl-days' + dtone,
        d === null ? '有效期未知' : d < 0 ? '已过期 ' + Math.abs(d) + ' 天' : '剩余 ' + d + ' 天'));
      add(dayCell, el('div', 'kcl-muted', c.not_after ? '至 ' + fmtTime(c.not_after) : '—'));
      var siteCell = cell(tr, '绑定站点');
      var binds = sitesFor(c.domain);
      if (!binds.length) add(siteCell, el('span', 'kcl-muted', '未绑定'));
      else binds.forEach(function (b) {
        var tag = add(siteCell, el('span', 'kcl-pill' + (b.cert_exists ? '' : ' off'), b.site || '—'));
        tag.title = b.cert_exists ? '归属已登记' : '证书已不在目录，需重新绑定';
      });
      var autoCell = cell(tr, '自动续期');
      var task = autoRenewFor(c.domain);
      if (task) {
        add(autoCell, el('span', 'kcl-pill ok', '已开启'));
        if (task.next_run_at) add(autoCell, el('div', 'kcl-muted', '下次 ' + fmtTime(task.next_run_at)));
      } else {
        add(autoCell, el('span', 'kcl-pill off', '未开启'));
      }
      var ops = cell(tr, '快捷操作');
      var opBox = add(ops, el('div', 'kcl-ops'));
      var renew = add(opBox, el('button', 'kcl-btn', '续期'));
      renew.setAttribute('data-act', 'renew');
      renew.setAttribute('data-domain', c.domain || '');
      var unbind = add(opBox, el('button', 'kcl-btn kcl-btn-danger', '解绑'));
      unbind.setAttribute('data-act', 'unbind');
      unbind.setAttribute('data-domain', c.domain || '');
      unbind.disabled = !binds.length;
      if (S.detailOf === c.domain) add(body, detailRow(c, body));
    });
  }
  // ---- 展开详情：SAN 取 list.domains，指纹/链/序列取 verify ----
  function detailRow(c, tbody) {
    var tr = add(tbody, el('tr', 'kcl-detail'));
    var td = add(tr, el('td'));
    td.colSpan = 6;
    var grid = add(td, el('div', 'kcl-detail-grid'));
    function item(k, v) {
      var box = add(grid, el('div', 'kcl-detail-item'));
      add(box, el('div', 'kcl-detail-k', k));
      add(box, el('div', 'kcl-detail-v' + (/指纹|序列|SHA/.test(k) ? ' kcl-mono' : ''), v));
    }
    item('SAN / 全部域名', (c.domains && c.domains.length ? c.domains.join(', ') : (c.domain || '—')));
    item('有效期', (c.not_before ? fmtTime(c.not_before) + ' → ' : '') + (c.not_after ? fmtTime(c.not_after) : '—'));
    item('证书文件', c.file || '—');
    item('公钥', [c.key_type, c.key_bits].filter(Boolean).join(' ') || '—');
    if (S.detailLoading) {
      add(td, el('div', 'kcl-muted', '正在读取证书指纹与链信息（真实 TLS 握手校验）…'));
    } else if (S.detail && S.detailError) {
      add(td, el('div', 'kcl-status fail', '详情读取失败：' + S.detailError));
    } else if (S.detail) {
      var v = S.detail;
      item('指纹 SHA-256', v.fingerprint_sha256 || '—');
      item('证书链', typeof v.chain_length === 'number' ? v.chain_length + ' 级（含叶子）' : '—');
      item('序列号', v.serial || '—');
      item('使用者', v.subject || '—');
      item('握手校验', v.reachable === undefined ? '—' :
        (v.reachable ? (v.matched ? '可达且域名匹配' : '可达但域名不匹配') : '不可达：' + (v.error || '连接失败')));
      add(td, el('div', 'kcl-note', '指纹与链来自 ssl.verify 的真实 TLS 握手结果；如站点尚未绑定该证书，握手信息可能为空或显示不匹配。'));
    }
    return tr;
  }
  function paint() {
    paintCards();
    paintTable();
  }
  // ---- 数据加载 ----
  function load() {
    var gen = S.gen;
    S.loading = true; S.loaded = false; S.error = '';
    setStatus('正在读取全部证书、站点绑定与自动续期任务…');
    var pList = invoke('ssl.list', {});
    var pBind = invoke('ssl.bind.list', {}).catch(function () { return { bindings: [] }; });
    var pTask = request(SCHED).catch(function () { return { tasks: [] }; });
    Promise.all([pList, pBind, pTask]).then(function (r) {
      if (S.destroyed || gen !== S.gen) return;
      S.certs = (r[0] && r[0].certs) || [];
      S.bindings = (r[1] && r[1].bindings) || [];
      S.tasks = (r[2] && r[2].tasks) || [];
      S.loading = false; S.loaded = true;
      paint();
      setStatus('共 ' + S.certs.length + ' 张证书，已按到期时间排序；30 天内到期标红',
        S.certs.length ? 'ok' : 'muted');
    }, function (err) {
      if (S.destroyed || gen !== S.gen) return;
      S.loading = false; S.error = errText(err);
      S.certs = []; paint();
      setStatus('读取证书失败：' + S.error + '。请确认 ssl 插件已加载后点「刷新」重试。', 'fail');
    });
  }
  function loadDetail(domain) {
    var gen = S.gen;
    S.detail = null; S.detailLoading = true; paint();
    invoke('ssl.verify', { domain: domain }).then(function (r) {
      if (S.destroyed || gen !== S.gen || S.detailOf !== domain) return;
      S.detail = r || {}; S.detailLoading = false; paint();
    }, function (err) {
      if (S.destroyed || gen !== S.gen || S.detailOf !== domain) return;
      S.detailError = errText(err); S.detailLoading = false; paint();
    });
  }
  // ---- 危险操作：二次确认后才发请求 ----
  function doRenew(domain) {
    if (!domain) return;
    if (!window.confirm('确认为「' + domain + '」续期？续期会重新签发证书并覆盖当前文件（插件会先备份旧证书）。')) return;
    var gen = S.gen;
    setStatus('正在续期 ' + domain + '…');
    invoke('ssl.renew', { domain: domain }).then(function (info) {
      if (S.destroyed || gen !== S.gen) return;
      if (info && info.renewed === false) {
        setStatus(domain + ' 未到续期窗口（剩余 ' + info.days_left + ' 天），未改动任何文件', 'ok');
      } else {
        setStatus('已续期 ' + domain + '，新指纹 ' + ((info && info.fingerprint_sha256) || '—'), 'ok');
      }
      load();
    }, function (err) {
      if (S.destroyed || gen !== S.gen) return;
      setStatus('续期失败：' + errText(err), 'fail');
    });
  }
  function doUnbind(domain) {
    if (!domain) return;
    var binds = sitesFor(domain);
    if (!binds.length) return;
    var names = binds.map(function (b) { return b.site || '—'; }).join('、');
    if (!window.confirm('确认解除「' + domain + '」与站点（' + names + '）的归属登记？这只删证书插件里的归属记录，不会修改网站服务器配置。')) return;
    var gen = S.gen;
    // 逐个解绑（现有 ssl.bind.remove 一次只处理一条 cert+site）。
    binds.reduce(function (p, b) {
      return p.then(function () { return invoke('ssl.bind.remove', { cert: domain, site: b.site }); });
    }, Promise.resolve()).then(function () {
      if (S.destroyed || gen !== S.gen) return;
      setStatus('已解除 ' + domain + ' 的 ' + binds.length + ' 条站点归属登记', 'ok');
      load();
    }, function (err) {
      if (S.destroyed || gen !== S.gen) return;
      setStatus('解绑失败：' + errText(err), 'fail');
    });
  }
  // ---- 事件委托：点行展开 / 按钮操作 / 键盘可达 ----
  function onClick(ev) {
    var t = ev.target;
    while (t && t !== S.root && !(t.getAttribute && t.getAttribute('data-act'))) {
      if (t.getAttribute && t.getAttribute('data-domain') && t.classList && t.classList.contains('kcl-row')) break;
      t = t.parentNode;
    }
    if (!t || t === S.root) return;
    var act = t.getAttribute && t.getAttribute('data-act');
    var domain = t.getAttribute && t.getAttribute('data-domain');
    if (act === 'goto-ssl') { navigate('#ssl'); return; }
    if (act === 'refresh') { load(); return; }
    if (act === 'renew') { ev.stopPropagation(); doRenew(domain); return; }
    if (act === 'unbind') { ev.stopPropagation(); doUnbind(domain); return; }
    if (t.classList && t.classList.contains('kcl-row')) {
      S.detailOf = S.detailOf === domain ? '' : domain;
      S.detail = null; S.detailError = ''; S.detailLoading = false;
      if (S.detailOf) loadDetail(domain);
      paint();
    }
  }
  function onKey(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var t = ev.target;
    if (t && t.classList && t.classList.contains('kcl-row')) {
      ev.preventDefault();
      onClick(ev);
    }
  }
  function build() {
    var root = S.root = el('section', 'kcl');
    root.id = 'kore-certlife';
    var head = add(root, el('div', 'kcl-head'));
    add(head, el('h2', null, '证书看板'));
    add(head, el('p', 'kcl-sub',
      '所有已签发证书按到期时间排序，30 天内到期或已过期会自动标红。点证书展开指纹、SAN 与证书链；续期和解绑都需二次确认。'));
    add(head, el('button', 'kcl-btn', '刷新')).setAttribute('data-act', 'refresh');
    S.status = add(root, el('div', 'kcl-status muted'));
    S.status.setAttribute('role', 'status');
    S.cardsHost = add(root, el('div', 'kcl-cards'));
    add(root, el('div', 'kcl-note',
      '「即将过期」按剩余 30 天统计；自动续期状态来自内核已登记的定时任务。'));
    S.tableHost = add(root, el('div', 'kcl-tablehost'));
  }
  function destroy() {
    S.destroyed = true;
    S.gen++;
    if (S.root && S.clickHandler) {
      try { S.root.removeEventListener('click', S.clickHandler); } catch (e) {}
      try { S.root.removeEventListener('keydown', onKey); } catch (e) {}
    }
    if (S.root && S.root.parentNode) {
      try { S.root.parentNode.removeChild(S.root); } catch (e) {}
    }
    S.root = null; S.clickHandler = null; S.status = null;
    S.cardsHost = null; S.tableHost = null;
    S.certs = []; S.bindings = []; S.tasks = [];
    S.detail = null; S.detailError = ''; S.detailOf = ''; S.detailLoading = false;
    S.loading = false; S.loaded = false;
  }
  function render(container) {
    if (!container) return null;
    if (!S.destroyed && S.root && S.root.parentNode === container) {
      paint();
      if (!S.loading && !S.loaded) load();
      return { destroy: destroy };
    }
    destroy();
    S = fresh();
    S.destroyed = false;
    S.gen++;
    build();
    container.appendChild(S.root);
    injectCss();
    S.clickHandler = onClick;
    S.root.addEventListener('click', S.clickHandler);
    S.root.addEventListener('keydown', onKey);
    paint();
    load();
    return { destroy: destroy };
  }
  window.KoreCertLifecycle = { render: render, destroy: destroy };
})();
