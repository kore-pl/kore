/* kore 主壳 · 计划任务（web/tasks.js）
   入口 window.KoreTasks.render(container)，零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/cron/cron.list）；方法段写完整限定名。
   调 cron 插件：cron.list / cron.add / cron.replace / cron.remove，写请求带 X-Kore-CSRF。
   编辑只替换 schedule+command（cron.replace 不接收 comment，原备注由插件保留），
   所有写操作展示插件返回的 backup_path，让"已备份"可核对。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/cron/';
  var PRESETS = [
    ['每分钟', '* * * * *'], ['每小时', '0 * * * *'],
    ['每天 3 点', '0 3 * * *'], ['每周一 3 点', '0 3 * * 1']
  ];
  // 提权说明锚点：docs/RUNBOOK.md §5「以 root 启动 kored 与提权通道（ADR-0018）」。
  var RUNBOOK_PRIV = 'docs/RUNBOOK.md#5-以-root-启动-kored-与提权通道adr-0018';
  // warning = 环境受限原因（供列表空态与只读判定），warnText = 灰底提示条的当前文案；两者不互相覆盖。
  var S = { entries: [], editIndex: null, warning: '', warnText: '', locked: false, lockReason: '' };

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
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(API + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) throw new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        return data;
      });
    });
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

  // 只读锁定：禁用表单与预设，页面顶部给黄底说明 + 提权说明链接（不再让人填完才失败）。
  function setLocked(reason) {
    S.locked = !!reason;
    S.lockReason = reason || '';
    if (S.form) {
      [S.form.schedule, S.form.command, S.form.comment, S.form.submit, S.form.cancel].forEach(function (n) {
        if (n) n.disabled = S.locked;
      });
      if (S.locked) {
        S.form.cancel.hidden = true;
        S.form.hint.textContent = '当前没有 root 权限：表单已禁用，仅保留只读展示。';
      } else {
        S.form.hint.textContent = '5 段 crontab 表达式；命令按原样写入当前用户的 crontab。';
      }
    }
    if (S.presets) S.presets.forEach(function (b) { b.disabled = S.locked; });
    paintPerm();
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

  function cancelEdit() {
    S.editIndex = null;
    if (!S.form) return;
    S.form.schedule.value = '';
    S.form.command.value = '';
    S.form.comment.value = '';
    S.form.comment.readOnly = false;
    S.form.submit.textContent = '新增任务';
    S.form.cancel.hidden = true;
    S.form.hint.textContent = S.locked
      ? '当前没有 root 权限：表单已禁用，仅保留只读展示。'
      : '5 段 crontab 表达式；命令按原样写入当前用户的 crontab。';
  }

  function beginEdit(entry) {
    S.editIndex = entry.index;
    S.form.schedule.value = entry.schedule;
    S.form.command.value = entry.command;
    S.form.comment.value = entry.comment || '';
    S.form.comment.readOnly = true;
    S.form.submit.textContent = '保存修改（第 ' + entry.index + ' 条）';
    S.form.cancel.hidden = false;
    S.form.hint.textContent = '编辑使用 cron.replace：只替换表达式与命令，原备注保留。';
    S.form.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    S.form.schedule.focus();
  }

  function submitForm(ev) {
    ev.preventDefault();
    if (S.locked) {
      setStatus('当前为只读：需要 root 权限才能写入系统计划任务', 'fail');
      return;
    }
    var schedule = S.form.schedule.value.trim();
    var command = S.form.command.value.trim();
    if (schedule.split(/\s+/).length !== 5) {
      setStatus('时间表达式必须恰为 5 段', 'fail');
      S.form.schedule.focus();
      return;
    }
    if (!command) { setStatus('命令不能为空', 'fail'); S.form.command.focus(); return; }
    if (S.editIndex !== null) {
      confirmBox('确认用新的表达式与命令替换第 ' + S.editIndex + ' 条任务？原备注会保留。', function (close, msg, ok) {
        invoke('cron.replace', { index: S.editIndex, schedule: schedule, command: command }).then(function (data) {
          close();
          showBackup(data.backup_path);
          setStatus('已替换第 ' + S.editIndex + ' 条任务', 'ok');
          cancelEdit();
          load();
        }, function (err) { ok.disabled = false; msg.textContent = err.message; });
      });
      return;
    }
    var comment = S.form.comment.value.trim();
    S.form.submit.disabled = true;
    invoke('cron.add', { schedule: schedule, command: command, comment: comment }).then(function (data) {
      S.form.submit.disabled = false;
      showBackup(data.backup_path);
      setStatus('已新增任务：' + schedule + ' ' + command, 'ok');
      S.form.schedule.value = ''; S.form.command.value = ''; S.form.comment.value = '';
      load();
    }, function (err) {
      S.form.submit.disabled = false;
      setStatus('新增失败：' + err.message, 'fail');
    });
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

  // showWarning 用灰底提示条表达"环境限制"，与红色错误态严格区分。
  function showWarning(text) {
    S.warnText = text || '';
    if (!S.warn) return;
    S.warn.textContent = S.warnText;
    S.warn.hidden = !S.warnText;
  }
  function paintList() {
    if (!S.listHost) return;
    S.listHost.textContent = '';
    if (S.listMeta) S.listMeta.textContent = S.entries.length ? '共 ' + S.entries.length + ' 条' : '';
    if (!S.entries.length) {
      var empty = add(S.listHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', S.warning
        ? '当前环境读不到 crontab，暂无计划任务可显示'
        : '还没有计划任务，用上方表单新增一条'));
      return;
    }
    var table = add(S.listHost, el('table', 'tasks-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    ['索引', '时间表达式', '命令', '备注', '操作'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.entries.forEach(function (entry) {
      var tr = add(body, el('tr'));
      var index = add(tr, el('td', 'task-index', String(entry.index)));
      index.dataset.label = '索引';
      var schedule = add(tr, el('td', 'mono')); schedule.dataset.label = '时间表达式';
      add(schedule, el('span', null, entry.schedule));
      var command = add(tr, el('td', 'mono task-command')); command.dataset.label = '命令';
      add(command, el('span', null, entry.command));
      var comment = add(tr, el('td', 'muted')); comment.dataset.label = '备注';
      add(comment, el('span', null, entry.comment || '—'));
      var ops = add(tr, el('td', 'cell-ops')); ops.dataset.label = '操作';
      var edit = add(ops, el('button', 'btn', '编辑')); edit.type = 'button';
      on(edit, function () { beginEdit(entry); });
      var del = add(ops, el('button', 'btn btn-ghost tasks-del', '删除')); del.type = 'button';
      on(del, function () { removeTask(entry); });
    });
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
      else setStatus(S.entries.length ? '计划任务已刷新' : '还没有计划任务，用上方表单新增一条', 'ok');
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

  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '计划任务'));
    add(head, el('p', 'view-sub', '管理当前用户的 crontab；每次写入前插件都会备份原内容。'));
    // 权限只读说明条：黄底 + 提权指引，位于表单之前（先看到原因，再看到被禁用的表单）。
    S.permHost = add(root, el('div', 'task-perm-host'));
    S.permHost.hidden = true;
    var formPanel = add(root, el('section', 'panel task-form-panel'));
    var formHead = add(formPanel, el('div', 'panel-head'));
    add(formHead, el('span', 'panel-title', '任务表单'));
    add(formHead, el('span', 'panel-meta', '5 段表达式'));
    var form = add(formPanel, el('form', 'task-form'));
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
    var cmdField = add(form, el('label', 'field task-cmd'));
    add(cmdField, el('span', 'field-label', '命令'));
    var command = add(cmdField, el('input', 'field-input mono'));
    command.type = 'text'; command.placeholder = '/usr/local/bin/backup.sh'; command.autocomplete = 'off';
    var noteField = add(form, el('label', 'field task-note'));
    add(noteField, el('span', 'field-label', '备注（可选）'));
    var comment = add(noteField, el('input', 'field-input'));
    comment.type = 'text'; comment.placeholder = '例如：每日备份'; comment.autocomplete = 'off';
    var ops = add(form, el('div', 'task-form-ops'));
    var submit = add(ops, el('button', 'btn btn-primary task-submit', '新增任务')); submit.type = 'submit';
    var cancel = add(ops, el('button', 'btn btn-ghost task-cancel', '取消编辑'));
    cancel.type = 'button'; cancel.hidden = true;
    on(cancel, cancelEdit);
    var hint = add(form, el('p', 'task-hint muted', '5 段 crontab 表达式；命令按原样写入当前用户的 crontab。'));
    S.form = { panel: formPanel, schedule: schedule, command: command, comment: comment, submit: submit, cancel: cancel, hint: hint };
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
  }

  function render(container) {
    if (!container) return null;
    container.textContent = '';
    S.entries = []; S.editIndex = null; S.warning = ''; S.warnText = ''; S.locked = false; S.lockReason = '';
    var root = add(container, el('section', 'tasks'));
    build(root);
    setLocked('');
    load();
  }
  window.KoreTasks = { render: render };
})();
