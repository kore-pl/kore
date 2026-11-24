/* kore 主壳 · 操作宏（web/macros.js）——纯增量新功能，零框架 / 零 CDN / 无外链。
   入口 window.KoreMacros.render(container)，返回 { destroy() }；由 shell 在「计划任务」hub 的
   「操作宏」tab 懒加载，不进首屏六件套、不计首屏 gzip 预算。

   定位：把用户跨视图的一组常用操作（如 建站点 → 绑 SSL → 设伪静态）录成宏，命名保存，一键回放。
   录制只在【主壳视图层】拦截 fetch 里的 invoke 请求，回放复用同一个 invoke 契约逐条执行；
   内核零业务、不新增任何 API、不 import 插件（G-13 薄壳红线）。

   invoke 契约实读自 web/batch.js:114 / web/sites.js:43 / web/ssl.js:64：
     POST /api/v1/invoke/<plugin>/<method>  +  X-Kore-CSRF 双提交，body = JSON(params)。

   数据形状（显式，localStorage key = kore.macros.v1；G-24：字段与类型逐一列明，无 object/any 逃逸）：
     {
       version: number,                      // 固定 1
       macros: [{                            // 宏定义
         id: string,                         // m_<毫秒>_<随机>
         name: string,                       // 用户命名
         createdAt: string,                  // ISO 时间
         updatedAt: string,                  // ISO 时间
         onFail: 'stop' | 'continue',        // 单步失败策略
         steps: [{                           // 步骤（按录制顺序）
           plugin: string,                   // 插件 id，如 site
           method: string,                   // 方法限定名，如 site.list
           params: object,                   // 入参：string/number/boolean/数组/对象；敏感字段值为 null
           redacted: boolean                // 是否含已脱敏字段（回放时跳过，绝不发 ***）
         }],
         lastRun: null | {
           at: string, success: boolean, total: number, ok: number, fail: number
         }
       }],
       history: [{                           // 执行历史（最多 30 条）
         id: string, macroId: string, macroName: string, at: string,
         success: boolean, total: number, ok: number, fail: number, aborted: boolean,
         results: [{ plugin: string, method: string, ok: boolean, skipped: boolean, error: string }]
       }]
     }

   G-30 硬红线：录制时字段名匹配 password/token/secret/key（含 passwd/pwd/apikey/credential/
   privatekey/pem/authorization）的参数一律不记录真实值——置 null 并标 redacted；回放时对
   redacted 步骤直接跳过，绝不把占位符当真值发出去。 */

