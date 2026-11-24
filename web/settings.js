/* kore 设置视图 —— 零框架、零 CDN、零外部资源；对外只暴露 window.KoreSettings.render(container)。
   数据只来自已存在端点（会话、系统信息、退出）；没端点的能力一律标「待支持」，不伪造；
   写请求统一带 X-Kore-CSRF 双提交头。界面不展示接口路径与文档章节，只给用户能读懂的一句话。
   退出下沉（DESIGN-AUDIT P0-1 / DESIGN-SYSTEM C10 三级）：全站唯一退出入口在本页
   「账户与安全」区块内，红字 + 确认弹层「确定退出 Kore 控制台？」，顶栏不再提供退出。
   本文件不自行挂载、不改 index.html：壳在「设置」被激活时调 render(container)。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action> —— 本视图不调 invoke，只走下方管理端点；
   一旦引入插件业务方法，方法段必须写 <id>.<action>，不得用裸动词。 */
(function () {
  'use strict';

  var EP = {
    info: '/api/v1/system/info',
    session: '/api/v1/auth/session',
    logout: '/api/v1/auth/logout',
    upgrade: '/api/v1/system/upgrade',
    upgradeJob: '/api/v1/system/upgrade/jobs/',
    upgradeRollback: '/api/v1/system/upgrade/rollback'
  };
  var TIMEOUT = 5000;
  // 资源预算（MiB）：展示常量，来源 AGENTS.md G-03 与 docs/DECISIONS/0016；改预算必须同步本表。
  var BUDGET = [
    ['主壳空载 VmRSS', '≤ 16 MiB', '8 MiB'],
    ['单常驻插件', '≤ 24 MiB', '12 MiB'],
    ['常驻合计', '≤ 48 MiB', '24 MiB'],
    ['同时常驻插件数', '≤ 3 个', '1–2 个']
  ];
  // 关于页常量：来源 docs/ROADMAP.md §5、docs/SCENARIOS.md §2、pkg/pluginapi.Protocol、LICENSE。
  var ABOUT = {
    protocol: 'kore.plugin.v1', license: 'MIT',
    repo: 'https://github.com/pengtang1024/kore',
    plugins: '21 个插件仓库（20 产品 + echo 验证件）', presets: '8 个场景预设'
  };
  // 视图缓存：先按缓存出骨架再拉真值重绘；单块读取失败只降级该块。
  var cache = { session: null, info: null, error: '', loaded: false };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
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
  function request(url, init, timeoutMs) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var opts = {
      method: (init && init.method) || 'GET', credentials: 'same-origin',
      headers: (init && init.headers) || {}, cache: 'no-store'
    };
    if (ctrl) opts.signal = ctrl.signal;
    if (init && init.body !== undefined) opts.body = init.body;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || TIMEOUT) : null;
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (raw) {
        if (timer) clearTimeout(timer);
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        return { status: res.status, ok: res.ok, data: data };
      });
    }, function (err) { if (timer) clearTimeout(timer); throw err; });
  }
  // RFC3339 → 本地可读；解析失败原样返回，不编造。
  function fmtExpiry(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var ms = d.getTime() - Date.now();
    var tail = ms <= 0 ? '（已过期）'
      : '（剩约 ' + Math.floor(ms / 3600000) + ' 小时 ' + Math.floor((ms % 3600000) / 60000) + ' 分）';
    return d.toLocaleString('zh-CN', { hour12: false }) + ' ' + tail;
  }
  function flag(text, tone) { return el('span', 'settings-flag ' + (tone || 'off'), text); }
  function ro(text) { return el('span', 'settings-ro', text); }
  function row(label, value) {
    var tr = el('tr');
    tr.appendChild(el('th', null, label));
    var td = el('td');
    if (value && value.nodeType === 1) td.appendChild(value);
    else td.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    tr.appendChild(td);
    return tr;
  }
  function card(title, meta, rows, extra, wide) {
    var box = el('section', 'panel' + (wide ? ' panel-wide' : ''));
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', title));
    if (meta) head.appendChild(el('span', 'panel-meta', meta));
    box.appendChild(head);
    var table = el('table', 'rows');
    for (var i = 0; i < rows.length; i++) table.appendChild(rows[i]);
    box.appendChild(table);
    for (var j = 0; extra && j < extra.length; j++) box.appendChild(extra[j]);
    return box;
  }
  function hint(text) { return el('div', 'settings-hint', text); }

  /* ===== 语言（ADR-0021）：中文为主、英文可选，唯一入口在本页 =====
     切换后写 localStorage 并由 i18n.js 通知导航原地重写；本页重绘以更新自身文案。
     未翻译的键由 i18n.js 回退中文，这里只负责把失败说清楚（不静默、不假装成功）。 */
  function tr(key, fallback) {
    var i18n = window.KoreI18n;
    if (i18n && typeof i18n.t === 'function') {
      var hit = i18n.t(key);
      if (hit && hit !== key) return hit;
    }
    return fallback === undefined || fallback === null ? key : String(fallback);
  }
  function buildLanguage() {
    var i18n = window.KoreI18n;
    var current = i18n && typeof i18n.locale === 'function' ? i18n.locale() : 'zh-CN';
    var sel = el('select', 'settings-select');
    sel.id = 'kore-language-select';
    sel.setAttribute('aria-label', tr('settings.language.label', '界面语言'));
    [['zh-CN', 'settings.language.zh', '中文（简体）'],
      ['en-US', 'settings.language.en', 'English']].forEach(function (item) {
      var opt = el('option', null, tr(item[1], item[2]));
      opt.value = item[0];
      if (item[0] === current) opt.selected = true;
      sel.appendChild(opt);
    });
    var status = el('div', 'settings-hint');
    status.id = 'kore-language-status';
    sel.addEventListener('change', function () {
      var target = sel.value;
      sel.disabled = true;
      status.textContent = '';
      var task = i18n && typeof i18n.setLocale === 'function'
        ? i18n.setLocale(target)
        : Promise.reject(new Error('i18n 未加载'));
      task.then(function () {
        if (host) paint(host);
      }, function () {
        sel.disabled = false;
        sel.value = current;
        status.textContent = tr('settings.language.failed', '切换失败，已保持中文');
        status.className = 'settings-hint settings-hint-error';
      });
    });
    return card(tr('settings.language.title', '语言'), tr('settings.language.meta', '中文为主 · 英文可选'),
      [row(tr('settings.language.label', '界面语言'), sel)],
      [hint(tr('settings.language.hint', '中文是默认语言；英文为可选项，未翻译的文案自动回退中文。切换后立即生效并记住选择。')), status]);
  }

  /* ===== 账户与安全：会话状态 + CSRF 只读展示 + 退出登录（全站唯一入口，三级·二次确认） =====
     C10：退出不可逆 → 三级（设置子项），红字 + 确认弹层；顶栏不再有退出（app.js）。 */
  function buildAccountSecurity() {
    var s = cache.session, authed = !!(s && s.authenticated === true);
    var csrf = readCookie('kore_csrf');
    var rows = [
      row('会话状态', flag(authed ? '会话有效' : (s ? '会话无效' : '会话状态未知（读取中或失败）'), authed ? 'ok' : 'warn')),
      row('认证主体', 'admin · 单管理员内核'),
      row('过期时刻', ro(fmtExpiry(s && s.expires_at))),
      row('CSRF 机制', '写操作需要页面内令牌校验，防止跨站伪造请求'),
      row('kore_csrf cookie', flag(csrf ? '存在（只读展示，前端不可改写）' : '缺失（写请求会被 401 拒绝）', csrf ? 'ok' : 'warn')),
      row('会话 cookie', '登录凭证保存在浏览器 Cookie 中，页面脚本不可读取'),
      row('会话有效期', '随使用自动续期，默认 12 小时（以配置文件为准）')
    ];
    var actions = el('div', 'settings-actions');
    var pw = el('button', 'btn', '修改管理员口令');
    pw.type = 'button';
    pw.id = 'kore-pw-change';
    pw.setAttribute('aria-describedby', 'kore-pw-note');
    pw.addEventListener('click', function () { openPasswordDialog(pw); });
    actions.appendChild(pw);
    var out = el('button', 'btn settings-logout', '退出登录');
    out.type = 'button';
    out.id = 'kore-settings-logout';
    out.setAttribute('data-kore-action', 'logout');
    out.addEventListener('click', function () { openLogoutConfirm(out); });
    actions.appendChild(out);
    actions.appendChild(el('span', 'settings-hint', '退出后会清除本机会话并回到登录页'));
    var pwNote = el('div', 'settings-hint');
    pwNote.id = 'kore-pw-note';
    pwNote.textContent = PW_ENDPOINT
      ? '修改成功后会退出当前登录，请用新口令重新登录。'
      : '在线修改需要内核提供对应接口；当前版本请在服务器终端执行 kored admin-password --set 后重启 kored，改完需重新登录。';
    return card('账户与安全', '会话 · 口令', rows, [actions, pwNote]);
  }

  /* ===== 运行参数：只读预算表 + 当前生效值 ===== */
  function buildRuntime() {
    var info = cache.info || {};
    var sup = info.supervisor || {};
    // 内核信息没读到（未登录 / 网络抖动）：整卡收成空态。显示一排「—」会被当成真实值，比空白更误导。
    if (cache.loaded && !cache.info) {
      var empty = window.KoreUI.emptyBlock({
        title: '还没有读取到内核信息',
        text: '运行参数与版本号来自内核的系统信息接口；未登录或网络抖动时会读不到，重试一次通常就能恢复。',
        label: '重新读取设置', onClick: reloadSettings
      });
      empty.classList.add('settings-empty-state');
      return card('运行参数', '只读 · 修改需改配置文件后重启', [], [empty], true);
    }
    var table = el('table', 'settings-table');
    var thead = el('thead'), htr = el('tr');
    htr.appendChild(el('th', null, '资源项'));
    htr.appendChild(el('th', null, '硬红线（判未完成）'));
    htr.appendChild(el('th', null, '目标（争取）'));
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el('tbody');
    for (var i = 0; i < BUDGET.length; i++) {
      var tr = el('tr');
      tr.appendChild(el('th', null, BUDGET[i][0]));
      tr.appendChild(el('td', null, BUDGET[i][1]));
      tr.appendChild(el('td', null, BUDGET[i][2]));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    var box = card('运行参数', '只读 · 修改需改配置文件后重启', [], [
      el('div', 'settings-hint', '当前版本未暴露运行参数（GOGC、内存上限、数据目录等）；如需调整，请在服务器终端修改配置文件后重启 kored。'),
      el('div', 'settings-hint', '资源预算（硬红线 / 目标）：'), table,
      hint('当前主壳 ' + (info.version || '—') + ' · 常驻插件 ' + (sup.resident === undefined ? '—' : sup.resident) +
        ' · 重启计数 ' + (sup.restarts === undefined ? '—' : sup.restarts))
    ], true);
    return box;
  }

  /* ===== 内核自升级：当前版本 / 可选目标 / 二次确认 / 进度 / 结果 / 回滚 =====
     端点：GET|POST /api/v1/system/upgrade、GET /api/v1/system/upgrade/jobs/{id}、
     POST /api/v1/system/upgrade/rollback。长动作返回 202 + job，前端按需轮询
     job（≤15 次、1s 间隔）——服务端不推送、不起定时器（G-19），进程重启后
     以状态端点里的 upgrade 标记（pending → success）为最终真相。 */
  function buildUpgrade() {
    var box = el('section', 'panel panel-wide');
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', tr('settings.upgrade.title', '升级内核')));
    head.appendChild(el('span', 'panel-meta', '校验来源 · 原子替换 · 可回滚'));
    box.appendChild(head);
    var body = el('div', 'settings-upgrade');
    var statusLine = el('div', 'settings-hint', '正在读取当前版本…');
    var detail = el('div', 'settings-hint');
    var marker = el('div', 'settings-hint');
    body.appendChild(statusLine); body.appendChild(detail); body.appendChild(marker);

    var form = el('div', 'settings-upgrade-form');
    var pathLabel = el('label', 'settings-hint', '新二进制本机路径（绝对路径；不接受 URL）');
    pathLabel.setAttribute('for', 'kore-upgrade-path');
    var path = el('input', 'settings-select');
    path.id = 'kore-upgrade-path'; path.type = 'text'; path.placeholder = '/var/lib/kore/incoming/kored';
    path.autocomplete = 'off';
    var shaLabel = el('label', 'settings-hint', '期望 sha256（64 位十六进制；不符时目标文件零改动）');
    shaLabel.setAttribute('for', 'kore-upgrade-sha');
    var sha = el('input', 'settings-select');
    sha.id = 'kore-upgrade-sha'; sha.type = 'text'; sha.placeholder = '例如 3f7a…（64 位）';
    sha.autocomplete = 'off';
    var confirmWrap = el('label', 'settings-hint');
    var confirm = el('input');
    confirm.type = 'checkbox'; confirm.id = 'kore-upgrade-confirm';
    confirmWrap.appendChild(confirm);
    confirmWrap.appendChild(document.createTextNode(' 我了解升级会重启内核，短暂中断面板访问'));
    form.appendChild(pathLabel); form.appendChild(path);
    form.appendChild(shaLabel); form.appendChild(sha);
    form.appendChild(confirmWrap);

    var ops = el('div', 'settings-actions');
    var go = el('button', 'btn', tr('settings.upgrade.start', '校验并升级'));
    go.type = 'button'; go.disabled = true;
    var rollback = el('button', 'btn settings-logout', tr('settings.upgrade.rollback', '回滚到上一版本'));
    rollback.type = 'button'; rollback.disabled = true;
    var progress = el('div', 'settings-hint');
    progress.id = 'kore-upgrade-progress';
    progress.setAttribute('role', 'status');
    ops.appendChild(go); ops.appendChild(rollback);
    body.appendChild(form); body.appendChild(ops); body.appendChild(progress);
    box.appendChild(body);

    var state = { canUpgrade: false, canRollback: false, busy: false };

    function setProgress(text, tone) {
      progress.textContent = text || '';
      progress.className = 'settings-hint' + (tone === 'err' ? ' settings-hint-error' : tone === 'ok' ? ' settings-hint-ok' : '');
    }
    function fmtSHA(v) {
      if (!v) return '—';
      return v.slice(0, 12) + '…' + v.slice(-8);
    }
    function applyStatus(data) {
      if (!data) { statusLine.textContent = '升级状态读取失败，请刷新重试'; return; }
      state.canUpgrade = data.can_upgrade === true;
      state.canRollback = data.can_rollback === true;
      var cur = data.current || {};
      statusLine.textContent = '当前内核版本 ' + (cache.info && cache.info.version ? cache.info.version : '—') +
        ' · sha256 ' + fmtSHA(cur.sha256) + ' · ' + (cur.path || '—');
      var prev = data.previous;
      detail.textContent = prev
        ? '可回滚目标：' + prev.path + '（sha256 ' + fmtSHA(prev.sha256) + '）'
        : '暂无可回滚目标（首次升级后自动保留 .prev）';
      if (data.marker) {
        marker.textContent = '最近一次升级：' + data.marker.state + ' · ' + (data.marker.to_sha256 || '').slice(0, 12) +
          '… · ' + (data.marker.updated_at || '');
      } else {
        marker.textContent = '本机尚未执行过内核升级';
      }
      if (!state.canUpgrade) {
        go.disabled = true;
        setProgress(data.reason || '当前运行身份无法升级内核', 'err');
      }
      rollback.disabled = !state.canRollback || state.busy;
      if (data.marker && data.marker.state === 'success') setProgress('新版本已生效（标记 success）', 'ok');
    }
    function refresh() {
      return request(EP.upgrade).then(function (res) {
        if (res.ok) { applyStatus(res.data); return res.data; }
        applyStatus(null);
        return null;
      }, function () { applyStatus(null); return null; });
    }
    function post(url, body) {
      var token = readCookie('kore_csrf');
      if (!token) { setProgress('缺少 CSRF 令牌，请刷新页面后重试', 'err'); return Promise.reject(new Error('no csrf')); }
      return request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kore-CSRF': token },
        body: JSON.stringify(body)
      }, 15000);
    }
    function poll(jobId, attempt) {
      if (attempt > 15) { setProgress('任务仍在执行或内核已重启；请稍后刷新状态查看结果', ''); return; }
      request(EP.upgradeJob + jobId, null, 5000).then(function (res) {
        if (res.status === 401 || res.status === 404) {
          // 进程重启会丢失内存 job：以持久标记为准。
          setProgress('内核正在重启，等待新版本生效…', '');
          window.setTimeout(function () { refresh(); }, 2000);
          return;
        }
        var job = res.data || {};
        if (job.state === 'success') {
          setProgress(job.message || '升级完成', 'ok'); refresh(); return;
        }
        if (job.state === 'failed') {
          setProgress((job.error_code ? job.error_code + '：' : '') + (job.message || '升级失败') +
            (job.output ? '\n' + job.output : ''), 'err'); state.busy = false; go.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback; refresh(); return;
        }
        setProgress((job.message || '处理中') + '…', '');
        window.setTimeout(function () { poll(jobId, attempt + 1); }, 1000);
      }, function () {
        window.setTimeout(function () { poll(jobId, attempt + 1); }, 1000);
      });
    }
    go.addEventListener('click', function () {
      if (!confirm.checked) { setProgress('请先勾选确认：升级会重启内核', 'err'); return; }
      state.busy = true; go.disabled = true; rollback.disabled = true;
      setProgress('已提交：正在校验 sha256 并原子替换…', '');
      post(EP.upgrade, { source_path: path.value.trim(), sha256: sha.value.trim(), confirm: true })
        .then(function (res) {
          if (res.status === 202 && res.data && res.data.id) { applyStatus(null); poll(res.data.id, 0); return; }
          var data = res.data || {};
          setProgress((data.code ? data.code + '：' : '') + (data.message || ('发起失败（HTTP ' + res.status + '）')), 'err');
          state.busy = false; go.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback;
        }, function (err) {
          setProgress('网络请求失败：' + (err && err.message ? err.message : '请重试'), 'err');
          state.busy = false; go.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback;
        });
    });
    rollback.addEventListener('click', function () {
      if (!window.confirm('回滚会用上一版本二进制替换当前内核并重启，确定继续？')) return;
      state.busy = true; go.disabled = true; rollback.disabled = true;
      setProgress('已提交回滚：正在校验 .prev 并替换…', '');
      post(EP.upgradeRollback, { confirm: true }).then(function (res) {
        if (res.status === 202 && res.data && res.data.id) { poll(res.data.id, 0); return; }
        var data = res.data || {};
        setProgress((data.code ? data.code + '：' : '') + (data.message || ('回滚失败（HTTP ' + res.status + '）')), 'err');
        state.busy = false; go.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback;
      }, function (err) {
        setProgress('网络请求失败：' + (err && err.message ? err.message : '请重试'), 'err');
        state.busy = false; go.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback;
      });
    });
    refresh();
    return box;
  }

  /* ===== 关于：版本 / 协议 / 许可 / 仓库 / 统计 ===== */
  function buildAbout() {
    var info = cache.info || {};
    var link = el('a', 'settings-link', 'github.com/pengtang1024/kore');
    link.href = ABOUT.repo;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return card('关于', '版本与许可', [
      row('Kore 版本', el('span', 'mono', info.version || '—')),
      row('协议版本', el('span', 'mono', ABOUT.protocol)),
      row('许可证', ABOUT.license + '（LICENSE）'),
      row('代码仓库', link),
      row('插件仓库', ABOUT.plugins),
      row('场景预设', ABOUT.presets),
      row('前端', '原生 JS · 零框架 · 零 CDN（不加载任何外部资源）')
    ], null, true);
  }

  /* ===== 修改管理员口令（R10-2）：完整交互骨架 + 诚实降级 =====
     后端现状（internal/core/httpapi/handlers.go:87-90）：/api/v1/auth 只有
     login / logout / session 三个端点，其余 /api/v1/auth/ 走 501；handlers_auth.go
     全文无改口令 handler。因此本视图提供完整交互骨架（旧口令验证 + 新口令两次
     确认 + 人话错误 + 成功清会话跳登录），但在端点就绪前明示降级，不伪造成功、
     不发送注定 501 的请求。后端卡落地后只需给 PW_ENDPOINT 赋真实路径，成功路径
     即刻启用，交互代码无需再改。
     G-30：口令只活在两个 input.value 里——不 console.log、不写 localStorage、
     不回显、不拼进 URL；关闭弹层立即清空输入值。 */
  var PW_ENDPOINT = ''; // 后端就绪后填，如 '/api/v1/auth/password'；空串 = 降级
  var PW_MIN_LEN = 12;  // 交互骨架下限：与 CLI --generate 的 24 位随机口令同口径，取保守值
  var pwDialog = null;

  function pwStatus(node, text, tone) {
    node.textContent = text || '';
    node.className = 'settings-hint' + (tone === 'err' ? ' settings-hint-error' : tone === 'ok' ? ' settings-hint-ok' : '');
  }
  function clearPwInputs(fields) {
    for (var i = 0; i < fields.length; i++) fields[i].value = '';
  }
  function closePasswordDialog() {
    if (!pwDialog) return;
    if (pwDialog.esc) document.removeEventListener('keydown', pwDialog.esc);
    clearPwInputs(pwDialog.fields); // G-30：关窗即清内存中的口令
    if (pwDialog.wrap && pwDialog.wrap.parentNode) pwDialog.wrap.parentNode.removeChild(pwDialog.wrap);
    if (pwDialog.trigger && pwDialog.trigger.isConnected) pwDialog.trigger.focus();
    pwDialog = null;
  }
  // 改口令成功后的统一收口：先吊销会话并清 cookie，再无条件回登录页用新口令登录。
  // 后端改口令应全局 RevokeAll（ADR-0041），这里的 logout 是幂等兜底（无 cookie 也 200）。
  function afterPasswordChanged() {
    cache.session = null;
    var csrf = readCookie('kore_csrf');
    var headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-Kore-CSRF'] = csrf;
    request(EP.logout, { method: 'POST', headers: headers, body: '{}' }, 8000)
      .then(backToLogin, backToLogin);
  }
  function openPasswordDialog(trigger) {
    closePasswordDialog();
    var wrap = el('div', 'settings-backdrop');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '修改管理员口令');
    var box = el('section', 'settings-dialog');
    box.appendChild(el('h3', 'settings-dialog-title', '修改管理员口令'));
    // 降级横幅：当前无后端端点，先说清楚再做样子，不用「待支持」糊弄人。
    box.appendChild(el('div', 'settings-pw-banner',
      '当前版本的内核还没有在线改口令接口，面板暂时无法替你完成修改。可在服务器终端执行 ' +
      'kored admin-password --set（按提示输入新口令）后重启 kored；命令行改口令会吊销所有会话，' +
      '重启后请用新口令重新登录。下方表单保留完整交互，端点就绪后即可直接启用。'));
    var form = el('div', 'settings-pw-form');
    var fields = [];
    [['kore-pw-old', '当前口令', 'current-password'],
      ['kore-pw-new', '新口令', 'new-password'],
      ['kore-pw-confirm', '确认新口令', 'new-password']].forEach(function (spec) {
      var label = el('label', null, spec[1]);
      label.setAttribute('for', spec[0]);
      var input = el('input');
      input.id = spec[0]; input.type = 'password'; input.autocomplete = spec[2];
      input.placeholder = spec[1];
      label.appendChild(input);
      form.appendChild(label);
      fields.push(input);
    });
    box.appendChild(form);
    var status = el('div', 'settings-hint');
    status.id = 'kore-pw-status';
    status.setAttribute('role', 'alert');
    box.appendChild(status);
    var ops = el('div', 'settings-dialog-ops');
    var cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', closePasswordDialog);
    var ok = el('button', 'btn', '确认修改');
    ok.type = 'button';
    if (!PW_ENDPOINT) ok.classList.add('settings-pw-pending');
    ops.appendChild(cancel); ops.appendChild(ok);
    box.appendChild(ops);
    wrap.appendChild(box);
    wrap.addEventListener('click', function (ev) { if (ev.target === wrap) closePasswordDialog(); });

    ok.addEventListener('click', function () {
      var oldPw = fields[0].value, newPw = fields[1].value, confirmPw = fields[2].value;
      // 人话错误：只讲规则、绝不回显或记录输入内容（G-30）。
      if (!oldPw) { pwStatus(status, '请先填写当前口令。', 'err'); fields[0].focus(); return; }
      if (!newPw) { pwStatus(status, '请填写新口令。', 'err'); fields[1].focus(); return; }
      if (newPw.length < PW_MIN_LEN) {
        pwStatus(status, '新口令至少 ' + PW_MIN_LEN + ' 位，建议更长或用密码管理器生成。', 'err');
        fields[1].focus(); return;
      }
      if (newPw === oldPw) { pwStatus(status, '新口令不能和当前口令相同，请换一个。', 'err'); fields[1].focus(); return; }
      if (newPw !== confirmPw) { pwStatus(status, '两次输入的新口令不一致，请再核对一次。', 'err'); fields[2].focus(); return; }
      clearPwInputs(fields); // G-30：校验通过即刻清明文，后续只传内存局部量

      if (!PW_ENDPOINT) {
        pwStatus(status, '当前内核还没有在线改口令接口，请在服务器终端执行 kored admin-password --set 后重启 kored；改完所有会话都会失效，需要重新登录。', 'ok');
        return;
      }
      var csrf = readCookie('kore_csrf');
      if (!csrf) { pwStatus(status, '缺少页面令牌，请刷新页面后重试。', 'err'); return; }
      ok.disabled = true;
      pwStatus(status, '正在提交…', '');
      request(PW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kore-CSRF': csrf },
        body: JSON.stringify({ current_password: oldPw, new_password: newPw })
      }, 15000).then(function (res) {
        ok.disabled = false;
        if (res.ok) {
          pwStatus(status, '口令已修改，正在退出并跳转登录页…', 'ok');
          closePasswordDialog();
          afterPasswordChanged();
          return;
        }
        var data = res.data || {};
        // 只显示后端返回的面向用户文案；不回显任何口令值（G-30）。
        var msg = data.message || '修改失败（HTTP ' + res.status + '），请稍后重试';
        pwStatus(status, msg, 'err');
      }, function (err) {
        ok.disabled = false;
        pwStatus(status, '网络不太顺畅：' + (err && err.message ? err.message : '请稍后重试'), 'err');
      });
    });
    document.body.appendChild(wrap);
    pwDialog = { wrap: wrap, trigger: trigger, fields: fields, esc: function (ev) {
      if (ev.key === 'Escape') closePasswordDialog();
    } };
    document.addEventListener('keydown', pwDialog.esc);
    fields[0].focus();
  }

  /* ===== 退出登录：先确认（弹层「确定退出 Kore 控制台？」），成功后回登录页，
     失败也不把用户困在面板里。Esc / 点遮罩 / 取消都只关弹层，不退出。 ===== */
  var logoutDialog = null;
  function openLogoutConfirm(trigger) {
    closeLogoutConfirm();
    var wrap = el('div', 'settings-backdrop');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '退出确认');
    var box = el('section', 'settings-dialog');
    box.setAttribute('aria-describedby', 'kore-logout-confirm-hint');
    box.appendChild(el('h3', 'settings-dialog-title', '确定退出 Kore 控制台？'));
    var hintP = el('p', 'settings-dialog-hint', '退出后将清除本机会话并回到登录页；未提交的表单内容不会保留。');
    hintP.id = 'kore-logout-confirm-hint';
    box.appendChild(hintP);
    var ops = el('div', 'settings-dialog-ops');
    var cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', closeLogoutConfirm);
    var ok = el('button', 'btn settings-logout', '确定退出');
    ok.type = 'button';
    ok.addEventListener('click', function () {
      closeLogoutConfirm();
      logout(trigger);
    });
    ops.appendChild(cancel);
    ops.appendChild(ok);
    box.appendChild(ops);
    wrap.appendChild(box);
    wrap.addEventListener('click', function (ev) {
      if (ev.target === wrap) closeLogoutConfirm();
    });
    document.body.appendChild(wrap);
    logoutDialog = { wrap: wrap, trigger: trigger, esc: function (ev) {
      if (ev.key === 'Escape') closeLogoutConfirm();
    } };
    document.addEventListener('keydown', logoutDialog.esc);
    ok.focus();
  }
  function closeLogoutConfirm() {
    if (!logoutDialog) return;
    if (logoutDialog.esc) document.removeEventListener('keydown', logoutDialog.esc);
    if (logoutDialog.wrap && logoutDialog.wrap.parentNode) {
      logoutDialog.wrap.parentNode.removeChild(logoutDialog.wrap);
    }
    if (logoutDialog.trigger && logoutDialog.trigger.isConnected) logoutDialog.trigger.focus();
    logoutDialog = null;
  }
  function logout(btn) {
    var csrf = readCookie('kore_csrf');
    var headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-Kore-CSRF'] = csrf;
    btn.disabled = true;
    btn.textContent = '正在退出…';
    request(EP.logout, { method: 'POST', headers: headers, body: '{}' }, 8000)
      .then(backToLogin, backToLogin);
  }
  function backToLogin() {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      window.KoreShell.navigate('/');
      return;
    }
    window.location.assign('/');
  }

  /* ===== 渲染与取数（常规设置 / 操作审计 两个 tab） ===== */
  var tab = 'config';
  var host = null;
  var auditHandle = null;
  var auditPromise = null;
  var credHandle = null;
  var credPromise = null;
  var SELECT_CSS = '.settings-select{min-height:36px;padding:0 var(--kore-space-2);color:var(--kore-text-1);' +
    'background:var(--kore-bg-0);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);font:inherit}' +
    '.settings-select:focus{border-color:var(--kore-info);outline:none}' +
    '@media (max-width:639px){.settings-select{min-height:var(--kore-touch);width:100%}}';
  var TAB_CSS = SELECT_CSS + '.settings-tabs{display:flex;gap:4px;margin:0 0 12px;border-bottom:1px solid var(--kore-border-1);padding:0 4px}' +
    '.settings-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--kore-text-3);' +
    'padding:10px 14px;font-size:var(--kore-font-14);cursor:pointer}' +
    '.settings-tab:hover{color:var(--kore-text-1)}.settings-tab.is-active{color:var(--kore-text-1);border-bottom-color:var(--kore-info)}' +
    '.settings-page{display:block}@media (max-width:639px){.settings-tab{min-height:var(--kore-touch);flex:1 1 auto}}' +
    // 视图级空态：主体由主壳 KoreUI.emptyBlock 渲染（panel-empty empty-state），这里只吃掉卡片里多出的内边距。
    '.settings-empty-state{padding:0}' +
    // 退出下沉：红字按钮（danger 只给不可逆操作）+ 确认弹层（C10 三级）。
    '.settings-logout{color:var(--kore-danger);border-color:var(--kore-danger)}' +
    '.settings-logout:hover{color:var(--kore-danger);border-color:var(--kore-danger);background:var(--kore-bg-2)}' +
    '.settings-logout:focus-visible{outline:2px solid var(--kore-danger);outline-offset:2px}' +
    '.settings-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;' +
    'padding:16px;background:var(--kore-overlay)}' +
    '.settings-dialog{width:100%;max-width:420px;padding:16px;background:var(--kore-bg-1);' +
    'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container);box-shadow:var(--kore-shadow)}' +
    '.settings-dialog-title{margin:0 0 8px;font-size:var(--kore-font-16);font-weight:600;color:var(--kore-text-1)}' +
    '.settings-dialog-hint{margin:0 0 12px;color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.5}' +
    '.settings-dialog-ops{display:flex;justify-content:flex-end;gap:8px}' +
    '@media (max-width:639px){.settings-dialog-ops .btn{min-height:var(--kore-touch);flex:1 1 auto}}' +
    '.settings-upgrade{display:flex;flex-direction:column;gap:8px;padding:12px 14px}' +
    '.settings-upgrade-form{display:flex;flex-direction:column;gap:4px}' +
    '.settings-upgrade-form .settings-select{width:100%;box-sizing:border-box}' +
    '.settings-upgrade-form input[type=checkbox]{width:20px;height:20px;accent-color:var(--kore-info)}' +
    '.settings-hint-ok{color:var(--kore-success)}' +
    // 修改口令弹层：口令框 + 降级横幅；手机下输入框与按钮触摸目标 ≥44px。
    '.settings-pw-banner{padding:10px 12px;margin:0 0 12px;line-height:1.6;font-size:var(--kore-font-13);' +
    'color:var(--kore-text-2);background:var(--kore-bg-2);border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control)}' +
    '.settings-pw-form{display:flex;flex-direction:column;gap:8px;margin:0 0 12px;color:var(--kore-text-2);font-size:var(--kore-font-13)}' +
    '.settings-pw-form input{display:block;width:100%;box-sizing:border-box;min-height:var(--kore-touch);margin-top:4px;' +
    'padding:0 var(--kore-space-2);font:inherit;color:var(--kore-text-1);background:var(--kore-bg-0);' +
    'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control)}' +
    '.settings-pw-form input:focus{border-color:var(--kore-info);outline:none}' +
    '.settings-pw-pending{opacity:.75}' +
    '@media (max-width:639px){.settings-pw-form input{min-height:var(--kore-touch);font-size:16px}}';
  function ensureTabCss() {
    if (document.getElementById('kore-settings-tabs-css')) return;
    var s = el('style'); s.id = 'kore-settings-tabs-css'; s.textContent = TAB_CSS; document.head.appendChild(s);
  }
  function releaseAudit() {
    if (auditHandle && typeof auditHandle.destroy === 'function') {
      try { auditHandle.destroy(); } catch (err) { /* 视图清理失败不阻断切 tab */ }
    }
    auditHandle = null;
  }
  // audit.js 懒加载：与 shell/ensureModule 同口径，只注入一次；失败清缓存允许重试。
  function mountAudit(box) {
    box.appendChild(el('div', 'stub', '正在加载操作审计…'));
    if (!auditPromise) {
      auditPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/assets/audit.js'; script.async = true;
        script.onload = function () {
          var mod = window.KoreAudit;
          if (!mod || typeof mod.render !== 'function') { auditPromise = null; reject(new Error('audit.js 未导出 KoreAudit.render')); return; }
          resolve(mod);
        };
        script.onerror = function () { auditPromise = null; reject(new Error('audit.js 加载失败')); };
        document.head.appendChild(script);
      });
    }
    auditPromise.then(function (mod) {
      if (tab !== 'audit' || !box.parentNode) return;
      box.textContent = '';
      auditHandle = mod.render(box);
    }, function (err) {
      if (tab !== 'audit') return;
      box.textContent = '';
      box.appendChild(el('div', 'stub', '操作审计不可用：' + (err && err.message ? err.message : '模块加载失败')));
    });
  }
  // credentials.js 懒加载：与 audit 同一模式（首次切到「凭据」才注入）。
  function releaseCredentials() {
    if (credHandle && typeof credHandle.destroy === 'function') {
      try { credHandle.destroy(); } catch (err) { /* 视图清理失败不阻断切 tab */ }
    }
    credHandle = null;
  }
  function mountCredentials(box) {
    box.appendChild(el('div', 'stub', '正在加载凭据管理…'));
    if (!credPromise) {
      credPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/assets/credentials.js'; script.async = true;
        script.onload = function () {
          var mod = window.KoreCredentials;
          if (!mod || typeof mod.render !== 'function') { credPromise = null; reject(new Error('credentials.js 未导出 KoreCredentials.render')); return; }
          resolve(mod);
        };
        script.onerror = function () { credPromise = null; reject(new Error('credentials.js 加载失败')); };
        document.head.appendChild(script);
      });
    }
    credPromise.then(function (mod) {
      if (tab !== 'credentials' || !box.parentNode) return;
      box.textContent = '';
      credHandle = mod.render(box);
    }, function (err) {
      if (tab !== 'credentials') return;
      box.textContent = '';
      box.appendChild(el('div', 'stub', '凭据管理不可用：' + (err && err.message ? err.message : '模块加载失败')));
    });
  }
  function buildTabs() {
    var bar = el('div', 'settings-tabs');
    bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', '设置分区');
    [['config', '常规设置'], ['audit', '操作审计'], ['credentials', '凭据']].forEach(function (item) {
      var b = el('button', 'settings-tab' + (tab === item[0] ? ' is-active' : ''), item[1]);
      b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', tab === item[0] ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (tab === item[0]) return;
        tab = item[0]; releaseAudit(); releaseCredentials(); paint(host);
      });
      bar.appendChild(b);
    });
    return bar;
  }
  function paint(container) {
    host = container || host;
    if (!host) return;
    ensureTabCss();
    releaseAudit(); releaseCredentials(); closePasswordDialog();
    var page = el('div', 'settings-page');
    page.appendChild(buildTabs());
    var body = el('div', 'settings-tab-body');
    page.appendChild(body);
    if (tab === 'audit') {
      body.className += ' audit-tab';
      mountAudit(body);
    } else if (tab === 'credentials') {
      mountCredentials(body);
    } else {
      var root = el('div', 'settings-root');
      root.appendChild(buildLanguage());
      root.appendChild(buildAccountSecurity());
      root.appendChild(buildRuntime());
      root.appendChild(buildUpgrade());
      root.appendChild(buildAbout());
      if (cache.error) root.insertBefore(el('div', 'settings-hint settings-hint-error', cache.error), root.firstChild);
      body.appendChild(root);
    }
    if (host.replaceChildren) host.replaceChildren(page);
    else { host.textContent = ''; host.appendChild(page); }
  }
  function load() {
    var p1 = request(EP.session).then(function (res) {
      if (res.ok && res.data && res.data.authenticated === true) {
        cache.session = { authenticated: true, expires_at: res.data.expires_at || '' };
      } else if (res.status === 401) {
        cache.session = { authenticated: false, expires_at: '' };
        cache.error = '会话已失效：请重新登录后再查看设置';
      } else {
        cache.session = null;
        cache.error = '设置读取失败，请稍后刷新重试';
      }
    }, function () { cache.session = null; cache.error = '网络不太顺畅，稍后再试一次'; });
    var p2 = request(EP.info).then(function (res) {
      cache.info = res.ok && res.data ? res.data : null;
    }, function () { cache.info = null; });
    return Promise.all([p1, p2]);
  }
  // reloadSettings：空态里的「重新读取设置」——重拉会话与系统信息后重绘本页（不整页刷新，保留当前 tab）。
  function reloadSettings() {
    load().then(function () {
      cache.loaded = true;
      paint(host);
      if (host && host.scrollIntoView) host.scrollIntoView({ block: 'start' });
    });
  }
  function render(container) {
    if (!container || container.nodeType !== 1) return Promise.resolve(false);
    cache.error = '';
    cache.loaded = false;
    // 全局搜索的「查看操作审计」在跳转前放这个标记，到达设置页直接落到审计 tab。
    if (window.__koreSettingsTab) {
      tab = window.__koreSettingsTab === 'audit' ? 'audit' : window.__koreSettingsTab === 'credentials' ? 'credentials' : 'config';
      window.__koreSettingsTab = '';
    }
    paint(container);
    return load().then(function () { cache.loaded = true; if (tab === 'config') paint(container); return true; });
  }

  window.KoreSettings = { render: render, endpoints: EP };
})();
