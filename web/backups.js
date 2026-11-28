/* kore 主壳 · 备份管理（web/backups.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/backup/backup.list）；
   方法段一律写完整限定名 backup.*，裸动词只是插件侧兼容，不得依赖。
   window.KoreBackup.render(container) 调 backup 插件：
   backup.create / .presets / .list / .verify / .restore / .delete / .retention / .stats。
   定时备份不在插件里实现：前端直接调内核 ADR-0019 的 /api/v1/scheduler/tasks，
   创建 backup.create（打包）+ backup.retention（1 分钟后清理）两条任务。
   恢复/删除/清理与任务删除一律走页面内二次确认面板（不用 window.confirm）。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/backup/';
  var SCHED = '/api/v1/scheduler/tasks';
  // backup.list 一次返回全部备份（无 limit），保留策略外的历史包会累积；
  // 列表分批渲染（默认 50 行 + 加载更多），避免上百份备份各带 4 个行内按钮整表铺开。
  var LIST_PAGE = 50;
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
      exclude: null, compression: null, submit: null, dims: null,
      presetList: [], presetDefault: '', presetSelected: '', presetHost: null, presetMsg: null,
      presetDb: null, presetDbField: null,
      jobs: [], jobsHost: null, jobsMsg: null,
      progWatch: null, progHost: null, progState: null, progText: null, progHint: null,
      stats: null, summaryHost: null, listHost: null, count: null,
      listShown: LIST_PAGE, moreBtn: null,
      tasks: [], sched: {}, ret: {}, taskDelete: null, schedHydrated: false,
      retPresets: [], retPresetSelected: '',
      verify: { supported: null, version: '' },
      upload: { supported: null, version: '' }, uploadBtn: null,
      srcDetect: { state: 'idle', data: null, error: null }, presetTask: null,
      pathsTouched: false, pathsAuto: '', presetAuto: '', presetPicked: false,
      pathsBadge: '', schedPathsTouched: false, schedPathsAuto: '', schedPathsBadge: '',
      detBadge: null, detBox: null, schedDetBadge: null, schedDetMeta: null };
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
      var params = createTask.params || {};
      var dims = params.dimensions || [];
      if (S.sched.dims) {
        S.sched.dims.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
          cb.checked = dims.indexOf(cb.value) >= 0;
        });
      }
      // 回填已生效任务的库名：否则刷新后库名输入框为空，用户一保存就把夜间任务改坏。
      var database = params.db && params.db.database ? params.db.database : '';
      if (S.sched.db) S.sched.db.value = database;
      if (typeof S.sched.syncDbField === 'function') S.sched.syncDbField();
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
    var dims = collectDims(S.sched.dims);
    if (!dims.length) { setNote(S.sched.msg, '请至少选择一个备份对象（站点目录 / MySQL 数据库）', 'fail'); return; }
    if (!paths.length && dims.indexOf('site') >= 0) { setNote(S.sched.msg, '选择了站点目录时请填写至少一个备份路径（每行一个）', 'fail'); return; }
    // db 维度必须带库名：后端 create 会校验 db.database（create.go:133），
    // 之前表单没这个输入，定时任务到点必然 E_INVALID——现在保存前就地拦住。
    var database = S.sched.db ? S.sched.db.value.trim() : '';
    if (dims.indexOf('db') >= 0 && !database) {
      setNote(S.sched.msg, '选择了 MySQL 数据库时请填写库名（在下方「备份对象」旁的输入框），例：wordpress', 'fail');
      return;
    }
    var createParams = { name: 'auto', dimensions: dims, paths: paths, compression: 'gzip' };
    if (dims.indexOf('db') >= 0) createParams.db = { database: database };
    var definitions = [
      { name: '备份 · 自动创建', plugin: 'backup', method: 'backup.create',
        params: createParams, schedule: cron, timeout_s: 1800 },
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
  // ---- 备份对象维度（USABILITY：预设优先，默认全选常用项） ----
  var DIM_LABELS = { site: '站点目录', db: 'MySQL 数据库' };
  function dimsBox(defaults, target) {
    var box = el('div', 'bak-dims');
    Object.keys(DIM_LABELS).forEach(function (key) {
      var label = add(box, el('label', 'bak-dim'));
      var cb = add(label, el('input'));
      cb.type = 'checkbox'; cb.value = key; cb.checked = defaults.indexOf(key) >= 0;
      add(label, el('span', null, DIM_LABELS[key]));
      if (target) target[key] = cb;
    });
    return box;
  }
  function collectDims(box) {
    var out = [];
    if (!box) return out;
    box.querySelectorAll('input[type=checkbox]').forEach(function (cb) { if (cb.checked) out.push(cb.value); });
    return out;
  }

  // ---- 备份预设（backup.presets；产品原则①：预设优先，自定义兜底） ----
  // 契约（读自 ../kore-plugin-backup/internal/backupop/preset.go:143-167，不猜）：
  //   入参 {}；出参 { default_preset, presets:[{ id, label, description,
  //   fields:[{key,label,type,required,help}],
  //   expanded:{name,dimensions,paths,exclude,compression,requires_database} }],
  //   retention_presets:[{id,label,keep,schedule,rationale}], hint }。
  // 选中预设 → 把 expanded 填进新建表单；填完仍可手改（后端 create 只补空字段）。
  // db 预设需要 db.database：条件显示库名输入，提交时按 createParams.db={database} 传。
  function findPreset(id) {
    var found = null;
    S.presetList.forEach(function (p) { if (p && p.id === id) found = p; });
    return found;
  }
  function loadPresets() {
    if (!S.presetHost) return Promise.resolve();
    S.presetHost.textContent = '正在读取备份预设…';
    S.presetHost.className = 'bak-presets loading muted';
    return invoke('backup.presets', {}).then(function (data) {
      if (S.destroyed) return;
      S.presetList = Array.isArray(data.presets) ? data.presets : [];
      S.presetDefault = data.default_preset || '';
      // retention_presets 是后端已声明、前端此前未消费的能力（preset.go:395-400）：
      // 一键把「频率 + 保留份数」成套填进定时/保留表单，省去手填 cron。
      S.retPresets = Array.isArray(data.retention_presets) ? data.retention_presets : [];
      paintPresets();
      paintRetPresets();
      // 默认预设自动套用：用户零点击也能拿到一份可提交的参数（预设优先）。
      var initial = findPreset(S.presetDefault) || S.presetList[0];
      if (initial) applyPreset(initial, true);
    }, function (err) {
      if (S.destroyed) return;
      S.presetList = [];
      paintPresets(err);
    });
  }
  // 保留策略预设：点一下同时填好执行频率与保留份数（两处表单同步），仍是自定义兜底。
  function applyRetPreset(p) {
    if (!p) return;
    S.retPresetSelected = p.id || '';
    var cron = String(p.schedule || '').trim();
    if (cron) {
      var matched = false;
      CRON_PRESETS.forEach(function (c) { if (c.cron === cron) { S.sched.preset.value = c.id; matched = true; } });
      if (!matched) { S.sched.preset.value = 'custom'; S.sched.custom.value = cron; }
      S.sched.customField.hidden = matched;
    }
    var keep = parseInt(p.keep, 10);
    if (!isNaN(keep) && keep >= 1 && keep <= 100) {
      S.sched.keep.value = String(keep); S.ret.keep.value = String(keep);
    }
    S.ret.preview = null; S.ret.run.disabled = true;
    if (S.ret.host) S.ret.host.textContent = '';
    paintRetPresets();
    var msg = '已选「' + (p.label || p.id) + '」：' + cronText({ schedule: cron }) +
      ' 自动备份，保留 ' + keep + ' 份。' + (p.rationale ? p.rationale + '。' : '');
    setNote(S.sched.msg, msg, 'ok');
    setRetMsg(msg, 'ok');
  }
  function paintRetPresets() {
    if (!S.retPresetHost) return;
    S.retPresetHost.textContent = '';
    if (!S.retPresets.length) return;
    var row = add(S.retPresetHost, el('div', 'bak-preset-row'));
    row.setAttribute('role', 'group'); row.setAttribute('aria-label', '保留策略预设');
    S.retPresets.forEach(function (p) {
      var b = add(row, el('button', 'btn btn-ghost bak-preset', p.label || p.id));
      b.type = 'button'; b.dataset.id = p.id || '';
      b.title = (p.rationale || '') + '（点一下填好频率和保留份数）';
      b.setAttribute('aria-pressed', S.retPresetSelected === p.id ? 'true' : 'false');
      if (S.retPresetSelected === p.id) b.classList.add('bak-preset-active');
      on(b, function () { applyRetPreset(p); });
    });
  }
  function setPresetMsg(text, tone) {
    if (!S.presetMsg) return;
    S.presetMsg.textContent = text || '';
    S.presetMsg.className = 'bak-preset-msg ' + (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function paintPresets(err) {
    if (!S.presetHost) return;
    S.presetHost.textContent = '';
    S.presetHost.className = 'bak-presets';
    if (err) {
      if (window.KoreUI && typeof window.KoreUI.errorBlock === 'function') {
        S.presetHost.appendChild(window.KoreUI.errorBlock(err, {
          title: '预设没能读出来',
          action: '刷新页面重试，或直接跳过预设在下方手动填写备份参数',
          onRetry: loadPresets, retryLabel: '重新读取预设'
        }));
      } else {
        add(S.presetHost, el('p', 'row-note-fail', '预设读取失败。怎么办：刷新页面重试，或在下方手动填写备份参数。'));
      }
      return;
    }
    if (!S.presetList.length) {
      add(S.presetHost, el('p', 'empty-state-text', '当前没有可用的备份预设。怎么办：在下方手动填写参数也能正常创建备份。'));
      return;
    }
    var row = add(S.presetHost, el('div', 'bak-preset-row'));
    row.setAttribute('role', 'group'); row.setAttribute('aria-label', '备份预设');
    S.presetList.forEach(function (p) {
      var b = add(row, el('button', 'btn btn-ghost bak-preset', p.label || p.id));
      b.type = 'button';
      b.dataset.id = p.id || '';
      b.title = p.description || '';
      b.setAttribute('aria-pressed', S.presetSelected === p.id ? 'true' : 'false');
      if (S.presetSelected === p.id) b.classList.add('bak-preset-active');
      on(b, function () { applyPreset(p, false); });
    });
  }
  // applyPreset 把预设展开结果填进新建表单；silent=true 是默认预设自动套用，不抢焦点。
  function applyPreset(p, silent) {
    if (!p) return;
    var expanded = p.expanded || {};
    S.presetSelected = p.id || '';
    if (S.name) S.name.value = expanded.name || S.presetSelected;
    if (S.compression) S.compression.value = expanded.compression || 'gzip';
    if (S.paths) S.paths.value = (expanded.paths || []).join('\n');
    S.presetAuto = S.paths ? S.paths.value : '';
    if (!silent) {
      // 用户显式选了预设：预设值是用户的选择，探测结果不再覆盖它（可点「重新检测」拉回来）。
      S.presetPicked = true; S.pathsTouched = false; syncPathsBadge();
    }
    if (S.exclude) S.exclude.value = (expanded.exclude || []).join(', ');
    if (S.dims) {
      var wanted = expanded.dimensions || [];
      S.dims.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
        cb.checked = wanted.indexOf(cb.value) >= 0;
      });
    }
    var needsDb = !!(expanded.requires_database || (p.fields || []).some(function (f) { return f && f.required && f.key === 'db.database'; }));
    if (S.presetDbField) S.presetDbField.hidden = !needsDb;
    paintPresets();
    var dimsNow = expanded.dimensions || [];
    var noPaths = dimsNow.indexOf('site') >= 0 && !(expanded.paths || []).length;
    var desc = p.description ? p.description + '。' : '';
    var msg, tone;
    if (needsDb) {
      msg = desc + '还需填写数据库名。'; tone = null;
    } else if (noPaths) {
      // callPresets 在本机没找到可备份目录时仍列出预设、但 paths 留空（preset.go:367-370）。
      // 必须给出可操作下一步，不能让用户以为"填好了"就点创建然后撞校验错误。
      msg = desc + '本预设要备份的目录在本机没找到，请在下方「备份源路径」手动填写实际路径（可到「设置 → 允许的根路径」加入目录）。';
      tone = 'fail';
    } else {
      msg = desc + '参数已自动填好，仍可自行修改。'; tone = 'ok';
    }
    if (!silent) msg += ' 已选用「' + (p.label || p.id) + '」。';
    setPresetMsg(msg, tone);
    if (!silent && S.presetDbField && needsDb && S.presetDb) S.presetDb.focus();
  }

  // ---- 备份源自动检测（产品原则②：自动发现，不让人填环境细节） ----
  // 数据源 = backup.sources.detect：插件侧 os.Lstat/os.ReadDir 只读探测 + 白名单过滤
  // （与 preset.go 的 existingAllowed 同一口径，见 kore-plugin-backup/internal/backupop/detect.go）。
  // 纪律：
  //   1) 只在打开页面 / 点「重新检测」时各调一次，不进首屏、不轮询、不新增定时器（G-19）；
  //   2) 用户手改过的路径不再被探测覆盖（原则②「用户改过的值不得被下一次探测覆盖」）；
  //   3) 探测失败不挡「创建备份」，只把「怎么办」写清楚（原则④）；
  //   4) 白名单外的目录如实列出但不可预填（预填一个点创建必失败的路径更糟），给「加入允许根路径」。
  var KIND_LABELS = { site: '网站目录', config: '配置目录', app: '应用目录', data: '数据目录' };
  var BADGE_TEXT = { auto: '已自动检测', preset: '预设已填', manual: '手动填写' };
  function detectedInfo() {
    var data = S.srcDetect.data || {};
    return {
      data: data,
      sources: Array.isArray(data.sources) ? data.sources : [],
      suggested: Array.isArray(data.suggested_paths) ? data.suggested_paths : []
    };
  }
  function splitPathLines(text) {
    return String(text || '').split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  }
  function detectClock(iso) {
    var d = new Date(iso || '');
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
  }
  function paintPathBadges() {
    if (S.detBadge) {
      var text = BADGE_TEXT[S.pathsBadge] || '';
      S.detBadge.hidden = !text; S.detBadge.textContent = text;
    }
    if (S.schedDetBadge) {
      var schedText = BADGE_TEXT[S.schedPathsBadge] || '';
      S.schedDetBadge.hidden = !schedText; S.schedDetBadge.textContent = schedText;
    }
  }
  // syncPathsBadge 按输入框实际内容判断来源：等于自动探测值 = 已自动检测，等于预设值 = 预设已填，否则手动。
  function syncPathsBadge() {
    var value = S.paths ? S.paths.value.trim() : '';
    if (!value) S.pathsBadge = '';
    else if (S.pathsAuto && value === S.pathsAuto.trim()) S.pathsBadge = 'auto';
    else if (S.presetAuto && value === S.presetAuto.trim()) S.pathsBadge = 'preset';
    else S.pathsBadge = 'manual';
    paintPathBadges();
  }
  // applyDetected 把探测结果填进两处路径输入框；force=true 是用户点「重新检测」，可以覆盖自动填过的值。
  function applyDetected(force) {
    var info = detectedInfo();
    if (!info.data) return;
    var suggested = info.suggested;
    if (S.paths) {
      var canFill = !S.pathsTouched && (force || !S.presetPicked);
      if (canFill && suggested.length) {
        S.paths.value = suggested.join('\n');
        S.pathsAuto = S.paths.value;
        S.pathsBadge = 'auto';
      } else if (!S.paths.value.trim()) {
        S.pathsBadge = '';
      }
    }
    if (S.sched.paths && !S.schedPathsTouched && suggested.length) {
      var schedValue = S.sched.paths.value.trim();
      if (!schedValue || S.sched.paths.value === S.schedPathsAuto) {
        S.sched.paths.value = suggested.join('\n');
        S.schedPathsAuto = S.sched.paths.value;
        S.schedPathsBadge = 'auto';
      }
    }
    paintPathBadges();
  }
  function toggleDetectedPath(path) {
    if (!S.paths) return;
    var lines = splitPathLines(S.paths.value);
    var at = lines.indexOf(path);
    if (at >= 0) lines.splice(at, 1); else lines.push(path);
    S.paths.value = lines.join('\n');
    S.pathsTouched = true;
    setStatus(at >= 0 ? '已从备份源移除 ' + path : '已把 ' + path + ' 加入备份源', 'ok');
    syncPathsBadge();
  }
  // addAllowRoot 把白名单外目录加入「允许的根路径」后重新探测：一次点击即可采用，不用去设置页手填。
  function addAllowRoot(path, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '正在加入…'; }
    invoke('backup.config.get', {}).then(function (data) {
      var values = (data && data.values) || {};
      var roots = Array.isArray(values.allow_roots) ? values.allow_roots.slice() : [];
      if (roots.indexOf(path) < 0) roots.push(path);
      return invoke('backup.config.set', { values: { allow_roots: roots } });
    }).then(function () {
      setStatus('已把 ' + path + ' 加入允许的根路径，正在重新检测…', 'ok');
      loadDetect(true);
    }, function (err) {
      if (btn) { btn.disabled = false; btn.textContent = '加入允许根路径'; }
      setStatus('加入允许根路径失败：' + (err && err.message ? err.message : '接口不可用') +
        '。怎么办：点右上角「⚙ 设置」→「允许的根路径」手动加上这个目录，再点「重新检测」。', 'fail');
    });
  }
  function detectRetryButton(parent) {
    var b = add(parent, el('button', 'btn btn-ghost bak-detect-btn', '重新检测'));
    b.type = 'button';
    on(b, function () { loadDetect(true); });
    return b;
  }
  function paintDetect() {
    var st = S.srcDetect.state, info = detectedInfo(), clock = detectClock(info.data.detected_at);
    if (S.detBox) {
      S.detBox.textContent = '';
      S.detBox.className = 'bak-detect bak-detect-' + st;
      if (st === 'loading') {
        add(S.detBox, el('p', 'bak-detect-meta muted', '正在只读探测本机可备份的目录…'));
      } else if (st === 'fail') {
        add(S.detBox, el('p', 'bak-detect-hint row-note-fail',
          '自动探测没成功（' + ((S.srcDetect.error && S.srcDetect.error.message) || '接口不可用') +
          '）。怎么办：直接在下面手填绝对路径也能创建备份，或点「重新检测」再试一次。'));
        detectRetryButton(S.detBox);
      } else if (st === 'ok') {
        var head = add(S.detBox, el('div', 'bak-detect-head'));
        add(head, el('span', 'bak-detect-meta',
          (info.suggested.length
            ? '检测到 ' + info.suggested.length + ' 个可直接备份的目录'
            : '本机没检测到可直接备份的目录') + (clock ? ' · 只读探测 ' + clock : '')));
        detectRetryButton(head);
        if (info.sources.length) {
          var chips = add(S.detBox, el('div', 'bak-detect-chips'));
          chips.setAttribute('role', 'group');
          chips.setAttribute('aria-label', '检测到的备份源目录');
          info.sources.forEach(function (src) {
            var row = add(chips, el('span', 'bak-detect-chip bak-detect-' + src.kind));
            add(row, el('span', 'bak-chip-kind', KIND_LABELS[src.kind] || '目录'));
            add(row, el('span', 'bak-chip-path', src.path));
            if (src.kind === 'data') {
              row.title = src.hint || '数据目录建议用「数据库备份」预设做一致性导出';
              add(row, el('span', 'bak-chip-note', '用数据库备份预设'));
              return;
            }
            if (!src.in_roots) {
              var join = add(row, el('button', 'bak-chip-btn', '加入允许根路径'));
              join.type = 'button';
              join.title = '该目录不在允许的根路径内，先加入才能备份';
              on(join, function () { addAllowRoot(src.path, join); });
              return;
            }
            var inUse = S.paths ? splitPathLines(S.paths.value).indexOf(src.path) >= 0 : false;
            var use = add(row, el('button', 'bak-chip-btn' + (inUse ? ' is-on' : ''), inUse ? '已填入' : '填入'));
            use.type = 'button';
            use.setAttribute('aria-pressed', inUse ? 'true' : 'false');
            on(use, function () { toggleDetectedPath(src.path); });
          });
        }
        if (!info.suggested.length && info.data.hint) {
          add(S.detBox, el('p', 'bak-detect-hint row-note-fail', info.data.hint));
          var open = add(S.detBox, el('button', 'btn btn-ghost bak-detect-btn', '去备份设置加允许根路径'));
          open.type = 'button';
          on(open, openConfig);
        } else if (info.data.note) {
          add(S.detBox, el('p', 'bak-detect-hint', info.data.note));
        }
      }
    }
    if (S.schedDetMeta) {
      var schedText = '';
      if (st === 'loading') schedText = '正在只读探测本机可备份的目录…';
      else if (st === 'fail') schedText = '自动探测没成功，请在下面手填路径，或到上面点「重新检测」。';
      else if (st === 'ok' && info.suggested.length) {
        schedText = '已按检测结果填好' + (clock ? '（只读探测 ' + clock + '）' : '') + '；改过之后不会再被覆盖。';
      } else if (st === 'ok') schedText = '没检测到可备份目录，请在下面手填，或到上面点「重新检测」。';
      setNote(S.schedDetMeta, schedText, st === 'fail' ? 'fail' : '');
    }
    paintPathBadges();
  }
  function loadDetect(force) {
    if (!S.detBox && !S.schedDetMeta) return;
    if (force) { S.pathsTouched = false; S.schedPathsTouched = false; }
    S.srcDetect.state = 'loading';
    paintDetect();
    (S.presetTask || Promise.resolve()).then(function () {
      return invoke('backup.sources.detect', {});
    }).then(function (data) {
      if (S.destroyed) return;
      S.srcDetect = { state: 'ok', data: data || {}, error: null };
      applyDetected(force);
      paintDetect();
    }, function (err) {
      if (S.destroyed) return;
      S.srcDetect = { state: 'fail', data: null, error: err };
      paintDetect();
    });
  }

  // ---- 下载（download 分块 → Blob，同 logs/files 通道） ----
  function downloadBackup(b) {
    setStatus('正在准备下载 ' + b.id + '…');
    var chunks = [], offset = 0;
    function step() {
      invoke('backup.download', { id: b.id, inline: true, offset: offset }).then(function (d) {
        if (d.data_base64) chunks.push(d.data_base64);
        if (!d.eof && typeof d.next_offset === 'number' && d.next_offset > offset) {
          offset = d.next_offset; step(); return;
        }
        if (!chunks.length) { setStatus('下载失败：服务端未返回数据', 'fail'); return; }
        var raw = atob(chunks.join('')), bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([bytes], { type: d.content_type || 'application/gzip' }));
        var a = document.createElement('a');
        a.href = url; a.download = d.filename || (b.id + '.tar.gz'); a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        setStatus('已开始下载 ' + a.download + '（' + fmtSize(d.size_bytes || bytes.length) + '）', 'ok');
      }, function (err) { setStatus('下载失败：' + err.message, 'fail'); });
    }
    step();
  }

  // ---- 最近作业（backup.jobs；空态引导到定时备份） ----
  function loadJobs(quiet) {
    invoke('backup.jobs', { limit: 8 }).then(function (data) {
      if (S.destroyed) return;
      S.jobs = data.jobs || []; paintJobs();
    }, function (err) {
      if (S.destroyed) return;
      S.jobs = []; if (!quiet) setNote(S.jobsMsg, '作业记录读取失败：' + err.message, 'fail');
      paintJobs();
    });
  }
  function paintJobs() {
    if (!S.jobsHost) return;
    S.jobsHost.textContent = '';
    if (!S.jobs.length) {
      var empty = add(S.jobsHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '还没有备份作业。创建一次备份，或保存定时备份让它自动执行。'));
      var guide = button(empty, '创建定时备份', 'btn', function () {
        if (S.sched.host) S.sched.host.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (S.sched.paths) S.sched.paths.focus();
      });
      guide.type = 'button';
      return;
    }
    var scroll = add(S.jobsHost, el('div', 'bak-table-host'));
    var table = add(scroll, el('table', 'bak-table')); table.setAttribute('aria-label', '最近备份作业');
    // 表头必须是真实 DOM 节点：add() 直接把 child 交给 appendChild，
    // 传字符串 'thead' 会抛 TypeError 让整个「最近作业」表渲染失败（hands-on-r51 P1-1）。
    var htr = add(add(table, el('thead')), el('tr'));
    ['状态', '名称', '维度', '开始时间', '条目', '大小', '错误'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.jobs.forEach(function (job) {
      var tr = add(body, el('tr'));
      var st = add(tr, el('td')); st.appendChild(chip(job.status === 'succeeded' ? 'ok' : (job.status === 'failed' ? 'fail' : 'na'), job.status || '—'));
      add(tr, el('td', null, job.name || '—'));
      add(tr, el('td', null, (job.dimensions || []).join(' + ') || '—'));
      add(tr, el('td', null, fmtTime(job.started_at)));
      add(tr, el('td', null, typeof job.entries === 'number' ? job.entries : '—'));
      add(tr, el('td', null, fmtSize(job.bytes || 0)));
      add(tr, el('td', 'bak-job-error', job.error || '—'));
    });
  }

  // ---- 长任务进度反馈层（进行中 / 成功 / 失败三态） ----
  // backup 插件是单 socket 顺序循环（serve.go），create 阻塞期间并发的 jobs 请求会排队，
  // 所以进行中用阶段文案推进，结束后用 create 的真实返回覆盖为终态并回读 jobs 落库记录确认。
  // 不做高频轮询——排队中的旧快照只会误导用户；所有 timer 随操作结束 / 页面销毁立即清理。
  var BAK_PHASES = [
    { at: 1500, text: '正在压缩并写入归档…' },
    { at: 5000, text: '正在计算校验值并落盘…' },
    { at: 12000, text: '数据量较大，仍在打包中，请稍候…' }
  ];
  function ensureProgress() {
    if (S.progHost || !S.root) return;
    var host = add(S.root, el('div', 'bak-progress'));
    host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite');
    S.progState = add(host, el('span', 'bak-progress-phase'));
    var track = add(host, el('div', 'bak-progress-track'));
    add(track, el('span', 'bak-progress-fill'));
    S.progText = add(host, el('span', 'bak-progress-text'));
    S.progHint = add(host, el('span', 'bak-progress-hint'));
    S.progHost = host;
    setProgress('idle', '', '');
  }
  function setProgress(tone, phase, hint) {
    if (!S.progHost) return;
    S.progHost.hidden = tone === 'idle';
    S.progHost.className = 'bak-progress bak-progress-' + tone;
    if (S.progState) S.progState.textContent = phase || '';
    if (S.progHint) S.progHint.textContent = hint || '';
    if (S.progText) S.progText.textContent = tone === 'ok' ? '成功' : tone === 'fail' ? '失败' : tone === 'busy' ? '进行中' : '';
    var fill = S.progHost.querySelector('.bak-progress-fill');
    if (fill) fill.style.width = tone === 'busy' ? '35%' : tone === 'ok' ? '100%' : '100%';
  }
  function stopProgress() {
    if (S.progWatch) {
      for (var i = 0; i < S.progWatch.length; i++) clearTimeout(S.progWatch[i]);
      S.progWatch = null;
    }
  }
  function startProgress(name) {
    ensureProgress(); stopProgress();
    S.progWatch = [];
    setProgress('busy', '正在准备备份「' + name + '」…', '');
    BAK_PHASES.forEach(function (p) {
      S.progWatch.push(setTimeout(function () {
        if (S.destroyed || !S.progWatch) return;
        setProgress('busy', p.text, '');
      }, p.at));
    });
  }
  function progressFail(err) {
    var msg = String((err && err.message) || err || '未知错误');
    setProgress('fail', '备份失败', msg + '。怎么办：请确认路径在允许的目录内、磁盘空间充足，再到「设置」核对备份目录权限后重试。');
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
      // 空态三件套：当前没有 X + 一句话说明 + 下一步按钮（跳到上方「新建备份」表单）。
      S.listHost.appendChild(window.KoreUI.emptyBlock({
        title: '还没有备份',
        text: '第一次备份成功后会按时间列在这里，并按保留份数自动清理。建议先备份站点目录。',
        label: '去创建第一个备份',
        onClick: function () {
          var form = document.querySelector('.bak-form');
          if (form && form.scrollIntoView) form.scrollIntoView({ block: 'center' });
          if (S.submit) S.submit.focus();
        }
      }));
      return;
    }
    var scroll = add(S.listHost, el('div', 'bak-table-host'));
    var table = add(scroll, el('table', 'bak-table')); table.setAttribute('aria-label', '备份列表');
    var htr = add(add(table, el('thead')), el('tr'));
    ['名称', '创建时间', '大小', '条目', 'SHA256', '状态', '操作'].forEach(function (label) {
      add(htr, el('th', null, label));
    });
    var body = add(table, el('tbody'));
    var shown = Math.min(S.listShown || LIST_PAGE, S.backups.length);
    S.backups.slice(0, shown).forEach(function (b) {
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
      button(ops, '下载', 'btn-ghost', function () { downloadBackup(b); });
      var vbtn = button(ops, '校验', 'btn-ghost', function () { verify(b, tr, vbtn); });
      if (S.verify.supported === false) {
        vbtn.disabled = true;
        vbtn.title = '当前备份插件版本不支持校验，请升级插件';
      }
      button(ops, '恢复', 'btn-ghost', function () { openConfirm('restore', b); });
      button(ops, '删除', 'btn-ghost bak-danger', function () { openConfirm('delete', b); });
    });
    S.moreBtn = null;
    if (shown < S.backups.length) {
      var moreBar = add(S.listHost, el('div', 'bak-list-more'));
      add(moreBar, el('span', 'panel-meta', '已显示 ' + shown + ' / 共 ' + S.backups.length + ' 个'));
      var moreBtn = add(moreBar, el('button', 'btn', '加载更多（剩余 ' + (S.backups.length - shown) + ' 个）'));
      moreBtn.type = 'button';
      S.moreBtn = moreBtn;
      on(moreBtn, function () {
        S.listShown = shown + LIST_PAGE;
        paintList();
        if (S.moreBtn) S.moreBtn.focus();
      });
    }
  }
  function resultTitle(kind) {
    return { create: '创建结果', verify: '校验结果', restore: '恢复结果', delete: '删除结果', upload: '导入结果' }[kind] || '操作结果';
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
    } else if (r.kind === 'upload') {
      kv(dl, 'id', d.id); kv(dl, 'filename', d.filename); kv(dl, 'entries', d.entries);
      kv(dl, 'size_bytes', fmtSize(d.size_bytes)); kv(dl, 'sha256', d.sha256);
      kv(dl, 'compression', d.compression); kv(dl, 'managed', String(d.managed)); kv(dl, 'duration_ms', d.duration_ms);
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
  // 文件选择 + 确认复用 bak-confirm 面板：只引入一个 file 控件，不新造弹窗组件。
  function paintUploadConfirm(p, c) {
    var h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', '导入备份'));
    add(h, el('span', 'panel-meta', '二次确认 · 页面内'));
    add(p, el('p', 'bak-warn', '只导入本插件生成的 .tar / .tar.gz 备份包；导入不会自动恢复，需到列表点「恢复」并二次确认。单个文件不超过 512 MiB。'));
    var f = add(p, el('form', 'bak-confirm-form'));
    c.fileInput = el('input', 'field-input');
    c.fileInput.type = 'file'; c.fileInput.accept = '.tar,.tar.gz';
    c.fileInput.setAttribute('aria-label', '选择备份文件');
    field(f, '备份文件', c.fileInput, 'span2');
    c.fileMeta = add(f, el('p', 'bak-upload-meta muted span2', '尚未选择文件'));
    var ops = add(f, el('div', 'bak-confirm-ops span2'));
    button(ops, '取消', 'btn-ghost', closeConfirm);
    var ok = add(ops, el('button', 'btn btn-primary bak-upload-ok', '确认导入')); ok.type = 'submit';
    c.fileInput.addEventListener('change', function () {
      var file = c.fileInput.files && c.fileInput.files[0];
      if (c.fileMeta) c.fileMeta.textContent = file
        ? '已选择：' + file.name + '（' + fmtSize(file.size) + '）；导入前会校验类型与大小。'
        : '尚未选择文件';
    });
    f.addEventListener('submit', function (ev) { ev.preventDefault(); doUpload(c, ok); });
  }
  function paintConfirm() {
    if (!S.confirmHost) return;
    S.confirmHost.textContent = ''; S.confirmMsg = null;
    if (!S.confirm) return;
    var c = S.confirm, b = c.backup || {};
    var p = add(S.confirmHost, el('section', 'panel bak-confirm'));
    if (c.kind === 'upload') {
      paintUploadConfirm(p, c);
      S.confirmMsg = add(p, el('div', 'bak-confirm-msg'));
      return;
    }
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
  // FileReader 分块转 base64：4 MiB  slices，避免 btoa 一次性展开大字符串炸栈。
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '').split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('读取文件失败，请重新选择备份包')); };
      reader.readAsDataURL(blob);
    });
  }
  // sha256 是可选完整性声明：浏览器不支持 Web Crypto 时跳过，后端按未声明处理。
  function fileSHA256(file) {
    if (!window.crypto || !window.crypto.subtle || !file.arrayBuffer) return Promise.resolve('');
    return file.arrayBuffer().then(function (buf) { return window.crypto.subtle.digest('SHA-256', buf); })
      .then(function (digest) {
        return Array.prototype.map.call(new Uint8Array(digest), function (byte) {
          return ('0' + byte.toString(16)).slice(-2);
        }).join('');
      }).catch(function () { return ''; });
  }
  function doUpload(c, btn) {
    var file = c.fileInput && c.fileInput.files && c.fileInput.files[0];
    if (!file) { setNote(S.confirmMsg, '请先选择要导入的备份文件，再点「确认导入」。', 'fail', 'bak-confirm-msg'); return; }
    if (!/\.(tar|tar\.gz)$/i.test(file.name)) {
      setNote(S.confirmMsg, '只支持 .tar 或 .tar.gz 备份包；请重新选择文件。', 'fail', 'bak-confirm-msg'); return;
    }
    if (file.size <= 0 || file.size > 512 * 1024 * 1024) {
      setNote(S.confirmMsg, '文件不能为空且不能超过 512 MiB；请检查文件大小后重试。', 'fail', 'bak-confirm-msg'); return;
    }
    var uploadID = 'web-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
    var chunkBytes = 4 * 1024 * 1024;
    btn.disabled = true; setNote(S.confirmMsg, '', '', 'bak-confirm-msg');
    stopProgress(); ensureProgress();
    setProgress('busy', '正在准备导入「' + file.name + '」…', '共 ' + fmtSize(file.size) + '，将分块上传');
    setStatus('正在导入备份 ' + file.name + '…');
    fileSHA256(file).then(function (sha) {
      return invoke('backup.upload', {
        phase: 'begin', upload_id: uploadID, filename: file.name, size_bytes: file.size, sha256: sha
      }).then(function () {
        var offset = 0;
        function sendNext() {
          if (S.destroyed) return Promise.reject(new Error('页面已关闭，导入已终止'));
          if (offset >= file.size) return invoke('backup.upload', { phase: 'commit', upload_id: uploadID });
          var end = Math.min(offset + chunkBytes, file.size);
          var previous = offset;
          setProgress('busy', '正在导入「' + file.name + '」…', fmtSize(offset) + ' / ' + fmtSize(file.size));
          return blobToBase64(file.slice(offset, end)).then(function (data) {
            return invoke('backup.upload', {
              phase: 'chunk', upload_id: uploadID, offset: offset, data_base64: data
            });
          }).then(function (data) {
            offset = data.next_offset;
            if (!offset || offset <= previous) throw new Error('上传进度没有推进，请重试');
            return sendNext();
          });
        }
        return sendNext();
      });
    }).then(function (data) {
      S.result = { kind: 'upload', id: data.id, data: data };
      S.confirm = null; paintConfirm(); paintResult();
      setProgress('ok', '导入完成：' + data.id, '可到备份列表点「恢复」并二次确认');
      setStatus('已导入备份 ' + data.id + '（' + data.entries + ' 个条目）', 'ok');
      loadList(true); loadStats();
    }, function (err) {
      if (err && err.code === 'E_NOTFOUND') {
        S.upload.supported = false;
        if (S.uploadBtn) { S.uploadBtn.hidden = true; S.uploadBtn.title = '当前备份插件版本不支持上传，请升级插件'; }
      }
      setProgress('fail', '导入失败', String((err && err.message) || err) + '。怎么办：请确认文件是完整备份包、磁盘空间充足后重试。');
      setNote(S.confirmMsg, '导入失败：' + String((err && err.message) || err), 'fail', 'bak-confirm-msg');
      setStatus('导入失败：' + String((err && err.message) || err), 'fail');
      invoke('backup.upload', { phase: 'abort', upload_id: uploadID }).catch(function () { /* 尽力清理半包 */ });
      btn.disabled = false;
    });
  }
  function versionAtLeast(version, want) {
    var a = String(version || '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var b = String(want || '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return true;
  }
  // 探测已装 backup 版本：<0.4.2 没有 checks[]/ok 契约，按钮从一开始就禁用而不是点了才报错。
  function loadVerifySupport() {
    fetch('/api/v1/plugins', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (S.destroyed || !data) return;
        var found = null, list = data.plugins || [];
        list.forEach(function (p) { if (p && p.id === 'backup') found = p; });
        var supported = !!(found && versionAtLeast(found.version, '0.4.2'));
        S.verify.version = found ? String(found.version || '') : '';
        if (S.verify.supported !== supported) {
          S.verify.supported = supported;
          if (S.backups.length) paintList();
        }
        // 上传是 0.6.0 新增方法：旧插件没有该方法时隐藏按钮并给升级提示（不点才知道失败）。
        var canUpload = !!(found && versionAtLeast(found.version, '0.6.0'));
        S.upload.version = S.verify.version;
        S.upload.supported = canUpload;
        if (S.uploadBtn) {
          S.uploadBtn.hidden = !canUpload;
          S.uploadBtn.title = canUpload ? '导入本地 .tar / .tar.gz 备份包，不会自动恢复' : '当前备份插件版本不支持上传，请升级插件';
        }
      }, function () { /* 探测失败不阻断列表：verify 调用时仍按 404 降级 */ });
  }
  function firstFailedCheck(checks) {
    var list = checks || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].ok === false) return list[i];
    }
    return null;
  }
  function verifyRowHost(tr) {
    var next = tr.nextSibling;
    while (next && next.nodeType === 1 && !next.classList.contains('bak-verify-row')) next = next.nextSibling;
    if (next && next.classList.contains('bak-verify-row') && next.parentNode) next.parentNode.removeChild(next);
    var row = el('tr', 'bak-verify-row');
    var cell = el('td', 'bak-verify-cell'); cell.colSpan = 7;
    add(row, cell);
    if (tr.parentNode) tr.parentNode.insertBefore(row, tr.nextSibling);
    return cell;
  }
  function paintVerifyResult(tr, b, data) {
    var cell = verifyRowHost(tr);
    var box = add(cell, el('div', 'bak-verify-inline'));
    if (data.legacy) {
      add(box, chip('warn', '旧备份未记录 sha256，仅检查了可读性'));
    } else if (data.ok) {
      add(box, chip('ok', '校验通过'));
    } else {
      add(box, chip('fail', '校验失败'));
      var first = firstFailedCheck(data.checks);
      if (first) add(box, el('p', 'row-note-fail bak-verify-detail', first.detail));
    }
    var meta = [];
    if (data.sha256) meta.push('sha256 ' + String(data.sha256).slice(0, 12));
    if (typeof data.size_bytes === 'number') meta.push(fmtSize(data.size_bytes));
    if (data.created_at) meta.push(fmtTime(data.created_at));
    if (meta.length) add(box, el('p', 'bak-verify-meta muted', meta.join(' · ')));
  }
  function paintVerifyError(tr, err) {
    var cell = verifyRowHost(tr);
    var box = add(cell, el('div', 'bak-verify-inline'));
    add(box, chip('fail', '校验请求失败'));
    add(box, el('p', 'row-note-fail bak-verify-detail', err.message || String(err)));
  }
  function verify(b, tr, btn) {
    if (!b || !b.id || !btn || btn.disabled) return;
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = '校验中…';
    invoke('backup.verify', { id: b.id }).then(function (data) {
      btn.disabled = false; btn.textContent = label;
      paintVerifyResult(tr, b, data || {});
      setStatus('校验完成：' + b.id, data && data.ok ? 'ok' : 'fail');
    }, function (err) {
      btn.disabled = false; btn.textContent = label;
      if (err.code === 'E_NOTFOUND') {
        // 旧版插件没有 backup.verify：全局降级为禁用，并说明升级路径。
        S.verify.supported = false;
        paintList();
        setStatus('当前备份插件版本不支持校验，请升级插件', 'fail');
        return;
      }
      paintVerifyError(tr, err);
      setStatus('校验失败：' + err.message, 'fail');
    });
  }
  function loadList(quiet) {
    if (!quiet) setStatus('正在读取备份列表…');
    invoke('backup.list', {}).then(function (data) {
      if (S.destroyed) return;
      S.backups = data.backups || []; S.listShown = LIST_PAGE; paintList();
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
    var dims = collectDims(S.dims);
    if (!name) { setStatus('请填写备份名称', 'fail'); return; }
    if (!dims.length) { setStatus('请至少选择一个备份对象（站点目录 / MySQL 数据库）', 'fail'); return; }
    if (!paths.length && dims.indexOf('site') >= 0) { setStatus('选择了站点目录时请至少填写一个路径（每行一个）', 'fail'); return; }
    var params = { name: name, dimensions: dims, paths: paths, exclude: exclude, compression: S.compression.value };
    // 预设 id 随参数回传（后端 create 只补未填字段）；若用户把 db 预设的库维度改掉了，
    // 视为自定义兜底覆盖预设，不再传 preset，避免后端按预设强校验 db.database 而卡住。
    var chosen = findPreset(S.presetSelected), presetId = S.presetSelected;
    if (chosen && chosen.expanded && chosen.expanded.requires_database && dims.indexOf('db') < 0) presetId = '';
    if (presetId) params.preset = presetId;
    // db 维度（含 db 预设）：库名来自预设选择区旁的库名输入；连接信息由插件配置提供。
    if (dims.indexOf('db') >= 0) {
      var database = S.presetDb ? S.presetDb.value.trim() : '';
      if (!database) { setStatus('选择了数据库备份时请填写数据库名（在上方预设区旁的输入框）', 'fail'); return; }
      params.db = { database: database };
    }
    S.busy = true; S.submit.disabled = true;
    setStatus('正在打包 ' + name + '（' + dims.join(' + ') + '，' + S.compression.value + '）…');
    startProgress(name);
    invoke('backup.create', params)
      .then(function (data) {
        S.busy = false; S.submit.disabled = false; stopProgress();
        setProgress('ok', '备份完成 · ' + fmtSize(data.size_bytes) + ' · ' + data.entries + ' 条目', '校验值 ' + String(data.sha256 || '').slice(0, 12) + '');
        S.result = { kind: 'create', id: data.id, data: data }; paintResult();
        setStatus('备份已创建：' + data.id + ' · ' + fmtSize(data.size_bytes) + ' · ' + data.entries +
          ' 条目 · sha ' + String(data.sha256 || '').slice(0, 12) + ' · ' + data.duration_ms + 'ms', 'ok');
        // 创建成功后把备份源恢复到「已自动检测」的值，下一次备份不用重新填（原则②）。
        S.paths.value = ''; S.pathsTouched = false; S.presetPicked = false; applyDetected(false);
        loadList(true); loadStats(); loadJobs(true);
      }, function (err) {
        S.busy = false; S.submit.disabled = false; stopProgress();
        progressFail(err);
        setStatus('创建失败：' + err.message, 'fail');
        loadJobs(true);
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
      '.bak-upload-meta{margin:0;word-break:break-all;}',
      '.bak-upload-btn[hidden]{display:none;}',
      // 备份列表分批渲染的底部条（随视图注入，不进首屏 style.css）
      '.bak-list-more{display:flex;align-items:center;justify-content:center;gap:var(--kore-space-3);padding:var(--kore-space-3);flex-wrap:wrap;border-top:1px solid var(--kore-border-2);}',
      '.bak-list-more .panel-meta{color:var(--kore-text-2);font-size:var(--kore-font-12);}',
      '.bak-ret-ops{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);align-items:end;}',
      '.bak-ret-result{padding:0 var(--kore-space-4) var(--kore-space-3);font-size:var(--kore-font-12);}',
      '.bak-ret-head{margin:0 0 var(--kore-space-2);font-weight:600;color:var(--kore-text-1);}',
      '.bak-ret-head.ok{color:var(--kore-success);}',
      '.bak-ret-list{margin:0;padding-left:var(--kore-space-6);color:var(--kore-text-2);}',
      '.bak-ret-note{margin:var(--kore-space-2) 0 0;color:var(--kore-text-3);}',
      '.bak-dims{display:flex;flex-wrap:wrap;gap:var(--kore-space-3);padding:var(--kore-space-2) 0;}',
      '.bak-dim{display:inline-flex;align-items:center;gap:6px;min-height:44px;font-size:var(--kore-font-13);}',
      '.bak-preset-box{display:flex;flex-direction:column;gap:var(--kore-space-2);padding:var(--kore-space-3);background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-container);}',
      '.bak-preset-box .field-label{margin:0;font-weight:600;}',
      '.bak-preset-box .field-hint{margin:0;}',
      '.bak-presets{font-size:var(--kore-font-12);}',
      '.bak-presets.loading{padding:var(--kore-space-2) 0;}',
      '.bak-preset-row{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);}',
      '.bak-preset{min-height:44px;padding:8px 14px;touch-action:manipulation;}',
      '.bak-preset-active{background:var(--kore-info);color:var(--kore-bg-1);border-color:var(--kore-info);}',
      '.bak-preset-msg{min-height:18px;margin:0;font-size:var(--kore-font-12);word-break:break-word;}',
      '.bak-preset-box .bak-preset-msg[hidden],.bak-preset-box [hidden]{display:none;}',
      '.bak-progress{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-2) var(--kore-space-4);border-bottom:1px solid var(--kore-border-2);background:var(--kore-bg-1);font-size:var(--kore-font-12);}',
      '.bak-progress[hidden]{display:none;}',
      '.bak-progress-phase{font-weight:600;color:var(--kore-text-1);flex:1 1 220px;}',
      '.bak-progress-text{min-width:44px;text-align:center;padding:4px 8px;border-radius:4px;color:var(--kore-text-2);background:var(--kore-bg-2);}',
      '.bak-progress-busy .bak-progress-text{color:var(--kore-warning,#d29922);}',
      '.bak-progress-ok .bak-progress-text{color:var(--kore-success,#3fb950);}',
      '.bak-progress-fail .bak-progress-text{color:var(--kore-danger,#f85149);}',
      '.bak-progress-track{flex:1 1 100%;height:6px;background:var(--kore-bg-2);border-radius:3px;overflow:hidden;}',
      '.bak-progress-fill{display:block;height:100%;width:0;background:var(--kore-warning,#d29922);transition:width .3s;}',
      '.bak-progress-ok .bak-progress-fill{background:var(--kore-success,#3fb950);}',
      '.bak-progress-fail .bak-progress-fill{background:var(--kore-danger,#f85149);}',
      '.bak-progress-hint{flex:1 1 100%;color:var(--kore-text-3);word-break:break-word;}',
      '.bak-job-error{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--kore-text-3);}',
      '.bak-detect{display:flex;flex-direction:column;gap:var(--kore-space-2);margin-top:var(--kore-space-2);}',
      '.bak-detect-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);}',
      '.bak-detect-meta{flex:1 1 220px;min-height:18px;color:var(--kore-text-2);font-size:var(--kore-font-12);word-break:break-word;}',
      '.bak-detect-btn{min-height:32px;padding:0 10px;font-size:var(--kore-font-12);}',
      '.bak-detect-chips{display:flex;flex-wrap:wrap;gap:var(--kore-space-2);}',
      '.bak-detect-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:2px 4px 2px 10px;background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-radius:999px;font-size:var(--kore-font-12);}',
      '.bak-chip-kind{color:var(--kore-info);white-space:nowrap;}',
      '.bak-detect-config .bak-chip-kind{color:var(--kore-warning);}',
      '.bak-detect-app .bak-chip-kind{color:var(--kore-success);}',
      '.bak-detect-data .bak-chip-kind{color:var(--kore-text-3);}',
      '.bak-chip-path{overflow-wrap:anywhere;color:var(--kore-text-1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
      '.bak-chip-btn{min-height:32px;padding:0 10px;color:var(--kore-info);background:transparent;border:1px solid var(--kore-border-2);border-radius:999px;font-size:var(--kore-font-12);cursor:pointer;touch-action:manipulation;}',
      '.bak-chip-btn.is-on{color:var(--kore-bg-1);background:var(--kore-info);border-color:var(--kore-info);}',
      '.bak-chip-btn:disabled{color:var(--kore-text-3);cursor:not-allowed;}',
      '.bak-chip-note{color:var(--kore-text-3);white-space:nowrap;}',
      '.bak-detect-hint{margin:0;color:var(--kore-text-2);font-size:var(--kore-font-12);line-height:1.6;}',
      '@media (min-width:640px){.bak-sched-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);} .bak-sched-grid .span2{grid-column:1 / -1;}}',
      '@media (max-width:639px){.bak-task-table{min-width:640px;} .bak-detect-btn,.bak-chip-btn{min-height:44px;}}'
    ].join(''));
    style.id = 'kore-backup-sched-css'; document.head.appendChild(style);
  }
  function build(root) {
    S.root = root;
    var head = add(root, el('header', 'view-head view-head-split'));
    var headMain = add(head, el('div', 'view-head-main'));
    add(headMain, el('h2', 'view-title', '备份'));
    add(headMain, el('p', 'view-sub', '打包目录、定时执行、按份数保留与完整性校验；恢复与删除都需要页面内二次确认。'));
    var uploadBtn = add(head, el('button', 'btn btn-ghost bak-upload-btn', '上传备份'));
    uploadBtn.type = 'button'; uploadBtn.hidden = true; // 探测到 backup.upload（>=0.6.0）后才显示
    uploadBtn.setAttribute('aria-label', '上传备份');
    on(uploadBtn, function () { openConfirm('upload', null); });
    S.uploadBtn = uploadBtn;
    var gear = add(head, el('button', 'btn btn-ghost cfg-gear', '⚙ 设置'));
    gear.type = 'button';
    gear.setAttribute('aria-label', '备份设置');
    on(gear, openConfig);
    S.status = add(root, el('div', 'bak-status muted')); S.status.setAttribute('role', 'status');
    ensureProgress();
    S.confirmHost = add(root, el('div', 'bak-confirm-host'));
    var create = panel(root, '新建备份', '选预设一键填好，或手动填写'), form = add(create, el('form', 'bak-form'));
    // 预设选择区（预设优先）：列出 backup.presets；选中后自动填参数，下面字段仍可改（自定义兜底）。
    var presetBox = add(form, el('div', 'bak-preset-box span2'));
    add(presetBox, el('p', 'field-label', '从预设开始（可选）'));
    add(presetBox, el('p', 'field-hint', '选一个预设会自动填好下面的参数；想要别的范围，直接改就行。'));
    S.presetHost = add(presetBox, el('div', 'bak-presets loading muted', '正在读取备份预设…'));
    S.presetMsg = add(presetBox, el('p', 'bak-preset-msg muted'));
    S.presetDb = input('text', null, '例：wordpress');
    S.presetDbField = field(presetBox, '数据库名（数据库备份时必填）', S.presetDb);
    S.presetDbField.hidden = true;
    S.name = input('text', 'span2', 'site-20261122'); field(form, '名称', S.name, 'span2');
    // 备份源：标签带来源徽标，输入框下方是只读探测结果（可点选填入 / 加入允许根路径 / 重新检测）。
    var srcField = add(form, el('div', 'field span2'));
    var srcLabel = add(srcField, el('span', 'field-label', '备份源路径（每行一个）'));
    S.detBadge = add(srcLabel, el('span', 'auto-badge'));
    S.detBadge.hidden = true;
    S.paths = textarea(4, '点「重新检测」自动填入；也可以直接手填绝对路径，每行一个');
    srcField.appendChild(S.paths);
    S.detBox = add(srcField, el('div', 'bak-detect bak-detect-idle'));
    S.paths.addEventListener('input', function () { S.pathsTouched = true; syncPathsBadge(); });
    S.exclude = input('text', 'span2', '*.log, node_modules（可选，glob）'); field(form, '排除 glob（可选）', S.exclude, 'span2');
    S.dims = dimsBox(['site', 'db']);
    field(form, '备份对象', S.dims, 'span2');
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
    var schedPathField = add(sForm, el('div', 'field span2'));
    var schedPathLabel = add(schedPathField, el('span', 'field-label', '定时备份的路径（每行一个）'));
    S.schedDetBadge = add(schedPathLabel, el('span', 'auto-badge'));
    S.schedDetBadge.hidden = true;
    S.sched.paths = textarea(2, '与上面「新建备份」的备份源一致即可，自动检测会填好');
    schedPathField.appendChild(S.sched.paths);
    S.schedDetMeta = add(schedPathField, el('p', 'bak-sched-msg muted'));
    S.sched.paths.addEventListener('input', function () { S.schedPathsTouched = true; });
    S.sched.dims = dimsBox(['site', 'db']);
    field(sForm, '备份对象', S.sched.dims, 'span2');
    S.sched.db = input('text', null, '例：wordpress');
    S.sched.dbField = field(sForm, '数据库名（选 MySQL 数据库时必填）', S.sched.db, 'span2');
    function syncSchedDbField() {
      var checked = false;
      S.sched.dims.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
        if (cb.checked && cb.value === 'db') checked = true;
      });
      S.sched.dbField.hidden = !checked;
    }
    S.sched.syncDbField = syncSchedDbField;
    syncSchedDbField(); // 默认已勾选 db：首屏就必须显示库名输入，不能等着用户改勾选才出现
    S.sched.dims.addEventListener('change', syncSchedDbField);
    add(sForm, el('p', 'field-hint span2', '保存会创建两条任务：到点打包 + 1 分钟后按保留份数清理；重复保存会替换本页创建的任务。路径必须在「设置」的允许根路径之下。'));
    S.sched.save = add(sForm, el('button', 'btn btn-primary', '保存定时备份')); S.sched.save.type = 'submit';
    sForm.addEventListener('submit', saveSchedule);
    S.sched.preset.addEventListener('change', function () {
      S.sched.customField.hidden = S.sched.preset.value !== 'custom';
    });
    S.sched.msg = add(sched, el('p', 'bak-sched-msg muted'));
    S.sched.listHost = add(sched, el('div', 'bak-sched-list'));
    S.sched.count = sched.querySelector('.panel-head').appendChild(el('span', 'panel-meta', ''));

    S.sched.host = sched;
    var jobs = panel(root, '最近作业', '定时 / 手动备份的执行进度');
    S.jobsMsg = add(jobs, el('p', 'bak-sched-msg muted'));
    S.jobsHost = add(jobs, el('div', 'bak-jobs'));

    var ret = panel(root, '保留策略', '只删本插件创建、且不是最新一份的旧备份');
    add(ret, el('p', 'field-hint', '常用方案：点一下同时填好上面的定时频率与下面的保留份数。'));
    S.retPresetHost = add(ret, el('div', 'bak-ret-presets'));
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
    loadVerifySupport();
    // 预设读取与备份源探测都跑在首屏渲染之后（按需触发，不拖慢打开页面），
    // 探测等预设读完再发一次请求，避免两次全量调用打同一个插件 socket。
    S.presetTask = loadPresets();
    loadDetect(false);
    loadList(false); loadStats(); loadTasks(true); loadJobs(true);
    return { destroy: function () { S.destroyed = true; stopProgress(); } };
  }
  /* 验收钩子（同 files.js 的 __koreFilesList）：count() = 已渲染行数，total() = 后端返回总数。 */
  window.__koreBackupList = {
    count: function () {
      return S.listHost ? S.listHost.querySelectorAll('.bak-table tbody tr').length : 0;
    },
    total: function () { return S.backups.length; },
    page: LIST_PAGE
  };
  window.KoreBackup = { render: render };
})();
