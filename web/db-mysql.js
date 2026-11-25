/* kore 主壳 · MySQL 写入执行面板（web/db-mysql.js，db-mysql 插件懒加载视图）
   为什么单独一个文件：后端 db-mysql.exec（internal/mysqlop/exec.go）早已实现——写语句两级确认 +
   白名单 + 结构化结果，但 db.js 的 SQL 控制台只接 db-mysql.query（只读白名单），用户根本点不到 exec。
   本模块由 db.js 在 MySQL 页展开「SQL 写入」时按需注入（同 db-l2.js 模式），不改只读控制台。

   二级确认与后端 internal/mysqlop/writeguard.go 严格一致：
     · data（INSERT/UPDATE/DELETE/REPLACE）：勾选确认框后 confirm=true 即可；
     · ddl （DROP/TRUNCATE/ALTER/CREATE/RENAME/GRANT/...）：还须手打首两个关键字（如 "DROP TABLE"），
       confirm_text 由后端复核，不一致会被 E_INVALID 拒绝并把正确短语回显在错误里。
   读语句（SELECT/SHOW/...）请走只读控制台，本面板只收写语句；多语句 / 反斜杠命令 / 可执行注释
   一概由后端拒绝，前端不重写 SQL 解析，只把 code + message 原文与「怎么办」展示出来。

   易用性（USABILITY 原则 2）：预设优先——五个常用写语句一键填入（新增行 / 改值 / 删除 / 建表 / 删表），
   步骤 ≤3：选预设 → （DDL 时）打确认短语 → 点执行。小白能看到每一步的中文说明与危险提示。
   纪律：零框架 / 零 CDN / 零外链 / 零轮询；RPC 走 ctx.invoke（db.js 封装，自动补 CSRF 与完整方法名），
   本模块不自己读 cookie / 不拼 URL / 不打印口令（G-30）。 */
