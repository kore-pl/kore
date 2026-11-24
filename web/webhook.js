/* kore 通知通道视图 —— 零框架、零 CDN、零外部资源。
   用户显式配置的出站 Webhook（G-10 例外，见 docs/DECISIONS/0054）：
   页面明说「由你配置的外部地址，Kore 不主动收集任何数据；只有你启用且告警触发时才 POST 一条消息」。
   数据只来自 /api/v1/webhook 管理端点；写请求统一带 X-Kore-CSRF 双提交头。
   对外暴露 window.KoreWebhook.mount(rootEl)，由主壳在切到本视图时调用；本文件不自行挂载、不改导航。 */
(function () {
  'use strict';

  var EP = '/api/v1/webhook';
  var TIMEOUT = 5000;
  // 与告警 source 同源的受控事件词表（G-24 显式 schema）。
  var EVENTS = [
    ['audit', '安全与权限告警'],
    ['plugin', '插件异常告警'],
    ['resource', '资源红线告警'],
    ['slot', '常驻槽位告警']
  ];
  var EVENT_LABEL = {
    audit: '安全与权限', plugin: '插件异常', resource: '资源红线', slot: '常驻槽位',
    webhook_test: '测试事件'
  };
  var state = { list: null, error: '', saving: false, notice: '' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  // 视图样式按需注入，不进首屏六件套（与 onboarding.js 同范式）。
  function ensureCss() {
    if (document.getElementById('kore-webhook-css')) return;
    var link = el('link');
    link.id = 'kore-webhook-css';
    link.rel = 'stylesheet';
    link.href = '/assets/webhook.css';
    document.head.appendChild(link);
  }
  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function csrfHeaders() {
    return { 'X-Kore-CSRF': readCookie('kore_csrf'), 'Content-Type': 'application/json' };
  }
  function request(url, init) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var opts = {
      method: (init && init.method) || 'GET', credentials: 'same-origin',
      headers: (init && init.headers) || {}, cache: 'no-store'
    };
    if (ctrl) opts.signal = ctrl.signal;
    if (init && init.body !== undefined) opts.body = init.body;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT) : null;
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (raw) {
        if (timer) clearTimeout(timer);
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        return { status: res.status, ok: res.ok, data: data };
      });
    }, function (err) { if (timer) clearTimeout(timer); throw err; });
  }
  // 从统一错误包里取人话（不展示接口路径/文档章节，G-33 A4）。
  function errText(res, fallback) {
    var d = res && res.data;
    return (d && (d.message || d.detail)) || fallback;
  }

  function load(root) {
    request(EP).then(function (res) {
      if (!res.ok) { state.error = errText(res, '读取通知通道失败，请刷新重试'); render(root); return; }
      state.list = res.data || { targets: [], history: [] };
      state.error = '';
      render(root);
    }, function () {
      state.error = '网络异常，读取通知通道失败，请检查本机连接后重试';
      render(root);
    });
  }

  function noticeBox() {
    var box = el('div', 'wh-notice' + (state.notice ? '' : ' wh-notice-hidden'));
    box.textContent = state.notice || '';
    return box;
  }
  function setNotice(root, text) {
    state.notice = text;
    render(root);
  }

  function boundaryCard() {
    var box = el('section', 'panel wh-boundary');
    box.appendChild(el('div', 'panel-title', '边界说明 · 你的数据你做主'));
    box.appendChild(el('p', 'wh-boundary-text',
      '由你配置的外部地址，Kore 不主动收集任何数据。只有当你在这里启用通道、并且告警实际触发时，Kore 才会向该地址 POST 一条告警消息；没有配置就不会产生任何对外连接。'));
    box.appendChild(el('p', 'wh-boundary-sub',
      '密钥只保存在当前进程内存中，重启后需要重新填写；日志不会记录完整地址或密钥。'));
    return box;
  }

  function formCard(root) {
    var box = el('section', 'panel');
    box.appendChild(el('div', 'panel-title', '添加通知通道'));
    box.appendChild(el('p', 'wh-hint', '填写你自己的接收地址，选择要推送的事件类型；可留空密钥。'));

    var urlLabel = el('label', 'wh-label', '接收地址（URL）');
    urlLabel.htmlFor = 'wh-url';
    var url = el('input', 'wh-input');
    url.id = 'wh-url'; url.type = 'url'; url.placeholder = '填写你自己的接收地址，例如 你的服务地址/钩子路径';
    url.setAttribute('autocomplete', 'off');
    box.appendChild(urlLabel); box.appendChild(url);

    var secretLabel = el('label', 'wh-label', '密钥（可选，作为请求头 X-Kore-Webhook-Token 发送）');
    secretLabel.htmlFor = 'wh-secret';
    var secret = el('input', 'wh-input');
    secret.id = 'wh-secret'; secret.type = 'password'; secret.placeholder = '留空则不发送密钥';
    secret.setAttribute('autocomplete', 'new-password');
    box.appendChild(secretLabel); box.appendChild(secret);

    box.appendChild(el('div', 'wh-label', '推送事件（至少选一项）'));
    var checks = el('div', 'wh-events');
    EVENTS.forEach(function (pair) {
      var wrap = el('label', 'wh-check');
      var cb = el('input');
      cb.type = 'checkbox'; cb.value = pair[0]; cb.className = 'wh-event-cb';
      wrap.appendChild(cb);
      wrap.appendChild(el('span', null, pair[1]));
      checks.appendChild(wrap);
    });
    box.appendChild(checks);

    var actions = el('div', 'wh-actions');
    var save = el('button', 'wh-btn wh-btn-primary', '保存通道');
    save.type = 'button';
    save.disabled = !!state.saving;
    save.addEventListener('click', function () {
      var events = [];
      var nodes = box.querySelectorAll('.wh-event-cb');
      for (var i = 0; i < nodes.length; i++) if (nodes[i].checked) events.push(nodes[i].value);
      var payload = { url: url.value.trim(), events: events, secret: secret.value };
      if (!payload.url || events.length === 0) {
        setNotice(root, '请填写接收地址，并至少选择一种事件类型');
        return;
      }
      state.saving = true; save.disabled = true;
      request(EP, { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(payload) })
        .then(function (res) {
          state.saving = false;
          if (!res.ok) { setNotice(root, errText(res, '保存失败，请检查地址格式后重试')); return; }
          setNotice(root, '通道已保存。可点「测试」发送一条测试消息。');
          load(root);
        }, function () {
          state.saving = false;
          setNotice(root, '网络异常，保存失败，请重试');
          render(root);
        });
    });
    actions.appendChild(save);
    box.appendChild(actions);
    return box;
  }

  function targetsCard(root) {
    var box = el('section', 'panel');
    box.appendChild(el('div', 'panel-title',
      '已配置通道' + (state.list && state.list.targets ? '（' + state.list.targets.length + '）' : '')));
    var targets = (state.list && state.list.targets) || [];
    if (targets.length === 0) {
      box.appendChild(el('p', 'wh-hint', '还没有配置任何通道。添加后，告警触发时才会向外推送。'));
      return box;
    }
    targets.forEach(function (t) {
      var row = el('div', 'wh-target');
      var meta = el('div', 'wh-target-meta');
      meta.appendChild(el('span', 'wh-target-url', t.url));
      var evs = (t.events || []).map(function (e) { return EVENT_LABEL[e] || e; }).join('、');
      meta.appendChild(el('span', 'wh-target-events', '事件：' + (evs || '—') + '　密钥：' + (t.secret_set ? '已设置' : '未设置')));
      row.appendChild(meta);

      var ops = el('div', 'wh-target-ops');
      var test = el('button', 'wh-btn', '测试');
      test.type = 'button';
      test.addEventListener('click', function () {
        request(EP + '/' + encodeURIComponent(t.id) + '/test', {
          method: 'POST', headers: csrfHeaders(), body: '{}'
        }).then(function (res) {
          if (!res.ok) { setNotice(root, errText(res, '测试请求失败，请重试')); return; }
          setNotice(root, '测试消息已发出，结果可在下方「投递记录」查看。');
          setTimeout(function () { load(root); }, 800);
        }, function () { setNotice(root, '网络异常，测试请求失败'); });
      });
      var del = el('button', 'wh-btn wh-btn-danger', '删除');
      del.type = 'button';
      del.addEventListener('click', function () {
        if (!window.confirm('确定删除这条通知通道？删除后将不再向该地址推送。')) return;
        request(EP + '/' + encodeURIComponent(t.id), { method: 'DELETE', headers: csrfHeaders() })
          .then(function (res) {
            if (!res.ok) { setNotice(root, errText(res, '删除失败，请重试')); return; }
            setNotice(root, '通道已删除。');
            load(root);
          }, function () { setNotice(root, '网络异常，删除失败'); });
      });
      ops.appendChild(test); ops.appendChild(del);
      row.appendChild(ops);
      box.appendChild(row);
    });
    return box;
  }

  function historyCard() {
    var box = el('section', 'panel');
    box.appendChild(el('div', 'panel-title', '投递记录（最近 200 条）'));
    var history = (state.list && state.list.history) || [];
    if (history.length === 0) {
      box.appendChild(el('p', 'wh-hint', '还没有投递记录。告警触发或点「测试」后会出现在这里。'));
      return box;
    }
    var table = el('table', 'wh-history');
    var head = el('tr');
    ['时间', '事件', '目标', '结果', '尝试次数'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    history.slice().reverse().forEach(function (d) {
      var tr = el('tr');
      tr.appendChild(el('td', null, d.at));
      tr.appendChild(el('td', null, EVENT_LABEL[d.event] || d.event));
      tr.appendChild(el('td', null, d.target_ref || d.target_id));
      var status = el('td', null, d.status === 'ok' ? '成功' : ('失败' + (d.err ? '：' + d.err : '')));
      if (d.status !== 'ok') status.className = 'wh-status-fail';
      tr.appendChild(status);
      tr.appendChild(el('td', null, d.attempts));
      table.appendChild(tr);
    });
    box.appendChild(table);
    return box;
  }

  function render(root) {
    root.textContent = '';
    root.appendChild(el('h2', 'view-title', '通知通道'));
    if (state.error) {
      var err = el('div', 'wh-error', state.error);
      var retry = el('button', 'wh-btn', '重试');
      retry.type = 'button';
      retry.addEventListener('click', function () { load(root); });
      err.appendChild(retry);
      root.appendChild(err);
      return;
    }
    root.appendChild(noticeBox());
    root.appendChild(boundaryCard());
    root.appendChild(formCard(root));
    root.appendChild(targetsCard(root));
    root.appendChild(historyCard());
  }

  window.KoreWebhook = {
    // 主壳 SHELL_VIEWS 约定：render(container) → {destroy}；与 settings/alerts 等视图一致。
    render: function (rootEl) {
      if (!rootEl) return { destroy: function () {} };
      ensureCss();
      state.list = null; state.error = ''; state.notice = '';
      render(rootEl);
      load(rootEl);
      return { destroy: function () { state.notice = ''; } };
    },
    // 兼容早期口头约定的 mount 别名（无副作用，仅转发）。
    mount: function (rootEl) { return this.render(rootEl); }
  };
})();
