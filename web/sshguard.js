/* kore 主壳 · SSH 防护（web/sshguard.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/ssh-guard/ssh-guard.<verb>（方法名必须带域前缀）。
   读：status / attempts / ban.list / whitelist；写：ban.add（不可回滚，需一次性 confirm 令牌）/
       ban.remove / whitelist.add / whitelist.remove / config.set。
   真实契约（照插件 0.4.0，别凭空加参数）：
   · ban.list 收 {limit, offset, address, source}，每条给 address / source / rule / banned_at /
     banned_at_source / remaining_s / whitelisted；applied 恒 false（只读）。
   · ban.add 只收 {ip, confirm}——**没有时长参数**，封禁时长由 fail2ban 的 bantime 决定；
     confirm 必须先用 GET /api/v1/plugins/ssh-guard/root-action/fail2ban-banip/confirm-token 换一次性令牌。
   · ban.remove 只收 {ip}，是恢复性动作、不需要令牌。
   · whitelist 只读；whitelist.add / whitelist.remove 收 {ip, note?}，是保护性配置（不需要 confirm 令牌），
     页面负责"明确提示 + 二次确认"。白名单 IP 的 ban.add 会被插件直接拒绝（E_CONFLICT，防误封自己）。
   · config.set 收 {bantime_s}：fail2ban 的 bantime 插件读不到，运维填了才能算出封禁剩余时长。
   降级：fail2ban 未装/未运行或本进程拿不到日志 → 只读模式（黄底说明需要什么），写按钮从一开始就禁用。 */
