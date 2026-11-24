/* kore 主壳 · SSH 防护（web/sshguard.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/ssh-guard/ssh-guard.<verb>（方法名必须带域前缀）。
   读：status / attempts / ban.list；写：ban.add（不可回滚，需一次性 confirm 令牌）/ ban.remove。
   真实契约（照插件 0.3.0，别凭空加参数）：
   · ban.add 只收 {ip, confirm}——**没有时长参数**，封禁时长由 fail2ban 的 bantime 决定；
     confirm 必须先用 GET /api/v1/plugins/ssh-guard/root-action/fail2ban-banip/confirm-token 换一次性令牌。
   · ban.remove 只收 {ip}，是恢复性动作、不需要令牌。
   降级：fail2ban 未装/未运行或本进程拿不到日志 → 只读模式（黄底说明需要什么），写按钮从一开始就禁用。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/ssh-guard/', TOKEN_API = '/api/v1/plugins/ssh-guard/root-action/fail2ban-banip/confirm-token';
  var RUNBOOK_PRIV = 'docs/RUNBOOK.md#5-以-root-启动-kored-与提权通道adr-0018';
  var WINDOWS = [{ v: '24h', label: '最近 24 小时' }, { v: '7d', label: '最近 7 天' }];

  function fresh() {
    return { root: null, status: null, statusError: '', statusCode: '', statusHint: '',
      attempts: null, attemptsLoaded: false, attemptsError: '', win: '24h',
      bans: [], bansLoaded: false, bansError: '', bansCode: '', bansHint: '', bansNote: '', bansSource: '', bansAvailable: false,
      ip: '', busy: false, notice: '', noticeTone: '', confirmUnban: '', banMsg: '', banTone: '',
      tokenMsg: '', readOnly: true, readOnlyWhy: '', notInstalled: false, destroyed: false,
      // 加固建议（suggest）：只生成建议，前端没有任何「应用」写操作
      sugPw: false, sugRoot: false, sugBusy: false, sugResult: null, sugError: '', sugHint: '', sugMsg: '', sugTone: '' };
  }
  var S = fresh();

  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn, type) { n.addEventListener(type || 'click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    } return '';
  }
  function csrf() { return cookie('kore_csrf'); }
  function request(url, body, method) {
    var token = csrf();
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    var init = { method: method || 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: body === undefined ? undefined : JSON.stringify(body || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(url, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        err.code = data.code || ''; err.detail = data.detail || ''; err.hint = data.hint || ''; err.status = res.status; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（15 秒）');
      throw err;
    });
  }
  function invoke(verb, params) { return request(API + verb, params || {}); }

  // ---- 白话 ----
  function engineText(p) {
    if (!p || !p.available) return '未检测到防护源';
    if (p.engine === 'fail2ban') return 'fail2ban' + (p.version ? ' · ' + p.version : '');
    if (p.engine === 'sshd') return '仅 sshd 日志（无自动封禁）';
    return '未检测到防护源';
  }
  function fmtTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return v;
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function remainText(until) {
    if (!until) return '—';
    var end = new Date(until).getTime();
    if (isNaN(end)) return until;
    var left = Math.round((end - Date.now()) / 60000);
    if (left <= 0) return '已到期';
    if (left >= 1440) return Math.floor(left / 1440) + ' 天 ' + (left % 1440 >= 60 ? Math.floor((left % 1440) / 60) + ' 小时' : '');
    if (left >= 60) return Math.floor(left / 60) + ' 小时 ' + (left % 60) + ' 分钟';
    return left + ' 分钟';
  }
  // 错误文案唯一来源是主壳 KoreUI.failureOf（web/app.js 的 ERROR_VIEW 映射表）。
  // 未收录的 code 原样回退本视图既有通用文案，保证映射表没跟上时不会空白 / undefined。
  function errorView(err) {
    var f = window.KoreUI && window.KoreUI.failureOf ? window.KoreUI.failureOf(err) : null;
    if (!f || !f.mapped) {
      return { mapped: false, title: '', action: '', detail: String((err && err.message) || err || '') };
    }
    return f;
  }
  function failureText(err, verb) {
    if (!err) return verb + '失败';
    var f = errorView(err);
    if (f.mapped) return f.title; // 同一 code 在任何页面都是这一句
    return verb + '失败：' + (err.message || '原因未知') + (err.hint ? '（' + err.hint + '）' : '');
  }
  // failureBlock：状态 / 列表级错误卡片（统一标题 + 可执行下一步 + 原始错误折叠）。
  function failureBlock(err, cmd) {
    var f = errorView(err), box = el('div', 'sg-callout sg-callout-warn');
    box.setAttribute('role', 'status');
    add(box, el('div', 'sg-callout-title', f.mapped ? f.title : '操作失败'));
    add(box, el('p', 'sg-callout-text', f.mapped
      ? f.action
      : '原因：' + ((err && err.message) || '原因未知') + (err && err.hint ? '（' + err.hint + '）' : '')));
    if (cmd) add(box, el('pre', 'sg-cmd', cmd));
    var raw = (err && err.message) ? String(err.message) : '';
    if (raw) {
      var details = add(box, el('details', 'sg-details'));
      add(details, el('summary', null, '查看原始错误'));
      add(details, el('pre', null, raw));
    }
    var p = add(box, el('p', 'sg-callout-text'));
    var a = add(p, el('a', 'sg-link', '查看运行手册'));
    a.href = RUNBOOK_PRIV; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return box;
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function notice(text, tone) {
    var n = el('div', 'notice' + (tone === 'ok' ? ' redis-notice-ok' : ''), text);
    n.setAttribute('role', 'alert'); return n;
  }
  function panel(title, metaText) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    return { panel: p, head: h, meta: add(h, el('span', 'panel-meta', metaText || '')) };
  }
  function emptyBlock(text, actionLabel, action) {
    var box = el('div', 'sg-empty');
    add(box, el('span', null, text));
    if (actionLabel) { var b = add(box, el('button', 'btn btn-ghost', actionLabel)); b.type = 'button'; if (action) on(b, action); }
    return box;
  }
  function guideBox(title, lines, cmds, hint) {
    var box = el('div', 'sg-callout sg-callout-warn');
    box.setAttribute('role', 'status');
    add(box, el('div', 'sg-callout-title', title));
    lines.forEach(function (l) { add(box, el('p', 'sg-callout-text', l)); });
    (cmds || []).forEach(function (c) { add(box, el('pre', 'sg-cmd', c)); });
    if (hint) {
      var d = add(box, el('details', 'sg-details'));
      add(d, el('summary', null, '查看后端原始提示'));
      add(d, el('p', 'sg-callout-text', hint));
    }
    return box;
  }
  function goStore() {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('store');
    else window.location.hash = '#/store';
  }
  function openConfig() {
    if (window.KoreShell && typeof window.KoreShell.openConfig === 'function') {
      window.KoreShell.openConfig(S.root, 'ssh-guard', { title: 'SSH 防护设置', onSaved: refreshAll });
    } else {
      S.attemptsError = '配置面板未加载，请刷新页面后重试'; paintAttempts();
    }
  }

  // ---- ① 状态 ----
  function paintStatus() {
    if (!S.statusHost) return;
    S.statusHost.textContent = '';
    if (S.statusError) {
      if (S.statusCode === 'E_NOTFOUND') {
        S.notInstalled = true; hidePanels();
        var missing = errorView({ code: S.statusCode, message: S.statusError, hint: S.statusHint });
        S.statusHost.appendChild(emptyBlock(missing.mapped ? missing.title + '：' + missing.action
          : '还没有安装 SSH 防护插件（页面先把「怎么装」给你，不留空白）。', '去软件商店安装', goStore));
      } else {
        S.statusHost.appendChild(failureBlock({ code: S.statusCode, message: S.statusError, hint: S.statusHint },
          S.statusCode === 'E_NEED_ROOT' ? 'sudo systemctl restart kore' : ''));
      }
      return;
    }
    if (S.notInstalled) { S.notInstalled = false; hidePanels(false); }
    if (!S.status) { add(S.statusHost, el('div', 'sg-loading', '正在读取 SSH 防护状态…')); return; }
    var st = S.status, p = st.protection || {};
    var protect = !!p.available && p.engine === 'fail2ban' && !!p.fail2ban_active;
    S.readOnly = !protect;
    S.readOnlyWhy = protect ? '' : '当前没有可用的自动封禁能力（fail2ban 未装或未运行），封禁/解封按钮已禁用。';
    var top = add(S.statusHost, el('div', 'sg-status-top'));
    top.appendChild(chip(protect ? 'ok' : 'warn', protect ? '自动封禁已启用' : '只读模式'));
    top.appendChild(chip('na', '防护源：' + engineText(p)));
    var grid = add(S.statusHost, el('div', 'sg-grid'));
    [
      ['防护引擎', engineText(p)],
      ['fail2ban', p.fail2ban_installed ? (p.fail2ban_active ? '已安装 · 运行中' : '已安装 · 未运行') : '未安装'],
      ['日志来源', p.log_source && p.log_source !== 'none' ? p.log_source : '读不到（权限不足）'],
      ['当前封禁', String(p.banned_count == null ? '—' : p.banned_count) + ' 个'],
      ['24 小时失败', String(p.failed_24h == null ? '—' : p.failed_24h) + ' 次'],
      ['扫描窗口', S.win === '7d' ? '最近 7 天' : '最近 24 小时']
    ].forEach(function (it) {
      var cell = add(grid, el('div', 'sg-cell'));
      add(cell, el('span', 'sg-cell-label', it[0]));
      add(cell, el('span', 'sg-cell-value', it[1]));
    });
    if (!protect) {
      S.statusHost.appendChild(guideBox('只读模式：能看统计，不能封禁',
        ['封禁/解封需要 fail2ban 在运行，并且 kored 经内核提权通道执行 fail2ban-client。',
         '当前缺的是「' + (!p.fail2ban_installed ? 'fail2ban 未安装' : (!p.fail2ban_active ? 'fail2ban 未运行' : '提权通道不可用')) + '」。'],
        p.fail2ban_installed ? ['sudo systemctl enable --now fail2ban'] : ['sudo apt install fail2ban      # Debian / Ubuntu', 'sudo dnf install fail2ban      # RHEL / Fedora'],
        p.hint || ''));
    }
    if (st.note) add(S.statusHost, el('p', 'field-hint', st.note));
    paintBans(); paintBanForm();
  }
  function hidePanels(hidden) {
    var flag = hidden === undefined ? true : !!hidden;
    [S.attemptsPanel, S.bansPanel, S.formPanel, S.sugPanel].forEach(function (p) { if (p) p.hidden = flag; });
  }

  // ---- ② 暴力破解统计 ----
  function paintAttempts() {
    if (!S.attemptsHost) return;
    S.attemptsHost.textContent = '';
    if (S.attemptsError) { S.attemptsHost.appendChild(notice(S.attemptsError, 'fail')); return; }
    if (!S.attemptsLoaded) { add(S.attemptsHost, el('div', 'sg-loading', '正在统计登录失败记录…')); return; }
    var a = S.attempts || {};
    var tops = a.top_ips || [];
    var head = add(S.attemptsHost, el('div', 'sg-attempt-head'));
    head.appendChild(chip(a.failed ? 'warn' : 'ok', (a.failed || 0) + ' 次失败'));
    add(head, el('span', 'sg-cell-label',
      '涉及 ' + (a.unique_ips || 0) + ' 个来源 IP · 无效用户 ' + (a.invalid_users || 0) +
      ' 次 · 成功登录 ' + (a.successful_logins || 0) + ' 次 · 日志来源 ' + (a.source || '—') +
      (a.events_without_time ? ' · ' + a.events_without_time + ' 条无时间戳' : '')));
    // 一句判读：不给结论就只是堆数字。
    var verdict;
    if (!a.failed) verdict = '这个窗口内没有登录失败记录：看起来没人在试密码。';
    else {
      var top = tops[0];
      var share = top && a.failed ? Math.round((top.failed / a.failed) * 100) : 0;
      if (tops.length <= 2 && share >= 60)
        verdict = '失败高度集中在 ' + tops.length + ' 个 IP（最高 ' + top.ip + ' 占 ' + share + '%）：像定向暴力破解，建议直接封这两个地址。';
      else if (tops.length >= 10)
        verdict = '失败来自 ' + tops.length + ' 个以上不同 IP、单 IP 占比不高：像分布式扫描/撞库，建议按 Top IP 逐个封禁并确认密码策略。';
      else verdict = '失败分散在 ' + tops.length + ' 个 IP：' + (a.failed > 100 ? '量偏大，建议封 Top IP。' : '量不大，先观察。');
    }
    add(S.attemptsHost, el('p', 'sg-verdict', verdict));
    if ((a.timeline_hourly || []).length && (a.failed || 0) > 0) {
      S.attemptsHost.appendChild(svgTimeline(a.timeline_hourly));
    }
    if (!tops.length) {
      S.attemptsHost.appendChild(emptyBlock('没有可聚合的失败来源。日志读不到时请检查插件设置里的日志路径，或改用 journal 来源。'));
      return;
    }
    var wrap = add(S.attemptsHost, el('div', 'sg-table-wrap'));
    var table = add(wrap, el('table', 'plugin-table sg-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['来源 IP', '失败次数', '占比', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    tops.slice(0, 10).forEach(function (item) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', 'sg-mono', item.ip || '—')).setAttribute('data-label', '来源 IP');
      add(tr, el('td', 'sg-num', String(item.failed || 0))).setAttribute('data-label', '失败次数');
      var pct = a.failed ? Math.round(((item.failed || 0) / a.failed) * 100) : 0;
      var bar = add(tr, el('td', null)); bar.setAttribute('data-label', '占比');
      var track = add(bar, el('span', 'sg-bar')); var fill = add(track, el('span', 'sg-bar-fill'));
      fill.style.width = Math.max(4, Math.min(100, pct)) + '%';
      add(bar, el('span', 'sg-cell-label', pct + '%'));
      var ops = add(tr, el('td', 'sg-ops')); ops.setAttribute('data-label', '操作');
      var btn = add(ops, el('button', 'btn btn-ghost', '封禁此 IP')); btn.type = 'button';
      btn.disabled = S.readOnly || S.busy;
      if (S.readOnly) btn.title = S.readOnlyWhy;
      on(btn, function () { S.ipInput.value = item.ip || ''; submitBan(); });
    });
  }

  // svgTimeline：24 根自绘柱（失败次数）。手写 SVG、零依赖——ADR-0027 驳回第三方图表库。
  function svgTimeline(hours) {
    var max = 1;
    hours.forEach(function (h) { if ((h.failed || 0) > max) max = h.failed || 0; });
    var w = 360, hgt = 56, bw = w / hours.length;
    var box = el('div', 'sg-chart');
    var label = add(box, el('span', 'sg-cell-label', '每小时失败次数（最高 ' + max + ' 次）'));
    label.className = 'sg-chart-label';
    var NS = 'http://www.w3.org/2000/svg';
    /* 读数面板：原生 <title> 只在桌面悬停后延迟出现、手机 tap 不显示，故改为 DOM 面板。 */
    var tip = add(box, el('div', 'sg-tip'));
    tip.hidden = true;
    var tipTime = add(tip, el('div', 'sg-tip-time'));
    var tipVal = add(tip, el('div', 'sg-tip-val'));
    var pinned = false;
    function showTip(rect, item) {
      var br = box.getBoundingClientRect();
      var rr = rect.getBoundingClientRect();
      var tw = tip.offsetWidth || 96, th = tip.offsetHeight || 34;
      tipTime.textContent = item.hour || '';
      tipVal.textContent = (item.failed || 0) + ' 次失败';
      tip.hidden = false;
      var left = rr.left - br.left + rr.width / 2 - tw / 2;
      left = Math.max(0, Math.min(Math.max(0, br.width - tw), left));
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(Math.max(0, rr.top - br.top - th - 6)) + 'px';
    }
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + hgt);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(hgt));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '按小时统计的登录失败次数：悬停或点按柱子读出每格数值');
    hours.forEach(function (item, i) {
      var v = item.failed || 0;
      var bh = Math.round((v / max) * (hgt - 8));
      var rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(Math.round(i * bw) + 1));
      rect.setAttribute('y', String(hgt - bh));
      rect.setAttribute('width', String(Math.max(1, Math.round(bw) - 2)));
      rect.setAttribute('height', String(bh));
      rect.setAttribute('fill', 'var(--kore-warning)');
      rect.setAttribute('role', 'img');
      rect.setAttribute('aria-label', (item.hour || '') + '：' + v + ' 次失败');
      rect.addEventListener('pointerenter', function () { showTip(rect, item); });
      rect.addEventListener('pointerdown', function () { pinned = true; showTip(rect, item); });
      svg.appendChild(rect);
    });
    svg.addEventListener('pointerleave', function () { if (!pinned) tip.hidden = true; });
    box.appendChild(svg);
    return box;
  }

  // ---- ③ 封禁名单 ----
  function sourceLabel() {
    if (S.bansSource === 'fail2ban') return 'fail2ban 封禁';
    if (S.bansSource) return '日志推断（' + S.bansSource + '）';
    return '未知';
  }
  // 推断名单里的 IP 并没有真的被 fail2ban 封禁，解封按钮必须禁用并说明。
  function bansAreInferred() { return !!S.bansSource && S.bansSource !== 'fail2ban'; }
  function paintBans() {
    if (!S.bansHost) return;
    S.bansHost.textContent = '';
    S.bansMeta.textContent = S.bansLoaded ? (S.bans.length + ' 个') : '';
    if (S.bansError) {
      S.bansHost.appendChild(failureBlock({ code: S.bansCode, message: S.bansError, hint: S.bansHint },
        S.bansCode === 'E_NEED_ROOT' ? 'sudo systemctl restart kore' : ''));
      return;
    }
    if (!S.bansLoaded) { add(S.bansHost, el('div', 'sg-loading', '正在读取封禁名单…')); return; }
    if (!S.bans.length) {
      S.bansHost.appendChild(emptyBlock(S.readOnly
        ? '没有封禁记录。自动封禁未启用时，这里不会出现新条目。'
        : '当前没有封禁任何 IP。上面「手动封禁」填一个地址即可。'));
      return;
    }
    if (bansAreInferred()) {
      S.bansHost.appendChild(guideBox('下面是「可疑 IP」而不是封禁名单',
        ['当前没有运行中的 fail2ban，插件只能从登录日志里按阈值挑出可疑来源；这些 IP 并没有被真正封禁。',
         '要真正封禁，请先启动 fail2ban，再用上面的「封禁此 IP」。'],
        ['sudo systemctl enable --now fail2ban'], S.bansNote));
    } else if (S.bansNote) {
      add(S.bansHost, el('p', 'field-hint', S.bansNote));
    }
    var wrap = add(S.bansHost, el('div', 'sg-table-wrap'));
    var table = add(wrap, el('table', 'plugin-table sg-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['IP 地址', '来源', '原因', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.bans.forEach(function (b) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', 'sg-mono', b.address || '—')).setAttribute('data-label', 'IP 地址');
      add(tr, el('td', null, sourceLabel())).setAttribute('data-label', '来源');
      add(tr, el('td', null, b.reason || '—')).setAttribute('data-label', '原因');
      var ops = add(tr, el('td', 'sg-ops cell-ops')); ops.setAttribute('data-label', '操作');
      if (S.confirmUnban === b.address) {
        add(ops, el('span', 'sg-cell-label', '确定解封？'));
        var yes = add(ops, el('button', 'btn sg-danger', '确认')); yes.type = 'button';
        var no = add(ops, el('button', 'btn btn-ghost', '取消')); no.type = 'button';
        on(no, function () { S.confirmUnban = ''; paintBans(); });
        on(yes, function () { S.confirmUnban = ''; unban(b.address, yes); });
      } else {
        var btn = add(ops, el('button', 'btn sg-danger', '解封')); btn.type = 'button';
        btn.disabled = S.readOnly || S.busy || bansAreInferred();
        if (S.readOnly) btn.title = S.readOnlyWhy;
        if (bansAreInferred()) btn.title = '这是从日志推断的可疑 IP，并没有真的被封禁；需要封禁请用上面的「封禁此 IP」';
        on(btn, function () { S.confirmUnban = b.address; paintBans(); });
      }
    });
    if (S.bansNote) add(S.bansHost, el('p', 'field-hint', S.bansNote));
  }

  // ---- ④ 手动封禁 ----
  function paintBanForm() {
    if (!S.banHint) return;
    var disabled = S.readOnly || S.busy;
    [S.ipInput, S.banBtn].forEach(function (n) { if (n) n.disabled = disabled; });
    S.banHint.textContent = S.readOnly
      ? S.readOnlyWhy + ' 需要：fail2ban 在运行 + kored 以 root 启动（提权通道）。'
      : '封禁走内核提权通道执行 fail2ban-client；不可回滚，页面会先申请一次性确认令牌再提交。';
  }
  function submitBan() {
    if (S.readOnly || S.busy) return;
    var ip = (S.ipInput.value || '').trim();
    if (!ip) { S.banMsg = '请填一个 IP 地址（例如 203.0.113.7）'; S.banTone = 'fail'; paintBanMsg(); S.ipInput.focus(); return; }
    if (!/^[0-9A-Fa-f:.]+$/.test(ip) || ip.indexOf(':') < 0 && ip.indexOf('.') < 0) {
      S.banMsg = 'IP 格式不对：只接受纯 IPv4 / IPv6 地址（不支持网段）'; S.banTone = 'fail'; paintBanMsg(); return;
    }
    S.busy = true; S.banMsg = '正在申请一次性确认令牌…'; S.banTone = ''; paintBanForm(); paintBanMsg();
    request(TOKEN_API, undefined, 'GET').then(function (tok) {
      var token = tok && (tok.token || tok.confirm || tok.confirm_token);
      if (!token) throw new Error('内核没有返回确认令牌');
      S.banMsg = '正在封禁 ' + ip + '…'; paintBanMsg();
      return invoke('ban.add', { ip: ip, confirm: token });
    }).then(function (r) {
      if (S.destroyed) return;
      S.busy = false;
      if (r && r.applied) {
        S.banMsg = '已封禁 ' + (r.ip || ip) + (r.verified ? '（已回读封禁清单确认生效）' : '（已执行，但回读未确认：' + (r.note || '请手动刷新名单核对') + '）');
        S.banTone = r.verified ? 'ok' : 'warn';
        S.ipInput.value = '';
      } else {
        S.banMsg = '没有确认到封禁结果' + (r && r.note ? '：' + r.note : ''); S.banTone = 'fail';
      }
      paintBanMsg(); paintBanForm(); loadBans(); loadStatus();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.banMsg = failureText(err, '封禁'); S.banTone = 'fail';
      paintBanForm(); paintBanMsg();
    });
  }
  function unban(ip, btn) {
    if (S.readOnly || S.busy) return;
    S.busy = true; if (btn) btn.disabled = true;
    S.banMsg = '正在解封 ' + ip + '…'; S.banTone = ''; paintBanMsg();
    invoke('ban.remove', { ip: ip }).then(function (r) {
      if (S.destroyed) return;
      S.busy = false;
      S.banMsg = '已解封 ' + ip + (r && r.verified ? '（已回读确认）' : '');
      S.banTone = 'ok'; paintBanMsg(); paintBans(); loadStatus();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.banMsg = failureText(err, '解封'); S.banTone = 'fail';
      paintBanMsg(); paintBans();
    });
  }
  function paintBanMsg() {
    if (!S.banMsgHost) return;
    S.banMsgHost.textContent = S.banMsg || '';
    S.banMsgHost.className = 'sg-msg' + (S.banTone === 'fail' ? ' is-fail' : (S.banTone === 'ok' ? ' is-ok' : ''));
  }

  // ---- ⑤ 加固建议（suggest）----
  // 只读：调 ssh-guard.suggest 拿 config_text / diff / risk / apply_commands；
  // 落地方式只有「复制命令」，**没有一键应用**——后端没有真机下发能力（见插件 0.3.0）。
  function copyTo(text, msgEl) {
    function done() { if (msgEl) { msgEl.textContent = '已复制'; msgEl.className = 'sg-msg is-ok'; } }
    function fail() { if (msgEl) { msgEl.textContent = '复制失败：请手动选中文本复制'; msgEl.className = 'sg-msg is-fail'; } }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail); return;
    }
    var ta = el('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { fail(); }
    document.body.removeChild(ta);
  }
  function copyBtn(text, label, msgEl) {
    var b = el('button', 'btn btn-ghost', label); b.type = 'button';
    on(b, function () { copyTo(text, msgEl); return; });
    return b;
  }
  function sugParams() {
    var p = {};
    if (S.sugPwCb && S.sugPwCb.checked) p.disable_password_auth = true;
    if (S.sugRootCb && S.sugRootCb.checked) p.disable_root_login = true;
    var port = (S.sugPort.value || '').trim();
    if (port) p.port = parseInt(port, 10);
    var max = (S.sugMax.value || '').trim();
    if (max) p.max_auth_tries = parseInt(max, 10);
    return p;
  }
  function paintSugMsg() {
    if (!S.sugMsgHost) return;
    S.sugMsgHost.textContent = S.sugMsg || '';
    S.sugMsgHost.className = 'sg-msg' + (S.sugTone === 'fail' ? ' is-fail' : (S.sugTone === 'ok' ? ' is-ok' : ''));
  }
  function submitSuggest() {
    if (S.sugBusy) return;
    var p = sugParams();
    var port = (S.sugPort.value || '').trim();
    if (port && (!/^[0-9]+$/.test(port) || +port < 1 || +port > 65535)) {
      S.sugError = ''; S.sugResult = null; S.sugMsg = '端口必须是 1–65535 的整数（留空表示保持当前端口）';
      S.sugTone = 'fail'; paintSugMsg(); paintSuggestResult(); S.sugPort.focus(); return;
    }
    var max = (S.sugMax.value || '').trim();
    if (max && (!/^[0-9]+$/.test(max) || +max < 1 || +max > 100)) {
      S.sugError = ''; S.sugResult = null; S.sugMsg = '最大认证次数必须是 1–100 的整数';
      S.sugTone = 'fail'; paintSugMsg(); paintSuggestResult(); S.sugMax.focus(); return;
    }
    S.sugBusy = true; S.sugError = ''; S.sugHint = ''; S.sugMsg = '正在生成建议…'; S.sugTone = ''; paintSugMsg();
    if (S.sugBtn) S.sugBtn.disabled = true;
    invoke('suggest', p).then(function (r) {
      if (S.destroyed) return;
      S.sugBusy = false; if (S.sugBtn) S.sugBtn.disabled = false;
      S.sugResult = r || null; S.sugMsg = ''; S.sugTone = ''; paintSugMsg(); paintSuggestResult();
    }, function (err) {
      if (S.destroyed) return;
      S.sugBusy = false; if (S.sugBtn) S.sugBtn.disabled = false;
      S.sugError = failureText(err, '生成加固建议'); S.sugHint = err.hint || ''; S.sugResult = null;
      S.sugMsg = ''; paintSugMsg(); paintSuggestResult();
    });
  }
  function paintSuggestResult() {
    if (!S.sugHost) return;
    var host = S.sugHost; host.textContent = '';
    if (S.sugError) {
      add(host, notice(S.sugError, 'fail'));
      if (S.sugHint) add(host, guideBox('生成失败', ['这是后端返回的原因，不是登录失效。'], [], S.sugHint));
      return;
    }
    if (!S.sugResult) {
      add(host, el('p', 'field-hint', '勾选要加固的项后点「生成建议」：会给出建议配置、与当前值的差异、风险与回滚，以及可整段复制的落地命令。'));
      return;
    }
    var r = S.sugResult, i;
    add(host, el('p', 'sg-sug-note', '建议态：kore 不会自动下发，请确认后手动执行。页面不提供「一键应用」。'));
    // 建议配置
    var cfg = add(host, el('div', 'sg-sug-sec'));
    add(cfg, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', '建议配置（/etc/ssh/sshd_config.d/kore.conf）'));
    add(cfg, el('pre', 'sg-cmd sg-sug-pre', r.config_text || ''));
    var cfgOps = add(cfg, el('div', 'sg-sug-ops'));
    var cfgMsg = add(cfgOps, el('span', 'sg-msg', ''));
    add(cfgOps, copyBtn(r.config_text || '', '复制配置', cfgMsg));
    if (r.path_hint) add(cfg, el('p', 'field-hint', r.path_hint));
    // 差异
    var diffs = r.diff_from_current || [];
    var diff = add(host, el('div', 'sg-sug-sec'));
    add(diff, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', '与当前值对比'));
    if (diffs.length) {
      diffs.forEach(function (d) {
        var row = add(diff, el('p', 'sg-diff'));
        add(row, el('span', 'sg-mono', (d.directive || '') + '：'));
        add(row, el('span', 'sg-diff-cur', String(d.current == null ? '—' : d.current)));
        add(row, el('span', 'sg-diff-arrow', ' → '));
        add(row, el('span', 'sg-diff-new', String(d.suggested == null ? '—' : d.suggested)));
      });
    } else {
      add(diff, el('p', 'field-hint', r.path_hint || '当前没有可对比的差异（可能未改动任何项）。'));
    }
    // 风险（每条必须显示回滚）
    var risks = r.risk || [];
    if (risks.length) {
      var box = add(host, el('div', 'sg-sug-sec'));
      add(box, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', '风险提示（每条都带怎么回滚）'));
      risks.forEach(function (risk) {
        var level = risk.level || 'low';
        var cls = level === 'high' ? ' sg-risk-high' : (level === 'medium' ? ' sg-risk-medium' : ' sg-risk-low');
        var card = add(box, el('div', 'sg-risk' + cls));
        var rh = add(card, el('div', 'sg-risk-head'));
        add(rh, el('span', 'sg-risk-level', level === 'high' ? '高危' : (level === 'medium' ? '注意' : '提示')));
        if (risk.code) add(rh, el('span', 'sg-mono', risk.code));
        add(card, el('p', 'sg-risk-msg', risk.message || ''));
        add(card, el('p', 'sg-risk-rollback', '回滚：' + (risk.rollback || '按 apply_commands 里的备份恢复，再 sshd -t && systemctl reload sshd')));
      });
    }
    // 落地命令（只有复制）
    var applyText = (r.apply_commands || []).join('\n');
    var cmd = add(host, el('div', 'sg-sug-sec'));
    add(cmd, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', '落地命令（整段复制，确认后手动执行）'));
    add(cmd, el('pre', 'sg-cmd sg-sug-pre', applyText || '（后端没有返回命令）'));
    var cmdOps = add(cmd, el('div', 'sg-sug-ops'));
    var cmdMsg = add(cmdOps, el('span', 'sg-msg', ''));
    add(cmdOps, copyBtn(applyText, '复制全部命令', cmdMsg));
    var verifyText = (r.verify_commands || []).join('\n');
    if (verifyText) {
      var ver = add(host, el('div', 'sg-sug-sec'));
      add(ver, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', '验证命令（sshd -T 看最终生效值）'));
      add(ver, el('pre', 'sg-cmd sg-sug-pre', verifyText));
      var verOps = add(ver, el('div', 'sg-sug-ops'));
      var verMsg = add(verOps, el('span', 'sg-msg', ''));
      add(verOps, copyBtn(verifyText, '复制验证命令', verMsg));
    }
  }

  // ---- 加载 ----
  function sinceISO() {
    var h = S.win === '7d' ? 24 * 7 : 24;
    return new Date(Date.now() - h * 3600 * 1000).toISOString();
  }
  function loadStatus() {
    S.statusError = ''; S.statusCode = ''; S.statusHint = ''; paintStatus();
    invoke('status').then(function (d) { if (S.destroyed) return; S.status = d; paintStatus(); }, function (err) {
      if (S.destroyed) return; S.statusError = err.message; S.statusCode = err.code || ''; S.statusHint = err.hint || ''; paintStatus();
    });
  }
  function loadAttempts() {
    S.attemptsLoaded = false; S.attemptsError = ''; paintAttempts();
    invoke('attempts', { since: sinceISO() }).then(function (d) {
      if (S.destroyed) return; S.attempts = d; S.attemptsLoaded = true; paintAttempts();
    }, function (err) {
      if (S.destroyed) return; S.attemptsError = failureText(err, '统计'); S.attemptsLoaded = true; paintAttempts();
    });
  }
  function loadBans() {
    S.bansLoaded = false; S.bansError = ''; S.bansCode = ''; S.bansHint = ''; paintBans();
    // 数据源是 bans（fail2ban 真实 jail 列表；没有 fail2ban 时是日志推断的可疑 IP）。
    // ban.list 是恒空桩（handleBanList 硬编码空数组），接了只会永远显示「没有封禁记录」。
    invoke('bans', {}).then(function (d) {
      if (S.destroyed) return;
      S.bans = (d && d.bans) || [];
      S.bansSource = (d && d.source) || '';
      S.bansAvailable = !!(d && d.available);
      S.bansNote = (d && d.note) || '';
      S.bansLoaded = true; paintBans();
    }, function (err) {
      if (S.destroyed) return; S.bansError = err.message; S.bansCode = err.code || ''; S.bansHint = err.hint || ''; S.bansLoaded = true; paintBans();
    });
  }
  function refreshAll() { loadStatus(); loadAttempts(); loadBans(); }

  function injectCSS() {
    if (document.getElementById('kore-sg-css')) return;
    var css = [
      '.sg-loading{padding:var(--kore-space-3) var(--kore-space-4);color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.sg-status-top{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.sg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) var(--kore-space-4);}',
      '.sg-cell{display:flex;flex-direction:column;gap:2px;min-width:0;padding:var(--kore-space-2) var(--kore-space-3);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);}',
      '.sg-cell-label{color:var(--kore-text-3);font-size:var(--kore-font-12);word-break:break-word;}',
      '.sg-cell-value{font-size:var(--kore-font-14);word-break:break-word;}',
      '.sg-callout{margin:0 var(--kore-space-4) var(--kore-space-3);padding:var(--kore-space-3);border-radius:var(--kore-radius-control);}',
      '.sg-callout-warn{color:var(--kore-text-1);background:var(--kore-warning-bg);border:1px solid var(--kore-warning);border-left:3px solid var(--kore-warning);}',
      '.sg-callout-title{margin-bottom:var(--kore-space-1);color:var(--kore-warning);font-weight:600;font-size:var(--kore-font-13);}',
      '.sg-callout-text{margin:0 0 var(--kore-space-1);color:var(--kore-text-2);font-size:var(--kore-font-13);word-break:break-word;}',
      '.sg-details{margin-top:var(--kore-space-2);color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.sg-details summary{cursor:pointer;}',
      '.sg-cmd{margin:var(--kore-space-1) 0;padding:var(--kore-space-2) var(--kore-space-3);overflow-x:auto;color:var(--kore-term-cyan);background:var(--kore-bg-0);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.sg-attempt-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.sg-verdict{margin:var(--kore-space-2) var(--kore-space-4);padding:var(--kore-space-2) var(--kore-space-3);color:var(--kore-text-1);background:var(--kore-bg-2);border-left:3px solid var(--kore-info);border-radius:var(--kore-radius-control);font-size:var(--kore-font-13);}',
      '.sg-table-wrap{overflow-x:auto;}',
      '.sg-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-13);}',
      '.sg-table thead th{text-align:left;padding:var(--kore-space-2) var(--kore-space-3);color:var(--kore-text-2);font-size:var(--kore-font-12);font-weight:400;border-bottom:1px solid var(--kore-border-2);white-space:nowrap;}',
      '.sg-table tbody tr + tr{border-top:1px solid var(--kore-border-2);}',
      '.sg-table td{padding:var(--kore-space-2) var(--kore-space-3);vertical-align:middle;word-break:break-word;}',
      '.sg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.sg-num{font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.sg-bar{display:inline-block;width:90px;height:6px;margin-right:var(--kore-space-2);vertical-align:middle;background:var(--kore-bg-0);border-radius:3px;overflow:hidden;}',
      '.sg-bar-fill{display:block;height:100%;background:var(--kore-warning);}',
      '.sg-ops{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);}',
      '.sg-danger{color:var(--kore-danger);border-color:var(--kore-danger);}',
      '.sg-form{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:var(--kore-space-3);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.sg-form-ops{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);}',
      '.sg-preset-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-2) var(--kore-space-4) 0;}',
      '.sg-preset{display:inline-flex;align-items:center;min-height:28px;padding:2px var(--kore-space-2);color:var(--kore-text-3);background:var(--kore-bg-0);border:1px dashed var(--kore-border-2);border-radius:var(--kore-radius-control);font-size:var(--kore-font-12);}',
      '.sg-chart{position:relative;margin:0 var(--kore-space-4) var(--kore-space-3);}',
      '.sg-chart svg{display:block;margin-top:var(--kore-space-1);background:var(--kore-bg-0);border-radius:var(--kore-radius-control);touch-action:pan-y;}',
      /* 读数面板：hover / tap 时显示「小时 + 失败次数」，数值带单位，pointer-events:none 不挡手势 */
      '.sg-tip{position:absolute;z-index:2;min-width:96px;padding:6px 8px;border-radius:6px;border:1px solid var(--kore-border-2);background:var(--kore-bg-1);box-shadow:0 4px 14px rgba(0,0,0,.28);font-size:var(--kore-font-12);line-height:1.5;color:var(--kore-text-1);pointer-events:none;white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.sg-tip[hidden]{display:none;}',
      '.sg-tip-time{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.sg-tip-val{color:var(--kore-text-1);}',
      '.sg-chart-label{display:block;color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.sg-msg{min-height:18px;color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.sg-msg.is-fail{color:var(--kore-danger);}',
      '.sg-msg.is-ok{color:var(--kore-success);}',
      '.sg-empty{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-4);color:var(--kore-text-3);font-size:var(--kore-font-13);}',
      '.sg-empty span{flex:1 1 260px;}',
      '.sg-sug-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kore-space-3);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.sg-sug-toggle{display:inline-flex;align-items:center;gap:var(--kore-space-2);min-height:44px;font-size:var(--kore-font-13);}',
      '.sg-sug-toggle input{width:20px;height:20px;flex:0 0 auto;}',
      '.sg-sug-ops{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-2) var(--kore-space-4) 0;}',
      '.sg-sug .btn,.sg-sug-form-ops .btn{min-height:44px;}',
      '.sg-sug-sec{margin:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.sg-sug-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);margin-bottom:var(--kore-space-1);}',
      '.sg-sug-title{font-size:var(--kore-font-13);font-weight:600;}',
      '.sg-sug-note{margin:var(--kore-space-3) var(--kore-space-4) 0;padding:var(--kore-space-2) var(--kore-space-3);color:var(--kore-text-1);background:var(--kore-warning-bg);border:1px solid var(--kore-warning);border-left:3px solid var(--kore-warning);border-radius:var(--kore-radius-control);}',
      '.sg-sug-pre{max-height:320px;overflow:auto;white-space:pre;word-break:normal;}',
      '.sg-diff{margin:var(--kore-space-1) 0;font-size:var(--kore-font-13);word-break:break-word;}',
      '.sg-diff-cur{color:var(--kore-danger);}',
      '.sg-diff-arrow{color:var(--kore-text-3);}',
      '.sg-diff-new{color:var(--kore-success);}',
      '.sg-risk{margin:var(--kore-space-2) 0;padding:var(--kore-space-2) var(--kore-space-3);background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-left:3px solid var(--kore-border-2);border-radius:var(--kore-radius-control);font-size:var(--kore-font-13);}',
      '.sg-risk-high{border-left-color:var(--kore-danger);}',
      '.sg-risk-medium{border-left-color:var(--kore-warning);}',
      '.sg-risk-low{border-left-color:var(--kore-text-3);}',
      '.sg-risk-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);margin-bottom:2px;}',
      '.sg-risk-level{font-size:var(--kore-font-12);font-weight:600;}',
      '.sg-risk-high .sg-risk-level{color:var(--kore-danger);}',
      '.sg-risk-medium .sg-risk-level{color:var(--kore-warning);}',
      '.sg-risk-low .sg-risk-level{color:var(--kore-text-3);}',
      '.sg-risk-msg{margin:0;color:var(--kore-text-2);word-break:break-word;}',
      '.sg-risk-rollback{margin:var(--kore-space-1) 0 0;color:var(--kore-text-1);font-size:var(--kore-font-12);word-break:break-word;}',
      '@media (max-width:639px){',
      '.sg-grid,.sg-form,.sg-sug-form{grid-template-columns:1fr;}',
      '.sg-sug .btn,.sg-sug-form-ops .btn{min-height:44px;width:100%;}',
      '.sg .panel-head{flex-wrap:wrap;row-gap:var(--kore-space-1);}',
      '}'
    ].join('\n');
    var style = el('style', null, css); style.id = 'kore-sg-css';
    document.head.appendChild(style);
  }

  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    injectCSS();
    S.root = add(container, el('section', 'sg'));
    var head = add(S.root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', 'SSH 防护'));
    add(head, el('p', 'view-sub', '看看谁在试密码、封掉它，并管理当前的封禁名单。'));

    // ① 状态
    var st = panel('防护状态', '只读探测，不修改 sshd 配置');
    add(S.root, st.panel);
    var sOps = add(st.meta, el('div', 'actions'));
    var cfg = add(sOps, el('button', 'btn btn-ghost', '防护设置')); cfg.type = 'button'; on(cfg, openConfig);
    var rf = add(sOps, el('button', 'btn btn-ghost', '刷新')); rf.type = 'button'; on(rf, refreshAll);
    S.statusHost = add(st.panel, el('div', 'sg-status'));

    // ② 暴力破解统计
    var att = panel('暴力破解统计', '');
    add(S.root, att.panel); S.attemptsPanel = att.panel;
    var winWrap = add(att.meta, el('div', 'sg-ops'));
    WINDOWS.forEach(function (w) {
      var b = add(winWrap, el('button', 'btn btn-ghost', w.label)); b.type = 'button';
      b.setAttribute('aria-pressed', S.win === w.v ? 'true' : 'false');
      on(b, function () { S.win = w.v; refreshAll(); });
    });
    S.attemptsHost = add(att.panel, el('div', 'sg-attempts'));

    // ③ 封禁名单
    var bans = panel('封禁名单', ''); add(S.root, bans.panel); S.bansPanel = bans.panel;
    S.bansMeta = add(bans.meta, el('span', null, ''));
    S.bansHost = add(bans.panel, el('div', 'sg-bans'));

    // ④ 手动封禁
    var form = panel('手动封禁', '封禁持续到你手动解封');
    add(S.root, form.panel); S.formPanel = form.panel;
    var grid = add(form.panel, el('div', 'sg-form'));
    S.ipInput = el('input', 'field-input'); S.ipInput.type = 'text';
    S.ipInput.placeholder = '203.0.113.7'; S.ipInput.maxLength = 45;
    S.ipInput.setAttribute('autocomplete', 'off'); S.ipInput.setAttribute('spellcheck', 'false');
    var ipField = add(grid, el('label', 'field'));
    add(ipField, el('span', 'field-label', 'IP 地址')); add(ipField, S.ipInput);
    var ttlField = add(grid, el('label', 'field'));
    add(ttlField, el('span', 'field-label', '封禁时长'));
    add(ttlField, el('span', 'sg-cell-value', '持续到你手动解封'));
    add(form.panel, el('p', 'field-hint',
      'fail2ban 的 ban.add 没有时长参数：封禁会一直生效，直到你在上面的名单里手动解封。需要自动到期请改 fail2ban 的 bantime。'));
    var ops = add(form.panel, el('div', 'sg-form-ops'));
    S.banBtn = add(ops, el('button', 'btn btn-primary', '封禁这个 IP')); S.banBtn.type = 'button';
    on(S.banBtn, submitBan);
    S.banMsgHost = add(ops, el('span', 'sg-msg', ''));
    S.banHint = add(form.panel, el('p', 'field-hint', ''));
    on(S.ipInput, function (e) { if (e.key === 'Enter') submitBan(); }, 'keydown');

    // ⑤ 加固建议（只读生成，不下发）
    var sug = panel('加固建议', '只生成建议，不自动下发');
    add(S.root, sug.panel); S.sugPanel = sug.panel;
    var sgrid = add(sug.panel, el('div', 'sg-sug-form'));
    function sugToggle(text) {
      var lab = add(sgrid, el('label', 'sg-sug-toggle'));
      var cb = add(lab, el('input', null)); cb.type = 'checkbox';
      add(lab, el('span', null, text));
      return cb;
    }
    S.sugPwCb = sugToggle('关闭密码认证（仅保留密钥等）');
    S.sugRootCb = sugToggle('禁止 root 直接登录');
    var portField = add(sgrid, el('label', 'field'));
    add(portField, el('span', 'field-label', 'SSH 端口（留空 = 保持当前）'));
    S.sugPort = add(portField, el('input', 'field-input')); S.sugPort.type = 'number';
    S.sugPort.min = '1'; S.sugPort.max = '65535'; S.sugPort.placeholder = '例如 2222';
    var maxField = add(sgrid, el('label', 'field'));
    add(maxField, el('span', 'field-label', '最大认证次数'));
    S.sugMax = add(maxField, el('input', 'field-input')); S.sugMax.type = 'number';
    S.sugMax.min = '1'; S.sugMax.max = '100'; S.sugMax.value = '6';
    var sugOps = add(sug.panel, el('div', 'sg-sug-ops sg-sug-form-ops'));
    S.sugBtn = add(sugOps, el('button', 'btn btn-primary', '生成建议')); S.sugBtn.type = 'button';
    on(S.sugBtn, submitSuggest);
    S.sugMsgHost = add(sugOps, el('span', 'sg-msg', ''));
    add(sug.panel, el('p', 'field-hint', '只读生成：建议配置 + 差异 + 风险（含回滚）+ 可复制命令；不会修改 /etc/ssh，也没有「一键应用」。'));
    S.sugHost = add(sug.panel, el('div', 'sg-sug-result'));
    paintSuggestResult();

    paintStatus(); paintAttempts(); paintBans(); paintBanForm(); paintBanMsg();
    refreshAll();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreSshGuard = { render: render };
})();
