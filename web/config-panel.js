/* kore 主壳 · 插件统一配置面板（web/config-panel.js）——零框架 / 零 CDN / 无外链。
   POST /api/v1/invoke/<id>/<id>.config.get|set（docs/PLUGIN-CONFIG.md）。
   window.KoreConfig.open(container, pluginId, opts)：按 schema.fields 渲染
   string/int/bool/select/list；每字段 label + 一行 help + 默认值提示（与默认不同会标出来）；
   sensitive 用 password 不回显；schema 标了 advanced 的字段折叠进「高级设置」可展开；
   字段 ≥6 个时给搜索框按标签 / 帮助过滤；关闭前有未保存改动会拦一次；
   保存成功提示「已保存，立即生效」并回报本次改了几项；restart_required 时提示「需重启 kored 生效」；
   「恢复默认值」只回填表单；opts.onSaved 在热生效后回调刷新数据。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/', TIMEOUT_MS = 15000, STYLE_ID = 'kore-cfg-style';
  var STYLE = [
    '.view-head-split{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.view-head-main{min-width:0}.cfg-gear{flex:0 0 auto;min-height:var(--kore-touch)}',
    '.cfg-panel{margin-bottom:var(--kore-space-4);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container);background:var(--kore-bg-1)}.cfg-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--kore-border-2)}',
    '.cfg-title{font-size:var(--kore-font-14);font-weight:600}.cfg-meta{margin-left:auto;color:var(--kore-text-3);font-size:var(--kore-font-12)}.cfg-close{min-width:var(--kore-touch);min-height:var(--kore-touch)}',
    '.cfg-body{display:flex;flex-direction:column;gap:12px;padding:12px 14px}.cfg-field{display:flex;flex-direction:column;gap:4px}.cfg-label{color:var(--kore-text-1);font-size:var(--kore-font-13);font-weight:500}.cfg-req{margin-left:2px;color:var(--kore-danger)}',
    '.cfg-input{width:100%;box-sizing:border-box;min-height:var(--kore-touch);padding:8px 10px;color:var(--kore-text-1);background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);font:inherit}.cfg-input:focus{outline:2px solid var(--kore-info);outline-offset:1px}',
    '.cfg-check{width:20px;height:20px;accent-color:var(--kore-info)}.cfg-help{margin:0;color:var(--kore-text-3);font-size:var(--kore-font-12)}',
    '.cfg-list{display:flex;flex-direction:column;gap:8px}.cfg-list-row{display:flex;align-items:center;gap:8px}.cfg-list-row .cfg-input{flex:1 1 auto}.cfg-remove,.cfg-add{min-height:var(--kore-touch)}.cfg-actions{display:flex;flex-wrap:wrap;gap:8px;padding:0 14px 12px}.cfg-status{min-height:20px;padding:0 14px 12px;font-size:var(--kore-font-12)}.cfg-status-ok{color:var(--kore-success)}.cfg-status-err{color:var(--kore-danger)}.cfg-status-warn{color:var(--kore-warning)}',
    '.cfg-auto{display:inline-flex;align-items:center;margin-left:6px;padding:0 7px;color:var(--kore-success);background:rgba(63,185,80,.12);border:1px solid var(--kore-success);border-radius:999px;font-size:11px;font-weight:500;vertical-align:1px}',
    '.cfg-note{margin:0 0 2px;padding:8px 10px;color:var(--kore-text-2);background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);font-size:var(--kore-font-12)}',
    '.cfg-auto-hint{color:var(--kore-success)}',
    // 默认值提示：默认值本身 + 当前是否仍是默认（与默认不同就标「已改」），避免用户以为空白就是没设过。
    '.cfg-default{margin:0;color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.6}',
    '.cfg-default-changed{color:var(--kore-warning)}',
    // 搜索：字段多时才出现；输入即过滤，命中数在右侧，回车不提交任何东西。
    '.cfg-search{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 2px}',
    '.cfg-search .cfg-input{flex:1 1 220px;min-width:0}',
    '.cfg-search-count{color:var(--kore-text-3);font-size:var(--kore-font-12)}',
    '.cfg-search-empty{margin:0;padding:10px 12px;color:var(--kore-text-2);background:var(--kore-bg-2);border:1px dashed var(--kore-border-2);border-radius:var(--kore-radius-control);font-size:var(--kore-font-12)}',
    // 高级项：默认折叠、点开即见；折叠标题给条数与用途，不像「更多」那样含糊。
    '.cfg-adv{border-top:1px dashed var(--kore-border-2);margin-top:2px}',
    '.cfg-adv summary{display:flex;align-items:center;min-height:var(--kore-touch);padding:10px 0;color:var(--kore-text-2);font-size:var(--kore-font-12);cursor:pointer}',
    '.cfg-adv summary:hover{color:var(--kore-text-1)}',
    '.cfg-adv .cfg-field{padding-top:8px}',
    // 未保存改动的确认：页面内浮层，不用 window.confirm（阻断原生弹窗、样式也不统一）。
    '.cfg-confirm{position:fixed;inset:0;z-index:910;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--kore-overlay)}',
    '.cfg-confirm-box{width:100%;max-width:420px;padding:16px;background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container);box-shadow:var(--kore-shadow)}',
    '.cfg-confirm-title{margin:0 0 8px;color:var(--kore-text-1);font-size:var(--kore-font-15);font-weight:600}',
    '.cfg-confirm-text{margin:0 0 12px;color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.6}',
    '.cfg-confirm-ops{display:flex;justify-content:flex-end;gap:8px}',
    '.cfg-toast{position:fixed;top:12px;left:50%;z-index:900;transform:translateX(-50%);max-width:min(92vw,560px);padding:10px 16px;color:var(--kore-text-1);background:var(--kore-bg-2);border:1px solid var(--kore-success);border-radius:var(--kore-radius-control);box-shadow:var(--kore-shadow);font-size:var(--kore-font-13)}',
    // 空态 / 失败态：白话标题 + 怎么办 + 下一步按钮；技术错误码只进折叠区（USABILITY §4）。
    '.cfg-state{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:18px 14px;text-align:left}',
    '.cfg-state-title{margin:0;color:var(--kore-text-1);font-size:var(--kore-font-14);font-weight:600;line-height:1.5}',
    '.cfg-state-detail{margin:0;color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.7;overflow-wrap:anywhere;white-space:normal}',
    '.cfg-state-code{max-width:100%;color:var(--kore-text-3);font-size:var(--kore-font-12)}.cfg-state-code pre{margin:6px 0 0;padding:8px;color:var(--kore-text-3);background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-radius:var(--kore-radius-control);overflow-wrap:anywhere;white-space:pre-wrap}',
    '.cfg-state-actions{display:flex;flex-wrap:wrap;gap:8px;width:100%}.cfg-state-btn{min-height:var(--kore-touch);padding:8px 14px;white-space:normal;text-align:center}',
    '@media(max-width:520px){.cfg-state{padding:14px 12px}.cfg-state-detail{line-height:1.8}.cfg-state-btn{flex:1 1 100%;min-height:var(--kore-touch)}.cfg-confirm-ops .btn{flex:1 1 auto;min-height:var(--kore-touch)}.cfg-search .cfg-input{flex:1 1 100%}}'
  ].join('');
  function el(tag, cls, text) {
    var node = document.createElement(tag); if (cls) node.className = cls;
    if (text != null) node.textContent = String(text); return node;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = el('style'); style.id = STYLE_ID; style.textContent = STYLE; document.head.appendChild(style);
  }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function invoke(pluginId, verb, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + pluginId + '/' + pluginId + '.config.' + verb, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { message: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || '';
          err.httpStatus = res.status;
          throw err;
        }
        return data;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }
  function toast(text) {
    var node = el('div', 'cfg-toast', text); node.setAttribute('role', 'status'); document.body.appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 8000);
  }
  // 默认值 / 当前值的可读写法：布尔说「开启 / 关闭」，列表用顿号连，空值明确写「（空）」。
  function fmtValue(value) {
    if (value === null || value === undefined) return '—';
    if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
    if (value === true) return '开启';
    if (value === false) return '关闭';
    return String(value);
  }
  function sameValue(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    if (typeof a === 'number' && typeof b === 'number' && !isFinite(a) && !isFinite(b)) return true;
    return a === b;
  }
  function textInput(field, value, type) {
    var input = el('input', 'cfg-input');
    input.type = type;
    if (field.placeholder) input.placeholder = field.placeholder;
    if (type === 'number') {
      if (field.min != null) input.min = String(field.min);
      if (field.max != null) input.max = String(field.max);
    }
    if (value != null) input.value = String(value);
    input.autocomplete = 'off'; input.spellcheck = false; return input;
  }
  function listControl(field, value) {
    var wrap = el('div', 'cfg-list'), rows = add(wrap, el('div', 'cfg-list'));
    function addRow(item) {
      var row = el('div', 'cfg-list-row'), input = textInput(field, item, 'text');
      var remove = el('button', 'btn btn-ghost cfg-remove', '删除'); remove.type = 'button';
      remove.setAttribute('aria-label', '删除' + (field.label || '条目'));
      remove.addEventListener('click', function () { row.remove(); });
      add(row, input); add(row, remove); add(rows, row); return input;
    }
    function fill(items) {
      rows.textContent = '';
      if (!items || !items.length) { addRow(''); return; }
      for (var i = 0; i < items.length; i++) addRow(items[i]);
    }
    fill(value);
    var addBtn = el('button', 'btn btn-ghost cfg-add', '＋ 添加一项');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () { addRow('').focus(); });
    add(wrap, addBtn);
    return {
      node: wrap,
      read: function () {
        var out = [], inputs = rows.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) {
          var text = inputs[i].value.trim();
          if (text) out.push(text);
        }
        return out;
      },
      reset: fill
    };
  }
  function fieldControl(field, value) {
    if (field.type === 'bool') {
      var box = el('input', 'cfg-check');
      box.type = 'checkbox'; box.checked = value === true;
      return { node: box, read: function () { return box.checked; },
        reset: function (def) { box.checked = def === true; } };
    }
    if (field.type === 'select') {
      var select = el('select', 'cfg-input'), options = field.options || [];
      for (var i = 0; i < options.length; i++) { var opt = el('option', null, options[i]); opt.value = String(options[i]); select.appendChild(opt); }
      if (value !== undefined && value !== null) select.value = String(value);
      return { node: select, read: function () { return select.value; },
        reset: function (def) { if (def !== undefined && def !== null) select.value = String(def); } };
    }
    if (field.type === 'list') return listControl(field, value);
    if (field.sensitive) {
      var masked = value === '***';
      var secret = textInput(field, masked ? '' : value, 'password');
      if (masked) secret.placeholder = '已保存（不回显）；留空表示不修改';
      return {
        node: secret,
        read: function () {
          var text = secret.value.trim();
          return !text && masked ? '***' : secret.value;
        },
        reset: function () { masked = false; secret.value = ''; secret.placeholder = field.placeholder || ''; }
      };
    }
    var inp = textInput(field, value, field.type === 'int' ? 'number' : 'text');
    return {
      node: inp,
      read: function () {
        if (field.type !== 'int') return inp.value;
        var n = Number(inp.value);
        return inp.value.trim() === '' || !isFinite(n) ? NaN : Math.trunc(n);
      },
      reset: function (def) { inp.value = def === undefined || def === null ? '' : String(def); }
    };
  }
  function renderField(field, value, autoKeys) {
    var box = el('div', 'cfg-field');
    box.setAttribute('data-kw', [field.label || field.key, field.help].join(' ').toLowerCase());
    var label = el('label', 'cfg-label', field.label || field.key);
    if (field.required) add(label, el('span', 'cfg-req', '*'));
    if (autoKeys && autoKeys[field.key]) add(label, el('span', 'cfg-auto', '已自动填入'));
    add(box, label);
    var control = fieldControl(field, value);
    add(box, control.node);
    if (field.help) add(box, el('p', 'cfg-help', field.help));
    // 默认值提示：契约要求每个字段都有 default，这里据实展示，并在用户改动后用颜色标「已改」。
    var defLine = null;
    if (field['default'] !== undefined) {
      defLine = el('p', 'cfg-default');
      var describe = function () {
        var defText = field.sensitive ? '已保存（不回显）' : fmtValue(field['default']);
        var changed = !field.sensitive && !sameValue(control.read(), field['default']);
        defLine.textContent = '默认：' + defText + (changed ? '（当前已改，保存后生效）' : '（当前使用默认值）');
        defLine.className = 'cfg-default' + (changed ? ' cfg-default-changed' : '');
      };
      describe();
      add(box, defLine);
      box.addEventListener('input', describe);
      box.addEventListener('change', describe);
    }
    return { field: field, box: box, control: control, describeDefault: defLine ? describe : null };
  }
  function collect(entries) {
    var values = {};
    for (var i = 0; i < entries.length; i++) {
      var field = entries[i].field, value = entries[i].control.read(), name = field.label || field.key;
      if (field.required) {
        var empty = value === '' || value == null || (Array.isArray(value) && value.length === 0);
        if (empty) return { error: '请填写「' + name + '」' };
      }
      if (field.type === 'int') {
        if (typeof value === 'number' && !isFinite(value)) return { error: '「' + name + '」需要填写整数' };
        if (field.min != null && value < field.min) return { error: '「' + name + '」不能小于 ' + field.min };
        if (field.max != null && value > field.max) return { error: '「' + name + '」不能大于 ' + field.max };
      }
      values[field.key] = value;
    }
    return { values: values };
  }
  // 契约缺失 → 友好空态；其它错误 → 人话失败态。两者都给「怎么办」+ 下一步按钮，
  // 不裸露错误码（错误码仅进折叠 details），符合 USABILITY §4 原则④。
  function isNoContract(err) {
    if (!err) return false;
    if (err.code === 'E_NOTFOUND') return true;
    var m = String(err.message || '');
    return /未知方法|unknown method|not implemented|方法不存在|暂无此能力/i.test(m);
  }
  function renderState(body, actions, cfg) {
    body.textContent = '';
    actions.textContent = '';
    var box = add(body, el('div', 'cfg-state'));
    var icon = el('div', 'cfg-state-icon', cfg.icon || 'ⓘ');
    icon.setAttribute('aria-hidden', 'true');
    add(box, icon);
    add(box, el('p', 'cfg-state-title', cfg.title));
    add(box, el('p', 'cfg-state-detail', cfg.detail));
    if (cfg.hint) add(box, el('p', 'cfg-state-detail', cfg.hint));
    if (cfg.code) {
      var det = el('details', 'cfg-state-code');
      add(det, el('summary', null, '技术信息（点开查看）'));
      add(det, el('pre', null, cfg.code));
      add(box, det);
    }
    var row = add(box, el('div', 'cfg-state-actions'));
    var buttons = cfg.buttons || [];
    for (var i = 0; i < buttons.length; i++) {
      (function (spec) {
        var btn = el('button', 'btn ' + (spec.primary ? 'btn-primary' : 'btn-ghost') + ' cfg-state-btn', spec.label);
        btn.type = 'button';
        btn.addEventListener('click', spec.onClick);
        add(row, btn);
      })(buttons[i]);
    }
    return box;
  }
  function open(host, pluginId, opts) {
    if (!host || !pluginId) return null;
    opts = opts || {};
    var existing = host.querySelector('.cfg-panel');
    if (existing && existing.getAttribute('data-plugin') === pluginId) {
      while (host.querySelector('.cfg-panel')) host.querySelector('.cfg-panel').remove(); return null;
    }
    ensureStyle();
    while (host.querySelector('.cfg-panel')) host.querySelector('.cfg-panel').remove();
    var panel = el('section', 'cfg-panel');
    panel.setAttribute('data-plugin', pluginId); panel.setAttribute('aria-label', (opts.title || '插件') + '设置');
    var head = add(panel, el('div', 'cfg-head'));
    add(head, el('span', 'cfg-title', opts.title || '设置'));
    add(head, el('span', 'cfg-meta', '保存后立即生效，无需重启'));
    var closeBtn = el('button', 'btn btn-ghost cfg-close', '×');
    closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', '关闭设置');
    add(head, closeBtn);
    var body = add(panel, el('div', 'cfg-body'));
    add(body, el('p', 'cfg-help', '正在读取配置…'));
    var actions = add(panel, el('div', 'cfg-actions'));
    var status = add(panel, el('div', 'cfg-status'));
    status.setAttribute('role', 'status');
    host.insertBefore(panel, host.children[1] || null);

    var saved = false;
    var dirtyProbe = null; // 有未保存改动时返回 true；schema 还没下来时为 null
    var confirming = false;

    function discardOverlay() {
      if (confirming) return;
      confirming = true;
      var wrap = el('div', 'cfg-confirm');
      wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', '有未保存的修改');
      var box = add(wrap, el('div', 'cfg-confirm-box'));
      add(box, el('h3', 'cfg-confirm-title', '这些修改还没保存'));
      add(box, el('p', 'cfg-confirm-text', '关闭后本次改动会丢失；想保留请先点「保存」。'));
      var ops = add(box, el('div', 'cfg-confirm-ops'));
      var keep = el('button', 'btn btn-ghost', '继续编辑');
      keep.type = 'button';
      var leave = el('button', 'btn', '放弃修改并关闭');
      leave.type = 'button';
      add(ops, keep); add(ops, leave);
      function finish(go) {
        if (!confirming) return;
        confirming = false;
        document.removeEventListener('keydown', onKey);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (go) { saved = true; close(); } else closeBtn.focus();
      }
      function onKey(ev) { if (ev.key === 'Escape') finish(false); }
      keep.addEventListener('click', function () { finish(false); });
      leave.addEventListener('click', function () { finish(true); });
      wrap.addEventListener('click', function (ev) { if (ev.target === wrap) finish(false); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
      keep.focus();
    }
    function close() {
      document.removeEventListener('keydown', onKey);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }
    function onKey(ev) { if (ev.key === 'Escape') requestClose(); }
    function requestClose() {
      if (confirming) return; // Esc 正被浮层处理，不要再叠一层
      if (saved || !dirtyProbe) { close(); return; }
      if (dirtyProbe()) { discardOverlay(); return; }
      close();
    }
    closeBtn.addEventListener('click', requestClose);
    document.addEventListener('keydown', onKey);
    var prefill = opts.prefill || {}, autoKeys = opts.autoKeys || {}, focusEntry = null;
    invoke(pluginId, 'get', {}).then(function (data) {
      var schema = data.schema || {}, values = data.values || {}, fields = schema.fields || [], entries = [];
      if (!fields.length) {
        // 没有可配置项：给小白下一步按钮，不铺空白表单/保存按钮（USABILITY §4）。
        renderState(body, actions, {
          icon: '◇',
          title: '该插件暂无可配置项',
          detail: '这是新版配置能力，插件作者尚未接入设置项；如需调整，可到软件商店查看该插件是否有新版本。',
          hint: '您可以先关闭本窗口继续使用插件，或前往软件商店查看更新。',
          buttons: [
            { label: '关闭', primary: true, onClick: close },
            { label: '去商店看看', onClick: function () {
              if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('store');
              else window.location.hash = '#/store';
              close();
            } }
          ]
        });
        return;
      }
      body.textContent = '';
      if (opts.autoNote) add(body, el('p', 'cfg-note', opts.autoNote));

      // 字段多时才给搜索：少字段塞搜索框是噪音（USABILITY 原则③ 少即是多）。
      var searchInput = null, searchCount = null, emptyNote = null, normalWrap = null, advFields = [];
      if (fields.length >= 6) {
        var bar = add(body, el('div', 'cfg-search'));
        searchInput = el('input', 'cfg-input');
        searchInput.type = 'search';
        searchInput.placeholder = '搜索设置项（例：端口 / 路径 / 超时）';
        searchInput.autocomplete = 'off';
        searchInput.setAttribute('aria-label', '搜索设置项');
        add(bar, searchInput);
        searchCount = add(bar, el('span', 'cfg-search-count'));
        emptyNote = add(body, el('p', 'cfg-search-empty', '没有匹配的设置项；换个关键词试试，或清空搜索看全部。'));
        emptyNote.style.display = 'none';
      }
      normalWrap = add(body, el('div', 'cfg-body-inner'));
      normalWrap.style.display = 'contents';
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i], current = values[field.key];
        if (current === undefined) current = field['default'];
        if (Object.prototype.hasOwnProperty.call(prefill, field.key)) current = prefill[field.key];
        var entry = renderField(field, current, autoKeys);
        entries.push(entry);
        if (field.advanced === true) advFields.push(entry);
        else add(normalWrap, entry.box);
        if (opts.focusKey && field.key === opts.focusKey) focusEntry = entry;
      }
      var advBox = null, advSummary = null;
      if (advFields.length) {
        var det = el('details', 'cfg-adv');
        advBox = det;
        advSummary = add(det, el('summary', null, '高级设置（' + advFields.length + ' 项，点开查看）'));
        for (var k = 0; k < advFields.length; k++) add(det, advFields[k].box);
        add(body, det);
      }
      function fieldVisible(entry) { return entry.box.style.display !== 'none'; }
      function filterFields() {
        if (!searchInput) return;
        var q = searchInput.value.trim().toLowerCase(), shown = 0;
        for (var n = 0; n < entries.length; n++) {
          var hit = !q || (entries[n].box.getAttribute('data-kw') || '').indexOf(q) >= 0;
          entries[n].box.style.display = hit ? '' : 'none';
          if (hit) shown++;
        }
        if (advBox) {
          var anyAdv = false;
          for (var a = 0; a < advFields.length; a++) if (fieldVisible(advFields[a])) { anyAdv = true; break; }
          advBox.style.display = anyAdv ? '' : 'none';
          if (q && anyAdv) advBox.open = true;
          if (!q) advBox.open = false;
          if (advSummary) advSummary.textContent = '高级设置（' + advFields.length + ' 项，点开查看）';
        }
        searchCount.textContent = q
          ? (shown ? '匹配到 ' + shown + ' 项' : '没有匹配的设置项')
          : '共 ' + entries.length + ' 项';
        emptyNote.style.display = q && !shown ? '' : 'none';
      }
      if (searchInput) {
        searchInput.addEventListener('input', filterFields);
        searchInput.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape' && searchInput.value) {
            searchInput.value = '';
            filterFields();
            ev.stopPropagation();
          }
        });
        filterFields();
      }
      if (focusEntry) {
        var focusNode = focusEntry.control.node;
        var inner = focusNode && focusNode.querySelector ? focusNode.querySelector('input,select,textarea') : null;
        (inner || focusNode).focus();
      }
      // 基线：打开面板时的值快照，用于「关闭前拦未保存改动」和「本次改了几项」。
      var snapshot = function () { return JSON.stringify(collect(entries).values || {}); };
      var baseline = snapshot();
      dirtyProbe = function () { return snapshot() !== baseline; };

      var save = el('button', 'btn btn-primary', '保存'), reset = el('button', 'btn btn-ghost', '恢复默认值');
      save.type = 'button'; reset.type = 'button';
      add(actions, save); add(actions, reset);
      reset.addEventListener('click', function () {
        for (var r = 0; r < entries.length; r++) {
          entries[r].control.reset(entries[r].field['default']);
          if (entries[r].describeDefault) entries[r].describeDefault();
        }
        status.className = 'cfg-status';
        status.textContent = '已回填为默认值（尚未保存）；确认无误后点「保存」才会生效';
      });
      save.addEventListener('click', function () {
        var result = collect(entries);
        if (result.error) { status.className = 'cfg-status cfg-status-err'; status.textContent = result.error; return; }
        // 数一下真正改了几项：只比较键值，不改的不算，避免「保存了 8 项」这种虚数。
        var before = {}, after = result.values, changed = 0;
        try { before = JSON.parse(baseline); } catch (e) { before = {}; }
        for (var key in after) {
          if (!Object.prototype.hasOwnProperty.call(after, key)) continue;
          if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed++;
        }
        save.disabled = true; reset.disabled = true;
        status.className = 'cfg-status'; status.textContent = '正在保存…';
        invoke(pluginId, 'set', { values: after }).then(function (res) {
          save.disabled = false; reset.disabled = false;
          var warnings = res.warnings && res.warnings.length ? '（' + res.warnings.join('；') + '）' : '';
          var scope = changed ? '，本次修改 ' + changed + ' 项' : '（内容未变）';
          saved = true;
          if (res.restart_required) {
            status.className = 'cfg-status cfg-status-warn';
            status.textContent = '已保存' + scope + '，需重启 kored 生效' + warnings;
            toast('已保存，需重启 kored 生效');
            return;
          }
          status.className = 'cfg-status cfg-status-ok';
          status.textContent = '已保存' + scope + '，立即生效' + warnings;
          if (typeof opts.onSaved === 'function') opts.onSaved(res);
          toast('已保存，立即生效');
          setTimeout(close, 500);
        }, function (err) {
          save.disabled = false; reset.disabled = false;
          status.className = 'cfg-status cfg-status-err'; status.textContent = '保存失败：' + err.message;
        });
      });
    }, function (err) {
      var code = (err && err.code) || '';
      var raw = (err && err.message) || '未知错误';
      if (isNoContract(err)) {
        // 插件未实现 config.get：与 fields 为空走同一套空态，文案一致不漂移。
        renderState(body, actions, {
          icon: '◇',
          title: '该插件暂无可配置项',
          detail: '这是新版配置能力，插件作者尚未接入设置项；如需调整，可到软件商店查看该插件是否有新版本。',
          hint: '您可以先关闭本窗口继续使用插件，或前往软件商店查看更新。',
          buttons: [
            { label: '关闭', primary: true, onClick: close },
            { label: '去商店看看', onClick: function () {
              if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('store');
              else window.location.hash = '#/store';
              close();
            } }
          ]
        });
        return;
      }
      // 其它错误：人话 + 怎么办 + 重试，错误码只进折叠区（不裸露、不甩锅用户）。
      renderState(body, actions, {
        icon: '⚠',
        title: '设置暂时读不出来',
        detail: '可能是插件还没启动好，或网络临时中断；请点「重试」再试一次，或回到列表刷新后重新打开。',
        hint: '如果反复出现，可到软件商店检查该插件是否需要更新。',
        code: (code ? code + '：' : '') + raw,
        buttons: [
          { label: '重试', primary: true, onClick: function () { close(); open(host, pluginId, opts); } },
          { label: '关闭', onClick: close }
        ]
      });
    });
    return { close: close };
  }
  window.KoreConfig = { open: open };
})();
