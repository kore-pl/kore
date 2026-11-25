/* kore 主壳 · 账户与安全中心（web/user-center.js）
   —— 把散在 设置→安全（security.js / 两步验证 / API 令牌 / 登录白名单）与账户口令
   里的东西收拢成一页：先回答"我的账号现在安全吗"，再给下一步动作。

   ===== 四块内容（对应任务卡 1-4）=====
   1. 账户状态总览：口令强度 + 上次修改、两步验证（含恢复码剩余）、API 令牌数量与最近使用、
      登录 IP 白名单是否启用、活跃会话数、最近登录与异常标记。
   2. 会话管理：列出活跃会话（登录时间 / 来源 IP / UA 摘要 / 最后活跃），可单独踢下线，
      也可"一键全踢（保留当前）"——当前会话永远踢不掉，退出当前登录请用「退出登录」。
   3. 登录记录：最近成功/失败记录（时间 / 网段 / 结果 / 原因），异常显著标记：
      new_network（30 天内首次出现的网段）/ fail_burst（同网段 ≥3 次失败）/ rate_limited。
      注意：审计只存**脱敏网段**（192.168.1.x），所以界面上写"网段"而不是"IP"。
   4. 快捷动作：改口令（本页内联弹层，带强度提示）、开启/关闭两步验证、生成令牌、
      管理白名单、退出登录——后四项跳到设置→安全 tab（security.js 仍那块的真源，不重复实现）。

   ===== 数据源（全部复用后端既有/本轮新增的只读或安全端点）=====
   GET    /api/v1/security/overview              账户状态总览
   GET    /api/v1/security/sessions              活跃会话
   DELETE /api/v1/security/sessions/{id}         踢单个会话
   POST   /api/v1/security/sessions/revoke-others 一键全踢（保留当前）
   GET    /api/v1/security/login-records         登录记录（审计流派生）
   POST   /api/v1/auth/password                  改口令（既有端点）
   POST   /api/v1/auth/logout                    退出登录（既有端点）

   ===== 工程约束 =====
   · 零框架 / 零 CDN / 零外链；懒加载视图，不进首屏六件套、不计首屏 gzip 预算（FRONTEND §7）。
   · 零轮询（G-19）：只有用户点「刷新」或本级首次进入时取一次数；没有 setInterval。
   · 写请求带 X-Kore-CSRF 双提交头；口令只活在内存，关窗即清（G-30）。
   · 手机适配（裁决41）：640px 以下卡片单列、表格变卡片式、触摸目标 ≥44px。
   · 对外只暴露 window.KoreUserCenter.render(container) → { destroy }。 */
