/* kore 主壳 · 磁盘分析视图（web/disk-analysis.js，R23 纯增量，懒加载子视图）
   解决用户问题：monitor 只会采磁盘总量，用户看不到"哪个目录在吃盘、能清什么"。
   本页只读扫描配置白名单目录（category 枚举，前端不传路径），给三块：
     ① 目录占用列表 + SVG 占比环（G-32：≤12 节点 / 每点带单位 / hover+tap 可读 / dispose）
     ② 大文件 TopN（路径 / 大小 / 修改时间）
     ③ 可清理建议（只给跳转，绝不真删）
   纪律：零框架 / 零 CDN / 零定时器轮询（G-19）；扫描需用户确认 + 进度态 + 请求级超时；
   空态与失败态给人话；手机适配；CSS 内联注入，不进首屏预算（FRONTEND §7/§13）。
   契约：window.KoreDiskAnalysis.render(container) → { destroy }。 */
(function () {
  'use strict';

  var API = '/api/v1/system/disk-usage';
  var STYLE_ID = 'kore-disk-analysis-style';

  // category 枚举与后端 diskCategoryValid 一一对应：前端只传这些值，绝不传路径。
  var CATEGORIES = [
    { key: 'system', label: '系统分区' },
    { key: 'logs', label: '日志' },
    { key: 'backups', label: '备份' },
    { key: 'plugins', label: '插件数据' },
    { key: 'sites', label: '站点目录' },
    { key: 'temp', label: '临时文件' }
  ];
  // 每个类别的清理跳转目标（与后端 advice.route 对齐；兜底用）
  var ROUTE_LABEL = { logs: '日志页', backup: '备份页', files: '文件管理' };

  var PALETTE = ['#4f8cff', '#36c6a0', '#f5a623', '#e5678a', '#8b7cf6',
    '#43b0d8', '#d98c3f', '#6bb661', '#c86fd1', '#8892a8', '#c9a227', '#5e6c84'];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, ev, fn) { node.addEventListener(ev, fn); }
  function tr(key, fallback) {
    try {
      if (window.koreI18n && typeof window.koreI18n.t === 'function') {
        var v = window.koreI18n.t(key);
        if (v && v !== key) return v;
      }
    } catch (e) { /* 兜底中文 */ }
    return fallback;
  }
  function fmtSize(n) {
    if (n === undefined || n === null || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    var u = ['KiB', 'MiB', 'GiB', 'TiB'], i = -1, v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + u[i];
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function plainError(err, fallback) {
    var msg = err && (err.message || err.detail || (typeof err === 'string' ? err : ''));
    return msg ? String(msg).slice(0, 120) : fallback;
  }
  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function navigate(route) {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      window.KoreShell.navigate(route);
    } else {
      window.location.hash = '#/' + route;
    }
  }

  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '.kore-da{font-size:var(--kore-font-14,14px);color:var(--kore-text-1,#e6e9ef)}' +
      '.kore-da-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}' +
      '.kore-da-title{font-size:var(--kore-font-18,18px);font-weight:600;flex:1;min-width:140px}' +
      '.kore-da-sub{font-size:12px;color:var(--kore-text-3,#8a94a6);font-weight:400;margin-left:8px}' +
      '.kore-da-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}' +
      '.kore-da-tab{min-height:36px;padding:7px 14px;border-radius:8px;cursor:pointer;' +
      'background:var(--kore-bg-2,#1c2230);border:1px solid var(--kore-border-1,#2c3444);' +
      'color:var(--kore-text-2,#b8c0cf);font-size:13px}' +
      '.kore-da-tab.is-active{background:var(--kore-info,#4f8cff);color:#fff;border-color:transparent}' +
      '.kore-da-run{min-height:40px;padding:9px 18px;border:0;border-radius:8px;cursor:pointer;' +
      'background:var(--kore-info,#4f8cff);color:#fff;font-size:14px;font-weight:600}' +
      '.kore-da-run:disabled{opacity:.5;cursor:not-allowed}' +
      '.kore-da-banner{padding:12px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;line-height:1.6;' +
      'background:var(--kore-bg-2,#1c2230);border:1px solid var(--kore-border-1,#2c3444)}' +
      '.kore-da-banner.is-err{border-color:var(--kore-danger,#e5678a);color:var(--kore-danger,#e5678a)}' +
      '.kore-da-banner.is-hint{border-color:var(--kore-warning,#f5a623);color:var(--kore-text-2,#b8c0cf)}' +
      '.kore-da-grid{display:grid;grid-template-columns:320px 1fr;gap:16px;align-items:start}' +
      '.kore-da-card{background:var(--kore-bg-2,#1c2230);border:1px solid var(--kore-border-1,#2c3444);' +
      'border-radius:10px;padding:16px}' +
      '.kore-da-card h3{margin:0 0 12px;font-size:14px;font-weight:600;color:var(--kore-text-1,#e6e9ef)}' +
      '.kore-da-ring-wrap{display:flex;flex-direction:column;align-items:center;gap:12px}' +
      '.kore-da-ring{width:240px;height:240px;max-width:100%;overflow:visible}' +
      '.kore-da-ring path{cursor:pointer;transition:opacity .12s}' +
      '.kore-da-ring path:hover,.kore-da-ring path.is-active{opacity:.82}' +
      '.kore-da-legend{list-style:none;margin:0;padding:0;width:100%}' +
      '.kore-da-legend li{display:flex;align-items:center;gap:8px;padding:6px 4px;' +
      'border-bottom:1px solid var(--kore-border-1,#2c3444);font-size:12px}' +
      '.kore-da-legend li:last-child{border-bottom:0}' +
      '.kore-da-dot{width:10px;height:10px;border-radius:50%;flex:none}' +
      '.kore-da-lg-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.kore-da-lg-val{font-variant-numeric:tabular-nums;color:var(--kore-text-2,#b8c0cf)}' +
      '.kore-da-section{margin-top:16px}' +
      '.kore-da-row{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;' +
      'padding:9px 4px;border-bottom:1px solid var(--kore-border-1,#2c3444);font-size:13px}' +
      '.kore-da-row:last-child{border-bottom:0}' +
      '.kore-da-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.kore-da-path{font-size:11px;color:var(--kore-text-3,#8a94a6);overflow-wrap:anywhere}' +
      '.kore-da-size{font-variant-numeric:tabular-nums;font-weight:600;color:var(--kore-warning,#f5a623)}' +
      '.kore-da-time{font-size:11px;color:var(--kore-text-3,#8a94a6);font-variant-numeric:tabular-nums}' +
      '.kore-da-advice{display:flex;gap:12px;align-items:flex-start;padding:12px;margin-bottom:10px;' +
      'border-radius:8px;background:var(--kore-bg-1,#141a24);border:1px solid var(--kore-border-1,#2c3444)}' +
      '.kore-da-advice-main{flex:1;min-width:0}' +
      '.kore-da-advice-title{font-weight:600;font-size:13px}' +
      '.kore-da-advice-reason{font-size:12px;color:var(--kore-text-3,#8a94a6);line-height:1.6;margin-top:4px}' +
      '.kore-da-go{min-height:36px;padding:7px 12px;border-radius:8px;cursor:pointer;flex:none;' +
      'background:transparent;border:1px solid var(--kore-info,#4f8cff);color:var(--kore-info,#4f8cff);font-size:12px}' +
      '.kore-da-empty{text-align:center;padding:40px 16px;color:var(--kore-text-3,#8a94a6)}' +
      '.kore-da-empty b{display:block;font-size:15px;color:var(--kore-text-2,#b8c0cf);margin-bottom:8px}' +
      '.kore-da-empty small{font-size:12px}' +
      '.kore-da-progress{height:6px;border-radius:3px;overflow:hidden;background:var(--kore-bg-1,#141a24);' +
      'margin-top:10px;display:none}' +
      '.kore-da-progress.is-on{display:block}' +
      '.kore-da-progress i{display:block;height:100%;width:30%;background:var(--kore-info,#4f8cff);' +
      'animation:kore-da-slide 1.1s ease-in-out infinite}' +
      '@keyframes kore-da-slide{0%{margin-left:-30%}100%{margin-left:100%}}' +
      '.kore-da-tip{position:fixed;z-index:80;pointer-events:none;background:var(--kore-bg-1,#141a24);' +
      'border:1px solid var(--kore-border-1,#2c3444);border-radius:8px;padding:8px 10px;font-size:12px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:260px;line-height:1.5;display:none}' +
      '@media (max-width:860px){.kore-da-grid{grid-template-columns:1fr}' +
      '.kore-da-tab,.kore-da-go,.kore-da-run{min-height:44px}}' +
      '@media (max-width:639px){.kore-da-ring{width:200px;height:200px}}';
    document.head.appendChild(s);
  }

  // ---- SVG 占比环：静态占比图优先 SVG（G-32 第5条）；逐点 hover/tap 读数带单位 ----
  function makeRing(container, dirs, tip) {
    var wrap = add(container, el('div', 'kore-da-ring-wrap'));
    var total = 0, i;
    for (i = 0; i < dirs.length; i++) total += dirs[i].bytes;
    if (!dirs.length || total <= 0) {
      add(wrap, el('div', 'kore-da-empty', '暂无可展示的占用数据'));
      return function () {};
    }
    var size = 240, cx = size / 2, cy = size / 2, r = 90, stroke = 34;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'kore-da-ring');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('role', 'img');
    var legend = '<div>目录占用占比（合计 ' + fmtSize(total) + '）：</div>';
    svg.setAttribute('aria-label', legend.replace(/<[^>]+>/g, ''));
    var circ = 2 * Math.PI * r, offset = 0;

    var paths = [];
    for (i = 0; i < dirs.length; i++) {
      var d = dirs[i];
      var frac = d.bytes / total;
      var len = circ * frac;
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', describeArc(cx, cy, r, offset, offset + len));
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', PALETTE[i % PALETTE.length]);
      p.setAttribute('stroke-width', String(stroke));
      p.setAttribute('aria-label', d.name + '：' + fmtSize(d.bytes) + '，占 ' +
        (frac * 100).toFixed(1) + '%');
      var label = d.name + '：' + fmtSize(d.bytes) + ' · ' + (frac * 100).toFixed(1) + '%';
      bindPoint(p, label, tip, paths);
      paths.push(p);
      svg.appendChild(p);
      offset += len;
    }
    add(wrap, svg);

    var ul = add(wrap, el('ul', 'kore-da-legend'));
    var legendNodes = [];
    for (i = 0; i < dirs.length; i++) {
      var d2 = dirs[i], li = add(ul, el('li'));
      var dot = add(li, el('span', 'kore-da-dot'));
      dot.style.background = PALETTE[i % PALETTE.length];
      add(li, el('span', 'kore-da-lg-name', d2.name));
      var pct = total > 0 ? (d2.bytes / total * 100).toFixed(1) : '0.0';
      add(li, el('span', 'kore-da-lg-val', fmtSize(d2.bytes) + ' · ' + pct + '%'));
      bindPoint(li, d2.name + '：' + fmtSize(d2.bytes) + ' · ' + pct + '%', tip, paths, i);
      legendNodes.push(li);
    }
    // 返回 dispose：清空监听与 DOM 引用（G-32 第6条）
    var disposer = function () {
      paths.forEach(function (p) { unbindPoint(p); });
      paths.length = 0;
      legendNodes.forEach(function (n) { unbindPoint(n); });
      legendNodes.length = 0;
      if (svg.parentNode) svg.parentNode.removeChild(svg);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    };
    disposer.__alive = true;
    return disposer;
  }

  function polar(cx, cy, r, angleDeg) {
    var a = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }
  function describeArc(cx, cy, r, startLen, endLen) {
    var startDeg = startLen / (2 * Math.PI * r) * 360;
    var endDeg = endLen / (2 * Math.PI * r) * 360;
    if (endDeg - startDeg < 0.6) endDeg = startDeg + 0.6; // 极小扇区保证可见
    var a = polar(cx, cy, r, endDeg), b = polar(cx, cy, r, startDeg);
    var large = endDeg - startDeg > 180 ? 1 : 0;
    return 'M ' + a.x.toFixed(2) + ' ' + a.y.toFixed(2) +
      ' A ' + r + ' ' + r + ' 0 ' + large + ' 0 ' + b.x.toFixed(2) + ' ' + b.y.toFixed(2);
  }
  function bindPoint(node, label, tip, paths, legendIdx) {
    function show(x, y) {
      tip.textContent = label;
      tip.style.display = 'block';
      var left = Math.min(x + 14, window.innerWidth - tip.offsetWidth - 12);
      var top = Math.max(8, Math.min(y + 14, window.innerHeight - tip.offsetHeight - 12));
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
      paths.forEach(function (p) { p.classList.remove('is-active'); });
      if (legendIdx === undefined) node.classList.add('is-active');
    }
    function hide() {
      tip.style.display = 'none';
      node.classList.remove('is-active');
    }
    node.__daHandler = function (e) { show(e.clientX, e.clientY); };
    node.__daMove = function (e) { show(e.clientX, e.clientY); };
    node.__daLeave = function () { hide(); };
    node.__daTap = function (e) { e.preventDefault(); show(e.clientX, e.clientY); };
    on(node, 'mouseenter', node.__daHandler);
    on(node, 'mousemove', node.__daMove);
    on(node, 'mouseleave', node.__daLeave);
    on(node, 'click', node.__daTap);
  }
  function unbindPoint(node) {
    if (!node || !node.__daHandler) return;
    node.removeEventListener('mouseenter', node.__daHandler);
    node.removeEventListener('mousemove', node.__daMove);
    node.removeEventListener('mouseleave', node.__daLeave);
    node.removeEventListener('click', node.__daTap);
    node.__daHandler = node.__daMove = node.__daLeave = node.__daTap = null;
  }

  function renderTopFiles(host, files) {
    var box = add(host, el('div', 'kore-da-section card kore-da-card'));
    add(box, el('h3', null, '大文件 Top ' + files.length));
    if (!files.length) {
      add(box, el('div', 'kore-da-empty', '这个目录里没有找到普通文件。'));
      return;
    }
    files.forEach(function (f) {
      var row = add(box, el('div', 'kore-da-row'));
      var name = add(row, el('div', 'kore-da-name'));
      add(name, el('div', null, f.path.split('/').pop()));
      add(name, el('div', 'kore-da-path', f.path));
      add(row, el('div', 'kore-da-time', fmtTime(f.mod_time)));
      add(row, el('div', 'kore-da-size', fmtSize(f.bytes)));
    });
  }

  function renderAdvice(host, advice) {
    var box = add(host, el('div', 'kore-da-section card kore-da-card'));
    add(box, el('h3', null, '可安全清理什么'));
    if (!advice.length) {
      add(box, el('div', 'kore-da-empty', '当前类别没有可给出的清理建议。'));
      return;
    }
    advice.forEach(function (a) {
      var item = add(box, el('div', 'kore-da-advice'));
      var main = add(item, el('div', 'kore-da-advice-main'));
      add(main, el('div', 'kore-da-advice-title', a.title +
        (a.bytes > 0 ? ' · 约 ' + fmtSize(a.bytes) : '')));
      add(main, el('div', 'kore-da-advice-reason', a.reason));
      if (a.route) {
        var btn = add(item, el('button', 'kore-da-go',
          '去' + (ROUTE_LABEL[a.route] || '处理')));
        btn.type = 'button';
        btn.setAttribute('aria-label', '跳转到' + (ROUTE_LABEL[a.route] || a.route) + '处理');
        on(btn, 'click', function () { navigate(a.route); });
      } else {
        add(item, el('span', 'kore-da-time', '需人工确认'));
      }
    });
  }

  // 对外：render(container) → { destroy }
  function render(container) {
    if (!container) return { destroy: function () {} };
    ensureCss();
    var destroyed = false, disposeRing = function () {}, controller = null;
    var currentCat = 'logs';
    var root = add(container, el('div', 'kore-da'));

    var tip = add(document.body, el('div', 'kore-da-tip'));
    tip.setAttribute('role', 'status');

    var head = add(root, el('div', 'kore-da-head'));
    var title = add(head, el('div', 'kore-da-title'));
    add(title, document.createTextNode(tr('nav.diskAnalysis', '磁盘分析')));
    add(title, el('span', 'kore-da-sub', '看看哪个目录在吃磁盘、能清什么'));
    var runBtn = add(head, el('button', 'kore-da-run', '开始扫描'));
    runBtn.type = 'button';

    var tabs = add(root, el('div', 'kore-da-tabs'));
    var tabBtns = {};
    CATEGORIES.forEach(function (c) {
      var b = add(tabs, el('button', 'kore-da-tab' + (c.key === currentCat ? ' is-active' : ''), c.label));
      b.type = 'button';
      tabBtns[c.key] = b;
      on(b, 'click', function () {
        if (destroyed || currentCat === c.key) return;
        currentCat = c.key;
        Object.keys(tabBtns).forEach(function (k) {
          tabBtns[k].classList.toggle('is-active', k === currentCat);
        });
        // 换类别后清空旧结果，等待用户确认（扫描是重操作，不自动触发）
        clearBody();
        showIdle();
      });
    });

    var banner = add(root, el('div', 'kore-da-banner'));
    banner.style.display = 'none';
    var progress = add(root, el('div', 'kore-da-progress'));
    add(progress, el('i'));
    var body = add(root, el('div'));

    function clearBody() {
      disposeRing();
      disposeRing = function () {};
      body.textContent = '';
    }
    function setBanner(msg, kind) {
      if (!msg) { banner.style.display = 'none'; banner.textContent = ''; return; }
      banner.style.display = 'block';
      banner.className = 'kore-da-banner' + (kind ? ' is-' + kind : '');
      banner.textContent = msg;
    }
    function setProgress(on_) {
      progress.classList.toggle('is-on', !!on_);
    }
    function showIdle() {
      setBanner('选择上方类别后点「开始扫描」。扫描会读取目录占用，可能需要几秒，不会修改任何文件。', 'hint');
      var e = add(body, el('div', 'kore-da-empty'));
      add(e, el('b', null, '还没扫描'));
      add(e, el('small', null, '点「开始扫描」看看是哪些文件占了空间。'));
    }

    function doScan() {
      if (destroyed) return;
      // 确认：扫描是重操作（G-19 不常驻轮询；这里是用户主动触发的一次性只读扫描）
      if (!window.confirm('将只读扫描「' + labelOf(currentCat) + '」目录（不删除任何文件），可能需要几秒，继续吗？')) return;
      clearBody();
      setBanner('正在扫描「' + labelOf(currentCat) + '」，请稍候…');
      setProgress(true);
      runBtn.disabled = true;

      // 请求级超时：AbortController 兜前端；后端也有 3s context 超时（G-19 允许请求级 timer）
      controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;
      var csrf = readCookie('kore_csrf');
      var headers = { 'Accept': 'application/json' };
      if (csrf) headers['X-CSRF-Token'] = csrf;

      fetch(API + '?category=' + encodeURIComponent(currentCat), {
        credentials: 'same-origin', cache: 'no-store',
        headers: headers, signal: controller ? controller.signal : undefined
      }).then(function (resp) {
        if (!resp.ok) return resp.text().then(function (t) {
          var msg = t || ('HTTP ' + resp.status);
          try { var j = JSON.parse(t); msg = j.message || j.detail || msg; } catch (e) {}
          throw new Error(msg);
        });
        return resp.json();
      }).then(function (data) {
        if (destroyed) return;
        paint(data);
      }).catch(function (err) {
        if (destroyed) return;
        var aborted = err && (err.name === 'AbortError');
        setBanner(aborted ? '扫描超时（超过 6 秒已停止）。可换个类别再试，或稍后重试。' :
          '扫描失败：' + plainError(err, '暂时无法读取磁盘占用，请稍后重试。'), 'err');
        var e = add(body, el('div', 'kore-da-empty'));
        add(e, el('b', null, aborted ? '扫描已停止' : '没能完成扫描'));
        add(e, el('small', null, aborted ? '为避免卡住已自动停止，不会修改任何文件。' :
          '这是只读扫描失败，你的文件没有被改动。'));
      }).then(function () {
        if (timer) clearTimeout(timer);
        setProgress(false);
        runBtn.disabled = false;
        controller = null;
      });
    }

    function paint(data) {
      clearBody();
      if (!data) { showIdle(); return; }
      if (data.note) setBanner(data.note, 'hint');
      else setBanner('');

      var grid = add(body, el('div', 'kore-da-grid'));

      // ① 占比环 + 目录列表
      var ringCard = add(grid, el('div', 'kore-da-card'));
      add(ringCard, el('h3', null, '目录占用 · ' + labelOf(currentCat)));
      var dirs = (data.dirs || []).map(function (d) {
        return { name: d.name, bytes: d.bytes, files: d.files };
      });
      if (!dirs.length) {
        add(ringCard, el('div', 'kore-da-empty', data.note || '这个目录暂时没有占用数据。'));
      } else {
        disposeRing = makeRing(ringCard, dirs, tip);
      }

      // ② TopN + ③ 建议（右侧）
      var right = add(grid, el('div'));
      var summary = add(right, el('div', 'kore-da-banner'));
      summary.textContent = '已扫描 ' + (data.scanned || 0) + ' 个文件 · 共 ' +
        fmtSize(data.total_bytes) + (data.root ? ' · 目录 ' + data.root : '') +
        (data.truncated ? ' · 部分结果' : '');
      renderTopFiles(right, data.top_files || []);
      renderAdvice(right, data.advice || []);
    }

    function labelOf(key) {
      for (var i = 0; i < CATEGORIES.length; i++) {
        if (CATEGORIES[i].key === key) return CATEGORIES[i].label;
      }
      return key;
    }

    on(runBtn, 'click', doScan);

    showIdle();
    // 暴露验收钩子（G-32 实例计数：本页仅 1 个 SVG 环，dispose 后归零）
    var hook = {
      count: function () { return body.querySelector('.kore-da-ring') ? 1 : 0; },
      dispose: function () { clearBody(); }
    };
    window.__koreDiskAnalysisChart = hook;

    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (controller) { try { controller.abort(); } catch (e) {} controller = null; }
        clearBody();
        if (tip.parentNode) tip.parentNode.removeChild(tip);
        if (root.parentNode) root.parentNode.removeChild(root);
        if (document.getElementById(STYLE_ID)) {
          // 样式保留供下次 render 复用（多实例共享），不移除，避免闪烁。
        }
        if (window.__koreDiskAnalysisChart === hook) delete window.__koreDiskAnalysisChart;
      }
    };
  }

  window.KoreDiskAnalysis = { render: render };
})();
