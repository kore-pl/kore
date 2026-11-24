/* kore 主壳 · 配置漂移检测（web/config-drift.js，懒加载视图）——零框架 / 零 CDN / 无外链。
    定位：把已有的两个能力组合成新流程——「当前运行配置 vs 选中的基线快照」主动对比，
    列出被改动的项（插件新增/移除/版本/启停），从操作审计关联"谁在什么时候改了什么"，
    并提供「接受为新基线」（采集当前配置建快照并设为基线）/「回滚到基线」（走 snapshot rollback，二次确认）。
    与 snapshot.js 的区别（不同层，不重复）：snapshot 页是"两个快照手动对比差异"；
    本页是"当前态 vs 基线 + 审计溯源 + 接受/回滚"的检测闭环。

    数据契约全部读自源码，不猜；取不到标「未知」，绝不编造：
      · GET  /api/v1/snapshots → {snapshots:[{id,name,created_at,plugins:[{id,version,enabled,desired}]}]}
              （handlers_snapshots.go snapshotListBody / Snapshot，按 created_at 倒序）
      · GET  /api/v1/snapshots/{id}/diff → {snapshot_id,changes:[{plugin_id,kind,from,to,from_exists,to_exists}]}
              kind ∈ added/removed/version/enabled（handlers_snapshots.go SnapshotDiffItem / diffSnapshots）
      · POST /api/v1/snapshots/{id}/rollback  body {confirm:"yes"} → {snapshot_id,applied,failed}
              （handlers_snapshots.go snapshotRollbackRequest / snapshotRollbackBody；confirm 必须是 "yes"）
      · POST /api/v1/snapshots  body {name} → Snapshot
              （handlers_snapshots.go handleSnapshotsCreate；"接受为新基线"=采集当前配置建快照）
      · GET  /api/v1/audit?since=<RFC3339>&limit=1000&order=desc
              → {records:[{at,subject,action,plugin,target,result,detail:[{key,value}]}],count,limit}
              since 必填、无 offset、上限 1000（handlers_audit.go parseAuditQuery / auditListBody / auditRecordDTO）

    纪律：零轮询（G-19）；写端点 CSRF 双提交（读非 HttpOnly 的 kore_csrf → X-Kore-CSRF 头）；
    危险操作（回滚）页面内二次确认，不用 window.confirm；样式内联注入，不进首屏预算（G-03）；
    手机适配触摸目标 ≥44px（裁决41）；基线选择存 localStorage（前端态，不碰运行态文件 G-29/G-31）。
    对外暴露 window.KoreConfigDrift = { render, _test }；render(container) → {destroy}。 */
