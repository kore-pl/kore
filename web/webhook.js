/* kore 通知通道视图 —— 零框架、零 CDN、零外部资源。
   告警外发：Webhook / 邮件(SMTP) / 企业微信 / 钉钉 / 飞书机器人。
   用户显式配置的出站推送（G-10 例外，见 docs/DECISIONS/0054）：
   页面明说「由你配置的外部地址，Kore 不主动收集任何数据；只有你启用通道且告警触发时才发一条消息」。
   数据只来自 /api/v1/webhook 管理端点；写请求统一带 X-Kore-CSRF 双提交头。
   新建通道默认未启用：先「发送测试」确认能收到，再「启用推送」——外发默认关闭、可随时关闭。
   对外暴露 window.KoreWebhook.mount(rootEl)，由主壳在切到本视图时调用；本文件不自行挂载、不改导航。 */
(function () {
  'use strict';

  var EP = '/api/v1/webhook';
  var TIMEOUT = 10000;
  // 与告警 source 同源的受控事件词表（G-24 显式 schema）。
  var EVENTS = [
    ['audit', '安全与权限告警'],
    ['plugin', '插件异常告警'],
    ['resource', '资源红线告警'],
    ['slot', '常驻槽位告警']
  ];
  var SEVERITIES = [
    ['critical', '严重'],
    ['warning', '警告'],
    ['info', '提示']
  ];
  var EVENT_LABEL = { audit: '安全与权限', plugin: '插件异常', resource: '资源红线', slot: '常驻槽位', webhook_test: '测试事件' };
  var SEV_LABEL = { critical: '严重', warning: '警告', info: '提示' };
  // 渠道类型：webhook / email / wecom / dingtalk / feishu（后三者 API 侧统一为 im + im_kind）。
  var KINDS = [
    ['webhook', 'Webhook（自定义 HTTP 接口）'],
    ['email', '邮件（SMTP）'],
    ['wecom', '企业微信群机器人'],
    ['dingtalk', '钉钉群机器人'],
    ['feishu', '飞书群机器人']
  ];
  var IM_HINT = {
    wecom: '在企业微信群 → 群机器人 → 添加机器人，复制 Webhook 地址。企业微信不需要加签。',
    dingtalk: '在钉钉群 → 群设置 → 机器人 → 自定义，复制 Webhook 地址；安全设置选「加签」时把密钥填到下面。',
    feishu: '在飞书群 → 设置 → 群机器人 → 添加「自定义机器人」，复制 Webhook 地址；开启签名校验时把密钥填到下面。'
  };
  var state = { list: null, error: '', saving: false, notice: '', kind: 'webhook' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
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
  function field(labelText, input, help) {
    var wrap = el('div', 'wh-field');
    var label = el('label', 'wh-label', labelText);
    if (input.id) label.htmlFor = input.id;
    wrap.appendChild(label);
    wrap.appendChild(input);
    if (help) wrap.appendChild(el('small', 'wh-help', help));
    return wrap;
  }
  function input(id, type, placeholder, value) {
    var n = el('input', 'wh-input');
    n.id = id; n.type = type || 'text';
    if (placeholder) n.placeholder = placeholder;
    if (value) n.value = value;
    n.setAttribute('autocomplete', 'off');
    return n;
  }
  function textarea(id, placeholder, rows) {
    var n = el('textarea', 'wh-input wh-textarea');
    n.id = id; n.rows = rows || 3;
    if (placeholder) n.placeholder = placeholder;
    return n;
  }

  function boundaryCard() {
    var box = el('section', 'panel wh-boundary');
    box.appendChild(el('div', 'panel-title', '边界说明 · 你的数据你做主'));
    box.appendChild(el('p', 'wh-boundary-text',
      '告警除了站内铃铛，还可以按你的配置推到你自己的 Webhook、邮箱、企业微信 / 钉钉 / 飞书群。' +
      'Kore 不主动收集任何数据；没有启用任何通道时不会产生一条对外连接。'));
    box.appendChild(el('p', 'wh-boundary-sub',
      '密钥与邮箱口令只保存在当前进程内存（重启面板后需要重新填写），日志与投递记录只记对端主机名和结果，不记完整地址、请求头或口令。' +
      '新建通道默认未启用：先「发送测试」确认能收到，再点「启用推送」。'));
    return box;
  }

  function checks(list, cls, defaultChecked) {
    var wrap = el('div', 'wh-events');
    list.forEach(function (pair) {
      var item = el('label', 'wh-check');
      var cb = el('input');
      cb.type = 'checkbox'; cb.value = pair[0]; cb.className = cls;
      if (defaultChecked) cb.checked = true;
      item.appendChild(cb);
      item.appendChild(el('span', null, pair[1]));
      wrap.appendChild(item);
    });
    return wrap;
  }
  function readChecked(box, cls) {
    var out = [];
    var nodes = box.querySelectorAll('.' + cls);
    for (var i = 0; i < nodes.length; i++) if (nodes[i].checked) out.push(nodes[i].value);
    return out;
  }

  // 按渠道类型显隐字段组（不重建 DOM，保留用户已填内容）。
  function syncGroups(box) {
    var kind = state.kind;
    var groups = box.querySelectorAll('.wh-kind-group');
    for (var i = 0; i < groups.length; i++) {
      groups[i].hidden = groups[i].getAttribute('data-kind') !== kind;
    }
    var imUrlLabel = box.querySelector('#wh-im-url-label');
    var imSecLabel = box.querySelector('#wh-im-secret-label');
    var hint = box.querySelector('#wh-im-hint');
    if (imUrlLabel) imUrlLabel.textContent = kind === 'wecom' ? '机器人 Webhook 地址' : '机器人 Webhook 地址';
    if (imSecLabel) imSecLabel.textContent = kind === 'wecom' ? '加签密钥（企业微信不需要，留空）' : '加签密钥（可选，机器人安全设置选「加签」时填写）';
    if (hint) hint.textContent = IM_HINT[kind] || '';
  }

  function formCard(root) {
    var box = el('section', 'panel');
    box.appendChild(el('div', 'panel-title', '添加通知通道'));

    var kindSel = el('select', 'wh-input');
    kindSel.id = 'wh-kind';
    KINDS.forEach(function (pair) {
      var opt = el('option', null, pair[1]);
      opt.value = pair[0];
      kindSel.appendChild(opt);
    });
    kindSel.value = state.kind;
    kindSel.addEventListener('change', function () {
      state.kind = kindSel.value;
      syncGroups(box);
    });
    box.appendChild(field('渠道类型', kindSel, '告警触发时按这里的类型发送；填错地址不会有任何出站。'));

    box.appendChild(field('名称（可选）', input('wh-name', 'text', '例如：运维群 / 值班邮箱'),
      '留空按渠道类型自动命名，方便在投递记录里认出是哪条通道。'));

    // Webhook 字段组。
    var webhookGroup = el('div', 'wh-kind-group');
    webhookGroup.setAttribute('data-kind', 'webhook');
    webhookGroup.appendChild(field('接收地址（URL）', input('wh-url', 'url', 'https://你的服务/告警钩子'),
      '必须是 http:// 或 https:// 开头的完整地址；Kore 只向这个地址 POST 一条 JSON。'));
    webhookGroup.appendChild(field('密钥（可选）',
      input('wh-secret', 'password', '留空则不发送密钥'),
      '填写后随请求头 X-Kore-Webhook-Token 发送，供你的服务校验来源。'));
    webhookGroup.appendChild(field('自定义请求头（可选）',
      textarea('wh-headers', '每行一条，格式：Name: Value\n例如：X-Env: prod', 2),
      '最多 8 条；Host / Content-Length 等关键请求头不允许自定义。'));
    webhookGroup.appendChild(field('JSON 模板（可选）',
      textarea('wh-template', '{"text":"{{title}}","level":"{{severity}}","at":"{{time}}"}', 3),
      '留空使用默认格式。可用占位符：{{source}} {{severity}} {{title}} {{detail}} {{time}} {{test}}，' +
      '要放在双引号里；替换后必须是合法 JSON。'));
    box.appendChild(webhookGroup);

    // 邮件字段组。
    var emailGroup = el('div', 'wh-kind-group');
    emailGroup.setAttribute('data-kind', 'email');
    var grid = el('div', 'wh-form-grid');
    grid.appendChild(field('SMTP 主机', input('wh-host', 'text', 'smtp.example.com'),
      '只填主机名或 IP，不要带 smtp:// 或路径。'));
    grid.appendChild(field('端口', input('wh-port', 'number', '587'),
      '留空按加密方式默认：STARTTLS 587 / SSL 465 / 明文 25。'));
    var tlsSel = el('select', 'wh-input');
    tlsSel.id = 'wh-tls';
    [['starttls', 'STARTTLS（常用，587）'], ['ssl', 'SSL 直连（465）'], ['none', '明文（25，仅本机中继）']]
      .forEach(function (pair) {
        var opt = el('option', null, pair[1]); opt.value = pair[0]; tlsSel.appendChild(opt);
      });
    grid.appendChild(field('加密方式', tlsSel, '优先用 STARTTLS；服务器只支持 465 时选 SSL。'));
    grid.appendChild(field('账号', input('wh-user', 'text', 'bot@example.com'),
      '不需要认证的中继可留空（口令也要留空）。'));
    grid.appendChild(field('口令', input('wh-pass', 'password', 'SMTP 授权码 / 口令'),
      '只存在进程内存，不回显、不写日志。'));
    grid.appendChild(field('发件人', input('wh-from', 'text', 'bot@example.com'),
      '留空则用账号地址。'));
    grid.appendChild(field('收件人', input('wh-to', 'text', 'ops@example.com, oncall@example.com'),
      '多个收件人用逗号分隔，最多 10 个。'));
    emailGroup.appendChild(grid);
    box.appendChild(emailGroup);

    // IM 字段组。
    var imGroup = el('div', 'wh-kind-group');
    imGroup.setAttribute('data-kind', 'im');
    var imUrlLabelWrap = field('机器人 Webhook 地址', input('wh-im-url', 'url', '机器人详情页里的 Webhook 地址'),
      '三家机器人的地址都是 https:// 开头的完整链接。');
    imUrlLabelWrap.querySelector('label').id = 'wh-im-url-label';
    imGroup.appendChild(imUrlLabelWrap);
    var imSecretWrap = field('加签密钥（可选）', input('wh-im-secret', 'password', '机器人安全设置里的加签密钥'),
      '钉钉 / 飞书开启「加签」时必填；企业微信不需要。');
    imSecretWrap.querySelector('label').id = 'wh-im-secret-label';
    imGroup.appendChild(imSecretWrap);
    var hint = el('p', 'wh-hint', IM_HINT[state.kind] || '');
    hint.id = 'wh-im-hint';
    imGroup.appendChild(hint);
    box.appendChild(imGroup);

    box.appendChild(el('div', 'wh-subhead', '推送哪些告警'));
    box.appendChild(checks(EVENTS, 'wh-event-cb', true));
    box.appendChild(el('div', 'wh-subhead', '按级别推送'));
    box.appendChild(checks(SEVERITIES, 'wh-sev-cb', true));

    var actions = el('div', 'wh-actions');
    var save = el('button', 'wh-btn wh-btn-primary', '保存通道（默认不启用）');
    save.type = 'button';
    save.disabled = !!state.saving;
    save.addEventListener('click', function () {
      var payload = buildPayload(box);
      if (typeof payload === 'string') { setNotice(root, payload); return; }
      state.saving = true; save.disabled = true;
      request(EP, { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(payload) })
        .then(function (res) {
          state.saving = false;
          if (!res.ok) { setNotice(root, errText(res, '保存失败，请检查填写内容后重试')); return; }
          setNotice(root, '通道已保存，当前未启用。点「发送测试」确认能收到，再点「启用推送」。');
          load(root);
        }, function () {
          state.saving = false;
          setNotice(root, '网络异常，保存失败，请重试');
          render(root);
        });
    });
    actions.appendChild(save);
    box.appendChild(actions);
    syncGroups(box);
    return box;
  }

  // buildPayload 返回请求体对象，或返回一段给用户看的错误提示。
  function buildPayload(box) {
    var kind = state.kind;
    var name = (box.querySelector('#wh-name').value || '').trim();
    var events = readChecked(box, 'wh-event-cb');
    var severities = readChecked(box, 'wh-sev-cb');
    if (events.length === 0) return '请至少选择一种要推送的告警类型';
    if (severities.length === 0) return '请至少选择一个告警级别';
    var payload = { name: name, events: events, severities: severities };
    if (kind === 'webhook') {
      var url = (box.querySelector('#wh-url').value || '').trim();
      if (!url) return '请填写你的接收地址（URL）';
      payload.kind = 'webhook';
      payload.url = url;
      payload.secret = box.querySelector('#wh-secret').value || '';
      var headers = parseHeaders(box.querySelector('#wh-headers').value || '');
      if (typeof headers === 'string') return headers;
      payload.headers = headers;
      payload.template = (box.querySelector('#wh-template').value || '').trim();
      return payload;
    }
    if (kind === 'email') {
      var host = (box.querySelector('#wh-host').value || '').trim();
      if (!host) return '请填写 SMTP 主机地址';
      var to = (box.querySelector('#wh-to').value || '').split(',').map(function (s) { return s.trim(); })
        .filter(function (s) { return s !== ''; });
      if (to.length === 0) return '请至少填写一个收件人邮箱';
      payload.kind = 'email';
      payload.email = {
        host: host,
        port: parseInt(box.querySelector('#wh-port').value, 10) || 0,
        tls: box.querySelector('#wh-tls').value,
        user: (box.querySelector('#wh-user').value || '').trim(),
        password: box.querySelector('#wh-pass').value || '',
        from: (box.querySelector('#wh-from').value || '').trim(),
        recipients: to
      };
      return payload;
    }
    var imURL = (box.querySelector('#wh-im-url').value || '').trim();
    if (!imURL) return '请填写机器人 Webhook 地址';
    payload.kind = 'im';
    payload.im_kind = kind;
    payload.url = imURL;
    payload.secret = box.querySelector('#wh-im-secret').value || '';
    return payload;
  }

  // parseHeaders 把「Name: Value」多行文本转成 [{name,value}]；格式错误返回提示字符串。
  function parseHeaders(raw) {
    var lines = raw.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var idx = line.indexOf(':');
      if (idx <= 0) return '请求头第 ' + (i + 1) + ' 行格式不对，应写成「名称: 值」';
      out.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
    }
    return out;
  }

  function targetHead(t) {
    var head = el('div', 'wh-row-head');
    var badge = el('span', 'wh-kind-badge wh-kind-' + t.kind,
      t.kind === 'webhook' ? 'Webhook' : (t.kind === 'email' ? '邮件' : (t.im && t.im.kind === 'wecom' ? '企业微信' : (t.im && t.im.kind === 'dingtalk' ? '钉钉' : '飞书'))));
    head.appendChild(badge);
    head.appendChild(el('span', 'wh-target-name', t.name || '未命名通道'));
    head.appendChild(el('span', 'wh-status ' + (t.enabled ? 'wh-status-on' : 'wh-status-off'),
      t.enabled ? '已启用' : '未启用'));
    return head;
  }
  function targetMeta(t) {
    var meta = el('div', 'wh-target-meta');
    if (t.kind === 'email' && t.email) {
      meta.appendChild(el('span', 'wh-target-url', t.email.host + ':' + t.email.port +
        '（' + (t.email.recipients || []).length + ' 个收件人）'));
      meta.appendChild(el('span', 'wh-target-events', '推送：' +
        (t.events || []).map(function (e) { return EVENT_LABEL[e] || e; }).join('、') +
        '　级别：' + (t.severities || []).map(function (s) { return SEV_LABEL[s] || s; }).join('、')));
      return meta;
    }
    meta.appendChild(el('span', 'wh-target-url', t.url));
    var extra = '推送：' + (t.events || []).map(function (e) { return EVENT_LABEL[e] || e; }).join('、') +
      '　级别：' + (t.severities || []).map(function (s) { return SEV_LABEL[s] || s; }).join('、');
    if (t.kind === 'im') extra += '　加签：' + (t.secret_set ? '已设置' : '未设置');
    if (t.kind === 'webhook' && t.headers && t.headers.length) extra += '　自定义请求头：' + t.headers.length + ' 条';
    meta.appendChild(el('span', 'wh-target-events', extra));
    return meta;
  }

  function targetsCard(root) {
    var box = el('section', 'panel');
    var targets = (state.list && state.list.targets) || [];
    box.appendChild(el('div', 'panel-title', '已配置通道（' + targets.length + '）'));
    if (targets.length === 0) {
      box.appendChild(el('p', 'wh-hint', '还没有配置任何通道。添加后先点「发送测试」，确认能收到再启用；没有启用时告警只在站内显示。'));
      return box;
    }
    targets.forEach(function (t) {
      var row = el('div', 'wh-target');
      var info = el('div', 'wh-target-info');
      info.appendChild(targetHead(t));
      info.appendChild(targetMeta(t));
      row.appendChild(info);

      var ops = el('div', 'wh-target-ops');
      var test = el('button', 'wh-btn', '发送测试');
      test.type = 'button';
      test.addEventListener('click', function () {
        request(EP + '/' + encodeURIComponent(t.id) + '/test', {
          method: 'POST', headers: csrfHeaders(), body: '{}'
        }).then(function (res) {
          if (!res.ok) { setNotice(root, errText(res, '测试请求失败，请重试')); return; }
          setNotice(root, '测试消息已发出，结果到下方「投递记录」查看（失败会写明原因）。');
          setTimeout(function () { load(root); }, 900);
        }, function () { setNotice(root, '网络异常，测试请求失败'); });
      });
      var toggle = el('button', 'wh-btn' + (t.enabled ? '' : ' wh-btn-primary'),
        t.enabled ? '停用推送' : '启用推送');
      toggle.type = 'button';
      toggle.addEventListener('click', function () {
        request(EP + '/' + encodeURIComponent(t.id), {
          method: 'PATCH', headers: csrfHeaders(),
          body: JSON.stringify({ enabled: !t.enabled })
        }).then(function (res) {
          if (!res.ok) { setNotice(root, errText(res, '操作失败，请重试')); return; }
          setNotice(root, t.enabled ? '已停用：这条通道不再发送告警。' : '已启用：符合条件的新告警会推送到这条通道。');
          load(root);
        }, function () { setNotice(root, '网络异常，操作失败'); });
      });
      var del = el('button', 'wh-btn wh-btn-danger', '删除');
      del.type = 'button';
      del.addEventListener('click', function () {
        if (!window.confirm('确定删除这条通知通道？删除后将不再向它发送任何消息。')) return;
        request(EP + '/' + encodeURIComponent(t.id), { method: 'DELETE', headers: csrfHeaders() })
          .then(function (res) {
            if (!res.ok) { setNotice(root, errText(res, '删除失败，请重试')); return; }
            setNotice(root, '通道已删除。');
            load(root);
          }, function () { setNotice(root, '网络异常，删除失败'); });
      });
      ops.appendChild(test); ops.appendChild(toggle); ops.appendChild(del);
      row.appendChild(ops);
      box.appendChild(row);
    });
    return box;
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return iso || '—';
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function historyCard() {
    var box = el('section', 'panel');
    box.appendChild(el('div', 'panel-title', '投递记录（最近 200 条）'));
    var history = (state.list && state.list.history) || [];
    if (history.length === 0) {
      box.appendChild(el('p', 'wh-hint', '还没有投递记录。告警触发或点「发送测试」后会出现在这里；失败会写明原因。'));
      return box;
    }
    var wrap = el('div', 'wh-history-wrap');
    var table = el('table', 'wh-history');
    var head = el('tr');
    ['时间', '通道', '级别', '事件', '结果', '尝试'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    history.slice().reverse().forEach(function (d) {
      var tr = el('tr');
      tr.appendChild(el('td', null, fmtTime(d.at)));
      tr.appendChild(el('td', null, d.name || d.target_id));
      tr.appendChild(el('td', null, SEV_LABEL[d.severity] || d.severity || '—'));
      tr.appendChild(el('td', null, EVENT_LABEL[d.event] || d.event));
      var status = el('td', null, d.status === 'ok' ? '成功' : ('失败' + (d.err ? '：' + d.err : '')));
      if (d.status !== 'ok') status.className = 'wh-status-fail';
      tr.appendChild(status);
      tr.appendChild(el('td', null, d.attempts));
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    box.appendChild(wrap);
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
