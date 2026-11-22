/* kore 主壳前端 —— 原生 JS，零依赖。
   启动即拉 /-/healthz 与 /api/v1/system/info，任一失败走降级渲染，绝不白屏。
   状态一律「点 + 文本」双通道（FRONTEND §6 红线 9）；禁止 console.log。 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  if (!app) return;

  var ENDPOINTS = {
    health: '/-/healthz',
    info: '/api/v1/system/info'
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
      )
    ]).then(render);
  }

  start();
})();