(function () {
  'use strict';

  var API = { snapshots: '/api/v1/snapshots', audit: '/api/v1/audit' };
  var STYLE_ID = 'kore-config-drift-css';
  var LS_KEY = 'kore.drift.baseline';
  var AUDIT_LIMIT = 1000;
  var KIND_LABEL = { added: '新增', removed: '移除', version: '版本变化', enabled: '启停变化' };
  var BASELINE_NAME = '漂移基线';

  // 模块生存态：每次 render 重置；destroy 后所有在途请求的回调都走 stale() 短路，不碰已卸载 DOM。
  var S = { root: null, box: null, destroyed: false, snaps: [], baselineId: '', changes: [], audit: [],
    auditErr: '', phase: 'empty', gen: 0, busy: false, confirm: null, resultMsg: '', resultTone: '', msg: '' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function stale(gen) { return S.destroyed || gen !== S.gen || !S.box; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [], i, kv;
    for (i = 0; i < parts.length; i++) {
      kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function fmtTime(v) {
    if (!v) return '未知';
    var d = new Date(v);
    return isNaN(d.getTime()) ? '未知' : d.toLocaleString('zh-CN', { hour12: false });
  }
  function stamp(d) {
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return String(d.getFullYear()) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  // GET：不因 HTTP 状态码 reject，交给调用方判 ok 并标「未知」，绝不编造数据。
  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.text().then(function (raw) {
          var data = {};
          if (raw) { try { data = JSON.parse(raw); } catch (e) { data = {}; } }
          return { ok: res.ok, status: res.status, data: data };
        });
      });
  }
  // 写端点（建快照 / 回滚）：CSRF 双提交；非 2xx 抛带 message 的错误。
  function postJSON(url, body) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少安全令牌，请刷新页面或重新登录'));
    return fetch(url, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.status = res.status; throw err;
        }
        return data;
      });
    });
  }
  function navigate(view) {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate(view);
    else window.location.hash = '#/' + view;
  }
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ---------- 纯函数：差异值展示 + 审计关联（供 node 级自测，_test 钩子） ---------- */
  // 与 snapshot.js 的 diff 展示口径一致：版本加 v 前缀、启停用原值、不存在标"无"。
  function showValue(c, field) {
    var exists = field === 'from' ? c.from_exists : c.to_exists;
    if (!exists) return '无';
    var v = c[field];
    if (v === undefined || v === null || v === '') return '无';
    return c.kind === 'version' ? 'v' + v : String(v);
  }
  // 关联审计：按 plugin_id 在审计记录（order=desc，最新优先）里找最近一条。
  // 取不到 / 字段为空一律标「未知」，不推测、不编造。
  function matchAudit(change, records) {
    var pid = String(change.plugin_id || '');
    var list = Array.isArray(records) ? records : [];
    if (!pid) return { who: '未知', when: '未知', action: '未知' };
    var re = new RegExp('(^|[^a-z0-9-])' + escapeRegExp(pid) + '([^a-z0-9-]|$)', 'i');
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      var fields = [r.plugin, r.target, r.action].concat((r.detail || []).map(function (kv) {
        return (kv && kv.value !== undefined && kv.value !== null) ? String(kv.value) : '';
      }));
      var hit = false;
      for (var j = 0; j < fields.length; j++) {
        if (fields[j] && re.test(String(fields[j]))) { hit = true; break; }
      }
      if (!hit) continue;
      return {
        who: r.subject || '未知',
        when: r.at ? fmtTime(r.at) : '未知',
        action: r.action || '未知',
        target: r.target || r.plugin || '未知'
      };
    }
    return { who: '未知', when: '未知', action: '未知' };
  }

  /* ---------- 内联样式：只作用本页，不进首屏 CSS 预算 ---------- */
  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.kdf-page{max-width:1080px;margin:0 auto;padding:16px;line-height:1.6;}',
      '.kdf-note{background:var(--kore-info-bg,#eef4fb);border:1px solid var(--kore-border-2,#d5dbe2);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;}',
      '.kdf-note b{color:var(--kore-accent,#2b6cb0);}',
      '.kdf-panel{border:1px solid var(--kore-border-2,#d5dbe2);border-radius:8px;padding:16px;margin-bottom:16px;}',
      '.kdf-title{font-weight:700;font-size:15px;margin-bottom:12px;}',
      '.kdf-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}',
      '.kdf-bar label{font-size:13px;color:var(--kore-muted,#6b7280);}',
      '.kdf-select{flex:1 1 260px;min-height:44px;padding:8px 10px;border:1px solid var(--kore-border-2,#d5dbe2);border-radius:6px;font-size:14px;box-sizing:border-box;background:var(--kore-bg-2,#fff);color:var(--kore-text-1,#1f2937);}',
      '.kdf-btn{min-height:44px;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:14px;border:1px solid var(--kore-border-2,#d5dbe2);background:transparent;color:var(--kore-text-1,#1f2937);}',
      '.kdf-btn.primary{background:var(--kore-accent,#2b6cb0);color:#fff;border-color:transparent;}',
      '.kdf-btn.danger{background:#b83232;color:#fff;border-color:transparent;}',
      '.kdf-btn:disabled{opacity:.55;cursor:not-allowed;}',
      '.kdf-msg{min-height:22px;margin-top:10px;font-size:13px;color:var(--kore-muted,#6b7280);}',
      '.kdf-msg.ok{color:#1f7a3d !important;}.kdf-msg.fail{color:#b83232 !important;}',
      '.kdf-banner{border-radius:8px;padding:18px;margin:12px 0;font-size:15px;font-weight:600;text-align:center;}',
      '.kdf-banner.ok{background:#e7f7ed;border:1px solid #8fd4a8;color:#1f7a3d;}',
      '.kdf-banner.warn{background:var(--kore-warning-bg,#fff6f0);border:1px solid #e8c39e;color:#a35b12;}',
      '.kdf-head,.kdf-row{display:grid;grid-template-columns:84px 1.1fr .8fr .8fr 1.7fr;gap:8px;align-items:start;padding:9px 10px;border-radius:6px;font-size:13px;}',
      '.kdf-head{color:var(--kore-muted,#6b7280);font-weight:600;border-bottom:1px solid var(--kore-border-2,#d5dbe2);border-radius:0;}',
      '.kdf-row{background:var(--kore-bg-2,#f7f8fa);margin-top:6px;word-break:break-all;}',
      '.kdf-row .kind{font-weight:600;color:var(--kore-accent,#2b6cb0);}',
      '.kdf-row .trace{font-size:12px;color:var(--kore-text-2,#4b5563);}',
      '.kdf-row .trace .who{color:var(--kore-text-1,#1f2937);}',
      '.kdf-unknown{color:var(--kore-muted,#9aa1ab);font-style:italic;}',
      '.kdf-ops{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;}',
      '.kdf-confirm{border:1px solid #e0a0a0;background:var(--kore-warning-bg,#fff6f0);border-radius:8px;padding:14px 16px;margin-top:14px;}',
      '.kdf-confirm .kdf-title{color:#b83232;}',
      '.kdf-confirm p{margin:4px 0;font-size:13px;}',
      '.kdf-empty{padding:26px;text-align:center;color:var(--kore-muted,#6b7280);border:1px dashed var(--kore-border-2,#d5dbe2);border-radius:8px;}',
      '.kdf-empty .kdf-btn{margin-top:14px;}',
      '@media (max-width:720px){.kdf-page{padding:10px;}.kdf-head{display:none;}',
      '.kdf-row{grid-template-columns:1fr;gap:4px;}.kdf-row>div:before{content:attr(data-label);display:inline-block;min-width:64px;color:var(--kore-muted,#6b7280);font-size:12px;}',
      '.kdf-bar .kdf-select,.kdf-bar .kdf-btn{flex:1 1 100%;}}'
    ].join('');
    var style = el('style'); style.id = STYLE_ID; style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------- 加载 ---------- */
  function loadSnapshots() {
    var gen = S.gen;
    S.phase = 'loading'; S.msg = ''; paintBar(); paintResult();
    return getJSON(API.snapshots).then(function (res) {
      if (stale(gen)) return;
      if (!res.ok) {
        S.snaps = []; S.phase = 'empty';
        S.msg = '读取快照失败（HTTP ' + res.status + '）：请确认已登录且有配置读取权限';
        paintAll(); return;
      }
      S.snaps = Array.isArray(res.data.snapshots) ? res.data.snapshots : [];
      if (!S.snaps.length) {
        S.phase = 'empty'; S.msg = ''; paintAll(); return;
      }
      // 基线默认策略：localStorage 中仍在列表里 → 用它；否则取最新（列表按 created_at 倒序）。
      var saved = '';
      try { saved = window.localStorage.getItem(LS_KEY) || ''; } catch (e) { saved = ''; }
      var found = false;
      for (var i = 0; i < S.snaps.length; i++) if (S.snaps[i].id === saved) { found = true; break; }
      S.baselineId = found ? saved : S.snaps[0].id;
      S.phase = 'idle'; S.msg = ''; paintAll();
    }, function () {
      if (stale(gen)) return;
      S.snaps = []; S.phase = 'empty'; S.msg = '网络不太顺畅，快照列表没有读到'; paintAll();
    });
  }
  function currentBaseline() {
    for (var i = 0; i < S.snaps.length; i++) if (S.snaps[i].id === S.baselineId) return S.snaps[i];
    return null;
  }
  function auditSince() {
    var snap = currentBaseline();
    var iso = snap && snap.created_at ? new Date(snap.created_at).toISOString() : '';
    if (!iso) iso = new Date(Date.now() - 7 * 86400000).toISOString(); // 基线缺时间时退回最近 7 天，不编造基线时间
    return iso;
  }
  function detect() {
    if (S.busy || !S.baselineId) return;
    var gen = S.gen, id = S.baselineId;
    S.busy = true; S.phase = 'detecting'; S.msg = ''; S.confirm = null;
    S.resultMsg = ''; S.auditErr = ''; paintBar(); paintResult(); paintConfirm();
    var url = API.snapshots + '/' + encodeURIComponent(id) + '/diff';
    var auditUrl = API.audit + '?since=' + encodeURIComponent(auditSince()) +
      '&limit=' + AUDIT_LIMIT + '&order=desc';
    Promise.all([
      getJSON(url),
      getJSON(auditUrl).catch(function () { return { ok: false, status: 0, data: {} }; })
    ]).then(function (rs) {
      if (stale(gen) || S.baselineId !== id) return;
      S.busy = false;
      var diffRes = rs[0], auditRes = rs[1];
      if (!diffRes.ok) {
        S.phase = 'error'; S.msg = '读取差异失败（HTTP ' + diffRes.status + '）：请确认基线快照仍存在';
        S.changes = []; paintAll(); return;
      }
      S.changes = Array.isArray(diffRes.data.changes) ? diffRes.data.changes : [];
      if (!auditRes.ok) {
        S.audit = []; S.auditErr = '审计记录暂不可用（HTTP ' + auditRes.status + '），下方溯源均标「未知」';
      } else {
        S.audit = Array.isArray(auditRes.data.records) ? auditRes.data.records : [];
        S.auditErr = '';
      }
      S.phase = 'done'; S.msg = ''; paintAll();
    }, function () {
      if (stale(gen) || S.baselineId !== id) return;
      S.busy = false; S.phase = 'error'; S.msg = '检测未成功，请重试'; S.changes = []; paintAll();
    });
  }

  /* ---------- 接受为新基线 ---------- */
  function acceptBaseline() {
    if (S.busy) return;
    var gen = S.gen;
    S.busy = true; S.msg = '正在采集当前配置…'; paintBar();
    var name = BASELINE_NAME + ' · ' + stamp(new Date());
    postJSON(API.snapshots, { name: name }).then(function (snap) {
      if (stale(gen)) return;
      if (!snap || !snap.id) { S.msg = '新基线已创建，但返回数据异常，请刷新后重新选择'; S.busy = false; paintBar(); return; }
      try { window.localStorage.setItem(LS_KEY, snap.id); } catch (e) { /* 存储不可用不影响本次切换 */ }
      S.baselineId = snap.id; S.busy = false;
      S.resultMsg = '已接受当前配置为新基线，后续检测将以它为参照';
      S.resultTone = 'ok';
      return loadSnapshots().then(function () {
        if (stale(gen)) return;
        S.resultMsg = '已接受当前配置为新基线，后续检测将以它为参照'; S.resultTone = 'ok';
        paintResult();
      });
    }, function (err) {
      if (stale(gen)) return;
      S.busy = false; S.msg = '接受失败：' + err.message + '（需要配置管理权限）'; paintBar();
    });
  }

  /* ---------- 回滚：二次确认 ---------- */
  function openConfirm() {
    if (S.busy) return;
    S.confirm = { id: S.baselineId };
    paintConfirm();
  }
  function closeConfirm() { S.confirm = null; paintConfirm(); }
  function paintConfirm() {
    if (!S.confirmHost || S.destroyed) return;
    S.confirmHost.textContent = '';
    if (!S.confirm) return;
    var snap = currentBaseline();
    var box = add(S.confirmHost, el('section', 'kdf-confirm'));
    add(box, el('div', 'kdf-title', '确认回滚到基线？这会改动当前配置'));
    add(box, el('p', null, '目标基线：「' + ((snap && snap.name) || '未命名快照') + '」（' +
      fmtTime(snap && snap.created_at) + '）'));
    add(box, el('p', null, '会改动什么：把基线里记录的插件启停态恢复到系统（启用未启用的 / 停用已启用的）。'));
    add(box, el('p', null, '不会改动：网站文件、数据库、插件包版本；基线里没有的插件不会被自动卸载。'));
    add(box, el('p', null, '操作不可自动撤销——请先看清上方差异列表。'));
    var ops = add(box, el('div', 'kdf-ops'));
    var yes = add(ops, on(el('button', 'kdf-btn danger', '确认回滚'), doRollback));
    add(ops, on(el('button', 'kdf-btn', '取消'), closeConfirm));
    S.confirmMsg = add(box, el('div', 'kdf-msg'));
    yes.scrollIntoView && yes.scrollIntoView({ block: 'nearest' });
  }
  function doRollback() {
    if (S.busy || !S.confirm) return;
    var gen = S.gen, id = S.confirm.id;
    S.busy = true; S.confirmMsg.textContent = '正在回滚…';
    postJSON(API.snapshots + '/' + encodeURIComponent(id) + '/rollback', { confirm: 'yes' }).then(function (data) {
      if (stale(gen)) return;
      S.busy = false; S.confirm = null; paintConfirm();
      var applied = (data && Array.isArray(data.applied)) ? data.applied.length : 0;
      var failed = (data && Array.isArray(data.failed)) ? data.failed : [];
      S.resultMsg = '回滚完成：改动 ' + applied + ' 项' + (failed.length ? '，跳过/失败 ' + failed.length + ' 项' : '');
      S.resultTone = failed.length ? '' : 'ok';
      S.resultExtra = failed;
      return detect();
    }, function (err) {
      if (stale(gen)) return;
      S.busy = false;
      if (S.confirmMsg) { S.confirmMsg.className = 'kdf-msg fail'; S.confirmMsg.textContent = '回滚失败：' + err.message; }
    });
  }

  /* ---------- 绘制 ---------- */
  function paintBar() {
    if (!S.barHost || S.destroyed) return;
    S.barHost.textContent = '';
    var bar = add(S.barHost, el('div', 'kdf-bar'));
    var label = el('label', null, '基线快照'); label.setAttribute('for', 'kdf-baseline');
    add(bar, label);
    var sel = el('select', 'kdf-select'); sel.id = 'kdf-baseline';
    sel.setAttribute('aria-label', '选择用作对比基线的快照');
    S.snaps.forEach(function (s) {
      var op = el('option', null, (s.name || '未命名快照') + ' · ' + fmtTime(s.created_at) + ' · ' + s.id);
      op.value = s.id; if (s.id === S.baselineId) op.selected = true;
      sel.appendChild(op);
    });
    if (!S.snaps.length) {
      var op0 = el('option', null, '（暂无快照）'); op0.value = ''; sel.appendChild(op0); sel.disabled = true;
    }
    sel.addEventListener('change', function () {
      S.baselineId = sel.value;
      try { window.localStorage.setItem(LS_KEY, sel.value); } catch (e) { /* 忽略 */ }
      S.phase = 'idle'; S.changes = []; S.resultMsg = ''; S.confirm = null;
      paintResult(); paintConfirm();
    });
    add(bar, sel);
    var detectBtn = add(bar, on(el('button', 'kdf-btn primary', S.phase === 'detecting' ? '检测中…' : '检测漂移'), detect));
    detectBtn.disabled = S.busy || !S.baselineId;
    var acceptBtn = add(bar, on(el('button', 'kdf-btn', '接受为新基线'), acceptBaseline));
    acceptBtn.disabled = S.busy || !S.baselineId;
    var rollBtn = add(bar, on(el('button', 'kdf-btn danger', '回滚到基线'), openConfirm));
    rollBtn.disabled = S.busy || !S.baselineId || S.phase !== 'done';
    if (S.msg) { S.msgEl.className = 'kdf-msg' + (S.phase === 'error' || S.phase === 'empty' ? ' fail' : ''); S.msgEl.textContent = S.msg; }
    else { S.msgEl.className = 'kdf-msg'; S.msgEl.textContent = ''; }
  }
  function paintResult() {
    if (!S.resultHost || S.destroyed) return;
    var host = S.resultHost;
    host.textContent = '';
    if (S.auditErr) {
      var an = add(host, el('div', 'kdf-msg fail', S.auditErr));
      an.style.marginBottom = '8px';
    }
    if (S.phase === 'empty') {
      var empty = add(host, el('div', 'kdf-empty'));
      add(empty, el('div', null, '还没有配置快照，无法检测漂移。'));
      add(empty, el('div', null, '先到「配置快照」给当前配置建一个基线，再回来检测谁能看出变化。'));
      var go = add(empty, on(el('button', 'kdf-btn primary', '去建基线快照'), function () { navigate('snapshot'); }));
      go.style.minHeight = '44px';
      return;
    }
    if (S.phase === 'idle') { add(host, el('div', 'kdf-msg', '选好基线后，点「检测漂移」对比当前配置与基线。')); return; }
    if (S.phase === 'loading') { add(host, el('div', 'kdf-msg', '正在加载快照列表…')); return; }
    if (S.phase === 'detecting') { add(host, el('div', 'kdf-msg', '正在对比当前配置与基线，并关联操作审计…')); return; }
    if (S.phase === 'error') { add(host, el('div', 'kdf-msg fail', S.msg || '检测未成功，请重试')); return; }
    if (S.phase !== 'done') return;

    if (S.resultMsg) add(host, el('div', 'kdf-msg' + (S.resultTone === 'ok' ? ' ok' : ''), S.resultMsg));
    if (S.resultExtra && S.resultExtra.length) {
      var fx = add(host, el('div', 'kdf-msg fail', '回滚未能完成的项目：'));
      S.resultExtra.forEach(function (f) {
        add(host, el('div', 'kdf-msg', (f.plugin_id || '?') + ' · ' + (f.action || '?') + '：' + (f.error || '未知原因')));
      });
    }
    if (!S.changes.length) {
      add(host, el('div', 'kdf-banner ok', '✓ 配置与基线一致，未发现漂移'));
      return;
    }
    add(host, el('div', 'kdf-banner warn', '发现 ' + S.changes.length + ' 项配置漂移'));
    var head = add(host, el('div', 'kdf-head'));
    [['变更类型', 'kind'], ['配置项', 'plugin'], ['旧值', 'from'], ['新值', 'to'], ['谁在何时改了什么', 'trace']].forEach(function (c) {
      var d = add(head, el('div', null, c[0])); d.dataset.label = c[0];
    });
    S.changes.forEach(function (c) {
      var row = add(host, el('div', 'kdf-row'));
      var kind = add(row, el('div', 'kind', KIND_LABEL[c.kind] || c.kind || '未知')); kind.dataset.label = '类型';
      var pid = add(row, el('div', null, c.plugin_id || '未知')); pid.dataset.label = '配置项';
      var from = add(row, el('div', null, showValue(c, 'from'))); from.dataset.label = '旧值';
      var to = add(row, el('div', null, showValue(c, 'to'))); to.dataset.label = '新值';
      var a = matchAudit(c, S.audit);
      var trace = add(row, el('div', 'trace')); trace.dataset.label = '溯源';
      var unknown = a.who === '未知' && a.when === '未知' && a.action === '未知';
      if (unknown) {
        add(trace, el('span', 'kdf-unknown', '操作者未知 · 时间未知 · 动作未知（审计无匹配记录）'));
      } else {
        add(trace, el('span', 'who', a.who)); add(trace, el('span', null, ' · ' + a.when + ' · ' + a.action));
      }
    });
  }
  function paintAll() { paintBar(); paintResult(); paintConfirm(); }

  /* ---------- render / destroy ---------- */
  function render(container) {
    if (!container || container.nodeType !== 1) return { destroy: function () {} };
    S = { root: container, box: null, destroyed: false, snaps: [], baselineId: '', changes: [], audit: [],
      auditErr: '', phase: 'empty', gen: S.gen + 1, busy: false, confirm: null, resultMsg: '', resultTone: '', msg: '',
      resultExtra: null };
    injectCSS();
    var page = add(container, el('div', 'kdf-page'));
    S.box = page;
    var note = add(page, el('div', 'kdf-note'));
    add(note, el('b', null, '配置漂移检测是什么？'));
    add(note, el('div', null,
      '给当前配置选一个"快照基线"，一键对比现在改了哪些地方：插件版本、启停态、新增或移除。每条变化尽量关联到操作审计，告诉你谁在什么时候动的。'));
    add(note, el('div', null,
      '确认改动是预期的，就「接受为新基线」；改坏了，就「回滚到基线」（只恢复启停态，不动文件、数据库和插件包）。审计查不到来源时明确标"未知"，不猜。'));
    var barPanel = add(page, el('section', 'kdf-panel'));
    add(barPanel, el('div', 'kdf-title', '选择基线并检测'));
    S.barHost = add(barPanel, el('div'));
    S.msgEl = add(barPanel, el('div', 'kdf-msg'));
    S.resultHost = add(page, el('div'));
    S.confirmHost = add(page, el('div'));
    loadSnapshots();
    return {
      destroy: function () {
        S.destroyed = true;
        if (page && page.parentNode === S.root) S.root.removeChild(page);
      }
    };
  }

  window.KoreConfigDrift = {
    render: render,
    _test: { showValue: showValue, matchAudit: matchAudit, escapeRegExp: escapeRegExp }
  };
})();
