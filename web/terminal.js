/* kore 主壳 · Web 终端（web/terminal.js）· window.KoreTerminal.render(container) → {destroy}
   契约（kore-plugin-terminal README）：write/read 的 data 是标准 base64；read 增量读（空串=暂无输出，
   eof=shell 已退出）；POST /api/v1/invoke/terminal/<m> + X-Kore-CSRF。ANSI 最小集：过滤 CSI/OSC、
   \r 覆盖、\b 删除、常见 SGR；零框架零依赖不引 xterm.js；光标绝对定位/鼠标/滚动区域明确不做。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/terminal/terminal.read）；
   方法段写完整限定名 terminal.*。 */
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
    var S = { session: '', shell: '', pid: 0, cols: 80, rows: 24, poll: 0, reading: false, connecting: false };
    var term = null, decoder = new TextDecoder('utf-8'), destroyed = false, ro = null, debounce = 0, stage, screen, input, status, foot, retry;
    container.textContent = '';
    var root = el('section', 'term');
    var bar = el('div', 'term-bar panel-head');
    bar.appendChild(el('span', 'panel-title', '终端'));
    status = el('span', 'term-status muted', '准备中…');
    bar.appendChild(status);
    var ops = el('span', 'term-ops');
    var btnNew = el('button', 'btn term-new', '新建会话');
    var btnClose = el('button', 'btn term-close', '关闭会话');
    retry = el('button', 'btn term-retry', '重连');
    retry.hidden = true;
    btnNew.type = 'button'; btnClose.type = 'button'; retry.type = 'button';
    ops.appendChild(btnNew); ops.appendChild(btnClose); ops.appendChild(retry);
    bar.appendChild(ops); root.appendChild(bar);
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
      foot.textContent = S.session ? '会话 ' + S.session + ' · ' + S.shell + ' · pid ' + S.pid + ' · ' + S.cols + '×' + S.rows
        : '点击屏幕后直接输入；Enter 执行、Ctrl+C 中断。';
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
        decoder = new TextDecoder('utf-8'); term = new Term(r.cols, r.rows); // 新会话独立解码状态
        screen.textContent = ''; setStatus('已连接', 'ok'); setFoot(); startPoll();
        if (input.focus) input.focus();
      }, function (err) {
        S.connecting = false; retry.hidden = false;
        setStatus('创建会话失败：' + err.message, 'fail');
      });
    }
    function newSession() {
      var old = S.session;
      S.session = ''; stopPoll(); term = null; screen.textContent = '';
      if (old) invoke('terminal.close', { params: { session_id: old } }).catch(function () {});
      connect();
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
      stopPoll();
      if (S.session) invoke('terminal.close', { params: { session_id: S.session }, keepalive: true }).catch(function () {});
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
    connect();
    return {
      destroy: function () { // 切视图/卸载：停轮询 + 断观察 + 关会话（防 4 会话上限被泄漏占满）
        destroyed = true; stopPoll();
        if (debounce) clearTimeout(debounce);
        if (ro) ro.disconnect();
        if (window.visualViewport) window.visualViewport.removeEventListener('resize', onVisualViewport);
        window.removeEventListener('pagehide', onPageHide);
        if (S.session) invoke('terminal.close', { params: { session_id: S.session } }).catch(function () {});
        S.session = ''; input.blur();
      }
    };
  }
  window.KoreTerminal = { render: render };
})();
