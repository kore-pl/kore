/* kore 主壳 · 配置快照 / 时光机（web/snapshot.js）——零框架 / 零 CDN / 无外链。
   与 backup 插件的区别（UI 反复讲清楚，避免用户混淆）：
     · 备份（文件 / 数据库）= 把"数据本身"打包成归档，恢复的是文件内容；
     · 配置快照（本页）= 只记录"装了哪些插件、什么版本、启停态、关键路径"这几项配置元数据，
       回滚的是配置状态，不碰任何用户数据、不恢复文件、不替换插件包。
   存储：快照 JSON 落 <state_dir>/snapshots/（内核 state 目录内，G-31 零侵入，不写安装目录外）。
   调用形态：window.KoreSnapshot.render(container) → 返回 { destroy() }；懒加载由主壳 shell 注入。
   API：GET/POST /api/v1/snapshots、GET .../diff、POST .../rollback、DELETE .../{id}；
   CSRF 双提交（kore_csrf 非 HttpOnly cookie → X-Kore-CSRF 头）；危险操作页面内二次确认，不用 window.confirm。 */
(function () {
  'use strict';
  var API = '/api/v1/snapshots';
  var MAX_NAME = 60;

  function fresh() {
    return { root: null, destroyed: false, list: [], listHost: null, status: null, statusTone: '',
      nameInput: null, creating: false, diffHost: null, diffFor: null, confirm: null, confirmHost: null,
      resultHost: null, busy: false };
  }
  var S = fresh();

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function request(url, method, body) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    var init = {
      method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Kore-CSRF': token }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || ''; throw err;
        }
        return data;
      });
    });
  }
  function setStatus(text, tone) {
    if (!S.status) return;
    S.status.textContent = text || '';
    S.status.className = 'snap-status ' + (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    dot.classList.add(tone); c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  function panel(parent, title, meta) {
    var p = add(parent, el('section', 'panel')), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    if (meta) add(h, el('span', 'panel-meta', meta));
    return p;
  }

  // 内联样式：只作用于本页，不进首屏 style.css 预算；手机断点触摸目标 ≥44px（裁决41）。
  function injectCSS() {
    if (document.getElementById('snap-style')) return;
    var css = [
      '.snap-page{max-width:900px;margin:0 auto;padding:16px;}',
      '.snap-note{background:var(--kore-info-bg,#eef4fb);border:1px solid var(--kore-border-2,#d5dbe2);border-radius:8px;padding:12px 16px;margin-bottom:16px;line-height:1.7;font-size:13px;}',
      '.snap-note b{color:var(--kore-accent,#2b6cb0);}',
      '.snap-status{min-height:22px;margin:10px 0;font-size:13px;}',
      '.snap-form{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:4px;}',
      '.snap-form input{flex:1 1 260px;min-height:44px;padding:8px 12px;border:1px solid var(--kore-border-2,#d5dbe2);border-radius:6px;font-size:14px;box-sizing:border-box;}',
      '.snap-form button,.snap-row button,.snap-confirm button{min-height:44px;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:14px;}',
      '.snap-primary{background:var(--kore-accent,#2b6cb0);color:#fff;border:1px solid transparent;}',
      '.snap-ghost{background:transparent;border:1px solid var(--kore-border-2,#d5dbe2);}',
      '.snap-danger{background:#b83232;color:#fff;border:1px solid transparent;}',
      '.snap-list{display:flex;flex-direction:column;gap:8px;margin-top:8px;}',
      '.snap-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--kore-border-2,#d5dbe2);border-radius:8px;}',
      '.snap-row-main{flex:1 1 280px;min-width:0;}',
      '.snap-row-name{font-weight:600;font-size:15px;word-break:break-all;}',
      '.snap-row-meta{font-size:12px;color:var(--kore-muted,#6b7280);margin-top:4px;}',
      '.snap-ops{display:flex;gap:8px;flex-wrap:wrap;}',
      '.snap-empty{padding:24px;text-align:center;color:var(--kore-muted,#6b7280);border:1px dashed var(--kore-border-2,#d5dbe2);border-radius:8px;}',
      '.snap-diff{display:flex;flex-direction:column;gap:6px;margin-top:10px;}',
      '.snap-diff-row{display:flex;gap:8px;flex-wrap:wrap;padding:8px 10px;background:var(--kore-bg-2,#f7f8fa);border-radius:6px;font-size:13px;}',
      '.snap-diff-kind{font-weight:600;color:var(--kore-accent,#2b6cb0);min-width:64px;}',
      '.snap-confirm{border:1px solid #e0a0a0;background:var(--kore-warning-bg,#fff6f0);border-radius:8px;padding:14px 16px;margin-top:14px;}',
      '.snap-confirm-title{font-weight:700;color:#b83232;margin-bottom:8px;}',
      '.snap-confirm-body{font-size:13px;line-height:1.7;}',
      '.snap-confirm-ops{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;}',
      '.row-note-fail{color:#b83232 !important;}.row-note-ok{color:#1f7a3d !important;}.muted{color:var(--kore-muted,#6b7280);}',
      '@media (max-width:640px){.snap-page{padding:10px;}.snap-row{flex-direction:column;align-items:stretch;}.snap-ops{width:100%;}.snap-ops button{flex:1 1 auto;}.snap-form input{flex-basis:100%;}}'
    ].join('');
    var style = el('style');
    style.id = 'snap-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- 列表 ----------
  function loadList() {
    if (S.destroyed) return Promise.resolve();
    setStatus('正在加载快照列表…');
    return request(API).then(function (data) {
      if (S.destroyed) return;
      S.list = data.snapshots || [];
      paintList();
      setStatus('', '');
    }, function (err) {
      if (S.destroyed) return;
      setStatus('加载失败：' + err.message, 'fail');
      paintList();
    });
  }

  function paintList() {
    if (!S.listHost || S.destroyed) return;
    S.listHost.textContent = '';
    if (!S.list.length) {
      var empty = add(S.listHost, el('div', 'snap-empty',
        '还没有配置快照。上面输入一个名字（例如「装 WordPress 前」），点「创建快照」即可给当前配置留一颗后悔药。'));
      var hint = add(empty, el('div', 'snap-row-meta',
        '提示：这是配置快照，不备份网站文件 / 数据库；要打包数据请去「文件 → 备份」。'));
      hint.style.marginTop = '8px';
      return;
    }
    S.list.forEach(function (snap) {
      var row = add(S.listHost, el('div', 'snap-row'));
      var main = add(row, el('div', 'snap-row-main'));
      add(main, el('div', 'snap-row-name', snap.name || '未命名快照'));
      var count = snap.plugins ? snap.plugins.length : 0;
      add(main, el('div', 'snap-row-meta',
        fmtTime(snap.created_at) + ' · ' + count + ' 个插件 · 编号 ' + snap.id));
      var ops = add(row, el('div', 'snap-ops'));
      on(add(ops, el('button', 'snap-ghost', '对比差异')), function () { openDiff(snap); });
      on(add(ops, el('button', 'snap-primary', '回滚到此快照')), function () { openConfirm(snap, 'rollback'); });
      on(add(ops, el('button', 'snap-ghost', '删除')), function () { openConfirm(snap, 'delete'); });
    });
  }

  // ---------- 创建 ----------
  function createSnapshot() {
    if (S.creating) return;
    var name = (S.nameInput.value || '').trim();
    if (!name) { setStatus('请先填快照名称，例如「装 WordPress 前」', 'fail'); S.nameInput.focus(); return; }
    if (Array.from(name).length > MAX_NAME) { setStatus('名称过长（最多 ' + MAX_NAME + ' 字）', 'fail'); return; }
    S.creating = true;
    setStatus('正在创建快照…');
    request(API, 'POST', { name: name }).then(function (snap) {
      if (S.destroyed) return;
      S.nameInput.value = '';
      setStatus('已创建快照「' + snap.name + '」，记录 ' + (snap.plugins ? snap.plugins.length : 0) + ' 个插件', 'ok');
      return loadList();
    }, function (err) {
      if (S.destroyed) return;
      setStatus('创建失败：' + err.message, 'fail');
    }).then(function () { S.creating = false; });
  }

  // ---------- 差异对比 ----------
  function openDiff(snap) {
    if (S.destroyed) return;
    S.diffFor = snap.id;
    S.diffHost.textContent = '';
    var head = add(S.diffHost, el('div', 'snap-confirm-title', '「' + (snap.name || '未命名快照') + '」与当前配置的差异'));
    add(S.diffHost, el('div', 'snap-confirm-body',
      '下面是"快照时的配置 → 现在配置"。回滚会把启停态改回快照时的值；版本变化不会自动降级/升级，请到软件商店处理。'));
    var host = add(S.diffHost, el('div', 'snap-diff'));
    add(host, el('div', 'snap-diff-row', '正在读取差异…'));
    S.diffHost.scrollIntoView({ block: 'nearest' });
    request(API + '/' + encodeURIComponent(snap.id) + '/diff').then(function (data) {
      if (S.destroyed || S.diffFor !== snap.id) return;
      host.textContent = '';
      if (!data.changes || !data.changes.length) {
        add(host, el('div', 'snap-diff-row', '当前配置与该快照一致，无需回滚。'));
        return;
      }
      var LABEL = { added: '新增插件', removed: '少了插件', version: '版本变化', enabled: '启停变化' };
      data.changes.forEach(function (c) {
        var r = add(host, el('div', 'snap-diff-row'));
        add(r, el('span', 'snap-diff-kind', LABEL[c.kind] || c.kind));
        add(r, el('span', null, c.plugin_id));
        var from = c.from_exists ? (c.kind === 'enabled' ? c.from : 'v' + c.from) : '无';
        var to = c.to_exists ? (c.kind === 'enabled' ? c.to : 'v' + c.to) : '无';
        add(r, el('span', null, from + ' → ' + to));
      });
    }, function (err) {
      if (S.destroyed || S.diffFor !== snap.id) return;
      host.textContent = '';
      add(host, el('div', 'row-note-fail', '读取差异失败：' + err.message));
    });
  }

  // ---------- 二次确认（回滚 / 删除） ----------
  function openConfirm(snap, kind) {
    if (S.destroyed) return;
    S.confirm = { snap: snap, kind: kind };
    paintConfirm();
  }
  function closeConfirm() { S.confirm = null; if (S.confirmHost) S.confirmHost.textContent = ''; }
  function paintConfirm() {
    if (!S.confirmHost || S.destroyed) return;
    S.confirmHost.textContent = '';
    if (!S.confirm) return;
    var c = S.confirm, snap = c.snap;
    var box = add(S.confirmHost, el('section', 'snap-confirm'));
    add(box, el('div', 'snap-confirm-title',
      c.kind === 'rollback' ? '确认回滚？这会改动当前配置' : '确认删除这个快照？'));
    var body = add(box, el('div', 'snap-confirm-body'));
    if (c.kind === 'rollback') {
      add(body, el('div', null, '目标快照：「' + (snap.name || '未命名快照') + '」（' + fmtTime(snap.created_at) + '）'));
      add(body, el('div', null, '会改动什么：把快照里记录的插件启停态恢复到系统（启用未启用 / 停用已启用）。'));
      add(body, el('div', null, '不会改动：网站文件、数据库、插件包版本；快照里没有的插件不会被自动卸载。'));
      add(body, el('div', null, '操作不可自动撤销——回滚前请先「对比差异」看清将改动哪些插件。'));
    } else {
      add(body, el('div', null, '将永久删除快照「' + (snap.name || '未命名快照') + '」，此操作不可恢复。'));
    }
    var ops = add(box, el('div', 'snap-confirm-ops'));
    var yes = add(ops, el('button', c.kind === 'rollback' ? 'snap-danger' : 'snap-primary',
      c.kind === 'rollback' ? '确认回滚' : '确认删除'));
    add(ops, on(el('button', 'snap-ghost', '取消'), closeConfirm));
    var msg = add(box, el('div', 'snap-status'));
    on(yes, function () {
      if (S.busy) return;
      S.busy = true; yes.disabled = true;
      msg.textContent = '正在执行…'; msg.className = 'snap-status';
      var p = c.kind === 'rollback'
        ? request(API + '/' + encodeURIComponent(snap.id) + '/rollback', 'POST', { confirm: 'yes' })
        : request(API + '/' + encodeURIComponent(snap.id), 'DELETE');
      p.then(function (data) {
        if (S.destroyed) return;
        msg.className = 'snap-status row-note-ok';
        if (c.kind === 'rollback') {
          var applied = (data.applied || []).length, failed = (data.failed || []).length;
          msg.textContent = '回滚完成：改动 ' + applied + ' 项' + (failed ? '，跳过/失败 ' + failed + ' 项（详见下方结果）' : '');
          if (failed) {
            var host = S.resultHost;
            host.textContent = '';
            add(host, el('div', 'snap-confirm-title', '回滚未能完成的项目'));
            (data.failed || []).forEach(function (f) {
              add(host, el('div', 'snap-diff-row', f.plugin_id + ' · ' + f.action + '：' + f.error));
            });
          }
        } else {
          S.list = S.list.filter(function (x) { return x.id !== snap.id; });
          paintList();
          msg.textContent = '快照已删除';
        }
        closeConfirm();
      }, function (err) {
        if (S.destroyed) return;
        msg.className = 'snap-status row-note-fail';
        msg.textContent = (c.kind === 'rollback' ? '回滚失败：' : '删除失败：') + err.message;
      }).then(function () { S.busy = false; });
    });
    box.scrollIntoView({ block: 'nearest' });
  }

  // ---------- render ----------
  function render(container) {
    S = fresh();
    S.root = container;
    injectCSS();
    var page = add(container, el('div', 'snap-page'));

    var note = add(page, el('div', 'snap-note'));
    add(note, el('b', null, '配置快照（时光机）是什么？'));
    add(note, el('div', null,
      '给当前系统配置拍一张"照片"：装了哪些插件、什么版本、启停态与关键路径。之后改坏了，可以对比差异、一键回到拍照时的启停状态。'));
    add(note, el('div', null,
      '和「备份」不一样：备份（文件 → 备份）打包的是网站文件与数据库；快照只记配置，不备份数据、不替换插件包。'));
    add(note, el('div', null, '快照保存在 kore 自己的状态目录（snapshots/），不往安装目录外写任何东西。'));

    var createPanel = panel(page, '创建快照', '给当前配置留一颗后悔药');
    var form = add(createPanel, el('div', 'snap-form'));
    S.nameInput = add(form, el('input'));
    S.nameInput.type = 'text';
    S.nameInput.maxLength = MAX_NAME;
    S.nameInput.placeholder = '例如：装 WordPress 前';
    S.nameInput.setAttribute('aria-label', '快照名称');
    on(add(form, el('button', 'snap-primary', '创建快照')), createSnapshot);
    S.nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') createSnapshot(); });
    S.status = add(createPanel, el('div', 'snap-status'));

    var listPanel = panel(page, '快照列表', '最新的排在最前');
    S.listHost = add(listPanel, el('div', 'snap-list'));
    S.diffHost = add(page, el('div', 'snap-diff-host'));
    S.confirmHost = add(page, el('div', 'snap-confirm-host'));
    S.resultHost = add(page, el('div', 'snap-result-host'));

    loadList();
    return {
      destroy: function () {
        S.destroyed = true;
        if (S.root && page && page.parentNode === S.root) S.root.removeChild(page);
      }
    };
  }

  window.KoreSnapshot = { render: render };
})();
