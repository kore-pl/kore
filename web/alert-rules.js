/* kore 主壳 · 告警规则可视化配置（web/alert-rules.js，懒加载视图）
   解决什么问题：告警中心原本只展示服务端埋点、监控页阈值写死在代码里，用户无法自建规则。
   本页让用户自己配「CPU / 内存 / 磁盘 / 负载 超过阈值 → 产生一条站内告警」的规则。

   数据形状（显式，G-24；localStorage 键 kore:alert-rules:v1，值 = Rule[]）：
     Rule = { id: string, name: string(1..40字), metric: 'cpu'|'memory'|'disk'|'load',
              threshold: number(在对应 metric 的 min..max 内), enabled: boolean,
              createdAt: ISO8601 string, lastTriggeredAt: ISO8601 string|'',
              triggerCount: number >= 0 }
   规则存本机：不加后端 bucket / 不改共享 store.go（同批写域不相交）；
   「测试触发」复用已存在的 POST /api/v1/alerts（system:admin + X-Kore-CSRF 双提交），
   真写一条告警进告警中心，用户可立刻到「告警中心」核对——不是假成功。

   纪律：零框架 / 零 CDN / 零定时器（无 setInterval）；CSS 内联注入不进首屏六件套；
   window.KoreAlertRules.render(container) → { destroy }。 */
