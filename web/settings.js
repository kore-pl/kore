/* kore 设置视图 —— 零框架、零 CDN、零外部资源；对外只暴露 window.KoreSettings.render(container)。
   2026-11-25 设置页整合（分组 · 可搜索 · 危险确认），不新增后端接口、不引入依赖：
   ① 常规设置按「账户与安全 / 站点与域名 / 数据与备份 / 通知与告警 / 系统与网络 / 关于」六组呈现；
      每组一句「这组管什么」+ 一句「什么时候需要改」，组内每个配置项都有中文标签 + 一行帮助 +
      默认值提示；高级项折叠在 details 里可展开；顶部搜索框按标签/帮助/默认值/分组过滤并定位。
   ② 危险操作统一走 openDangerConfirm：先列后果，再要求输入指定确认文字（内核升级输「升级」、
      回滚输「回滚」）；修改管理员口令在弹层里列明后果（当前口令本身就是确认凭据，不再叠一道）。
   ③ 跨页设置给「去配置」入口（网站 / 解析 / 证书 / 备份 / 告警 / 快照…），本页不重复造表单：
      同一件事只有一份实现，改一处不会两边漂移。
   ④ 保存/切换后就地给结果（成功说「已生效」，失败说「怎么办」），不静默、不假装成功。
   数据只来自已存在端点（会话、系统信息、退出）；没端点的能力一律标「待支持」，不伪造。
   退出下沉（DESIGN-AUDIT P0-1 / DESIGN-SYSTEM C10 三级）：全站唯一退出入口在本页
   「账户与安全」组内，红字 + 确认弹层「确定退出 Kore 控制台？」，顶栏不再提供退出。
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
    plugins: '24 个插件仓库（23 产品 + echo 验证件，按需安装）',
    presets: '8 个场景预设'
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
  function buildLanguageControl() {
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
    status.setAttribute('role', 'status');
    sel.addEventListener('change', function () {
      var target = sel.value;
      sel.disabled = true;
      status.textContent = '';
      status.className = 'settings-hint';
      var task = i18n && typeof i18n.setLocale === 'function'
        ? i18n.setLocale(target)
        : Promise.reject(new Error('i18n 未加载'));
      task.then(function () {
        cfgNotice = '已切换为' + (target === 'en-US' ? 'English' : '中文（简体）') + '，立即生效并已记住选择。';
        if (host) paint(host);
      }, function () {
        sel.disabled = false;
        sel.value = current;
        status.textContent = tr('settings.language.failed', '切换失败，已保持原语言；请刷新页面后重试');
        status.className = 'settings-hint settings-hint-error';
      });
    });
    var wrap = el('div', 'settings-item-control');
    wrap.appendChild(sel);
    wrap.appendChild(status);
    return wrap;
  }

  /* ===== 配置项与分组：一份登记表驱动渲染 + 搜索 + 折叠 =====
     每个配置项 = 中文标签 + 一行帮助 + 默认值提示；危险操作在 actions 里并带 danger 标记。
     advanced=true 的项收进「高级设置（N 项）」details，默认折叠、点开即见。 */
  function cfgItem(spec) {
    var row = el('div', 'settings-item');
    var kw = [spec.label, spec.help, spec.def, spec.badge, spec.when].join(' ');
    row.setAttribute('data-kw', kw.toLowerCase());
    if (spec.advanced) row.setAttribute('data-advanced', '1');
    var head = el('div', 'settings-item-head');
    head.appendChild(el('span', 'settings-item-label', spec.label));
    if (spec.badge) head.appendChild(el('span', 'settings-badge', spec.badge));
    if (spec.advanced) head.appendChild(el('span', 'settings-badge settings-badge-adv', '高级'));
    if (spec.value !== undefined) {
      var val = el('span', 'settings-item-value');
      if (spec.value && spec.value.nodeType === 1) val.appendChild(spec.value);
      else val.textContent = spec.value === '' || spec.value === null ? '—' : String(spec.value);
      head.appendChild(val);
    }
    row.appendChild(head);
    if (spec.help) row.appendChild(el('p', 'settings-item-help', spec.help));
    if (spec.def) row.appendChild(el('p', 'settings-item-def', '默认：' + spec.def));
    if (spec.control) row.appendChild(spec.control);
    if (spec.actions && spec.actions.length) {
      var ops = el('div', 'settings-item-actions');
      for (var i = 0; i < spec.actions.length; i++) {
        (function (a) {
          var btn = el('button', 'btn' + (a.danger ? ' settings-logout' : ''), a.label);
          btn.type = 'button';
          if (a.id) btn.id = a.id;
          if (a.route) btn.setAttribute('data-route', a.route);
          if (a.action) btn.setAttribute('data-kore-action', a.action);
          if (a.title) btn.title = a.title;
          if (a.onClick) btn.addEventListener('click', a.onClick);
          ops.appendChild(btn);
        })(spec.actions[i]);
      }
      row.appendChild(ops);
    }
    if (spec.note) row.appendChild(spec.note);
    return row;
  }
  // 跨页设置：本页只给「什么时候需要改 + 去配置」，不在两处各写一份表单。
  function navItem(spec) {
    return cfgItem({
      label: spec.label,
      badge: '在「' + spec.page + '」页',
      help: spec.help,
      def: spec.def,
      actions: [{ label: '去配置', route: spec.view, onClick: function () { go(spec.view); } }]
    });
  }
  function go(view) {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      window.KoreShell.navigate(view);
      return;
    }
    window.location.hash = '#/' + view;
  }
  function switchTab(name) {
    tab = name;
    releaseAudit(); releaseCredentials(); releaseSecurity();
    paint(host);
  }

  /* ===== 各组内容 ===== */
  function itemsAccount() {
    var s = cache.session, authed = !!(s && s.authenticated === true);
    var csrf = readCookie('kore_csrf');
    var items = [
      cfgItem({
        label: '会话状态',
        value: flag(authed ? '会话有效' : (s ? '会话无效' : '会话状态未知（读取中或失败）'), authed ? 'ok' : 'warn'),
        help: '「会话有效」表示当前浏览器已登录，可以改设置、点危险操作。',
        def: '登录后 12 小时有效，期间有操作会自动续期（以配置文件为准）'
      }),
      cfgItem({
        label: '登录身份',
        value: 'admin',
        help: 'Kore 是一台机器一个管理员，不提供多账号；要换人用，先改口令并把旧设备登出。',
        def: 'admin（单管理员，不支持多用户）'
      }),
      cfgItem({
        label: '登录到期时刻',
        value: ro(fmtExpiry(s && s.expires_at)),
        help: '到期后要重新输入口令；如果比预期早，通常是内核重启过。',
        def: '到期前持续使用会自动续期'
      }),
      cfgItem({
        label: '修改管理员口令',
        help: '改完当前及其它设备上已登录的页面会全部失效，请用新口令重新登录。',
        def: '最短 12 位，建议用密码管理器生成并保存',
        actions: [{ label: '修改口令', id: 'kore-pw-change', onClick: function (ev) { openPasswordDialog(ev.currentTarget); } }],
        note: passwordNoteNode()
      }),
      cfgItem({
        label: '退出登录',
        help: '在公共电脑上用完请退出；只结束当前浏览器的登录，不会改口令。',
        def: '不主动退出时，登录状态随会话到期自动结束',
        actions: [{ label: '退出登录', danger: true, id: 'kore-settings-logout', action: 'logout',
          onClick: function (ev) { openLogoutConfirm(ev.currentTarget); } }]
      }),
      cfgItem({
        advanced: true,
        label: '数据保护令牌',
        value: flag(csrf ? '已下发' : '缺失（写请求会被 401 拒绝）', csrf ? 'ok' : 'warn'),
        help: '页面里的一次性校验令牌：改设置、点按钮时自动带上，防止别的网站冒名替你提交。',
        def: '登录成功时自动下发，正常不需要关心'
      }),
      cfgItem({
        advanced: true,
        label: '登录凭证存放位置',
        value: '浏览器 Cookie（页面脚本不可读取）',
        help: '凭证由浏览器保管，页面拿不到明文；这正是它比存在页面变量里更安全的原因。',
        def: '登录成功时由内核写入，退出或到期即失效'
      })
    ];
    return items;
  }
  function itemsSites() {
    return [
      navItem({ label: '网站与域名', page: '网站', view: 'sites',
        help: '建站、绑域名、伪静态与运行环境在一次表单里完成，目录会自动填好并标「已自动检测」。',
        def: '站点能力由站点插件提供；没装站点插件时此入口不可用' }),
      navItem({ label: '域名解析', page: 'DNS 解析', view: 'security/dns',
        help: '把域名指向本机，或给子域加 A / CNAME / TXT 记录；改完立即生效。' }),
      navItem({ label: 'HTTPS 证书', page: '证书', view: 'security/ssl',
        help: '申请、续期证书并绑定到站点；快到期时会出现在告警里。' }),
      navItem({ label: '站点迁移', page: '站点迁移', view: 'sites/site-migrate',
        help: '换机器时把站点连同数据库整体搬过去；迁移前请先做一次完整备份。' })
    ];
  }
  function itemsData() {
    return [
      navItem({ label: '备份计划', page: '备份', view: 'files/backup',
        help: '定时备份站点文件与数据库，可在备份页按任务设定时间与保留份数。' }),
      navItem({ label: '磁盘分析', page: '磁盘分析', view: 'files/disk-analysis',
        help: '盘快满了先看这里，按目录找出最占空间的大头，再决定删什么。' }),
      navItem({ label: '配置快照', page: '配置快照', view: 'settings/snapshot',
        help: '改内核配置前留一份快照，改坏了可以一键回到改之前。' }),
      navItem({ label: '配置迁移', page: '配置迁移', view: 'settings/migrate',
        help: '把当前内核配置导出带走，或在另一台机器上导入。' }),
      navItem({ label: '配置漂移', page: '配置漂移', view: 'settings/config-drift',
        help: '有人手改了服务器上的配置文件时，能看出和面板里的不一致。' }),
      cfgItem({ label: '凭据库', badge: '本页 tab', help: '站点、数据库口令集中保存，页面上不明文回显；要用时复制，不落历史。',
        def: '首次保存后才产生条目',
        actions: [{ label: '打开凭据', onClick: function () { switchTab('credentials'); } }] }),
      cfgItem({ label: '操作审计', badge: '本页 tab', help: '谁在什么时候做了什么（改设置、启停插件、执行危险操作），用于事后追查。',
        def: '只记录最终生效的操作，不记录被拒绝的尝试',
        actions: [{ label: '查看审计', onClick: function () { switchTab('audit'); } }] })
    ];
  }
  function itemsNotify() {
    return [
      cfgItem({ label: '告警中心', badge: '顶栏铃铛', help: '最近的异常集中在这里；点顶栏铃铛随时打开，红点表示有未读。',
        def: '未读告警在顶栏铃铛上以红点提示',
        actions: [{ label: '打开告警中心', onClick: openAlertCenter }] }),
      navItem({ label: '告警规则', page: '告警规则', view: 'monitor/alert-rules',
        help: '什么情况算告警、阈值多少、是否提醒，都在这里按规则配。' }),
      navItem({ label: '日志告警', page: '日志告警', view: 'monitor/log-alerts',
        help: '盯日志里出现关键字就提醒（例：OOM、Failed password），避免出事没人发现。' }),
      navItem({ label: '通知通道', page: '通知通道', view: 'settings/webhook',
        help: '把告警发到你的机器人或回调地址；没配通道时告警只在面板里看。' })
    ];
  }
  function itemsSystem() {
    var info = cache.info || {}, sup = info.supervisor || {}, paths = info.paths || {}, dem = info.demotion || {};
    // 内核信息没读到（未登录 / 网络抖动）：整组收成空态。显示一排「—」会被当成真实值，比空白更误导。
    if (cache.loaded && !cache.info) {
      var empty = window.KoreUI.emptyBlock({
        title: '还没有读取到内核信息',
        text: '这些设置来自内核的系统信息接口；未登录或网络抖动时会读不到，重试一次通常就能恢复。',
        label: '重新读取设置', onClick: reloadSettings
      });
      empty.classList.add('settings-empty-state');
      return [cfgItem({ label: '内核信息', help: '读不到就不会编造：这里空着说明接口这次没返回，不是内核坏了。', note: empty })];
    }
    var items = [
      cfgItem({
        label: tr('settings.language.label', '界面语言'),
        help: '中文是默认语言，英文为可选；未翻译的文案自动回退中文，切换后立即生效并记住选择。',
        def: '中文（简体）',
        control: buildLanguageControl()
      }),
      cfgItem({
        label: '内核版本',
        value: el('span', 'mono', info.version || '—'),
        help: '升级后这里会跟着变；反馈问题时请把它一起贴上。',
        def: '由当前运行的二进制决定'
      }),
      cfgItem({
        label: '常驻插件与重启',
        value: '常驻 ' + (sup.resident === undefined ? '—' : sup.resident) +
          ' · 上限 ' + (sup.resident_max === undefined ? '—' : sup.resident_max) +
          ' · 重启计数 ' + (sup.restarts === undefined ? '—' : sup.restarts),
        help: '常驻越多占内存越多；重启计数持续增长说明有插件在反复崩，需要看日志。',
        def: '常驻上限 3 个（推荐 1–2 个）'
      }),
      cfgItem({
        label: '升级内核',
        help: '换一份新的 kored 二进制并重启：先校验 sha256，再原子替换，失败不动现网。',
        def: '升级后自动保留上一版本，可回滚一次',
        control: buildUpgradeForm()
      }),
      cfgItem({
        advanced: true,
        label: '插件降权',
        value: flag(dem.enabled ? '已生效' : '未生效', dem.enabled ? 'ok' : 'warn'),
        help: '生效时插件以自己的低权限用户运行，出问题也碰不到系统文件；未生效会写明原因和怎么开。',
        def: '内核以非 root 启动时自动生效',
        note: dem.reason ? el('p', 'settings-hint', dem.reason) : null
      }),
      cfgItem({
        advanced: true,
        label: '运行目录',
        value: '数据 ' + (paths.state_dir || '—') + ' · 日志 ' + (paths.log_dir || '—') +
          ' · 运行 ' + (paths.run_dir || '—'),
        help: '排障时看这里：插件二进制在插件目录、本地索引在索引目录，路径都是绝对路径，不用再猜进程工作目录。',
        def: '由配置文件 paths 段决定，改完需重启内核'
      }),
      cfgItem({
        advanced: true,
        label: '插件目录与索引目录',
        value: '插件 ' + (paths.plugin_dir || '—') + ' · 索引 ' + (paths.index_dir || '—'),
        help: '商店里看到的插件版本来自索引目录；插件二进制解包在插件目录。',
        def: '随安装位置与配置变化'
      }),
      cfgItem({
        advanced: true,
        label: '运行环境',
        value: (info.os || '—') + ' · ' + (info.arch || '—') + ' · 内核 ' + (info.kernel || '—') +
          ' · cgroup ' + (info.cgroup_mode || '—'),
        help: 'cgroup 与 systemd 决定插件隔离与限额能不能真正生效；不满足时对应能力会降级。',
        def: '启动时探测一次，不随运行变化'
      }),
      cfgItem({
        advanced: true,
        label: '资源预算',
        help: '硬红线是判「未完成」的线，目标是争取值；超红线才算问题，红线与目标之间只记趋势。',
        def: '依据 ADR-0016，除安全事故外不再调整',
        control: buildBudgetTable()
      })
    ];
    return items;
  }
  function itemsAbout() {
    var info = cache.info || {};
    var link = el('a', 'settings-link', 'github.com/pengtang1024/kore');
    link.href = ABOUT.repo;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return [
      cfgItem({ label: 'Kore 版本', value: el('span', 'mono', info.version || '—'), help: '当前运行的内核版本号。', def: '随安装包' }),
      cfgItem({ label: '协议版本', value: el('span', 'mono', ABOUT.protocol), help: '内核与插件之间的约定版本；插件声明不兼容时商店会拒绝安装。', def: '当前内核支持的协议' }),
      cfgItem({ label: '许可证', value: ABOUT.license + '（LICENSE）', help: '本项目以 MIT 协议开源，可商用、可修改，保留版权声明即可。', def: 'MIT' }),
      cfgItem({ label: '代码仓库', value: link, help: '问题反馈、更新日志与文档都在仓库里；外链只在你点击时才发请求。', def: ABOUT.repo }),
      cfgItem({ label: '插件仓库', value: ABOUT.plugins, help: '一个插件一个仓库，装什么、升级什么由你决定，面板不代管你的数据。', def: '按需安装，装多少都不自动常驻' }),
      cfgItem({ label: '场景预设', value: ABOUT.presets, help: '按用途一次装好一组插件，比逐个挑省事；装完仍可单独启停。', def: '预设只是初始清单，不影响后续自由安装' }),
      cfgItem({ advanced: true, label: '前端实现', value: '原生 JS · 零框架 · 零 CDN（不加载任何外部资源）',
        help: '不依赖外部 CDN，断网也能开面板；代价是没有现成组件库，样式都写在本地。', def: '零外部资源是硬约束（离线可用）' })
    ];
  }

  /* ===== 分组登记：标题 / 说明 / 什么时候需要改 / 项 ===== */
  var GROUPS = [
    { id: 'account', title: '账户与安全', desc: '登录身份、管理员口令与登出。',
      when: '换管理员口令、想把某台设备登出，或确认当前会话是否还有效时来这里。', items: itemsAccount },
    { id: 'sites', title: '站点与域名', desc: '建站、域名解析与 HTTPS 证书分别由各自页面管理。',
      when: '要新建网站、换域名、加一条解析或续证书时，点「去配置」直接过去。', items: itemsSites },
    { id: 'data', title: '数据与备份', desc: '备份计划、配置快照与迁移、凭据库与操作审计。',
      when: '要设定时备份、改坏了想回滚配置、找回口令，或追查谁改过东西时来这里。', items: itemsData },
    { id: 'notify', title: '通知与告警', desc: '告警中心、告警规则、日志告警与通知通道。',
      when: '想让异常主动提醒你，或嫌告警太吵要调阈值时来这里。', items: itemsNotify },
    { id: 'system', title: '系统与网络', desc: '界面语言、运行参数、运行目录、运行环境与内核升级。',
      when: '首次使用想换语言、要升级内核，或排查目录/权限/环境问题时来这里。', items: itemsSystem },
    { id: 'about', title: '关于', desc: '版本、协议、许可与代码仓库。',
      when: '反馈问题要贴版本号，或核对协议与许可时看这里。', items: itemsAbout }
  ];

  var cfgRoot = null;
  var cfgQuery = '';
  var cfgNotice = ''; // 一次性的成功提示（如语言切换），渲染后清空，不重复打扰

  function groupById(id) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].id === id) return GROUPS[i];
    return null;
  }
  function buildGroup(g) {
    var box = el('section', 'settings-group');
    box.id = 'kore-cfg-' + g.id;
    box.setAttribute('data-cfg-group', g.id);
    box.setAttribute('data-kw', (g.title + ' ' + g.desc + ' ' + g.when).toLowerCase());
    var head = el('div', 'settings-group-head');
    var title = el('div', 'settings-group-title');
    title.appendChild(el('span', null, g.title));
    var count = el('span', 'settings-group-count');
    title.appendChild(count);
    head.appendChild(title);
    head.appendChild(el('p', 'settings-group-desc', g.desc));
    head.appendChild(el('p', 'settings-group-when', '什么时候需要改：' + g.when));
    box.appendChild(head);

    var plain = el('div', 'settings-items');
    var advanced = [];
    var list = g.items() || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-advanced')) advanced.push(list[i]);
      else plain.appendChild(list[i]);
    }
    box.appendChild(plain);
    if (advanced.length) {
      var det = el('details', 'settings-adv');
      det.setAttribute('data-cfg-adv', '1');
      var sum = el('summary', null, '高级设置（' + advanced.length + ' 项，点开查看）');
      det.appendChild(sum);
      var advWrap = el('div', 'settings-items');
      for (var j = 0; j < advanced.length; j++) advWrap.appendChild(advanced[j]);
      det.appendChild(advWrap);
      box.appendChild(det);
    }
    count.textContent = list.length + ' 项';
    box.setAttribute('tabindex', '-1');
    return box;
  }

  /* ===== 搜索：按标签 / 帮助 / 默认值 / 分组过滤，命中组自动展开高级项 ===== */
  function buildSearchBar() {
    var wrap = el('div', 'settings-search');
    var label = el('label', 'settings-search-label', '搜索设置项');
    label.setAttribute('for', 'kore-cfg-search');
    wrap.appendChild(label);
    var input = el('input', 'settings-select settings-search-input');
    input.id = 'kore-cfg-search';
    input.type = 'search';
    input.placeholder = '例：口令 / 备份 / 目录 / 证书';
    input.autocomplete = 'off';
    input.value = cfgQuery;
    var count = el('span', 'settings-search-count');
    count.id = 'kore-cfg-count';
    count.setAttribute('role', 'status');
    var clear = el('button', 'btn btn-ghost settings-search-clear', '清空');
    clear.type = 'button';
    clear.addEventListener('click', function () {
      cfgQuery = '';
      input.value = '';
      applyCfgFilter();
      input.focus();
    });
    input.addEventListener('input', function () {
      cfgQuery = input.value;
      applyCfgFilter();
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && cfgQuery) {
        cfgQuery = '';
        input.value = '';
        applyCfgFilter();
      }
    });
    wrap.appendChild(input);
    wrap.appendChild(count);
    wrap.appendChild(clear);
    return wrap;
  }
  function applyCfgFilter() {
    if (!cfgRoot) return;
    var q = (cfgQuery || '').trim().toLowerCase();
    var groups = cfgRoot.querySelectorAll('[data-cfg-group]');
    var total = 0, shown = 0;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var groupHit = !!q && (g.getAttribute('data-kw') || '').indexOf(q) >= 0;
      var items = g.querySelectorAll('[data-kw]');
      var visible = 0;
      for (var j = 0; j < items.length; j++) {
        var hit = !q || groupHit || (items[j].getAttribute('data-kw') || '').indexOf(q) >= 0;
        items[j].style.display = hit ? '' : 'none';
        if (hit) visible++;
        total++;
      }
      // 高级项：有命中就展开（否则搜到了还看不见），清空搜索后回到折叠。
      var details = g.querySelectorAll('details[data-cfg-adv]');
      for (var k = 0; k < details.length; k++) {
        var any = 0, kids = details[k].querySelectorAll('[data-kw]');
        for (var m = 0; m < kids.length; m++) if (kids[m].style.display !== 'none') any++;
        details[k].style.display = any ? '' : 'none';
        details[k].open = !!q && any > 0;
      }
      g.style.display = visible ? '' : 'none';
      var countNode = g.querySelector('.settings-group-count');
      if (countNode) {
        countNode.textContent = q ? visible + ' / ' + items.length + ' 项命中' : items.length + ' 项';
      }
      shown += visible;
    }
    var count = document.getElementById('kore-cfg-count');
    if (count) {
      count.textContent = q
        ? (shown ? '匹配到 ' + shown + ' 项（共 ' + total + ' 项）' : '没有匹配的设置项')
        : '共 ' + total + ' 项，输入关键词可直接定位';
      count.className = 'settings-search-count' + (q && !shown ? ' settings-search-count-empty' : '');
    }
    var empty = document.getElementById('kore-cfg-empty');
    if (empty) {
      empty.style.display = q && !shown ? '' : 'none';
      var echo = document.getElementById('kore-cfg-empty-echo');
      if (echo) echo.textContent = cfgQuery.trim();
    }
  }
  function buildSearchEmpty() {
    var box = el('div', 'settings-search-empty');
    box.id = 'kore-cfg-empty';
    box.style.display = 'none';
    var text = el('p', 'settings-search-empty-text');
    text.appendChild(document.createTextNode('没有找到和「'));
    var echo = el('b', null, '');
    echo.id = 'kore-cfg-empty-echo';
    text.appendChild(echo);
    text.appendChild(document.createTextNode('」相关的设置项。换个说法试试，例如「口令」「备份」「目录」「证书」；也可以直接点上面的分组跳过去。'));
    box.appendChild(text);
    var btn = el('button', 'btn btn-ghost', '清空搜索');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      cfgQuery = '';
      var input = document.getElementById('kore-cfg-search');
      if (input) { input.value = ''; input.focus(); }
      applyCfgFilter();
    });
    box.appendChild(btn);
    return box;
  }
  function buildChips() {
    var chips = el('div', 'settings-chips');
    chips.setAttribute('role', 'navigation');
    chips.setAttribute('aria-label', '设置分组');
    for (var i = 0; i < GROUPS.length; i++) {
      (function (g) {
        var btn = el('button', 'settings-chip', g.title);
        btn.type = 'button';
        btn.addEventListener('click', function () {
          var target = document.getElementById('kore-cfg-' + g.id);
          if (!target) return;
          target.scrollIntoView({ block: 'start' });
          if (target.focus) target.focus({ preventScroll: true });
        });
        chips.appendChild(btn);
      })(GROUPS[i]);
    }
    return chips;
  }

  /* ===== 危险操作统一确认：写清后果 + 输入指定文字（不给「手滑就执行」的机会） =====
     返回 Promise<boolean>：确认 true、取消/遮罩/Esc false。Promise 只在用户做出选择后兑现。 */
  function openDangerConfirm(opts) {
    return new Promise(function (resolve) {
      var phrase = opts.phrase || '';
      var wrap = el('div', 'settings-backdrop');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', opts.title || '危险操作确认');
      var box = el('section', 'settings-dialog settings-dialog-danger');
      box.appendChild(el('h3', 'settings-dialog-title', opts.title || '请确认'));
      if (opts.desc) box.appendChild(el('p', 'settings-dialog-hint', opts.desc));
      if (opts.consequences && opts.consequences.length) {
        var ul = el('ul', 'settings-consequences');
        for (var i = 0; i < opts.consequences.length; i++) ul.appendChild(el('li', null, opts.consequences[i]));
        box.appendChild(ul);
      }
      var tip = el('label', 'settings-dialog-hint settings-confirm-label');
      tip.setAttribute('for', 'kore-danger-phrase');
      tip.textContent = '为防误点，请输入「' + phrase + '」确认：';
      box.appendChild(tip);
      var input = el('input', 'settings-confirm-input');
      input.id = 'kore-danger-phrase';
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = phrase;
      box.appendChild(input);
      var status = el('div', 'settings-hint');
      status.id = 'kore-danger-status';
      status.setAttribute('role', 'alert');
      box.appendChild(status);

      var ops = el('div', 'settings-dialog-ops');
      var cancel = el('button', 'btn', '取消');
      cancel.type = 'button';
      var ok = el('button', 'btn settings-danger-btn', opts.confirmLabel || '确认执行');
      ok.type = 'button';
      ok.disabled = true;
      ops.appendChild(cancel);
      ops.appendChild(ok);
      box.appendChild(ops);
      wrap.appendChild(box);
      document.body.appendChild(wrap);

      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (opts.trigger && opts.trigger.isConnected) opts.trigger.focus();
        resolve(value);
      }
      function onKey(ev) { if (ev.key === 'Escape') finish(false); }
      function sync() {
        var match = input.value.trim() === phrase;
        ok.disabled = !match;
        status.textContent = input.value && !match ? '还需要输入「' + phrase + '」才能继续。' : '';
        status.className = 'settings-hint' + (input.value && !match ? ' settings-hint-error' : '');
      }
      input.addEventListener('input', sync);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ok.disabled) { ev.preventDefault(); finish(true); }
      });
      cancel.addEventListener('click', function () { finish(false); });
      ok.addEventListener('click', function () { if (!ok.disabled) finish(true); });
      wrap.addEventListener('click', function (ev) { if (ev.target === wrap) finish(false); });
      document.addEventListener('keydown', onKey);
      input.focus();
    });
  }

  /* ===== 内核自升级：当前版本 / 可选目标 / 危险确认 / 进度 / 结果 / 回滚 =====
     端点：GET|POST /api/v1/system/upgrade、GET /api/v1/system/upgrade/jobs/{id}、
     POST /api/v1/system/upgrade/rollback。长动作返回 202 + job，前端按需轮询
     job（≤15 次、1s 间隔）——服务端不推送、不起定时器（G-19），进程重启后
     以状态端点里的 upgrade 标记（pending → success）为最终真相。 */
  function buildUpgradeForm() {
    var wrap = el('div', 'settings-upgrade');
    var statusLine = el('div', 'settings-hint', '正在读取当前版本…');
    var detail = el('div', 'settings-hint');
    var marker = el('div', 'settings-hint');
    // 不可升级时的「怎么办」：先说人能看懂的一句，原始原因单独一行（排障时给运维看）。
    var reasonLine = el('div', 'settings-hint');
    reasonLine.id = 'kore-upgrade-reason';
    wrap.appendChild(statusLine); wrap.appendChild(detail); wrap.appendChild(marker); wrap.appendChild(reasonLine);

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
    form.appendChild(pathLabel); form.appendChild(path);
    form.appendChild(shaLabel); form.appendChild(sha);

    var ops = el('div', 'settings-actions');
    var goBtn = el('button', 'btn', tr('settings.upgrade.start', '校验并升级'));
    goBtn.type = 'button'; goBtn.disabled = true;
    var rollback = el('button', 'btn settings-logout', tr('settings.upgrade.rollback', '回滚到上一版本'));
    rollback.type = 'button'; rollback.disabled = true;
    var progress = el('div', 'settings-hint');
    progress.id = 'kore-upgrade-progress';
    progress.setAttribute('role', 'status');
    ops.appendChild(goBtn); ops.appendChild(rollback);
    wrap.appendChild(form); wrap.appendChild(ops); wrap.appendChild(progress);

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
        goBtn.disabled = true;
        setProgress('当前身份不能在线升级内核；请用 root 启动 kored 后重试，或让运维在服务器上手动升级。', 'err');
        reasonLine.textContent = data.reason ? '具体原因：' + data.reason : '';
      } else {
        goBtn.disabled = state.busy;
        reasonLine.textContent = '';
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
            (job.output ? '\n' + job.output : ''), 'err');
          state.busy = false; goBtn.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback; refresh(); return;
        }
        setProgress((job.message || '处理中') + '…', '');
        window.setTimeout(function () { poll(jobId, attempt + 1); }, 1000);
      }, function () {
        window.setTimeout(function () { poll(jobId, attempt + 1); }, 1000);
      });
    }
    goBtn.addEventListener('click', function () {
      var srcPath = path.value.trim(), wantSha = sha.value.trim();
      if (!srcPath) { setProgress('请先填写新二进制在本机的绝对路径', 'err'); path.focus(); return; }
      if (srcPath.charAt(0) !== '/') {
        setProgress('请填绝对路径（以 / 开头），例：/var/lib/kore/incoming/kored', 'err'); path.focus(); return;
      }
      if (!/^[0-9a-fA-F]{64}$/.test(wantSha)) {
        setProgress('sha256 需要 64 位十六进制，例：3f7a…（共 64 位）', 'err'); sha.focus(); return;
      }
      openDangerConfirm({
        title: '确认升级内核',
        desc: '将用你指定的新二进制替换当前内核，并重启一次。',
        consequences: [
          '内核会重启，面板短暂断开（通常几秒），期间不要重复点击',
          'sha256 与文件不符时直接失败，目标文件零改动',
          '升级完成后可点「回滚到上一版本」退回',
          '升级会中断正在跑的长任务，建议先等它结束'
        ],
        phrase: '升级',
        confirmLabel: '确认升级',
        trigger: goBtn
      }).then(function (ok) {
        if (!ok) return;
        state.busy = true; goBtn.disabled = true; rollback.disabled = true;
        setProgress('已提交：正在校验 sha256 并原子替换…', '');
        post(EP.upgrade, { source_path: srcPath, sha256: wantSha, confirm: true })
          .then(function (res) {
            if (res.status === 202 && res.data && res.data.id) { applyStatus(null); poll(res.data.id, 0); return; }
            var data = res.data || {};
            setProgress((data.code ? data.code + '：' : '') + (data.message || ('发起失败（HTTP ' + res.status + '）')), 'err');
            state.busy = false; goBtn.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback;
          }, function (err) {
            setProgress('网络请求失败：' + (err && err.message ? err.message : '请重试'), 'err');
            state.busy = false; goBtn.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback;
          });
      });
    });
    rollback.addEventListener('click', function () {
      openDangerConfirm({
        title: '确认回滚到上一版本',
        desc: '用上一版本二进制替换当前内核，并重启一次。',
        consequences: [
          '内核会重启，面板短暂断开（通常几秒）',
          '回滚后本次升级带来的修复/新功能不再生效',
          '没有上一版本时按钮不可用，不会发生任何替换'
        ],
        phrase: '回滚',
        confirmLabel: '确认回滚',
        trigger: rollback
      }).then(function (ok) {
        if (!ok) return;
        state.busy = true; goBtn.disabled = true; rollback.disabled = true;
        setProgress('已提交回滚：正在校验 .prev 并替换…', '');
        post(EP.upgradeRollback, { confirm: true }).then(function (res) {
          if (res.status === 202 && res.data && res.data.id) { poll(res.data.id, 0); return; }
          var data = res.data || {};
          setProgress((data.code ? data.code + '：' : '') + (data.message || ('回滚失败（HTTP ' + res.status + '）')), 'err');
          state.busy = false; goBtn.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback;
        }, function (err) {
          setProgress('网络请求失败：' + (err && err.message ? err.message : '请重试'), 'err');
          state.busy = false; goBtn.disabled = !state.canUpgrade; rollback.disabled = !state.canRollback;
        });
      });
    });
    refresh();
    return wrap;
  }
  function buildBudgetTable() {
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
    var box = el('div', 'settings-item-control');
    box.appendChild(table);
    return box;
  }
  function passwordNoteNode() {
    var note = el('div', 'settings-hint');
    note.id = 'kore-pw-note';
    note.textContent = PW_ENDPOINT
      ? '修改成功后会退出当前登录，请用新口令重新登录。'
      : '在线修改需要内核提供对应接口；当前版本请在服务器终端执行 kored admin-password --set 后重启 kored，改完需重新登录。';
    return note;
  }
  function openAlertCenter() {
    if (window.KoreAlerts && typeof window.KoreAlerts.open === 'function') {
      window.KoreAlerts.open();
      return;
    }
    // 告警模块没加载（极少见）：退回顶栏铃铛的入口语义，明确告诉用户点哪里。
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      var bell = document.querySelector('.kore-bell,.kore-alerts-btn,[data-kore-action="alerts"]');
      if (bell && bell.click) { bell.click(); return; }
    }
    window.alert('告警中心在顶栏铃铛里；点右上角铃铛即可打开。');
  }

  /* ===== 修改管理员口令（R10-2）：完整交互骨架 + 诚实降级 =====
     后端口径（internal/core/httpapi/handlers_password.go）：成功即全局吊销会话，
     前端随后清会话回登录页。交互骨架保留旧口令验证 + 新口令两次确认 + 人话错误；
     端点未就绪（PW_ENDPOINT 为空串）时明示降级，不伪造成功、不发注定 501 的请求。
     G-30：口令只活在两个 input.value 里——不 console.log、不写 localStorage、
     不回显、不拼进 URL；关闭弹层立即清空输入值。 */
  var PW_ENDPOINT = '/api/v1/auth/password'; // 后端已就绪（r10-passwdapi），空串才是降级
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
    // 先列后果再给表单：用户点「确认修改」前就知道会发生什么。
    var consequences = el('ul', 'settings-consequences');
    [
      '当前及其它设备上已登录的页面会全部失效',
      '需要用新口令重新登录，旧口令立即作废',
      '口令只保存在内核里，页面不会回显、也不写浏览器存储'
    ].forEach(function (text) { consequences.appendChild(el('li', null, text)); });
    box.appendChild(consequences);
    // 提示横幅：端点未接通时诚实降级；已接通时说明改口令的会话影响，避免文案自相矛盾。
    box.appendChild(el('div', 'settings-pw-banner', PW_ENDPOINT
      ? '下方需要先验证当前口令——这一步本身就是确认；改完立刻退出，用新口令登录。'
      : '当前版本的内核还没有在线改口令接口，面板暂时无法替你完成修改。可在服务器终端执行 ' +
        'kored admin-password --set（按提示输入新口令）后重启 kored；命令行改口令会吊销所有会话，' +
        '重启后请用新口令重新登录。下方表单保留完整交互，端点就绪后即可直接启用。'));
    var form = el('div', 'settings-pw-form');
    var fields = [];
    [['kore-pw-old', '当前口令', 'current-password'],
      ['kore-pw-new', '新口令（至少 ' + PW_MIN_LEN + ' 位）', 'new-password'],
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
    var ok = el('button', 'btn settings-danger-btn', '确认修改');
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

  /* ===== 渲染与取数（常规设置 / 安全 / 操作审计 / 凭据 四个 tab） ===== */
  var tab = 'config';
  var host = null;
  var auditHandle = null;
  var auditPromise = null;
  var credHandle = null;
  var credPromise = null;
  var securityHandle = null;
  var securityPromise = null;
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
    '.settings-dialog-danger{max-width:480px;border-color:var(--kore-danger)}' +
    '.settings-dialog-title{margin:0 0 8px;font-size:var(--kore-font-16);font-weight:600;color:var(--kore-text-1)}' +
    '.settings-dialog-hint{margin:0 0 12px;color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.5}' +
    '.settings-dialog-ops{display:flex;justify-content:flex-end;gap:8px}' +
    '@media (max-width:639px){.settings-dialog-ops .btn{min-height:var(--kore-touch);flex:1 1 auto}}' +
    '.settings-upgrade{display:flex;flex-direction:column;gap:8px;padding:12px 0 0}' +
    '.settings-upgrade-form{display:flex;flex-direction:column;gap:4px}' +
    '.settings-upgrade-form .settings-select{width:100%;box-sizing:border-box}' +
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
    '@media (max-width:639px){.settings-pw-form input{min-height:var(--kore-touch);font-size:16px}}' +
    // 新增：分组 / 搜索 / 配置项 / 危险确认。
    '.settings-cfg{display:block}' +
    '.settings-search{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px}' +
    '.settings-search-label{color:var(--kore-text-2);font-size:var(--kore-font-13)}' +
    '.settings-search-input{flex:1 1 240px;min-width:0}' +
    '.settings-search-clear{flex:0 0 auto;min-height:36px}' +
    '.settings-search-count{flex:1 1 auto;min-width:0;color:var(--kore-text-3);font-size:var(--kore-font-12)}' +
    '.settings-search-count-empty{color:var(--kore-warning)}' +
    '.settings-search-empty{margin:0 0 16px;padding:14px;border:1px dashed var(--kore-border-1);' +
    'border-radius:var(--kore-radius-container);background:var(--kore-bg-1)}' +
    '.settings-search-empty-text{margin:0 0 10px;color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.7}' +
    '.settings-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}' +
    '.settings-chip{min-height:36px;padding:0 12px;color:var(--kore-text-2);background:var(--kore-bg-1);' +
    'border:1px solid var(--kore-border-1);border-radius:999px;font:inherit;font-size:var(--kore-font-13);cursor:pointer}' +
    '.settings-chip:hover{color:var(--kore-text-1);border-color:var(--kore-info)}' +
    '.settings-group{margin:0 0 16px;border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container);' +
    'background:var(--kore-bg-1);outline:none}' +
    '.settings-group-head{padding:12px 14px;border-bottom:1px solid var(--kore-border-2)}' +
    '.settings-group-title{display:flex;align-items:center;gap:8px;color:var(--kore-text-1);font-size:var(--kore-font-14);font-weight:600}' +
    '.settings-group-count{margin-left:auto;color:var(--kore-text-3);font-size:var(--kore-font-12);font-weight:400}' +
    '.settings-group-desc{margin:6px 0 0;color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.6}' +
    '.settings-group-when{margin:4px 0 0;color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.6}' +
    '.settings-items{display:flex;flex-direction:column}' +
    '.settings-item{padding:10px 14px}' +
    '.settings-item + .settings-item{border-top:1px solid var(--kore-border-2)}' +
    '.settings-item-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}' +
    '.settings-item-label{color:var(--kore-text-1);font-size:var(--kore-font-13);font-weight:500}' +
    '.settings-item-value{margin-left:auto;min-width:0;color:var(--kore-text-1);font-size:var(--kore-font-13);word-break:break-all;text-align:right}' +
    '.settings-badge{display:inline-flex;align-items:center;padding:0 7px;color:var(--kore-text-2);' +
    'background:var(--kore-bg-2);border:1px solid var(--kore-border-2);border-radius:999px;font-size:11px}' +
    '.settings-badge-adv{color:var(--kore-warning);border-color:var(--kore-warning)}' +
    '.settings-item-help{margin:4px 0 0;color:var(--kore-text-2);font-size:var(--kore-font-12);line-height:1.65}' +
    '.settings-item-def{margin:2px 0 0;color:var(--kore-text-3);font-size:var(--kore-font-12);line-height:1.6}' +
    '.settings-item-control{margin-top:8px}' +
    '.settings-item-control .settings-hint{padding-left:0;padding-right:0}' +
    '.settings-item-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}' +
    '.settings-item-actions .btn{min-height:36px}' +
    '.settings-adv{border-top:1px solid var(--kore-border-2)}' +
    '.settings-adv summary{display:flex;align-items:center;min-height:var(--kore-touch);padding:10px 14px;' +
    'color:var(--kore-text-2);font-size:var(--kore-font-12);cursor:pointer}' +
    '.settings-adv summary:hover{color:var(--kore-text-1)}' +
    '.settings-adv .settings-items{border-top:1px dashed var(--kore-border-2)}' +
    '.settings-consequences{margin:0 0 12px;padding:0 0 0 18px;color:var(--kore-text-2);font-size:var(--kore-font-13);line-height:1.75}' +
    '.settings-consequences li{margin:2px 0}' +
    '.settings-confirm-label{margin:0 0 6px}' +
    '.settings-confirm-input{display:block;width:100%;box-sizing:border-box;min-height:var(--kore-touch);margin:0 0 12px;' +
    'padding:0 var(--kore-space-2);font:inherit;color:var(--kore-text-1);background:var(--kore-bg-0);' +
    'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control)}' +
    '.settings-confirm-input:focus{border-color:var(--kore-danger);outline:none}' +
    '.settings-danger-btn{color:var(--kore-danger);border-color:var(--kore-danger)}' +
    '.settings-danger-btn:hover{color:var(--kore-danger);background:var(--kore-bg-2)}' +
    '.settings-danger-btn:disabled{opacity:.5;cursor:not-allowed}' +
    '.settings-danger-btn:focus-visible{outline:2px solid var(--kore-danger);outline-offset:2px}' +
    '@media (max-width:639px){' +
    '.settings-item-head{flex-direction:column;align-items:flex-start}' +
    '.settings-item-value{margin-left:0;text-align:left}' +
    '.settings-item-actions .btn{min-height:var(--kore-touch);flex:1 1 auto}' +
    '.settings-search-clear{min-height:var(--kore-touch)}' +
    '.settings-chip{min-height:var(--kore-touch)}' +
    '.settings-search-input{flex:1 1 100%}}';
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
  // security.js 懒加载：首次切到「安全」才注入，与 audit / credentials 同模式。
  function releaseSecurity() {
    if (securityHandle && typeof securityHandle.destroy === 'function') {
      try { securityHandle.destroy(); } catch (err) { /* 清理失败不阻断切 tab */ }
    }
    securityHandle = null;
  }
  function mountSecurity(box) {
    box.appendChild(el('div', 'stub', '正在加载安全设置…'));
    if (!securityPromise) {
      securityPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = '/assets/security.js'; script.async = true;
        script.onload = function () {
          var mod = window.KoreSecurity;
          if (!mod || typeof mod.render !== 'function') { securityPromise = null; reject(new Error('security.js 未导出 KoreSecurity.render')); return; }
          resolve(mod);
        };
        script.onerror = function () { securityPromise = null; reject(new Error('security.js 加载失败')); };
        document.head.appendChild(script);
      });
    }
    securityPromise.then(function (mod) {
      if (tab !== 'security' || !box.parentNode) return;
      box.textContent = '';
      securityHandle = mod.render(box);
    }, function (err) {
      if (tab !== 'security') return;
      box.textContent = '';
      box.appendChild(el('div', 'stub', '安全设置不可用：' + (err && err.message ? err.message : '模块加载失败')));
    });
  }
  function buildTabs() {
    var bar = el('div', 'settings-tabs');
    bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', '设置分区');
    [['config', '常规设置'], ['security', '安全'], ['audit', '操作审计'], ['credentials', '凭据']].forEach(function (item) {
      var b = el('button', 'settings-tab' + (tab === item[0] ? ' is-active' : ''), item[1]);
      b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', tab === item[0] ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (tab === item[0]) return;
        switchTab(item[0]);
      });
      bar.appendChild(b);
    });
    return bar;
  }
  // 常规设置：搜索 + 分组 chips + 六组配置项。整页只有这一处登记表，加项只改 GROUPS。
  function buildConfigPage() {
    var root = el('div', 'settings-cfg');
    if (cache.error) root.appendChild(el('div', 'settings-hint settings-hint-error', cache.error));
    if (cfgNotice) {
      root.appendChild(el('div', 'settings-hint settings-hint-ok', cfgNotice));
      cfgNotice = '';
    }
    root.appendChild(buildSearchBar());
    root.appendChild(buildChips());
    root.appendChild(buildSearchEmpty());
    var list = el('div', 'settings-groups');
    for (var i = 0; i < GROUPS.length; i++) list.appendChild(buildGroup(GROUPS[i]));
    root.appendChild(list);
    root.appendChild(el('p', 'settings-hint', '本页只放内核自己的设置；插件自己的设置在各插件页右上角「设置」里，保存后立即生效。'));
    cfgRoot = root;
    return root;
  }
  function paint(container) {
    host = container || host;
    if (!host) return;
    ensureTabCss();
    releaseAudit(); releaseCredentials(); releaseSecurity(); closePasswordDialog();
    var page = el('div', 'settings-page');
    page.appendChild(buildTabs());
    var body = el('div', 'settings-tab-body');
    page.appendChild(body);
    if (tab === 'audit') {
      body.className += ' audit-tab';
      mountAudit(body);
    } else if (tab === 'credentials') {
      mountCredentials(body);
    } else if (tab === 'security') {
      mountSecurity(body);
    } else {
      body.appendChild(buildConfigPage());
    }
    if (host.replaceChildren) host.replaceChildren(page);
    else { host.textContent = ''; host.appendChild(page); }
    // 计数 / 空态 / 分组显隐按实际挂载后的 DOM 计算：构建期节点还没进文档，querySelector 找不到它们。
    if (tab === 'config' && cfgRoot) applyCfgFilter();
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
    cfgQuery = '';
    // 全局搜索的「查看操作审计」在跳转前放这个标记，到达设置页直接落到审计 tab。
    if (window.__koreSettingsTab) {
      tab = window.__koreSettingsTab === 'audit' ? 'audit' : window.__koreSettingsTab === 'credentials' ? 'credentials' : window.__koreSettingsTab === 'security' ? 'security' : 'config';
      window.__koreSettingsTab = '';
    }
    paint(container);
    return load().then(function () { cache.loaded = true; if (tab === 'config') paint(container); return true; });
  }

  // confirmDanger 对外公开：清空日志 / 卸载插件 / 删除站点等视图可直接复用同一套
  // 「后果 + 输入确认文字」弹层，避免各处自造确认（本卡不改它们的文件，只留公共入口）。
  window.KoreSettings = { render: render, endpoints: EP, confirmDanger: openDangerConfirm };
})();
