/* kore 主壳 · 备份管理（web/backups.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/backup/backup.list）；
   方法段一律写完整限定名 backup.*，裸动词只是插件侧兼容，不得依赖。
   window.KoreBackup.render(container) 调 backup 插件：
   backup.create / .list / .verify / .restore / .delete / .retention / .stats。
   定时备份不在插件里实现：前端直接调内核 ADR-0019 的 /api/v1/scheduler/tasks，
   创建 backup.create（打包）+ backup.retention（1 分钟后清理）两条任务。
   恢复/删除/清理与任务删除一律走页面内二次确认面板（不用 window.confirm）。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/backup/';
  var SCHED = '/api/v1/scheduler/tasks';
  var CRON_PRESETS = [
    { id: 'daily3', label: '每天 3 点', cron: '0 3 * * *' },
    { id: 'sixh', label: '每 6 小时', cron: '0 */6 * * *' },
    { id: 'weekly', label: '每周日 2 点', cron: '0 2 * * 0' },
    { id: 'custom', label: '自定义 cron', cron: '' }
  ];
  var CRON_LABELS = {
    '0 3 * * *': '每天 03:00',
    '1 3 * * *': '每天 03:01（备份后 1 分钟）',
    '0 */6 * * *': '每 6 小时',
    '1 */6 * * *': '每 6 小时（备份后 1 分钟）',
    '0 2 * * 0': '每周日 02:00',
    '1 2 * * 0': '每周日 02:01（备份后 1 分钟）'
  };
  var TASK_PREFIX = '备份 · ';
  function fresh() {
    return { root: null, backups: [], destroyed: false, status: null, result: null, resultHost: null,
      confirm: null, confirmHost: null, confirmMsg: null, busy: false, name: null, paths: null,
      exclude: null, compression: null, submit: null,
      stats: null, summaryHost: null, listHost: null, count: null,
      tasks: [], sched: {}, ret: {}, taskDelete: null, schedHydrated: false };
  }
  var S = fresh();
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function request(url, method, body) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var init = {
      method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Kore-CSRF': token }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || ''; err.hint = data.hint || ''; throw err;
        }
        return data;
      });
    });
  }
  function invoke(method, params) { return request(API + method, 'POST', params || {}); }
  function fmtSize(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MiB';
    return (n / 1073741824).toFixed(2) + ' GiB';
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function setStatus(text, tone) {
    if (!S.status) return;
    S.status.textContent = text;
    S.status.className = 'bak-status ' + (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function setNote(node, text, tone, base) {
    if (!node) return;
    node.textContent = text || '';
    node.className = (base || 'bak-sched-msg') + ' ' +
      (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function panel(parent, title, meta) {
    var p = add(parent, el('section', 'panel')), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    if (meta) add(h, el('span', 'panel-meta', meta));
    return p;
  }
  function kv(parent, label, value) {
    add(parent, el('dt', null, label));
    var dd = add(parent, el('dd', null, value === undefined || value === null || value === '' ? '—' : value));
    return dd;
  }
  function field(form, label, control, span) {
    var box = add(form, el('label', 'field' + (span ? ' ' + span : '')));
    add(box, el('span', 'field-label', label)); box.appendChild(control); return box;
  }
  function input(type, cls, ph) {
    var n = el('input', 'field-input' + (cls ? ' ' + cls : ''));
    n.type = type; if (ph) n.placeholder = ph;
    n.autocomplete = 'off'; n.spellcheck = false; return n;
  }
  function textarea(rows, ph) {
    var n = el('textarea', 'bak-textarea');
    n.rows = rows; n.placeholder = ph || ''; n.autocomplete = 'off'; n.spellcheck = false; return n;
  }
  function button(parent, label, cls, fn) {
    var b = add(parent, el('button', 'btn' + (cls ? ' ' + cls : ''), label));
    b.type = 'button'; return on(b, fn);
  }
  // ---- 定时备份（内核 scheduler） ----
  function isOurTask(t) { return t && t.plugin === 'backup' && String(t.name || '').indexOf(TASK_PREFIX) === 0; }
  function selectedPreset() {
    var id = S.sched.preset.value, found = null;
    CRON_PRESETS.forEach(function (p) { if (p.id === id) found = p; });
    return found || CRON_PRESETS[0];
  }
  function currentCron() {
    var preset = selectedPreset();
    return preset.id === 'custom' ? S.sched.custom.value.trim() : preset.cron;
  }
  function cronValid(cron) { return cron.split(/\s+/).filter(function (s) { return s; }).length === 5; }
  // 清理任务排在备份后 1 分钟：同刻并发时保留任务可能先跑，导致本次多留一份。
  function retentionCron(cron) {
    var parts = String(cron || '').trim().split(/\s+/);
    if (parts.length !== 5 || !/^\d+$/.test(parts[0])) return cron;
    var minute = parseInt(parts[0], 10);
    if (isNaN(minute) || minute > 58) return cron;
    parts[0] = String(minute + 1);
    return parts.join(' ');
  }
  function cronText(t) {
    if (t.interval_s) return '每 ' + t.interval_s + ' 秒';
    return CRON_LABELS[t.schedule] || t.schedule || '—';
  }
  function taskPayload(t, enabled) {
    return { name: t.name, plugin: t.plugin, method: t.method, params: t.params || {},
      schedule: t.schedule || '', interval_s: t.interval_s || 0, timeout_s: t.timeout_s || 300, enabled: enabled };
  }
  function loadTasks(quiet) {
    request(SCHED).then(function (data) {
      if (S.destroyed) return;
      S.tasks = (data.tasks || []).filter(isOurTask); paintTasks();
      if (!S.schedHydrated && S.tasks.length) hydrateSchedule(S.tasks);
      if (quiet !== true) setNote(S.sched.msg, S.tasks.length ? '已加载 ' + S.tasks.length + ' 条备份任务' : '还没有定时备份任务', 'ok');
    }, function (err) {
      if (S.destroyed) return;
      S.tasks = []; paintTasks();
      var hint = err.code === 'E_UNSUPPORTED' ? '（内核未装配调度器）' : err.hint ? '（' + err.hint + '）' : '';
      setNote(S.sched.msg, '读取定时任务失败：' + err.message + hint, 'fail');
    });
  }
  // hydrateSchedule 把已有任务回填到表单：刷新后能看到真正生效的频率/份数/路径，
  // 而不是只剩任务列表可读。只在首次加载回填，避免覆盖用户正在编辑的输入。
  function hydrateSchedule(tasks) {
    var createTask = null, keepTask = null;
    tasks.forEach(function (t) {
      if (t.method === 'backup.create') createTask = t;
      if (t.method === 'backup.retention') keepTask = t;
    });
    if (createTask) {
      var matched = false;
      CRON_PRESETS.forEach(function (p) {
        if (p.cron && p.cron === createTask.schedule) { S.sched.preset.value = p.id; matched = true; }
      });
      S.sched.customField.hidden = matched;
      if (!matched && createTask.schedule) {
        S.sched.preset.value = 'custom'; S.sched.custom.value = createTask.schedule;
      }
      var paths = (createTask.params && createTask.params.paths) || [];
      if (paths.length) S.sched.paths.value = paths.join('\n');
    }
    var keep = keepTask && keepTask.params ? keepTask.params.keep : 0;
    if (keep >= 1 && keep <= 100) {
      S.sched.keep.value = String(keep); S.ret.keep.value = String(keep);
    }
    S.schedHydrated = true;
  }
  function paintTasks() {
    if (!S.sched.listHost) return;
    S.sched.listHost.textContent = ''; S.sched.count.textContent = S.tasks.length ? S.tasks.length + ' 个任务' : '';
    if (S.taskDelete) {
      var t = null;
      S.tasks.forEach(function (item) { if (item.id === S.taskDelete) t = item; });
      if (t) {
        var bar = add(S.sched.listHost, el('div', 'bak-sched-confirm'));
        add(bar, el('span', null, '删除后不再执行：' + t.name));
        button(bar, '确认删除', 'bak-danger', function () { deleteTask(t); });
        button(bar, '取消', 'btn-ghost', function () { S.taskDelete = null; paintTasks(); });
      } else { S.taskDelete = null; }
    }
    if (!S.tasks.length) {
      var empty = add(S.sched.listHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '还没有定时备份；选一个频率并保存，之后到点自动打包并按保留份数清理。'));
      return;
    }
    var scroll = add(S.sched.listHost, el('div', 'bak-task-host'));
    var table = add(scroll, el('table', 'bak-task-table')); table.setAttribute('aria-label', '定时备份任务');
    var htr = add(add(table, el('thead')), el('tr'));
    ['任务', '执行时间', '下次执行', '上次结果', '状态', '操作'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.tasks.forEach(function (t) {
      var tr = add(body, el('tr'));
      var name = add(tr, el('td', 'bak-name-cell')); name.dataset.label = '任务';
      add(name, el('span', 'bak-name', t.name));
      var method = add(name, el('span', 'bak-id', t.method + ' · ' + t.id)); method.title = t.id;
      add(tr, el('td', null, cronText(t))).dataset.label = '执行时间';
      add(tr, el('td', null, fmtTime(t.next_run_at))).dataset.label = '下次执行';
      var last = add(tr, el('td')); last.dataset.label = '上次结果';
      if (!t.last_result) last.appendChild(chip('na', '未执行'));
      else if (t.last_result === 'ok') last.appendChild(chip('ok', '成功'));
      else if (t.last_result === 'skipped' || t.last_result === 'missed') last.appendChild(chip('warn', t.last_result));
      else last.appendChild(chip('fail', t.last_result));
      if (t.last_run_at) last.title = fmtTime(t.last_run_at);
      var state = add(tr, el('td')); state.dataset.label = '状态';
      state.appendChild(t.enabled ? chip('ok', '已启用') : chip('na', '已暂停'));
      var ops = add(tr, el('td', 'cell-ops bak-ops')); ops.dataset.label = '操作';
      button(ops, t.enabled ? '暂停' : '恢复', 'btn-ghost', function () { toggleTask(t, !t.enabled); });
      button(ops, '删除', 'btn-ghost bak-danger', function () { S.taskDelete = t.id; paintTasks(); });
    });
  }
  function saveSchedule(ev) {
    ev.preventDefault();
    var cron = currentCron(), preset = selectedPreset();
    if (!cron) { setNote(S.sched.msg, '请选择预设或填写自定义 cron', 'fail'); return; }
    if (!cronValid(cron)) { setNote(S.sched.msg, 'cron 需要 5 段（分 时 日 月 周），例：0 3 * * *', 'fail'); return; }
    var keep = parseInt(S.sched.keep.value, 10);
    if (isNaN(keep) || keep < 1 || keep > 100) { setNote(S.sched.msg, '保留份数必须是 1–100 的整数', 'fail'); return; }
    var paths = S.sched.paths.value.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    if (!paths.length) { setNote(S.sched.msg, '请填写至少一个备份路径（每行一个）', 'fail'); return; }
    var definitions = [
      { name: '备份 · 自动创建', plugin: 'backup', method: 'backup.create',
        params: { name: 'auto', paths: paths, compression: 'gzip' }, schedule: cron, timeout_s: 1800 },
      { name: '备份 · 保留 ' + keep + ' 份', plugin: 'backup', method: 'backup.retention',
        params: { keep: keep }, schedule: retentionCron(cron), timeout_s: 600 }
    ];
    S.sched.save.disabled = true;
    setNote(S.sched.msg, '正在保存定时备份配置…');
    // 保存 = 替换：先删本页创建的旧任务，再按当前配置建两条，避免重复累积。
    request(SCHED).then(function (data) {
      return (data.tasks || []).filter(isOurTask).reduce(function (p, t) {
        return p.then(function () { return request(SCHED + '/' + encodeURIComponent(t.id), 'DELETE'); });
      }, Promise.resolve());
    }).then(function () {
      return definitions.reduce(function (p, def) {
        return p.then(function () { return request(SCHED, 'POST', def); });
      }, Promise.resolve());
    }).then(function () {
      S.taskDelete = null; S.schedHydrated = true;
      setNote(S.sched.msg, '已保存：' + (preset.id === 'custom' ? cron : preset.label) +
        ' 打包一次，1 分钟后清理到保留 ' + keep + ' 份', 'ok');
      loadTasks(true); loadList(true); loadStats();
    }, function (err) {
      var hint = err.hint ? '（' + err.hint + '）' : '';
      setNote(S.sched.msg, '保存失败：' + err.message + hint, 'fail');
    }).then(function () { S.sched.save.disabled = false; });
  }
  function toggleTask(t, enable) {
    // 内核没有原地启停端点：先按原定义建"暂停/恢复"副本，成功后再删旧任务，
    // 这样建副本失败时原任务仍在，不会出现"暂停把配置弄丢"。
    setNote(S.sched.msg, enable ? '正在恢复任务…' : '正在暂停任务…');
    request(SCHED, 'POST', taskPayload(t, enable)).then(function () {
      return request(SCHED + '/' + encodeURIComponent(t.id), 'DELETE');
    }).then(function () {
      setNote(S.sched.msg, (enable ? '已恢复：' : '已暂停：') + t.name +
        '（内核暂无原地启停端点，任务已按原定义重建）', 'ok');
      loadTasks(true);
    }, function (err) {
      setNote(S.sched.msg, (enable ? '恢复' : '暂停') + '未完成：' + err.message +
        '（原任务仍保留，可重试）', 'fail');
    });
  }
  function deleteTask(t) {
    S.taskDelete = null;
    request(SCHED + '/' + encodeURIComponent(t.id), 'DELETE').then(function () {
      setNote(S.sched.msg, '已删除任务：' + t.name, 'ok'); paintTasks(); loadTasks(true);
    }, function (err) { setNote(S.sched.msg, '删除失败：' + err.message, 'fail'); paintTasks(); });
  }
  // ---- 保留信息 / 保留策略 ----
  function loadStats() {
    invoke('backup.stats', {}).then(function (data) {
      if (S.destroyed) return;
      S.stats = data; paintSummary();
    }, function () {
      if (S.destroyed) return;
      S.stats = null; paintSummary();
    });
  }
  function paintSummary() {
    if (!S.summaryHost) return;
    if (!S.stats) { S.summaryHost.textContent = '保留统计暂不可用'; return; }
    var d = S.stats;
    S.summaryHost.textContent = d.total_count
      ? '共 ' + d.total_count + ' 份，最早 ' + fmtTime(d.oldest) + '，最晚 ' + fmtTime(d.newest) + '，占用 ' + fmtSize(d.total_bytes)
      : '共 0 份，还没有占用空间';
  }
  function setRetMsg(text, tone) { setNote(S.ret.msg, text, tone, 'bak-ret-msg'); }
  function renderRetention(data, dryRun) {
    if (!S.ret.host) return;
    S.ret.host.textContent = '';
    var box = add(S.ret.host, el('div', 'bak-ret-result'));
    var head = (dryRun ? '预览：将删除 ' : '已删除 ') + data.deleted.length + ' 份，' +
      (dryRun ? '预计释放 ' : '释放 ') + fmtSize(data.freed_bytes) + '，保留 ' + data.kept + ' 份';
    add(box, el('p', dryRun ? 'bak-ret-head' : 'bak-ret-head ok', head));
    if (data.deleted.length) {
      var ul = add(box, el('ul', 'bak-ret-list'));
      data.deleted.forEach(function (item) {
        add(ul, el('li', null, item.id + ' · ' + fmtTime(item.created_at) + ' · ' + fmtSize(item.size_bytes)));
      });
    }
    if (data.protected && data.protected.length) {
      add(box, el('p', 'bak-ret-note', '跳过 ' + data.protected.length +
        ' 份非本插件创建的备份（不会删除）：' + data.protected.map(function (p) { return p.id; }).join('、')));
    }
  }
  function previewRetention() {
    var keep = parseInt(S.ret.keep.value, 10);
    if (isNaN(keep) || keep < 1 || keep > 100) { setRetMsg('保留份数必须是 1–100 的整数', 'fail'); return; }
    S.ret.preview = null; S.ret.run.disabled = true;
    setRetMsg('正在预演清理（不会删任何文件）…');
    invoke('backup.retention', { keep: keep, dry_run: true }).then(function (data) {
      S.ret.preview = { keep: keep, data: data };
      renderRetention(data, true);
      S.ret.run.disabled = data.deleted.length === 0;
      setRetMsg(data.deleted.length ? '确认后将真正删除上面 ' + data.deleted.length + ' 份旧备份'
        : '没有需要清理的旧备份（最新一份与外来备份受保护）', data.deleted.length ? null : 'ok');
    }, function (err) { setRetMsg('预演失败：' + err.message, 'fail'); });
  }
  function runRetention() {
    var preview = S.ret.preview, keep = preview ? preview.keep : parseInt(S.ret.keep.value, 10);
    if (!preview) { setRetMsg('请先点「预览」确认将删除的清单', 'fail'); return; }
    if (parseInt(S.ret.keep.value, 10) !== keep) { setRetMsg('保留份数已改动，请重新预览', 'fail'); return; }
    S.ret.run.disabled = true;
    setRetMsg('正在清理…');
    invoke('backup.retention', { keep: keep }).then(function (data) {
      S.ret.preview = null;
      renderRetention(data, false);
      setRetMsg('清理完成：保留 ' + data.kept + ' 份，释放 ' + fmtSize(data.freed_bytes), 'ok');
      loadList(true); loadStats();
    }, function (err) { setRetMsg('清理失败：' + err.message, 'fail'); });
  }
  // ---- 备份列表 ----
  function paintList() {
    if (!S.listHost) return;
    S.listHost.textContent = ''; S.count.textContent = S.backups.length ? S.backups.length + ' 个' : '';
    if (!S.backups.length) {
      var empty = add(S.listHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '还没有备份；建议先备份站点目录'));
      return;
    }
    var scroll = add(S.listHost, el('div', 'bak-table-host'));
    var table = add(scroll, el('table', 'bak-table')); table.setAttribute('aria-label', '备份列表');
    var htr = add(add(table, el('thead')), el('tr'));
    ['名称', '创建时间', '大小', '条目', 'SHA256', '状态', '操作'].forEach(function (label) {
      add(htr, el('th', null, label));
    });
    var body = add(table, el('tbody'));
    S.backups.forEach(function (b) {
      var tr = add(body, el('tr'));
      var name = add(tr, el('td', 'bak-name-cell')); name.dataset.label = '名称';
      add(name, el('span', 'bak-name', b.name || '—'));
      if (b.managed === false) name.appendChild(chip('na', '外部包'));
      if (b.id) add(name, el('span', 'bak-id', b.id));
      var created = add(tr, el('td', null, fmtTime(b.created_at))); created.dataset.label = '创建时间';
      var size = add(tr, el('td', null, fmtSize(b.size_bytes))); size.dataset.label = '大小';
      var entries = add(tr, el('td', null, typeof b.entries === 'number' ? b.entries : '—'));
      entries.dataset.label = '条目';
      var sha = b.sha256 || '', shaCell = add(tr, el('td')); shaCell.dataset.label = 'SHA256';
      var code = add(shaCell, el('code', 'bak-sha', sha ? sha.slice(0, 12) : '—')); code.title = sha;
      var state = add(tr, el('td')); state.dataset.label = '状态';
      state.appendChild(b.corrupted ? chip('fail', 'corrupted') : chip('ok', '正常'));
      var ops = add(tr, el('td', 'cell-ops bak-ops')); ops.dataset.label = '操作';
      button(ops, '校验', 'btn-ghost', function () { verify(b); });
      button(ops, '恢复', 'btn-ghost', function () { openConfirm('restore', b); });
      button(ops, '删除', 'btn-ghost bak-danger', function () { openConfirm('delete', b); });
    });
  }
  function resultTitle(kind) {
    return { create: '创建结果', verify: '校验结果', restore: '恢复结果', delete: '删除结果' }[kind] || '操作结果';
  }
  function paintResult() {
    if (!S.resultHost) return;
    S.resultHost.textContent = '';
    if (!S.result) return;
    var r = S.result, d = r.data || {};
    var p = panel(S.resultHost, resultTitle(r.kind), r.id || ''), dl = add(p, el('dl', 'bak-kv bak-result-body'));
    if (r.kind === 'create') {
      kv(dl, 'size_bytes', fmtSize(d.size_bytes) + '（' + (d.size_bytes != null ? d.size_bytes : '—') + ' B）');
      kv(dl, 'entries', d.entries); kv(dl, 'sha256', d.sha256); kv(dl, 'duration_ms', d.duration_ms);
    } else if (r.kind === 'verify') {
      kv(dl, 'sha_match', String(d.sha_match)); kv(dl, 'entries', d.entries);
      kv(dl, 'size_bytes', fmtSize(d.size_bytes)); kv(dl, 'uncompressed_bytes', fmtSize(d.uncompressed_bytes));
      kv(dl, 'sha256', d.sha256); kv(dl, 'corrupted', String(d.corrupted)); kv(dl, 'duration_ms', d.duration_ms);
    } else if (r.kind === 'restore') {
      kv(dl, 'restored_entries', d.restored_entries); kv(dl, 'target_dir', d.target_dir);
      kv(dl, 'failed', (d.failed || []).length); kv(dl, 'duration_ms', d.duration_ms);
      if (d.failed && d.failed.length) {
        var fl = add(p, el('ul', 'bak-failed'));
        d.failed.forEach(function (item) { add(fl, el('li', null, item)); });
      }
    } else {
      kv(dl, 'id', d.id); kv(dl, 'deleted', String(d.deleted)); kv(dl, 'duration_ms', d.duration_ms);
    }
    if (d.skipped && d.skipped.length) add(p, el('p', 'field-hint', '跳过：' + d.skipped.join('、')));
    if (d.warnings && d.warnings.length) add(p, el('p', 'field-hint', '警告：' + d.warnings.join('、')));
  }
  function openConfirm(kind, b) {
    S.confirm = { kind: kind, backup: b, target: '', msg: null };
    paintConfirm();
    if (S.confirmHost) S.confirmHost.scrollIntoView({ block: 'nearest' });
  }
  function paintConfirm() {
    if (!S.confirmHost) return;
    S.confirmHost.textContent = ''; S.confirmMsg = null;
    if (!S.confirm) return;
    var c = S.confirm, b = c.backup || {};
    var p = add(S.confirmHost, el('section', 'panel bak-confirm'));
    var h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', c.kind === 'restore' ? '恢复确认' : '删除确认'));
    add(h, el('span', 'panel-meta', '二次确认 · 页面内'));
    var dl = add(p, el('dl', 'bak-kv bak-confirm-body'));
    kv(dl, 'id', b.id); kv(dl, 'name', b.name); kv(dl, 'created_at', fmtTime(b.created_at));
    kv(dl, 'size_bytes', fmtSize(b.size_bytes)); kv(dl, 'entries', b.entries);
    kv(dl, 'sha256', b.sha256);
    if (c.kind === 'restore') {
      add(p, el('p', 'bak-warn', '目标目录必须不存在，或存在且为空目录；非空目标会被插件拒绝（E_CONFLICT），不会覆盖已有文件。'));
      var f = add(p, el('form', 'bak-confirm-form'));
      c.targetInput = input('text', 'span2', '/tmp/restore-target');
      field(f, '目标目录', c.targetInput, 'span2');
      var ops = add(f, el('div', 'bak-confirm-ops span2'));
      button(ops, '取消', 'btn-ghost', closeConfirm);
      var ok = add(ops, el('button', 'btn btn-primary', '确认恢复')); ok.type = 'submit';
      f.addEventListener('submit', function (ev) { ev.preventDefault(); doRestore(c, ok); });
    } else {
      add(p, el('p', 'bak-warn', '删除会同时移除备份包与 .sha256 / .meta.json sidecar，不可恢复。'));
      var ops2 = add(p, el('div', 'bak-confirm-ops'));
      button(ops2, '取消', 'btn-ghost', closeConfirm);
      button(ops2, '确认删除', 'bak-danger', function () { doDelete(c); });
    }
    S.confirmMsg = add(p, el('div', 'bak-confirm-msg'));
  }
  function closeConfirm() { S.confirm = null; paintConfirm(); }
  function doRestore(c, btn) {
    var target = c.targetInput.value.trim();
    if (!target) { if (S.confirmMsg) S.confirmMsg.textContent = '请填写恢复目标目录'; return; }
    btn.disabled = true; if (S.confirmMsg) S.confirmMsg.textContent = '';
    setStatus('正在恢复 ' + c.backup.id + ' 到 ' + target + '…');
    invoke('backup.restore', { id: c.backup.id, target_dir: target }).then(function (data) {
      S.result = { kind: 'restore', id: c.backup.id, data: data };
      S.confirm = null; paintConfirm(); paintResult();
      var failed = (data.failed || []).length;
      setStatus('恢复完成：' + data.restored_entries + ' 个条目' + (failed ? '，失败 ' + failed + ' 个' : '，无失败'),
        failed ? 'fail' : 'ok');
      loadList(true);
    }, function (err) {
      btn.disabled = false;
      if (S.confirmMsg) S.confirmMsg.textContent = '恢复失败：' + err.message;
      setStatus('恢复失败：' + err.message, 'fail');
    });
  }
  function doDelete(c) {
    var btn = S.confirmHost.querySelector('.bak-danger');
    if (btn) btn.disabled = true;
    if (S.confirmMsg) S.confirmMsg.textContent = '';
    invoke('backup.delete', { id: c.backup.id }).then(function (data) {
      S.result = { kind: 'delete', id: c.backup.id, data: data };
      S.confirm = null; paintConfirm(); paintResult();
      setStatus('已删除备份 ' + data.id + '（deleted=' + data.deleted + '，' + data.duration_ms + 'ms）', 'ok');
      loadList(true); loadStats();
    }, function (err) {
      if (btn) btn.disabled = false;
      if (S.confirmMsg) S.confirmMsg.textContent = '删除失败：' + err.message;
      setStatus('删除失败：' + err.message, 'fail');
    });
  }
  function verify(b) {
    setStatus('正在校验 ' + b.id + '…');
    invoke('backup.verify', { id: b.id }).then(function (data) {
      S.result = { kind: 'verify', id: b.id, data: data }; paintResult();
      setStatus('校验完成：sha_match=' + data.sha_match + ' · entries=' + data.entries +
        ' · uncompressed=' + fmtSize(data.uncompressed_bytes), data.sha_match ? 'ok' : 'fail');
      loadList(true);
    }, function (err) {
      setStatus('校验失败：' + err.message, 'fail');
    });
  }
  function loadList(quiet) {
    if (!quiet) setStatus('正在读取备份列表…');
    invoke('backup.list', {}).then(function (data) {
      if (S.destroyed) return;
      S.backups = data.backups || []; paintList();
      if (!quiet) setStatus('共 ' + S.backups.length + ' 个备份', 'ok');
    }, function (err) {
      if (S.destroyed) return;
      setStatus('读取失败：' + err.message, 'fail'); S.backups = []; paintList();
    });
  }
  function submitCreate(ev) {
    ev.preventDefault();
    var name = S.name.value.trim(), paths = S.paths.value.split('\n').map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
    var exclude = S.exclude.value.split(/[\n,]/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
    if (!name) { setStatus('请填写备份名称', 'fail'); return; }
    if (!paths.length) { setStatus('请至少填写一个备份路径（每行一个）', 'fail'); return; }
    S.busy = true; S.submit.disabled = true;
    setStatus('正在打包 ' + name + '（' + paths.length + ' 个路径，' + S.compression.value + '）…');
    invoke('backup.create', { name: name, paths: paths, exclude: exclude, compression: S.compression.value })
      .then(function (data) {
        S.busy = false; S.submit.disabled = false;
        S.result = { kind: 'create', id: data.id, data: data }; paintResult();
        setStatus('备份已创建：' + data.id + ' · ' + fmtSize(data.size_bytes) + ' · ' + data.entries +
          ' 条目 · sha ' + String(data.sha256 || '').slice(0, 12) + ' · ' + data.duration_ms + 'ms', 'ok');
        S.paths.value = ''; loadList(true); loadStats();
      }, function (err) {
        S.busy = false; S.submit.disabled = false;
        setStatus('创建失败：' + err.message, 'fail');
      });
  }
  function openConfig() {
    if (!S.root) return;
    if (!window.KoreShell || typeof window.KoreShell.openConfig !== 'function') {
      setStatus('配置面板未加载，请刷新页面后重试', 'fail'); return;
    }
    window.KoreShell.openConfig(S.root, 'backup', {
      title: '备份设置',
      onSaved: function () { loadList(true); }
    });
  }
  function injectCSS() {
    if (document.getElementById('kore-backup-sched-css')) return;
    var style = el('style', null, [
      '.bak-sched-grid{display:grid;grid-template-columns:1fr;gap:var(--kore-space-3);padding:var(--kore-space-4);}',
      '.bak-sched-msg,.bak-ret-msg{min-height:18px;padding:0 var(--kore-space-4) var(--kore-space-2);font-size:var(--kore-font-12);word-break:break-word;}',
      '.bak-sched-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4);background:var(--kore-warning-bg);border-bottom:1px solid var(--kore-border-2);font-size:var(--kore-font-12);}',
      '.bak-sched-confirm span{flex:1 1 220px;}',
      '.bak-task-host{overflow-x:auto;}',
      '.bak-task-table{width:100%;min-width:760px;border-collapse:collapse;font-size:var(--kore-font-13);}',
      '.bak-task-table thead th{text-align:left;padding:var(--kore-space-2) var(--kore-space-3);color:var(--kore-text-2);font-size:var(--kore-font-12);font-weight:400;white-space:nowrap;border-bottom:1px solid var(--kore-border-2);}',
      '.bak-task-table tbody tr + tr{border-top:1px solid var(--kore-border-2);}',
      '.bak-task-table td{padding:var(--kore-space-2) var(--kore-space-3);vertical-align:middle;}',
      '.bak-list-summary{margin:0;padding:var(--kore-space-2) var(--kore-space-4);color:var(--kore-text-2);font-size:var(--kore-font-12);border-bottom:1px solid var(--kore-border-2);}',
      '.bak-ret-ops{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);align-items:end;}',
      '.bak-ret-result{padding:0 var(--kore-space-4) var(--kore-space-3);font-size:var(--kore-font-12);}',
      '.bak-ret-head{margin:0 0 var(--kore-space-2);font-weight:600;color:var(--kore-text-1);}',
      '.bak-ret-head.ok{color:var(--kore-success);}',
      '.bak-ret-list{margin:0;padding-left:var(--kore-space-6);color:var(--kore-text-2);}',
      '.bak-ret-note{margin:var(--kore-space-2) 0 0;color:var(--kore-text-3);}',
      '@media (min-width:640px){.bak-sched-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);} .bak-sched-grid .span2{grid-column:1 / -1;}}',
      '@media (max-width:639px){.bak-task-table{min-width:640px;}}'
    ].join(''));
    style.id = 'kore-backup-sched-css'; document.head.appendChild(style);
  }
  function build(root) {
    S.root = root;
    var head = add(root, el('header', 'view-head view-head-split'));
    var headMain = add(head, el('div', 'view-head-main'));
    add(headMain, el('h2', 'view-title', '备份'));
    add(headMain, el('p', 'view-sub', '打包目录、定时执行、按份数保留与完整性校验；恢复与删除都需要页面内二次确认。'));
    var gear = add(head, el('button', 'btn btn-ghost cfg-gear', '⚙ 设置'));
    gear.type = 'button';
    gear.setAttribute('aria-label', '备份设置');
    on(gear, openConfig);
    S.status = add(root, el('div', 'bak-status muted')); S.status.setAttribute('role', 'status');
    S.confirmHost = add(root, el('div', 'bak-confirm-host'));
    var create = panel(root, '新建备份', 'gzip 或无压缩 tar'), form = add(create, el('form', 'bak-form'));
    S.name = input('text', 'span2', 'site-20261122'); field(form, '名称', S.name, 'span2');
    S.paths = textarea(4, '/var/www/site\n/etc/kore'); field(form, '路径列表（每行一个）', S.paths, 'span2');
    S.exclude = input('text', 'span2', '*.log, node_modules（可选，glob）'); field(form, '排除 glob（可选）', S.exclude, 'span2');
    S.compression = el('select', 'field-input');
    [['gzip', 'gzip 压缩'], ['none', '不压缩（tar）']].forEach(function (o) {
      var opt = el('option', null, o[1]); opt.value = o[0]; S.compression.appendChild(opt);
    });
    field(form, '压缩', S.compression);
    S.submit = add(form, el('button', 'btn btn-primary bak-submit', '创建备份')); S.submit.type = 'submit';
    add(form, el('p', 'field-hint span2', '路径必须在「设置」里的允许根路径之下；点右上角设置可改备份目录与白名单。符号链接按链接记录。'));
    form.addEventListener('submit', submitCreate);

    var sched = panel(root, '定时备份', '内核 scheduler · 到点自动打包并清理');
    var sForm = add(sched, el('form', 'bak-sched-grid'));
    S.sched.preset = el('select', 'field-input');
    CRON_PRESETS.forEach(function (p) {
      var opt = el('option', null, p.label); opt.value = p.id; S.sched.preset.appendChild(opt);
    });
    field(sForm, '执行频率', S.sched.preset);
    S.sched.custom = input('text', null, '0 3 * * *（分 时 日 月 周）');
    S.sched.customField = field(sForm, '自定义 cron', S.sched.custom);
    S.sched.customField.hidden = true;
    S.sched.keep = input('number', null, '7');
    S.sched.keep.value = '7'; S.sched.keep.min = '1'; S.sched.keep.max = '100';
    field(sForm, '保留份数（1–100）', S.sched.keep);
    S.sched.paths = textarea(2, '/var/www');
    field(sForm, '定时备份的路径（每行一个）', S.sched.paths, 'span2');
    add(sForm, el('p', 'field-hint span2', '保存会创建两条任务：到点打包 + 1 分钟后按保留份数清理；重复保存会替换本页创建的任务。路径必须在「设置」的允许根路径之下。'));
    S.sched.save = add(sForm, el('button', 'btn btn-primary', '保存定时备份')); S.sched.save.type = 'submit';
    sForm.addEventListener('submit', saveSchedule);
    S.sched.preset.addEventListener('change', function () {
      S.sched.customField.hidden = S.sched.preset.value !== 'custom';
    });
    S.sched.msg = add(sched, el('p', 'bak-sched-msg muted'));
    S.sched.listHost = add(sched, el('div', 'bak-sched-list'));
    S.sched.count = sched.querySelector('.panel-head').appendChild(el('span', 'panel-meta', ''));

    var ret = panel(root, '保留策略', '只删本插件创建、且不是最新一份的旧备份');
    var rForm = add(ret, el('form', 'bak-sched-grid'));
    S.ret.keep = input('number', null, '7');
    S.ret.keep.value = '7'; S.ret.keep.min = '1'; S.ret.keep.max = '100';
    field(rForm, '保留份数（1–100）', S.ret.keep);
    var rOps = add(rForm, el('div', 'bak-ret-ops'));
    button(rOps, '预览（不删除）', 'btn', previewRetention);
    S.ret.run = button(rOps, '立即清理', 'bak-danger', runRetention); S.ret.run.disabled = true;
    add(rForm, el('p', 'field-hint span2', '按创建时间倒序只留最近 N 份；最新一份永不删除；手工放入的外部包（无插件 sidecar）一律跳过。'));
    S.ret.msg = add(ret, el('p', 'bak-ret-msg muted'));
    S.ret.host = add(ret, el('div', 'bak-ret-host'));
    S.ret.keep.addEventListener('input', function () {
      S.ret.preview = null; S.ret.run.disabled = true;
      if (S.ret.host) S.ret.host.textContent = '';
    });

    var list = panel(root, '备份列表');
    S.summaryHost = add(list, el('p', 'bak-list-summary', '正在统计…'));
    S.count = list.querySelector('.panel-head').appendChild(el('span', 'panel-meta', ''));
    S.listHost = add(list, el('div', 'bak-list'));
    S.resultHost = add(root, el('div', 'bak-result-host'));
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    injectCSS();
    var root = add(container, el('section', 'backups'));
    build(root);
    loadList(false); loadStats(); loadTasks(true);
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreBackup = { render: render };
})();
