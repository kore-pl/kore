/* kore 主壳 · 日志告警（web/log-alerts.js，懒加载视图，R23 新功能7）——零框架 / 零 CDN / 无外链。
   入口：window.KoreLogAlerts.render(container) → { destroy() }。
   解决什么：用户想让日志里出现 ERROR / panic / timeout 时收到站内告警，但告警中心此前只有
   内核埋点、用户无法自行配置「日志文本命中关键字就告警」的规则——本视图补上这一缺口。

   与 r23-alertrules 的分工（划界写进界面文案，避免混淆）：
   - 告警规则（阈值）：监控指标数值超线（CPU / 内存 / 磁盘等采样）；
   - 本页日志告警：日志文本命中关键字（本视图，数据源 logs 插件 tail/search）。
   两者命中后统一进入现有告警中心，复用 5 分钟去重与 webhook 出站。

   G-19 硬约束（无常驻轮询）：本文件零 setInterval / 零周期 setTimeout / 零 requestAnimationFrame 循环。
   「立即扫描」是用户主动点击的一次请求级动作：经 POST /api/v1/log-alerts/scan 提交刚读取的日志行，
   服务端同步匹配、命中写告警中心。本视图不自行 tail 日志、不起跟随循环；只读日志页已读取的内容。

   数据在 process 内存（重启即清空），界面明示；命中片段由服务端脱敏（G-30），正文一律 textContent，
   不拼 HTML、不 innerHTML；不渲染宿主绝对路径。对外契约与 r23-integration 对齐：
   window.KoreLogAlerts.render(container) → { destroy() }；CSS 内联注入 style#kore-log-alerts-css。 */