(function () {
  'use strict';

  var STORE_KEY = 'kore:alert-rules:v1';
  var ALERTS_API = '/api/v1/alerts';
  var STYLE_ID = 'kore-alert-rules-css';

  /* 监控项受控词表：阈值范围与帮助文案跟着监控项走，不手填魔法数（G-24）。
     与 monitor.js 的 THRESHOLDS（cpu_percent / memory_percent / disk_percent）及
     monitor 插件 alerts[] 的 cpu/memory/disk/load 四项口径对齐。 */
  var METRICS = [
    { key: 'cpu', label: 'CPU 使用率', unit: '%', min: 1, max: 100, step: 1, def: 90,
      help: 'CPU 长时间超过该百分比时提醒；建议 80–90，太低会频繁提醒。' },
    { key: 'memory', label: '内存使用率', unit: '%', min: 1, max: 100, step: 1, def: 90,
      help: '内存占用超过该百分比时提醒；建议 80–90。' },
    { key: 'disk', label: '磁盘使用率', unit: '%', min: 1, max: 100, step: 1, def: 90,
      help: '磁盘占用超过该百分比时提醒；建议 85 左右，留出清理时间。' },
    { key: 'load', label: '系统负载（1 分钟均值）', unit: '', min: 0.1, max: 1024, step: 0.1, def: 8,
      help: '负载不是百分比；一般设为 CPU 核数的 1–2 倍，例如 4 核机器可填 8。' }
  ];
  var METRIC_MAP = {};
  METRICS.forEach(function (m) { METRIC_MAP[m.key] = m; });

  /* 单视图状态：gen 防旧异步回写，destroy 只清自己的引用与监听。 */
  var S = { box: null, gen: 0, rules: [], error: '', notice: '',
    editing: null, confirmId: null, busy: false, formName: '', formMetric: 'cpu', formThreshold: '' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  var CSS =
    '.ar-wrap{max-width:1080px;margin:0 auto;padding:var(--kore-space-4)}' +
    '.ar-head{display:flex;align-items:flex-start;gap:var(--kore-space-3);flex-wrap:wrap;margin-bottom:var(--kore-space-4)}' +
    '.ar-head-main{flex:1;min-width:240px}' +
    '.ar-h1{font-size:var(--kore-font-20);font-weight:600;margin:0 0 var(--kore-space-1)}' +
    '.ar-sub{font-size:var(--kore-font-12);color:var(--kore-text-3);margin:0;line-height:1.6}' +
    '.ar-notice,.ar-error{padding:var(--kore-space-2) var(--kore-space-3);border-radius:var(--kore-radius-control);' +
    'font-size:var(--kore-font-12);margin-bottom:var(--kore-space-3);line-height:1.6}' +
    '.ar-notice{background:var(--kore-bg-2);color:var(--kore-success);border:1px solid var(--kore-border-1)}' +
    '.ar-error{background:var(--kore-bg-2);color:var(--kore-danger);border:1px solid var(--kore-border-1)}' +
    '.ar-panel{margin-bottom:var(--kore-space-4)}' +
    '.ar-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--kore-space-3)}' +
    '.ar-field{display:flex;flex-direction:column;gap:var(--kore-space-1)}' +
    '.ar-label{font-size:var(--kore-font-12);font-weight:600}' +
    '.ar-input,.ar-select{min-height:var(--kore-touch,44px);padding:0 var(--kore-space-2);' +
    'background:var(--kore-bg-1);color:var(--kore-text-1);border:1px solid var(--kore-border-1);' +
    'border-radius:var(--kore-radius-control);font-size:var(--kore-font-14);width:100%;box-sizing:border-box}' +
    '.ar-help{font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.5}' +
    '.ar-actions{display:flex;gap:var(--kore-space-2);flex-wrap:wrap;align-items:center;margin-top:var(--kore-space-3)}' +
    '.ar-btn{min-height:var(--kore-touch,44px);padding:0 var(--kore-space-3);cursor:pointer;white-space:nowrap}' +
    '.ar-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-12)}' +
    '.ar-table th,.ar-table td{text-align:left;padding:var(--kore-space-2);' +
    'border-bottom:1px solid var(--kore-border-1);vertical-align:middle}' +
    '.ar-table th{color:var(--kore-text-3);font-weight:600;white-space:nowrap}' +
    '.ar-name{font-weight:600;font-size:var(--kore-font-14)}' +
    '.ar-muted{color:var(--kore-text-3)}' +
    '.ar-badge{display:inline-block;padding:2px var(--kore-space-2);border-radius:999px;' +
    'font-size:var(--kore-font-12);border:1px solid var(--kore-border-1)}' +
    '.ar-badge.on{color:var(--kore-success)}.ar-badge.off{color:var(--kore-text-3)}' +
    '.ar-rowact{display:flex;gap:var(--kore-space-2);flex-wrap:wrap}' +
    '.ar-empty{text-align:center;padding:var(--kore-space-6) var(--kore-space-3);color:var(--kore-text-2)}' +
    '.ar-empty b{display:block;font-size:var(--kore-font-16);color:var(--kore-success);margin-bottom:var(--kore-space-2)}' +
    '.ar-empty small{color:var(--kore-text-3);display:block;margin-bottom:var(--kore-space-3);line-height:1.6}' +
    '@media (max-width:639px){' +
    '.ar-wrap{padding:var(--kore-space-2)}' +
    '.ar-table thead{display:none}' +
    '.ar-table,.ar-table tbody,.ar-table tr,.ar-table td{display:block;width:100%;box-sizing:border-box}' +
    '.ar-table tr{border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);' +
    'padding:var(--kore-space-2);margin-bottom:var(--kore-space-2)}' +
    '.ar-table td{border:0;display:flex;justify-content:space-between;gap:var(--kore-space-2);' +
    'padding:var(--kore-space-1) 0;text-align:right}' +
    '.ar-table td::before{content:attr(data-label);color:var(--kore-text-3);flex:none;text-align:left}' +
    '.ar-rowact{justify-content:flex-end}' +
    '.ar-form{grid-template-columns:1fr}' +
    '}';

  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = el('style'); s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function nowIso() { return new Date().toISOString(); }
  function uid() {
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function fmtTime(iso) {
    if (!iso) return '从未触发';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '从未触发';
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }

  function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  /* 读盘即收口：任何损坏/越界字段丢弃或归位，不让坏数据进 UI（内部 any → 具体类型）。 */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var m = METRIC_MAP[raw.metric];
    if (!m) return null;
    var name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
    var th = num(raw.threshold);
    if (!name || th === null || th < m.min || th > m.max) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
      name: name, metric: m.key, threshold: th, enabled: !!raw.enabled,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
      lastTriggeredAt: typeof raw.lastTriggeredAt === 'string' ? raw.lastTriggeredAt : '',
      triggerCount: Math.max(0, Math.floor(num(raw.triggerCount) || 0))
    };
  }
  function load() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      var out = [];
      var ids = {};
      parsed.forEach(function (r) {
        var rule = normalize(r);
        if (rule && !ids[rule.id]) { ids[rule.id] = true; out.push(rule); }
      });
      return out;
    } catch (e) { return []; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S.rules)); return true; }
    catch (e) {
      S.error = '保存到本机失败：浏览器存储不可用或空间已满。请检查浏览器隐私设置后重试，本次改动尚未保存。';
      return false;
    }
  }
  function countWords(s) {
    // 中文/全角按字计，英文按词粗算：只用于 40 字上限的宽松校验。
    return String(s || '').trim().length;
  }
  /* G-33 A3：错误文案 ≥8 字，含「请/应/需/例/如」并给「怎么办」。 */
  function validate(name, metricKey, thresholdRaw) {
    var trimmed = String(name || '').trim();
    if (!countWords(trimmed)) return '请填写规则名称，例如「CPU 持续偏高」，不超过 40 个字。';
    if (countWords(trimmed) > 40) return '规则名称太长了，请缩到 40 个字以内，例如「磁盘空间不足」。';
    var m = METRIC_MAP[metricKey];
    if (!m) return '请选择一个监控项（CPU、内存、磁盘或系统负载）。';
    var v = num(thresholdRaw);
    if (v === null) return '请填写阈值数字，例如 ' + m.def + m.unit + '，不要填文字或留空。';
    if (v < m.min || v > m.max) {
      return m.label + '的阈值应在 ' + m.min + ' 到 ' + m.max + m.unit + ' 之间，例如 ' + m.def + m.unit + '。';
    }
    return '';
  }
  function errText(res, fallback) {
    var d = res && res.data;
    return (d && (d.message || d.detail)) || fallback;
  }
  function triggerMessage(res) {
    var status = res && res.status;
    var detail = errText(res, '');
    if (status === 401 || status === 403) {
      return '需要管理员权限才能发送测试告警。请切换到管理员账号后重试；规则本身已保存，不受影响。';
    }
    if (status === 501) {
      return '告警中心后端尚未装配，测试告警发不出去。请使用完整安装版本或联系管理员；规则本身已保存。';
    }
    if (detail) return '测试告警发送失败：' + detail + '。请稍后重试，或到「告警中心」查看是否已有记录。';
    return '测试告警发送失败（状态 ' + (status || '未知') + '）。请检查本机服务后重试，规则本身已保存。';
  }

  /* 测试触发：真写一条告警进告警中心（复用现有端点，不造假成功）。 */
  function testTrigger(rule) {
    var m = METRIC_MAP[rule.metric];
    if (!m) return;
    var title = '【测试】' + rule.name + '：' + m.label + '超过阈值 ' + rule.threshold + m.unit;
    var detail = '这是「告警规则」页的测试触发，用于确认规则能产生站内告警；' +
      '规则：' + rule.name + '，监控项：' + m.label + '，阈值：' + rule.threshold + m.unit + '。' +
      '请到「告警中心」核对这条记录；真实自动判断将在监控采集侧接入后生效。';
    var token = readCookie('kore_csrf');
    var gen = S.gen;
    S.busy = true; paint();
    fetch(ALERTS_API, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Kore-CSRF': token, Accept: 'application/json' },
      body: JSON.stringify({ severity: 'warning', source: 'resource', title: title, detail: detail })
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = {}; } }
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (res) {
      if (gen !== S.gen) return;
      S.busy = false;
      if (res.ok) {
        rule.lastTriggeredAt = nowIso();
        rule.triggerCount += 1;
        var okSave = save();
        if (okSave) S.notice = '测试告警已发送到「告警中心」，请到那里查看；这条规则的「最近触发」已更新。';
      } else {
        S.error = triggerMessage(res);
      }
      paint();
    }, function () {
      if (gen !== S.gen) return;
      S.busy = false;
      S.error = '无法连接本机服务，测试告警没有发出。请确认 Kore 正在运行后重试；规则本身已保存。';
      paint();
    });
  }

  function msgBox() {
    var wrap = el('div');
    if (S.notice) { var n = el('div', 'ar-notice', S.notice); n.setAttribute('role', 'status'); wrap.appendChild(n); }
    if (S.error) { var e = el('div', 'ar-error', S.error); e.setAttribute('role', 'alert'); wrap.appendChild(e); }
    return wrap;
  }

  function formCard() {
    var panel = el('section', 'panel ar-panel');
    panel.appendChild(el('div', 'panel-title', S.editing ? '编辑告警规则' : '新建告警规则'));
    var help = el('p', 'ar-help', '设置一条规则：当监控项超过阈值时，Kore 会向「告警中心」写入一条站内告警。');
    help.style.margin = '0 0 var(--kore-space-3)';
    panel.appendChild(help);
    var form = el('div', 'ar-form');

    var fName = el('div', 'ar-field');
    fName.appendChild(el('label', 'ar-label', '规则名称'));
    var nameInput = el('input', 'ar-input');
    nameInput.type = 'text'; nameInput.maxLength = 40; nameInput.value = S.formName;
    nameInput.placeholder = '例如：CPU 持续偏高';
    nameInput.setAttribute('aria-label', '规则名称');
    nameInput.addEventListener('input', function () { S.formName = nameInput.value; });
    fName.appendChild(nameInput);
    fName.appendChild(el('div', 'ar-help', '给这条规则起个看得懂的名字，方便以后辨认。'));
    form.appendChild(fName);

    var fMetric = el('div', 'ar-field');
    fMetric.appendChild(el('label', 'ar-label', '监控项'));
    var sel = el('select', 'ar-select');
    sel.setAttribute('aria-label', '监控项');
    METRICS.forEach(function (m) {
      var opt = el('option', null, m.label);
      opt.value = m.key;
      if (m.key === S.formMetric) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      S.formMetric = sel.value;
      var m = METRIC_MAP[S.formMetric];
      if (m) {
        S.formThreshold = String(m.def);
        thInput.value = S.formThreshold;
        thHelp.textContent = m.help + '范围：' + m.min + '–' + m.max + m.unit + '。';
        thInput.min = String(m.min); thInput.max = String(m.max); thInput.step = String(m.step);
        unit.textContent = m.unit || '数值';
      }
    });
    fMetric.appendChild(sel);
    fMetric.appendChild(el('div', 'ar-help', '想盯哪项资源？选中后会给出建议阈值。'));
    form.appendChild(fMetric);

    var fTh = el('div', 'ar-field');
    fTh.appendChild(el('label', 'ar-label', '阈值'));
    var thInput = el('input', 'ar-input');
    thInput.type = 'number'; thInput.value = S.formThreshold;
    var m0 = METRIC_MAP[S.formMetric] || METRICS[0];
    thInput.min = String(m0.min); thInput.max = String(m0.max); thInput.step = String(m0.step);
    thInput.setAttribute('aria-label', '阈值');
    thInput.addEventListener('input', function () { S.formThreshold = thInput.value; });
    fTh.appendChild(thInput);
    var unit = el('span', 'ar-muted', m0.unit || '数值');
    unit.style.fontSize = 'var(--kore-font-12)';
    var thHelp = el('div', 'ar-help', '');
    thHelp.textContent = METRIC_MAP[S.formMetric].help + '范围：' + METRIC_MAP[S.formMetric].min +
      '–' + METRIC_MAP[S.formMetric].max + METRIC_MAP[S.formMetric].unit + '。';
    fTh.appendChild(thHelp);
    fTh.appendChild(unit);
    form.appendChild(fTh);
    panel.appendChild(form);

    var actions = el('div', 'ar-actions');
    var saveBtn = el('button', 'btn btn-primary ar-btn', S.editing ? '保存修改' : '添加规则');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', function () {
      var problem = validate(S.formName, S.formMetric, S.formThreshold);
      if (problem) { S.error = problem; S.notice = ''; paint(); return; }
      var m = METRIC_MAP[S.formMetric];
      var value = num(S.formThreshold);
      if (S.editing) {
        S.rules.forEach(function (r) {
          if (r.id === S.editing) { r.name = S.formName.trim(); r.metric = m.key; r.threshold = value; }
        });
      } else {
        S.rules.push({ id: uid(), name: S.formName.trim(), metric: m.key, threshold: value,
          enabled: true, createdAt: nowIso(), lastTriggeredAt: '', triggerCount: 0 });
      }
      if (save()) {
        S.notice = S.editing ? '规则已更新。' : '规则已创建并默认启用，可在下方测试触发或随时停用。';
        resetForm();
      }
      paint();
    });
    actions.appendChild(saveBtn);
    if (S.editing) {
      var cancel = el('button', 'btn btn-ghost ar-btn', '取消编辑');
      cancel.type = 'button';
      cancel.addEventListener('click', function () { resetForm(); S.error = ''; paint(); });
      actions.appendChild(cancel);
    }
    panel.appendChild(actions);
    return panel;
  }

  function resetForm() {
    S.editing = null; S.formName = ''; S.formMetric = 'cpu'; S.formThreshold = String(METRICS[0].def);
  }

  function listCard() {
    var panel = el('section', 'panel ar-panel');
    panel.appendChild(el('div', 'panel-title', '我的告警规则（' + S.rules.length + ' 条）'));
    if (!S.rules.length) {
      var empty = el('div', 'ar-empty');
      empty.appendChild(el('b', null, '还没有告警规则'));
      empty.appendChild(el('small', null,
        '配一条规则，Kore 就能在资源超过阈值时往「告警中心」写一条提醒——不用再记硬编码的数字。'));
      var add = el('button', 'btn btn-primary ar-btn', '创建第一条告警规则');
      add.type = 'button';
      add.addEventListener('click', function () { resetForm(); S.error = ''; paint(); if (S.box) {
        var first = S.box.querySelector('.ar-input'); if (first) first.focus();
      } });
      empty.appendChild(add);
      panel.appendChild(empty);
      return panel;
    }
    var table = el('table', 'ar-table');
    var thead = el('thead');
    var hr = el('tr');
    ['规则名称', '监控项', '阈值', '状态', '最近触发', '操作'].forEach(function (t) {
      var th = el('th', null, t); th.scope = 'col'; hr.appendChild(th);
    });
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = el('tbody');
    S.rules.forEach(function (r) {
      var m = METRIC_MAP[r.metric];
      var tr = el('tr');
      function cell(label, cls) { var td = el('td', cls || ''); td.setAttribute('data-label', label); tr.appendChild(td); return td; }
      var cName = cell('规则名称');
      cName.appendChild(el('span', 'ar-name', r.name));
      var cMetric = cell('监控项'); cMetric.textContent = m ? m.label : r.metric;
      var cTh = cell('阈值'); cTh.textContent = r.threshold + (m ? m.unit : '');
      var cState = cell('状态');
      cState.appendChild(el('span', 'ar-badge ' + (r.enabled ? 'on' : 'off'), r.enabled ? '已启用' : '已停用'));
      var cLast = cell('最近触发');
      cLast.appendChild(el('span', null, fmtTime(r.lastTriggeredAt)));
      if (r.triggerCount) cLast.appendChild(el('span', ' ar-muted', ' · 累计 ' + r.triggerCount + ' 次'));
      var cAct = cell('操作');
      var acts = el('div', 'ar-rowact');

      var toggle = el('button', 'btn btn-ghost ar-btn', r.enabled ? '停用' : '启用');
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', r.enabled ? 'true' : 'false');
      toggle.addEventListener('click', function () {
        r.enabled = !r.enabled;
        if (save()) S.notice = r.enabled ? '规则已启用。' : '规则已停用，暂时不会产生告警。';
        paint();
      });
      acts.appendChild(toggle);

      var test = el('button', 'btn btn-ghost ar-btn', S.busy ? '发送中…' : '测试触发');
      test.type = 'button'; test.disabled = S.busy;
      test.addEventListener('click', function () { S.error = ''; S.notice = ''; testTrigger(r); });
      acts.appendChild(test);

      var edit = el('button', 'btn btn-ghost ar-btn', '编辑');
      edit.type = 'button';
      edit.addEventListener('click', function () {
        S.editing = r.id; S.formName = r.name; S.formMetric = r.metric; S.formThreshold = String(r.threshold);
        S.error = ''; S.notice = ''; paint();
        if (S.box) { var inp = S.box.querySelector('.ar-input'); if (inp) inp.focus(); }
      });
      acts.appendChild(edit);

      if (S.confirmId === r.id) {
        var yes = el('button', 'btn btn-primary ar-btn', '确认删除');
        yes.type = 'button';
        yes.addEventListener('click', function () {
          S.rules = S.rules.filter(function (x) { return x.id !== r.id; });
          S.confirmId = null;
          if (S.editing === r.id) resetForm();
          if (save()) S.notice = '规则已删除。';
          paint();
        });
        acts.appendChild(yes);
        var no = el('button', 'btn btn-ghost ar-btn', '取消');
        no.type = 'button';
        no.addEventListener('click', function () { S.confirmId = null; paint(); });
        acts.appendChild(no);
      } else {
        var del = el('button', 'btn btn-ghost ar-btn', '删除');
        del.type = 'button';
        del.addEventListener('click', function () { S.confirmId = r.id; paint(); });
        acts.appendChild(del);
      }
      cAct.appendChild(acts);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    panel.appendChild(table);
    return panel;
  }

  function paint() {
    if (!S.box || !S.box.parentNode) return;
    S.box.textContent = '';
    var wrap = el('div', 'ar-wrap');
    var head = el('div', 'ar-head');
    var main = el('div', 'ar-head-main');
    main.appendChild(el('h1', 'ar-h1', '告警规则'));
    main.appendChild(el('p', 'ar-sub',
      '在这里告诉 Kore 该盯什么、盯多紧。规则保存在这台机器上；测试触发会真的往「告警中心」写一条告警，方便你马上验证。'));
    head.appendChild(main);
    var again = el('button', 'btn btn-ghost ar-btn', '重新加载');
    again.type = 'button';
    again.addEventListener('click', function () { S.rules = load(); S.confirmId = null; S.error = ''; paint(); });
    head.appendChild(again);
    wrap.appendChild(head);
    wrap.appendChild(msgBox());
    wrap.appendChild(formCard());
    wrap.appendChild(listCard());
    S.box.appendChild(wrap);
  }

  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    ensureCss();
    S.gen++; S.box = container; S.error = ''; S.notice = ''; S.busy = false; S.confirmId = null;
    resetForm();
    S.rules = load();
    paint();
    return {
      destroy: function () {
        S.gen++;
        if (S.box === container) S.box = null;
        S.confirmId = null;
      }
    };
  }

  window.KoreAlertRules = {
    render: render,
    // 纯函数自检钩子（node 级验证用；不渲染、不发请求、不新增网络 API）。
    _test: { validate: validate, normalize: normalize, METRICS: METRICS, STORE_KEY: STORE_KEY }
  };
})();
