/* kore 主壳 · TLS 证书管理（web/ssl.js）——零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/ssl/ssl.list）；
   方法段一律写完整限定名 ssl.*，裸动词只是插件侧兼容，不得依赖。
   window.KoreSsl.render(container) 调 ssl 插件：ssl.list / ssl.selfsign / ssl.import /
   ssl.renew / ssl.verify / ssl.expiring / ssl.renew.set / ssl.acme.status / ssl.acme.issue /
   ssl.acme.builtin.status / ssl.acme.builtin.issue / ssl.acme.auto（内置 ACME，0.5.0 起默认主推）。
   自动续期不在插件里创建任务：前端把 ssl.renew.set / ssl.acme.auto 给的 task 原样
   POST 到内核 ADR-0019 的 /api/v1/scheduler/tasks（插件无权调内核 API）。
   ACME 两条路线并存、互不互斥：①内置（默认，标准库 RFC8555，零外部依赖）；
   ②外部客户端（engine=external，certbot / acme.sh）。两者都会联网，必须用户勾选确认后才调用；
   builtin.status 只读探测（system:read、零联网），可安全自动加载用于展示内置 ACME 可用状态。
   强制 HTTPS 走 ssl.https.status / ssl.https.enforce / ssl.https.unenforce：本插件只登记期望状态、
   真正让浏览器自动跳转由网站页完成，故 UI 区分「已记录」与「已生效」，不把登记说成生效。
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
      acmeSubmit: null, acmeNote: null, acmeResult: null, acmeResultHost: null,
      builtinStatus: null, builtinStatusHost: null, bDomain: null, bEmail: null, bCA: null,
      bWebroot: null, bConfirm: null, bSubmit: null, bResult: null, bResultHost: null,
      autoEnabled: null, autoDays: null, autoCA: null, autoWebroot: null, autoEmail: null,
      autoConfirm: null, autoSubmit: null, autoResultHost: null, autoResult: null,
      httpsDomain: null, httpsAutoNote: null, httpsStatus: null, httpsStatusHost: null,
      httpsCheckBtn: null, httpsBtnOn: null, httpsBtnOff: null, httpsUserEdited: false };
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
  // ---- 强制 HTTPS（ssl.https.status / enforce / unenforce） ----
  // 本插件只做"期望状态登记 + 只读判定"，真正的 80→443 跳转由网站页完成。
  // 所以 UI 分两层说人话：已记录（本页操作）与已生效（站点侧已跳转）。
  function paintHTTPS() {
    if (!S.httpsStatusHost) return;
    var host = S.httpsStatusHost; host.textContent = '';
    var st = S.httpsStatus;
    if (!st) { add(host, el('span', 'muted', '点「查看当前状态」后，这里会显示是否已开启强制 HTTPS。')); return; }
    if (st.__error) {
      add(host, el('div', 'row-note-fail', st.__error));
      return;
    }
    var on = !!st.force_https;
    host.appendChild(chip(on ? 'ok' : 'warn', on ? '浏览器会自动跳转到 HTTPS' : '目前不会自动跳转到 HTTPS'));
    add(host, el('span', 'muted', st.enforced ? '本页已记录' : '本页暂无记录'));
    var how = el('details', 'ssl-https-how');
    add(how, el('summary', null, '展开看详情'));
    add(how, el('div', 'muted',
      '443 加密访问：' + (st.https && st.https.reachable ? '可用' : '不可用') +
      '；80 跳转：' + (st.http && st.http.redirects_to_https ? '已开启' : '未开启') +
      '；判定：' + (st.verdict || '—')));
    if (st.hint) add(how, el('div', 'muted', st.hint));
    add(host, how);
    if (S.httpsBtnOn) S.httpsBtnOn.disabled = on;
    if (S.httpsBtnOff) S.httpsBtnOff.disabled = !on;
  }
  function loadHTTPS(silent) {
    var domain = (S.httpsDomain && S.httpsDomain.value.trim().toLowerCase()) || '';
    if (!domain) { setStatus('请先填写要设置的域名', 'fail'); return Promise.reject(new Error('no-domain')); }
    if (!silent) setStatus('正在查看「' + domain + '」的 HTTPS 状态…');
    return invoke('ssl.https.status', { domain: domain }).then(function (data) {
      if (S.destroyed) return;
      S.httpsStatus = data || {};
      paintHTTPS();
      if (!silent) setStatus(data && data.force_https
        ? '「' + domain + '」已开启强制 HTTPS：浏览器会自动跳转到加密地址'
        : '「' + domain + '」尚未开启强制 HTTPS：可在下方点「开启」', data && data.force_https ? 'ok' : '');
    }, function (err) {
      if (S.destroyed) return;
      S.httpsStatus = { __error: '查不到「' + domain + '」的 HTTPS 状态：' + errText(err) +
        '。请确认域名填写正确、服务可访问后重试。' };
      paintHTTPS();
      if (!silent) setStatus('状态查询失败：' + errText(err), 'fail');
    });
  }
  function changeHTTPS(enforce, btn) {
    var domain = (S.httpsDomain && S.httpsDomain.value.trim().toLowerCase()) || '';
    if (!domain) { setStatus('请先填写要设置的域名', 'fail'); return; }
    var method = enforce ? 'ssl.https.enforce' : 'ssl.https.unenforce';
    var label = enforce ? '开启' : '关闭';
    if (btn) btn.disabled = true;
    var old = btn ? btn.textContent : '';
    if (btn) btn.textContent = label + '中…';
    setStatus('正在' + label + '「' + domain + '」的强制 HTTPS…');
    invoke(method, { domain: domain }).then(function (info) {
      if (S.destroyed) return;
      var hint = info && info.hint ? '｜' + info.hint : '';
      setStatus('已' + label + '「' + domain + '」的强制 HTTPS 记录' + hint, 'ok');
      return loadHTTPS(true);
    }, function (err) {
      if (!S.destroyed) setStatus(label + '失败：' + errText(err) +
        '。请确认域名已绑证书、服务可访问后重试，或点「查看当前状态」复核。', 'fail');
    }).then(function () {
      if (btn && !S.destroyed) { btn.disabled = false; btn.textContent = old; paintHTTPS(); }
    });
  }
  function fillHTTPSFromCerts() {
    if (S.httpsUserEdited || !S.httpsDomain) return;
    var first = S.certs && S.certs[0];
    if (first && first.domain) {
      S.httpsDomain.value = first.domain;
      if (S.httpsAutoNote) S.httpsAutoNote.textContent = '已自动填入第一张证书的域名，可改成要设置的站点域名';
      if (!S.httpsStatus && !S.destroyed) loadHTTPS(true);
    }
  }
  // ---- 内置 ACME（0.5.0 起默认主推；标准库 RFC8555，零外部依赖） ----
  // builtin.status 只读探测（system:read、零联网、无副作用），自动加载展示配置与审计。
  function loadBuiltinStatus() {
    if (!S.builtinStatusHost) return;
    invoke('ssl.acme.builtin.status', {}).then(function (status) {
      if (S.destroyed) return;
      S.builtinStatus = status; paintBuiltinStatus();
      fillBuiltinFromStatus(status);
    }, function (err) {
      if (S.destroyed) return;
      S.builtinStatus = { __error: errText(err) }; paintBuiltinStatus();
    });
  }
  // 自动填 webroot / 域名等（易用性：自动发现、不让人填环境细节；标注来源）。
  function fillBuiltinFromStatus(st) {
    if (!st || st.__error) return;
    if (S.bWebroot && !S.bWebroot.value.trim() && st.webroot) {
      S.bWebroot.value = st.webroot;
      if (S.bWebrootNote) S.bWebrootNote.textContent = '已自动填入当前配置的 webroot（来自内置 ACME 状态），可改成站点根目录';
    }
    if (S.bCA && !S.bCA.value && st.ca) S.bCA.value = st.ca;
    if (S.autoWebroot && !S.autoWebroot.value.trim() && st.webroot) S.autoWebroot.value = st.webroot;
  }
  function paintBuiltinStatus() {
    if (!S.builtinStatusHost) return;
    var host = S.builtinStatusHost; host.textContent = '';
    var st = S.builtinStatus;
    if (!st) { add(host, el('span', 'muted', '正在检测内置 ACME 配置（只读，不联网）…')); return; }
    if (st.__error) { add(host, el('div', 'row-note-fail', '读取内置 ACME 状态失败：' + st.__error +
      '。请点刷新重试；若反复失败，确认 ssl 插件已加载且为 0.5.0 以上版本。')); return; }
    var line = add(host, el('div', 'ssl-verify-line'));
    line.appendChild(chip('ok', '内置可用'));
    var ca = st.ca || '—';
    add(line, el('span', 'ssl-acme-tool', 'CA：' + ca + (st.staging ? '（staging，浏览器不信任）' : '')));
    line.appendChild(chip(st.account_exists ? 'ok' : 'warn', st.account_exists ? '账户已注册' : '账户未注册'));
    line.appendChild(chip(st.auto_renew ? 'ok' : 'na', st.auto_renew ? '自动续期已开' : '自动续期关闭'));
    var meta = add(host, el('div', 'muted'));
    add(meta, el('span', null, '证书目录：' + (st.cert_dir || '—')));
    if (st.webroot) add(meta, el('span', null, ' · webroot：' + st.webroot));
    if (st.days_before) add(meta, el('span', null, ' · 到期前 ' + st.days_before + ' 天续期'));
    if (st.hint) add(host, el('div', 'field-hint', '提示：' + st.hint));
    var aud = st.last_audit || [];
    if (aud.length) {
      var det = add(host, el('details', 'ssl-https-how'));
      add(det, el('summary', null, '展开看最近审计（' + aud.length + ' 条）'));
      aud.slice(-5).reverse().forEach(function (a) {
        add(det, el('div', 'muted', (a.at || '—') + ' · ' + (a.action || '—') +
          ' · ' + (a.domain || a.ca || '—') + ' · ' + (a.result || '—') +
          (a.reason ? '（' + a.reason + '）' : '')));
      });
    }
  }
  function paintBuiltinResult() {
    if (!S.bResultHost) return;
    var host = S.bResultHost; host.textContent = '';
    var r = S.bResult;
    if (!r) return;
    var line = add(host, el('div', 'ssl-verify-line'));
    line.appendChild(chip('ok', '已签发并导入'));
    add(line, el('code', 'ssl-verify-host', r.cert_path || r.domain || '—'));
    add(line, el('span', 'ssl-verify-days', 'days_left=' + r.days_left));
    add(line, el('span', 'muted', '到期 ' + fmtTime(r.not_after)));
    if (r.staging) add(host, el('div', 'field-hint', '注意：当前是 staging 证书，浏览器不信任；验证通过后把 CA 换成 letsencrypt 或 litessl 再签一次。'));
  }
  function paintAutoResult() {
    if (!S.autoResultHost) return;
    var host = S.autoResultHost; host.textContent = '';
    var r = S.autoResult;
    if (!r) return;
    var line = add(host, el('div', 'ssl-verify-line'));
    line.appendChild(chip(r.auto_renew ? 'ok' : 'na', r.auto_renew ? '自动续期已开启' : '自动续期已关闭'));
    add(host, el('div', 'muted', 'CA：' + (r.ca || '—') +
      (r.webroot ? ' · webroot：' + r.webroot : '') +
      (r.next_run_at ? ' · 下次检查 ' + fmtTime(r.next_run_at) : '')));
    if (r.warning) add(host, el('div', 'field-hint', r.warning));
    if (r.hint) add(host, el('div', 'field-hint', '怎么办：' + r.hint));
  }
  // 签发：显式确认门（勾选才解锁按钮，confirm:true 硬门在后端 acme_issue.go:212）。
  function submitBuiltinIssue(ev) {
    ev.preventDefault();
    var domain = S.bDomain.value.trim().toLowerCase();
    var email = S.bEmail.value.trim();
    var ca = S.bCA.value.trim();
    var webroot = S.bWebroot.value.trim();
    if (!domain) { setStatus('请填写要申请证书的域名', 'fail'); return; }
    if (!webroot) { setStatus('请填写站点根目录（webroot）：HTTP-01 校验文件要写进去', 'fail'); return; }
    if (!S.bConfirm.checked) { setStatus('必须勾选「我确认联网申请」才会调用内置 ACME', 'fail'); return; }
    var params = { domain: domain, webroot: webroot, confirm: true };
    if (email) params.email = email;
    if (ca) params.ca = ca;
    S.bSubmit.disabled = true;
    setStatus('正在用内置 ACME 为 ' + domain + ' 申请证书（会联网，可能需要 1–2 分钟）…');
    invoke('ssl.acme.builtin.issue', params).then(function (result) {
      if (S.destroyed) return;
      S.bResult = result; paintBuiltinResult();
      setStatus('内置 ACME 签发成功：' + domain + '，有效期至 ' + fmtTime(result.not_after) +
        '，已纳入证书管理', 'ok');
      S.bConfirm.checked = false;
      load(true); loadExpiry(); loadBuiltinStatus();
    }, function (err) {
      if (!S.destroyed) setStatus('内置 ACME 签发失败：' + errText(err) +
        '。首次建议把 CA 设为 letsencrypt-staging 跑通，并确认域名已解析到本机、80 端口可访问。', 'fail');
    }).then(function () { if (S.bSubmit) S.bSubmit.disabled = false; paintBuiltinStatus(); });
  }
  // acme.auto：写配置 + 自动续期开关，confirm:true 硬门；开启后把返回的 task 落到内核 scheduler。
  function submitAuto(ev) {
    ev.preventDefault();
    if (!S.autoConfirm.checked) { setStatus('必须勾选「我确认修改自动续期设置」才会保存', 'fail'); return; }
    var enabled = !!S.autoEnabled.checked;
    var days = parseInt(S.autoDays.value, 10);
    var params = { enabled: enabled, confirm: true };
    if (isFinite(days) && days >= 1) params.days_before = days;
    var ca = S.autoCA.value.trim(); if (ca) params.ca = ca;
    var wr = S.autoWebroot.value.trim(); if (wr) params.webroot = wr;
    var em = S.autoEmail.value.trim(); if (em) params.email = em;
    S.autoSubmit.disabled = true;
    setStatus('正在保存 ACME 设置' + (enabled ? '并开启自动续期（会允许内核每天联网检查）…' : '并关闭自动续期…'));
    invoke('ssl.acme.auto', params).then(function (result) {
      if (S.destroyed) return result;
      S.autoResult = result; paintAutoResult();
      // 开启时把 task 原样 POST 到 scheduler（插件无权自建任务，ADR-0019 / G-19）。
      var task = result && result.task;
      if (!enabled || !task || !task.name) {
        setStatus('ACME 设置已保存' + (enabled ? '；但返回里没有可创建的定时任务，请联系管理员检查插件版本' : ''),
          enabled ? 'fail' : 'ok');
        loadBuiltinStatus();
        return result;
      }
      return loadTasks().then(function () {
        if (findTask(task.name)) {
          setStatus('ACME 设置已保存；自动续期任务 ' + task.name + ' 已存在，未重复创建', 'ok');
          return result;
        }
        var body = { name: task.name, plugin: task.plugin, method: task.method,
          params: task.params, schedule: task.schedule || RENEW_SCHEDULE, timeout_s: 300, enabled: true };
        return request(SCHED, 'POST', body).then(function (created) {
          S.tasks.push(created);
          setStatus('ACME 设置已保存；已创建自动续期任务 ' + created.name +
            '，每天 03:00 检查（到期前才续），下次 ' + fmtTime(created.next_run_at), 'ok');
          return result;
        });
      });
    }).then(function () {
      if (!S.destroyed) { S.autoConfirm.checked = false; if (S.autoSubmit) S.autoSubmit.disabled = false; loadBuiltinStatus(); }
    }, function (err) {
      if (!S.destroyed) setStatus('保存 ACME 设置失败：' + errText(err) +
        '。检查 webroot 是否为站点根目录、CA 是否需要 EAB；自动续期未生效前不会产生联网任务。', 'fail');
      if (S.autoSubmit) S.autoSubmit.disabled = false;
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
      S.certs = data.certs || []; paintCerts(); fillHTTPSFromCerts();
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
    add(head, el('p', 'view-sub', '到期告警、自签 / 导入 / 自动续期与真实 TLS 握手验证；ACME 有内置（默认推荐，零外部依赖）与外部客户端两条路线，均需手动确认。'));
    var bar = add(root, el('div', 'ssl-toolbar')), vbox = add(bar, el('div', 'ssl-verify-box'));
    S.verifyHost = add(vbox, input('text', 'ssl-verify-input', 'host 或 host:port（如 127.0.0.1:443）'));
    S.verifyHost.setAttribute('aria-label', '验证目标 host 或 host:port');
    var vbtn = add(vbox, el('button', 'btn btn-primary', '验证')); vbtn.type = 'button'; on(vbtn, verify);
    var refresh = add(bar, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, function () { load(false); loadExpiry(); loadBuiltinStatus(); loadACME(); loadHTTPS(true); });
    S.status = add(root, el('div', 'ssl-status muted')); S.status.setAttribute('role', 'status');
    S.expiryHost = add(root, el('div', 'ssl-expiry-host'));
    S.expiryActions = add(root, el('div', 'ssl-expiry-actions')); S.expiryActions.hidden = true;
    S.verifyOutHost = add(root, el('div', 'ssl-verifyresult'));
    var list = panel(root, '证书列表');
    S.count = list.querySelector('.panel-head').appendChild(el('span', 'panel-meta', ''));
    S.certHost = add(list, el('div', 'ssl-certs'));

    // 强制 HTTPS 卡片：域名自动填第一张证书，按钮/触摸目标内联 44px 不依赖样式文件（写域约束）。
    var enforce = panel(root, '强制 HTTPS', '让网站自动从 http 跳到 https');
    var ef = add(enforce, el('form', 'ssl-form'));
    S.httpsDomain = input('text', 'span2', '要设置的站点域名（如 www.example.com）');
    S.httpsDomain.setAttribute('aria-label', '要开启强制 HTTPS 的站点域名');
    S.httpsDomain.addEventListener('input', function () { S.httpsUserEdited = true; });
    field(ef, '站点域名', S.httpsDomain, 'span2');
    S.httpsAutoNote = add(ef, el('p', 'field-hint span2', ''));
    var eops = add(ef, el('div', 'span2 ssl-https-ops'));
    eops.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
    var checkBtn = add(eops, el('button', 'btn btn-ghost', '查看当前状态'));
    checkBtn.type = 'button'; checkBtn.style.minHeight = 'var(--kore-touch)';
    checkBtn.style.minWidth = 'var(--kore-touch)';
    on(checkBtn, function () { loadHTTPS(false); });
    S.httpsCheckBtn = checkBtn;
    S.httpsBtnOn = add(eops, el('button', 'btn btn-primary', '开启强制 HTTPS'));
    S.httpsBtnOn.type = 'button'; S.httpsBtnOn.style.minHeight = 'var(--kore-touch)';
    S.httpsBtnOn.style.minWidth = 'var(--kore-touch)';
    on(S.httpsBtnOn, function () { changeHTTPS(true, S.httpsBtnOn); });
    S.httpsBtnOff = add(eops, el('button', 'btn btn-ghost', '关闭强制 HTTPS'));
    S.httpsBtnOff.type = 'button'; S.httpsBtnOff.style.minHeight = 'var(--kore-touch)';
    S.httpsBtnOff.style.minWidth = 'var(--kore-touch)';
    on(S.httpsBtnOff, function () { changeHTTPS(false, S.httpsBtnOff); });
    add(ef, el('p', 'field-hint span2',
      '开启只是先在本页记下设置；真正让浏览器自动跳转，还需到网站页绑定证书并开启跳转。点「查看当前状态」可看是否已生效。'));
    S.httpsStatusHost = add(enforce, el('div', 'ssl-https-status'));
    paintHTTPS();

    // 内置 ACME 卡片（默认主推、零外部依赖）：只读 status 自动探测，签发/自动续期需显式确认。
    var builtin = panel(root, 'ACME 证书（内置 · 推荐）', '零外部依赖 · 需手动确认 · 会联网');
    S.builtinStatusHost = add(builtin, el('div', 'ssl-acme-status'));
    var bf = add(builtin, el('form', 'ssl-form ssl-acme-form'));
    S.bDomain = input('text', '', 'www.example.com'); field(bf, '域名', S.bDomain);
    S.bEmail = input('email', '', 'ops@example.com（可选，CA 用于联系）'); field(bf, '账号邮箱', S.bEmail);
    S.bCA = el('select', 'field-input');
    [['letsencrypt-staging', 'Let\'s Encrypt staging（测试，不占配额）'],
      ['letsencrypt', 'Let\'s Encrypt（生产）'], ['litessl', 'LiteSSL（需 EAB）']].forEach(function (o) {
      var opt = el('option', null, o[1]); opt.value = o[0]; S.bCA.appendChild(opt);
    });
    field(bf, 'CA 服务商', S.bCA);
    S.bWebroot = input('text', 'span2', '/install/data/sites/你的域名');
    S.bWebroot.setAttribute('aria-label', '站点根目录 webroot（HTTP-01 校验文件写入处）');
    field(bf, '站点根目录（webroot）', S.bWebroot, 'span2');
    S.bWebrootNote = add(bf, el('p', 'field-hint span2', 'HTTP-01 校验文件会临时写进这个目录，签发后自动删除。'));
    var bConfirmBox = add(bf, el('label', 'field ssl-acme-confirm span2'));
    S.bConfirm = el('input'); S.bConfirm.type = 'checkbox';
    bConfirmBox.appendChild(S.bConfirm);
    add(bConfirmBox, el('span', null, '我确认由内置 ACME 联网向 CA 申请证书（首次建议先用 staging）'));
    S.bSubmit = add(bf, el('button', 'btn btn-primary ssl-submit', '申请证书（需勾选确认）'));
    S.bSubmit.type = 'submit'; S.bSubmit.disabled = true;
    S.bSubmit.style.minHeight = 'var(--kore-touch)'; S.bSubmit.style.minWidth = 'var(--kore-touch)';
    add(bf, el('p', 'field-hint span2',
      '会占用 80 端口；域名需先解析到本机且 80 可访问。失败提示里会给排查办法，可先切 staging 跑通。'));
    S.bConfirm.addEventListener('change', function () { S.bSubmit.disabled = !S.bConfirm.checked; });
    bf.addEventListener('submit', submitBuiltinIssue);
    // 自动续期设置（独立的显式确认门；开启后把 task 落到内核 scheduler）。
    var af2 = add(builtin, el('form', 'ssl-form ssl-acme-form'));
    add(af2, el('p', 'field-hint span2', '自动续期默认关闭：开启后内核每天 03:00 检查，到期前才联网续期；关闭则不联网。'));
    var autoEnableBox = add(af2, el('label', 'field ssl-acme-confirm span2'));
    S.autoEnabled = el('input'); S.autoEnabled.type = 'checkbox';
    autoEnableBox.appendChild(S.autoEnabled);
    add(autoEnableBox, el('span', null, '开启自动续期（会允许内核按计划联网检查）'));
    S.autoDays = input('number', '', '30'); S.autoDays.value = '30';
    S.autoDays.min = '1'; S.autoDays.max = '90'; field(af2, '到期前多少天续期', S.autoDays);
    S.autoCA = input('text', '', 'letsencrypt-staging（留空表示不改）'); field(af2, 'CA（可选）', S.autoCA);
    S.autoWebroot = input('text', '', '站点根目录（留空表示不改）'); field(af2, 'webroot（可选）', S.autoWebroot);
    S.autoEmail = input('email', '', '账号邮箱（可选）'); field(af2, '邮箱（可选）', S.autoEmail);
    var autoConfirmBox = add(af2, el('label', 'field ssl-acme-confirm span2'));
    S.autoConfirm = el('input'); S.autoConfirm.type = 'checkbox';
    autoConfirmBox.appendChild(S.autoConfirm);
    add(autoConfirmBox, el('span', null, '我确认保存上述设置（修改会写入 ACME 配置）'));
    S.autoSubmit = add(af2, el('button', 'btn btn-ghost ssl-submit', '保存 ACME 设置'));
    S.autoSubmit.type = 'submit'; S.autoSubmit.disabled = true;
    S.autoSubmit.style.minHeight = 'var(--kore-touch)'; S.autoSubmit.style.minWidth = 'var(--kore-touch)';
    S.autoConfirm.addEventListener('change', function () { S.autoSubmit.disabled = !S.autoConfirm.checked; });
    af2.addEventListener('submit', submitAuto);
    S.bResultHost = add(builtin, el('div', 'ssl-verifyresult'));
    S.autoResultHost = add(builtin, el('div', 'ssl-verifyresult'));

    // 外部客户端路线（保留，与内置并存、互不互斥）。
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
    build(root); load(false); loadExpiry(); loadBuiltinStatus(); loadACME();
    return { destroy: function () { S.destroyed = true; S.keyPEM = ''; } };
  }
  window.KoreSsl = { render: render };
})();
