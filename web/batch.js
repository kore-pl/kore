/* kore 主壳 · 批量操作中心（web/batch.js）——纯增量新功能，零框架 / 零 CDN / 无外链。
   入口 window.KoreBatch.render(container)，返回 { destroy() }；由 shell 懒加载，不进首屏六件套。

   定位：跨插件的批量执行器。各插件原本只有单对象操作，本页在【主壳视图层】循环调用插件
   现成的 invoke，不在内核内实现任何业务（G-13 薄壳红线：内核不写业务逻辑、不 import 插件）。
   用户路径：选目标 → 选操作 → 预览影响清单 → （危险操作二次确认）→ 执行 → 看每个结果。

   invoke 契约均从源码实读，非臆造：
     · site.list  -> { sites: [{ domain, enabled, ... }] }        web/sites.js:812
       site.enable / site.disable -> { domain }                   web/sites.js:184
     · container.list -> { containers: [{ id, name, protected, ...}], count, all }
                                                                  web/container.js:651
       container.restart -> { id, confirm: true }                  web/container.js:632
       （struct 定义 kore-plugin-container/internal/containerop/types.go:87-103）
   统一调用形态：POST /api/v1/invoke/<plugin>/<method> + X-Kore-CSRF 双提交（同 sites.js/container.js）。 */