(function () {
  'use strict';

  var EP = '/api/v1/log-alerts';
  var LOGS_EP = '/api/v1/invoke/logs/';
  var ALERTS_EP = '/api/v1/alerts';
  var TIMEOUT_MS = 15000;
  var STYLE_ID = 'kore-log-alerts-css';
  var ALL = '*';
  var SEV = { critical: '严重', warning: '警告', info: '提示' };
  var DEFAULT_KEYWORDS = ['ERROR', 'panic', 'timeout']; // 预设优先，点一下即填（易用性§4）

  var S = null;

  function fresh(root) {
    return { root: root, rules: [], hits: [], sources: [], selectedSource: ALL,
      notice: '', error: '', busy: false, scanBusy: false, editingId: '',
      formOpen: false, confirmId: '', confirmText: '', loaded: false, destroyed: false };
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function csrfHeaders() {
    return { 'X-Kore-CSRF': readCookie('kore_csrf'), 'Content-Type': 'application/json',
      Accept: 'application/json' };
  }
  // 所有请求带超时与 AbortController；destroy 时不再发新请求（不轮询、不残留定时器）。
  function request(url, method, body) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var init = { method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: csrfHeaders() };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (ctrl) init.signal = ctrl.signal;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    return fetch(url, init).then(function (res) {
      return res.text().then(function (raw) {
        if (timer !== null) clearTimeout(timer);
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || '';
          throw err;
        }
        return data;
      });
    }, function (err) {
      if (timer !== null) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + ' 秒）');
      throw err;
    });
  }
  // 人话错误 + 怎么办（USABILITY §4）；内部错误码只进 title。
  function plainError(err, fallback) {
    var msg = err && err.message ? String(err.message) : (fallback || '操作未完成');
    return msg.replace(/^E_[A-Z_]+[:：]\s*/, '') + '。怎么办：请重试；仍失败请刷新页面。';
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '—';
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' +
      p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = el('style');
    style.id = STYLE_ID;
    style.textContent =
      '.la-wrap{display:flex;flex-direction:column;gap:var(--kore-space-3);padding:var(--kore-space-3) 0;}' +
      '.la-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2);}' +
      '.la-title{font-size:var(--kore-font-16);font-weight:600;color:var(--kore-text-1);margin-right:auto;}' +
      '.la-note{font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.55;}' +
      '.la-boundary{padding:var(--kore-space-2) var(--kore-space-3);background:var(--kore-bg-2);' +
      'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);' +
      'font-size:var(--kore-font-12);color:var(--kore-text-2);line-height:1.6;}' +
      '.la-panel{padding:var(--kore-space-3);background:var(--kore-bg-1);' +
      'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);}' +
      '.la-panel-title{font-size:var(--kore-font-14);font-weight:600;color:var(--kore-text-1);' +
      'margin-bottom:var(--kore-space-2);}' +
      '.la-table{width:100%;border-collapse:collapse;font-size:var(--kore-font-12);}' +
      '.la-table th,.la-table td{padding:var(--kore-space-2);text-align:left;' +
      'border-bottom:1px solid var(--kore-border-1);color:var(--kore-text-2);vertical-align:top;}' +
      '.la-table th{font-weight:600;color:var(--kore-text-3);white-space:nowrap;}' +
      '.la-table td.la-kw{color:var(--kore-text-1);font-weight:600;word-break:break-all;}' +
      '.la-sev{display:inline-block;padding:1px 6px;border-radius:999px;font-size:var(--kore-font-12);' +
      'border:1px solid var(--kore-border-1);}' +
      '.la-sev.critical{color:var(--kore-danger);border-color:var(--kore-danger);}' +
      '.la-sev.warning{color:var(--kore-warning);border-color:var(--kore-warning);}' +
      '.la-sev.info{color:var(--kore-info);border-color:var(--kore-info);}' +
      '.la-tag{display:inline-block;padding:1px 6px;border-radius:999px;font-size:var(--kore-font-12);' +
      'color:var(--kore-text-3);background:var(--kore-bg-2);}' +
      '.la-tag.on{color:var(--kore-ok,var(--kore-info));}' +
      '.la-actions{display:flex;flex-wrap:wrap;gap:var(--kore-space-1);}' +
      '.la-action{min-height:32px;padding:0 var(--kore-space-2);color:var(--kore-text-2);background:var(--kore-bg-0);' +
      'border:1px solid var(--kore-border-1);border-radius:var(--kore-radius-control);' +
      'font:inherit;font-size:var(--kore-font-12);cursor:pointer;}' +
      '.la-action:hover{border-color:var(--kore-info);}' +
      '.la-action.danger:hover{border-color:var(--kore-danger);color:var(--kore-danger);}' +
      '.la-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--kore-space-2);' +
      'margin-bottom:var(--kore-space-2);}' +
      '.la-field{flex:1 1 180px;display:flex;flex-direction:column;gap:2px;}' +
      '.la-field>span{font-size:var(--kore-font-12);color:var(--kore-text-1);}' +
      '.la-field>small{font-size:var(--kore-font-12);color:var(--kore-text-3);line-height:1.4;}' +
      '.la-field input,.la-field select{min-height:36px;padding:0 var(--kore-space-1);color:var(--kore-text-1);' +
      'background:var(--kore-bg-0);border:1px solid var(--kore-border-1);' +
      'border-radius:var(--kore-radius-control);font:inherit;font-size:var(--kore-font-12);}' +
      '.la-field input[type=checkbox]{flex:none;width:20px;height:20px;min-height:20px;}' +
      '.la-check{flex-direction:row;align-items:center;gap:var(--kore-space-1);}' +
      '.la-presets{display:inline-flex;flex-wrap:wrap;gap:var(--kore-space-1);align-items:center;}' +
      '.la-preset{min-height:32px;padding:0 var(--kore-space-2);background:var(--kore-bg-0);' +
      'border:1px dashed var(--kore-border-1);border-radius:999px;font:inherit;font-size:var(--kore-font-12);' +
      'color:var(--kore-text-2);cursor:pointer;}' +
      '.la-form-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:var(--kore-space-2);' +
      'margin-top:var(--kore-space-2);}' +
      '.la-empty{padding:var(--kore-space-5) var(--kore-space-3);text-align:center;color:var(--kore-text-3);}' +
      '.la-empty b{display:block;font-size:var(--kore-font-14);color:var(--kore-text-1);' +
      'margin-bottom:var(--kore-space-1);}' +
      '.la-empty small{display:block;margin-bottom:var(--kore-space-2);line-height:1.6;}' +
      '.la-notice{font-size:var(--kore-font-12);color:var(--kore-ok,var(--kore-info));line-height:1.5;}' +
      '.la-error{font-size:var(--kore-font-12);color:var(--kore-danger);line-height:1.5;' +
      'padding:var(--kore-space-1) var(--kore-space-2);background:var(--kore-bg-2);' +
      'border-left:3px solid var(--kore-danger);border-radius:var(--kore-radius-control);}' +
      '.la-snippet{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
      'font-size:var(--kore-font-12);word-break:break-all;max-width:360px;}' +
      '.la-confirm{padding:var(--kore-space-2);margin-bottom:var(--kore-space-2);' +
      'background:var(--kore-bg-2);border:1px solid var(--kore-danger);' +
      'border-radius:var(--kore-radius-control);font-size:var(--kore-font-12);line-height:1.6;}' +
      '@media (pointer:coarse),(max-width:639px){' +
      '.la-action,.la-preset,.la-form-actions .btn{min-height:44px;}' +
      '.la-field input,.la-field select{min-height:44px;}' +
      '.la-field input[type=checkbox]{min-height:20px;}' +
      '.la-table th,.la-table td{padding:var(--kore-space-1);font-size:var(--kore-font-12);}' +
      '.la-snippet{max-width:100%;}}';
    document.head.appendChild(style);
  }

  // ===== 数据加载 =====
  function loadAll() {
    if (!S || S.destroyed) return;
    var gotRules = false, gotSources = false;
    function paint() { if (S && !S.destroyed && gotRules && gotSources) renderBody(); }
    request(EP, 'GET').then(function (d) {
      if (!S || S.destroyed) return;
      S.rules = d.rules || []; S.hits = d.hits || []; S.loaded = true;
      gotRules = true; paint();
    }, function (err) {
      if (!S || S.destroyed) return;
      S.error = '规则读取失败：' + plainError(err, '规则读取失败');
      S.loaded = true; gotRules = true; paint();
    });
    // 来源下拉：复用 logs.sources 请求级读取，不在本视图起跟随循环（G-19）。
    request(LOGS_EP + 'logs.sources', 'POST', {}).then(function (d) {
      if (!S || S.destroyed) return;
      S.sources = (d.sources || []).map(function (x) { return x.name; }).filter(Boolean);
      gotSources = true; paint();
    }, function () {
      if (!S || S.destroyed) return;
      S.sources = []; gotSources = true; paint(); // 来源读不到也能配置通配规则，不阻塞
    });
  }

  // ===== 规则表单 =====
  function openForm(rule) {
    if (!S || S.destroyed) return;
    S.editingId = rule ? rule.ID : '';
    S.formOpen = true;
    renderBody();
  }
  function closeForm() { S.editingId = ''; S.formOpen = false; renderBody(); }

  function submitForm(keyword, source, severity, enabled) {
    if (!S || S.destroyed || S.busy) return;
    var kw = String(keyword || '').trim();
    if (!kw) { S.error = '请先填写关键字，例如 ERROR。怎么办：输入日志里真实出现过的文本。'; renderBody(); return; }
    var body = { keyword: kw, source: source || ALL, severity: severity, enabled: !!enabled };
    var editing = S.editingId;
    S.busy = true; S.error = ''; renderBody();
    var url = editing ? EP + '/' + encodeURIComponent(editing) : EP;
    request(url, editing ? 'PUT' : 'POST', body).then(function () {
      if (!S || S.destroyed) return;
      S.busy = false; S.formOpen = false; S.editingId = '';
      S.notice = editing ? '规则已更新并立即生效' : '规则已创建并立即生效';
      loadAll();
    }, function (err) {
      if (!S || S.destroyed) return;
      S.busy = false;
      S.error = (editing ? '更新失败：' : '新增失败：') + plainError(err, '保存失败');
      renderBody();
    });
  }

  function toggleRule(rule) {
    if (!S || S.destroyed || S.busy) return;
    S.busy = true; S.error = '';
    var body = { keyword: rule.Keyword, source: rule.Source, severity: rule.Severity, enabled: !rule.Enabled };
    request(EP + '/' + encodeURIComponent(rule.ID), 'PUT', body).then(function () {
      if (!S || S.destroyed) return;
      S.busy = false; S.notice = rule.Enabled ? '规则已停用' : '规则已启用'; loadAll();
    }, function (err) {
      if (!S || S.destroyed) return;
      S.busy = false; S.error = '切换失败：' + plainError(err, '切换失败'); renderBody();
    });
  }

  function askDelete(rule) {
    if (!S || S.destroyed) return;
    S.confirmId = rule.ID;
    S.confirmText = '「' + rule.Keyword + '」';
    renderBody();
  }
  function doDelete() {
    if (!S || S.destroyed || S.busy || !S.confirmId) return;
    S.busy = true; S.error = '';
    request(EP + '/' + encodeURIComponent(S.confirmId), 'DELETE').then(function () {
      if (!S || S.destroyed) return;
      S.busy = false; S.confirmId = ''; S.notice = '规则已删除（命中历史保留供回溯）'; loadAll();
    }, function (err) {
      if (!S || S.destroyed) return;
      S.busy = false; S.error = '删除失败：' + plainError(err, '删除失败'); renderBody();
    });
  }

  // ===== 立即扫描（请求级，唯一命中检测入口）=====
  // 从 logs.tail 请求级读取当前来源的最近日志行，提交给后端匹配；无 setInterval。
  function scanNow() {
    if (!S || S.destroyed || S.scanBusy) return;
    var src = S.selectedSource === ALL ? (S.sources[0] || '') : S.selectedSource;
    if (!src) {
      S.error = '还没有可扫描的日志来源。怎么办：请先在「日志」页配置来源，或新建规则后到日志页读取内容再回来扫描。';
      renderBody(); return;
    }
    S.scanBusy = true; S.error = ''; S.notice = ''; renderBody();
    request(LOGS_EP + 'logs.tail', 'POST', { source: src, lines: 200 }).then(function (d) {
      if (!S || S.destroyed) return;
      var entries = d.entries || [];
      var lines = entries.map(function (x, i) {
        return { line_no: x.line_no || (i + 1), text: String(x.text != null ? x.text : x) };
      });
      if (!lines.length) {
        S.scanBusy = false;
        S.notice = '日志来源「' + src + '」当前没有可扫描的行'; renderBody(); return;
      }
      return request(EP + '/scan', 'POST', { source: src, lines: lines }).then(function (res) {
        if (!S || S.destroyed) return;
        S.scanBusy = false;
        S.notice = '已扫描 ' + (res.scanned || 0) + ' 行，命中 ' + (res.matched || 0) + ' 条' +
          ((res.matched || 0) ? '，已写入告警中心' : '');
        if (res.note) S.notice += '；' + res.note;
        loadAll(); // 刷新命中次数与历史
      });
    }, function (err) {
      if (!S || S.destroyed) return;
      S.scanBusy = false;
      S.error = '扫描失败：' + plainError(err, '扫描失败'); renderBody();
    }).catch(function (err) {
      if (!S || S.destroyed) return;
      S.scanBusy = false;
      S.error = '扫描失败：' + plainError(err, '扫描失败'); renderBody();
    });
  }

  // ===== 渲染 =====
  function emptyState(host, title, text, actionText, action) {
    var box = add(host, el('div', 'la-empty'));
    add(box, el('b', null, title));
    add(box, el('small', null, text));
    if (actionText) {
      var btn = add(box, el('button', 'btn', actionText));
      btn.type = 'button'; on(btn, action);
    }
  }

  function renderForm(host) {
    if (!S.formOpen) return;
    var rule = null;
    if (S.editingId) {
      for (var i = 0; i < S.rules.length; i++) {
        if (S.rules[i].ID === S.editingId) { rule = S.rules[i]; break; }
      }
    }
    var box = add(host, el('section', 'la-panel'));
    add(box, el('div', 'la-panel-title', rule ? '编辑规则' : '新增规则'));

    var kwRow = add(box, el('div', 'la-row'));
    var kwField = add(kwRow, el('label', 'la-field'));
    add(kwField, el('span', null, '匹配关键字'));
    var kw = add(kwField, el('input'));
    kw.type = 'text'; kw.value = rule ? rule.Keyword : '';
    kw.placeholder = '例如 ERROR、panic、timeout'; kw.maxLength = 128;
    kw.setAttribute('aria-label', '匹配关键字');
    add(kwField, el('small', null, '日志行包含这个词就命中；不区分大小写。'));

    var presetWrap = add(kwRow, el('div', 'la-field'));
    add(presetWrap, el('span', null, '常用关键字（点一下填入）'));
    var presets = add(presetWrap, el('div', 'la-presets'));
    DEFAULT_KEYWORDS.forEach(function (word) {
      var btn = add(presets, el('button', 'la-preset', word));
      btn.type = 'button';
      on(btn, function () { kw.value = word; kw.focus(); });
    });

    var row2 = add(box, el('div', 'la-row'));
    var srcField = add(row2, el('label', 'la-field'));
    add(srcField, el('span', null, '日志来源'));
    var src = add(srcField, el('select'));
    src.setAttribute('aria-label', '日志来源');
    var opts = [ALL].concat(S.sources);
    opts.forEach(function (name) {
      var o = add(src, el('option', null, name === ALL ? '所有来源' : name));
      o.value = name;
      if (rule ? rule.Source === name : S.selectedSource === name) o.selected = true;
    });
    add(srcField, el('small', null, '只检查这个来源；来源列表来自日志页，读不到时可选「所有来源」。'));

    var sevField = add(row2, el('label', 'la-field'));
    add(sevField, el('span', null, '严重级别'));
    var sev = add(sevField, el('select'));
    sev.setAttribute('aria-label', '严重级别');
    ['critical', 'warning', 'info'].forEach(function (key) {
      var o = add(sev, el('option', null, SEV[key] + '（' + key + '）'));
      o.value = key;
      if (rule ? rule.Severity === key : key === 'warning') o.selected = true;
    });
    add(sevField, el('small', null, '命中后告警中心显示的颜色等级；严重会推送通知通道。'));

    var enabledField = add(row2, el('label', 'la-field la-check'));
    var enabled = add(enabledField, el('input'));
    enabled.type = 'checkbox'; enabled.checked = rule ? rule.Enabled : true;
    enabled.id = 'la-enabled';
    add(enabledField, el('span', null, '启用'));
    add(enabledField, el('small', null, '停用后不参与扫描，历史命中次数保留。'));

    var actions = add(box, el('div', 'la-form-actions'));
    var cancel = add(actions, el('button', 'btn btn-ghost', '取消'));
    cancel.type = 'button'; on(cancel, closeForm);
    var save = add(actions, el('button', 'btn', S.busy ? '保存中…' : '保存规则'));
    save.type = 'button'; save.disabled = S.busy;
    on(save, function () { submitForm(kw.value, src.value, sev.value, enabled.checked); });
  }

  function renderRules(host) {
    var panel = add(host, el('section', 'la-panel'));
    var head = add(panel, el('div', 'la-head'));
    add(head, el('div', 'la-panel-title', '告警规则'));
    var addBtn = add(head, el('button', 'btn', '新增规则'));
    addBtn.type = 'button'; on(addBtn, function () { openForm(null); });

    if (!S.rules.length) {
      emptyState(panel, '还没有日志告警规则',
        '配置一条规则后，在日志页读到含关键字的行、点本页「立即扫描」就能收到站内告警。',
        '新增第一条规则', function () { openForm(null); });
      return;
    }
    var table = add(panel, el('table', 'la-table'));
    var thead = add(table, el('thead'));
    var hr = add(thead, el('tr'));
    ['关键字', '来源', '级别', '状态', '命中次数', '操作'].forEach(function (h) {
      add(hr, el('th', null, h));
    });
    var tbody = add(table, el('tbody'));
    S.rules.forEach(function (rule) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', 'la-kw', rule.Keyword));
      add(tr, el('td', null, rule.Source === ALL ? '所有来源' : rule.Source));
      var sevCell = add(tr, el('td'));
      add(sevCell, el('span', 'la-sev ' + rule.Severity, SEV[rule.Severity] || rule.Severity));
      var stCell = add(tr, el('td'));
      add(stCell, el('span', 'la-tag' + (rule.Enabled ? ' on' : ''), rule.Enabled ? '已启用' : '已停用'));
      add(tr, el('td', null, String(rule.HitCount || 0) + ' 次'));
      var act = add(tr, el('td'));
      var acts = add(act, el('div', 'la-actions'));
      var toggle = add(acts, el('button', 'la-action', rule.Enabled ? '停用' : '启用'));
      toggle.type = 'button'; on(toggle, function () { toggleRule(rule); });
      var edit = add(acts, el('button', 'la-action', '编辑'));
      edit.type = 'button'; on(edit, function () { openForm(rule); });
      var del = add(acts, el('button', 'la-action danger', '删除'));
      del.type = 'button'; on(del, function () { askDelete(rule); });

      if (S.confirmId === rule.ID) {
        var confirm = add(tr, el('td'));
        confirm.colSpan = 6;
        var box = add(confirm, el('div', 'la-confirm'));
        add(box, el('div', null, '确认删除规则' + S.confirmText + '？删除后无法恢复；命中历史会保留。'));
        var yes = add(box, el('button', 'btn', S.busy ? '删除中…' : '确认删除'));
        yes.type = 'button'; yes.disabled = S.busy; on(yes, doDelete);
        var no = add(box, el('button', 'btn btn-ghost', '取消'));
        no.type = 'button'; on(no, function () { S.confirmId = ''; renderBody(); });
      }
    });
  }

  function renderHits(host) {
    var panel = add(host, el('section', 'la-panel'));
    var head = add(panel, el('div', 'la-head'));
    add(head, el('div', 'la-panel-title', '最近命中'));
    var srcField = add(head, el('div', 'la-field'));
    var src = add(srcField, el('select'));
    src.setAttribute('aria-label', '扫描来源');
    var opts = [ALL].concat(S.sources);
    opts.forEach(function (name) {
      var o = add(src, el('option', null, name === ALL ? '所有来源' : name));
      o.value = name;
      if (S.selectedSource === name) o.selected = true;
    });
    on(src, function () { S.selectedSource = src.value; });
    var scanBtn = add(head, el('button', 'btn', S.scanBusy ? '扫描中…' : '立即扫描'));
    scanBtn.type = 'button'; scanBtn.disabled = S.scanBusy; on(scanBtn, scanNow);
    add(panel, el('div', 'la-note',
      '扫描是一次性动作：只读取日志页当前可读取的最近 200 行做匹配，不会在后台持续跟随日志。'));

    if (!S.hits.length) {
      emptyState(panel, '还没有命中记录',
        '配置关键字规则后点「立即扫描」；命中行会自动脱敏后出现在这里，并同步进告警中心。', '', null);
      return;
    }
    var table = add(panel, el('table', 'la-table'));
    var thead = add(table, el('thead'));
    var hr = add(thead, el('tr'));
    ['时间', '来源', '关键字', '匹配行片段（已脱敏）'].forEach(function (h) { add(hr, el('th', null, h)); });
    var tbody = add(table, el('tbody'));
    S.hits.slice(0, 50).forEach(function (hit) {
      var tr = add(tbody, el('tr'));
      add(tr, el('td', null, fmtTime(hit.At)));
      add(tr, el('td', null, hit.Source + ' · 第 ' + (hit.LineNo || 0) + ' 行'));
      add(tr, el('td', null, hit.Keyword));
      add(tr, el('td', 'la-snippet', hit.Snippet || ''));
    });
    var link = add(panel, el('div', 'la-note', '告警中心的同类记录可在顶部铃铛里查看。'));
    link.style.marginTop = 'var(--kore-space-2)';
  }

  function renderBody() {
    if (!S || S.destroyed || !S.root) return;
    var root = S.root;
    root.textContent = '';
    ensureStyles();
    var wrap = add(root, el('div', 'la-wrap'));
    var head = add(wrap, el('div', 'la-head'));
    add(head, el('div', 'la-title', '日志告警'));
    var openAlerts = add(head, el('button', 'la-action', '打开告警中心'));
    openAlerts.type = 'button';
    on(openAlerts, function () {
      if (window.KoreAlerts && typeof window.KoreAlerts.open === 'function') window.KoreAlerts.open();
    });

    add(wrap, el('div', 'la-boundary',
      '这里配置「日志文本命中关键字就告警」，和「告警规则」页的监控指标阈值（CPU / 内存 / 磁盘）是两种不同规则。' +
      '规则保存在当前进程内存中，重启后需重新配置；命中片段已脱敏。'));

    if (S.notice) add(wrap, el('div', 'la-notice', S.notice));
    if (S.error) add(wrap, el('div', 'la-error', S.error));

    if (!S.loaded) {
      add(wrap, el('div', 'la-note', '正在读取规则…'));
      return;
    }
    if (S.formOpen) renderForm(wrap);
    renderRules(wrap);
    renderHits(wrap);
  }

  window.KoreLogAlerts = {
    render: function (container) {
      if (!container) throw new Error('日志告警视图需要一个容器元素');
      S = fresh(container);
      renderBody();
      loadAll();
      return {
        destroy: function () {
          if (!S) return;
          S.destroyed = true;
          if (S.root) S.root.textContent = '';
          var style = document.getElementById(STYLE_ID);
          if (style && style.parentNode) style.parentNode.removeChild(style);
          S = null;
        }
      };
    }
  };
})();
