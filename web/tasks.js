/* kore 主壳 · 计划任务（web/tasks.js）
   入口 window.KoreTasks.render(container)，零框架 / 零 CDN / 无外链。
   调 cron 插件：POST /api/v1/invoke/cron/cron.<action>，写请求带 X-Kore-CSRF。
   方法面（0.3.0 起；0.9.0 补 cron.runlog）：
     cron.list / cron.add / cron.replace / cron.remove —— 系统 crontab 增删改查；
     cron.logs —— 读系统 cron 启动日志（journalctl / cron.log / syslog）；
     cron.runlog —— 逐次执行记录（定时执行由包装命令写、立即执行由 cron.run 写）；
     cron.run  —— 同步执行**已注册任务**的命令（不接受任意命令）。
   内核定时任务的执行历史走 GET /api/v1/scheduler/tasks/{id}/runs（内核自己的调度记录），
   就地改计划走 PUT /api/v1/scheduler/tasks/{id}（插件与方法不可改，改了等于换任务）。
   任务类型：shell / http 落系统 crontab；plugin 类型按 ADR-0019 归内核 scheduler，
   前端拿到 cron.add 返回的 scheduler_task 建议后调 /api/v1/scheduler/tasks 创建，
   cron 插件不写 crontab、不执行 plugin 任务。
   编辑只替换 schedule+command（cron.replace 不接收 comment，原备注由插件保留），
   http 任务要改参数请删除后重建；所有写操作展示插件返回的 backup_path。

   易用性（USABILITY 原则 4 / G-33 A5）：
     · 空状态给「下一步」按钮（用预设建第一条 / 手动填写 / 重试读取 / 去商店），不留空白页；
     · 失败可见：任务行显著标红并给「重试 / 查看日志 / 编辑」入口——crontab 任务用插件
       binary_status（stale / missing）预判「到点会失败」并给一键修复路径；
       本页「立即执行」的退出码按任务留痕；内核定时任务用后端 last_result 判最近执行失败；
     · 执行结果可读：成功 / 失败 / 超时 / 跳过给明确文案与颜色，时间一律人话，
       日志只展示关键行（错误行 + 首尾），全量输出折叠，不整屏倾倒。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/cron/';
  var SCHEDULER_API = '/api/v1/scheduler/tasks';
  var PRESETS = [
    ['每分钟', '* * * * *'], ['每小时', '0 * * * *'],
    ['每天 3 点', '0 3 * * *'], ['每周一 3 点', '0 3 * * 1']
  ];
  // 常用任务预设：一次点击填好类型 / 频率 / 命令或地址 / 备注，再点保存即完成（2 步）。
  var QUICK_PRESETS = [
    { id: 'backup', name: '每天备份站点', type: 'shell', schedule: '0 3 * * *',
      command: 'tar czf /var/backups/site-$(date +%F).tar.gz /var/www', comment: '每日备份站点',
      why: '每天 03:00 打包 /var/www 到 /var/backups' },
    { id: 'cleanup', name: '每周清理日志', type: 'shell', schedule: '0 4 * * 0',
      command: "find /var/log -name '*.log' -mtime +14 -delete", comment: '每周清理日志',
      why: '每周日 04:00 删除 14 天前的 .log' },
    { id: 'health', name: '每小时健康检查', type: 'http', schedule: '0 * * * *',
      url: 'https://example.com/health', method: 'GET', comment: '每小时健康检查',
      why: '每小时访问一次健康检查地址' },
    { id: 'cert', name: '每月检查证书到期', type: 'http', schedule: '0 6 1 * *',
      url: 'https://example.com', method: 'GET', comment: '每月检查证书到期',
      why: '每月 1 日 06:00 检查 HTTPS 端点' }
  ];
  var TYPES = [['shell', 'Shell 命令'], ['http', 'HTTP 请求'], ['plugin', '插件任务']];
  var HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
  // warning = 环境受限原因（供列表空态与只读判定），warnText = 灰底提示条的当前文案；两者不互相覆盖。
  var S = {
    entries: [], editIndex: null, warning: '', warnText: '', locked: false, lockReason: '',
    type: 'shell',
    selected: {}, quickGrid: null, quickMeta: null, quickFirst: null, quickPresets: [],
    logs: { available: null, source: '', entries: [], note: '', loading: false, error: '' },
    // runlog：crontab 任务的逐次执行记录（cron.runlog）。与上面「系统 cron 日志」不同——
    // 那份是 cron 守护进程的启动行，这份是**每次执行的退出码与输出摘要**，刷新不丢。
    runlog: { available: null, entries: [], note: '', loading: false, error: '', failuresOnly: false },
    // schedRuns：内核任务的执行历史（GET /scheduler/tasks/{id}/runs），按任务 id 缓存。
    schedRuns: {},
    // runs：本页「立即执行」的结果按任务下标留在内存（刷新即清空，不落盘）；
    // filter：列表过滤（all / abnormal）；loadError：读取失败的原因（用于空态给下一步）。
    runs: {}, filter: 'all', loadError: '', filterBtn: null,
    // result：执行结果与日志面板（kind = cron / sched）。
    result: { visible: false, kind: '', index: null, id: '', title: '', record: null, error: '' },
    // sched：内核定时任务（ADR-0019）——plugin 型任务建在这里，必须在本页可见可重试。
    sched: { host: null, meta: null, loading: false, loaded: false, error: '', tasks: [] }
  };

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
  function readResponse(res) {
    return res.text().then(function (raw) {
      var data = {};
      if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
      if (!res.ok) {
        var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        err.code = data.code || '';
        throw err;
      }
      return data;
    });
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(API + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(readResponse);
  }
  // plugin 类型任务：cron.add 只生成建议，真正创建走内核 scheduler（ADR-0019）。
  function createSchedulerTask(task) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(SCHEDULER_API, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(task)
    }).then(readResponse);
  }
  function setStatus(text, tone) {
    if (!S.status) return;
    S.status.textContent = text;
    S.status.className = 'task-status ' + (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  // 管理员权限提示：优先用共享组件（P0-2），组件缺失或原因为空时回退到不含内部实现词的人话。
  function rootHint(reason, options) {
    if (!reason) return null;
    var ui = window.KoreUI;
    if (!ui || typeof ui.rootErrorHint !== 'function') return null;
    try { return ui.rootErrorHint(reason, options || {}); } catch (e) { return null; }
  }
  function appendRootHint(host, reason, options, fallbackText) {
    var hint = rootHint(reason, options);
    if (hint) { host.appendChild(hint); return; }
    var note = document.createElement('p');
    note.className = 'row-note';
    note.textContent = fallbackText ||
      '这项操作需要系统管理员权限：请让管理员为 Kore 服务授权后重试（部署手册有具体步骤）。';
    host.appendChild(note);
  }

  function showBackup(path) {
    if (!S.backup) return;
    S.backup.textContent = path ? '已备份：' + path : '';
    S.backup.hidden = !path;
  }
  function confirmBox(text, onOk) {
    var mask = el('div', 'kore-modal');
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
    var box = add(mask, el('div', 'kore-modal-box'));
    add(box, el('div', 'kore-modal-title', '确认操作'));
    add(box, el('p', 'kore-modal-text', text));
    var msg = add(box, el('div', 'kore-modal-msg'));
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary', '确认')); ok.type = 'button';
    function close() {
      document.removeEventListener('keydown', esc);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }
    function esc(ev) { if (ev.key === 'Escape') close(); }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', esc);
    ok.addEventListener('click', function () { ok.disabled = true; onOk(close, msg, ok); });
    document.body.appendChild(mask);
  }

  // 权限类失败识别：E_UNAUTHORIZED / E_NEED_ROOT / crontab 报权限错误都算，"填完才报错"必须前置。
  function permissionProblem(text) {
    var msg = String(text || '');
    if (!msg) return '';
    if (/E_UNAUTHORIZED|E_NEED_ROOT|E_PERM|权限|permission|not permitted|must be root|需要 root/i.test(msg)) return msg;
    return '';
  }

  // 只读锁定：禁用表单、类型选择与执行按钮，页面顶部给黄底说明 + 提权说明链接。
  function setLocked(reason) {
    S.locked = !!reason;
    S.lockReason = reason || '';
    if (S.form) {
      var nodes = [S.form.schedule, S.form.command, S.form.url, S.form.httpMethod,
        S.form.headers, S.form.body, S.form.plugin, S.form.pluginMethod, S.form.params,
        S.form.comment, S.form.typeSelect, S.form.submit, S.form.cancel];
      nodes.forEach(function (n) { if (n) n.disabled = S.locked; });
      S.form.cancel.hidden = S.locked && S.editIndex === null;
      S.form.hint.textContent = S.locked
        ? '当前没有系统管理员权限：表单与立即执行已禁用，仅保留只读展示。'
        : hintForType(S.type, S.editIndex);
    }
    if (S.presets) S.presets.forEach(function (b) { b.disabled = S.locked; });
    paintPerm();
    paintList();
  }

  function paintPerm() {
    if (!S.permHost) return;
    S.permHost.textContent = '';
    S.permHost.hidden = !S.locked;
    if (!S.locked) return;
    var box = add(S.permHost, el('div', 'task-perm-warn'));
    box.setAttribute('role', 'status');
    appendRootHint(box, S.lockReason,
      { retry: load, command: 'sudo systemctl restart kore' },
      '当前没有读取系统计划任务的权限：请让管理员为 Kore 服务授权后重试（部署手册有具体步骤）。');
  }

  function hintForType(type, editIndex) {
    if (editIndex !== null) return '修改这条任务的时间与内容，原备注保留。';
    if (type === 'http') return '按你设定的时间自动访问这个地址；访问失败会记为执行失败。';
    if (type === 'plugin') return '按你设定的时间调用已安装插件里的动作。';
    return '按你设定的时间自动执行这条命令。';
  }

  // applyQuickPreset：点一次卡片 = 填好全部字段（第 1 步），用户确认后点保存（第 2 步）。
  function applyQuickPreset(preset) {
    if (S.locked || !S.form) return;
    S.editIndex = null;
    S.form.comment.readOnly = false;
    setType(preset.type);
    S.form.schedule.value = preset.schedule;
    S.form.comment.value = preset.comment || '';
    if (preset.type === 'http') {
      S.form.url.value = preset.url || '';
      if (S.form.httpMethod) S.form.httpMethod.value = preset.method || 'GET';
    } else {
      S.form.command.value = preset.command || '';
    }
    S.form.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    S.form.submit.focus();
    setStatus('已填入「' + preset.name + '」：' + preset.why + '。检查后点「新增任务」即可（共 2 步）', 'ok');
  }

  // 预设卡优先来自后端 cron.templates；后端不可用（插件未装/版本旧）保持内置 4 张，不白屏。
  function presetFromTemplate(t) {
    return { id: t.id, name: t.name, why: t.description || '', type: t.type,
      schedule: t.schedule, command: t.command, url: t.url, method: t.method, comment: t.comment };
  }
  function paintQuickPresets(list, source) {
    if (!S.quickGrid) return;
    S.quickGrid.textContent = '';
    S.quickFirst = null;
    S.quickPresets = list;
    list.forEach(function (preset) {
      var card = add(S.quickGrid, el('button', 'btn task-quick-card'));
      card.type = 'button';
      card.setAttribute('aria-label', '使用预设：' + preset.name);
      card.style.cssText = 'display:block;text-align:left;min-height:88px;padding:12px 14px;line-height:1.45;';
      add(card, el('strong', null, preset.name));
      var meta = add(card, el('span', 'task-quick-meta', preset.why || ''));
      meta.style.cssText = 'display:block;margin-top:6px;font-size:12px;color:var(--kore-text-3);';
      var use = add(card, el('span', 'task-quick-use', '使用 →'));
      use.style.cssText = 'display:block;margin-top:6px;font-size:12px;color:var(--kore-info);';
      on(card, function () { applyQuickPreset(preset); });
      if (!S.quickFirst) S.quickFirst = card;
    });
    if (S.quickMeta) S.quickMeta.textContent = source + ' · ' + list.length + ' 个';
  }
  function loadQuickTemplates() {
    invoke('cron.templates', {}).then(function (data) {
      var list = (data.templates || []).map(presetFromTemplate).filter(function (t) {
        return t.id && t.name && t.type && t.schedule;
      });
      if (!list.length) throw new Error('empty');
      paintQuickPresets(list, '来自插件模板');
    }, function () {
      if (S.quickMeta) S.quickMeta.textContent = '内置预设（插件模板不可用） · ' + QUICK_PRESETS.length + ' 个';
    });
  }

  function cancelEdit() {
    S.editIndex = null;
    if (!S.form) return;
    S.form.schedule.value = '';
    S.form.command.value = '';
    S.form.url.value = '';
    S.form.headers.value = '';
    S.form.body.value = '';
    S.form.plugin.value = '';
    S.form.pluginMethod.value = '';
    S.form.params.value = '';
    S.form.comment.value = '';
    S.form.comment.readOnly = false;
    S.form.submit.textContent = '新增任务';
    S.form.cancel.hidden = true;
    setType('shell');
  }

  function beginEdit(entry) {
    if (entry.type && entry.type !== 'shell') return;
    S.editIndex = entry.index;
    setType('shell');
    S.form.schedule.value = entry.schedule;
    S.form.command.value = entry.command;
    S.form.comment.value = entry.comment || '';
    S.form.comment.readOnly = true;
    S.form.submit.textContent = '保存修改（第 ' + entry.index + ' 条）';
    S.form.cancel.hidden = false;
    S.form.hint.textContent = hintForType('shell', entry.index);
    S.form.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    S.form.schedule.focus();
  }

  // setType 切换三组字段的可见性；编辑态只允许 shell（cron.replace 只收 schedule+command）。
  function setType(type) {
    if (S.editIndex !== null && type !== 'shell') type = 'shell';
    S.type = type;
    if (!S.form) return;
    [['shell', S.form.typeShell], ['http', S.form.typeHTTP], ['plugin', S.form.typePlugin]].forEach(function (pair) {
      if (pair[1]) pair[1].hidden = pair[0] !== type;
    });
    if (S.form.typeSelect) S.form.typeSelect.value = type;
    if (S.form.cancel.hidden !== (S.editIndex === null)) S.form.cancel.hidden = S.editIndex === null;
    S.form.hint.textContent = hintForType(type, S.editIndex);
    S.form.submit.textContent = S.editIndex === null ? '新增任务' : ('保存修改（第 ' + S.editIndex + ' 条）');
  }

  // parseHeaders 把「每行 Key: Value」解析为对象；格式错误返回 {error}。
  function parseHeaders(text) {
    var headers = {};
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var idx = line.indexOf(':');
      if (idx <= 0) return { error: '第 ' + (i + 1) + ' 行请求头格式应为「名称: 值」' };
      var name = line.slice(0, idx).trim();
      var value = line.slice(idx + 1).trim();
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return { error: '第 ' + (i + 1) + ' 行请求头名称非法：' + name };
      headers[name] = value;
    }
    return { headers: headers };
  }

  function buildPayload(schedule, comment) {
    var payload = { type: S.type, schedule: schedule, comment: comment };
    if (S.type === 'shell') {
      payload.command = S.form.command.value.trim();
      if (!payload.command) return { error: '命令不能为空', focus: S.form.command };
      return { payload: payload };
    }
    if (S.type === 'http') {
      payload.url = S.form.url.value.trim();
      if (!/^https?:\/\/[^\s]+$/i.test(payload.url)) {
        return { error: 'URL 必须以 http:// 或 https:// 开头且不含空白', focus: S.form.url };
      }
      payload.method = S.form.httpMethod.value;
      var parsed = parseHeaders(S.form.headers.value);
      if (parsed.error) return { error: parsed.error, focus: S.form.headers };
      payload.headers = parsed.headers;
      payload.body = S.form.body.value;
      return { payload: payload };
    }
    payload.plugin = S.form.plugin.value.trim();
    payload.method = S.form.pluginMethod.value.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(payload.plugin)) {
      return { error: '插件 id 须为小写字母开头的字母/数字/连字符', focus: S.form.plugin };
    }
    if (!/^[a-z][A-Za-z0-9_-]*(\.[a-z][A-Za-z0-9_-]*)*$/.test(payload.method)) {
      return { error: '插件方法须为点分方法名（如 echo.ping）', focus: S.form.pluginMethod };
    }
    var raw = S.form.params.value.trim();
    var params = {};
    if (raw) {
      try { params = JSON.parse(raw); } catch (e) { return { error: '参数必须是合法 JSON 对象', focus: S.form.params }; }
      if (!params || typeof params !== 'object' || params instanceof Array) {
        return { error: '参数必须是 JSON 对象', focus: S.form.params };
      }
    }
    payload.params = params;
    return { payload: payload };
  }

  function submitForm(ev) {
    ev.preventDefault();
    if (S.locked) {
      setStatus('当前为只读：需要系统管理员权限才能写入系统计划任务', 'fail');
      return;
    }
    var schedule = S.form.schedule.value.trim();
    if (schedule.split(/\s+/).length !== 5) {
      setStatus('时间表达式必须恰为 5 段', 'fail');
      S.form.schedule.focus();
      return;
    }
    var comment = S.form.comment.value.trim();
    var built = buildPayload(schedule, comment);
    if (built.error) { setStatus(built.error, 'fail'); if (built.focus) built.focus.focus(); return; }
    if (S.editIndex !== null) {
      confirmBox('确认用新的表达式与命令替换第 ' + S.editIndex + ' 条任务？原备注会保留。', function (close, msg, ok) {
        invoke('cron.replace', { index: S.editIndex, schedule: schedule, command: built.payload.command }).then(function (data) {
          close();
          showBackup(data.backup_path);
          setStatus('已替换第 ' + S.editIndex + ' 条任务', 'ok');
          cancelEdit();
          load();
        }, function (err) { ok.disabled = false; msg.textContent = err.message; });
      });
      return;
    }
    S.form.submit.disabled = true;
    invoke('cron.add', built.payload).then(function (data) {
      S.form.submit.disabled = false;
      if (S.type === 'plugin') {
        var task = data.scheduler_task;
        if (!task) throw new Error('插件未返回 scheduler_task 建议');
        return createSchedulerTask(task).then(function (created) {
          showBackup('');
          resetForm();
          // load() 会先写"正在读取/已刷新"，创建成功的文案必须在它完成后落定。
          return load().then(function () {
            setStatus('已创建内核定时任务「' + (task.name || task.method) + '」' +
              (created && created.id ? '（' + created.id + '）' : '') + '；cron 插件未写入 crontab', 'ok');
          });
        });
      }
      showBackup(data.backup_path);
      setStatus('已新增' + (S.type === 'http' ? ' HTTP ' : '') + '任务：' + schedule + ' ' + built.payload.command, 'ok');
      resetForm();
      load();
    }).catch(function (err) {
      S.form.submit.disabled = false;
      setStatus('新增失败：' + err.message, 'fail');
    });
  }

  function resetForm() {
    S.form.schedule.value = ''; S.form.command.value = '';
    S.form.url.value = ''; S.form.headers.value = ''; S.form.body.value = '';
    S.form.plugin.value = ''; S.form.pluginMethod.value = ''; S.form.params.value = '';
    S.form.comment.value = '';
  }

  function removeTask(entry) {
    confirmBox('确认删除第 ' + entry.index + ' 条任务（' + entry.schedule + ' ' + entry.command + '）？', function (close, msg, ok) {
      invoke('cron.remove', { index: entry.index }).then(function (data) {
        close();
        showBackup(data.backup_path);
        setStatus('已删除第 ' + entry.index + ' 条任务', 'ok');
        if (S.editIndex === entry.index) cancelEdit();
        load();
      }, function (err) { ok.disabled = false; msg.textContent = err.message; });
    });
  }

  function findEntry(index) {
    var found = null;
    S.entries.forEach(function (e) { if (e.index === index) found = e; });
    return found;
  }

  // runTask 立即执行：确认 → 同步调用 cron.run（最长 60s）→ 结果面板 + 行内状态。
  function runTask(entry) {
    if (S.locked) return;
    // 停用任务后端会拒绝（E_CONFLICT）：这里先给人话指引，不把裸错误甩给用户。
    if (entry.enabled === false) {
      setStatus('该任务已停用，先点「启用」再执行', 'fail');
      return;
    }
    var again = !!runRecord(entry.index);
    confirmBox((again ? '将再执行一次' : '将立即执行') + '第 ' + entry.index + ' 条任务（同步，最长 60 秒）：' + entry.command,
      function (close, msg, ok) {
        ok.textContent = '执行中…';
        invoke('cron.run', { index: entry.index }).then(function (data) {
          close();
          var record = recordRun(entry.index, data);
          var verdict = runVerdict(record);
          S.result = {
            visible: true, kind: 'cron', index: entry.index, id: '',
            title: '第 ' + entry.index + ' 条任务' + (entry.comment ? '「' + entry.comment + '」' : ''),
            record: record, error: ''
          };
          paintResult();
          paintList();
          setStatus('第 ' + entry.index + ' 条任务' + verdict.text + '，耗时 ' + humanDuration(record.durationMs),
            verdict.tone === 'ok' ? 'ok' : 'fail');
          scrollToResult();
        }, function (err) {
          close();
          var record = recordRunError(entry.index, err.message);
          S.result = {
            visible: true, kind: 'cron', index: entry.index, id: '',
            title: '第 ' + entry.index + ' 条任务' + (entry.comment ? '「' + entry.comment + '」' : ''),
            record: record, error: ''
          };
          paintResult();
          paintList();
          setStatus('立即执行失败：' + err.message, 'fail');
          scrollToResult();
        });
      });
  }

  function scrollToResult() {
    if (S.runPanel) S.runPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // showRunLog 打开某条 crontab 任务最近一次执行的结果与关键日志：
  // 优先本页刚跑的，其次插件持久化的定时执行记录（刷新后依然能看）。
  function showRunLog(index) {
    var entry = findEntry(index);
    var latest = entry ? latestRun(entry) : null;
    if (!latest) {
      setStatus('这条任务还没有执行记录：等到点执行，或点「立即执行」先跑一次，之后这里就能看到时间、退出码与关键输出', 'fail');
      return;
    }
    S.result = {
      visible: true, kind: 'cron', index: index, id: '',
      title: '第 ' + index + ' 条任务' + (entry && entry.comment ? '「' + entry.comment + '」' : '') +
        (latest.scheduled ? ' · 定时执行' : ''),
      record: latest.record, error: ''
    };
    paintResult();
    scrollToResult();
  }

  // paintResult 把一次执行渲染成「结论 + 关键行 + 折叠的全量输出」：
  // 结论给成功 / 失败（退出码）/ 超时 / 跳过与颜色，日志只给关键行，全量输出收进折叠区。
  function paintResult() {
    if (!S.runHost) return;
    S.runHost.textContent = '';
    if (S.runPanel) S.runPanel.hidden = !S.result.visible;
    if (!S.result.visible) return;
    if (S.result.kind === 'schedruns') { paintSchedRuns(); return; }
    var record = S.result.record || {};
    var verdict, sourceText = '', metaBits = [];
    if (record.runnerError) {
      verdict = { tone: 'fail', text: '没能执行：' + record.runnerError };
    } else if (S.result.kind === 'sched') {
      var state = SCHED_STATUS[record.status] || { text: record.status || '未知', tone: 'warn' };
      verdict = { tone: state.tone, text: '执行' + state.text };
      sourceText = record.error || '';
      metaBits.push('耗时 ' + humanDuration(record.durationMs));
    } else {
      verdict = runVerdict(record);
      sourceText = record.output || '';
      metaBits.push(record.exitCode === null || record.exitCode === undefined ? '没有退出码' : '退出码 ' + record.exitCode);
      metaBits.push('耗时 ' + humanDuration(record.durationMs));
      if (record.outputBytes) metaBits.push('输出共 ' + record.outputBytes + ' 字节');
      metaBits.push(record.scheduled ? '定时执行' : '立即执行');
    }
    var toneColor = verdict.tone === 'ok' ? 'var(--kore-success)'
      : verdict.tone === 'warn' ? 'var(--kore-warning)' : 'var(--kore-danger)';
    var head = add(S.runHost, el('div', 'task-result-head'));
    var node = add(head, el('p', 'task-result-verdict', verdict.text));
    node.style.cssText = 'margin:0 0 4px;font-size:15px;font-weight:600;color:' + toneColor + ';';
    if (S.result.title) {
      var which = add(head, el('p', 'muted', S.result.title));
      which.style.cssText = 'margin:0 0 4px;font-size:12px;';
    }
    var meta = add(head, el('div', 'task-run-meta'));
    add(meta, el('span', null, humanTime(record.at)));
    metaBits.forEach(function (bit) { add(meta, el('span', null, bit)); });
    var cmd = S.result.kind === 'cron' ? (record.command || '') : '';
    if (cmd) add(meta, el('span', 'mono', cmd));
    var hint = add(S.runHost, el('p', 'task-note'));
    if (verdict.tone === 'ok') {
      hint.textContent = '这次执行成功，没有需要处理的错误。';
    } else if (verdict.tone === 'warn') {
      hint.textContent = '这次被跳过或错过，不是命令本身出错；下次到点会正常执行。';
    } else if (record.runnerError) {
      hint.textContent = '下一步：先点「重试」；一直失败就确认计划任务插件已启动，或按上方提示让管理员授权后再试。';
    } else if (S.result.kind === 'sched' && !record.error) {
      hint.textContent = '内核只保留最近一次执行的状态；点「重试」立即跑一次就能看到本次的错误信息。';
    } else if (record.scheduled) {
      hint.textContent = '这条是定时执行留下的真实记录。下一步：点「重试」手动再跑一次对照；' +
        '重复失败就把命令复制到「终端」里执行，能看到完整报错。';
    } else {
      hint.textContent = '下一步：点「重试」再跑一次；若重复失败，把命令复制到「终端」手动执行，就能看到完整报错。';
    }
    var picked = keyLines(sourceText);
    var pre = add(S.runHost, el('pre', 'task-output',
      picked.lines.length ? picked.lines.join('\n') : '（这次执行没有输出）'));
    pre.setAttribute('aria-label', '执行输出关键行');
    if (picked.hidden > 0) {
      add(S.runHost, el('p', 'task-note',
        '共 ' + picked.total + ' 行输出，上面只显示关键行（报错行 + 首尾），另有 ' + picked.hidden + ' 行已折叠。'));
      var details = add(S.runHost, el('details', 'task-raw'));
      add(details, el('summary', null, '查看完整输出'));
      var full = add(details, el('pre', 'task-output', String(sourceText || '')));
      full.style.maxHeight = '320px';
      full.setAttribute('aria-label', '完整执行输出');
    }
    var ops = add(S.runHost, el('div', 'task-result-ops'));
    ops.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;';
    if (S.result.kind === 'sched') {
      var task = null;
      (S.sched.tasks || []).forEach(function (t) { if (t.id === S.result.id) task = t; });
      if (task) {
        var schedRetry = add(ops, el('button', 'btn btn-primary', '重试'));
        schedRetry.type = 'button'; schedRetry.style.minHeight = '44px';
        on(schedRetry, function () { runSchedTask(task); });
      }
    }
    if (S.result.kind === 'cron') {
      var entry = findEntry(S.result.index);
      if (entry) {
        var retry = add(ops, el('button', 'btn' + (verdict.tone === 'ok' ? '' : ' btn-primary'), '重试'));
        retry.type = 'button'; retry.style.minHeight = '44px';
        retry.disabled = S.locked;
        on(retry, function () { runTask(entry); });
        if (!entry.type || entry.type === 'shell') {
          var editBtn = add(ops, el('button', 'btn btn-ghost', '编辑这条任务'));
          editBtn.type = 'button'; editBtn.style.minHeight = '44px';
          editBtn.disabled = S.locked;
          on(editBtn, function () { beginEdit(entry); });
        }
      }
    }
  }

  // showWarning 用灰底提示条表达"环境限制"，与红色错误态严格区分。
  function showWarning(text) {
    S.warnText = text || '';
    if (!S.warn) return;
    S.warn.textContent = S.warnText;
    S.warn.hidden = !S.warnText;
  }

  // cron 表达式翻成人话：常见预设直出，看不懂就原样显示（不猜）。
  function humanCron(expr) {
    var text = String(expr || '').trim();
    var known = {
      '* * * * *': '每分钟', '0 * * * *': '每小时整点', '0 */6 * * *': '每 6 小时',
      '0 3 * * *': '每天 03:00', '0 4 * * *': '每天 04:00',
      '0 2 * * *': '每天 02:00', '0 0 * * *': '每天 00:00',
      '0 3 * * 1': '每周一 03:00', '0 3 * * 0': '每周日 03:00', '0 2 * * 0': '每周日 02:00'
    };
    if (known[text]) return known[text];
    var m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(text);
    if (m) return '每天 ' + (m[2].length < 2 ? '0' + m[2] : m[2]) + ':' + (m[1].length < 2 ? '0' + m[1] : m[1]);
    return '';
  }

  /* ---------- 人话时间 / 关键行 / 执行状态（可读性骨架） ---------- */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  // humanTime 把 ISO 时间 / 毫秒时间戳翻成「刚刚 / 5 分钟前 / 今天 14:03 / 昨天 09:20 / 11-20 09:20」。
  // 时间一律本地时区展示；解析不了就原样显示（不猜、不编造）。
  function humanTime(value) {
    if (value === undefined || value === null || value === '') return '';
    var d = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
    if (isNaN(d.getTime())) return String(value);
    var now = new Date();
    var diff = now.getTime() - d.getTime();
    if (diff >= 0 && diff < 60 * 1000) return '刚刚';
    if (diff >= 0 && diff < 3600 * 1000) return Math.max(1, Math.floor(diff / 60000)) + ' 分钟前';
    if (sameDay(d, now)) return '今天 ' + hhmm(d);
    if (sameDay(d, new Date(now.getTime() - 86400000))) return '昨天 ' + hhmm(d);
    if (diff > 0 && diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前 ' + hhmm(d);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hhmm(d);
  }
  // humanDuration 把毫秒翻成「820 毫秒 / 1.4 秒 / 2 分 05 秒」。
  function humanDuration(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1000) return Math.round(n) + ' 毫秒';
    if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + ' 秒';
    var total = Math.round(n / 1000);
    return Math.floor(total / 60) + ' 分 ' + pad2(total % 60) + ' 秒';
  }

  // KEY_LINE_RE 是「关键行」判据：报错 / 权限 / 超时类行优先展示，其余折叠。
  var KEY_LINE_RE = /(error|errno|fail|denied|refused?|not found|no such|cannot|can't|unable|permission|timed?\s?out|panic|fatal|traceback|exception|exit code|错误|失败|拒绝|权限|不存在|未找到|超时)/i;
  var MAX_KEY_LINES = 12;

  // keyLines 从执行输出里挑关键行：命中关键词的行（最多 6 条）+ 首 2 行 + 尾 3 行，
  // 其余折叠。返回 { lines, hidden, total }——hidden 是"被折叠的行数"，如实告诉用户。
  function keyLines(raw) {
    var text = String(raw === undefined || raw === null ? '' : raw).replace(/\r\n/g, '\n');
    var all = text.split('\n');
    var nonEmpty = 0, i;
    for (i = 0; i < all.length; i++) if (all[i].trim()) nonEmpty++;
    if (!nonEmpty) return { lines: [], hidden: 0, total: 0 };
    var picked = [], seen = {};
    function take(idx) {
      if (idx < 0 || idx >= all.length || seen[idx]) return;
      var line = all[idx].replace(/\s+$/, '');
      if (!line.trim()) return;
      seen[idx] = true;
      picked.push({ i: idx, text: line.length > 240 ? line.slice(0, 240) + '…（该行过长已截断）' : line });
    }
    if (nonEmpty <= MAX_KEY_LINES) {
      for (i = 0; i < all.length; i++) take(i);
    } else {
      var hits = 0;
      for (i = 0; i < all.length && hits < 6; i++) {
        if (KEY_LINE_RE.test(all[i]) && all[i].trim()) { take(i); hits++; }
      }
      take(0); take(1);
      take(all.length - 3); take(all.length - 2); take(all.length - 1);
    }
    picked.sort(function (a, b) { return a.i - b.i; });
    return {
      lines: picked.map(function (p) { return p.text; }),
      hidden: Math.max(0, nonEmpty - picked.length),
      total: nonEmpty
    };
  }

  var SCHED_STATUS = {
    ok: { text: '成功', tone: 'ok' },
    failed: { text: '失败', tone: 'fail' },
    timeout: { text: '超时', tone: 'fail' },
    skipped: { text: '跳过（上次还没跑完）', tone: 'warn' },
    missed: { text: '错过（停机未补跑）', tone: 'warn' }
  };

  // recordRun 把一次 cron.run 的结果按任务下标留在内存：行内状态、重试、查看日志都靠它。
  // 只存本页发起的执行（刷新即清空）；定时执行的持久历史在 S.runlog（cron.runlog）。
  function recordRun(index, data) {
    S.runs[index] = {
      at: Date.now(),
      runnerError: '',
      exitCode: typeof data.exit_code === 'number' ? data.exit_code : null,
      timedOut: !!data.timed_out,
      durationMs: data.duration_ms,
      command: data.command || '',
      output: data.output || '',
      outputBytes: data.output_bytes || 0
    };
    return S.runs[index];
  }
  function recordRunError(index, message) {
    S.runs[index] = { at: Date.now(), runnerError: message || '执行请求失败', exitCode: null,
      timedOut: false, durationMs: 0, command: '', output: '', outputBytes: 0 };
    return S.runs[index];
  }
  function runRecord(index) { return S.runs[index] || null; }

  // runVerdict 统一判定一次执行：成功 / 失败（退出码）/ 超时 / 没能执行。
  function runVerdict(record) {
    if (!record) return { tone: 'na', short: '未执行', text: '这条任务在本页还没有执行记录' };
    if (record.runnerError) {
      return { tone: 'fail', short: '调用失败', text: '没能执行：' + record.runnerError };
    }
    if (record.timedOut) return { tone: 'fail', short: '超时（60 秒）', text: '执行超时：60 秒未结束已被终止' };
    if (record.exitCode === 0) return { tone: 'ok', short: '成功', text: '执行成功（退出码 0）' };
    return { tone: 'fail', short: '失败（退出码 ' + record.exitCode + '）', text: '执行失败（退出码 ' + record.exitCode + '）' };
  }

  /* ---------- 逐次执行记录（定时执行历史）---------- */

  // runlogLatest 按任务名找最近一条执行记录（插件返回的 entries 已是最新在前）。
  // 任务名来自 crontab 条目（备注优先、其次命令），与插件写 runlog 的口径一致。
  function runlogLatest(name) {
    var wanted = String(name || '').trim();
    if (!wanted) return null;
    var list = (S.runlog && S.runlog.entries) || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].task_name || '') === wanted) return list[i];
    }
    return null;
  }
  // runlogRecord 把一条 runlog 记录转成本页统一的结果形状（paintResult 直接复用）。
  function runlogRecord(entry) {
    return {
      at: entry.started_at,
      runnerError: '',
      exitCode: typeof entry.exit_code === 'number' ? entry.exit_code : null,
      timedOut: !!entry.timed_out,
      durationMs: entry.duration_ms,
      command: '',
      output: entry.output_head || '',
      outputBytes: entry.output_bytes || 0,
      scheduled: true
    };
  }
  // latestRun 取某条任务最近一次执行：优先本页立即执行的结果，其次定时执行记录。
  // 定时记录是持久化的（刷新仍在），这样"到点跑失败"不用手动点了才看得见。
  function latestRun(entry) {
    var local = runRecord(entry.index);
    if (local) return { record: local, scheduled: false };
    var log = runlogLatest(entry.task_name);
    if (log) return { record: runlogRecord(log), scheduled: true };
    return null;
  }

  // loadRunlog 读逐次执行记录：available=false 照实说明（还没跑过），不伪装成失败。
  function loadRunlog() {
    if (!S.runlogHost) return Promise.resolve();
    S.runlog.loading = true;
    S.runlog.error = '';
    paintRunlog();
    return invoke('cron.runlog', { limit: 50 }).then(function (data) {
      S.runlog.available = !!data.available;
      S.runlog.entries = Array.isArray(data.entries) ? data.entries : [];
      S.runlog.note = data.note || '';
      S.runlog.loading = false;
      paintRunlog();
      paintList();
    }, function (err) {
      S.runlog.loading = false;
      S.runlog.available = false;
      S.runlog.entries = [];
      S.runlog.error = err.message || '读取失败';
      paintRunlog();
    });
  }

  // runlogVerdict 判定一条执行记录：成功 / 失败（退出码）/ 超时，与立即执行同一套文案。
  function runlogVerdict(entry) {
    return runVerdict(runlogRecord(entry));
  }

  // paintRunlog 渲染「执行历史」表：时间（人话）/ 任务 / 状态 / 耗时 / 关键输出。
  // 输出只给关键行，全量（前 512 字节）折叠——与立即执行的结果面板同一口径。
  function paintRunlog() {
    if (!S.runlogHost) return;
    S.runlogHost.textContent = '';
    var entries = S.runlog.entries || [];
    var shown = S.runlog.failuresOnly
      ? entries.filter(function (e) { return runlogVerdict(e).tone === 'fail'; })
      : entries;
    if (S.runlogMeta) {
      S.runlogMeta.textContent = S.runlog.loading ? '读取中…'
        : S.runlog.error ? '读取失败'
          : S.runlog.available ? ('最近 ' + entries.length + ' 条' +
            (S.runlog.failuresOnly ? '（只看失败 ' + shown.length + ' 条）' : ''))
            : '还没有执行记录';
    }
    if (S.runlogToggle) {
      S.runlogToggle.hidden = !entries.length;
      S.runlogToggle.textContent = S.runlog.failuresOnly ? '显示全部' : '只看失败';
      S.runlogToggle.setAttribute('aria-pressed', S.runlog.failuresOnly ? 'true' : 'false');
    }
    if (S.runlog.loading) {
      add(S.runlogHost, el('div', 'panel-empty empty-state')).appendChild(
        el('p', 'empty-state-text', '正在读取执行历史…'));
      return;
    }
    if (S.runlog.error) {
      var box = add(S.runlogHost, el('div', 'fw-callout-warn'));
      add(box, el('div', 'fw-callout-title', '执行历史读不出来'));
      add(box, el('p', 'fw-callout-text', S.runlog.error));
      add(box, el('p', 'fw-callout-text',
        '先点「重试」再读一次；一直失败的话，到「软件商店」确认计划任务插件已更新到新版本。'));
      emptyButton(box, '重试', true, loadRunlog);
      return;
    }
    if (!entries.length) {
      var empty = add(S.runlogHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '还没有执行记录。'));
      add(empty, el('p', 'empty-state-text',
        '任务到点执行后，每一次的时间、状态、退出码和关键输出都会记在这里（刷新不丢）；' +
        '不想等到点，也可以点任务行的「立即执行」先跑一次。'));
      var ops = add(empty, el('div', 'task-empty-ops'));
      ops.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
      emptyButton(ops, '刷新', true, loadRunlog);
      emptyButton(ops, '用预设创建第一个任务', false, primeFirstPreset);
      if (S.runlog.note) add(S.runlogHost, el('p', 'task-note', S.runlog.note));
      return;
    }
    if (!shown.length) {
      var calm = add(S.runlogHost, el('div', 'panel-empty empty-state'));
      add(calm, el('p', 'empty-state-text', '最近 ' + entries.length + ' 次执行全部成功，没有失败记录。'));
      emptyButton(add(calm, el('div')), '显示全部记录', true, function () {
        S.runlog.failuresOnly = false;
        paintRunlog();
      });
      return;
    }
    var table = add(S.runlogHost, el('table', 'tasks-table task-runlog-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    ['时间', '任务', '状态', '耗时', '输出'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    shown.forEach(function (entry) {
      var verdict = runlogVerdict(entry);
      var tr = add(body, el('tr'));
      if (verdict.tone === 'fail') tr.style.boxShadow = 'inset 3px 0 0 var(--kore-danger)';
      var when = add(tr, el('td', 'task-log-time', humanTime(entry.started_at)));
      when.title = entry.started_at || '';
      when.dataset.label = '时间';
      add(tr, el('td', 'mono', entry.task_name || '—')).dataset.label = '任务';
      var state = add(tr, el('td')); state.dataset.label = '状态';
      var tone = verdict.tone === 'ok' ? 'ok' : verdict.tone === 'warn' ? 'warn' : 'fail';
      var c = add(state, el('span', 'chip chip-' + tone));
      if (tone === 'fail') c.style.color = 'var(--kore-danger)';
      add(c, el('span', 'dot ' + tone));
      add(c, el('span', null, verdict.short));
      var dur = add(tr, el('td', 'muted', humanDuration(entry.duration_ms))); dur.dataset.label = '耗时';
      var out = add(tr, el('td', 'task-command')); out.dataset.label = '输出';
      // 手机端 td 是 flex 行（左侧 84px 标签列）：允许换行，摘要与折叠区才能独占整行。
      out.style.flexWrap = 'wrap';
      var text = String(entry.output_head || '');
      var picked = keyLines(text);
      var summary = picked.lines.length ? picked.lines : ['（这次执行没有输出）'];
      var pre = add(out, el('pre', 'task-output', summary.join('\n')));
      pre.style.cssText = 'margin:0;max-height:120px;overflow:auto;';
      pre.setAttribute('aria-label', '第 ' + (entry.task_name || '') + ' 条执行记录的关键输出');
      var more = [];
      more.push('开始于 ' + humanTime(entry.started_at));
      more.push('耗时 ' + humanDuration(entry.duration_ms) || '耗时未知');
      if (entry.exit_code !== undefined && entry.exit_code !== null) more.push('退出码 ' + entry.exit_code);
      if (entry.mode === 'scheduled') more.push('定时执行');
      else if (entry.mode === 'manual') more.push('立即执行');
      if (entry.output_bytes) more.push('输出共 ' + entry.output_bytes + ' 字节');
      if (entry.truncated) more.push('只保留了前 512 字节');
      if (picked.hidden > 0) more.push('关键行已折叠 ' + picked.hidden + ' 行');
      add(out, el('div', 'muted', more.join(' · '))).style.cssText =
        'margin-top:4px;font-size:12px;color:var(--kore-text-3);flex-basis:100%;width:100%;';
      if (verdict.tone === 'fail') {
        var details = add(out, el('details', 'task-raw'));
        // 手机端 td 是 flex（左侧 84px 标签列）：折叠区必须独占一行，
        // 否则 summary 会被挤成竖排单字（截图验收时发现）。
        details.style.cssText = 'display:block;flex-basis:100%;width:100%;margin-top:4px;';
        add(details, el('summary', null, '查看保存的输出（前 512 字节）'));
        var full = add(details, el('pre', 'task-output', text || '（这次执行没有输出）'));
        full.style.maxHeight = '240px';
        full.setAttribute('aria-label', '执行记录保存的完整输出');
      }
    });
    if (S.runlog.note) add(S.runlogHost, el('p', 'task-note', S.runlog.note));
  }

  // entryRisk 用插件返回的 binary_status 预判"到点会静默失败"：missing 必失败，stale 升级后易失败。
  function entryRisk(entry) {
    var status = entry.binary_status || '';
    var note = entry.binary_note || '';
    if (status === 'missing') return note || '任务指向的程序不存在，到点会静默失败：点「修复路径」改写为当前版本，或删除后重建。';
    if (status === 'stale') return note || '任务指向的是旧版本程序，升级后可能执行失败：点「修复路径」改写到当前稳定路径。';
    return '';
  }
  // entryAbnormal 是行级异常判定（用于标红与"只看异常"过滤）。
  function entryAbnormal(entry) {
    if (entryRisk(entry)) return true;
    var latest = latestRun(entry);
    if (!latest) return false;
    var record = latest.record;
    return !!(record.runnerError || record.timedOut || record.exitCode !== 0);
  }
  function abnormalCount() {
    var n = 0;
    S.entries.forEach(function (entry) { if (entryAbnormal(entry)) n++; });
    return n;
  }

  // 行内启停：cron.enable / cron.disable（不弹窗，直接写当前用户 crontab）。
  function toggleTask(entry, button) {
    if (S.locked) return;
    var next = !entry.enabled, previous = entry.enabled;
    var action = next ? 'cron.enable' : 'cron.disable';
    // 乐观更新：先翻转行状态并置灰，失败再回滚到原状态（不假装成功）。
    entry.enabled = next;
    paintList();
    setStatus('正在' + (next ? '启用' : '停用') + '第 ' + entry.index + ' 条任务…');
    invoke(action, { index: entry.index }).then(function (data) {
      var enabled = data.entry && typeof data.entry.enabled === 'boolean' ? data.entry.enabled : next;
      setStatus('第 ' + entry.index + ' 条任务已' + (enabled ? '启用' : '停用') +
        (data.changed ? '（已写回 crontab）' : '（状态未变化）') +
        (data.backup_path ? '；原内容已备份' : ''), 'ok');
      showBackup(data.backup_path);
      load();
    }, function (err) {
      entry.enabled = previous;
      paintList();
      var perm = permissionProblem(err.message);
      setStatus((next ? '启用' : '停用') + '失败，已恢复原状态：' + err.message, 'fail');
      if (perm) {
        appendRootHint(S.status, err.message,
          { command: 'sudo systemctl restart kore' },
          '这项操作需要系统管理员权限：请让管理员为 Kore 服务授权后重试（部署手册有具体步骤）。');
      }
    });
  }

  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone);
    add(c, el('span', 'dot ' + tone));
    add(c, el('span', null, text));
    return c;
  }

  function typeBadge(type) {
    var label = type === 'http' ? 'http' : 'shell';
    return el('span', 'task-badge task-badge-' + label, label);
  }

  function selectedIndexes() {
    return Object.keys(S.selected).filter(function (k) { return S.selected[k]; })
      .map(Number).sort(function (a, b) { return a - b; });
  }
  function paintBulkCount() {
    if (!S.bulkCount) return;
    var ids = selectedIndexes();
    S.bulkCount.textContent = ids.length ? '已选 ' + ids.length + ' 条' : '未选择任务';
    if (S.bulkEnable) S.bulkEnable.disabled = S.locked || !ids.length;
    if (S.bulkDisable) S.bulkDisable.disabled = S.locked || !ids.length;
  }
  function batchTasks(action) {
    var ids = selectedIndexes();
    if (!ids.length) { setStatus('请先勾选要批量操作的任务', 'fail'); return; }
    setStatus('正在批量' + (action === 'enable' ? '启用' : '停用') + ' ' + ids.length + ' 条任务…');
    invoke('cron.batch', { action: action, ids: ids }).then(function (data) {
      var ok = (data.succeeded || []).length;
      var bad = data.failed || [];
      var detail = bad.length ? '（' + bad.map(function (item) {
        return '第 ' + item.id + ' 条：' + (item.error || '失败');
      }).join('；') + '）' : '';
      var msg = '批量' + (action === 'enable' ? '启用' : '停用') + '：成功 ' + ok + ' 条，失败 ' + bad.length + ' 条' + detail;
      var tone = bad.length ? 'fail' : 'ok';
      S.selected = {};
      load().then(function () { setStatus(msg, tone); });
    }, function (err) {
      // 旧版插件没有 cron.batch（E_NOTFOUND）：给逐条操作指引，不在前端假装成功。
      setStatus('批量操作未完成：' + (err.message || '当前插件版本不支持批量操作') + '；可逐条点「启用/停用」。', 'fail');
    });
  }
  function paintBulkBar() {
    var bar = add(S.listHost, el('div', 'task-bulk'));
    bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:8px 16px;border-bottom:1px solid var(--kore-border-2);';
    var allLabel = add(bar, el('label', 'task-bulk-all'));
    allLabel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;min-height:44px;';
    var all = add(allLabel, el('input'));
    all.type = 'checkbox'; S.bulkAll = all;
    add(allLabel, el('span', null, '全选'));
    all.checked = S.entries.length > 0 && selectedIndexes().length === S.entries.length;
    all.disabled = S.locked;
    all.addEventListener('change', function () {
      S.selected = {};
      if (all.checked) S.entries.forEach(function (e) { S.selected[e.index] = true; });
      paintList();
    });
    S.bulkEnable = add(bar, el('button', 'btn', '批量启用')); S.bulkEnable.type = 'button';
    S.bulkDisable = add(bar, el('button', 'btn btn-ghost', '批量停用')); S.bulkDisable.type = 'button';
    on(S.bulkEnable, function () { batchTasks('enable'); });
    on(S.bulkDisable, function () { batchTasks('disable'); });
    S.bulkCount = add(bar, el('span', 'muted', ''));
    paintBulkCount();
  }

  // 一键修复：cron.migrate 把 crontab 里指向旧版本程序的路径改写到稳定路径（写前先备份）。
  function fixPaths() {
    if (S.locked) { setStatus('当前为只读：需要系统管理员权限才能修复任务路径', 'fail'); return; }
    confirmBox('把任务里指向旧版本程序的路径改写到当前稳定路径？原 crontab 会先备份。', function (close, msg, ok) {
      ok.textContent = '修复中…';
      invoke('cron.migrate', {}).then(function (data) {
        close();
        showBackup(data.backup_path);
        var rewritten = data.rewritten || 0;
        var note = data.note ? '（' + data.note + '）' : '';
        setStatus(rewritten ? '已修复 ' + rewritten + ' 条任务的程序路径' + note
          : '没有需要修复的任务路径' + note, 'ok');
        load();
      }, function (err) { ok.disabled = false; msg.textContent = err.message; });
    });
  }

  function goStore() {
    var K = window.KoreShell;
    if (K && typeof K.navigate === 'function') K.navigate('store');
    else setStatus('打开左侧「软件商店」即可安装计划任务插件', 'ok');
  }
  // 空态「用预设创建第一个任务」直接把第一张预设卡填进表单（1 次点击 → 检查 → 保存 = 2 步），
  // 而不是只把用户滚到卡片前、再让他点第二下。
  function primeFirstPreset() {
    var list = S.quickPresets || [];
    if (!list.length || S.locked) { focusForm(); return; }
    applyQuickPreset(list[0]);
  }
  function focusForm() {
    if (!S.form) return;
    S.form.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    S.form.schedule.focus();
    setStatus('先填时间表达式（分 时 日 月 周），再填命令或地址', 'ok');
  }

  // emptyButton 是空态里的「下一步」按钮：必带 44px 触摸高度（裁决41）。
  function emptyButton(host, label, primary, fn) {
    var b = add(host, el('button', 'btn' + (primary ? ' btn-primary' : ''), label));
    b.type = 'button';
    b.style.minHeight = '44px';
    on(b, fn);
    return b;
  }

  // paintEmptyList 空状态：一句现状 + 明确的下一步按钮，不留「暂无数据」死胡同。
  function paintEmptyList() {
    var empty = add(S.listHost, el('div', 'panel-empty empty-state'));
    var ops = add(empty, el('div', 'task-empty-ops'));
    ops.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    if (S.loadError) {
      add(empty, el('p', 'empty-state-text', '计划任务读不出来：' + S.loadError));
      add(empty, el('p', 'empty-state-text',
        '先点「重试」再读一次；一直失败的话，到「软件商店」确认计划任务插件已安装并启用，' +
        '或按上方提示让管理员给 Kore 服务授权。'));
      emptyButton(ops, '重试', true, function () { load(); });
      emptyButton(ops, '去软件商店看看', false, goStore);
      return;
    }
    if (S.warning) {
      add(empty, el('p', 'empty-state-text', '当前环境读不到系统计划任务：' + S.warning));
      add(empty, el('p', 'empty-state-text', '点「重试读取」再试一次；仍不行就按上方提示授权后重试。'));
      emptyButton(ops, '重试读取', true, function () { load(); });
      return;
    }
    var title = add(empty, el('p', 'empty-state-text'));
    add(title, el('strong', null, '还没有任何定时任务'));
    var firstPreset = (S.quickPresets && S.quickPresets[0]) ? S.quickPresets[0].name : '最常用的预设';
    add(empty, el('p', 'empty-state-text',
      '下一步：点「用预设创建第一个任务」会把「' + firstPreset + '」的时间和命令自动填好，' +
      '检查后点「新增任务」就建好了——共 2 步，不用先想清楚 cron 语法。'));
    emptyButton(ops, '用预设创建第一个任务', true, primeFirstPreset);
    emptyButton(ops, '手动填写', false, focusForm);
  }

  // paintRunCell 渲染「最近执行」列：程序路径失效（会失败）优先，其次本页执行结果。
  function paintRunCell(cell, entry) {
    var wrap = add(cell, el('div', 'task-run-cell'));
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;';
    var risk = entryRisk(entry);
    if (risk) {
      var bad = add(wrap, el('button', 'chip chip-fail', S.locked ? '会失败' : '会失败 · 修复'));
      bad.type = 'button';
      bad.disabled = S.locked;
      bad.title = risk;
      bad.setAttribute('aria-label', '这条任务会失败：' + risk);
      bad.style.cssText = 'color:var(--kore-danger);cursor:pointer;';
      on(bad, fixPaths);
    }
    var latest = latestRun(entry);
    if (latest) {
      var record = latest.record;
      var verdict = runVerdict(record);
      var status = add(wrap, el('span', 'chip chip-' + (verdict.tone === 'ok' ? 'ok' : verdict.tone === 'fail' ? 'fail' : 'na')));
      if (verdict.tone === 'fail') status.style.color = 'var(--kore-danger)';
      add(status, el('span', 'dot ' + (verdict.tone === 'ok' ? 'ok' : verdict.tone === 'fail' ? 'fail' : 'na')));
      add(status, el('span', null, verdict.short));
      status.title = verdict.text + (latest.scheduled
        ? '（定时执行记录，来自「执行历史」，刷新后仍在）'
        : '（本页立即执行，刷新后清空）');
      var when = add(wrap, el('span', 'muted', humanTime(record.at)));
      when.style.cssText = 'font-size:12px;';
      when.title = String(record.at);
      if (latest.scheduled) {
        var tag = add(wrap, el('span', 'muted', '定时'));
        tag.style.cssText = 'font-size:12px;color:var(--kore-text-3);';
        tag.title = '这条状态来自插件记录的真实定时执行，不是本页手动点出来的';
      }
      return;
    }
    if (!risk) add(wrap, el('span', 'muted', '—'));
    if (entry.wrapped === false) {
      var noLog = add(wrap, el('span', 'muted', '无逐任务日志'));
      noLog.style.cssText = 'font-size:12px;';
      noLog.title = '该任务没套上执行日志包装（命令过长或取不到插件路径），定时执行不会留下退出码记录';
    }
  }

  // paintList：表格 + 行级失败标记 +「只看异常」过滤。
  // 列 = 选择 / 索引 / 类型 / 时间 / 命令（含备注）/ 最近执行 / 操作；备注并入命令列以让出失败列宽。
  function paintList() {
    if (!S.listHost) return;
    S.listHost.textContent = '';
    var bad = abnormalCount();
    if (S.listMeta) {
      S.listMeta.textContent = S.entries.length
        ? ('共 ' + S.entries.length + ' 条' + (bad ? ' · ' + bad + ' 条异常' : ''))
        : '';
    }
    paintFilterBtn(bad);
    if (!S.entries.length) { paintEmptyList(); return; }
    if (S.filter === 'abnormal' && !bad) {
      var calm = add(S.listHost, el('div', 'panel-empty empty-state'));
      add(calm, el('p', 'empty-state-text', '当前没有异常任务：所有任务的程序路径可用，本页执行也都成功。'));
      emptyButton(add(calm, el('div')), '显示全部任务', true, function () { S.filter = 'all'; paintList(); });
      return;
    }
    paintBulkBar();
    var table = add(S.listHost, el('table', 'tasks-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    ['选择', '索引', '类型', '时间表达式', '命令', '最近执行', '操作'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.entries.forEach(function (entry) {
      var abnormal = entryAbnormal(entry);
      if (S.filter === 'abnormal' && !abnormal) return;
      var tr = add(body, el('tr'));
      if (entry.enabled === false) {
        tr.style.opacity = '0.55';
        tr.title = '该任务已停用（定义仍保留在 crontab 注释中）';
      }
      if (abnormal) {
        // 失败行显著标记：左侧红条 + 标题说明，不靠颜色单通道（同时有文字 chip）。
        tr.style.boxShadow = 'inset 3px 0 0 var(--kore-danger)';
        tr.style.opacity = entry.enabled === false ? '0.6' : '1';
      }
      var checkCell = add(tr, el('td', 'task-check'));
      var check = add(checkCell, el('input'));
      check.type = 'checkbox'; check.setAttribute('aria-label', '选择第 ' + entry.index + ' 条任务');
      check.checked = !!S.selected[entry.index];
      check.disabled = S.locked;
      check.addEventListener('change', function () {
        if (check.checked) S.selected[entry.index] = true; else delete S.selected[entry.index];
        paintBulkCount();
      });
      var index = add(tr, el('td', 'task-index', String(entry.index)));
      index.dataset.label = '索引';
      var type = add(tr, el('td')); type.dataset.label = '类型';
      add(type, typeBadge(entry.type));
      if (typeof entry.enabled === 'boolean') add(type, chip(entry.enabled ? 'ok' : 'na', entry.enabled ? '已启用' : '已停用'));
      var schedule = add(tr, el('td')); schedule.dataset.label = '时间表达式';
      var human = humanCron(entry.schedule);
      if (human) add(schedule, el('span', null, human + ' '));
      add(schedule, el('span', 'mono muted', entry.schedule));
      var command = add(tr, el('td', 'mono task-command')); command.dataset.label = '命令';
      // 命令与备注包在同一个内容块里：手机端 <640px 的 td 是 flex（左侧标签 84px），
      // 直接塞两个子节点会把备注挤成竖排单字。
      var commandBody = add(command, el('div', 'task-command-body'));
      commandBody.style.cssText = 'min-width:0;word-break:break-word;';
      add(commandBody, el('span', null, entry.command));
      if (entry.comment) {
        var commentLine = add(commandBody, el('div', 'muted', '备注：' + entry.comment));
        commentLine.style.cssText = 'margin-top:4px;font-family:inherit;font-size:12px;color:var(--kore-text-3);';
      }
      var runCell = add(tr, el('td', 'task-run')); runCell.dataset.label = '最近执行';
      paintRunCell(runCell, entry);
      var ops = add(tr, el('td', 'cell-ops')); ops.dataset.label = '操作';
      if (typeof entry.enabled === 'boolean') {
        var toggle = add(ops, el('button', 'btn btn-ghost task-toggle-btn', entry.enabled ? '停用' : '启用'));
        toggle.type = 'button';
        toggle.setAttribute('data-action', entry.enabled ? 'cron-disable' : 'cron-enable');
        toggle.title = entry.enabled ? '停用该任务（注释掉 crontab 行，配置保留）' : '启用该任务（恢复 crontab 行）';
        toggle.disabled = S.locked;
        on(toggle, function () { toggleTask(entry, toggle); });
      }
      var edit = add(ops, el('button', 'btn', '编辑')); edit.type = 'button';
      if (entry.type && entry.type !== 'shell') {
        edit.disabled = true;
        edit.title = 'http 任务由 url/headers/body 生成，改参数请删除后重建';
      } else {
        edit.disabled = S.locked;
        on(edit, function () { beginEdit(entry); });
      }
      // 最近一次执行可能来自本页立即执行，也可能来自插件的定时执行记录：
      // 两种都要给「查看日志」入口，否则"到点跑失败"在行上只显示状态、点不进去。
      var latestForRow = latestRun(entry);
      var record = latestForRow ? latestForRow.record : null;
      var failedBefore = !!(record && (record.runnerError || record.timedOut || record.exitCode !== 0));
      var run = add(ops, el('button', 'btn task-run-btn', failedBefore ? '重试' : '立即执行'));
      run.type = 'button';
      run.disabled = S.locked;
      run.title = failedBefore
        ? '用同样的命令再跑一次（上次失败 / 超时）'
        : '直接执行该任务在 crontab 里的命令（不经过 crontab 调度）';
      on(run, function () { runTask(entry); });
      if (record) {
        var logBtn = add(ops, el('button', 'btn btn-ghost task-log-btn', '查看日志'));
        logBtn.type = 'button';
        logBtn.title = latestForRow.scheduled
          ? '看这次定时执行的时间、退出码与关键输出（插件持久记录，刷新不丢）'
          : '看这次执行的关键日志（错误行 + 首尾）与完整输出';
        on(logBtn, function () { showRunLog(entry.index); });
      }
      var del = add(ops, el('button', 'btn btn-ghost tasks-del', '删除')); del.type = 'button';
      del.disabled = S.locked;
      on(del, function () { removeTask(entry); });
    });
  }

  // paintFilterBtn 维护列表头的「只看异常」开关（无异常时不显示，避免空按钮）。
  function paintFilterBtn(bad) {
    if (!S.filterBtn) return;
    S.filterBtn.hidden = !bad && S.filter !== 'abnormal';
    S.filterBtn.textContent = (S.filter === 'abnormal' ? '显示全部' : '只看异常') + (bad ? '（' + bad + '）' : '');
    S.filterBtn.setAttribute('aria-pressed', S.filter === 'abnormal' ? 'true' : 'false');
  }

  // loadLogs 读系统 cron 启动日志：available=false 时照实展示原因与补救方式。
  function loadLogs() {
    if (!S.logsHost) return;
    S.logs.loading = true;
    S.logs.error = '';
    paintLogs();
    return invoke('cron.logs', { limit: 50 }).then(function (data) {
      S.logs = {
        available: !!data.available, source: data.source || '', entries: Array.isArray(data.entries) ? data.entries : [],
        note: data.note || '', loading: false, error: ''
      };
      paintLogs();
    }, function (err) {
      S.logs = { available: false, source: '', entries: [], note: '', loading: false, error: err.message };
      paintLogs();
    });
  }

  function paintLogs() {
    if (!S.logsHost) return;
    S.logsHost.textContent = '';
    if (S.logsMeta) {
      S.logsMeta.textContent = S.logs.loading ? '读取中…'
        : S.logs.error ? '读取失败'
          : S.logs.available ? ('日志源：' + S.logs.source + ' · ' + S.logs.entries.length + ' 条')
            : '没有可读的日志源';
    }
    if (S.logs.loading) {
      add(S.logsHost, el('div', 'panel-empty empty-state'));
      add(S.logsHost.lastChild, el('p', 'empty-state-text', '正在读取系统 cron 日志…'));
      return;
    }
    if (S.logs.error) {
      add(S.logsHost, el('div', 'site-result-error')).textContent = '执行日志读取失败：' + S.logs.error;
      return;
    }
    if (!S.logs.available) {
      var warn = add(S.logsHost, el('div', 'fw-callout-warn'));
      add(warn, el('div', 'fw-callout-title', '本机没有可读的 cron 执行日志'));
      add(warn, el('p', 'fw-callout-text', S.logs.note || '系统 crontab 默认不记录执行日志。'));
      add(warn, el('p', 'fw-callout-text',
        '要看到「谁在什么时候跑了哪条任务」，需要系统开启 cron 日志（部署手册有一行开启命令）；' +
        '不看系统日志也能验证任务：点任务行的「立即执行」即可看到退出码与关键输出。'));
      var recheck = add(warn, el('button', 'btn', '重新检测日志源'));
      recheck.type = 'button'; recheck.style.minHeight = '44px';
      on(recheck, loadLogs);
      return;
    }
    if (!S.logs.entries.length) {
      var empty = add(S.logsHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '日志源里暂无 CRON 启动记录：任务还没到点执行过，或日志刚被轮转。'));
      emptyButton(empty, '刷新日志', true, loadLogs);
      if (S.logs.note) add(S.logsHost, el('p', 'task-note', S.logs.note));
      return;
    }
    var table = add(S.logsHost, el('table', 'tasks-table task-logs-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    ['时间', '用户', 'PID', '命令'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.logs.entries.forEach(function (entry) {
      var tr = add(body, el('tr'));
      var time = add(tr, el('td', 'task-log-time', humanTime(entry.time)));
      time.title = entry.time || '';
      time.dataset.label = '时间';
      var user = add(tr, el('td', 'mono', entry.user || '—')); user.dataset.label = '用户';
      var pid = add(tr, el('td', 'mono', entry.pid || '—')); pid.dataset.label = 'PID';
      var command = add(tr, el('td', 'mono task-command', entry.command || '')); command.dataset.label = '命令';
    });
    if (S.logs.note) add(S.logsHost, el('p', 'task-note', S.logs.note));
  }

  /* ---------- 内核定时任务（ADR-0019）：plugin 型任务建在这里，本页必须可见 / 可重试 ---------- */

  function schedRequest(method, path, body) {
    var token = cookie('kore_csrf');
    if (method !== 'GET' && !token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var headers = { Accept: 'application/json' };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-Kore-CSRF'] = token; }
    var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: headers };
    if (body) opts.body = JSON.stringify(body);
    return fetch(SCHEDULER_API + (path || ''), opts).then(readResponse);
  }

  function loadSched() {
    if (!S.sched.host) return Promise.resolve();
    S.sched.loading = true;
    S.sched.error = '';
    paintSched();
    return schedRequest('GET', '').then(function (data) {
      S.sched.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      S.sched.loading = false;
      S.sched.loaded = true;
      paintSched();
    }, function (err) {
      S.sched.loading = false;
      S.sched.loaded = true;
      S.sched.error = (err && err.message) || '读取失败';
      paintSched();
    });
  }

  function schedName(task) { return task.name || (task.plugin + '.' + task.method); }
  function schedSchedule(task) {
    if (task.schedule) return humanCron(task.schedule) || task.schedule;
    var sec = task.interval_s;
    if (!sec) return '—';
    if (sec % 3600 === 0) return '每 ' + (sec / 3600) + ' 小时';
    if (sec % 60 === 0) return '每 ' + (sec / 60) + ' 分钟';
    return '每 ' + sec + ' 秒';
  }
  function schedAbnormal(task) {
    return task.last_result === 'failed' || task.last_result === 'timeout';
  }

  // paintSchedLast 渲染内核任务的「最近执行」：后端 last_result 是权威判定
  // （ok / failed / timeout / skipped / missed），失败与超时红字 + 红点。
  function paintSchedLast(cell, task) {
    var wrap = add(cell, el('div'));
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;';
    if (!task.last_result) { add(wrap, el('span', 'muted', '还没执行过')); return; }
    var state = SCHED_STATUS[task.last_result] || { text: task.last_result, tone: 'warn' };
    var tone = state.tone === 'ok' ? 'ok' : state.tone === 'warn' ? 'warn' : 'fail';
    var c = add(wrap, el('span', 'chip chip-' + tone));
    if (tone === 'fail') c.style.color = 'var(--kore-danger)';
    add(c, el('span', 'dot ' + tone));
    add(c, el('span', null, state.text));
    if (task.last_run_at) {
      var when = add(wrap, el('span', 'muted', humanTime(task.last_run_at)));
      when.style.cssText = 'font-size:12px;';
      when.title = task.last_run_at;
    }
    if (task.missed_count) {
      var missed = add(wrap, el('span', 'muted', '错过 ' + task.missed_count + ' 次'));
      missed.style.cssText = 'font-size:12px;';
      missed.title = '停机期间错过的执行不补跑，到下一个时间点再执行';
    }
  }

  function paintSched() {
    if (!S.sched.host) return;
    S.sched.host.textContent = '';
    var list = S.sched.tasks || [];
    var bad = 0;
    list.forEach(function (t) { if (schedAbnormal(t)) bad++; });
    if (S.sched.meta) {
      S.sched.meta.textContent = S.sched.loading ? '读取中…'
        : S.sched.error ? '读取失败'
          : '共 ' + list.length + ' 条' + (bad ? ' · ' + bad + ' 条最近执行失败' : '');
    }
    if (S.sched.loading) {
      var loading = add(S.sched.host, el('div', 'panel-empty empty-state'));
      add(loading, el('p', 'empty-state-text', '正在读取内核定时任务…'));
      return;
    }
    if (S.sched.error) {
      var box = add(S.sched.host, el('div', 'fw-callout-warn'));
      add(box, el('div', 'fw-callout-title', '内核定时任务读不出来'));
      add(box, el('p', 'fw-callout-text', S.sched.error));
      emptyButton(box, '重试读取', true, loadSched);
      return;
    }
    if (!list.length) {
      var empty = add(S.sched.host, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text',
        '还没有内核定时任务。插件任务（备份、证书续期、审计清理等）由内核调度，' +
        '在上方「任务类型」里选「插件任务」就能建一条。'));
      emptyButton(empty, '建一条插件任务', false, focusPluginForm);
      return;
    }
    var table = add(S.sched.host, el('table', 'tasks-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    ['名称', '插件方法', '计划', '下次执行', '最近执行', '操作'].forEach(function (label) {
      add(htr, el('th', null, label));
    });
    var body = add(table, el('tbody'));
    list.forEach(function (task) {
      var abnormal = schedAbnormal(task);
      var tr = add(body, el('tr'));
      if (task.enabled === false) {
        tr.style.opacity = '0.55';
        tr.title = '该任务已停用（定义保留，到点不执行）';
      }
      if (abnormal) tr.style.boxShadow = 'inset 3px 0 0 var(--kore-danger)';
      var name = add(tr, el('td')); name.dataset.label = '名称';
      add(name, el('span', null, schedName(task)));
      if (task.enabled === false) add(name, chip('na', '已停用'));
      var method = add(tr, el('td', 'mono muted')); method.dataset.label = '插件方法';
      method.textContent = task.plugin + '.' + task.method;
      var plan = add(tr, el('td')); plan.dataset.label = '计划';
      add(plan, el('span', null, schedSchedule(task)));
      if (task.schedule) add(plan, el('span', 'mono muted', ' ' + task.schedule));
      var next = add(tr, el('td')); next.dataset.label = '下次执行';
      next.textContent = task.next_run_at ? humanTime(task.next_run_at) : '—';
      if (task.next_run_at) next.title = task.next_run_at;
      var last = add(tr, el('td')); last.dataset.label = '最近执行';
      paintSchedLast(last, task);
      var ops = add(tr, el('td', 'cell-ops')); ops.dataset.label = '操作';
      var run = add(ops, el('button', 'btn task-sched-run', abnormal ? '重试' : '立即执行'));
      run.type = 'button';
      run.title = '立刻执行一次（不改下次执行时间）';
      on(run, function () { runSchedTask(task); });
      var histBtn = add(ops, el('button', 'btn btn-ghost', '执行历史'));
      histBtn.type = 'button';
      histBtn.title = '看这条任务每次到点执行的时间、状态与耗时（最近 100 条）';
      on(histBtn, function () { showSchedRuns(task); });
      var editBtn = add(ops, el('button', 'btn', '改计划'));
      editBtn.type = 'button';
      if (task.plugin === 'kore') {
        editBtn.disabled = true;
        editBtn.title = '系统自带任务（证书续期 / 审计清理等）的计划由内核配置管理，' +
          '请改对应配置项后重启，不能在这里直接改';
      } else {
        editBtn.title = '就地修改执行时间或启停（调用的插件动作不变）';
        on(editBtn, function () { openSchedEdit(task); });
      }
      var logBtn = add(ops, el('button', 'btn btn-ghost', '查看日志'));
      logBtn.type = 'button';
      logBtn.title = '看最近一次执行的结果与错误信息';
      on(logBtn, function () { showSchedLog(task); });
      var del = add(ops, el('button', 'btn btn-ghost tasks-del', '删除'));
      del.type = 'button';
      on(del, function () { removeSchedTask(task); });
    });
    add(S.sched.host, el('p', 'task-note',
      '内核定时任务由 Kore 按时间直接调用插件动作（备份、证书续期、审计清理等），不写系统 crontab；' +
      '时间或启停可以点「改计划」就地修改，插件动作不随之改变——要换动作请删除后重建。'));
  }

  function focusPluginForm() {
    if (!S.form) return;
    setType('plugin');
    S.form.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    S.form.plugin.focus();
    setStatus('填插件 id 与方法名，保存后由内核调度执行（不写 crontab）', 'ok');
  }

  function showSchedLog(task) {
    var label = schedName(task);
    S.result = {
      visible: true, kind: 'sched', index: null, id: task.id, title: '内核定时任务「' + label + '」',
      record: { at: task.last_run_at || Date.now(), status: task.last_result || '', error: '',
        durationMs: 0, runnerError: '' },
      error: ''
    };
    paintResult();
    scrollToResult();
  }

  function runSchedTask(task) {
    var label = schedName(task);
    confirmBox('立即执行一次「' + label + '」？会真调用它的插件方法，执行结果稍后显示在下方（不改下次执行时间）。',
      function (close, msg, ok) {
        ok.textContent = '执行中…';
        schedRequest('POST', '/' + encodeURIComponent(task.id) + '/run').then(function (run) {
          close();
          S.result = {
            visible: true, kind: 'sched', index: null, id: task.id,
            title: '内核定时任务「' + label + '」',
            record: { at: Date.now(), status: run.status, error: run.error || '',
              durationMs: run.dur_ms, runnerError: '' },
            error: ''
          };
          paintResult();
          var state = SCHED_STATUS[run.status] || { text: run.status || '完成', tone: 'warn' };
          setStatus('「' + label + '」执行' + state.text, state.tone === 'ok' ? 'ok' : 'fail');
          scrollToResult();
          loadSched();
        }, function (err) {
          close();
          S.result = {
            visible: true, kind: 'sched', index: null, id: task.id,
            title: '内核定时任务「' + label + '」',
            record: { at: Date.now(), status: 'failed', error: '', durationMs: 0,
              runnerError: err.message || '调用失败' },
            error: ''
          };
          paintResult();
          setStatus('没能执行「' + label + '」：' + err.message, 'fail');
          scrollToResult();
        });
      });
  }

  // schedById 按 id 找当前列表里的内核任务（重试 / 历史按钮都要最新定义）。
  function schedById(id) {
    var found = null;
    (S.sched.tasks || []).forEach(function (t) { if (t.id === id) found = t; });
    return found;
  }

  // openSchedEdit 就地改计划（PUT /scheduler/tasks/{id}）：表达式 / 固定间隔 / 启停。
  // 插件与方法不可改——改了等于换一条任务，页面明确说明而不是让用户猜。
  // 内置任务（plugin=kore，如证书续期 / 审计清理）由内核配置管理，入口直接禁用。
  function openSchedEdit(task) {
    var mask = el('div', 'kore-modal');
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
    var box = add(mask, el('div', 'kore-modal-box'));
    add(box, el('div', 'kore-modal-title', '修改执行计划'));
    add(box, el('p', 'kore-modal-text',
      '「' + schedName(task) + '」只改什么时候执行，它调用的插件动作不变。'));
    var modeField = add(box, el('label', 'field'));
    add(modeField, el('span', 'field-label', '按什么时间执行'));
    var mode = add(modeField, el('select', 'field-input'));
    [['schedule', '按时间表达式（分 时 日 月 周）'], ['interval', '按固定间隔（秒）']].forEach(function (pair) {
      var option = el('option', null, pair[1]); option.value = pair[0]; add(mode, option);
    });
    mode.value = task.schedule ? 'schedule' : 'interval';
    var valueField = add(box, el('label', 'field'));
    var valueLabel = add(valueField, el('span', 'field-label', ''));
    var valueInput = add(valueField, el('input', 'field-input mono'));
    valueInput.type = 'text'; valueInput.autocomplete = 'off';
    function syncValue() {
      if (mode.value === 'schedule') {
        valueLabel.textContent = '时间表达式（例：0 3 * * * 表示每天 03:00）';
        valueInput.value = task.schedule || '';
        valueInput.placeholder = '0 3 * * *';
      } else {
        valueLabel.textContent = '间隔秒数（需在 30 秒到 366 天之间，例：3600 表示每小时）';
        valueInput.value = task.interval_s ? String(task.interval_s) : '3600';
        valueInput.placeholder = '3600';
      }
    }
    mode.addEventListener('change', syncValue);
    syncValue();
    var enabledLabel = add(box, el('label', 'task-bulk-all'));
    enabledLabel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;min-height:44px;';
    var enabled = add(enabledLabel, el('input'));
    enabled.type = 'checkbox'; enabled.checked = task.enabled !== false;
    add(enabledLabel, el('span', null, '启用这条任务（取消勾选后到点不执行，历史记录保留）'));
    var msg = add(box, el('div', 'kore-modal-msg'));
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary', '保存')); ok.type = 'button';
    function close() {
      document.removeEventListener('keydown', esc);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }
    function esc(ev) { if (ev.key === 'Escape') close(); }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', esc);
    ok.addEventListener('click', function () {
      var raw = valueInput.value.trim();
      var body = { enabled: enabled.checked };
      if (mode.value === 'schedule') {
        if (raw.split(/\s+/).length !== 5) {
          msg.textContent = '时间表达式需恰好 5 段，例如 0 3 * * *（每天 03:00）';
          valueInput.focus();
          return;
        }
        body.schedule = raw;
      } else {
        var seconds = Number(raw);
        if (!/^\d+$/.test(raw) || seconds < 30 || seconds > 31622400) {
          msg.textContent = '间隔需是 30 到 31622400 之间的整数秒（最多一年），例：3600 表示每小时';
          valueInput.focus();
          return;
        }
        body.interval_s = seconds;
      }
      ok.disabled = true;
      schedRequest('PUT', '/' + encodeURIComponent(task.id), body).then(function () {
        close();
        setStatus('已修改「' + schedName(task) + '」的执行计划', 'ok');
        loadSched();
      }, function (err) { ok.disabled = false; msg.textContent = err.message; });
    });
    document.body.appendChild(mask);
    valueInput.focus();
  }

  // showSchedRuns 打开内核任务的执行历史（GET /scheduler/tasks/{id}/runs）。
  // 与「立即执行」区分：这里看的是**已经发生过的**定时执行，不是这次点出来的结果。
  function showSchedRuns(task) {
    S.result = {
      visible: true, kind: 'schedruns', index: null, id: task.id,
      title: '内核定时任务「' + schedName(task) + '」', record: null,
      runs: [], note: '', loading: true, error: ''
    };
    paintResult();
    scrollToResult();
    schedRequest('GET', '/' + encodeURIComponent(task.id) + '/runs?limit=20').then(function (data) {
      S.result.runs = Array.isArray(data.runs) ? data.runs : [];
      S.result.note = data.note || '';
      S.result.loading = false;
      paintResult();
    }, function (err) {
      S.result.loading = false;
      S.result.error = err.message || '读取失败';
      paintResult();
    });
  }

  // paintSchedRuns 渲染内核任务的执行历史：时间 / 状态 / 耗时 / 错误摘要。
  function paintSchedRuns() {
    var runs = S.result.runs || [];
    var head = add(S.runHost, el('div', 'task-result-head'));
    var verdictText = S.result.loading ? '正在读取执行历史…'
      : S.result.error ? '执行历史读取失败'
        : (runs.length ? '最近 ' + runs.length + ' 次执行' : '还没有执行记录');
    var verdict = add(head, el('p', 'task-result-verdict', verdictText));
    verdict.style.cssText = 'margin:0 0 4px;font-size:15px;font-weight:600;color:var(--kore-text-1);';
    if (S.result.title) {
      var which = add(head, el('p', 'muted', S.result.title));
      which.style.cssText = 'margin:0 0 4px;font-size:12px;';
    }
    if (S.result.error) {
      add(S.runHost, el('div', 'site-result-error')).textContent = '执行历史读取失败：' + S.result.error;
      var retryOps = add(S.runHost, el('div', 'task-result-ops'));
      retryOps.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;';
      emptyButton(retryOps, '重试', true, function () {
        var task = schedById(S.result.id);
        if (task) showSchedRuns(task);
      });
      return;
    }
    if (S.result.loading) return;
    var task = schedById(S.result.id);
    if (!runs.length) {
      var empty = add(S.runHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text',
        '这条任务还没有执行记录：到点执行，或点「立即执行」先跑一次，' +
        '之后每次的时间、结果与耗时都会记在这里（最近 100 条）。'));
      var ops = add(empty, el('div', 'task-empty-ops'));
      ops.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
      if (task) emptyButton(ops, '立即执行一次', true, function () { runSchedTask(task); });
      return;
    }
    var table = add(S.runHost, el('table', 'tasks-table'));
    var thead = add(table, el('thead')), htr = add(thead, el('tr'));
    ['时间', '状态', '耗时', '错误信息'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    runs.forEach(function (run) {
      var state = SCHED_STATUS[run.status] || { text: run.status || '未知', tone: 'warn' };
      var tone = state.tone === 'ok' ? 'ok' : state.tone === 'warn' ? 'warn' : 'fail';
      var tr = add(body, el('tr'));
      if (tone === 'fail') tr.style.boxShadow = 'inset 3px 0 0 var(--kore-danger)';
      var when = add(tr, el('td', 'task-log-time', humanTime(run.started_at)));
      when.title = String(run.started_at || '');
      when.dataset.label = '时间';
      var cell = add(tr, el('td')); cell.dataset.label = '状态';
      var chipNode = add(cell, el('span', 'chip chip-' + tone));
      if (tone === 'fail') chipNode.style.color = 'var(--kore-danger)';
      add(chipNode, el('span', 'dot ' + tone));
      add(chipNode, el('span', null, state.text));
      add(tr, el('td', 'muted', humanDuration(run.dur_ms) || '—')).dataset.label = '耗时';
      var errCell = add(tr, el('td', 'mono')); errCell.dataset.label = '错误信息';
      errCell.textContent = run.error || '—';
      errCell.style.cssText = 'word-break:break-word;';
    });
    if (S.result.note) add(S.runHost, el('p', 'task-note', S.result.note));
  }

  function removeSchedTask(task) {
    var label = schedName(task);
    confirmBox('删除内核定时任务「' + label + '」？删除后不再执行，要恢复只能重新创建。', function (close, msg, ok) {
      schedRequest('DELETE', '/' + encodeURIComponent(task.id)).then(function () {
        close();
        setStatus('已删除内核定时任务「' + label + '」', 'ok');
        loadSched();
      }, function (err) { ok.disabled = false; msg.textContent = err.message; });
    });
  }

  function load() {
    setStatus('正在读取计划任务…');
    S.loadError = '';
    return invoke('cron.list', {}).then(function (data) {
      S.entries = Array.isArray(data.entries) ? data.entries : [];
      S.warning = data.warning || '';
      S.loadError = '';
      // 打开页面即探测权限：cron.list 成功但带权限告警（crontab -l 失败）同样按只读处理。
      var blocked = permissionProblem(S.warning);
      setLocked(blocked);
      showWarning(blocked ? '' : S.warning);
      paintList();
      if (S.locked) setStatus('当前为只读：需要系统管理员权限才能读取/写入系统计划任务，见上方说明', 'fail');
      else if (S.warning) setStatus('已读取；当前环境受限，见上方提示', 'ok');
      else setStatus(S.entries.length ? '计划任务已刷新' : '还没有任何定时任务：点「用预设创建第一个任务」即可建好第一条', 'ok');
      loadSched();
      // 任务名用于把执行历史对回行内状态：列表刷新后重读一次（读文件尾部，开销小）。
      loadRunlog();
    }, function (err) {
      var blocked = permissionProblem(err && (err.message + ' ' + (err.code || '')));
      if (blocked) {
        // 权限错误不是"读取失败"，而是环境不满足前置条件：锁表单 + 黄底说明。
        S.entries = []; S.warning = blocked; setLocked(blocked); showWarning(''); paintList();
        setStatus('当前为只读：需要系统管理员权限才能读取/写入系统计划任务，见上方说明', 'fail');
        return;
      }
      // 其它失败（插件未装 / 未启动 / 网络）走带「下一步」按钮的错误空态，不留裸错误码。
      S.entries = []; S.loadError = err.message || '未知原因';
      paintList();
      setStatus('计划任务读取失败：' + (err.message || '未知原因'), 'fail');
      loadSched();
    });
  }

  // buildTypeFields 生成三组按类型切换的字段；全部控件一次性建好，切换只改 hidden。
  function buildTypeFields(form) {
    var shell = add(form, el('div', 'task-type-group task-type-shell'));
    var cmdField = add(shell, el('label', 'field task-cmd'));
    add(cmdField, el('span', 'field-label', '命令'));
    var command = add(cmdField, el('input', 'field-input mono'));
    command.type = 'text'; command.placeholder = '/usr/local/bin/backup.sh'; command.autocomplete = 'off';

    var http = add(form, el('div', 'task-type-group task-type-http'));
    http.hidden = true;
    var urlField = add(http, el('label', 'field task-url'));
    add(urlField, el('span', 'field-label', 'URL（http / https）'));
    var url = add(urlField, el('input', 'field-input mono'));
    url.type = 'url'; url.placeholder = 'https://example.com/health'; url.autocomplete = 'off';
    var methodField = add(http, el('label', 'field task-http-method'));
    add(methodField, el('span', 'field-label', '方法'));
    var httpMethod = add(methodField, el('select', 'field-input'));
    HTTP_METHODS.forEach(function (name) {
      var option = el('option', null, name); option.value = name; add(httpMethod, option);
    });
    var headersField = add(http, el('label', 'field'));
    add(headersField, el('span', 'field-label', '请求头（每行「名称: 值」，可留空）'));
    var headers = add(headersField, el('textarea', 'field-input task-textarea mono'));
    headers.rows = 3; headers.placeholder = 'X-Token: abc';
    var bodyField = add(http, el('label', 'field'));
    add(bodyField, el('span', 'field-label', '请求体（可留空，不支持换行）'));
    var body = add(bodyField, el('textarea', 'field-input task-textarea mono'));
    body.rows = 2; body.placeholder = '{"ok":true}';

    var plugin = add(form, el('div', 'task-type-group task-type-plugin'));
    plugin.hidden = true;
    var pluginField = add(plugin, el('label', 'field'));
    add(pluginField, el('span', 'field-label', '插件 id'));
    var pluginInput = add(pluginField, el('input', 'field-input mono'));
    pluginInput.type = 'text'; pluginInput.placeholder = 'backup'; pluginInput.autocomplete = 'off';
    var pluginMethodField = add(plugin, el('label', 'field'));
    add(pluginMethodField, el('span', 'field-label', '插件方法'));
    var pluginMethod = add(pluginMethodField, el('input', 'field-input mono'));
    pluginMethod.type = 'text'; pluginMethod.placeholder = 'backup.create'; pluginMethod.autocomplete = 'off';
    var paramsField = add(plugin, el('label', 'field'));
    add(paramsField, el('span', 'field-label', '参数（JSON 对象，可留空）'));
    var params = add(paramsField, el('textarea', 'field-input task-textarea mono'));
    params.rows = 3; params.placeholder = '{"scope":"files"}';

    return {
      shell: shell, http: http, plugin: plugin,
      command: command, url: url, httpMethod: httpMethod, headers: headers, body: body,
      pluginInput: pluginInput, pluginMethod: pluginMethod, params: params
    };
  }

  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '计划任务'));
    add(head, el('p', 'view-sub',
      '任务会在固定时间自动执行：上表是系统计划任务（crontab），下表是内核调度的插件任务。' +
      '执行失败的任务会标红，点「重试」可以再跑一次。'));
    var adv = add(head, el('details', 'task-advanced'));
    adv.style.cssText = 'margin-top:6px;font-size:12px;color:var(--kore-text-3);';
    add(adv, el('summary', null, '高级说明'));
    add(adv, el('p', 'task-advanced-text',
      '普通任务写入当前用户的系统计划任务表（crontab，shell / http），每次写入前会自动备份原内容；' +
      '「插件任务」不写 crontab，而是生成内核调度器（/api/v1/scheduler/tasks）的任务描述。'));
    // 权限只读说明条：黄底 + 提权指引，位于表单之前（先看到原因，再看到被禁用的表单）。
    S.permHost = add(root, el('div', 'task-perm-host'));
    S.permHost.hidden = true;
    var quickPanel = add(root, el('section', 'panel task-quick-panel'));
    var quickHead = add(quickPanel, el('div', 'panel-head'));
    add(quickHead, el('span', 'panel-title', '常用任务'));
    S.quickMeta = add(quickHead, el('span', 'panel-meta', '点一下自动填好，确认保存即可'));
    S.quickGrid = add(quickPanel, el('div', 'task-quick-grid'));
    S.quickGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;padding:12px 16px;';
    paintQuickPresets(QUICK_PRESETS, '内置预设');
    var formPanel = add(root, el('section', 'panel task-form-panel'));
    var formHead = add(formPanel, el('div', 'panel-head'));
    add(formHead, el('span', 'panel-title', '任务表单'));
    add(formHead, el('span', 'panel-meta', 'shell / http / plugin'));
    var form = add(formPanel, el('form', 'task-form'));
    var typeField = add(form, el('label', 'field task-type-row'));
    add(typeField, el('span', 'field-label', '任务类型'));
    var typeSelect = add(typeField, el('select', 'field-input task-type-select'));
    TYPES.forEach(function (pair) {
      var option = el('option', null, pair[1]); option.value = pair[0]; add(typeSelect, option);
    });
    typeSelect.addEventListener('change', function () { setType(typeSelect.value); });
    var fields = buildTypeFields(form);

    var schedField = add(form, el('label', 'field task-sched'));
    add(schedField, el('span', 'field-label', '时间表达式（分 时 日 月 周）'));
    var schedule = add(schedField, el('input', 'field-input mono'));
    schedule.type = 'text'; schedule.placeholder = '* * * * *'; schedule.autocomplete = 'off';
    var presets = add(form, el('div', 'task-presets'));
    presets.setAttribute('role', 'group'); presets.setAttribute('aria-label', '常用预设');
    S.presets = [];
    PRESETS.forEach(function (preset) {
      var b = add(presets, el('button', 'btn btn-ghost task-preset', preset[0]));
      b.type = 'button';
      on(b, function () { schedule.value = preset[1]; schedule.focus(); });
      S.presets.push(b);
    });
    var noteField = add(form, el('label', 'field task-note'));
    add(noteField, el('span', 'field-label', '备注（可选；plugin 任务会作为任务名）'));
    var comment = add(noteField, el('input', 'field-input'));
    comment.type = 'text'; comment.placeholder = '例如：每日备份'; comment.autocomplete = 'off';
    var ops = add(form, el('div', 'task-form-ops'));
    var submit = add(ops, el('button', 'btn btn-primary task-submit', '新增任务')); submit.type = 'submit';
    var cancel = add(ops, el('button', 'btn btn-ghost task-cancel', '取消编辑'));
    cancel.type = 'button'; cancel.hidden = true;
    on(cancel, cancelEdit);
    var hint = add(form, el('p', 'task-hint muted', hintForType('shell', null)));
    S.form = {
      panel: formPanel, typeSelect: typeSelect, submit: submit, cancel: cancel, hint: hint,
      schedule: schedule, comment: comment,
      command: fields.command, url: fields.url, httpMethod: fields.httpMethod,
      headers: fields.headers, body: fields.body,
      plugin: fields.pluginInput, pluginMethod: fields.pluginMethod, params: fields.params,
      typeShell: fields.shell, typeHTTP: fields.http, typePlugin: fields.plugin
    };
    form.addEventListener('submit', submitForm);
    S.status = add(root, el('div', 'task-status muted'));
    S.status.setAttribute('role', 'status');
    S.warn = add(root, el('div', 'task-warn'));
    S.warn.setAttribute('role', 'status');
    S.warn.hidden = true;
    S.backup = add(root, el('div', 'task-backup mono'));
    S.backup.hidden = true;
    var listPanel = add(root, el('section', 'panel'));
    var listHead = add(listPanel, el('div', 'panel-head'));
    add(listHead, el('span', 'panel-title', '任务列表'));
    S.listMeta = add(listHead, el('span', 'panel-meta', ''));
    S.filterBtn = add(listHead, el('button', 'btn btn-ghost', '只看异常'));
    S.filterBtn.type = 'button';
    S.filterBtn.hidden = true;
    S.filterBtn.setAttribute('aria-pressed', 'false');
    on(S.filterBtn, function () {
      S.filter = S.filter === 'abnormal' ? 'all' : 'abnormal';
      paintList();
    });
    var refresh = add(listHead, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, load);
    S.listHost = add(listPanel, el('div', 'tasks-list-host'));

    // 执行历史（cron.runlog）：每次到点执行的时间 / 状态 / 退出码 / 关键输出，
    // 与「立即执行」的结果分开——那份是本页点出来的、刷新即丢，这份是持久记录。
    var runlogPanel = add(root, el('section', 'panel task-runlog-panel'));
    var runlogHead = add(runlogPanel, el('div', 'panel-head'));
    add(runlogHead, el('span', 'panel-title', '执行历史'));
    S.runlogMeta = add(runlogHead, el('span', 'panel-meta', ''));
    S.runlogToggle = add(runlogHead, el('button', 'btn btn-ghost', '只看失败'));
    S.runlogToggle.type = 'button';
    S.runlogToggle.hidden = true;
    S.runlogToggle.setAttribute('aria-pressed', 'false');
    on(S.runlogToggle, function () {
      S.runlog.failuresOnly = !S.runlog.failuresOnly;
      paintRunlog();
    });
    var runlogRefresh = add(runlogHead, el('button', 'btn btn-ghost', '刷新')); runlogRefresh.type = 'button';
    on(runlogRefresh, loadRunlog);
    S.runlogHost = add(runlogPanel, el('div', 'task-runlog-host'));

    // 内核定时任务（ADR-0019）：这里建的插件任务必须在本页可见——否则"建完就消失"。
    var schedPanel = add(root, el('section', 'panel task-sched-panel'));
    var schedHead = add(schedPanel, el('div', 'panel-head'));
    add(schedHead, el('span', 'panel-title', '内核定时任务'));
    S.sched.meta = add(schedHead, el('span', 'panel-meta', ''));
    var schedRefresh = add(schedHead, el('button', 'btn btn-ghost', '刷新')); schedRefresh.type = 'button';
    on(schedRefresh, loadSched);
    S.sched.host = add(schedPanel, el('div', 'task-sched-host'));

    // 执行结果与日志：默认隐藏，跑过之后展示结论 / 关键行 / 折叠的全量输出。
    S.runPanel = add(root, el('section', 'panel task-run-panel'));
    S.runPanel.hidden = true;
    var runHead = add(S.runPanel, el('div', 'panel-head'));
    add(runHead, el('span', 'panel-title', '执行结果与日志'));
    var runClose = add(runHead, el('button', 'btn btn-ghost', '关闭')); runClose.type = 'button';
    on(runClose, function () {
      S.result = { visible: false, kind: '', index: null, id: '', title: '', record: null, error: '' };
      paintResult();
    });
    S.runHost = add(S.runPanel, el('div', 'task-run-host'));

    // 系统 cron 日志：默认自动加载一次；来源与 note 照实展示（available=false 不伪装成功）。
    // 与上面「执行历史」区分：这里是 cron 守护进程的启动行（谁在什么时候启动了命令），
    // 不含退出码与输出；每次执行的成败看「执行历史」。
    var logsPanel = add(root, el('section', 'panel task-logs-panel'));
    var logsHead = add(logsPanel, el('div', 'panel-head'));
    add(logsHead, el('span', 'panel-title', '系统 cron 日志'));
    S.logsMeta = add(logsHead, el('span', 'panel-meta', ''));
    var logsRefresh = add(logsHead, el('button', 'btn btn-ghost', '刷新日志')); logsRefresh.type = 'button';
    on(logsRefresh, loadLogs);
    S.logsHost = add(logsPanel, el('div', 'task-logs-host'));
  }

  /* 跨视图预填（G-33 A5）：monitor 空态「一键开启连续采样」写一份 sessionStorage draft
     再导航到本页。这里只读一次：白名单字段直接填进表单控件，不自动提交、不自动创建任务。
     存储不可用或无 draft 时静默跳过（不影响正常新建流程）。draft 读完即删，避免下次进页又填。 */
  function applyTaskDraft() {
    var draft = null, raw = '';
    try {
      if (!window.sessionStorage) return;
      raw = window.sessionStorage.getItem('kore:task-draft:v1') || '';
      if (!raw) return;
      draft = JSON.parse(raw);
      window.sessionStorage.removeItem('kore:task-draft:v1');
    } catch (e) { return; }
    if (!draft || typeof draft !== 'object' || !S.form) return;
    var allowed = ['shell', 'http', 'plugin'];
    if (allowed.indexOf(draft.type) >= 0) setType(draft.type);
    if (typeof draft.schedule === 'string') S.form.schedule.value = draft.schedule;
    if (typeof draft.comment === 'string') S.form.comment.value = draft.comment;
    if (draft.type === 'plugin') {
      if (typeof draft.plugin === 'string') S.form.plugin.value = draft.plugin;
      if (typeof draft.method === 'string') S.form.pluginMethod.value = draft.method;
      if (draft.params && typeof draft.params === 'object') S.form.params.value = JSON.stringify(draft.params);
    }
    setStatus('已按你的选择预填任务表单：核对后点「新增任务」才会创建，不会自动提交。', 'ok');
    S.form.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function render(container) {
    if (!container) return null;
    container.textContent = '';
    S.entries = []; S.editIndex = null; S.warning = ''; S.warnText = ''; S.locked = false; S.lockReason = '';
    S.type = 'shell'; S.selected = {};
    S.logs = { available: null, source: '', entries: [], note: '', loading: false, error: '' };
    S.runlog = { available: null, entries: [], note: '', loading: false, error: '', failuresOnly: false };
    S.schedRuns = {};
    S.runs = {}; S.filter = 'all'; S.loadError = '';
    S.result = { visible: false, kind: '', index: null, id: '', title: '', record: null, error: '' };
    S.sched = { host: null, meta: null, loading: false, loaded: false, error: '', tasks: [] };
    var root = add(container, el('section', 'tasks'));
    build(root);
    applyTaskDraft();
    loadQuickTemplates();
    setLocked('');
    load();
    loadLogs();
    loadRunlog();
  }
  window.KoreTasks = { render: render };
})();
