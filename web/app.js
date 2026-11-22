/* kore 主壳前端 —— 原生 JS，零依赖。
   启动即拉 /-/healthz 与 /api/v1/system/info，任一失败走降级渲染，绝不白屏。
   状态一律「点 + 文本」双通道（FRONTEND §6 红线 9）；禁止 console.log。
   插件 UI 走独立 origin iframe + postMessage 桥（裁决40/41），不进主壳 realm。 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  if (!app) return;

  var ENDPOINTS = {
    health: '/-/healthz',
    info: '/api/v1/system/info',
    plugins: '/api/v1/plugins'
  };
  var REQUEST_TIMEOUT_MS = 5000;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fetchJson(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
    var init = { headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (ctrl) init.signal = ctrl.signal;

    return fetch(url, init).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (raw) {
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch (e) {
        // healthz 等端点可能返回纯文本（如 "ok"），按成功处理，避免误报降级
        return { raw: raw };
      }
    }).then(function (data) {
      if (timer !== null) clearTimeout(timer);
      return data;
    }).catch(function (err) {
      if (timer !== null) clearTimeout(timer);
      throw err;
    });
  }

  function stateOf(res) {
    if (res.status === 'rejected') return { cls: 'fail', text: '异常' };
    if (res.value && res.value.ok === false) return { cls: 'fail', text: '异常' };
    var body = res.value || {};
    var status = body.status || body.state || body.data;
    if (status === 'degraded') return { cls: 'warn', text: '降级' };
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

  function statusTag(state) {
    var wrap = el('span', 'tag');
    wrap.appendChild(el('span', 'dot ' + state.cls));
    wrap.appendChild(el('span', null, state.text));
    return wrap;
  }

  function panel(title, meta, rows) {
    var box = el('section', 'panel');
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', title));
    if (meta) head.appendChild(el('span', 'panel-meta', meta));
    box.appendChild(head);
    var table = el('table', 'rows');
    for (var i = 0; i < rows.length; i++) table.appendChild(rows[i]);
    box.appendChild(table);
    return box;
  }

  function degraded(message) {
    var box = el('div', 'notice');
    box.appendChild(el('span', 'dot warn notice-dot'));
    var text = el('div');
    text.appendChild(el('div', 'notice-title', '后端未连接'));
    text.appendChild(el('div', 'notice-hint', message + '；页面以降级模式展示，不阻断静态访问。'));
    box.appendChild(text);
    return box;
  }

  function renderTopbar(health, info) {
    var bar = el('header', 'topbar');
    var brand = el('div', 'brand');
    brand.appendChild(el('span', 'brand-name', 'kore'));
    brand.appendChild(el('span', 'brand-sub', '控制台 · 系统态势'));
    var conn = el('div', 'conn');
    conn.appendChild(statusTag(health));
    conn.appendChild(el('span', null, '健康检查'));
    conn.appendChild(statusTag(info));
    conn.appendChild(el('span', null, '系统信息'));
    bar.appendChild(brand);
    bar.appendChild(conn);
    return bar;
  }

  function renderHealth(health) {
    var rows = [];
    rows.push(row('状态', statusTag(health)));
    if (health.status === 'fulfilled') {
      var body = health.value || {};
      rows.push(row('详情', body.raw || (typeof body.status === 'string' ? body.status : (body.message || '—'))));
    } else {
      rows.push(row('详情', (health.reason && health.reason.message) || '请求失败'));
    }
    return panel('健康检查', ENDPOINTS.health, rows);
  }

  function renderInfo(info) {
    var rows = [];
    rows.push(row('状态', statusTag(info)));
    if (info.status === 'fulfilled') {
      var body = info.value || {};
      var data = body.data && typeof body.data === 'object' ? body.data : body;
      rows.push(row('版本', data.version || data.kore_version || '—'));
      rows.push(row('运行态', data.mode || data.runtime || '—'));
      rows.push(row('说明', data.message || (body.message || '—')));
    } else {
      rows.push(row('详情', (info.reason && info.reason.message) || '请求失败'));
    }
    return panel('系统信息', ENDPOINTS.info, rows);
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
      list.appendChild(el('div', 'notice-hint', '暂无声明 web 入口且已启用的插件；插件 UI 按需挂载，不进首屏。'));
    }
    content.appendChild(box);
  }

  function render(results) {
    var health = stateOf(results[0]);
    var info = stateOf(results[1]);
    var root = el('div');
    root.appendChild(renderTopbar(health, info));

    var content = el('main', 'content');
    if (results[0].status === 'rejected' || results[1].status === 'rejected') {
      content.appendChild(degraded('健康检查或系统信息不可达'));
    }
    content.appendChild(renderHealth(results[0]));
    content.appendChild(renderInfo(results[1]));
    renderPluginUis(content, results[2]);
    root.appendChild(content);

    var retry = el('button', null, '重新检测');
    retry.type = 'button';
    var meta = el('div', 'panel-meta');
    meta.appendChild(retry);
    content.appendChild(meta);
    retry.addEventListener('click', start);

    app.replaceChildren ? app.replaceChildren(root) : (app.innerHTML = '', app.appendChild(root));
  }

  function start() {
    app.textContent = '';
    app.appendChild(el('div', 'boot', '正在检测后端…'));
    Promise.all([
      fetchJson(ENDPOINTS.health).then(
        function (v) { return { status: 'fulfilled', value: v }; },
        function (e) { return { status: 'rejected', reason: e }; }
      ),
      fetchJson(ENDPOINTS.info).then(
        function (v) { return { status: 'fulfilled', value: v }; },
        function (e) { return { status: 'rejected', reason: e }; }
      ),
      fetchJson(ENDPOINTS.plugins).then(
        function (v) { return { status: 'fulfilled', value: v }; },
        function (e) { return { status: 'rejected', reason: e }; }
      )
    ]).then(render);
  }

  start();
})();
