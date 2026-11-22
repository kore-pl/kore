/* kore 主壳前端 —— 原生 JS，零依赖。
   启动先探测 GET /api/v1/system/info，按三态分流（绝不把 401 误判成"后端未连接"）：
     200 → 已登录，渲染控制台（系统信息 + 插件表格 + 启停/调用）
     401 → 渲染登录表单（口令 → POST /api/v1/auth/login，错误逐类显示，不吞错）
     网络错误 / 超时 → 才显示"后端未连接"降级横幅
   写请求（POST）一律带 X-Kore-CSRF 双提交头；cookie 缺失时先 GET 一次探测触发重新下发，
   仍缺失则明确提示刷新，不静默失败。状态一律「点 + 文本」双通道（FRONTEND §6 红线 9）。
   插件 UI 走独立 origin iframe + postMessage 桥（裁决40/41），不进主壳 realm。 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  if (!app) return;

  var ENDPOINTS = {
    health: '/-/healthz',
    info: '/api/v1/system/info',
    plugins: '/api/v1/plugins',
    login: '/api/v1/auth/login',
    logout: '/api/v1/auth/logout'
  };
  var REQUEST_TIMEOUT_MS = 5000;
  var LOGIN_TIMEOUT_MS = 8000;
  var WRITE_TIMEOUT_MS = 15000;

  // 会话/视图状态：authed 由 system/info 的状态码决定，不靠猜测。
  var state = {
    authed: false,
    health: null,
    info: null,
    plugins: [],
    notice: '',
    ping: Object.create(null)
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtInt(value) {
    return typeof value === 'number' && isFinite(value) ? String(value) : '—';
  }

  // 读非 HttpOnly 的 kore_csrf（双提交要求前端可读；会话 cookie 仍 HttpOnly）。
  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }

  function errText(err) {
    if (!err) return '未知错误';
    if (err.name === 'AbortError') return '请求超时';
    return err.message ? String(err.message) : '网络请求失败';
  }

  // 统一请求：永不因 HTTP 状态码 reject（401/429 由调用方分流），只有网络/超时 reject。
  function request(url, init, timeoutMs) {
    var opts = init || {};
    opts.credentials = 'same-origin';
    opts.cache = 'no-store';
    if (!opts.headers) opts.headers = {};
    if (!opts.headers.Accept) opts.headers.Accept = 'application/json';
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || REQUEST_TIMEOUT_MS) : null;
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(url, opts).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {};
        if (raw) {
          try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; }
        }
        return { ok: res.ok, status: res.status, data: data };
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      throw err;
    });
  }

  // 错误体统一口径：{code,message,detail}。界面只说人话，错误码留给调试（title / 控制台）。
  function describeError(res) {
    var body = (res && res.data) || {};
    var message = body.message ? String(body.message) : '';
    if (message) return message;
    if (res && res.status === 401) return '会话已失效，请重新登录';
    return '操作未完成（HTTP ' + (res && res.status ? res.status : '?') + '）';
  }

  // CSRF 双提交：cookie 缺失时先 GET 一次探测（服务端仅在登录成功时下发），仍无则明确报错。
  function ensureCsrf() {
    var token = readCookie('kore_csrf');
    if (token) return Promise.resolve(token);
    return request(ENDPOINTS.info).then(function () {
      return readCookie('kore_csrf');
    }, function () {
      return readCookie('kore_csrf');
    });
  }

  function writeJson(url, body, timeoutMs) {
    return ensureCsrf().then(function (token) {
      if (!token) throw new Error('缺少 CSRF 令牌（kore_csrf），请刷新页面或重新登录后重试');
      return request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kore-CSRF': token },
        body: body === undefined ? '{}' : JSON.stringify(body)
      }, timeoutMs || WRITE_TIMEOUT_MS);
    });
  }

  function probeHealth() {
    return request(ENDPOINTS.health).then(
      function (res) { return { reached: true, res: res }; },
      function (err) { return { reached: false, error: err }; }
    );
  }

  function probeInfo() {
    return request(ENDPOINTS.info).then(
      function (res) { return { reached: true, res: res }; },
      function (err) { return { reached: false, error: err }; }
    );
  }

  function statusTag(state) {
    var wrap = el('span', 'tag');
    wrap.appendChild(el('span', 'dot ' + state.cls));
    wrap.appendChild(el('span', null, state.text));
    return wrap;
  }

  function healthState() {
    var h = state.health;
    if (!h) return { cls: 'warn', text: '检测中' };
    if (!h.reached) return { cls: 'fail', text: '不可达' };
    if (!h.res.ok) return { cls: 'fail', text: '异常' };
    return { cls: 'ok', text: '正常' };
  }

  function infoState() {
    if (!state.authed) return { cls: 'warn', text: '未登录' };
    if (!state.info) return { cls: 'warn', text: '检测中' };
    return { cls: 'ok', text: '正常' };
  }

  function row(label, value) {
    var tr = el('tr');
    tr.appendChild(el('th', null, label));
    var td = el('td');
    if (value && value.nodeType === 1) {
      td.appendChild(value);
    } else {
      td.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    }
    tr.appendChild(td);
    return tr;
  }

  function panel(title, rows) {
    var box = el('section', 'panel');
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', title));
    box.appendChild(head);
    var table = el('table', 'rows');
    for (var i = 0; i < rows.length; i++) table.appendChild(rows[i]);
    box.appendChild(table);
    return box;
  }

  // 空状态统一给下一步动作，而不是只留一句冷冰冰的"暂无数据"。
  function emptyState(text, routeId, label) {
    var wrap = el('div', 'panel-empty empty-state');
    wrap.appendChild(el('p', 'empty-state-text', text));
    if (routeId) {
      var btn = el('button', 'btn', label || '去软件商店');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
          window.KoreShell.navigate(routeId);
        } else {
          window.location.hash = '#/' + routeId;
        }
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function replaceNode(oldNode, newNode) {
    if (oldNode && oldNode.parentNode) {
      oldNode.parentNode.replaceChild(newNode, oldNode);
    }
  }

  function noticeBar(message) {
    var box = el('div', 'notice');
    box.appendChild(el('span', 'dot fail notice-dot'));
    var text = el('div');
    text.className = 'notice-body';
    text.appendChild(el('div', 'notice-title', '操作未完成'));
    text.appendChild(el('div', 'notice-hint', message));
    box.appendChild(text);
    var close = el('button', 'btn btn-ghost notice-close', '关闭');
    close.type = 'button';
    close.addEventListener('click', function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    });
    box.appendChild(close);
    return box;
  }

  // 仅用于「网络层不可达」：401 不再落到这里。
  function degraded(message) {
    var box = el('div', 'notice');
    box.appendChild(el('span', 'dot warn notice-dot'));
    var text = el('div');
    text.className = 'notice-body';
    text.appendChild(el('div', 'notice-title', '后端未连接'));
    text.appendChild(el('div', 'notice-hint', message + '；页面以降级模式展示，不阻断静态访问。'));
    box.appendChild(text);
    var retry = el('button', 'btn btn-ghost', '重新检测');
    retry.type = 'button';
    retry.addEventListener('click', start);
    box.appendChild(retry);
    return box;
  }

  /* ===================== 登录视图 ===================== */

  function showLoginError(errBox, message) {
    if (!errBox) return;
    errBox.textContent = message;
    errBox.hidden = false;
  }

  function renderLogin(message) {
    var wrap = el('div', 'login-wrap');
    var card = el('form', 'login-card');
    card.setAttribute('method', 'post');
    card.setAttribute('novalidate', 'novalidate');

    card.appendChild(el('div', 'login-brand', 'kore'));
    card.appendChild(el('div', 'login-sub', '控制台 · 单管理员登录'));

    var label = el('label', 'field');
    label.appendChild(el('span', 'field-label', '管理员口令'));
    var input = document.createElement('input');
    input.type = 'password';
    input.id = 'kore-password';
    input.name = 'password';
    input.className = 'field-input';
    input.autocomplete = 'current-password';
    input.required = true;
    input.setAttribute('placeholder', '请输入口令');
    label.appendChild(input);
    card.appendChild(label);

    var submit = el('button', 'btn btn-primary btn-block', '登录');
    submit.type = 'submit';
    card.appendChild(submit);

    var errBox = el('div', 'login-error', message || '');
    errBox.id = 'kore-login-error';
    errBox.setAttribute('role', 'alert');
    if (!message) errBox.hidden = true;
    card.appendChild(errBox);
    card.appendChild(el('div', 'login-note', '登录失败 5 次/60 秒后锁定 5 分钟；口令仅在本机校验。'));

    card.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitLogin(input, submit, errBox);
    });

    wrap.appendChild(card);
    if (app.replaceChildren) app.replaceChildren(wrap);
    else { app.innerHTML = ''; app.appendChild(wrap); }
    input.focus();
  }

  function submitLogin(input, submit, errBox) {
    var password = input.value || '';
    if (!password) {
      showLoginError(errBox, '请输入口令');
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = '登录中…';

    request(ENDPOINTS.login, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password })
    }, LOGIN_TIMEOUT_MS).then(function (res) {
      if (res.ok) {
        // 登录成功：服务端已下发 kore_session(HttpOnly) + kore_csrf，回到探测流程重渲染面板。
        start();
        return;
      }
      input.value = '';
      if (res.status === 401) showLoginError(errBox, '口令错误，请重试');
      else if (res.status === 429) showLoginError(errBox, '尝试过于频繁，已被临时锁定，请稍后再试');
      else showLoginError(errBox, '登录失败：' + describeError(res));
      submit.disabled = false;
      submit.textContent = '登录';
      input.focus();
    }, function (err) {
      showLoginError(errBox, '后端未连接：' + errText(err));
      submit.disabled = false;
      submit.textContent = '登录';
    });
  }

  /* ===================== 控制台视图 ===================== */

  // 品牌只在侧栏出现一次；顶栏在壳内只承担状态与退出（withBrand 仅给无壳的降级页用）。
  function renderTopbar(withBrand) {
    var bar = el('header', 'topbar');
    if (withBrand) {
      var brand = el('div', 'brand');
      brand.appendChild(el('span', 'brand-name', 'kore'));
      brand.appendChild(el('span', 'brand-sub', '控制台'));
      bar.appendChild(brand);
    } else {
      bar.classList.add('topbar-solo');
    }

    var conn = el('div', 'conn');
    conn.appendChild(statusTag(healthState()));
    conn.appendChild(el('span', 'conn-label', '健康检查'));
    conn.appendChild(statusTag(infoState()));
    conn.appendChild(el('span', 'conn-label', '系统信息'));

    if (state.authed) {
      var out = el('button', 'btn btn-ghost', '退出');
      out.type = 'button';
      out.addEventListener('click', logout);
      conn.appendChild(out);
    }

    bar.appendChild(conn);
    return bar;
  }

  function renderInfoPanel() {
    var data = state.info || {};
    var sup = data.supervisor && typeof data.supervisor === 'object' ? data.supervisor : {};
    var rows = [];
    rows.push(row('版本', data.version || '—'));
    rows.push(row('常驻插件', fmtInt(sup.resident)));
    rows.push(row('重启计数', fmtInt(sup.restarts)));
    rows.push(row('插件总数', fmtInt(state.plugins.length)));
    var platform = [data.os, data.arch].filter(Boolean).join(' · ');
    rows.push(row('平台', platform || '—'));
    rows.push(row('cgroup', data.cgroup_mode || '—'));
    if (Array.isArray(data.warnings) && data.warnings.length) {
      rows.push(row('降级告警', data.warnings.join('；')));
    }
    var box = panel('系统信息', rows);
    box.id = 'kore-info-panel';
    return box;
  }

  function cell(label, value) {
    var td = el('td');
    td.setAttribute('data-label', label);
    if (value && value.nodeType === 1) td.appendChild(value);
    else td.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    return td;
  }

  function pingState(id) {
    if (!state.ping[id]) state.ping[id] = { supported: true, result: '', error: '' };
    return state.ping[id];
  }

  function pluginRow(plugin) {
    var id = plugin.id || '';
    var tr = el('tr', 'plugin-row');
    tr.id = 'kore-row-' + id;
    tr.setAttribute('data-plugin-id', id);

    var idCell = el('div', 'plugin-id');
    idCell.appendChild(el('span', 'plugin-id-name', id));
    if (plugin.name && plugin.name !== id) idCell.appendChild(el('span', 'plugin-id-alias', plugin.name));

    tr.appendChild(cell('插件', idCell));
    tr.appendChild(cell('版本', plugin.version));
    tr.appendChild(cell('深度', plugin.depth_level));
    tr.appendChild(cell('生命周期', plugin.lifecycle));
    tr.appendChild(cell('状态', statusTag(pluginStateTag(plugin))));

    var ops = el('td', 'cell-ops');
    ops.setAttribute('data-label', '操作');

    var enabled = plugin.enabled === true;
    var action = enabled ? 'disable' : 'enable';
    var actionBtn = el('button', 'btn', enabled ? '停用' : '启用');
    actionBtn.type = 'button';
    actionBtn.addEventListener('click', function () {
      lifecycle(plugin, action, tr, actionBtn);
    });
    ops.appendChild(actionBtn);

    var ping = pingState(id);
    var pingBtn = el('button', 'btn', '调用 ping');
    pingBtn.type = 'button';
    if (!enabled || plugin.state !== 'ready' || !ping.supported) {
      pingBtn.disabled = true;
      pingBtn.title = !enabled ? '插件未启用，先点「启用」'
        : (plugin.state !== 'ready' ? '插件当前状态 ' + (plugin.state || '未知') + '，未就绪'
          : '该插件不支持 ping 方法');
    }
    pingBtn.addEventListener('click', function () {
      invokePing(plugin, pingBtn, note);
    });
    ops.appendChild(pingBtn);

    var note = el('div', 'row-note');
    if (!ping.supported) note.textContent = '该插件不支持 ping 方法';
    else if (ping.error) { note.textContent = 'ping 失败：' + ping.error; note.className = 'row-note row-note-fail'; }
    else if (ping.result) { note.textContent = 'ping → ' + ping.result; note.className = 'row-note row-note-ok'; }
    else if (!enabled) note.textContent = '未启用';
    else if (plugin.state !== 'ready') note.textContent = '状态 ' + (plugin.state || '未知');
    ops.appendChild(note);

    tr.appendChild(ops);
    return tr;
  }

  function pluginStateTag(plugin) {
    var text = plugin.state || (plugin.enabled ? 'enabled' : 'stopped');
    if (text === 'ready') return { cls: 'ok', text: text };
    if (text === 'failed') return { cls: 'fail', text: text };
    if (text === 'starting' || text === 'draining') return { cls: 'warn', text: text };
    return { cls: 'warn', text: text };
  }

  function replaceRow(plugin) {
    for (var i = 0; i < state.plugins.length; i++) {
      if (state.plugins[i] && state.plugins[i].id === plugin.id) {
        state.plugins[i] = plugin;
        break;
      }
    }
    var oldRow = document.getElementById('kore-row-' + plugin.id);
    if (oldRow) replaceNode(oldRow, pluginRow(plugin));
  }

  function lifecycle(plugin, action, tr, btn) {
    var url = ENDPOINTS.plugins + '/' + encodeURIComponent(plugin.id) + '/' + action;
    btn.disabled = true;
    btn.textContent = action === 'enable' ? '启用中…' : '停用中…';

    writeJson(url, {}).then(function (res) {
      if (res.status === 401) {
        state.authed = false;
        renderLogin('会话已过期，请重新登录');
        return;
      }
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = action === 'enable' ? '启用' : '停用';
        state.notice = '插件 ' + plugin.id + ' ' + (action === 'enable' ? '启用' : '停用') + '失败：' + describeError(res);
        var panelNode = document.getElementById('kore-plugins-panel');
        if (panelNode) {
          var old = document.getElementById('kore-notice');
          var bar = noticeBar(state.notice);
          bar.id = 'kore-notice';
          if (old) replaceNode(old, bar);
          else if (panelNode.parentNode) panelNode.parentNode.insertBefore(bar, panelNode);
        }
        return;
      }
      // 服务端在启停响应里回读单插件视图 → 局部刷新该行，不重排整表。
      var updated = res.data && res.data.id ? res.data : null;
      if (updated) replaceRow(updated);
      else loadDashboard();
      refreshInfo();
    }, function (err) {
      btn.disabled = false;
      btn.textContent = action === 'enable' ? '启用' : '停用';
      state.notice = '插件 ' + plugin.id + ' ' + (action === 'enable' ? '启用' : '停用') + '请求失败：' + errText(err);
      var host = document.getElementById('kore-plugins-panel');
      var existing = document.getElementById('kore-notice');
      var bar = noticeBar(state.notice);
      bar.id = 'kore-notice';
      if (existing) replaceNode(existing, bar);
      else if (host && host.parentNode) host.parentNode.insertBefore(bar, host);
    });
  }

  // 静默刷新系统信息（常驻数/重启计数），只替换信息面板，不动其它节点。
  function refreshInfo() {
    request(ENDPOINTS.info).then(function (res) {
      if (!res.ok) return;
      state.info = res.data || {};
      var old = document.getElementById('kore-info-panel');
      if (old) replaceNode(old, renderInfoPanel());
    }, function () { /* 静默：失败不打断当前视图，下次操作或「重新检测」会重试 */ });
  }

  // ping：真实方法调用，成功显示服务端原样结果；方法不存在则把该行 ping 标记为不支持。
  function invokePing(plugin, btn, note) {
    var url = '/api/v1/invoke/' + encodeURIComponent(plugin.id) + '/ping';
    var entry = pingState(plugin.id);
    btn.disabled = true;
    btn.textContent = '调用中…';

    writeJson(url, {}).then(function (res) {
      btn.textContent = '调用 ping';
      if (res.status === 401) {
        state.authed = false;
        renderLogin('会话已过期，请重新登录');
        return;
      }
      if (res.ok) {
        entry.supported = true;
        entry.error = '';
        entry.result = JSON.stringify(res.data);
        note.className = 'row-note row-note-ok';
        note.textContent = 'ping → ' + entry.result;
        btn.disabled = false;
        return;
      }
      var code = res.data && res.data.code ? String(res.data.code) : '';
      if (code === 'E_NOTFOUND') {
        entry.supported = false;
        entry.result = '';
        entry.error = '';
        note.className = 'row-note';
        note.textContent = '该插件不支持 ping 方法';
        btn.disabled = true;
        btn.title = '该插件不支持 ping 方法';
        return;
      }
      entry.error = describeError(res);
      note.className = 'row-note row-note-fail';
      note.textContent = 'ping 失败：' + entry.error;
      btn.disabled = false;
    }, function (err) {
      btn.textContent = '调用 ping';
      btn.disabled = false;
      entry.error = errText(err);
      note.className = 'row-note row-note-fail';
      note.textContent = 'ping 失败：' + entry.error;
    });
  }

  function renderPluginsPanel() {
    var box = el('section', 'panel');
    box.id = 'kore-plugins-panel';
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', '插件'));
    var reload = el('button', 'btn btn-ghost', '刷新列表');
    reload.type = 'button';
    reload.addEventListener('click', loadDashboard);
    head.appendChild(reload);
    box.appendChild(head);

    if (!state.plugins.length) {
      box.appendChild(emptyState('暂无已安装插件，去软件商店安装。', 'store', '去软件商店'));
      return box;
    }

    var table = el('table', 'plugin-table');
    var thead = el('thead');
    var headRow = el('tr');
    var cols = ['插件', '版本', '深度', '生命周期', '状态', '操作'];
    for (var c = 0; c < cols.length; c++) headRow.appendChild(el('th', null, cols[c]));
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = el('tbody');
    for (var i = 0; i < state.plugins.length; i++) {
      var plugin = state.plugins[i];
      if (!plugin || !plugin.id) continue;
      tbody.appendChild(pluginRow(plugin));
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  /* ===================== 插件 UI 桥（裁决40 / 41） =====================
     顶层设计：插件 UI 不进主壳 realm。生产环境 asset 必须独立 origin：
       frame.src = 'https://<asset-origin>/plugin-assets/<id>@<ver>/index.html'
       sandbox   = 'allow-scripts'（绝不授予同源沙箱许可，否则子帧可自行摘沙箱）
     本地 file:// 无法真跨站，故用 srcdoc + sandbox 模拟隔离边界：srcdoc 的
     origin 是 opaque 'null'，event.source 校验仍按 iframe.contentWindow 做。
     管理 API（/api/v1/plugins/* 等）永不进桥白名单——显式 method 白名单 +
     拒绝分支双保险；服务端 bus 的能力校验是权威，本桥只是兜底。 */
  var PluginBridge = (function () {
    'use strict';

    // 业务方法语法：单段、点分多段，或插件协议标准 <plugin-id>:<action>（冒号形态）。
    // 冒号分支必须放行——FRONTEND §4.3 与 PLUGIN-PROTOCOL 的标准调用形态即 echo:ping；
    // 后端 methodPattern 只认点分，HTTP 转发时由 forward() 把冒号转点分。
    var METHOD_RE = /^[a-z][a-z0-9_-]*(?:(?:\.|:)[a-z][a-z0-9_-]*)*$/;
    // 管理面形态一律拒绝：路径式 /api/...、plugins 段、生命周期动词。
    var ADMIN_RE = /^\/?(?:api(?:\/v\d+)?\/)?plugins(?:\/|$)|^\/?api\/|(?:^|[.:/])(?:enable|disable|install|uninstall|upgrade|remove)(?:$|[.:/])/i;
    var sessions = Object.create(null);
    var listening = false;

    function newId(prefix) {
      var bytes = new Uint8Array(16);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
      } else {
        for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
      var hex = '';
      for (var j = 0; j < bytes.length; j++) hex += ('0' + bytes[j].toString(16)).slice(-2);
      return prefix + '-' + hex;
    }

    function readCookie(name) {
      var parts = document.cookie ? document.cookie.split(';') : [];
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].trim();
        if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
      }
      return '';
    }

    // <plugin-id>:<action> 或 <plugin-id>.<action> → 所需 capability。
    function requiredCapability(pluginId, method) {
      var sep = method.indexOf(':') >= 0 ? ':' : '.';
      var parts = method.split(sep);
      if (parts.length !== 2 || parts[0] !== pluginId) return null;
      return pluginId + ':' + parts[1];
    }

    function capabilityForDisplay(pluginId, grantedCapabilities) {
      for (var i = 0; i < grantedCapabilities.length; i++) {
        var value = grantedCapabilities[i];
        var parts = value.split(':');
        if (parts.length === 2 && parts[0] === pluginId && parts[1] !== '*') return value;
      }
      return '';
    }

    // 白名单 + 拒绝分支：只转发 <plugin-id>:<action>，且必须命中已授予能力。
    function methodAllowed(pluginId, method, grantedCapabilities) {
      if (typeof method !== 'string' || !METHOD_RE.test(method)) return false;
      if (ADMIN_RE.test(method)) return false;
      if (method.indexOf('kore.') === 0) return false; // 协议保留方法不对桥开放
      var cap = requiredCapability(pluginId, method);
      if (!cap) return false;
      var wildcard = pluginId + ':*';
      for (var i = 0; i < grantedCapabilities.length; i++) {
        if (grantedCapabilities[i] === cap || grantedCapabilities[i] === wildcard) return true;
      }
      return false;
    }

    // srcdoc 内的 RPC shim：暴露唯一入口 window.kore.invoke(method, params)。
    // 生产环境改为 asset 独立 origin 文档时，此 shim 由主壳在帧加载后注入。
    function srcdocFor(sessionId, demoMethod) {
      var sid = JSON.stringify(sessionId);
      var method = JSON.stringify(demoMethod);
      return [
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>plugin ui</title>',
        '<style>body{font:13px system-ui,sans-serif;padding:16px}button{min-height:44px;min-width:44px}</style>',
        '</head><body>',
        '<div>插件 UI 沙箱容器（独立 origin 边界模拟）</div>',
        '<button id="kore-probe" type="button">调用 ' + demoMethod + '</button>',
        '<div id="kore-out" role="status"></div>',
        '<script>(function(){',
        'var SID=' + sid + ';var seq=0;var pending={};',
        'window.kore={',
        'invoke:function(m,p){return new Promise(function(resolve,reject){',
        'var reqId="req-"+(++seq);pending[reqId]={resolve:resolve,reject:reject};',
        'var payload=p===undefined||p===null?{}:p;',
        'parent.postMessage({type:"kore:invoke",kind:"kore.invoke",sessionId:SID,reqId:reqId,req_id:reqId,method:m,params:payload,params_json:JSON.stringify(payload)},"*");',
        '});},',
        'onEvent:function(topic,fn){return function(){};}',
        '};',
        'window.addEventListener("message",function(ev){',
        'var d=ev.data;if(!d||typeof d!=="object")return;',
        'if(d.type!=="kore:response"&&d.kind!=="kore.result")return;',
        'var id=d.reqId||d.req_id;var p=pending[id];if(!p)return;delete pending[id];',
        'if(d.ok){p.resolve(d.result!==undefined?d.result:(d.result_json?JSON.parse(d.result_json):{}));}',
        'else{p.reject(new Error(d.error&&d.error.message?d.error.message:"invoke failed"));}',
        '});',
        'var probe=document.getElementById("kore-probe");',
        'probe.addEventListener("click",function(){',
        'window.kore.invoke(' + method + ',{}).then(function(r){',
        'document.getElementById("kore-out").textContent="OK "+JSON.stringify(r);',
        '},function(e){document.getElementById("kore-out").textContent="ERR "+e.message;});',
        '});',
        '})();<\/script>',
        '</body></html>'
      ].join('\n');
    }

    // 主壳经现有 HTTP bus 转发：写请求在主壳 realm 贴 CSRF 头与 cookie。
    function forward(session, method, params) {
      var httpMethod = method.replace(':', '.'); // echo:ping → echo.ping（后端 methodPattern 接受点分）
      var url = '/api/v1/invoke/' + encodeURIComponent(session.pluginId) + '/' + encodeURIComponent(httpMethod);
      var csrf = readCookie('kore_csrf');
      var init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(params)
      };
      if (csrf) init.headers['X-Kore-CSRF'] = csrf;
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
      if (ctrl) init.signal = ctrl.signal;

      return fetch(url, init).then(function (res) {
        return res.text().then(function (raw) {
          if (timer !== null) clearTimeout(timer);
          if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + raw.slice(0, 200));
          if (!raw) return {};
          try { return JSON.parse(raw); } catch (e) { return { raw: raw }; }
        });
      }, function (err) {
        if (timer !== null) clearTimeout(timer);
        throw err;
      });
    }

    function respond(session, reqId, method, params) {
      function reply(ok, result, error) {
        if (!session.frame) return;
        // 双写兼容：派发单 type/kore:response + FRONTEND §4.3 kind/kore.result。
        var body = { type: 'kore:response', kind: 'kore.result', reqId: reqId, req_id: reqId, ok: ok };
        if (ok) {
          body.result = result === undefined ? {} : result;
          body.result_json = JSON.stringify(body.result);
        } else {
          body.error = { code: error.code, message: error.message };
        }
        session.frame.contentWindow.postMessage(body, '*');
      }

      if (!methodAllowed(session.pluginId, method, session.grantedCapabilities)) {
        reply(false, null, {
          code: 'E_UNAUTHORIZED',
          message: '方法 ' + String(method) + ' 不在桥白名单或未授予能力'
        });
        return;
      }
      forward(session, method, params || {}).then(
        function (result) { reply(true, result, null); },
        function (err) {
          reply(false, null, {
            code: 'E_INVOKE',
            message: err && err.message ? err.message : '调用失败'
          });
        }
      );
    }

    // 全局唯一 message 监听：source / origin / sessionId 三关全过才处理。
    function onMessage(event) {
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'kore:invoke' && data.kind !== 'kore.invoke') return;
      var session = data.sessionId ? sessions[data.sessionId] : null;
      if (!session) return;
      if (!session.frame || event.source !== session.frame.contentWindow) return;
      // srcdoc 的 origin 为 'null'；生产 asset 独立 origin 时必须精确相等。
      if (session.assetOrigin === 'null') {
        if (event.origin !== 'null') return;
      } else if (event.origin !== session.assetOrigin) {
        return;
      }
      var reqId = data.reqId || data.req_id;
      if (typeof reqId !== 'string' || !reqId) return;
      var params = data.params;
      if (params === undefined && typeof data.params_json === 'string') {
        try { params = JSON.parse(data.params_json); } catch (e) { params = {}; }
      }
      respond(session, reqId, data.method, params);
    }

    function attach(host, spec) {
      if (!host || !spec || typeof spec.pluginId !== 'string' || !spec.pluginId) return null;
      var sessionId = newId('kore-s');
      var granted = Array.isArray(spec.grantedCapabilities) ? spec.grantedCapabilities.slice() : [];
      var demoMethod = capabilityForDisplay(spec.pluginId, granted);
      var frame = document.createElement('iframe');
      // 沙箱只给脚本能力，绝不授予同源许可（子帧不可自行摘沙箱）。
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('title', '插件 UI · ' + spec.pluginId);
      frame.className = 'plugin-frame';
      frame.setAttribute('srcdoc', srcdocFor(sessionId, demoMethod));

      sessions[sessionId] = {
        pluginId: spec.pluginId,
        version: spec.version || '',
        grantedCapabilities: granted,
        assetOrigin: 'null', // 生产环境 asset 独立 origin 时改为实际 origin
        frame: frame,
        sessionId: sessionId
      };
      if (!listening) {
        window.addEventListener('message', onMessage, false);
        listening = true;
      }
      host.appendChild(frame);
      return sessionId;
    }

    // 卸载顺序：移除帧 → 清 sessionId 映射与 source 引用，不留闭包（FRONTEND §4.5）。
    function teardown(sessionId) {
      var session = sessions[sessionId];
      if (!session) return;
      if (session.frame && session.frame.parentNode) {
        session.frame.parentNode.removeChild(session.frame);
      }
      session.frame = null;
      delete sessions[sessionId];
    }

    return { attach: attach, teardown: teardown, methodAllowed: methodAllowed };
  })();

  function renderPluginUis(content, pluginsResult) {
    var box = el('section', 'panel plugin-panel');
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', '插件 UI（独立沙箱）'));
    box.appendChild(head);
    var list = el('div', 'plugin-ui-list');
    box.appendChild(list);

    if (!pluginsResult || pluginsResult.status !== 'fulfilled') {
      list.appendChild(el('div', 'notice-hint', '插件列表不可达，未挂载任何插件 UI。'));
      content.appendChild(box);
      return;
    }
    var data = pluginsResult.value || {};
    var items = Array.isArray(data.plugins) ? data.plugins : [];
    var mounted = 0;
    for (var i = 0; i < items.length; i++) {
      var plugin = items[i];
      // fail-closed：当前后端不返回 web / granted_capabilities；
      // 未显式声明 UI 入口和已授予能力的插件一律不建帧，首屏零注入。
      if (!plugin || plugin.enabled !== true || !plugin.web || typeof plugin.web.entry !== 'string') continue;
      var card = el('div', 'plugin-ui-card');
      card.appendChild(el('div', 'plugin-ui-title', (plugin.name || plugin.id) + ' · ' + plugin.id));
      var sessionId = PluginBridge.attach(card, {
        pluginId: plugin.id,
        version: plugin.version || '',
        grantedCapabilities: Array.isArray(plugin.granted_capabilities) ? plugin.granted_capabilities : []
      });
      if (!sessionId) {
        card.appendChild(el('div', 'notice-hint', 'UI 挂载失败'));
      } else {
        mounted++;
        var close = el('button', 'plugin-ui-close', '卸载 UI');
        close.type = 'button';
        close.addEventListener('click', (function (id, node) {
          return function () {
            PluginBridge.teardown(id);
            if (node.parentNode) node.parentNode.removeChild(node);
          };
        })(sessionId, card));
        card.appendChild(close);
      }
      list.appendChild(card);
    }
    if (mounted === 0) {
      list.appendChild(el('div', 'notice-hint', '暂无可展示的插件界面；插件界面会在需要时加载，不影响首屏速度。'));
    }
    content.appendChild(box);
  }

  function logout() {
    // logout 在 CSRF 豁免名单内（幂等会话终止）；失败也回登录页，别把用户困在面板里。
    request(ENDPOINTS.logout, { method: 'POST' }).then(
      function () { resetAndStart(); },
      function () { resetAndStart(); }
    );
  }

  function resetAndStart() {
    state.authed = false;
    state.info = null;
    state.plugins = [];
    state.ping = Object.create(null);
    start();
  }

  /* ===================== 视图路由（侧栏壳由 shell.js 提供） =====================
     只有登录成功后的 renderDashboard 注册路由；login / offline 仍走整页替换。
     store / monitor / settings 三个视图模块**懒加载**：切到该视图时才注入
     <script src="/assets/store.js">，不进首屏（FRONTEND §7：d(首屏)/d(视图数)=0）。
     模块缺席或加载失败时明确报错到容器，不退化成"空白页"——静默失败不可接受。 */
  var VIEW_MODULES = Object.create(null); // url → { state: 'loading'|'ready'|'error', error, waiters }

  // ensureModule 保证同一脚本只注入一次；并发切视图共用同一个 promise（不重复请求）。
  // 若模块已被 index.html 预先加载（window 上已有导出），直接复用，不重复注入第二次。
  function ensureModule(url, globalName) {
    var entry = VIEW_MODULES[url];
    if (!entry && window[globalName] && typeof window[globalName].render === 'function') {
      VIEW_MODULES[url] = { state: 'ready', error: null, promise: Promise.resolve(window[globalName]) };
      return VIEW_MODULES[url].promise;
    }
    if (entry && entry.state === 'ready') {
      if (window[globalName] && typeof window[globalName].render === 'function') {
        return Promise.resolve(window[globalName]);
      }
      // 脚本已执行但导出缺失：视为契约破坏，明确报错而不是静默。
      return Promise.reject(new Error(url + ' 未导出 ' + globalName + '.render'));
    }
    if (entry && entry.promise) return entry.promise;

    var record = { state: 'loading', error: null };
    record.promise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = function () {
        var mod = window[globalName];
        if (!mod || typeof mod.render !== 'function') {
          record.state = 'error';
          record.error = new Error(url + ' 已加载但未导出 ' + globalName + '.render');
          reject(record.error);
          return;
        }
        record.state = 'ready';
        resolve(mod);
      };
      script.onerror = function () {
        record.state = 'error';
        record.error = new Error(url + ' 加载失败（HTTP 错误或网络中断）');
        reject(record.error);
      };
      document.head.appendChild(script);
    });
    // 失败后允许下次切视图重试：清掉缓存记录，不把一次网络抖动变成永久白屏。
    record.promise.catch(function () { delete VIEW_MODULES[url]; });
    VIEW_MODULES[url] = record;
    return record.promise;
  }

  // moduleView 返回 shell 需要的 render(container)：同步返回 handle，
  // 异步等模块就绪后再真正渲染；切走时 shell 调 handle.destroy()，
  // 用它把"迟到的渲染"挡在已卸载的容器外（monitor 的轮询也在这里停）。
  function moduleView(globalName, url, label) {
    return function (box) {
      var live = { destroyed: false, handle: null };
      box.appendChild(el('div', 'stub', '正在加载' + label + '…'));

      ensureModule(url, globalName).then(function (mod) {
        if (live.destroyed) return;
        box.textContent = '';
        try {
          var handle = mod.render(box);
          if (handle && typeof handle.destroy === 'function') live.handle = handle;
        } catch (err) {
          box.textContent = '';
          box.appendChild(el('div', 'stub', label + '渲染失败：' + (err && err.message ? err.message : err)));
        }
      }, function (err) {
        if (live.destroyed) return;
        box.textContent = '';
        box.appendChild(el('div', 'stub', label + '不可用：' + (err && err.message ? err.message : '模块加载失败')));
      });

      return {
        destroy: function () {
          live.destroyed = true;
          if (live.handle && typeof live.handle.destroy === 'function') {
            try { live.handle.destroy(); } catch (err) { /* 模块清理失败不阻断切视图 */ }
          }
          live.handle = null;
        }
      };
    };
  }

  function viewNotice(box) {
    if (!state.notice) return;
    var bar = noticeBar(state.notice);
    bar.id = 'kore-notice';
    box.appendChild(bar);
  }

  function pluginSummaryPanel() {
    var enabled = 0, ready = 0, failed = 0;
    for (var i = 0; i < state.plugins.length; i++) {
      var p = state.plugins[i] || {};
      if (p.enabled === true) enabled++;
      if (p.state === 'ready') ready++;
      if (p.state === 'failed') failed++;
    }
    var box = el('section', 'panel');
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', '插件概览'));
    box.appendChild(head);
    if (!state.plugins.length) {
      // 零插件时不再展示四行全 0 的表格：给一句人话 + 一个可点的下一步。
      box.appendChild(emptyState('还没有安装插件', 'store', '去软件商店'));
      return box;
    }
    var table = el('table', 'rows');
    table.appendChild(row('已安装', fmtInt(state.plugins.length)));
    table.appendChild(row('已启用', fmtInt(enabled)));
    table.appendChild(row('运行中', fmtInt(ready)));
    table.appendChild(row('异常', fmtInt(failed)));
    box.appendChild(table);
    var meta = el('div', 'panel-meta actions');
    var more = el('button', 'btn', '查看全部插件');
    more.type = 'button';
    more.addEventListener('click', function () { window.KoreShell.navigate('plugins'); });
    meta.appendChild(more);
    box.appendChild(meta);
    return box;
  }

  function renderDashboardView(box) {
    viewNotice(box);
    box.appendChild(renderInfoPanel());
    box.appendChild(pluginSummaryPanel());
    var meta = el('div', 'panel-meta actions');
    var retry = el('button', 'btn', '重新检测');
    retry.type = 'button';
    retry.addEventListener('click', start);
    meta.appendChild(retry);
    box.appendChild(meta);
  }

  function renderPluginsView(box) {
    viewNotice(box);
    box.appendChild(renderPluginsPanel());
    renderPluginUis(box, { status: 'fulfilled', value: { plugins: state.plugins } });
  }

  var SHELL_ROUTES = [
    { id: 'dashboard', label: '概览', render: renderDashboardView },
    { id: 'store', label: '软件商店', render: moduleView('KoreStore', '/assets/store.js', '软件商店') },
    { id: 'plugins', label: '已装插件', render: renderPluginsView },
    { id: 'monitor', label: '监控', render: moduleView('KoreMonitor', '/assets/monitor.js', '监控') },
    { id: 'settings', label: '设置', render: moduleView('KoreSettings', '/assets/settings.js', '设置') }
  ];

  function renderDashboard() {
    if (!window.KoreShell || typeof window.KoreShell.mount !== 'function') {
      renderLegacyDashboard(); // 壳缺席：退回单页，面板不因缺一个脚本而白屏
      return;
    }
    // 首次登录挂壳；后续数据刷新只重绘当前视图，不重建导航（否则丢失视图与滚动位置）。
    var mounted = !!document.getElementById('view');
    if (!mounted) window.KoreShell.mount(SHELL_ROUTES);
    else window.KoreShell.navigate(window.KoreShell.current() || 'dashboard');

    var top = document.getElementById('kore-topbar');
    if (top) {
      top.textContent = '';
      top.appendChild(renderTopbar(false));
    }
  }

  // 视图模块（如 settings.js 退出登录）显式回到站点根 = 归位意图：
  // 鉴权状态只有本文件持有，故由这里重新探测，而不是让视图模块自己猜会话。
  if (window.addEventListener) {
    window.addEventListener('kore:root', function () { resetAndStart(); });
  }

  function renderLegacyDashboard() {
    var root = el('div');
    root.appendChild(renderTopbar(true));
    var content = el('main', 'content');
    viewNotice(content);
    content.appendChild(renderInfoPanel());
    content.appendChild(renderPluginsPanel());
    renderPluginUis(content, { status: 'fulfilled', value: { plugins: state.plugins } });
    root.appendChild(content);
    if (app.replaceChildren) app.replaceChildren(root);
    else { app.innerHTML = ''; app.appendChild(root); }
  }

  // 仅网络层不可达（fetch reject）走这里：明确"后端未连接"，不是登录问题。
  function renderOffline(err) {
    var root = el('div');
    root.appendChild(renderTopbar(true));
    var content = el('main', 'content');
    content.appendChild(degraded('无法连接内核接口：' + errText(err)));
    root.appendChild(content);
    if (app.replaceChildren) app.replaceChildren(root);
    else { app.innerHTML = ''; app.appendChild(root); }
  }

  function loadDashboard() {
    if (!state.authed) return;
    return request(ENDPOINTS.plugins).then(function (res) {
      if (res.status === 401) {
        state.authed = false;
        renderLogin('会话已过期，请重新登录');
        return;
      }
      if (!res.ok) {
        state.plugins = [];
        state.notice = '插件列表读取失败：' + describeError(res);
      } else {
        var body = res.data || {};
        state.plugins = Array.isArray(body.plugins) ? body.plugins : [];
        state.notice = '';
      }
      renderDashboard();
    }, function (err) {
      state.plugins = [];
      state.notice = '插件列表请求失败：' + errText(err);
      renderDashboard();
    });
  }

  function start() {
    app.textContent = '';
    app.appendChild(el('div', 'boot', '正在连接内核…'));

    Promise.all([probeHealth(), probeInfo()]).then(function (out) {
      state.health = out[0];
      var info = out[1];

      if (!info.reached) {
        // 网络错误/超时：这才是"后端未连接"。
        state.authed = false;
        renderOffline(info.error);
        return;
      }
      if (info.res.status === 401) {
        // 未登录：渲染登录表单，绝不显示"后端未连接"。
        state.authed = false;
        state.info = null;
        renderLogin('');
        return;
      }
      if (!info.res.ok) {
        state.authed = false;
        var root = el('div');
        root.appendChild(renderTopbar(true));
        var content = el('main', 'content');
        var box = noticeBar('系统信息读取失败：' + describeError(info.res));
        content.appendChild(box);
        root.appendChild(content);
        if (app.replaceChildren) app.replaceChildren(root);
        else { app.innerHTML = ''; app.appendChild(root); }
        return;
      }
      state.authed = true;
      state.info = info.res.data || {};
      loadDashboard();
    });
  }

  start();
})();
