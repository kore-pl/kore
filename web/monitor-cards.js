/* kore 主壳 · 监控视图的纯渲染构件（web/monitor-cards.js）——零框架 / 零 DOM 查询 / 无副作用。
   只做「数据 → DOM 节点」：卡片、面板、表格、进度条、人类可读格式化；不发请求、不持状态。
   由 web/monitor.js 在进入监控视图时按需注入（/assets/monitor-cards.js），首屏不加载。
   对外：window.KoreMonitorCards = { systemCards, kernelCards, diskPanel, netPanel,
   tempContent, procTable, warnings, panel, fmtUptime, fmtBytes }。 */
(function () {
  'use strict';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function clampPct(v) { return Math.max(0, Math.min(100, v)); }
  function tone(pct) { return pct === null ? 'ok' : pct >= 90 ? 'fail' : pct >= 80 ? 'warn' : 'ok'; }

  function fmtUptime(sec) {
    var s = Math.max(0, Math.floor(num(sec) === null ? 0 : sec));
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + ' 天 ' + h + ' 小时';
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分 ' + (s % 60) + ' 秒';
    return s + ' 秒';
  }
  function fmtBytes(v) {
    var n = num(v);
    if (n === null || n < 0) return '—';
    if (n / 1073741824 >= 1) return (n / 1073741824).toFixed(1) + ' GiB';
    if (n / 1048576 >= 1) return (n / 1048576).toFixed(1) + ' MiB';
    return (n / 1024).toFixed(0) + ' KiB';
  }
  function human(text, bytes) { return text || fmtBytes(bytes); }

  function chip(toneName, text) {
    var c = el('span', 'chip chip-' + toneName), dot = el('span', 'dot');
    if (toneName === 'ok' || toneName === 'warn' || toneName === 'fail') dot.classList.add(toneName);
    add(c, dot); add(c, el('span', null, text));
    return c;
  }

  /* 占用条：< 80% 绿 / ≥80% 黄 / ≥90% 红；无数据不填充。 */
  function barCell(pct) {
    var cell = el('div', 'mon-barcell'), track = add(cell, el('div', 'mon-bar'));
    var v = num(pct) === null ? 0 : clampPct(pct), t = tone(num(pct));
    var fill = add(track, el('div', 'mon-bar-fill' + (t === 'warn' ? ' mon-bar-warn' : t === 'fail' ? ' mon-bar-fail' : '')));
    fill.style.width = v.toFixed(1) + '%';
    add(cell, el('span', 'mon-pct', (num(pct) === null ? '—' : pct.toFixed(1)) + '%'));
    return cell;
  }

  function card(title, value, unit, note, extra, chipText, chipTone) {
    var box = el('div', 'monitor-card'), head = add(box, el('div', 'monitor-head'));
    add(head, el('span', 'monitor-title', title));
    if (chipText) add(head, chip(chipTone || 'ok', chipText));
    var val = add(box, el('div', 'monitor-value'));
    add(val, el('span', 'monitor-num', value));
    if (unit) add(val, el('span', 'monitor-unit', unit));
    if (extra) add(box, extra);
    if (note) add(box, el('p', 'monitor-note', note));
    return box;
  }

  function panel(title, extraHead, bodyClass) {
    var p = el('section', 'panel'), head = add(p, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', title));
    if (extraHead) add(head, extraHead);
    p.body = add(p, el('div', bodyClass || ''));
    return p;
  }

  function table(heads, rows) {
    var wrap = el('div', 'mon-scroll'), t = add(wrap, el('table', 'mon-table'));
    var htr = add(add(t, el('thead')), el('tr')), tb = add(t, el('tbody')), i, j;
    for (i = 0; i < heads.length; i++) add(htr, el('th', null, heads[i]));
    for (i = 0; i < rows.length; i++) {
      var tr = add(tb, el('tr'));
      for (j = 0; j < rows[i].length; j++) {
        var td = add(tr, el('td')), cell = rows[i][j];
        if (cell && cell.nodeType) td.appendChild(cell);
        else td.textContent = cell === undefined || cell === null ? '—' : String(cell);
      }
    }
    return wrap;
  }

  function emptyLine(text) { return el('p', 'panel-empty', text); }

  /* ---------- 图表构件（磁盘容量 / 网络 / 温度 / 进程 TOP） ----------
     G-32 落点（本文件由 monitor.js 懒加载，不在首屏 FILES）：
       §13-1 按需加载：随视图注入，首屏 gzip 不随图表数增长；
       §13-2 实例数：纯 SVG / DOM，不注册图表实例，不占 12 个 canvas 额度；
       §13-5 渲染器：静态占比图（环形）用 SVG，排序条用 DOM 百分比宽度
                （天然响应式、文字不缩放，比拉伸 viewBox 更稳）；
       §13-3 不引入任何图表库；§13-8 无动画、无 emphasis、无 markPoint；
       §13-11 数据可读：每根柱 / 每个环都是可聚焦按钮，hover / 键盘 focus /
                手机 tap 都弹出读数面板且**数值带单位**（X% / 12.3 GiB / 45.0°C）。
     面板直接复用 monitor.js 注入的 .mon-tip 样式，视觉与历史曲线读数一致。 */
  var CHART_STYLE_ID = 'kore-mon-chart-style';
  var SVGNS = 'http://www.w3.org/2000/svg';

  var CHART_CSS = [
    '.mon-cbox{position:relative}',
    '.mon-donuts{display:flex;flex-wrap:wrap;gap:16px;padding:6px 0 2px}',
    '.mon-donut{appearance:none;background:none;border:0;margin:0;padding:4px;font:inherit;color:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;border-radius:6px;min-width:104px;min-height:44px}',
    '.mon-donut:focus-visible{outline:2px solid var(--kore-info);outline-offset:2px}',
    '.mon-donut svg{display:block;width:84px;height:84px}',
    '.mon-donut-cap{font-size:12px;color:var(--kore-text-2);max-width:136px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mon-donut-sub{font-size:11px;color:var(--kore-text-3);font-variant-numeric:tabular-nums}',
    '.mon-hbar{display:flex;flex-direction:column;gap:2px;padding:2px 0}',
    '.mon-hbar-row{appearance:none;background:none;border:0;margin:0;padding:4px;font:inherit;color:inherit;cursor:pointer;display:grid;grid-template-columns:minmax(56px,24%) 1fr auto;align-items:center;gap:8px;border-radius:var(--kore-radius-control);text-align:left;min-height:32px;width:100%}',
    '.mon-hbar-row:focus-visible{outline:2px solid var(--kore-info);outline-offset:-2px}',
    '.mon-hbar-row:hover{background:var(--kore-bg-2)}',
    '.mon-hbar-name{font-size:12px;color:var(--kore-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mon-hbar-track{display:block;position:relative;height:10px;border-radius:5px;background:var(--kore-bg-0);overflow:hidden}',
    '.mon-hbar-fill{position:absolute;top:0;bottom:0;left:0;border-radius:5px;background:var(--kore-info)}',
    '.mon-hbar-fill.mon-hbar-warn{background:var(--kore-warning)}',
    '.mon-hbar-fill.mon-hbar-fail{background:var(--kore-danger)}',
    '.mon-hbar-fill.mon-hbar-alt{background:var(--kore-text-3)}',
    '.mon-hbar-val{font-size:12px;color:var(--kore-text-1);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.mon-hbar-note{padding:6px 4px 2px;margin:0;font-size:11px;color:var(--kore-text-3);line-height:1.6}',
    '@media (max-width:640px){.mon-hbar-row{min-height:var(--kore-touch)}.mon-donut{min-width:132px}}'
  ].join('\n');

  function ensureChartStyle() {
    if (document.getElementById(CHART_STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = CHART_STYLE_ID;
    s.textContent = CHART_CSS;
    document.head.appendChild(s);
  }

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag), k;
    for (k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    }
    return n;
  }

  /* 读数面板宿主：面板 body 里包一层 position:relative，面板按指针 x 夹取定位。 */
  function tipBox(body) {
    ensureChartStyle();
    return add(body, el('div', 'mon-cbox'));
  }

  function makeTip(box) {
    var tip = add(box, el('div', 'mon-tip'));
    tip.hidden = true;
    return tip;
  }

  function hideTip(tip) { tip.hidden = true; }

  /* 数值 + 单位；非有限值给 —，避免面板出现 NaN。 */
  function withUnit(v, unit) {
    if (num(v) === null) return '—';
    return v.toFixed(1) + (unit || '');
  }

  function paintTip(tip, box, title, rows, clientX) {
    tip.textContent = '';
    if (title) add(tip, el('div', 'mon-tip-time', title));
    rows.forEach(function (r) {
      var row = add(tip, el('div', 'mon-tip-row'));
      if (r.tone) {
        var dot = add(row, el('i', 'mon-tip-dot'));
        dot.style.background = r.tone;
      }
      add(row, el('span', 'mon-tip-val', r.text));
    });
    tip.hidden = false;
    /* 位置：以指针 x 居中，两侧夹取在容器内（手机不横向溢出面板）。 */
    var bw = box.clientWidth || 0, tw = tip.offsetWidth || 0;
    var left = box.getBoundingClientRect().left;
    var x = typeof clientX === 'number' && isFinite(clientX) ? clientX - left : bw / 2;
    x = Math.max(4, Math.min(x - tw / 2, Math.max(4, bw - tw - 4)));
    tip.style.left = x + 'px';
    tip.style.top = '0';
  }

  /* 一个数据点绑三种读数入口：鼠标 hover、键盘 Tab focus、手机 tap。
     touchstart 用 passive 不夺滚动手势；离开 / 失焦收起。 */
  function bindPoint(node, tip, box, read) {
    function show(ev) {
      var cx = null;
      if (ev && ev.touches && ev.touches[0]) cx = ev.touches[0].clientX;
      else if (ev && typeof ev.clientX === 'number') cx = ev.clientX;
      var data = read();
      if (data) paintTip(tip, box, data.title, data.rows, cx);
    }
    node.addEventListener('mouseenter', show);
    node.addEventListener('focus', show);
    node.addEventListener('touchstart', show, { passive: true });
    node.addEventListener('mouseleave', function () { hideTip(tip); });
    node.addEventListener('blur', function () { hideTip(tip); });
  }

  /* 环形占比（静态 → SVG）：dasharray 画弧，环心百分比，下方已用 / 总量。 */
  function donutNode(disk, tip, box) {
    var pct = num(disk.used_percent);
    var v = pct === null ? 0 : clampPct(pct), t = tone(pct);
    var btn = el('button', 'mon-donut');
    btn.type = 'button';
    var R = 34, C = 2 * Math.PI * R;
    var svg = svgEl('svg', { viewBox: '0 0 84 84', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('circle', {
      cx: 42, cy: 42, r: R, fill: 'none',
      stroke: 'var(--kore-bg-0)', 'stroke-width': 9
    }));
    svg.appendChild(svgEl('circle', {
      cx: 42, cy: 42, r: R, fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round',
      stroke: t === 'fail' ? 'var(--kore-danger)' : t === 'warn' ? 'var(--kore-warning)' : 'var(--kore-info)',
      'stroke-dasharray': (C * v / 100).toFixed(2) + ' ' + C.toFixed(2),
      transform: 'rotate(-90 42 42)'
    }));
    var label = svgEl('text', {
      x: 42, y: 42, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: 'var(--kore-text-1)', 'font-size': 15, 'font-weight': 600
    });
    label.textContent = pct === null ? '—' : v.toFixed(0) + '%';
    svg.appendChild(label);
    btn.appendChild(svg);
    add(btn, el('span', 'mon-donut-cap', disk.mount || '—'));
    add(btn, el('span', 'mon-donut-sub',
      human(disk.used_human, disk.used) + ' / ' + human(disk.total_human, disk.total)));
    bindPoint(btn, tip, box, function () {
      return {
        title: (disk.mount || '—') + (disk.fs_type ? ' · ' + disk.fs_type : ''),
        rows: [
          { text: '占用 ' + withUnit(pct, '%'), tone: 'var(--kore-info)' },
          { text: '已用 ' + human(disk.used_human, disk.used) },
          { text: '可用 ' + human(disk.avail_human, disk.avail) },
          { text: '总量 ' + human(disk.total_human, disk.total) }
        ]
      };
    });
    return btn;
  }

  /* 横向柱（排序 / 当前值对比）：DOM 百分比宽度，行高在手机端抬到 44px 触摸目标。 */
  function hbarChart(box, tip, rows, scaleMax, note) {
    var wrap = add(box, el('div', 'mon-hbar'));
    rows.forEach(function (r) {
      var btn = el('button', 'mon-hbar-row');
      btn.type = 'button';
      add(btn, el('span', 'mon-hbar-name', r.label));
      var track = add(btn, el('span', 'mon-hbar-track'));
      var cls = 'mon-hbar-fill';
      if (r.tone === 'warn') cls += ' mon-hbar-warn';
      else if (r.tone === 'fail') cls += ' mon-hbar-fail';
      else if (r.tone === 'alt') cls += ' mon-hbar-alt';
      var fill = add(track, el('span', cls));
      var ratio = scaleMax > 0 ? Math.max(0, Math.min(1, r.value / scaleMax)) : 0;
      fill.style.width = (ratio * 100).toFixed(1) + '%';
      add(btn, el('span', 'mon-hbar-val', r.display));
      if (r.tip) bindPoint(btn, tip, box, r.tip);
      wrap.appendChild(btn);
    });
    if (note) add(box, el('p', 'mon-hbar-note', note));
    return wrap;
  }

  /* 系统四卡：CPU / 内存 / 负载 / 运行时长（monitor.system）。 */
  function systemCards(d) {
    var cpu = d.cpu || {}, mem = d.memory || {}, load = d.load || {}, up = d.uptime || {};
    var pct = num(cpu.usage_percent), cores = num(cpu.cores), usedPct = num(mem.used_percent);
    var cpuNote = cores ? cores + ' 核 · 采样 ' + (num(cpu.sample_interval_ms) || '—') + ' ms' : '总使用率';
    var memNote = 'Swap ' + (num(mem.swap_total) ? human(mem.swap_used_human, mem.swap_used) + ' / ' +
      human(mem.swap_total_human, mem.swap_total) : '未启用');
    return [
      card('CPU 使用率', pct === null ? '—' : pct.toFixed(1), '%', cpuNote, null,
        pct === null ? '' : pct >= 80 ? '偏高' : '正常', tone(pct)),
      card('内存', human(mem.used_human, mem.used), '/ ' + human(mem.total_human, mem.total), memNote,
        barCell(usedPct), usedPct === null ? '' : usedPct >= 80 ? '偏高' : '正常', tone(usedPct)),
      card('负载', num(load.load1) === null ? '—' : load.load1.toFixed(2), '',
        '5 分钟 ' + (num(load.load5) === null ? '—' : load.load5.toFixed(2)) +
        ' · 15 分钟 ' + (num(load.load15) === null ? '—' : load.load15.toFixed(2)) +
        (num(load.running) === null ? '' : ' · 运行 ' + load.running + ' / ' + load.total), null, '', 'ok'),
      card('运行时长', fmtUptime(up.uptime_s), '',
        num(up.idle_s) === null ? '自内核启动' : '空闲累计 ' + fmtUptime(up.idle_s), null, '', 'ok')
    ];
  }

  /* 内核降级四卡：只用 /api/v1/system/metrics 的字段，不编造插件才有的数据。 */
  function kernelCards(m) {
    var pct = num(m.cpu_pct), load = num(m.load1), usedKib = num(m.disk_used_kib), totalKib = num(m.disk_total_kib);
    var diskPct = usedKib !== null && totalKib ? (usedKib / totalKib) * 100 : null;
    return [
      card('CPU 使用率', pct === null ? '—' : pct.toFixed(1), '%', '内核采样 · 仅总使用率', null,
        pct === null ? '' : pct >= 80 ? '偏高' : '正常', tone(pct)),
      card('负载', load === null ? '—' : load.toFixed(2), '', '5 / 15 分钟需 monitor 插件', null, '', 'ok'),
      card('运行时长', fmtUptime(m.uptime_sec), '', '自内核启动', null, '', 'ok'),
      card('磁盘（根分区汇总）', usedKib === null ? '—' : (usedKib / 1048576).toFixed(1),
        totalKib === null ? '' : '/ ' + (totalKib / 1048576).toFixed(1) + ' GiB',
        '内核汇总值；逐挂载点 / inode 需 monitor 插件', barCell(diskPct), '', 'ok'),
      card('主壳 VmRSS', num(m.rss_kib) === null ? '—' : (m.rss_kib / 1024).toFixed(1), 'MiB',
        'goroutine ' + (num(m.goroutines) === null ? '—' : m.goroutines) +
        ' · fd ' + (num(m.fds) === null ? '—' : m.fds), null, '', 'ok')
    ];
  }

  /* 磁盘容量：环形占比为主（静态 → SVG），精确值进读数面板，不再用表格。 */
  function diskPanel(d) {
    var p = panel('磁盘容量'), disks = Array.isArray(d.disks) ? d.disks : [];
    if (!disks.length) { add(p.body, emptyLine('无可用块设备挂载点')); return p; }
    var box = tipBox(p.body), tip = makeTip(box);
    var row = add(box, el('div', 'mon-donuts'));
    disks.forEach(function (x) { row.appendChild(donutNode(x, tip, box)); });
    add(box, el('p', 'mon-hbar-note',
      '环心是占用比，下方是已用 / 总量；悬停、Tab 聚焦或手机点按看精确值（含单位）。'));
    return p;
  }

  /* 网络：后端只有累计计数器（无历史、无速率），故画各网卡累计收发对比，
     不画速率折线——那需要两次采样差分，编一条曲线就是造假。 */
  function netPanel(d) {
    var p = panel('网络累计收发');
    var net = Array.isArray(d.network) ? d.network : (Array.isArray(d.net) ? d.net : []);
    if (!net.length) { add(p.body, emptyLine('无网络接口数据（loopback 已排除）')); return p; }
    var box = tipBox(p.body), tip = makeTip(box), maxV = 0, rows = [];
    net.forEach(function (x) {
      maxV = Math.max(maxV, num(x.rx_bytes) || 0, num(x.tx_bytes) || 0);
    });
    net.forEach(function (x) {
      var name = x.name || '—';
      rows.push({
        label: name + ' 收', value: num(x.rx_bytes) || 0,
        display: human(x.rx_human, x.rx_bytes), tone: '',
        tip: function () {
          return {
            title: name + ' · 接收',
            rows: [
              { text: '累计 ' + human(x.rx_human, x.rx_bytes), tone: 'var(--kore-info)' },
              { text: '包 ' + (num(x.rx_packets) || 0) + ' · 错误 ' + (num(x.rx_errors) || 0) }
            ]
          };
        }
      });
      rows.push({
        label: name + ' 发', value: num(x.tx_bytes) || 0,
        display: human(x.tx_human, x.tx_bytes), tone: 'alt',
        tip: function () {
          return {
            title: name + ' · 发送',
            rows: [
              { text: '累计 ' + human(x.tx_human, x.tx_bytes), tone: 'var(--kore-text-3)' },
              { text: '包 ' + (num(x.tx_packets) || 0) + ' · 错误 ' + (num(x.tx_errors) || 0) }
            ]
          };
        }
      });
    });
    hbarChart(box, tip, rows, maxV, '网卡累计计数器（不是速率）：monitor.system 只返回累计收/发，' +
      '速率需要两次采样求差；本页按次刷新，所以这里给累计对比而不是折线。');
    return p;
  }

  /* 温度：后端只给当前读数（无历史），故用当前值横条，不伪造趋势折线。 */
  function tempContent(host, d) {
    host.textContent = '';
    var zones = d && Array.isArray(d.zones) ? d.zones : [];
    if (!d || d.available === false || !zones.length) {
      add(host, el('span', 'muted', '本机不支持温度读取'));
      return;
    }
    var box = tipBox(host), tip = makeTip(box);
    var rows = zones.map(function (z) {
      var t = num(z.temp_c), name = z.zone || 'zone';
      var toneName = t === null ? '' : t >= 80 ? 'fail' : t >= 70 ? 'warn' : '';
      return {
        label: name, value: t === null ? 0 : t,
        display: t === null ? '—' : t.toFixed(1) + '°C', tone: toneName,
        tip: function () {
          return {
            title: name + (z.type ? ' · ' + z.type : ''),
            rows: [
              { text: '当前 ' + withUnit(t, '°C'), tone: 'var(--kore-warning)' },
              { text: '刻度 0–100°C · ≥70 警告 / ≥80 严重' }
            ]
          };
        }
      };
    });
    hbarChart(box, tip, rows, 100, '每行一个传感器/热区；monitor.temperature 只给当前值，没有历史序列。');
  }

  /* 进程 TOP：横向柱为主（比表格直观），PID / RSS / 线程进读数面板。 */
  function procTable(host, procs, err, opts) {
    host.textContent = '';
    if (err) { add(host, emptyLine('进程读取失败：' + err)); return; }
    if (!procs) { add(host, emptyLine('正在读取进程…')); return; }
    var items = Array.isArray(procs.items) ? procs.items : [];
    if (!items.length) { add(host, emptyLine('无进程数据')); return; }
    var byMem = procs.sort === 'mem';
    var box = tipBox(host), tip = makeTip(box), maxV = 0, rows = [];
    items.forEach(function (p) {
      var v = byMem ? (num(p.mem_percent) || 0) : (num(p.cpu_percent) || 0);
      if (v > maxV) maxV = v;
    });
    items.forEach(function (p) {
      var cpu = num(p.cpu_percent), mem = num(p.mem_percent);
      var v = byMem ? (mem || 0) : (cpu || 0);
      var name = p.comm || '—';
      rows.push({
        label: name + (p.protected ? ' 🔒' : ''), value: v,
        display: byMem ? withUnit(mem, '%') : withUnit(cpu, '%'),
        tone: v >= 80 ? 'fail' : v >= 50 ? 'warn' : '',
        tip: function () {
          return {
            title: name + ' · PID ' + p.pid,
            rows: [
              { text: 'CPU ' + withUnit(cpu, '%'), tone: 'var(--kore-info)' },
              { text: '内存 ' + human(p.mem_rss_human, p.mem_rss_bytes) + '（' + withUnit(mem, '%') + '）',
                tone: 'var(--kore-success)' },
              { text: '线程 ' + (num(p.threads) === null ? '—' : p.threads) +
                (p.protected ? ' · 在保护名单，结束需二次确认' : '') }
            ]
          };
        }
      });
    });
    hbarChart(box, tip, rows, maxV || 1,
      '按 ' + (byMem ? '内存' : 'CPU') + ' 排序；柱长按本次采样最大值归一，右侧是读数值。');
    var foot = add(host, el('p', 'mon-proc-meta'), '共 ' + (num(procs.total) || items.length) + ' 个进程 · 单次采样 ' +
      (num(procs.sample_interval_ms) || '—') + ' ms · CPU% 按单核归一');
    if (opts && opts.allHref) {
      var all = add(foot, el('a', 'mon-all', '查看全部 →'));
      all.href = opts.allHref;
      all.title = '打开进程页查看全部进程并结束进程';
    }
  }

  function warnings(host, list) {
    host.textContent = '';
    (Array.isArray(list) ? list : []).forEach(function (w) { host.appendChild(chip('warn', w)); });
  }

  window.KoreMonitorCards = {
    systemCards: systemCards, kernelCards: kernelCards, diskPanel: diskPanel, netPanel: netPanel,
    tempContent: tempContent, procTable: procTable, warnings: warnings,
    panel: panel, table: table, chip: chip, emptyLine: emptyLine, fmtUptime: fmtUptime, fmtBytes: fmtBytes
  };
})();
