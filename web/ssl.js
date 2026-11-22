/* kore 主壳 · TLS 证书管理（web/ssl.js）——零框架 / 零 CDN / 无外链。
   window.KoreSsl.render(container) 调 ssl 插件：list / selfsign / import / renew / verify。
   私钥只经 password 输入框粘贴，内容留在内存变量、提交后清空；不回显、不写日志、不落 localStorage。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/ssl/';
  function fresh() {
    return { certs: [], destroyed: false, status: null, verifyHost: null, verifyOut: null, createDomain: null,
      createDays: null, createKey: null, importDomain: null, importCert: null, importKey: null,
      importChain: null, keyPEM: '', keyNote: null, busy: false };
  }
  var S = fresh();
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
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || '';
          throw err;
        }
        return data;
      });
    });
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function setStatus(text, tone) {
    if (!S.status) return;
    S.status.textContent = text;
    S.status.className = 'ssl-status ' + (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function panel(parent, title, meta) {
    var p = add(parent, el('section', 'panel')), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    if (meta) add(h, el('span', 'panel-meta', meta));
    return p;
  }
  function field(form, label, control, span) {
    var box = add(form, el('label', 'field' + (span ? ' ' + span : '')));
    add(box, el('span', 'field-label', label)); box.appendChild(control); return box;
  }
  function input(type, cls, ph) {
    var n = el('input', 'field-input' + (cls ? ' ' + cls : ''));
    n.type = type; if (ph) n.placeholder = ph;
    n.autocomplete = 'off'; n.spellcheck = false;
    return n;
  }
  function textarea(rows, ph) {
    var n = el('textarea', 'ssl-textarea');
    n.rows = rows; n.placeholder = ph || ''; n.autocomplete = 'off'; n.spellcheck = false;
    return n;
  }
  function paintCerts() {
    if (!S.certHost) return;
    S.certHost.textContent = '';
    S.count.textContent = S.certs.length ? S.certs.length + ' 张' : '';
    if (!S.certs.length) {
      var empty = add(S.certHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '还没有证书，可以创建自签证书或导入已有证书'));
      return;
    }
    var scroll = add(S.certHost, el('div', 'ssl-table-host'));
    var table = add(scroll, el('table', 'ssl-table'));
    table.setAttribute('aria-label', 'TLS 证书列表');
    var htr = add(add(table, el('thead')), el('tr'));
    ['域名', '有效期至', '剩余', 'issuer', '密钥', '标签', '链', '指纹', '操作'].forEach(function (label) {
      add(htr, el('th', null, label));
    });
    var body = add(table, el('tbody'));
    S.certs.forEach(function (cert) {
      var tr = add(body, el('tr'));
      var domain = add(tr, el('td', 'ssl-domain')); domain.dataset.label = '域名';
      add(domain, el('span', 'ssl-domain-name', cert.domain || '—'));
      if (cert.error) add(domain, el('div', 'ssl-cert-error', '解析失败：' + cert.error));
      var end = add(tr, el('td', null, fmtTime(cert.not_after))); end.dataset.label = '有效期至';
      var days = add(tr, el('td')); days.dataset.label = '剩余';
      var d = typeof cert.days_left === 'number' ? cert.days_left : null;
      var dcls = d === null ? '' : d < 0 ? ' is-fail' : d < 30 ? ' is-warn' : '';
      add(days, el('span', 'ssl-days' + dcls, d === null ? '—' : d + ' 天'));
      if (cert.expired) add(days, el('span', 'ssl-expired', '已过期'));
      var issuer = add(tr, el('td')); issuer.dataset.label = 'issuer';
      var is = add(issuer, el('span', 'ssl-issuer', cert.issuer || '—')); is.title = cert.issuer || '';
      var key = add(tr, el('td', null, [cert.key_type, cert.key_bits].filter(Boolean).join(' ') || '—'));
      key.dataset.label = '密钥';
      var tags = add(tr, el('td', 'ssl-tags')); tags.dataset.label = '标签';
      if (cert.self_signed) tags.appendChild(chip('na', '自签'));
      if (!cert.self_signed && cert.source) add(tags, el('span', 'ssl-source', cert.source));
      var chain = add(tr, el('td', null, cert.chain_length != null ? cert.chain_length : '—'));
      chain.dataset.label = '链';
      var fp = cert.fingerprint_sha256 || '', fpCell = add(tr, el('td')); fpCell.dataset.label = '指纹';
      var code = add(fpCell, el('code', 'ssl-fp', fp ? fp.slice(0, 16) + '…' : '—')); code.title = fp;
      var ops = add(tr, el('td', 'cell-ops ssl-ops')); ops.dataset.label = '操作';
      var v = add(ops, el('button', 'btn btn-ghost', '验证')); v.type = 'button';
      on(v, function () { S.verifyHost.value = cert.domain || ''; verify(); });
      var rn = add(ops, el('button', 'btn btn-ghost', '续期')); rn.type = 'button';
      on(rn, function () { renew(cert.domain); });
    });
  }
  function paintVerify() {
    if (!S.verifyOutHost) return;
    var host = S.verifyOutHost; host.textContent = '';
    if (!S.verifyOut) return;
    var r = S.verifyOut, line = add(host, el('div', 'ssl-verify-line'));
    add(line, el('code', 'ssl-verify-host', r.address || r.host || '—'));
    line.appendChild(chip(r.reachable ? 'ok' : 'fail', 'reachable=' + r.reachable));
    line.appendChild(chip(r.matched ? 'ok' : 'warn', 'matched=' + r.matched));
    add(line, el('span', 'ssl-verify-days', 'days_left=' + r.days_left));
    add(line, el('span', 'muted', '到期 ' + fmtTime(r.not_after)));
    if (r.issuer) add(line, el('span', 'muted ssl-verify-issuer', 'issuer=' + r.issuer));
    if (r.error) add(host, el('div', 'row-note-fail', '握手错误：' + r.error));
  }
  function load(quiet) {
    if (!quiet) setStatus('正在读取证书列表…');
    invoke('list', {}).then(function (data) {
      if (S.destroyed) return;
      S.certs = data.certs || []; paintCerts();
      if (!quiet) setStatus('共 ' + S.certs.length + ' 张证书；验证只做真实 TLS 握手，不改任何文件', 'ok');
    }, function (err) {
      if (S.destroyed) return;
      setStatus('读取失败：' + err.message, 'fail'); S.certs = []; paintCerts();
    });
  }
  function verify() {
    var host = S.verifyHost ? S.verifyHost.value.trim() : '';
    if (!host) { setStatus('请输入 host 或 host:port 再验证', 'fail'); return; }
    S.verifyOut = null; paintVerify(); setStatus('正在对 ' + host + ' 做 TLS 握手…');
    invoke('verify', { domain: host }).then(function (r) {
      if (S.destroyed) return;
      S.verifyOut = r; paintVerify();
      setStatus(r.reachable ? (r.matched ? '握手可达，证书匹配 ' + host : '握手可达，但证书不匹配 ' + host)
        : '握手不可达：' + (r.error || '连接失败'), r.matched ? 'ok' : 'fail');
    }, function (err) {
      if (!S.destroyed) setStatus('验证失败：' + err.message, 'fail');
    });
  }
  function renew(domain) {
    if (!domain) return;
    setStatus('正在续期 ' + domain + '…');
    invoke('renew', { domain: domain }).then(function (info) {
      if (S.destroyed) return;
      setStatus('已续期 ' + domain + '，新指纹 ' + (info.fingerprint_sha256 || '—') +
        '（有效期至 ' + fmtTime(info.not_after) + '）', 'ok');
      load(true);
    }, function (err) {
      if (!S.destroyed) setStatus('续期失败：' + err.message, 'fail');
    });
  }
  function submitCreate(ev) {
    ev.preventDefault();
    var domain = S.createDomain.value.trim().toLowerCase(), days = parseInt(S.createDays.value, 10);
    if (!domain) { setStatus('请填写域名', 'fail'); return; }
    if (!isFinite(days) || days < 1) { setStatus('天数必须是正整数', 'fail'); return; }
    S.busy = true; setStatus('正在签发 ' + domain + ' 自签证书（' + days + ' 天）…');
    invoke('selfsign', { domain: domain, days: days, key_type: S.createKey.value }).then(function (info) {
      S.busy = false; if (S.destroyed) return;
      setStatus('已创建 ' + domain + '（' + (info.key_type || '') + ' ' + (info.key_bits || '') +
        '），指纹 ' + (info.fingerprint_sha256 || '—') + '，有效期至 ' + fmtTime(info.not_after), 'ok');
      load(true);
    }, function (err) {
      S.busy = false; if (!S.destroyed) setStatus('创建失败：' + err.message, 'fail');
    });
  }
  function submitImport(ev) {
    ev.preventDefault();
    var domain = S.importDomain.value.trim().toLowerCase(), certPEM = S.importCert.value.trim();
    var keyPEM = (S.keyPEM || S.importKey.value).trim();
    if (!domain) { setStatus('请填写域名', 'fail'); return; }
    if (!certPEM) { setStatus('请粘贴证书 PEM', 'fail'); return; }
    if (!keyPEM) { setStatus('请粘贴私钥 PEM（输入框不会回显）', 'fail'); return; }
    S.busy = true; setStatus('正在校验并导入 ' + domain + '…');
    invoke('import', { domain: domain, cert_pem: certPEM, key_pem: keyPEM,
      chain_pem: S.importChain.value.trim() }).then(function (info) {
      S.busy = false; S.keyPEM = ''; S.importKey.value = '';
      S.keyNote.textContent = '私钥已提交并从输入区清空，不会回显、不会记录';
      if (S.destroyed) return;
      setStatus('已导入 ' + domain + '，指纹 ' + (info.fingerprint_sha256 || '—') +
        '，有效期至 ' + fmtTime(info.not_after), 'ok');
      load(true);
    }, function (err) {
      S.busy = false; if (!S.destroyed) setStatus('导入失败：' + err.message, 'fail');
    });
  }
  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', 'SSL 证书'));
    add(head, el('p', 'view-sub', '证书扫描、自签、导入、续期与真实 TLS 握手验证；私钥只提交给本机插件。'));
    var bar = add(root, el('div', 'ssl-toolbar')), vbox = add(bar, el('div', 'ssl-verify-box'));
    S.verifyHost = add(vbox, input('text', 'ssl-verify-input', 'host 或 host:port（如 127.0.0.1:443）'));
    S.verifyHost.setAttribute('aria-label', '验证目标 host 或 host:port');
    var vbtn = add(vbox, el('button', 'btn btn-primary', '验证')); vbtn.type = 'button'; on(vbtn, verify);
    var refresh = add(bar, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, function () { load(false); });
    S.status = add(root, el('div', 'ssl-status muted')); S.status.setAttribute('role', 'status');
    var acme = add(root, el('div', 'ssl-acme'));
    var abtn = add(acme, el('button', 'btn', '申请 Let\'s Encrypt 证书'));
    abtn.type = 'button'; abtn.disabled = true; abtn.title = 'ACME 自动申请未实现（v1.1 跟进）';
    add(acme, el('span', 'ssl-acme-note', 'ACME 自动申请未实现（v1.1 跟进），当前可用自签或导入'));
    S.verifyOutHost = add(root, el('div', 'ssl-verifyresult'));
    var list = panel(root, '证书列表');
    S.count = list.querySelector('.panel-head').appendChild(el('span', 'panel-meta', ''));
    S.certHost = add(list, el('div', 'ssl-certs'));
    var grid = add(root, el('div', 'ssl-grid'));
    var create = panel(grid, '新建自签证书', '写入本机证书目录'), cf = add(create, el('form', 'ssl-form'));
    S.createDomain = input('text', 'span2', 'ui.kore.local'); field(cf, '域名', S.createDomain, 'span2');
    S.createDays = input('number', '', '365'); S.createDays.value = '365';
    S.createDays.min = '1'; S.createDays.max = '3650'; field(cf, '有效天数', S.createDays);
    S.createKey = el('select', 'field-input');
    [['rsa2048', 'RSA 2048'], ['ecdsa256', 'ECDSA P-256']].forEach(function (o) {
      var opt = el('option', null, o[1]); opt.value = o[0]; S.createKey.appendChild(opt);
    });
    field(cf, '密钥类型', S.createKey);
    var cbtn = add(cf, el('button', 'btn btn-primary ssl-submit', '创建自签证书')); cbtn.type = 'submit';
    add(cf, el('p', 'field-hint span2', '自签证书只用于测试/内网；默认 365 天。'));
    cf.addEventListener('submit', submitCreate);
    var imp = panel(grid, '导入已有证书', '证书 + 私钥 + 可选链'), inf = add(imp, el('form', 'ssl-form'));
    S.importDomain = input('text', 'span2', 'www.example.com'); field(inf, '域名', S.importDomain, 'span2');
    S.importCert = textarea(4, '-----BEGIN CERTIFICATE-----\n…'); field(inf, '证书 PEM', S.importCert, 'span2');
    S.importKey = input('password', 'span2', '粘贴私钥 PEM（不会回显）');
    S.importKey.setAttribute('autocomplete', 'new-password');
    S.importKey.addEventListener('paste', function (ev) {
      var text = ev.clipboardData ? ev.clipboardData.getData('text') : '';
      if (!text) return;
      ev.preventDefault(); S.keyPEM = text; S.importKey.value = '';
      S.keyNote.textContent = '已接收私钥（' + text.length + ' 字符），不会回显、不会记录';
    });
    S.importKey.addEventListener('input', function () {
      if (S.importKey.value) { S.keyPEM = ''; S.keyNote.textContent = '正在输入私钥（密码框显示为圆点，不会回显）'; }
    });
    field(inf, '私钥 PEM', S.importKey, 'span2');
    S.keyNote = add(inf, el('p', 'field-hint span2', '私钥输入框为 password 类型：粘贴内容不回显、不记录，提交后清空。'));
    S.importChain = textarea(2, '可选：中间链 PEM'); field(inf, '链 PEM（可选）', S.importChain, 'span2');
    var ibtn = add(inf, el('button', 'btn btn-primary ssl-submit', '导入证书')); ibtn.type = 'submit';
    inf.addEventListener('submit', submitImport);
  }
  function render(container) {
    if (!container) return null;
    S = fresh(); container.textContent = '';
    var root = add(container, el('section', 'ssl'));
    build(root); load(false);
    return { destroy: function () { S.destroyed = true; S.keyPEM = ''; } };
  }
  window.KoreSsl = { render: render };
})();
