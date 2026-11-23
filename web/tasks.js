/* kore 主壳 · 计划任务（web/tasks.js）
   入口 window.KoreTasks.render(container)，零框架 / 零 CDN / 无外链。
   调 cron 插件：POST /api/v1/invoke/cron/cron.<action>，写请求带 X-Kore-CSRF。
   方法面（0.3.0）：
     cron.list / cron.add / cron.replace / cron.remove —— 系统 crontab 增删改查；
     cron.logs —— 读系统 cron 启动日志（journalctl / cron.log / syslog）；
     cron.run  —— 同步执行**已注册任务**的命令（不接受任意命令）。
   任务类型：shell / http 落系统 crontab；plugin 类型按 ADR-0019 归内核 scheduler，
   前端拿到 cron.add 返回的 scheduler_task 建议后调 /api/v1/scheduler/tasks 创建，
   cron 插件不写 crontab、不执行 plugin 任务。
   编辑只替换 schedule+command（cron.replace 不接收 comment，原备注由插件保留），
   http 任务要改参数请删除后重建；所有写操作展示插件返回的 backup_path。 */
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
  // 提权说明锚点：docs/RUNBOOK.md §5「以 root 启动 kored 与提权通道（ADR-0018）」。
  var RUNBOOK_PRIV = 'docs/RUNBOOK.md#5-以-root-启动-kored-与提权通道adr-0018';
  // warning = 环境受限原因（供列表空态与只读判定），warnText = 灰底提示条的当前文案；两者不互相覆盖。
  var S = {
    entries: [], editIndex: null, warning: '', warnText: '', locked: false, lockReason: '',
    type: 'shell',
    logs: { available: null, source: '', entries: [], note: '', loading: false, error: '' },
    run: { visible: false, error: '', result: null }
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
        ? '当前没有 root 权限：表单与立即执行已禁用，仅保留只读展示。'
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
    var box = add(S.permHost, el('div', 'fw-callout-warn task-perm-warn'));
    box.setAttribute('role', 'status');
    add(box, el('div', 'fw-callout-title', '当前无法读取系统计划任务'));
    var p = add(box, el('p', 'fw-callout-text',
      '当前无法读取系统计划任务：' + S.lockReason + '。需要 root 权限（kored 需以 root 运行）。 '));
    var a = add(p, el('a', 'task-perm-link', '查看提权说明'));
    a.href = RUNBOOK_PRIV; a.target = '_blank'; a.rel = 'noopener noreferrer';
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
      setStatus('当前为只读：需要 root 权限才能写入系统计划任务', 'fail');
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

  // runTask 立即执行：确认 → 同步调用 cron.run（最长 60s）→ 结果面板。
  function runTask(entry) {
    if (S.locked) return;
    // 停用任务后端会拒绝（E_CONFLICT）：这里先给人话指引，不把裸错误甩给用户。
    if (entry.enabled === false) {
      setStatus('该任务已停用，先点「启用」再执行', 'fail');
      return;
    }
    confirmBox('将立即执行第 ' + entry.index + ' 条任务（同步，最长 60 秒）：' + entry.command, function (close, msg, ok) {
      ok.textContent = '执行中…';
      invoke('cron.run', { index: entry.index }).then(function (data) {
        close();
        S.run = { visible: true, error: '', result: data };
        paintRun();
        setStatus('第 ' + entry.index + ' 条任务执行完成，退出码 ' + data.exit_code, data.exit_code === 0 ? 'ok' : 'fail');
        if (S.runPanel) S.runPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, function (err) {
        close();
        S.run = { visible: true, error: err.message, result: null };
        paintRun();
        setStatus('立即执行失败：' + err.message, 'fail');
      });
    });
  }

  function paintRun() {
    if (!S.runHost) return;
    S.runHost.textContent = '';
    if (S.runPanel) S.runPanel.hidden = !S.run.visible;
    if (!S.run.visible) return;
    if (S.run.error) {
      var box = add(S.runHost, el('div', 'site-result-error'));
      add(box, el('p', null, '立即执行失败：' + S.run.error));
      return;
    }
    var result = S.run.result || {};
    var meta = add(S.runHost, el('div', 'task-run-meta'));
    add(meta, el('span', null, '退出码 ' + result.exit_code));
    add(meta, el('span', null, '耗时 ' + result.duration_ms + ' ms'));
    if (result.timed_out) add(meta, el('span', 'row-note-fail', '已超时（60s）并终止'));
    add(meta, el('span', 'mono', result.command || ''));
    var output = add(S.runHost, el('pre', 'task-output', result.output || '（无输出）'));
    output.setAttribute('aria-label', '执行输出');
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
      setStatus((next ? '启用' : '停用') + '失败，已恢复原状态：' + err.message +
        (perm ? '（按 RUNBOOK §5 以 root 启动 kored 后重试）' : ''), 'fail');
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

  function paintList() {
    if (!S.listHost) return;
    S.listHost.textContent = '';
    if (S.listMeta) S.listMeta.textContent = S.entries.length ? '共 ' + S.entries.length + ' 条' : '';
    if (!S.entries.length) {
      var empty = add(S.listHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', S.warning
        ? '当前环境读不到 crontab，暂无计划任务可显示'
        : '还没有任务，先从上面挑一个常用任务'));
      return;
    }
    var table = add(S.listHost, el('table', 'tasks-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    ['索引', '类型', '时间表达式', '命令', '备注', '操作'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.entries.forEach(function (entry) {
      var tr = add(body, el('tr'));
      if (entry.enabled === false) {
        tr.style.opacity = '0.55';
        tr.title = '该任务已停用（定义仍保留在 crontab 注释中）';
      }
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
      add(command, el('span', null, entry.command));
      var comment = add(tr, el('td', 'muted')); comment.dataset.label = '备注';
      add(comment, el('span', null, entry.comment || '—'));
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
      var run = add(ops, el('button', 'btn task-run-btn', '立即执行')); run.type = 'button';
      run.disabled = S.locked;
      run.title = '直接执行该任务在 crontab 里的命令（不经过 crontab 调度）';
      on(run, function () { runTask(entry); });
      var del = add(ops, el('button', 'btn btn-ghost tasks-del', '删除')); del.type = 'button';
      del.disabled = S.locked;
      on(del, function () { removeTask(entry); });
    });
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
      return;
    }
    if (!S.logs.entries.length) {
      var empty = add(S.logsHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '日志源里暂无 CRON 启动记录'));
      if (S.logs.note) add(S.logsHost, el('p', 'task-note', S.logs.note));
      return;
    }
    var table = add(S.logsHost, el('table', 'tasks-table task-logs-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    ['时间', '用户', 'PID', '命令'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.logs.entries.forEach(function (entry) {
      var tr = add(body, el('tr'));
      var time = add(tr, el('td', 'mono task-log-time', entry.time)); time.dataset.label = '时间';
      var user = add(tr, el('td', 'mono', entry.user || '—')); user.dataset.label = '用户';
      var pid = add(tr, el('td', 'mono', entry.pid || '—')); pid.dataset.label = 'PID';
      var command = add(tr, el('td', 'mono task-command', entry.command || '')); command.dataset.label = '命令';
    });
    if (S.logs.note) add(S.logsHost, el('p', 'task-note', S.logs.note));
  }

  function load() {
    setStatus('正在读取计划任务…');
    return invoke('cron.list', {}).then(function (data) {
      S.entries = Array.isArray(data.entries) ? data.entries : [];
      S.warning = data.warning || '';
      // 打开页面即探测权限：cron.list 成功但带权限告警（crontab -l 失败）同样按只读处理。
      var blocked = permissionProblem(S.warning);
      setLocked(blocked);
      showWarning(blocked ? '' : S.warning);
      paintList();
      if (S.locked) setStatus('当前为只读：需要 root 权限才能读取/写入系统计划任务，见上方说明', 'fail');
      else if (S.warning) setStatus('已读取；当前环境受限，见上方提示', 'ok');
      else setStatus(S.entries.length ? '计划任务已刷新' : '还没有任务，先从上面挑一个常用任务', 'ok');
    }, function (err) {
      var blocked = permissionProblem(err && (err.message + ' ' + (err.code || '')));
      if (blocked) {
        // 权限错误不是"读取失败"，而是环境不满足前置条件：锁表单 + 黄底说明。
        S.entries = []; S.warning = blocked; setLocked(blocked); showWarning(''); paintList();
        setStatus('当前为只读：需要 root 权限才能读取/写入系统计划任务，见上方说明', 'fail');
        return;
      }
      setStatus('计划任务读取失败：' + err.message, 'fail');
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
    add(head, el('p', 'view-sub', '这里的任务会在固定时间自动执行；系统级任务由 Kore 内核调度。'));
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
    add(quickHead, el('span', 'panel-meta', '点一下自动填好，确认保存即可'));
    var quickGrid = add(quickPanel, el('div', 'task-quick-grid'));
    quickGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;padding:12px 16px;';
    QUICK_PRESETS.forEach(function (preset) {
      var card = add(quickGrid, el('button', 'btn task-quick-card'));
      card.type = 'button';
      card.setAttribute('aria-label', '使用预设：' + preset.name);
      card.style.cssText = 'display:block;text-align:left;min-height:88px;padding:12px 14px;line-height:1.45;';
      add(card, el('strong', null, preset.name));
      var meta = add(card, el('span', 'task-quick-meta', preset.why));
      meta.style.cssText = 'display:block;margin-top:6px;font-size:12px;color:var(--kore-text-3);';
      on(card, function () { applyQuickPreset(preset); });
    });
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
    var refresh = add(listHead, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, load);
    S.listHost = add(listPanel, el('div', 'tasks-list-host'));

    // 立即执行结果：默认隐藏，跑过之后展示退出码 / 耗时 / 输出。
    S.runPanel = add(root, el('section', 'panel task-run-panel'));
    S.runPanel.hidden = true;
    var runHead = add(S.runPanel, el('div', 'panel-head'));
    add(runHead, el('span', 'panel-title', '立即执行结果'));
    var runClose = add(runHead, el('button', 'btn btn-ghost', '关闭')); runClose.type = 'button';
    on(runClose, function () { S.run = { visible: false, error: '', result: null }; paintRun(); });
    S.runHost = add(S.runPanel, el('div', 'task-run-host'));

    // 执行日志：默认自动加载一次；来源与 note 照实展示（available=false 不伪装成功）。
    var logsPanel = add(root, el('section', 'panel task-logs-panel'));
    var logsHead = add(logsPanel, el('div', 'panel-head'));
    add(logsHead, el('span', 'panel-title', '执行日志'));
    S.logsMeta = add(logsHead, el('span', 'panel-meta', ''));
    var logsRefresh = add(logsHead, el('button', 'btn btn-ghost', '刷新日志')); logsRefresh.type = 'button';
    on(logsRefresh, loadLogs);
    S.logsHost = add(logsPanel, el('div', 'task-logs-host'));
  }

  function render(container) {
    if (!container) return null;
    container.textContent = '';
    S.entries = []; S.editIndex = null; S.warning = ''; S.warnText = ''; S.locked = false; S.lockReason = '';
    S.type = 'shell';
    S.logs = { available: null, source: '', entries: [], note: '', loading: false, error: '' };
    S.run = { visible: false, error: '', result: null };
    var root = add(container, el('section', 'tasks'));
    build(root);
    setLocked('');
    load();
    loadLogs();
  }
  window.KoreTasks = { render: render };
})();