(function () {
  'use strict';

  var EP = {
    overview: '/api/v1/security/overview',
    sessions: '/api/v1/security/sessions',
    revokeOthers: '/api/v1/security/sessions/revoke-others',
    loginRecords: '/api/v1/security/login-records?limit=50&days=30',
    password: '/api/v1/auth/password',
    logout: '/api/v1/auth/logout'
  };
  var TIMEOUT = 8000;
  var STYLE_ID = 'kore-user-center-style';
  var PW_MIN_LEN = 12;
  var S = {
    box: null, gen: 0, busy: false,
    overview: null, sessions: [], records: [], ipMasked: true,
    dialog: null, listError: ''
  };

  var CSS = [
    '.uc-head{display:flex;align-items:flex-start;flex-wrap:wrap;gap:6px 14px;margin-bottom:4px}',
    '.uc-title{margin:0;font-size:20px;font-weight:600}',
    '.uc-sub{font-size:12px;line-height:1.7;color:var(--kore-text-3);max-width:760px}',
    '.uc-head .btn{margin-left:auto;min-height:44px}',
    '.uc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:14px 0}',
    '.uc-card{border:1px solid var(--kore-border-2);border-radius:10px;background:var(--kore-bg-1);padding:14px 16px;display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.uc-card-title{font-size:13px;color:var(--kore-text-3);display:flex;align-items:center;gap:6px}',
    '.uc-card-value{font-size:19px;font-weight:600;color:var(--kore-text-1);word-break:break-word}',
    '.uc-card-desc{font-size:12px;color:var(--kore-text-2);line-height:1.6;word-break:break-word}',
    '.uc-card-act{margin-top:auto;padding-top:6px}',
    '.uc-card-act .btn{min-height:40px;padding:0 12px;font-size:13px}',
    '.uc-ok{color:var(--kore-success)}',
    '.uc-warn{color:var(--kore-warning)}',
    '.uc-bad{color:var(--kore-danger)}',
    '.uc-muted{color:var(--kore-text-3)}',
    '.uc-actions{display:flex;flex-wrap:wrap;gap:10px;margin:4px 0 16px}',
    '.uc-actions .btn{min-height:44px;padding:0 16px}',
    '.uc-sec{margin-bottom:18px}',
    '.uc-sec-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}',
    '.uc-sec-title{margin:0;font-size:16px;font-weight:600}',
    '.uc-sec-desc{font-size:12px;color:var(--kore-text-3);line-height:1.6}',
    '.uc-sec-head .btn{margin-left:auto;min-height:44px}',
    '.uc-tbl-wrap{overflow-x:auto;border:1px solid var(--kore-border-2);border-radius:10px;background:var(--kore-bg-1)}',
    '.uc-tbl{width:100%;border-collapse:collapse;font-size:13px}',
    '.uc-tbl th,.uc-tbl td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--kore-border-2);vertical-align:top;word-break:break-word}',
    '.uc-tbl th{font-size:12px;font-weight:600;color:var(--kore-text-3);background:var(--kore-bg-0);white-space:nowrap}',
    '.uc-tbl tr:last-child td{border-bottom:0}',
    '.uc-tbl .uc-num{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.uc-tbl .uc-ua{max-width:280px;color:var(--kore-text-2);font-size:12px}',
    '.uc-rowact{white-space:nowrap}',
    '.uc-rowact .btn{min-height:36px;padding:0 10px;font-size:12px}',
    '.uc-flag{display:inline-block;margin:2px 4px 2px 0;padding:1px 7px;border-radius:10px;font-size:11px;line-height:18px;background:var(--kore-bg-0);color:var(--kore-text-2);border:1px solid var(--kore-border-2)}',
    '.uc-flag-warn{color:var(--kore-warning);border-color:currentColor}',
    '.uc-flag-bad{color:var(--kore-danger);border-color:currentColor}',
    '.uc-flag-cur{color:var(--kore-info);border-color:currentColor}',
    '.uc-result-ok{color:var(--kore-success);font-weight:600}',
    '.uc-result-bad{color:var(--kore-danger);font-weight:600}',
    '.uc-empty{padding:26px 16px;text-align:center}',
    '.uc-empty .empty-state-text{margin-bottom:12px}',
    '.uc-empty .btn{min-height:44px}',
    '.uc-hint{font-size:12px;color:var(--kore-text-3);line-height:1.7;margin:8px 0 0}',
    '.uc-err{padding:16px;border:1px solid var(--kore-danger);border-radius:10px;background:var(--kore-bg-1)}',
    '.uc-err-text{margin:0 0 10px;font-size:13px;color:var(--kore-text-1);line-height:1.7}',
    '.uc-err .btn{min-height:44px}',
    '.uc-loading{padding:26px 16px;text-align:center;color:var(--kore-text-3);font-size:13px}',
    '.uc-backdrop{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px}',
    '.uc-dialog{width:min(520px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--kore-bg-1);border:1px solid var(--kore-border-2);border-radius:12px;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.35)}',
    '.uc-dialog h3{margin:0 0 6px;font-size:17px}',
    '.uc-dialog ul{margin:0 0 12px;padding-left:18px;font-size:12px;color:var(--kore-text-2);line-height:1.8}',
    '.uc-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}',
    '.uc-field label{font-size:13px;color:var(--kore-text-2)}',
    '.uc-field input{min-height:44px;padding:8px 10px;border:1px solid var(--kore-border-2);border-radius:8px;background:var(--kore-bg-0);color:var(--kore-text-1);font-size:14px}',
    '.uc-meter{display:flex;gap:4px;margin-top:6px}',
    '.uc-meter i{flex:1;height:6px;border-radius:3px;background:var(--kore-bg-0);border:1px solid var(--kore-border-2)}',
    '.uc-meter i.on-weak{background:var(--kore-danger)}',
    '.uc-meter i.on-mid{background:var(--kore-warning)}',
    '.uc-meter i.on-good{background:var(--kore-success)}',
    '.uc-dialog-hint{font-size:12px;line-height:1.7;color:var(--kore-text-3);min-height:18px;margin:2px 0 10px}',
    '.uc-dialog-hint.err{color:var(--kore-danger)}',
    '.uc-dialog-hint.ok{color:var(--kore-success)}',
    '.uc-dialog-ops{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}',
    '.uc-dialog-ops .btn{min-height:44px;padding:0 16px}',
    '@media (max-width:1023px){.uc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '@media (max-width:640px){',
    '.uc-grid{grid-template-columns:1fr}',
    '.uc-head .btn{margin-left:0;width:100%}',
    '.uc-tbl-wrap{border:0;background:transparent;overflow:visible}',
    '.uc-tbl thead{display:none}',
    '.uc-tbl,.uc-tbl tbody,.uc-tbl tr,.uc-tbl td{display:block;width:100%}',
    '.uc-tbl tr{border:1px solid var(--kore-border-2);border-radius:10px;background:var(--kore-bg-1);margin-bottom:10px;padding:6px 4px}',
    '.uc-tbl td{border:0;padding:6px 12px;display:flex;gap:10px;justify-content:space-between}',
    '.uc-tbl td::before{content:attr(data-label);flex:none;color:var(--kore-text-3);font-size:12px}',
    '.uc-tbl td.uc-td-plain{display:block}',
    '.uc-tbl td.uc-td-plain::before{display:block;margin-bottom:2px}',
    '.uc-tbl .uc-ua{max-width:none}',
    '.uc-dialog-ops .btn{flex:1}',
    '}'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function button(label, cls) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    return b;
  }
  function stale(gen) { return gen !== S.gen || !S.box; }
  function csrf() {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf('kore_csrf=') === 0) return decodeURIComponent(kv.slice('kore_csrf='.length));
    }
    return '';
  }
  function request(url, method, body) {
    var headers = { 'Accept': 'application/json' };
    var verb = method || 'GET';
    var init = { method: verb, credentials: 'same-origin', cache: 'no-store', headers: headers };
    // 写请求必须带双提交头——**不看有没有 body**：DELETE（踢下线）同样要过 withCSRF，
    // 只在带 body 时才加头会让「踢下线」一律 401 CSRF 校验失败。
    if (verb !== 'GET' && verb !== 'HEAD') {
      var token = csrf();
      if (token) headers['X-Kore-CSRF'] = token;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = null;
    if (ctrl) { init.signal = ctrl.signal; timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT); }
    return fetch(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (raw) {
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        return { ok: res.ok, status: res.status, data: data };
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }
  function msgOf(res, fallback) {
    if (res && res.data && res.data.message) return String(res.data.message);
    if (res && res.status === 401) return '登录状态已失效，请重新登录后再试。';
    if (res && res.status === 501) return '当前内核版本还没有这个能力，请升级内核后重试。';
    return fallback || '操作未完成，请稍后重试';
  }

  // 时间显示：本地时区 YYYY-MM-DD HH:mm；空值显示「未知」。
  function fmtTime(iso) {
    if (!iso) return '未知';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '未知';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  // 相对时间：最后活跃/登录用它更直观（分钟级，与后端 5 分钟节流粒度一致）。
  function fmtAgo(iso) {
    if (!iso) return '未知';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '未知';
    var diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 0) return fmtTime(iso);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    return fmtTime(iso);
  }
  function uaSummary(ua) {
    if (!ua) return '未知浏览器';
    var text = String(ua);
    // 只留"像浏览器"的片段，避免把整串 UA 塞进手机屏：Chrome / Firefox / Safari / Edge 等。
    var m = text.match(/(Edg|Chrome|Firefox|Safari|OPR|MicroMessenger|curl|Wget)[\/ ]?([0-9.]+)?/);
    var os = text.match(/(Windows NT [0-9.]+|Mac OS X [0-9_.]+|Android [0-9.]+|iPhone OS [0-9_]+|Linux)/);
    var out = m ? m[1] + (m[2] ? ' ' + m[2] : '') : text.slice(0, 24);
    if (os) out += ' · ' + os[1].replace(/_/g, '.');
    return out.length > 60 ? out.slice(0, 60) + '…' : out;
  }
  function gotoSettingTab(tab) {
    // 既有约定（settings.js 读取该标记并切到对应 tab）；不改 settings.js。
    try { window.__koreSettingsTab = tab; } catch (e) { /* 标记写不进去也不影响跳转 */ }
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      window.KoreShell.navigate('settings/settings');
      return;
    }
    window.location.hash = '#/settings/settings';
  }
  function backToLogin() {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      window.KoreShell.navigate('/');
      return;
    }
    window.location.assign('/');
  }

  /* ===== 渲染骨架 ===== */
  function render(box) {
    injectStyle();
    S.box = box;
    S.gen++;
    S.busy = false;
    box.textContent = '';
    var gen = S.gen;

    var head = add(box, el('div', 'uc-head'));
    add(head, el('h2', 'uc-title', '账户中心'));
    var refresh = button('刷新', 'btn-ghost');
    refresh.setAttribute('data-kore-action', 'uc-refresh');
    refresh.addEventListener('click', function () { load(gen, true); });
    add(head, refresh);
    add(box, el('p', 'uc-sub',
      '这里回答一个问题：我的管理账号现在安全吗。口令、两步验证、API 令牌、登录白名单、' +
      '活跃会话与登录记录都在这一页；改口令和踢下线也在这一页完成。具体配置项仍在「常规设置」里改。'));

    var body = add(box, el('div', 'uc-body'));
    load(gen, false);

    var handle = {
      destroy: function () {
        S.gen++;
        closeDialog();
        S.box = null;
        S.busy = false;
      }
    };
    return handle;

    function load(wantGen, manual) {
      if (stale(wantGen)) return;
      if (S.busy) return;
      S.busy = true;
      body.textContent = '';
      add(body, el('div', 'uc-loading', manual ? '正在刷新…' : '正在读取账户安全状态…'));
      Promise.all([
        request(EP.overview),
        request(EP.sessions),
        request(EP.loginRecords)
      ]).then(function (results) {
        if (stale(wantGen)) return;
        S.busy = false;
        var ov = results[0], ss = results[1], lr = results[2];
        if (!ov.ok) {
          renderError(ov, gen);
          return;
        }
        S.overview = ov.data || null;
        S.sessions = (ss.ok && ss.data && Array.isArray(ss.data.sessions)) ? ss.data.sessions : [];
        S.listError = ss.ok ? '' : msgOf(ss, '会话列表读取失败');
        if (lr.ok && lr.data) {
          S.records = Array.isArray(lr.data.records) ? lr.data.records : [];
          S.ipMasked = lr.data.ipMasked !== false;
        } else {
          S.records = [];
          S.ipMasked = true;
        }
        paint(gen, lr);
      }, function () {
        if (stale(wantGen)) return;
        S.busy = false;
        renderError({ status: 0, data: null }, gen);
      });
    }

    function renderError(res, wantGen) {
      body.textContent = '';
      var box2 = add(body, el('div', 'uc-err'));
      add(box2, el('p', 'uc-err-text', msgOf(res, '读取账户安全状态失败')));
      var retry = button('重试', 'btn-primary');
      retry.addEventListener('click', function () { load(wantGen, true); });
      add(box2, retry);
      if (res && res.status === 401) {
        var relogin = button('重新登录', 'btn-ghost');
        relogin.addEventListener('click', backToLogin);
        add(box2, relogin);
      }
    }

    function paint(wantGen, lrRes) {
      body.textContent = '';
      paintCards(body, wantGen);
      paintActions(body);
      paintSessions(body, wantGen);
      paintRecords(body, lrRes);
    }
  }

  /* ===== 1. 账户状态总览 ===== */
  function paintCards(box, gen) {
    var ov = S.overview || {};
    var pw = ov.password || {};
    var tf = ov.twoFactor || {};
    var tk = ov.tokens || {};
    var ip = ov.ipAllow || {};
    var sess = ov.sessions || {};
    var login = ov.login || {};
    var grid = add(box, el('div', 'uc-grid'));

    // 口令：强度未知时明确说"未评估"，并给出一次评估入口。
    var pwTone = pw.score >= 3 ? 'uc-ok' : pw.score >= 2 ? 'uc-warn' : pw.score === 0 ? 'uc-bad' : 'uc-muted';
    var pwDesc = pw.score === 0 ? '偏弱，建议换成 14 位以上、字母+数字+符号的组合'
      : pw.score === 1 ? '较弱，建议加长并混用大小写/数字/符号'
      : pw.score === 2 ? '一般，还可以更长或加入符号'
      : pw.score >= 3 ? '强度够用' : '还没评估过：下次改口令时会自动评估';
    card(grid, '管理员口令', pw.label || '未评估', pwTone, [
      ['上次修改', pw.changedAt ? fmtTime(pw.changedAt) : '未知（未在本面板改过）'],
      ['强度说明', pwDesc],
      ['存储方式', (pw.hashAlgorithm || 'PBKDF2') + (pw.hashIterations ? ' / ' + pw.hashIterations + ' 次' : '')]
    ], { label: '改口令', act: function () { openPasswordDialog(); } });

    card(grid, '两步验证', tf.enabled ? '已开启' : '未开启',
      tf.enabled ? 'uc-ok' : 'uc-warn', [
        ['恢复码剩余', tf.enabled ? (tf.recoveryCodesLeft + ' 个') : '—'],
        ['开启时间', tf.enabled ? fmtTime(tf.createdAt) : '—'],
        ['作用', '登录时除口令外再要一次手机验证码']
      ], { label: tf.enabled ? '管理两步验证' : '开启两步验证', act: function () { gotoSettingTab('security'); } });

    card(grid, 'API 令牌', (tk.count || 0) + ' 个', tk.count > 0 ? 'uc-ok' : 'uc-muted', [
      ['最近使用', tk.lastUsedAt ? fmtAgo(tk.lastUsedAt) : '从未使用'],
      ['用途', '给脚本/CLI 用的免页面登录凭证'],
      ['建议', tk.count > 0 ? '不用时及时吊销，尤其 read 令牌' : '不需要脚本访问就不用生成']
    ], { label: '生成令牌', act: function () { gotoSettingTab('security'); } });

    card(grid, '登录白名单', ip.enabled ? '已开启' : '未开启',
      ip.enabled ? 'uc-ok' : 'uc-muted', [
        ['允许网段', ip.enabled ? (ip.count + ' 条') : '不限（任意来源可尝试登录）'],
        ['开启后', '不在列表里的来源连口令都不校验'],
        ['建议', ip.enabled ? '换网络前先确认新网段已加入' : '有固定出口 IP 时建议开启']
      ], { label: '管理白名单', act: function () { gotoSettingTab('security'); } });

    card(grid, '活跃登录', (sess.active || 0) + ' 处', (sess.active || 0) > 1 ? 'uc-warn' : 'uc-ok', [
      ['当前设备', '已标记为本机这一处'],
      ['其它设备', (sess.active || 0) > 1 ? ((sess.active - 1) + ' 处可踢下线') : '无'],
      ['建议', (sess.active || 0) > 1 ? '不是自己登录的就踢掉' : '只有当前这一处登录']
    ], { label: '查看会话', act: function () { scrollToSec('uc-sessions'); } });

    card(grid, '最近登录', login.lastSuccessAt ? fmtAgo(login.lastSuccessAt) : '暂无记录',
      login.suspicious ? 'uc-warn' : 'uc-ok', [
        ['来源', login.lastSuccessIp ? (login.lastSuccessIp + (S.ipMasked ? '（网段）' : '')) : '—'],
        ['24 小时内失败', (login.failures24h || 0) + ' 次'],
        ['异常', login.suspicious ? (login.suspiciousReason || '有异常') : '未发现异常']
      ], { label: '看登录记录', act: function () { scrollToSec('uc-login-records'); } });
  }

  function card(grid, title, value, tone, rows, action) {
    var c = add(grid, el('div', 'uc-card'));
    add(c, el('div', 'uc-card-title', title));
    add(c, el('div', 'uc-card-value' + (tone ? ' ' + tone : ''), value));
    for (var i = 0; i < rows.length; i++) {
      var line = el('div', 'uc-card-desc');
      line.appendChild(el('span', 'uc-muted', rows[i][0] + '：'));
      line.appendChild(document.createTextNode(rows[i][1] || '—'));
      add(c, line);
    }
    if (action) {
      var act = add(c, el('div', 'uc-card-act'));
      var b = button(action.label, 'btn-ghost');
      b.addEventListener('click', action.act);
      add(act, b);
    }
  }

  /* ===== 4. 快捷动作 ===== */
  function paintActions(box) {
    var actions = add(box, el('div', 'uc-actions'));
    var specs = [
      ['改口令', 'btn-primary', function () { openPasswordDialog(); }],
      ['开启/关闭两步验证', 'btn-ghost', function () { gotoSettingTab('security'); }],
      ['生成 API 令牌', 'btn-ghost', function () { gotoSettingTab('security'); }],
      ['管理登录白名单', 'btn-ghost', function () { gotoSettingTab('security'); }],
      ['退出登录', 'btn-ghost', function () { gotoSettingTab('security'); }]
    ];
    for (var i = 0; i < specs.length; i++) {
      (function (spec) {
        var b = button(spec[0], spec[1]);
        b.addEventListener('click', spec[2]);
        add(actions, b);
      })(specs[i]);
    }
  }

  function scrollToSec(id) {
    var node = document.getElementById(id);
    if (node && node.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ===== 2. 会话管理 ===== */
  function paintSessions(box, gen) {
    var sec = add(box, el('section', 'uc-sec'));
    sec.id = 'uc-sessions';
    var head = add(sec, el('div', 'uc-sec-head'));
    add(head, el('h3', 'uc-sec-title', '活跃登录（会话）'));
    add(head, el('span', 'uc-sec-desc',
      '每一行是一处已登录的设备或浏览器；「最后活跃」精确到约 5 分钟。'));
    var others = S.sessions.filter(function (s) { return !s.current; }).length;
    if (others > 0) {
      var kickAll = button('一键全踢（保留当前）', 'btn-ghost');
      kickAll.addEventListener('click', function () { revokeOthers(kickAll, gen); });
      add(head, kickAll);
    }

    if (S.listError) {
      var errBox = add(sec, el('div', 'uc-empty empty-state'));
      add(errBox, el('p', 'empty-state-text', S.listError));
      var retry = button('重试', 'btn-primary');
      retry.addEventListener('click', function () { if (S.box) S.box.textContent = ''; });
      retry.addEventListener('click', function () { reloadAll(gen); });
      add(errBox, retry);
      return;
    }
    if (!S.sessions.length) {
      var empty = add(sec, el('div', 'uc-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '还没有可显示的登录会话（可能是刚刚重启过内核）。'));
      var go = button('回到页面顶部刷新', 'btn-primary');
      go.addEventListener('click', function () { reloadAll(gen); });
      add(empty, go);
      return;
    }

    var wrap = add(sec, el('div', 'uc-tbl-wrap'));
    var tbl = add(wrap, el('table', 'uc-tbl'));
    var thead = add(tbl, el('thead'));
    var hr = add(thead, el('tr'));
    ['登录时间', '来源', '设备', '最后活跃', '到期时间', '操作'].forEach(function (t) {
      add(hr, el('th', null, t));
    });
    var tbody = add(tbl, el('tbody'));
    for (var i = 0; i < S.sessions.length; i++) {
      (function (s) {
        var tr = add(tbody, el('tr'));
        td(tr, '登录时间', fmtTime(s.createdAt), 'uc-num');
        var ipCell = td(tr, '来源', s.ip || '本机通道', 'uc-num');
        if (s.current) add(ipCell, el('span', 'uc-flag uc-flag-cur', '当前'));
        td(tr, '设备', uaSummary(s.userAgent), 'uc-ua');
        td(tr, '最后活跃', fmtAgo(s.lastSeenAt), 'uc-num');
        td(tr, '到期时间', fmtTime(s.expiresAt), 'uc-num');
        var opTd = td(tr, '操作', '', 'uc-rowact');
        if (s.current) {
          add(opTd, el('span', 'uc-muted', '当前会话'));
        } else {
          var kick = button('踢下线', 'btn-ghost');
          kick.addEventListener('click', function () { revokeOne(s, kick, gen); });
          add(opTd, kick);
        }
      })(S.sessions[i]);
    }
    add(sec, el('p', 'uc-hint',
      '踢下线会立即让那台设备退出登录，它下次操作需要重新输入口令。当前这一处不会被踢——' +
      '要退出当前登录，请用「退出登录」。'));
  }

  function td(tr, label, text, cls) {
    var cell = el('td', cls + (cls && cls.indexOf('uc-ua') === 0 ? ' uc-td-plain' : ''));
    cell.setAttribute('data-label', label);
    if (text) cell.appendChild(document.createTextNode(text));
    tr.appendChild(cell);
    return cell;
  }

  function revokeOne(sess, btn, gen) {
    btn.disabled = true;
    btn.textContent = '正在踢…';
    request(EP.sessions + '/' + encodeURIComponent(sess.id), 'DELETE').then(function (res) {
      if (stale(gen)) return;
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = '踢下线';
        toast(msgOf(res, '踢下线失败'));
        return;
      }
      reloadAll(gen);
    }, function () {
      if (stale(gen)) return;
      btn.disabled = false;
      btn.textContent = '踢下线';
      toast('网络异常，踢下线未完成，请重试');
    });
  }

  function revokeOthers(btn, gen) {
    btn.disabled = true;
    btn.textContent = '正在踢…';
    request(EP.revokeOthers, 'POST', {}).then(function (res) {
      if (stale(gen)) return;
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = '一键全踢（保留当前）';
        toast(msgOf(res, '一键全踢失败'));
        return;
      }
      var n = (res.data && res.data.revoked) || 0;
      if (S.box) reloadAll(gen);
      toast(n > 0 ? ('已踢下线 ' + n + ' 处其它登录') : '没有其它登录需要踢下线');
    }, function () {
      if (stale(gen)) return;
      btn.disabled = false;
      btn.textContent = '一键全踢（保留当前）';
      toast('网络异常，一键全踢未完成，请重试');
    });
  }

  /* ===== 3. 登录记录 ===== */
  function paintRecords(box, lrRes) {
    var sec = add(box, el('section', 'uc-sec'));
    sec.id = 'uc-login-records';
    var head = add(sec, el('div', 'uc-sec-head'));
    add(head, el('h3', 'uc-sec-title', '最近登录记录'));
    var auditBtn = button('看完整操作审计', 'btn-ghost');
    auditBtn.addEventListener('click', function () { gotoSettingTab('audit'); });
    add(head, auditBtn);
    add(head, el('span', 'uc-sec-desc',
      '最近 30 天的登录成功与失败（最多 50 条）。来源是脱敏网段（最后一截用 x 代替），' +
      '不显示完整 IP。'));

    if (lrRes && !lrRes.ok) {
      var errBox = add(sec, el('div', 'uc-empty empty-state'));
      add(errBox, el('p', 'empty-state-text', msgOf(lrRes, '登录记录读取失败')));
      var goAudit = button('去看完整操作审计', 'btn-primary');
      goAudit.addEventListener('click', function () { gotoSettingTab('audit'); });
      add(errBox, goAudit);
      return;
    }
    if (!S.records.length) {
      var empty = add(sec, el('div', 'uc-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '最近 30 天没有登录记录。登录一次后这里会出现时间、来源网段和结果。'));
      var goAudit2 = button('去看完整操作审计', 'btn-primary');
      goAudit2.addEventListener('click', function () { gotoSettingTab('audit'); });
      add(empty, goAudit2);
      return;
    }

    var wrap = add(sec, el('div', 'uc-tbl-wrap'));
    var tbl = add(wrap, el('table', 'uc-tbl'));
    var thead = add(tbl, el('thead'));
    var hr = add(thead, el('tr'));
    ['时间', '来源网段', '结果', '原因', '设备', '异常'].forEach(function (t) {
      add(hr, el('th', null, t));
    });
    var tbody = add(tbl, el('tbody'));
    for (var i = 0; i < S.records.length; i++) {
      (function (rec) {
        var tr = add(tbody, el('tr'));
        td(tr, '时间', fmtTime(rec.at), 'uc-num');
        td(tr, '来源网段', rec.ip || '本机通道', 'uc-num');
        var okCell = td(tr, '结果', rec.result === 'ok' ? '成功' : '失败',
          'uc-rowact ' + (rec.result === 'ok' ? 'uc-result-ok' : 'uc-result-bad'));
        td(tr, '原因', rec.reason || '—', 'uc-ua');
        td(tr, '设备', uaSummary(rec.userAgent), 'uc-ua');
        var flagCell = td(tr, '异常', '', 'uc-ua');
        if (!rec.flags || !rec.flags.length) {
          add(flagCell, el('span', 'uc-muted', '—'));
        } else {
          for (var j = 0; j < rec.flags.length; j++) {
            add(flagCell, flagOf(rec.flags[j]));
          }
        }
        void okCell;
      })(S.records[i]);
    }
  }

  function flagOf(flag) {
    switch (flag) {
      case 'new_network':
        return el('span', 'uc-flag uc-flag-warn', '首次该网段登录');
      case 'fail_burst':
        return el('span', 'uc-flag uc-flag-bad', '同网段多次失败');
      case 'rate_limited':
        return el('span', 'uc-flag uc-flag-bad', '触发失败延迟');
      default:
        return el('span', 'uc-flag', flag);
    }
  }

  /* ===== 4b. 改口令弹层（带强度提示）===== */
  function openPasswordDialog() {
    closeDialog();
    var wrap = el('div', 'uc-backdrop');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '修改管理员口令');
    var box = add(wrap, el('section', 'uc-dialog'));
    add(box, el('h3', null, '修改管理员口令'));
    var list = add(box, el('ul'));
    ['修改后所有已登录的页面（含当前这台）都会失效，需要用新口令重新登录',
      '新口令只保存在内核里，页面不回显、也不写浏览器存储',
      '至少 ' + PW_MIN_LEN + ' 位，建议 14 位以上并混用大小写、数字与符号'
    ].forEach(function (t) { add(list, el('li', null, t)); });

    var oldInput = field(box, 'kore-uc-pw-old', '当前口令', 'current-password');
    var newInput = field(box, 'kore-uc-pw-new', '新口令（至少 ' + PW_MIN_LEN + ' 位）', 'new-password');
    var meter = add(box, el('div', 'uc-meter'));
    var bars = [];
    for (var i = 0; i < 4; i++) bars.push(add(meter, el('i')));
    var meterHint = add(box, el('div', 'uc-dialog-hint', '新口令强度：等待输入'));
    var confirmInput = field(box, 'kore-uc-pw-confirm', '再输一次新口令', 'new-password');
    var hint = add(box, el('div', 'uc-dialog-hint'));
    var ops = add(box, el('div', 'uc-dialog-ops'));
    var cancel = button('取消', 'btn-ghost');
    var submit = button('保存新口令', 'btn-primary');
    add(ops, cancel);
    add(ops, submit);

    newInput.addEventListener('input', function () { paintStrength(newInput.value, bars, meterHint); });

    var esc = function (ev) { if (ev.key === 'Escape') closeDialog(); };
    document.addEventListener('keydown', esc);
    wrap.addEventListener('click', function (ev) { if (ev.target === wrap) closeDialog(); });
    cancel.addEventListener('click', closeDialog);

    submit.addEventListener('click', function () {
      var oldPw = oldInput.value;
      var newPw = newInput.value;
      if (!oldPw) { setHint(hint, '请先输入当前口令。', 'err'); oldInput.focus(); return; }
      if (newPw.length < PW_MIN_LEN) { setHint(hint, '新口令至少 ' + PW_MIN_LEN + ' 位，请再长一点。', 'err'); newInput.focus(); return; }
      if (newPw === oldPw) { setHint(hint, '新口令不能和当前口令相同，请换一个。', 'err'); newInput.focus(); return; }
      if (newPw !== confirmInput.value) { setHint(hint, '两次输入的新口令不一致，请再确认一次。', 'err'); confirmInput.focus(); return; }
      submit.disabled = true;
      submit.textContent = '正在保存…';
      setHint(hint, '正在校验当前口令并保存…', '');
      request(EP.password, 'POST', { current_password: oldPw, new_password: newPw }).then(function (res) {
        if (res.ok) {
          closeDialog();
          // 后端已吊销全部会话（含当前），先幂等 logout 再回登录页。
          request(EP.logout, 'POST', {}).then(backToLogin, backToLogin);
          return;
        }
        submit.disabled = false;
        submit.textContent = '保存新口令';
        setHint(hint, msgOf(res, '口令没有改动，请检查当前口令是否正确'), 'err');
      }, function () {
        submit.disabled = false;
        submit.textContent = '保存新口令';
        setHint(hint, '网络异常，口令没有改动，请重试。', 'err');
      });
    });

    document.body.appendChild(wrap);
    S.dialog = {
      wrap: wrap,
      inputs: [oldInput, newInput, confirmInput],
      esc: esc
    };
    oldInput.focus();
  }

  function field(parent, id, labelText, autocomplete) {
    var label = el('label', 'uc-field');
    label.setAttribute('for', id);
    add(label, el('span', null, labelText));
    var input = el('input');
    input.id = id;
    input.type = 'password';
    input.autocomplete = autocomplete;
    input.placeholder = labelText;
    add(label, input);
    add(parent, label);
    return input;
  }

  function setHint(node, text, tone) {
    node.className = 'uc-dialog-hint' + (tone ? ' ' + tone : '');
    node.textContent = text || '';
  }

  // 前端强度提示与后端 auth.PasswordStrength 同口径（长度阶梯 + 字符种类），
  // 只作输入时的即时反馈；最终分数以改口令成功后后端记录的为准。
  function paintStrength(pw, bars, hint) {
    var score = 0;
    var label = '等待输入';
    if (pw) {
      var n = pw.length;
      var classes = 0;
      if (/[a-zA-Z]/.test(pw)) classes++;
      if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) classes++;
      if (/[0-9]/.test(pw)) classes++;
      if (/[^A-Za-z0-9]/.test(pw)) classes++;
      if (n >= 10) score++;
      if (n >= 14) score++;
      if (n >= 18) score++;
      if (classes >= 3) score++;
      if (score > 4) score = 4;
      if (n < PW_MIN_LEN) { score = 0; label = '太短（不足 ' + PW_MIN_LEN + ' 位）'; }
      else label = ['弱', '较弱', '一般', '强', '很强'][score] || '一般';
    }
    for (var i = 0; i < bars.length; i++) {
      var on = i < score;
      bars[i].className = on ? (score <= 1 ? 'on-weak' : score === 2 ? 'on-mid' : 'on-good') : '';
    }
    hint.textContent = '新口令强度：' + label;
  }

  function closeDialog() {
    if (!S.dialog) return;
    var d = S.dialog;
    if (d.esc) document.removeEventListener('keydown', d.esc);
    // G-30：关窗即清内存里的口令
    for (var i = 0; i < d.inputs.length; i++) d.inputs[i].value = '';
    if (d.wrap && d.wrap.parentNode) d.wrap.parentNode.removeChild(d.wrap);
    S.dialog = null;
  }

  /* ===== 轻量提示条（无第三方 toast）===== */
  function toast(text) {
    if (!S.box) return;
    var bar = el('div', 'uc-hint', text);
    bar.setAttribute('role', 'status');
    bar.style.color = 'var(--kore-info)';
    S.box.insertBefore(bar, S.box.firstChild);
    setTimeout(function () {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }, 4000);
  }

  // 重新拉取三份数据（踢完会话 / 点刷新后）；gen 未变则沿用同一渲染代。
  function reloadAll(gen) {
    if (!S.box || stale(gen)) return;
    S.busy = false;
    var box = S.box;
    var handle = render(box);
    void handle;
  }

  window.KoreUserCenter = { render: render };
})();
