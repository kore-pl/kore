/* Kore 主壳 · 关键文件完整性（web/integrity.js）——零框架 / 零 CDN / 无外链。
   依据：kore-plugin-integrity/info.json 的 8 个方法（integrity.baseline / baseline.list / check /
   restore / status / verify_file / schedule.set / schedule.get）+ internal/integrity 的响应契约，
   本轮只补前端缺口：不改内核、不加方法、不引依赖。
   契约（kore-plugin-integrity/internal/integrity/methods.go:88-190）：status{has_baseline,created_at,
   entries,total_bytes,last_check_at,last_check_ok,baseline_count,latest_id} ·
   baseline.list{baselines[]{id,created_at,note,entries,total_bytes,last_check_at,last_check_ok,current},
   count,keep} · baseline{id,entries,total_bytes,duration_ms,warnings?} ·
   check{ok,added[],removed[],modified[]{path,old_sha256,new_sha256,old_mode,new_mode,changes[]},
   changes[]{type,path,severity},checked_at,unchanged,truncated,summary,warnings?} ·
   restore{from_id,to_id,restored,verified,changes,message,hint} · verify_file{match,actual_sha256}。
   POST /api/v1/invoke/integrity/integrity.<verb>；写操作带 X-Kore-CSRF 双提交。
   本轮补齐的用户可见缺口：① 变更清单按时间范围 / 类型 / 高危 / 路径筛选，高危目录（/etc、Web 根）
   高亮并在概览计数；② 单条变更「接受」与「恢复…」指引 + 「校验是否已恢复」；③ 一键导出变更清单 CSV；
   ④ 基线版本「恢复到此版本」（restore 此前从未在界面上接线）；⑤ 概览汇总最近一次扫描结论与扫描范围。
   前端态（扫描历史 / 已接受标记 / 各基线扫描路径）只落 localStorage（config-drift.js:23 同口径），
   不碰运行态文件（G-29/G-31）；零轮询（G-19）；手机适配触摸目标 ≥44px（裁决41）。
   0 条目基线不算成功：如实说清并给下一步，不用「已建立」糊过去。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/integrity/integrity.', TIMEOUT_MS = 30000, DEF_EXCLUDE = '*.log, *.tmp, */cache/*';
  var ROOTS_TEXT = '/etc、/usr/bin、/usr/sbin、/opt、/var/www 与插件数据目录';
  var LS_HISTORY = 'kore.integrity.history.v1', LS_ACKS = 'kore.integrity.acks.v1', LS_ROOTS = 'kore.integrity.roots.v1';
  var HISTORY_RUNS = 20, HISTORY_ROWS = 300, ACK_LIMIT = 400;
  // 预设 = 插件默认白名单根：点一下就能建基线，不要求用户懂路径（USABILITY ①预设优先）。
  var PRESETS = [{ path: '/etc', name: '系统配置', note: '服务配置与启动参数' },
    { path: '/usr/bin', name: '系统命令', note: '可执行文件被换即后门' },
    { path: '/var/www', name: '站点文件', note: '网站根目录（未部署站点时为空）' },
    { path: '/opt', name: '应用目录', note: '自装应用的安装目录' }];
  var RANGES = [{ id: 'latest', label: '最近一次扫描' }, { id: '1h', label: '最近 1 小时' },
    { id: '24h', label: '最近 24 小时' }, { id: '7d', label: '最近 7 天' }, { id: 'all', label: '全部记录' }];
  var KINDS = [{ id: 'all', label: '全部类型' }, { id: 'added', label: '只看新增' },
    { id: 'modified', label: '只看修改' }, { id: 'removed', label: '只看删除' }];
  var KIND_META = { added: { text: '新增', tone: 'warn', sign: '+' }, modified: { text: '修改', tone: 'warn', sign: '~' },
    removed: { text: '删除', tone: 'fail', sign: '−' } };
  // 高危目录判定：后端 severity 只标系统二进制 / 配置（internal/integrity/changes.go:15-23），
  // Web 根与部署目录在后端是 warning；这里按用户可见口径补上「站点与部署」一档并统一高亮。
  var RISK_SYSTEM = ['/etc/', '/bin/', '/sbin/', '/lib/', '/lib64/', '/boot/', '/usr/bin/', '/usr/sbin/',
    '/usr/lib/', '/usr/lib64/', '/usr/local/bin/', '/usr/local/sbin/', '/usr/local/lib/', '/root/'];
  var RISK_WEB = ['/var/www', '/srv/www', '/srv/http', '/usr/share/nginx', '/opt/'];
  var S = {};

  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn) { n.addEventListener('click', fn); return n; }
  function btn(parent, label, cls, fn) {
    var b = add(parent, el('button', cls || 'btn')); b.type = 'button'; b.textContent = label; return on(b, fn);
  }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function invoke(verb, params) {
    var token = cookie('kore_csrf'), data = {}; if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(params || {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token } };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + verb, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = {}; } }
        if (res.ok) return data;
        var err = new Error((data.code ? data.code + '：' : '') + (data.message || 'HTTP ' + res.status));
        err.code = data.code || ''; err.hint = data.hint || ''; throw err;
      });
    }, function (e) {
      if (timer !== null) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒），请稍后重试');
      throw e;
    });
  }
  // 插件只产任务描述（created 恒 false），真正生效要 POST 到内核 scheduler（ADR-0019，插件不起 ticker）。
  var SCHEDULER_API = '/api/v1/scheduler/tasks';
  function postScheduler(task) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(SCHEDULER_API, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(task)
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = {}; } }
        if (res.ok) return data;
        var err = new Error(data.message || ('创建定时任务失败（HTTP ' + res.status + '）'));
        err.code = data.code || '';
        throw err;
      });
    });
  }
  // cron 表达式翻成人话（常用预设 + 简单解析），看不懂时原样显示，不猜。
  function humanSchedule(expr) {
    var text = String(expr || '').trim();
    var known = {
      '0 4 * * *': '每天 04:00', '0 3 * * *': '每天 03:00', '0 2 * * *': '每天 02:00',
      '0 * * * *': '每小时整点', '0 */6 * * *': '每 6 小时', '0 0 * * *': '每天 00:00',
      '0 3 * * 0': '每周日 03:00', '0 3 * * 1': '每周一 03:00',
      '0 3 1 * *': '每月 1 日 03:00'
    };
    if (known[text]) return known[text];
    var m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(text);
    if (m) return '每天 ' + (m[2].length < 2 ? '0' + m[2] : m[2]) + ':' + (m[1].length < 2 ? '0' + m[1] : m[1]);
    return text ? '自定义（' + text + '）' : '—';
  }
  var SCHEDULE_PRESETS = [
    { label: '每天 04:00（推荐）', cron: '0 4 * * *' },
    { label: '每周日 03:00', cron: '0 3 * * 0' },
    { label: '每 6 小时', cron: '0 */6 * * *' },
    { label: '自定义', cron: '' }
  ];
  function fmtBytes(n) {
    var v = Number(n) || 0; if (v < 1024) return v + ' B'; if (v < 1048576) return (v / 1024).toFixed(1) + ' KiB';
    return v < 1073741824 ? (v / 1048576).toFixed(1) + ' MiB' : (v / 1073741824).toFixed(2) + ' GiB';
  }
  function fmtTime(s) {
    if (!s) return '—'; var d = new Date(s); if (isNaN(d.getTime())) return String(s);
    function p(v) { return v < 10 ? '0' + v : String(v); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function short(h) { return h ? String(h).slice(0, 8) : '—'; }
  // 基线 id 形如 bl-20261124-0210-7f3c9a12：前 8 位常常相同，列表里必须露出尾部才分得清。
  function idLabel(id) { var s = String(id || ''); return s.length > 16 ? s.slice(0, 3) + '…' + s.slice(-8) : s; }
  function baseName(p) { var s = String(p || ''); var i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone); add(c, el('span', 'dot ' + tone)); add(c, el('span', null, text)); return c;
  }
  function noticeCard(title, lines, tone) {
    var box = el('div', tone === 'warn' ? 'fw-callout-warn' : 'db-notice'); box.setAttribute('role', 'status');
    if (title) add(box, el('div', 'fw-callout-title', title));
    (lines || []).forEach(function (t) { add(box, el('p', 'fw-callout-text', t)); }); return box;
  }
  function panel(title) {
    var p = el('section', 'panel'), head = add(p, el('div', 'panel-head')); add(head, el('span', 'panel-title', title));
    return { panel: p, meta: add(head, el('span', 'panel-meta', '')) };
  }
  // ---------------- 前端态：扫描历史 / 已接受标记 / 基线扫描路径 ----------------
  function readLS(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key); if (!raw) return fallback;
      var v = JSON.parse(raw); return (v === null || v === undefined) ? fallback : v;
    } catch (e) { return fallback; } // 隐私模式 / 存储不可用：降级为仅本页内存态
  }
  function writeLS(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function isRun(run) { return !!(run && run.at && Array.isArray(run.rows)); }
  function loadHistory() {
    var list = readLS(LS_HISTORY, []);
    S.history = Array.isArray(list) ? list.filter(isRun) : [];
  }
  function recordRun(result) {
    var at = result.checked_at || new Date().toISOString();
    var rows = rowsFromCheck(result, at).slice(0, HISTORY_ROWS);
    var run = { at: at, baseline_id: result.baseline_id || '', ok: !!result.ok,
      summary: result.summary || { added: 0, modified: 0, removed: 0, unchanged: 0, skipped: 0 },
      unchanged: result.unchanged || 0, truncated: !!result.truncated, rows: rows };
    var list = [run];
    (S.history || []).forEach(function (old) { if (old.at !== at) list.push(old); });
    S.history = list.slice(0, HISTORY_RUNS);
    if (!writeLS(LS_HISTORY, S.history)) S.storageNote = '浏览器存储不可用，扫描记录只保留到本次刷新前';
  }
  function loadAcks() {
    var map = readLS(LS_ACKS, {});
    S.acks = (map && typeof map === 'object') ? map : {};
  }
  function rowKey(row) { return row.type + '|' + row.path + '|' + (row.newSha || '') + '|' + (row.oldSha || ''); }
  function ackOf(row) { return S.acks ? S.acks[rowKey(row)] : null; }
  function trimAcks() {
    var keys = Object.keys(S.acks || {});
    if (keys.length <= ACK_LIMIT) return;
    keys.sort(function (a, b) { return String((S.acks[a] || {}).at || '').localeCompare(String((S.acks[b] || {}).at || '')); });
    var drop = keys.slice(0, keys.length - ACK_LIMIT);
    drop.forEach(function (k) { delete S.acks[k]; });
  }
  function ackRow(row) {
    S.acks[rowKey(row)] = { at: new Date().toISOString() };
    trimAcks(); writeLS(LS_ACKS, S.acks);
    S.notice = { tone: 'ok', title: '已标记为接受', lines: [
      baseName(row.path) + ' 记为本机已确认（只是本页标记，基线没有变化）。',
      '要让这个变更正式进入基线，请点概览里的「新建基线」；想先看还有多少待处理，勾选「隐藏已接受」。'] };
    paintNotice(); paintOverview(); paintChanges();
  }
  function unackRow(row) {
    delete S.acks[rowKey(row)]; writeLS(LS_ACKS, S.acks); paintOverview(); paintChanges();
  }
  function loadRoots() {
    var map = readLS(LS_ROOTS, {});
    S.rootMap = (map && typeof map === 'object') ? map : {};
  }
  function rememberRoots(id, roots) {
    if (!id || !roots || !roots.length) return;
    S.rootMap[id] = roots.slice(0, 64);
    var keys = Object.keys(S.rootMap);
    if (keys.length > 20) keys.slice(0, keys.length - 20).forEach(function (k) { delete S.rootMap[k]; });
    writeLS(LS_ROOTS, S.rootMap);
  }
  // ---------------- 变更清单：分类 / 高危判定 / 去重 / 筛选 ----------------
  function startsWithAny(p, list) {
    for (var i = 0; i < list.length; i++) if (p.indexOf(list[i]) === 0) return true;
    return false;
  }
  function riskOf(path) {
    var p = String(path || '');
    if (startsWithAny(p, RISK_SYSTEM)) return { key: 'system', label: '系统关键', tone: 'fail', high: true };
    if (startsWithAny(p, RISK_WEB) || /\/public_html\//.test(p)) return { key: 'web', label: '站点与部署', tone: 'warn', high: true };
    return { key: 'other', label: '普通', tone: 'na', high: false };
  }
  function rowsFromCheck(result, runAt) {
    var rows = [], sev = Object.create(null), changes = result.changes || [], mods = result.modified || [], i;
    for (i = 0; i < changes.length; i++) sev[changes[i].path] = changes[i].severity;
    function push(type, path, oldSha, newSha, oldMode, newMode, list) {
      var risk = riskOf(path);
      rows.push({ type: type, path: path, risk: risk.key, riskLabel: risk.label, riskTone: risk.tone, high: risk.high,
        severity: sev[path] || (risk.high ? 'critical' : 'warning'),
        oldSha: oldSha || '', newSha: newSha || '', oldMode: oldMode || '', newMode: newMode || '',
        changes: list || [], at: runAt });
    }
    for (i = 0; i < (result.removed || []).length; i++) push('removed', result.removed[i]);
    for (i = 0; i < mods.length; i++) push('modified', mods[i].path, mods[i].old_sha256, mods[i].new_sha256, mods[i].old_mode, mods[i].new_mode, mods[i].changes);
    for (i = 0; i < (result.added || []).length; i++) push('added', result.added[i]);
    return rows;
  }
  function rangeStart(id) {
    var now = Date.now();
    if (id === '1h') return now - 3600000;
    if (id === '24h') return now - 86400000;
    if (id === '7d') return now - 604800000;
    return 0;
  }
  function runsInRange() {
    var list = (S.history || []).slice(), id = S.filters.range;
    if (id === 'latest') return list.slice(0, 1);
    var from = rangeStart(id);
    if (!from) return list;
    return list.filter(function (run) { var t = Date.parse(run.at); return isFinite(t) && t >= from; });
  }
  function visibleRows() {
    var seen = Object.create(null), out = [], q = S.filters.q;
    runsInRange().forEach(function (run) {
      (run.rows || []).forEach(function (row) {
        var key = rowKey(row);
        if (seen[key]) return; seen[key] = 1;
        if (S.filters.kind !== 'all' && row.type !== S.filters.kind) return;
        if (S.filters.high && !row.high) return;
        if (S.filters.hideAck && ackOf(row)) return;
        if (q && row.path.toLowerCase().indexOf(q) < 0) return;
        out.push(row);
      });
    });
    return out;
  }
  function changeText(row) {
    if (row.type === 'added') return '基线里没有，现在出现';
    if (row.type === 'removed') return '基线里有，现在消失';
    var parts = [];
    if (row.oldSha || row.newSha) parts.push('指纹 ' + short(row.oldSha) + ' → ' + short(row.newSha));
    if (row.oldMode !== row.newMode) parts.push('权限 ' + (row.oldMode || '—') + ' → ' + (row.newMode || '—'));
    (row.changes || []).forEach(function (c) { if (String(c).indexOf('mode') < 0) parts.push(String(c)); });
    return parts.length ? parts.join(' · ') : '内容或权限位有变化';
  }
  function parseParams(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (e) { return null; } }
    return typeof raw === 'object' ? raw : null;
  }
  // 扫描范围：优先本页记录的当前基线路径，其次定时扫描记录里已提交的路径（都不改后端）。
  function scanScope() {
    var id = S.status && S.status.latest_id;
    if (id && S.rootMap && S.rootMap[id] && S.rootMap[id].length) return S.rootMap[id].slice();
    var roots = [];
    (S.schedules || []).forEach(function (rec) {
      if (roots.length) return;
      var params = parseParams((rec.recommended_task || {}).params);
      if (params && params.paths && params.paths.length) roots = params.paths.slice(0, 64);
    });
    return roots;
  }
  function splitPaths(raw) {
    return String(raw || '').split(/[\s,，;；]+/).filter(function (s) { return !!s; });
  }
  function selectOf(options, value, onChange) {
    var sel = el('select', 'int-input int-select');
    options.forEach(function (o) { var opt = add(sel, el('option', null, o.label)); opt.value = o.id; });
    sel.value = value;
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }
  function checkboxOf(label, checked, onChange) {
    var wrap = el('label', 'int-check'), input = add(wrap, el('input'));
    input.type = 'checkbox'; input.checked = !!checked;
    input.addEventListener('change', function () { onChange(input.checked); });
    add(wrap, el('span', null, label));
    return wrap;
  }
  function stamp() {
    var d = new Date();
    function p(v) { return v < 10 ? '0' + v : String(v); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  // ---------------- 通知条 ----------------
  function paintNotice() {
    var host = S.noticeHost; if (!host) return;
    host.textContent = '';
    if (S.storageNote) host.appendChild(noticeCard('扫描记录只存在本页', [S.storageNote], 'warn'));
    if (S.notice) host.appendChild(noticeCard(S.notice.title, S.notice.lines, S.notice.tone));
  }
  // ---------------- 概览：基线状态 + 最近一次扫描结论 + 扫描范围 + 一键动作 ----------------
  function paintOverview() {
    var host = S.overviewHost; if (!host) return; host.textContent = '';
    if (S.error) {
      var ebox = noticeCard('状态读取失败', [S.error + (S.hint ? '（提示：' + S.hint + '）' : '')], 'warn');
      btn(ebox, '重试', 'btn btn-ghost', loadStatus); add(host, ebox); return;
    }
    if (!S.status) { add(host, el('div', 'muted int-pad', '正在读取基线状态…')); return; }
    var st = S.status, body, grid, ops, latest = (S.history || [])[0];
    if (!st.has_baseline) {
      body = add(host, el('div', 'empty-state int-empty'));
      add(body, el('p', 'int-empty-title', '尚未建立完整性基线'));
      add(body, el('p', 'empty-state-text', '基线会记录关键文件的指纹（sha256），之后每次扫描都能看出谁新增、谁被改、谁消失了。'));
      btn(body, '建立基线', 'btn btn-primary', function () { openBaseline(false); }).setAttribute('data-action', 'int-new-baseline');
      return;
    }
    body = add(host, el('div', 'int-status-body'));
    var top = add(body, el('div', 'int-status-top'));
    var ok = st.last_check_ok;
    top.appendChild(chip(ok === false ? 'fail' : (ok === true ? 'ok' : 'na'),
      ok === false ? '上次扫描有改动' : (ok === true ? '上次扫描通过' : '尚未扫描')));
    top.appendChild(chip('na', '当前基线 ' + idLabel(st.latest_id)));
    top.appendChild(chip('na', '共 ' + (st.baseline_count || 0) + ' 个版本'));
    if (st.latest_note) top.appendChild(el('span', 'muted', st.latest_note));
    grid = add(body, el('div', 'int-stats'));
    [['建立时间', fmtTime(st.created_at)], ['记录文件', (st.entries || 0) + ' 个'],
      ['合计体积', fmtBytes(st.total_bytes)], ['上次扫描', st.last_check_at ? fmtTime(st.last_check_at) : '从未']]
      .forEach(function (kv) {
        var cell = add(grid, el('div', 'int-stat'));
        add(cell, el('span', 'int-stat-label', kv[0])); add(cell, el('span', 'int-stat-value', kv[1]));
      });
    // 最近一次扫描结果摘要：本页有记录就用记录（含高危计数），否则只如实说「本页无记录」。
    var sum = latest && latest.summary ? latest.summary : null, srow = add(body, el('div', 'int-sumrow'));
    if (sum) {
      var highCount = 0;
      (latest.rows || []).forEach(function (r) { if (r.high) highCount++; });
      [['新增', sum.added || 0, 'warn'], ['修改', sum.modified || 0, 'warn'], ['删除', sum.removed || 0, 'fail'],
        ['高危', highCount, 'fail'], ['未变化', sum.unchanged || (latest.unchanged || 0), 'na']].forEach(function (kv) {
        var box = add(srow, el('div', 'int-sum int-sum-' + kv[2]));
        add(box, el('span', 'int-sum-num', kv[1])); add(box, el('span', 'int-sum-label', kv[0]));
      });
      add(body, el('p', 'field-hint', '这次扫描：' + fmtTime(latest.at) +
        (latest.truncated ? '（结果被条目上限截断，结论可能不完整）' : '') + '；点「变更追踪」可按时间范围回看。'));
    } else {
      add(body, el('p', 'field-hint', st.last_check_at
        ? '上次扫描发生在 「' + fmtTime(st.last_check_at) + '」，但本页没有逐条变更记录（换过浏览器或清过存储就会这样）。点「立即扫描」补一次。'
        : '还没有扫描过：点「立即扫描」比对一次，改动会列在下方「变更追踪」。'));
    }
    var scope = scanScope(), sline = add(body, el('div', 'int-scope'));
    add(sline, el('span', 'int-scope-label', '扫描范围'));
    if (scope.length) {
      add(sline, el('span', 'int-scope-count', scope.length + ' 个路径'));
      var chips = add(sline, el('div', 'int-chips'));
      scope.slice(0, 6).forEach(function (p) { chips.appendChild(el('code', 'int-scope-path', p)); });
      if (scope.length > 6) add(chips, el('span', 'muted', '…另有 ' + (scope.length - 6) + ' 个'));
    } else {
      add(sline, el('span', 'muted', '本页还没有记录扫描路径；用本页「新建基线」重建一次会自动记下，已配置的定时扫描路径也会显示在这里。'));
    }
    ops = add(body, el('div', 'int-ops'));
    var scanBtn = btn(ops, S.busy ? '正在扫描…' : '立即扫描', 'btn btn-primary', runCheck);
    scanBtn.disabled = S.busy; scanBtn.setAttribute('data-action', 'int-scan');
    btn(ops, '新建基线', 'btn', function () { openBaseline(true); }).setAttribute('data-action', 'int-new-baseline');
    btn(ops, '导出变更清单', 'btn btn-ghost', exportChanges).setAttribute('data-action', 'int-export');
  }
  function loadStatus() {
    invoke('status', {}).then(function (d) {
      if (S.destroyed) return; S.status = d; S.error = ''; S.hint = ''; paintOverview();
    }, function (err) {
      if (S.destroyed) return; S.error = err.message; S.hint = err.hint || ''; if (!S.status) paintOverview();
    });
  }
  // ---------------- 变更追踪：筛选 + 高危高亮 + 单条接受 / 恢复指引 ----------------
  function paintFilterBar(host) {
    var bar = add(host, el('div', 'int-filters'));
    var g1 = add(bar, el('label', 'int-filter'));
    add(g1, el('span', 'int-label', '时间范围'));
    g1.appendChild(selectOf(RANGES, S.filters.range, function (v) { S.filters.range = v; paintChanges(); }));
    var g2 = add(bar, el('label', 'int-filter'));
    add(g2, el('span', 'int-label', '变更类型'));
    g2.appendChild(selectOf(KINDS, S.filters.kind, function (v) { S.filters.kind = v; paintChanges(); }));
    var g3 = add(bar, el('label', 'int-filter int-filter-q'));
    add(g3, el('span', 'int-label', '按路径搜索'));
    var q = add(g3, el('input', 'int-input')); q.type = 'search'; q.placeholder = '/etc/nginx/nginx.conf 或 nginx'; q.value = S.filters.q;
    var timer = null;
    q.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; S.filters.q = q.value.trim().toLowerCase(); paintChanges(); }, 160);
    });
    var g4 = add(bar, el('div', 'int-filter int-filter-flags'));
    g4.appendChild(checkboxOf('只看高危目录', S.filters.high, function (v) { S.filters.high = v; paintChanges(); }));
    g4.appendChild(checkboxOf('隐藏已接受', S.filters.hideAck, function (v) { S.filters.hideAck = v; paintChanges(); }));
  }
  function paintChanges() {
    var host = S.changesHost; if (!host) return; host.textContent = '';
    if (S.checkError) {
      var ebox = noticeCard('扫描未完成', [S.checkError + (S.checkHint ? '（提示：' + S.checkHint + '）' : '')], 'warn');
      btn(ebox, '建立基线', 'btn btn-primary', function () { openBaseline(false); }); add(host, ebox); return;
    }
    var runs = runsInRange();
    if (!runs.length) {
      var empty = add(host, el('div', 'empty-state int-empty'));
      add(empty, el('p', 'int-empty-title', S.filters.range === 'latest' ? '还没有扫描记录' : '这个时间范围内没有扫描记录'));
      add(empty, el('p', 'empty-state-text', '点「立即扫描」比对一次当前文件与基线；结果会按新增 / 修改 / 删除列在这里，高危目录单独高亮。'));
      var go = btn(empty, S.busy ? '正在扫描…' : '立即扫描', 'btn btn-primary', runCheck); go.disabled = S.busy;
      if (!S.status || !S.status.has_baseline) {
        var go2 = btn(empty, '先建立基线', 'btn btn-ghost', function () { openBaseline(false); });
        go2.setAttribute('data-action', 'int-go-baseline');
      }
      return;
    }
    paintFilterBar(host);
    var rows = visibleRows(), run = runs[0], head = add(host, el('div', 'int-verdict ' + (run.ok ? 'is-ok' : 'is-fail')));
    add(head, el('span', 'int-verdict-dot'));
    var total = (run.rows || []).length;
    add(head, el('span', 'int-verdict-text', run.ok ? '未检测到改动' : (total ? '检测到 ' + total + ' 处改动' : '检测到改动但清单为空')));
    add(head, el('span', 'int-verdict-meta', '最近一次扫描 ' + fmtTime(run.at) + ' · 基线 ' + idLabel(run.baseline_id) +
      (runs.length > 1 ? ' · 当前范围含 ' + runs.length + ' 次扫描' : '')));
    var highRows = rows.filter(function (r) { return r.high; }), stat = add(host, el('div', 'int-sumrow int-sumrow-flat'));
    [['可见变更', rows.length, 'na'], ['系统关键', highRows.filter(function (r) { return r.risk === 'system'; }).length, 'fail'],
      ['站点与部署', highRows.filter(function (r) { return r.risk === 'web'; }).length, 'warn'],
      ['已接受', rows.filter(function (r) { return !!ackOf(r); }).length, 'ok']].forEach(function (kv) {
      var box = add(stat, el('div', 'int-sum int-sum-' + kv[2]));
      add(box, el('span', 'int-sum-num', kv[1])); add(box, el('span', 'int-sum-label', kv[0]));
    });
    if (!rows.length) {
      var none = add(host, el('div', 'empty-state int-empty int-empty-small'));
      add(none, el('p', 'int-empty-title', '当前筛选下没有变更'));
      add(none, el('p', 'empty-state-text', '可能被筛掉了：换个时间范围 / 类型，或取消「隐藏已接受」「只看高危」。'));
      btn(none, '清除筛选', 'btn', function () {
        S.filters.range = 'latest'; S.filters.kind = 'all'; S.filters.high = false; S.filters.hideAck = false; S.filters.q = '';
        paintChanges();
      });
      return;
    }
    var table = add(host, el('table', 'int-table int-changes'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['类型', '风险', '路径', '变化', '时间', '操作'].forEach(function (c) { add(htr, el('th', null, c)); });
    var tbody = add(table, el('tbody'));
    rows.slice(0, 400).forEach(function (row) { paintRow(tbody, row); });
    if (rows.length > 400) add(host, el('p', 'field-hint', '还有 ' + (rows.length - 400) + ' 条未显示（表格最多列 400 条）；用筛选或缩小时间范围查看，导出的 CSV 包含全部可见行。'));
    add(host, el('p', 'field-hint', '「接受」只是本页标记，不会改基线；要让变更进入基线，请点概览里的「新建基线」。删除与修改类变更点「恢复…」会给出恢复步骤，并能当场校验是否恢复成功。'));
  }
  function paintRow(tbody, row) {
    var tr = add(tbody, el('tr', row.high ? 'int-row int-row-high' : 'int-row'));
    if (ackOf(row)) tr.className += ' int-row-acked';
    var td1 = add(tr, el('td')); td1.setAttribute('data-label', '类型');
    var meta = KIND_META[row.type] || KIND_META.modified;
    td1.appendChild(chip(meta.tone, meta.sign + ' ' + meta.text));
    var td2 = add(tr, el('td')); td2.setAttribute('data-label', '风险');
    td2.appendChild(chip(row.riskTone, row.riskLabel));
    if (row.severity === 'critical' && row.risk !== 'system') td2.appendChild(chip('fail', '系统级'));
    var td3 = add(tr, el('td', 'int-path')); td3.setAttribute('data-label', '路径');
    add(td3, el('code', 'int-path-code', row.path));
    if (ackOf(row)) {
      var acked = ackOf(row), c = chip('ok', '已接受'); c.title = '接受于 ' + fmtTime(acked.at); td3.appendChild(c);
    }
    var td4 = add(tr, el('td', 'int-chg-cell')); td4.setAttribute('data-label', '变化');
    add(td4, el('span', 'int-chg-text', changeText(row)));
    var td5 = add(tr, el('td', 'int-time')); td5.setAttribute('data-label', '时间');
    add(td5, el('span', 'muted', fmtTime(row.at)));
    var td6 = add(tr, el('td', 'int-actions')); td6.setAttribute('data-label', '操作');
    if (ackOf(row)) {
      btn(td6, '撤销接受', 'btn btn-ghost int-mini', function () { unackRow(row); });
    } else {
      var ack = btn(td6, '接受', 'btn int-mini', function () { ackRow(row); });
      ack.setAttribute('data-action', 'int-ack');
      var rec = btn(td6, '恢复…', 'btn btn-ghost int-mini', function () { openRecover(row); });
      rec.setAttribute('data-action', 'int-recover');
    }
  }
  // ---------------- 弹层：通用壳 ----------------
  function closeDialog() {
    var d = S.dialog; if (d && d.wrap && d.wrap.parentNode) d.wrap.parentNode.removeChild(d.wrap); S.dialog = null;
  }
  function openDialog(title, hint) {
    closeDialog();
    var wrap = el('div', 'int-backdrop'); wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', title);
    var box = add(wrap, el('section', 'int-dialog')), head = add(box, el('header', 'int-dialog-head'));
    add(head, el('h3', 'int-dialog-title', title));
    btn(head, '关闭', 'btn btn-ghost', closeDialog);
    if (hint) { (hint instanceof Array ? hint : [hint]).forEach(function (t) { add(box, el('p', 'int-dialog-hint', t)); }); }
    // body 先入 DOM、ops 后入 DOM：调用方往 body 里加内容时按钮组自然留在最下方（不被内容顶到上面）。
    var bodyEl = add(box, el('div', 'int-dialog-body'));
    var ops = add(box, el('div', 'int-dialog-ops'));
    S.dialog = { wrap: wrap, box: box, body: bodyEl, ops: ops }; document.body.appendChild(wrap);
    return S.dialog;
  }
  // ---------------- 建立 / 重建基线（预设多选 + 自定义路径） ----------------
  function openBaseline(rebuild) {
    var d = openDialog(rebuild ? '重建基线' : '建立基线',
      ['选择要保护的关键路径（可多选）：基线会记录这些文件的 sha256 指纹；重建会用当前文件覆盖当前基线，旧版本仍留在「基线版本」里。']);
    var chosen = Object.create(null), presetBtns = [], pick = add(d.body, el('div', 'int-presets'));
    (S.roots || []).forEach(function (p) { if (p) chosen[p] = true; });
    function syncPresets() { presetBtns.forEach(function (it) { it.node.classList.toggle('is-on', !!chosen[it.path]); }); }
    PRESETS.forEach(function (p) {
      var b = el('button', 'int-preset'); b.type = 'button';
      add(b, el('span', 'int-preset-name', p.name)); add(b, el('code', 'int-preset-path', p.path));
      add(b, el('span', 'int-preset-note', p.note));
      on(b, function () { if (chosen[p.path]) delete chosen[p.path]; else chosen[p.path] = true; syncPresets(); });
      presetBtns.push({ node: b, path: p.path }); pick.appendChild(b);
    });
    syncPresets();
    var f1 = add(d.body, el('label', 'int-field')), f2 = add(d.body, el('label', 'int-field'));
    add(f1, el('span', 'int-label', '自定义路径（多个用逗号或空格分隔）'));
    add(f2, el('span', 'int-label', '排除规则（glob，多个用逗号分隔）'));
    var custom = add(f1, el('input', 'int-input')), exclude = add(f2, el('input', 'int-input'));
    custom.type = 'text'; custom.placeholder = '/srv/app /data'; exclude.type = 'text'; exclude.value = DEF_EXCLUDE;
    var errLine = add(d.box, el('p', 'int-dialog-err'));
    var submit = btn(d.ops, rebuild ? '重建基线' : '建立基线', 'btn btn-primary', doSubmit);
    btn(d.ops, '取消', 'btn', closeDialog);
    submit.setAttribute('data-action', 'int-baseline-submit');
    S.dialog.chosen = chosen; S.dialog.custom = custom; S.dialog.exclude = exclude; S.dialog.err = errLine; S.dialog.submit = submit;
    function doSubmit() {
      if (S.busy) return;
      var roots = Object.keys(chosen);
      splitPaths(custom.value).forEach(function (p) { if (roots.indexOf(p) < 0) roots.push(p); });
      if (!roots.length) { errLine.textContent = '请至少选择一个路径（点上面的预设，或填写自定义绝对路径）。'; return; }
      S.busy = true; errLine.textContent = ''; submit.disabled = true; submit.textContent = '正在建立…';
      invoke('baseline', { paths: roots, exclude: splitPaths(exclude.value) }).then(function (r) {
        S.busy = false; closeDialog(); S.roots = roots; S.checkError = ''; rememberRoots(r && r.id, roots);
        var lines = ['路径 ' + roots.join('、') + ' · 记录 ' + (r.entries || 0) + ' 个文件 · ' +
          fmtBytes(r.total_bytes) + ' · 耗时 ' + (r.duration_ms || 0) + ' ms'], warn = r.warnings || [];
        S.notice = (r.entries || 0) > 0 ? { tone: 'ok', title: '基线已建立', lines: lines }
          : { tone: 'warn', title: '基线已保存，但一条文件都没记录',
            lines: lines.concat(warn.length ? warn : ['所选路径下没有可读文件，请换一个路径重建。']) };
        paintNotice(); paintOverview(); loadStatus(); loadBaselines();
      }, function (err) {
        S.busy = false; submit.disabled = false; submit.textContent = rebuild ? '重建基线' : '建立基线';
        errLine.textContent = '建立失败：' + err.message + (err.hint ? '（' + err.hint + '）' : '') +
          '。只能扫描 ' + ROOTS_TEXT + '；路径须为已存在的绝对路径，请换一个再试。';
      });
    }
  }
  // ---------------- 单条变更「恢复…」：步骤指引 + 当场校验是否已恢复 ----------------
  function openRecover(row) {
    var d = openDialog('恢复「' + baseName(row.path) + '」',
      ['完整性插件只做检测、不保存文件内容，无法自己把文件回滚——恢复要借助备份功能或你自己的备份。']);
    var kv = add(d.body, el('div', 'int-kv'));
    [['文件路径', row.path], ['变更类型', (KIND_META[row.type] || {}).text || row.type],
      ['旧指纹 sha256', row.oldSha || '（后端只回路径，未提供旧指纹）'], ['当前指纹 sha256', row.newSha || '（文件已不存在）']]
      .forEach(function (pair) {
        var line = add(kv, el('div', 'int-kv-row'));
        add(line, el('span', 'int-kv-key', pair[0])); add(line, el('code', 'int-kv-val', pair[1]));
      });
    var steps = add(d.body, el('ol', 'int-steps'));
    [row.type === 'added'
      ? '先确认这个新文件是不是你自己或某个服务刚写下的（看下面的路径与时间）。'
      : '用备份功能（备份页的「恢复」）或你自己的备份，把这个文件恢复成基线里的版本。',
      row.oldSha ? '恢复后点下面「校验是否已恢复」：它会用旧指纹比对当前文件，一致才算真的恢复好。'
        : '旧指纹没有留在这里，恢复后请用本页「单文件校验」核对文件内容。',
      '确认无误后再点「接受」，或点概览「新建基线」把当前状态写进基线。'].forEach(function (t) { add(steps, el('li', 'int-step', t)); });
    var out = add(d.body, el('div', 'int-recover-out'));
    if (row.oldSha) {
      var check = btn(d.ops, '校验是否已恢复', 'btn btn-primary', function () {
        out.textContent = ''; add(out, el('div', 'muted int-pad', '正在计算 sha256…'));
        check.disabled = true;
        invoke('verify_file', { path: row.path, expected_sha256: row.oldSha }).then(function (r) {
          check.disabled = false; out.textContent = '';
          var head = add(out, el('div', 'int-verdict ' + (r.match ? 'is-ok' : 'is-fail')));
          add(head, el('span', 'int-verdict-dot'));
          add(head, el('span', 'int-verdict-text', r.match ? '已恢复：当前文件与基线指纹一致' : '还没恢复：当前文件与基线指纹不一致'));
          add(out, el('pre', 'int-pre', '当前 sha256：' + (r.actual_sha256 || '—') + '\n基线 sha256：' + row.oldSha));
        }, function (err) {
          check.disabled = false; out.textContent = '';
          out.appendChild(noticeCard('校验失败', [err.message + (err.hint ? '（' + err.hint + '）' : '') +
            '。文件可能已被删除或路径不可读，请先用备份恢复文件再校验。'], 'warn'));
        });
      });
      check.setAttribute('data-action', 'int-verify-recovered');
    }
    var copy = btn(d.ops, '复制路径', 'btn', function () {
      copy.disabled = true;
      function done() { copy.textContent = '已复制'; setTimeout(function () { copy.textContent = '复制路径'; copy.disabled = false; }, 1500); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(row.path).then(done, function () { copy.disabled = false; copy.textContent = '复制失败，请手动选中路径'; });
      } else { copy.disabled = false; copy.textContent = '请手动选中上方路径复制'; }
    });
    copy.setAttribute('data-action', 'int-copy-path');
    var nav = btn(d.ops, '去备份页', 'btn btn-ghost', function () {
      if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('backup');
      else window.location.hash = '#/backup';
    });
    nav.setAttribute('data-action', 'int-goto-backup');
  }
  // ---------------- 基线版本：列表 + 恢复到该版本 ----------------
  function paintBaselines() {
    var host = S.baselineHost; if (!host) return; host.textContent = '';
    if (S.baselineError) { host.appendChild(noticeCard('基线列表读取失败', [S.baselineError], 'warn')); return; }
    var list = S.baselines || [];
    if (!list.length) {
      var empty = add(host, el('div', 'empty-state int-empty'));
      add(empty, el('p', 'int-empty-title', '还没有任何基线版本'));
      add(empty, el('p', 'empty-state-text', '建立一次基线后，这里会按时间列出每个版本；定时扫描需要一个当前基线。'));
      btn(empty, '建立基线', 'btn btn-primary', function () { openBaseline(false); });
      return;
    }
    var table = add(host, el('table', 'int-table int-baselines-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['版本', '建立时间', '文件', '体积', '上次扫描', '状态', '操作'].forEach(function (c) { add(htr, el('th', null, c)); });
    var tbody = add(table, el('tbody'));
    list.forEach(function (b) {
      var tr = add(tbody, el('tr')), idCell = add(tr, el('td', 'mono'));
      idCell.setAttribute('data-label', '版本');
      var idText = add(idCell, el('span', null, idLabel(b.id))); idText.title = b.id;
      if (b.current) add(idCell, chip('ok', '当前'));
      add(tr, el('td', null, fmtTime(b.created_at))).setAttribute('data-label', '建立时间');
      add(tr, el('td', null, (b.entries || 0) + ' 个')).setAttribute('data-label', '文件');
      add(tr, el('td', null, fmtBytes(b.total_bytes))).setAttribute('data-label', '体积');
      add(tr, el('td', null, b.last_check_at ? fmtTime(b.last_check_at) : '从未')).setAttribute('data-label', '上次扫描');
      var st = add(tr, el('td')); st.setAttribute('data-label', '状态');
      if (b.last_check_ok === true) st.appendChild(chip('ok', '通过'));
      else if (b.last_check_ok === false) st.appendChild(chip('fail', '有改动'));
      else st.appendChild(chip('na', '未扫描'));
      if (b.note) { var note = add(st, el('span', 'muted', ' ' + b.note)); note.title = b.note; }
      var ops = add(tr, el('td', 'int-actions')); ops.setAttribute('data-label', '操作');
      if (!b.current) {
        var rb = btn(ops, '恢复到此版本', 'btn btn-ghost int-mini', function () { openRestore(b); });
        rb.setAttribute('data-action', 'int-restore-version');
      } else {
        add(ops, el('span', 'muted', '定时扫描使用此版本'));
      }
    });
    if (typeof S.keep === 'number' && S.keep > 0) add(host, el('p', 'field-hint', '最多保留 ' + S.keep + ' 个版本；当前版本参与定时扫描。'));
  }
  function loadBaselines() {
    if (!S.baselineHost) return;
    invoke('baseline.list', { limit: 20 }).then(function (d) {
      if (S.destroyed) return;
      S.baselines = Array.isArray(d.baselines) ? d.baselines : []; S.keep = d.keep; S.baselineError = '';
      paintBaselines(); paintBaselinePick();
    }, function (err) {
      if (S.destroyed) return; S.baselineError = err.message + (err.hint ? '（' + err.hint + '）' : ''); paintBaselines();
    });
  }
  function openRestore(item) {
    var d = openDialog('恢复到这个基线版本？', [
      '恢复的是「基线记录」，不是文件内容：会用这个版本的指纹替换当前基线，并把当前基线备份 + 归档成历史版本（随时能再切回来）。',
      '恢复后插件会自动复核当前文件与目标基线的差异，复核结果会显示在下方通知里。']);
    var kv = add(d.body, el('div', 'int-kv'));
    [['要恢复到的版本', item.id], ['该版本建立时间', fmtTime(item.created_at)],
      ['该版本记录文件', (item.entries || 0) + ' 个（' + fmtBytes(item.total_bytes) + '）']].forEach(function (pair) {
      var line = add(kv, el('div', 'int-kv-row'));
      add(line, el('span', 'int-kv-key', pair[0])); add(line, el('code', 'int-kv-val', pair[1]));
    });
    var errLine = add(d.body, el('p', 'int-dialog-err'));
    var submit = btn(d.ops, '确认恢复', 'btn btn-primary', function () {
      submit.disabled = true; submit.textContent = '正在恢复…'; errLine.textContent = '';
      invoke('restore', { baseline_id: item.id }).then(function (r) {
        closeDialog();
        var lines = [r.message || (r.restored ? '已恢复为历史版本' : '当前基线已是该版本，无需恢复')];
        if (r.backup_path) lines.push('恢复前的当前基线已备份：' + r.backup_path);
        if (typeof r.changes === 'number' && !r.verified) lines.push('复核发现当前文件与该基线仍有 ' + r.changes + ' 处不一致——基线已切换，但文件内容没有被改动。');
        if (r.hint) lines.push(r.hint);
        S.notice = { tone: r.verified ? 'ok' : 'warn', title: r.restored ? '基线已恢复到历史版本' : '无需恢复', lines: lines };
        paintNotice(); loadStatus(); loadBaselines();
      }, function (err) {
        submit.disabled = false; submit.textContent = '确认恢复';
        errLine.textContent = '恢复失败：' + err.message + (err.hint ? '（' + err.hint + '）' : '') + '。请刷新「基线版本」后重试。';
      });
    });
    submit.setAttribute('data-action', 'int-restore-confirm');
    btn(d.ops, '取消', 'btn', closeDialog);
  }
  // ---------------- 导出变更清单（CSV，纯前端） ----------------
  function csvCell(v) {
    var s = String(v === undefined || v === null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportChanges() {
    var rows = visibleRows();
    if (!rows.length) {
      S.notice = { tone: 'warn', title: '当前筛选下没有可导出的变更', lines: ['先点「立即扫描」，或把时间范围 / 类型放宽一点再导出。'] };
      paintNotice(); return;
    }
    var lines = ['类型,风险,路径,变化,旧sha256,新sha256,权限变化,扫描时间,是否已接受'];
    rows.forEach(function (row) {
      lines.push([(KIND_META[row.type] || {}).text || row.type, row.riskLabel, row.path, changeText(row),
        row.oldSha, row.newSha, row.oldMode === row.newMode ? '' : (row.oldMode + ' -> ' + row.newMode),
        row.at, ackOf(row) ? '是' : '否'].map(csvCell).join(','));
    });
    var name = 'integrity-changes-' + stamp() + '.csv';
    try {
      var url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
      var a = el('a'); a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      S.notice = { tone: 'ok', title: '变更清单已导出', lines: [rows.length + ' 条记录 · ' + name + '（utf-8 CSV，可直接给审计用）'] };
    } catch (e) {
      S.notice = { tone: 'warn', title: '导出失败', lines: ['浏览器拒绝了文件下载，请换一个浏览器或允许本站下载后重试。'] };
    }
    paintNotice();
  }
  // ---------------- 定时扫描（schedule.get / set，任务交给内核调度器） ----------------
  function paintSchedule() {
    var host = S.scheduleHost; if (!host) return; host.textContent = '';
    if (S.scheduleError) { host.appendChild(noticeCard('定时扫描读取失败', [S.scheduleError], 'warn')); return; }
    var records = S.schedules || [];
    add(host, el('p', 'field-hint', '这里只展示插件给出的任务描述，不代表内核任务是否真的在跑；下方表单会把描述提交给内核调度器后才生效。'));
    if (!records.length) {
      var empty = add(host, el('div', 'empty-state int-empty'));
      add(empty, el('p', 'int-empty-title', '还没有定时扫描'));
      add(empty, el('p', 'empty-state-text', '选一个预设时间、挑好要扫描的路径，一次提交就建好；不需要手写 cron。'));
      if (S.scheduleHint) add(empty, el('p', 'field-hint', S.scheduleHint));
      return;
    }
    var table = add(host, el('table', 'int-table int-schedules-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['任务名', '频率', '下次执行', '状态'].forEach(function (c) { add(htr, el('th', null, c)); });
    var tbody = add(table, el('tbody'));
    records.forEach(function (r) {
      var task = r.recommended_task || {}, tr = add(tbody, el('tr'));
      add(tr, el('td', 'mono', r.name || task.name || '—')).setAttribute('data-label', '任务名');
      var freq = add(tr, el('td')); freq.setAttribute('data-label', '频率');
      add(freq, el('span', null, humanSchedule(task.schedule || '')));
      add(tr, el('td', null, fmtTime(r.next_run_at))).setAttribute('data-label', '下次执行');
      var st = add(tr, el('td')); st.setAttribute('data-label', '状态');
      st.appendChild(chip(task.enabled === false ? 'na' : 'ok', task.enabled === false ? '已停用' : '已提交调度'));
      if (r.hint) { var hint = add(st, el('span', 'muted', ' ' + r.hint)); hint.title = r.hint; }
    });
  }
  function loadSchedules() {
    if (!S.scheduleHost) return;
    invoke('schedule.get', {}).then(function (d) {
      if (S.destroyed) return;
      S.schedules = Array.isArray(d.records) ? d.records : []; S.scheduleHint = d.hint || ''; S.scheduleError = '';
      paintSchedule(); paintOverview();
    }, function (err) {
      if (S.destroyed) return; S.scheduleError = err.message + (err.hint ? '（' + err.hint + '）' : ''); paintSchedule();
    });
  }
  function paintBaselinePick() {
    var sel = S.scheduleBaseline; if (!sel) return;
    var keepValue = sel.value; sel.textContent = '';
    var auto = add(sel, el('option', null, '使用当前基线（推荐）')); auto.value = '';
    (S.baselines || []).forEach(function (b) {
      var opt = add(sel, el('option', null, idLabel(b.id) + ' · ' + fmtTime(b.created_at) + (b.current ? '（当前）' : '')));
      opt.value = b.id;
    });
    if (keepValue) sel.value = keepValue;
  }
  function buildScheduleForm(host) {
    var panelHost = add(host, el('div', 'int-sched-form'));
    var form = add(panelHost, el('form', 'int-inline-form'));
    var presetField = add(form, el('label', 'int-field'));
    add(presetField, el('span', 'int-label', '扫描频率（预设优先，不写 cron）'));
    var preset = add(presetField, el('select', 'int-input'));
    SCHEDULE_PRESETS.forEach(function (p, i) { var o = add(preset, el('option', null, p.label)); o.value = String(i); });
    var customField = add(form, el('label', 'int-field')); customField.style.display = 'none';
    add(customField, el('span', 'int-label', '自定义 cron 表达式（高级）'));
    var custom = add(customField, el('input', 'int-input')); custom.type = 'text'; custom.placeholder = '0 4 * * *';
    var pathField = add(form, el('label', 'int-field'));
    add(pathField, el('span', 'int-label', '要扫描的路径（逗号或空格分隔，至少一个）'));
    var paths = add(pathField, el('input', 'int-input')); paths.type = 'text';
    var scope = scanScope();
    paths.value = (scope.length ? scope : (S.roots && S.roots.length ? S.roots : ['/etc', '/usr/bin'])).join(', ');
    var excludeField = add(form, el('label', 'int-field'));
    add(excludeField, el('span', 'int-label', '排除规则（可选）'));
    var exclude = add(excludeField, el('input', 'int-input')); exclude.type = 'text'; exclude.value = DEF_EXCLUDE;
    var baselineField = add(form, el('label', 'int-field'));
    add(baselineField, el('span', 'int-label', '基于哪个基线（可选）'));
    var baselineSel = add(baselineField, el('select', 'int-input')); S.scheduleBaseline = baselineSel;
    var timeoutField = add(form, el('label', 'int-field'));
    add(timeoutField, el('span', 'int-label', '单次扫描超时（秒，可选）'));
    var timeout = add(timeoutField, el('input', 'int-input')); timeout.type = 'number'; timeout.min = '1'; timeout.max = '3600'; timeout.value = '1800';
    var msg = add(form, el('div', 'int-dialog-err'));
    var ops = add(form, el('div', 'int-dialog-ops'));
    var submit = btn(ops, '创建定时扫描', 'btn btn-primary', submitSchedule);
    preset.addEventListener('change', function () { customField.style.display = preset.value === String(SCHEDULE_PRESETS.length - 1) ? '' : 'none'; });
    function submitSchedule() {
      var chosen = SCHEDULE_PRESETS[Number(preset.value)] || SCHEDULE_PRESETS[0];
      var cron = chosen.cron || custom.value.trim();
      var roots = splitPaths(paths.value);
      msg.textContent = '';
      if (!cron) { msg.textContent = '请选择预设频率，或填写自定义 cron 表达式。'; return; }
      if (!roots.length) { msg.textContent = '请至少填一个要扫描的路径（例如 /etc）。'; return; }
      submit.disabled = true;
      var params = { schedule: cron, paths: roots, exclude: splitPaths(exclude.value) };
      if (baselineSel.value) params.baseline_id = baselineSel.value;
      var secs = parseInt(timeout.value, 10);
      if (!isNaN(secs) && secs >= 1 && secs <= 3600) params.timeout_s = secs;
      invoke('schedule.set', params).then(function (r) {
        var task = r.recommended_task || {};
        return postScheduler(task).then(function (created) {
          submit.disabled = false;
          S.notice = { tone: 'ok', title: '定时扫描已提交给内核调度器', lines: [
            '频率：' + humanSchedule(task.schedule || cron) + '；下次执行：' + fmtTime(r.next_run_at),
            '任务：' + (task.name || '—') + (created && created.id ? '（' + created.id + '）' : '') +
              '；插件本身不起定时器，由内核调度（G-19）'] };
          if (r.hint) S.notice.lines.push(r.hint);
          paintNotice(); loadSchedules(); loadBaselines();
        });
      }, function (err) {
        submit.disabled = false;
        if (err.code === 'E_NOTFOUND') {
          msg.textContent = '还没有可用基线：请先点上方「建立基线」，再回来创建定时扫描。';
          var go = btn(ops, '先去建立基线', 'btn', function () { openBaseline(false); });
          go.setAttribute('data-action', 'int-go-baseline');
          return;
        }
        msg.textContent = '创建失败：' + err.message + (err.hint ? '（' + err.hint + '）' : '');
      }).catch(function (err) {
        submit.disabled = false;
        msg.textContent = '任务描述已生成，但提交内核调度失败：' + err.message + '；请稍后重试（不会重复建基线）。';
      });
    }
  }
  // ---------------- 立即扫描 ----------------
  function runCheck() {
    if (S.busy) return;
    S.busy = true; S.checkError = ''; S.checkHint = '';
    paintOverview(); paintChanges();
    invoke('check', {}).then(function (r) {
      if (S.destroyed) return;
      S.busy = false; recordRun(r); paintOverview(); paintChanges(); loadStatus(); loadBaselines();
    }, function (err) {
      if (S.destroyed) return;
      S.busy = false; S.checkError = err.message; S.checkHint = err.hint || '';
      paintChanges(); paintOverview();
    });
  }
  // ---------------- 单文件校验 ----------------
  function verifyFile() {
    var out = S.verifyOut, path = S.verifyPath.value.trim(), expect = S.verifySha.value.trim(), head;
    out.textContent = '';
    if (!path || !expect) { out.appendChild(noticeCard('缺少输入', ['请填写文件路径与期望的 sha256（64 位十六进制）。'], 'warn')); return; }
    out.appendChild(el('div', 'muted int-pad', '正在计算 sha256…'));
    invoke('verify_file', { path: path, expected_sha256: expect }).then(function (r) {
      if (S.destroyed) return;
      out.textContent = ''; head = add(out, el('div', 'int-verdict ' + (r.match ? 'is-ok' : 'is-fail')));
      add(head, el('span', 'int-verdict-dot'));
      add(head, el('span', 'int-verdict-text', r.match ? 'match: true · 文件未被改动' : 'match: false · 文件与期望指纹不一致'));
      add(out, el('pre', 'int-pre', '实际 sha256：' + (r.actual_sha256 || '—') + '\n期望 sha256：' + (r.expected_sha256 || expect)));
    }, function (err) {
      if (S.destroyed) return;
      out.textContent = ''; out.appendChild(noticeCard('校验失败', [err.message + (err.hint ? '（' + err.hint + '）' : '')], 'warn'));
    });
  }
  // ---------------- 渲染入口 ----------------
  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    S = { overviewHost: null, noticeHost: null, changesHost: null, baselineHost: null, scheduleHost: null,
      status: null, error: '', hint: '', busy: false, notice: null, storageNote: '', checkError: '', checkHint: '',
      history: [], acks: {}, rootMap: {}, baselines: [], schedules: [], roots: [], dialog: null, destroyed: false,
      filters: { range: 'latest', kind: 'all', high: false, hideAck: false, q: '' } };
    loadHistory(); loadAcks(); loadRoots();
    ensureCss(); container.textContent = '';
    var root = add(container, el('section', 'int')), head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '关键文件完整性'));
    add(head, el('p', 'view-sub', '给关键文件建一份 sha256 基线，之后随时比对新增 / 修改 / 删除；高危目录单独高亮，单条变更可接受或按指引恢复。'));
    S.noticeHost = add(root, el('div', 'int-notice'));
    var op = panel('完整性概览'), cp = panel('变更追踪'), bp = panel('基线版本'), tp = panel('定时扫描'), vp = panel('单文件校验');
    add(root, op.panel); add(root, cp.panel); add(root, bp.panel); add(root, tp.panel); add(root, vp.panel);
    btn(op.meta, '刷新', 'btn btn-ghost', function () { loadStatus(); loadSchedules(); });
    btn(cp.meta, '刷新', 'btn btn-ghost', function () { loadHistory(); paintChanges(); });
    btn(cp.meta, '导出 CSV', 'btn btn-ghost', exportChanges).setAttribute('data-action', 'int-export');
    btn(bp.meta, '刷新', 'btn btn-ghost', loadBaselines);
    btn(bp.meta, '新建基线', 'btn btn-ghost', function () { openBaseline(true); });
    btn(tp.meta, '刷新', 'btn btn-ghost', loadSchedules);
    S.overviewHost = add(op.panel, el('div', 'int-status'));
    S.changesHost = add(cp.panel, el('div', 'int-result'));
    S.baselineHost = add(bp.panel, el('div', 'int-baselines'));
    S.scheduleHost = add(tp.panel, el('div', 'int-schedules'));
    var form = add(vp.panel, el('div', 'int-form'));
    S.verifyPath = add(form, el('input', 'int-input')); S.verifyPath.type = 'text'; S.verifyPath.placeholder = '/etc/nginx/nginx.conf';
    S.verifySha = add(form, el('input', 'int-input')); S.verifySha.type = 'text'; S.verifySha.placeholder = '期望的 sha256（64 位十六进制）';
    btn(form, '校验', 'btn btn-primary', verifyFile);
    S.verifyOut = add(vp.panel, el('div', 'int-verify-out'));
    buildScheduleForm(tp.panel);
    paintNotice(); paintOverview(); paintChanges();
    loadStatus(); loadBaselines(); loadSchedules();
    return { destroy: function () { S.destroyed = true; closeDialog(); } };
  }
  // 样式随视图注入：不占首屏 style.css 预算，也不与其它视图互相干扰。
  function ensureCss() {
    if (document.getElementById('kore-integrity-css')) return;
    var CSS = [
      '.int-pad{padding:12px 16px}.int-notice:empty{display:none}.int-notice{padding:12px 16px 0}.int-empty{padding:20px 16px}.int-empty-small{padding:16px}.int-empty-title{margin:0;font-size:17px;font-weight:600}' +
        '.int-status-body{display:flex;flex-direction:column;gap:12px;padding:12px 16px 16px}.int-status-top,.int-ops{display:flex;flex-wrap:wrap;align-items:center;gap:8px}' +
        '.int-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.int-stat{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control)}.int-stat-label{color:var(--kore-text-3);font-size:12px}.int-stat-value{font-size:14px;font-variant-numeric:tabular-nums;word-break:break-all}',
      '.int-sumrow{display:flex;flex-wrap:wrap;gap:8px}.int-sumrow-flat{padding:10px 16px 0}.int-sum{display:flex;align-items:baseline;gap:6px;padding:6px 10px;border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);font-variant-numeric:tabular-nums}.int-sum-num{font-size:15px;font-weight:600}.int-sum-label{color:var(--kore-text-3);font-size:12px}.int-sum-warn .int-sum-num{color:var(--kore-warning)}.int-sum-fail .int-sum-num{color:var(--kore-danger)}.int-sum-ok .int-sum-num{color:var(--kore-success)}',
      '.int-scope{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;color:var(--kore-text-3)}.int-scope-label{font-weight:600;color:var(--kore-text-2)}.int-scope-count{color:var(--kore-text-2)}.int-chips{display:flex;flex-wrap:wrap;gap:6px}.int-scope-path{padding:2px 6px;color:var(--kore-info);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:4px;font-size:11px}',
      '.int-filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:12px 16px 4px;border-bottom:1px solid var(--kore-border-2)}.int-filter{display:flex;flex-direction:column;gap:4px}.int-filter-flags{flex-direction:row;align-items:center;gap:14px;grid-column:1/-1;flex-wrap:wrap}.int-check{display:inline-flex;align-items:center;gap:6px;min-height:var(--kore-touch);font-size:12px;color:var(--kore-text-2);cursor:pointer}.int-check input{width:16px;height:16px;accent-color:var(--kore-info)}.int-select{min-height:36px}',
      '.int-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55)}.int-dialog{width:100%;max-width:600px;max-height:88vh;overflow:auto;padding:16px;background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container)}.int-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.int-dialog-title{margin:0;font-size:16px;font-weight:600}.int-dialog-hint{margin:8px 0 12px;color:var(--kore-text-3);font-size:12px}.int-presets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
      '.int-preset{display:flex;flex-direction:column;gap:2px;padding:10px 12px;text-align:left;cursor:pointer;min-height:var(--kore-touch);color:var(--kore-text-1);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);font:inherit}.int-preset.is-on{border-color:var(--kore-info);box-shadow:inset 0 0 0 1px var(--kore-info)}.int-preset-name{font-size:13px;font-weight:600}.int-preset-path{font-size:12px;color:var(--kore-info)}.int-preset-note{font-size:11px;color:var(--kore-text-3)}.int-field{display:flex;flex-direction:column;gap:4px;margin-top:12px}.int-label{color:var(--kore-text-3);font-size:12px}',
      '.int-input{box-sizing:border-box;width:100%;min-height:36px;padding:0 8px;color:var(--kore-text-1);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);font:inherit}.int-input:focus{border-color:var(--kore-info);outline:none}.int-dialog-err{margin:8px 0 0;min-height:16px;color:var(--kore-danger);font-size:12px}.int-dialog-ops{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}',
      '.int-kv{display:flex;flex-direction:column;gap:6px;margin:4px 0 12px}.int-kv-row{display:flex;gap:8px;font-size:12px}.int-kv-key{flex:0 0 104px;color:var(--kore-text-3)}.int-kv-val{color:var(--kore-text-2);word-break:break-all}.int-steps{margin:0 0 4px;padding-left:20px;color:var(--kore-text-2);font-size:12px;line-height:1.7}.int-step{margin:2px 0}',
      '.int-verdict{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--kore-border-2);font-weight:600}.int-verdict-dot{width:10px;height:10px;border-radius:50%}.int-verdict-meta{color:var(--kore-text-3);font-size:12px;font-weight:400}.int-verdict.is-ok .int-verdict-dot{background:var(--kore-success)}.int-verdict.is-ok .int-verdict-text{color:var(--kore-success)}.int-verdict.is-fail .int-verdict-dot{background:var(--kore-danger)}.int-verdict.is-fail .int-verdict-text{color:var(--kore-danger)}',
      '.int-table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}.int-table th{text-align:left;padding:6px 16px;color:var(--kore-text-3);font-weight:400;border-bottom:1px solid var(--kore-border-2);white-space:nowrap}.int-table td{padding:8px 16px;vertical-align:top;border-top:1px solid var(--kore-border-2);word-break:break-all}',
      '.int-changes th:nth-child(1){width:9%}.int-changes th:nth-child(2){width:13%}.int-changes th:nth-child(3){width:30%}.int-changes th:nth-child(4){width:22%}.int-changes th:nth-child(5){width:12%}.int-changes th:nth-child(6){width:14%}.int-row-high{background:var(--kore-warning-bg);box-shadow:inset 3px 0 0 var(--kore-warning)}.int-row-acked td{opacity:.62}',
      '.int-path-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--kore-text-1)}.int-path .chip{margin-left:6px}.int-chg-text{color:var(--kore-text-2)}.int-actions{display:flex;flex-wrap:wrap;gap:6px}.int-actions .btn{white-space:nowrap}.int-mini{min-height:32px;padding:0 10px;font-size:12px}',
      '.int-baselines-table th:nth-child(1){width:14%}.int-baselines-table th:nth-child(2){width:16%}.int-baselines-table th:nth-child(3){width:8%}.int-baselines-table th:nth-child(4){width:9%}.int-baselines-table th:nth-child(5){width:15%}.int-baselines-table th:nth-child(6){width:20%}.int-baselines-table th:nth-child(7){width:18%}.int-baselines-table td .muted{display:block;margin-top:2px;font-size:11px}.int-schedules-table th:nth-child(1){width:30%}.int-schedules-table th:nth-child(2){width:26%}',
      '.int-form{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;padding:12px 16px}.int-verify-out:empty{display:none}.int-pre{margin:0;padding:12px 16px;color:var(--kore-text-2);font-size:12px;white-space:pre-wrap;word-break:break-all}',
      '.int-inline-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:12px 16px 16px}.int-inline-form .int-field{margin-top:0}.int-inline-form .int-dialog-err,.int-inline-form .int-dialog-ops{grid-column:1/-1}',
      '@media (max-width:639px){.int-presets{grid-template-columns:1fr}.int-form{grid-template-columns:1fr}.int-inline-form{grid-template-columns:1fr}.int-filters{grid-template-columns:1fr}.int-stats{grid-template-columns:1fr}' +
        '.int-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.int-table,.int-table tbody,.int-table tr{display:block;width:100%}' +
        '.int-table tr{padding:8px 0;border-top:1px solid var(--kore-border-2)}.int-table td{display:flex;gap:12px;padding:4px 16px;border:0}' +
        '.int-table td::before{content:attr(data-label);flex:0 0 72px;color:var(--kore-text-3)}.int-actions .btn{flex:1 1 auto;min-height:var(--kore-touch)}.int-dialog-ops .btn{flex:1 1 auto;min-height:var(--kore-touch)}}'
    ].join('');
    var style = el('style', null, CSS); style.id = 'kore-integrity-css'; document.head.appendChild(style);
  }
  window.KoreIntegrity = { render: render };
})();
