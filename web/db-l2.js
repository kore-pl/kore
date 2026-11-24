/* kore 主壳 · 数据库页 L2 管理（web/db-l2.js）
   由 web/db.js 在首次写操作（建库/删库/建用户/授权/改密/导入导出）或展开「用户与授权」时注入，导出
   window.KoreDbL2。写方法要求插件 system:admin；删库/删用户在后端强制 confirm=true，本页一律再
   走一层「手输名称」确认，不存在单击即删路径。失败原样展示后端 code + message 并给「怎么办」。
   导入导出的 file_path 必须落在插件导出目录内（KORE_DB_EXPORT_DIR，缺省 <state>/exports），
   故默认值给相对文件名，由后端按该根目录解析。

   域切换（MySQL / PostgreSQL 共用本 UI）：方法名经 m(ctx, action) 按当前域拼完整限定名
   （db-mysql. / db-postgres.），与 db.js:methodFor 同范式——裸动词会被后端 E_NOTFOUND 拒绝。
   域判定读 localStorage 的 kore.db.type（与 db.js:loadTypePref 同一个 key，单一真源），
   因此本模块与页面头部的 MySQL/PostgreSQL 切换始终一致，无需改 db.js。每个写方法的入参按
   各自后端契约构造（PG 契约见 kore-plugin-db-postgres/internal/pgop/{admin,types,identifiers}.go）：
     PG createDatabase  {instance,name,owner}          MySQL  {name,charset}
     PG dropDatabase    {instance,name,confirm}        MySQL  {name,confirm}
     PG createUser      {instance,user,password,can_create_db,can_create_role}
                                                       MySQL  {user,host,password,grants}
     PG dropUser        {instance,user,confirm}        MySQL  {user,host,confirm}
     PG grant           {instance,user,database,privileges,with_grant_option}
                                                       MySQL  {user,host,database,privileges}
     PG changePassword  {instance,user,password}       MySQL  {instance,user,host,password,confirm?}
   改密口令只走输入框（type=password）、不回显、提交后立即清空、不进任何 notice/日志（G-30）。 */