(function () {
  'use strict';
  // 方法名必须带域前缀：内核 validateMethod 要求点分方法的域 == 路径里的插件 id
  // （internal/core/httpapi/handlers_invoke.go:81），所以 API 常量直接含 'ssh-guard.'。
  // 漏掉前缀时 status（无点）能过，但 ban.list / whitelist.add / config.get 会被
  // 判成"域与插件不一致"回 E_INVALID——本页曾经因此整块功能不可用。
  var API = '/api/v1/invoke/ssh-guard/ssh-guard.', TOKEN_API = '/api/v1/plugins/ssh-guard/root-action/fail2ban-banip/confirm-token';
  var DROPIN_FILE = 'kore-ssh-guard-hardening.conf';
  var DROPIN_PATH = '/etc/ssh/sshd_config.d/' + DROPIN_FILE;
  var RUNBOOK_PRIV = 'docs/RUNBOOK.md#5-以-root-启动-kored-与提权通道adr-0018';
  var WINDOWS = [{ v: '24h', label: tr('sshguard.window.24h', '最近 24 小时') }, { v: '7d', label: tr('sshguard.window.7d', '最近 7 天') }];

  function fresh() {
    return { root: null, status: null, statusError: '', statusCode: '', statusHint: '',
      attempts: null, attemptsLoaded: false, attemptsError: '', win: '24h',
      bans: [], bansLoaded: false, bansError: '', bansCode: '', bansHint: '', bansNote: '', bansSource: '',
      bansAvailable: false, bansWhitelisted: 0, bansTotal: 0, bansEngine: '',
      // sel 是"已勾选待批量解封"的地址集合（对象当 Set 用，值恒 true）
      sel: {}, selAll: false,
      // 批量封禁：一行一个 IP（也接受逗号/空格分隔），逐条执行并汇总结果
      banTargets: '', banMsg: '', banTone: '', banProgress: '', busy: false, confirmUnban: '',
      // 白名单（自保）：wl 是 whitelist 结果；wlPending 是"等用户二次确认"的 IP
      wl: null, wlLoaded: false, wlError: '', wlCode: '', wlHint: '', wlIp: '', wlPending: '', wlMode: '',
      wlMsg: '', wlTone: '', wlBusy: false,
      // 封禁时长（fail2ban bantime，秒；0 = 未知）：填了才能算剩余时长
      bantimeMin: '', btMsg: '', btTone: '', btBusy: false,
      readOnly: true, readOnlyWhy: '', notInstalled: false, destroyed: false,
      // 加固建议（suggest）：生成预览；一键应用/回滚（0.5.0）才写宿主
      sugPw: false, sugRoot: false, sugBusy: false, sugResult: null, sugError: '', sugHint: '', sugMsg: '', sugTone: '',
      hardBusy: false, hardMsg: '', hardTone: '', applyConfirm: null, rollbackConfirm: false };
  }
  var S = fresh();

  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  // 本地化（ADR-0021）：切英文后本页用户可见文案走 en-US 表；语言包未就绪/缺键时
  // i18n.t 返回键名本身，这里以 hit !== key 拦截并回退到原中文，中文态零影响、不露裸键。
  function tr(key, fallback, params) {
    var i18n = window.KoreI18n;
    if (i18n && typeof i18n.t === 'function') {
      var hit = i18n.t(key, params);
      if (hit && hit !== key) return hit;
    }
    var out = fallback === undefined || fallback === null ? key : String(fallback);
    if (params) {
      for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k)) out = out.split('{' + k + '}').join(String(params[k]));
      }
    }
    return out;
  }
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
    if (!token) return Promise.reject(new Error(tr('sshguard.err.noCsrf', '缺少 CSRF 令牌，请刷新页面或重新登录')));
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
        var err = new Error(data.message || (tr('sshguard.err.http', '请求失败（HTTP ') + res.status + '）'));
        err.code = data.code || ''; err.detail = data.detail || ''; err.hint = data.hint || ''; err.status = res.status; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error(tr('sshguard.err.timeout', '请求超时（15 秒）'));
      throw err;
    });
  }
  function invoke(verb, params) { return request(API + verb, params || {}); }
  function rootActionToken(actionID) {
    return request('/api/v1/plugins/ssh-guard/root-action/' + actionID + '/confirm-token', {}, 'GET')
      .then(function (r) { return (r && (r.token || r.confirm || r.confirm_token)) || ''; });
  }
  function setHardMsg(text, tone) {
    S.hardMsg = text || ''; S.hardTone = tone || ''; paintHardMsg();
  }
  function paintHardMsg() {
    if (!S.hardMsgHost) return;
    S.hardMsgHost.textContent = S.hardMsg || '';
    S.hardMsgHost.className = 'sg-msg' + (S.hardTone === 'fail' ? ' is-fail' : (S.hardTone === 'ok' ? ' is-ok' : ''));
  }

  // ---- 白话 ----
  function engineText(p) {
    if (!p || !p.available) return tr('sshguard.engine.none', '未检测到防护源');
    if (p.engine === tr('sshguard.cell.fail2ban', 'fail2ban')) return tr('sshguard.cell.fail2ban', 'fail2ban') + (p.version ? tr('sshguard.sep.dot', ' · ') + p.version : '');
    if (p.engine === 'sshd') return tr('sshguard.engine.sshdOnly', '仅 sshd 日志（无自动封禁）');
    return tr('sshguard.engine.none', '未检测到防护源');
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
    if (left <= 0) return tr('sshguard.remain.expired', '已到期');
    if (left >= 1440) return Math.floor(left / 1440) + tr('sshguard.remain.days', ' 天 ') + (left % 1440 >= 60 ? Math.floor((left % 1440) / 60) + tr('sshguard.remain.hours', ' 小时') : '');
    if (left >= 60) return Math.floor(left / 60) + ' 小时 ' + (left % 60) + tr('sshguard.remain.minutes', ' 分钟');
    return left + tr('sshguard.remain.minutes', ' 分钟');
  }
  // remainSecs：把后端给的剩余秒数说成人话（0 秒 = 已到 fail2ban 的 bantime，等下一次清理）。
  function remainSecs(secs) {
    if (secs === null || secs === undefined) return '';
    var n = Number(secs);
    if (!isFinite(n) || n < 0) return '';
    if (n === 0) return tr('sshguard.remain.due', '已到时长上限，等 fail2ban 清理');
    if (n >= 86400) return Math.floor(n / 86400) + tr('sshguard.remain.days', ' 天 ') + Math.floor((n % 86400) / 3600) + tr('sshguard.remain.hours', ' 小时');
    if (n >= 3600) return Math.floor(n / 3600) + tr('sshguard.remain.hours', ' 小时') + ' ' + Math.floor((n % 3600) / 60) + tr('sshguard.remain.minutes', ' 分钟');
    if (n >= 60) return Math.floor(n / 60) + tr('sshguard.remain.minutes', ' 分钟');
    return n + tr('sshguard.unit.secs', ' 秒');
  }
  // banTimeText：封禁时刻 + 来源标注（observed=本插件亲测、log=日志推断），推断必须标明。
  function banTimeText(item) {
    if (!item.banned_at) return '—';
    var base = fmtTime(item.banned_at);
    if (item.banned_at_source === 'log') return base + tr('sshguard.ban.atInferred', '（推断）');
    return base;
  }
  // kindBars：失败类型分布（自绘横条，数值+单位常显，不依赖 hover；G-32「每个数据点可读」）。
  function kindBars(kinds, failed) {
    var box = el('div', 'sg-kinds');
    add(box, el('span', 'sg-cell-label sg-kinds-title',
      tr('sshguard.kinds.title', '失败类型分布（共 ') + (failed || 0) + tr('sshguard.kinds.total', ' 次失败）')));
    kinds.forEach(function (k) {
      var row = add(box, el('div', 'sg-kind'));
      add(row, el('span', 'sg-kind-name', k.label || k.kind || '—'));
      var track = add(row, el('span', 'sg-bar sg-bar-wide'));
      var fill = add(track, el('span', 'sg-bar-fill'));
      fill.style.width = Math.max(4, Math.min(100, k.ratio || 0)) + '%';
      var text = (k.count || 0) + tr('sshguard.unit.times', ' 次') + ' · ' + (k.ratio || 0) + '%';
      var val = add(row, el('span', 'sg-kind-val', text));
      val.setAttribute('title', (k.label || k.kind || '') + tr('sshguard.sep.colon', '：') + text);
    });
    return box;
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
    if (!err) return verb + tr('sshguard.word.fail', '失败');
    var f = errorView(err);
    if (f.mapped) return f.title; // 同一 code 在任何页面都是这一句
    return verb + tr('sshguard.word.failColon', '失败：') + (err.message || tr('sshguard.word.reasonUnknown', '原因未知')) + (err.hint ? '（' + err.hint + '）' : '');
  }
  // failureBlock：状态 / 列表级错误卡片（统一标题 + 可执行下一步 + 原始错误折叠）。
  function failureBlock(err, cmd) {
    var f = errorView(err), box = el('div', 'sg-callout sg-callout-warn');
    box.setAttribute('role', 'status');
    add(box, el('div', 'sg-callout-title', f.mapped ? f.title : tr('sshguard.err.operationFail', '操作失败')));
    add(box, el('p', 'sg-callout-text', f.mapped
      ? f.action
      : tr('sshguard.label.reason', '原因：') + ((err && err.message) || tr('sshguard.word.reasonUnknown', '原因未知')) + (err && err.hint ? '（' + err.hint + '）' : '')));
    if (cmd) add(box, el('pre', 'sg-cmd', cmd));
    var raw = (err && err.message) ? String(err.message) : '';
    if (raw) {
      var details = add(box, el('details', 'sg-details'));
      add(details, el('summary', null, tr('sshguard.btn.viewRaw', '查看原始错误')));
      add(details, el('pre', null, raw));
    }
    var p = add(box, el('p', 'sg-callout-text'));
    var a = add(p, el('a', 'sg-link', tr('sshguard.btn.runbook', '查看运行手册')));
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
      add(d, el('summary', null, tr('sshguard.btn.viewBackendHint', '查看后端原始提示')));
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
      window.KoreShell.openConfig(S.root, 'ssh-guard', { title: tr('sshguard.cfg.title', 'SSH 防护设置'), onSaved: refreshAll });
    } else {
      S.attemptsError = tr('sshguard.err.cfgUnavailable', '配置面板未加载，请刷新页面后重试'); paintAttempts();
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
        S.statusHost.appendChild(emptyBlock(missing.mapped ? missing.title + tr('sshguard.sep.colon', '：') + missing.action
          : '还没有安装 SSH 防护插件（页面先把「怎么装」给你，不留空白）。', tr('sshguard.btn.goStore', '去软件商店安装'), goStore));
      } else {
        S.statusHost.appendChild(failureBlock({ code: S.statusCode, message: S.statusError, hint: S.statusHint },
          S.statusCode === 'E_NEED_ROOT' ? tr('sshguard.cmd.restartKore', 'sudo systemctl restart kore') : ''));
      }
      return;
    }
    if (S.notInstalled) { S.notInstalled = false; hidePanels(false); }
    if (!S.status) { add(S.statusHost, el('div', 'sg-loading', tr('sshguard.status.loading', '正在读取 SSH 防护状态…'))); return; }
    var st = S.status, p = st.protection || {};
    var protect = !!p.available && p.engine === tr('sshguard.cell.fail2ban', 'fail2ban') && !!p.fail2ban_active;
    S.readOnly = !protect;
    S.readOnlyWhy = protect ? '' : tr('sshguard.readonly.why', '当前没有可用的自动封禁能力（fail2ban 未装或未运行），封禁/解封按钮已禁用。');
    var top = add(S.statusHost, el('div', 'sg-status-top'));
    top.appendChild(chip(protect ? 'ok' : 'warn', protect ? tr('sshguard.badge.autoBan', '自动封禁已启用') : tr('sshguard.badge.readonly', '只读模式')));
    top.appendChild(chip('na', tr('sshguard.label.source', '防护源：') + engineText(p)));
    var grid = add(S.statusHost, el('div', 'sg-grid'));
    [
      [tr('sshguard.cell.engine', '防护引擎'), engineText(p)],
      [tr('sshguard.cell.fail2ban', 'fail2ban'), p.fail2ban_installed ? (p.fail2ban_active ? tr('sshguard.fail2ban.running', '已安装 · 运行中') : tr('sshguard.fail2ban.stopped', '已安装 · 未运行')) : tr('sshguard.fail2ban.notInstalled', '未安装')],
      [tr('sshguard.cell.logSource', '日志来源'), p.log_source && p.log_source !== 'none' ? p.log_source : tr('sshguard.logSource.denied', '读不到（权限不足）')],
      [tr('sshguard.cell.banned', '当前封禁'), String(p.banned_count == null ? '—' : p.banned_count) + ' 个'],
      [tr('sshguard.cell.failed24h', '24 小时失败'), String(p.failed_24h == null ? '—' : p.failed_24h) + tr('sshguard.unit.times', ' 次')],
      [tr('sshguard.cell.window', '扫描窗口'), S.win === '7d' ? tr('sshguard.window.7d', '最近 7 天') : tr('sshguard.window.24h', '最近 24 小时')]
    ].forEach(function (it) {
      var cell = add(grid, el('div', 'sg-cell'));
      add(cell, el('span', 'sg-cell-label', it[0]));
      add(cell, el('span', 'sg-cell-value', it[1]));
    });
    if (!protect) {
      S.statusHost.appendChild(guideBox(tr('sshguard.guide.readonlyTitle', '只读模式：能看统计，不能封禁'),
        ['封禁/解封需要 fail2ban 在运行，并且 kored 经内核提权通道执行 fail2ban-client。',
         tr('sshguard.guide.missingPrefix', '当前缺的是「') + (!p.fail2ban_installed ? tr('sshguard.guide.notInstalled', 'fail2ban 未安装') : (!p.fail2ban_active ? tr('sshguard.guide.notRunning', 'fail2ban 未运行') : tr('sshguard.guide.noPriv', '提权通道不可用'))) + tr('sshguard.guide.missingSuffix', '」。')],
        p.fail2ban_installed ? [tr('sshguard.cmd.enableFail2ban', 'sudo systemctl enable --now fail2ban')] : [tr('sshguard.cmd.aptFail2ban', 'sudo apt install fail2ban      # Debian / Ubuntu'), tr('sshguard.cmd.dnfFail2ban', 'sudo dnf install fail2ban      # RHEL / Fedora')],
        p.hint || ''));
    }
    if (st.note) add(S.statusHost, el('p', 'field-hint', st.note));
    paintWhitelist(); paintBans(); paintBanForm();
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
    if (!S.attemptsLoaded) { add(S.attemptsHost, el('div', 'sg-loading', tr('sshguard.status.counting', '正在统计登录失败记录…'))); return; }
    var a = S.attempts || {};
    var tops = a.top_ips || [];
    var head = add(S.attemptsHost, el('div', 'sg-attempt-head'));
    head.appendChild(chip(a.failed ? 'warn' : 'ok', (a.failed || 0) + ' 次失败'));
    add(head, el('span', 'sg-cell-label',
      tr('sshguard.attempts.involve', '涉及 ') + (a.unique_ips || 0) + tr('sshguard.attempts.invalidUser', ' 个来源 IP · 无效用户 ') + (a.invalid_users || 0) +
      tr('sshguard.attempts.successLogin', ' 次 · 成功登录 ') + (a.successful_logins || 0) + tr('sshguard.attempts.logSource', ' 次 · 日志来源 ') + (a.source || '—') +
      (a.events_without_time ? tr('sshguard.sep.dot', ' · ') + a.events_without_time + tr('sshguard.attempts.noTime', ' 条无时间戳') : '')));
    // 一句判读：不给结论就只是堆数字。
    var verdict;
    if (!a.failed) verdict = tr('sshguard.verdict.none', '这个窗口内没有登录失败记录：看起来没人在试密码。');
    else {
      var top = tops[0];
      var share = top && a.failed ? Math.round((top.failed / a.failed) * 100) : 0;
      if (tops.length <= 2 && share >= 60)
        verdict = tr('sshguard.verdict.targeted', '失败高度集中在 {n} 个 IP（最高 {ip} 占 {pct}%）：像定向暴力破解，建议直接封这两个地址。', { n: tops.length, ip: top.ip, pct: share });
      else if (tops.length >= 10)
        verdict = tr('sshguard.verdict.distributed', '失败来自 {n} 个以上不同 IP、单 IP 占比不高：像分布式扫描/撞库，建议按 Top IP 逐个封禁并确认密码策略。', { n: tops.length });
      else verdict = tr('sshguard.verdict.spread', '失败分散在 {n} 个 IP：{note}', { n: tops.length, note: a.failed > 100 ? tr('sshguard.verdict.heavy', '量偏大，建议封 Top IP。') : tr('sshguard.verdict.light', '量不大，先观察。') });
    }
    add(S.attemptsHost, el('p', 'sg-verdict', verdict));
    if ((a.kinds || []).length) {
      S.attemptsHost.appendChild(kindBars(a.kinds, a.failed));
    }
    if ((a.timeline_hourly || []).length && (a.failed || 0) > 0) {
      S.attemptsHost.appendChild(svgTimeline(a.timeline_hourly));
    }
    if (!tops.length) {
      S.attemptsHost.appendChild(emptyBlock(tr('sshguard.attempts.noSource', '没有可聚合的失败来源。日志读不到时请检查插件设置里的日志路径，或改用 journal 来源。')));
      return;
    }
    var wrap = add(S.attemptsHost, el('div', 'sg-table-wrap'));
    var table = add(wrap, el('table', 'plugin-table sg-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['来源 IP', '失败次数', '占比', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    tops.slice(0, 10).forEach(function (item) {
      var row = add(tbody, el('tr'));
      add(row, el('td', 'sg-mono', item.ip || '—')).setAttribute('data-label', tr('sshguard.col.sourceIp', '来源 IP'));
      add(row, el('td', 'sg-num', String(item.failed || 0))).setAttribute('data-label', tr('sshguard.col.failCount', '失败次数'));
      var pct = a.failed ? Math.round(((item.failed || 0) / a.failed) * 100) : 0;
      var bar = add(row, el('td', null)); bar.setAttribute('data-label', tr('sshguard.col.ratio', '占比'));
      var track = add(bar, el('span', 'sg-bar')); var fill = add(track, el('span', 'sg-bar-fill'));
      fill.style.width = Math.max(4, Math.min(100, pct)) + '%';
      add(bar, el('span', 'sg-cell-label', pct + '%'));
      var ops = add(row, el('td', 'sg-ops')); ops.setAttribute('data-label', tr('sshguard.col.actions', '操作'));
      var btn = add(ops, el('button', 'btn btn-ghost', tr('sshguard.btn.banIp', '封禁此 IP'))); btn.type = 'button';
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
    var label = add(box, el('span', 'sg-cell-label', tr('sshguard.chart.label', '每小时失败次数（最高 ') + max + ' 次）'));
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
    svg.setAttribute('aria-label', tr('sshguard.chart.aria', '按小时统计的登录失败次数：悬停或点按柱子读出每格数值'));
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
      rect.setAttribute('aria-label', (item.hour || '') + tr('sshguard.sep.colon', '：') + v + ' 次失败');
      rect.addEventListener('pointerenter', function () { showTip(rect, item); });
      rect.addEventListener('pointerdown', function () { pinned = true; showTip(rect, item); });
      svg.appendChild(rect);
    });
    svg.addEventListener('pointerleave', function () { if (!pinned) tip.hidden = true; });
    box.appendChild(svg);
    return box;
  }

  // ---- ③ 白名单（自保）----
  // 产品口径：fail2ban 封的是"来源 IP"，而管理员的出口 IP 正是同一个维度——误封一次
  // 就把自己锁在门外。白名单是插件侧的封禁前置门：命中的 IP 在 ban.add 里被直接拒绝
  // （后端硬拦，前端这里只是把"会发生什么"提前讲清楚）。"你的 IP"取自成功登录日志。
  function whitelistSet() {
    var set = {};
    var entries = (S.wl && S.wl.entries) || [];
    for (var i = 0; i < entries.length; i++) { if (entries[i] && entries[i].ip) set[entries[i].ip] = entries[i]; }
    return set;
  }
  function wlChip(ok) {
    return chip(ok ? 'ok' : 'warn', ok ? tr('sshguard.wl.inList', '已在白名单') : tr('sshguard.wl.notInList', '不在白名单'));
  }
  // askWhitelist 打开"明确提示 + 二次确认"：绝不因为一次点击就改白名单。
  function askWhitelist(ip, mode, note) {
    S.wlPending = ip || ''; S.wlMode = mode || 'add'; S.wlNote = note || '';
    S.wlMsg = ''; paintWhitelist();
  }
  function submitWhitelist() {
    if (!S.wlPending || S.wlBusy || S.destroyed) return;
    var ip = S.wlPending, mode = S.wlMode;
    S.wlBusy = true; S.wlMsg = ''; S.wlTone = ''; paintWhitelist();
    var payload = mode === 'remove' ? { ip: ip } : { ip: ip, note: S.wlNote || tr('sshguard.wl.manualNote', '手动填写') };
    invoke(mode === 'remove' ? 'whitelist.remove' : 'whitelist.add', payload).then(function (r) {
      if (S.destroyed) return;
      S.wlBusy = false; S.wlPending = '';
      var added = !!(r && r.added), removed = !!(r && r.removed);
      S.wlMsg = mode === 'remove'
        ? (removed ? tr('sshguard.wl.removed', '已从白名单移除 ') + ip : tr('sshguard.wl.removeNoop', '这个 IP 本来不在白名单里：') + ip)
        : (added ? tr('sshguard.wl.added', '已加入白名单 ') + ip + tr('sshguard.wl.addedTail', '（这个地址不会再被封禁）') : tr('sshguard.wl.addNoop', '这个 IP 早在白名单里：') + ip);
      if (r && r.note) S.wlMsg += tr('sshguard.sep.semicolon', '；') + r.note;
      S.wlTone = (r && (added || removed)) ? 'ok' : '';
      S.wl = (r && r.whitelist) || S.wl;
      paintWhitelist(); loadBans();
    }, function (err) {
      if (S.destroyed) return;
      S.wlBusy = false; S.wlMsg = failureText(err, mode === 'remove' ? tr('sshguard.wl.removeWord', '移出白名单') : tr('sshguard.wl.addWord', '加入白名单'));
      S.wlTone = 'fail'; paintWhitelist();
    });
  }
  function paintWlMsg() {
    if (!S.wlMsgHost) return;
    S.wlMsgHost.textContent = S.wlMsg || '';
    S.wlMsgHost.className = 'sg-msg' + (S.wlTone === 'fail' ? ' is-fail' : (S.wlTone === 'ok' ? ' is-ok' : ''));
  }
  function paintWhitelist() {
    if (!S.wlHost) return;
    S.wlHost.textContent = '';
    if (S.wlMeta) S.wlMeta.textContent = (S.wlLoaded && S.wl) ? (S.wl.count + tr('sshguard.unit.ips', ' 个')) : '';
    paintWlMsg();
    if (S.wlError) {
      S.wlHost.appendChild(failureBlock({ code: S.wlCode, message: S.wlError, hint: S.wlHint }, ''));
      return;
    }
    if (!S.wlLoaded) { add(S.wlHost, el('div', 'sg-loading', tr('sshguard.wl.loading', '正在读取白名单…'))); return; }
    var w = S.wl || {}, entries = w.entries || [], candidates = w.candidates || [];

    // ① 当前 IP 判定（口径写在页面上，不让人误以为这是浏览器 IP）
    var top = add(S.wlHost, el('div', 'sg-wl-top'));
    if (w.current_ip) {
      top.appendChild(wlChip(!!w.current_whitelisted));
      add(top, el('span', 'sg-cell-label', tr('sshguard.wl.currentPrefix', '你最近一次 SSH 登录的 IP：')));
      add(top, el('span', 'sg-mono sg-wl-ip', w.current_ip));
      var seenAt = candidates.length ? fmtTime(candidates[0].last_seen) : '—';
      add(top, el('span', 'sg-cell-label', tr('sshguard.wl.lastSeenPrefix', '（最后成功登录 ') + seenAt + tr('sshguard.wl.lastSeenSuffix', '）')));
      if (!w.current_whitelisted) {
        var addCurrent = add(top, el('button', 'btn btn-primary',
          tr('sshguard.wl.addCurrent', '把 ') + w.current_ip + tr('sshguard.wl.addCurrentTail', ' 加入白名单')));
        addCurrent.type = 'button'; addCurrent.disabled = S.wlBusy;
        on(addCurrent, function () { askWhitelist(w.current_ip, 'add', tr('sshguard.wl.candNote', '最近一次成功 SSH 登录的 IP')); });
      }
    } else {
      top.appendChild(chip('warn', tr('sshguard.wl.unknownChip', '读不到你的登录 IP')));
      add(top, el('p', 'sg-callout-text', tr('sshguard.wl.unknownWhy',
        '插件读不到 SSH 登录日志（当前来源：') + (w.log_source || 'none') +
        tr('sshguard.wl.unknownWhyTail', '），没法自动认出你的 IP。请在下面「手动添加」里填你自己的出口 IP。')));
    }
    add(S.wlHost, el('p', 'field-hint', tr('sshguard.wl.caveat',
      '白名单按 IP 精确匹配，防的是「把自己封在门外」。上面的 IP 是按 SSH 登录日志推算的：如果你不是从这台机器 SSH 过来的（比如只用浏览器打开面板），请手动填你的出口 IP。')));

    // ② 自锁告警：白名单里的 IP 却仍被封着 → 给一键解封
    var locked = w.banned_whitelisted || [];
    if (locked.length) {
      var lockBox = guideBox(tr('sshguard.wl.lockTitle', '白名单里有 IP 仍被封禁（这就是会把自己锁在门外的情况）'),
        [tr('sshguard.wl.lockLine', '这些地址在白名单里，但 fail2ban 还封着：') + locked.join(tr('sshguard.sep.comma', '、'))],
        [], '');
      S.wlHost.appendChild(lockBox);
      var unlockBtn = add(lockBox, el('button', 'btn btn-primary', tr('sshguard.wl.unbanAll', '解封这些 IP')));
      unlockBtn.type = 'button'; unlockBtn.disabled = S.readOnly || S.busy;
      if (S.readOnly) unlockBtn.title = S.readOnlyWhy;
      on(unlockBtn, function () { unbanMany(locked); });
    }

    // ③ 二次确认区（明确提示：会 / 不会发生什么，以及怎么撤销）
    if (S.wlPending) {
      var confirmBox = add(S.wlHost, el('div', 'sg-callout sg-callout-warn sg-wl-confirm'));
      confirmBox.setAttribute('role', 'alertdialog');
      var adding = S.wlMode !== 'remove';
      add(confirmBox, el('div', 'sg-callout-title',
        (adding ? tr('sshguard.wl.confirmAdd', '确定把 ') : tr('sshguard.wl.confirmRemove', '确定把 ')) + S.wlPending +
        (adding ? tr('sshguard.wl.confirmAddTail', ' 加入白名单？') : tr('sshguard.wl.confirmRemoveTail', ' 移出白名单？'))));
      add(confirmBox, el('p', 'sg-callout-text', adding
        ? tr('sshguard.wl.confirmAddText', '加入后这个 IP 不会再被本页封禁——这是防误封自己的保护。请确认它就是你自己的出口 IP；加错了可以随时移除。')
        : tr('sshguard.wl.confirmRemoveText', '移出后它会重新进入自动封禁范围。如果你可能从这个 IP 登录，先别移除，否则下一次误封会把你锁在门外。')));
      var cOps = add(confirmBox, el('div', 'sg-ops'));
      var okBtn = add(cOps, el('button', 'btn btn-primary', adding ? tr('sshguard.wl.doAdd', '确认加入') : tr('sshguard.wl.doRemove', '确认移除')));
      okBtn.type = 'button'; okBtn.disabled = S.wlBusy;
      on(okBtn, submitWhitelist);
      var cancelBtn = add(cOps, el('button', 'btn btn-ghost', tr('sshguard.btn.cancel', '取消')));
      cancelBtn.type = 'button';
      on(cancelBtn, function () { S.wlPending = ''; paintWhitelist(); });
    }

    // ④ 候选 IP：最近成功登录过这台机器的来源（可一键加入）
    var entrySet = whitelistSet(), extra = [];
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c] && candidates[c].ip && !entrySet[candidates[c].ip]) extra.push(candidates[c]);
    }
    if (extra.length) {
      add(S.wlHost, el('span', 'sg-cell-label', tr('sshguard.wl.candTitle', '最近成功登录的 IP（选出你自己的那条加入）')));
      var cwrap = add(S.wlHost, el('div', 'sg-table-wrap'));
      var ctable = add(cwrap, el('table', 'plugin-table sg-table'));
      var chtr = add(add(ctable, el('thead')), el('tr'));
      [tr('sshguard.col.ip', 'IP 地址'), tr('sshguard.wl.colLastLogin', '最后成功登录'), tr('sshguard.wl.colCount', '成功次数'), tr('sshguard.col.actions', '操作')]
        .forEach(function (t) { add(chtr, el('th', null, t)); });
      var cbody = add(ctable, el('tbody'));
      extra.forEach(function (cand) {
        var row = add(cbody, el('tr'));
        add(row, el('td', 'sg-mono', cand.ip)).setAttribute('data-label', tr('sshguard.col.ip', 'IP 地址'));
        add(row, el('td', null, fmtTime(cand.last_seen))).setAttribute('data-label', tr('sshguard.wl.colLastLogin', '最后成功登录'));
        add(row, el('td', 'sg-num', String(cand.success || 0) + tr('sshguard.unit.times', ' 次'))).setAttribute('data-label', tr('sshguard.wl.colCount', '成功次数'));
        var candOps = add(row, el('td', 'sg-ops')); candOps.setAttribute('data-label', tr('sshguard.col.actions', '操作'));
        var candBtn = add(candOps, el('button', 'btn btn-ghost', tr('sshguard.wl.addThis', '加入白名单')));
        candBtn.type = 'button'; candBtn.disabled = S.wlBusy;
        on(candBtn, function () { askWhitelist(cand.ip, 'add', tr('sshguard.wl.candNote', '最近一次成功 SSH 登录的 IP')); });
      });
    }

    // ⑤ 白名单清单
    if (!entries.length) {
      S.wlHost.appendChild(emptyBlock(tr('sshguard.wl.empty',
        '白名单是空的：现在一旦你的 IP 被封，就只能从别的地址进来解封。建议先把你自己正在用的 IP 加进来。'),
        tr('sshguard.wl.emptyAction', '加我当前的 IP'), function () { if (w.current_ip) askWhitelist(w.current_ip, 'add', tr('sshguard.wl.candNote', '最近一次成功 SSH 登录的 IP')); else if (S.wlInput) S.wlInput.focus(); }));
      return;
    }
    var wrap = add(S.wlHost, el('div', 'sg-table-wrap'));
    var table = add(wrap, el('table', 'plugin-table sg-table sg-table-lg'));
    var htr = add(add(table, el('thead')), el('tr'));
    [tr('sshguard.col.ip', 'IP 地址'), tr('sshguard.wl.colAddedAt', '加入时间'), tr('sshguard.wl.colNote', '备注'), tr('sshguard.col.actions', '操作')]
      .forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    entries.forEach(function (entry) {
      var row = add(tbody, el('tr'));
      add(row, el('td', 'sg-mono', entry.ip)).setAttribute('data-label', tr('sshguard.col.ip', 'IP 地址'));
      add(row, el('td', null, fmtTime(entry.added_at))).setAttribute('data-label', tr('sshguard.wl.colAddedAt', '加入时间'));
      add(row, el('td', null, entry.note || '—')).setAttribute('data-label', tr('sshguard.wl.colNote', '备注'));
      var ops = add(row, el('td', 'sg-ops')); ops.setAttribute('data-label', tr('sshguard.col.actions', '操作'));
      var rmBtn = add(ops, el('button', 'btn btn-ghost', tr('sshguard.wl.remove', '移出白名单')));
      rmBtn.type = 'button'; rmBtn.disabled = S.wlBusy;
      on(rmBtn, function () { askWhitelist(entry.ip, 'remove', ''); });
    });
    if (w.note) add(S.wlHost, el('p', 'field-hint', w.note));
  }

  // ---- ④ 封禁名单 ----
  // 一条记录要回答四件事：谁被拦、凭什么、什么时候封的、还剩多久（读不到就说读不到）。
  function sourceText(item) {
    if (item && item.source === 'fail2ban') return tr('sshguard.source.fail2ban', 'fail2ban 封禁');
    if (item && item.source === 'log') return tr('sshguard.source.inferredShort', '日志推断（未真封）');
    return tr('sshguard.source.unknown', '未知');
  }
  // 推断名单里的 IP 并没有真的被 fail2ban 封禁，解封按钮必须禁用并说明。
  function bansAreInferred() { return !!S.bansSource && S.bansSource !== tr('sshguard.cell.fail2ban', 'fail2ban'); }
  function selectedBans() {
    var out = [];
    (S.bans || []).forEach(function (b) { if (b && b.address && S.sel[b.address]) out.push(b.address); });
    return out;
  }
  function clearSelection() { S.sel = {}; S.selAll = false; }
  function toggleSelect(address, on_) {
    if (on_) S.sel[address] = true; else delete S.sel[address];
    paintBans();
  }
  function paintBans() {
    if (!S.bansHost) return;
    S.bansHost.textContent = '';
    if (S.bansMeta) S.bansMeta.textContent = S.bansLoaded ? (S.bans.length + ' 个') : '';
    if (S.bansError) {
      S.bansHost.appendChild(failureBlock({ code: S.bansCode, message: S.bansError, hint: S.bansHint },
        S.bansCode === 'E_NEED_ROOT' ? tr('sshguard.cmd.restartKore', 'sudo systemctl restart kore') : ''));
      return;
    }
    if (!S.bansLoaded) { add(S.bansHost, el('div', 'sg-loading', tr('sshguard.status.loadingBans', '正在读取封禁名单…'))); return; }
    if (!S.bans.length) {
      S.bansHost.appendChild(emptyBlock(S.readOnly
        ? tr('sshguard.bans.emptyReadonly', '没有封禁记录。自动封禁未启用时，这里不会出现新条目。')
        : tr('sshguard.bans.emptyOk', '当前没有封禁任何 IP。下面「手动封禁」填一个地址即可。')));
      return;
    }
    var inferred = bansAreInferred();
    if (inferred) {
      S.bansHost.appendChild(guideBox(tr('sshguard.guide.inferredTitle', '下面是「可疑 IP」而不是封禁名单'),
        [tr('sshguard.guide.inferredLine1', '当前没有运行中的 fail2ban，插件只能从登录日志里按阈值挑出可疑来源；这些 IP 并没有被真正封禁。'),
         tr('sshguard.guide.inferredLine2', '要真正封禁，请先启动 fail2ban，再用下面的「手动封禁」。')],
        [tr('sshguard.cmd.enableFail2ban', 'sudo systemctl enable --now fail2ban')], S.bansNote));
    } else if (S.bansNote) {
      add(S.bansHost, el('p', 'field-hint', S.bansNote));
    }

    // 批量操作条：勾选 → 批量解封（逐条执行，有失败就逐条报出来）
    var sel = selectedBans();
    var bar = add(S.bansHost, el('div', 'sg-bulk'));
    var selectAllLabel = add(bar, el('label', 'sg-checkwrap'));
    var selectAll = add(selectAllLabel, el('input', 'sg-check'));
    selectAll.type = 'checkbox';
    selectAll.checked = !!S.bans.length && sel.length === S.bans.length;
    selectAll.setAttribute('aria-label', tr('sshguard.bans.selectAll', '全选当前封禁名单'));
    on(selectAll, function () {
      if (selectAll.checked) { S.bans.forEach(function (b) { if (b && b.address) S.sel[b.address] = true; }); }
      else { clearSelection(); }
      paintBans();
    }, 'change');
    add(selectAllLabel, el('span', 'sg-cell-label', tr('sshguard.bans.selectAllLabel', '全选')));
    add(bar, el('span', 'sg-cell-label', sel.length
      ? (tr('sshguard.bans.selectedPrefix', '已选 ') + sel.length + tr('sshguard.unit.items', ' 个'))
      : tr('sshguard.bans.selectHint', '勾选左侧方框可批量解封')));
    var bulkUnban = add(bar, el('button', 'btn sg-unban', tr('sshguard.btn.unbanSelected', '批量解封')));
    bulkUnban.type = 'button';
    bulkUnban.disabled = !sel.length || S.readOnly || S.busy || inferred;
    if (S.readOnly) bulkUnban.title = S.readOnlyWhy;
    if (inferred) bulkUnban.title = tr('sshguard.bans.inferredTitle', '这是从日志推断的可疑 IP，并没有真的被封禁；需要封禁请用下面的「手动封禁」');
    on(bulkUnban, function () { unbanMany(selectedBans()); });

    var wrap = add(S.bansHost, el('div', 'sg-table-wrap'));
    var table = add(wrap, el('table', 'plugin-table sg-table sg-table-lg'));
    var htr = add(add(table, el('thead')), el('tr'));
    add(htr, el('th', 'sg-col-check', ''));
    [tr('sshguard.col.ip', 'IP 地址'), tr('sshguard.col.source', '来源'), tr('sshguard.col.rule', '触发规则'),
      tr('sshguard.col.bannedAt', '封禁时间'), tr('sshguard.col.remaining', '剩余时长'), tr('sshguard.col.actions', '操作')]
      .forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.bans.forEach(function (b) {
      var address = b.address || '';
      var rowNode = add(tbody, el('tr'));
      if (b.whitelisted) rowNode.className = 'sg-row-wl';
      var checkCell = add(rowNode, el('td', 'sg-col-check'));
      var checkWrap = add(checkCell, el('label', 'sg-checkwrap'));
      var box = add(checkWrap, el('input', 'sg-check'));
      box.type = 'checkbox'; box.checked = !!S.sel[address];
      box.setAttribute('aria-label', tr('sshguard.bans.selectOne', '选择 ') + address);
      on(box, function () { toggleSelect(address, box.checked); }, 'change');
      var ipCell = add(rowNode, el('td', 'sg-mono', address || '—'));
      ipCell.setAttribute('data-label', tr('sshguard.col.ip', 'IP 地址'));
      if (b.whitelisted) {
        var wlBadge = chip('warn', tr('sshguard.bans.wlChip', '白名单'));
        wlBadge.className += ' sg-inline-chip';
        ipCell.appendChild(wlBadge);
      }
      add(rowNode, el('td', null, sourceText(b))).setAttribute('data-label', tr('sshguard.col.source', '来源'));
      add(rowNode, el('td', 'sg-rule', b.rule || b.reason || '—')).setAttribute('data-label', tr('sshguard.col.rule', '触发规则'));
      add(rowNode, el('td', null, banTimeText(b))).setAttribute('data-label', tr('sshguard.col.bannedAt', '封禁时间'));
      var remain = '—';
      if (b.source === 'fail2ban') {
        remain = (b.remaining_s === null || b.remaining_s === undefined)
          ? tr('sshguard.bans.remainUnknown', '未知（填「封禁时长」后可算）')
          : remainSecs(b.remaining_s);
      }
      add(rowNode, el('td', 'sg-num', remain)).setAttribute('data-label', tr('sshguard.col.remaining', '剩余时长'));
      var ops = add(rowNode, el('td', 'sg-ops cell-ops')); ops.setAttribute('data-label', tr('sshguard.col.actions', '操作'));
      if (S.confirmUnban === address) {
        add(ops, el('span', 'sg-cell-label', tr('sshguard.bans.confirmUnban', '确定解封？')));
        var yes = add(ops, el('button', 'btn sg-unban', tr('sshguard.btn.confirm', '确认'))); yes.type = 'button';
        var no = add(ops, el('button', 'btn btn-ghost', tr('sshguard.btn.cancel', '取消'))); no.type = 'button';
        on(no, function () { S.confirmUnban = ''; paintBans(); });
        on(yes, function () { S.confirmUnban = ''; unban(address, yes); });
      } else {
        var btn = add(ops, el('button', 'btn sg-unban', tr('sshguard.btn.unban', '解封'))); btn.type = 'button';
        btn.disabled = S.readOnly || S.busy || inferred;
        if (S.readOnly) btn.title = S.readOnlyWhy;
        if (inferred) btn.title = tr('sshguard.bans.inferredTitle', '这是从日志推断的可疑 IP，并没有真的被封禁；需要封禁请用下面的「手动封禁」');
        on(btn, function () { S.confirmUnban = address; paintBans(); });
      }
    });
    if (S.bansWhitelisted) {
      add(S.bansHost, el('p', 'field-hint', tr('sshguard.bans.wlWarn',
        '名单里有 ') + S.bansWhitelisted + tr('sshguard.bans.wlWarnTail', ' 个 IP 在白名单里却仍被封着：先去上面「白名单」用一键解封，否则它们下次还会被封。')));
    }
  }

  // ---- ⑤ 手动封禁（支持批量）----
  function paintBanForm() {
    if (!S.banHint) return;
    var disabled = S.readOnly || S.busy;
    [S.ipInput, S.banBtn, S.btInput, S.btBtn].forEach(function (n) { if (n) n.disabled = disabled || (n === S.btBtn && S.btBusy); });
    S.banHint.textContent = S.readOnly
      ? S.readOnlyWhy + tr('sshguard.ban.hintNeed', ' 需要：fail2ban 在运行 + kored 以 root 启动（提权通道）。')
      : tr('sshguard.ban.hintFlow', '封禁走内核提权通道执行 fail2ban-client；不可回滚，每个 IP 都会先申请一次性确认令牌再提交。白名单里的 IP 会被插件直接拒绝（防误封自己）。');
    if (S.btHint) {
      S.btHint.textContent = tr('sshguard.bt.hint', 'fail2ban 的 bantime 插件读不到，所以默认不显示「剩余时长」。在宿主执行 fail2ban-client get sshd bantime 查到秒数后填进来，封禁清单就能算出还剩多久。');
    }
  }
  // parseTargets 把多行/逗号/空格分隔的目标拆成去重的 IP 列表（一行一个最直观，其他分隔也接受）。
  function parseTargets(raw) {
    var parts = String(raw || '').split(/[\s,;\u3001\uFF0C\uFF1B]+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var ip = parts[i].trim();
      if (ip && out.indexOf(ip) < 0) out.push(ip);
    }
    return out;
  }
  function looksLikeIP(ip) {
    return /^[0-9A-Fa-f:.]+$/.test(ip) && (ip.indexOf(':') >= 0 || ip.indexOf('.') >= 0);
  }
  function submitBan() {
    if (S.readOnly || S.busy) return;
    var ips = parseTargets(S.ipInput ? S.ipInput.value : '');
    if (!ips.length) {
      S.banMsg = tr('sshguard.err.ipEmpty', '请填一个 IP 地址（例如 203.0.113.7）'); S.banTone = 'fail';
      paintBanMsg(); if (S.ipInput) S.ipInput.focus(); return;
    }
    var bad = ips.filter(function (ip) { return !looksLikeIP(ip); });
    if (bad.length) {
      S.banMsg = tr('sshguard.err.ipFormat', 'IP 格式不对：只接受纯 IPv4 / IPv6 地址（不支持网段）') + tr('sshguard.sep.colon', '：') + bad.slice(0, 3).join(tr('sshguard.sep.comma', '、'));
      S.banTone = 'fail'; paintBanMsg(); return;
    }
    // 白名单前置提示：真正拦截在后端（E_CONFLICT），这里先挡住，省掉一轮令牌申请与失败。
    var set = whitelistSet();
    var blocked = ips.filter(function (ip) { return !!set[ip]; });
    if (blocked.length) {
      S.banMsg = tr('sshguard.err.whitelisted', '这些 IP 在白名单里，封禁会被拒绝（防止把你自己锁在门外）：') + blocked.join(tr('sshguard.sep.comma', '、')) + tr('sshguard.err.whitelistedTail', '。请先到「白名单」移除，再封禁。');
      S.banTone = 'fail'; paintBanMsg(); return;
    }
    S.busy = true; S.banTone = '';
    var ok = 0, failed = [], index = 0;
    function finish() {
      if (S.destroyed) return;
      S.busy = false;
      var head = ok ? (tr('sshguard.ban.batchDone', '已封禁 ') + ok + tr('sshguard.unit.items', ' 个') + (failed.length ? tr('sshguard.ban.batchPartial', '，失败 ') + failed.length + tr('sshguard.unit.items', ' 个') : ''))
        : tr('sshguard.ban.batchNone', '一个都没封成功');
      S.banMsg = head + (failed.length ? tr('sshguard.sep.colon', '：') + failed.join(tr('sshguard.sep.semicolon', '；')) : '');
      S.banTone = ok ? (failed.length ? '' : 'ok') : 'fail';
      if (ok && S.ipInput) S.ipInput.value = '';
      paintBanMsg(); paintBanForm(); loadBans(); loadStatus(); loadWhitelist();
    }
    function step() {
      if (index >= ips.length) { finish(); return; }
      var ip = ips[index++];
      S.banMsg = tr('sshguard.status.banning', '正在封禁 ') + ip + tr('sshguard.ban.progress', '（') + index + '/' + ips.length + tr('sshguard.ban.progressTail', '）…');
      paintBanMsg();
      request(TOKEN_API, undefined, 'GET').then(function (tok) {
        var token = tok && (tok.token || tok.confirm || tok.confirm_token);
        if (!token) throw new Error(tr('sshguard.err.noToken', '内核没有返回确认令牌'));
        return invoke('ban.add', { ip: ip, confirm: token });
      }).then(function (r) {
        if (r && r.applied) {
          ok++;
          if (!r.verified) failed.push(ip + tr('sshguard.sep.colon', '：') + (r.note || tr('sshguard.ban.refreshNote', '已执行，但回读未确认')));
        } else {
          failed.push(ip + tr('sshguard.sep.colon', '：') + ((r && r.note) || tr('sshguard.ban.noResult', '没有确认到封禁结果')));
        }
        step();
      }, function (err) {
        // 白名单拒绝（E_CONFLICT）要说清楚"该改哪里"，不能被通用冲突文案盖过去。
        var why = (err && err.code === 'E_CONFLICT')
          ? tr('sshguard.err.wlRefused', '这个 IP 在白名单里，封禁被拒绝（防止把你锁在门外）——请先到「白名单」移除它')
          : failureText(err, tr('sshguard.word.ban', '封禁'));
        failed.push(ip + tr('sshguard.sep.colon', '：') + why);
        step();
      });
    }
    step();
  }
  function unban(ip, btn) {
    if (S.readOnly || S.busy) return;
    S.busy = true; if (btn) btn.disabled = true;
    S.banMsg = tr('sshguard.status.unbanning', '正在解封 ') + ip + '…'; S.banTone = ''; paintBanMsg();
    invoke('ban.remove', { ip: ip }).then(function (r) {
      if (S.destroyed) return;
      S.busy = false;
      S.banMsg = tr('sshguard.unban.done', '已解封 ') + ip + (r && r.verified ? tr('sshguard.unban.verified', '（已回读确认）') : '');
      S.banTone = 'ok'; paintBanMsg(); paintBans(); loadStatus(); loadWhitelist();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.banMsg = failureText(err, tr('sshguard.btn.unban', '解封')); S.banTone = 'fail';
      paintBanMsg(); paintBans();
    });
  }
  // unbanMany 逐条解封（fail2ban-client 一次只接受一个 banip/unbanip 追加参数，
  // 所以批量必须串行；有失败就逐条列出，不做"看起来全成功"的合并汇总）。
  function unbanMany(ips) {
    if (!ips || !ips.length || S.readOnly || S.busy) return;
    S.busy = true; S.banTone = '';
    S.banMsg = tr('sshguard.status.unbanningMany', '正在解封 ') + ips.length + tr('sshguard.unit.items', ' 个 IP…');
    paintBanMsg(); paintBans(); paintBanForm();
    var ok = 0, failed = [], index = 0;
    function step() {
      if (index >= ips.length) {
        if (S.destroyed) return;
        S.busy = false;
        S.banMsg = tr('sshguard.unban.done', '已解封 ') + ok + tr('sshguard.unit.items', ' 个') +
          (failed.length ? tr('sshguard.ban.batchPartial', '，失败 ') + failed.length + tr('sshguard.unit.items', ' 个') + tr('sshguard.sep.colon', '：') + failed.join(tr('sshguard.sep.semicolon', '；')) : '');
        S.banTone = ok ? (failed.length ? '' : 'ok') : 'fail';
        clearSelection(); paintBanMsg(); paintBans(); paintBanForm(); loadBans(); loadStatus(); loadWhitelist();
        return;
      }
      var ip = ips[index++];
      S.banMsg = tr('sshguard.status.unbanning', '正在解封 ') + ip + tr('sshguard.ban.progress', '（') + index + '/' + ips.length + tr('sshguard.ban.progressTail', '）…');
      paintBanMsg();
      invoke('ban.remove', { ip: ip }).then(function () { ok++; step(); }, function (err) {
        failed.push(ip + tr('sshguard.sep.colon', '：') + failureText(err, tr('sshguard.btn.unban', '解封')));
        step();
      });
    }
    step();
  }
  // saveBantime 把运维填的 fail2ban bantime（分钟）写进插件配置：之后封禁清单才能算剩余时长。
  function saveBantime() {
    if (!S.btInput || S.btBusy) return;
    var raw = (S.btInput.value || '').trim();
    var minutes = raw === '' ? 0 : parseInt(raw, 10);
    if (!/^[0-9]*$/.test(raw) || isNaN(minutes) || minutes < 0 || minutes > 525600) {
      S.btMsg = tr('sshguard.bt.bad', '请填 0–525600 的整数分钟（0 表示未知、不推算剩余时长）');
      S.btTone = 'fail'; paintBtMsg(); return;
    }
    S.btBusy = true; S.btMsg = tr('sshguard.bt.saving', '正在保存封禁时长…'); S.btTone = ''; paintBtMsg(); paintBanForm();
    invoke('config.set', { bantime_s: minutes * 60 }).then(function (r) {
      if (S.destroyed) return;
      S.btBusy = false;
      var secs = (r && r.bantime_s) || 0;
      S.btMsg = secs > 0
        ? (tr('sshguard.bt.saved', '已保存：fail2ban 封禁时长 ') + Math.round(secs / 60) + tr('sshguard.bt.savedTail', ' 分钟（封禁清单会据此算剩余时长）'))
        : tr('sshguard.bt.cleared', '已清除封禁时长：封禁清单不再显示剩余时长');
      S.btTone = 'ok'; paintBtMsg(); loadBans();
    }, function (err) {
      if (S.destroyed) return;
      S.btBusy = false; S.btMsg = failureText(err, tr('sshguard.bt.word', '保存封禁时长')); S.btTone = 'fail';
      paintBtMsg(); paintBanForm();
    });
  }
  function paintBtMsg() {
    if (!S.btMsgHost) return;
    S.btMsgHost.textContent = S.btMsg || '';
    S.btMsgHost.className = 'sg-msg' + (S.btTone === 'fail' ? ' is-fail' : (S.btTone === 'ok' ? ' is-ok' : ''));
  }
  function paintBanMsg() {
    if (!S.banMsgHost) return;
    S.banMsgHost.textContent = S.banMsg || '';
    S.banMsgHost.className = 'sg-msg' + (S.banTone === 'fail' ? ' is-fail' : (S.banTone === 'ok' ? ' is-ok' : ''));
  }

  // ---- ⑤ 加固建议（suggest）----
  // 生成预览：调 ssh-guard.suggest 拿 config_text / diff / risk / apply_commands（dry-run）；
  // 真正下发走本文件 ⑤-b 的一键应用/回滚（插件 0.5.0 受控写通道，见 hardening.go）。
  function copyTo(text, msgEl) {
    function done() { if (msgEl) { msgEl.textContent = tr('sshguard.copy.done', '已复制'); msgEl.className = 'sg-msg is-ok'; } }
    function fail() { if (msgEl) { msgEl.textContent = tr('sshguard.copy.fail', '复制失败：请手动选中文本复制'); msgEl.className = 'sg-msg is-fail'; } }
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
      S.sugError = ''; S.sugResult = null; S.sugMsg = tr('sshguard.err.portRange', '端口必须是 1–65535 的整数（留空表示保持当前端口）');
      S.sugTone = 'fail'; paintSugMsg(); paintSuggestResult(); S.sugPort.focus(); return;
    }
    var max = (S.sugMax.value || '').trim();
    if (max && (!/^[0-9]+$/.test(max) || +max < 1 || +max > 100)) {
      S.sugError = ''; S.sugResult = null; S.sugMsg = tr('sshguard.err.maxRange', '最大认证次数必须是 1–100 的整数');
      S.sugTone = 'fail'; paintSugMsg(); paintSuggestResult(); S.sugMax.focus(); return;
    }
    S.sugBusy = true; S.sugError = ''; S.sugHint = ''; S.sugMsg = tr('sshguard.status.suggesting', '正在生成建议…'); S.sugTone = ''; paintSugMsg();
    if (S.sugBtn) S.sugBtn.disabled = true;
    invoke('suggest', p).then(function (r) {
      if (S.destroyed) return;
      S.sugBusy = false; if (S.sugBtn) S.sugBtn.disabled = false;
      S.sugResult = r || null; S.sugMsg = ''; S.sugTone = ''; paintSugMsg(); paintSuggestResult();
    }, function (err) {
      if (S.destroyed) return;
      S.sugBusy = false; if (S.sugBtn) S.sugBtn.disabled = false;
      S.sugError = failureText(err, tr('sshguard.word.genSuggest', '生成加固建议')); S.sugHint = err.hint || ''; S.sugResult = null;
      S.sugMsg = ''; paintSugMsg(); paintSuggestResult();
    });
  }
  function paintSuggestResult() {
    if (!S.sugHost) return;
    var host = S.sugHost; host.textContent = '';
    if (S.sugError) {
      add(host, notice(S.sugError, 'fail'));
      if (S.sugHint) add(host, guideBox(tr('sshguard.sug.genFail', '生成失败'), [tr('sshguard.sug.failNote', '这是后端返回的原因，不是登录失效。')], [], S.sugHint));
      return;
    }
    if (!S.sugResult) {
      add(host, el('p', 'field-hint', tr('sshguard.sug.hint', '勾选要加固的项后点「生成建议」：会给出建议配置、与当前值的差异、风险与回滚，以及可整段复制的落地命令。')));
      return;
    }
    var r = S.sugResult, i;
    add(host, el('p', 'sg-sug-note', tr('sshguard.sug.note', '这是只读预览（dry-run）：确认无误后可点「一键应用」经受控写下发，应用不会 reload sshd。')));
    // 建议配置
    var cfg = add(host, el('div', 'sg-sug-sec'));
    add(cfg, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', tr('sshguard.sug.configTitle', '建议配置（/etc/ssh/sshd_config.d/kore.conf）')));
    add(cfg, el('pre', 'sg-cmd sg-sug-pre', r.config_text || ''));
    var cfgOps = add(cfg, el('div', 'sg-sug-ops'));
    var cfgMsg = add(cfgOps, el('span', 'sg-msg', ''));
    add(cfgOps, copyBtn(r.config_text || '', tr('sshguard.btn.copyConfig', '复制配置'), cfgMsg));
    if (r.path_hint) add(cfg, el('p', 'field-hint', r.path_hint));
    // 差异
    var diffs = r.diff_from_current || [];
    var diff = add(host, el('div', 'sg-sug-sec'));
    add(diff, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', tr('sshguard.sug.diffTitle', '与当前值对比')));
    if (diffs.length) {
      diffs.forEach(function (d) {
        var row = add(diff, el('p', 'sg-diff'));
        add(row, el('span', 'sg-mono', (d.directive || '') + tr('sshguard.sep.colon', '：')));
        add(row, el('span', 'sg-diff-cur', String(d.current == null ? '—' : d.current)));
        add(row, el('span', 'sg-diff-arrow', ' → '));
        add(row, el('span', 'sg-diff-new', String(d.suggested == null ? '—' : d.suggested)));
      });
    } else {
      add(diff, el('p', 'field-hint', r.path_hint || tr('sshguard.sug.noDiff', '当前没有可对比的差异（可能未改动任何项）。')));
    }
    // 风险（每条必须显示回滚）
    var risks = r.risk || [];
    if (risks.length) {
      var box = add(host, el('div', 'sg-sug-sec'));
      add(box, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', tr('sshguard.sug.riskTitle', '风险提示（每条都带怎么回滚）')));
      risks.forEach(function (risk) {
        var level = risk.level || 'low';
        var cls = level === 'high' ? ' sg-risk-high' : (level === 'medium' ? ' sg-risk-medium' : ' sg-risk-low');
        var card = add(box, el('div', 'sg-risk' + cls));
        var rh = add(card, el('div', 'sg-risk-head'));
        add(rh, el('span', 'sg-risk-level', level === 'high' ? tr('sshguard.risk.high', '高危') : (level === 'medium' ? tr('sshguard.risk.medium', '注意') : tr('sshguard.risk.low', '提示'))));
        if (risk.code) add(rh, el('span', 'sg-mono', risk.code));
        add(card, el('p', 'sg-risk-msg', risk.message || ''));
        add(card, el('p', 'sg-risk-rollback', tr('sshguard.sug.rollback', '回滚：') + (risk.rollback || tr('sshguard.sug.rollbackDefault', '点本页「一键回滚」，按变更账本撤销；或在管理员会话手工 reload sshd'))));
      });
    }
    // 落地命令（只有复制）
    var applyText = (r.apply_commands || []).join('\n');
    var cmd = add(host, el('div', 'sg-sug-sec'));
    add(cmd, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', tr('sshguard.sug.applyTitle', '落地命令（整段复制，确认后手动执行）')));
    add(cmd, el('pre', 'sg-cmd sg-sug-pre', applyText || tr('sshguard.sug.noCmd', '（后端没有返回命令）')));
    var cmdOps = add(cmd, el('div', 'sg-sug-ops'));
    var cmdMsg = add(cmdOps, el('span', 'sg-msg', ''));
    add(cmdOps, copyBtn(applyText, tr('sshguard.btn.copyAll', '复制全部命令'), cmdMsg));
    var verifyText = (r.verify_commands || []).join('\n');
    if (verifyText) {
      var ver = add(host, el('div', 'sg-sug-sec'));
      add(ver, el('div', 'sg-sug-head')).appendChild(el('span', 'sg-sug-title', tr('sshguard.sug.verifyTitle', '验证命令（sshd -T 看最终生效值）')));
      add(ver, el('pre', 'sg-cmd sg-sug-pre', verifyText));
      var verOps = add(ver, el('div', 'sg-sug-ops'));
      var verMsg = add(verOps, el('span', 'sg-msg', ''));
      add(verOps, copyBtn(verifyText, tr('sshguard.btn.copyVerify', '复制验证命令'), verMsg));
    }
  }

  // ---- ⑤-b 一键应用 / 回滚（只写 drop-in，不 reload）----
  function diffLines(result) {
    var items = (result && result.diff_from_current) || [];
    if (!items.length) return [tr('sshguard.hard.diffNone', '当前配置不可读或没有差异，写入后请用 sshd -T 复核生效值。')];
    return items.map(function (d) {
      return (d.directive || '') + ': ' + String(d.current == null ? '—' : d.current) +
        ' → ' + String(d.suggested == null ? '—' : d.suggested);
    });
  }
  function riskLines(result) {
    var items = (result && result.risk) || [];
    return items.map(function (r) {
      return (r.level === 'high' ? tr('sshguard.risk.high', '高危') : (r.level === 'medium' ? tr('sshguard.risk.medium', '注意') : tr('sshguard.risk.low', '提示'))) +
        ' · ' + (r.message || '') + '（回滚：' + (r.rollback || tr('sshguard.hard.rollbackDefault', '在加固面板点「回滚」，按变更账本撤销')) + '）';
    });
  }
  // confirmDialog 是通用二次确认：正文逐条列出文件名、指令 diff、风险与回滚方式，
  // 并把「下次 sshd 重载生效 + 保留密钥会话别关终端」放到最显眼位置（G-10 用户显式）。
  function confirmDialog(title, lines, warnings, ackLabel, onConfirm) {
    var mask = el('div', 'kore-modal');
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
    var box = add(mask, el('div', 'kore-modal-box sg-hard-modal'));
    add(box, el('div', 'kore-modal-title', title));
    var body = add(box, el('div', 'sg-hard-modal-body'));
    lines.forEach(function (line) { add(body, el('p', 'sg-hard-modal-line', line)); });
    warnings.forEach(function (line) { add(body, el('p', 'sg-hard-modal-warn', line)); });
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', tr('sshguard.btn.cancel', '取消'))); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary', tr('sshguard.btn.confirm', '确认'))); ok.type = 'button';
    var ack = add(ops, el('label', 'sg-hard-ack'));
    var cb = add(ack, el('input', null)); cb.type = 'checkbox';
    add(ack, el('span', null, ackLabel));
    ok.disabled = true;
    on(cb, function () { ok.disabled = !cb.checked; });
    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
    on(cancel, close);
    on(ok, function () { if (!cb.checked) return; close(); onConfirm(); });
    document.body.appendChild(mask);
    return mask;
  }
  function hardSessionWarning() {
    return [
      tr('sshguard.hard.noReload', '应用只写入配置片段，不会重载 sshd：新设置要等下次 sshd 重载/重启才生效。'),
      tr('sshguard.hard.keepSession', '请先确认已有一条可用的密钥登录会话，保留当前终端不要关闭；另开一个会话验证能登录后再自行 reload。')
    ];
  }
  function requestApply() {
    if (S.hardBusy) return;
    if (!S.sugResult) { setHardMsg(tr('sshguard.hard.genFirst', '请先点「生成建议」，确认指令差异后再应用'), 'fail'); return; }
    if (!/^[a-z][a-z0-9._-]*$/.test((S.sugPort.value || '').trim()) && (S.sugPort.value || '').trim()) {
      setHardMsg(tr('sshguard.err.portRange', '端口必须是 1–65535 的整数（留空表示保持当前端口）'), 'fail'); return;
    }
    var params = sugParams();
    if (!params || !Object.prototype.hasOwnProperty.call(params, 'disable_password_auth') &&
        !Object.prototype.hasOwnProperty.call(params, 'disable_root_login') &&
        !Object.prototype.hasOwnProperty.call(params, 'port') &&
        !Object.prototype.hasOwnProperty.call(params, 'max_auth_tries')) {
      setHardMsg(tr('sshguard.hard.pickOne', '请至少勾选一项加固项，应用不写入空配置'), 'fail'); return;
    }
    var lines = [tr('sshguard.hard.file', '将写入文件：') + DROPIN_PATH,
      tr('sshguard.hard.mode', '权限：0644 root:root；内容经受控写 allowlist 校验，不执行任何命令。')]
      .concat([tr('sshguard.hard.diffTitle', '指令差异：')], diffLines(S.sugResult),
        [tr('sshguard.hard.riskTitle', '风险与回滚方式：')], riskLines(S.sugResult));
    confirmDialog(tr('sshguard.hard.applyTitle', '确认一键应用加固？'), lines, hardSessionWarning(),
      tr('sshguard.hard.applyAck', '我已确认有可用密钥会话，明白下次 sshd 重载才生效，保留当前终端不关闭'),
      function () { doApply(params); });
  }
  function doApply(params) {
    S.hardBusy = true; setHardMsg(tr('sshguard.hard.applying', '正在写入加固 drop-in…'), '');
    rootActionToken('sshd-dropin-write').then(function (token) {
      if (!token) throw new Error(tr('sshguard.hard.noToken', '未拿到一次性确认令牌：请确认当前是管理员会话，未写入任何文件'));
      return invoke('apply-hardening', Object.assign({}, params, { confirm: token }));
    }).then(function (r) {
      S.hardBusy = false;
      setHardMsg(tr('sshguard.hard.applied', '已写入 ') + DROPIN_PATH + tr('sshguard.hard.appliedTail', '：应用不 reload，下次 sshd 重载/重启生效。请保留密钥会话并另开会话验证。'), 'ok');
      if (r && r.risk) S.sugResult = Object.assign({}, S.sugResult || {}, { risk: r.risk, diff_from_current: r.diff_from_current || [] });
    }, function (err) {
      S.hardBusy = false; setHardMsg(failureText(err, tr('sshguard.hard.applyWord', '一键应用')), 'fail');
    });
  }
  function requestRollback() {
    if (S.hardBusy) return;
    confirmDialog(tr('sshguard.hard.rollbackTitle', '确认回滚加固？'),
      [tr('sshguard.hard.rollbackFile', '将按变更账本撤销文件：') + DROPIN_PATH,
       tr('sshguard.hard.rollbackHow', '回滚方式：内核受控删除（删前强制备份，账本记 file.restore），不执行 shell 命令；只撤销文件内容，不会逆转 sshd 进程状态。')],
      hardSessionWarning(),
      tr('sshguard.hard.rollbackAck', '我已确认要撤销这条加固写入，并保留密钥会话、明白下次 sshd 重载才读回旧配置'),
      function () {
        S.hardBusy = true; setHardMsg(tr('sshguard.hard.rolling', '正在按变更账本回滚…'), '');
        invoke('rollback-hardening', {}).then(function () {
          S.hardBusy = false; setHardMsg(tr('sshguard.hard.rolled', '已回滚：') + DROPIN_PATH + tr('sshguard.hard.rolledTail', '。下次 sshd 重载/重启读回旧配置；请保留密钥会话。'), 'ok');
        }, function (err) {
          S.hardBusy = false; setHardMsg(failureText(err, tr('sshguard.hard.rollbackWord', '一键回滚')), 'fail');
        });
      });
  }

  // ---- 加载 ----
  function sinceISO() {
    var h = S.win === '7d' ? 24 * 7 : 24;
    // 后端按 RFC3339 严格解析（time.Parse(time.RFC3339)），带毫秒的 toISOString()
    // 会被判非法（E_INVALID）——所以这里裁掉毫秒，只留秒级 'YYYY-MM-DDTHH:MM:SSZ'。
    return new Date(Date.now() - h * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
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
      if (S.destroyed) return; S.attemptsError = failureText(err, tr('sshguard.word.stat', '统计')); S.attemptsLoaded = true; paintAttempts();
    });
  }
  function loadBans() {
    S.bansLoaded = false; S.bansError = ''; S.bansCode = ''; S.bansHint = ''; paintBans();
    // 数据源是 ban.list（插件 0.4.0 起为真实实现）：fail2ban 活跃时是 jail 当前封禁，
    // 没有 fail2ban 时是日志推断的可疑 IP（source 字段逐条标明，不混为一谈）。
    invoke('ban.list', { limit: 100 }).then(function (d) {
      if (S.destroyed) return;
      S.bans = (d && d.bans) || [];
      S.bansSource = (d && d.source) || '';
      S.bansAvailable = !!(d && d.available);
      S.bansEngine = (d && d.engine) || '';
      S.bansNote = (d && d.note) || '';
      S.bansWhitelisted = (d && d.whitelisted) || 0;
      S.bansTotal = (d && d.total) || S.bans.length;
      // 勾选集只保留仍存在的地址（避免解封后批量按钮还记着旧 IP）
      var keep = {};
      S.bans.forEach(function (b) { if (b && b.address && S.sel[b.address]) keep[b.address] = true; });
      S.sel = keep;
      S.bansLoaded = true; paintBans();
    }, function (err) {
      if (S.destroyed) return; S.bansError = err.message; S.bansCode = err.code || ''; S.bansHint = err.hint || ''; S.bansLoaded = true; paintBans();
    });
  }
  function loadWhitelist() {
    S.wlLoaded = false; S.wlError = ''; S.wlCode = ''; S.wlHint = ''; paintWhitelist();
    invoke('whitelist', {}).then(function (d) {
      if (S.destroyed) return;
      S.wl = d || null; S.wlLoaded = true;
      paintWhitelist();
    }, function (err) {
      if (S.destroyed) return; S.wlError = err.message; S.wlCode = err.code || ''; S.wlHint = err.hint || ''; S.wlLoaded = true; paintWhitelist();
    });
  }
  function refreshAll() { loadStatus(); loadAttempts(); loadWhitelist(); loadBans(); }

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
      // P2 danger 治理：解封=移除封禁（可逆，后续可再封）→ 中性灰，不占危险色。
      '.sg-unban{color:var(--kore-text-2);border-color:var(--kore-border-1);}',
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
      /* 白名单（自保）：当前 IP 判定 + 二次确认 + 手动添加行 */
      '.sg-wl-top{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.sg-wl-top .sg-callout-text{flex:1 1 100%;margin:var(--kore-space-1) 0 0;}',
      '.sg-wl-ip{font-size:var(--kore-font-14);word-break:break-all;}',
      '.sg-wl-form{display:grid;grid-template-columns:minmax(0,2fr) auto;gap:var(--kore-space-3);align-items:end;padding:var(--kore-space-3) var(--kore-space-4) 0;}',
      '.sg-wl-confirm{margin:var(--kore-space-2) var(--kore-space-4) 0;}',
      '.sg-inline-chip{margin-left:var(--kore-space-2);vertical-align:middle;}',
      '.sg-row-wl{background:var(--kore-warning-bg);}',
      /* 封禁名单：批量选择 + 新列 */
      '.sg-bulk{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-2) var(--kore-space-4);border-bottom:1px solid var(--kore-border-2);}',
      '.sg-checkwrap{display:inline-flex;align-items:center;justify-content:center;gap:var(--kore-space-1);min-height:44px;min-width:44px;cursor:pointer;}',
      '.sg-check{width:20px;height:20px;flex:0 0 auto;}',
      '.sg-col-check{width:52px;text-align:center;}',
      '.sg-rule{max-width:320px;}',
      /* 失败类型分布（自绘横条，数值常显） */
      '.sg-kinds{display:grid;gap:var(--kore-space-1);padding:var(--kore-space-2) var(--kore-space-4) var(--kore-space-3);}',
      '.sg-kinds-title{display:block;margin-bottom:var(--kore-space-1);}',
      '.sg-kind{display:grid;grid-template-columns:minmax(120px,1fr) 140px minmax(84px,auto);align-items:center;gap:var(--kore-space-2);font-size:var(--kore-font-12);}',
      '.sg-kind-name{color:var(--kore-text-2);word-break:break-word;}',
      '.sg-kind-val{color:var(--kore-text-1);white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.sg-bar-wide{width:100%;}',
      /* 批量封禁输入 + 封禁时长 */
      '.sg-textarea{min-height:84px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.sg-form-single{grid-template-columns:minmax(0,1fr);}',
      '.sg-bt{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) 0;margin-top:var(--kore-space-3);border-top:1px solid var(--kore-border-2);}',
      '.sg-bt-field{flex:0 1 220px;min-width:180px;}',
      '.sg-preset-inline{padding:0;}',
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
      '.sg-hard-modal{max-width:min(680px,92vw);max-height:86vh;overflow:auto;}',
      '.sg-hard-modal-body{max-height:60vh;overflow:auto;}',
      '.sg-hard-modal-line{margin:var(--kore-space-1) 0;color:var(--kore-text-2);font-size:var(--kore-font-12);word-break:break-word;}',
      '.sg-hard-modal-warn{margin:var(--kore-space-1) 0;padding:var(--kore-space-2);border-left:3px solid var(--kore-warning);background:var(--kore-bg-2);font-weight:600;line-height:1.5;}',
      '.sg-hard-ack{display:flex;align-items:flex-start;gap:var(--kore-space-2);font-size:var(--kore-font-12);margin-right:auto;}',
      '.sg-hard-ack input{width:18px;height:18px;flex:0 0 auto;margin-top:2px;}',
      '.sg-hard-apply,.sg-hard-rollback{min-height:44px;}',
      '@media (max-width:639px){',
      '.sg-grid,.sg-form,.sg-sug-form{grid-template-columns:1fr;}',
      '.sg-wl-form{grid-template-columns:1fr;}',
      '.sg-kind{grid-template-columns:1fr;gap:2px;}',
      /* 手机端把宽表拆成"标签 + 值"卡片，避免 7 列表格横向溢出 */
      '.sg-table-lg thead{display:none;}',
      '.sg-table-lg,.sg-table-lg tbody,.sg-table-lg tr,.sg-table-lg td{display:block;width:100%;}',
      '.sg-table-lg tr{padding:var(--kore-space-2) 0;border-top:1px solid var(--kore-border-2);}',
      '.sg-table-lg td{display:grid;grid-template-columns:88px minmax(0,1fr);gap:var(--kore-space-2);padding:var(--kore-space-1) 0;border:0;}',
      '.sg-table-lg td::before{content:attr(data-label);color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.sg-table-lg td.sg-col-check{grid-template-columns:auto;justify-content:start;padding:0;}',
      '.sg-table-lg td.sg-col-check::before{content:none;}',
      '.sg-bulk .btn{width:100%;}',
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
    add(head, el('h2', 'view-title', tr('sshguard.title', 'SSH 防护')));
    add(head, el('p', 'view-sub', tr('sshguard.subtitle', '看看谁在试密码、封掉它、管好白名单——别把你自己封在门外。')));

    // ① 状态
    var st = panel(tr('sshguard.panel.status', '防护状态'), tr('sshguard.panel.statusMeta', '只读探测，不修改 sshd 配置'));
    add(S.root, st.panel);
    var sOps = add(st.meta, el('div', 'actions'));
    var cfg = add(sOps, el('button', 'btn btn-ghost', tr('sshguard.btn.cfg', '防护设置'))); cfg.type = 'button'; on(cfg, openConfig);
    var rf = add(sOps, el('button', 'btn btn-ghost', tr('sshguard.btn.refresh', '刷新'))); rf.type = 'button'; on(rf, refreshAll);
    S.statusHost = add(st.panel, el('div', 'sg-status'));

    // ② 暴力破解统计
    var att = panel(tr('sshguard.panel.attempts', '暴力破解统计'), '');
    add(S.root, att.panel); S.attemptsPanel = att.panel;
    var winWrap = add(att.meta, el('div', 'sg-ops'));
    WINDOWS.forEach(function (w) {
      var b = add(winWrap, el('button', 'btn btn-ghost', w.label)); b.type = 'button';
      b.setAttribute('aria-pressed', S.win === w.v ? 'true' : 'false');
      on(b, function () { S.win = w.v; refreshAll(); });
    });
    S.attemptsHost = add(att.panel, el('div', 'sg-attempts'));

    // ③ 白名单（自保）—— 放在封禁名单之前：先讲清"谁会免于被封"，再谈封谁
    var wlp = panel(tr('sshguard.panel.wl', '白名单（防止把自己封掉）'), '');
    add(S.root, wlp.panel); S.wlPanel = wlp.panel;
    S.wlMeta = add(wlp.meta, el('span', null, ''));
    S.wlHost = add(wlp.panel, el('div', 'sg-wl'));
    var wlForm = add(wlp.panel, el('div', 'sg-wl-form'));
    var wlField = add(wlForm, el('label', 'field'));
    add(wlField, el('span', 'field-label', tr('sshguard.wl.manualLabel', '手动添加 IP（填你自己的出口 IP）')));
    S.wlInput = add(wlField, el('input', 'field-input'));
    S.wlInput.type = 'text'; S.wlInput.placeholder = '203.0.113.7'; S.wlInput.maxLength = 45;
    S.wlInput.setAttribute('autocomplete', 'off'); S.wlInput.setAttribute('spellcheck', 'false');
    S.wlBtn = add(wlForm, el('button', 'btn btn-ghost', tr('sshguard.wl.manualBtn', '加入白名单')));
    S.wlBtn.type = 'button';
    on(S.wlBtn, function () {
      var ip = (S.wlInput.value || '').trim();
      if (!ip) { S.wlMsg = tr('sshguard.err.ipEmpty', '请填一个 IP 地址（例如 203.0.113.7）'); S.wlTone = 'fail'; paintWlMsg(); S.wlInput.focus(); return; }
      if (!looksLikeIP(ip)) { S.wlMsg = tr('sshguard.err.ipFormat', 'IP 格式不对：只接受纯 IPv4 / IPv6 地址（不支持网段）'); S.wlTone = 'fail'; paintWlMsg(); return; }
      askWhitelist(ip, 'add', tr('sshguard.wl.manualNote', '手动填写'));
    });
    S.wlMsgHost = add(wlp.panel, el('p', 'sg-msg', ''));

    // ④ 封禁名单
    var bans = panel(tr('sshguard.panel.bans', '封禁名单'), ''); add(S.root, bans.panel); S.bansPanel = bans.panel;
    S.bansMeta = add(bans.meta, el('span', null, ''));
    S.bansHost = add(bans.panel, el('div', 'sg-bans'));

    // ⑤ 手动封禁（支持批量）+ 封禁时长（fail2ban bantime）
    var form = panel(tr('sshguard.panel.manualBan', '手动封禁'), tr('sshguard.panel.banMeta', '一行一个 IP，可批量'));
    add(S.root, form.panel); S.formPanel = form.panel;
    var grid = add(form.panel, el('div', 'sg-form sg-form-single'));
    var ipField = add(grid, el('label', 'field'));
    add(ipField, el('span', 'field-label', tr('sshguard.ipTargets', '要封禁的 IP（一行一个，也接受逗号/空格分隔）')));
    S.ipInput = add(ipField, el('textarea', 'field-input sg-textarea'));
    S.ipInput.rows = 3;
    S.ipInput.placeholder = '203.0.113.7\n198.51.100.9';
    S.ipInput.maxLength = 2000;
    S.ipInput.setAttribute('autocomplete', 'off'); S.ipInput.setAttribute('spellcheck', 'false');
    var ops = add(form.panel, el('div', 'sg-form-ops'));
    S.banBtn = add(ops, el('button', 'btn btn-primary', tr('sshguard.btn.banThisIp', '封禁这些 IP'))); S.banBtn.type = 'button';
    on(S.banBtn, submitBan);
    S.banMsgHost = add(ops, el('span', 'sg-msg', ''));
    S.banHint = add(form.panel, el('p', 'field-hint', ''));
    // 封禁时长：插件的 ban.add 没有时长参数，时长由宿主 fail2ban 的 bantime 决定；
    // 这里让运维把那个秒数填进来，封禁清单才能把"剩余时长"算成具体分钟。
    var btRow = add(form.panel, el('div', 'sg-bt'));
    var btField = add(btRow, el('label', 'field sg-bt-field'));
    add(btField, el('span', 'field-label', tr('sshguard.bt.label', 'fail2ban 封禁时长（分钟，0 = 未知）')));
    S.btInput = add(btField, el('input', 'field-input'));
    S.btInput.type = 'number'; S.btInput.min = '0'; S.btInput.max = '525600';
    S.btInput.placeholder = tr('sshguard.bt.placeholder', '例如 10');
    var btPresets = add(btRow, el('div', 'sg-preset-row sg-preset-inline'));
    [['10', tr('sshguard.bt.m10', '10 分钟')], ['60', tr('sshguard.bt.h1', '1 小时')], ['1440', tr('sshguard.bt.d1', '1 天')]].forEach(function (p) {
      var pb = add(btPresets, el('button', 'btn btn-ghost sg-preset', p[1])); pb.type = 'button';
      on(pb, function () { if (S.btInput) { S.btInput.value = p[0]; saveBantime(); } });
    });
    S.btBtn = add(btRow, el('button', 'btn btn-ghost', tr('sshguard.bt.save', '保存封禁时长'))); S.btBtn.type = 'button';
    on(S.btBtn, saveBantime);
    S.btMsgHost = add(form.panel, el('p', 'sg-msg', ''));
    S.btHint = add(form.panel, el('p', 'field-hint', ''));

    // ⑤ 加固建议（只读生成，不下发）
    var sug = panel(tr('sshguard.panel.suggest', '加固建议'), tr('sshguard.panel.suggestMeta', '生成建议 · 一键应用/回滚（应用不 reload）'));
    add(S.root, sug.panel); S.sugPanel = sug.panel;
    var sgrid = add(sug.panel, el('div', 'sg-sug-form'));
    function sugToggle(text) {
      var lab = add(sgrid, el('label', 'sg-sug-toggle'));
      var cb = add(lab, el('input', null)); cb.type = 'checkbox';
      add(lab, el('span', null, text));
      return cb;
    }
    S.sugPwCb = sugToggle(tr('sshguard.sug.disablePw', '关闭密码认证（仅保留密钥等）'));
    S.sugRootCb = sugToggle(tr('sshguard.sug.disableRoot', '禁止 root 直接登录'));
    var portField = add(sgrid, el('label', 'field'));
    add(portField, el('span', 'field-label', tr('sshguard.label.port', 'SSH 端口（留空 = 保持当前）')));
    S.sugPort = add(portField, el('input', 'field-input')); S.sugPort.type = 'number';
    S.sugPort.min = '1'; S.sugPort.max = '65535'; S.sugPort.placeholder = tr('sshguard.sug.portPlaceholder', '例如 2222');
    var maxField = add(sgrid, el('label', 'field'));
    add(maxField, el('span', 'field-label', tr('sshguard.label.maxAuth', '最大认证次数')));
    S.sugMax = add(maxField, el('input', 'field-input')); S.sugMax.type = 'number';
    S.sugMax.min = '1'; S.sugMax.max = '100'; S.sugMax.value = '6';
    var sugOps = add(sug.panel, el('div', 'sg-sug-ops sg-sug-form-ops'));
    S.sugBtn = add(sugOps, el('button', 'btn btn-primary', tr('sshguard.btn.genSuggest', '生成建议'))); S.sugBtn.type = 'button';
    on(S.sugBtn, submitSuggest);
    S.applyBtn = add(sugOps, el('button', 'btn btn-ghost sg-hard-apply', tr('sshguard.btn.apply', '一键应用'))); S.applyBtn.type = 'button';
    on(S.applyBtn, requestApply);
    S.rollbackBtn = add(sugOps, el('button', 'btn btn-ghost sg-hard-rollback', tr('sshguard.btn.rollback', '一键回滚'))); S.rollbackBtn.type = 'button';
    on(S.rollbackBtn, requestRollback);
    S.sugMsgHost = add(sugOps, el('span', 'sg-msg', ''));
    S.hardMsgHost = add(sugOps, el('span', 'sg-msg', ''));
    add(sug.panel, el('p', 'field-hint', tr('sshguard.sug.footer', '「生成建议」只读预览；「一键应用」经内核受控写只写 drop-in，不 reload sshd——下次 sshd 重载/重启才生效，请保留密钥会话、别关终端。')));
    S.sugHost = add(sug.panel, el('div', 'sg-sug-result'));
    paintSuggestResult();

    paintStatus(); paintAttempts(); paintWhitelist(); paintBans(); paintBanForm();
    paintBanMsg(); paintWlMsg(); paintBtMsg();
    // 封禁时长回读：config.get 的 bantime_s 预填输入框（缺省 0 = 未知则不填）
    invoke('config.get', {}).then(function (d) {
      if (S.destroyed || !S.btInput) return;
      var secs = (d && d.bantime_s) || 0;
      if (secs > 0) S.btInput.value = String(Math.round(secs / 60));
    }, function () { /* 只读配置读不到不阻塞页面：留空即可 */ });
    refreshAll();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreSshGuard = { render: render };
})();
