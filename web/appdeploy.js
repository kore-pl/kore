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
      // ① 从模板部署：目录 / 表单 / 结果（模板字段形状来自后端 types.go，见下方 loadTemplates）
      tpls: [], tplError: '', tplLoading: false,
      tplSel: '', tplName: '', tplHostPorts: {}, tplEnvVals: {},
      tplBusy: false, tplMsg: '', tplResult: null,
      // ② 移除部署：页内二次确认（不可逆，输入部署名解锁），后端强制 confirm:true
      rmConfirm: null,
      progWatch: null, progHost: null, progState: null, progText: null, progHint: null,
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

  // ---- 长任务进度反馈层（进行中 / 成功 / 失败三态） ----
  // 上传本身已有 XHR 真实进度（paintUpBar / paintUpgrade）；这里补的是"上传完成→服务端
  // 解压/登记/快照"这段空窗。app-deploy 插件顺序处理请求，服务端忙时并发 jobs 会排队，
  // 所以进行中用阶段文案推进，结束后回读 jobs 的真实步骤覆盖终态。所有 timer 随操作
  // 结束 / 页面销毁立即清理，不做后台常驻轮询（G-19）。
  var ADP_PHASES = [
    { at: 1200, text: '正在解压并校验制品…' },
    { at: 4500, text: '正在登记部署信息…' },
    { at: 10000, text: '服务端仍在处理，请稍候…' }
  ];
  function ensureProgress() {
    if (S.progHost || !S.root) return;
    var host = add(S.root, el('div', 'adp-progress-panel'));
    host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite');
    S.progState = add(host, el('span', 'adp-progress-phase'));
    var track = add(host, el('div', 'adp-progress-track'));
    add(track, el('span', 'adp-progress-fill'));
    S.progText = add(host, el('span', 'adp-progress-text'));
    S.progHint = add(host, el('span', 'adp-progress-hint'));
    S.progHost = host;
    setProgress('idle', '', '');
  }
  function setProgress(tone, phase, hint) {
    if (!S.progHost) return;
    S.progHost.hidden = tone === 'idle';
    S.progHost.className = 'adp-progress-panel adp-progress-' + tone;
    if (S.progState) S.progState.textContent = phase || '';
    if (S.progHint) S.progHint.textContent = hint || '';
    if (S.progText) S.progText.textContent = tone === 'ok' ? '成功' : tone === 'fail' ? '失败' : tone === 'busy' ? '进行中' : '';
    var fill = S.progHost.querySelector('.adp-progress-fill');
    if (fill) fill.style.width = tone === 'ok' ? '100%' : tone === 'fail' ? '100%' : '35%';
  }
  function stopProgress() {
    if (S.progWatch) {
      for (var i = 0; i < S.progWatch.length; i++) clearTimeout(S.progWatch[i]);
      S.progWatch = null;
    }
  }
  // 服务端处理阶段：上传完成后调用，busy 态按阶段推进；done/fail 由调用方在结果回来时覆盖。
  function startProgress(label) {
    ensureProgress(); stopProgress();
    S.progWatch = [];
    setProgress('busy', label + ' · 正在提交到服务端…', '');
    ADP_PHASES.forEach(function (p) {
      S.progWatch.push(setTimeout(function () {
        if (S.destroyed || !S.progWatch) return;
        setProgress('busy', p.text, '');
      }, p.at));
    });
  }
  function progressSteps(jobs, name) {
    // 从 jobs 里找本次任务的真实步骤（优先 name 匹配，否则取最近一条），拼成阶段文案。
    var list = jobs || [], pick = null;
    for (var i = 0; i < list.length; i++) { if (name && list[i].name === name) { pick = list[i]; break; } }
    if (!pick && list.length) pick = list[0];
    if (!pick) return '';
    var parts = [];
    (pick.steps || []).forEach(function (st) {
      parts.push((st.name || '步骤') + (st.status === 'succeeded' ? ' ✓' : st.status === 'failed' ? ' ✗' : ' …'));
    });
    return parts.length ? parts.join(' → ') : jobStatusText(pick.status);
  }
  function progressFail(label, err) {
    var kind = degrade(err);
    var msg = String((err && err.message) || err || '未知错误');
    var hint = kind === 'unsupported'
      ? '当前插件版本较低，没有对应方法；请到软件商店升级应用部署插件后重试。'
      : kind === 'notinstalled'
        ? '应用部署插件未安装或未启用；请先到软件商店安装后重试。'
        : kind === 'denied'
          ? '当前账号没有部署权限；请让管理员在插件设置里授权后重试。'
          : '请检查制品包格式（tar.gz / zip）与文件权限，或稍后重试；反复失败请把错误原文交给维护者。';
    setProgress('fail', label + '失败', msg + '。怎么办：' + hint);
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
      // 移除是危险且不可逆操作（删容器 + 命名卷，含数据库数据）：页内二次确认 + 后端 confirm:true。
      var rm = add(op, el('button', 'btn btn-ghost adp-rm', '移除')); rm.type = 'button';
      var appName = d.name || d.id;
      on(rm, function () { openRemove(appName); });
    });
  }

  // ---- 移除部署：页内二次确认（输入名字解锁），契约 removeParams{name,confirm}（remove.go:15）----
  function openRemove(name) {
    S.rmConfirm = { name: name, typed: '', msg: '', busy: false };
    paintRemove();
    if (S.rmHost && S.rmHost.scrollIntoView) S.rmHost.scrollIntoView({ block: 'nearest' });
  }
  function closeRemove() { S.rmConfirm = null; paintRemove(); }
  function paintRemove() {
    if (!S.rmHost) return;
    S.rmHost.textContent = '';
    var c = S.rmConfirm;
    if (!c) return;
    var p = add(S.rmHost, el('section', 'panel adp-rm-confirm'));
    var h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', '移除部署确认'));
    add(h, el('span', 'panel-meta', '二次确认 · 页面内'));
    add(p, el('p', 'adp-rm-warn', '将停止并删除「' + c.name + '」的全部容器与数据卷（数据库内容一并删除，不可恢复）。普通应用文件会保留。'));
    var form = add(p, el('form', 'adp-rm-form'));
    var w = add(form, el('label', 'field adp-field'));
    add(w, el('span', 'field-label', '请输入上面的部署名（完全一致才解锁确认按钮，防误删）'));
    var inp = add(w, el('input', 'field-input'));
    inp.placeholder = c.name; inp.autocomplete = 'off';
    inp.setAttribute('aria-label', '输入部署名以确认移除');
    on(inp, function () {
      c.typed = inp.value;
      if (ok) ok.disabled = c.typed !== c.name || c.busy;
    }, 'input');
    var ops = add(form, el('div', 'adp-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button'; on(cancel, closeRemove);
    var ok = add(ops, el('button', 'btn btn-primary adp-rm-ok', '确认移除')); ok.type = 'submit';
    ok.disabled = true;
    form.addEventListener('submit', function (ev) { ev.preventDefault(); doRemove(c, ok); });
    S.rmMsg = add(p, el('div', 'adp-rm-msg'));
    if (c.msg) S.rmMsg.textContent = c.msg;
  }
  function doRemove(c, btn) {
    if (c.busy || c.typed !== c.name) return;
    c.busy = true; c.msg = ''; btn.disabled = true;
    if (S.rmMsg) S.rmMsg.textContent = '正在移除 ' + c.name + '…';
    // remove.go:15 契约：只认 name + confirm:true，没有 id 字段（不按任务卡字面猜）。
    invoke('remove', { name: c.name, confirm: true }).then(function (d) {
      if (S.destroyed) return;
      S.rmConfirm = null; paintRemove();
      var warn = (d && d.warnings && d.warnings.length) ? '（注意：' + d.warnings.join('；') + '）' : '';
      startProgress('移除「' + c.name + '」');
      stopProgress(); setProgress('ok', '已移除「' + c.name + '」', '相关容器与数据卷已清理' + warn);
      load(); loadJobs();
    }, function (err) {
      if (S.destroyed) return;
      c.busy = false; btn.disabled = false;
      c.msg = humanError('移除', err);
      if (S.rmMsg) S.rmMsg.textContent = c.msg;
      progressFail('移除', err);
    });
  }
  function statusText(s) {
    return s === 'running' ? '运行中' : s === 'missing' ? '未启动容器（制品已就位）' : s === 'stopped' ? '已停止' : (s || '未知');
  }

  // ---- ① 从内置模板一键部署 ----
  // 契约读自插件源码（kore-plugin-app-deploy/internal/apop/）：
  //   call.go:49  app-deploy.templates → TemplatesResult{templates,count}（入参空对象）
  //   call.go:51  app-deploy.deploy    → deployParams{template,name,ports,env,volumes} → DeployResult
  //   call.go:55  app-deploy.remove    → removeParams{name,confirm:true} → RemoveResult
  //   types.go:174 注意字段是 template（不是 template_id）；name 必须以 kore-app- 开头
  //   validate.go:15 name 须匹配 ^[a-z][a-z0-9-]{0,30}$，长度 ≤31（含前缀）
  //   templates.go 端口默认 default_host_port、env 必填项 required=true
  // 用户看不到内部术语：模板要求用人话展示（内存/端口/必填配置），不暴露镜像名与服务编排。
  var TPL_PREFIX = 'kore-app-';
  function templateRequirements(t) {
    var parts = [];
    if (typeof t.estimated_memory_mb === 'number' && t.estimated_memory_mb > 0) {
      parts.push('内存约 ' + t.estimated_memory_mb + ' MiB');
    }
    var ports = t.ports || [];
    ports.forEach(function (p) {
      parts.push((p.label || '端口') + ' ' + (p.default_host_port || p.container_port || '—') +
        (p.default_host_port ? '（推荐，可改）' : ''));
    });
    var req = (t.env || []).filter(function (e) { return e.required; });
    if (req.length) {
      parts.push('必填配置：' + req.map(function (e) { return e.label || e.key; }).join('、'));
    }
    if ((t.services || []).length > 1) parts.push('含数据库等 ' + t.services.length + ' 个组件');
    return parts.length ? parts.join(' · ') : '开箱即用，无需额外配置';
  }
  function loadTemplates() {
    if (S.tplLoading) return Promise.resolve();
    S.tplLoading = true; S.tplError = ''; paintTemplates();
    return invoke('templates', {}).then(function (d) {
      if (S.destroyed) return;
      S.tpls = (d && d.templates) || [];
      S.tplLoading = false;
      if (!S.tplSel && S.tpls.length) S.tplSel = S.tpls[0].id; // 预设优先：默认选中第一个，点击 ≤3 次可部署
      S.tplError = '';
      paintTemplates();
    }, function (err) {
      if (S.destroyed) return;
      S.tplLoading = false;
      S.tplError = humanError('读取模板目录', err);
      paintTemplates();
    });
  }
  // 人话错误 + 怎么办：按错误码分类给下一步动作，错误原文保留在括号里供排障。
  function humanError(action, err) {
    var code = (err && err.code) || '';
    var raw = String((err && err.message) || err || '未知错误');
    var kind = degrade(err);
    if (kind === 'notinstalled') {
      return action + '失败：应用部署插件还没安装好。怎么办：到软件商店安装并启用后刷新本页。';
    }
    if (kind === 'denied') {
      return action + '失败：当前账号没有部署权限。怎么办：让管理员在插件设置里授权后重试。';
    }
    if (kind === 'unsupported') {
      return action + '失败：插件版本太旧（已确认 ' + S.pluginVersion + ' < ' + MIN_METHOD_VERSION +
        '），没有这个方法。怎么办：到软件商店升级应用部署插件后刷新。';
    }
    if (code === 'E_CONFLICT' || /已被占用|已存在|端口.*占用/.test(raw)) {
      return action + '失败：名称或端口被占用了。怎么办：换一个应用名 / 端口再试（' + raw + '）。';
    }
    if (code === 'E_INVALID' || /非法|缺少必填|未声明|必须在/.test(raw)) {
      return action + '失败：填的内容不合要求。怎么办：按下面提示改好后重试（' + raw + '）。';
    }
    return action + '失败：' + raw + '。怎么办：先点表单里的重试；反复失败把这段原文交给维护者。';
  }
  function tplSelected() {
    for (var i = 0; i < S.tpls.length; i++) { if (S.tpls[i].id === S.tplSel) return S.tpls[i]; }
    return null;
  }
  // 部署名：帮用户自动加插件要求的前缀并收敛成合法形状（原则②自动发现，不让人填环境细节）。
  function normalizedName(raw, tplId) {
    var n = String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/--+/g, '-');
    if (!n) n = String(tplId || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (n.indexOf(TPL_PREFIX) === 0) n = n.slice(TPL_PREFIX.length);
    // 前缀 9 字符，后端总长上限 31 → 用户部分最多 22 字符
    n = n.slice(0, 31 - TPL_PREFIX.length).replace(/-+$/g, '');
    return TPL_PREFIX + (n || 'app');
  }
  function paintTemplates() {
    if (!S.tplHost) return;
    S.tplHost.textContent = '';
    if (S.tplError) { S.tplHost.appendChild(notice(S.tplError)); return; }
    if (S.tplLoading) { S.tplHost.appendChild(el('p', 'adp-hint', '正在读取内置模板目录…')); return; }
    if (!S.tpls.length) {
      S.tplHost.appendChild(emptyBlock('暂时没有可用的内置模板。怎么办：点刷新重试；也可用下面的「上传部署」上传自己的制品。',
        '刷新模板', loadTemplates));
      return;
    }
    // 模板卡片：选中态用按钮 aria-pressed，键盘/触摸都可操作（Tap 目标 ≥44px）。
    var cards = add(S.tplHost, el('div', 'adp-tpl-cards'));
    S.tpls.forEach(function (t) {
      var b = add(cards, el('button', 'adp-tpl-card' + (t.id === S.tplSel ? ' active' : '')));
      b.type = 'button';
      b.setAttribute('aria-pressed', t.id === S.tplSel ? 'true' : 'false');
      add(b, el('span', 'adp-tpl-name', t.name || t.id));
      add(b, el('span', 'adp-tpl-desc', t.description || ''));
      add(b, el('span', 'adp-tpl-req', templateRequirements(t)));
      on(b, function () {
        S.tplSel = t.id; S.tplResult = null; S.tplMsg = '';
        // 换模板时按新模板重置默认值；保留用户已改过的同名 env/端口键不丢。
        S.tplName = normalizedName(t.id, t.id);
        S.tplHostPorts = {}; S.tplEnvVals = {};
        paintTemplates();
      });
    });
    var tpl = tplSelected();
    if (!tpl) return;
    var form = add(S.tplHost, el('div', 'adp-tpl-form'));
    var nameWrap = add(form, el('label', 'field adp-field'));
    add(nameWrap, el('span', 'field-label', '应用名（自动加 kore-app- 前缀，只能用小写字母/数字/连字符）'));
    var nameInp = add(nameWrap, el('input', 'field-input'));
    nameInp.id = 'adp-tpl-name'; nameInp.placeholder = TPL_PREFIX + 'wordpress';
    nameInp.value = S.tplName || normalizedName(tpl.id, tpl.id);
    on(nameInp, function () { S.tplName = nameInp.value; }, 'input');

    // 端口：模板声明了才显示；默认带推荐端口，用户可改（原则①预设优先，不填也能成功）。
    var ports = tpl.ports || [];
    ports.forEach(function (p) {
      var w = add(form, el('label', 'field adp-field'));
      add(w, el('span', 'field-label', (p.label || '端口') + '（宿主机端口，留空用推荐 ' +
        (p.default_host_port || p.container_port || '自动') + '）'));
      var inp = add(w, el('input', 'field-input'));
      inp.type = 'number'; inp.min = '1024'; inp.max = '65535';
      inp.placeholder = String(p.default_host_port || p.container_port || '');
      inp.value = S.tplHostPorts[p.container_port] || '';
      inp.setAttribute('aria-label', (p.label || '端口') + '宿主机端口');
      on(inp, function () { S.tplHostPorts[p.container_port] = inp.value; }, 'input');
    });

    // 环境变量：按模板 env 字段生成；必填项标「必填」，口令项用 password 输入框，
    // 帮助文案直接取自后端模板（原则④小白能看懂）。
    (tpl.env || []).forEach(function (e) {
      var w = add(form, el('label', 'field adp-field'));
      add(w, el('span', 'field-label', (e.label || e.key) + (e.required ? '（必填）' : '') +
        (e.secret ? ' · 留空自动生成' : '')));
      var inp = add(w, el('input', 'field-input'));
      inp.type = e.secret ? 'password' : 'text';
      inp.autocomplete = 'off';
      inp.placeholder = e.default || (e.required ? '请填写' : '自动生成/用默认值');
      inp.value = S.tplEnvVals[e.key] || '';
      if (e.help) inp.title = e.help;
      add(w, el('span', 'field-hint', e.help || ''));
      on(inp, function () { S.tplEnvVals[e.key] = inp.value; }, 'input');
    });

    var ops = add(form, el('div', 'adp-actions'));
    var btn = add(ops, el('button', 'btn btn-primary', S.tplBusy ? '正在部署…' : '从模板一键部署'));
    btn.type = 'button'; btn.disabled = S.tplBusy; btn.id = 'adp-tpl-submit';
    on(btn, submitDeploy);
    var rf = add(ops, el('button', 'btn btn-ghost', '刷新模板')); rf.type = 'button'; on(rf, loadTemplates);
    add(form, el('p', 'adp-hint', '部署会启动真实容器；镜像由内置模板固定，不接受自定义镜像。'));
    if (S.tplMsg) S.tplHost.appendChild(notice(S.tplMsg));
    if (S.tplResult) {
      var r = S.tplResult, box = add(S.tplHost, el('div', 'adp-result'));
      box.appendChild(chip(r.deployed ? 'ok' : 'warn', r.deployed ? '已部署' : '部署未确认'));
      add(box, el('span', 'mono', (r.name || '') + ' · ' + (r.template || '')));
      if (r.access_url) add(box, el('p', 'adp-path', '访问地址：' + r.access_url));
      if (r.id) add(box, el('p', 'adp-path mono', '部署 id：' + r.id));
    }
  }
  function submitDeploy() {
    if (S.tplBusy) return;
    var tpl = tplSelected();
    if (!tpl) { S.tplMsg = '请先选择一个模板。怎么办：点上面的模板卡片。'; paintTemplates(); return; }
    var name = normalizedName(S.tplName, tpl.id);
    if (name.length > 31) { S.tplMsg = '应用名太长（最多 31 个字符）。怎么办：缩短应用名再试。'; paintTemplates(); return; }
    var ports = [], portBad = '';
    (tpl.ports || []).forEach(function (p) {
      if (portBad) return;
      var raw = String(S.tplHostPorts[p.container_port] || '').trim();
      if (!raw) return; // 留空 → 后端自动用推荐端口并向上找可用端口
      var port = parseInt(raw, 10);
      if (!isFinite(port) || port < 1024 || port > 65535) {
        portBad = (p.label || '端口') + '填的不是 1024~65535 之间的数字。怎么办：改成合法端口或留空自动分配。';
        return;
      }
      ports.push({ container_port: p.container_port, host_port: port });
    });
    if (portBad) { S.tplMsg = portBad; paintTemplates(); return; }
    var env = {};
    (tpl.env || []).forEach(function (e) {
      var v = S.tplEnvVals[e.key];
      if (v !== undefined && String(v) !== '') env[e.key] = String(v);
    });
    // 按后端契约 deployParams（types.go:174）：template / name / ports / env / volumes。
    // volumes 不传覆盖项，交给模板默认（后端 prepareVolumes 用 spec.Name 作子目录）。
    S.tplBusy = true; S.tplMsg = ''; S.tplResult = null; paintTemplates();
    startProgress('部署「' + name + '」');
    invoke('deploy', { template: tpl.id, name: name, ports: ports, env: env, volumes: [] }).then(function (d) {
      if (S.destroyed) return;
      S.tplBusy = false; S.tplResult = d; S.tplName = name; paintTemplates();
      stopProgress(); setProgress('ok', '部署「' + name + '」完成', d && d.access_url ? '访问地址：' + d.access_url : '容器已启动');
      load(); loadJobs();
    }, function (err) {
      if (S.destroyed) return;
      S.tplBusy = false; S.tplMsg = humanError('部署', err); paintTemplates();
      progressFail('部署', err);
    });
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
      startProgress('部署「' + name + '」');
      return invoke('deployFromArtifact', { name: name });
    }).then(function (dep) {
      S.upDeploy = dep; paintUpload(); load();
      // 回读 jobs 真实步骤覆盖终态；读不到也不影响成功结果，仅保留成功文案。
      return loadJobs().then(function () {
        stopProgress();
        setProgress('ok', '部署「' + name + '」完成', progressSteps(S.jobs, name) || '已解压并登记部署');
      });
    }).catch(function (err) {
      S.upBusy = false; S.upProgress = -1; stopProgress();
      progressFail('上传部署', err);
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
      S.upgResult = r; S.upgProgress = 100; S.upgBusy = false; paintUpgrade(); load();
      startProgress('升级「' + name + '」');
      return loadJobs().then(function () {
        stopProgress();
        var t = (r && r.rolled_back) ? '升级异常已自动回滚，原版本仍可用' : (r && r.upgraded ? '升级完成' : '升级未确认');
        setProgress(r && r.rolled_back ? 'fail' : 'ok', '升级「' + name + '」· ' + t,
          progressSteps(S.jobs, name) || (r && r.snapshot ? '已自动快照，可回滚' : ''));
      });
    }).catch(function (err) {
      S.upgBusy = false; S.upgProgress = -1; stopProgress();
      progressFail('升级', err);
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
      S.jobsHost.appendChild(window.KoreUI.emptyBlock({
        title: '还没有部署任务',
        text: '上传或升级一次应用就会在这里出现时间线；没有记录通常说明还没做过部署。',
        label: '刷新任务记录', onClick: loadJobs
      }));
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
    '.adp-progress-panel{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 10px;margin-bottom:10px;border:1px solid var(--kore-border-1);border-radius:6px;background:var(--kore-bg-0);font-size:var(--kore-font-12)}' +
    '.adp-progress-panel[hidden]{display:none}' +
    '.adp-progress-phase{flex:1 1 220px;font-weight:600;color:var(--kore-text-1)}' +
    '.adp-progress-track{flex:1 1 100%;height:6px;background:var(--kore-bg-2);border-radius:3px;overflow:hidden}' +
    '.adp-progress-track .adp-progress-fill{width:35%;background:var(--kore-warning,#d29922)}' +
    '.adp-progress-ok .adp-progress-fill{background:var(--kore-ok,#3fb950)}' +
    '.adp-progress-fail .adp-progress-fill{background:var(--kore-danger,#f85149)}' +
    '.adp-progress-text{min-width:44px;text-align:center;padding:4px 8px;border-radius:4px;color:var(--kore-text-2);background:var(--kore-bg-2)}' +
    '.adp-progress-ok .adp-progress-text{color:var(--kore-ok,#3fb950)}' +
    '.adp-progress-fail .adp-progress-text{color:var(--kore-danger,#f85149)}' +
    '.adp-progress-hint{flex:1 1 100%;color:var(--kore-text-3);word-break:break-word}' +
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
    // 从模板部署 + 移除确认：样式复用主壳变量，手机端 ≥44px 触摸目标（裁决41）。
    '.adp-tpl-cards{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}' +
    '.adp-tpl-card{flex:1 1 190px;min-width:170px;min-height:44px;display:flex;flex-direction:column;gap:4px;' +
    'align-items:flex-start;text-align:left;padding:10px;border:1px solid var(--kore-border-1);' +
    'border-radius:6px;background:var(--kore-bg-0);cursor:pointer}' +
    '.adp-tpl-card.active{border-color:var(--kore-info,#58a6ff);background:var(--kore-bg-2)}' +
    '.adp-tpl-name{font-weight:600;color:var(--kore-text-1)}' +
    '.adp-tpl-desc{font-size:var(--kore-font-12);color:var(--kore-text-2);line-height:1.5}' +
    '.adp-tpl-req{font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.5}' +
    '.adp-tpl-form{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;' +
    'padding:10px;border:1px solid var(--kore-border-1);border-radius:6px;background:var(--kore-bg-1)}' +
    '.adp-tpl-form .adp-field{flex:1 1 180px}' +
    '.adp-tpl-form .field-hint{font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.4}' +
    '.adp-rm{color:var(--kore-danger,#f85149)}' +
    '.adp-rm-confirm{border-color:var(--kore-danger,#f85149)}' +
    '.adp-rm-warn{margin:0 0 10px;font-size:var(--kore-font-13);color:var(--kore-danger,#f85149);line-height:1.6}' +
    '.adp-rm-form{display:flex;flex-direction:column;gap:8px}' +
    '.adp-rm-msg{font-size:var(--kore-font-12);color:var(--kore-text-2);word-break:break-word;min-height:16px}' +
    '@media (max-width:640px){.adp-opts{flex-direction:column;align-items:stretch}' +
    '.adp-field{min-width:0}.adp-actions{flex-direction:column;align-items:stretch}' +
    '.adp-actions .btn{min-height:44px;width:100%}.adp-progress{width:100%}' +
    '.adp-tpl-cards{flex-direction:column}.adp-tpl-card{width:100%;min-height:44px}' +
    '.adp-tpl-form{flex-direction:column;align-items:stretch}' +
    '.adp-tpl-form .adp-field{min-width:0}.adp-tpl-form .btn{min-height:44px;width:100%}' +
    '.adp-rm-form .btn{min-height:44px;width:100%}' +
    '.plugin-table .adp-rm{min-height:44px}}';
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
    ensureProgress();

    // ① 列表
    var list = panel('应用列表', '');
    add(S.root, list.panel);
    S.listMeta = add(list.meta, el('span', null, ''));
    S.listHost = add(list.panel, el('div', 'adp-list'));

    // ① 从内置模板部署（预设优先：选中模板即可一键部署，无需填镜像/编排细节）
    var tplPanel = panel('从模板部署', '选内置模板，填个名字就能一键起 WordPress / nginx 等');
    add(S.root, tplPanel.panel);
    var tplOps = add(tplPanel.head, el('span', 'adp-jobs-ops'));
    var trf = add(tplOps, el('button', 'btn btn-ghost', '刷新模板')); trf.type = 'button'; on(trf, loadTemplates);
    S.tplHost = add(tplPanel.panel, el('div', 'adp-tpl-host'));

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

    // 移除确认宿主：挂在 root 上，列表重绘不影响它。
    S.rmHost = add(S.root, el('div', 'adp-rm-host'));

    paintDenied(); paintList(); paintTemplates(); paintUpload(); paintUpgrade(); paintJobs(); paintRemove();
    probePluginVersion();
    load(); loadJobs(); loadTemplates();
    return { destroy: function () { S.destroyed = true; stopProgress(); } };
  }
  window.KoreAppDeploy = { render: render };
})();