(function () {
  'use strict';

  // 常用写语句预设：只做示例模板，不预填真实库表；用户需替换库名/表名后再执行。
  var PRESETS = [
    { key: 'insert', label: '新增一行', sql: "INSERT INTO demo (name, created_at) VALUES ('示例', NOW())",
      hint: '向 demo 表插入一行；把 demo 换成你的表名。' },
    { key: 'update', label: '修改数据', sql: "UPDATE demo SET name = '新值' WHERE id = 1",
      hint: '务必带 WHERE 条件，否则会改掉整张表。' },
    { key: 'delete', label: '删除数据', sql: 'DELETE FROM demo WHERE id = 1',
      hint: '务必带 WHERE 条件，否则会删掉整张表。' },
    { key: 'create', label: '新建表', sql: 'CREATE TABLE demo (id INT PRIMARY KEY, name VARCHAR(64))',
      hint: '建表属于结构变更，需手打确认短语 CREATE TABLE。' },
    { key: 'drop', label: '删除表', sql: 'DROP TABLE demo',
      hint: '不可回滚：删表前请确认已备份，需手打确认短语 DROP TABLE。' }
  ];
  var DATA_KINDS = { INSERT: 1, UPDATE: 1, DELETE: 1, REPLACE: 1 };
  var DDL_KINDS = { DROP: 1, TRUNCATE: 1, ALTER: 1, CREATE: 1, RENAME: 1, GRANT: 1, REVOKE: 1,
    FLUSH: 1, SET: 1, ANALYZE: 1, OPTIMIZE: 1, REPAIR: 1, CALL: 1 };
  var READ_KINDS = { SELECT: 1, SHOW: 1, DESCRIBE: 1, DESC: 1, EXPLAIN: 1, WITH: 1 };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function button(parent, cls, label, fn) {
    var b = add(parent, el('button', 'btn ' + cls, label));
    b.type = 'button';
    if (fn) b.addEventListener('click', fn);
    return b;
  }

  // classify：镜像后端 firstKeyword + 白名单分级（writeguard.go:44-92）。这里只判定 UI 形态，
  // 真正的合法性仍由后端 ValidateWriteSQL 裁决；前端判不出的一律当 unknown 并让后端报错。
  function classify(sql) {
    var text = String(sql || '')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|\n)\s*(--[^\n]*|#[^\n]*)/g, ' ')
      .trim();
    var m = /^([a-zA-Z]+)/.exec(text);
    if (!m) return { kind: 'unknown', phrase: '' };
    var kw = m[1].toUpperCase();
    if (READ_KINDS[kw]) return { kind: 'read', phrase: kw };
    // confirmPhrase 只取前两个纯字母 token（writeguard.go:118-134）。
    var two = /^([a-zA-Z]+)\s+([a-zA-Z]+)/.exec(text);
    var phrase = two ? (two[1] + ' ' + two[2]).toUpperCase() : kw;
    if (DDL_KINDS[kw]) return { kind: 'ddl', phrase: phrase };
    if (DATA_KINDS[kw]) return { kind: 'data', phrase: kw };
    return { kind: 'unknown', phrase: '' };
  }

  function hintFor(err) {
    var msg = String((err && err.message) || err || '');
    if (/confirm_text|确认短语|不匹配/.test(msg)) return 'DDL 语句必须手打首两个关键字作为确认短语（大小写不敏感）；照错误里的正确短语填一次再执行。';
    if (/confirm=true|显式确认/.test(msg)) return '写语句需要先勾选「我已确认」；DDL 还要手打确认短语。';
    if (/db-mysql.query|读语句|只读/.test(msg)) return '这是读语句，请到上方只读 SQL 控制台执行；本面板只收 INSERT/UPDATE/DELETE/REPLACE 与结构变更语句。';
    if (/白名单|禁止|只允许单条|分号|64 KiB|反斜杠|可执行注释|NUL/.test(msg)) return '语句不符合后端安全白名单：只允单条写语句，禁止多语句/读文件/阻塞函数/可执行注释；按 message 原文改后再试。';
    if (/权限|denied|Access|E_UNAUTHORIZED/i.test(msg)) return '数据库账号缺少该写权限，或当前 Kore 用户没有 system:admin 能力；请联系 DBA / 管理员。';
    if (/E_NOTFOUND|实例|instance/.test(msg)) return '连接不存在：先刷新连接列表并选中一个可达的 MySQL 连接再执行。';
    if (/E_UPSTREAM|超时|refused|Can't connect|连接|timed out/i.test(msg)) return '数据库连不上或执行失败：确认连接地址/端口/账号后重试；注意写语句失败前可能已部分生效，先查数据再重放。';
    return '先看下方 message 原文；权限/语法类找 DBA，连接类可重试。危险操作执行前务必备份。';
  }

  // render(host, ctx) → { destroy }。ctx = { instance, instances, invoke, notice? }，
  // invoke(method, params) 由 db.js 提供（自动补 CSRF + 完整方法名 db-mysql.exec）。
  function render(host, ctx) {
    if (!host || !ctx || typeof ctx.invoke !== 'function') return { destroy: function () {} };
    var destroyed = false;
    var seq = 0;
    var S = { busy: false, result: null, error: '', phrase: '', sql: '' };
    var cssId = 'kore-db-exec-css';
    if (!document.getElementById(cssId)) {
      var css = el('style');
      css.id = cssId;
      css.textContent = '.db-exec-presets{display:flex;gap:var(--kore-space-1);flex-wrap:wrap;margin:0 0 var(--kore-space-2)}' +
        '.db-exec-presets .btn{min-height:32px;padding:0 var(--kore-space-2);font-size:var(--kore-font-12)}' +
        '.db-exec-warn{margin:0 0 var(--kore-space-2);padding:var(--kore-space-2) var(--kore-space-3);' +
        'color:var(--kore-danger);border:1px solid var(--kore-danger);border-radius:var(--kore-radius-control);' +
        'font-size:var(--kore-font-12);line-height:1.6}' +
        '.db-exec-form{display:flex;flex-direction:column;gap:var(--kore-space-2)}' +
        '.db-exec-form label{display:flex;align-items:center;gap:var(--kore-space-1);color:var(--kore-text-2);font-size:var(--kore-font-12)}' +
        '.db-exec-form textarea{display:block;width:100%;box-sizing:border-box;min-height:96px;resize:vertical;' +
        'padding:var(--kore-space-2) var(--kore-space-3);border:1px solid var(--kore-border-1);' +
        'border-radius:var(--kore-radius-control);background:var(--kore-bg-0);color:var(--kore-text-1);' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--kore-font-13);line-height:1.5}' +
        '.db-exec-confirm{display:flex;align-items:center;gap:var(--kore-space-2);flex-wrap:wrap}' +
        '.db-exec-confirm input.field-input{max-width:20ch;font-family:ui-monospace,Menlo,monospace}' +
        '.db-exec-msg{margin:var(--kore-space-2) 0;padding:var(--kore-space-2) var(--kore-space-3);' +
        'border-radius:var(--kore-radius-control);font-size:var(--kore-font-12);line-height:1.6;word-break:break-word}' +
        '.db-exec-msg.err{color:var(--kore-danger);border:1px solid var(--kore-danger)}' +
        '.db-exec-msg.ok{color:var(--kore-success);border:1px solid var(--kore-success)}' +
        '.db-exec-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-12)}' +
        '.db-exec-table th,.db-exec-table td{padding:var(--kore-space-1) var(--kore-space-2);' +
        'border-top:1px solid var(--kore-border-1);text-align:left;word-break:break-word}' +
        '@media (max-width:640px){.db-exec-form textarea{min-height:120px}.db-exec-confirm .btn{min-height:44px}}';
      document.head.appendChild(css);
    }

    var root = add(host, el('div', 'db-exec'));
    var form = add(root, el('div', 'db-exec-form'));
    // 连接选择：默认跟随 db.js 当前选中实例，可在本面板内单独改，不影响只读控制台。
    var connRow = add(form, el('label', null, '数据库连接'));
    var instSel = add(connRow, el('select', null));
    instSel.setAttribute('aria-label', '写入执行的目标数据库连接');
    var instances = Array.isArray(ctx.instances) ? ctx.instances : [];
    var chosen = ctx.instance || (instances[0] && instances[0].name) || '';
    instances.forEach(function (inst) {
      var opt = add(instSel, el('option', null, inst.name + (inst.reachable ? '' : '（不可达）')));
      opt.value = inst.name;
      if (inst.name === chosen) opt.selected = true;
    });
    if (!instances.length && chosen) add(instSel, el('option', null, chosen)).value = chosen;

    add(form, el('p', 'db-exec-warn',
      '写语句不可回滚：执行前请确认已备份。INSERT/UPDATE/DELETE/REPLACE 勾选确认即可；' +
      'DROP/ALTER/CREATE 等结构变更还须手打确认短语（如 DROP TABLE）。读语句请用上方只读控制台。'));

    var presetBar = add(form, el('div', 'db-exec-presets'));
    add(presetBar, el('span', 'field-label', '常用示例：'));
    PRESETS.forEach(function (p) {
      var b = button(presetBar, 'btn-ghost', p.label, function () {
        sqlBox.value = p.sql;
        S.sql = p.sql;
        applyClassification();
        sqlBox.focus();
      });
      b.title = p.hint;
    });

    var sqlLabel = add(form, el('label', null, 'SQL（单条写语句）'));
    var sqlBox = add(sqlLabel, el('textarea', null));
    sqlBox.rows = 5;
    sqlBox.spellcheck = false;
    sqlBox.placeholder = "INSERT INTO demo (name) VALUES ('示例')";
    sqlBox.setAttribute('aria-label', '写入 SQL 输入（单条写语句）');
    sqlBox.addEventListener('input', function () {
      S.sql = sqlBox.value;
      applyClassification();
    });

    var confirmRow = add(form, el('label', 'db-exec-confirm'));
    var confirmBox = add(confirmRow, el('input', null));
    confirmBox.type = 'checkbox';
    add(confirmRow, el('span', null, '我已确认：知道这条语句会改数据且不可回滚'));

    var phraseWrap = add(form, el('div', 'db-exec-confirm'));
    phraseWrap.hidden = true;
    var phraseLabel = add(phraseWrap, el('label', null, '确认短语（结构变更必填）'));
    var phraseBox = add(phraseLabel, el('input', 'field-input'));
    phraseBox.type = 'text';
    phraseBox.autocomplete = 'off';
    phraseBox.placeholder = '例如 DROP TABLE';
    phraseBox.setAttribute('aria-label', '结构变更确认短语');
    phraseBox.addEventListener('input', function () { S.phrase = phraseBox.value; });

    var kindNote = add(form, el('p', 'field-hint', '填入写语句后自动判断是普通写入还是结构变更。'));
    var ops = add(form, el('div', 'db-sql-ops'));
    var runBtn = button(ops, 'btn-danger', '执行写入', run);
    var runState = add(ops, el('span', 'muted', ''));

    var msgHost = add(root, el('div', 'db-exec-msg-host'));
    var resultHost = add(root, el('div', 'db-result'));

    function applyClassification() {
      var c = classify(S.sql);
      if (c.kind === 'read') {
        kindNote.textContent = '检测到读语句（' + c.phrase + '）：请到上方只读 SQL 控制台执行，本面板不接读语句。';
        phraseWrap.hidden = true;
        return;
      }
      if (c.kind === 'ddl') {
        kindNote.textContent = '检测到结构变更（' + c.phrase + '）：勾选确认框并手打「' + c.phrase + '」后才能执行。';
        if (!S.phrase) { phraseBox.value = c.phrase; S.phrase = c.phrase; }
        phraseWrap.hidden = false;
        return;
      }
      if (c.kind === 'data') {
        kindNote.textContent = '检测到普通写入（' + c.phrase + '）：勾选确认框即可执行；务必带上 WHERE 条件。';
      } else {
        kindNote.textContent = '填入 INSERT / UPDATE / DELETE / REPLACE 或结构变更语句，本面板会自动判断确认级别。';
      }
      phraseWrap.hidden = true;
    }

    function paintMsg() {
      msgHost.textContent = '';
      if (S.error) {
        var errBox = add(msgHost, el('p', 'db-exec-msg err', S.error + ' 怎么办：' + hintFor(S.error)));
        errBox.setAttribute('role', 'alert');
      } else if (S.result) {
        var r = S.result;
        add(msgHost, el('p', 'db-exec-msg ok',
          '执行完成：' + (r.kind === 'ddl' ? '结构变更' : '数据写入') + ' · 目标 ' + (r.instance || chosen) +
          ' · 影响行数 ' + (typeof r.row_count === 'number' ? r.row_count : '—')));
      }
    }

    function paintResult() {
      resultHost.textContent = '';
      var r = S.result;
      if (!r) {
        add(resultHost, el('div', 'db-result-empty muted', '执行结果（列与返回行）在此查看；写语句通常不返回结果集。'));
        return;
      }
      var cols = Array.isArray(r.columns) ? r.columns : [];
      var rows = Array.isArray(r.rows) ? r.rows : [];
      if (!cols.length) return;
      var scroll = add(resultHost, el('div', 'db-result-scroll'));
      var table = add(scroll, el('table', 'db-exec-table'));
      var htr = add(add(table, el('thead')), el('tr'));
      cols.forEach(function (c) { add(htr, el('th', null, c)); });
      var tbody = add(table, el('tbody'));
      rows.forEach(function (row) {
        var tr = add(tbody, el('tr'));
        cols.forEach(function (c) {
          var v = row && typeof row === 'object' ? row[c] : null;
          var td = add(tr, el('td'));
          td.textContent = v === null || v === undefined ? 'NULL' : String(v);
        });
      });
    }

    function paint() {
      if (destroyed) return;
      runBtn.disabled = S.busy || !chosen;
      instSel.disabled = S.busy || !chosen;
      sqlBox.disabled = S.busy;
      phraseBox.disabled = S.busy;
      confirmBox.disabled = S.busy;
      runState.textContent = S.busy ? '执行中…' : '';
      paintMsg();
      paintResult();
    }

    function run() {
      if (destroyed || S.busy) return;
      var sql = String(sqlBox.value || '').trim();
      if (!sql) { S.error = '请输入 SQL 后再执行'; S.result = null; paint(); return; }
      var c = classify(sql);
      if (c.kind === 'read') {
        S.error = '这是读语句（' + c.phrase + '）：请到上方只读 SQL 控制台执行';
        S.result = null; paint(); return;
      }
      if (!confirmBox.checked) {
        S.error = '请先勾选「我已确认」；这是写操作，不可回滚';
        S.result = null; paint(); return;
      }
      if (c.kind === 'ddl' && String(phraseBox.value || '').trim().toUpperCase() !== c.phrase) {
        S.error = '结构变更必须手打确认短语「' + c.phrase + '」（大小写不敏感）';
        S.result = null; paint(); return;
      }
      var instance = instSel.value || chosen;
      var params = {
        instance: instance,
        sql: sql,
        confirm: true,
        confirm_text: c.kind === 'ddl' ? String(phraseBox.value || '').trim() : ''
      };
      var mySeq = ++seq;
      S.busy = true; S.error = ''; S.result = null; paint();
      ctx.invoke('db-mysql.exec', params).then(function (data) {
        if (destroyed || mySeq !== seq) return;
        S.busy = false; S.result = data || {}; paint();
        if (ctx.notice) ctx.notice('写入已执行：' + (data && data.kind === 'ddl' ? '结构变更' : '数据写入') + '，影响行数 ' +
          ((data && data.row_count) || 0), 'ok');
      }, function (err) {
        if (destroyed || mySeq !== seq) return;
        S.busy = false;
        S.error = String((err && err.message) || err || '执行失败');
        paint();
      });
    }

    applyClassification();
    paint();
    return { destroy: function () { destroyed = true; } };
  }

  window.KoreDbMysqlExec = { render: render, classify: classify, hintFor: hintFor, presets: PRESETS };
})();