(function () {
  'use strict';
  // MySQL 白名单（保持既有行为不变）
  var NAME_RE = /^[a-zA-Z0-9_]{1,64}$/, USER_RE = /^[a-zA-Z0-9_]{1,32}$/, HOST_RE = /^[A-Za-z0-9._:%-]+$/;
  var PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'EXECUTE'];
  var CHARSETS = [
    { value: 'utf8mb4', label: 'utf8mb4（推荐，完整 Unicode / emoji）' }, { value: 'utf8', label: 'utf8（每字符最多 3 字节）' },
    { value: 'latin1', label: 'latin1（西欧字符，兼容老库）' }
  ];
  // PostgreSQL 白名单（源码：identifiers.go roleNameRE=^[a-zA-Z0-9_]{1,63}$；
  // databaseGrantPrivileges=CONNECT/CREATE/TEMP(TEMPORARY)/ALL；保护库 postgres/template0/template1；
  // 保留角色 pg_ 前缀与 postgres）
  var PG_NAME_RE = /^[a-zA-Z0-9_]{1,63}$/, PG_USER_RE = /^[a-zA-Z0-9_]{1,63}$/;
  var PG_PRIVS = ['CONNECT', 'CREATE', 'TEMP', 'ALL'];
  var PG_SYSTEM_DBS = ['postgres', 'template0', 'template1'];

  // isPg：域判定的单一真源。优先用调用方显式传入的 ctx.isPg/dbType（便于将来 db.js 直接注入），
  // 否则读 localStorage 的 kore.db.type——这正是 db.js:loadTypePref 用来记住用户切换的 key。
  // 读不到一律 mysql（与 db.js 的默认一致），不猜、不静默切域。
  function isPg(ctx) {
    if (ctx && typeof ctx.isPg === 'boolean') return ctx.isPg;
    if (ctx && ctx.dbType) return ctx.dbType === 'postgres';
    try { return localStorage.getItem('kore.db.type') === 'postgres'; } catch (e) { return false; }
  }
  // m：按当前域拼完整方法名（复用 db.js:methodFor 范式，裸动词会被后端拒绝）。
  function m(ctx, action) { return (isPg(ctx) ? 'db-postgres.' : 'db-mysql.') + action; }
  function dbLabel(ctx) { return isPg(ctx) ? 'PostgreSQL' : 'MySQL'; }

  // L2 专属「怎么办」：先按错误码给可执行动作，未命中再回落到调用方的通用提示。
  // PG 的 E_INVALID 文案按 PG 契约（库/角色 63 位、权限 CONNECT/CREATE/TEMP/ALL、需 instance）。
  function hintFor(ctx, err) {
    var m2 = String((err && err.message) || err || '');
    if (/E_UNAUTHORIZED[\s\S]*(confirm|确认)/i.test(m2)) {
      return '危险操作需要显式确认（confirm=true）。本页已自动带上，若仍报错请刷新页面重试。';
    }
    if (/E_UNAUTHORIZED/.test(m2)) {
      return isPg(ctx)
        ? '当前账号没有该权限：系统库（postgres/template0/template1）与保留角色（pg_ 前缀 / postgres）在插件侧即被禁止；写操作还需数据库账号本身具备 CREATEDB / CREATEROLE 等权限。'
        : '当前账号没有该权限：系统库与 root 账号在插件侧即被禁止；建库/建用户/授权/改密/导入导出' +
          '还需插件声明 system:admin，且数据库账号本身具备 CREATE / CREATE USER / GRANT OPTION。';
    }
    if (/E_INVALID[\s\S]*(导出目录|export dir|KORE_DB_EXPORT_DIR)/i.test(m2)) {
      return '导出目录不可用：在内核启动环境里设置 KORE_DB_EXPORT_DIR（绝对路径），或把文件写成相对文件名。';
    }
    if (/E_INVALID[\s\S]*(confirm|确认)/i.test(m2)) {
      return '请求缺少 confirm=true：本页会自动带上；出现该提示说明请求被中间层改写。';
    }
    if (/文件不存在|no such file|ENOENT/i.test(m2)) {
      return '文件不存在：路径必须落在导出目录内（先「导出」生成一个文件），Linux 下区分大小写。';
    }
    if (/E_INVALID/.test(m2)) {
      return isPg(ctx)
        ? '参数不符合 PostgreSQL 后端白名单：库名/角色名 1–63 位字母数字下划线；权限只允许 CONNECT/CREATE/TEMP/ALL；所有写操作都带当前连接名（instance）。'
        : '参数不符合后端白名单：库名 1–64 位字母/数字/下划线；用户名 1–32 位；host 只允许字母数字' +
          ' . _ : % -；权限只允许 SELECT/INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/INDEX/EXECUTE。';
    }
    if (/E_NOTFOUND/.test(m2)) return '对象不存在：先刷新列表，确认名字完全一致；若刚切换过连接类型，请重新展开本区。';
    if (/E_CONFLICT/.test(m2)) {
      return '同名对象已存在：建库/建用户不会覆盖已存在对象（也不会改密码）；需要改密码请用「修改密码」。';
    }
    if (/E_UPSTREAM|E_INTERNAL/.test(m2)) {
      return '数据库或客户端执行失败：看 message 原文；连接/超时类可重试，权限与语法类需要 DBA 处理。';
    }
    return ctx.hint ? ctx.hint(m2) : '先刷新列表确认对象状态；仍失败请把 message 原文交给 DBA。';
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
  // f.type==='password' 时用 type=password 输入框且 autocomplete=new-password：口令不回显（G-30）。
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
        control.type = f.type === 'password' ? 'password' : 'text';
        control.autocomplete = f.type === 'password' ? 'new-password' : 'off';
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
      // 关闭即清空所有口令输入框：口令不残留在 DOM 里（G-30）。
      (opts.fields || []).forEach(function (f) {
        if (f.type === 'password' && inputs[f.key]) inputs[f.key].value = '';
      });
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
        // 成功提交后立即清空口令框（G-30：口令不回显、不残留）。
        (opts.fields || []).forEach(function (f) {
          if (f.type === 'password' && inputs[f.key]) inputs[f.key].value = '';
        });
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

  // ── 建库：PG 用 {instance,name,owner}；MySQL 用 {name,charset}。UI 共用同一张表单。 ──
  function openCreateDb(ctx) {
    var pg = isPg(ctx);
    var fields = [
      { key: 'name', label: '库名', placeholder: 'kore_app', mono: true,
        hint: pg ? '只允许字母、数字、下划线，1–63 位。' : '只允许字母、数字、下划线，1–64 位。',
        validate: pg
          ? function (v) { return PG_NAME_RE.test(v) ? '' : '库名只允许字母/数字/下划线，1–63 位'; }
          : function (v) { return NAME_RE.test(v) ? '' : '库名只允许字母/数字/下划线，1–64 位'; } }
    ];
    if (pg) {
      fields.push({ key: 'owner', label: '所有者（可选）', placeholder: '已有的角色名', mono: true, required: false,
        hint: '留空由数据库决定；填写必须是已存在的角色，只允许字母/数字/下划线，1–63 位。',
        validate: function (v) { return !v || PG_USER_RE.test(v) ? '' : '所有者只允许字母/数字/下划线，1–63 位'; } });
    } else {
      fields.push({ key: 'charset', label: '字符集', type: 'select', value: 'utf8mb4', options: CHARSETS,
        hint: '不确定就保持 utf8mb4：能存中文与 emoji，和多数现代应用一致。' });
    }
    dialog(ctx, {
      title: '新建数据库（' + dbLabel(ctx) + '）', fields: fields,
      okLabel: '创建',
      onSubmit: function (v) {
        var params = pg ? { instance: ctx.instance || '', name: v.name } : { name: v.name, charset: v.charset };
        if (pg && v.owner) params.owner = v.owner;
        return ctx.invoke(m(ctx, 'createDatabase'), params);
      },
      onDone: function (r) {
        ctx.loadDbs();
        ctx.notice('数据库「' + (r && r.name ? r.name : '') + '」' + (r && r.created === false ? '已存在（未改动）' : '创建成功') + '。', 'ok');
      }
    });
  }

  // ── 删库：两域都要求 confirm=true；再加 typed 手输名称门。PG 系统库 postgres/template0/template1 后端直接拒绝。 ──
  function confirmDropDb(ctx, name) {
    var pg = isPg(ctx);
    dialog(ctx, {
      title: '删除数据库（' + dbLabel(ctx) + '）', danger: true, okLabel: '永久删除',
      text: '将删除数据库 `' + name + '` 及其全部数据，操作不可恢复。',
      warn: pg
        ? '删除前请先备份；系统库 postgres / template0 / template1 会被数据库直接拒绝删除。'
        : '删除前请先「导出」备份；系统库（mysql / information_schema / performance_schema / sys）后端会直接拒绝。',
      fields: [],
      typed: { expect: name, label: '要删除的库名：' + name + '（请手动输入）' },
      onSubmit: function () {
        return ctx.invoke(m(ctx, 'dropDatabase'), pg
          ? { instance: ctx.instance || '', name: name, confirm: true }
          : { name: name, confirm: true });
      },
      onDone: function () { ctx.loadDbs(); ctx.notice('数据库「' + name + '」已删除。', 'ok'); }
    });
  }

  // ── 导出/导入是 db-mysql 专属能力（PG info.json 无 export/import 方法）；保持既有 MySQL 行为。 ──
  function openExport(ctx, name) {
    var def = name + '-' + stamp() + '.sql';
    dialog(ctx, {
      title: '导出数据库', text: '导出 `' + name + '` 的结构与数据到导出目录内的 .sql 文件。',
      fields: [{ key: 'path', label: '目标文件', value: def, mono: true,
        hint: '相对路径落在插件的导出目录（默认 <状态目录>/exports，可用 KORE_DB_EXPORT_DIR 改）；默认文件名已按库名+时间戳填好。',
        validate: function (v) { return v ? '' : '请填写目标文件路径'; } }],
      okLabel: '开始导出',
      onSubmit: function (v) { return ctx.invoke(m(ctx, 'export'), { database: name, file_path: v.path }); },
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
          options: dbOptions(ctx, false), hint: '只列出当前连接可见的库；没有目标库请先「新建数据库」。' },
        { key: 'path', label: 'SQL 文件', placeholder: 'kore_app-20260101-120000.sql', mono: true,
          hint: '必须是导出目录内的文件（与「导出」同一个根目录）。' }
      ],
      okLabel: '确认导入',
      onSubmit: function (v) { return ctx.invoke(m(ctx, 'import'), { database: v.database, file_path: v.path }); },
      onDone: function (r) {
        ctx.loadDbs();
        ctx.notice('已导入到「' + (r && r.database ? r.database : '') + '」' +
          (r && typeof r.size_bytes === 'number' ? '（' + Math.max(1, Math.round(r.size_bytes / 1024)) + ' KiB）' : '') + '。', 'ok');
      }
    });
  }

  // ── 建用户：PG {instance,user,password,can_create_db,can_create_role}；MySQL {user,host,password,grants}。 ──
  function openCreateUser(ctx) {
    var pg = isPg(ctx);
    var pw = password();
    var fields = [
      { key: 'user', label: '用户名', placeholder: 'kore_app', mono: true,
        hint: pg ? '字母、数字、下划线，1–63 位；pg_ 前缀与 postgres 是系统保留，不能用。'
                 : '字母、数字、下划线，1–32 位。',
        validate: pg
          ? function (v) { return PG_USER_RE.test(v) ? '' : '用户名只允许字母/数字/下划线，1–63 位'; }
          : function (v) { return USER_RE.test(v) ? '' : '用户名只允许字母/数字/下划线，1–32 位'; } }
    ];
    if (!pg) {
      fields.push({ key: 'host', label: '允许来源（host）', value: '%', mono: true,
        hint: '默认 % 表示任意来源；只允许本机就填 localhost。', validate: function (v) { return HOST_RE.test(v) ? '' : 'host 只允许字母数字 . _ : % -'; } });
    }
    fields.push({ key: 'password', label: '密码', type: 'password', value: pw, gen: true, mono: true, required: false,
      hint: pg
        ? '已自动生成 24 位随机密码，可「生成」换一个或「复制」；留空创建无口令账号（peer/证书认证场景合法）。密码不会回显或写入日志。'
        : '已自动生成 24 位随机密码，可「生成」换一个或「复制」；留空创建无密码账号（不安全，不建议）。密码不会回显或写入日志。' });
    if (pg) {
      fields.push({ key: 'flags', label: '角色选项（可选）', type: 'checkgroup', required: false,
        options: [{ value: 'can_create_db', label: '允许建库（CREATEDB）' }, { value: 'can_create_role', label: '允许建角色（CREATEROLE）' }],
        hint: '都不选就是普通账号；不接受超级用户权限。' });
    } else {
      fields.push({ key: 'database', label: '授权到库（可选）', type: 'select', value: '', options: dbOptions(ctx, true) });
      fields.push({ key: 'privileges', label: '权限（配合上面的库）', type: 'checkgroup', required: false,
        options: PRIVS.map(function (p) { return { value: p, label: p }; }),
        hint: '不选则只建账号。授权不可再转授（插件明确拒绝 GRANT OPTION / ALL）。' });
    }
    dialog(ctx, {
      title: '新建数据库用户（' + dbLabel(ctx) + '）', fields: fields,
      okLabel: '创建用户',
      validate: function (v) {
        if (!pg && v.database && !v.privileges.length) return '选了授权库就必须至少选 1 个权限，或把授权库改回「不授权」';
        return '';
      },
      onSubmit: function (v) {
        var params;
        if (pg) {
          params = { instance: ctx.instance || '', user: v.user };
          if (v.password) params.password = v.password;
          if (v.flags && v.flags.indexOf('can_create_db') >= 0) params.can_create_db = true;
          if (v.flags && v.flags.indexOf('can_create_role') >= 0) params.can_create_role = true;
        } else {
          params = { user: v.user, host: v.host };
          if (v.password) params.password = v.password;
          if (v.database && v.privileges.length) params.grants = [v.database + ':' + v.privileges.join(',')];
        }
        return ctx.invoke(m(ctx, 'createUser'), params);
      },
      onDone: function (r) {
        if (ctx.onUsersChanged) ctx.onUsersChanged();
        if (pg) {
          ctx.notice('用户「' + (r && r.user ? r.user : '') + '」' +
            (r && r.created === false ? '已存在（未改密码）' : '创建成功') + '。', 'ok');
        } else {
          ctx.notice('用户「' + (r && r.user ? r.user : '') + '@' + (r && r.host ? r.host : '') + '」' +
            (r && r.created === false ? '已存在（未改密码）' : '创建成功') + '。', 'ok');
        }
      }
    });
  }

  // ── 授权：PG {instance,user,database,privileges,with_grant_option}，权限白名单 CONNECT/CREATE/TEMP/ALL。 ──
  function openGrant(ctx, user, host) {
    var pg = isPg(ctx);
    var privs = pg ? PG_PRIVS : PRIVS;
    var fields = [
      { key: 'database', label: '库', type: 'select', value: ctx.selectedDb || '',
        options: dbOptions(ctx, false) },
      { key: 'privileges', label: '权限', type: 'checkgroup', options: privs.map(function (p) { return { value: p, label: p }; }),
        validate: function (v) { return v.length ? '' : '至少选 1 个权限'; } }
    ];
    // 转授选项只 PG 支持（MySQL 插件明确拒绝 GRANT OPTION），不能给 MySQL 显示无效字段。
    if (pg) {
      fields.push({ key: 'withGrantOption', label: '允许转授（可选）', type: 'checkgroup', required: false,
        options: [{ value: 'yes', label: '允许该角色把权限再授给别人' }],
        hint: '对应 WITH GRANT OPTION；普通场景不要勾选。' });
    }
    dialog(ctx, {
      title: '授权 ' + user + (pg ? '' : '@' + host),
      text: pg
        ? '给该角色追加库级权限（数据库只允许 CONNECT / CREATE / TEMP / ALL）。'
        : '给该账号追加库级权限（BACKEND 禁止 ALL 与 GRANT OPTION，仅允许下列 9 种）。',
      fields: fields,
      okLabel: '授权',
      onSubmit: function (v) {
        var params = pg
          ? { instance: ctx.instance || '', user: user, database: v.database, privileges: v.privileges,
              with_grant_option: !!(v.withGrantOption && v.withGrantOption.indexOf('yes') >= 0) }
          : { user: user, host: host, database: v.database, privileges: v.privileges };
        return ctx.invoke(m(ctx, 'grant'), params);
      },
      onDone: function (r) {
        if (ctx.onUsersChanged) ctx.onUsersChanged();
        ctx.notice('已授权 ' + user + (pg ? '' : '@' + host) + '：' + ((r && r.privileges) || []).join(', ') + '。', 'ok');
      }
    });
  }

  // ── 删用户：两域都要求 confirm=true；再加 typed 手输名称门。 ──
  function confirmDropUser(ctx, user, host) {
    var pg = isPg(ctx);
    dialog(ctx, {
      title: '删除用户（' + dbLabel(ctx) + '）', danger: true, okLabel: '永久删除',
      text: '将删除账号 ' + user + (pg ? '' : '@' + host) + ' 及其全部授权，操作不可恢复。',
      warn: pg
        ? '系统保留角色（pg_ 前缀 / postgres）会被数据库直接拒绝；删除后使用该角色的服务立即断连，请确认没有服务仍在使用它。'
        : 'root 账号在插件侧一律拒绝；删除后该账号立即无法登录，请确认没有服务仍在使用它。',
      fields: [],
      typed: { expect: user, label: '要删除的用户名：' + user + '（请手动输入）' },
      onSubmit: function () {
        return ctx.invoke(m(ctx, 'dropUser'), pg
          ? { instance: ctx.instance || '', user: user, confirm: true }
          : { user: user, host: host, confirm: true });
      },
      onDone: function () {
        if (ctx.onUsersChanged) ctx.onUsersChanged();
        ctx.notice('用户「' + user + (pg ? '' : '@' + host) + '」已删除。', 'ok');
      }
    });
  }

  // ── 改密（新增，PG 6 写方法之一）：PG {instance,user,password}；MySQL {instance,user,host,password,confirm?}。
  // 口令字段 type=password + 生成/复制，提交后 dialog 立即清空、成功提示不含口令（G-30）。 ──
  function openChangePassword(ctx, user, host) {
    var pg = isPg(ctx);
    var pw = password();
    var fields = [
      { key: 'user', label: '要改密的用户', value: user || '', mono: true,
        hint: '要修改密码的账号名；系统保留角色不允许改密。',
        validate: function (v) { return v ? '' : '请填写要改密的用户'; } },
      { key: 'password', label: '新密码', type: 'password', value: pw, gen: true, mono: true,
        hint: '已自动生成 24 位随机密码，可「生成」换一个或「复制」后保存。至少 8 位、不要与用户名相同；密码不回显、不进日志。',
        validate: function (v) {
          if (v.length < 8) return '新密码至少 8 位，请加长后重试';
          return '';
        } }
    ];
    if (!pg) {
      fields.splice(1, 0, { key: 'host', label: '来源（host）', value: host || 'localhost', mono: true,
        hint: '账号的 host，默认 localhost；root / 系统账号改密需二次确认。' });
    }
    dialog(ctx, {
      title: '修改密码（' + dbLabel(ctx) + '）',
      text: '修改账号 「' + (user || '') + '」 的登录密码。改完请立即更新使用该账号的应用配置。',
      warn: '这是高风险操作：新密码只显示一次，本页不保存也不回显。请先把新密码复制到安全的地方再提交。',
      fields: fields,
      okLabel: '确认改密',
      validate: function (v) {
        if (v.password && v.user && v.password.toLowerCase() === v.user.toLowerCase()) return '新密码不得与用户名相同，请换一个更强的密码';
        return '';
      },
      onSubmit: function (v) {
        var params = pg
          ? { instance: ctx.instance || '', user: v.user, password: v.password }
          : { instance: ctx.instance || '', user: v.user, host: v.host || 'localhost', password: v.password, confirm: true };
        return ctx.invoke(m(ctx, 'changePassword'), params);
      },
      onDone: function (r) {
        ctx.notice('用户「' + (r && r.user ? r.user : '') + '」的密码已修改。请更新使用该账号的应用配置。', 'ok');
      }
    });
  }

  // mountUsers 渲染「用户与授权」折叠区：列表来自只读查询（MySQL 查 mysql.user；PG 查 pg_roles）。
  function mountUsers(ctx, host) {
    var pg = isPg(ctx);
    host.textContent = '';
    var head = mk(host, 'div', 'db-l2-users-head');
    mk(head, 'p', 'db-l2-note', pg
      ? '角色列表来自只读查询 pg_roles（只列可登录的普通角色，排除系统保留角色）。'
      : '账号列表来自 SELECT user, host FROM mysql.user（只读查询）。');
    var ops = mk(head, 'div', 'db-l2-ops');
    button(ops, 'btn-primary', '新建用户', function () { openCreateUser(ctx); });
    button(ops, 'btn-ghost', '刷新', function () { load(); });
    var tableHost = mk(host, 'div', 'db-l2-users-body');
    var count = mk(host, 'p', 'db-l2-note', '');
    var removed = false;

    function paint(users) {
      tableHost.textContent = '';
      count.textContent = users.length ? users.length + ' 个账号' : '';
      if (!users.length) { mk(tableHost, 'p', 'db-l2-note', '没有账号（或当前连接无读取权限）。'); return; }
      var table = mk(tableHost, 'table', 'db-l2-users-table');
      var htr = mk(mk(table, 'thead'), 'tr');
      (pg ? ['用户', '操作'] : ['用户', '主机', '操作']).forEach(function (h) { mk(htr, 'th', null, h); });
      var tbody = mk(table, 'tbody');
      users.forEach(function (u) {
        var name = String(u.user !== undefined ? u.user
          : (u.User !== undefined ? u.User : (u.rolname !== undefined ? u.rolname : u.role_name)));
        var h = String(u.host === undefined ? (u.Host !== undefined ? u.Host : '') : u.host);
        var tr = mk(tbody, 'tr');
        mk(tr, 'td', 'db-l2-user', name);
        if (!pg) mk(tr, 'td', 'db-l2-host', h);
        var td = mk(tr, 'td', 'db-l2-row-ops');
        button(td, 'btn-ghost', '授权', function () { openGrant(ctx, name, h); });
        button(td, 'btn-ghost', '修改密码', function () { openChangePassword(ctx, name, h); });
        var locked = pg ? (/^(pg_|postgres$)/i.test(name)) : (name === 'root');
        if (locked) {
          var lockedMsg = mk(td, 'span', 'db-l2-locked', pg ? '系统保留角色不可删' : 'root 不可删除');
          lockedMsg.title = pg
            ? '插件对 pg_ 前缀与 postgres 角色的 dropUser 一律返回 E_UNAUTHORIZED'
            : '插件对 root 账号（任意 host）的 dropUser 一律返回 E_UNAUTHORIZED';
        } else {
          button(td, 'btn-ghost', '删除', function () { confirmDropUser(ctx, name, h); });
        }
      });
    }
    function load() {
      tableHost.textContent = '';
      mk(tableHost, 'p', 'db-l2-note', '正在读取账号列表…');
      var sql = pg
        // 用 role_name 而非 user 作别名：USER 在 PostgreSQL 是保留关键字（CURRENT_USER 别名），
        // 裸写 `AS user` 会被解析报错；role_name 无争议，paint 侧已兼容该别名。
        ? "SELECT rolname AS role_name FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'pg_%' AND rolname <> 'postgres' ORDER BY rolname"
        : 'SELECT user, host FROM mysql.user ORDER BY user, host';
      ctx.invoke(m(ctx, 'query'), {
        instance: ctx.instance, sql: sql, limit: 1000
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
    openExport: openExport, openImport: openImport, confirmDropUser: confirmDropUser,
    openChangePassword: openChangePassword
  };
})();
