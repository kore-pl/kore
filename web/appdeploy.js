/* kore 主壳 · 应用部署（web/appdeploy.js）——零框架 / 零 CDN / 无外链。
   调用形态（硬约束，docs/FRONTEND.md §业务方法调用形态）：POST /api/v1/invoke/app-deploy/app-deploy.<action>。
   读：app-deploy.list / app-deploy.jobs / app-deploy.templates；
   写：app-deploy.upload（content_base64 制品）→ app-deploy.deployFromArtifact（登记部署）、app-deploy.upgrade（同名新包，先快照可回滚）。
   三种降级：插件未安装（E_NOTFOUND + 未安装文案）→ 去商店；无权限（E_UNAUTHORIZED/E_FORBIDDEN）→ 只读说明；
   已确认插件版本低于 0.3.0（确实没有该方法）→ 「去升级」。其它调用失败（含方法名/URL 契约不一致）按原始错误
   中性展示——「未知方法」不是旧插件的证据，不能把自身 bug 包装成用户可操作的升级提示。
   上传用 XHR 以显示真实进度（大包不能没有反馈）。
   本页不轮询：列表与任务都是进页时/用户触发各查一次。 */
(function () {
  'use strict';
  // 方法名必须是 <plugin-id>.<action>（docs/FRONTEND.md §业务方法调用形态）：
  // 控制器按最后一个 '.' 拆插件与动作，漏掉 'app-deploy.' 前缀会被插件当成未知方法。
  var API = '/api/v1/invoke/app-deploy/app-deploy.', TIMEOUT_MS = 30000;
  // upload / deployFromArtifact / upgrade / jobs 是 0.3.0 引入的方法（见插件 CHANGELOG），
  // 只有版本确实低于它，"未知方法" 才可能是旧插件。
  var MIN_METHOD_VERSION = '0.3.0';

  function fresh() {
    return { root: null, notInstalled: false, denied: '', loadError: '', loadCode: '',
      deployments: [], jobs: [], jobsError: '', jobsCode: '',
      upFile: null, upName: '', upBusy: false, upProgress: -1, upResult: null, upError: '',
      upDeploy: null,
      upgSel: '', upgFile: null, upgBusy: false, upgProgress: -1, upgResult: null, upgError: '',
      pluginVersion: '', versionProbed: false,
      destroyed: false };
  }
  var S = fresh();

  function el(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text); return n;
  }
  function add(p, c) { p.appendChild(c); return c; }
  function on(n, fn, type) { n.addEventListener(type || 'click', fn); return n; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) { var kv = parts[i].trim(); if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1)); }
    return '';
  }
  function invoke(method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(Object.assign(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'), { code: '' }));
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    var init = { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {}) };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API + method, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {}; if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (res.ok) return data;
        var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('请求失败（HTTP ' + res.status + '）')));
        err.code = data.code || ''; throw err;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw Object.assign(new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）'), { code: 'E_TIMEOUT' });
      throw err;
    });
  }
  // 上传走 XHR：fetch 拿不到上传进度，大包没有进度条就是"卡死了"的观感。
  function invokeWithProgress(method, payload, onProgress) {
    return new Promise(function (resolve, reject) {
      var token = cookie('kore_csrf');
      if (!token) { reject(Object.assign(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'), { code: '' })); return; }
      var xhr = new XMLHttpRequest();
      xhr.open('POST', API + method, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-Kore-CSRF', token);
      xhr.timeout = TIMEOUT_MS * 4; // 大包上传给 4 倍超时
      if (xhr.upload && onProgress) {
        xhr.upload.addEventListener('progress', function (e) {
          if (e.lengthComputable) onProgress(Math.round(e.loaded * 100 / e.total));
        });
      }
      xhr.addEventListener('load', function () {
        var data = {};
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch (e) { data = { raw: xhr.responseText }; }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(data); return; }
        var err = new Error((data.code ? data.code + '：' : '') + (data.message || ('请求失败（HTTP ' + xhr.status + '）')));
        err.code = data.code || ''; reject(err);
      });
      xhr.addEventListener('error', function () { reject(Object.assign(new Error('网络错误，上传失败'), { code: '' })); });
      xhr.addEventListener('timeout', function () { reject(Object.assign(new Error('上传超时'), { code: 'E_TIMEOUT' })); });
      xhr.send(JSON.stringify(payload));
    });
  }
  function chip(tone, text) { var c = el('span', 'chip chip-' + tone, text); return c; }
  function notice(text, tone) {
    var n = el('div', 'db-notice' + (tone === 'ok' ? ' db-notice-ok' : ''), text);
    n.setAttribute('role', 'alert'); return n;
  }
  function panel(title, metaText) {
    var p = el('section', 'panel');
    var head = add(p, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', title));
    var meta = add(head, el('span', 'panel-meta', metaText || ''));
    return { panel: p, head: head, meta: meta };
  }
  function emptyBlock(text, actionLabel, action) {
    var box = el('div', 'panel-empty');
    add(box, el('p', 'empty-state-text', text));
    if (actionLabel) { var b = add(box, el('button', 'btn btn-primary', actionLabel)); b.type = 'button'; on(b, action); }
    return box;
  }
  function goStore() {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('store');
    else window.location.hash = '#/store';
  }
  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    var u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i ? v.toFixed(1) : v) + ' ' + u[i];
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso); if (isNaN(d.getTime())) return String(iso);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  // 版本比较只服务于"确认旧插件"这一件事：数字逐段比，缺段按 0。
  function versionAtLeast(version, want) {
    var a = String(version || '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var b = String(want || '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return true;
  }
  // 探测已装 app-deploy 的版本（GET /api/v1/plugins，一次进页探测，不轮询）。
  // 探测失败只记 versionProbed=true，版本留空——宁可中性报错，也不猜"去升级"。
  function probePluginVersion() {
    fetch('/api/v1/plugins', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (S.destroyed) return;
        var list = (data && data.plugins) || [], found = null;
        for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === 'app-deploy') found = list[i]; }
        S.pluginVersion = found ? String(found.version || '') : '';
        S.versionProbed = true;
        if (S.loadError) paintList();
        if (S.jobsError) paintJobs();
        if (S.upError) paintUpload();
        if (S.upgError) paintUpgrade();
      }, function () { if (!S.destroyed) S.versionProbed = true; });
  }
  // 降级四态：denied（无权限）/ notinstalled（没装或没 enable）/ unsupported（版本确认更旧）/ other。
  // 「未知方法」只是"方法没找到"的事实，可能是旧插件、也可能是前端 URL 拼错或插件比前端新——
  // 所以 unsupported 必须由版本证据支撑，其余一律 other 按原始错误中性展示。
  function degrade(err) {
    var code = (err && err.code) || '';
    var msg = String((err && err.message) || err || '');
    if (code === 'E_UNAUTHORIZED' || code === 'E_FORBIDDEN' || /无权限|未授权|E_UNAUTHORIZED/.test(msg)) return 'denied';
    if (/未安装|未 enable|插件不存在|插件未启用/.test(msg)) return 'notinstalled';
    if (/未知方法|不支持的方法|method\s+.*not\s+found/i.test(msg)) {
      return (S.pluginVersion && !versionAtLeast(S.pluginVersion, MIN_METHOD_VERSION)) ? 'unsupported' : 'other';
    }
    if (code === 'E_NOTFOUND') return 'notinstalled';
    return 'other';
  }
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var bytes = new Uint8Array(r.result), bin = '', CHUNK = 0x8000;
        for (var i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        try { resolve(btoa(bin)); } catch (e) { reject(new Error('读取文件失败：' + e.message)); }
      };
      r.onerror = function () { reject(new Error('读取文件失败')); };
      r.readAsArrayBuffer(file);
    });
  }
  function artifactNameOf(filename) {
    var n = String(filename || '').toLowerCase().replace(/\.(tar\.gz|tgz|tar|zip)$/, '');
    n = n.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return n || 'app';
  }

  // ---- ① 应用列表 ----
  function paintList() {
    if (!S.listHost) return;
    S.listHost.textContent = '';
    if (S.loadError) {
      var kind = degrade({ code: S.loadCode, message: S.loadError });
      if (kind === 'notinstalled') {
        S.notInstalled = true;
        S.listHost.appendChild(emptyBlock('还没有安装应用部署插件（先去商店装，装好回本页即可上传部署）。',
          '去软件商店安装', goStore));
        return;
      }
      S.listHost.appendChild(notice('列表读取失败：' + S.loadError));
      S.listHost.appendChild(emptyBlock(kind === 'unsupported'
        ? '当前插件版本较低，没有列表方法（已确认版本 ' + S.pluginVersion + ' < ' + MIN_METHOD_VERSION + '）：请到软件商店升级应用部署插件后刷新本页。'
        : '调用失败，错误原文已保留在上面。先点「刷新」重试；反复出现说明前端与插件的方法契约不一致（既不是没装插件，也不是提示你升级就能解决），请把错误原文交给维护者。', '刷新', load));
      return;
    }
    if (S.notInstalled) S.notInstalled = false;
    if (!S.deployments.length) {
      S.listHost.appendChild(emptyBlock('还没有应用：上传一个 tar.gz/zip 制品即可完成第一次部署。',
        '上传第一个应用', function () {
          var n = document.getElementById('adp-up-file'); if (n) n.click();
        }));
      return;
    }
    var wrap = add(S.listHost, el('div', 'plugin-table-wrap'));
    var table = add(wrap, el('table', 'plugin-table'));
    var tr = add(add(table, el('thead')), el('tr'));
    ['应用名', '部署模板', '状态', '创建时间', '操作'].forEach(function (h) { add(tr, el('th', null, h)); });
    var tb = add(table, el('tbody'));
    S.deployments.forEach(function (d) {
      var row = add(tb, el('tr'));
      add(row, el('td', 'mono', d.name || d.id));
      add(row, el('td', null, d.template || 'artifact'));
      var st = add(row, el('td'));
      var tone = d.status === 'running' ? 'ok' : d.status === 'missing' ? 'na' : 'warn';
      st.appendChild(chip(tone, statusText(d.status)));
      add(row, el('td', null, fmtTime(d.created_at)));
      var op = add(row, el('td'));
      var up = add(op, el('button', 'btn btn-ghost', '升级')); up.type = 'button';
      on(up, function () { S.upgSel = d.name || d.id; if (S.upgSelSel) S.upgSelSel.value = S.upgSel; paintUpgrade(); focusEl('adp-upg-file'); });
      var jb = add(op, el('button', 'btn btn-ghost', '看任务')); jb.type = 'button';
      on(jb, function () { loadJobs(); });
    });
  }
  function statusText(s) {
    return s === 'running' ? '运行中' : s === 'missing' ? '未启动容器（制品已就位）' : s === 'stopped' ? '已停止' : (s || '未知');
  }

  // ---- ② 上传部署 ----
  function paintUpload() {
    if (!S.upResultHost) return;
    S.upResultHost.textContent = '';
    if (S.upError) { S.upResultHost.appendChild(notice('上传部署失败：' + S.upError)); return; }
    if (!S.upResult) return;
    var r = S.upResult;
    var box = add(S.upResultHost, el('div', 'adp-result'));
    box.appendChild(chip('ok', '已上传并解压'));
    add(box, el('span', 'mono', (r.name || '') + ' · ' + fmtBytes(r.bytes) + ' · ' + (r.files || 0) + ' 个文件'));
    add(box, el('p', 'adp-path', '已解压到 ' + (r.path || '—')));
    add(box, el('p', 'adp-path mono', 'sha256 ' + (r.sha256 || '—')));
    add(box, el('p', 'adp-path', '任务 ' + (r.job || '—')));
    if (S.upDeploy) {
      var d = S.upDeploy;
      box.appendChild(chip(d.deployed ? 'ok' : 'warn', d.deployed ? '部署已登记' : '部署登记未确认'));
      if (d.site_hint && d.site_hint.hint) add(box, el('p', 'adp-path', '建站提示：' + d.site_hint.hint));
    }
    S.upBusy = false; S.upProgress = -1; paintUpBar();
  }
  function paintUpBar() {
    if (!S.upBar) return;
    S.upBar.hidden = S.upProgress < 0;
    if (S.upProgress >= 0) S.upBarFill.style.width = S.upProgress + '%';
    if (S.upBtn) { S.upBtn.disabled = S.upBusy; S.upBtn.textContent = S.upBusy ? '上传中 ' + (S.upProgress >= 0 ? S.upProgress + '%' : '…') : '上传并部署'; }
  }
  function submitUpload() {
    if (S.upBusy) return;
    var f = S.upFile;
    if (!f) { S.upError = '请先选择一个 tar.gz / zip 制品文件'; paintUpload(); return; }
    var name = (S.upName || '').trim() || artifactNameOf(f.name);
    S.upBusy = true; S.upError = ''; S.upResult = null; S.upDeploy = null; S.upProgress = 0; paintUpBar(); paintUpload();
    fileToBase64(f).then(function (b64) {
      return invokeWithProgress('upload', { name: name, content_base64: b64 }, function (p) { S.upProgress = p; paintUpBar(); });
    }).then(function (up) {
      S.upResult = up; S.upProgress = 100; paintUpload();
      return invoke('deployFromArtifact', { name: name });
    }).then(function (dep) {
      S.upDeploy = dep; paintUpload(); load(); loadJobs();
    }).catch(function (err) {
      S.upBusy = false; S.upProgress = -1;
      S.upError = degrade(err) === 'unsupported'
        ? '当前插件版本较低，没有上传方法（已确认版本 ' + S.pluginVersion + ' < ' + MIN_METHOD_VERSION + '）：请到软件商店升级应用部署插件后重试'
        : String(err && err.message || err);
      paintUpBar(); paintUpload();
    });
  }

  // ---- ③ 升级 ----
  function paintUpgrade() {
    if (!S.upgSelHost) return;
    S.upgSelHost.textContent = '';
    var sel = add(S.upgSelHost, el('select', 'field-input'));
    sel.setAttribute('aria-label', '选择要升级的应用');
    if (!S.deployments.length) {
      var o0 = el('option', null, '（暂无应用）'); o0.value = ''; sel.appendChild(o0); sel.disabled = true;
    } else {
      S.deployments.forEach(function (d) {
        var o = el('option', null, d.name || d.id); o.value = d.name || d.id; sel.appendChild(o);
      });
      sel.value = S.upgSel || (S.deployments[0].name || S.deployments[0].id);
      S.upgSel = sel.value;
    }
    S.upgSelSel = sel;
    on(sel, function () { S.upgSel = sel.value; }, 'change');
    if (S.upgResultHost) {
      S.upgResultHost.textContent = '';
      if (S.upgError) S.upgResultHost.appendChild(notice('升级失败：' + S.upgError));
      if (S.upgResult) {
        var r = S.upgResult, box = add(S.upgResultHost, el('div', 'adp-result'));
        box.appendChild(chip(r.upgraded ? 'ok' : 'warn', r.upgraded ? '升级完成' : '升级未确认'));
        add(box, el('span', null, fmtBytes(r.bytes) + ' · ' + (r.files || 0) + ' 个文件'));
        if (r.snapshot) {
          box.appendChild(chip('ok', '已自动快照，可回滚'));
          add(box, el('p', 'adp-path mono', '快照位置：' + r.snapshot));
        }
        if (r.rolled_back) box.appendChild(chip('warn', '异常已自动回滚'));
        if (r.job && r.job.id) add(box, el('p', 'adp-path', '任务 ' + r.job.id + (r.job.status ? ' · ' + r.job.status : '')));
      }
    }
    if (S.upgBar) { S.upgBar.hidden = S.upgProgress < 0; if (S.upgProgress >= 0) S.upgBarFill.style.width = S.upgProgress + '%'; }
    if (S.upgBtn) { S.upgBtn.disabled = S.upgBusy || !S.deployments.length; S.upgBtn.textContent = S.upgBusy ? '升级中 ' + (S.upgProgress >= 0 ? S.upgProgress + '%' : '…') : '上传新版本并升级'; }
  }
  function submitUpgrade() {
    if (S.upgBusy) return;
    var f = S.upgFile, name = S.upgSel;
    if (!f) { S.upgError = '请选择新版制品文件'; paintUpgrade(); return; }
    if (!name) { S.upgError = '请先上传并部署至少一个应用'; paintUpgrade(); return; }
    S.upgBusy = true; S.upgError = ''; S.upgResult = null; S.upgProgress = 0; paintUpgrade();
    fileToBase64(f).then(function (b64) {
      return invokeWithProgress('upgrade', { name: name, content_base64: b64 },
        function (p) { S.upgProgress = p; paintUpgrade(); });
    }).then(function (r) {
      S.upgResult = r; S.upgProgress = 100; S.upgBusy = false; paintUpgrade(); load(); loadJobs();
    }).catch(function (err) {
      S.upgBusy = false; S.upgProgress = -1;
      S.upgError = degrade(err) === 'unsupported' ? '当前插件版本较低，没有升级方法（已确认版本 ' + S.pluginVersion + ' < ' + MIN_METHOD_VERSION + '）：请到软件商店升级应用部署插件后重试' : String(err && err.message || err);
      paintUpgrade();
    });
  }

  // ---- ④ 任务 / 历史 ----
  function paintJobs() {
    if (!S.jobsHost) return;
    S.jobsHost.textContent = '';
    if (S.jobsError) {
      var kind = degrade({ code: S.jobsCode, message: S.jobsError });
      S.jobsHost.appendChild(emptyBlock(kind === 'unsupported'
        ? '当前插件版本较低，没有任务查询方法（已确认版本 ' + S.pluginVersion + ' < ' + MIN_METHOD_VERSION + '）：请到软件商店升级应用部署插件。'
        : '任务读取失败：' + S.jobsError, '刷新', loadJobs));
      return;
    }
    if (!S.jobs.length) {
      add(S.jobsHost, el('p', 'muted', '还没有任务记录：上传或升级一次就会在这里出现时间线。'));
      return;
    }
    S.jobs.forEach(function (j) {
      var box = add(S.jobsHost, el('div', 'adp-job'));
      var head = add(box, el('div', 'adp-job-head'));
      head.appendChild(chip(j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'fail' : 'warn',
        actionText(j.action) + ' · ' + jobStatusText(j.status)));
      add(head, el('span', 'mono', j.name || ''));
      add(head, el('span', 'muted', fmtTime(j.started_at || j.finished_at)));
      var steps = add(box, el('div', 'adp-steps'));
      (j.steps || []).forEach(function (st, i) {
        if (i) add(steps, el('span', 'adp-step-arrow', '→'));
        var s = add(steps, el('span', 'adp-step ' + (st.status === 'succeeded' ? 'ok' : st.status === 'failed' ? 'fail' : 'run'),
          st.name + (st.status === 'succeeded' ? ' ✓' : st.status === 'failed' ? ' ✗' : ' …')));
      });
      if (j.error) add(box, el('p', 'adp-job-error', '失败原因：' + j.error));
    });
  }
  function actionText(a) {
    return a === 'upload' ? '上传' : a === 'upgrade' ? '升级' : a === 'deployFromArtifact' ? '部署登记' : a === 'deploy' ? '部署' : (a || '任务');
  }
  function jobStatusText(s) {
    return s === 'succeeded' ? '成功' : s === 'failed' ? '失败' : s === 'running' ? '进行中' : (s || '未知');
  }

  function focusEl(id) { var n = document.getElementById(id); if (n) n.focus(); }
  function paintDenied() {
    if (!S.bannerHost) return;
    S.bannerHost.textContent = '';
    if (S.denied) S.bannerHost.appendChild(notice(S.denied));
  }

  function load() {
    return invoke('list', {}).then(function (d) {
      if (S.destroyed) return;
      S.deployments = (d && d.deployments) || [];
      S.loadError = ''; S.loadCode = '';
      paintList(); paintUpgrade();
    }, function (err) {
      if (S.destroyed) return;
      S.loadError = String(err && err.message || err); S.loadCode = (err && err.code) || '';
      if (degrade(err) === 'denied') S.denied = '当前账号没有应用部署的权限（只读展示）：写操作已隐藏，需要管理员在插件设置里授权。';
      paintDenied(); paintList();
    });
  }
  function loadJobs() {
    return invoke('jobs', {}).then(function (d) {
      if (S.destroyed) return;
      S.jobs = (d && (d.jobs || d.items)) || [];
      S.jobsError = ''; S.jobsCode = '';
      paintJobs();
    }, function (err) {
      if (S.destroyed) return;
      S.jobsError = String(err && err.message || err); S.jobsCode = (err && err.code) || '';
      paintJobs();
    });
  }

  var CSS = '' +
    '.adp-banner{margin-bottom:10px}' +
    '.adp-opts{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px}' +
    '.adp-field{flex:1;min-width:200px;display:flex;flex-direction:column;gap:4px}' +
    '.adp-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}' +
    '.adp-progress{flex:1;min-width:160px;height:8px;background:var(--kore-bg-2);border-radius:4px;overflow:hidden}' +
    '.adp-progress[hidden]{display:none}' +
    '.adp-progress-fill{display:block;height:100%;width:0;background:var(--kore-ok,#3fb950);transition:width .2s}' +
    '.adp-hint{margin:0 0 8px;font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.6}' +
    '.adp-path{margin:4px 0 0;font-size:var(--kore-font-12);color:var(--kore-text-2);word-break:break-all}' +
    '.adp-result{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 10px;border:1px solid var(--kore-border-1);border-radius:6px;background:var(--kore-bg-0);font-size:var(--kore-font-13)}' +
    '.adp-job{border:1px solid var(--kore-border-1);border-radius:6px;padding:8px 10px;margin-bottom:8px;background:var(--kore-bg-0)}' +
    '.adp-job-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:var(--kore-font-13)}' +
    '.adp-steps{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;font-size:var(--kore-font-12)}' +
    '.adp-step{padding:2px 6px;border-radius:4px;background:var(--kore-bg-2);color:var(--kore-text-2)}' +
    '.adp-step.ok{color:var(--kore-ok,#3fb950)}.adp-step.fail{color:var(--kore-danger,#f85149)}.adp-step.run{color:var(--kore-warning,#d29922)}' +
    '.adp-step-arrow{color:var(--kore-text-3)}' +
    '.adp-job-error{margin:6px 0 0;font-size:var(--kore-font-12);color:var(--kore-danger,#f85149);word-break:break-all}' +
    '.adp-selhost select{width:100%}' +
    '@media (max-width:640px){.adp-opts{flex-direction:column;align-items:stretch}' +
    '.adp-field{min-width:0}.adp-actions{flex-direction:column;align-items:stretch}' +
    '.adp-actions .btn{min-height:44px;width:100%}.adp-progress{width:100%}}';
  function ensureCss() {
    if (document.getElementById('kore-appdeploy-css')) return;
    var st = el('style'); st.id = 'kore-appdeploy-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  function render(container) {
    ensureCss();
    S = fresh(); S.root = el('div', 'adp-root');
    add(container, S.root);

    S.bannerHost = add(S.root, el('div', 'adp-banner'));

    // ① 列表
    var list = panel('应用列表', '');
    add(S.root, list.panel);
    S.listMeta = add(list.meta, el('span', null, ''));
    S.listHost = add(list.panel, el('div', 'adp-list'));

    // ② 上传部署
    var up = panel('上传部署', '选 tar.gz / zip 制品，上传后自动登记部署');
    add(S.root, up.panel);
    var upForm = add(up.panel, el('div', 'adp-opts'));
    var upFileWrap = add(upForm, el('label', 'field adp-field'));
    add(upFileWrap, el('span', 'field-label', '制品文件'));
    var upFile = add(upFileWrap, el('input', 'field-input')); upFile.type = 'file';
    upFile.accept = '.gz,.tgz,.zip,.tar'; upFile.id = 'adp-up-file';
    on(upFile, function () { S.upFile = upFile.files && upFile.files[0] ? upFile.files[0] : null; S.upError = ''; paintUpload(); }, 'change');
    var upNameWrap = add(upForm, el('label', 'field adp-field'));
    add(upNameWrap, el('span', 'field-label', '应用名（留空按文件名）'));
    var upName = add(upNameWrap, el('input', 'field-input')); upName.placeholder = 'my-app';
    on(upName, function () { S.upName = upName.value; }, 'input');
    var upOps = add(up.panel, el('div', 'adp-actions'));
    S.upBtn = add(upOps, el('button', 'btn btn-primary', '上传并部署')); S.upBtn.type = 'button';
    on(S.upBtn, submitUpload);
    S.upBar = add(upOps, el('div', 'adp-progress')); S.upBar.hidden = true;
    S.upBarFill = add(S.upBar, el('span', 'adp-progress-fill'));
    add(up.panel, el('p', 'adp-hint', '上传是真实传输：包会解压到插件数据目录，成功后自动登记部署（不启容器、不写 nginx）。'));
    S.upResultHost = add(up.panel, el('div', 'adp-result-host'));

    // ③ 升级
    var upg = panel('升级', '同名新版本：先自动快照，异常可回滚');
    add(S.root, upg.panel);
    var upgForm = add(upg.panel, el('div', 'adp-opts'));
    var upgSelWrap = add(upgForm, el('label', 'field adp-field'));
    add(upgSelWrap, el('span', 'field-label', '选择应用'));
    S.upgSelHost = add(upgSelWrap, el('div', 'adp-selhost'));
    var upgFileWrap = add(upgForm, el('label', 'field adp-field'));
    add(upgFileWrap, el('span', 'field-label', '新版制品'));
    var upgFile = add(upgFileWrap, el('input', 'field-input')); upgFile.type = 'file';
    upgFile.accept = '.gz,.tgz,.zip,.tar'; upgFile.id = 'adp-upg-file';
    on(upgFile, function () { S.upgFile = upgFile.files && upgFile.files[0] ? upgFile.files[0] : null; S.upgError = ''; paintUpgrade(); }, 'change');
    var upgOps = add(upg.panel, el('div', 'adp-actions'));
    S.upgBtn = add(upgOps, el('button', 'btn btn-primary', '上传新版本并升级')); S.upgBtn.type = 'button';
    on(S.upgBtn, submitUpgrade);
    S.upgBar = add(upgOps, el('div', 'adp-progress')); S.upgBar.hidden = true;
    S.upBarFill2 = null; S.upgBarFill = add(S.upgBar, el('span', 'adp-progress-fill'));
    S.upgResultHost = add(upg.panel, el('div', 'adp-result-host'));

    // ④ 任务
    var jobs = panel('任务 / 历史', '上传、部署、升级的每一步时间线');
    add(S.root, jobs.panel);
    var jobsOps = add(jobs.head, el('span', 'adp-jobs-ops'));
    var jb = add(jobsOps, el('button', 'btn btn-ghost', '刷新任务')); jb.type = 'button';
    on(jb, loadJobs);
    S.jobsHost = add(jobs.panel, el('div', 'adp-jobs'));

    paintDenied(); paintList(); paintUpload(); paintUpgrade(); paintJobs();
    probePluginVersion();
    load(); loadJobs();
    return { destroy: function () { S.destroyed = true; } };
  }
  window.KoreAppDeploy = { render: render };
})();
