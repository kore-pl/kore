/* kore 主壳 · TLS 证书管理（web/ssl.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/ssl/ssl.list）；
   方法段一律写完整限定名 ssl.*，裸动词只是插件侧兼容，不得依赖。
   window.KoreSsl.render(container) 调 ssl 插件：ssl.list / ssl.selfsign / ssl.import /
   ssl.renew / ssl.verify / ssl.expiring / ssl.renew.set / ssl.acme.status / ssl.acme.issue。
   自动续期不在插件里创建任务：前端把 ssl.renew.set 给的 recommended_task 原样
   POST 到内核 ADR-0019 的 /api/v1/scheduler/tasks（插件无权调内核 API）。
   ACME 会联网，必须用户勾选确认后才调用外部客户端（certbot / acme.sh）。
   私钥只经 password 输入框粘贴，内容留在内存变量、提交后清空；不回显、不写日志、不落 localStorage。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/ssl/';
  var SCHED = '/api/v1/scheduler/tasks';
  var RENEW_SCHEDULE = '0 3 * * *';
  function fresh() {
    return { certs: [], destroyed: false, status: null, verifyHost: null, verifyOut: null, createDomain: null,
      createDays: null, createKey: null, importDomain: null, importCert: null, importKey: null,
      importChain: null, keyPEM: '', keyNote: null, busy: false,
      expiry: null, expiryHost: null, expiryActions: null, tasks: [], taskLoaded: false,
      acmeStatus: null, acmeStatusHost: null, acmeDomain: null, acmeEmail: null, acmeConfirm: null,
      acmeSubmit: null, acmeNote: null, acmeResult: null, acmeResultHost: null };
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
  // decode 统一解析错误体：code / message / hint（hint 是内核从插件 detail 取出的下一步提示）。
  function decode(res, raw) {
    var data = {};
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
    if (!res.ok) {
      var err = new Error((data.code ? data.code + '：' : '') +
        (data.message || ('请求失败（HTTP ' + res.status + '）')));
      err.code = data.code || '';
      err.hint = data.hint || '';
      throw err;
    }
    return data;
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch(API + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) { return decode(res, raw); });
    });
  }
  // request 调内核 API（scheduler/tasks）；与插件方法分开，避免把内核端点拼进插件前缀。
  function request(url, method, body) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var init = {
      method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Kore-CSRF': token }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (raw) { return decode(res, raw); });
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
  function errText(err) {
    return err && err.hint ? err.message + '｜' + err.hint : (err ? err.message : '未知错误');
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
  function button(parent, label, cls, fn) {
    var b = add(parent, el('button', 'btn' + (cls ? ' ' + cls : ''), label));
    b.type = 'button'; return on(b, fn);
  }
  // ---- 证书列表 ----
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
      var st = add(ops, el('button', 'btn btn-ghost', '设置自动续期')); st.type = 'button';
      st.title = '创建内核任务：每天 03:00 检查，到期前 30 天才重签';
      on(st, function () { setupRenew(cert.domain, st); });
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
  // ---- 到期告警条（ssl.expiring 聚合视图） ----
  function loadExpiry() {
    return invoke('ssl.expiring', {}).then(function (data) {
      if (S.destroyed) return;
      S.expiry = data; paintExpiry();
    }, function (err) {
      if (S.destroyed) return;
      S.expiry = { error: errText(err), expiring: [], checked: 0 }; paintExpiry();
    });
  }
  function paintExpiry() {
    if (!S.expiryHost) return;
    var host = S.expiryHost; host.textContent = '';
    if (S.expiryActions) { S.expiryActions.textContent = ''; S.expiryActions.hidden = true; }
    var data = S.expiry || { expiring: [], checked: 0 };
    if (data.error) {
      add(host, el('div', 'row-note-fail', '到期检查失败：' + data.error));
      return;
    }
    var critical = [], warning = [], ok = [];
    (data.expiring || []).forEach(function (item) {
      if (item.severity === 'critical') critical.push(item);
      else if (item.severity === 'warning') warning.push(item);
      else ok.push(item);
    });
    var tone = critical.length ? 'critical' : warning.length ? 'warning' : 'ok';
    var bar = add(host, el('div', 'ssl-expiry ssl-expiry-' + tone));
    var icon = critical.length ? '⚠' : warning.length ? '⏳' : '✓';
    add(bar, el('span', 'ssl-expiry-icon', icon));
    var body = add(bar, el('div', 'ssl-expiry-body'));
    if (tone === 'ok') {
      add(body, el('div', 'ssl-expiry-text',
        '全部证书 30 天以上到期（已检查 ' + (data.checked || 0) + ' 张）'));
      return;
    }
    var parts = [];
    if (critical.length) parts.push(critical.length + ' 张 7 天内到期或已过期');
    if (warning.length) parts.push(warning.length + ' 张 30 天内到期');
    add(body, el('div', 'ssl-expiry-text',
      parts.join(' + ') + '（已检查 ' + (data.checked || 0) + ' 张）'));
    var list = add(body, el('div', 'ssl-expiry-list'));
    critical.concat(warning).slice(0, 6).forEach(function (item) {
      var row = add(list, el('span', 'ssl-expiry-item'));
      add(row, el('strong', null, item.name || '—'));
      add(row, el('span', 'ssl-expiry-days', item.days_left < 0
        ? '已过期 ' + Math.abs(item.days_left) + ' 天'
        : '剩余 ' + item.days_left + ' 天'));
      add(row, el('span', 'muted', '（' + fmtTime(item.not_after) + '）'));
    });
    if (critical.length + warning.length > 6) {
      add(list, el('span', 'muted', '等 ' + (critical.length + warning.length) + ' 张'));
    }
    if (S.expiryActions) {
      S.expiryActions.hidden = false;
      button(S.expiryActions, '为临期证书设置自动续期', 'btn btn-primary', function () {
        var names = critical.concat(warning).map(function (item) { return item.name; });
        setupRenewFor(names);
      });
    }
  }
  // ---- 自动续期（ssl.renew.set → 内核 scheduler） ----
  function loadTasks() {
    return request(SCHED).then(function (data) {
      S.tasks = data.tasks || []; S.taskLoaded = true;
    }, function () {
      S.tasks = []; S.taskLoaded = false;
    });
  }
  function findTask(name) {
    var found = null;
    (S.tasks || []).forEach(function (t) { if (t.name === name) found = t; });
    return found;
  }
  function setupRenewFor(names) {
    if (!names || !names.length) return;
    setStatus('正在为 ' + names.length + ' 张证书创建自动续期任务…');
    var done = [];
    names.reduce(function (p, name) {
      return p.then(function () {
        return setupRenew(name, null, true).then(function (created) { if (created) done.push(name); });
      });
    }, Promise.resolve()).then(function () {
      setStatus('已为 ' + done.length + ' 张证书创建自动续期任务（每天 03:00 检查，到期前 30 天才重签）', 'ok');
    }, function (err) {
      setStatus('批量设置自动续期失败：' + errText(err), 'fail');
    });
  }
  // setupRenew 调 ssl.renew.set 拿任务描述，再落到内核 scheduler。
  // 已有同名任务时不重复创建（避免每天多跑一遍），返回 Promise<是否新建>。
  function setupRenew(name, btn, quiet) {
    if (btn) btn.disabled = true;
    if (!quiet) setStatus('正在生成 ' + name + ' 的自动续期任务描述…');
    return invoke('ssl.renew.set', { name: name, days_before: 30 }).then(function (plan) {
      var task = plan.recommended_task;
      return loadTasks().then(function () {
        var existing = findTask(task.name);
        if (existing) {
          if (!quiet) {
            setStatus('已有自动续期任务：' + existing.name + '（下次 ' + fmtTime(existing.next_run_at) + '），未重复创建', 'ok');
          }
          return false;
        }
        var body = { name: task.name, plugin: task.plugin, method: task.method,
          params: task.params, schedule: task.schedule || RENEW_SCHEDULE, timeout_s: 300, enabled: true };
        return request(SCHED, 'POST', body).then(function (created) {
          S.tasks.push(created);
          if (!quiet) {
            setStatus('已创建自动续期任务：' + created.name + '，每次 ' + fmtTime(created.next_run_at) +
              ' 执行（到期前 30 天才重签，未到期会跳过）', 'ok');
          }
          return true;
        });
      });
    }).then(function (created) {
      if (btn) btn.disabled = false;
      return created;
    }, function (err) {
      if (btn) btn.disabled = false;
      if (!quiet) {
        setStatus((err.code === 'E_UNSUPPORTED' ? '内核未装配调度器：' : '设置自动续期失败：') + errText(err), 'fail');
      }
      throw err;
    });
  }
  // ---- ACME（探测 + 显式调用外部客户端） ----
  function loadACME() {
    if (!S.acmeStatusHost) return;
    invoke('ssl.acme.status', {}).then(function (status) {
      if (S.destroyed) return;
      S.acmeStatus = status; paintACME();
    }, function (err) {
      if (S.destroyed) return;
      S.acmeStatus = { available: false, tool: '', version: '', error: errText(err) }; paintACME();
    });
  }
  function paintACME() {
    if (!S.acmeStatusHost) return;
    var host = S.acmeStatusHost; host.textContent = '';
    var st = S.acmeStatus;
    if (!st) { add(host, el('span', 'muted', '正在检测本机 ACME 客户端…')); return; }
    if (st.error) { add(host, el('span', 'row-note-fail', 'ACME 检测失败：' + st.error)); return; }
    if (st.available) {
      host.appendChild(chip('ok', '可用'));
      add(host, el('span', 'ssl-acme-tool', (st.tool || 'acme') + ' ' + (st.version || '')));
      add(host, el('span', 'muted', '调用前需勾选确认；签发成功会自动纳入本页证书管理'));
    } else {
      host.appendChild(chip('na', '未安装'));
      add(host, el('span', 'ssl-acme-tool', '未检测到 certbot / acme.sh'));
      add(host, el('span', 'muted', '无联网或未装客户端时，继续用自签或导入'));
    }
    if (S.acmeSubmit) S.acmeSubmit.disabled = !st.available || !(S.acmeConfirm && S.acmeConfirm.checked);
  }
  function paintACMEResult() {
    if (!S.acmeResultHost) return;
    var host = S.acmeResultHost; host.textContent = '';
    var r = S.acmeResult;
    if (!r) return;
    var line = add(host, el('div', 'ssl-verify-line'));
    line.appendChild(chip('ok', '已签发并导入'));
    add(line, el('code', 'ssl-verify-host', r.cert_path || '—'));
    add(line, el('span', 'ssl-verify-days', 'days_left=' + r.days_left));
    add(line, el('span', 'muted', '到期 ' + fmtTime(r.not_after)));
    if (r.fingerprint_sha256) {
      var code = add(line, el('code', 'ssl-fp', String(r.fingerprint_sha256).slice(0, 16) + '…'));
      code.title = r.fingerprint_sha256;
    }
  }
  function submitACME(ev) {
    ev.preventDefault();
    var domain = S.acmeDomain.value.trim().toLowerCase(), email = S.acmeEmail.value.trim();
    if (!domain) { setStatus('请填写要申请证书的域名', 'fail'); return; }
    if (!email) { setStatus('请填写 ACME 账号邮箱', 'fail'); return; }
    if (!S.acmeConfirm.checked) { setStatus('必须勾选「确认联网申请」才能调用 ACME', 'fail'); return; }
    if (!S.acmeStatus || !S.acmeStatus.available) { setStatus('本机没有可用的 ACME 客户端（certbot / acme.sh）', 'fail'); return; }
    S.acmeSubmit.disabled = true;
    setStatus('正在调用 ' + S.acmeStatus.tool + ' 为 ' + domain + ' 申请证书（会联网，可能需要 1–2 分钟）…');
    invoke('ssl.acme.issue', { domain: domain, email: email, confirm: true }).then(function (result) {
      if (S.destroyed) return;
      S.acmeResult = result; paintACMEResult();
      setStatus('ACME 签发成功：' + domain + '，有效期至 ' + fmtTime(result.not_after) + '，已纳入证书管理', 'ok');
      S.acmeConfirm.checked = false;
      load(true);
    }, function (err) {
      if (!S.destroyed) setStatus('ACME 签发失败：' + errText(err), 'fail');
    }).then(function () { if (S.acmeSubmit) S.acmeSubmit.disabled = false; paintACME(); });
  }
  // ---- 加载与操作 ----
  function load(quiet) {
    if (!quiet) setStatus('正在读取证书列表…');
    return invoke('ssl.list', {}).then(function (data) {
      if (S.destroyed) return;
      S.certs = data.certs || []; paintCerts();
      if (!quiet) setStatus('共 ' + S.certs.length + ' 张证书；验证只做真实 TLS 握手，不改任何文件', 'ok');
    }, function (err) {
      if (S.destroyed) return;
      setStatus('读取失败：' + errText(err), 'fail'); S.certs = []; paintCerts();
    });
  }
  function verify() {
    var host = S.verifyHost ? S.verifyHost.value.trim() : '';
    if (!host) { setStatus('请输入 host 或 host:port 再验证', 'fail'); return; }
    S.verifyOut = null; paintVerify(); setStatus('正在对 ' + host + ' 做 TLS 握手…');
    invoke('ssl.verify', { domain: host }).then(function (r) {
      if (S.destroyed) return;
      S.verifyOut = r; paintVerify();
      setStatus(r.reachable ? (r.matched ? '握手可达，证书匹配 ' + host : '握手可达，但证书不匹配 ' + host)
        : '握手不可达：' + (r.error || '连接失败'), r.matched ? 'ok' : 'fail');
    }, function (err) {
      if (!S.destroyed) setStatus('验证失败：' + errText(err), 'fail');
    });
  }
  function renew(domain) {
    if (!domain) return;
    setStatus('正在续期 ' + domain + '（覆盖前会先备份旧证书）…');
    invoke('ssl.renew', { domain: domain }).then(function (info) {
      if (S.destroyed) return;
      if (info.renewed === false) {
        setStatus(domain + ' 未到续期窗口（剩余 ' + info.days_left + ' 天），未改动任何文件', 'ok');
        load(true); loadExpiry();
        return;
      }
      var backup = info.backup_path ? '；旧证书已备份到 ' + info.backup_path : '';
      setStatus('已续期 ' + domain + '，新指纹 ' + (info.fingerprint_sha256 || '—') +
        '（有效期至 ' + fmtTime(info.not_after) + '）' + backup, 'ok');
      load(true); loadExpiry();
    }, function (err) {
      if (!S.destroyed) setStatus('续期失败：' + errText(err), 'fail');
    });
  }
  function submitCreate(ev) {
    ev.preventDefault();
    var domain = S.createDomain.value.trim().toLowerCase(), days = parseInt(S.createDays.value, 10);
    if (!domain) { setStatus('请填写域名', 'fail'); return; }
    if (!isFinite(days) || days < 1) { setStatus('天数必须是正整数', 'fail'); return; }
    S.busy = true; setStatus('正在签发 ' + domain + ' 自签证书（' + days + ' 天）…');
    invoke('ssl.selfsign', { domain: domain, days: days, key_type: S.createKey.value }).then(function (info) {
      S.busy = false; if (S.destroyed) return;
      setStatus('已创建 ' + domain + '（' + (info.key_type || '') + ' ' + (info.key_bits || '') +
        '），指纹 ' + (info.fingerprint_sha256 || '—') + '，有效期至 ' + fmtTime(info.not_after), 'ok');
      load(true); loadExpiry();
    }, function (err) {
      S.busy = false; if (!S.destroyed) setStatus('创建失败：' + errText(err), 'fail');
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
    invoke('ssl.import', { domain: domain, cert_pem: certPEM, key_pem: keyPEM,
      chain_pem: S.importChain.value.trim() }).then(function (info) {
      S.busy = false; S.keyPEM = ''; S.importKey.value = '';
      S.keyNote.textContent = '私钥已提交并从输入区清空，不会回显、不会记录';
      if (S.destroyed) return;
      setStatus('已导入 ' + domain + '，指纹 ' + (info.fingerprint_sha256 || '—') +
        '，有效期至 ' + fmtTime(info.not_after), 'ok');
      load(true); loadExpiry();
    }, function (err) {
      S.busy = false; if (!S.destroyed) setStatus('导入失败：' + errText(err), 'fail');
    });
  }
  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', 'SSL 证书'));
    add(head, el('p', 'view-sub', '到期告警、自签 / 导入 / 自动续期与真实 TLS 握手验证；ACME 由本机外部客户端执行，必须手动确认。'));
    var bar = add(root, el('div', 'ssl-toolbar')), vbox = add(bar, el('div', 'ssl-verify-box'));
    S.verifyHost = add(vbox, input('text', 'ssl-verify-input', 'host 或 host:port（如 127.0.0.1:443）'));
    S.verifyHost.setAttribute('aria-label', '验证目标 host 或 host:port');
    var vbtn = add(vbox, el('button', 'btn btn-primary', '验证')); vbtn.type = 'button'; on(vbtn, verify);
    var refresh = add(bar, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, function () { load(false); loadExpiry(); loadACME(); });
    S.status = add(root, el('div', 'ssl-status muted')); S.status.setAttribute('role', 'status');
    S.expiryHost = add(root, el('div', 'ssl-expiry-host'));
    S.expiryActions = add(root, el('div', 'ssl-expiry-actions')); S.expiryActions.hidden = true;
    S.verifyOutHost = add(root, el('div', 'ssl-verifyresult'));
    var list = panel(root, '证书列表');
    S.count = list.querySelector('.panel-head').appendChild(el('span', 'panel-meta', ''));
    S.certHost = add(list, el('div', 'ssl-certs'));

    var acme = panel(root, 'ACME 证书（外部客户端）', '需手动确认 · 会联网');
    S.acmeStatusHost = add(acme, el('div', 'ssl-acme-status'));
    var af = add(acme, el('form', 'ssl-form ssl-acme-form'));
    S.acmeDomain = input('text', '', 'www.example.com');
    field(af, '域名', S.acmeDomain);
    S.acmeEmail = input('email', '', 'ops@example.com');
    field(af, '账号邮箱', S.acmeEmail);
    var confirmBox = add(af, el('label', 'field ssl-acme-confirm'));
    S.acmeConfirm = el('input'); S.acmeConfirm.type = 'checkbox';
    confirmBox.appendChild(S.acmeConfirm);
    add(confirmBox, el('span', null, '我确认由本机 ' + 'certbot / acme.sh' + ' 联网向公共 CA 申请证书'));
    confirmBox.classList.add('span2');
    S.acmeSubmit = add(af, el('button', 'btn btn-primary ssl-submit', '申请证书（需勾选确认）'));
    S.acmeSubmit.type = 'submit'; S.acmeSubmit.disabled = true;
    add(af, el('p', 'field-hint span2',
      'ACME 会联网并占用 80 端口；未安装客户端或不允许出网时，请用自签证书或导入。'));
    S.acmeConfirm.addEventListener('change', function () { paintACME(); });
    af.addEventListener('submit', submitACME);
    S.acmeResultHost = add(acme, el('div', 'ssl-verifyresult'));

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
    build(root); load(false); loadExpiry(); loadACME();
    return { destroy: function () { S.destroyed = true; S.keyPEM = ''; } };
  }
  window.KoreSsl = { render: render };
})();
