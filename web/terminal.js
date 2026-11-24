/* kore 主壳 · Web 终端（web/terminal.js）· window.KoreTerminal.render(container) → {destroy}
   契约（kore-plugin-terminal README）：write/read 的 data 是标准 base64；read 增量读（空串=暂无输出，
   eof=shell 已退出）；POST /api/v1/invoke/terminal/<m> + X-Kore-CSRF。ANSI：自研 VT 子集（光标绝对定位 / 滚动区域 / 备用屏 / 256 色 / 光标显隐），vim、htop 可正常整屏重绘；
   零框架零依赖不引 xterm.js（选型理由与覆盖清单见下方引擎头注释）；鼠标报告与图片协议明确不做。
   回看缓冲 2000 行；屏幕可鼠标选中复制（输入层不再铺满遮挡），也可点「复制」取整屏。
   多标签：每标签一个独立会话（create/list/attach/close 复用同一后端契约），切换只换 DOM 挂载与轮询；
   字号 A−/A+ 全局生效并存 localStorage（键 kore.terminal.fontSize）。
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
        '.term-hist-ops{width:100%;margin-left:0}.term-hist-ops .btn{flex:1 1 auto;min-height:var(--kore-touch)}' +
        '.term-hist-item .btn{min-height:var(--kore-touch)}' +
        '.term-hist-search{min-height:var(--kore-touch);font-size:16px}' +
        '.term-input{position:fixed;left:0;right:0;bottom:0;height:var(--kore-touch);opacity:1;' +
        'background:var(--kore-bg-1);color:var(--kore-text-1);border-top:1px solid var(--kore-border-2);' +
        'caret-color:var(--kore-text-1);padding:0 12px;font-size:16px}' +
        '.term-stage{padding-bottom:calc(var(--kore-touch) + 12px)}}' +
      // 本视图专属样式一律在此注入：web/style.css 属首屏资产，改它会动首屏 gzip 预算
      '.term-input{pointer-events:none}' +
      '.term-screen{padding:0}' +
      '.term-line{white-space:pre}' +
      '.term-cursor{display:inline-block;min-width:.6em;background:var(--kore-text-1);color:var(--kore-bg-0);' +
      'box-shadow:0 0 0 1px var(--kore-text-1)}' +
      '.term:fullscreen{height:100vh;padding:8px;background:var(--kore-bg-0);border-radius:0}' +
      '.term:fullscreen .term-stage{border-radius:var(--kore-radius-control)}' +
      '@media (max-width:639px){.term-input{pointer-events:auto}}' +
      // 多标签栏 + 字号按钮：触摸目标 ≥44px（--kore-touch 通常是 44px），窄屏横向滚动
      '.term-tabs{display:flex;align-items:center;gap:4px;overflow-x:auto;padding:4px 8px;' +
      'border-bottom:1px solid var(--kore-border-2);background:var(--kore-bg-1);min-height:44px}' +
      '.term-tab{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;min-height:44px;' +
      'padding:0 10px;border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);' +
      'font-size:var(--kore-font-12);color:var(--kore-text-2);background:var(--kore-bg-0);cursor:pointer}' +
      '.term-tab.is-active{color:var(--kore-text-1);border-color:var(--kore-info);background:var(--kore-bg-2)}' +
      '.term-tab-x,.term-tab-add,.term-fbtn{min-height:44px;min-width:44px;flex:0 0 auto;' +
      'display:inline-flex;align-items:center;justify-content:center}'
    ].join('');
    var style = el('style', null, CSS);
    style.id = 'kore-terminal-extra-css';
    document.head.appendChild(style);
  }
  /* ===== ANSI/VT 渲染引擎（等价实现，零依赖）=====
     为什么不是 xterm.js：主壳前端是零构建、按单段文件名托管（web/embed.go 的 //go:embed 精确路径），
     引 xterm.js 需要新增 vendor 资产 + 改 Makefile 的 WEB_SRC_FILES + 改 embed.go 三处，
     且多付 ~70–90 KiB gzip 的懒加载体积。这里按同一份协议契约实现 VT 子集，保持"零框架零依赖"。
     覆盖：CR/LF/BS/HT · CSI A B C D E F G H f d J K L M P S T X @ ` · SGR 0/1/4/7/22/24/27/
     30-37/38;5;n/38;2;r;g;b/39/40-47/48;5;n/49/90-97/100-107 · DECSTBM(r) · 备用屏 (?1049/?47/
     ?1047) · 光标显隐 (?25) · 保存/恢复光标 (s/u · ESC 7/8) · DECAWM (?7) · OSC 丢弃（标题/超链接）。
     不做：鼠标报告（?1000/1006，无鼠标事件语义）、字符集切换、图片协议——忽略而非报错。
     屏幕模型：固定 rows×cols 网格 + 独立滚动历史（hist），因此 vim/htop 的光标定位与整屏重绘可正确收敛，
     历史行一旦滚出即不可变（缓存签名），重绘只碰变动行。 */
  var HIST_MAX = 2000; // 回看缓冲（行），够翻一次 ls -lR / 一次编译日志
  var FG16 = {
    30: 'var(--kore-text-3)', 31: 'var(--kore-danger)', 32: 'var(--kore-success)', 33: 'var(--kore-warning)',
    34: 'var(--kore-info)', 35: 'var(--kore-term-magenta)', 36: 'var(--kore-term-cyan)', 37: 'var(--kore-text-1)',
    90: 'var(--kore-text-3)', 91: 'var(--kore-danger)', 92: 'var(--kore-success)', 93: 'var(--kore-warning)',
    94: 'var(--kore-info)', 95: 'var(--kore-term-magenta)', 96: 'var(--kore-term-cyan)', 97: 'var(--kore-text-1)',
    40: 'var(--kore-bg-3)', 41: 'var(--kore-danger)', 42: 'var(--kore-success)', 43: 'var(--kore-warning)',
    44: 'var(--kore-info)', 45: 'var(--kore-term-magenta)', 46: 'var(--kore-term-cyan)', 47: 'var(--kore-text-2)',
    100: 'var(--kore-bg-2)', 101: 'var(--kore-danger)', 102: 'var(--kore-success)', 103: 'var(--kore-warning)',
    104: 'var(--kore-info)', 105: 'var(--kore-term-magenta)', 106: 'var(--kore-term-cyan)', 107: 'var(--kore-text-1)'
  };
  // xterm-256 → hex：16 基础色 + 6×6×6 立方 + 24 灰阶（业界同源公式）
  var CUBE = [0, 95, 135, 175, 215, 255];
  function c256(n) {
    n = Number(n) || 0;
    if (n < 16) return n;           // 基础 16 色走 CSS 令牌
    if (n < 232) {
      var i = n - 16;
      return rgb(CUBE[Math.floor(i / 36) % 6], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]);
    }
    var g = 8 + (n - 232) * 10;
    return rgb(g, g, g);
  }
  function rgb(r, g, b) {
    function h(v) { v = Math.max(0, Math.min(255, Number(v) || 0)); return (v < 16 ? '0' : '') + v.toString(16); }
    return '#' + h(r) + h(g) + h(b);
  }
  function Term(cols, rows) {
    this.cols = cols || 80; this.rows = rows || 24;
    this.pn = []; this.ps = []; // 已渲染 DOM 节点 / 行签名（增量重绘用）
    this.resetAll();
  }
  Term.prototype.blank = function () { var a = [], i; for (i = 0; i < this.cols; i++) a.push(null); return a; };
  Term.prototype.resetAll = function () {
    this.grid = []; for (var i = 0; i < this.rows; i++) this.grid.push(this.blank());
    this.hsig = []; this.hist = [];          // 滚动历史（行数组 + 与其等长的签名缓存）
    this.row = 0; this.col = 0; this.top = 0; this.bottom = this.rows - 1;
    this.attr = { f: '', b: '', a: '' }; this.wrapnext = false; this.wrap = true;
    this.cursor = true; this.state = 0; this.buf = ''; this.saved = null; this.alt = null;
    this.pn = []; this.ps = [];
  };
  // 行签名：内容 + 样式 + （光标行）光标列。历史行算一次即缓存，避免每次重绘扫全缓冲。
  Term.prototype.sigOf = function (line, curCol) {
    var s = '', last = -1, i, cell;
    for (i = 0; i < line.length; i++) if (line[i]) last = i;
    for (i = 0; i <= last; i++) {
      cell = line[i];
      if (!cell) { s += ' '; continue; }
      s += cell.c + '\u0001' + cell.f + '\u0001' + cell.b + '\u0001' + cell.a;
    }
    return curCol >= 0 ? s + '\u0002' + curCol : s;
  };
  Term.prototype.lineNode = function (line, curCol) {
    var d = document.createElement('div'); d.className = 'term-line';
    var last = -1, i, cell;
    for (i = 0; i < line.length; i++) if (line[i]) last = i;
    if (curCol > last) last = curCol;
    var run = '', st = null, sig = '';
    function flush() {
      if (!run) return;
      var n = document.createElement('span');
      if (sig) n.setAttribute('style', sig);
      n.textContent = run;
      d.appendChild(n); run = '';
    }
    for (i = 0; i <= last; i++) {
      cell = line[i];
      var f = cell ? cell.f : '', b = cell ? cell.b : '', a = cell ? cell.a : '';
      var next = (f ? 'color:' + f + ';' : '') + (b ? 'background-color:' + b + ';' : '') +
        (a.indexOf('b') >= 0 ? 'font-weight:700;' : '') + (a.indexOf('i') >= 0 ? 'font-style:italic;' : '') +
        (a.indexOf('u') >= 0 ? 'text-decoration:underline;' : '') +
        (a.indexOf('r') >= 0 ? 'filter:invert(1);' : '');
      if (i === curCol) { // 光标：块状，压在字符上（vim 里就是那个方块）
        flush();
        var cur = document.createElement('span');
        cur.className = 'term-cursor';
        cur.textContent = cell && cell.c !== ' ' ? cell.c : ' ';
        d.appendChild(cur);
        st = null; sig = '';
        continue;
      }
      if (next !== st) { flush(); st = next; sig = next; }
      run += cell ? cell.c : ' ';
    }
    flush();
    if (!d.childNodes.length) d.appendChild(document.createTextNode(' '));
    return d;
  };
  // 增量重绘：先按长度裁头（hist 满时滚出 1 行），再做公共前缀/后缀对齐，只替换变动行。
  Term.prototype.paint = function (pre) {
    var lines = this.hist.concat(this.grid), sigs = [], i;
    var curAbs = this.hist.length + this.row;
    for (i = 0; i < this.hist.length; i++) sigs.push(this.hsig[i]);
    for (i = 0; i < this.grid.length; i++) {
      sigs.push(this.sigOf(this.grid[i], (this.hist.length + i === curAbs && this.cursor) ? this.col : -1));
    }
    while (this.pn.length > sigs.length) { // 头部滚出：直接摘 DOM，不整屏重建
      pre.removeChild(this.pn.shift()); this.ps.shift();
    }
    if (!this.ps.length) {
      for (i = 0; i < sigs.length; i++) {
        var node = this.lineNode(lines[i], (i === curAbs && this.cursor) ? this.col : -1);
        pre.appendChild(node); this.pn.push(node); this.ps.push(sigs[i]);
      }
      return;
    }
    var head = 0, tail = 0, n = Math.min(this.ps.length, sigs.length);
    while (head < n && this.ps[head] === sigs[head]) head++;
    while (tail < n - head && this.ps[this.ps.length - 1 - tail] === sigs[sigs.length - 1 - tail]) tail++;
    var mid = this.ps.length - tail; // 旧 [head, mid) 换新 [head, sigs.length-tail)
    var ref = this.pn[mid] || null;
    for (i = head; i < mid; i++) pre.removeChild(this.pn[i]);
    var fresh = [];
    for (i = head; i < sigs.length - tail; i++) {
      var nd = this.lineNode(lines[i], (i === curAbs && this.cursor) ? this.col : -1);
      pre.insertBefore(nd, ref); fresh.push(nd);
    }
    this.pn = this.pn.slice(0, head).concat(fresh, this.pn.slice(mid));
    this.ps = this.ps.slice(0, head).concat(sigs.slice(head, sigs.length - tail), this.ps.slice(mid));
  };
  Term.prototype.text = function () { // 复制用：历史 + 屏幕，行尾空白裁掉
    var out = [], i, j, arr = this.hist.concat(this.grid);
    for (i = 0; i < arr.length; i++) {
      var line = arr[i], s = '';
      for (j = 0; j < line.length; j++) s += line[j] ? line[j].c : ' ';
      out.push(s.replace(/\s+$/, ''));
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  };
  Term.prototype.put = function (ch) {
    if (this.wrapnext) { this.wrapnext = false; if (this.wrap) { this.col = 0; this.lineFeed(); } }
    this.grid[this.row][this.col] = { c: ch, f: this.attr.f, b: this.attr.b, a: this.attr.a };
    if (this.col >= this.cols - 1) this.wrapnext = true; else this.col++;
  };
  Term.prototype.lineFeed = function () {
    if (this.row === this.bottom) this.scrollUp(1); else if (this.row < this.rows - 1) this.row++;
  };
  Term.prototype.scrollUp = function (n) {
    n = Math.max(1, n | 0);
    while (n--) {
      var line = this.grid[this.top];
      if (this.top === 0 && this.bottom === this.rows - 1) { // 全屏上滚才进历史（备用屏不进）
        if (!this.alt) {
          this.hist.push(line); this.hsig.push(this.sigOf(line, -1));
          if (this.hist.length > HIST_MAX) { this.hist.shift(); this.hsig.shift(); }
        }
      }
      this.grid.splice(this.top, 1); this.grid.splice(this.bottom, 0, this.blank());
    }
  };
  Term.prototype.scrollDown = function (n) {
    n = Math.max(1, n | 0);
    while (n--) { this.grid.splice(this.bottom, 1); this.grid.splice(this.top, 0, this.blank()); }
  };
  Term.prototype.clear = function (all) {
    for (var i = 0; i < this.rows; i++) this.grid[i] = this.blank();
    this.row = this.top; this.col = 0; this.wrapnext = false;
    if (all) { this.hist = []; this.hsig = []; }
  };
  Term.prototype.sgr = function (parts) {
    var a = this.attr, i, n;
    if (!parts.length) { this.attr = { f: '', b: '', a: '' }; return; }
    for (i = 0; i < parts.length; i++) {
      n = Number(parts[i] === '' ? 0 : parts[i]);
      if (n === 0) { a = this.attr = { f: '', b: '', a: '' }; continue; }
      if (n === 1) { if (a.a.indexOf('b') < 0) a.a += 'b'; continue; }
      if (n === 3) { if (a.a.indexOf('i') < 0) a.a += 'i'; continue; }
      if (n === 4) { a.a += 'u'; continue; }
      if (n === 7) { a.a += 'r'; continue; }
      if (n === 22) { a.a = a.a.replace(/b/g, ''); continue; }
      if (n === 23) { a.a = a.a.replace(/i/g, ''); continue; }
      if (n === 24) { a.a = a.a.replace(/u/g, ''); continue; }
      if (n === 27) { a.a = a.a.replace(/r/g, ''); continue; }
      if (n === 39) { a.f = ''; continue; }
      if (n === 49) { a.b = ''; continue; }
      if (n === 38 || n === 48) { // 扩展色：38;5;n / 38;2;r;g;b
        var key = n === 38 ? 'f' : 'b';
        if (Number(parts[i + 1]) === 5) { a[key] = String(c256(parts[i + 2])); i += 2; }
        else if (Number(parts[i + 1]) === 2) { a[key] = rgb(parts[i + 2], parts[i + 3], parts[i + 4]); i += 4; }
        continue;
      }
      if (FG16[n] !== undefined) {
        if (n >= 40 && n < 50) a.b = FG16[n]; else if (n >= 100) a.b = FG16[n]; else a.f = FG16[n];
        continue;
      }
    }
  };
  Term.prototype.csi = function (params, final) {
    var raw = String(params || ''), priv = /^[?>!]/.test(raw) ? raw.charAt(0) : '';
    var body = raw.replace(/^[?>!]/, '');
    var parts = body === '' ? [] : body.split(';');
    function num(k, dft) { var v = Number(parts[k]); return isNaN(v) || v === 0 ? dft : v; }
    if (final === 'm') { this.sgr(parts); return; }
    if (final === 'h' || final === 'l') { // 模式设置：只认与本引擎相关的几个
      var on = final === 'h';
      for (var i = 0; i < parts.length; i++) {
        var mode = Number(parts[i]);
        if (priv !== '?') { if (mode === 7) this.wrap = on; continue; }
        if (mode === 25) this.cursor = on;
        else if (mode === 7) this.wrap = on;
        else if (mode === 1049 || mode === 1047 || mode === 47) { // 备用屏：vim/htop 的全屏画布
          if (on && !this.alt) {
            this.alt = { grid: this.grid, row: this.row, col: this.col, top: this.top, bottom: this.bottom };
            this.grid = []; for (var k = 0; k < this.rows; k++) this.grid.push(this.blank());
            this.row = 0; this.col = 0; this.top = 0; this.bottom = this.rows - 1;
          } else if (!on && this.alt) {
            this.grid = this.alt.grid; this.row = this.alt.row; this.col = this.alt.col;
            this.top = this.alt.top; this.bottom = this.alt.bottom; this.alt = null;
          }
        } else if (mode === 1048) { if (on) this.saveCursor(); else this.restoreCursor(); }
      }
      return;
    }
    if (final === 'J') {
      var jm = Number(parts[0] || 0);
      if (jm === 2 || jm === 3) { this.clear(jm === 3); return; }
      if (jm === 0) { // 清到屏幕末尾
        var cl = this.grid[this.row]; for (var x = this.col; x < this.cols; x++) cl[x] = null;
        for (var r2 = this.row + 1; r2 < this.rows; r2++) this.grid[r2] = this.blank();
        return;
      }
      for (var r3 = 0; r3 < this.row; r3++) this.grid[r3] = this.blank();
      var cl3 = this.grid[this.row]; for (var x3 = 0; x3 <= this.col && x3 < this.cols; x3++) cl3[x3] = null;
      return;
    }
    if (final === 'K') {
      var km = Number(parts[0] || 0), ln = this.grid[this.row], y;
      if (km === 2) { for (y = 0; y < this.cols; y++) ln[y] = null; }
      else if (km === 1) { for (y = 0; y <= this.col && y < this.cols; y++) ln[y] = null; }
      else { for (y = this.col; y < this.cols; y++) ln[y] = null; }
      return;
    }
    if (final === 'H' || final === 'f') { // 绝对定位（vim 的命门）
      this.row = Math.max(0, Math.min(this.rows - 1, num(0, 1) - 1));
      this.col = Math.max(0, Math.min(this.cols - 1, num(1, 1) - 1));
      this.wrapnext = false; return;
    }
    if (final === 'A') { this.row = Math.max(this.top, this.row - num(0, 1)); this.wrapnext = false; return; }
    if (final === 'B' || final === 'e') { this.row = Math.min(this.bottom, this.row + num(0, 1)); this.wrapnext = false; return; }
    if (final === 'C' || final === 'a') { this.col = Math.min(this.cols - 1, this.col + num(0, 1)); this.wrapnext = false; return; }
    if (final === 'D') { this.col = Math.max(0, this.col - num(0, 1)); this.wrapnext = false; return; }
    if (final === 'E') { this.row = Math.min(this.bottom, this.row + num(0, 1)); this.col = 0; return; }
    if (final === 'F') { this.row = Math.max(this.top, this.row - num(0, 1)); this.col = 0; return; }
    if (final === 'G' || final === '`') { this.col = Math.max(0, Math.min(this.cols - 1, num(0, 1) - 1)); return; }
    if (final === 'd') { this.row = Math.max(0, Math.min(this.rows - 1, num(0, 1) - 1)); return; }
    if (final === 'L') { this.insertLines(num(0, 1)); return; }
    if (final === 'M') { this.deleteLines(num(0, 1)); return; }
    if (final === 'P') { this.deleteChars(num(0, 1)); return; }
    if (final === '@') { this.insertChars(num(0, 1)); return; }
    if (final === 'S') { this.scrollUp(num(0, 1)); return; }
    if (final === 'T') { this.scrollDown(num(0, 1)); return; }
    if (final === 'X') {
      var lnx = this.grid[this.row], n2 = num(0, 1);
      for (var q = this.col; q < this.col + n2 && q < this.cols; q++) lnx[q] = null;
      return;
    }
    if (final === 'r') { // 滚动区域
      var t = Math.max(1, Math.min(this.rows, num(0, 1))), b2 = Math.max(1, Math.min(this.rows, num(1, this.rows)));
      if (b2 > t) { this.top = t - 1; this.bottom = b2 - 1; this.row = this.top; this.col = 0; }
      return;
    }
    if (final === 's') { this.saveCursor(); return; }
    if (final === 'u') { this.restoreCursor(); return; }
    // 其余（设备查询/窗口大小/鼠标模式/键盘模式）：忽略，不回包（不回包比回错包安全）
  };
  Term.prototype.insertLines = function (n) {
    for (var i = 0; i < n; i++) { if (this.row <= this.bottom) { this.grid.splice(this.bottom, 1); this.grid.splice(this.row, 0, this.blank()); } }
  };
  Term.prototype.deleteLines = function (n) {
    for (var i = 0; i < n; i++) { this.grid.splice(this.row, 1); this.grid.splice(this.bottom, 0, this.blank()); }
  };
  Term.prototype.insertChars = function (n) {
    var ln = this.grid[this.row];
    for (var i = 0; i < n; i++) { ln.splice(this.col, 0, null); ln.length = this.cols; }
  };
  Term.prototype.deleteChars = function (n) {
    var ln = this.grid[this.row];
    for (var i = 0; i < n; i++) { ln.splice(this.col, 1); ln.push(null); }
  };
  Term.prototype.saveCursor = function () { this.saved = { row: this.row, col: this.col, attr: { f: this.attr.f, b: this.attr.b, a: this.attr.a } }; };
  Term.prototype.restoreCursor = function () {
    if (!this.saved) return;
    this.row = Math.min(this.rows - 1, this.saved.row); this.col = Math.min(this.cols - 1, this.saved.col);
    this.attr = { f: this.saved.attr.f, b: this.saved.attr.b, a: this.saved.attr.a };
  };
  Term.prototype.control = function (c, ch) {
    if (c === 0x0d) { this.col = 0; this.wrapnext = false; return; }  // CR：回行首
    if (c === 0x0a || c === 0x0b || c === 0x0c) { this.lineFeed(); if (c === 0x0c) this.col = 0; return; }
    if (c === 0x08) { if (this.col > 0) this.col--; this.wrapnext = false; return; } // BS：退格（覆盖由后续 put 完成）
    if (c === 0x09) { var n = 8 - (this.col % 8); while (n-- > 0) this.put(' '); return; }
    if (c < 0x20 || c === 0x7f) return; // 其余控制符 / BEL：忽略
    this.put(ch);
  };
  Term.prototype.ch = function (ch) {
    var c = ch.charCodeAt(0);
    switch (this.state) {
      case 0:
        if (c === 0x1b) { this.state = 1; return; }
        this.control(c, ch); return;
      case 1: // ESC 后一字节
        if (ch === '[') { this.state = 2; this.buf = ''; return; }
        if (ch === ']') { this.state = 3; return; }
        if (ch === '7') { this.state = 0; this.saveCursor(); return; }
        if (ch === '8') { this.state = 0; this.restoreCursor(); return; }
        if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#' || ch === '%') { this.state = 5; return; }
        this.state = 0; return; // 其余单字节 ESC 序列（= > M E D c）：忽略
      case 2: // CSI
        if (c >= 0x40 && c <= 0x7e) { var p = this.buf; this.state = 0; this.csi(p, ch); } else this.buf += ch;
        return;
      case 3: // OSC（标题/超链接）：吃到 BEL 或 ST 为止
        if (c === 0x07) this.state = 0; else if (c === 0x1b) this.state = 4;
        return;
      case 4: this.state = ch === '\\' ? 0 : 3; return;
      default: this.state = 0; return; // ESC ( B 这类字符集选择：吞掉参数字节
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
  Term.prototype.resize = function (cols, rows) { // 只改网格尺寸，历史保留（不重排，避免折行错位）
    cols = Math.max(20, cols | 0); rows = Math.max(6, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    for (var i = 0; i < this.grid.length; i++) {
      var ln = this.grid[i];
      if (cols > ln.length) { while (ln.length < cols) ln.push(null); }
      else ln.length = cols;
    }
    while (this.grid.length < rows) this.grid.push(this.blank());
    while (this.grid.length > rows) this.grid.shift();
    this.cols = cols; this.rows = rows;
    this.top = 0; this.bottom = rows - 1;
    this.row = Math.min(this.row, rows - 1); this.col = Math.min(this.col, cols - 1);
    this.pn = []; this.ps = []; // 尺寸变了：整屏重排更省心
  };

  /* ===== 视图 ===== */
  function render(container) {
    if (!container) return null;
    // 字号是全局设置（所有标签共享），存 localStorage 跨刷新保留
    var FONT_KEY = 'kore.terminal.fontSize';
    function loadFont() { try { var v = Number(localStorage.getItem(FONT_KEY)); return v >= 11 && v <= 20 ? v : 13; } catch (e) { return 13; } }
    var FONT = loadFont();
    var tabSeq = 0, tabs = [], active = null, tabbar = null, busy = false;
    var S = null, term = null, decoder = new TextDecoder('utf-8'), destroyed = false, ro = null, debounce = 0,
      stage, screen, input, status, foot, retry, sessHost, histHost;
    // ===== 多标签：每个 tab 持有独立会话/屏幕；别名 S/term/screen/decoder 始终指向 active =====
    function attachActive(T) { active = T; S = T.S; term = T.term; screen = T.screen; decoder = T.decoder; }
    function updateTabs() {
      if (!tabbar) return;
      tabbar.textContent = '';
      tabs.forEach(function (T) {
        var b = el('button', 'term-tab' + (T === active ? ' is-active' : ''),
          '终端 ' + T.no + (T.S.session ? (T.S.eof ? ' · 已结束' : '') : ' · 未连接'));
        b.type = 'button'; b.title = T === active ? '当前标签' : '切换到这个终端标签';
        b.addEventListener('click', function () { switchTab(T); });
        var x = el('button', 'term-tab-x', '×');
        x.type = 'button'; x.title = '关闭这个标签（结束会话）';
        x.addEventListener('click', function (ev) { ev.stopPropagation(); closeTab(T); });
        b.appendChild(x); tabbar.appendChild(b);
      });
      var add = el('button', 'term-tab-add', '+');
      add.type = 'button'; add.title = '新建终端标签（新会话）';
      add.addEventListener('click', addTab); tabbar.appendChild(add);
    }
    function switchTab(T) {
      if (destroyed || T === active || busy) return;
      if (active) { active.draft = input.value; active.scrollTop = stage.scrollTop; stopPoll(active); } // 停旧标签轮询，存草稿/滚动
      // screen 每 tab 独立，摘挂即可；不需要 term.paint（Term.pn 缓存的 DOM 节点跟着 screen 走）
      if (active && active.screen.parentNode === stage) stage.removeChild(active.screen);
      attachActive(T);
      stage.insertBefore(T.screen, input);
      input.value = T.draft || ''; stage.scrollTop = T.scrollTop || 0;
      updateTabs(); setFoot();
      if (T.S.session && !T.S.eof) { setStatus(T.S.reconnecting ? '正在重连…' : '已恢复标签 ' + T.no, 'ok'); startPoll(T); }
      else { stopPoll(T); setStatus(T.S.session ? '会话已结束' : '未连接，点「新建会话」开始', T.S.session ? 'fail' : undefined); }
      if (input.focus) input.focus();
    }
    function addTab() {
      if (destroyed || busy) return;
      var T = makeTab(); tabs.push(T);
      switchTabForce(T); // 先切到新标签（会摘掉旧 screen）
      connect(T); // 再为它创建会话（connect 内部锁定 busy）
    }
    function switchTabForce(T) { // 与 switchTab 同逻辑但不受 busy 限制（busy 由 connect 设置）
      if (active) { active.draft = input.value; active.scrollTop = stage.scrollTop; stopPoll(active); }
      if (active && active.screen.parentNode === stage) stage.removeChild(active.screen);
      attachActive(T); stage.insertBefore(T.screen, input); // attachActive 已刷新 term/decoder 别名
      input.value = ''; stage.scrollTop = 0;
      updateTabs(); setFoot(); setStatus('新标签已就绪');
    }
    function closeTab(T) {
      if (destroyed || !T) return;
      var id = T.S.session;
      stopPoll(T);
      if (id) invoke('terminal.close', { params: { session_id: id }, keepalive: true }).catch(function () {});
      var i = tabs.indexOf(T); if (i >= 0) tabs.splice(i, 1);
      if (!tabs.length) { addTab(); return; } // 至少保留一个标签（addTab 会请求新会话）
      if (T === active) {
        var next = tabs[Math.min(i, tabs.length - 1)];
        switchTabForce(next);
        if (next.S.session && !next.S.eof) { startPoll(next); setStatus('已切到标签 ' + next.no, 'ok'); }
      } else updateTabs();
    }
    function makeTab() {
      var s = { fs: FONT, session: '', shell: '', pid: 0, cols: 80, rows: 24, poll: 0, reading: false,
        connecting: false, eof: false, idleAt: '', maxSessions: 0, cursor: 0, reconnecting: false,
        sessions: null, histOpen: false, histData: null, histLoading: false, histError: '',
        histMsg: '', clearArmed: false, histLines: null, histQuery: '', histCursor: -1, draftInput: '' };
      // screen 每 tab 独立：Term.pn 缓存的是 screen 内的 DOM 节点引用，共享 screen 会让增量重绘串台
      var sc = el('pre', 'term-screen');
      sc.setAttribute('aria-live', 'polite'); sc.setAttribute('aria-label', '终端输出');
      sc.style.fontSize = FONT + 'px'; sc.style.lineHeight = Math.round(FONT * 1.5) + 'px';
      return { no: ++tabSeq, S: s, term: null, decoder: new TextDecoder('utf-8'), screen: sc, scrollTop: 0 };
    }
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
    var btnFontDown = el('button', 'btn term-fbtn', 'A−');
    var btnFontUp = el('button', 'btn term-fbtn', 'A+');
    var btnCopy = el('button', 'btn term-copy', '复制');
    var btnFull = el('button', 'btn term-full', '全屏');
    retry = el('button', 'btn term-retry', '重连');
    retry.hidden = true;
    btnNew.type = 'button'; btnClose.type = 'button'; retry.type = 'button'; btnHist.type = 'button';
    btnFontDown.type = 'button'; btnFontUp.type = 'button'; btnCopy.type = 'button'; btnFull.type = 'button';
    btnFontDown.title = '缩小字号'; btnFontUp.title = '放大字号';
    btnCopy.title = '复制选中的文字；没有选中就复制整屏（含回看缓冲）';
    btnFull.title = '全屏显示终端（Esc 退出）';
    ops.appendChild(btnNew); ops.appendChild(btnClose); ops.appendChild(btnHist);
    ops.appendChild(btnFontDown); ops.appendChild(btnFontUp); ops.appendChild(btnCopy); ops.appendChild(btnFull);
    ops.appendChild(retry);
    bar.appendChild(ops); root.appendChild(bar);
    tabbar = el('div', 'term-tabs'); root.appendChild(tabbar);
    sessHost = el('div', 'term-sess-host'); sessHost.hidden = true; root.appendChild(sessHost);
    histHost = el('div', 'term-hist-host'); histHost.hidden = true; root.appendChild(histHost);
    stage = el('div', 'term-stage');
    input = el('textarea', 'term-input');
    input.setAttribute('autocomplete', 'off'); input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false'); input.setAttribute('aria-label', '终端输入');
    // screen 由每个 tab 独立提供，激活时插到 input 前；input 常驻单例
    stage.appendChild(input); root.appendChild(stage);
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
    function measure() { // 等宽字宽≈0.6×字号、行高=1.5×字号：字号可调后列/行必须跟着变，否则折行错位
      var w = stage.clientWidth || 640, h = stage.clientHeight || 360;
      var cw = Math.max(6, Math.round(FONT * 0.6)), lh = Math.round(FONT * 1.5);
      return { cols: Math.max(20, Math.min(300, Math.floor(w / cw))), rows: Math.max(6, Math.min(120, Math.floor(h / lh))) };
    }
    function atBottom() { return stage.scrollHeight - stage.scrollTop - stage.clientHeight < 24; }
    // 只让活跃标签轮询（G-03 资源纪律：避免 N 个 80ms 定时器并发）。
    // 切走即停、切回即续：read 从游标增量读，服务端 replay 窗口保住离开期间的输出，不丢数据。
    function stopPoll(T) { T = T || active; if (T && T.S.poll) { clearInterval(T.S.poll); T.S.poll = 0; } }
    function stopAllPoll() { tabs.forEach(function (T) { stopPoll(T); }); }
    function startPoll(T) {
      T = T || active; stopPoll(T);
      T.S.poll = setInterval(function () { tick(T); }, POLL_MS);
    }
    function tick(T) {
      var s = T.S;
      if (s.reading || !s.session || destroyed) return;
      s.reading = true;
      invoke('terminal.read', { params: { session_id: s.session, max_bytes: 262144 } }).then(function (r) {
        s.reading = false;
        if (destroyed) return;
        if (typeof r.cursor === 'number') s.cursor = r.cursor;
        if (r.data) {
          var text = T.decoder.decode(b64dec(r.data), { stream: true }); // 流式解码：容忍截断的多字节
          if (text) {
            T.term.feed(text); T.term.paint(T.screen);
            if (active === T && atBottom()) stage.scrollTop = stage.scrollHeight; // 仅前台自动跟底
          }
        }
        if (r.eof) {
          stopPoll(T); s.eof = true; updateTabs();
          if (active === T) { setStatus('会话已退出（可新建会话）', 'fail'); setFoot(); }
        }
      }, function (err) {
        s.reading = false;
        if (!destroyed) reconnect(T, err); // 断线不销毁会话：带 cursor 走 attach 恢复
      });
    }
    // 断线重连状态机：读取失败 → 正在重连… → attach(cursor) → replay 补输出 → 已恢复（补了 N 行）；
    // 会话已被回收/游标超出窗口 → 会话已过期，请新建（不再自动建，避免用户丢上下文）。
    function countLines(text) { var n = 0; for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n || 1; }
    function expireSession(T) {
      T = T || active; stopPoll(T); T.S.session = ''; T.S.cursor = 0; T.S.eof = false;
      if (active === T) { retry.hidden = true; setStatus('会话已过期，请新建', 'fail'); setFoot(); }
      updateTabs();
    }
    function reconnect(T, err) {
      T = T || active; var s = T.S;
      if (destroyed || !s.session || s.reconnecting) return;
      stopPoll(T);
      if (err && err.code === 'E_NOTFOUND') { expireSession(T); return; } // 已被空闲回收
      s.reconnecting = true; if (active === T) { retry.hidden = true; setStatus('正在重连…'); }
      var from = s.cursor;
      invoke('terminal.attach', { params: { session_id: s.session, cursor: from } }).then(function (a) {
        s.reconnecting = false;
        if (destroyed || s.session !== a.session_id) return;
        s.eof = !!a.eof; s.idleAt = a.idle_expires_at || '';
        var replay = (typeof a.cursor === 'number' && a.cursor > from)
          ? invoke('terminal.read', { params: { session_id: s.session, cursor: from, max_bytes: 1048576 } })
          : Promise.resolve(null);
        replay.then(function (r) {
          if (destroyed || s.session !== a.session_id) return;
          var added = 0;
          if (r && r.data) {
            var text = T.decoder.decode(b64dec(r.data));
            if (text) { added = countLines(text); T.term.feed(text); T.term.paint(T.screen); if (active === T) stage.scrollTop = stage.scrollHeight; }
            if (typeof r.cursor === 'number') s.cursor = r.cursor;
          }
          if (active === T) { setStatus(added > 0 ? '已恢复（补了 ' + added + ' 行）' : '已恢复', 'ok'); setFoot(); }
          if (!s.eof) startPoll(T);
        }, function () {
          if (active === T) setStatus('已恢复（补读失败，后续输出仍会继续）', 'ok');
          if (!s.eof) startPoll(T);
        });
      }, function (aerr) {
        s.reconnecting = false;
        if (destroyed) return;
        if (aerr.code === 'E_NOTFOUND' || aerr.code === 'E_CONFLICT' || aerr.code === 'E_UNAUTHORIZED') { expireSession(T); return; }
        if (active === T) { setStatus('重连失败：' + aerr.message + '（可点「重连」再试）', 'fail'); retry.hidden = false; }
      });
    }
    function closeSession() { closeTab(active); } // 关闭当前标签（见下方多标签实现）
    function connect(T) {
      T = T || active; var s = T.S;
      if (destroyed || s.connecting) return;
      s.connecting = true; busy = true; if (active === T) { retry.hidden = true; setStatus('正在创建会话…'); }
      var geo = measure();
      invoke('terminal.create', { params: { cols: geo.cols, rows: geo.rows } }).then(function (r) {
        s.connecting = false; busy = false;
        if (destroyed) { invoke('terminal.close', { params: { session_id: r.session_id } }).catch(function () {}); return; }
        s.session = r.session_id; s.shell = r.shell; s.pid = r.pid; s.cols = r.cols; s.rows = r.rows;
        s.eof = false; s.idleAt = ''; if (active === T) hideSess();
        T.decoder = new TextDecoder('utf-8'); T.term = new Term(r.cols, r.rows); // 每标签独立解码/屏幕状态
        T.screen.textContent = ''; if (active === T) attachActive(T); // 刷新全局别名（新 term 生效）
        updateTabs();
        if (active === T) { setStatus('已连接', 'ok'); setFoot(); startPoll(T); if (input.focus) input.focus(); }
        // 非活跃标签不轮询：切回时 switchTab 会 startPoll 从游标续读
      }, function (err) {
        s.connecting = false; busy = false;
        if (active === T) {
          retry.hidden = false;
          // 会话数上限（默认 4）：给出可操作出路，而不是甩一个错误码。
          setStatus(err.code === 'E_RATELIMIT'
            ? '会话数已达上限（最多 ' + (S.maxSessions || 4) + ' 个）：先关闭一个已有标签或会话'
            : '创建会话失败：' + err.message, 'fail');
        }
      });
    }
    function newSession() { addTab(); } // 「新建会话」= 开一个新标签（原单会话语义保留为标签 1）
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
        if (live.length === 1 && all.length === 1) { restoreSession(live[0]); return; } // 唯一存活会话 → 首个标签静默恢复
        if (live.length >= 1) { showSess(all); setStatus('发现可恢复的会话', 'ok'); return; } // 多会话 → 保持原选择条语义
        connect(active);
      }, function () { if (!destroyed) connect(active); }); // 探活失败不砖化视图：退回新建
    }
    function closeOne(id) {
      // 若这个会话正被某标签占用（边界：恢复列表与已开标签重叠），先清掉该标签的会话状态
      tabs.forEach(function (T) {
        if (T.S.session === id) { stopPoll(T); T.S.session = ''; T.S.eof = false; T.term = null; T.screen.textContent = '';
          if (active === T) { attachActive(T); setStatus('当前标签的会话已关闭', 'fail'); setFoot(); } }
      });
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
    function restoreSession(info, T) {
      T = T || active; var s = T.S;
      if (destroyed || s.connecting) return;
      s.connecting = true; busy = true; if (active === T) { retry.hidden = true; setStatus('正在恢复会话…'); }
      invoke('terminal.attach', { params: { session_id: info.session_id } }).then(function (a) {
        s.connecting = false; busy = false;
        if (destroyed) return;
        s.session = a.session_id; s.shell = a.shell; s.pid = a.pid;
        s.cols = a.cols; s.rows = a.rows; s.eof = !!a.eof; s.idleAt = a.idle_expires_at || '';
        s.cursor = typeof a.cursor === 'number' ? a.cursor : 0;
        T.decoder = new TextDecoder('utf-8'); T.term = new Term(a.cols, a.rows);
        T.screen.textContent = ''; if (active === T) { hideSess(); attachActive(T); }
        updateTabs();
        if (active === T) { setStatus(a.eof ? '会话已结束' : '已恢复会话', a.eof ? 'fail' : 'ok'); setFoot(); }
        // 回放 [cursor-replay_bytes, cursor) 重建刷新前的屏幕；max 放宽到 1MiB 顺带吃掉
        // attach 与 read 之间新到的输出（读游标小于当前偏移时走服务端补读窗口，不重复不遗漏）。
        var from = Math.max(0, a.cursor - a.replay_bytes);
        var p = a.replay_bytes > 0
          ? invoke('terminal.read', { params: { session_id: a.session_id, cursor: from, max_bytes: 1048576 } })
          : Promise.resolve(null);
        p.then(function (r) {
          if (destroyed || s.session !== a.session_id) return;
          if (r && r.data) {
            var text = T.decoder.decode(b64dec(r.data));
            if (text) { T.term.feed(text); T.term.paint(T.screen); if (active === T) stage.scrollTop = stage.scrollHeight; }
            if (typeof r.cursor === 'number') s.cursor = r.cursor;
          }
          if (active === T && s.eof) setStatus('会话已结束', 'fail');
          if (!s.eof) startPoll(T);
          else stopPoll(T);
          if (active === T && input.focus) input.focus();
        }, function () {
          if (destroyed) return;
          if (!s.eof) startPoll(T); // 回放失败不拆会话：直接进入增量读，旧屏幕内容缺失但可用
        });
      }, function (err) {
        s.connecting = false; busy = false;
        if (active === T) { retry.hidden = false;
          // 会话可能已被空闲回收 / 归属不符：说明原因并自动新建，不让用户卡住。
          setStatus('恢复会话失败（' + err.message + '），已为你新建会话', 'fail');
        }
        connect(T);
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
    // 历史里的原始命令（保留多行，去掉行尾换行），用于「填入输入框」与方向键检索。
    function histCommand(b64) {
      try {
        var raw = new TextDecoder('utf-8').decode(b64dec(b64));
        return raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      } catch (e) { return ''; }
    }
    function fillHistory(cmd) {
      if (!cmd) return;
      input.value = cmd; S.histCursor = -1;
      if (input.focus) input.focus();
      var end = input.value.length; if (input.setSelectionRange) input.setSelectionRange(end, end);
      setStatus('已填入输入框（按 Enter 才会执行）', 'ok');
    }
    // 首次按上/下键时拉一次历史并缓存；插件侧 history 只读，不落任何本地存储。
    function ensureHistLines(done) {
      if (S.histLines) { done(); return; }
      invoke('terminal.history', { params: { limit: 100 } }).then(function (r) {
        S.histLines = (r.entries || []).map(function (e) { return histCommand(e.data); }).filter(function (v) { return v; });
        done();
      }, function () { done(); });
    }
    function stepHistory(dir) {
      ensureHistLines(function () {
        var lines = S.histLines || [];
        if (!lines.length) return;
        if (S.histCursor < 0) S.draftInput = input.value;
        var next;
        if (dir < 0) next = Math.min(lines.length - 1, S.histCursor + 1);
        else next = S.histCursor - 1;
        if (next < -1) next = -1;
        S.histCursor = next;
        input.value = next < 0 ? (S.draftInput || '') : lines[next];
        var end = input.value.length; if (input.setSelectionRange) input.setSelectionRange(end, end);
      });
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
        S.histLoading = false; S.histData = r;
        S.histLines = (r.entries || []).map(function (e) { return histCommand(e.data); }).filter(function (v) { return v; });
        S.histCursor = -1; renderHist();
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
      var search = el('input', 'term-hist-search');
      search.type = 'search'; search.placeholder = '搜索历史命令（输入即筛选）';
      search.value = S.histQuery; search.setAttribute('aria-label', '搜索历史命令');
      search.addEventListener('input', function () {
        S.histQuery = search.value; renderHist();
        var again = histHost.querySelector('.term-hist-search');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
      box.appendChild(search);
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
      var query = (S.histQuery || '').toLowerCase();
      var shown = entries.slice().reverse().filter(function (e) {
        return !query || histText(e.data).toLowerCase().indexOf(query) >= 0;
      });
      if (!shown.length) {
        box.appendChild(el('div', 'muted', '没有匹配的历史命令：换个关键词，或点「清空历史」重置。'));
        histHost.appendChild(box); return;
      }
      shown.forEach(function (e) {
        var row = el('div', 'term-hist-item');
        row.appendChild(el('span', 'term-hist-at', fmtClock(e.at)));
        row.appendChild(el('span', 'term-hist-text', histText(e.data) +
          (e.truncated ? '（太长已截断）' : '')));
        var rowOps = el('span', 'term-hist-ops');
        var fill = el('button', 'btn btn-ghost', '填入');
        fill.type = 'button'; fill.title = '只填入输入框，不会自动执行';
        fill.addEventListener('click', function () { fillHistory(histCommand(e.data)); });
        rowOps.appendChild(fill); row.appendChild(rowOps);
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
    // xterm 传统 F1–F12 序列（F1–F4 走 SS3，F5 起走 CSI 15~…24~）：htop/mc/vim 的快捷键都依赖它们
    var FN = {
      F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
      F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
      F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~'
    };
    // Ctrl+方向 / Ctrl+Home|End：按词跳与行首行尾（readline 默认绑定）
    var CTRL_MOD = {
      ArrowLeft: '\x1b[1;5D', ArrowRight: '\x1b[1;5C', ArrowUp: '\x1b[1;5A', ArrowDown: '\x1b[1;5B',
      Home: '\x1b[1;5H', End: '\x1b[1;5F'
    };
    function send(text) {
      if (!S.session || !term) return;
      var payload = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
      invoke('terminal.write', { params: { session_id: S.session, data: b64enc(new TextEncoder().encode(payload)) } })
        .catch(function (err) { if (err.code === 'E_NOTFOUND') expireSession(); else setStatus('发送失败：' + err.message, 'fail'); });
    }
    function onKey(ev) {
      if (ev.isComposing) return;
      // ↑/↓ 检索输入历史：仅在光标贴边且单行输入时拦截，避免抢走 shell 的方向键。
      // 只在「历史已加载且非空」且输入框是单行、光标贴边时拦截；否则交给 shell——
      // 历史为空/未加载时吞掉 ↑↓ 会让 vim、less 里按上键毫无反应（实测踩到）。
      if (!ev.ctrlKey && !ev.altKey && !ev.metaKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') &&
          input.value.indexOf('\n') < 0 && S.histLines && S.histLines.length) {
        var atStart = input.selectionStart === 0 && input.selectionEnd === 0;
        var atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        if ((ev.key === 'ArrowUp' && atStart) || (ev.key === 'ArrowDown' && atEnd)) {
          ev.preventDefault(); stepHistory(ev.key === 'ArrowUp' ? -1 : 1); return;
        }
      }
      if (!S.histLines && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) ensureHistLines(function () {});
      var bytes = null;
      if (ev.shiftKey && ev.key === 'Tab') bytes = '\x1b[Z';                       // 反向补全
      else if (FN[ev.key]) bytes = FN[ev.key];                                      // F1–F12
      else if (ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key.length === 1) bytes = '\x1b' + ev.key; // Alt+b/f 按词跳
      else if (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key === ' ') bytes = '\x00';              // Ctrl+Space
      else if (ev.ctrlKey && !ev.altKey && !ev.metaKey && CTRL_MOD[ev.key]) bytes = CTRL_MOD[ev.key];
      else if (ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey && /^[a-z]$/i.test(ev.key)) {
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
    function onVisualViewport() { // 软键盘弹起：容器高度跟随可视视口，输出滚到底，键盘不再挤坏布局
      var vv = window.visualViewport;
      if (!vv) return;
      document.documentElement.style.setProperty('--kore-vv-h', Math.round(vv.height) + 'px');
      if (vv.height + 100 < window.innerHeight) { stage.scrollTop = stage.scrollHeight; scheduleResize(); }
    }
    function onPageHide() {
      // 刷新/关标签不再关闭会话：会话留给下一次 terminal.list 自动发现并恢复；
      // 服务端按最近活动时间（默认 30 分钟）自动回收，不会无限堆积。
      stopAllPoll();
    }
    function scheduleResize() { // 容器变化防抖 300ms → terminal.resize（作用于当前活跃标签）
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function () {
        debounce = 0;
        var T = active, s = T.S;
        if (destroyed || !s.session || !T.term) return;
        var geo = measure();
        if (geo.cols === s.cols && geo.rows === s.rows) return;
        s.cols = geo.cols; s.rows = geo.rows;
        if (T.term.resize) T.term.resize(geo.cols, geo.rows); else { T.term.cols = geo.cols; T.term.rows = geo.rows; }
        invoke('terminal.resize', { params: { session_id: s.session, cols: geo.cols, rows: geo.rows } })
          .then(function (r) { s.cols = r.cols; s.rows = r.rows; if (active === T) setFoot(); })
          .catch(function () { /* resize 失败不拆会话，下一次变化再试 */ });
      }, 300);
    }
    function applyFont(delta) {
      FONT = Math.max(11, Math.min(20, FONT + delta));
      try { localStorage.setItem(FONT_KEY, String(FONT)); } catch (e) { /* 隐私模式禁用存储：本次会话仍生效 */ }
      // 字号是全局设置：所有已开标签一起变（每个 tab 有独立 screen）
      tabs.forEach(function (t) {
        t.screen.style.fontSize = FONT + 'px';
        t.screen.style.lineHeight = Math.round(FONT * 1.5) + 'px';
        t.S.fs = FONT;
      });
      setStatus('字号 ' + FONT + 'px', 'ok');
      scheduleResize();
    }
    function copyOut() {
      var sel = window.getSelection ? String(window.getSelection()) : '';
      var text = sel.replace(/\s+$/, '') ? sel : (term ? term.text() : '');
      if (!text) { setStatus('没有可复制的输出', 'fail'); return; }
      function ok() { setStatus('已复制 ' + text.length + ' 字符', 'ok'); }
      function fallback() { // 非安全上下文（http + 非 localhost）没有 clipboard API
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var done = false;
        try { done = document.execCommand('copy'); } catch (e) { done = false; }
        document.body.removeChild(ta);
        if (done) ok(); else setStatus('复制被浏览器拒绝：请手动选中后 Ctrl+C', 'fail');
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
      else fallback();
    }
    function toggleFull() {
      if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); return; }
      if (root.requestFullscreen) root.requestFullscreen().catch(function () { setStatus('当前浏览器不允许全屏', 'fail'); });
      else setStatus('当前浏览器不支持全屏', 'fail');
    }
    function onFsChange() { if (document.fullscreenElement) scheduleResize(); }
    btnNew.addEventListener('click', newSession); btnClose.addEventListener('click', closeSession);
    btnHist.addEventListener('click', toggleHist);
    btnFontDown.addEventListener('click', function () { applyFont(-1); });
    btnFontUp.addEventListener('click', function () { applyFont(1); });
    btnCopy.addEventListener('click', copyOut);
    btnFull.addEventListener('click', toggleFull);
    document.addEventListener('fullscreenchange', onFsChange);
    retry.addEventListener('click', function () { if (S.session) reconnect(active); else connect(active); });
    function focusInput() { // 有文字选区时不清选区——鼠标复制是终端的第一诉求
      var sel = window.getSelection ? String(window.getSelection()) : '';
      if (sel) return;
      if (input.focus) input.focus();
    }
    // 事件委托到 stage：screen 每标签独立且会摘挂，监听 stage 才能覆盖所有标签（点击冒泡上来）
    stage.addEventListener('click', focusInput);
    input.addEventListener('keydown', onKey); input.addEventListener('input', onInput);
    input.addEventListener('paste', function (ev) {
      var clip = ev.clipboardData ? ev.clipboardData.getData('text') : '';
      if (!clip) return;
      var lines = clip.split('\n').length;
      if (clip.length > 2000 || lines > 30) {
        if (!window.confirm('内容较大（' + clip.length + ' 字符 / ' + lines + ' 行），确认粘贴到终端？')) ev.preventDefault();
      }
    });
    document.addEventListener('visibilitychange', function () { // 后台停轮询，回前台恢复
      if (document.hidden) stopAllPoll();
      else if (active && active.S.session && !active.S.eof && !active.S.poll && !destroyed) startPoll(active);
    });
    window.addEventListener('pagehide', onPageHide);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onVisualViewport);
    if (window.ResizeObserver) { ro = new ResizeObserver(scheduleResize); ro.observe(stage); }
    ensureCss();
    // 首个标签：挂载 screen 到 stage（input 之前）；字号从 localStorage 恢复
    var first = makeTab(); tabs.push(first); attachActive(first); stage.insertBefore(screen, input);
    tabs.forEach(function (t) {
      t.screen.style.fontSize = FONT + 'px';
      t.screen.style.lineHeight = Math.round(FONT * 1.5) + 'px';
    });
    updateTabs(); setFoot();
    boot(); // 先 terminal.list 探活，再决定 恢复 / 选择 / 新建
    return {
      destroy: function () { // 切视图：停轮询 + 断观察，**不关会话**（下次进入自动恢复；空闲由服务端回收）
        destroyed = true; stopAllPoll();
        if (debounce) clearTimeout(debounce);
        if (ro) ro.disconnect();
        if (window.visualViewport) window.visualViewport.removeEventListener('resize', onVisualViewport);
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('fullscreenchange', onFsChange);
        document.documentElement.style.removeProperty('--kore-vv-h');
        input.blur();
      }
    };
  }
  window.KoreTerminal = { render: render };
})();
