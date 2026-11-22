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

  function diskPanel(d) {
    var p = panel('磁盘'), disks = Array.isArray(d.disks) ? d.disks : [];
    if (!disks.length) { add(p.body, emptyLine('无可用块设备挂载点')); return p; }
    add(p.body, table(['挂载点', '文件系统', '已用', '总量', '占用'], disks.map(function (x) {
      return [el('code', 'mon-mono', x.mount || '—'), x.fs_type || '—',
        human(x.used_human, x.used), human(x.total_human, x.total), barCell(num(x.used_percent))];
    })));
    return p;
  }

  function netPanel(d) {
    var p = panel('网络'), net = Array.isArray(d.network) ? d.network : (Array.isArray(d.net) ? d.net : []);
    if (!net.length) { add(p.body, emptyLine('无网络接口数据（loopback 已排除）')); return p; }
    add(p.body, table(['网卡', '接收', '发送', '错误 rx/tx'], net.map(function (x) {
      return [el('code', 'mon-mono', x.name || '—'), human(x.rx_human, x.rx_bytes),
        human(x.tx_human, x.tx_bytes), (num(x.rx_errors) || 0) + ' / ' + (num(x.tx_errors) || 0)];
    })));
    return p;
  }

  /* 温度：available=false 或无 zone 时只给一句灰字，不渲染空表。 */
  function tempContent(host, d) {
    host.textContent = '';
    var zones = d && Array.isArray(d.zones) ? d.zones : [];
    if (!d || d.available === false || !zones.length) {
      add(host, el('span', 'muted', '本机不支持温度读取'));
      return;
    }
    zones.forEach(function (z) {
      host.appendChild(chip('na', (z.zone || 'zone') + ' · ' +
        (num(z.temp_c) === null ? '—' : z.temp_c.toFixed(1)) + '°C' + (z.type ? ' · ' + z.type : '')));
    });
  }

  function procTable(host, procs, err) {
    host.textContent = '';
    if (err) { add(host, emptyLine('进程读取失败：' + err)); return; }
    if (!procs) { add(host, emptyLine('正在读取进程…')); return; }
    var items = Array.isArray(procs.items) ? procs.items : [];
    if (!items.length) { add(host, emptyLine('无进程数据')); return; }
    add(host, table(['PID', '名称', 'CPU%', '内存', '线程'], items.map(function (p) {
      return [el('code', 'mon-mono', p.pid), el('span', null, p.comm || '—'),
        num(p.cpu_percent) === null ? '—' : p.cpu_percent.toFixed(1),
        human(p.mem_rss_human, p.mem_rss_bytes), num(p.threads) === null ? '—' : p.threads];
    })));
    add(host, el('p', 'mon-proc-meta', '共 ' + (num(procs.total) || items.length) + ' 个进程 · 单次采样 ' +
      (num(procs.sample_interval_ms) || '—') + ' ms · CPU% 按单核归一'));
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
