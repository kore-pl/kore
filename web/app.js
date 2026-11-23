/* kore 主壳前端 —— 原生 JS，零依赖。
   启动先探测 GET /api/v1/system/info，按三态分流（绝不把 401 误判成"后端未连接"）：
     200 → 已登录，渲染控制台（概览指标卡 + 插件表格 + 启停/调用）
     401 → 渲染登录表单（口令 → POST /api/v1/auth/login，错误逐类显示，不吞错）
     网络错误 / 超时 → 才显示"后端未连接"降级横幅
   写请求（POST）一律带 X-Kore-CSRF 双提交头；cookie 缺失时先 GET 一次探测触发重新下发，
   仍缺失则明确提示刷新，不静默失败。状态一律「点 + 文本」双通道（FRONTEND §6 红线 9）。
   退出下沉（DESIGN-AUDIT P0-1 / C10 三级）：顶栏不再放「退出」，只有「设置」图标入口，
   退出登录唯一入口在 设置 → 账户与安全（settings.js，二次确认）。
   概览重排（DESIGN-AUDIT P0-3 / DESIGN-SYSTEM C4）：四张指标卡（32px Display 大数字 +
   迷你进度条 + 状态点）→ 服务/插件两张状态卡 → 告警摘要 → 折叠的系统信息键值。
   插件 UI 走独立 origin iframe + postMessage 桥（裁决40/41），不进主壳 realm。 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  if (!app) return;

  var ENDPOINTS = {
    health: '/-/healthz',
    info: '/api/v1/system/info',
    plugins: '/api/v1/plugins',
    login: '/api/v1/auth/login'
  };
  var REQUEST_TIMEOUT_MS = 5000;
  var LOGIN_TIMEOUT_MS = 8000;
  var WRITE_TIMEOUT_MS = 15000;

  // 会话/视图状态：authed 由 system/info 的状态码决定，不靠猜测。
  var state = {
    authed: false,
    health: null,
    info: null,
    plugins: [],
    notice: '',
    pendingNotice: '',
    ping: Object.create(null)
  };
  // 一键升级的运行态：放模块级，跨重绘保留（重绘只换 DOM，不丢进度）。
  var upgradeBatch = { running: false, done: 0, total: 0, failed: [], message: '' };
  // 概览数据缓存：跨重绘保留（loadOverview 异步回填后原位更新，不整页重绘）。
  // sys=null 表示尚未采样；svc 各键 null 表示该来源读取失败或插件未启用（诚实降级，不编 0）。
  var ov = {
    sys: null, sysSrc: '', sysReason: '',
    svc: { sites: null, ssl: null, db: null },
    alerts: null, alertBusy: false
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtInt(value) {
    return typeof value === 'number' && isFinite(value) ? String(value) : '—';
  }

  // 读非 HttpOnly 的 kore_csrf（双提交要求前端可读；会话 cookie 仍 HttpOnly）。
  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }

  function errText(err) {
    if (!err) return '未知错误';
    if (err.name === 'AbortError') return '请求超时';
    return err.message ? String(err.message) : '网络请求失败';
  }

  // 统一请求：永不因 HTTP 状态码 reject（401/429 由调用方分流），只有网络/超时 reject。
  function request(url, init, timeoutMs) {
    var opts = init || {};
    opts.credentials = 'same-origin';
    opts.cache = 'no-store';
    if (!opts.headers) opts.headers = {};
    if (!opts.headers.Accept) opts.headers.Accept = 'application/json';
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || REQUEST_TIMEOUT_MS) : null;
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(url, opts).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {};
        if (raw) {
          try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; }
        }
        return { ok: res.ok, status: res.status, data: data };
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      throw err;
    });
  }

  // 错误体统一口径：{code,message,detail}。界面只说人话，错误码留给调试（title / 控制台）。
  function describeError(res) {
    var body = (res && res.data) || {};
    var message = body.message ? String(body.message) : '';
    if (message) return message;
    if (res && res.status === 401) return '会话已失效，请重新登录';
    return '操作未完成（HTTP ' + (res && res.status ? res.status : '?') + '）';
  }

  // CSRF 双提交：cookie 缺失时先 GET 一次探测（服务端仅在登录成功时下发），仍无则明确报错。
  function ensureCsrf() {
    var token = readCookie('kore_csrf');
    if (token) return Promise.resolve(token);
    return request(ENDPOINTS.info).then(function () {
      return readCookie('kore_csrf');
    }, function () {
      return readCookie('kore_csrf');
    });
  }

  function writeJson(url, body, timeoutMs) {
    return ensureCsrf().then(function (token) {
      if (!token) throw new Error('缺少 CSRF 令牌（kore_csrf），请刷新页面或重新登录后重试');
      return request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kore-CSRF': token },
        body: body === undefined ? '{}' : JSON.stringify(body)
      }, timeoutMs || WRITE_TIMEOUT_MS);
    });
  }

  function probeHealth() {
    return request(ENDPOINTS.health).then(
      function (res) { return { reached: true, res: res }; },
      function (err) { return { reached: false, error: err }; }
    );
  }

  function probeInfo() {
    return request(ENDPOINTS.info).then(
      function (res) { return { reached: true, res: res }; },
      function (err) { return { reached: false, error: err }; }
    );
  }

  // 状态标签：cls 决定点色（ok/warn/fail），info=true 用信息蓝（lazy 空闲态，不是故障）。
  function statusTag(st) {
    var wrap = el('span', 'tag');
    var dot = el('span', 'dot ' + (st.cls || ''));
    if (st.info) dot.style.background = 'var(--kore-info)';
    if (st.title) { wrap.title = st.title; dot.title = st.title; }
    wrap.appendChild(dot);
    wrap.appendChild(el('span', null, st.text));
    return wrap;
  }

  function healthState() {
    var h = state.health;
    if (!h) return { cls: 'warn', text: '检测中' };
    if (!h.reached) return { cls: 'fail', text: '不可达' };
    if (!h.res.ok) return { cls: 'fail', text: '异常' };
    return { cls: 'ok', text: '正常' };
  }

  function infoState() {
    if (!state.authed) return { cls: 'warn', text: '未登录' };
    if (!state.info) return { cls: 'warn', text: '检测中' };
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

  function panel(title, rows) {
    var box = el('section', 'panel');
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', title));
    box.appendChild(head);
    var table = el('table', 'rows');
    for (var i = 0; i < rows.length; i++) table.appendChild(rows[i]);
    box.appendChild(table);
    return box;
  }

  // 空状态统一给下一步动作，而不是只留一句冷冰冰的"暂无数据"。
  function emptyState(text, routeId, label) {
    var wrap = el('div', 'panel-empty empty-state');
    wrap.appendChild(el('p', 'empty-state-text', text));
    if (routeId) {
      var btn = el('button', 'btn', label || '去软件商店');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
          window.KoreShell.navigate(routeId);
        } else {
          window.location.hash = '#/' + routeId;
        }
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function replaceNode(oldNode, newNode) {
    if (oldNode && oldNode.parentNode) {
      oldNode.parentNode.replaceChild(newNode, oldNode);
    }
  }

  function noticeBar(message) {
    var box = el('div', 'notice');
    box.appendChild(el('span', 'dot fail notice-dot'));
    var text = el('div');
    text.className = 'notice-body';
    text.appendChild(el('div', 'notice-title', '操作未完成'));
    text.appendChild(el('div', 'notice-hint', message));
    box.appendChild(text);
    var close = el('button', 'btn btn-ghost notice-close', '关闭');
    close.type = 'button';
    close.addEventListener('click', function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    });
    box.appendChild(close);
    return box;
  }

  // 仅用于「网络层不可达」：401 不再落到这里。
  function degraded(message) {
    var box = el('div', 'notice');
    box.appendChild(el('span', 'dot warn notice-dot'));
    var text = el('div');
    text.className = 'notice-body';
    text.appendChild(el('div', 'notice-title', '后端未连接'));
    text.appendChild(el('div', 'notice-hint', message + '；页面以降级模式展示，不阻断静态访问。'));
    box.appendChild(text);
    var retry = el('button', 'btn btn-ghost', '重新检测');
    retry.type = 'button';
    retry.addEventListener('click', start);
    box.appendChild(retry);
    return box;
  }

  /* ===================== 登录视图 ===================== */

  function showLoginError(errBox, message) {
    if (!errBox) return;
    errBox.textContent = message;
    errBox.hidden = false;
  }

  function renderLogin(message) {
    var wrap = el('div', 'login-wrap');
    var card = el('form', 'login-card');
    card.setAttribute('method', 'post');
    card.setAttribute('novalidate', 'novalidate');

    card.appendChild(el('div', 'login-brand', 'Kore'));
    card.appendChild(el('div', 'login-sub', '控制台 · 单管理员登录'));

    var label = el('label', 'field');
    label.appendChild(el('span', 'field-label', '管理员口令'));
    var input = document.createElement('input');
    input.type = 'password';
    input.id = 'kore-password';
    input.name = 'password';
    input.className = 'field-input';
    input.autocomplete = 'current-password';
    input.required = true;
    input.setAttribute('placeholder', '请输入口令');
    label.appendChild(input);
    card.appendChild(label);

    var submit = el('button', 'btn btn-primary btn-block', '登录');
    submit.type = 'submit';
    card.appendChild(submit);

    var errBox = el('div', 'login-error', message || '');
    errBox.id = 'kore-login-error';
    errBox.setAttribute('role', 'alert');
    if (!message) errBox.hidden = true;
    card.appendChild(errBox);
    card.appendChild(el('div', 'login-note', '登录失败 5 次/60 秒后锁定 5 分钟；口令仅在本机校验。'));

    card.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitLogin(input, submit, errBox);
    });

    wrap.appendChild(card);
    if (app.replaceChildren) app.replaceChildren(wrap);
    else { app.innerHTML = ''; app.appendChild(wrap); }
    input.focus();
  }

  function submitLogin(input, submit, errBox) {
    var password = input.value || '';
    if (!password) {
      showLoginError(errBox, '请输入口令');
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = '登录中…';

    request(ENDPOINTS.login, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password })
    }, LOGIN_TIMEOUT_MS).then(function (res) {
      if (res.ok) {
        // 登录成功：服务端已下发 kore_session(HttpOnly) + kore_csrf，回到探测流程重渲染面板。
        start();
        return;
      }
      input.value = '';
      if (res.status === 401) showLoginError(errBox, '口令错误，请重试');
      else if (res.status === 429) showLoginError(errBox, '尝试过于频繁，已被临时锁定，请稍后再试');
      else showLoginError(errBox, '登录失败：' + describeError(res));
      submit.disabled = false;
      submit.textContent = '登录';
      input.focus();
    }, function (err) {
      showLoginError(errBox, '后端未连接：' + errText(err));
      submit.disabled = false;
      submit.textContent = '登录';
    });
  }

  /* ===================== 控制台视图 ===================== */

  // 品牌只在侧栏出现一次；顶栏在壳内只承担状态与设置入口（withBrand 仅给无壳的降级页用）。
  // 退出登录不在顶栏（C10 一级不得放不可逆操作）：唯一入口在 设置 → 账户与安全（二次确认）。
  var TOPBAR_ICON = ['M3 6h14', 'M3 10h14', 'M3 14h14', 'M7 4v4', 'M13 8v4', 'M9 12v4'];
  function iconSvg(paths) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < paths.length; i++) {
      var path = document.createElementNS(NS, 'path');
      path.setAttribute('d', paths[i]);
      svg.appendChild(path);
    }
    return svg;
  }
  function renderTopbar(withBrand) {
    ensureAppCss();
    var bar = el('header', 'topbar');
    if (withBrand) {
      var brand = el('div', 'brand');
      brand.appendChild(el('span', 'brand-name', 'Kore'));
      brand.appendChild(el('span', 'brand-sub', '控制台'));
      bar.appendChild(brand);
    } else {
      bar.classList.add('topbar-solo');
    }

    var conn = el('div', 'conn');
    conn.appendChild(statusTag(healthState()));
    conn.appendChild(el('span', 'conn-label', '健康检查'));
    conn.appendChild(statusTag(infoState()));
    conn.appendChild(el('span', 'conn-label', '系统信息'));

    if (state.authed) {
      // 设置入口（一级 · 可逆）：顶栏 → 设置 → 账户与安全 → 退出，2 次点击仍可达退出。
      var set = el('button', 'topbar-settings');
      set.type = 'button';
      set.id = 'kore-topbar-settings';
      set.setAttribute('aria-label', '设置');
      set.title = '设置';
      set.appendChild(iconSvg(TOPBAR_ICON));
      set.addEventListener('click', function () {
        if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
          window.KoreShell.navigate('settings');
        } else {
          window.location.hash = '#/settings';
        }
      });
      conn.appendChild(set);
    }

    bar.appendChild(conn);
    return bar;
  }

  // residentText 与监控页同源（system/info.supervisor）：分子=当前常驻，分母=常驻上限
  // resident_max（R5-5 槽位保护：resident 限 2、lazy 保底 1 槽），lazy_slots 为可拉起的剩余槽位。
  // 概要页不再自己数插件，避免"概览 2 / 监控 3"的双口径。
  function residentText(sup) {
    var n = fmtInt(sup.resident);
    if (n === '—') return '—';
    var max = fmtInt(sup.resident_max);
    var text = max === '—' ? n + ' / 上限 3' : n + ' / ' + max;
    var lazy = fmtInt(sup.lazy_slots);
    if (lazy !== '—') text += ' · lazy 可用 ' + lazy;
    return text;
  }

  // humanWarnings 把技术字符串翻成人话；原始细节留在 title，供排查时展开。
  function humanWarnings(data) {
    var raw = Array.isArray(data.warnings) ? data.warnings : [];
    var causes = [];
    if (data.delegation === false) causes.push('cgroup 委派未开启');
    if (data.selinux && data.selinux !== 'enforcing') causes.push('SELinux 未启用');
    var text = causes.length
      ? '部分隔离能力不可用（' + causes.join('、') + '），资源限额将以观测模式运行'
      : '部分隔离能力不可用，资源限额将以观测模式运行';
    var node = el('span', 'warn-summary', text);
    node.title = raw.join('；');
    return node;
  }

  function renderInfoPanel() {
    var data = state.info || {};
    var sup = data.supervisor && typeof data.supervisor === 'object' ? data.supervisor : {};
    var rows = [];
    rows.push(row('版本', data.version || '—'));
    rows.push(row('常驻插件', residentText(sup)));
    rows.push(row('插件总数', fmtInt(state.plugins.length)));
    var platform = [data.os, data.arch].filter(Boolean).join(' · ');
    rows.push(row('平台', platform || '—'));
    rows.push(row('cgroup', data.cgroup_mode || '—'));
    if (Array.isArray(data.warnings) && data.warnings.length) {
      rows.push(row('降级告警', humanWarnings(data)));
    }
    var box = panel('系统信息', rows);
    box.id = 'kore-info-panel';
    // 重启计数是历史累计，留在监控页；概览只在非零时给一条黄色小字提示。
    var restarts = typeof sup.restarts === 'number' && isFinite(sup.restarts) ? sup.restarts : 0;
    if (restarts > 0) {
      var note = el('p', 'info-note-warn', '累计重启 ' + restarts + ' 次');
      note.title = '自进程启动以来的累计重启，不代表当前正在抖动';
      box.appendChild(note);
    }
    return box;
  }

  function cell(label, value) {
    var td = el('td');
    td.setAttribute('data-label', label);
    if (value && value.nodeType === 1) td.appendChild(value);
    else td.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    return td;
  }

  function pingState(id) {
    if (!state.ping[id]) state.ping[id] = { supported: true, result: '', error: '' };
    return state.ping[id];
  }

  // 语义化版本比较（MAJOR.MINOR.PATCH）；内核只给原始 latest_version，方向由前端判定。
  function cmpVer(left, right) {
    var a = String(left || '').split('.'), b = String(right || '').split('.');
    for (var i = 0; i < 3; i++) {
      var x = parseInt(a[i], 10), y = parseInt(b[i], 10);
      if (!isFinite(x)) x = 0;
      if (!isFinite(y)) y = 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  // 安装状态：latest（最新）/ upgradable（可升级）/ unindexed（索引未收录）/
  // unknown（老内核未返回 latest_version，不臆造可升级）。
  function pluginUpgradeState(plugin) {
    var latest = plugin && plugin.latest_version ? String(plugin.latest_version) : '';
    if (!latest) return 'unindexed';
    var cmp = cmpVer(latest, plugin.version);
    if (cmp > 0) return 'upgradable';
    if (cmp === 0) return 'latest';
    return 'unindexed';
  }

  function upgradablePlugins() {
    return state.plugins.filter(function (p) {
      return p && p.id && pluginUpgradeState(p) === 'upgradable';
    });
  }

  // 失败文案：后端 message 之外按错误码补一条可执行提示。
  function upgradeErrorText(res) {
    var msg = describeError(res);
    var code = res && res.data && res.data.code ? String(res.data.code) : '';
    if (code === 'E_CONFLICT') msg += '（可先点「重装」再试）';
    else if (code === 'E_UPSTREAM') msg += '（检查网络或镜像后重试）';
    else if (code === 'E_UNAUTHORIZED') msg += '（索引刚更新时需重启 kored）';
    return msg;
  }

  // 单个升级：download=true + force=true；后端保留 desired_state 并重载。
  function runPluginUpgrade(plugin, target) {
    return writeJson('/api/v1/store/install', {
      id: plugin.id, version: target, download: true, force: true
    }, 120000).then(function (res) {
      if (res.status === 401) return { ok: false, message: '登录已过期，请重新登录' };
      if (!res.ok) return { ok: false, message: upgradeErrorText(res) };
      return { ok: true, message: '已升级到 v' + target };
    }, function (err) {
      return { ok: false, message: errText(err) };
    });
  }

  function pluginRow(plugin) {
    var id = plugin.id || '';
    var tr = el('tr', 'plugin-row');
    tr.id = 'kore-row-' + id;
    tr.setAttribute('data-plugin-id', id);

    var idCell = el('div', 'plugin-id');
    idCell.appendChild(el('span', 'plugin-id-name', id));
    if (plugin.name && plugin.name !== id) idCell.appendChild(el('span', 'plugin-id-alias', plugin.name));

    var upState = pluginUpgradeState(plugin);

    tr.appendChild(cell('插件', idCell));
    tr.appendChild(cell('版本', plugin.version));
    tr.appendChild(cell('最新版本', latestCell(plugin, upState)));
    tr.appendChild(cell('深度', plugin.depth_level));
    tr.appendChild(cell('运行方式', plugin.lifecycle));
    tr.appendChild(cell('状态', statusTag(pluginStateTag(plugin))));

    var ops = el('td', 'cell-ops');
    ops.setAttribute('data-label', '操作');

    var enabled = plugin.enabled === true;
    var action = enabled ? 'disable' : 'enable';
    var actionBtn = el('button', 'btn', enabled ? '停用' : '启用');
    actionBtn.type = 'button';
    actionBtn.addEventListener('click', function () {
      lifecycle(plugin, action, tr, actionBtn);
    });
    // 仅可升级时出现「升级」入口；最新/索引未收录不显示，避免无效按钮。
    if (upState === 'upgradable') {
      var upgradeBtn = el('button', 'btn btn-primary plugin-upgrade-btn', '升级');
      upgradeBtn.type = 'button';
      upgradeBtn.title = '升级到 v' + plugin.latest_version + '（保留配置与启用状态）';
      upgradeBtn.addEventListener('click', function () {
        confirmRowUpgrade(plugin, tr, note, upgradeBtn);
      });
      ops.appendChild(upgradeBtn);
    }
    ops.appendChild(actionBtn);

    // 卸载：DELETE /api/v1/plugins/{id}（停进程 + 删程序文件，幂等）。危险色与「停用」灰区分；
    // 老内核探测到 404/405/501 后按钮直接禁用，不做点了才报错的假按钮。
    var uninstallBtn = el('button', 'btn plugin-uninstall-btn', '卸载');
    uninstallBtn.type = 'button';
    uninstallBtn.style.color = 'var(--kore-danger)';
    uninstallBtn.style.borderColor = 'var(--kore-danger)';
    if (state.pluginsUninstallOff === true) {
      uninstallBtn.disabled = true;
      uninstallBtn.title = '当前内核版本不支持卸载插件';
    } else {
      uninstallBtn.title = '卸载插件：停止进程并删除程序文件，业务数据保留（需二次确认）';
      uninstallBtn.addEventListener('click', function () {
        confirmRowUninstall(plugin, tr, note, uninstallBtn);
      });
      if (state.pluginsUninstallOff === undefined) probeRowUninstall();
    }
    ops.appendChild(uninstallBtn);

    var ping = pingState(id);
    var pingBtn = el('button', 'btn', '调用 ping');
    pingBtn.type = 'button';
    if (!enabled || plugin.state !== 'ready' || !ping.supported) {
      pingBtn.disabled = true;
      pingBtn.title = !enabled ? '插件已停用，先点「启用」'
        : (plugin.state !== 'ready' ? '插件当前空闲（lazy 按需启动，未驻留进程）'
          : '该插件不支持 ping 方法');
    }
    pingBtn.addEventListener('click', function () {
      invokePing(plugin, pingBtn, note);
    });
    ops.appendChild(pingBtn);

    var note = el('div', 'row-note');
    if (!ping.supported) note.textContent = '该插件不支持 ping 方法';
    else if (ping.error) { note.textContent = 'ping 失败：' + ping.error; note.className = 'row-note row-note-fail'; }
    else if (ping.result) { note.textContent = 'ping → ' + ping.result; note.className = 'row-note row-note-ok'; }
    else if (!enabled) note.textContent = '已停用（可点「启用」）';
    else if (plugin.state !== 'ready') {
      note.textContent = String(plugin.lifecycle || '') === 'lazy' ? '空闲（按需启动）'
        : '状态 ' + (plugin.state || '未知');
      note.title = String(plugin.lifecycle || '') === 'lazy' ? LAZY_IDLE_TIP : '';
    }
    ops.appendChild(note);

    tr.appendChild(ops);
    return tr;
  }

  // 「最新版本」列：可升级黄字 v当前 → v最新；最新灰字；索引未收录淡灰提示。
  function latestCell(plugin, upState) {
    if (upState === 'upgradable') {
      var arrow = el('span', 'ver-upgradable', plugin.version + ' → ' + plugin.latest_version);
      arrow.title = '可升级：当前 v' + plugin.version + '，索引 v' + plugin.latest_version;
      return arrow;
    }
    if (upState === 'latest') return el('span', 'ver-latest', plugin.latest_version);
    var latest = plugin.latest_version ? String(plugin.latest_version) : '';
    var muted = el('span', 'ver-muted', '索引未收录');
    muted.title = latest ? '索引版本 v' + latest + ' 不高于已装版本' : '商店索引未收录该插件';
    return muted;
  }

  // 行内升级确认：先说明"保留配置与启用状态"，确认后才发请求。
  function confirmRowUpgrade(plugin, tr, note, btn) {
    btn.disabled = true;
    note.className = 'row-note row-note-warn';
    note.textContent = '';
    note.appendChild(document.createTextNode('当前 v' + plugin.version + ' → 新 v' +
      plugin.latest_version + '；升级会保留配置与启用状态。 '));
    var ok = el('button', 'btn btn-primary', '确认升级');
    ok.type = 'button';
    var cancel = el('button', 'btn btn-ghost', '取消');
    cancel.type = 'button';
    ok.addEventListener('click', function () {
      note.className = 'row-note';
      note.textContent = '升级中…';
      ok.disabled = true; cancel.disabled = true;
      runPluginUpgrade(plugin, plugin.latest_version).then(function (res) {
        if (!res.ok) {
          note.className = 'row-note row-note-fail';
          note.textContent = '升级失败：' + res.message;
          ok.disabled = false; cancel.disabled = false; btn.disabled = false;
          return;
        }
        state.pendingNotice = '插件 ' + plugin.id + ' ' + res.message +
          (plugin.enabled === true ? ' · 已重新启用' : ' · 保持停用');
        loadDashboard();
      });
    });
    cancel.addEventListener('click', function () { replaceRow(plugin); });
    note.appendChild(ok);
    note.appendChild(cancel);
  }

  // 卸载能力一次性探测（G-19：无定时器、无轮询）：用永不存在的 id 探 DELETE，
  // 老内核 404/405/501 → 之后所有行内按钮直接禁用。新内核回 200 already_absent，无副作用。
  var uninstallProbing = false;
  function probeRowUninstall() {
    if (uninstallProbing) return Promise.resolve();
    uninstallProbing = true;
    return ensureCsrf().then(function (token) {
      return request(ENDPOINTS.plugins + '/kore-uninstall-probe',
        { method: 'DELETE', headers: { 'X-Kore-CSRF': token } });
    }).then(function (res) {
      uninstallProbing = false;
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        state.pluginsUninstallOff = true;
        renderDashboard();
        return;
      }
      state.pluginsUninstallOff = false;
    }, function () { uninstallProbing = false; });
  }

  // 行内卸载：与商店同一份确认文案、同一 API；成功即移除该行并刷新一次列表。
  function confirmRowUninstall(plugin, tr, note, btn) {
    btn.disabled = true;
    note.className = 'row-note row-note-warn';
    note.textContent = '';
    var head = el('strong', null, '确认卸载 ' + (plugin.name || plugin.id));
    head.style.display = 'block';
    note.appendChild(head);
    note.appendChild(document.createTextNode('将停止该插件并删除其程序文件（data/plugins/' +
      plugin.id + '/ 下所有版本）。插件业务数据（安装目录外）不受影响。此操作不可撤销。 '));
    var ok = el('button', 'btn plugin-uninstall-ok', '确认卸载');
    ok.type = 'button';
    ok.style.color = 'var(--kore-danger)';
    ok.style.borderColor = 'var(--kore-danger)';
    var cancel = el('button', 'btn btn-ghost', '取消');
    cancel.type = 'button';
    ok.addEventListener('click', function () {
      note.className = 'row-note';
      note.textContent = '卸载中…';
      ok.disabled = true; cancel.disabled = true;
      uninstallRowPlugin(plugin).then(function (r) {
        if (!r.ok) {
          if (r.unsupported) { renderDashboard(); return; } // 已降级：整表重绘后按钮为禁用态
          note.className = 'row-note row-note-fail';
          note.textContent = r.message;
          ok.disabled = false; cancel.disabled = false; btn.disabled = false;
          return;
        }
        // 成功：行移除 + 一次列表刷新（复用既有 refresh 入口，不新增轮询）。
        if (tr.parentNode) tr.parentNode.removeChild(tr);
        state.plugins = state.plugins.filter(function (x) { return !x || x.id !== plugin.id; });
        state.notice = r.message;
        refreshPluginsView();
      });
    });
    cancel.addEventListener('click', function () { replaceRow(plugin); });
    note.appendChild(ok);
    note.appendChild(cancel);
  }

  // DELETE 卸载（不做 POST 伪装）；结果按状态码给六种人话，与商店页同一口径。
  function uninstallRowPlugin(plugin) {
    return ensureCsrf().then(function (token) {
      if (!token) return { ok: false, message: '缺少 CSRF 令牌（kore_csrf），请刷新页面或重新登录后重试' };
      return request(ENDPOINTS.plugins + '/' + encodeURIComponent(plugin.id),
        { method: 'DELETE', headers: { 'X-Kore-CSRF': token } }).then(function (res) {
        var d = res.data || {};
        if (res.status === 200 && res.ok) {
          return { ok: true, message: d.already_absent === true ? '该插件已不在，列表已同步'
            : '已卸载 ' + (plugin.name || plugin.id) };
        }
        if (res.status === 404 || res.status === 405) {
          state.pluginsUninstallOff = true;
          return { ok: false, unsupported: true, message: '当前内核版本不支持卸载插件' };
        }
        if (res.status === 409) return { ok: false, message: '插件停不下来，未做任何删除；请查看插件日志或稍后重试' };
        if (res.status === 503) return { ok: false, message: '审计写入失败，操作已整体回滚，插件仍完好' };
        if (res.status === 501) {
          state.pluginsUninstallOff = true;
          return { ok: false, unsupported: true, message: '当前内核版本不支持卸载' };
        }
        if (res.status === 401) {
          state.authed = false;
          renderLogin('会话已过期，请重新登录');
          return { ok: false, message: '会话已过期，请重新登录' };
        }
        return { ok: false, message: '卸载失败：' + describeError(res) };
      });
    }, function (err) {
      return { ok: false, message: '卸载失败：' + (err && err.message ? err.message : '网络错误') };
    });
  }

  // lazy 语义：lifecycle=lazy 的插件按需拉起、空闲退出以省资源，stopped 是正常空闲而非故障。
  var LAZY_IDLE_TIP = '按需启动（lazy）：收到请求才拉起，空闲时退出以省资源；这是正常状态，不是故障。';

  // 四态：运行中（绿）/ 空闲（蓝，lazy+已启用+未运行）/ 已停用（灰，期望停用）/ 异常（红）。
  function pluginStateTag(plugin) {
    // 缺 state 时按"未运行"处理：宁可显示空闲/已停用，也不无证据地宣称运行中。
    var st = String(plugin.state || 'stopped');
    var desired = String(plugin.desired || (plugin.enabled === true ? 'enabled' : 'disabled'));
    var lazy = String(plugin.lifecycle || '') === 'lazy';
    if (st === 'ready' || st === 'running') {
      return { cls: 'ok', text: '运行中', title: '进程已就绪，可处理请求。' };
    }
    if (st === 'stopped' && desired === 'disabled') {
      return { cls: 'na', text: '已停用', title: '用户已停用：不会处理请求，点行内「启用」后生效。' };
    }
    if (st === 'stopped' && desired === 'enabled' && lazy) {
      return { cls: 'na', info: true, text: '空闲', title: LAZY_IDLE_TIP };
    }
    if (st === 'starting' || st === 'draining') {
      // 过渡态：既非空闲也非故障，用黄色提示，避免把 1–2 秒的启停瞬间误报成异常。
      return { cls: 'warn', text: st === 'starting' ? '启动中' : '停止中',
        title: '插件正在' + (st === 'starting' ? '启动' : '停止') + '，稍后刷新即可。' };
    }
    if (st === 'failed') {
      return { cls: 'fail', text: '异常', title: '插件进程异常退出（failed），请查看日志或重启内核。' };
    }
    return { cls: 'fail', text: '异常', title: '非预期状态：state=' + st + '，期望 ' + desired + '；请查看日志。' };
  }

  function replaceRow(plugin) {
    for (var i = 0; i < state.plugins.length; i++) {
      if (state.plugins[i] && state.plugins[i].id === plugin.id) {
        state.plugins[i] = plugin;
        break;
      }
    }
    var oldRow = document.getElementById('kore-row-' + plugin.id);
    if (oldRow) replaceNode(oldRow, pluginRow(plugin));
  }

  function lifecycle(plugin, action, tr, btn) {
    var url = ENDPOINTS.plugins + '/' + encodeURIComponent(plugin.id) + '/' + action;
    btn.disabled = true;
    btn.textContent = action === 'enable' ? '启用中…' : '停用中…';

    writeJson(url, {}).then(function (res) {
      if (res.status === 401) {
        state.authed = false;
        renderLogin('会话已过期，请重新登录');
        return;
      }
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = action === 'enable' ? '启用' : '停用';
        state.notice = '插件 ' + plugin.id + ' ' + (action === 'enable' ? '启用' : '停用') + '失败：' + describeError(res);
        var panelNode = document.getElementById('kore-plugins-panel');
        if (panelNode) {
          var old = document.getElementById('kore-notice');
          var bar = noticeBar(state.notice);
          bar.id = 'kore-notice';
          if (old) replaceNode(old, bar);
          else if (panelNode.parentNode) panelNode.parentNode.insertBefore(bar, panelNode);
        }
        return;
      }
      // 服务端在启停响应里回读单插件视图 → 局部刷新该行，不重排整表。
      var updated = res.data && res.data.id ? res.data : null;
      if (updated) replaceRow(updated);
      else loadDashboard();
      refreshInfo();
    }, function (err) {
      btn.disabled = false;
      btn.textContent = action === 'enable' ? '启用' : '停用';
      state.notice = '插件 ' + plugin.id + ' ' + (action === 'enable' ? '启用' : '停用') + '请求失败：' + errText(err);
      var host = document.getElementById('kore-plugins-panel');
      var existing = document.getElementById('kore-notice');
      var bar = noticeBar(state.notice);
      bar.id = 'kore-notice';
      if (existing) replaceNode(existing, bar);
      else if (host && host.parentNode) host.parentNode.insertBefore(bar, host);
    });
  }

  // 静默刷新系统信息（常驻数/重启计数），只重绘概览（或降级页的信息面板），不动其它节点。
  function refreshInfo() {
    request(ENDPOINTS.info).then(function (res) {
      if (!res.ok) return;
      state.info = res.data || {};
      var overview = document.getElementById('kore-overview');
      if (overview && overview.isConnected) {
        overview.textContent = '';
        buildOverviewInto(overview);
        return;
      }
      var legacy = document.getElementById('kore-info-panel');
      if (legacy) replaceNode(legacy, renderInfoPanel());
    }, function () { /* 静默：失败不打断当前视图，下次操作或「重新检测」会重试 */ });
  }

  // ping：真实方法调用，成功显示服务端原样结果；方法不存在则把该行 ping 标记为不支持。
  // 调用形态：POST /api/v1/invoke/<id>/<id>.<action>——方法段写完整限定名（echo → echo.ping），
  // 裸动词 ping 只有插件的兼容层才认，协议 §7.2 要求 <plugin>.<verb>。
  function invokePing(plugin, btn, note) {
    var url = '/api/v1/invoke/' + encodeURIComponent(plugin.id) + '/' +
      encodeURIComponent(plugin.id + '.ping');
    var entry = pingState(plugin.id);
    btn.disabled = true;
    btn.textContent = '调用中…';

    writeJson(url, {}).then(function (res) {
      btn.textContent = '调用 ping';
      if (res.status === 401) {
        state.authed = false;
        renderLogin('会话已过期，请重新登录');
        return;
      }
      if (res.ok) {
        entry.supported = true;
        entry.error = '';
        entry.result = JSON.stringify(res.data);
        note.className = 'row-note row-note-ok';
        note.textContent = 'ping → ' + entry.result;
        btn.disabled = false;
        return;
      }
      var code = res.data && res.data.code ? String(res.data.code) : '';
      if (code === 'E_NOTFOUND') {
        entry.supported = false;
        entry.result = '';
        entry.error = '';
        note.className = 'row-note';
        note.textContent = '该插件不支持 ping 方法';
        btn.disabled = true;
        btn.title = '该插件不支持 ping 方法';
        return;
      }
      entry.error = describeError(res);
      note.className = 'row-note row-note-fail';
      note.textContent = 'ping 失败：' + entry.error;
      btn.disabled = false;
    }, function (err) {
      btn.textContent = '调用 ping';
      btn.disabled = false;
      entry.error = errText(err);
      note.className = 'row-note row-note-fail';
      note.textContent = 'ping 失败：' + entry.error;
    });
  }

  function renderPluginsPanel() {
    var box = el('section', 'panel');
    box.id = 'kore-plugins-panel';
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', '插件'));
    var reload = el('button', 'btn btn-ghost', '刷新列表');
    reload.type = 'button';
    reload.addEventListener('click', loadDashboard);
    head.appendChild(reload);
    box.appendChild(head);

    if (!state.plugins.length) {
      box.appendChild(emptyState('暂无已安装插件，去软件商店安装。', 'store', '去软件商店'));
      return box;
    }

    box.appendChild(upgradeSummaryPanel());

    var table = el('table', 'plugin-table');
    var thead = el('thead');
    var headRow = el('tr');
    var cols = ['插件', '版本', '最新版本', '深度', '运行方式', '状态', '操作'];
    for (var c = 0; c < cols.length; c++) {
      var th = el('th', null, cols[c]);
      // 状态列表头带 lazy 语义说明：绿=运行中 / 蓝=空闲（正常）/ 灰=已停用 / 红=异常。
      if (cols[c] === '状态') {
        th.title = '运行中=进程就绪；空闲=已启用的 lazy 插件按需启动、空闲退出以省资源（正常）；' +
          '已停用=用户主动停用（正常，不是故障）；异常=启动失败或非预期退出。';
      }
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = el('tbody');
    for (var i = 0; i < state.plugins.length; i++) {
      var plugin = state.plugins[i];
      if (!plugin || !plugin.id) continue;
      tbody.appendChild(pluginRow(plugin));
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  // 插件状态计数：四态口径与 pluginStateTag 一致，汇总条与行内标签永远同一本账。
  function pluginCounts() {
    var c = { total: state.plugins.length, enabled: 0, running: 0, idle: 0, disabled: 0, failed: 0 };
    for (var i = 0; i < state.plugins.length; i++) {
      var p = state.plugins[i] || {};
      var st = String(p.state || '');
      var desired = String(p.desired || (p.enabled === true ? 'enabled' : 'disabled'));
      var lazy = String(p.lifecycle || '') === 'lazy';
      if (desired === 'enabled') c.enabled++; else c.disabled++;
      if (st === 'ready' || st === 'running') c.running++;
      else if (st === 'failed') c.failed++;
      else if (st === 'stopped' && desired === 'enabled' && lazy) c.idle++;
    }
    return c;
  }

  // 顶部汇总条：已启用 N · 运行中 M · 空闲 K · 已停用 J —— 蓝色"空闲"不再被读成故障。
  function summaryBarText() {
    var c = pluginCounts();
    return '已启用 ' + fmtInt(c.enabled) + ' · 运行中 ' + fmtInt(c.running) +
      ' · 空闲 ' + fmtInt(c.idle) + ' · 已停用 ' + fmtInt(c.disabled);
  }

  // 顶部汇总条：N 个已安装 / M 个可升级 + 一键全部升级 + 批量进度。
  function upgradeSummaryPanel() {
    var up = upgradablePlugins();
    var box = el('div', 'store-upgrade-summary panel-upgrade-summary');
    box.id = 'kore-upgrade-summary';
    box.appendChild(el('span', 'store-upgrade-text',
      summaryBarText() + ' · 共 ' + fmtInt(state.plugins.length) + ' 个已安装，' + up.length + ' 个可升级'));
    var btn = el('button', 'btn btn-primary', '一键全部升级');
    btn.type = 'button';
    btn.id = 'kore-upgrade-all';
    if (upgradeBatch.running) btn.textContent = '升级中…';
    else if (!up.length) btn.textContent = '全部已是最新';
    btn.disabled = upgradeBatch.running || up.length === 0;
    btn.title = '逐个升级可升级插件（失败项会列出，不中断剩余升级）';
    btn.addEventListener('click', upgradeAll);
    box.appendChild(btn);

    var status = el('span', 'store-upgrade-status', '');
    status.id = 'kore-upgrade-status';
    status.setAttribute('role', 'status');
    if (upgradeBatch.running) {
      status.textContent = '正在升级 ' + Math.min(upgradeBatch.done + 1, upgradeBatch.total) +
        '/' + upgradeBatch.total + '…';
    } else if (upgradeBatch.message) {
      status.textContent = upgradeBatch.message;
      status.className = 'store-upgrade-status ' +
        (upgradeBatch.failed.length ? 'is-fail' : 'is-ok');
    }
    box.appendChild(status);
    return box;
  }

  function setUpgradeStatus(text) {
    var node = document.getElementById('kore-upgrade-status');
    if (node) node.textContent = text;
  }

  // 一键全部升级：先固定清单，再逐个串行升级；失败收集后一次性报告，不中断队列。
  function upgradeAll() {
    if (upgradeBatch.running) return;
    var list = upgradablePlugins();
    if (!list.length) return;
    upgradeBatch = { running: true, done: 0, total: list.length, failed: [], message: '' };
    var allBtn = document.getElementById('kore-upgrade-all');
    if (allBtn) { allBtn.disabled = true; allBtn.textContent = '升级中…'; }
    var index = 0;
    function step() {
      if (index >= list.length) {
        var okCount = list.length - upgradeBatch.failed.length;
        upgradeBatch.running = false;
        upgradeBatch.message = '批量升级完成：成功 ' + okCount + ' 个' +
          (upgradeBatch.failed.length ? '，失败 ' + upgradeBatch.failed.length + ' 个（' +
            upgradeBatch.failed.join('、') + '）' : '');
        state.pendingNotice = upgradeBatch.message;
        loadDashboard();
        return;
      }
      var plugin = list[index];
      setUpgradeStatus('正在升级 ' + (index + 1) + '/' + upgradeBatch.total + ' · ' +
        plugin.id + '（v' + plugin.version + ' → v' + plugin.latest_version + '）');
      runPluginUpgrade(plugin, plugin.latest_version).then(function (res) {
        if (res.ok) upgradeBatch.done++;
        else upgradeBatch.failed.push(plugin.id + '（v' + plugin.version + '：' + res.message + '）');
        index++;
        step();
      });
    }
    step();
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
      list.appendChild(el('div', 'notice-hint', '暂无可展示的插件界面；插件界面会在需要时加载，不影响首屏速度。'));
    }
    content.appendChild(box);
  }

  function resetAndStart() {
    state.authed = false;
    state.info = null;
    state.plugins = [];
    state.ping = Object.create(null);
    start();
  }

  /* ===================== 视图路由（侧栏壳由 shell.js 提供） =====================
     只有登录成功后的 renderDashboard 注册路由；login / offline 仍走整页替换。
     store / monitor / settings 三个视图模块**懒加载**：切到该视图时才注入
     <script src="/assets/store.js">，不进首屏（FRONTEND §7：d(首屏)/d(视图数)=0）。
     模块缺席或加载失败时明确报错到容器，不退化成"空白页"——静默失败不可接受。 */
  var VIEW_MODULES = Object.create(null); // url → { state: 'loading'|'ready'|'error', error, waiters }

  // ensureModule 保证同一脚本只注入一次；并发切视图共用同一个 promise（不重复请求）。
  // 若模块已被 index.html 预先加载（window 上已有导出），直接复用，不重复注入第二次。
  function ensureModule(url, globalName) {
    var entry = VIEW_MODULES[url];
    if (!entry && window[globalName] && typeof window[globalName].render === 'function') {
      VIEW_MODULES[url] = { state: 'ready', error: null, promise: Promise.resolve(window[globalName]) };
      return VIEW_MODULES[url].promise;
    }
    if (entry && entry.state === 'ready') {
      if (window[globalName] && typeof window[globalName].render === 'function') {
        return Promise.resolve(window[globalName]);
      }
      // 脚本已执行但导出缺失：视为契约破坏，明确报错而不是静默。
      return Promise.reject(new Error(url + ' 未导出 ' + globalName + '.render'));
    }
    if (entry && entry.promise) return entry.promise;

    var record = { state: 'loading', error: null };
    record.promise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = function () {
        var mod = window[globalName];
        if (!mod || typeof mod.render !== 'function') {
          record.state = 'error';
          record.error = new Error(url + ' 已加载但未导出 ' + globalName + '.render');
          reject(record.error);
          return;
        }
        record.state = 'ready';
        resolve(mod);
      };
      script.onerror = function () {
        record.state = 'error';
        record.error = new Error(url + ' 加载失败（HTTP 错误或网络中断）');
        reject(record.error);
      };
      document.head.appendChild(script);
    });
    // 失败后允许下次切视图重试：清掉缓存记录，不把一次网络抖动变成永久白屏。
    record.promise.catch(function () { delete VIEW_MODULES[url]; });
    VIEW_MODULES[url] = record;
    return record.promise;
  }

  // moduleView 返回 shell 需要的 render(container)：同步返回 handle，
  // 异步等模块就绪后再真正渲染；切走时 shell 调 handle.destroy()，
  // 用它把"迟到的渲染"挡在已卸载的容器外（monitor 的轮询也在这里停）。
  function moduleView(globalName, url, label) {
    return function (box) {
      var live = { destroyed: false, handle: null };
      box.appendChild(el('div', 'stub', '正在加载' + label + '…'));

      ensureModule(url, globalName).then(function (mod) {
        if (live.destroyed) return;
        box.textContent = '';
        try {
          var handle = mod.render(box);
          if (handle && typeof handle.destroy === 'function') live.handle = handle;
        } catch (err) {
          box.textContent = '';
          box.appendChild(el('div', 'stub', label + '渲染失败：' + (err && err.message ? err.message : err)));
        }
      }, function (err) {
        if (live.destroyed) return;
        box.textContent = '';
        box.appendChild(el('div', 'stub', label + '不可用：' + (err && err.message ? err.message : '模块加载失败')));
      });

      return {
        destroy: function () {
          live.destroyed = true;
          if (live.handle && typeof live.handle.destroy === 'function') {
            try { live.handle.destroy(); } catch (err) { /* 模块清理失败不阻断切视图 */ }
          }
          live.handle = null;
        }
      };
    };
  }

  function viewNotice(box) {
    if (!state.notice) return;
    var bar = noticeBar(state.notice);
    bar.id = 'kore-notice';
    box.appendChild(bar);
  }

  // 样式随视图注入（integrity.js 先例）：顶栏设置入口 + 概览卡片样式不进 style.css，
  // 不占首屏预算；--kore-font-32（C1 Display 档）由 style.css 令牌表统一提供。
  function ensureAppCss() {
    if (document.getElementById('kore-app-css')) return;
    var CSS = [
      '.topbar-settings{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;' +
        'padding:0 6px;border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);' +
        'background:var(--kore-bg-2);color:var(--kore-text-2);cursor:pointer;font:inherit}' +
        '.topbar-settings:hover{color:var(--kore-text-1);border-color:var(--kore-text-3)}' +
        '.topbar-settings:focus-visible{outline:2px solid var(--kore-info);outline-offset:2px}' +
        '@media (max-width:639px){.topbar-settings{min-width:var(--kore-touch);min-height:var(--kore-touch)}}',
      '.ov-head{display:flex;align-items:center;justify-content:space-between;gap:var(--kore-space-3);' +
        'margin-bottom:var(--kore-space-4)}',
      '.ov-note{margin:0 0 var(--kore-space-2);padding:var(--kore-space-2) var(--kore-space-3);' +
        'color:var(--kore-warning);background:var(--kore-warning-bg);border:1px solid var(--kore-warning);' +
        'border-radius:var(--kore-radius-control);font-size:var(--kore-font-12);word-break:break-word}',
      '.ov-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--kore-space-3);' +
        'margin-bottom:var(--kore-space-6)}',
      '.ov-card{display:flex;flex-direction:column;gap:var(--kore-space-2);padding:var(--kore-space-4);' +
        'background:var(--kore-bg-1);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container);min-width:0}',
      '.ov-card-head{display:flex;align-items:center;justify-content:space-between;gap:var(--kore-space-2)}',
      '.ov-card-title{color:var(--kore-text-3);font-size:var(--kore-font-12)}',
      '.ov-value{display:flex;align-items:baseline;gap:var(--kore-space-1)}',
      '.ov-num{font-size:var(--kore-font-32);font-weight:600;line-height:1.1;' +
        'font-variant-numeric:tabular-nums;color:var(--kore-text-1)}',
      '.ov-unit{font-size:var(--kore-font-12);color:var(--kore-text-3)}',
      '.ov-bar{height:4px;border-radius:2px;background:var(--kore-bg-2);overflow:hidden}',
      '.ov-bar-fill{height:100%;border-radius:2px;background:var(--kore-success)}',
      '.ov-tone-warn{background:var(--kore-warning)}',
      '.ov-tone-fail{background:var(--kore-danger)}',
      '.ov-caption{margin:0;color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.5;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ov-status{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kore-space-3);' +
        'margin-bottom:var(--kore-space-6)}',
      '.ov-panel .panel-head{padding:var(--kore-space-3) var(--kore-space-4) 0}',
      '.ov-panel-body{display:flex;flex-direction:column;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) var(--kore-space-4)}',
      '.ov-row{display:flex;align-items:center;justify-content:space-between;gap:var(--kore-space-3);min-height:24px}',
      '.ov-row-label{color:var(--kore-text-3);font-size:var(--kore-font-12)}',
      '.ov-row-value{display:inline-flex;align-items:center;gap:var(--kore-space-2)}',
      '.ov-row-num{font-size:var(--kore-font-16);font-weight:600;color:var(--kore-text-1);' +
        'font-variant-numeric:tabular-nums}',
      '.ov-alert-panel{margin-bottom:var(--kore-space-4)}',
      '.ov-alert-body{display:flex;flex-direction:column;gap:var(--kore-space-2);padding:var(--kore-space-3) var(--kore-space-4) var(--kore-space-4)}',
      '.ov-alert{display:flex;gap:var(--kore-space-3);padding:var(--kore-space-2) var(--kore-space-3);' +
        'background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-left:4px solid var(--kore-text-3);' +
        'border-radius:var(--kore-radius-control)}',
      '.ov-alert.is-critical{border-left-color:var(--kore-danger)}',
      '.ov-alert.is-warning{border-left-color:var(--kore-warning)}',
      '.ov-alert.is-info{border-left-color:var(--kore-info)}',
      '.ov-alert-main{flex:1;min-width:0}',
      '.ov-alert-line{display:flex;align-items:baseline;gap:var(--kore-space-2);flex-wrap:wrap}',
      '.ov-alert-sev{font-size:var(--kore-font-12);font-weight:600;color:var(--kore-text-2)}',
      '.ov-alert-sev.is-critical{color:var(--kore-danger)}',
      '.ov-alert-sev.is-warning{color:var(--kore-warning)}',
      '.ov-alert-what{font-weight:600;overflow-wrap:anywhere}',
      '.ov-alert-time{color:var(--kore-text-3);font-size:var(--kore-font-12)}',
      '.ov-alert-ok{display:flex;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-1) 0}',
      '.ov-alert-ok span:last-child{margin-left:auto}',
      '.ov-sysinfo{margin-bottom:var(--kore-space-4);background:var(--kore-bg-1);' +
        'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container)}',
      '.ov-sysinfo>summary{cursor:pointer;padding:var(--kore-space-3) var(--kore-space-4);' +
        'color:var(--kore-text-2);font-size:var(--kore-font-13)}',
      '.ov-sysinfo>summary:hover{color:var(--kore-text-1)}',
      '.ov-sysinfo .rows{margin:0 var(--kore-space-4) var(--kore-space-3)}',
      '.ov-sysinfo .ov-caption{padding:0 var(--kore-space-4) var(--kore-space-3)}',
      '@media (max-width:1024px){.ov-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (max-width:639px){.ov-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kore-space-2)}' +
        '.ov-status{grid-template-columns:1fr;gap:var(--kore-space-2)}' +
        '.ov-card{padding:var(--kore-space-3)}' +
        '.ov-head{flex-wrap:wrap}}'
    ].join('');
    var style = el('style', null, CSS);
    style.id = 'kore-app-css';
    document.head.appendChild(style);
  }

  /* ===================== 概览重排（DESIGN-AUDIT P0-3 · DESIGN-SYSTEM C1/C4/C7/C8/C10） =====================     顶层设计：首屏 1 秒内先看到 4 个 32px 大数字（指标卡），其次状态点（服务/插件卡），
     最后才是说明文字（折叠的系统信息 + 告警摘要）。键值表不再平铺 12 行同字号。
     数据来源（每个视图一次，不轮询，G-19）：
       monitor.system（插件）→ 不可用时降级 /api/v1/system/metrics（内核采样，monitor.js 同口径）
       site.list / ssl.list / discover.services → 服务卡计数（插件缺席显示「未启用」，不编 0）
       audit（5 分钟窗口）+ state.plugins + state.info → 告警摘要（阈值与 alerts.js 同一本账）
     样式随视图注入（integrity.js 先例）：不进 style.css、不占首屏预算。 */
  var OV_INVOKE = {
    system: '/api/v1/invoke/monitor/monitor.system',
    sites: '/api/v1/invoke/site/site.list',
    ssl: '/api/v1/invoke/ssl/ssl.list',
    discover: '/api/v1/invoke/discover/discover.services'
  };
  var OV_METRICS = '/api/v1/system/metrics';
  var OV_AUDIT = '/api/v1/audit';
  var OV_ALERT_WINDOW_MS = 5 * 60 * 1000;
  var OV_DENIED_BURST = 5;
  var OV_HIGH_RISK = { 'root.action': '提权动作被拒绝', 'capability.denied': '权限不足被拒绝（让管理员在设置里为该插件授权）' };
  var OV_SEV_TEXT = { critical: '严重', warning: '警告', info: '提示' };

  function ovNum(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function ovTone(pct) {
    var n = ovNum(pct);
    if (n === null) return 'na';
    return n >= 90 ? 'fail' : n >= 80 ? 'warn' : 'ok';
  }
  function ovChip(toneName, text, title) {
    var chip = el('span', 'chip chip-' + toneName);
    chip.appendChild(el('span', 'dot ' + (toneName === 'na' ? '' : toneName)));
    chip.appendChild(el('span', null, text));
    if (title) { chip.title = title; chip.setAttribute('aria-label', text + '（' + title + '）'); }
    return chip;
  }
  function ovBar(pct, toneName, label) {
    var v = Math.max(0, Math.min(100, ovNum(pct) === null ? 0 : pct));
    var bar = el('div', 'ov-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(v)));
    bar.setAttribute('aria-label', label);
    var fill = el('div', 'ov-bar-fill ov-tone-' + toneName);
    fill.style.width = v.toFixed(1) + '%';
    bar.appendChild(fill);
    return bar;
  }
  function ovMetricCard(title, num, unit, toneName, chipText, chipTitle, barPct, caption) {
    var card = el('section', 'ov-card');
    var head = el('div', 'ov-card-head');
    head.appendChild(el('span', 'ov-card-title', title));
    if (chipText) head.appendChild(ovChip(toneName, chipText, chipTitle));
    card.appendChild(head);
    var val = el('div', 'ov-value');
    val.appendChild(el('span', 'ov-num', num));
    if (unit) val.appendChild(el('span', 'ov-unit', unit));
    card.appendChild(val);
    if (barPct !== null && barPct !== undefined) {
      card.appendChild(ovBar(barPct, toneName, title + '占用 ' +
        (ovNum(barPct) === null ? '—' : barPct.toFixed(1)) + '%'));
    }
    card.appendChild(el('p', 'ov-caption', caption));
    return card;
  }

  // 指标卡数据：插件成功 → 全量；失败 → 内核 metrics 降级（缺内存占比，如实标注）。
  function ovFetchSystem() {
    return writeJson(OV_INVOKE.system, {}).then(function (res) {
      if (res.ok && res.data && res.data.cpu) {
        ov.sysSrc = 'plugin'; ov.sysReason = '';
        ov.sys = res.data;
        return;
      }
      return ovFetchKernelMetrics(res.ok ? 'monitor 插件未返回系统数据' : 'monitor 插件不可用（HTTP ' + res.status + '）');
    }, function () {
      return ovFetchKernelMetrics('monitor 插件请求失败');
    });
  }
  function ovFetchKernelMetrics(reason) {
    return request(OV_METRICS).then(function (res) {
      ov.sysSrc = res.ok ? 'kernel' : 'none';
      ov.sysReason = reason;
      ov.sys = res.ok ? res.data : null;
    }, function () {
      ov.sysSrc = 'none'; ov.sysReason = reason; ov.sys = null;
    });
  }
  // invoke 统一口径：成功回 data，失败/超时/插件未装 → null（视图层显示「未启用」，不编 0）。
  function ovFetchInvoke(url) {
    return writeJson(url, {}).then(function (res) {
      return res.ok ? res.data : null;
    }, function () { return null; });
  }
  function ovLoadServices() {
    return Promise.all([
      ovFetchInvoke(OV_INVOKE.sites),
      ovFetchInvoke(OV_INVOKE.ssl),
      ovFetchInvoke(OV_INVOKE.discover)
    ]).then(function (out) {
      ov.svc.sites = out[0] && Array.isArray(out[0].sites) ? out[0].sites : null;
      ov.svc.ssl = out[1] && Array.isArray(out[1].certs) ? out[1].certs : null;
      var db = null;
      if (Array.isArray(out[2])) {
        for (var i = 0; i < out[2].length; i++) {
          var s = out[2][i];
          if (s && (s.id === 'mysql' || s.id === 'mariadb') && s.found && s.running) { db = s; break; }
        }
      }
      ov.svc.db = db;
    });
  }

  // 告警摘要：阈值与 alerts.js 同一本账（审计 denied 激增/高危、插件 failed/反复重启、
  // 槽位满、内核降级告警）；只读 audit/plugins/info，不落库、不轮询（G-19）。
  function ovCollectAlerts() {
    ov.alertBusy = true;
    paintOvAlerts();
    var since = new Date(Date.now() - OV_ALERT_WINDOW_MS).toISOString();
    var tasks = [
      request(OV_AUDIT + '?since=' + encodeURIComponent(since) + '&order=desc&limit=200')
        .then(function (res) { return res; }, function () { return null; })
    ];
    return Promise.all(tasks).then(function (out) {
      var alerts = [];
      var res = out[0];
      var denied = res && res.ok && res.data && Array.isArray(res.data.records)
        ? res.data.records.filter(function (r) { return r.result === 'denied'; }) : [];
      if (denied.length > OV_DENIED_BURST) {
        alerts.push({ severity: 'warning', title: '近期有 ' + denied.length + ' 次被拒绝的操作',
          time: denied[0].at || '' });
      }
      Object.keys(OV_HIGH_RISK).forEach(function (action) {
        var hits = denied.filter(function (r) { return r.action === action; });
        if (hits.length) {
          alerts.push({ severity: 'critical', title: OV_HIGH_RISK[action] + '（' + hits.length + ' 次）',
            time: hits[0].at || '' });
        }
      });
      (state.plugins || []).forEach(function (p) {
        if (!p || !p.id) return;
        var name = p.name || p.id;
        if (p.state === 'failed') {
          alerts.push({ severity: 'critical', title: '插件 ' + name + ' 运行失败', time: '' });
        } else if (Number(p.restarts) > 3) {
          alerts.push({ severity: 'warning', title: '插件 ' + name + ' 反复重启（' + p.restarts + ' 次）', time: '' });
        }
      });
      var info = state.info || {};
      var sup = info.supervisor && typeof info.supervisor === 'object' ? info.supervisor : {};
      if (Number(sup.resident) >= 3) {
        alerts.push({ severity: 'warning', title: '常驻名额已满（最多 3 个插件同时常驻，当前 ' + Number(sup.resident) + ' 个）', time: '' });
      }
      if (Array.isArray(info.warnings) && info.warnings.length) {
        alerts.push({ severity: 'warning', title: '部分隔离能力不可用，资源限额以观测模式运行', time: '' });
      }
      var rank = { critical: 0, warning: 1, info: 2 };
      alerts.sort(function (a, b) { return rank[a.severity] - rank[b.severity]; });
      ov.alerts = alerts;
      ov.alertBusy = false;
      paintOvAlerts();
    });
  }

  function ovFmtClock(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) return '—';
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function paintOvMetrics(host) {
    if (!host || !host.isConnected) return;
    host.textContent = '';
    var sys = ov.sys, src = ov.sysSrc;
    var cpu = (sys && sys.cpu) || {}, mem = (sys && sys.memory) || {},
      load = (sys && sys.load) || {}, disks = (sys && Array.isArray(sys.disks)) ? sys.disks : [];
    var root = null;
    for (var i = 0; i < disks.length; i++) {
      if (disks[i] && disks[i].mount === '/') { root = disks[i]; break; }
    }
    var cpuPct = ovNum(cpu.usage_percent), memPct = ovNum(mem.used_percent);
    var load1 = ovNum(load.load1), cores = ovNum(cpu.cores);
    var diskPct = ovNum(root && root.used_percent);
    var loadTone = 'na';
    if (load1 !== null && cores) loadTone = load1 > cores * 2 ? 'fail' : load1 > cores ? 'warn' : 'ok';
    var cards = [
      ovMetricCard('CPU', cpuPct === null ? '—' : cpuPct.toFixed(1), '%', ovTone(cpuPct),
        cpuPct === null ? '' : (cpuPct >= 90 ? '过高' : cpuPct >= 80 ? '偏高' : '正常'),
        cpuPct === null ? '' : '阈值：≥80% 偏高、≥90% 过高', cpuPct,
        cores ? cores + ' 核 · 采样 ' + (ovNum(cpu.sample_interval_ms) || '—') + ' ms' : '总使用率'),
      ovMetricCard('内存', memPct === null ? '—' : memPct.toFixed(1), '%', ovTone(memPct),
        memPct === null ? '' : (memPct >= 90 ? '过高' : memPct >= 80 ? '偏高' : '正常'),
        memPct === null ? '' : '阈值：≥80% 偏高、≥90% 过高', memPct,
        memPct === null ? '内核指标不含内存占比，需 monitor 插件'
          : (mem.used_human || '—') + ' / ' + (mem.total_human || '—')),
      ovMetricCard('磁盘 /', diskPct === null ? '—' : diskPct.toFixed(1), '%', ovTone(diskPct),
        diskPct === null ? '' : (diskPct >= 90 ? '过高' : diskPct >= 80 ? '偏高' : '正常'),
        diskPct === null ? '' : '阈值：≥80% 偏高、≥90% 过高', diskPct,
        root ? (root.used_human || '—') + ' / ' + (root.total_human || '—')
          : (src === 'kernel' && ovNum(sys && sys.disk_used_kib) !== null
            ? '内核汇总 ' + ((sys.disk_used_kib / 1048576).toFixed(1)) + ' / ' +
              ((sys.disk_total_kib / 1048576).toFixed(1)) + ' GiB'
            : '未读取到根分区')),
      ovMetricCard('负载', load1 === null ? '—' : load1.toFixed(2), '', loadTone,
        load1 === null || !cores ? '' : (load1 > cores * 2 ? '过高' : load1 > cores ? '偏高' : '正常'),
        load1 === null ? '' : '对照核数：1× 核数内正常、1–2× 偏高、>2× 过高',
        load1 !== null && cores ? (load1 / cores) * 100 : null,
        '5 分钟 ' + (ovNum(load.load5) === null ? '—' : load.load5.toFixed(2)) +
        ' · 15 分钟 ' + (ovNum(load.load15) === null ? '—' : load.load15.toFixed(2)))
    ];
    for (var c = 0; c < cards.length; c++) host.appendChild(cards[c]);
    if (src === 'kernel' || src === 'none') {
      var note = document.getElementById('kore-ov-note');
      if (note && note.isConnected) {
        note.hidden = false;
        note.textContent = 'monitor 插件未启用，指标为内核采样降级值（不含内存占比）。' +
          (ov.sysReason ? '原因：' + ov.sysReason : '');
      }
    }
  }

  function ovCountRow(label, toneName, valueText) {
    var rowEl = el('div', 'ov-row');
    rowEl.appendChild(el('span', 'ov-row-label', label));
    var val = el('span', 'ov-row-value');
    val.appendChild(el('span', 'dot ' + (toneName === 'na' ? '' : toneName)));
    val.appendChild(el('span', 'ov-row-num', valueText));
    rowEl.appendChild(val);
    return rowEl;
  }
  function paintOvStatus(host) {
    if (!host || !host.isConnected) return;
    host.textContent = '';
    // 服务卡：站点 / 证书 / 数据库——[色点]+[数字]，句子进 title。
    var svc = el('section', 'panel ov-panel');
    var svcHead = el('div', 'panel-head');
    svcHead.appendChild(el('span', 'panel-title', '服务'));
    svc.appendChild(svcHead);
    var svcBody = el('div', 'ov-panel-body');
    var sites = ov.svc.sites, certs = ov.svc.ssl;
    svcBody.appendChild(ovCountRow('站点', sites === null ? 'na' : (sites.length ? 'ok' : 'na'),
      sites === null ? '未启用' : String(sites.length)));
    svcBody.appendChild(ovCountRow('证书', certs === null ? 'na' : (certs.length ? 'ok' : 'na'),
      certs === null ? '未启用' : String(certs.length)));
    var db = ov.svc.db;
    svcBody.appendChild(ovCountRow('数据库', db ? 'ok' : 'na', db
      ? (String(db.id) === 'mariadb' ? 'MariaDB 运行中' : 'MySQL 运行中')
      : '未检测到'));
    svc.appendChild(svcBody);
    host.appendChild(svc);

    // 插件卡：计数口径与 pluginCounts / 已装插件页同一本账；常驻槽位来自 system/info.supervisor。
    var c = pluginCounts();
    var sup = (state.info && state.info.supervisor) || {};
    var plug = el('section', 'panel ov-panel');
    var plugHead = el('div', 'panel-head');
    plugHead.appendChild(el('span', 'panel-title', '插件'));
    plug.appendChild(plugHead);
    var plugBody = el('div', 'ov-panel-body');
    plugBody.appendChild(ovCountRow('已装', '', String(c.total)));
    plugBody.appendChild(ovCountRow('运行', c.running ? 'ok' : 'na', String(c.running)));
    plugBody.appendChild(ovCountRow('空闲', c.idle ? 'ok' : 'na', String(c.idle)));
    plugBody.appendChild(ovCountRow('已停用', 'na', String(c.disabled)));
    if (c.failed) plugBody.appendChild(ovCountRow('异常', 'fail', String(c.failed)));
    var resident = ovNum(sup.resident), residentMax = ovNum(sup.resident_max);
    var slotText = resident === null ? '常驻 —' : '常驻 ' + resident + ' / ' +
      (residentMax === null ? '3' : residentMax);
    var lazySlots = ovNum(sup.lazy_slots);
    if (lazySlots !== null) slotText += ' · lazy 可用 ' + lazySlots;
    plugBody.appendChild(el('p', 'ov-caption', slotText));
    plug.appendChild(plugBody);
    host.appendChild(plug);
  }

  function paintOvAlerts() {
    var host = document.getElementById('kore-ov-alert-body');
    if (!host || !host.isConnected) return;
    host.textContent = '';
    if (ov.alertBusy || ov.alerts === null) {
      host.appendChild(el('p', 'ov-caption', '正在检查最近 5 分钟的告警…'));
      return;
    }
    if (!ov.alerts.length) {
      var ok = el('div', 'ov-alert-ok');
      ok.appendChild(el('span', 'dot ok'));
      ok.appendChild(el('span', null, '一切正常'));
      ok.appendChild(el('span', 'ov-caption', '检查于 ' + ovFmtClock('')));
      host.appendChild(ok);
      return;
    }
    var top = ov.alerts.slice(0, 3);
    for (var i = 0; i < top.length; i++) {
      var a = top[i];
      var item = el('div', 'ov-alert is-' + a.severity);
      var main = el('div', 'ov-alert-main');
      var line = el('div', 'ov-alert-line');
      line.appendChild(el('span', 'ov-alert-sev is-' + a.severity, OV_SEV_TEXT[a.severity] || '提示'));
      line.appendChild(el('span', 'ov-alert-what', a.title));
      if (a.time) line.appendChild(el('span', 'ov-alert-time', ovFmtClock(a.time)));
      main.appendChild(line);
      item.appendChild(main);
      host.appendChild(item);
    }
    if (ov.alerts.length > 3) {
      host.appendChild(el('p', 'ov-caption', '还有 ' + (ov.alerts.length - 3) + ' 条未展示'));
    }
  }

  function openAlertCenter() {
    ensureModule('/assets/alerts.js', 'KoreAlerts').then(function (mod) {
      if (typeof mod.open === 'function') mod.open();
    }, function (err) {
      state.notice = '告警中心不可用：' + (err && err.message ? err.message : '模块加载失败');
      var overview = document.getElementById('kore-overview');
      if (overview && overview.isConnected) {
        var bar = noticeBar(state.notice);
        overview.parentNode.insertBefore(bar, overview);
      }
    });
  }

  // 剩余键值收进折叠区（C4：主体连续纯文字 ≤3 行 → 超出转表格并折叠）。
  function buildOvSysDetails() {
    var data = state.info || {};
    var sup = data.supervisor && typeof data.supervisor === 'object' ? data.supervisor : {};
    var details = el('details', 'ov-sysinfo');
    details.id = 'kore-ov-sysinfo';
    var summary = el('summary', null, '系统信息');
    summary.setAttribute('aria-label', '展开系统信息（版本、平台、cgroup 模式等只读键值）');
    details.appendChild(summary);
    var rows = [
      row('版本', data.version || '—'),
      row('常驻插件', residentText(sup)),
      row('插件总数', fmtInt(state.plugins.length)),
      row('平台', [data.os, data.arch].filter(Boolean).join(' · ') || '—'),
      row('cgroup', data.cgroup_mode || '—')
    ];
    if (Array.isArray(data.warnings) && data.warnings.length) {
      rows.push(row('降级告警', humanWarnings(data)));
    }
    var table = el('table', 'rows');
    for (var i = 0; i < rows.length; i++) table.appendChild(rows[i]);
    details.appendChild(table);
    var restarts = typeof sup.restarts === 'number' && isFinite(sup.restarts) ? sup.restarts : 0;
    if (restarts > 0) {
      var note = el('p', 'ov-caption', '累计重启 ' + restarts + ' 次（历史累计，不代表当前抖动）');
      details.appendChild(note);
    }
    return details;
  }

  function buildOverviewInto(root) {
    ensureAppCss();
    var head = el('div', 'ov-head');
    var headTitle = el('h2', 'view-title', '概览');
    head.appendChild(headTitle);
    var refresh = el('button', 'btn btn-ghost', '重新检测');
    refresh.type = 'button';
    refresh.addEventListener('click', start);
    head.appendChild(refresh);
    root.appendChild(head);

    var note = el('p', 'ov-note');
    note.id = 'kore-ov-note';
    note.hidden = true;
    note.setAttribute('role', 'status');
    root.appendChild(note);

    var metrics = el('div', 'ov-metrics');
    metrics.id = 'kore-ov-metrics';
    root.appendChild(metrics);
    paintOvMetrics(metrics);

    var status = el('div', 'ov-status');
    status.id = 'kore-ov-status';
    root.appendChild(status);
    paintOvStatus(status);

    var alertPanel = el('section', 'panel ov-alert-panel');
    alertPanel.id = 'kore-ov-alerts';
    var alertHead = el('div', 'panel-head');
    alertHead.appendChild(el('span', 'panel-title', '最近告警'));
    var more = el('button', 'btn btn-ghost', '查看全部');
    more.type = 'button';
    more.addEventListener('click', openAlertCenter);
    alertHead.appendChild(more);
    alertPanel.appendChild(alertHead);
    var alertBody = el('div', 'ov-alert-body');
    alertBody.id = 'kore-ov-alert-body';
    alertPanel.appendChild(alertBody);
    root.appendChild(alertPanel);
    paintOvAlerts();

    root.appendChild(buildOvSysDetails());
  }

  // 数据装载：每个来源独立降级，任何一个失败不拖垮整页；回填后原位重绘对应区块。
  function loadOverview() {
    ovFetchSystem().then(function () { paintOvMetrics(document.getElementById('kore-ov-metrics')); });
    ovLoadServices().then(function () { paintOvStatus(document.getElementById('kore-ov-status')); });
    ovCollectAlerts();
  }

  function renderDashboardView(box) {
    viewNotice(box);
    var root = el('div', 'ov');
    root.id = 'kore-overview';
    buildOverviewInto(root);
    box.appendChild(root);
    loadOverview();
  }

  // 进入视图时轻量补拉一次插件列表：安装后缓存会 stale，但只做「进入 + 手动刷新」，
  // 不引入任何轮询/定时器（G-19）；数据未变不重绘，避免打断当前视图。
  var pluginsRefreshing = false;
  function refreshPluginsView() {
    if (pluginsRefreshing || !state.authed) return;
    pluginsRefreshing = true;
    request(ENDPOINTS.plugins).then(function (res) {
      pluginsRefreshing = false;
      if (res.status === 401) { state.authed = false; renderLogin('会话已过期，请重新登录'); return; }
      if (!res.ok || !res.data) return;
      var next = Array.isArray(res.data.plugins) ? res.data.plugins : [];
      if (JSON.stringify(next) === JSON.stringify(state.plugins)) return;
      state.plugins = next;
      renderDashboard();
    }, function () { pluginsRefreshing = false; });
  }

  function renderPluginsView(box) {
    viewNotice(box);
    box.appendChild(renderPluginsPanel());
    renderPluginUis(box, { status: 'fulfilled', value: { plugins: state.plugins } });
    refreshPluginsView();
  }

  var SHELL_ROUTES = [
    { id: 'dashboard', label: '概览', render: renderDashboardView },
    { id: 'store', label: '软件商店', render: moduleView('KoreStore', '/assets/store.js', '软件商店') },
    { id: 'plugins', label: '已装插件', render: renderPluginsView },
    { id: 'files', label: '文件管理', render: moduleView('KoreFiles', '/assets/files.js', '文件管理') },
    { id: 'sites', label: '网站', render: moduleView('KoreSites', '/assets/sites.js', '网站') },
    { id: 'tasks', label: '计划任务', render: moduleView('KoreTasks', '/assets/tasks.js', '计划任务') },
    { id: 'monitor', label: '监控', render: moduleView('KoreMonitor', '/assets/monitor.js', '监控') },
    { id: 'settings', label: '设置', render: moduleView('KoreSettings', '/assets/settings.js', '设置') }
  ];

  function renderDashboard() {
    if (!window.KoreShell || typeof window.KoreShell.mount !== 'function') {
      renderLegacyDashboard(); // 壳缺席：退回单页，面板不因缺一个脚本而白屏
      return;
    }
    // 首次登录挂壳；后续数据刷新只重绘当前视图，不重建导航（否则丢失视图与滚动位置）。
    var mounted = !!document.getElementById('view');
    if (!mounted) window.KoreShell.mount(SHELL_ROUTES);
    else window.KoreShell.navigate(window.KoreShell.current() || 'dashboard');

    var top = document.getElementById('kore-topbar');
    if (top) {
      top.textContent = '';
      top.appendChild(renderTopbar(false));
    }
  }

  // 视图模块（如 settings.js 退出登录）显式回到站点根 = 归位意图：
  // 鉴权状态只有本文件持有，故由这里重新探测，而不是让视图模块自己猜会话。
  if (window.addEventListener) {
    window.addEventListener('kore:root', function () { resetAndStart(); });
  }

  function renderLegacyDashboard() {
    var root = el('div');
    root.appendChild(renderTopbar(true));
    var content = el('main', 'content');
    viewNotice(content);
    content.appendChild(renderInfoPanel());
    content.appendChild(renderPluginsPanel());
    renderPluginUis(content, { status: 'fulfilled', value: { plugins: state.plugins } });
    root.appendChild(content);
    if (app.replaceChildren) app.replaceChildren(root);
    else { app.innerHTML = ''; app.appendChild(root); }
  }

  // 仅网络层不可达（fetch reject）走这里：明确"后端未连接"，不是登录问题。
  function renderOffline(err) {
    var root = el('div');
    root.appendChild(renderTopbar(true));
    var content = el('main', 'content');
    content.appendChild(degraded('无法连接内核接口：' + errText(err)));
    root.appendChild(content);
    if (app.replaceChildren) app.replaceChildren(root);
    else { app.innerHTML = ''; app.appendChild(root); }
  }

  function loadDashboard() {
    if (!state.authed) return;
    return request(ENDPOINTS.plugins).then(function (res) {
      if (res.status === 401) {
        state.authed = false;
        renderLogin('会话已过期，请重新登录');
        return;
      }
      if (!res.ok) {
        state.plugins = [];
        state.notice = '插件列表读取失败：' + describeError(res);
      } else {
        var body = res.data || {};
        state.plugins = Array.isArray(body.plugins) ? body.plugins : [];
        state.notice = state.pendingNotice || '';
        state.pendingNotice = '';
      }
      renderDashboard();
    }, function (err) {
      state.plugins = [];
      state.notice = '插件列表请求失败：' + errText(err);
      renderDashboard();
    });
  }

  function start() {
    app.textContent = '';
    app.appendChild(el('div', 'boot', '正在连接内核…'));

    Promise.all([probeHealth(), probeInfo()]).then(function (out) {
      state.health = out[0];
      var info = out[1];

      if (!info.reached) {
        // 网络错误/超时：这才是"后端未连接"。
        state.authed = false;
        renderOffline(info.error);
        return;
      }
      if (info.res.status === 401) {
        // 未登录：渲染登录表单，绝不显示"后端未连接"。
        state.authed = false;
        state.info = null;
        renderLogin('');
        return;
      }
      if (!info.res.ok) {
        state.authed = false;
        var root = el('div');
        root.appendChild(renderTopbar(true));
        var content = el('main', 'content');
        var box = noticeBar('系统信息读取失败：' + describeError(info.res));
        content.appendChild(box);
        root.appendChild(content);
        if (app.replaceChildren) app.replaceChildren(root);
        else { app.innerHTML = ''; app.appendChild(root); }
        return;
      }
      state.authed = true;
      state.info = info.res.data || {};
      loadDashboard();
    });
  }

  // 共享 root 权限错误组件（task-145）：KoreUI.rootErrorHint(reason, {retry, command})。
  var ROOT_ERROR_CMD = 'sudo systemctl restart kore';

  function copyText(text, button, code) {
    var done = function (ok) {
      button.textContent = ok ? '已复制' : '已选中，请 Ctrl+C';
      window.setTimeout(function () { button.textContent = '复制修法命令'; }, 2500);
    };
    var fallback = function () {
      code.focus();
      window.getSelection().selectAllChildren(code);
      done(false);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
      return;
    }
    fallback();
  }

  function rootErrorHint(reason, options) {
    var opts = typeof options === 'function' ? { retry: options } : (options || {});
    var command = opts.command || ROOT_ERROR_CMD;
    var box = el('section', 'root-error');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px 16px;border:1px solid var(--kore-warning);border-radius:8px';
    var title = el('p', 'panel-title', '这项操作需要系统管理员权限');
    title.style.margin = '0';
    box.appendChild(title);
    box.appendChild(el('p', 'row-note', reason ? String(reason) : 'Kore 服务当前没有该权限，需要管理员授权后重试。'));
    var row = el('div', 'files-actions');
    var code = el('code', null, command);
    code.style.cssText = 'flex:1 1 200px;min-width:0;padding:6px 8px;border:1px solid var(--kore-border-1);border-radius:8px;background:var(--kore-bg-0);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;overflow-x:auto';
    row.appendChild(code);
    var copy = el('button', 'btn btn-ghost', '复制修法命令');
    copy.type = 'button';
    copy.addEventListener('click', function () { copyText(command, copy, code); });
    row.appendChild(copy);
    box.appendChild(row);
    var why = el('details');
    var summary = el('summary', null, '为什么需要 root');
    summary.style.cssText = 'min-height:44px;display:flex;align-items:center;cursor:pointer;font-size:12px;color:var(--kore-text-3)';
    why.appendChild(summary);
    why.appendChild(el('p', 'row-note', '绑定低位端口、管理服务与切换用户需要管理员权限；详见部署手册。'));
    box.appendChild(why);
    if (typeof opts.retry === 'function') {
      var actions = el('div', 'files-actions');
      var retry = el('button', 'btn btn-primary', '重试');
      retry.type = 'button';
      retry.addEventListener('click', function () {
        var finish = function () { retry.disabled = false; };
        retry.disabled = true;
        Promise.resolve(opts.retry()).then(finish, finish);
      });
      actions.appendChild(retry);
      box.appendChild(actions);
    }
    return box;
  }
  window.KoreUI = window.KoreUI || {};
  window.KoreUI.rootErrorHint = rootErrorHint;

  start();
})();
