/* kore 安全设置视图 —— 两步验证 / 登录 IP 白名单 / API token。
   零框架、零 CDN；由 settings.js 的「安全」tab 首次打开时懒加载。
   所有写请求带 X-Kore-CSRF 双提交头；口令只活在内存、不写 DOM 持久化。
   对外只暴露 window.KoreSecurity.render(container) 。 */
(function () {
  'use strict';
  var EP = {
    status: '/api/v1/security/status',
    totpBegin: '/api/v1/security/totp/begin',
    totpEnable: '/api/v1/security/totp/enable',
    totpDisable: '/api/v1/security/totp/disable',
    ipAllow: '/api/v1/security/ipallow',
    tokens: '/api/v1/security/tokens'
  };
  var TIMEOUT = 8000;
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function csrf() {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf('kore_csrf=') === 0) return decodeURIComponent(kv.slice('kore_csrf='.length));
    }
    return '';
  }
  function request(url, method, body) {
    var headers = { 'Accept': 'application/json' };
    var init = { method: method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      var token = csrf();
      if (token) headers['X-Kore-CSRF'] = token;
      init.body = JSON.stringify(body);
    }
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = null;
    if (ctrl) { init.signal = ctrl.signal; timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT); }
    return fetch(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (raw) {
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        return { ok: res.ok, status: res.status, data: data };
      });
    }, function (err) { if (timer) clearTimeout(timer); throw err; });
  }
  function msg(res, fallback) {
    if (res && res.data && res.data.message) return String(res.data.message);
    return fallback || '操作未完成，请稍后重试';
  }
  function section(title, desc) {
    var box = el('section', 'panel');
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', title));
    if (desc) head.appendChild(el('span', 'panel-meta', desc));
    box.appendChild(head);
    return box;
  }
  function statusLine(text, tone) {
    var n = el('div', 'settings-hint' + (tone ? ' settings-hint-' + tone : ''), text);
    n.setAttribute('role', 'status');
    return n;
  }
  function field(labelText, id, type, placeholder) {
    var label = el('label', 'settings-pw-form');
    label.setAttribute('for', id);
    label.appendChild(el('span', null, labelText));
    var input = el('input', 'settings-select');
    input.id = id; input.type = type || 'text';
    if (placeholder) input.placeholder = placeholder;
    input.autocomplete = 'off';
    label.appendChild(input);
    return { label: label, input: input };
  }
  function btn(text, id) {
    var b = el('button', 'btn', text);
    b.type = 'button';
    if (id) b.id = id;
    return b;
  }
  function ensureCss() {
    if (document.getElementById('kore-security-css')) return;
    var s = el('style'); s.id = 'kore-security-css';
    s.textContent = '.security-grid{display:flex;flex-direction:column;gap:6px;margin:0 0 10px}' +
      '.security-grid label{display:block;color:var(--kore-text-2);font-size:var(--kore-font-13)}' +
      '.security-grid input{display:block;width:100%;box-sizing:border-box;min-height:var(--kore-touch);' +
      'margin-top:4px;padding:0 var(--kore-space-2);font:inherit;color:var(--kore-text-1);' +
      'background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control)}' +
      '.security-grid input:focus{border-color:var(--kore-info);outline:none}' +
      '.security-codes{white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:var(--kore-font-13);' +
      'padding:8px 10px;background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control)}' +
      '.security-token{word-break:break-all;font-family:monospace}' +
      '@media (max-width:639px){.security-grid input{font-size:16px}.security-grid .btn{min-height:var(--kore-touch)}}';
    document.head.appendChild(s);
  }

  /* ===== 两步验证卡片：生成 → 展示密钥/恢复码 → 输 6 位码确认开启 ===== */
  function buildTOTP(host, state, reload) {
    var box = section('两步验证（登录二次验证）', state.totpEnabled ? '已开启' : '未开启 · 默认关闭');
    var note = statusLine('开启后，每次登录都要在口令之后输入认证器上的 6 位验证码；密钥与恢复码只在设置时显示一次，请立刻保存。');
    box.appendChild(note);
    var grid = el('div', 'security-grid');
    var pw = field('当前管理员口令（确认是本人操作）', 'kore-sec-totp-pw', 'password', '请输入当前口令');
    pw.input.autocomplete = 'current-password';
    var code = field('认证器上的 6 位验证码', 'kore-sec-totp-code', 'text', '例如 123456');
    code.input.inputMode = 'numeric';
    code.input.maxLength = 6;
    grid.appendChild(pw.label);
    grid.appendChild(code.label);
    box.appendChild(grid);
    var ops = el('div', 'settings-actions');
    var begin = btn(state.totpEnabled ? '重新设置（需先关闭）' : '① 生成密钥', 'kore-sec-totp-begin');
    var enable = btn('② 确认开启', 'kore-sec-totp-enable');
    var disable = btn('关闭两步验证', 'kore-sec-totp-disable');
    if (state.totpEnabled) { begin.disabled = true; enable.disabled = true; }
    else disable.disabled = true;
    ops.appendChild(begin); ops.appendChild(enable); ops.appendChild(disable);
    box.appendChild(ops);
    var secrets = el('div');
    box.appendChild(secrets);
    var pending = null;
    begin.addEventListener('click', function () {
      if (!pw.input.value) { note.textContent = '请先填写当前管理员口令。'; note.className = 'settings-hint settings-hint-error'; return; }
      note.textContent = '正在生成密钥…'; note.className = 'settings-hint';
      request(EP.totpBegin, 'POST', { password: pw.input.value }).then(function (res) {
        if (!res.ok || !res.data) { note.textContent = msg(res, '生成密钥失败'); note.className = 'settings-hint settings-hint-error'; return; }
        pending = res.data;
        secrets.textContent = '';
        secrets.appendChild(el('div', 'security-hint', '请立刻保存（只显示这一次）：'));
        secrets.appendChild(el('div', 'security-codes', '密钥：' + pending.secret + '\n\n恢复码（任一可登录一次）：\n' + pending.recoveryCodes.join('\n')));
        note.textContent = '密钥已生成，请在认证器中添加后输入 6 位验证码点「确认开启」。';
        note.className = 'settings-hint settings-hint-ok';
      }, function () { note.textContent = '网络不太顺畅，请重试。'; note.className = 'settings-hint settings-hint-error'; });
    });
    enable.addEventListener('click', function () {
      if (!pending) { note.textContent = '请先点「生成密钥」保存好密钥与恢复码。'; note.className = 'settings-hint settings-hint-error'; return; }
      if (!/^\d{6}$/.test(code.input.value.trim())) { note.textContent = '请输入认证器上的 6 位数字验证码。'; note.className = 'settings-hint settings-hint-error'; return; }
      request(EP.totpEnable, 'POST', { code: code.input.value.trim() }).then(function (res) {
        note.textContent = res.ok ? '两步验证已开启。' : msg(res, '开启失败');
        note.className = res.ok ? 'settings-hint settings-hint-ok' : 'settings-hint settings-hint-error';
        if (res.ok) reload();
      }, function () { note.textContent = '网络不太顺畅，请重试。'; note.className = 'settings-hint settings-hint-error'; });
    });
    disable.addEventListener('click', function () {
      if (!pw.input.value || !code.input.value.trim()) { note.textContent = '关闭需要当前口令 + 一个 6 位验证码或恢复码。'; note.className = 'settings-hint settings-hint-error'; return; }
      if (!window.confirm('确定关闭两步验证吗？关闭后登录只需口令。')) return;
      request(EP.totpDisable, 'POST', { password: pw.input.value, code: code.input.value.trim() }).then(function (res) {
        note.textContent = res.ok ? '两步验证已关闭。' : msg(res, '关闭失败');
        note.className = res.ok ? 'settings-hint settings-hint-ok' : 'settings-hint settings-hint-error';
        if (res.ok) reload();
      }, function () { note.textContent = '网络不太顺畅，请重试。'; note.className = 'settings-hint settings-hint-error'; });
    });
    return box;
  }

  /* ===== IP 白名单卡片：默认关闭；开启后仅网段内可登录 ===== */
  function buildIPAllow(host, state, reload) {
    var box = section('登录网络限制', state.ipAllow && state.ipAllow.enabled ? '已开启' : '未开启 · 默认所有网络可登录');
    box.appendChild(statusLine('开启后，只有下面网段内的电脑能登录 Kore。请先加入你当前办公网络的网段，再点保存，否则会把自己挡在门外。'));
    var grid = el('div', 'security-grid');
    var pw = field('当前管理员口令', 'kore-sec-ip-pw', 'password', '请输入当前口令');
    pw.input.autocomplete = 'current-password';
    var cidrLabel = el('label', 'settings-pw-form');
    cidrLabel.setAttribute('for', 'kore-sec-ip-cidrs');
    cidrLabel.appendChild(el('span', null, '允许登录的网段（每行一个，例如 192.168.1.0/24）'));
    var textarea = el('textarea', 'settings-select');
    textarea.id = 'kore-sec-ip-cidrs';
    textarea.rows = 4;
    textarea.placeholder = '127.0.0.1/32\n192.168.1.0/24';
    textarea.value = (state.ipAllow && state.ipAllow.cidrs || []).join('\n');
    cidrLabel.appendChild(textarea);
    grid.appendChild(pw.label);
    grid.appendChild(cidrLabel);
    var check = el('label', 'settings-hint');
    var enabled = el('input'); enabled.type = 'checkbox'; enabled.id = 'kore-sec-ip-enabled';
    enabled.checked = !!(state.ipAllow && state.ipAllow.enabled);
    check.appendChild(enabled);
    check.appendChild(document.createTextNode(' 开启登录网络限制'));
    grid.appendChild(check);
    box.appendChild(grid);
    var note = statusLine('');
    box.appendChild(note);
    var save = btn('保存设置', 'kore-sec-ip-save');
    box.appendChild(save);
    save.addEventListener('click', function () {
      var lines = textarea.value.split(/[\n,]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!pw.input.value) { note.textContent = '请先填写当前管理员口令。'; note.className = 'settings-hint settings-hint-error'; return; }
      if (enabled.checked && lines.length === 0) { note.textContent = '开启限制时至少要填一个网段。'; note.className = 'settings-hint settings-hint-error'; return; }
      save.disabled = true;
      request(EP.ipAllow, 'POST', { password: pw.input.value, enabled: enabled.checked, cidrs: lines }).then(function (res) {
        save.disabled = false;
        note.textContent = res.ok ? '登录网络限制已' + (enabled.checked ? '开启' : '关闭') + '。' : msg(res, '保存失败');
        note.className = res.ok ? 'settings-hint settings-hint-ok' : 'settings-hint settings-hint-error';
        if (res.ok) reload();
      }, function () { save.disabled = false; note.textContent = '网络不太顺畅，请重试。'; note.className = 'settings-hint settings-hint-error'; });
    });
    return box;
  }

  /* ===== API token 卡片：生成（明文只显示一次）/ 列表 / 吊销 ===== */
  function buildTokens(host, state, reload) {
    var box = section('API 令牌', '已创建 ' + (state.tokenCount || 0) + ' 个 · 供脚本与自动化调用');
    box.appendChild(statusLine('令牌用于让脚本调用 Kore 接口，不需要每次登录。明文只在创建时显示一次，请立刻复制保存；不用了就吊销。'));
    var grid = el('div', 'security-grid');
    var pw = field('当前管理员口令', 'kore-sec-token-pw', 'password', '请输入当前口令');
    pw.input.autocomplete = 'current-password';
    var name = field('令牌名称（方便你认出用途）', 'kore-sec-token-name', 'text', '例如 备份脚本');
    var scope = field('权限范围', 'kore-sec-token-scope', 'text', 'read 或 admin');
    var sel = el('select', 'settings-select');
    sel.id = 'kore-sec-token-scope';
    [['read', '只读（只能查看，不能修改）'], ['admin', '全部（可修改设置）']].forEach(function (item) {
      var op = el('option', null, item[1]); op.value = item[0]; sel.appendChild(op);
    });
    scope.label.replaceChild(sel, scope.input);
    var ttl = field('有效期天数', 'kore-sec-token-ttl', 'number', '90');
    ttl.input.value = '90'; ttl.input.min = '1'; ttl.input.max = '365';
    grid.appendChild(pw.label); grid.appendChild(name.label); grid.appendChild(scope.label); grid.appendChild(ttl.label);
    box.appendChild(grid);
    var created = el('div');
    box.appendChild(created);
    var note = statusLine('');
    box.appendChild(note);
    var create = btn('生成令牌', 'kore-sec-token-create');
    box.appendChild(create);
    create.addEventListener('click', function () {
      if (!pw.input.value || !name.input.value.trim()) { note.textContent = '请填当前口令和令牌名称。'; note.className = 'settings-hint settings-hint-error'; return; }
      create.disabled = true;
      request(EP.tokens, 'POST', { password: pw.input.value, name: name.input.value.trim(), scope: sel.value, ttl_days: parseInt(ttl.input.value, 10) || 0 }).then(function (res) {
        create.disabled = false;
        if (!res.ok || !res.data) { note.textContent = msg(res, '生成失败'); note.className = 'settings-hint settings-hint-error'; return; }
        created.textContent = '';
        var wrap = el('div', 'security-codes');
        wrap.appendChild(el('div', null, '请立刻复制保存（只显示这一次）：'));
        wrap.appendChild(el('div', 'security-token', res.data.token));
        wrap.appendChild(el('div', null, '调用示例：curl -H "Authorization: Bearer <令牌>" http://127.0.0.1:8787/api/v1/system/info'));
        created.appendChild(wrap);
        note.textContent = '令牌已生成。'; note.className = 'settings-hint settings-hint-ok';
        reload();
      }, function () { create.disabled = false; note.textContent = '网络不太顺畅，请重试。'; note.className = 'settings-hint settings-hint-error'; });
    });

    var list = el('div', 'security-token-list');
    box.appendChild(el('h4', null, '已有令牌'));
    box.appendChild(list);
    function paintList() {
      list.textContent = '';
      request(EP.tokens, 'GET').then(function (res) {
        if (!res.ok || !res.data || !res.data.tokens || !res.data.tokens.length) {
          var empty = el('div', 'settings-hint', '还没有令牌。用上面的表单生成第一个，脚本就能免登录调用接口。');
          list.appendChild(empty);
          var refresh = btn('刷新列表');
          refresh.addEventListener('click', paintList);
          list.appendChild(refresh);
          return;
        }
        res.data.tokens.forEach(function (item) {
          var row = el('div', 'security-grid');
          row.appendChild(el('div', null, item.name + '（' + (item.scope === 'read' ? '只读' : '全部') + '） · 创建 ' + item.createdAt + ' · 到期 ' + item.expiresAt));
          var revoke = btn('吊销');
          revoke.addEventListener('click', function () {
            if (!window.confirm('确定吊销「' + item.name + '」吗？使用该令牌的脚本会立刻无法调用接口。')) return;
            request(EP.tokens + '/' + encodeURIComponent(item.id), 'DELETE').then(function (r) {
              note.textContent = r.ok ? '已吊销。' : msg(r, '吊销失败');
              note.className = r.ok ? 'settings-hint settings-hint-ok' : 'settings-hint settings-hint-error';
              if (r.ok) paintList();
            }, function () { note.textContent = '网络不太顺畅，请重试。'; });
          });
          row.appendChild(revoke);
          list.appendChild(row);
        });
      }, function () { list.appendChild(el('div', 'settings-hint settings-hint-error', '令牌列表读取失败，请刷新重试。')); });
    }
    paintList();
    return box;
  }

  var hostEl = null;
  function render(container) {
    if (!container || container.nodeType !== 1) return;
    hostEl = container;
    ensureCss();
    container.textContent = '';
    container.appendChild(statusLine('正在读取安全设置…'));
    function reload() {
      if (!hostEl) return;
      request(EP.status, 'GET').then(function (res) {
        if (!hostEl) return;
        hostEl.textContent = '';
        if (!res.ok || !res.data) {
          hostEl.appendChild(el('div', 'settings-hint settings-hint-error', msg(res, '读取安全设置失败，请刷新重试')));
          return;
        }
        hostEl.appendChild(buildTOTP(hostEl, res.data, reload));
        hostEl.appendChild(buildIPAllow(hostEl, res.data, reload));
        hostEl.appendChild(buildTokens(hostEl, res.data, reload));
      }, function () {
        if (hostEl) hostEl.textContent = '网络不太顺畅，请刷新重试。';
      });
    }
    reload();
    return { destroy: function () { hostEl = null; } };
  }
  window.KoreSecurity = { render: render, endpoints: EP };
})();
