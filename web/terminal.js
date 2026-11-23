/* kore 主壳 · Web 终端（web/terminal.js）· window.KoreTerminal.render(container) → {destroy}
   契约（kore-plugin-terminal README）：write/read 的 data 是标准 base64；read 增量读（空串=暂无输出，
   eof=shell 已退出）；POST /api/v1/invoke/terminal/<m> + X-Kore-CSRF。ANSI 最小集：过滤 CSI/OSC、
   \r 覆盖、\b 删除、常见 SGR；零框架零依赖不引 xterm.js；光标绝对定位/鼠标/滚动区域明确不做。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/terminal/terminal.read）；
   方法段写完整限定名 terminal.*。
   会话续接（Gitea #3，4 个方法）：terminal.list 打开时自动发现存活会话 → 仅 1 个时静默
   terminal.attach 恢复，多个时给「检测到 N 个未关闭的会话」选择条；attach 用
   cursor-replay_bytes 回放窗口重建屏幕后继续增量读。terminal.history 展示输入回滚
   （base64 解码 + 去控制符），terminal.history.clear 两段式确认清空。
   刷新 / 切走视图不再关闭会话（服务端 30 分钟空闲自动回收），这是"刷新就丢"痛点的根治。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/terminal/';
  var POLL_MS = 80;    // 交互级延迟，每次都是增量读
  var MAX_LINES = 300; // 回看缓冲上限（超出裁头），防长时间输出吃内存
  var SGR = {
    1: 'term-bold', 30: 'term-fg-30', 31: 'term-fg-31', 32: 'term-fg-32', 33: 'term-fg-33', 34: 'term-fg-34',
    35: 'term-fg-35', 36: 'term-fg-36', 37: 'term-fg-37', 90: 'term-fg-90', 91: 'term-fg-91', 92: 'term-fg-92',
    93: 'term-fg-93', 94: 'term-fg-94', 95: 'term-fg-95', 96: 'term-fg-96', 97: 'term-fg-97'
  };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function invoke(method, opts) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    opts = opts || {};
    return fetch(API + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: !!opts.keepalive,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(opts.params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { message: raw }; } }
        if (res.ok) return data;
        var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        err.code = data.code || ''; throw err;
      });
    });
  }
  // base64：字节流是唯一口径（避免截断多字节 UTF-8）；分块编码防 apply 参数超限
  function b64enc(bytes) {
    var bin = '', i = 0;
    while (i < bytes.length) { bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); i += 0x8000; }
    return btoa(bin);
  }
  function b64dec(text) {
    var bin = atob(text || ''), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // 样式随视图注入：不占首屏 style.css 预算，也不与其它视图互相干扰。
  function ensureCss() {
    if (document.getElementById('kore-terminal-extra-css')) return;
    var CSS = [
      '.term-sess{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--kore-warning);background:var(--kore-warning-bg);border-radius:var(--kore-radius-control);border-top-left-radius:0;border-top-right-radius:0}',
      '.term-sess-title{font-size:var(--kore-font-13);font-weight:600}',
      '.term-sess-sub{font-size:var(--kore-font-12)}',
      '.term-sess-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:var(--kore-font-12);color:var(--kore-text-2)}',
      '.term-sess-meta{flex:1 1 320px;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}',
      '.term-sess-ops{display:flex;gap:6px}',
      '.term-hist{display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow:auto;padding:10px 12px;border:1px solid var(--kore-border-2);background:var(--kore-bg-0);border-radius:var(--kore-radius-control);border-top-left-radius:0;border-top-right-radius:0}',
      '.term-hist-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:var(--kore-font-12);color:var(--kore-text-3)}',
      '.term-hist-title{font-weight:600;color:var(--kore-text-2)}',
      '.term-hist-ops{display:flex;gap:6px;margin-left:auto}',
      '.term-hist-sub{font-size:var(--kore-font-12)}',
      '.term-hist-ok{font-size:var(--kore-font-12);color:var(--kore-success)}',
      '.term-hist-err{font-size:var(--kore-font-12);color:var(--kore-danger)}',
      '.term-hist-item{display:flex;gap:8px;padding:3px 0;font-size:var(--kore-font-12);border-top:1px solid var(--kore-border-1)}',
      '.term-hist-item:first-of-type{border-top:0}',
      '.term-hist-at{flex:0 0 auto;color:var(--kore-text-3);font-variant-numeric:tabular-nums}',
      '.term-hist-text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--kore-text-2);word-break:break-all}',
      '@media (max-width:639px){.term-sess-ops{width:100%}.term-sess-ops .btn{flex:1 1 auto;min-height:var(--kore-touch)}' +
        '.term-hist-ops{width:100%;margin-left:0}.term-hist-ops .btn{flex:1 1 auto;min-height:var(--kore-touch)}}'
    ].join('');
    var style = el('style', null, CSS);
    style.id = 'kore-terminal-extra-css';
    document.head.appendChild(style);
  }
  /* ===== 最小 ANSI 渲染器：文本缓冲 + 光标（行内/换行/退格/回车）+ SGR ===== */
  function Term(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.lines = [[]]; this.row = 0; this.col = 0; // cell = {c:字符, s:SGR class}
    this.bold = false; this.fg = ''; this.state = 0; this.buf = ''; // 0 普通 / 1 ESC / 2 CSI / 3 OSC / 4 OSC 内 ESC
  }
  Term.prototype.cur = function () { return this.lines[this.row]; };
  Term.prototype.style = function () { return (this.bold ? 'term-bold ' : '') + this.fg; };
  Term.prototype.newline = function () {
    this.row++;
    if (!this.lines[this.row]) this.lines.push([]);
    this.col = 0;
    if (this.lines.length > MAX_LINES) { // 裁头时同步修正光标行号
      var drop = this.lines.length - MAX_LINES;
      this.lines.splice(0, drop); this.row = Math.max(0, this.row - drop);
    }
  };
  Term.prototype.put = function (ch) {
    if (this.col >= this.cols) { this.col = 0; this.newline(); } // 自动折行
    this.cur()[this.col] = { c: ch, s: this.style() };
    this.col++;
  };
  Term.prototype.clear = function () { this.lines = [[]]; this.row = 0; this.col = 0; };
  Term.prototype.sgr = function (parts) {
    if (!parts.length) { this.bold = false; this.fg = ''; return; }
    for (var i = 0; i < parts.length; i++) {
      var n = Number(parts[i] === '' ? 0 : parts[i]);
      if (n === 0) { this.bold = false; this.fg = ''; }
      else if (n === 1) this.bold = true;
      else if (n === 22) this.bold = false;
      else if (n === 39) this.fg = '';
      else if (SGR[n]) this.fg = SGR[n];
    }
  };
  Term.prototype.csi = function (params, final) {
    var body = params.replace(/^[?>!]/, ''), parts = body === '' ? [] : body.split(';'), mode = Number(parts[0] || 0);
    if (final === 'm') { this.sgr(parts); return; }
    if (final === 'J') { // 2J/3J 清屏；0J 清到屏幕末尾
      if (mode === 2 || mode === 3) { this.clear(); return; }
      this.cur().length = Math.min(this.cur().length, this.col); this.lines.length = this.row + 1; return;
    }
    if (final === 'K') { // 0K 清到行尾 / 1K 清到行首 / 2K 清整行
      var line = this.cur();
      if (mode === 1) { for (var i = 0; i <= this.col && i < line.length; i++) line[i] = { c: ' ', s: '' }; }
      else if (mode === 2) line.length = 0;
      else line.length = Math.min(line.length, this.col);
    }
    // 其余（H/f 绝对定位、滚动区域、鼠标报告）明确不做：忽略
  };
  Term.prototype.control = function (c, ch) {
    if (c === 0x0d) { this.col = 0; return; }   // \r 回行首（后续覆盖该行）
    if (c === 0x0a) { this.newline(); return; } // \n 换行
    if (c === 0x08) { if (this.col > 0) { this.col--; this.cur().splice(this.col, 1); } return; } // \b 删除前一字符
    if (c === 0x09) { for (var n = 8 - (this.col % 8); n > 0; n--) this.put(' '); return; }       // \t 制表位
    if (c < 0x20 || c === 0x7f) return;         // 其它控制符 / bell：忽略
    this.put(ch);
  };
  Term.prototype.ch = function (ch) {
    var c = ch.charCodeAt(0);
    switch (this.state) {
      case 0:
        if (c === 0x1b) { this.state = 1; return; }
        this.control(c, ch); return;
      case 1: // ESC 后一字节：CSI/OSC 进子状态，其余（字符集/键区）丢弃
        if (ch === '[') { this.state = 2; this.buf = ''; } else if (ch === ']') this.state = 3; else this.state = 0;
        return;
      case 2: // CSI：参数收到终止字节 0x40–0x7e
        if (c >= 0x40 && c <= 0x7e) { this.csi(this.buf, ch); this.state = 0; } else this.buf += ch;
        return;
      case 3: // OSC：BEL 结束
        if (c === 0x07) this.state = 0; else if (c === 0x1b) this.state = 4;
        return;
      default: this.state = ch === '\\' ? 0 : 3; // OSC 内 ESC：ESC \ 是 ST
    }
  };
  Term.prototype.feed = function (text) {
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { // 代理对合成一个码点
        var lo = text.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) { this.ch(text.substr(i, 2)); i++; continue; }
      }
      this.ch(text.charAt(i));
    }
  };
  Term.prototype.paint = function (pre) {
    var start = Math.max(0, this.lines.length - this.rows), frag = document.createDocumentFragment();
    for (var r = start; r < this.lines.length; r++) {
      if (r > start) frag.appendChild(document.createTextNode('\n'));
      var line = this.lines[r], run = '', style = null;
      for (var c = 0; c <= line.length; c++) {
        var cell = line[c], st = cell ? cell.s || '' : '';
        if (st !== style || c === line.length) {
          if (run) frag.appendChild(style ? el('span', style, run) : document.createTextNode(run));
          run = ''; style = st;
          if (c === line.length) break;
        }
        run += cell && cell.c !== undefined ? cell.c : ' ';
      }
    }
    pre.textContent = ''; // 只插入自己生成的 text/span，终端内容一律走 textContent
    pre.appendChild(frag);
  };
  /* ===== 视图 ===== */
  function render(container) {
    if (!container) return null;
    var S = { session: '', shell: '', pid: 0, cols: 80, rows: 24, poll: 0, reading: false,
      connecting: false, eof: false, idleAt: '', maxSessions: 0,
      sessions: null, histOpen: false, histData: null, histLoading: false, histError: '',
      histMsg: '', clearArmed: false };
    var term = null, decoder = new TextDecoder('utf-8'), destroyed = false, ro = null, debounce = 0,
      stage, screen, input, status, foot, retry, sessHost, histHost;
    container.textContent = '';
    var root = el('section', 'term');
    var bar = el('div', 'term-bar panel-head');
    bar.appendChild(el('span', 'panel-title', '终端'));
    status = el('span', 'term-status muted', '准备中…');
    bar.appendChild(status);
    var ops = el('span', 'term-ops');
    var btnNew = el('button', 'btn term-new', '新建会话');
    var btnClose = el('button', 'btn term-close', '关闭会话');
    var btnHist = el('button', 'btn term-hist-btn', '输入历史');
    retry = el('button', 'btn term-retry', '重连');
    retry.hidden = true;
    btnNew.type = 'button'; btnClose.type = 'button'; retry.type = 'button'; btnHist.type = 'button';
    ops.appendChild(btnNew); ops.appendChild(btnClose); ops.appendChild(btnHist); ops.appendChild(retry);
    bar.appendChild(ops); root.appendChild(bar);
    sessHost = el('div', 'term-sess-host'); sessHost.hidden = true; root.appendChild(sessHost);
    histHost = el('div', 'term-hist-host'); histHost.hidden = true; root.appendChild(histHost);
    stage = el('div', 'term-stage'); screen = el('pre', 'term-screen');
    screen.setAttribute('aria-live', 'polite'); screen.setAttribute('aria-label', '终端输出');
    input = el('textarea', 'term-input');
    input.setAttribute('autocomplete', 'off'); input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false'); input.setAttribute('aria-label', '终端输入');
    stage.appendChild(screen); stage.appendChild(input); root.appendChild(stage);
    foot = el('div', 'term-foot muted', '点击屏幕后直接输入；Enter 执行、Ctrl+C 中断。');
    root.appendChild(foot); container.appendChild(root);

    function setStatus(text, tone) {
      status.textContent = text;
      status.className = 'term-status ' + (tone === 'fail' ? 'term-fail' : tone === 'ok' ? 'term-ok' : 'muted');
    }
    function setFoot() {
      if (!S.session) { foot.textContent = '点击屏幕后直接输入；Enter 执行、Ctrl+C 中断。'; return; }
      var base = '会话 ' + S.session + ' · ' + S.shell + ' · 进程 ' + S.pid + ' · ' + S.cols + '×' + S.rows;
      if (S.eof) { foot.textContent = base + ' · 会话已结束（shell 已退出，点「新建会话」继续）'; return; }
      if (S.idleAt) {
        var mins = Math.max(0, Math.round((new Date(S.idleAt).getTime() - Date.now()) / 60000));
        foot.textContent = base + ' · 空闲 ' + mins + ' 分钟无操作会自动回收';
        return;
      }
      foot.textContent = base;
    }
    // 时间人话化：列表/选择条里不甩 RFC3339 原文（USABILITY ④）。
    function fmtClock(iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso || '—');
      function p(v) { return v < 10 ? '0' + v : String(v); }
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    function measure() { // cols=floor(w/8)、rows=floor(h/18)，按容器估算
      var w = stage.clientWidth || 640, h = stage.clientHeight || 360;
      return { cols: Math.max(20, Math.min(300, Math.floor(w / 8))), rows: Math.max(6, Math.min(120, Math.floor(h / 18))) };
    }
    function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = 0; } }
    function disconnect(msg) { stopPoll(); S.session = ''; retry.hidden = false; setStatus(msg || '已断开', 'fail'); setFoot(); }
    function tick() {
      if (S.reading || !S.session || destroyed) return;
      S.reading = true;
      invoke('terminal.read', { params: { session_id: S.session, max_bytes: 262144 } }).then(function (r) {
        S.reading = false;
        if (destroyed) return;
        if (r.data) {
          var text = decoder.decode(b64dec(r.data), { stream: true }); // 流式解码：容忍截断的多字节
          if (text) { term.feed(text); term.paint(screen); stage.scrollTop = stage.scrollHeight; }
        }
        if (r.eof) disconnect('会话已退出');
      }, function (err) {
        S.reading = false;
        if (!destroyed) disconnect(err.code === 'E_NOTFOUND' ? '会话已失效（可能被空闲回收）' : '读取失败：' + err.message);
      });
    }
    function startPoll() { stopPoll(); S.poll = setInterval(tick, POLL_MS); }
    function closeSession() {
      var id = S.session;
      S.session = ''; stopPoll(); retry.hidden = false; setStatus('已关闭', 'ok'); setFoot();
      if (id) invoke('terminal.close', { params: { session_id: id }, keepalive: true }).catch(function () {});
    }
    function connect() {
      if (destroyed || S.connecting) return;
      S.connecting = true; retry.hidden = true; setStatus('正在创建会话…');
      var geo = measure();
      invoke('terminal.create', { params: { cols: geo.cols, rows: geo.rows } }).then(function (r) {
        S.connecting = false;
        if (destroyed) { invoke('terminal.close', { params: { session_id: r.session_id } }).catch(function () {}); return; }
        S.session = r.session_id; S.shell = r.shell; S.pid = r.pid; S.cols = r.cols; S.rows = r.rows;
        S.eof = false; S.idleAt = ''; hideSess();
        decoder = new TextDecoder('utf-8'); term = new Term(r.cols, r.rows); // 新会话独立解码状态
        screen.textContent = ''; setStatus('已连接', 'ok'); setFoot(); startPoll();
        if (input.focus) input.focus();
      }, function (err) {
        S.connecting = false; retry.hidden = false;
        // 会话数上限（默认 4）：给出可操作出路，而不是甩一个错误码。
        setStatus(err.code === 'E_RATELIMIT'
          ? '会话数已达上限（最多 ' + (S.maxSessions || 4) + ' 个）：先在上方恢复或关闭一个已有会话'
          : '创建会话失败：' + err.message, 'fail');
      });
    }
    function newSession() {
      var old = S.session;
      S.session = ''; stopPoll(); term = null; screen.textContent = '';
      if (old) invoke('terminal.close', { params: { session_id: old } }).catch(function () {});
      connect();
    }
    /* ===== 会话发现与恢复（terminal.list / terminal.attach）===== */
    function hideSess() { if (sessHost) { sessHost.hidden = true; sessHost.textContent = ''; } }
    // 选择条：把 eof / 最近活动翻译成人话，恢复与关闭都是一次点击。
    function showSess(list) {
      if (!sessHost) return;
      S.sessions = list;
      sessHost.textContent = ''; sessHost.hidden = false;
      var box = el('div', 'term-sess');
      box.appendChild(el('div', 'term-sess-title', '检测到 ' + list.length + ' 个未关闭的会话，要恢复吗？'));
      box.appendChild(el('div', 'muted term-sess-sub',
        '恢复 = 接回原来的屏幕和输入，不用重开；不需要的可以直接关掉。'));
      list.forEach(function (info) {
        var row = el('div', 'term-sess-row');
        row.appendChild(el('span', 'term-sess-meta',
          (info.eof ? '会话已结束（可看最后输出）' : '可恢复') + ' · ' + (info.shell || '登录 shell') +
          ' · 进程 ' + info.pid + ' · 最近活动 ' + fmtClock(info.last_active)));
        var rowOps = el('span', 'term-sess-ops');
        var resume = el('button', 'btn', info.eof ? '查看' : '恢复'); resume.type = 'button';
        resume.addEventListener('click', function () { hideSess(); restoreSession(info); });
        var drop = el('button', 'btn btn-ghost', '关闭'); drop.type = 'button';
        drop.title = '结束这个会话（连同它的 shell 进程）';
        drop.addEventListener('click', function () { closeOne(info.session_id); });
        rowOps.appendChild(resume); rowOps.appendChild(drop);
        row.appendChild(rowOps);
        box.appendChild(row);
      });
      sessHost.appendChild(box);
    }
    // 打开视图先探活：仅 1 个存活会话 → 静默恢复（少步骤）；≥2 → 选择条；没有 → 新建。
    function boot() {
      invoke('terminal.list', { params: {} }).then(function (r) {
        if (destroyed) return;
        var all = r.sessions || [], live = all.filter(function (s) { return !s.eof; });
        S.maxSessions = r.max_sessions || 0;
        if (live.length === 1 && all.length === 1) { restoreSession(live[0]); return; }
        if (live.length >= 1) { showSess(all); setStatus('发现可恢复的会话', 'ok'); return; }
        connect();
      }, function () { if (!destroyed) connect(); }); // 探活失败不砖化视图：退回新建
    }
    function closeOne(id) {
      invoke('terminal.close', { params: { session_id: id }, keepalive: true }).then(function () {
        if (destroyed) return;
        var left = (S.sessions || []).filter(function (s) { return s.session_id !== id; });
        S.sessions = left;
        var live = left.filter(function (s) { return !s.eof; });
        if (!left.length || !live.length) { hideSess(); if (!S.session) connect(); return; }
        showSess(left);
      }, function (err) {
        if (destroyed) return;
        setStatus('关闭会话失败：' + err.message, 'fail');
      });
    }
    // terminal.attach：接管存活会话 → 用回放窗口重建屏幕 → 继续增量读。
    function restoreSession(info) {
      if (destroyed || S.connecting) return;
      S.connecting = true; retry.hidden = true; setStatus('正在恢复会话…');
      invoke('terminal.attach', { params: { session_id: info.session_id } }).then(function (a) {
        S.connecting = false;
        if (destroyed) return;
        S.session = a.session_id; S.shell = a.shell; S.pid = a.pid;
        S.cols = a.cols; S.rows = a.rows; S.eof = !!a.eof; S.idleAt = a.idle_expires_at || '';
        decoder = new TextDecoder('utf-8'); term = new Term(a.cols, a.rows);
        screen.textContent = ''; hideSess();
        setStatus(a.eof ? '会话已结束' : '已恢复会话', a.eof ? 'fail' : 'ok'); setFoot();
        // 回放 [cursor-replay_bytes, cursor) 重建刷新前的屏幕；max 放宽到 1MiB 顺带吃掉
        // attach 与 read 之间新到的输出（读游标小于当前偏移时走服务端补读窗口，不重复不遗漏）。
        var from = Math.max(0, a.cursor - a.replay_bytes);
        var p = a.replay_bytes > 0
          ? invoke('terminal.read', { params: { session_id: a.session_id, cursor: from, max_bytes: 1048576 } })
          : Promise.resolve(null);
        p.then(function (r) {
          if (destroyed || S.session !== a.session_id) return;
          if (r && r.data) {
            var text = decoder.decode(b64dec(r.data));
            if (text) { term.feed(text); term.paint(screen); stage.scrollTop = stage.scrollHeight; }
          }
          if (S.eof) return; // 已结束：只回放，不起轮询
          startPoll();
          if (input.focus) input.focus();
        }, function () {
          if (destroyed || S.eof) return;
          startPoll(); // 回放失败不拆会话：直接进入增量读，旧屏幕内容缺失但可用
        });
      }, function (err) {
        S.connecting = false; retry.hidden = false;
        // 会话可能已被空闲回收 / 归属不符：说明原因并自动新建，不让用户卡住。
        setStatus('恢复会话失败（' + err.message + '），已为你新建会话', 'fail');
        connect();
      });
    }
    /* ===== 输入历史（terminal.history / terminal.history.clear）===== */
    // data 是 base64 的原始输入字节：剥 ANSI 转义与控制符、回车显示成 ⏎，超长截断。
    function histText(b64) {
      try {
        var s = new TextDecoder('utf-8').decode(b64dec(b64));
        s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
             .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
             .replace(/[\r\n]+/g, ' ⏎ ').replace(/\t/g, ' ')
             .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
        s = s.replace(/\s+/g, ' ').trim();
        if (!s) return '（不可见输入）';
        return s.length > 160 ? s.slice(0, 160) + '…' : s;
      } catch (e) { return '（这条记录解码失败）'; }
    }
    function toggleHist() {
      if (S.histOpen) { S.histOpen = false; histHost.hidden = true; return; }
      S.histOpen = true; histHost.hidden = false;
      S.histMsg = ''; S.clearArmed = false;
      loadHistory();
    }
    function loadHistory() {
      S.histLoading = true; S.histError = ''; renderHist();
      invoke('terminal.history', { params: { limit: 50 } }).then(function (r) {
        if (destroyed) return;
        S.histLoading = false; S.histData = r; renderHist();
      }, function (err) {
        if (destroyed) return;
        S.histLoading = false; S.histError = err.message; renderHist();
      });
    }
    function clearHistory() {
      if (!S.clearArmed) { S.clearArmed = true; renderHist(); return; } // 两段式确认，不弹窗
      invoke('terminal.history.clear', { params: {} }).then(function (r) {
        if (destroyed) return;
        S.clearArmed = false;
        S.histMsg = '已清空 ' + (r.cleared_entries || 0) + ' 条输入（' +
          (r.cleared_sessions || 0) + ' 个会话）';
        loadHistory();
      }, function (err) {
        if (destroyed) return;
        S.clearArmed = false; S.histError = err.message; renderHist();
      });
    }
    function renderHist() {
      if (!histHost || !S.histOpen) return;
      histHost.textContent = '';
      var box = el('div', 'term-hist');
      var head = el('div', 'term-hist-head');
      head.appendChild(el('span', 'term-hist-title', '输入历史（最近敲过的命令）'));
      var d = S.histData;
      head.appendChild(el('span', 'muted', d
        ? (d.count || 0) + ' 条 · 最多保留 ' + (d.max_entries || '—') + ' 条' : ''));
      var headOps = el('span', 'term-hist-ops');
      var refresh = el('button', 'btn btn-ghost', '刷新'); refresh.type = 'button';
      refresh.addEventListener('click', loadHistory);
      var clear = el('button', 'btn btn-ghost', S.clearArmed ? '确认清空？' : '清空历史');
      clear.type = 'button';
      clear.addEventListener('click', clearHistory);
      var shut = el('button', 'btn btn-ghost', '收起'); shut.type = 'button';
      shut.addEventListener('click', function () { S.histOpen = false; histHost.hidden = true; });
      headOps.appendChild(refresh); headOps.appendChild(clear); headOps.appendChild(shut);
      head.appendChild(headOps);
      box.appendChild(head);
      if (S.clearArmed) box.appendChild(el('div', 'muted term-hist-sub',
        '再点一次「确认清空？」删除全部输入历史；点「收起」放弃。'));
      if (S.histMsg) box.appendChild(el('div', 'term-hist-ok', S.histMsg));
      if (S.histError) {
        box.appendChild(el('div', 'term-hist-err', '读取失败：' + S.histError));
        histHost.appendChild(box); return;
      }
      if (S.histLoading) { box.appendChild(el('div', 'muted', '正在读取…')); histHost.appendChild(box); return; }
      if (!d) { histHost.appendChild(box); return; }
      if (d.enabled === false) {
        box.appendChild(el('div', 'muted', '输入历史在插件侧已关闭，这里不会有记录。'));
        histHost.appendChild(box); return;
      }
      if (d.storage_error) box.appendChild(el('div', 'term-hist-err',
        '历史存储异常（' + d.storage_error + '）：记录可能不全，可点「清空历史」重置。'));
      var entries = d.entries || [];
      if (!entries.length) {
        box.appendChild(el('div', 'muted', '还没有输入历史：在下方终端里敲几条命令就有了。'));
        histHost.appendChild(box); return;
      }
      entries.slice().reverse().forEach(function (e) {
        var row = el('div', 'term-hist-item');
        row.appendChild(el('span', 'term-hist-at', fmtClock(e.at)));
        row.appendChild(el('span', 'term-hist-text', histText(e.data) +
          (e.truncated ? '（太长已截断）' : '')));
        box.appendChild(row);
      });
      histHost.appendChild(box);
    }
    // 键盘 → 字节：Enter=\r、Backspace=\x7f，方向键走 CSI，Ctrl+字母走 0x01–0x1a
    var KEYS = {
      Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b',
      ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
      Home: '\x1b[H', End: '\x1b[F', Insert: '\x1b[2~', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~'
    };
    function send(text) {
      if (!S.session || !term) return;
      var payload = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
      invoke('terminal.write', { params: { session_id: S.session, data: b64enc(new TextEncoder().encode(payload)) } })
        .catch(function (err) { if (err.code === 'E_NOTFOUND') disconnect('会话已失效'); });
    }
    function onKey(ev) {
      if (ev.isComposing) return;
      var bytes = null;
      if (ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey && /^[a-z]$/i.test(ev.key)) {
        bytes = String.fromCharCode(ev.key.toUpperCase().charCodeAt(0) - 64); // Ctrl+A=0x01
      } else if (ev.ctrlKey && ev.key === '[') bytes = '\x1b'; else if (KEYS[ev.key]) bytes = KEYS[ev.key];
      if (!bytes) return; // 普通可打印字符交给 input 事件（IME 合成也走那里）
      ev.preventDefault(); send(bytes);
    }
    function onInput(ev) {
      if (ev.isComposing) return;
      var data = input.value;
      if (!data) return;
      input.value = ''; send(data);
    }
    function onVisualViewport() { // 虚拟键盘弹出：把输出滚到输入行附近即可，不做复杂适配
      var vv = window.visualViewport;
      if (vv && vv.height + 100 < window.innerHeight) stage.scrollTop = stage.scrollHeight;
    }
    function onPageHide() {
      // 刷新/关标签不再关闭会话：会话留给下一次 terminal.list 自动发现并恢复；
      // 服务端按最近活动时间（默认 30 分钟）自动回收，不会无限堆积。
      stopPoll();
    }
    function scheduleResize() { // 容器变化防抖 300ms → terminal.resize
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function () {
        debounce = 0;
        if (destroyed || !S.session || !term) return;
        var geo = measure();
        if (geo.cols === S.cols && geo.rows === S.rows) return;
        S.cols = geo.cols; S.rows = geo.rows; term.cols = geo.cols; term.rows = geo.rows;
        invoke('terminal.resize', { params: { session_id: S.session, cols: geo.cols, rows: geo.rows } })
          .then(function (r) { S.cols = r.cols; S.rows = r.rows; setFoot(); })
          .catch(function () { /* resize 失败不拆会话，下一次变化再试 */ });
      }, 300);
    }
    btnNew.addEventListener('click', newSession); btnClose.addEventListener('click', closeSession);
    btnHist.addEventListener('click', toggleHist);
    retry.addEventListener('click', connect);
    screen.addEventListener('click', function () { input.focus(); });
    stage.addEventListener('click', function () { input.focus(); });
    input.addEventListener('keydown', onKey); input.addEventListener('input', onInput);
    document.addEventListener('visibilitychange', function () { // 后台停轮询，回前台恢复
      if (document.hidden) stopPoll(); else if (S.session && !S.poll && !destroyed) startPoll();
    });
    window.addEventListener('pagehide', onPageHide);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onVisualViewport);
    if (window.ResizeObserver) { ro = new ResizeObserver(scheduleResize); ro.observe(stage); }
    ensureCss();
    boot(); // 先 terminal.list 探活，再决定 恢复 / 选择 / 新建
    return {
      destroy: function () { // 切视图：停轮询 + 断观察，**不关会话**（下次进入自动恢复；空闲由服务端回收）
        destroyed = true; stopPoll();
        if (debounce) clearTimeout(debounce);
        if (ro) ro.disconnect();
        if (window.visualViewport) window.visualViewport.removeEventListener('resize', onVisualViewport);
        window.removeEventListener('pagehide', onPageHide);
        input.blur();
      }
    };
  }
  window.KoreTerminal = { render: render };
})();
