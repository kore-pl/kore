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
   首登改密提示（用户口径 2026-11-25「不能是必选项」）：后端在已鉴权响应上挂
   X-Kore-Password-Hint: 1，首屏据此渲染一条可关闭的非阻断横幅（建议改初始口令，
   「去修改」直达设置→账户与安全，「以后再说」关闭后本会话不再出现）；不改密也能
   正常使用全部功能。插件 UI 走独立 origin iframe + postMessage 桥（裁决40/41），不进主壳 realm。 */
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
    ping: Object.create(null),
    // 首登改密提示：true 才渲染可关闭横幅；「以后再说」关掉即本会话不再出现（非阻断）。
    passwordHint: false,
    passwordHintDismissed: false
  };
  // 一键升级的运行态：放模块级，跨重绘保留（重绘只换 DOM，不丢进度）。
  var upgradeBatch = { running: false, done: 0, total: 0, failed: [], message: '' };
  // 概览数据缓存：跨重绘保留（loadOverview 异步回填后原位更新，不整页重绘）。
  // sys=null 表示尚未采样；svc 各键 null 表示该来源读取失败或插件未启用（诚实降级，不编 0）。
  var ov = {
    sys: null, sysSrc: '', sysReason: '',
    svc: { sites: null, ssl: null, db: null },
    alerts: null, alertBusy: false,
    // 任务 / 商店 / 采样趋势：任一来源失败只让对应待办缺席，不拖垮整页（诚实降级，不编 0）。
    jobs: { cron: null, sched: null },
    store: { presets: null },
    // 会话内趋势采样：monitor 插件无 history 时（内核降级 / 插件未装）用本地重绘采样兜底。
    sess: { cpu: [], mem: [], disk: [] }
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
      // 保留响应头：首登改密的 X-Kore-Password-Hint 走响应头通道（非阻断提示，
      // 不塞进任何业务 JSON 体，免得每个 handler 都改一遍），消费方只读这一个键。
      var hint = res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('X-Kore-Password-Hint') : null;
      var retryAfter = res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('Retry-After') : null;
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {};
        if (raw) {
          try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; }
        }
        return { ok: res.ok, status: res.status, data: data, passwordHint: hint === '1', retryAfter: retryAfter };
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

  // 错误码 → 用户可执行文案的显式映射表（ADR-0042 / ADR-0026）。
  // 用 map 而不是散落 if-else：错误码是有限枚举，集中一处可穷举审计；新增码只加一行，
  // 不会在多个消费者里漏改。`code|detail.reason` 复合键让同一 code 的不同原因各有文案：
  // E_NEED_ROOT 是「内核没以系统服务（root）运行」，E_UNSUPPORTED|docker_missing 才是「缺依赖」，
  // 两者都曾被 message 正则混成同一句「检查 Docker」，正是本表要拆开的。
  var ERROR_VIEW = (function () {
    var needRoot = {
      title: '需要内核以系统服务（root）运行',
      action: '把 Kore 内核配置成 systemd 服务并以 root 运行（unit 内 User=root），重启服务后重试；插件进程自身永不提权。'
    };
    var dockerMissing = {
      title: '依赖缺失：Docker 未安装或未启动',
      action: 'Debian/Ubuntu 用 curl -fsSL https://get.docker.com | sh 安装，RHEL 用 dnf install docker；装好后 systemctl enable --now docker，再刷新本页。'
    };
    // 下面几项由 firewall / waf / dns / ssh-guard 四个视图的实测错误码补齐（2026-11-24）。
    // 通用码（NOTFOUND/UNAUTHORIZED/UNSUPPORTED/INVALID/UPSTREAM）不绑页面，
    // 同一 code 在任何视图都必须落到同一句 title，避免各页再写一套局部文案。
    var notFound = {
      title: '插件未安装或没有这个方法',
      action: '到左侧「软件商店」安装对应插件（或确认插件已启用、方法名正确），装好后刷新本页。'
    };
    var unauthorized = {
      title: '没有权限执行这个操作',
      action: '确认登录未失效、当前账号有对应权限；受保护对象与不可回滚动作按页面提示完成二次确认后再试。'
    };
    var unsupported = {
      title: '当前环境不支持这个操作',
      action: '按提示检查依赖与版本（如 nftables、插件版本），补齐或升级后重试。'
    };
    var invalid = {
      title: '填写的参数不合法',
      action: '按提示检查格式、范围与必填项，修正后重试。'
    };
    var noEngine = {
      title: '本机没有可用的 DNS 服务',
      action: '装上 BIND9 或 dnsmasq 并启动后刷新本页；只查外部域名可直接用「即时查询」。'
    };
    var confirmRequired = {
      title: '这个动作需要一次性确认',
      action: '页面会自动申请一次性确认令牌，重试一次即可；不可回滚的动作请先核对目标。'
    };
    var upstream = {
      title: '后端命令执行失败或超时',
      action: '确认对应服务在运行、磁盘与系统负载正常后重试；持续失败请查看插件日志。'
    };
    var conflict = {
      title: '操作与当前状态冲突',
      action: '刷新后按当前状态重试；插件未启用时先到「插件」页启用，目标已存在时换名称或先删除。'
    };
    return {
      'E_NEED_ROOT': needRoot,
      'E_NEED_ROOT|need_root': needRoot,
      'E_UNSUPPORTED|docker_missing': dockerMissing,
      'E_UNAVAILABLE|docker_missing': dockerMissing,
      'E_UNAVAILABLE': { title: '依赖缺失', action: '按提示安装所需组件后重试。' },
      'E_NOTFOUND': notFound,
      'E_UNAUTHORIZED': unauthorized,
      'E_UNSUPPORTED': unsupported,
      'E_INVALID': invalid,
      'E_NO_ENGINE': noEngine,
      'E_CONFIRM_REQUIRED': confirmRequired,
      'E_UPSTREAM': upstream,
      'E_CONFLICT': conflict
    };
  })();

  // failureReason 从 detail.reason 取可判别原因；detail 可能是 JSON 字符串（HTTP 错误体）或对象。
  function failureReason(err) {
    if (!err) return '';
    if (err.reason) return String(err.reason);
    var detail = err.detail;
    if (detail && typeof detail === 'object') return detail.reason ? String(detail.reason) : '';
    if (typeof detail === 'string' && detail) {
      try {
        var parsed = JSON.parse(detail);
        return parsed && parsed.reason ? String(parsed.reason) : '';
      } catch (e) { return ''; }
    }
    return '';
  }

  // failureOf 把 {code,message,detail,hint} 或 Error 归一成 {title,action,detail,mapped}。
  // mapped=false 时调用方沿用既有通用文案，保证未收录的错误码行为不变。
  function failureOf(err) {
    var code = String((err && err.code) || '');
    var reason = failureReason(err);
    var view = (reason && ERROR_VIEW[code + '|' + reason]) || ERROR_VIEW[code] || null;
    var detail = err && err.message ? String(err.message) : '';
    detail = detail.replace(/^E_[A-Z_]+[:：]\s*/, '');
    if (!detail && err && err.hint) detail = String(err.hint);
    return { title: view ? view.title : '', action: view ? view.action : '', detail: detail, mapped: !!view };
  }

  // ---- 全页统一文案契约（AGENTS.md §7 ④；G-33 A4/A5）----
  // 错误：<什么错了>。<怎么办：具体动作>      —— errorText（单行串）/ errorBlock（带重试按钮的块）
  // 空态：<当前没有 X> + <一句话说明> + [下一步按钮] —— emptyBlock
  // 视图模块一律调这里，别各自拼「X失败：' + err」——那会把内部错误原文直接甩给用户。
  var DEFAULT_ACTION = '按提示修正后重试；仍不成功请刷新页面，或到「日志」页查看插件日志。';

  // sentence 是错误文案的唯一拼装函数：保证「。怎么办：」只有一处，标点不重复。
  function sentence(title, action) {
    var t = String(title || '').replace(/[\s。：:；;，,、]+$/, '');
    var a = String(action || '').replace(/^\s*怎么办\s*[：:]?\s*/, '').replace(/[\s。；;]+$/, '');
    if (!t) t = '操作未完成';
    if (!a) a = DEFAULT_ACTION;
    return t + '。怎么办：' + a + '。';
  }

  // errorText 把任意错误对象压成一句可直接显示的「什么错了。怎么办：动作」。
  function errorText(err, fallbackTitle) {
    var f = failureOf(err);
    if (f.mapped) return sentence(f.title, f.action);
    var detail = String(f.detail || '').replace(/^E_[A-Z_]+[:：]\s*/, '').trim();
    return sentence(detail || fallbackTitle || '操作未完成', DEFAULT_ACTION);
  }

  // errorBlock 是错误态的统一块：标题 / 服务端原文 / 「怎么办」/（可选）重试按钮。
  function errorBlock(err, options) {
    var o = options || {};
    var f = failureOf(err);
    var box = el('div', 'empty-state');
    box.setAttribute('role', 'alert');
    box.appendChild(el('p', 'empty-state-title', o.title || f.title || '操作未完成'));
    var detail = String(f.detail || '').replace(/^E_[A-Z_]+[:：]\s*/, '').trim();
    if (detail) box.appendChild(el('p', 'empty-state-text', detail));
    box.appendChild(el('p', 'empty-state-text', '怎么办：' + (f.action || o.action || DEFAULT_ACTION)));
    if (typeof o.onRetry === 'function') {
      var retry = el('button', 'btn btn-ghost', o.retryLabel || '重新读取');
      retry.type = 'button';
      retry.addEventListener('click', o.onRetry);
      box.appendChild(retry);
    }
    return box;
  }

  // emptyBlock 是空态的统一块：<当前没有 X> + <一句话说明> + [下一步按钮]。
  // 没有 label 就不渲染按钮——调用方必须自己想清楚「用户下一步该点哪」。
  function emptyBlock(options) {
    var o = options || {};
    var box = el('div', 'panel-empty empty-state');
    box.appendChild(el('p', 'empty-state-title', o.title || '这里还没有内容'));
    if (o.text) box.appendChild(el('p', 'empty-state-text', o.text));
    if (o.hint) box.appendChild(el('p', 'empty-state-text', o.hint));
    if (o.label) {
      var btn = el('button', 'btn btn-primary', o.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        if (o.route) {
          if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate(o.route);
          else window.location.hash = '#/' + o.route;
          return;
        }
        if (typeof o.onClick === 'function') o.onClick();
      });
      box.appendChild(btn);
    }
    return box;
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

  // ── 顶栏状态指示器（R24）：图标 + 四态色 + tip，替代旧「绿点 + 文字」 ──
  // 语义图标 20×20 currentColor，与 shell.js ICONS 同一套视觉语言，不引图标库、不发请求。
  var STATUS_ICON = {
    health: ['M3 11h3l2-4 3 7 2.2-4.5 1.3 1.5H17'], // 心电脉冲折线（健康检查）
    info: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M10 9v5', 'M10 6.4h.01'] // 圆圈 i（系统信息）
  };
  // 四态 → 颜色令牌：正常绿 / 警告黄 / 异常红 / 未知灰。颜色从状态数据取，绝不写死全绿。
  var STATUS_TONE = { ok: 'var(--kore-success)', warn: 'var(--kore-warning)', fail: 'var(--kore-danger)', unknown: 'var(--kore-text-3)' };

  // tip 浮层：position:fixed 挂 body、z-index 90（高于抽屉/遮罩）、pointer-events:none，
  // 视口 clamp 防溢出。与 r24-charttip 的 .kore-ui-tip 范式统一，避免两套实现打架。
  var uiTip = null;
  function hideUiTip() { if (uiTip) uiTip.style.display = 'none'; }
  function showUiTip(anchor, text) {
    if (!uiTip) {
      uiTip = el('div', 'kore-ui-tip');
      uiTip.setAttribute('role', 'tooltip');
      document.body.appendChild(uiTip);
    }
    uiTip.textContent = text;
    uiTip.style.display = 'block';
    var a = anchor.getBoundingClientRect();
    var t = uiTip.getBoundingClientRect();
    var left = a.left + a.width / 2 - t.width / 2;
    var top = a.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
    if (top + t.height > window.innerHeight - 8) top = a.top - t.height - 8;
    uiTip.style.left = left + 'px';
    uiTip.style.top = top + 'px';
  }
  if (document.addEventListener) document.addEventListener('click', hideUiTip);

  // 顶栏单个状态图标：颜色 = 状态映射，右下角小圆点作第二编码通道，aria-label 保留文本通道。
  function statusIcon(kind, st, tipText) {
    var tone = STATUS_TONE[st.cls] || STATUS_TONE.unknown;
    var btn = el('span', 'status-ico status-ico-' + (st.cls || 'unknown'));
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('role', 'img');
    btn.setAttribute('aria-label', tipText);
    btn.style.color = tone;
    btn.appendChild(iconSvg(STATUS_ICON[kind]));
    var pip = el('span', 'status-ico-pip');
    pip.style.background = tone;
    btn.appendChild(pip);
    var show = function () { showUiTip(btn, tipText); };
    // 触摸 tap 会合成 mouseenter→mouseleave；短时间内忽略 mouseleave，
    // 保证手机上 tip 点出后保持可见（FRONTEND §13 判据 11）。
    var touchLock = 0;
    btn.addEventListener('mouseenter', show);
    btn.addEventListener('mouseleave', function () { if (Date.now() - touchLock > 900) hideUiTip(); });
    btn.addEventListener('focus', show);
    btn.addEventListener('blur', function () { if (Date.now() - touchLock > 900) hideUiTip(); });
    btn.addEventListener('click', function (e) { e.stopPropagation(); show(); }); // 手机 tap + 桌面点击都可显示
    btn.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') { touchLock = Date.now(); show(); } });
    return btn;
  }

  // tip 文案：状态名 + 关键数值，人话，零内部术语（G-33 A4）。
  function healthTip(st) {
    if (st.cls === 'ok') return '健康检查：正常 · 服务响应正常';
    if (st.cls === 'fail') return '健康检查：' + st.text + ' · 服务未响应，请稍后重试';
    return '健康检查：' + st.text + ' · 正在检测或暂未取得结果';
  }
  function infoTip(st) {
    var data = state.info || {};
    var ver = data.version ? 'kored ' + data.version : '';
    var cnt = state.plugins && state.plugins.length ? state.plugins.length + ' 个插件' : '';
    var detail = [ver, cnt].filter(Boolean).join(' · ');
    if (st.cls === 'ok') return '系统信息：正常' + (detail ? ' · ' + detail : ' · 信息已读取');
    return '系统信息：' + st.text + (detail ? ' · ' + detail : ' · 暂未取得完整信息');
  }

  function healthState() {
    var h = state.health;
    if (!h) return { cls: 'unknown', text: '检测中' };
    if (!h.reached) return { cls: 'fail', text: '不可达' };
    if (!h.res.ok) return { cls: 'fail', text: '异常' };
    return { cls: 'ok', text: '正常' };
  }

  function infoState() {
    if (!state.authed) return { cls: 'unknown', text: '未登录' };
    if (!state.info) return { cls: 'unknown', text: '检测中' };
    if (Array.isArray(state.info.warnings) && state.info.warnings.length) return { cls: 'warn', text: '部分受限' };
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

  // 首登改密提示：非阻断、可关闭。后端 X-Kore-Password-Hint: 1 触发，只说「建议」，
  // 绝不拦任何功能；「以后再说」只置本会话标记，关掉不再出现（不写 localStorage，
  // 下次重新登录仍按后端标志提示）。「去修改」直达设置→账户与安全并打开改密弹层。
  function passwordHintBar() {
    var box = el('div', 'notice notice-advisory');
    box.id = 'kore-password-hint';
    box.setAttribute('role', 'status');
    box.appendChild(el('span', 'dot warn notice-dot'));
    var text = el('div', 'notice-body');
    text.appendChild(el('div', 'notice-title', '建议修改初始口令'));
    text.appendChild(el('div', 'notice-hint', '当前口令是安装时生成的初始口令。建议现在改一个只有你知道的口令；不改也能正常使用全部功能。'));
    box.appendChild(text);
    var ops = el('div', 'notice-ops');
    var go = el('button', 'btn btn-primary', '去修改');
    go.type = 'button';
    go.addEventListener('click', function () {
      closePasswordHint();
      if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
        window.KoreShell.navigate('settings');
      }
      // settings.js 懒加载完成后再打开弹层；render 内已处理账户与安全 tab 的落地。
      if (window.KoreCtx && typeof window.KoreCtx.ensureModule === 'function') {
        window.KoreCtx.ensureModule('/assets/settings.js', 'KoreSettings').then(function (mod) {
          if (mod && typeof mod.openPasswordDialog === 'function') {
            mod.openPasswordDialog(go);
          } else if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
            window.KoreShell.navigate('settings/user-center');
          }
        }, function () { /* 加载失败就留在设置页，用户可手动点「修改口令」 */ });
      }
    });
    var later = el('button', 'btn btn-ghost', '以后再说');
    later.type = 'button';
    later.addEventListener('click', closePasswordHint);
    ops.appendChild(go);
    ops.appendChild(later);
    box.appendChild(ops);
    return box;
  }

  function closePasswordHint() {
    state.passwordHintDismissed = true;
    var box = document.getElementById('kore-password-hint');
    if (box && box.parentNode) box.parentNode.removeChild(box);
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

  function showLoginError(errBox, message, retryAfter) {
    if (!errBox) return;
    // 延时提示给白话 + 逐秒倒计时（USABILITY §4：错误提示必须带「怎么办」）。
    // 只有一个计时器：重绘/再次报错先清掉，避免两条提示各跑一个 interval 互相覆盖。
    if (errBox._koreCountdown) {
      clearInterval(errBox._koreCountdown);
      errBox._koreCountdown = null;
    }
    var seconds = parseInt(retryAfter || '0', 10);
    if (!isFinite(seconds) || seconds <= 0) {
      errBox.textContent = message;
      errBox.hidden = false;
      return;
    }
    var fixed = message.replace(/\d+\s*秒/g, 'N 秒');
    var left = seconds;
    function paint() {
      errBox.textContent = fixed.replace('N', String(left));
      errBox.hidden = false;
    }
    paint();
    errBox._koreCountdown = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(errBox._koreCountdown);
        errBox._koreCountdown = null;
        errBox.textContent = '等待结束，请再试一次';
        return;
      }
      paint();
    }, 1000);
  }

  // 一字段一卡：中文标签 + 一行帮助（USABILITY 原则④），表单顺序即阅读顺序。
  function loginField(labelText, helpText, isAuto) {
    var field = el('div', 'login-field');
    var head = el('div', 'login-field-head');
    head.appendChild(el('span', 'field-label', labelText));
    if (isAuto) head.appendChild(el('span', 'login-auto-tag', '已自动检测'));
    field.appendChild(head);
    if (helpText) field.appendChild(el('div', 'field-help', helpText));
    return field;
  }

  function renderLogin(message) {
    var wrap = el('div', 'login-wrap');
    var card = el('form', 'login-card');
    card.setAttribute('method', 'post');
    card.setAttribute('novalidate', 'novalidate');

    card.appendChild(el('div', 'login-brand', 'Kore'));
    card.appendChild(el('div', 'login-sub', '控制台 · 账号登录'));

    // 三要素一张卡：账号 → 密码 →（按需）验证码，顺序即阅读顺序；
    // 每个字段「中文标签 + 一行帮助」（USABILITY 原则④），不靠 placeholder 当标签。
    var userLabel = loginField('账号', '本机管理员账号，已为你填好，一般不用改', true);
    var username = document.createElement('input');
    username.type = 'text';
    username.id = 'kore-username';
    username.name = 'username';
    username.className = 'field-input';
    username.autocomplete = 'username';
    username.value = 'admin';
    username.required = true;
    username.setAttribute('placeholder', '请输入账号');
    userLabel.appendChild(username);
    card.appendChild(userLabel);

    var label = loginField('密码', '安装时生成的管理员密码，输入后点「登录」');
    var input = document.createElement('input');
    input.type = 'password';
    input.id = 'kore-password';
    input.name = 'password';
    input.className = 'field-input';
    input.autocomplete = 'current-password';
    input.required = true;
    input.setAttribute('placeholder', '请输入密码');
    label.appendChild(input);
    card.appendChild(label);

    // 两步验证：服务端要求时（E_2FA_REQUIRED）才显示验证码输入框。
    var otpLabel = loginField('验证码（认证器）', '打开认证器 App，输入 6 位数字或恢复码');
    otpLabel.id = 'kore-otp-field';
    otpLabel.hidden = true;
    var otp = document.createElement('input');
    otp.type = 'text';
    otp.id = 'kore-otp';
    otp.name = 'otp';
    otp.className = 'field-input';
    // 不设 maxLength：恢复码是 11 位（XXXXX-XXXXX），设 6 会把恢复码截断。
    otp.setAttribute('placeholder', '请输入认证器上的验证码');
    otpLabel.appendChild(otp);
    card.appendChild(otpLabel);

    // 图形验证码：第一次密码错误后由服务端要求，默认隐藏；图片与按钮都能刷新。
    var captchaLabel = loginField('验证码（图片）', '请输入右侧图片里的字符；看不清可点图片或「换一张」', false);
    captchaLabel.id = 'kore-captcha-field';
    captchaLabel.hidden = true;
    var captchaRow = el('div', 'kore-captcha-row');
    var captchaImg = el('img', 'kore-captcha-img');
    captchaImg.id = 'kore-captcha-image';
    captchaImg.alt = '验证码图片，点击可换一张';
    captchaImg.title = '点击换一张';
    captchaImg.setAttribute('role', 'button');
    captchaImg.tabIndex = 0;
    captchaRow.appendChild(captchaImg);
    var captchaSwap = el('button', 'btn btn-ghost kore-captcha-swap', '换一张');
    captchaSwap.type = 'button';
    captchaSwap.id = 'kore-captcha-refresh';
    captchaSwap.setAttribute('aria-label', '刷新验证码图片');
    captchaRow.appendChild(captchaSwap);
    captchaLabel.appendChild(captchaRow);
    var captcha = document.createElement('input');
    captcha.type = 'text';
    captcha.id = 'kore-captcha-answer';
    captcha.maxLength = 10;
    captcha.name = 'captcha_answer';
    captcha.className = 'field-input';
    captcha.autocomplete = 'off';
    captcha.setAttribute('placeholder', '请输入图片里的字符');
    captcha.setAttribute('aria-label', '图片验证码答案');
    captchaLabel.appendChild(captcha);
    captchaLabel.appendChild(el('span', 'field-help', '不方便看图？图片标题里有同样的加法题，可直接算答案'));
    card.appendChild(captchaLabel);

    // 验证码触发后把「为什么多了一步」写在验证码与按钮之间，小白不用猜三者关系。
    var captchaNotice = el('div', 'login-captcha-notice', '为确认是您本人操作，请先填写下方图片验证码，再点「登录」。');
    captchaNotice.id = 'kore-captcha-notice';
    captchaNotice.setAttribute('role', 'status');
    captchaNotice.hidden = true;
    card.appendChild(captchaNotice);

    var submit = el('button', 'btn btn-primary btn-block', '登录');
    submit.type = 'submit';
    submit.id = 'kore-login-submit';
    card.appendChild(submit);

    var errBox = el('div', 'login-error', message || '');
    errBox.id = 'kore-login-error';
    errBox.setAttribute('role', 'alert');
    if (!message) errBox.hidden = true;
    card.appendChild(errBox);
    card.appendChild(el('div', 'login-note', '密码连续输错后会要求验证码并逐步延长等待时间；密码只在本机校验，不会发送出去。'));

    var captchaState = { id: '', question: '' };
    function loadCaptcha() {
      request('/api/v1/auth/captcha', { method: 'GET' }, LOGIN_TIMEOUT_MS).then(function (res) {
        if (!res.ok || !res.data) return;
        captchaState.id = res.data.captcha_id || '';
        captchaState.question = res.data.text_question || '';
        if (res.data.image) captchaImg.src = res.data.image;
        if (captchaState.question) captchaImg.title = '也可以计算：' + captchaState.question;
      }, function () { /* 拉取失败保留旧图，用户可重试 */ });
    }
    function showCaptcha() {
      captchaLabel.hidden = false;
      captchaNotice.hidden = false;
      captcha.value = '';
      loadCaptcha();
    }
    captchaSwap.addEventListener('click', loadCaptcha);
    captchaImg.addEventListener('click', loadCaptcha);
    // 图片也是可点控件：键盘 Enter/空格同效（触摸目标在 CSS 里≥44px）。
    captchaImg.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); loadCaptcha(); }
    });

    card.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitLogin(username, input, submit, errBox, otpLabel, otp, captchaLabel, captcha, captchaState, showCaptcha);
    });

    wrap.appendChild(card);
    if (app.replaceChildren) app.replaceChildren(wrap);
    else { app.innerHTML = ''; app.appendChild(wrap); }
    input.focus();
  }

  function submitLogin(username, input, submit, errBox, otpLabel, otp, captchaLabel, captcha, captchaState, showCaptcha) {
    var account = username ? (username.value || '').trim() : '';
    var password = input.value || '';
    if (!account) {
      showLoginError(errBox, '请输入账号');
      if (username) username.focus();
      return;
    }
    if (!password) {
      showLoginError(errBox, '请输入密码');
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = '登录中…';

    request(ENDPOINTS.login, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: account,
        password: password,
        otp: otp && otpLabel && !otpLabel.hidden ? (otp.value || '') : '',
        captcha_id: captchaLabel && !captchaLabel.hidden ? (captchaState.id || '') : '',
        captcha_answer: captchaLabel && !captchaLabel.hidden ? (captcha.value || '') : ''
      })
    }, LOGIN_TIMEOUT_MS).then(function (res) {
      if (res.ok) {
        // 登录成功：服务端已下发 kore_session(HttpOnly) + kore_csrf，回到探测流程重渲染面板。
        start();
        return;
      }
      var code = (res.data && res.data.code) || '';
      var msg = (res.data && res.data.message) || '';
      var retryAfter = parseInt(res.retryAfter || '0', 10);
      // 429 先判：延时提示优先于其它分支，倒计时跟 Retry-After 走（G-30 不泄露内部码）。
      if (res.status === 429) {
        showLoginError(errBox, retryAfter > 0 ? ('请 ' + retryAfter + ' 秒后再试') : '请稍后再试，尝试太频繁', res.retryAfter);
        submit.disabled = false;
        submit.textContent = '登录';
        return;
      }
      if (code === 'E_2FA_REQUIRED' && otpLabel && otp) {
        // 口令正确，只差二次验证：展开输入框，保留口令不清空，等用户输入后重提。
        otpLabel.hidden = false;
        showLoginError(errBox, msg || '请输入 6 位验证码');
        submit.disabled = false;
        submit.textContent = '登录';
        otp.focus();
        return;
      }
      // 需要验证码（首次口令错 / 428 / 401 提示验证码）：展开并自动换一张。
      var needCaptcha = code === 'E_CAPTCHA_REQUIRED' || code === 'E_CAPTCHA_INVALID' ||
        (res.status === 401 && /验证码/.test(msg));
      if (needCaptcha && showCaptcha) showCaptcha();
      input.value = '';
      if (otp) otp.value = '';
      if (otpLabel) otpLabel.hidden = true;
      if (code === 'E_2FA_INVALID') showLoginError(errBox, '验证码或恢复码不正确，请重新输入');
      else if (code === 'E_IP_DENIED') showLoginError(errBox, '当前网络地址不在允许登录的范围内，请联系管理员');
      else if (res.status === 401 && msg === '账号或口令错误') showLoginError(errBox, '账号或口令不正确，请检查后再试');
      else if (needCaptcha) showLoginError(errBox, msg || '密码错误，请输入右侧验证码');
      else showLoginError(errBox, '登录失败：' + describeError(res));
      submit.disabled = false;
      submit.textContent = '登录';
      if (needCaptcha && captcha) captcha.focus(); else input.focus();
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
    var hs = healthState();
    var is = infoState();
    conn.appendChild(statusIcon('health', hs, healthTip(hs)));
    conn.appendChild(statusIcon('info', is, infoTip(is)));

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

  function residentText(sup) {
    var n = fmtInt(sup.resident);
    if (n === '—') return '—';
    var max = fmtInt(sup.resident_max);
    var text = max === '—' ? n + ' / 上限 3' : n + ' / ' + max;
    var lazy = fmtInt(sup.lazy_slots);
    if (lazy !== '—') text += ' · lazy 可用 ' + lazy;
    return text;
  }

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

  // 「已装插件」tab：插件管理子系统（插件表 / 单条升级 / 卸载 / 一键全部升级 /
  // invoke ping 探测 / 插件 UI 桥）在 /assets/plugins-view.js，首次点进该 tab 才注入。
  // 首屏不带它 —— FRONTEND §7：d(首屏)/d(视图数)=0；同一个「软件商店」hub 里
  // 「应用商店」tab（store.js）本来就是懒加载，这里对齐口径：插件数与管理逻辑再多，
  // 也不撑大首屏六件套（抽出后 app.js 实测 gzip 约 -11.8 KiB）。
  function renderPluginsView(box) {
    var live = { destroyed: false };
    box.appendChild(el('div', 'stub', '正在加载插件管理…'));
    ensureModule('/assets/plugins-view.js', 'KorePluginsView').then(function (mod) {
      if (live.destroyed) return;
      box.textContent = '';
      try {
        mod.render(box);
      } catch (err) {
        box.textContent = '';
        box.appendChild(el('div', 'stub', '插件管理渲染失败：' + (err && err.message ? err.message : err)));
      }
    }, function (err) {
      if (live.destroyed) return;
      box.textContent = '';
      box.appendChild(el('div', 'stub', '插件管理不可用：' + errText(err)));
    });
    return { destroy: function () { live.destroyed = true; } };
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
      // 顶栏状态指示器（R24）：图标 + 四态色 + tip；颜色由 statusIcon 内联 style.color 按状态映射。
      '.status-ico{position:relative;display:inline-flex;align-items:center;justify-content:center;' +
        'width:32px;height:32px;flex:0 0 auto;cursor:help;border-radius:var(--kore-radius-control)}' +
        '.status-ico svg{width:18px;height:18px;pointer-events:none}' +
        '.status-ico-pip{position:absolute;right:3px;bottom:3px;width:6px;height:6px;border-radius:50%;' +
        'box-shadow:0 0 0 2px var(--kore-bg-1)}' +
        '.status-ico:hover{background:var(--kore-bg-2)}' +
        '.status-ico:focus-visible{outline:2px solid var(--kore-info);outline-offset:1px}' +
        '.kore-ui-tip{position:fixed;z-index:90;pointer-events:none;display:none;max-width:280px;' +
        'padding:6px 10px;border-radius:var(--kore-radius-control);border:1px solid var(--kore-border-1);' +
        'background:var(--kore-bg-2);color:var(--kore-text-1);box-shadow:var(--kore-shadow);' +
        'font-size:var(--kore-font-12);line-height:1.5;white-space:nowrap}' +
        '@media (max-width:639px){.status-ico{min-width:var(--kore-touch);min-height:var(--kore-touch)}' +
        '.kore-ui-tip{white-space:normal;max-width:calc(100vw - 16px)}}',
      '.ov-head{display:flex;align-items:center;justify-content:space-between;gap:var(--kore-space-3);' +
        'margin-bottom:var(--kore-space-4)}',
      '.ov-note{margin:0 0 var(--kore-space-2);padding:var(--kore-space-2) var(--kore-space-3);' +
        'color:var(--kore-warning);background:var(--kore-warning-bg);border:1px solid var(--kore-warning);' +
        'border-radius:var(--kore-radius-control);font-size:var(--kore-font-12);word-break:break-word}',
      // 5 张指标卡（CPU / 内存 / 磁盘 / 负载 / 网络）：auto-fit 让宽屏一行 5 张、
      // 窄屏自动折行，不靠固定列数（加卡不用改布局）。
      '.ov-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(176px,1fr));' +
        'gap:var(--kore-space-3);margin-bottom:var(--kore-space-6)}',
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
      '.ov-row-link{cursor:pointer;min-height:var(--kore-touch);margin:0 calc(var(--kore-space-3) * -1);' +
        'padding:0 var(--kore-space-3);border-radius:var(--kore-radius-control)}',
      '.ov-row-link:hover{background:var(--kore-bg-2)}',
      '.ov-row-link:focus-visible{outline:2px solid var(--kore-info);outline-offset:1px}',
      '.ov-row-go{color:var(--kore-text-3);font-size:var(--kore-font-16);line-height:1}',
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
      '.ov-alert-sev{flex:0 0 auto;font-size:var(--kore-font-12);font-weight:600;color:var(--kore-text-2)}',
      '.ov-alert-sev.is-critical{color:var(--kore-danger)}',
      '.ov-alert-sev.is-warning{color:var(--kore-warning)}',
      '.ov-alert-what{font-weight:600;overflow-wrap:anywhere}',
      '.ov-alert-time{color:var(--kore-text-3);font-size:var(--kore-font-12)}',
      '.ov-alert-ok{display:flex;align-items:center;gap:var(--kore-space-2);padding:var(--kore-space-1) 0}',
      '.ov-alert-ok span:last-child{margin-left:auto}',
      // 健康状态卡（首屏第一块）：分数 + 一句话结论 + 七项分项；异常项整块可点直达。
      '.ov-hero{display:flex;flex-direction:column;gap:var(--kore-space-3);margin-bottom:var(--kore-space-4);' +
        'padding:var(--kore-space-4);background:var(--kore-bg-1);border:1px solid var(--kore-border-1);' +
        'border-left:4px solid var(--kore-border-2);border-radius:var(--kore-radius-container)}',
      '.ov-hero.is-ok{border-left-color:var(--kore-success)}' +
        '.ov-hero.is-warn{border-left-color:var(--kore-warning)}' +
        '.ov-hero.is-fail{border-left-color:var(--kore-danger)}',
      '.ov-hero-main{display:flex;align-items:center;gap:var(--kore-space-4);flex-wrap:wrap}',
      '.ov-hero-score{display:flex;align-items:baseline;gap:2px;min-width:72px}',
      '.ov-hero-num{font-size:var(--kore-font-32);font-weight:600;line-height:1;' +
        'font-variant-numeric:tabular-nums;color:var(--kore-text-1)}',
      '.ov-hero.is-warn .ov-hero-num{color:var(--kore-warning)}' +
        '.ov-hero.is-fail .ov-hero-num{color:var(--kore-danger)}',
      '.ov-hero-unit{font-size:var(--kore-font-12);color:var(--kore-text-3)}',
      '.ov-hero-text{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.ov-hero-line{display:flex;align-items:center;gap:var(--kore-space-2);flex-wrap:wrap}',
      '.ov-hero-headline{font-size:var(--kore-font-16);font-weight:600;color:var(--kore-text-1)}',
      '.ov-hero-tools{display:flex;gap:var(--kore-space-2);flex:0 0 auto}',
      '.ov-hero-go{min-height:var(--kore-touch)}',
      '.ov-hero-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:var(--kore-space-2)}',
      '.ov-check{display:flex;align-items:center;gap:var(--kore-space-2);min-height:36px;min-width:0;' +
        'padding:var(--kore-space-1) var(--kore-space-2);background:var(--kore-bg-2);' +
        'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control)}',
      '.ov-check-label{font-size:var(--kore-font-12);color:var(--kore-text-3);white-space:nowrap}',
      '.ov-check-value{margin-left:auto;font-size:var(--kore-font-13);font-weight:600;color:var(--kore-text-1);' +
        'font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ov-check.is-warn .ov-check-value{color:var(--kore-warning)}' +
        '.ov-check.is-fail .ov-check-value{color:var(--kore-danger)}',
      '.ov-check-link{cursor:pointer}' +
        '.ov-check-link:hover{border-color:var(--kore-text-3)}' +
        '.ov-check-link:focus-visible{outline:2px solid var(--kore-info);outline-offset:1px}',
      '.ov-check-go{color:var(--kore-text-3);font-size:var(--kore-font-16);line-height:1}',
      // 快捷入口：四个高频动作；手机 2×2，触摸目标 ≥44px（裁决41）。
      '.ov-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--kore-space-2);' +
        'margin-bottom:var(--kore-space-4)}',
      '.ov-action{display:flex;flex-direction:column;gap:2px;align-items:flex-start;min-height:var(--kore-touch);' +
        'padding:var(--kore-space-2) var(--kore-space-3);background:var(--kore-bg-1);' +
        'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);' +
        'color:var(--kore-text-1);font:inherit;text-align:left;cursor:pointer}',
      '.ov-action:hover{border-color:var(--kore-text-3);background:var(--kore-bg-2)}' +
        '.ov-action:focus-visible{outline:2px solid var(--kore-info);outline-offset:1px}',
      '.ov-action-label{font-size:var(--kore-font-14);font-weight:600}' +
        '.ov-action-hint{font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.4}',
      // 待办：一行一件事，右侧「去处理」，整行可点（不用先想这件事在哪个菜单）。
      '.ov-todo-panel{margin-bottom:var(--kore-space-4)}',
      '.ov-todo-body{display:flex;flex-direction:column;gap:0;padding:var(--kore-space-2) var(--kore-space-4) var(--kore-space-4)}',
      '.ov-todo{display:flex;align-items:center;gap:var(--kore-space-3);min-height:var(--kore-touch);' +
        'padding:var(--kore-space-2);border-bottom:1px solid var(--kore-border-1);' +
        'border-radius:var(--kore-radius-control);cursor:pointer}',
      '.ov-todo:last-of-type{border-bottom:0}' +
        '.ov-todo:hover{background:var(--kore-bg-2)}' +
        '.ov-todo:focus-visible{outline:2px solid var(--kore-info);outline-offset:1px}',
      '.ov-todo-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
      '.ov-todo-title{font-size:var(--kore-font-14);font-weight:600;color:var(--kore-text-1);overflow-wrap:anywhere}',
      '.ov-todo.is-fail .ov-todo-title{color:var(--kore-danger)}' +
        '.ov-todo.is-warn .ov-todo-title{color:var(--kore-warning)}',
      '.ov-todo-detail{font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.5;overflow-wrap:anywhere}',
      '.ov-todo-cta{font-size:var(--kore-font-12);color:var(--kore-info);white-space:nowrap;flex:0 0 auto}',
      // 迷你趋势：静态条形，点一下 / 方向键把单点读数写出来（G-32「数据点可读」）。
      '.ov-trend{margin-top:var(--kore-space-1)}',
      '.ov-trend-bars{display:flex;align-items:flex-end;gap:2px;height:26px;cursor:crosshair}',
      '.ov-trend-bar{flex:1 1 0;min-width:2px;max-width:14px;align-self:flex-end;' +
        'background:var(--kore-info);opacity:0.55;border-radius:1px 1px 0 0}',
      '.ov-trend-bar.is-active{opacity:1;background:var(--kore-text-1)}',
      '.ov-trend-read{margin:2px 0 0;font-size:var(--kore-font-12);color:var(--kore-text-3);' +
        'font-variant-numeric:tabular-nums;line-height:1.4;overflow-wrap:anywhere}',
      '.ov-trend:focus-visible{outline:2px solid var(--kore-info);outline-offset:1px}',
      '.ov-net{display:flex;flex-wrap:wrap;gap:var(--kore-space-3)}',
      '.ov-net-line{font-size:var(--kore-font-16);font-weight:600;color:var(--kore-text-1);' +
        'font-variant-numeric:tabular-nums}',
      '.ov-card-btn{min-height:var(--kore-touch);align-self:flex-start}',
      '.ov-sysinfo{margin-bottom:var(--kore-space-4);background:var(--kore-bg-1);' +
        'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-container)}',
      '.ov-sysinfo>summary{cursor:pointer;padding:var(--kore-space-3) var(--kore-space-4);' +
        'color:var(--kore-text-2);font-size:var(--kore-font-13)}',
      '.ov-sysinfo>summary:hover{color:var(--kore-text-1)}',
      '.ov-sysinfo .rows{margin:0 var(--kore-space-4) var(--kore-space-3)}',
      '.ov-sysinfo .ov-caption{padding:0 var(--kore-space-4) var(--kore-space-3)}',
      '@media (max-width:1024px){.ov-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}' +
        '.ov-actions{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (max-width:639px){.ov-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kore-space-2)}' +
        '.ov-status{grid-template-columns:1fr;gap:var(--kore-space-2)}' +
        '.ov-card{padding:var(--kore-space-3)}' +
        '.ov-head{flex-wrap:wrap}' +
        '.ov-hero{padding:var(--kore-space-3);gap:var(--kore-space-2)}' +
        '.ov-hero-main{gap:var(--kore-space-3)}' +
        '.ov-hero-tools{width:100%}' +
        '.ov-hero-go{width:100%}' +
        '.ov-hero-checks{grid-template-columns:repeat(2,minmax(0,1fr))}' +
        '#kore-ov-hero .ov-caption{white-space:normal}' +
        '.ov-check{min-height:var(--kore-touch)}' +
        '.ov-actions{grid-template-columns:repeat(2,minmax(0,1fr))}' +
        '.ov-todo-body{padding:var(--kore-space-2) var(--kore-space-3) var(--kore-space-3)}' +
        '.ov-todo{gap:var(--kore-space-2)}' +
        '.ov-todo-detail{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}}'
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
  var OV_CRON = '/api/v1/invoke/cron/cron.list';
  var OV_SCHED = '/api/v1/scheduler/tasks';
  var OV_PRESETS = '/api/v1/store/presets';
  // 概览阈值：与 alert-rules.js / monitor 插件同一本账（occupancy 80/90、负载 1×/2× 核数）。
  var OV_DISK_TODO = 85;      // 磁盘到这条线就进「待办」，不再只是变黄
  var OV_CERT_WARN_DAYS = 30; // 证书剩余天数
  var OV_CERT_FAIL_DAYS = 7;
  var OV_TREND_MAX = 24;      // 迷你趋势最多保留的采样点（单图 ≤1000 点，G-32）
  var OV_TODO_MAX = 8;        // 待办一屏最多 8 条，超出只显示前 8（附「还有 N 项」）
  var OV_ALERT_WINDOW_MS = 5 * 60 * 1000;
  var OV_DENIED_BURST = 5;
  var OV_HIGH_RISK = { 'root.action': '提权动作被拒绝', 'capability.denied': '权限不足被拒绝（需要管理员账号；能力由插件声明授予，无逐项授权开关）' };
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
  function ovMetricCard(title, num, unit, toneName, chipText, chipTitle, barPct, caption, trend) {
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
    if (trend) card.appendChild(trend);
    card.appendChild(el('p', 'ov-caption', caption));
    return card;
  }


  /* ---------- 概览：健康状态 / 待办 / 快捷入口 / 迷你趋势 ----------
     战略「操作更简便」的首页版本：登录后第一屏用 3 秒回答两件事——
     「这台机器现在怎么样」（健康分 + 分项）与「有什么要处理」（待办，每条一键直达）。
     数据全部复用既有 API 与插件方法，一次性拉取，不新增轮询（G-19）、不引依赖；
     任一来源不可用时该项进「未采集」并如实标注，不编 0（诚实降级）。 */

  var OV_TONE_TEXT = { ok: '正常', warn: '注意', fail: '异常', na: '未采集' };
  var OV_RANK = { na: 0, ok: 1, warn: 2, fail: 3 };

  function ovWorse(a, b) { return OV_RANK[b] > OV_RANK[a] ? b : a; }
  function ovPctText(v) { var n = ovNum(v); return n === null ? '—' : n.toFixed(1) + '%'; }

  // 概览内的跳转：'!alerts' 打开告警中心浮层（不是路由），其余走主壳路由。
  function ovGo(route) {
    if (!route) return;
    if (route === '!alerts') { openAlertCenter(); return; }
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate(route);
  }

  // 趋势序列：优先用 monitor 插件的 history（一次请求带回来，不额外定时采样）；
  // 插件缺席时退回「本次会话内每次重绘的采样」，够画一条可信的迷你曲线。
  function ovSeries(kind) {
    var hist = (ov.sys && ov.sys.history) || {};
    var key = { cpu: 'cpu_percent', mem: 'memory_percent', disk: 'disk_percent' }[kind];
    var arr = key && Array.isArray(hist[key]) ? hist[key] : null;
    if (arr && arr.length) return arr.slice(-OV_TREND_MAX);
    return (ov.sess[kind] || []).slice(-OV_TREND_MAX);
  }

  // 会话采样：每次真正拿到一份系统数据才追加一个点（不在重绘里重复推）。
  function ovPushSample() {
    var sys = ov.sys || {}, cpu = sys.cpu || {}, mem = sys.memory || {};
    var disks = Array.isArray(sys.disks) ? sys.disks : [], root = null;
    for (var i = 0; i < disks.length; i++) {
      if (disks[i] && disks[i].mount === '/') { root = disks[i]; break; }
    }
    var pts = { cpu: ovNum(cpu.usage_percent), mem: ovNum(mem.used_percent), disk: ovNum(root && root.used_percent) };
    Object.keys(pts).forEach(function (k) {
      if (pts[k] === null) return;
      var arr = ov.sess[k];
      arr.push(pts[k]);
      while (arr.length > OV_TREND_MAX) arr.shift();
    });
  }

  // 迷你趋势：静态条形（G-32：静态图优先轻量实现，单图点 ≤ OV_TREND_MAX）。
  // 每个点 hover 有 title、点击/方向键把读数写进下一行——手机上点到哪根就读哪根。
  function ovTrend(kind, unit) {
    var values = ovSeries(kind);
    if (!values.length) return null;
    var max = 0, min = 1e9;
    for (var i = 0; i < values.length; i++) {
      var v = ovNum(values[i]);
      if (v === null) continue;
      if (v > max) max = v;
      if (v < min) min = v;
    }
    if (min > max) { min = 0; max = 0; }
    var scale = Math.max(max, 1);
    var wrap = el('div', 'ov-trend');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', '近 ' + values.length + ' 次采样趋势，方向键逐点读取');
    var bars = el('div', 'ov-trend-bars');
    var nodes = [];
    for (var j = 0; j < values.length; j++) {
      var n = ovNum(values[j]);
      var bar = el('div', 'ov-trend-bar');
      bar.style.height = Math.max(4, Math.min(100, ((n === null ? 0 : n) / scale) * 100)).toFixed(1) + '%';
      bar.title = (n === null ? '—' : n.toFixed(1) + unit);
      bar.setAttribute('aria-hidden', 'true');
      nodes.push(bar);
      bars.appendChild(bar);
    }
    wrap.appendChild(bars);
    // 读数用短句（卡片窄，长句会被省略号切掉）：次数 + 低 / 高 / 最新。
    var last = ovNum(values[values.length - 1]);
    var read = el('p', 'ov-trend-read', '近 ' + values.length + ' 次 · 低 ' + min.toFixed(1) + unit +
      ' 高 ' + max.toFixed(1) + unit + ' 最新 ' + (last === null ? '—' : last.toFixed(1) + unit));
    wrap.appendChild(read);
    var active = -1;
    function pick(idx) {
      if (idx < 0) idx = 0;
      if (idx > values.length - 1) idx = values.length - 1;
      if (idx === active) return;
      if (active >= 0 && nodes[active]) nodes[active].className = 'ov-trend-bar';
      active = idx;
      if (nodes[active]) nodes[active].className = 'ov-trend-bar is-active';
      var pv = ovNum(values[active]);
      read.textContent = '第 ' + (active + 1) + ' 次采样 · ' + (pv === null ? '—' : pv.toFixed(1) + unit);
    }
    wrap.addEventListener('click', function (ev) {
      var rect = bars.getBoundingClientRect();
      if (!rect.width) return;
      var ratio = (ev.clientX - rect.left) / rect.width;
      pick(Math.round(ratio * (values.length - 1)));
    });
    wrap.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight') { ev.preventDefault(); pick(active < 0 ? 0 : active + 1); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); pick(active < 0 ? values.length - 1 : active - 1); }
    });
    return wrap;
  }

  // 服务聚合检查：告警（严重/警告）+ 插件运行失败，用同一个 tone 表达「要不要管」。
  function ovServiceCheck() {
    var alerts = ov.alerts || [], crit = 0, warn = 0;
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].severity === 'critical') crit++;
      else if (alerts[i].severity === 'warning') warn++;
    }
    var counts = pluginCounts();
    var tone = counts.failed > 0 || crit > 0 ? 'fail' : warn > 0 ? 'warn' : (ov.alerts === null ? 'na' : 'ok');
    // 告警还没读到时不冒充「正常」，显示「读取中」；读到 0 条才说正常。
    var value = counts.failed > 0 ? ('插件异常 ' + counts.failed)
      : crit > 0 ? ('严重告警 ' + crit) : warn > 0 ? ('告警 ' + warn)
      : (ov.alerts === null ? '读取中' : '正常');
    var detail = counts.failed > 0 ? '有插件进程运行失败，去插件管理看日志'
      : crit > 0 ? '最近 5 分钟有严重告警待处理' : warn > 0 ? '最近 5 分钟有告警待确认' : '无严重告警，插件运行正常';
    return { tone: tone, value: value, detail: detail };
  }

  // 证书最差一张：证书插件缺席时返回 null（显示「未启用」，不当作「没有问题」）。
  function ovCertWorst() {
    var certs = ov.svc.ssl;
    if (!Array.isArray(certs)) return null;
    var worst = null;
    for (var i = 0; i < certs.length; i++) {
      var c = certs[i] || {}, d = ovNum(c.days_left);
      if (d === null) continue;
      if (!worst || d < worst.days) worst = { days: d, domain: c.domain || '—', expired: c.expired === true || d < 0 };
    }
    return worst;
  }

  // 任务体检：内核 scheduler 的 last_result + cron 的 binary_status（到点会静默失败）。
  function ovJobsCheck() {
    var out = { failed: 0, stale: 0, failedNames: [], known: false };
    var sched = ov.jobs.sched;
    if (sched && Array.isArray(sched.tasks)) {
      out.known = true;
      for (var i = 0; i < sched.tasks.length; i++) {
        var t = sched.tasks[i] || {};
        if (t.last_result === 'failed' || t.last_result === 'timeout') {
          out.failed++;
          if (out.failedNames.length < 2) out.failedNames.push(t.name || t.id || '未命名任务');
        }
      }
    }
    var cron = ov.jobs.cron;
    if (cron && Array.isArray(cron.entries)) {
      out.known = true;
      for (var j = 0; j < cron.entries.length; j++) {
        var en = cron.entries[j] || {};
        if (en.enabled === false) continue;
        if (en.binary_status === 'missing' || en.binary_status === 'stale') out.stale++;
      }
    }
    return out;
  }

  // 可更新插件：直接读内核已对齐的 update_available / latest_version
  // （handlers_plugins.go alignIndexVersions 按已验签索引算好），前端不再自己比版本——
  // 少一处可能跟商店说两套话的版本比较。
  function ovUpgradable() {
    var out = [];
    for (var i = 0; i < state.plugins.length; i++) {
      var p = state.plugins[i] || {};
      if (!p.id || p.update_available !== true) continue;
      out.push({ id: p.id, name: p.name || p.id,
        from: String(p.version || '—'), to: String(p.latest_version || '—') });
    }
    return out;
  }

  // 推荐未装插件：只认预设里 out_of_box=true 的条目（「开箱该有的」），
  // 已装（含停用）不算缺；预设目录未装配时接口回空数组，这里就自然不提示，不臆造推荐。
  function ovRecommendedMissing() {
    var presets = ov.store.presets;
    if (!Array.isArray(presets)) return null;
    var nameOf = Object.create(null);
    var installed = Object.create(null);
    for (var j = 0; j < state.plugins.length; j++) {
      if (state.plugins[j] && state.plugins[j].id) installed[state.plugins[j].id] = true;
    }
    var seen = Object.create(null), out = [];
    for (var k = 0; k < presets.length; k++) {
      var pre = presets[k] || {};
      if (pre.out_of_box !== true || !Array.isArray(pre.plugins)) continue;
      for (var m = 0; m < pre.plugins.length; m++) {
        var id = pre.plugins[m] && pre.plugins[m].id;
        if (!id || installed[id] || seen[id]) continue;
        seen[id] = true;
        out.push({ id: id, name: nameOf[id] || id });
      }
    }
    return out;
  }

  // 健康分与分项：权重只在「有数据」的项上归一，缺数据不扣分也不冒充正常。
  function ovHealth() {
    var sys = ov.sys || {}, cpu = sys.cpu || {}, mem = sys.memory || {}, load = sys.load || {};
    var disks = Array.isArray(sys.disks) ? sys.disks : [], root = null;
    for (var i = 0; i < disks.length; i++) {
      if (disks[i] && disks[i].mount === '/') { root = disks[i]; break; }
    }
    var cpuPct = ovNum(cpu.usage_percent), memPct = ovNum(mem.used_percent);
    var diskPct = ovNum(root && root.used_percent);
    var load1 = ovNum(load.load1), cores = ovNum(cpu.cores);
    var checks = [];
    function push(id, label, tone, value, detail, route, cta, weight) {
      checks.push({ id: id, label: label, tone: tone, value: value, detail: detail,
        route: route, cta: cta, weight: weight });
    }

    push('cpu', 'CPU', ovTone(cpuPct), ovPctText(cpuPct),
      cores ? (cores + ' 核 · ' + (cpuPct === null ? '无采样' : '阈值 80% / 90%')) : '缺少总使用率',
      'monitor', '看监控', 15);
    push('mem', '内存', ovTone(memPct), ovPctText(memPct),
      mem.total_human ? (mem.used_human + ' / ' + mem.total_human) : '缺少内存明细，需监控插件',
      'monitor', '看监控', 15);
    push('disk', '磁盘 /', ovTone(diskPct), ovPctText(diskPct),
      root ? (root.used_human + ' / ' + root.total_human) : '未读取到根分区',
      'files/disk-analysis', '查磁盘', 20);
    var loadTone = 'na';
    if (load1 !== null && cores) loadTone = load1 > cores * 2 ? 'fail' : load1 > cores ? 'warn' : 'ok';
    push('load', '负载', loadTone, load1 === null ? '—' : load1.toFixed(2),
      cores ? ('对照 ' + cores + ' 核 · 1 分钟') : '缺少核数', 'monitor', '看监控', 10);

    var svc = ovServiceCheck();
    // 服务异常分成两类去处：插件进程失败去插件管理，告警去告警中心（浮层，不是路由）。
    var svcRoute = 'monitor';
    if (svc.tone === 'fail' || svc.tone === 'warn') {
      svcRoute = pluginCounts().failed > 0 ? 'store/plugins' : '!alerts';
    }
    push('svc', '服务', svc.tone, svc.value, svc.detail, svcRoute, '去处理', 20);

    var cert = ovCertWorst();
    var certTone = 'na', certValue = '未启用';
    if (cert) {
      certTone = cert.expired || cert.days < OV_CERT_FAIL_DAYS ? 'fail'
        : cert.days < OV_CERT_WARN_DAYS ? 'warn' : 'ok';
      certValue = cert.expired ? '已过期' : (cert.days + ' 天');
    } else if (Array.isArray(ov.svc.ssl)) {
      // 证书插件在、只是还没有受管证书：这是「没东西要续」，不是「没数据」。
      certTone = 'ok';
      certValue = '无证书';
    }
    push('cert', '证书', certTone, certValue,
      cert ? (cert.domain + ' 最近到期') : (Array.isArray(ov.svc.ssl) ? '还没有受管证书' : '证书插件未启用'),
      'security/ssl', '看证书', 10);

    var jobs = ovJobsCheck();
    var jobTone = 'na', jobValue = '未启用';
    if (jobs.known) {
      jobTone = jobs.failed > 0 ? 'fail' : jobs.stale > 0 ? 'warn' : 'ok';
      jobValue = jobs.failed > 0 ? (jobs.failed + ' 失败') : jobs.stale > 0 ? (jobs.stale + ' 待修') : '正常';
    }
    push('job', '任务', jobTone, jobValue,
      jobs.failed > 0 ? '上次执行失败，去计划任务看输出'
        : jobs.stale > 0 ? '指向的程序不可用，到点会静默失败' : '计划任务上次执行正常',
      'tasks', '看任务', 10);

    var tone = 'na', scoreSum = 0, weightSum = 0, count = { ok: 0, warn: 0, fail: 0, na: 0 };
    for (var k = 0; k < checks.length; k++) {
      var c = checks[k];
      count[c.tone]++;
      if (c.tone !== 'na') {
        tone = ovWorse(tone, c.tone);
        weightSum += c.weight;
        scoreSum += c.weight * (c.tone === 'ok' ? 1 : c.tone === 'warn' ? 0.6 : 0);
      }
    }
    var score = weightSum > 0 ? Math.round((scoreSum / weightSum) * 100) : null;
    var stateText = (tone === 'fail' || tone === 'warn' || tone === 'ok') ? OV_TONE_TEXT[tone] : '未采集';
    var need = count.fail + count.warn;
    var headline = tone === 'fail' ? (need > 0 ? '有 ' + need + ' 项要处理' : '运行异常')
      : tone === 'warn' ? ('有 ' + need + ' 项建议处理')
      : tone === 'ok' ? '各项检查正常' : '等待采集指标';
    // 一半以上分项没数据时明确说「指标不全」，不让 100 分看起来像全都验过了。
    if (count.na >= 3) headline += '，指标不全';
    return { tone: tone, score: score, stateText: stateText, headline: headline,
      counts: count, checks: checks };
  }

  // 待办：把「需要人动手」的事收成一条清单，每条带直达入口。
  // 顺序 = 严重度（严重 → 警告 → 提示），同级按影响面（磁盘 / 服务 > 证书 / 任务 > 插件更新）。
  function ovTodoItems() {
    var items = [];
    function add(tone, title, detail, route, cta) {
      items.push({ tone: tone, title: title, detail: detail, route: route, cta: cta });
    }
    var alerts = ov.alerts || [];
    var crit = 0, warn = 0;
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].severity === 'critical') crit++;
      else if (alerts[i].severity === 'warning') warn++;
    }
    var counts = pluginCounts();
    if (crit > 0) add('fail', '有 ' + crit + ' 条严重告警待处理', '最近 5 分钟内的严重告警，先看再决定是否忽略', '!alerts', '查看告警');
    else if (warn > 0) add('warn', '有 ' + warn + ' 条告警待确认', '最近 5 分钟内的告警，确认后可不再处理', '!alerts', '查看告警');
    if (counts.failed > 0) add('fail', '有 ' + counts.failed + ' 个插件运行失败', '插件进程退出后不会自愈，去插件管理看日志并重启', 'store/plugins', '去插件管理');

    var sys = ov.sys || {}, disks = Array.isArray(sys.disks) ? sys.disks : [];
    var hot = null;
    for (var d = 0; d < disks.length; d++) {
      var used = ovNum(disks[d] && disks[d].used_percent);
      if (used !== null && used >= OV_DISK_TODO && (!hot || used > hot.used)) hot = { used: used, mount: disks[d].mount || '—' };
    }
    if (hot) add(hot.used >= 90 ? 'fail' : 'warn', '磁盘 ' + hot.mount + ' 快满了',
      '已用 ' + hot.used.toFixed(1) + '%，清理大文件或扩容后再继续写入', 'files/disk-analysis', '查磁盘');

    var cert = ovCertWorst();
    if (cert && (cert.expired || cert.days < OV_CERT_WARN_DAYS)) {
      add(cert.expired || cert.days < OV_CERT_FAIL_DAYS ? 'fail' : 'warn',
        cert.expired ? '证书已过期' : '证书即将过期',
        cert.domain + (cert.expired ? ' 已过期，站点会被浏览器拦' : ' 剩余 ' + cert.days + ' 天，建议现在续期'),
        'security/ssl', cert.expired ? '去重签' : '去续期');
    }

    var jobs = ovJobsCheck();
    if (jobs.failed > 0) add('warn', '有 ' + jobs.failed + ' 个计划任务上次执行失败',
      '最近失败：' + jobs.failedNames.join('、') + '；去计划任务看输出并重试', 'tasks', '看任务');
    if (jobs.stale > 0) add('warn', '有 ' + jobs.stale + ' 个计划任务指向的程序不可用',
      '升级后路径变了，到点会静默失败；去计划任务点「修复路径」', 'tasks', '去修复');

    var memPct = ovNum(sys.memory && sys.memory.used_percent);
    if (memPct !== null && memPct >= 80) add('warn', '内存占用偏高', '已用 ' + memPct.toFixed(1) + '%，继续涨会拖慢响应；去监控看 Top 进程', 'monitor', '看监控');

    var up = ovUpgradable();
    if (up.length) add('info', '有 ' + up.length + ' 个插件可更新',
      '例如 ' + up.slice(0, 2).map(function (x) { return x.name + ' ' + x.from + ' → ' + x.to; }).join('、'),
      'store', '去升级');

    var missing = ovRecommendedMissing();
    if (missing && missing.length) add('info', '推荐插件还没装',
      missing.slice(0, 3).map(function (x) { return x.name; }).join('、') + '：装上后概览与监控才能看到完整数据',
      'store', '去安装');

    if (ov.sysSrc && ov.sysSrc !== 'plugin') add('info', '监控插件未启用，指标不全',
      '内存占比、磁盘明细与网络收发由监控插件提供；当前只有内核基础采样', 'store', '去安装');

    var rank = { fail: 0, warn: 1, info: 2, ok: 3 };
    items.sort(function (a, b) { return rank[a.tone] - rank[b.tone]; });
    return items;
  }

  // 快捷入口：四个高频动作，点击即到（新站点 / 部署 / 日志 / 终端）。
  var OV_ACTIONS = [
    { label: '新建网站', hint: '添加站点、绑域名、开 HTTPS', route: 'sites' },
    { label: '部署应用', hint: '从模板一键装应用', route: 'sites/appdeploy' },
    { label: '查日志', hint: '按来源看实时日志', route: 'monitor/logs' },
    { label: '打开终端', hint: '直接进本机命令行', route: 'terminal' }
  ];

  function paintOvActions(host) {
    if (!host || !host.isConnected) return;
    host.textContent = '';
    for (var i = 0; i < OV_ACTIONS.length; i++) {
      (function (a) {
        var btn = el('button', 'ov-action');
        btn.type = 'button';
        btn.appendChild(el('span', 'ov-action-label', a.label));
        btn.appendChild(el('span', 'ov-action-hint', a.hint));
        btn.title = a.label + '：' + a.hint;
        btn.addEventListener('click', function () { ovGo(a.route); });
        host.appendChild(btn);
      })(OV_ACTIONS[i]);
    }
  }

  function paintOvHero(host) {
    if (!host || !host.isConnected) return;
    var h = ovHealth();
    host.textContent = '';
    host.className = 'ov-hero is-' + h.tone;

    var main = el('div', 'ov-hero-main');
    var score = el('div', 'ov-hero-score');
    score.appendChild(el('span', 'ov-hero-num', h.score === null ? '—' : String(h.score)));
    score.appendChild(el('span', 'ov-hero-unit', h.score === null ? '' : '分'));
    main.appendChild(score);

    var text = el('div', 'ov-hero-text');
    var line = el('div', 'ov-hero-line');
    line.appendChild(ovChip(h.tone, h.stateText, '综合 CPU / 内存 / 磁盘 / 负载 / 服务 / 证书 / 任务 七项'));
    line.appendChild(el('span', 'ov-hero-headline', h.headline));
    text.appendChild(line);
    var parts = ['正常 ' + h.counts.ok];
    if (h.counts.warn) parts.push('注意 ' + h.counts.warn);
    if (h.counts.fail) parts.push('异常 ' + h.counts.fail);
    if (h.counts.na) parts.push('未采集 ' + h.counts.na);
    text.appendChild(el('p', 'ov-caption', '7 项检查：' + parts.join(' · ') + ' · 检查于 ' + ovFmtClock('')));
    main.appendChild(text);

    var tools = el('div', 'ov-hero-tools');
    var first = null;
    for (var i = 0; i < h.checks.length; i++) {
      if (h.checks[i].tone !== 'ok' && h.checks[i].tone !== 'na') { first = h.checks[i]; break; }
    }
    if (first) {
      var go = el('button', 'btn btn-primary ov-hero-go', '去处理 · ' + first.label);
      go.type = 'button';
      go.title = first.detail;
      go.addEventListener('click', function () { ovGo(first.route); });
      tools.appendChild(go);
    } else {
      var again = el('button', 'btn btn-ghost ov-hero-go', '重新检测');
      again.type = 'button';
      again.addEventListener('click', function () { start(); });
      tools.appendChild(again);
    }
    main.appendChild(tools);
    host.appendChild(main);

    var checks = el('div', 'ov-hero-checks');
    for (var c = 0; c < h.checks.length; c++) {
      (function (ck) {
        var chip = el('div', 'ov-check is-' + ck.tone);
        chip.appendChild(el('span', 'dot ' + (ck.tone === 'na' ? '' : ck.tone)));
        chip.appendChild(el('span', 'ov-check-label', ck.label));
        chip.appendChild(el('span', 'ov-check-value', ck.value));
        chip.title = ck.label + '：' + ck.detail;
        chip.setAttribute('aria-label', ck.label + ' ' + ck.value + '，' + ck.detail);
        if (ck.tone === 'fail' || ck.tone === 'warn') {
          chip.className += ' ov-check-link';
          chip.setAttribute('role', 'button');
          chip.tabIndex = 0;
          var jump = function () { ovGo(ck.route); };
          chip.addEventListener('click', jump);
          chip.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); jump(); }
          });
          chip.appendChild(el('span', 'ov-check-go', '›'));
        }
        checks.appendChild(chip);
      })(h.checks[c]);
    }
    host.appendChild(checks);
  }

  function paintOvTodos(host) {
    if (!host || !host.isConnected) return;
    host.textContent = '';
    var items = ovTodoItems();
    var head = el('div', 'panel-head');
    head.appendChild(el('span', 'panel-title', '待办事项'));
    if (items.length) head.appendChild(ovChip(items[0].tone === 'fail' ? 'fail' : items[0].tone === 'warn' ? 'warn' : 'na', items.length + ' 项', '需要你决定或动手的事'));
    host.appendChild(head);

    var body = el('div', 'ov-todo-body');
    if (!items.length) {
      var ok = el('div', 'ov-alert-ok');
      ok.appendChild(el('span', 'dot ok'));
      ok.appendChild(el('span', null, '一切正常，没有需要处理的事'));
      body.appendChild(ok);
      body.appendChild(el('p', 'ov-caption', '磁盘、证书、计划任务、插件与告警都通过检查；建议保持现状，定期回来看一眼。'));
      host.appendChild(body);
      return;
    }
    var shown = items.slice(0, OV_TODO_MAX);
    for (var i = 0; i < shown.length; i++) {
      (function (it) {
        var row = el('div', 'ov-todo is-' + it.tone);
        row.appendChild(el('span', 'dot ' + (it.tone === 'info' ? '' : it.tone)));
        var main = el('div', 'ov-todo-main');
        main.appendChild(el('span', 'ov-todo-title', it.title));
        if (it.detail) main.appendChild(el('span', 'ov-todo-detail', it.detail));
        row.appendChild(main);
        row.appendChild(el('span', 'ov-todo-cta', it.cta + ' ›'));
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.title = it.title + '：' + it.cta;
        var jump = function () { ovGo(it.route); };
        row.addEventListener('click', jump);
        row.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); jump(); }
        });
        body.appendChild(row);
      })(shown[i]);
    }
    if (items.length > shown.length) {
      body.appendChild(el('p', 'ov-caption', '还有 ' + (items.length - shown.length) + ' 项，处理完上面几条后会自动更新'));
    }
    host.appendChild(body);
  }

  // 指标卡数据：插件成功 → 全量；失败 → 内核 metrics 降级（缺内存占比，如实标注）。
  function ovFetchSystem() {
    return writeJson(OV_INVOKE.system, {}).then(function (res) {
      if (res.ok && res.data && res.data.cpu) {
        ov.sysSrc = 'plugin'; ov.sysReason = '';
        ov.sys = res.data;
        ovPushSample();
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
      ovPushSample();
    }, function () {
      ov.sysSrc = 'none'; ov.sysReason = reason; ov.sys = null;
      ovPushSample();
    });
  }

  // 概览待办的两个补充来源（都是一次性拉取，失败只让对应待办缺席）：
  //   · 任务：内核 scheduler 的 last_result + cron 插件的 binary_status；
  //   · 预设：out_of_box 预设判「推荐未装」（可更新直接读 /plugins 的 update_available）。
  function ovLoadJobs() {
    var cron = writeJson(OV_CRON, {}).then(function (res) { return res.ok ? res.data : null; },
      function () { return null; });
    var sched = request(OV_SCHED).then(function (res) { return res.ok ? res.data : null; },
      function () { return null; });
    return Promise.all([cron, sched]).then(function (out) {
      ov.jobs.cron = out[0];
      ov.jobs.sched = out[1];
    });
  }

  function ovLoadPresets() {
    return request(OV_PRESETS).then(function (res) {
      ov.store.presets = res.ok && res.data && Array.isArray(res.data.presets) ? res.data.presets : null;
    }, function () { ov.store.presets = null; });
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

  // 网络卡：monitor 插件才带 network（内核基础指标不含网络）。按主要网卡展示累计收发
  // （除环回，取 rx 最大的一块）；不可用时如实显示「未启用 + 安装入口」，不画 0。
  function ovNetCard(sys) {
    var nets = sys && Array.isArray(sys.network) ? sys.network : [];
    var card = el('section', 'ov-card');
    var head = el('div', 'ov-card-head');
    head.appendChild(el('span', 'ov-card-title', '网络'));
    card.appendChild(head);
    var primary = null, errs = 0, ifaces = 0;
    for (var i = 0; i < nets.length; i++) {
      var n = nets[i] || {};
      if (!n.name || /^lo(?:opback)?\d*$/.test(n.name)) continue;
      ifaces++;
      errs += (ovNum(n.rx_errors) || 0) + (ovNum(n.tx_errors) || 0);
      if (!primary || (ovNum(n.rx_bytes) || 0) > (ovNum(primary.rx_bytes) || 0)) primary = n;
    }
    if (!primary) {
      head.appendChild(ovChip('na', '未启用', '网络收发统计由监控插件采集'));
      var empty = el('div', 'ov-value');
      empty.appendChild(el('span', 'ov-num', '—'));
      card.appendChild(empty);
      var btn = el('button', 'btn btn-ghost ov-card-btn', '去商店装监控插件');
      btn.type = 'button';
      btn.addEventListener('click', function () { ovGo('store'); });
      card.appendChild(btn);
      card.appendChild(el('p', 'ov-caption', '装上「监控」插件后这里是每块网卡的累计收发与错误数'));
      return card;
    }
    head.appendChild(ovChip(errs > 0 ? 'warn' : 'ok', errs > 0 ? ('错误 ' + errs) : '正常',
      errs > 0 ? '收/发错误累计非零，检查网卡与链路' : '未发现网卡收/发错误'));
    var val = el('div', 'ov-net');
    val.appendChild(el('span', 'ov-net-line', '↓ ' + (primary.rx_human || '—')));
    val.appendChild(el('span', 'ov-net-line', '↑ ' + (primary.tx_human || '—')));
    card.appendChild(val);
    card.appendChild(el('p', 'ov-caption', (primary.name || '—') + ' · 累计收发' +
      (ifaces > 1 ? ' · 另有 ' + (ifaces - 1) + ' 块' : '')));
    card.title = '共 ' + ifaces + ' 块网卡，按累计接收量最大的一块展示（可去监控页看逐块明细）';
    return card;
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
        cores ? cores + ' 核 · 采样 ' + (ovNum(cpu.sample_interval_ms) || '—') + ' ms' : '总使用率',
        ovTrend('cpu', '%')),
      ovMetricCard('内存', memPct === null ? '—' : memPct.toFixed(1), '%', ovTone(memPct),
        memPct === null ? '' : (memPct >= 90 ? '过高' : memPct >= 80 ? '偏高' : '正常'),
        memPct === null ? '' : '阈值：≥80% 偏高、≥90% 过高', memPct,
        memPct === null ? '内核指标不含内存占比，需 monitor 插件'
          : (mem.used_human || '—') + ' / ' + (mem.total_human || '—'),
        ovTrend('mem', '%')),
      ovMetricCard('磁盘 /', diskPct === null ? '—' : diskPct.toFixed(1), '%', ovTone(diskPct),
        diskPct === null ? '' : (diskPct >= 90 ? '过高' : diskPct >= 80 ? '偏高' : '正常'),
        diskPct === null ? '' : '阈值：≥80% 偏高、≥90% 过高', diskPct,
        root ? (root.used_human || '—') + ' / ' + (root.total_human || '—')
          : (src === 'kernel' && ovNum(sys && sys.disk_used_kib) !== null
            ? '内核汇总 ' + ((sys.disk_used_kib / 1048576).toFixed(1)) + ' / ' +
              ((sys.disk_total_kib / 1048576).toFixed(1)) + ' GiB'
            : '未读取到根分区'),
        ovTrend('disk', '%')),
      ovMetricCard('负载', load1 === null ? '—' : load1.toFixed(2), '', loadTone,
        load1 === null || !cores ? '' : (load1 > cores * 2 ? '过高' : load1 > cores ? '偏高' : '正常'),
        load1 === null ? '' : '对照核数：1× 核数内正常、1–2× 偏高、>2× 过高',
        load1 !== null && cores ? (load1 / cores) * 100 : null,
        '5 分钟 ' + (ovNum(load.load5) === null ? '—' : load.load5.toFixed(2)) +
        ' · 15 分钟 ' + (ovNum(load.load15) === null ? '—' : load.load15.toFixed(2)))
    ];
    cards.push(ovNetCard(sys));
    for (var c = 0; c < cards.length; c++) host.appendChild(cards[c]);
    if (src === 'kernel' || src === 'none') {
      var note = document.getElementById('kore-ov-note');
      if (note && note.isConnected) {
        note.hidden = false;
        // 不把 HTTP 404 / 插件内部原因摆在正文：给「现在能用什么 + 下一步装什么」。
        note.textContent = '监控插件还没装：指标暂用内核采样（不含内存占比）。装好「监控」插件后这里会完整显示。';
        if (ov.sysReason) note.title = '检测结果：' + ov.sysReason;
        if (!note.querySelector('.ov-note-btn')) {
          var installBtn = el('button', 'btn btn-ghost ov-note-btn', '去商店装监控插件');
          installBtn.type = 'button';
          installBtn.style.marginLeft = 'var(--kore-space-2)';
          installBtn.style.minHeight = 'var(--kore-touch)';
          installBtn.addEventListener('click', function () {
            if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('store');
          });
          note.appendChild(installBtn);
        }
      }
    }
  }

  // route 给了就把整行做成入口：概览上看到「未启用」时，点一下直接到能处理它的页面，
  // 不用先想「这在哪个菜单里」（USABILITY 原则 4「空状态给下一步按钮」的概览版）。
  function ovCountRow(label, toneName, valueText, route) {
    var rowEl = el('div', 'ov-row' + (route ? ' ov-row-link' : ''));
    rowEl.appendChild(el('span', 'ov-row-label', label));
    var val = el('span', 'ov-row-value');
    val.appendChild(el('span', 'dot ' + (toneName === 'na' ? '' : toneName)));
    val.appendChild(el('span', 'ov-row-num', valueText));
    rowEl.appendChild(val);
    if (route) {
      rowEl.appendChild(el('span', 'ov-row-go', '\u203a'));
      rowEl.setAttribute('role', 'button');
      rowEl.setAttribute('tabindex', '0');
      rowEl.title = '打开' + label + '管理';
      var jump = function () {
        if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate(route);
      };
      rowEl.addEventListener('click', jump);
      rowEl.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); jump(); }
      });
    }
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
      sites === null ? '未启用' : String(sites.length), 'sites'));
    svcBody.appendChild(ovCountRow('证书', certs === null ? 'na' : (certs.length ? 'ok' : 'na'),
      certs === null ? '未启用' : String(certs.length), 'ssl'));
    var db = ov.svc.db;
    svcBody.appendChild(ovCountRow('数据库', db ? 'ok' : 'na', db
      ? (String(db.id) === 'mariadb' ? 'MariaDB 运行中' : 'MySQL 运行中')
      : '未检测到', 'db'));
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

  // 告警中心是浮层组件（KoreAlerts 导出 open/close/probe/refresh，没有 render），
  // 不能走 ensureModule 的「视图契约」（那里要求导出 render，会直接判失败）；
  // 这里只认 open()：已就绪直接开，脚本由主壳首屏后懒探测时在途就等它，
  // 都没有才自己注入一次——注入前先查同源 script 在途，避免二次执行出两套浮层。
  function ovAlertError(err) {
    state.notice = '告警中心不可用：' + (err && err.message ? err.message : '模块加载失败');
    var host = document.getElementById('kore-overview') || document.getElementById('view');
    if (!host || !host.isConnected) return;
    host.parentNode.insertBefore(noticeBar(state.notice), host);
  }

  function openAlertCenter() {
    if (window.KoreAlerts && typeof window.KoreAlerts.open === 'function') { window.KoreAlerts.open(); return; }
    if (document.querySelector('script[src$="/assets/alerts.js"]')) {
      var tries = 0;
      (function waitAlert() {
        if (window.KoreAlerts && typeof window.KoreAlerts.open === 'function') { window.KoreAlerts.open(); return; }
        if (++tries > 30) { ovAlertError(new Error('脚本已加载但未导出 open()')); return; }
        window.setTimeout(waitAlert, 100);
      })();
      return;
    }
    var s = document.createElement('script');
    s.src = '/assets/alerts.js';
    s.async = true;
    s.onload = function () {
      if (window.KoreAlerts && typeof window.KoreAlerts.open === 'function') window.KoreAlerts.open();
      else ovAlertError(new Error('告警中心脚本已加载但未导出 open()'));
    };
    s.onerror = function () { ovAlertError(new Error('告警中心脚本加载失败')); };
    document.head.appendChild(s);
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

    // ① 健康状态：先回答「现在怎么样」，异常项直接给入口。
    var hero = el('section', 'ov-hero is-na');
    hero.id = 'kore-ov-hero';
    hero.setAttribute('role', 'status');
    root.appendChild(hero);
    paintOvHero(hero);

    // ② 快捷入口：高频动作一步到（放第二屏首位，手机上不用翻菜单）。
    var actions = el('div', 'ov-actions');
    actions.id = 'kore-ov-actions';
    root.appendChild(actions);
    paintOvActions(actions);

    // ③ 待办：回答「有什么要处理」；为空时明说一切正常，不留白。
    var todoPanel = el('section', 'panel ov-todo-panel');
    todoPanel.id = 'kore-ov-todos';
    root.appendChild(todoPanel);
    paintOvTodos(todoPanel);

    // ④ 关键指标：CPU / 内存 / 磁盘 / 负载 / 网络，带迷你趋势与阈值提示。
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

  // 重画「依赖多来源」的三块：任一来源回填后都重画一次，先到先显示，不互相等待。
  function repaintOvSummary() {
    paintOvHero(document.getElementById('kore-ov-hero'));
    paintOvTodos(document.getElementById('kore-ov-todos'));
  }

  // 数据装载：每个来源独立降级，任何一个失败不拖垮整页；回填后原位重绘对应区块。
  // 全部是一次性拉取（进入视图 / 点「重新检测」触发），没有任何定时器（G-19）。
  function loadOverview() {
    ovFetchSystem().then(function () {
      paintOvMetrics(document.getElementById('kore-ov-metrics'));
      repaintOvSummary();
    });
    ovLoadServices().then(function () {
      paintOvStatus(document.getElementById('kore-ov-status'));
      repaintOvSummary();
    });
    ovLoadJobs().then(repaintOvSummary);
    ovLoadPresets().then(repaintOvSummary);
    ovCollectAlerts().then(repaintOvSummary);
  }

  function renderDashboardView(box) {
    viewNotice(box);
    var root = el('div', 'ov');
    root.id = 'kore-overview';
    // 先挂进文档再建内容：各 paint* 都以 isConnected 判活（防离屏重绘写进废 DOM），
    // 反过来的建法会让首帧的静态块（快捷入口 / 告警）被自己跳过。
    box.appendChild(root);
    buildOverviewInto(root);
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

  // 判据与 PluginBridge 建帧条件严格一致（enabled + web.entry），不另立一套口径。
  /* 一级导航 = 10 项「用户任务」，插件视图收进所属任务的 tab（子视图）。
     收敛口径：一级项回答「用户要干什么」，插件只是能力的实现方式，不该一个个占一级菜单。
     之前 8 项硬编码 + shell.mount() 补 16 项 = 24 项，导航成了插件清单的线性投影；
     现在一级清单只在这里声明一处，漏项在 review 阶段就暴露，不再有「免得漏项」的兜底注入。
     子视图一律懒加载：首次点进该 tab 才注入脚本，首屏请求数/体积与 tab 数无关（FRONTEND §7）。

     形状约束（G-33 A6 / A5 会静态解析本注册表，改形状前先读 scripts/usability-check.sh）：
       · 块内 `id:` 只允许是一级项 → 子视图用 `sub:`，否则 A6 把子视图也算进一级菜单；
       · 块内保留 app.js 自有视图的 /assets/*.js 路径 → A5 据此定位视图文件检查空状态。 */
  // 壳内置模块的子视图定义（[全局名, 脚本, i18n 键, 中文兜底]）。放块外：它们不是一级项。
  var SHELL_VIEWS = {
    db: ['KoreDb', '/assets/db.js', 'nav.db', '数据库'],
    redis: ['KoreRedis', '/assets/redis.js', 'nav.redis', 'Redis'],
    backup: ['KoreBackup', '/assets/backups.js', 'nav.backup', '备份'],
    logs: ['KoreLogs', '/assets/logs.js', 'nav.logs', '日志'],
    process: ['KoreProcess', '/assets/process.js', 'nav.process', '进程'],
    firewall: ['KoreFirewall', '/assets/firewall.js', 'nav.firewall', '防火墙'],
    waf: ['KoreWaf', '/assets/waf.js', 'nav.waf', 'Web 防火墙'],
    sshguard: ['KoreSshGuard', '/assets/sshguard.js', 'nav.sshguard', 'SSH 防护'],
    dns: ['KoreDns', '/assets/dns.js', 'nav.dns', 'DNS 解析'],
    ssl: ['KoreSsl', '/assets/ssl.js', 'nav.ssl', '证书'],
    integrity: ['KoreIntegrity', '/assets/integrity.js', 'nav.integrity', '完整性'],
    discover: ['KoreDiscover', '/assets/discover.js', 'nav.discover', '服务发现'],
    runtimes: ['KoreRuntimes', '/assets/runtimes.js', 'nav.runtimes', '运行环境'],
    appdeploy: ['KoreAppDeploy', '/assets/appdeploy.js', 'nav.appdeploy', '应用部署'],
    container: ['KoreContainer', '/assets/container.js', 'nav.container', '容器'],
    terminal: ['KoreTerminal', '/assets/terminal.js', 'nav.terminal', '终端'],
    // R22 新功能：统一在此登记懒加载子视图（一级菜单仍 10 项，G-33 A6）。
    // 每项 = [全局名, 脚本, i18n 键, 中文兜底]；视图文件由各卡交付，懒加载不进首屏。
    health: ['KoreHealth', '/assets/health.js', 'nav.health', '系统体检'],
    report: ['KoreReport', '/assets/report.js', 'nav.report', '运行报告'],
    topology: ['KoreTopology', '/assets/topology.js', 'nav.topology', '服务拓扑'],
    calendar: ['KoreCalendar', '/assets/calendar.js', 'nav.calendar', '运维日历'],
    batch: ['KoreBatch', '/assets/batch.js', 'nav.batch', '批量操作'],
    snapshot: ['KoreSnapshot', '/assets/snapshot.js', 'nav.snapshot', '配置快照'],
    migrate: ['KoreMigrate', '/assets/migrate.js', 'nav.migrate', '配置迁移'],
    'site-migrate': ['KoreSiteMigrate', '/assets/site-migrate.js', 'nav.siteMigrate', '站点迁移'],
    webhook: ['KoreWebhook', '/assets/webhook.js', 'nav.webhook', '通知通道'],
    // 账户与安全中心（用户中心）：账户状态总览 / 会话管理 / 登录记录 / 快捷动作，
    // 挂在「设置」hub 的第二个 tab（默认 tab 仍是常规设置，A7 主流程不变）。
    'user-center': ['KoreUserCenter', '/assets/user-center.js', 'nav.userCenter', '账户中心'],
    // R23 第二批 8 个新视图：统一登记懒加载 sub（一级菜单仍 10 项，G-33 A6）。
    // 每项 = [全局名, 脚本, i18n 键, 中文兜底]；带连字符的键必须加引号（否则被解析成减法表达式）。
    // 视图文件由各卡交付，懒加载不进首屏六件套、不计首屏 gzip 预算。
    'alert-rules': ['KoreAlertRules', '/assets/alert-rules.js', 'nav.alertRules', '告警规则'],
    'disk-analysis': ['KoreDiskAnalysis', '/assets/disk-analysis.js', 'nav.diskAnalysis', '磁盘分析'],
    'fault-drill': ['KoreFaultDrill', '/assets/fault-drill.js', 'nav.faultdrill', '故障演练'],
    macros: ['KoreMacros', '/assets/macros.js', 'nav.macros', '操作宏'],
    'cert-lifecycle': ['KoreCertLifecycle', '/assets/cert-lifecycle.js', 'nav.certLifecycle', '证书看板'],
    'config-drift': ['KoreConfigDrift', '/assets/config-drift.js', 'nav.configDrift', '配置漂移'],
    slowquery: ['KoreSlowQuery', '/assets/slow-query.js', 'nav.slowquery', '慢查询分析'],
    'log-alerts': ['KoreLogAlerts', '/assets/log-alerts.js', 'nav.logAlerts', '日志告警'],
    // settings / tasks 原为单视图，改为 hub 后在此保留原模块，避免把原「设置 / 计划任务」弄丢。
    settings: ['KoreSettings', '/assets/settings.js', 'nav.settings', '设置'],
    tasks: ['KoreTasks', '/assets/tasks.js', 'nav.tasks', '计划任务']
  };

  var HUB_DEFS = [
    { id: 'dashboard', label: '概览', render: renderDashboardView },
    {
      id: 'sites', label: '网站', views: [
        { sub: 'sites', label: '网站', labelKey: 'nav.sites', render: moduleView('KoreSites', '/assets/sites.js', '网站') },
        { sub: 'site-migrate' },
        { sub: 'runtimes' },
        { sub: 'appdeploy' },
        { sub: 'container' },
        { sub: 'batch' }
      ]
    },
    {
      id: 'db', label: '数据库', views: [{ sub: 'db' }, { sub: 'redis' }, { sub: 'slowquery' }]
    },
    {
      id: 'files', label: '文件', views: [
        { sub: 'files', label: '文件管理', labelKey: 'nav.files', render: moduleView('KoreFiles', '/assets/files.js', '文件管理') },
        { sub: 'backup' },
        { sub: 'disk-analysis' }
      ]
    },
    {
      // 「已装插件」不再是独立一级菜单：商店自带「已安装 / 可更新」筛选，
      // 插件管理表（版本 / 深度 / 运行方式 / 状态 / 批量升级）作为商店第二个 tab。
      id: 'store', label: '软件商店', views: [
        { sub: 'store', label: '应用商店', labelKey: 'nav.store', render: moduleView('KoreStore', '/assets/store.js', '软件商店') },
        { sub: 'plugins', label: '插件管理', labelKey: 'nav.store.plugins', render: renderPluginsView }
      ]
    },
    {
      id: 'monitor', label: '监控', views: [
        { sub: 'monitor', label: '监控', labelKey: 'nav.monitor', render: moduleView('KoreMonitor', '/assets/monitor.js', '监控') },
        { sub: 'health' },
        { sub: 'report' },
        { sub: 'topology' },
        { sub: 'logs' },
        { sub: 'process' },
        { sub: 'alert-rules' },
        { sub: 'fault-drill' },
        { sub: 'log-alerts' }
      ]
    },
    // R22：计划任务从单视图改为 hub（原 KoreTasks 通过 SHELL_VIEWS.tasks 保留），新增运维日历 tab。
    // R23：操作宏挂计划任务（自动化/效率工具，与定时任务同一心智模型）。
    { id: 'tasks', label: '计划任务', views: [{ sub: 'tasks' }, { sub: 'calendar' }, { sub: 'macros' }] },
    {
      // 「安全」收的是「对外暴露面的防守」：网络边界（防火墙/WAF/DNS/SSH）、信任链（证书）、
      // 资产完整性（完整性校验）、本机暴露面盘点（服务发现）。同一心智模型：
      // 谁在敲门、门锁没锁、锁还灵不灵——服务发现的产出正是「这台机器上有什么在监听」，是安全视图的输入。
      id: 'security', label: '安全', views: [
        { sub: 'firewall' }, { sub: 'waf' }, { sub: 'sshguard' }, { sub: 'dns' },
        { sub: 'ssl' }, { sub: 'integrity' }, { sub: 'discover' },
        { sub: 'cert-lifecycle' }
      ]
    },
    { id: 'terminal', label: '终端', views: [{ sub: 'terminal' }] },
    // R22：设置从单视图改为 hub（原 KoreSettings 通过 SHELL_VIEWS.settings 保留），新增快照/迁移/通知三个 tab。
    // R23：配置漂移挂设置（与快照/迁移同属配置治理闭环）。
    { id: 'settings', label: '设置', views: [
      { sub: 'settings' }, { sub: 'user-center' }, { sub: 'snapshot' }, { sub: 'migrate' },
      { sub: 'webhook' }, { sub: 'config-drift' }
    ] }
  ];

  // 把注册表展开成 shell 要的 routes：单子视图的一级项直接渲染（不显示只有一格的 tab 条）。
  function shellRoutes() {
    var K = window.KoreShell;
    function resolve(v) {
      if (typeof v.render === 'function') return v.render;
      var def = SHELL_VIEWS[v.sub];
      return K.view(def[0], def[1], def[2], def[3]);
    }
    var out = [];
    for (var i = 0; i < HUB_DEFS.length; i++) {
      var def = HUB_DEFS[i];
      if (!def.views || !def.views.length) {
        out.push({ id: def.id, label: def.label, render: def.render });
        continue;
      }
      if (def.views.length === 1) {
        out.push({ id: def.id, label: def.label, render: resolve(def.views[0]) });
        continue;
      }
      var children = [];
      for (var j = 0; j < def.views.length; j++) {
        var v = def.views[j], sv = SHELL_VIEWS[v.sub];
        children.push({
          id: v.sub,
          label: v.label || (sv ? sv[3] : v.sub),
          labelKey: v.labelKey || (sv ? sv[2] : ''),
          render: resolve(v)
        });
      }
      out.push({ id: def.id, label: def.label, children: children });
    }
    return out;
  }

  function renderDashboard() {
    if (!window.KoreShell || typeof window.KoreShell.mount !== 'function') {
      renderLegacyDashboard(); // 壳缺席：退回单页，面板不因缺一个脚本而白屏
      return;
    }
    // 首次登录挂壳；后续数据刷新只重绘当前视图，不重建导航（否则丢失视图与滚动位置）。
    var mounted = !!document.getElementById('view');
    if (!mounted) window.KoreShell.mount(shellRoutes());
    else window.KoreShell.navigate(window.KoreShell.current() || 'dashboard');

    var top = document.getElementById('kore-topbar');
    if (top) {
      top.textContent = '';
      top.appendChild(renderTopbar(false));
    }
    // 非阻断提示挂载：重绘只换视图内容，横幅按状态补挂一次（不重复、不挡操作）。
    mountPasswordHint();
  }

  // 把改密提示挂到主内容区顶部；已关闭或标志为 false 时确保不残留。
  function mountPasswordHint() {
    var old = document.getElementById('kore-password-hint');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!state.passwordHint || state.passwordHintDismissed) return;
    var content = document.getElementById('view') || document.querySelector('.content');
    if (content && content.insertBefore) {
      content.insertBefore(passwordHintBar(), content.firstChild);
    }
  }

  // 视图模块（如 settings.js 退出登录）显式回到站点根 = 归位意图：
  // 鉴权状态只有本文件持有，故由这里重新探测，而不是让视图模块自己猜会话。
  if (window.addEventListener) {
    window.addEventListener('kore:root', function () { resetAndStart(); });
  }

  // 壳缺席降级单页用的入口：把「系统信息 + 插件表 + 插件 UI 面板」整块按需注入同一容器。
  function loadPluginsViewInto(content) {
    ensureModule('/assets/plugins-view.js', 'KorePluginsView').then(function (mod) {
      if (typeof mod.renderLegacy === 'function') mod.renderLegacy(content);
    }, function (err) {
      content.appendChild(el('div', 'stub', '插件管理不可用：' + errText(err)));
    });
  }

  function renderLegacyDashboard() {
    var root = el('div');
    root.appendChild(renderTopbar(true));
    var content = el('main', 'content');
    viewNotice(content);
    // 插件管理子系统（系统信息卡 / 插件表 / 插件 UI 面板）按需注入，壳缺席时也照样加载，
    // 降级单页不因此少一块内容；渲染顺序与重构前一致。
    loadPluginsViewInto(content);
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
      // 首屏探测响应头带提示标志才提示；登录失败 5 次锁定等状态与本提示无关。
      state.passwordHint = !!info.res.passwordHint;
      state.passwordHintDismissed = false;
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
  // 懒加载视图的最小上下文：首屏不带的模块（如 plugins-view.js）通过它复用主壳的
  // 请求 / CSRF / 状态 / 渲染构件，不再各自复制一套（口径分裂比体积更贵的债）。
  window.KoreCtx = {
    el: el, fmtInt: fmtInt, readCookie: readCookie, errText: errText,
    request: request, describeError: describeError, failureOf: failureOf,
    failureReason: failureReason, ensureCsrf: ensureCsrf, writeJson: writeJson,
    statusTag: statusTag, row: row, panel: panel, emptyState: emptyState,
    replaceNode: replaceNode, noticeBar: noticeBar, viewNotice: viewNotice,
    ensureModule: ensureModule,
    renderLogin: renderLogin, renderDashboard: renderDashboard,
    loadDashboard: loadDashboard, refreshPluginsView: refreshPluginsView,
    buildOverviewInto: buildOverviewInto, pluginCounts: pluginCounts,
    residentText: residentText, humanWarnings: humanWarnings,
    state: state, ENDPOINTS: ENDPOINTS, REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
    upgradeBatch: upgradeBatch
  };

  window.KoreUI = window.KoreUI || {};
  window.KoreUI.rootErrorHint = rootErrorHint;
  // 错误码分流入口：视图模块统一走这里，避免各自复制一套 code → 文案判断。
  window.KoreUI.failureOf = failureOf;
  window.KoreUI.failureReason = failureReason;
  // 统一文案入口（AGENTS.md §7 ④）：错误句 / 错误块 / 空态块，视图模块只调这三个。
  window.KoreUI.sentence = sentence;
  window.KoreUI.errorText = errorText;
  window.KoreUI.errorBlock = errorBlock;
  window.KoreUI.emptyBlock = emptyBlock;

  start();
})();
