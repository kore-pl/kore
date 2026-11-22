/* kore 主壳 · 数据库页 L2 管理（web/db-l2.js）
   由 web/db.js 在首次写操作（建库/删库/建用户/授权/导入导出）或展开「用户与授权」时注入，导出
   window.KoreDbL2。写方法要求插件 system:admin；删库/删用户在后端强制 confirm=true，本页一律再
   走一层「手输名称」确认，不存在单击即删路径。失败原样展示后端 code + message 并给「怎么办」。
   导入导出的 file_path 必须落在插件导出目录内（KORE_DB_EXPORT_DIR，缺省 <state>/exports），
   故默认值给相对文件名，由后端按该根目录解析。 */
(function () {
  'use strict';
  var NAME_RE = /^[a-zA-Z0-9_]{1,64}$/, USER_RE = /^[a-zA-Z0-9_]{1,32}$/, HOST_RE = /^[A-Za-z0-9._:%-]+$/;
  var PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'EXECUTE'];
  var CHARSETS = [
    { value: 'utf8mb4', label: 'utf8mb4（推荐，完整 Unicode / emoji）' }, { value: 'utf8', label: 'utf8（每字符最多 3 字节）' },
    { value: 'latin1', label: 'latin1（西欧字符，兼容老库）' }
  ];

  // L2 专属「怎么办」：先按错误码给可执行动作，未命中再回落到调用方的通用提示。
  function hintFor(ctx, err) {
    var m = String((err && err.message) || err || '');
    if (/E_UNAUTHORIZED[\s\S]*(confirm|确认)/i.test(m)) {
      return '危险操作需要显式确认（confirm=true）。本页已自动带上，若仍报错请刷新页面重试。';
    }
    if (/E_UNAUTHORIZED/.test(m)) {
      return '当前账号没有该权限：系统库与 root 账号在插件侧即被禁止；建库/建用户/授权/导入导出' +
        '还需插件声明 system:admin，且数据库账号本身具备 CREATE / CREATE USER / GRANT OPTION。';
    }
    if (/E_INVALID[\s\S]*(导出目录|export dir|KORE_DB_EXPORT_DIR)/i.test(m)) {
      return '导出目录不可用：在内核启动环境里设置 KORE_DB_EXPORT_DIR（绝对路径），或把文件写成相对文件名。';
    }
    if (/E_INVALID[\s\S]*(confirm|确认)/i.test(m)) {
      return '请求缺少 confirm=true：本页会自动带上；出现该提示说明请求被中间层改写。';
    }
    if (/文件不存在|no such file|ENOENT/i.test(m)) {
      return '文件不存在：路径必须落在导出目录内（先「导出」生成一个文件），Linux 下区分大小写。';
    }
    if (/E_INVALID/.test(m)) {
      return '参数不符合后端白名单：库名 1–64 位字母/数字/下划线；用户名 1–32 位；host 只允许字母数字' +
        ' . _ : % -；权限只允许 SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/INDEX/EXECUTE。';
    }
    if (/E_NOTFOUND/.test(m)) return '对象不存在：先刷新列表，确认名字（用户是 user@host 整体）完全一致。';
    if (/E_CONFLICT/.test(m)) {
      return '同名对象已存在：建库/建用户不会覆盖已存在对象（也不会改密码）；需要改密码请先删除该用户再重建。';
    }
    if (/E_UPSTREAM|E_INTERNAL/.test(m)) {
      return '数据库或客户端执行失败：看 message 原文；连接/超时类可重试，权限与语法类需要 DBA 处理。';
    }
    return ctx.hint ? ctx.hint(m) : '先刷新列表确认对象状态；仍失败请把 message 原文交给 DBA。';
  }

  function mk(parent, tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    parent.appendChild(n);
    return n;
  }
  function button(parent, cls, label, fn) {
    var b = mk(parent, 'button', 'btn ' + cls, label);
    b.type = 'button';
    if (fn) b.addEventListener('click', fn);
    return b;
  }
  function password() {
    var alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_=+';
    var buf = new Uint8Array(24);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
    else for (var i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    var out = '';
    for (var j = 0; j < buf.length; j++) out += alphabet.charAt(buf[j] % alphabet.length);
    return out;
  }
  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', 'readonly'); ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
      return;
    }
    fallback();
  }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function dbOptions(ctx, withNone) {
    var list = withNone ? [{ value: '', label: '不授权（只建账号）' }] : [];
    (ctx.dbs || []).forEach(function (n) { list.push({ value: n, label: n }); });
    return list;
  }

  // dialog 是所有 L2 表单的唯一入口：字段声明式生成 + 统一校验/错误呈现 + 手输确认门。
  function dialog(ctx, opts) {
    var mask = mk(document.body, 'div', 'kore-modal');
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
    var form = mk(mask, 'form', 'kore-modal-box');
    mk(form, 'div', 'kore-modal-title', opts.title);
    if (opts.text) mk(form, 'p', 'kore-modal-text', opts.text);
    if (opts.warn) mk(form, 'p', 'db-l2-warn', opts.warn);
    var inputs = {}, groups = {};
    (opts.fields || []).forEach(function (f) {
      var box = mk(form, 'div', 'field');
      if (f.label) mk(box, 'span', 'field-label', f.label + (f.required === false ? '' : '（必填）'));
      var control;
      if (f.type === 'select') {
        control = mk(box, 'select', 'field-input');
        (f.options || []).forEach(function (o) {
          var opt = mk(control, 'option', null, o.label);
          opt.value = o.value;
        });
        control.value = f.value || '';
      } else if (f.type === 'checkgroup') {
        var wrap = mk(box, 'div', 'db-l2-checks');
        groups[f.key] = [];
        (f.options || []).forEach(function (o) {
          var line = mk(wrap, 'label', 'field-check');
          var cb = mk(line, 'input', null);
          cb.type = 'checkbox'; cb.value = o.value;
          if (f.value && f.value.indexOf(o.value) >= 0) cb.checked = true;
          mk(line, 'span', null, o.label);
          groups[f.key].push(cb);
        });
        control = wrap;
      } else {
        var row = mk(box, 'div', 'db-l2-input-row');
        control = mk(row, 'input', 'field-input');
        control.type = 'text'; control.autocomplete = 'off';
        control.value = f.value || '';
        if (f.placeholder) control.placeholder = f.placeholder;
        if (f.gen) {
          button(row, 'btn-ghost', '生成', function () { control.value = password(); });
          button(row, 'btn-ghost', '复制', function () {
            copyText(control.value, function (ok) {
              mk(box, 'p', 'field-hint db-l2-copy', ok ? '已复制到剪贴板' : '复制失败，请手动全选复制');
            });
          });
        }
        if (f.mono) control.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      }
      inputs[f.key] = control;
      if (f.hint) mk(box, 'span', 'field-hint', f.hint);
    });
    var typed = null;
    if (opts.typed) {
      var tbox = mk(form, 'div', 'field');
      mk(tbox, 'span', 'field-label', opts.typed.label);
      typed = mk(tbox, 'input', 'field-input');
      typed.type = 'text'; typed.autocomplete = 'off';
      typed.placeholder = opts.typed.placeholder || '请输入上面的名称';
      mk(tbox, 'span', 'field-hint', '输入完全一致才会解锁「' + (opts.okLabel || '确定') + '」，防止误删。');
    }
    var msg = mk(form, 'div', 'kore-modal-msg');
    msg.setAttribute('role', 'alert');
    var ops = mk(form, 'div', 'kore-modal-actions');
    var cancel = button(ops, 'btn-ghost', '取消', null);
    var ok = mk(ops, 'button', 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), opts.okLabel || '确定');
    ok.type = 'submit';
    function close() {
      document.removeEventListener('keydown', esc);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }
    function esc(ev) { if (ev.key === 'Escape') close(); }
    function sync() { ok.disabled = !!(typed && typed.value !== opts.typed.expect); }
    if (typed) { typed.addEventListener('input', sync); sync(); ok.disabled = true; }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', esc);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var values = {};
      (opts.fields || []).forEach(function (f) {
        if (f.type === 'checkgroup') {
          values[f.key] = groups[f.key].filter(function (cb) { return cb.checked; })
            .map(function (cb) { return cb.value; });
        } else values[f.key] = String(inputs[f.key].value || '').trim();
      });
      msg.textContent = '';
      for (var i = 0; i < (opts.fields || []).length; i++) {
        var f = opts.fields[i];
        if (f.required === false) continue;
        if (f.validate) {
          var bad = f.validate(values[f.key]);
          if (bad) { msg.textContent = bad; inputs[f.key].focus(); return; }
        } else if (f.type !== 'checkgroup' && f.type !== 'select' && !values[f.key]) {
          msg.textContent = '请填写「' + f.label + '」'; inputs[f.key].focus(); return;
        }
      }
      if (opts.validate) {
        var extra = opts.validate(values);
        if (extra) { msg.textContent = extra; return; }
      }
      ok.disabled = true;
      Promise.resolve().then(function () {
        return opts.onSubmit(values, {
          close: close, msg: msg,
          fail: function (err) { ok.disabled = false; msg.textContent = ctx.errText(err) + ' 怎么办：' + hintFor(ctx, err); }
        });
      }).then(function (res) {
        ok.disabled = false;
        close();
        if (opts.onDone) opts.onDone(res);
      }, function (err) {
        ok.disabled = false;
        msg.textContent = ctx.errText(err) + ' 怎么办：' + hintFor(ctx, err);
      });
    });
    (form.querySelector('.field-input') || typed).focus();
    return { close: close };
  }

  function openCreateDb(ctx) {
    dialog(ctx, {
      title: '新建数据库', fields: [
        { key: 'name', label: '库名', placeholder: 'kore_app', mono: true,
          hint: '只允许字母、数字、下划线，1–64 位。', validate: function (v) { return NAME_RE.test(v) ? '' : '库名只允许字母/数字/下划线，1–64 位'; } },
        { key: 'charset', label: '字符集', type: 'select', value: 'utf8mb4', options: CHARSETS,
          hint: '不确定就保持 utf8mb4：能存中文与 emoji，和多数现代应用一致。' }
      ],
      okLabel: '创建',
      onSubmit: function (v) { return ctx.invoke('db-mysql.createDatabase', { name: v.name, charset: v.charset }); },
      onDone: function (r) {
        ctx.loadDbs();
        ctx.notice('数据库「' + (r && r.name ? r.name : '') + '」' + (r && r.created === false ? '已存在（未改动）' : '创建成功') + '。', 'ok');
      }
    });
  }

  function confirmDropDb(ctx, name) {
    dialog(ctx, {
      title: '删除数据库', danger: true, okLabel: '永久删除',
      text: '将删除数据库 `' + name + '` 及其全部表与数据，操作不可恢复。',
      warn: '删除前请先「导出」备份；系统库（mysql / information_schema / performance_schema / sys）后端会直接拒绝。',
      fields: [],
      typed: { expect: name, label: '要删除的库名：' + name + '（请手动输入）' },
      onSubmit: function () { return ctx.invoke('db-mysql.dropDatabase', { name: name, confirm: true }); },
      onDone: function () { ctx.loadDbs(); ctx.notice('数据库「' + name + '」已删除。', 'ok'); }
    });
  }

  function openExport(ctx, name) {
    var def = name + '-' + stamp() + '.sql';
    dialog(ctx, {
      title: '导出数据库', text: '导出 `' + name + '` 的结构与数据到导出目录内的 .sql 文件。',
      fields: [{ key: 'path', label: '目标文件', value: def, mono: true,
        hint: '相对路径落在插件的导出目录（默认 <状态目录>/exports，可用 KORE_DB_EXPORT_DIR 改）；默认文件名已按库名+时间戳填好。',
        validate: function (v) { return v ? '' : '请填写目标文件路径'; } }],
      okLabel: '开始导出',
      onSubmit: function (v) { return ctx.invoke('db-mysql.export', { database: name, file_path: v.path }); },
      onDone: function (r) {
        var kb = r && typeof r.size_bytes === 'number' ? '，' + Math.max(1, Math.round(r.size_bytes / 1024)) + ' KiB' : '';
        ctx.notice('已导出到 ' + (r && r.file_path ? r.file_path : def) + kb + '。', 'ok');
      }
    });
  }

  function openImport(ctx) {
    dialog(ctx, {
      title: '导入 SQL 文件',
      text: '把导出目录内的 .sql 文件导入指定数据库。',
      warn: '导入会写入目标库：文件里的 CREATE TABLE / INSERT 语句会真实执行，可能覆盖同名表的数据，且不可撤销。' +
        '建议先导出一份当前库作为回滚点，并确认目标库选对。',
      fields: [
        { key: 'database', label: '目标库', type: 'select', value: ctx.selectedDb || '',
          options: dbOptions(ctx, false), hint: '只列出当前实例可见的库；没有目标库请先「新建数据库」。' },
        { key: 'path', label: 'SQL 文件', placeholder: 'kore_app-20260101-120000.sql', mono: true,
          hint: '必须是导出目录内的文件（与「导出」同一个根目录）。' }
      ],
      okLabel: '确认导入',
      onSubmit: function (v) { return ctx.invoke('db-mysql.import', { database: v.database, file_path: v.path }); },
      onDone: function (r) {
        ctx.loadDbs();
        ctx.notice('已导入到「' + (r && r.database ? r.database : '') + '」' +
          (r && typeof r.size_bytes === 'number' ? '（' + Math.max(1, Math.round(r.size_bytes / 1024)) + ' KiB）' : '') + '。', 'ok');
      }
    });
  }

  function openCreateUser(ctx) {
    var pw = password();
    dialog(ctx, {
      title: '新建数据库用户',
      fields: [
        { key: 'user', label: '用户名', placeholder: 'kore_app', mono: true,
          hint: '字母、数字、下划线，1–32 位。', validate: function (v) { return USER_RE.test(v) ? '' : '用户名只允许字母/数字/下划线，1–32 位'; } },
        { key: 'host', label: '允许来源（host）', value: '%', mono: true,
          hint: '默认 % 表示任意来源；只允许本机就填 localhost。', validate: function (v) { return HOST_RE.test(v) ? '' : 'host 只允许字母数字 . _ : % -'; } },
        { key: 'password', label: '密码', value: pw, gen: true, mono: true, required: false,
          hint: '已自动生成 24 位随机密码，可「生成」换一个或「复制」；留空创建无密码账号（不安全，不建议）。' },
        { key: 'database', label: '授权到库（可选）', type: 'select', value: '', options: dbOptions(ctx, true) },
        { key: 'privileges', label: '权限（配合上面的库）', type: 'checkgroup', required: false,
          options: PRIVS.map(function (p) { return { value: p, label: p }; }),
          hint: '不选则只建账号。授权不可再转授（插件明确拒绝 GRANT OPTION / ALL）。' }
      ],
      okLabel: '创建用户',
      validate: function (v) {
        if (v.database && !v.privileges.length) return '选了授权库就必须至少选 1 个权限，或把授权库改回「不授权」';
        return '';
      },
      onSubmit: function (v) {
        var params = { user: v.user, host: v.host };
        if (v.password) params.password = v.password;
        if (v.database && v.privileges.length) params.grants = [v.database + ':' + v.privileges.join(',')];
        return ctx.invoke('db-mysql.createUser', params);
      },
      onDone: function (r) {
        if (ctx.onUsersChanged) ctx.onUsersChanged();
        ctx.notice('用户「' + (r && r.user ? r.user : '') + '@' + (r && r.host ? r.host : '') + '」' +
          (r && r.created === false ? '已存在（未改密码）' : '创建成功') + '。', 'ok');
      }
    });
  }

  function openGrant(ctx, user, host) {
    dialog(ctx, {
      title: '授权 ' + user + '@' + host,
      text: '给该账号追加库级权限（BACKEND 禁止 ALL 与 GRANT OPTION，仅允许下列 9 种）。',
      fields: [
        { key: 'database', label: '库', type: 'select', value: ctx.selectedDb || '',
          options: dbOptions(ctx, false) },
        { key: 'privileges', label: '权限', type: 'checkgroup', options: PRIVS.map(function (p) { return { value: p, label: p }; }),
          validate: function (v) { return v.length ? '' : '至少选 1 个权限'; } }
      ],
      okLabel: '授权',
      onSubmit: function (v) {
        return ctx.invoke('db-mysql.grant', { user: user, host: host, database: v.database, privileges: v.privileges });
      },
      onDone: function (r) {
        if (ctx.onUsersChanged) ctx.onUsersChanged();
        ctx.notice('已授权 ' + user + '@' + host + '：' + ((r && r.privileges) || []).join(', ') + '。', 'ok');
      }
    });
  }

  function confirmDropUser(ctx, user, host) {
    dialog(ctx, {
      title: '删除用户', danger: true, okLabel: '永久删除',
      text: '将删除账号 ' + user + '@' + host + ' 及其全部授权。',
      warn: 'root 账号在插件侧一律拒绝；删除后该账号立即无法登录，请确认没有服务仍在使用它。',
      fields: [],
      typed: { expect: user, label: '要删除的用户名：' + user + '（请手动输入）' },
      onSubmit: function () { return ctx.invoke('db-mysql.dropUser', { user: user, host: host, confirm: true }); },
      onDone: function () {
        if (ctx.onUsersChanged) ctx.onUsersChanged();
        ctx.notice('用户「' + user + '@' + host + '」已删除。', 'ok');
      }
    });
  }

  // mountUsers 渲染「用户与授权」折叠区内容：列表来自只读 SQL（mysql.user 需该账号有 SELECT 权限）。
  function mountUsers(ctx, host) {
    host.textContent = '';
    var head = mk(host, 'div', 'db-l2-users-head');
    mk(head, 'p', 'db-l2-note', '账号列表来自 SELECT user, host FROM mysql.user（只读查询）。');
    var ops = mk(head, 'div', 'db-l2-ops');
    button(ops, 'btn-primary', '新建用户', function () { openCreateUser(ctx); });
    button(ops, 'btn-ghost', '刷新', function () { load(); });
    var tableHost = mk(host, 'div', 'db-l2-users-body');
    var count = mk(host, 'p', 'db-l2-note', '');
    var removed = false;

    function paint(users) {
      tableHost.textContent = '';
      count.textContent = users.length ? users.length + ' 个账号' : '';
      if (!users.length) { mk(tableHost, 'p', 'db-l2-note', '没有账号（或当前连接无 mysql.user 读权限）。'); return; }
      var table = mk(tableHost, 'table', 'db-l2-users-table');
      var htr = mk(mk(table, 'thead'), 'tr');
      ['用户', '主机', '操作'].forEach(function (h) { mk(htr, 'th', null, h); });
      var tbody = mk(table, 'tbody');
      users.forEach(function (u) {
        var name = String(u.user === undefined ? u.User : u.user);
        var h = String(u.host === undefined ? u.Host : u.host);
        var tr = mk(tbody, 'tr');
        mk(tr, 'td', 'db-l2-user', name);
        mk(tr, 'td', 'db-l2-host', h);
        var td = mk(tr, 'td', 'db-l2-row-ops');
        button(td, 'btn-ghost', '授权', function () { openGrant(ctx, name, h); });
        if (name === 'root') {
          var locked = mk(td, 'span', 'db-l2-locked', 'root 不可删除');
          locked.title = '插件对 root 账号（任意 host）的 dropUser 一律返回 E_UNAUTHORIZED';
        } else {
          button(td, 'btn-ghost', '删除', function () { confirmDropUser(ctx, name, h); });
        }
      });
    }
    function load() {
      tableHost.textContent = '';
      mk(tableHost, 'p', 'db-l2-note', '正在读取账号列表…');
      ctx.invoke('db-mysql.query', {
        instance: ctx.instance, sql: 'SELECT user, host FROM mysql.user ORDER BY user, host', limit: 1000
      }).then(function (data) {
        if (removed) return;
        paint((data && data.rows) || []);
      }, function (err) {
        if (removed) return;
        tableHost.textContent = '';
        var box = mk(tableHost, 'div', 'db-l2-error');
        mk(box, 'p', null, ctx.errText(err));
        mk(box, 'p', 'field-hint', '怎么办：' + hintFor(ctx, err));
        button(box, 'btn-ghost', '重试', function () { load(); });
      });
    }
    load();
    return {
      reload: load,
      destroy: function () { removed = true; }
    };
  }

  window.KoreDbL2 = {
    mountUsers: mountUsers, openCreateDb: openCreateDb, confirmDropDb: confirmDropDb,
    openExport: openExport, openImport: openImport, confirmDropUser: confirmDropUser
  };
})();
