// web/plugins-view.js — 已装插件管理视图（懒加载，不进首屏六件套）。
// 挂载点：「软件商店」hub 的第二 tab（HUB_DEFS 的 store/plugins），以及壳缺席时的降级单页。
// 实现从 app.js 整段搬来（residentText … renderPluginUis 之间除三个计数/文案函数外的全部代码），
// 逻辑不变、只换加载时机：首次进该 tab 才由 app.js 的 ensureModule 注入 /assets/plugins-view.js，
// 首屏 gzip 不再随插件管理逻辑增长（FRONTEND §7：d(首屏)/d(视图数)=0）。
// 对外只暴露 window.KorePluginsView.render(container) / renderLegacy(container)；
// 主壳能力（请求 / CSRF / 状态 / 渲染构件）由 window.KoreCtx 提供，本文件不复制第二套。
// 调用形态：管理面写请求走 POST|DELETE /api/v1/plugins/{id}[/enable|/disable]；
// 插件业务方法走 POST /api/v1/invoke/<plugin-id>/<plugin-id>.<action>（完整限定名，禁裸动词）。
(function () {
  'use strict';

  var C = window.KoreCtx;
  if (!C) throw new Error('KoreCtx 缺失：主壳 app.js 未初始化，插件管理视图无法挂载');
  var el = C.el, fmtInt = C.fmtInt, readCookie = C.readCookie, errText = C.errText,
    request = C.request, describeError = C.describeError, failureOf = C.failureOf,
    failureReason = C.failureReason, ensureCsrf = C.ensureCsrf, writeJson = C.writeJson,
    statusTag = C.statusTag, row = C.row, panel = C.panel, emptyState = C.emptyState,
    replaceNode = C.replaceNode, noticeBar = C.noticeBar, viewNotice = C.viewNotice,
    renderLogin = C.renderLogin, renderDashboard = C.renderDashboard,
    loadDashboard = C.loadDashboard, refreshPluginsView = C.refreshPluginsView,
    buildOverviewInto = C.buildOverviewInto, pluginCounts = C.pluginCounts,
    residentText = C.residentText, humanWarnings = C.humanWarnings;
  var state = C.state, ENDPOINTS = C.ENDPOINTS, REQUEST_TIMEOUT_MS = C.REQUEST_TIMEOUT_MS,
    upgradeBatch = C.upgradeBatch;

  // humanWarnings 把技术字符串翻成人话；原始细节留在 title，供排查时展开。
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

  // 插件枚举值白话化（USABILITY §4 / G-33 A4）：内部英文值不直出，未知值保留原值 + 提示，绝不空白。
  var DEPTH_LABELS = { production: '生产级', basic: '基础级' };
  var LIFECYCLE_LABELS = { resident: '常驻', lazy: '按需启动', oneshot: '一次性' };
  function depthLabel(v) {
    return DEPTH_LABELS[v] || ((v ? String(v) : '') + '（未知深度）');
  }
  function lifecycleLabel(v) {
    return LIFECYCLE_LABELS[v] || ((v ? String(v) : '') + '（未知运行方式）');
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
    tr.appendChild(cell('深度', depthLabel(plugin.depth_level)));
    tr.appendChild(cell('运行方式', lifecycleLabel(plugin.lifecycle)));
    tr.appendChild(cell('状态', statusTag(pluginStateTag(plugin))));

    var ops = el('td', 'cell-ops');
    ops.setAttribute('data-label', '操作');

    // 设置：复用统一配置面板（PLUGIN-CONFIG §9），不各自造表单。host 实时取插件面板容器，
    // 以覆盖启停后 replaceRow 重建行的场景；面板由 openConfig 插在标题下方、列表上方。
    var settingBtn = el('button', 'btn plugin-setting-btn', '设置');
    settingBtn.type = 'button';
    settingBtn.title = '打开「' + (plugin.name || id) + '」的设置，保存后立即生效';
    settingBtn.addEventListener('click', function () {
      var host = document.getElementById('kore-plugins-panel');
      if (!host || !window.KoreShell || typeof window.KoreShell.openConfig !== 'function') return;
      window.KoreShell.openConfig(host, id, { title: (plugin.name || id) + ' 设置' });
    });
    ops.appendChild(settingBtn);

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
      var body = (res && res.data) || {};
      var view = failureOf({ code: code, message: describeError(res), detail: body.detail, hint: body.hint });
      entry.error = view.mapped ? view.title + '：' + view.action : describeError(res);
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
          if (!res.ok) {
            // 不把错误体压成字符串：code / detail.reason / hint 是插件 UI 分流渲染的依据，
            // 丢掉它们只能按 message 猜（E_NEED_ROOT 与 docker_missing 就会混成一句）。
            var errBody = {};
            try { errBody = raw ? JSON.parse(raw) : {}; } catch (e) { errBody = {}; }
            var invokeErr = new Error(errBody.message ? String(errBody.message) : ('HTTP ' + res.status + ' ' + raw.slice(0, 200)));
            invokeErr.code = errBody.code ? String(errBody.code) : '';
            invokeErr.detail = errBody.detail || '';
            invokeErr.hint = errBody.hint || '';
            invokeErr.reason = failureReason(invokeErr);
            invokeErr.status = res.status;
            throw invokeErr;
          }
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
          if (error.detail) body.error.detail = error.detail;
          if (error.hint) body.error.hint = error.hint;
          if (error.reason) body.error.reason = error.reason;
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
          // 后端错误码原样透传；只有真正的网络/桥错误才落到 E_INVOKE。
          reply(false, null, {
            code: (err && err.code) || 'E_INVOKE',
            message: err && err.message ? err.message : '调用失败',
            detail: err && err.detail ? err.detail : '',
            hint: err && err.hint ? err.hint : '',
            reason: err && err.reason ? err.reason : ''
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

  function renderPluginsView(box) {
    viewNotice(box);
    box.appendChild(renderPluginsPanel());
    // 插件 UI 面板按需出现：只有真有插件声明了 web.entry 才建区块。
    // 24 个 info.json 当前无一声明 web 字段 → 该面板此前是「永远空的死面板」，
    // 不删代码（桥接仍是 v1.1 的接入点），但也不再对用户展示一块永远没内容的区域。
    if (hasPluginWebUi()) {
      renderPluginUis(box, { status: 'fulfilled', value: { plugins: state.plugins } });
    }
    refreshPluginsView();
  }

  function hasPluginWebUi() {
    for (var i = 0; i < state.plugins.length; i++) {
      var p = state.plugins[i];
      if (p && p.enabled === true && p.web && typeof p.web.entry === 'string') return true;
    }
    return false;
  }

  // 壳缺席的降级单页：系统信息卡 → 插件表 → 插件 UI 面板，顺序与重构前一致。
  function renderLegacy(box) {
    box.appendChild(renderInfoPanel());
    box.appendChild(renderPluginsPanel());
    renderPluginUis(box, { status: 'fulfilled', value: { plugins: state.plugins } });
  }

  window.KorePluginsView = { render: renderPluginsView, renderLegacy: renderLegacy };
})();