(function () {
  'use strict';

  var CSS = '' +
    '.macros{color:var(--kore-text-1)}' +
    '.macros .mac-head{margin-bottom:12px}' +
    '.macros .mac-title{margin:0 0 4px;font-size:var(--kore-font-18,18px);font-weight:600}' +
    '.macros .mac-sub{margin:0;color:var(--kore-text-3);font-size:var(--kore-font-13,13px);line-height:1.6}' +
    '.macros .mac-record{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px;border:1px solid var(--kore-border-1);border-radius:6px;background:var(--kore-bg-1);margin:12px 0}' +
    '.macros .mac-record.is-on{border-color:var(--kore-danger,#d9534f);background:rgba(217,83,79,.06)}' +
    '.macros .mac-rec-dot{width:9px;height:9px;border-radius:50%;background:var(--kore-danger,#d9534f);flex:0 0 auto}' +
    '.macros .mac-rec-text{flex:1 1 220px;color:var(--kore-text-2);font-size:var(--kore-font-13,13px);line-height:1.6}' +
    '.macros .mac-btn{min-height:36px;padding:0 14px;border:1px solid var(--kore-border-1);border-radius:4px;background:var(--kore-bg-2);color:var(--kore-text-1);cursor:pointer;font-size:var(--kore-font-13,13px)}' +
    '.macros .mac-btn:hover:not([disabled]){border-color:var(--kore-accent,var(--kore-primary,#4a90e2))}' +
    '.macros .mac-btn[disabled]{opacity:.5;cursor:not-allowed}' +
    '.macros .mac-btn.is-primary{background:var(--kore-accent,var(--kore-primary,#4a90e2));color:#fff;border-color:transparent}' +
    '.macros .mac-btn.is-danger{background:var(--kore-danger,#d9534f);color:#fff;border-color:transparent}' +
    '.macros .mac-btn.is-min{min-height:30px;padding:0 10px;font-size:var(--kore-font-12,12px)}' +
    '.macros .mac-status{min-height:20px;margin:8px 0;font-size:var(--kore-font-13,13px)}' +
    '.macros .mac-status.is-ok{color:var(--kore-success,#2e7d32)}' +
    '.macros .mac-status.is-fail{color:var(--kore-danger,#d9534f)}' +
    '.macros .mac-list{display:flex;flex-direction:column;gap:10px}' +
    '.macros .mac-card{border:1px solid var(--kore-border-1);border-radius:6px;padding:12px 14px;background:var(--kore-bg-1)}' +
    '.macros .mac-card-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center}' +
    '.macros .mac-name{flex:1 1 200px;font-size:var(--kore-font-15,15px);font-weight:600;word-break:break-all}' +
    '.macros .mac-meta{color:var(--kore-text-3);font-size:var(--kore-font-12,12px)}' +
    '.macros .mac-badge{flex:0 0 auto;padding:1px 8px;border-radius:999px;font-size:var(--kore-font-12,12px)}' +
    '.macros .mac-badge.is-ok{color:var(--kore-success,#2e7d32);background:rgba(46,125,50,.12)}' +
    '.macros .mac-badge.is-fail{color:var(--kore-danger,#d9534f);background:rgba(217,83,79,.12)}' +
    '.macros .mac-badge.is-none{color:var(--kore-text-3);background:var(--kore-bg-2)}' +
    '.macros .mac-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}' +
    '.macros .mac-steps{display:flex;flex-direction:column;gap:4px;margin:10px 0}' +
    '.macros .mac-step{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-height:38px;padding:6px 10px;border:1px solid var(--kore-border-2);border-radius:4px;font-size:var(--kore-font-13,13px)}' +
    '.macros .mac-step-no{flex:0 0 auto;color:var(--kore-text-3);font-size:var(--kore-font-12,12px)}' +
    '.macros .mac-step-name{flex:1 1 200px;word-break:break-all}' +
    '.macros .mac-step-red{color:var(--kore-danger,#d9534f);font-size:var(--kore-font-12,12px)}' +
    '.macros .mac-empty{padding:22px;text-align:center;color:var(--kore-text-3);font-size:var(--kore-font-13,13px);line-height:1.8;border:1px dashed var(--kore-border-1);border-radius:6px}' +
    '.macros .mac-field{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0;font-size:var(--kore-font-13,13px)}' +
    '.macros .mac-input{min-height:36px;padding:0 10px;border:1px solid var(--kore-border-1);border-radius:4px;background:var(--kore-bg-1);color:var(--kore-text-1);flex:1 1 220px;font-size:var(--kore-font-13,13px)}' +
    '.macros .mac-radio{display:inline-flex;align-items:center;gap:5px;min-height:36px;margin-right:12px;cursor:pointer}' +
    '.macros .mac-radio input{width:16px;height:16px;min-width:16px;min-height:16px}' +
    '.macros .mac-results{display:flex;flex-direction:column;gap:4px;margin:10px 0}' +
    '.macros .mac-result{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--kore-border-1);border-radius:4px;font-size:var(--kore-font-13,13px)}' +
    '.macros .mac-result.is-ok{border-left:3px solid var(--kore-success,#2e7d32)}' +
    '.macros .mac-result.is-fail{border-left:3px solid var(--kore-danger,#d9534f)}' +
    '.macros .mac-result.is-skip{border-left:3px solid var(--kore-text-3)}' +
    '.macros .mac-progress{height:8px;border-radius:4px;background:var(--kore-bg-2);overflow:hidden;margin:8px 0}' +
    '.macros .mac-progress-fill{height:100%;background:var(--kore-accent,var(--kore-primary,#4a90e2));transition:width .2s}' +
    '.macros .mac-hist{margin-top:16px}' +
    '.macros .mac-hist-item{padding:8px 10px;border-bottom:1px solid var(--kore-border-2);font-size:var(--kore-font-12,12px);line-height:1.6}' +
    '.macros .mac-confirm{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;padding:8px 10px;border:1px solid var(--kore-danger,#d9534f);border-radius:4px;color:var(--kore-danger,#d9534f);font-size:var(--kore-font-13,13px)}' +
    '@media (max-width:639px){' +
      '.macros .mac-btn{min-height:44px;flex:1 1 auto}' +
      '.macros .mac-btn.is-min{min-height:44px}' +
      '.macros .mac-input{min-height:44px;flex:1 1 100%}' +
      '.macros .mac-radio{min-height:44px}' +
      '.macros .mac-radio input{width:20px;height:20px;min-width:20px;min-height:20px}' +
      '.macros .mac-card{padding:12px}' +
      '.macros .mac-step{min-height:44px}' +
      '.macros .mac-actions .mac-btn{flex:1 1 44%}' +
    '}';

  var LS_KEY = 'kore.macros.v1';
  var HISTORY_MAX = 30;
  var METHOD_RE = /^\/api\/v1\/invoke\/([^/]+)\/([^/?]+)/;

  // G-30：字段名匹配即脱敏（大小写不敏感）。password/token/secret/key 四类必匹配，
  // 另外覆盖常见的 passwd/pwd/apikey/api_key/credential/privatekey/private_key/pem/authorization。
  var SENSITIVE_FIELD_RE = /(pass(word|wd)?|pwd|token|secret|key|apikey|api_key|credential|privatekey|private_key|pem|authorization)/i;

  // 方法名 → 中文标签（未命中回退原始限定名，不臆造能力）
  var METHOD_LABEL = {
    'site.list': '列出站点', 'site.get': '查看站点', 'site.status': '站点状态',
    'site.create': '新建站点', 'site.delete': '删除站点', 'site.enable': '启用站点',
    'site.disable': '停用站点', 'site.clone': '克隆站点', 'site.config.get': '读取站点配置',
    'site.config.set': '设置站点配置', 'site.traffic': '查看流量',
    'site.setPassword': '设置访问口令', 'site.clearPassword': '关闭访问口令',
    'ssl.list': '列出证书', 'ssl.expiring': '即将到期证书', 'ssl.verify': '校验证书',
    'ssl.import': '导入证书', 'ssl.selfsign': '自签证书', 'ssl.renew': '续期证书',
    'ssl.renew.set': '设置自动续期', 'ssl.https.status': 'HTTPS 状态',
    'ssl.acme.status': 'ACME 状态', 'ssl.acme.issue': 'ACME 签发',
    'ssl.acme.auto': '自动 ACME', 'ssl.acme.builtin.status': '内置 ACME 状态',
    'ssl.acme.builtin.issue': '内置 ACME 签发'
  };

  // 模块级状态：视图 destroy 后仍在，保证用户切到别的页面录制期间不丢步骤。
  var recordSession = null;   // { active, steps, startedAt }
  var nativeFetch = null;     // 原始 fetch 引用，避免回放/透传被自己的 hook 干扰

  function ensureCss() {
    if (document.getElementById('kore-macros-css')) return;
    var s = document.createElement('style');
    s.id = 'kore-macros-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function tr(key, fallback, params) {
    var i18n = window.KoreI18n;
    var out = fallback;
    if (i18n && typeof i18n.t === 'function') {
      var hit = i18n.t(key);
      if (hit && hit !== key) out = hit;
    }
    if (params) {
      out = String(out).replace(/\{(\w+)\}/g, function (m, k) {
        return params[k] !== undefined ? String(params[k]) : m;
      });
    }
    return out;
  }
  function errText(err) {
    var text = err && err.message ? String(err.message) : '未知错误';
    if (err && err.code && text.indexOf(err.code) < 0) text = err.code + '：' + text;
    return text;
  }
  function stamp(iso) {
    if (!iso) return '从未执行';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '从未执行';
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function stepLabel(step) {
    return METHOD_LABEL[step.method] || step.method;
  }
  function uid(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  }

  // ---------- 持久化（localStorage：纯个人偏好，零后端、零 state 目录写入）----------
  function emptyData() { return { version: 1, macros: [], history: [] }; }

  function load() {
    try {
      var raw = window.localStorage.getItem(LS_KEY);
      if (!raw) return emptyData();
      var data = JSON.parse(raw);
      if (!data || data.version !== 1 || !Array.isArray(data.macros) || !Array.isArray(data.history)) {
        return emptyData();
      }
      return data;
    } catch (e) {
      return emptyData();
    }
  }

  function save(data) {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- G-30 脱敏：字段名匹配即不记录真实值 ----------
  function sanitizeParams(params) {
    var out = {};
    var redacted = false;
    var src = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (SENSITIVE_FIELD_RE.test(k)) {
        // 口令/密钥/令牌类：置空，不落盘；redacted 标记让回放阶段直接跳过。
        out[k] = null;
        redacted = true;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        var sub = sanitizeParams(v);
        out[k] = sub.params;
        if (sub.redacted) redacted = true;
      } else {
        out[k] = v;
      }
    });
    return { params: out, redacted: redacted };
  }

  // ---------- fetch 拦截（录制）----------
  function installFetchHook() {
    if (nativeFetch) return;
    nativeFetch = window.fetch.bind(window);
    window.fetch = function (url, init) {
      if (recordSession && recordSession.active) {
        var step = capture(url, init);
        if (step) recordSession.steps.push(step);
      }
      return nativeFetch(url, init);
    };
  }

  function capture(url, init) {
    var u = typeof url === 'string' ? url : (url && url.url ? String(url.url) : '');
    var m = u.match(METHOD_RE);
    if (!m) return null;
    var method = init && init.method ? String(init.method).toUpperCase() : 'GET';
    if (method !== 'POST') return null; // invoke 一律 POST；GET（如静态资源）不录
    var params = {};
    var body = init && init.body;
    if (typeof body === 'string') {
      try { params = JSON.parse(body); } catch (e) { params = {}; }
    } else if (body && typeof body === 'object') {
      params = body;
    }
    var san = sanitizeParams(params);
    return { plugin: m[1], method: m[2], params: san.params, redacted: san.redacted };
  }

  function beginRecord() {
    installFetchHook();
    recordSession = { active: true, steps: [], startedAt: new Date().toISOString() };
  }

  function stopRecord() {
    if (!recordSession) return [];
    var steps = recordSession.steps.slice();
    recordSession = null;
    return steps;
  }

  function discardRecord() { recordSession = null; }

  // ---------- 回放（复用 invoke 契约）----------
  function invoke(plugin, method, params) {
    var fetchFn = nativeFetch || window.fetch.bind(window);
    var parts = document.cookie ? document.cookie.split(';') : [];
    var token = '';
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf('kore_csrf=') === 0) { token = decodeURIComponent(kv.slice('kore_csrf='.length)); break; }
    }
    if (!token) return Promise.reject(new Error('缺少安全令牌，请刷新页面或重新登录后重试'));
    return fetchFn('/api/v1/invoke/' + plugin + '/' + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var e = new Error((data.code ? data.code + '：' : '') + (data.message || '操作未成功（HTTP ' + res.status + '）'));
          e.code = data.code || '';
          throw e;
        }
        return data;
      });
    });
  }

  function render(container) {
    if (!container) return null;
    ensureCss();
    var alive = { value: true };
    var data = load();
    var root = add(container, el('section', 'macros'));
    var head = add(root, el('header', 'mac-head'));
    add(head, el('h2', 'mac-title', tr('macros.title', '操作宏')));
    add(head, el('p', 'mac-sub', tr('macros.subtitle', '把常用的一串操作录下来，命名保存，以后一键回放。点「开始录制」后像平时一样去建站点、绑证书，操作会被自动记下来。')));
    var recordBar = add(root, el('div', 'mac-record'));
    var status = add(root, el('div', 'mac-status'));
    status.setAttribute('role', 'status');
    var work = add(root, el('div', 'mac-work'));

    function setStatus(text, kind) {
      status.textContent = text || '';
      status.className = 'mac-status' + (kind ? ' is-' + kind : '');
    }
    function persist() {
      if (!save(data)) setStatus('保存失败：浏览器存储不可用，请检查是否开启了隐私模式。', 'fail');
    }
    function findMacro(id) {
      for (var i = 0; i < data.macros.length; i++) if (data.macros[i].id === id) return data.macros[i];
      return null;
    }

    // ---------- 录制条 ----------
    function paintRecordBar() {
      clear(recordBar);
      if (recordSession && recordSession.active) {
        recordBar.className = 'mac-record is-on';
        add(recordBar, el('span', 'mac-rec-dot'));
        add(recordBar, el('span', 'mac-rec-text',
          '正在录制（已捕获 ' + recordSession.steps.length + ' 步）。现在切到其他页面正常操作；含口令/密钥的步骤会自动跳过不记录。'));
        var nameInput = add(recordBar, el('input', 'mac-input'));
        nameInput.type = 'text';
        nameInput.placeholder = '给这串操作起个名字，如：建站并绑证书';
        nameInput.setAttribute('aria-label', '宏名称');
        var stop = add(recordBar, el('button', 'mac-btn is-primary', '停止并保存'));
        stop.type = 'button';
        var discard = add(recordBar, el('button', 'mac-btn', '放弃'));
        discard.type = 'button';
        on(stop, function () {
          var name = (nameInput.value || '').trim();
          if (!name) { setStatus('请先给宏起个名字再保存。', 'fail'); nameInput.focus(); return; }
          var steps = stopRecord();
          if (!steps.length) { setStatus('没有捕获到任何操作，请先在别的页面做一些操作再回来。', 'fail'); showList(); return; }
          var now = new Date().toISOString();
          data.macros.unshift({
            id: uid('m'), name: name, createdAt: now, updatedAt: now,
            onFail: 'stop', steps: steps, lastRun: null
          });
          persist();
          setStatus('已保存宏「' + name + '」，共 ' + steps.length + ' 步。', 'ok');
          showList();
        });
        on(discard, function () { discardRecord(); setStatus('已放弃本次录制。'); showList(); });
      } else {
        recordBar.className = 'mac-record';
        add(recordBar, el('span', 'mac-rec-text', '录一串新操作：'));
        var begin = add(recordBar, el('button', 'mac-btn is-primary', '开始录制'));
        begin.type = 'button';
        begin.setAttribute('data-action', 'macros-record');
        on(begin, function () {
          beginRecord();
          setStatus('录制已开始。去其他页面正常操作，完成后回到这里点「停止并保存」。', 'ok');
          paintRecordBar();
        });
      }
    }

    // ---------- 列表 ----------
    function showList() {
      clear(work);
      paintRecordBar();
      if (!data.macros.length) {
        var empty = add(work, el('div', 'mac-empty'));
        add(empty, el('div', '', '还没有操作宏。'));
        add(empty, el('div', '', '点上面的「开始录制」，然后像平时一样去建站点、绑证书……操作会被自动记下来，回来命名保存，下次一键回放。'));
        var go = add(empty, el('button', 'mac-btn is-primary', '录第一条宏'));
        go.type = 'button';
        go.setAttribute('data-action', 'macros-record');
        on(go, function () {
          beginRecord();
          setStatus('录制已开始。去其他页面正常操作，完成后回到这里点「停止并保存」。', 'ok');
          paintRecordBar();
        });
        return;
      }
      var list = add(work, el('div', 'mac-list'));
      data.macros.forEach(function (macro) {
        var card = add(list, el('div', 'mac-card'));
        var h = add(card, el('div', 'mac-card-head'));
        add(h, el('span', 'mac-name', macro.name));
        add(h, el('span', 'mac-meta', macro.steps.length + ' 步 · 最近执行 ' + stamp(macro.lastRun && macro.lastRun.at)));
        var badge = add(h, el('span', 'mac-badge ' +
          (macro.lastRun ? (macro.lastRun.success ? 'is-ok' : 'is-fail') : 'is-none'),
          macro.lastRun ? (macro.lastRun.success ? '上次成功' : '上次失败') : '未执行'));
        var actions = add(card, el('div', 'mac-actions'));
        var run = add(actions, el('button', 'mac-btn is-primary is-min', '执行'));
        run.type = 'button';
        run.setAttribute('data-action', 'macros-run');
        on(run, function () { showDetail(macro); });
        var edit = add(actions, el('button', 'mac-btn is-min', '编辑'));
        edit.type = 'button';
        edit.setAttribute('data-action', 'macros-edit');
        on(edit, function () { showEdit(macro); });
        var del = add(actions, el('button', 'mac-btn is-min', '删除'));
        del.type = 'button';
        del.setAttribute('data-action', 'macros-delete');
        on(del, function () { confirmDelete(macro, card); });
      });
      paintHistory(add(work, el('div', 'mac-hist')));
    }

    function paintHistory(host) {
      clear(host);
      var recent = data.history.slice(0, 8);
      if (!recent.length) return;
      add(host, el('div', 'mac-meta', '最近执行历史'));
      recent.forEach(function (h) {
        var item = add(host, el('div', 'mac-hist-item',
          stamp(h.at) + ' · ' + h.macroName + ' · ' +
          (h.success ? '成功' : '失败') + ' ' + h.ok + '/' + h.total +
          (h.aborted ? '（中途停止）' : '')));
        item.setAttribute('data-action', 'macros-history');
      });
    }

    function confirmDelete(macro, card) {
      if (card.querySelector('.mac-confirm')) return;
      var box = add(card, el('div', 'mac-confirm'));
      add(box, el('span', '', '确定删除宏「' + macro.name + '」？删除后无法恢复。'));
      var yes = add(box, el('button', 'mac-btn is-danger is-min', '确认删除'));
      yes.type = 'button';
      var no = add(box, el('button', 'mac-btn is-min', '取消'));
      no.type = 'button';
      on(no, function () { if (box.parentNode) box.parentNode.removeChild(box); });
      on(yes, function () {
        data.macros = data.macros.filter(function (m) { return m.id !== macro.id; });
        persist();
        setStatus('已删除宏「' + macro.name + '」。', 'ok');
        showList();
      });
    }

    // ---------- 步骤预览（复用）----------
    function paintSteps(host, macro, editable) {
      clear(host);
      if (!macro.steps.length) { add(host, el('div', 'mac-empty', '这个宏还没有步骤。')); return; }
      macro.steps.forEach(function (step, i) {
        var row = add(host, el('div', 'mac-step'));
        add(row, el('span', 'mac-step-no', String(i + 1) + '.'));
        add(row, el('span', 'mac-step-name', stepLabel(step)));
        if (step.redacted) add(row, el('span', 'mac-step-red', '含敏感参数·回放时跳过'));
        if (editable) {
          var up = add(row, el('button', 'mac-btn is-min', '上移'));
          up.type = 'button';
          on(up, function () { move(i, -1); });
          var down = add(row, el('button', 'mac-btn is-min', '下移'));
          down.type = 'button';
          on(down, function () { move(i, 1); });
          var rm = add(row, el('button', 'mac-btn is-min', '移除'));
          rm.type = 'button';
          on(rm, function () { macro.steps.splice(i, 1); macro.updatedAt = new Date().toISOString(); persist(); paintSteps(host, macro, true); });
        }
      });
      function move(i, dir) {
        var j = i + dir;
        if (j < 0 || j >= macro.steps.length) return;
        var t = macro.steps[i]; macro.steps[i] = macro.steps[j]; macro.steps[j] = t;
        macro.updatedAt = new Date().toISOString();
        persist();
        paintSteps(host, macro, true);
      }
    }

    function onFailPicker(host, macro) {
      clear(host);
      var row = add(host, el('div', 'mac-field'));
      add(row, el('span', '', '单步失败时：'));
      [['stop', '停止后续步骤'], ['continue', '继续执行后续步骤']].forEach(function (pair) {
        var lab = add(row, el('label', 'mac-radio'));
        var rb = add(lab, el('input'));
        rb.type = 'radio';
        rb.name = 'mac-onfail-' + macro.id;
        rb.value = pair[0];
        rb.checked = macro.onFail === pair[0];
        add(lab, el('span', '', pair[1]));
        rb.addEventListener('change', function () {
          if (!rb.checked) return;
          macro.onFail = pair[0];
          macro.updatedAt = new Date().toISOString();
          persist();
        });
      });
    }

    // ---------- 执行 ----------
    function showDetail(macro) {
      clear(work);
      paintRecordBar();
      var card = add(work, el('div', 'mac-card'));
      var h = add(card, el('div', 'mac-card-head'));
      add(h, el('span', 'mac-name', macro.name));
      add(h, el('span', 'mac-meta', macro.steps.length + ' 步'));
      var back = add(h, el('button', 'mac-btn is-min', '返回列表'));
      back.type = 'button';
      on(back, showList);

      add(card, el('div', 'mac-meta', '将按以下顺序执行：'));
      var stepsHost = add(card, el('div', 'mac-steps'));
      paintSteps(stepsHost, macro, false);
      var failHost = add(card, el('div'));
      onFailPicker(failHost, macro);

      var bar = add(card, el('div', 'mac-actions'));
      var go = add(bar, el('button', 'mac-btn is-primary', '一键回放'));
      go.type = 'button';
      go.setAttribute('data-action', 'macros-execute');
      var progress = add(card, el('div', 'mac-progress'));
      var fill = add(progress, el('div', 'mac-progress-fill'));
      fill.style.width = '0%';
      var resultsHost = add(card, el('div', 'mac-results'));
      var histHost = add(card, el('div', 'mac-hist'));

      on(go, function () {
        go.disabled = true;
        execute(macro, resultsHost, fill, function () { go.disabled = false; paintMacroHistory(histHost, macro); });
      });
      paintMacroHistory(histHost, macro);
    }

    function paintMacroHistory(host, macro) {
      clear(host);
      var rows = data.history.filter(function (h) { return h.macroId === macro.id; }).slice(0, 8);
      if (!rows.length) return;
      add(host, el('div', 'mac-meta', '这个宏的执行历史'));
      rows.forEach(function (h) {
        add(host, el('div', 'mac-hist-item',
          stamp(h.at) + ' · ' + (h.success ? '成功' : '失败') + ' ' + h.ok + '/' + h.total +
          (h.aborted ? '（中途停止）' : '')));
      });
    }

    function execute(macro, resultsHost, fill, done) {
      clear(resultsHost);
      var results = [];
      var i = 0, ok = 0, fail = 0, aborted = false;

      function append(step, kind, detail) {
        var r = add(resultsHost, el('div', 'mac-result is-' + kind));
        add(r, el('span', 'mac-badge ' +
          (kind === 'ok' ? 'is-ok' : (kind === 'skip' ? 'is-none' : 'is-fail')),
          kind === 'ok' ? '成功' : (kind === 'skip' ? '跳过' : '失败')));
        var body = add(r, el('div'));
        add(body, el('div', '', stepLabel(step)));
        if (detail) add(body, el('div', 'mac-meta', detail));
      }
      function finish() {
        var success = fail === 0 && !aborted;
        var now = new Date().toISOString();
        macro.lastRun = { at: now, success: success, total: macro.steps.length, ok: ok, fail: fail };
        data.history.unshift({
          id: uid('h'), macroId: macro.id, macroName: macro.name, at: now,
          success: success, total: macro.steps.length, ok: ok, fail: fail, aborted: aborted,
          results: results
        });
        if (data.history.length > HISTORY_MAX) data.history.length = HISTORY_MAX;
        persist();
        fill.style.width = '100%';
        setStatus('回放结束：成功 ' + ok + ' 步 / 失败 ' + fail + ' 步' +
          (aborted ? '（中途停止）' : '') + '。', success ? 'ok' : 'fail');
        if (done) done();
      }
      function next() {
        if (!alive.value) return Promise.resolve();
        if (i >= macro.steps.length || aborted) { finish(); return Promise.resolve(); }
        var step = macro.steps[i];
        var idx = i + 1;
        setStatus('正在执行第 ' + idx + '/' + macro.steps.length + ' 步：' + stepLabel(step));
        if (step.redacted) {
          // G-30：含敏感参数的步骤绝不自动回放（占位符不是真值），明确跳过。
          results.push({ plugin: step.plugin, method: step.method, ok: false, skipped: true, error: '含敏感参数已脱敏' });
          append(step, 'skip', '此步骤含口令/密钥，已脱敏不记录，请到原页面手动执行。');
          i++;
          fill.style.width = (i / macro.steps.length * 100) + '%';
          return next();
        }
        return invoke(step.plugin, step.method, step.params).then(function () {
          if (!alive.value) return;
          ok++;
          results.push({ plugin: step.plugin, method: step.method, ok: true, skipped: false, error: '' });
          append(step, 'ok', '');
        }, function (err) {
          if (!alive.value) return;
          fail++;
          results.push({ plugin: step.plugin, method: step.method, ok: false, skipped: false, error: errText(err) });
          append(step, 'fail', errText(err) + '。请检查该步骤的当前状态。');
          if (macro.onFail === 'stop') aborted = true;
        }).then(function () {
          if (!alive.value) return;
          i++;
          fill.style.width = (i / macro.steps.length * 100) + '%';
          return next();
        });
      }
      next();
    }

    // ---------- 编辑（重命名 / 步骤顺序 / 失败策略）----------
    function showEdit(macro) {
      clear(work);
      paintRecordBar();
      var card = add(work, el('div', 'mac-card'));
      add(card, el('h3', '', '编辑宏'));
      var nameRow = add(card, el('div', 'mac-field'));
      add(nameRow, el('span', '', '名称：'));
      var nameInput = add(nameRow, el('input', 'mac-input'));
      nameInput.type = 'text';
      nameInput.value = macro.name;
      var rename = add(nameRow, el('button', 'mac-btn is-min', '保存名称'));
      rename.type = 'button';
      on(rename, function () {
        var name = (nameInput.value || '').trim();
        if (!name) { setStatus('名称不能为空。', 'fail'); return; }
        macro.name = name;
        macro.updatedAt = new Date().toISOString();
        persist();
        setStatus('已重命名为「' + name + '」。', 'ok');
      });
      add(card, el('div', 'mac-meta', '调整步骤顺序或移除步骤：'));
      var stepsHost = add(card, el('div', 'mac-steps'));
      paintSteps(stepsHost, macro, true);
      var failHost = add(card, el('div'));
      onFailPicker(failHost, macro);
      var bar = add(card, el('div', 'mac-actions'));
      var back = add(bar, el('button', 'mac-btn is-primary', '完成'));
      back.type = 'button';
      on(back, function () { persist(); showList(); });
    }

    showList();
    return {
      destroy: function () { alive.value = false; }
    };
  }

  window.KoreMacros = { render: render };
})();
