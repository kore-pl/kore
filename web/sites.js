/* kore 主壳 · 网站管理（web/sites.js）
   入口 window.KoreSites.render(container)，零框架 / 零 CDN / 无外链。
   调 site 插件：site.create / site.delete / site.list / site.status，写请求带 X-Kore-CSRF。
   结果只展示插件真实字段（test_passed / reloaded / applied / backup_path / test_output），
   不把"配置写过了"说成"站点已生效"。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/site/';
  var S = { sites: [], detail: null };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(API + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) throw new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        return data;
      });
    });
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    if (tone === 'ok' || tone === 'warn' || tone === 'fail') dot.classList.add(tone);
    c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function flag(value, skipped, yes, no) {
    if (skipped) return chip('na', '已跳过');
    return value ? chip('ok', yes) : chip('fail', no);
  }
  function setStatus(text, tone) {
    if (!S.status) return;
    S.status.textContent = text;
    S.status.className = 'site-status ' + (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function row(label, value) {
    var tr = el('tr');
    tr.appendChild(el('th', null, label));
    var td = el('td');
    if (value && value.nodeType === 1) td.appendChild(value);
    else td.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    tr.appendChild(td); return tr;
  }
  function showResult(title, data, failed) {
    if (!S.resultHost) return;
    var box = el('section', 'panel site-result' + (failed ? ' site-result-fail' : ''));
    var head = add(box, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', title));
    add(head, el('span', 'panel-meta', failed ? '未完成' : '插件返回'));
    if (failed) {
      add(box, el('div', 'site-result-error', data.message || '操作未完成'));
      S.resultHost.replaceChildren(box);
      return;
    }
    var table = add(box, el('table', 'rows'));
    table.appendChild(row('域名', data.domain || '—'));
    if (data.vhost_path) table.appendChild(row('vhost 路径', el('span', 'mono', data.vhost_path)));
    if (data.backup_path) table.appendChild(row('备份路径', el('span', 'mono', data.backup_path)));
    table.appendChild(row('nginx -t', flag(data.test_passed, data.test_skipped, '通过', '未通过')));
    table.appendChild(row('已 reload', flag(data.reloaded, data.reload_skipped, '已重载', '未重载')));
    if (data.applied !== undefined) table.appendChild(row('整体生效', flag(data.applied, false, '已生效', '未生效')));
    if (data.created !== undefined) table.appendChild(row('新建片段', data.created ? '是' : '否（覆盖已有）'));
    if (data.deleted !== undefined) table.appendChild(row('已删除', data.deleted ? '是' : '无托管站点可删'));
    S.resultHost.replaceChildren(box);
  }
  function confirmBox(text, onOk) {
    var mask = el('div', 'kore-modal');
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
    var box = add(mask, el('div', 'kore-modal-box'));
    add(box, el('div', 'kore-modal-title', '删除确认'));
    add(box, el('p', 'kore-modal-text', text));
    var msg = add(box, el('div', 'kore-modal-msg'));
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary', '确认删除')); ok.type = 'button';
    function close() {
      document.removeEventListener('keydown', esc);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }
    function esc(ev) { if (ev.key === 'Escape') close(); }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', esc);
    ok.addEventListener('click', function () { ok.disabled = true; onOk(close, msg, ok); });
    document.body.appendChild(mask);
  }
  function removeSite(domain) {
    confirmBox('将删除站点 ' + domain + ' 的托管 vhost 并 reload nginx；插件会先备份原 vhost。', function (close, msg, ok) {
      invoke('site.delete', { domain: domain }).then(function (data) {
        close();
        showResult('删除结果 · ' + domain, data, false);
        setStatus('已处理删除：' + domain, 'ok');
        if (S.detail && S.detail.domain === domain) { S.detail = null; paintDetail(); }
        load();
      }, function (err) {
        ok.disabled = false;
        msg.textContent = err.message;
        showResult('删除失败 · ' + domain, err, true);
      });
    });
  }
  function showDetail(domain) {
    invoke('site.status', { domain: domain }).then(function (data) {
      S.detail = data; paintDetail();
      setStatus('已读取 ' + domain + ' 的生效状态', 'ok');
    }, function (err) { showResult('状态读取失败 · ' + domain, err, true); });
  }
  function paintDetail() {
    if (!S.detailHost) return;
    var d = S.detail;
    S.detailHost.textContent = '';
    if (!d) return;
    var box = add(S.detailHost, el('section', 'panel site-detail'));
    var head = add(box, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', '站点状态 · ' + d.domain));
    var close = add(head, el('button', 'btn btn-ghost', '收起'));
    close.type = 'button';
    on(close, function () { S.detail = null; paintDetail(); });
    var table = add(box, el('table', 'rows'));
    table.appendChild(row('在插件清单内', d.managed ? '是' : '否'));
    table.appendChild(row('vhost 文件', d.conf_exists ? '存在' : '缺失'));
    table.appendChild(row('站点根目录', d.site_dir_exists ? '存在' : '缺失或未配置'));
    table.appendChild(row('nginx -t', flag(d.test_passed, d.test_skipped, '通过', '未通过')));
    table.appendChild(row('已被 nginx 加载', d.load_checked ? (d.loaded ? '是' : '否') : '未检查'));
    if (d.test_output) {
      var pre = el('pre', 'site-test-output', d.test_output);
      table.appendChild(row('nginx -t 输出', pre));
    }
  }
  function paintList() {
    if (!S.listHost) return;
    S.listHost.textContent = '';
    if (S.listMeta) S.listMeta.textContent = S.sites.length ? '共 ' + S.sites.length + ' 个站点' : '';
    if (!S.sites.length) {
      var empty = add(S.listHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '还没有站点，创建第一个站点'));
      return;
    }
    var table = add(S.listHost, el('table', 'sites-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    ['域名', '生效状态', '操作'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.sites.forEach(function (site) {
      var tr = add(body, el('tr'));
      var domain = add(tr, el('td', 'site-domain'));
      domain.dataset.label = '域名';
      add(domain, el('span', 'mono', site.domain));
      var state = add(tr, el('td', 'site-state'));
      state.dataset.label = '生效状态';
      state.appendChild(flag(site.exists, false, 'vhost 存在', 'vhost 缺失'));
      state.appendChild(flag(site.test_ok, false, 'nginx -t 通过', 'nginx -t 未通过'));
      state.appendChild(flag(site.reloaded, false, '已加载', '未加载'));
      var ops = add(tr, el('td', 'cell-ops'));
      ops.dataset.label = '操作';
      var detail = add(ops, el('button', 'btn', '查看状态')); detail.type = 'button';
      on(detail, function () { showDetail(site.domain); });
      var del = add(ops, el('button', 'btn btn-ghost sites-del', '删除')); del.type = 'button';
      on(del, function () { removeSite(site.domain); });
    });
  }
  function load() {
    setStatus('正在读取站点列表…');
    return invoke('site.list', {}).then(function (data) {
      S.sites = Array.isArray(data.sites) ? data.sites : [];
      paintList();
      setStatus(S.sites.length ? '站点列表已刷新' : '还没有站点，创建第一个站点', 'ok');
    }, function (err) { setStatus('站点列表读取失败：' + err.message, 'fail'); });
  }
  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '网站管理'));
    add(head, el('p', 'view-sub', '创建站点 vhost，查看 nginx 校验与重载的真实结果。'));
    S.resultHost = add(root, el('div', 'site-result-host'));
    var formPanel = add(root, el('section', 'panel'));
    var formHead = add(formPanel, el('div', 'panel-head'));
    add(formHead, el('span', 'panel-title', '创建站点'));
    add(formHead, el('span', 'panel-meta', '写入后执行 nginx -t 与 reload'));
    var form = add(formPanel, el('form', 'site-form'));
    var domainField = add(form, el('label', 'field'));
    add(domainField, el('span', 'field-label', '域名（小写，至少两个标签）'));
    var domain = add(domainField, el('input', 'field-input'));
    domain.type = 'text'; domain.placeholder = 'example.com'; domain.autocomplete = 'off';
    var rootField = add(form, el('label', 'field'));
    add(rootField, el('span', 'field-label', '站点根目录（可选，留空自动生成）'));
    var siteRoot = add(rootField, el('input', 'field-input'));
    siteRoot.type = 'text'; siteRoot.placeholder = '/var/www/example.com'; siteRoot.autocomplete = 'off';
    var submit = add(form, el('button', 'btn btn-primary site-submit', '创建站点'));
    submit.type = 'submit';
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var d = domain.value.trim().toLowerCase();
      if (!d) { setStatus('请填写域名', 'fail'); domain.focus(); return; }
      var body = { domain: d };
      if (siteRoot.value.trim()) body.root = siteRoot.value.trim();
      submit.disabled = true;
      setStatus('正在创建 ' + d + '…');
      invoke('site.create', body).then(function (data) {
        submit.disabled = false;
        domain.value = '';
        showResult('创建结果 · ' + d, data, false);
        setStatus('已创建 ' + d + '；请核对 nginx -t 与 reload 字段', 'ok');
        load();
      }, function (err) {
        submit.disabled = false;
        showResult('创建失败 · ' + d, err, true);
        setStatus('创建失败：' + err.message, 'fail');
      });
    });
    S.status = add(root, el('div', 'site-status muted'));
    S.status.setAttribute('role', 'status');
    var listPanel = add(root, el('section', 'panel'));
    var listHead = add(listPanel, el('div', 'panel-head'));
    add(listHead, el('span', 'panel-title', '站点列表'));
    S.listMeta = add(listHead, el('span', 'panel-meta', ''));
    var refresh = add(listHead, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, load);
    S.listHost = add(listPanel, el('div', 'sites-list-host'));
    S.detailHost = add(root, el('div', 'site-detail-host'));
  }
  function render(container) {
    if (!container) return null;
    container.textContent = '';
    S.sites = []; S.detail = null;
    var root = add(container, el('section', 'sites'));
    build(root);
    load();
  }
  window.KoreSites = { render: render };
})();
