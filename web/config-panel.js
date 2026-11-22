/* kore 主壳 · 插件统一配置面板（web/config-panel.js）——零框架 / 零 CDN / 无外链。
   POST /api/v1/invoke/<id>/<id>.config.get|set（docs/PLUGIN-CONFIG.md）。
   window.KoreConfig.open(container, pluginId, opts)：按 schema.fields 渲染
   string/int/bool/select/list；每字段 label + 一行 help；sensitive 用 password 不回显；
   保存成功提示「已保存，立即生效」，restart_required 时提示「需重启 kored 生效」；
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
    '.cfg-toast{position:fixed;top:12px;left:50%;z-index:900;transform:translateX(-50%);max-width:min(92vw,560px);padding:10px 16px;color:var(--kore-text-1);background:var(--kore-bg-2);border:1px solid var(--kore-success);border-radius:var(--kore-radius-control);box-shadow:var(--kore-shadow);font-size:var(--kore-font-13)}'
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
          throw new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
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
    var input = textInput(field, value, field.type === 'int' ? 'number' : 'text');
    return {
      node: input,
      read: function () {
        if (field.type !== 'int') return input.value;
        var n = Number(input.value);
        return input.value.trim() === '' || !isFinite(n) ? NaN : Math.trunc(n);
      },
      reset: function (def) { input.value = def === undefined || def === null ? '' : String(def); }
    };
  }
  function renderField(field, value) {
    var box = el('div', 'cfg-field'), label = el('label', 'cfg-label', field.label || field.key);
    if (field.required) add(label, el('span', 'cfg-req', '*'));
    add(box, label);
    var control = fieldControl(field, value);
    add(box, control.node);
    if (field.help) add(box, el('p', 'cfg-help', field.help));
    return { field: field, box: box, control: control };
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
    function close() {
      document.removeEventListener('keydown', onKey); if (panel.parentNode) panel.parentNode.removeChild(panel);
    }
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    invoke(pluginId, 'get', {}).then(function (data) {
      var schema = data.schema || {}, values = data.values || {}, fields = schema.fields || [], entries = [];
      body.textContent = '';
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i], current = values[field.key];
        if (current === undefined) current = field['default'];
        var entry = renderField(field, current);
        entries.push(entry); add(body, entry.box);
      }
      var save = el('button', 'btn btn-primary', '保存'), reset = el('button', 'btn btn-ghost', '恢复默认值');
      save.type = 'button'; reset.type = 'button';
      add(actions, save); add(actions, reset);
      reset.addEventListener('click', function () {
        for (var k = 0; k < entries.length; k++) entries[k].control.reset(entries[k].field['default']);
        status.className = 'cfg-status'; status.textContent = '已恢复为默认值（尚未保存）';
      });
      save.addEventListener('click', function () {
        var result = collect(entries);
        if (result.error) { status.className = 'cfg-status cfg-status-err'; status.textContent = result.error; return; }
        save.disabled = true; reset.disabled = true;
        status.className = 'cfg-status'; status.textContent = '正在保存…';
        invoke(pluginId, 'set', { values: result.values }).then(function (res) {
          save.disabled = false; reset.disabled = false;
          var warnings = res.warnings && res.warnings.length ? '（' + res.warnings.join('；') + '）' : '';
          if (res.restart_required) {
            status.className = 'cfg-status cfg-status-warn';
            status.textContent = '已保存，需重启 kored 生效' + warnings;
            toast('已保存，需重启 kored 生效');
            return;
          }
          status.className = 'cfg-status cfg-status-ok';
          status.textContent = '已保存，立即生效' + warnings;
          if (typeof opts.onSaved === 'function') opts.onSaved(res);
          toast('已保存，立即生效');
          setTimeout(close, 500);
        }, function (err) {
          save.disabled = false; reset.disabled = false;
          status.className = 'cfg-status cfg-status-err'; status.textContent = '保存失败：' + err.message;
        });
      });
    }, function (err) {
      body.textContent = '';
      add(body, el('p', 'cfg-status cfg-status-err', '读取配置失败：' + err.message));
    });
    return { close: close };
  }
  window.KoreConfig = { open: open };
})();