(function () {
  'use strict';

  var CSS = '' +
    '.batch{color:var(--kore-text-1)}' +
    '.batch .batch-head{margin-bottom:12px}' +
    '.batch .batch-title{margin:0 0 4px;font-size:var(--kore-font-18,18px);font-weight:600}' +
    '.batch .batch-sub{margin:0;color:var(--kore-text-3);font-size:var(--kore-font-13,13px);line-height:1.6}' +
    '.batch .batch-steps{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 14px}' +
    '.batch .batch-step{padding:4px 10px;border:1px solid var(--kore-border-1);border-radius:999px;color:var(--kore-text-3);font-size:var(--kore-font-12,12px)}' +
    '.batch .batch-step.is-active{color:var(--kore-bg-1);background:var(--kore-accent,var(--kore-primary,#4a90e2));border-color:transparent}' +
    '.batch .batch-card{border:1px solid var(--kore-border-1);border-radius:6px;padding:14px;margin:10px 0;background:var(--kore-bg-1)}' +
    '.batch .batch-cards{display:flex;flex-wrap:wrap;gap:10px}' +
    '.batch .batch-cards .batch-card{flex:1 1 240px;cursor:pointer;transition:border-color .15s}' +
    '.batch .batch-cards .batch-card:hover{border-color:var(--kore-accent,var(--kore-primary,#4a90e2))}' +
    '.batch .batch-cards .batch-card.is-picked{border-color:var(--kore-accent,var(--kore-primary,#4a90e2));box-shadow:0 0 0 1px var(--kore-accent,var(--kore-primary,#4a90e2)) inset}' +
    '.batch .batch-card h3{margin:0 0 4px;font-size:var(--kore-font-15,15px)}' +
    '.batch .batch-card p{margin:0;color:var(--kore-text-3);font-size:var(--kore-font-12,12px);line-height:1.6}' +
    '.batch .batch-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}' +
    '.batch .batch-btn{min-height:36px;padding:0 14px;border:1px solid var(--kore-border-1);border-radius:4px;background:var(--kore-bg-2);color:var(--kore-text-1);cursor:pointer;font-size:var(--kore-font-13,13px)}' +
    '.batch .batch-btn:hover:not([disabled]){border-color:var(--kore-accent,var(--kore-primary,#4a90e2))}' +
    '.batch .batch-btn[disabled]{opacity:.5;cursor:not-allowed}' +
    '.batch .batch-btn.is-primary{background:var(--kore-accent,var(--kore-primary,#4a90e2));color:#fff;border-color:transparent}' +
    '.batch .batch-btn.is-danger{background:var(--kore-danger,#d9534f);color:#fff;border-color:transparent}' +
    // P2 danger 治理：可逆的批量停用走中性色；danger 只给真正不可逆/故障的批量操作。
    '.batch .batch-btn.is-muted{background:var(--kore-bg-2);color:var(--kore-text-2);border-color:var(--kore-border-1)}' +
    '.batch .batch-list{display:flex;flex-direction:column;gap:2px;max-height:320px;overflow:auto;margin:8px 0;border:1px solid var(--kore-border-1);border-radius:4px}' +
    '.batch .batch-item{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 10px;border-bottom:1px solid var(--kore-border-2);font-size:var(--kore-font-13,13px)}' +
    '.batch .batch-item:last-child{border-bottom:0}' +
    '.batch .batch-item input[type=checkbox]{width:18px;height:18px;flex:0 0 auto;min-width:18px;min-height:18px;cursor:pointer}' +
    '.batch .batch-item-name{flex:1;word-break:break-all}' +
    '.batch .batch-item-note{color:var(--kore-text-3);font-size:var(--kore-font-12,12px)}' +
    '.batch .batch-warn{margin:8px 0;padding:10px 12px;border:1px solid var(--kore-danger,#d9534f);border-radius:4px;color:var(--kore-danger,#d9534f);font-size:var(--kore-font-13,13px);line-height:1.6}' +
    '.batch .batch-confirm{display:flex;align-items:center;gap:8px;min-height:44px;margin:8px 0;font-size:var(--kore-font-13,13px)}' +
    '.batch .batch-confirm input{width:18px;height:18px;min-width:18px;min-height:18px}' +
    '.batch .batch-meta{color:var(--kore-text-2);font-size:var(--kore-font-12,12px)}' +
    '.batch .batch-status{min-height:20px;margin:8px 0;font-size:var(--kore-font-13,13px)}' +
    '.batch .batch-status.is-ok{color:var(--kore-success,#2e7d32)}' +
    '.batch .batch-status.is-fail{color:var(--kore-danger,#d9534f)}' +
    '.batch .batch-progress{height:8px;border-radius:4px;background:var(--kore-bg-2);overflow:hidden;margin:8px 0}' +
    '.batch .batch-progress-fill{height:100%;background:var(--kore-accent,var(--kore-primary,#4a90e2));transition:width .2s}' +
    '.batch .batch-results{display:flex;flex-direction:column;gap:4px;margin:8px 0}' +
    '.batch .batch-result{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--kore-border-1);border-radius:4px;font-size:var(--kore-font-13,13px)}' +
    '.batch .batch-result.is-ok{border-left:3px solid var(--kore-success,#2e7d32)}' +
    '.batch .batch-result.is-fail{border-left:3px solid var(--kore-danger,#d9534f)}' +
    '.batch .batch-badge{flex:0 0 auto;padding:1px 6px;border-radius:999px;font-size:var(--kore-font-12,12px)}' +
    '.batch .batch-result.is-ok .batch-badge{color:var(--kore-success,#2e7d32);background:rgba(46,125,50,.12)}' +
    '.batch .batch-result.is-fail .batch-badge{color:var(--kore-danger,#d9534f);background:rgba(217,83,79,.12)}' +
    '.batch .batch-empty{padding:18px;text-align:center;color:var(--kore-text-3);font-size:var(--kore-font-13,13px);line-height:1.7}' +
    '@media (max-width:639px){' +
      '.batch .batch-btn{min-height:44px;flex:1 1 auto}' +
      '.batch .batch-list{max-height:none}' +
      '.batch .batch-item{min-height:48px}' +
      '.batch .batch-cards .batch-card{flex:1 1 100%}' +
    '}';

  function ensureCss() {
    if (document.getElementById('kore-batch-css')) return;
    var s = document.createElement('style');
    s.id = 'kore-batch-css';
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
  function tr(key, fallback, params) {
    var i18n = window.KoreI18n;
    var out = fallback;
    if (i18n && typeof i18n.t === 'function') {
      var hit = i18n.t(key);
      if (hit && hit !== key) out = hit;
    }
    // 插值：i18n 命中或未命中都用 params 替换 {name} 占位符（中文态零依赖也能正确显示）。
    if (params) {
      out = String(out).replace(/\{(\w+)\}/g, function (m, k) {
        return params[k] !== undefined ? String(params[k]) : m;
      });
    }
    return out;
  }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function errText(err) {
    var text = err && err.message ? String(err.message) : '未知错误';
    if (err && err.code && text.indexOf(err.code) < 0) text = err.code + '：' + text;
    return text;
  }
  function invoke(plugin, method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少安全令牌，请刷新页面或重新登录后再试'));
    return fetch('/api/v1/invoke/' + plugin + '/' + method, {
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

  // 场景注册表：新增一种批量能力只需在此追加一项，执行器/UI 完全复用（顶层设计：标准化流水线）。
  // eligible 决定该操作下哪些目标可选；params 把目标翻译成该插件单操作的真实入参。
  var SCENARIOS = [
    {
      id: 'site',
      label: '批量启停站点',
      desc: '一次启用或停用多个网站；每条独立执行，某条失败不影响其它条目。',
      plugin: 'site',
      list: { method: 'site.list', params: {}, pick: function (d) { return d && d.sites ? d.sites : []; } },
      name: function (t) { return t.domain; },
      note: function (t) { return t.enabled ? '当前启用' : '当前停用'; },
      ops: [
        {
          id: 'enable', label: '批量启用', method: 'site.enable', dangerous: false,
          eligible: function (t) { return !t.enabled; },
          params: function (t) { return { domain: t.domain }; }
        },
        {
          // 批量停用可逆（随时再启用）→ 中性灰，不占危险色（DESIGN-SYSTEM C7）。
          // 仍保留危险 flag 的二次确认步骤（批量操作先核对清单，只改颜色不改安全流程）。
          id: 'disable', label: '批量停用', method: 'site.disable', dangerous: true, reversible: true,
          eligible: function (t) { return !!t.enabled; },
          params: function (t) { return { domain: t.domain }; }
        }
      ]
    },
    {
      id: 'container',
      label: '批量重启容器',
      desc: '一次重启多个本机容器；带锁标的核心容器会被自动排除，重启属于危险操作需二次确认。',
      plugin: 'container',
      list: { method: 'container.list', params: { all: true }, pick: function (d) { return d && d.containers ? d.containers : []; } },
      name: function (t) { return t.name || t.id; },
      note: function (t) { return t.protected ? '受保护' : (t.state || ''); },
      ops: [
        {
          id: 'restart', label: '批量重启', method: 'container.restart', dangerous: true,
          eligible: function (t) { return !t.protected; },
          params: function (t) { return { id: t.id, confirm: true }; }
        }
      ]
    }
  ];

  function scenarioById(id) {
    for (var i = 0; i < SCENARIOS.length; i++) if (SCENARIOS[i].id === id) return SCENARIOS[i];
    return null;
  }

  // 单次批次的运行态；destroy 时置 destroyed，执行器在下一轮循环前停下，不继续发后续请求。
  function newRun() {
    return { destroyed: false, running: false, scenario: null, op: null, targets: [], selected: {}, results: [] };
  }

  function render(container) {
    if (!container) return null;
    ensureCss();
    var run = newRun();
    var root = add(container, el('section', 'batch'));
    var head = add(root, el('header', 'batch-head'));
    add(head, el('h2', 'batch-title', tr('batch.title', '批量操作中心')));
    add(head, el('p', 'batch-sub', tr('batch.subtitle', '跨插件一次处理多个目标：选目标、选操作、预览影响清单，再统一执行并查看每一条结果。')));

    var steps = add(root, el('div', 'batch-steps'));
    var stepEls = [];
    ['选场景', '选操作与目标', '预览确认', '执行与结果'].forEach(function (label) {
      stepEls.push(add(steps, el('span', 'batch-step', label)));
    });
    function setStep(n) {
      for (var i = 0; i < stepEls.length; i++) stepEls[i].className = 'batch-step' + (i === n ? ' is-active' : '');
    }

    var status = add(root, el('div', 'batch-status'));
    status.setAttribute('role', 'status');
    var work = add(root, el('div', 'batch-work'));

    function setStatus(text, kind) {
      status.textContent = text || '';
      status.className = 'batch-status' + (kind ? ' is-' + kind : '');
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    function showScenarios() {
      setStep(0);
      clear(work);
      var box = add(work, el('div', 'batch-card'));
      add(box, el('h3', '', tr('batch.pickScene', '第一步 · 选择要批量处理的对象')));
      add(box, el('p', 'batch-meta', tr('batch.pickSceneHint', '选择一类资源后，再决定对它执行什么操作。')));
      var cards = add(box, el('div', 'batch-cards'));
      SCENARIOS.forEach(function (sc) {
        var c = add(cards, el('div', 'batch-card'));
        c.setAttribute('data-action', 'batch-scenario-' + sc.id);
        c.setAttribute('role', 'button');
        c.setAttribute('tabindex', '0');
        add(c, el('h3', '', sc.label));
        add(c, el('p', '', sc.desc));
        function pick() { showOps(sc); }
        on(c, pick);
        c.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); }
        });
      });
      setStatus('');
    }

    function showOps(sc) {
      run.scenario = sc;
      run.op = null;
      run.targets = [];
      run.selected = {};
      run.results = [];
      setStep(1);
      clear(work);
      var box = add(work, el('div', 'batch-card'));
      add(box, el('h3', '', tr('batch.pickOp', '第二步 · 选择操作')));
      var row = add(box, el('div', 'batch-row'));
      sc.ops.forEach(function (op) {
        var b = add(row, el('button', 'batch-btn' + opToneClass(op), op.label));
        b.type = 'button';
        b.setAttribute('data-action', 'batch-op-' + op.id);
        on(b, function () { loadTargets(sc, op); });
      });
      var back = add(row, el('button', 'batch-btn', tr('common.back', '上一步')));
      back.type = 'button';
      on(back, showScenarios);
      var host = add(box, el('div', 'batch-targets'));
      setStatus('');
      run.targetHost = host;
      host.appendChild(el('div', 'batch-empty', tr('batch.chooseOpHint', '选好操作后，这里会列出可以处理的目标，请从中勾选。')));
    }

    function loadTargets(sc, op) {
      run.op = op;
      setStatus(tr('batch.loadingTargets', '正在读取可处理的目标…'));
      invoke(sc.plugin, sc.list.method, sc.list.params).then(function (data) {
        if (run.destroyed || run.op !== op) return;
        var all = sc.list.pick(data);
        run.targets = [];
        for (var i = 0; i < all.length; i++) {
          if (op.eligible(all[i])) run.targets.push(all[i]);
        }
        run.selected = {};
        for (var j = 0; j < run.targets.length; j++) run.selected[j] = true; // 默认全选，减少点击（产品原则③）
        paintTargets(sc, op);
        setStatus(tr('batch.targetsLoaded', '已读取 {n} 个可处理目标', { n: run.targets.length }), 'ok');
      }, function (err) {
        if (run.destroyed || run.op !== op) return;
        clear(run.targetHost);
        var hint = add(run.targetHost, el('div', 'batch-empty',
          tr('batch.targetsFailed', '读取目标失败：{msg}。请确认对应插件已启用后再试。', { msg: errText(err) })));
        hint.setAttribute('role', 'alert');
        setStatus(errText(err), 'fail');
      });
    }

    // P2 danger 治理：dangerous 表示「需二次确认」，reversible 表示「可逆 → 中性色」。
    // 两者解耦：批量停用仍要确认清单，但不再染红；批量重启不可逆语境仍保留红。
    function opToneClass(op) {
      if (op && op.reversible) return ' is-muted';
      return op && op.dangerous ? ' is-danger' : '';
    }
    function paintTargets(sc, op) {
      clear(run.targetHost);
      if (!run.targets.length) {
        var empty = add(run.targetHost, el('div', 'batch-empty',
          tr('batch.noTargets', '当前没有可处理的目标。可先到对应页面创建，或换一个操作再试。')));
        var go = add(empty, el('button', 'batch-btn', tr('batch.know', '知道了')));
        go.type = 'button';
        go.style.marginLeft = '8px';
        on(go, showOps.bind(null, sc));
        return;
      }
      var meta = add(run.targetHost, el('div', 'batch-row'));
      var selectedMeta = add(meta, el('span', 'batch-meta'));
      var list = add(run.targetHost, el('div', 'batch-list'));
      var boxes = [];
      function refreshMeta() {
        var n = 0;
        for (var k in run.selected) if (run.selected[k]) n++;
        selectedMeta.textContent = tr('batch.selectedCount', '已勾选 {n} / {total} 个目标', { n: n, total: run.targets.length });
      }
      run.targets.forEach(function (t, i) {
        var row = add(list, el('label', 'batch-item'));
        var cb = add(row, el('input'));
        cb.type = 'checkbox';
        cb.checked = !!run.selected[i];
        cb.setAttribute('data-action', 'batch-target');
        boxes.push(cb);
        cb.addEventListener('change', function () { run.selected[i] = cb.checked; refreshMeta(); });
        add(row, el('span', 'batch-item-name', sc.name(t)));
        var note = sc.note(t);
        if (note) add(row, el('span', 'batch-item-note', note));
      });
      refreshMeta();
      var bar = add(run.targetHost, el('div', 'batch-row'));
      var all = add(bar, el('button', 'batch-btn', tr('batch.selectAll', '全选')));
      all.type = 'button';
      on(all, function () { setAll(true); });
      var none = add(bar, el('button', 'batch-btn', tr('batch.selectNone', '全不选')));
      none.type = 'button';
      on(none, function () { setAll(false); });
      var next = add(bar, el('button', 'batch-btn is-primary', tr('batch.preview', '下一步 · 预览')));
      next.type = 'button';
      next.setAttribute('data-action', 'batch-preview');
      on(next, function () {
        var picked = pickedTargets();
        if (!picked.length) { setStatus(tr('batch.pickOne', '请至少勾选一个目标再继续。'), 'fail'); return; }
        showPreview(sc, op, picked);
      });
      function setAll(v) {
        for (var i = 0; i < boxes.length; i++) { boxes[i].checked = v; run.selected[i] = v; }
        refreshMeta();
      }
    }

    function pickedTargets() {
      var out = [];
      for (var i = 0; i < run.targets.length; i++) if (run.selected[i]) out.push(run.targets[i]);
      return out;
    }

    function showPreview(sc, op, picked) {
      setStep(2);
      clear(work);
      var box = add(work, el('div', 'batch-card'));
      add(box, el('h3', '', tr('batch.previewTitle', '第三步 · 预览影响清单')));
      add(box, el('p', 'batch-meta', tr('batch.previewDesc', '将按以下清单执行：')));
      var list = add(box, el('div', 'batch-list'));
      picked.forEach(function (t) { add(list, el('div', 'batch-item', sc.name(t))); });
      var confirmBox = null, confirmInput = null;
      if (op.dangerous) {
        var warn = add(box, el('div', 'batch-warn',
          tr('batch.dangerWarn', '危险操作：将对上面 {n} 个目标执行「{op}」，执行后可能影响线上服务，且不会自动回滚。请逐个核对清单。',
            { n: picked.length, op: op.label })));
        warn.setAttribute('role', 'alert');
        confirmBox = add(box, el('label', 'batch-confirm'));
        confirmInput = add(confirmBox, el('input'));
        confirmInput.type = 'checkbox';
        confirmInput.setAttribute('data-action', 'batch-confirm');
        add(confirmBox, el('span', '',
          tr('batch.dangerConfirm', '我已核对以上清单，确认执行批量{op}', { op: op.label })));
      }
      var bar = add(box, el('div', 'batch-row'));
      var back = add(bar, el('button', 'batch-btn', tr('common.back', '上一步')));
      back.type = 'button';
      on(back, function () { showTargetsAgain(sc, op); });
      var go = add(bar, el('button', 'batch-btn ' + (opToneClass(op) || 'is-primary').trim(),
        tr('batch.execute', '确认执行 {n} 项', { n: picked.length })));
      go.type = 'button';
      go.setAttribute('data-action', 'batch-execute');
      if (op.dangerous && confirmInput) {
        go.disabled = true;
        confirmInput.addEventListener('change', function () { go.disabled = !confirmInput.checked; });
      }
      on(go, function () { execute(sc, op, picked); });
      setStatus('');
    }

    function showTargetsAgain(sc, op) {
      setStep(1);
      clear(work);
      var box = add(work, el('div', 'batch-card'));
      add(box, el('h3', '', tr('batch.pickOp', '第二步 · 选择操作')));
      var row = add(box, el('div', 'batch-row'));
      sc.ops.forEach(function (o) {
        var b = add(row, el('button', 'batch-btn' + opToneClass(o), o.label));
        b.type = 'button';
        on(b, function () { loadTargets(sc, o); });
      });
      run.targetHost = add(box, el('div', 'batch-targets'));
      paintTargets(sc, op);
    }

    function execute(sc, op, picked) {
      setStep(3);
      run.running = true;
      run.results = [];
      clear(work);
      var box = add(work, el('div', 'batch-card'));
      add(box, el('h3', '', tr('batch.runningTitle', '第四步 · 正在执行')));
      var progress = add(box, el('div', 'batch-progress'));
      var fill = add(progress, el('div', 'batch-progress-fill'));
      fill.style.width = '0%';
      var counter = add(box, el('div', 'batch-meta', '0 / ' + picked.length));
      var results = add(box, el('div', 'batch-results'));
      var done = 0, okCount = 0, failCount = 0;
      var failedIdx = [];

      function appendResult(name, ok, detail) {
        var r = add(results, el('div', 'batch-result ' + (ok ? 'is-ok' : 'is-fail')));
        add(r, el('span', 'batch-badge', ok ? tr('batch.ok', '成功') : tr('batch.fail', '失败')));
        var body = add(r, el('div'));
        add(body, el('div', '', name));
        if (detail) add(body, el('div', 'batch-item-note', detail));
      }
      function summarize(data) {
        if (!data) return '';
        var parts = [];
        if (data.applied === true) parts.push(tr('batch.applied', '已生效'));
        if (data.reloaded === true) parts.push(tr('batch.reloaded', '已重载'));
        if (data.status) parts.push(String(data.status));
        return parts.join(' · ');
      }
      function finish() {
        run.running = false;
        counter.textContent = tr('batch.done', '完成：成功 {ok} 项 / 失败 {fail} 项 / 共 {total} 项',
          { ok: okCount, fail: failCount, total: picked.length });
        fill.style.width = '100%';
        setStatus(tr('batch.finished', '批量操作已结束，逐条结果见下方。'), failCount ? 'fail' : 'ok');
        var bar = add(box, el('div', 'batch-row'));
        var again = add(bar, el('button', 'batch-btn', tr('batch.again', '再做一批')));
        again.type = 'button';
        on(again, showScenarios);
        if (failCount) {
          var retry = add(bar, el('button', 'batch-btn is-primary', tr('batch.retryFailed', '仅重试失败项')));
          retry.type = 'button';
          on(retry, function () {
            var retryTargets = [];
            for (var i = 0; i < failedIdx.length; i++) retryTargets.push(picked[failedIdx[i]]);
            if (retryTargets.length) execute(sc, op, retryTargets);
          });
        }
      }
      function step(i) {
        if (run.destroyed) return Promise.resolve();
        if (i >= picked.length) { finish(); return Promise.resolve(); }
        var t = picked[i], name = sc.name(t);
        setStatus(tr('batch.processing', '正在处理 {i}/{total}：{name}', { i: i + 1, total: picked.length, name: name }));
        return invoke(sc.plugin, op.method, op.params(t)).then(function (data) {
          if (run.destroyed) return;
          okCount++; run.results.push({ name: name, ok: true });
          appendResult(name, true, summarize(data));
        }, function (err) {
          if (run.destroyed) return;
          failCount++;
          failedIdx.push(i);
          var detail = errText(err) + '。请检查该目标的当前状态后单独重试。';
          run.results.push({ name: name, ok: false });
          appendResult(name, false, detail);
        }).then(function () {
          if (run.destroyed) return;
          done++;
          counter.textContent = done + ' / ' + picked.length;
          fill.style.width = (done / picked.length * 100) + '%';
          return step(i + 1);
        });
      }
      step(0);
    }

    showScenarios();
    return {
      destroy: function () {
        run.destroyed = true;
        run.running = false;
      }
    };
  }

  window.KoreBatch = { render: render };
})();
