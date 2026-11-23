/* kore 主壳 · 完整性校验（web/integrity.js）——零框架 / 零 CDN / 无外链。
   契约（插件 README + internal/integrity）：status{has_baseline,created_at,entries,total_bytes,
   last_check_at,last_check_ok} · baseline{entries,total_bytes,duration_ms,warnings?} ·
   check{ok,added[],removed[],modified[],unchanged,checked_at,warnings?} · verify_file{match,actual_sha256}。
   POST /api/v1/invoke/integrity/integrity.<verb>。0 条目基线不算成功：/var/www 未部署时插件回
   entries=0 + warning，页面必须说清而不是显示"已建立"；错误一律透出后端 hint。 */
(function () {
  'use strict'; var API = '/api/v1/invoke/integrity/integrity.', TIMEOUT_MS = 30000, DEF_EXCLUDE = '*.log, *.tmp, */cache/*'; var ROOTS_TEXT = '/etc、/usr/bin、/usr/sbin、/opt、/var/www 与插件数据目录';
  // 预设 = 插件默认白名单根：点一下就能建基线，不要求用户懂路径（USABILITY ①预设优先）。
  var PRESETS = [{ path: '/etc', name: '系统配置', note: '服务配置与启动参数' },
    { path: '/usr/bin', name: '系统命令', note: '可执行文件被换即后门' },
    { path: '/var/www', name: '站点文件', note: '网站根目录（未部署站点时为空）' },
    { path: '/opt', name: '应用目录', note: '自装应用的安装目录' }];
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
    var token = cookie('kore_csrf'), data = {}; if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录')); var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(params || {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token } };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + verb, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = {}; } }
        if (res.ok) return data; var err = new Error((data.code ? data.code + '：' : '') + (data.message || 'HTTP ' + res.status)); err.code = data.code || ''; err.hint = data.hint || ''; throw err;
      });
    }, function (e) {
      if (timer !== null) clearTimeout(timer); if (e && e.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）'); throw e;
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
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone); add(c, el('span', 'dot ' + tone)); add(c, el('span', null, text)); return c;
  }
  function noticeCard(title, lines, tone) {
    var box = el('div', tone === 'warn' ? 'fw-callout-warn' : 'db-notice'); box.setAttribute('role', 'status'); if (title) add(box, el('div', 'fw-callout-title', title));
    (lines || []).forEach(function (t) { add(box, el('p', 'fw-callout-text', t)); }); return box;
  }
  function panel(title) {
    var p = el('section', 'panel'), head = add(p, el('div', 'panel-head')); add(head, el('span', 'panel-title', title)); return { panel: p, meta: add(head, el('span', 'panel-meta', '')) };
  }
  function paintNotice() {
    var host = S.noticeHost; if (!host) return; host.textContent = ''; if (S.notice) host.appendChild(noticeCard(S.notice.title, S.notice.lines, S.notice.tone));
  }
  // 状态卡两态：未建立基线 → 大字 + 说明 + 下一步；已建立 → 元信息 + 立即校验/重建基线。
  function paintStatus() {
    var host = S.statusHost; if (!host) return; host.textContent = '';
    if (S.error) {
      var ebox = noticeCard('状态读取失败', [S.error + (S.hint ? '（提示：' + S.hint + '）' : '')], 'warn'); btn(ebox, '重试', 'btn btn-ghost', loadStatus); add(host, ebox); return;
    }
    if (!S.status) { add(host, el('div', 'muted int-pad', '正在读取基线状态…')); return; }
    var st = S.status, ok = st.last_check_ok, body, grid, ops;
    if (!st.has_baseline) {
      body = add(host, el('div', 'empty-state int-empty')); add(body, el('p', 'int-empty-title', '尚未建立完整性基线')); add(body, el('p', 'empty-state-text', '基线会记录关键文件的指纹，之后可检测是否被篡改'));
      btn(body, '建立基线', 'btn btn-primary', function () { openBaseline(false); }); return;
    }
    body = add(host, el('div', 'int-status-body'));
    add(body, el('div', 'int-status-top')).appendChild(chip(ok === false ? 'fail' : (ok === true ? 'ok' : 'na'),
      ok === false ? '上次校验有改动' : (ok === true ? '上次校验通过' : '尚未校验')));
    grid = add(body, el('div', 'int-stats'));
    [['建立时间', fmtTime(st.created_at)], ['文件条目', (st.entries || 0) + ' 个'],
      ['合计体积', fmtBytes(st.total_bytes)], ['上次校验', st.last_check_at ? fmtTime(st.last_check_at) : '从未']]
      .forEach(function (kv) {
        var cell = add(grid, el('div', 'int-stat')); add(cell, el('span', 'int-stat-label', kv[0])); add(cell, el('span', 'int-stat-value', kv[1]));
      });
    if (!st.entries) add(body, noticeCard('基线里没有记录任何文件', ['路径不存在或目录为空时会得到空基线，「检测是否被篡改」也就失去意义。',
      '请点「重建基线」，换一个确实有文件的路径（预设 /var/www 在未部署站点时就是空目录）。'], 'warn'));
    ops = add(body, el('div', 'int-ops')); btn(ops, '立即校验', 'btn btn-primary', runCheck).disabled = S.busy; btn(ops, '重建基线', 'btn', function () { openBaseline(true); });
  }
  function loadStatus() {
    invoke('status', {}).then(function (d) {
      if (S.destroyed) return; S.status = d; S.error = ''; S.hint = ''; paintStatus();
    }, function (err) {
      if (S.destroyed) return; S.error = err.message; S.hint = err.hint || ''; if (!S.status) paintStatus();
    });
  }
  // ---------------- 基线多版本（baseline.list）----------------
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
    var table = add(host, el('table', 'int-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['版本', '建立时间', '文件', '体积', '上次校验', '状态'].forEach(function (c) { add(htr, el('th', null, c)); });
    var tbody = add(table, el('tbody'));
    list.forEach(function (b) {
      var tr = add(tbody, el('tr'));
      var idCell = add(tr, el('td', 'mono')); idCell.setAttribute('data-label', '版本');
      add(idCell, el('span', null, short(b.id)));
      if (b.current) add(idCell, chip('ok', '当前'));
      add(tr, el('td', null, fmtTime(b.created_at))).setAttribute('data-label', '建立时间');
      add(tr, el('td', null, (b.entries || 0) + ' 个')).setAttribute('data-label', '文件');
      add(tr, el('td', null, fmtBytes(b.total_bytes))).setAttribute('data-label', '体积');
      add(tr, el('td', null, b.last_check_at ? fmtTime(b.last_check_at) : '从未')).setAttribute('data-label', '上次校验');
      var st = add(tr, el('td')); st.setAttribute('data-label', '状态');
      if (b.last_check_ok === true) st.appendChild(chip('ok', '通过'));
      else if (b.last_check_ok === false) st.appendChild(chip('fail', '有改动'));
      else st.appendChild(chip('na', '未校验'));
      if (b.note) { var note = add(st, el('span', 'muted', ' ' + b.note)); note.title = b.note; }
    });
    if (typeof S.keep === 'number' && S.keep > 0) add(host, el('p', 'field-hint', '最多保留 ' + S.keep + ' 个版本；当前版本参与定时扫描。'));
  }
  function loadBaselines() {
    if (!S.baselineHost) return;
    invoke('baseline.list', { limit: 20 }).then(function (d) {
      if (S.destroyed) return; S.baselines = Array.isArray(d.baselines) ? d.baselines : []; S.keep = d.keep; S.baselineError = ''; paintBaselines(); paintBaselinePick();
    }, function (err) {
      if (S.destroyed) return; S.baselineError = err.message + (err.hint ? '（' + err.hint + '）' : ''); paintBaselines();
    });
  }
  // ---------------- 定时扫描（schedule.get / set）----------------
  function paintSchedule() {
    var host = S.scheduleHost; if (!host) return; host.textContent = '';
    if (S.scheduleError) { host.appendChild(noticeCard('定时扫描描述读取失败', [S.scheduleError], 'warn')); return; }
    var records = S.schedules || [];
    add(host, el('p', 'field-hint', '这里只展示插件给出的任务描述，不代表内核任务是否真的在跑；下方表单会把描述提交给内核调度器后才生效。'));
    if (!records.length) {
      var empty = add(host, el('div', 'empty-state int-empty'));
      add(empty, el('p', 'int-empty-title', '还没有定时扫描'));
      add(empty, el('p', 'empty-state-text', '选一个预设时间、挑好要扫描的路径，一次提交就建好；不需要手写 cron。'));
      if (S.scheduleHint) add(empty, el('p', 'field-hint', S.scheduleHint));
      return;
    }
    var table = add(host, el('table', 'int-table'));
    var htr = add(add(table, el('thead')), el('tr'));
    ['任务名', '频率', '下次执行', '状态'].forEach(function (c) { add(htr, el('th', null, c)); });
    var tbody = add(table, el('tbody'));
    records.forEach(function (r) {
      var task = r.recommended_task || {};
      var tr = add(tbody, el('tr'));
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
      if (S.destroyed) return; S.schedules = Array.isArray(d.records) ? d.records : []; S.scheduleHint = d.hint || ''; S.scheduleError = ''; paintSchedule();
    }, function (err) {
      if (S.destroyed) return; S.scheduleError = err.message + (err.hint ? '（' + err.hint + '）' : ''); paintSchedule();
    });
  }
  function paintBaselinePick() {
    var sel = S.scheduleBaseline; if (!sel) return;
    var keepValue = sel.value; sel.textContent = '';
    var auto = add(sel, el('option', null, '使用当前基线（推荐）')); auto.value = '';
    (S.baselines || []).forEach(function (b) {
      var opt = add(sel, el('option', null, short(b.id) + ' · ' + fmtTime(b.created_at) + (b.current ? '（当前）' : '')));
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
    paths.value = (S.roots && S.roots.length ? S.roots : ['/etc', '/usr/bin']).join(', ');
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
              '；插件本身不起定时器，由内核调度（G-19）'
          ] };
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
  function closeBaseline() {
    var d = S.dialog; if (d && d.wrap && d.wrap.parentNode) d.wrap.parentNode.removeChild(d.wrap); S.dialog = null;
  }
  // 弹层：预设多选（点击即选）+ 自定义路径 + 排除规则；提交后回填 entries/体积/耗时。
  function openBaseline(rebuild) {
    closeBaseline(); var wrap = el('div', 'int-backdrop'); wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', rebuild ? '重建完整性基线' : '建立完整性基线'); var box = add(wrap, el('section', 'int-dialog')), head = add(box, el('header', 'int-dialog-head'));
    add(head, el('h3', 'int-dialog-title', rebuild ? '重建基线' : '建立基线')); btn(head, '关闭', 'btn btn-ghost', closeBaseline);
    add(box, el('p', 'int-dialog-hint', '选择要保护的关键路径（可多选）：基线会记录这些文件的 sha256 指纹；重建会用当前文件覆盖旧基线。')); var chosen = Object.create(null), presetBtns = [], pick = add(box, el('div', 'int-presets'));
    S.roots.forEach(function (p) { if (p) chosen[p] = true; });
    function syncPresets() { presetBtns.forEach(function (it) { it.node.classList.toggle('is-on', !!chosen[it.path]); }); }
    PRESETS.forEach(function (p) {
      var b = el('button', 'int-preset'); b.type = 'button'; add(b, el('span', 'int-preset-name', p.name)); add(b, el('code', 'int-preset-path', p.path));
      add(b, el('span', 'int-preset-note', p.note)); on(b, function () { if (chosen[p.path]) delete chosen[p.path]; else chosen[p.path] = true; syncPresets(); });
      presetBtns.push({ node: b, path: p.path }); pick.appendChild(b);
    }); syncPresets(); var f1 = add(box, el('label', 'int-field')), f2 = add(box, el('label', 'int-field')); add(f1, el('span', 'int-label', '自定义路径（多个用逗号或空格分隔）'));
    add(f2, el('span', 'int-label', '排除规则（glob，多个用逗号分隔）')); var custom = add(f1, el('input', 'int-input')), exclude = add(f2, el('input', 'int-input'));
    custom.type = 'text'; custom.placeholder = '/srv/app /data'; exclude.type = 'text'; exclude.value = DEF_EXCLUDE;
    var errLine = add(box, el('p', 'int-dialog-err')), ops = add(box, el('div', 'int-dialog-ops')); var submit = btn(ops, rebuild ? '重建基线' : '建立基线', 'btn btn-primary', submitBaseline);
    btn(ops, '取消', 'btn', closeBaseline); S.dialog = { wrap: wrap, chosen: chosen, custom: custom, exclude: exclude, err: errLine, submit: submit }; document.body.appendChild(wrap);
  }
  function splitPaths(raw) { return String(raw || '').split(/[\s,，;；]+/).filter(function (s) { return !!s; }); }
  function submitBaseline() {
    var d = S.dialog, roots; if (!d || S.busy) return; roots = Object.keys(d.chosen); splitPaths(d.custom.value).forEach(function (p) { if (roots.indexOf(p) < 0) roots.push(p); });
    if (!roots.length) { d.err.textContent = '请至少选择一个路径（点上面的预设，或填写自定义绝对路径）。'; return; }
    S.busy = true; d.err.textContent = ''; d.submit.disabled = true; d.submit.textContent = '正在建立…';
    invoke('baseline', { paths: roots, exclude: splitPaths(d.exclude.value) }).then(function (r) {
      S.busy = false; closeBaseline(); S.roots = roots; S.check = null; S.checkError = ''; paintCheck();
      var lines = ['路径 ' + roots.join('、') + ' · 记录 ' + (r.entries || 0) + ' 个文件 · ' +
        fmtBytes(r.total_bytes) + ' · 耗时 ' + (r.duration_ms || 0) + ' ms'], warn = r.warnings || [];
      S.notice = (r.entries || 0) > 0 ? { tone: 'ok', title: '基线已建立', lines: lines }
        : { tone: 'warn', title: '基线已保存，但一条文件都没记录',
          lines: lines.concat(warn.length ? warn : ['所选路径下没有可读文件，请换一个路径重建。']) };
      paintNotice(); loadStatus();
    }, function (err) {
      S.busy = false; d.submit.disabled = false; d.submit.textContent = '建立基线'; d.err.textContent = err.message + (err.hint ? '（' + err.hint + '）' : '。只能扫描 ' + ROOTS_TEXT + '；路径须为已存在的绝对路径。');
    });
  }
  // 三张可折叠表：新增/删除给路径 + 状态，修改给 old→new 指纹（前 8 位）+ changes；行内 details 展开完整路径与元数据。
  function detailCell(pairs) {
    var d = el('details', 'int-detail'), row; add(d, el('summary', null, '详情'));
    pairs.forEach(function (kv) {
      row = add(d, el('div', 'int-detail-row')); add(row, el('span', 'int-detail-key', kv[0])); add(row, el('span', 'int-detail-val', kv[1]));
    }); return d;
  }
  function diffTable(title, rows, kind) {
    var box = el('details', 'int-section'), modified = kind === 'modified'; box.open = true; add(box, el('summary', 'int-section-head', title + '（' + rows.length + '）'));
    if (!rows.length) { add(box, el('p', 'panel-empty', '无')); return box; }
    var table = add(box, el('table', 'int-table')), htr = add(add(table, el('thead')), el('tr'));
    (modified ? ['路径', '指纹变化（前 8 位）', '变更', '详情'] : ['路径', '详情']).forEach(function (c) {
      add(htr, el('th', null, c));
    }); var tbody = add(table, el('tbody'));
    rows.forEach(function (item) {
      var path = modified ? item.path : item, tr = add(tbody, el('tr')), cell, c1, c2, sh; add(tr, el('td', 'int-path', path)).setAttribute('data-label', '路径');
      if (!modified) {
        cell = add(tr, el('td')); cell.setAttribute('data-label', '详情');
        add(cell, detailCell([['完整路径', path], ['状态', kind === 'added' ? '基线里没有，现在出现' : '基线里有，现在消失']])); return;
      }
      c1 = add(tr, el('td')); c1.setAttribute('data-label', '指纹变化'); sh = add(c1, el('span', 'int-sha'));
      add(sh, el('code', 'int-sha-old', short(item.old_sha256))); add(sh, el('span', 'int-sha-arrow', '→')); add(sh, el('code', 'int-sha-new', short(item.new_sha256)));
      c2 = add(tr, el('td')); c2.setAttribute('data-label', '变更'); (item.changes || []).forEach(function (ch) { c2.appendChild(el('span', 'int-chg', ch)); });
      cell = add(tr, el('td')); cell.setAttribute('data-label', '详情'); add(cell, detailCell([['完整路径', path], ['旧 sha256', item.old_sha256 || '—'], ['新 sha256', item.new_sha256 || '—'],
        ['权限位', (item.old_mode || '—') + ' → ' + (item.new_mode || '—')]]));
    }); return box;
  }
  function paintCheck() {
    var host = S.resultHost, r, added, removed, modified, head, ebox; if (!host) return; host.textContent = '';
    if (!S.check && !S.checkError) {
      host.hidden = true; if (S.resultPanel) S.resultPanel.hidden = true;
      add(host, el('p', 'panel-empty', '还没有校验结果：先建立基线，再做一次「立即校验」。')); return;
    }
    host.hidden = false; if (S.resultPanel) S.resultPanel.hidden = false;
    if (S.checkError) {
      ebox = noticeCard('校验未完成', [S.checkError + (S.checkHint ? '（提示：' + S.checkHint + '）' : '')], 'warn'); if (S.checkHint) btn(ebox, '建立基线', 'btn btn-primary', function () { openBaseline(false); });
      add(host, ebox); return;
    }
    r = S.check; added = r.added || []; removed = r.removed || []; modified = r.modified || []; head = add(host, el('div', 'int-verdict ' + (r.ok ? 'is-ok' : 'is-fail')));
    add(head, el('span', 'int-verdict-dot')); add(head, el('span', 'int-verdict-text', r.ok ? '未检测到改动' : '检测到 ' + (added.length + removed.length + modified.length) + ' 处改动'));
    add(head, el('span', 'int-verdict-meta', '校验于 ' + fmtTime(r.checked_at) + ' · 未变化 ' + (r.unchanged || 0) + ' 个'));
    if (r.warnings && r.warnings.length) add(host, noticeCard('部分路径被跳过', r.warnings, 'warn')); if (r.ok) return;
    add(host, diffTable('新增', added, 'added')); add(host, diffTable('删除', removed, 'removed')); add(host, diffTable('修改', modified, 'modified'));
  }
  function runCheck() {
    if (S.busy) return; S.busy = true; S.check = null; S.checkError = ''; S.checkHint = ''; paintStatus(); paintCheck();
    if (S.resultHost) {
      S.resultHost.hidden = false; S.resultHost.textContent = ''; add(S.resultHost, el('div', 'muted int-pad', '正在比对基线…'));
    }
    invoke('check', {}).then(function (r) {
      if (S.destroyed) return; S.busy = false; S.check = r; paintCheck(); loadStatus();
    }, function (err) {
      if (S.destroyed) return; S.busy = false; S.checkError = err.message; S.checkHint = err.hint || ''; paintCheck(); paintStatus();
    });
  }
  function verifyFile() {
    var out = S.verifyOut, path = S.verifyPath.value.trim(), expect = S.verifySha.value.trim(), head; out.textContent = '';
    if (!path || !expect) { out.appendChild(noticeCard('缺少输入', ['请填写文件路径与期望的 sha256（64 位十六进制）。'], 'warn')); return; }
    out.appendChild(el('div', 'muted int-pad', '正在计算 sha256…'));
    invoke('verify_file', { path: path, expected_sha256: expect }).then(function (r) {
      if (S.destroyed) return; out.textContent = ''; head = add(out, el('div', 'int-verdict ' + (r.match ? 'is-ok' : 'is-fail'))); add(head, el('span', 'int-verdict-dot'));
      add(head, el('span', 'int-verdict-text', r.match ? 'match: true · 文件未被改动' : 'match: false · 文件与期望指纹不一致'));
      add(out, el('pre', 'int-pre', '实际 sha256：' + (r.actual_sha256 || '—') + '\n期望 sha256：' + (r.expected_sha256 || expect)));
    }, function (err) {
      if (S.destroyed) return; out.textContent = ''; out.appendChild(noticeCard('校验失败', [err.message + (err.hint ? '（' + err.hint + '）' : '')], 'warn'));
    });
  }
  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    S = { statusHost: null, noticeHost: null, resultHost: null, resultPanel: null, status: null, error: '', hint: '',
      busy: false, notice: null, check: null, checkError: '', checkHint: '', dialog: null, destroyed: false, roots: [] };
    ensureCss(); container.textContent = ''; var root = add(container, el('section', 'int')), head = add(root, el('header', 'view-head')); add(head, el('h2', 'view-title', '完整性校验'));
    add(head, el('p', 'view-sub', '给关键文件建一份 sha256 基线，之后随时比对新增 / 删除 / 修改；可疑文件可单独校验指纹。')); S.noticeHost = add(root, el('div', 'int-notice'));
    var sp = panel('基线状态'), bp = panel('基线版本'), tp = panel('定时扫描'), rp = panel('校验结果'), vp = panel('单文件校验');
    add(root, sp.panel); add(root, bp.panel); add(root, tp.panel); add(root, rp.panel); add(root, vp.panel);
    btn(sp.meta, '刷新', 'btn btn-ghost', loadStatus);
    btn(bp.meta, '刷新', 'btn btn-ghost', loadBaselines);
    btn(tp.meta, '刷新', 'btn btn-ghost', loadSchedules);
    S.baselineHost = add(bp.panel, el('div', 'int-baselines'));
    S.scheduleHost = add(tp.panel, el('div', 'int-schedules'));
    S.statusHost = add(sp.panel, el('div', 'int-status')); S.resultPanel = rp.panel;
    S.resultHost = add(rp.panel, el('div', 'int-result')); var form = add(vp.panel, el('div', 'int-form'));
    S.verifyPath = add(form, el('input', 'int-input')); S.verifyPath.type = 'text'; S.verifyPath.placeholder = '/etc/nginx/nginx.conf'; S.verifySha = add(form, el('input', 'int-input'));
    S.verifySha.type = 'text'; S.verifySha.placeholder = '期望的 sha256（64 位十六进制）'; btn(form, '校验', 'btn btn-primary', verifyFile); S.verifyOut = add(vp.panel, el('div', 'int-verify-out'));
    paintNotice(); paintStatus(); paintCheck(); buildScheduleForm(tp.panel);
    loadStatus(); loadBaselines(); loadSchedules();
    return { destroy: function () { S.destroyed = true; closeBaseline(); } };
  }
  // 样式随视图注入：不占首屏 style.css 预算，也不与其它视图互相干扰。
  function ensureCss() {
    if (document.getElementById('kore-integrity-css')) return;
    var CSS = [
      '.int-pad{padding:12px 16px}.int-notice:empty{display:none}.int-notice{padding:12px 16px 0}.int-empty{padding:20px 16px}.int-empty-title{margin:0;font-size:17px;font-weight:600}.int-status-body{display:flex;flex-direction:column;gap:12px;padding:12px 16px 16px}.int-status-top,.int-ops{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.int-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.int-stat{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control)}.int-stat-label{color:var(--kore-text-3);font-size:12px}.int-stat-value{font-size:14px;font-variant-numeric:tabular-nums;word-break:break-all}',
      '.int-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55)}.int-dialog{width:100%;max-width:560px;max-height:88vh;overflow:auto;padding:16px;background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container)}.int-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.int-dialog-title{margin:0;font-size:16px;font-weight:600}.int-dialog-hint{margin:8px 0 12px;color:var(--kore-text-3);font-size:12px}.int-presets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
      '.int-preset{display:flex;flex-direction:column;gap:2px;padding:10px 12px;text-align:left;cursor:pointer;min-height:var(--kore-touch);color:var(--kore-text-1);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);font:inherit}.int-preset.is-on{border-color:var(--kore-info);box-shadow:inset 0 0 0 1px var(--kore-info)}.int-preset-name{font-size:13px;font-weight:600}.int-preset-path{font-size:12px;color:var(--kore-info)}.int-preset-note{font-size:11px;color:var(--kore-text-3)}.int-field{display:flex;flex-direction:column;gap:4px;margin-top:12px}.int-label{color:var(--kore-text-3);font-size:12px}',
      '.int-input{box-sizing:border-box;width:100%;min-height:36px;padding:0 8px;color:var(--kore-text-1);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);font:inherit}.int-input:focus{border-color:var(--kore-info);outline:none}.int-dialog-err{margin:8px 0 0;min-height:16px;color:var(--kore-danger);font-size:12px}.int-dialog-ops{display:flex;gap:8px;margin-top:12px}',
      '.int-verdict{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--kore-border-2);font-weight:600}.int-verdict-dot{width:10px;height:10px;border-radius:50%}.int-verdict-meta{color:var(--kore-text-3);font-size:12px;font-weight:400}.int-verdict.is-ok .int-verdict-dot{background:var(--kore-success)}.int-verdict.is-ok .int-verdict-text{color:var(--kore-success)}.int-verdict.is-fail .int-verdict-dot{background:var(--kore-danger)}.int-verdict.is-fail .int-verdict-text{color:var(--kore-danger)}',
      '.int-section{border-top:1px solid var(--kore-border-2)}.int-table{table-layout:fixed}.int-table th:nth-child(1){width:34%}.int-table th:nth-child(2){width:26%}.int-table th:nth-child(3){width:12%}.int-table th:nth-child(4){width:28%}.int-sha code,.int-chg{white-space:nowrap}.int-section-head{padding:10px 16px;cursor:pointer;font-size:13px;font-weight:600}.int-table{width:100%;border-collapse:collapse;font-size:12px}.int-table th{text-align:left;padding:6px 16px;color:var(--kore-text-3);font-weight:400;border-bottom:1px solid var(--kore-border-2);white-space:nowrap}.int-table td{padding:8px 16px;vertical-align:top;border-top:1px solid var(--kore-border-2);word-break:break-all}.int-sha{display:inline-flex;align-items:center;gap:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.int-sha-old,.int-sha-arrow{color:var(--kore-text-3)}.int-sha-new{color:var(--kore-warning)}',
      '.int-chg{display:inline-block;margin-right:4px;padding:0 6px;color:var(--kore-warning);border:1px solid currentColor;border-radius:4px;font-size:11px}.int-detail summary{cursor:pointer;color:var(--kore-info);font-size:11px}.int-detail-row{display:flex;gap:6px;margin-top:4px;font-size:11px}.int-detail-key{flex:0 0 76px;color:var(--kore-text-3)}.int-detail-val{color:var(--kore-text-2);word-break:break-all}.int-form{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;padding:12px 16px}.int-verify-out:empty{display:none}.int-pre{margin:0;padding:12px 16px;color:var(--kore-text-2);font-size:12px;white-space:pre-wrap;word-break:break-all}',
      '.int-inline-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:12px 16px 16px}.int-inline-form .int-field{margin-top:0}.int-inline-form .int-dialog-err,.int-inline-form .int-dialog-ops{grid-column:1/-1}.int-baselines .int-table{table-layout:fixed}.int-baselines .int-table th:nth-child(1){width:15%}.int-baselines .int-table th:nth-child(2){width:17%}.int-baselines .int-table th:nth-child(3){width:7%}.int-baselines .int-table th:nth-child(4){width:9%}.int-baselines .int-table th:nth-child(5){width:18%}.int-baselines .int-table th:nth-child(6){width:34%}.int-baselines .chip,.int-schedules .chip{white-space:nowrap}.int-baselines .int-table td .muted{display:block;margin-top:2px;font-size:11px}.int-schedules .int-table th:nth-child(1){width:28%}.int-schedules .int-table th:nth-child(2){width:24%}',
      '@media (max-width:639px){.int-presets{grid-template-columns:1fr}.int-form{grid-template-columns:1fr}.int-inline-form{grid-template-columns:1fr}' +
      '.int-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.int-table,.int-table tbody,.int-table tr{display:block;width:100%}' +
      '.int-table tr{padding:8px 0;border-top:1px solid var(--kore-border-2)}.int-table td{display:flex;gap:12px;padding:4px 16px;border:0}' +
      '.int-table td::before{content:attr(data-label);flex:0 0 72px;color:var(--kore-text-3)}}'
    ].join(''); var style = el('style', null, CSS); style.id = 'kore-integrity-css'; document.head.appendChild(style);
  }
  window.KoreIntegrity = { render: render };
})();
