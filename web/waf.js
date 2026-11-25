/* kore 主壳 · Web 应用防火墙（web/waf.js）——零框架 / 零 CDN / 无外链。
   调用形态（硬约束，docs/FRONTEND.md §业务方法调用形态）：POST /api/v1/invoke/waf/waf.<action>，
   方法名必须带域前缀，裸动词只有插件兼容层才认。
   读：waf.status / waf.rules / waf.bans / waf.logs；写：waf.toggle（模式 + 防护等级）/ waf.ban / waf.unban；
   配置：waf.config.get/set 经内核通用配置面板（KoreShell.openConfig）打开。
   两个平面分开呈现：引擎平面（宿主已装的 modsecurity/naxsi/coraza/crowdsec，只读探测）与
   kore 自有的 nft 数据面（封禁集合 + 基础防护规则，可写、经 root-action 通道）。
   降级原则（USABILITY ④ + ADR-0018）：引擎没装只影响 HTTP 层规则，IP 封禁照常可用；
   没装 nftables / kored 非 root / 无提权通道时一律给出「怎么办」并把写操作整体禁用，
   不允许"能填、点提交才报错"。本页不轮询（无 timer），刷新由用户点击触发。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/waf/', TIMEOUT_MS = 15000;
  // 提权说明锚点：docs/RUNBOOK.md §5「以 root 启动 kored 与提权通道（ADR-0018）」。
  var RUNBOOK_PRIV = 'docs/RUNBOOK.md#5-以-root-启动-kored-与提权通道adr-0018';

  // 三档模式的用户语言（不出现 observe/enforce/off 这类内部术语）。
  var MODES = [
    { id: 'observe', title: '只记录不拦截', desc: '命中规则只计数和记日志，请求照常放行。用来先观察规则有没有误伤。' },
    { id: 'enforce', title: '直接拦截', desc: '命中规则直接丢包：封禁名单、扫描限速、并发上限全部生效。' },
    { id: 'off', title: '关闭防护', desc: '清空规则，封禁名单保留但不再生效。' }
  ];
  // 封禁时长预设（秒）：预设优先，不让人填秒数。
  var TTL_PRESETS = [
    { value: 3600, label: '1 小时' }, { value: 86400, label: '1 天' },
    { value: 604800, label: '7 天' }, { value: 0, label: '永久（手动解封）' }
  ];

  function fresh() {
    return { root: null, status: null, statusError: '', statusCode: '', statusHint: '',
      count: 0, rules: [], rulesLoaded: false, rulesError: '', rulesCount: 0,
      bans: [], bansLoaded: false, bansError: '', bansCode: '', bansHint: '',
      logs: [], logSources: [], logsLoaded: false, logsError: '',
      canWrite: false, locked: true, rootMissing: false, busy: false, notice: '', noticeTone: '',
      confirmOff: false, confirmMode: '', modeMsg: '', modeTone: '', banMsg: '', banTone: '',
      // 防护等级（0.5.0+）：值从 status.backend.level 或链上内置规则推断。
      level: '', levelBusy: false, levelMsg: '', levelTone: '',
      // 命中分析：独立于「最近记录」列表，按时间范围拉更多记录后在前端聚合。
      hitSince: '24h', hitLogs: [], hitLoaded: false, hitError: '', hitMsg: '', hitTone: '',
      notInstalled: false, destroyed: false };
  }
  var S = fresh();

  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn) { n.addEventListener('click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    } return '';
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + method, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('请求失败（HTTP ' + res.status + '）')));
        err.code = data.code || ''; err.detail = data.detail || ''; err.hint = data.hint || ''; err.status = res.status; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }

  // ---- 文案与格式化 ----
  function modeText(mode) {
    if (mode === 'observe') return '只记录不拦截';
    if (mode === 'enforce') return '直接拦截';
    if (mode === 'off') return '已关闭';
    return '未知';
  }
  function setText(set) {
    if (set === 'banned4') return 'IPv4 封禁';
    if (set === 'banned6') return 'IPv6 封禁';
    return set || '—';
  }
  function fmtRemain(item) {
    if (!item || !item.expires_s) return (item && item.timeout_s ? '即将到期' : '永久');
    var left = item.expires_s, out = [];
    if (left >= 86400) { out.push(Math.floor(left / 86400) + ' 天'); left = left % 86400; }
    if (left >= 3600) { out.push(Math.floor(left / 3600) + ' 小时'); left = left % 3600; }
    if (left >= 60 && out.length < 2) { out.push(Math.floor(left / 60) + ' 分钟'); }
    return out.length ? out.join(' ') + '后到期' : '不到 1 分钟后到期';
  }
  // rulePurpose：把 nft 表达式翻译成一句人能懂的话（原表达式仍保留在第二行，便于核对）。
  function rulePurpose(summary) {
    var text = String(summary || '');
    if (text.indexOf('@banned4') >= 0) return '封禁名单（IPv4）命中即丢包';
    if (text.indexOf('@banned6') >= 0) return '封禁名单（IPv6）命中即丢包';
    if (text.indexOf('meter') >= 0 || text.indexOf('limit rate') >= 0) return '单 IP 扫描限速：SYN 过多即丢包';
    if (text.indexOf('ct count') >= 0) return '单 IP 并发连接上限：超过即丢包';
    return text || '—';
  }
  function fmtBytes(v) {
    var n = Number(v) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
    return (n / 1048576).toFixed(1) + ' MiB';
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function notice(text, tone) {
    var cls = 'notice' + (tone === 'ok' ? ' redis-notice-ok' : '');
    var n = el('div', cls, text); n.setAttribute('role', 'alert'); return n;
  }
  function panel(title, metaText) {
    var p = el('section', 'panel'), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    return { panel: p, head: h, meta: add(h, el('span', 'panel-meta', metaText || '')) };
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
    var f = errorView(err), box = el('div', 'waf-callout waf-callout-warn');
    box.setAttribute('role', 'status');
    add(box, el('div', 'waf-callout-title', f.mapped ? f.title : '操作失败'));
    add(box, el('p', 'waf-callout-text', f.mapped
      ? f.action
      : '原因：' + ((err && err.message) || '原因未知') + (err && err.hint ? '（' + err.hint + '）' : '')));
    if (cmd) add(box, el('pre', 'waf-cmd', cmd));
    var raw = (err && err.message) ? String(err.message) : '';
    if (raw) {
      var details = add(box, el('details', 'waf-details'));
      add(details, el('summary', null, '查看原始错误'));
      add(details, el('pre', null, raw));
    }
    var link = add(box, el('p', 'waf-callout-text'));
    var a = add(link, el('a', 'waf-link', '查看运行手册'));
    a.href = RUNBOOK_PRIV; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return box;
  }
  // guideFor：把后端原因翻译成「怎么办」的黄底块（引擎 / nftables / 通道 / 表未初始化）。
  function guideFor(title, lines, commands, hint) {
    var box = el('div', 'waf-callout waf-callout-warn');
    box.setAttribute('role', 'status');
    add(box, el('div', 'waf-callout-title', title));
    lines.forEach(function (line) { add(box, el('p', 'waf-callout-text', line)); });
    (commands || []).forEach(function (cmd) { add(box, el('pre', 'waf-cmd', cmd)); });
    if (hint) {
      // 后端 hint 往往是一长串安装建议：默认收起，避免把状态卡撑成说明书。
      var details = add(box, el('details', 'waf-details'));
      add(details, el('summary', null, '查看后端原始提示'));
      add(details, el('p', 'waf-callout-text', hint));
    }
    return box;
  }
  function emptyBlock(text, actionLabel, action) {
    // 注意 add() 返回的是**子节点**：容器要先 createElement 再 append，否则样式类丢在游离节点上。
    var box = el('div', 'waf-empty');
    add(box, el('span', null, text));
    if (actionLabel) {
      var btn = add(box, el('button', 'btn btn-ghost', actionLabel));
      btn.type = 'button'; if (action) on(btn, action);
    }
    return box;
  }
  function goStore() {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('store');
    else window.location.hash = '#/store';
  }

  // ---- 状态卡片 ----
  function paintStatus() {
    if (!S.statusHost) return;
    S.statusHost.textContent = '';
    if (S.statusError) {
      if (S.statusCode === 'E_NOTFOUND') {
        // 插件未安装：只留一张「怎么装」的空态卡，隐藏其余面板——
        // 四个相同的 404 红条不是信息，是噪音。标题与下一步同样取自映射表。
        S.notInstalled = true;
        hidePanels();
        var missing = errorView({ code: S.statusCode, message: S.statusError, hint: S.statusHint });
        S.statusHost.appendChild(emptyBlock(missing.mapped ? missing.title + '：' + missing.action
          : '还没有安装 WAF 插件（页面先把「怎么装」给你，不留空白）。',
          '去软件商店安装', goStore));
      } else {
        S.statusHost.appendChild(failureBlock({ code: S.statusCode, message: S.statusError, hint: S.statusHint },
          S.statusCode === 'E_NEED_ROOT' ? 'sudo systemctl restart kore' : ''));
      }
      setLocked(true); return;
    }
    if (S.notInstalled) {
      S.notInstalled = false;
      hidePanels(false);
    }
    if (!S.status) { add(S.statusHost, el('div', 'waf-loading', '正在读取防护状态…')); return; }
    var st = S.status, be = st.backend || {};
    var engineReady = !!st.available;
    // 通道存在 ≠ 有 root：kored 非 root 启动时通道会把动作拒成 E_NEED_ROOT，
    // 插件把原因写在 backend.reason 里。先按它判定，避免"能填、提交才报错"。
    var rootMissing = /E_NEED_ROOT/.test(String(be.reason || '')) || /E_NEED_ROOT/.test(String(st.hint || ''));
    S.rootMissing = rootMissing;
    var backendReady = !!(be.available && be.channel) && !rootMissing;
    S.canWrite = backendReady;
    var top = add(S.statusHost, el('div', 'waf-status-top'));
    top.appendChild(chip(engineReady ? 'ok' : 'na', engineReady ? '引擎已就绪' : '未装 WAF 引擎'));
    top.appendChild(chip(be.present && be.mode !== 'off' ? 'ok' : 'warn',
      be.present ? '数据面：' + modeText(be.mode) : '数据面未初始化'));
    var grid = add(S.statusHost, el('div', 'waf-grid'));
    [
      ['防护引擎', engineReady ? ((st.engine || '—') + (st.version ? ' · ' + st.version : '')) : '未检测到'],
      ['引擎规则', engineReady ? (Number(st.rules_count) || 0) + ' 条' : '—'],
      ['IP 封禁数', be.present ? String(Number(be.banned_count) || 0) : '—'],
      ['已装防护规则', be.present ? String(Number(be.rules_count) || 0) : '—'],
      ['防护模式', modeText(be.mode)],
      ['防护等级', be.present ? levelText(be.level || levelFromChain()) : '—'],
      ['数据面后端', (be.tool || 'nft') + (be.table ? ' · ' + be.table + '/' + (be.chain || 'input') : '')]
    ].forEach(function (item) {
      var cell = add(grid, el('div', 'waf-cell'));
      add(cell, el('span', 'waf-cell-label', item[0]));
      add(cell, el('span', 'waf-cell-value', item[1]));
    });
    // 降级指引：按「引擎 → nftables → 提权通道 → 表状态」顺序只给最该看的那一条。
    if (!engineReady) {
      var engineBox = guideFor('HTTP 层规则没有引擎在管（不影响 IP 封禁）',
        ['kore 不内置 WAF 引擎：装了本插件也只做「IP 封禁 + SYN 扫描限速 + 并发上限」这类网络层防护。' +
        '需要按 URL/参数拦截 SQL 注入、XSS 之类，请另装 ModSecurity 或 Naxsi 并启用对应 nginx 模块。'],
        ['sudo apt install libmodsecurity3', 'apt install nginx-module-modsecurity   # 以发行版包名为准'],
        st.hint || '');
      S.statusHost.appendChild(engineBox);
    }
    if (!be.available) {
      S.statusHost.appendChild(guideFor('本机没有 nftables，IP 封禁与基础防护用不了',
        ['封禁与防护规则落在 kore 自有的 nft 表里（不改宿主既有规则）。装上 nftables 后刷新本页即可。'],
        ['sudo apt install nftables      # Debian / Ubuntu', 'sudo dnf install nftables      # RHEL / Fedora'],
        be.hint || be.reason || ''));
    } else if (rootMissing || !be.channel) {
      S.statusHost.appendChild(failureBlock({ code: 'E_NEED_ROOT', message: be.hint || be.reason || '', hint: be.hint || '' },
        'sudo systemctl restart kore'));
    } else if (!be.present) {
      S.statusHost.appendChild(guideFor('数据面还没初始化（正常，第一次启用时自动建表）',
        ['点下面「只记录不拦截」或「直接拦截」会自动建 kore 自有 nft 表与封禁集合；也可以先加一个封禁 IP。'], [], ''));
    }
    if (S.notice) S.statusHost.parentNode.insertBefore(notice(S.notice, S.noticeTone === 'ok' ? 'ok' : 'fail'),
      S.statusHost.parentNode.firstChild);
    S.level = be.level || S.level;
    paintLevel(); paintModes(); setLocked(!S.canWrite);
  }

  // hidePanels：插件未安装时把「模式/名单/添加/规则/日志」面板整体收起。
  function hidePanels(hidden) {
    var flag = hidden === undefined ? true : !!hidden;
    [S.modePanel, S.levelPanel, S.hitPanel, S.bansPanel, S.formPanel, S.rulesPanel, S.addRulePanel, S.logsPanel].forEach(function (p) {
      if (p) p.hidden = flag;
    });
  }

  // ---- 模式切换 ----
  function paintModes() {
    if (!S.modeHost) return;
    var current = S.status && S.status.backend ? S.status.backend.mode : 'off';
    S.modeHost.textContent = '';
    var wrap = add(S.modeHost, el('div', 'waf-modes'));
    MODES.forEach(function (m) {
      var b = add(wrap, el('button', 'waf-mode'));
      b.type = 'button';
      b.setAttribute('aria-pressed', current === m.id ? 'true' : 'false');
      b.disabled = S.locked || S.busy;
      if (S.locked) b.title = '当前没有可用的提权通道：按状态卡片里的说明重启 kored 后即可切换';
      add(b, el('span', 'waf-mode-title', m.title));
      add(b, el('span', 'waf-mode-desc', m.desc));
      on(b, function () { chooseMode(m.id); });
    });
    if (S.modeMsg) add(S.modeHost, el('div', 'waf-mode-tip waf-msg' + (S.modeTone === 'fail' ? ' is-fail' : (S.modeTone === 'ok' ? ' is-ok' : '')), S.modeMsg));
    if (S.confirmOff) {
      var box = add(S.modeHost, el('div', 'waf-confirm'));
      box.setAttribute('role', 'alertdialog');
      add(box, el('span', null,
        '关闭后封禁名单仍在但不生效，服务器会重新暴露在扫描与暴力破解下。确定关闭防护？'));
      var yes = add(box, el('button', 'btn waf-danger', '确认关闭防护')); yes.type = 'button';
      var no = add(box, el('button', 'btn btn-ghost', '取消')); no.type = 'button';
      on(no, function () { S.confirmOff = false; paintModes(); });
      on(yes, function () { S.confirmOff = false; applyMode('off', true, yes); });
    }
    // 模式切换也要确认：observe → enforce 会立刻开始丢包，enforce → observe 会停止拦截，
    // 两种都会改变线上行为，不允许「点一下就直接生效」。
    if (S.confirmMode) {
      var mbox = add(S.modeHost, el('div', 'waf-confirm'));
      mbox.setAttribute('role', 'alertdialog');
      var mtext = S.confirmMode === 'enforce'
        ? '切换到「直接拦截」后，命中封禁名单 / 扫描限速 / 并发上限的请求会被直接丢弃（客户端看到连接中断）。'
        : '切换到「只记录不拦截」后，命中规则的请求不再被丢弃，服务器会重新暴露在扫描与暴力破解下（只留日志）。';
      add(mbox, el('span', null, mtext + '确定切换？'));
      var myes = add(mbox, el('button', 'btn btn-primary', '确认切换到「' + modeText(S.confirmMode) + '」'));
      myes.type = 'button';
      var mno = add(mbox, el('button', 'btn btn-ghost', '取消')); mno.type = 'button';
      on(mno, function () { S.confirmMode = ''; paintModes(); });
      on(myes, function () {
        var target = S.confirmMode; S.confirmMode = ''; applyMode(target, false, myes);
      });
    }
  }
  function chooseMode(mode) {
    if (S.busy || S.locked) return;
    if (mode === currentMode()) { S.modeMsg = '当前已是「' + modeText(mode) + '」，无需切换。'; S.modeTone = ''; paintModes(); return; }
    S.modeMsg = ''; S.confirmOff = false; S.confirmMode = '';
    if (mode === 'off') { S.confirmOff = true; paintModes(); return; }
    // 观察 ↔ 拦截都是线上行为变化：先给明确提示与确认按钮，再下发。
    S.confirmMode = mode; paintModes();
  }
  function applyMode(mode, confirmOff, btn) {
    if (S.busy) return;
    S.busy = true; S.modeMsg = '正在下发规则并回读校验…'; S.modeTone = ''; paintModes();
    if (btn) btn.disabled = true;
    var params = { mode: mode };
    if (confirmOff) params.confirm = true;
    invoke('waf.toggle', params).then(function (data) {
      if (S.destroyed) return;
      S.busy = false;
      var verified = !!(data && data.applied && data.verified);
      if (verified) {
        S.modeMsg = '已切换为「' + modeText(mode) + '」：规则已下发并回读确认（' +
          ((data.rules || []).length) + ' 条）。';
        S.modeTone = 'ok';
      } else if (data && data.applied) {
        S.modeMsg = '规则已下发，但没有通过回读校验' + (data.hint ? '：' + data.hint : '（建议再点一次或检查 nft 版本）');
        S.modeTone = 'fail';
      } else {
        S.modeMsg = '没有生效' + (data && data.hint ? '：' + data.hint : '（请查看状态卡的提示）');
        S.modeTone = 'fail';
      }
      paintModes(); refreshAll();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false;
      S.modeMsg = failureText(err, '切换防护模式');
      S.modeTone = 'fail';
      if (err && err.code === 'E_NEED_ROOT') { S.locked = true; }
      paintModes(); setLocked(S.locked);
      if (err && err.code === 'E_NEED_ROOT') paintStatus();
    });
  }

  // ---- 封禁名单 ----
  function paintBans() {
    if (S.notInstalled) { if (S.bansHost) S.bansHost.textContent = ''; return; }
    if (!S.bansHost) return;
    S.bansHost.textContent = '';
    S.banCount.textContent = S.bansLoaded ? S.bans.length + ' 个' : '';
    if (S.bansError) {
      if (S.bansCode === 'E_NEED_ROOT') {
        S.rootMissing = true; S.canWrite = false; S.locked = true;
      }
      S.bansHost.appendChild(failureBlock({ code: S.bansCode, message: S.bansError, hint: S.bansHint },
        S.bansCode === 'E_NEED_ROOT' ? 'sudo systemctl restart kore' : ''));
      if (S.bansCode === 'E_NEED_ROOT' && S.statusHost) paintStatus();
      return;
    }
    if (!S.bansLoaded) { add(S.bansHost, el('div', 'waf-loading', '正在读取封禁名单…')); return; }
    if (!S.bans.length) {
      S.bansHost.appendChild(emptyBlock('还没有封禁任何 IP。下面「添加封禁」填一个地址即可，封禁会写进 kore 自有的 nft 集合。'));
      return;
    }
    var scroll = add(S.bansHost, el('div', 'waf-table-wrap'));
    var table = add(scroll, el('table', 'waf-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['IP 地址', '所属集合', '剩余时间', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.bans.forEach(function (item) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', 'waf-num', item.ip)).setAttribute('data-label', 'IP 地址');
      add(tr, el('td', null, setText(item.set))).setAttribute('data-label', '所属集合');
      add(tr, el('td', null, fmtRemain(item))).setAttribute('data-label', '剩余时间');
      var ops = add(tr, el('td', 'waf-ops')); ops.setAttribute('data-label', '操作');
      var btn = add(ops, el('button', 'btn waf-danger', '解封')); btn.type = 'button';
      btn.disabled = !S.canWrite || S.busy;
      btn.title = S.canWrite ? '把这个地址从封禁集合移除' : '需要 root 权限（当前没有提权通道）';
      on(btn, function () { unban(item.ip, btn); });
    });
  }
  function unban(ip, btn) {
    if (!S.canWrite || S.busy) return;
    S.busy = true; btn.disabled = true; S.banMsg = '正在解封 ' + ip + '…'; S.banTone = ''; paintBanMsg();
    invoke('waf.unban', { ip: ip }).then(function (data) {
      if (S.destroyed) return;
      S.busy = false;
      S.banMsg = data && data.removed ? '已解封 ' + ip + '。' : (ip + ' 本来就不在封禁名单里。');
      S.banTone = 'ok';
      paintBanMsg(); loadBans(); loadStatus(); loadRules();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.banMsg = failureText(err, '解封'); S.banTone = 'fail';
      if (err && err.code === 'E_NEED_ROOT') setLocked(true);
      paintBanMsg(); paintBans();
    });
  }
  function paintBanMsg() {
    if (!S.banMsgHost) return;
    S.banMsgHost.textContent = S.banMsg || '';
    S.banMsgHost.className = 'waf-msg' + (S.banTone === 'fail' ? ' is-fail' : (S.banTone === 'ok' ? ' is-ok' : ''));
  }
  function checkIP(raw) {
    var value = String(raw || '').trim();
    if (!value) return '请填一个 IP 地址（例如 203.0.113.7）';
    if (!/^[0-9A-Fa-f:.]{2,45}(\/(\d{1,3}))?$/.test(value)) return '格式看起来不对：只接受 IPv4/IPv6 地址或网段（如 203.0.113.0/24）';
    var parts = value.split('/');
    if (parts.length === 2 && (Number(parts[1]) < 0 || Number(parts[1]) > 128)) return '网段前缀必须在 0–128 之间';
    return '';
  }
  function submitBan() {
    if (!S.canWrite || S.busy) return;
    var ip = S.ipInput.value.trim(), ttl = Number(S.ttlSel.value), reason = S.reasonInput.value.trim();
    var bad = checkIP(ip);
    if (bad) { S.banMsg = bad; S.banTone = 'fail'; paintBanMsg(); S.ipInput.focus(); return; }
    S.busy = true; S.banBtn.disabled = true;
    S.banMsg = '正在封禁 ' + ip + '…'; S.banTone = ''; paintBanMsg();
    var params = { ip: ip, ttl_s: ttl };
    if (reason) params.reason = reason;
    invoke('waf.ban', params).then(function (data) {
      if (S.destroyed) return;
      S.busy = false; S.banBtn.disabled = !S.canWrite;
      if (data && data.banned) {
        S.banMsg = '已封禁 ' + (data.ip || ip) + '（' + setText(data.set) + '，' +
          (data.ttl_s ? fmtRemain({ expires_s: data.ttl_s }) : '永久') + '）。';
        S.banTone = 'ok';
        S.ipInput.value = ''; S.reasonInput.value = '';
      } else {
        S.banMsg = '没有确认到封禁结果' + (data && data.hint ? '：' + data.hint : '（请刷新名单核对）');
        S.banTone = 'fail';
      }
      paintBanMsg(); loadBans(); loadStatus(); loadRules();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.banBtn.disabled = !S.canWrite;
      S.banMsg = failureText(err, '封禁'); S.banTone = 'fail';
      if (err && err.code === 'E_NEED_ROOT') { setLocked(true); paintStatus(); }
      paintBanMsg();
    });
  }

  // ---- 防护等级（宽松 / 标准 / 严格）----
  // 等级是数据面事实：从后端 level 字段读，老版本插件没有该字段时按链上内置规则推断。
  var LEVELS = [
    { id: 'loose', title: '宽松', desc: '只保留 IP 封禁名单，不做扫描限速与并发限制。排障或活动期间临时放宽时用。' },
    { id: 'standard', title: '标准', desc: '封禁名单 + SYN 扫描限速（每源 60 次/秒）+ 单 IP 并发上限 200。日常推荐。' },
    { id: 'strict', title: '严格', desc: '在标准之上再加：丢弃畸形连接、限制 SSH 暴力破解（每源 10 次/分钟）。对外服务推荐。' }
  ];
  function levelText(id) {
    if (id === 'loose') return '宽松';
    if (id === 'standard') return '标准';
    if (id === 'strict') return '严格';
    return '未启用';
  }
  // levelFromChain：老版本插件不给 level 字段时的前端兜底推断（内置规则名判定）。
  function levelFromChain() {
    var has = {}, any = false;
    (S.chain || []).forEach(function (r) {
      if (!r || !r.builtin || !r.name) return;
      any = true; has[r.name] = true;
    });
    if (!any) return '';
    if (has['invalid-state'] || has['ssh-rate']) return 'strict';
    if (has['syn-rate'] || has['conn-rate']) return 'standard';
    return 'loose';
  }
  function currentMode() { return (S.status && S.status.backend && S.status.backend.mode) || 'off'; }
  function currentLevel() {
    var be = (S.status && S.status.backend) || {};
    return be.level || levelFromChain() || S.level || '';
  }
  function applyLevel(level) {
    if (S.levelBusy || S.busy) return;
    var mode = currentMode();
    if (mode === 'off') { return; }
    if (level === currentLevel()) { return; }
    S.levelBusy = true; S.levelMsg = '正在把防护等级切到「' + levelText(level) + '」并回读校验…'; S.levelTone = '';
    paintLevel();
    invoke('waf.toggle', { mode: mode, level: level }).then(function (data) {
      if (S.destroyed) return;
      S.levelBusy = false;
      var applied = !!(data && data.applied && data.verified);
      S.level = (data && data.level) || level;
      S.levelMsg = applied
        ? '已切换为「' + levelText(level) + '」：' + levelText(level) + '等级已生效（' +
          ((data.rules || []).length) + ' 条内置规则，已回读确认）。'
        : '等级没有确认生效' + (data && data.hint ? '：' + data.hint : '（请刷新后再看当前等级）');
      S.levelTone = applied ? 'ok' : 'fail';
      paintLevel(); refreshAll();
    }, function (err) {
      if (S.destroyed) return;
      S.levelBusy = false;
      S.levelMsg = failureText(err, '切换防护等级'); S.levelTone = 'fail';
      if (err && err.code === 'E_NEED_ROOT') setLocked(true);
      paintLevel();
    });
  }
  function paintLevel() {
    if (!S.levelHost) return;
    S.levelHost.textContent = '';
    var level = currentLevel(), mode = currentMode();
    var wrap = add(S.levelHost, el('div', 'waf-levels'));
    LEVELS.forEach(function (item) {
      var b = add(wrap, el('button', 'waf-level'));
      b.type = 'button';
      b.setAttribute('aria-pressed', level === item.id ? 'true' : 'false');
      b.disabled = S.locked || S.busy || S.levelBusy || mode === 'off';
      if (mode === 'off') b.title = '先选择一种防护模式（只记录或直接拦截），等级才会生效';
      else if (S.locked) b.title = '需要 root 提权通道（见状态卡）';
      add(b, el('span', 'waf-level-title', item.title));
      add(b, el('span', 'waf-level-desc', item.desc));
      on(b, function () { applyLevel(item.id); });
    });
    if (mode === 'off') {
      add(S.levelHost, el('p', 'field-hint', '当前防护已关闭：开启「只记录不拦截」或「直接拦截」后再选等级。'));
    }
    if (S.levelMsg) {
      add(S.levelHost, el('div', 'waf-msg' + (S.levelTone === 'fail' ? ' is-fail' : (S.levelTone === 'ok' ? ' is-ok' : '')), S.levelMsg));
    }
  }

  // ---- 命中分析（Top 来源 IP / Top 命中规则 + 一键封禁）----
  // 图表口径（G-32）：这里只用静态 CSS 条，不引入图表库、不建实例、无定时器；
  // 每个条同时给出数值文本与 title（hover/tap 可读），单位「次」写在值里。
  var HIT_RANGES = [
    { v: '1h', label: '最近 1 小时' }, { v: '24h', label: '最近 24 小时' }, { v: '7d', label: '最近 7 天' }
  ];
  function loadHits() {
    if (!S.hitHost) return;
    S.hitLoaded = false; S.hitError = ''; S.hitMsg = ''; paintHits();
    invoke('waf.logs', { limit: 200, since: S.hitSince }).then(function (data) {
      if (S.destroyed) return;
      S.hitLogs = (data && data.entries) || [];
      S.hitLoaded = true; paintHits();
    }, function (err) {
      if (S.destroyed) return;
      S.hitError = failureText(err, '读取命中记录'); S.hitLoaded = true; paintHits();
    });
  }
  function aggregateHits(entries) {
    var ips = {}, rules = {};
    (entries || []).forEach(function (entry) {
      var blocked = entry && entry.action === 'blocked';
      var ip = String((entry && entry.ip) || '').trim();
      if (ip) {
        if (!ips[ip]) ips[ip] = { ip: ip, count: 0, blocked: 0, last: '' };
        ips[ip].count++; if (blocked) ips[ip].blocked++;
        if (!ips[ip].last && entry.time) ips[ip].last = entry.time;
      }
      var rule = String((entry && entry.rule_id) || '').trim() || '（未标注规则）';
      if (!rules[rule]) rules[rule] = { id: rule, count: 0, blocked: 0 };
      rules[rule].count++; if (blocked) rules[rule].blocked++;
    });
    var ipList = [], ruleList = [];
    for (var k in ips) if (Object.prototype.hasOwnProperty.call(ips, k)) ipList.push(ips[k]);
    for (var r in rules) if (Object.prototype.hasOwnProperty.call(rules, r)) ruleList.push(rules[r]);
    ipList.sort(function (a, b) { return b.count - a.count || (a.ip < b.ip ? -1 : 1); });
    ruleList.sort(function (a, b) { return b.count - a.count || (a.id < b.id ? -1 : 1); });
    return { ips: ipList, rules: ruleList };
  }
  // hitBar 返回 { row, line }：line 是「进度条 + 操作按钮」那一行，调用方可往里放按钮。
  function hitBar(label, count, max, detail) {
    var row = el('div', 'waf-hit-row');
    var head = add(row, el('div', 'waf-hit-head'));
    add(head, el('span', 'waf-hit-label', label));
    add(head, el('span', 'waf-hit-value', count + ' 次'));
    var line = add(row, el('div', 'waf-hit-line'));
    var track = add(line, el('div', 'waf-hit-track'));
    var bar = add(track, el('span', 'waf-hit-bar'));
    bar.style.width = (max > 0 ? Math.max(2, Math.round(count / max * 100)) : 0) + '%';
    bar.title = label + '：命中 ' + count + ' 次' + (detail ? '（' + detail + '）' : '');
    if (detail) add(row, el('span', 'waf-hit-detail', detail));
    return { row: row, line: line };
  }
  function isBanned(ip) {
    for (var i = 0; i < S.bans.length; i++) if (S.bans[i] && S.bans[i].ip === ip) return true;
    return false;
  }
  function banFromHit(ip, btn) {
    if (!S.canWrite || S.busy) return;
    S.busy = true; if (btn) { btn.disabled = true; btn.textContent = '封禁中…'; }
    S.hitMsg = '正在把 ' + ip + ' 加入封禁名单（1 天）…'; S.hitTone = ''; paintHits();
    invoke('waf.ban', { ip: ip, ttl_s: 86400, reason: '命中分析：一键封禁' }).then(function (data) {
      if (S.destroyed) return;
      S.busy = false;
      if (data && data.banned) {
        S.hitMsg = '已封禁 ' + (data.ip || ip) + '（' + setText(data.set) + '，1 天后自动解封；封禁名单里可手动解封）。';
        S.hitTone = 'ok'; loadBans(); loadHits();
      } else {
        S.hitMsg = '没有确认到封禁结果' + (data && data.hint ? '：' + data.hint : '（请刷新封禁名单核对）');
        S.hitTone = 'fail'; paintHits();
      }
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false;
      S.hitMsg = failureText(err, '一键封禁'); S.hitTone = 'fail';
      if (err && err.code === 'E_NEED_ROOT') setLocked(true);
      paintHits();
    });
  }
  function paintHits() {
    if (S.notInstalled) { if (S.hitHost) S.hitHost.textContent = ''; return; }
    if (!S.hitHost) return;
    S.hitHost.textContent = '';
    if (S.hitMeta) S.hitMeta.textContent = S.hitLoaded ? (S.hitLogs.length + ' 条记录') : '';
    if (S.hitMsg) {
      add(S.hitHost, el('div', 'waf-msg' + (S.hitTone === 'fail' ? ' is-fail' : (S.hitTone === 'ok' ? ' is-ok' : '')), S.hitMsg));
    }
    if (S.hitError) { S.hitHost.appendChild(notice(S.hitError, 'fail')); return; }
    if (!S.hitLoaded) { add(S.hitHost, el('div', 'waf-loading', '正在统计命中记录…')); return; }
    var agg = aggregateHits(S.hitLogs);
    var blocked = 0;
    S.hitLogs.forEach(function (entry) { if (entry && entry.action === 'blocked') blocked++; });
    var summary = add(S.hitHost, el('div', 'waf-hit-summary'));
    [
      ['记录数', S.hitLogs.length + ' 条'],
      ['已拦截', blocked + ' 条'],
      ['仅记录', (S.hitLogs.length - blocked) + ' 条'],
      ['独立来源 IP', agg.ips.length + ' 个']
    ].forEach(function (item) {
      var cell = add(summary, el('div', 'waf-cell'));
      add(cell, el('span', 'waf-cell-label', item[0]));
      add(cell, el('span', 'waf-cell-value', item[1]));
    });
    if (!S.hitLogs.length) {
      var sev = S.logSources.filter(function (s) { return s.existing !== false && s.exists !== false; });
      var text = sev.length
        ? '这个时间范围内没有命中记录：可以换个时间范围，或确认引擎的审计日志已开启（SecAuditEngine RelevantOnly）。'
        : '没有可统计的引擎日志：装好 ModSecurity / Naxsi 并启用审计日志后，这里会按来源 IP 与命中规则聚合。' +
          'kore 自有的 nft 防护是网络层丢包，只记计数器——命中包数在上方「防护规则」表里看。';
      S.hitHost.appendChild(emptyBlock(text));
      return;
    }
    var topIps = agg.ips.slice(0, 8), topRules = agg.rules.slice(0, 8);
    var maxIp = topIps.length ? topIps[0].count : 1;
    var maxRule = topRules.length ? topRules[0].count : 1;

    var ipsPanel = add(S.hitHost, el('div', 'waf-hit-block'));
    add(ipsPanel, el('div', 'waf-hit-title', 'Top 来源 IP'));
    topIps.forEach(function (item) {
      var bar = hitBar(item.ip, item.count, maxIp,
        '拦截 ' + item.blocked + ' 次 · 仅记录 ' + (item.count - item.blocked) + ' 次' + (item.last ? ' · 最近 ' + item.last : ''));
      var ops = add(bar.line, el('span', 'waf-hit-ops'));
      if (isBanned(item.ip)) {
        add(ops, el('span', 'chip chip-na', '已在封禁名单'));
      } else {
        var btn = add(ops, el('button', 'btn btn-ghost waf-hit-ban', '一键封禁 1 天'));
        btn.type = 'button';
        btn.disabled = !S.canWrite || S.busy;
        btn.title = S.canWrite ? '把这个来源 IP 写进 kore 自有 nft 封禁集合（1 天后自动解封）'
          : '需要 root 提权通道（见状态卡）';
        on(btn, function () { banFromHit(item.ip, btn); });
      }
      ipsPanel.appendChild(bar.row);
    });

    var rulesPanel = add(S.hitHost, el('div', 'waf-hit-block'));
    add(rulesPanel, el('div', 'waf-hit-title', 'Top 命中规则'));
    topRules.forEach(function (item) {
      rulesPanel.appendChild(hitBar(item.id, item.count, maxRule, '拦截 ' + item.blocked + ' 次').row);
    });
    add(S.hitHost, el('p', 'field-hint',
      '统计来自引擎审计日志；kore 自有 nft 规则（封禁 / 限速 / 并发）只记计数器，其命中在「防护规则」表的「命中包数」列。' +
      '「一键封禁」写进 kore 自有的 nft 封禁集合，不改宿主已有防火墙；封禁会与「封禁名单」面板同一份数据。'));
  }

  // ---- 防护规则（内置只可启停；自定义可增删启停）----
  // 后端契约（waf 0.4.1+）：waf.rules 额外返回 chain[]（name/expr/action/enabled/builtin/handle）；
  // rule.add 只收 {name, expr, action}，expr 必须命中受控匹配器白名单（不接受自由 nft 语法）；
  // rule.remove 对内置规则一律 E_INVALID（只能 rule.toggle enabled=false）。
  var MATCHERS = [
    { v: 'ip saddr', label: '来源 IPv4（ip saddr）', hint: 'IPv4 或网段，如 203.0.113.7 / 203.0.113.0/24', need: true },
    { v: 'ip6 saddr', label: '来源 IPv6（ip6 saddr）', hint: 'IPv6 或网段，如 2001:db8::1 / 2001:db8::/32', need: true },
    { v: 'tcp dport', label: 'TCP 端口（tcp dport）', hint: '端口或逗号列表，如 22 或 80,443', need: true },
    { v: 'udp dport', label: 'UDP 端口（udp dport）', hint: '端口或逗号列表，如 53 或 53,123', need: true },
    { v: 'ct state', label: '连接状态（ct state）', hint: 'new / established / related / invalid，可逗号组合', need: true },
    { v: 'tcp flags syn', label: 'SYN 扫描（tcp flags syn）', hint: '这个匹配器不需要值', need: false }
  ];
  // 规则模板：把「用户想干什么」放在前面，匹配器/动作由模板带出（预设优先，仍可改）。
  var RULE_PRESETS = [
    { id: 'ip-block', label: '封禁来源 IP（黑名单）', matcher: 'ip saddr', action: 'drop', hint: '203.0.113.7 或 203.0.113.0/24' },
    { id: 'port-block', label: '限制端口', matcher: 'tcp dport', action: 'drop', hint: '22 或 8080' },
    { id: 'invalid-drop', label: '丢弃畸形连接', matcher: 'ct state', action: 'drop', value: 'invalid' },
    { id: 'ip-allow', label: '放行办公 IP（白名单）', matcher: 'ip saddr', action: 'accept', hint: '198.51.100.7' }
  ];
  function applyPreset(preset) {
    if (!S.mMatcher || !S.mAction || !S.mValue) return;
    S.mMatcher.value = preset.matcher;
    S.mAction.value = preset.action;
    var def = matcherDef(preset.matcher);
    S.mValue.disabled = !def.need;
    S.mValue.placeholder = preset.hint || def.hint;
    S.mValue.value = preset.value || '';
    if (def.need && !preset.value) S.mValue.focus();
  }
  function matcherDef(v) {
    for (var i = 0; i < MATCHERS.length; i++) if (MATCHERS[i].v === v) return MATCHERS[i];
    return MATCHERS[0];
  }
  function ruleFailure(err, verb) {
    var msg = (err && err.message) || '';
    if (err && err.code === 'E_UNSUPPORTED' && /匹配器|白名单|不受控|expr/i.test(msg)) {
      return '这个匹配条件暂不支持：' + msg + '。可用的是：ip saddr / ip6 saddr / tcp dport / udp dport / ct state / tcp flags syn。';
    }
    if (/内置/.test(msg)) return '内置规则只能停用不能删除（用「停用」按钮）。';
    return failureText(err, verb);
  }
  function toggleRule(name, enabled, btn) {
    if (S.rBusy) return;
    S.rBusy = true; if (btn) btn.disabled = true;
    S.rMsg = (enabled ? '正在启用 ' : '正在停用 ') + name + '…'; S.rTone = ''; paintRuleMsg();
    invoke('waf.rule.toggle', { name: name, enabled: enabled }).then(function (d) {
      if (S.destroyed) return;
      S.rBusy = false;
      S.rMsg = (enabled ? '已启用 ' : '已停用 ') + name + (d && d.verified ? '（已回读确认）' : '（未回读确认，请刷新核对）');
      S.rTone = d && d.verified ? 'ok' : 'warn';
      paintRuleMsg(); loadRules(); loadStatus();
    }, function (err) {
      if (S.destroyed) return;
      S.rBusy = false; S.rMsg = ruleFailure(err, enabled ? '启用' : '停用'); S.rTone = 'fail';
      paintRuleMsg(); paintRules();
    });
  }
  function removeRule(name, btn) {
    if (S.rBusy) return;
    S.rBusy = true; if (btn) btn.disabled = true;
    S.rMsg = '正在删除 ' + name + '…'; S.rTone = ''; paintRuleMsg();
    invoke('waf.rule.remove', { name: name }).then(function (d) {
      if (S.destroyed) return;
      S.rBusy = false;
      S.rMsg = '已删除 ' + name + (d && d.verified ? '（已回读确认）' : '');
      S.rTone = 'ok'; paintRuleMsg(); loadRules();
    }, function (err) {
      if (S.destroyed) return;
      S.rBusy = false; S.rMsg = ruleFailure(err, '删除'); S.rTone = 'fail';
      paintRuleMsg(); paintRules();
    });
  }
  function submitRule() {
    if (S.rBusy || S.locked) return;
    var name = (S.mName.value || '').trim();
    var def = matcherDef(S.mMatcher.value);
    var value = (S.mValue.value || '').trim();
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) {
      S.rMsg = '规则名要小写字母开头，只用小写字母、数字和连字符（2–31 位），例如 allow-office'; S.rTone = 'fail';
      paintRuleMsg(); S.mName.focus(); return;
    }
    if (def.need && !value) { S.rMsg = '请填「' + def.label + '」的值：' + def.hint; S.rTone = 'fail'; paintRuleMsg(); S.mValue.focus(); return; }
    var expr = def.need ? (def.v + ' ' + value) : def.v;
    var action = S.mAction.value;
    S.rBusy = true; S.mBtn.disabled = true;
    S.rMsg = '正在新增规则 ' + name + '…'; S.rTone = ''; paintRuleMsg();
    invoke('waf.rule.add', { name: name, expr: expr, action: action }).then(function (d) {
      if (S.destroyed) return;
      S.rBusy = false; S.mBtn.disabled = false;
      if (d && d.verified) {
        S.rMsg = '已新增规则 ' + name + '（' + expr + ' → ' + action + '），已回读确认。';
        S.rTone = 'ok'; S.mName.value = ''; S.mValue.value = '';
      } else {
        S.rMsg = '规则已提交，但没有通过回读校验' + (d && d.hint ? '：' + d.hint : '（请刷新核对）');
        S.rTone = 'warn';
      }
      paintRuleMsg(); loadRules(); loadStatus();
    }, function (err) {
      if (S.destroyed) return;
      S.rBusy = false; S.mBtn.disabled = false;
      S.rMsg = ruleFailure(err, '新增规则'); S.rTone = 'fail';
      paintRuleMsg(); paintRules();
    });
  }
  function paintRuleMsg() {
    if (!S.rMsgHost) return;
    S.rMsgHost.textContent = S.rMsg || '';
    S.rMsgHost.className = 'waf-msg' + (S.rTone === 'fail' ? ' is-fail' : (S.rTone === 'ok' ? ' is-ok' : ''));
  }
  function paintRules() {
    if (S.notInstalled) { if (S.rulesHost) S.rulesHost.textContent = ''; return; }
    if (!S.rulesHost) return;
    S.rulesHost.textContent = '';
    S.rulesMeta.textContent = S.rulesLoaded ? (S.chain.length ? (S.chain.length + ' 条（' + S.chain.filter(function (r) { return r.builtin; }).length + ' 内置）') : (S.rulesCount + ' 条规则')) : '';
    if (S.rulesError) { S.rulesHost.appendChild(notice('规则读取失败：' + S.rulesError, 'fail')); return; }
    if (!S.rulesLoaded) { add(S.rulesHost, el('div', 'waf-loading', '正在读取规则…')); return; }
    if (S.rulesErrorText) S.rulesHost.appendChild(notice(S.rulesErrorText, 'fail'));
    if (S.chain.length) {
      var wrap = add(S.rulesHost, el('div', 'plugin-table-wrap'));
      var table = add(wrap, el('table', 'plugin-table waf-table'));
      var htr = add(add(table, el('thead')), el('tr'));
      ['规则名', '匹配条件', '动作', '类型', '状态', '操作'].forEach(function (t) { add(htr, el('th', null, t)); });
      var tbody = add(table, el('tbody'));
      S.chain.forEach(function (r) {
        var tr = add(tbody, el('tr'));
        add(tr, el('td', 'waf-rule-text', r.name || '—')).setAttribute('data-label', '规则名');
        add(tr, el('td', 'waf-rule-text', r.expr || '—')).setAttribute('data-label', '匹配条件');
        add(tr, el('td', null, r.action === 'drop' ? '拦截' : (r.action === 'accept' ? '放行' : (r.action || '—')))).setAttribute('data-label', '动作');
        var typeTd = add(tr, el('td', null)); typeTd.setAttribute('data-label', '类型');
        typeTd.appendChild(chip(r.builtin ? 'na' : 'ok', r.builtin ? '内置' : '自定义'));
        add(tr, el('td', null, r.enabled === false ? '已停用' : '启用中')).setAttribute('data-label', '状态');
        var ops = add(tr, el('td', 'waf-ops cell-ops')); ops.setAttribute('data-label', '操作');
        var tb = add(ops, el('button', 'btn btn-ghost', r.enabled === false ? '启用' : '停用')); tb.type = 'button';
        tb.disabled = S.rBusy || S.locked;
        if (S.locked) tb.title = '需要 root 提权通道（见状态卡）';
        on(tb, function () { toggleRule(r.name, r.enabled === false, tb); });
        var db = add(ops, el('button', 'btn waf-danger', '删除')); db.type = 'button';
        db.disabled = !!r.builtin || S.rBusy || S.locked;
        db.title = r.builtin ? '内置规则只能停用不能删除' : (S.locked ? '需要 root 提权通道（见状态卡）' : '删除这条自定义规则');
        on(db, function () { removeRule(r.name, db); });
      });
      add(S.rulesHost, el('p', 'field-hint', '内置规则是基础防护（封禁名单 / SYN 限速 / 并发上限），只能停用不能删除；自定义规则可删可启停。'));
      return;
    }
    if (!S.rules.length) {
      S.rulesHost.appendChild(emptyBlock('当前没有装载任何规则。切到「只记录不拦截」或「直接拦截」后会装载 4 条内置基础规则。'));
      return;
    }
    var scroll2 = add(S.rulesHost, el('div', 'waf-table-wrap'));
    var t2 = add(scroll2, el('table', 'waf-table'));
    var h2 = add(add(t2, el('thead')), el('tr'));
    ['#', '规则内容', '动作', '命中包数', '字节数'].forEach(function (t) { add(h2, el('th', null, t)); });
    var b2 = add(t2, el('tbody'));
    S.rules.forEach(function (rule) {
      var tr = add(b2, el('tr'));
      add(tr, el('td', 'waf-num', '#' + (rule.handle || '?'))).setAttribute('data-label', '序号');
      var ruleCell = add(tr, el('td', 'waf-rule-text'));
      ruleCell.setAttribute('data-label', '规则内容');
      add(ruleCell, el('div', null, rulePurpose(rule.summary)));
      add(ruleCell, el('code', 'waf-rule-raw', rule.summary || ''));
      add(tr, el('td', null, rule.verdict === 'drop' ? '拦截' : (rule.verdict === 'accept' ? '放行' : '只记录'))).setAttribute('data-label', '动作');
      add(tr, el('td', 'waf-num', String(Number(rule.packets) || 0))).setAttribute('data-label', '命中包数');
      add(tr, el('td', 'waf-num', fmtBytes(rule.bytes))).setAttribute('data-label', '字节数');
    });
  }

  // ---- 拦截日志（引擎平面，只读）----
  function paintLogs() {
    if (S.notInstalled) { if (S.logsHost) S.logsHost.textContent = ''; return; }
    if (!S.logsHost) return;
    S.logsHost.textContent = '';
    if (S.logsError) { S.logsHost.appendChild(notice('日志读取失败：' + S.logsError, 'fail')); return; }
    if (!S.logsLoaded) { add(S.logsHost, el('div', 'waf-loading', '正在读取拦截日志…')); return; }
    if (!S.logs.length) {
      var sources = S.logSources.filter(function (s) { return s.existing !== false && s.exists !== false; });
      var text = sources.length
        ? '最近没有拦截记录（已扫描 ' + sources.length + ' 个日志文件）。'
        : '没有可读的引擎日志：装好 ModSecurity / Naxsi 后这里会显示拦截记录。';
      S.logsHost.appendChild(emptyBlock(text));
      return;
    }
    var scroll = add(S.logsHost, el('div', 'waf-table-wrap'));
    var table = add(scroll, el('table', 'waf-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['时间', '来源 IP', '请求路径', '命中规则', '结果'].forEach(function (t) { add(htr, el('th', null, t)); });
    var tbody = add(table, el('tbody'));
    S.logs.forEach(function (entry) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', 'waf-num', entry.time || '—')).setAttribute('data-label', '时间');
      add(tr, el('td', 'waf-num', entry.ip || '—')).setAttribute('data-label', '来源 IP');
      add(tr, el('td', 'waf-rule-text', entry.uri || '—')).setAttribute('data-label', '请求路径');
      add(tr, el('td', 'waf-num', entry.rule_id || '—')).setAttribute('data-label', '命中规则');
      add(tr, el('td', null, entry.action === 'blocked' ? '已拦截' : '仅记录')).setAttribute('data-label', '结果');
    });
  }

  // ---- 表单可用性 ----
  function setLocked(locked) {
    S.locked = !!locked;
    [S.ipInput, S.ttlSel, S.reasonInput].forEach(function (n) { if (n) n.disabled = S.locked || S.busy; });
    if (S.banBtn) S.banBtn.disabled = S.locked || S.busy;
    if (S.banHint) {
      S.banHint.textContent = S.locked
        ? '当前没有可用的提权通道：表单已禁用，仍可查看状态与名单。按状态卡片里的说明重启 kored 后即可编辑。'
        : '封禁写进 kore 自有的 nft 集合，不影响宿主已有防火墙规则；永久封禁需手动解封。';
    }
    if (S.logsRefresh) S.logsRefresh.disabled = false;
    if (S.mBtn) S.mBtn.disabled = S.locked || S.rBusy;
    if (S.ruleHint) {
      S.ruleHint.textContent = S.locked
        ? '规则增删/启停需要 root 提权通道；当前没有，表单已禁用。按状态卡片里的说明启动 kored 后即可编辑。'
        : '后端只接受上面 6 种匹配器，值不合法会被拒绝；提交后会回读 nft 链确认生效。';
    }
    [S.mName, S.mMatcher, S.mValue, S.mAction].forEach(function (n) { if (n) n.disabled = S.locked || S.rBusy; });
    // 解锁后必须重画模式/等级/命中按钮：它们的 disabled 由各自 paint 读 S.locked 决定，
    // 只改 S.locked 不重画会留下「按钮一直灰着」的死状态（真机截图抓到）。
    if (S.modeHost) paintModes();
    if (S.levelHost) paintLevel();
    if (S.hitHost && S.hitLoaded) paintHits();
  }

  // ---- 数据加载 ----
  function loadStatus() {
    S.statusError = ''; S.statusCode = ''; S.statusHint = ''; paintStatus();
    invoke('waf.status', {}).then(function (data) {
      if (S.destroyed) return; S.status = data; paintStatus();
    }, function (err) {
      if (S.destroyed) return;
      S.statusError = err.message; S.statusCode = err.code || ''; S.statusHint = err.hint || '';
      paintStatus();
    });
  }
  function loadBans() {
    S.bansLoaded = false; S.bansError = ''; S.bansCode = ''; S.bansHint = ''; paintBans();
    invoke('waf.bans', {}).then(function (data) {
      if (S.destroyed) return;
      S.bans = (data && data.bans) || []; S.bansLoaded = true; paintBans();
    }, function (err) {
      if (S.destroyed) return;
      S.bansError = err.message; S.bansCode = err.code || ''; S.bansHint = err.hint || ''; S.bansLoaded = true; paintBans();
    });
  }
  function loadRules() {
    S.rulesLoaded = false; S.rulesError = ''; paintRules();
    invoke('waf.rules', {}).then(function (data) {
      if (S.destroyed) return;
      var nft = (data && data.nft) || {};
      S.rules = nft.rules || []; S.rulesCount = Number(nft.rules_count) || S.rules.length;
      S.chain = (data && data.chain) || [];
      S.rulesLoaded = true; paintRules();
    }, function (err) {
      if (S.destroyed) return;
      S.rulesError = err.message; S.rulesLoaded = true; paintRules();
    });
  }
  function loadLogs() {
    S.logsLoaded = false; S.logsError = ''; paintLogs();
    invoke('waf.logs', { limit: 20 }).then(function (data) {
      if (S.destroyed) return;
      S.logs = (data && data.entries) || []; S.logSources = (data && data.sources) || [];
      S.logsLoaded = true; paintLogs();
    }, function (err) {
      if (S.destroyed) return;
      S.logsError = err.message; S.logsLoaded = true; paintLogs();
    });
  }
  function refreshAll() { loadStatus(); loadBans(); loadRules(); loadLogs(); loadHits(); }

  function injectCSS() {
    if (document.getElementById('kore-waf-css')) return;
    var css = [
      '.waf-status{padding:0 var(--kore-space-4) var(--kore-space-4);}',
      '.waf-loading{padding:var(--kore-space-3) 0;color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.waf-status-top{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding-top:var(--kore-space-3);}',
      '.waf-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kore-space-2);padding-top:var(--kore-space-3);}',
      '.waf-cell{display:flex;flex-direction:column;gap:2px;min-width:0;padding:var(--kore-space-2) var(--kore-space-3);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);}',
      '.waf-cell-label{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.waf-cell-value{font-size:var(--kore-font-14);word-break:break-word;}',
      '.waf-callout{margin-top:var(--kore-space-3);padding:var(--kore-space-3);border-radius:var(--kore-radius-control);}',
      '.waf-callout-warn{color:var(--kore-text-1);background:var(--kore-warning-bg);border:1px solid var(--kore-warning);border-left:3px solid var(--kore-warning);}',
      '.waf-callout-title{margin-bottom:var(--kore-space-1);color:var(--kore-warning);font-weight:600;font-size:var(--kore-font-13);}',
      '.waf-callout-text{margin:0 0 var(--kore-space-1);color:var(--kore-text-2);font-size:var(--kore-font-13);word-break:break-word;}',
      '.waf-details{margin-top:var(--kore-space-2);color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.waf-details summary{cursor:pointer;}',
      '.waf-details pre{margin:var(--kore-space-2) 0 0;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--kore-text-2);}',
      '.waf-cmd{margin:var(--kore-space-1) 0;padding:var(--kore-space-2) var(--kore-space-3);overflow-x:auto;color:var(--kore-term-cyan);background:var(--kore-bg-0);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);}',
      '.waf-link{color:var(--kore-info);}',
      '.waf-modes{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);padding:0 var(--kore-space-4) var(--kore-space-3);}',
      '.waf-mode{display:flex;flex-direction:column;gap:2px;flex:1 1 200px;min-height:var(--kore-touch);padding:var(--kore-space-2) var(--kore-space-3);text-align:left;color:var(--kore-text-1);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);cursor:pointer;}',
      '.waf-mode[aria-pressed="true"]{border-color:var(--kore-info);background:var(--kore-bg-2);}',
      '.waf-mode:disabled{cursor:not-allowed;opacity:.6;}',
      '.waf-mode-title{font-weight:600;font-size:var(--kore-font-13);}',
      '.waf-mode-desc{color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.5;}',
      '.waf-mode-tip{padding:0 var(--kore-space-4) var(--kore-space-3);color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.waf-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);margin:0 var(--kore-space-4) var(--kore-space-3);padding:var(--kore-space-3);background:var(--kore-warning-bg);border:1px solid var(--kore-warning);border-radius:var(--kore-radius-control);font-size:var(--kore-font-12);}',
      '.waf-confirm span{flex:1 1 220px;color:var(--kore-text-2);}',
      '.waf-table-wrap{overflow-x:auto;}',
      '.waf-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-13);}',
      '.waf-table thead th{text-align:left;padding:var(--kore-space-2) var(--kore-space-3);color:var(--kore-text-2);font-size:var(--kore-font-12);font-weight:400;border-bottom:1px solid var(--kore-border-2);white-space:nowrap;}',
      '.waf-table tbody tr + tr{border-top:1px solid var(--kore-border-2);}',
      '.waf-table td{padding:var(--kore-space-2) var(--kore-space-3);vertical-align:middle;word-break:break-word;}',
      '.waf-num{font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.waf-rule-text{font-size:var(--kore-font-13);word-break:break-word;}',
      '.waf-rule-raw{display:block;margin-top:2px;color:var(--kore-text-3);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-12);word-break:break-all;}',
      '.waf-ops{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);}',
      '.waf-danger{color:var(--kore-danger);border-color:var(--kore-danger);}',
      '.waf-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kore-space-3);padding:0 var(--kore-space-4) var(--kore-space-4);}',
      '.waf-form-ops{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);}',
      '.waf-msg{min-height:18px;color:var(--kore-text-3);font-size:var(--kore-font-12);word-break:break-word;}',
      '.waf-msg.is-fail{color:var(--kore-danger);}',
      '.waf-msg.is-ok{color:var(--kore-success);}',
      '.waf-empty{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-4);color:var(--kore-text-3);font-size:var(--kore-font-13);}',
      '.waf-level-host{padding:0 var(--kore-space-4) var(--kore-space-3);}',
      '.waf-levels{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);}',
      '.waf-level{display:flex;flex-direction:column;gap:2px;flex:1 1 220px;min-height:var(--kore-touch);padding:var(--kore-space-2) var(--kore-space-3);text-align:left;color:var(--kore-text-1);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);cursor:pointer;}',
      '.waf-level[aria-pressed="true"]{border-color:var(--kore-info);background:var(--kore-bg-2);}',
      '.waf-level:disabled{cursor:not-allowed;opacity:.6;}',
      '.waf-level-title{font-weight:600;font-size:var(--kore-font-13);}',
      '.waf-level-desc{color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.5;}',
      '.waf-hits{display:flex;flex-direction:column;gap:var(--kore-space-3);padding:0 var(--kore-space-4) var(--kore-space-4);}',
      '.waf-hit-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--kore-space-2);}',
      '.waf-hit-block{display:flex;flex-direction:column;gap:var(--kore-space-2);}',
      '.waf-hit-title{color:var(--kore-text-2);font-weight:600;font-size:var(--kore-font-13);}',
      '.waf-hit-row{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.waf-hit-head{display:flex;justify-content:space-between;gap:var(--kore-space-2);font-size:var(--kore-font-12);}',
      '.waf-hit-label{color:var(--kore-text-2);word-break:break-all;}',
      '.waf-hit-value{font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.waf-hit-line{display:flex;align-items:center;gap:var(--kore-space-2);}',
      '.waf-hit-track{flex:1 1 auto;height:6px;overflow:hidden;background:var(--kore-bg-2);border-radius:3px;}',
      '.waf-hit-bar{display:block;height:100%;background:var(--kore-info);border-radius:3px;}',
      '.waf-hit-ops{flex:0 0 auto;display:flex;gap:var(--kore-space-1);}',
      '.waf-hit-detail{color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.waf-hit-ban{min-height:32px;padding:var(--kore-space-1) var(--kore-space-2);font-size:var(--kore-font-12);}',
      '.waf-hit-range{min-height:32px;padding:var(--kore-space-1) var(--kore-space-2);font-size:var(--kore-font-12);}',
      '.waf-empty span{flex:1 1 260px;}',
      '@media (max-width:639px){',
      '.waf-grid{grid-template-columns:1fr;}',
      '.waf-form{grid-template-columns:1fr;}',
      '.waf-mode{flex:1 1 100%;}',
      '.waf-level{flex:1 1 100%;}',
      '.waf-hit-summary{grid-template-columns:repeat(2,minmax(0,1fr));}',
      '.waf-hit-ban{min-height:44px;}',
      '.waf-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}',
      '.waf-table,.waf-table tbody,.waf-table tr,.waf-table td{display:block;width:100%;}',
      '.waf-table tr{padding:var(--kore-space-2) 0 var(--kore-space-3);border-top:1px solid var(--kore-border-2);}',
      '.waf-table td{display:flex;gap:var(--kore-space-3);align-items:center;padding:var(--kore-space-1) var(--kore-space-4);}',
      '.waf-table td::before{content:attr(data-label);flex:0 0 84px;color:var(--kore-text-3);font-size:var(--kore-font-12);}',
      '.waf-table td.waf-ops{flex-wrap:wrap;}',
      '.waf-table td.waf-ops::before{flex:0 0 84px;}',
      '}'
    ].join('\n');
    var style = el('style', null, css); style.id = 'kore-waf-css';
    document.head.appendChild(style);
  }

  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    injectCSS();
    S.root = add(container, el('section', 'waf'));
    var head = add(S.root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', 'Web 应用防火墙'));
    add(head, el('p', 'view-sub',
      '两层防护：引擎层按 URL/参数拦请求（跟随宿主已装的 WAF 引擎），网络层由 kore 自己封 IP、限扫描、限并发。'));

    // ① 状态
    var status = panel('运行状态', '');
    add(S.root, status.panel);
    var sBtns = add(status.meta, el('div', 'actions'));
    var configBtn = add(sBtns, el('button', 'btn btn-ghost', '插件设置')); configBtn.type = 'button';
    on(configBtn, function () {
      if (window.KoreShell && typeof window.KoreShell.openConfig === 'function') {
        window.KoreShell.openConfig(S.root, 'waf', { title: 'WAF 设置', onSaved: refreshAll });
      } else {
        S.notice = '配置面板未加载，请刷新页面后重试'; S.noticeTone = 'fail'; paintStatus();
      }
    });
    var refresh = add(sBtns, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, refreshAll);
    S.statusHost = add(status.panel, el('div', 'waf-status'));

    // ② 模式
    var modeP = panel('防护模式', '切换后自动回读校验');
    add(S.root, modeP.panel); S.modePanel = modeP.panel;
    S.modeHost = add(modeP.panel, el('div', 'waf-mode-host'));

    // ②b 防护等级（在模式之下：先有模式，等级才有落点）
    var levelP = panel('防护等级', '宽松 / 标准 / 严格');
    add(S.root, levelP.panel); S.levelPanel = levelP.panel;
    S.levelHost = add(levelP.panel, el('div', 'waf-level-host'));

    // ③ 封禁名单
    var bans = panel('封禁名单', ''); add(S.root, bans.panel); S.bansPanel = bans.panel;
    S.banCount = add(bans.meta, el('span', null, ''));
    S.bansHost = add(bans.panel, el('div', 'waf-bans'));

    // ④ 添加封禁
    var form = panel('添加封禁', '写入 kore 自有 nft 集合');
    add(S.root, form.panel); S.formPanel = form.panel;
    var grid = add(form.panel, el('div', 'waf-form'));
    S.ipInput = el('input', 'field-input'); S.ipInput.type = 'text'; S.ipInput.placeholder = '203.0.113.7 或 203.0.113.0/24';
    S.ipInput.setAttribute('autocomplete', 'off'); S.ipInput.maxLength = 64;
    S.ttlSel = el('select', 'field-input');
    TTL_PRESETS.forEach(function (p) { var o = el('option', null, p.label); o.value = String(p.value); S.ttlSel.appendChild(o); });
    S.reasonInput = el('input', 'field-input'); S.reasonInput.type = 'text';
    S.reasonInput.placeholder = '例如：扫描器 / 暴力破解（可留空）'; S.reasonInput.maxLength = 200;
    [['IP 地址', S.ipInput], ['封禁时长', S.ttlSel], ['原因（可选）', S.reasonInput]].forEach(function (f) {
      var label = add(grid, el('label', 'field'));
      add(label, el('span', 'field-label', f[0])); add(label, f[1]);
    });
    var ops = add(grid, el('div', 'waf-form-ops'));
    S.banBtn = add(ops, el('button', 'btn btn-primary', '封禁这个 IP')); S.banBtn.type = 'button';
    on(S.banBtn, submitBan);
    S.banMsgHost = add(ops, el('span', 'waf-msg', ''));
    S.banHint = add(form.panel, el('p', 'field-hint', ''));

    // ⑤ 规则（只读）
    var rules = panel('防护规则', '内置只可停用；自定义可增删启停'); add(S.root, rules.panel); S.rulesPanel = rules.panel;
    S.rulesMeta = add(rules.meta, el('span', null, ''));
    S.rulesHost = add(rules.panel, el('div', 'waf-rules'));

    // 新增规则：匹配器只给下拉（后端只收白名单表达式），值按匹配器给提示，动作只有 drop/accept。
    var addRule = panel('新增规则', '只支持受控匹配器，不支持自由表达式'); add(S.root, addRule.panel); S.addRulePanel = addRule.panel;
    var rform = add(addRule.panel, el('div', 'waf-form'));
    S.mName = el('input', 'field-input'); S.mName.type = 'text'; S.mName.placeholder = '例如 allow-office';
    S.mName.setAttribute('autocomplete', 'off'); S.mName.maxLength = 31;
    S.mMatcher = el('select', 'field-input');
    MATCHERS.forEach(function (m) { var o = el('option', null, m.label); o.value = m.v; S.mMatcher.appendChild(o); });
    S.mValue = el('input', 'field-input'); S.mValue.type = 'text';
    S.mValue.placeholder = matcherDef('ip saddr').hint; S.mValue.setAttribute('autocomplete', 'off');
    S.mAction = el('select', 'field-input');
    [['drop', '拦截（drop）'], ['accept', '放行（accept）']].forEach(function (a) { var o = el('option', null, a[1]); o.value = a[0]; S.mAction.appendChild(o); });
    var presetSel = el('select', 'field-input');
    RULE_PRESETS.forEach(function (preset) {
      var opt = el('option', null, preset.label); opt.value = preset.id; presetSel.appendChild(opt);
    });
    var pf = add(rform, el('label', 'field'));
    add(pf, el('span', 'field-label', '规则模板')); add(pf, presetSel);
    on(presetSel, function () {
      var picked = null;
      RULE_PRESETS.forEach(function (preset) { if (preset.id === presetSel.value) picked = preset; });
      if (picked) applyPreset(picked);
    }, 'change');
    var nf = add(rform, el('label', 'field')); add(nf, el('span', 'field-label', '规则名')); add(nf, S.mName);
    var mf = add(rform, el('label', 'field')); add(mf, el('span', 'field-label', '匹配条件')); add(mf, S.mMatcher);
    var vf = add(rform, el('label', 'field')); add(vf, el('span', 'field-label', '匹配值')); add(vf, S.mValue);
    var af = add(rform, el('label', 'field')); add(af, el('span', 'field-label', '动作')); add(af, S.mAction);
    var rops = add(rform, el('div', 'waf-form-ops'));
    S.mBtn = add(rops, el('button', 'btn btn-primary', '新增规则')); S.mBtn.type = 'button'; on(S.mBtn, submitRule);
    S.rMsgHost = add(rops, el('span', 'waf-msg', ''));
    S.ruleHint = add(addRule.panel, el('p', 'field-hint', ''));
    add(addRule.panel, el('p', 'field-hint',
      '按 URL 路径 / User-Agent 拦截属于 HTTP 层规则，需要宿主装 ModSecurity / Naxsi 并启用其规则文件——' +
      'kore 只写自己 kore_waf 表里的网络层规则，不改宿主的 nginx / Apache 配置。'));
    on(S.mMatcher, function () {
      var def = matcherDef(S.mMatcher.value);
      S.mValue.placeholder = def.hint;
      S.mValue.disabled = !def.need;
      if (!def.need) S.mValue.value = '';
    }, 'change');

    // ⑤b 命中分析（Top IP / Top 规则 + 一键封禁）
    var hits = panel('命中分析', '引擎审计日志聚合 · 一键封禁可疑 IP');
    add(S.root, hits.panel); S.hitPanel = hits.panel;
    S.hitMeta = add(hits.meta, el('span', null, ''));
    var hitCtl = add(hits.meta, el('div', 'actions'));
    var rangeSel = add(hitCtl, el('select', 'field-input waf-hit-range'));
    HIT_RANGES.forEach(function (item) {
      var opt = el('option', null, item.label); opt.value = item.v;
      if (item.v === S.hitSince) opt.selected = true;
      rangeSel.appendChild(opt);
    });
    on(rangeSel, function () { S.hitSince = rangeSel.value; loadHits(); }, 'change');
    var hitRefresh = add(hitCtl, el('button', 'btn btn-ghost', '刷新')); hitRefresh.type = 'button';
    on(hitRefresh, loadHits);
    S.hitHost = add(hits.panel, el('div', 'waf-hits'));

    // ⑥ 拦截日志
    var logs = panel('最近拦截记录', '引擎平面，只读'); add(S.root, logs.panel); S.logsPanel = logs.panel;
    S.logsRefresh = add(logs.meta, el('button', 'btn btn-ghost', '刷新')); S.logsRefresh.type = 'button';
    on(S.logsRefresh, loadLogs);
    S.logsHost = add(logs.panel, el('div', 'waf-logs'));

    // fail-closed：状态回来前先锁表单，避免"打开就能填、提交才知道没权限"。
    setLocked(true); paintStatus(); paintModes(); paintLevel(); paintBans(); paintRules(); paintHits(); paintLogs();
    refreshAll();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreWaf = { render: render };
})();
