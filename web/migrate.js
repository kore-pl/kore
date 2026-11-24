/* kore 主壳 · 配置迁移（web/migrate.js）——零框架 / 零 CDN / 无外链。
   window.KoreMigrate.render(container) → { destroy }，由主壳懒加载（不进首屏预算）。

   【导出文件 schema（owner 显式定义，G-24；字段类型写死，不用 object/any）】
     format: string="kore-migrate"            // 文件格式标识
     schema_version: int=1                    // 仅此版本可导入
     kore_version: string                     // 导出端 Kore 版本
     exported_at: string(RFC3339)             // 导出时刻
     sha256: string(64 位 hex)                // payload 规范化 JSON 摘要，导入前校验
     payload: {
       config: { profile, server_addr, server_socket, server_tls(bool),
         session_ttl_seconds(int), cookie_secure, auth_initialized(bool),
         paths{state_dir,log_dir,run_dir,plugin_dir,index_dir},
         log{level,max_size_mb(int),max_backups(int)},
         resources{memory_mb(int),cpu_quota,pids_max(int),enforce(bool),resident_max(int)},
         plugins{allow_unsigned(bool),autostart:string[]},
         store{allow_unsigned(bool)},
         security{attempts(int),window_seconds(int),lock_seconds(int)},
         audit{invoke_all(bool),retention_seconds(int),clean_enabled(bool),
               clean_interval_seconds(int),clean_batch(int)},
         cert_renew{enabled(bool),interval_seconds(int)} },
       plugins: [{id,name,version,lifecycle,desired,enabled(bool),state}],
       presets: [{id,name,description,out_of_box(bool),plugins:[{id,version,desired}]}]
     }
   【凭据红线 G-30】导出 schema 不含任何明文口令 / token / session / secret 字段：
   鉴权块只导出 initialized(bool) 与 session_ttl_seconds(int)，哈希与原口令两者都不导出；
   本文件也不出现 password/token/secret 字样作为导出字段（仅 UI 文案出现"凭据"两字提示）。

   【导入流程】选文件 → 服务端校验 format/schema/sha/版本兼容 → 预览"将改变什么" →
   页面内二次确认 → 应用。校验不过一律不进应用步骤；应用失败可读原因、不伪装成功。
   配置与预设的真源是 config.yaml / 商店索引，导入只自动应用插件启停态，其余给手工步骤。
   与「配置快照」区分：快照是本机版本回溯，本页是跨机文件流转。 */
(function () {
  'use strict';
  var EXPORT_URL = '/api/v1/migrate/export';
  var PREVIEW_URL = '/api/v1/migrate/preview';
  var APPLY_URL = '/api/v1/migrate/apply';
  var CSS_ID = 'kore-migrate-css';
  var S = { root: null, gen: 0, destroyed: false, busy: false,
    file: null, fileText: '', preview: null, previewFile: '',
    msg: null, msgTone: '', infoHost: null, diffHost: null,
    confirm: false, confirmHost: null, resultHost: null };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function button(parent, label, cls, fn) {
    var b = add(parent, el('button', 'btn' + (cls ? ' ' + cls : ''), label));
    b.type = 'button';
    if (fn) b.addEventListener('click', fn);
    return b;
  }
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
    var init = { method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Kore-CSRF': token } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
          err.code = data.code || ''; err.detail = data.detail || '';
          throw err;
        }
        return data;
      });
    });
  }
  function setMsg(text, tone) {
    if (!S.msg) return;
    S.msg.textContent = text || '';
    S.msg.className = 'mig-msg ' +
      (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '—') : d.toLocaleString('zh-CN', { hour12: false });
  }
  function kv(parent, label, value) {
    add(parent, el('dt', null, label));
    add(parent, el('dd', null, value === undefined || value === null || value === '' ? '—' : value));
  }
  function panel(parent, title, meta) {
    var p = add(parent, el('section', 'panel')), h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', title));
    if (meta) add(h, el('span', 'panel-meta', meta));
    return p;
  }
  function injectCSS() {
    if (document.getElementById(CSS_ID)) return;
    var s = el('style'); s.id = CSS_ID;
    s.textContent = [
      '.mig-wrap{display:grid;grid-template-columns:1fr;gap:var(--kore-space-3,12px);padding:var(--kore-space-4,16px);}',
      '.mig-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--kore-space-2,8px);}',
      '.mig-h2{margin:0;font-size:var(--kore-font-16,16px);font-weight:600;flex:1 1 240px;}',
      '.mig-sub{margin:0;color:var(--kore-text-2);font-size:var(--kore-font-12,12px);line-height:1.6;}',
      '.mig-msg{min-height:20px;font-size:var(--kore-font-12,12px);word-break:break-word;}',
      '.mig-ops{display:flex;flex-wrap:wrap;gap:var(--kore-space-2,8px);align-items:center;}',
      '.mig-btn{min-height:44px;padding:8px 16px;touch-action:manipulation;}',
      '.mig-file{display:inline-flex;align-items:center;min-height:44px;padding:8px 14px;',
      'border:1px dashed var(--kore-border-2);border-radius:var(--kore-radius-container,8px);cursor:pointer;}',
      '.mig-file input{position:absolute;opacity:0;width:1px;height:1px;}',
      '.mig-kv{display:grid;grid-template-columns:140px 1fr;gap:6px 12px;margin:0;',
      'font-size:var(--kore-font-12,12px);word-break:break-all;}',
      '.mig-kv dt{color:var(--kore-text-3);}', '.mig-kv dd{margin:0;color:var(--kore-text-1);}',
      '.mig-table-host{overflow-x:auto;}',
      '.mig-table{width:100%;min-width:620px;border-collapse:collapse;font-size:var(--kore-font-13,13px);}',
      '.mig-table th{text-align:left;padding:var(--kore-space-2,8px) var(--kore-space-3,12px);',
      'color:var(--kore-text-2);font-size:var(--kore-font-12,12px);font-weight:400;white-space:nowrap;',
      'border-bottom:1px solid var(--kore-border-2);}',
      '.mig-table td{padding:var(--kore-space-2,8px) var(--kore-space-3,12px);vertical-align:top;word-break:break-word;}',
      '.mig-table tbody tr + tr{border-top:1px solid var(--kore-border-2);}',
      '.mig-warn{margin:var(--kore-space-2,8px) 0;padding:var(--kore-space-2,8px) var(--kore-space-3,12px);',
      'background:var(--kore-warning-bg);border-radius:var(--kore-radius-container,8px);',
      'font-size:var(--kore-font-12,12px);line-height:1.6;}',
      '.mig-code{font-family:ui-monospace,monospace;font-size:var(--kore-font-12,12px);}',
      '@media (max-width:639px){.mig-kv{grid-template-columns:1fr;}',
      '.mig-kv dt{margin-top:6px;}}'
    ].join('');
    document.head.appendChild(s);
  }
  function download(manifest) {
    var text = JSON.stringify(manifest, null, 2);
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url; a.download = 'kore-config-' + stamp + '.json'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    return a.download;
  }
  function doExport() {
    if (S.busy) return;
    var gen = S.gen;
    S.busy = true; setMsg('正在导出当前配置…');
    request(EXPORT_URL, 'GET').then(function (m) {
      if (S.destroyed || S.gen !== gen) return;
      var name = download(m);
      paintInfo(m);
      setMsg('已下载 ' + name + '（' + (m.kore_version || '—') + ' · ' +
        String(m.sha256 || '').slice(0, 12) + '…）；文件不含任何明文凭据', 'ok');
    }, function (err) {
      if (S.destroyed || S.gen !== gen) return;
      setMsg('导出失败：' + err.message + (err.detail ? '（' + err.detail + '）' : '') +
        '。怎么办：确认已登录、再看「系统信息」是否正常后重试', 'fail');
    }).then(function () { S.busy = false; });
  }
  function paintInfo(m) {
    if (!S.infoHost) return;
    S.infoHost.textContent = '';
    var dl = add(S.infoHost, el('dl', 'mig-kv'));
    kv(dl, '格式', m.format); kv(dl, 'schema 版本', m.schema_version);
    kv(dl, 'Kore 版本', m.kore_version); kv(dl, '导出时间', fmtTime(m.exported_at));
    kv(dl, 'sha256', m.sha256);
    kv(dl, '插件数', m.payload && m.payload.plugins ? m.payload.plugins.length : 0);
    kv(dl, '预设数', m.payload && m.payload.presets ? m.payload.presets.length : 0);
  }
  function readFile(file) {
    if (!file) return;
    S.file = file; S.preview = null; S.confirm = false;
    paintConfirm(); paintDiff(); paintResult();
    setMsg('正在读取文件 ' + file.name + '…');
    var reader = new FileReader();
    reader.onerror = function () {
      if (S.destroyed) return;
      setMsg('读取文件失败，请重新选择文件', 'fail');
    };
    reader.onload = function () {
      if (S.destroyed) return;
      var text = String(reader.result || '');
      var parsed;
      try { parsed = JSON.parse(text); }
      catch (e) {
        setMsg('这不是合法的 JSON 文件：' + e.message + '。怎么办：请重新导出一份完整文件', 'fail');
        return;
      }
      if (!parsed || !parsed.manifest) {
        setMsg('文件缺少 manifest 字段，可能不是 Kore 配置迁移文件。怎么办：请用本页面重新导出', 'fail');
        return;
      }
      S.fileText = text;
      S.previewFile = file.name;
      setMsg('已读到 ' + file.name + '，点「预览差异」校验后再决定是否导入');
    };
    reader.readAsText(file);
  }
  function doPreview() {
    if (S.busy) return;
    if (!S.fileText) { setMsg('请先选择要导入的 JSON 文件', 'fail'); return; }
    var manifest;
    try { manifest = JSON.parse(S.fileText).manifest; }
    catch (e) { setMsg('文件内容解析失败，请重新选择文件', 'fail'); return; }
    S.busy = true; S.preview = null; S.confirm = false;
    paintConfirm(); paintDiff();
    setMsg('正在校验格式 / 版本 / 校验值并计算差异…');
    request(PREVIEW_URL, 'POST', { manifest: manifest }).then(function (p) {
      if (S.destroyed) return;
      S.preview = p;
      paintDiff();
      if (!p.compatible) {
        setMsg('不能导入：' + p.reason + '。怎么办：换用匹配版本的 Kore 或重新导出', 'fail');
      } else if (!p.sha_ok) {
        setMsg('校验不通过：' + p.reason + '。怎么办：重新导出，不要导入被改动的文件', 'fail');
      } else {
        setMsg('校验通过：' + p.reason + '；共 ' + (p.changes || []).length +
          ' 项变更。请核对下方差异后再确认', 'ok');
      }
    }, function (err) {
      if (S.destroyed) return;
      setMsg('校验失败：' + err.message + (err.detail ? '（' + err.detail + '）' : '') +
        '。怎么办：确认文件完整、与当前 Kore 版本匹配', 'fail');
    }).then(function () { S.busy = false; });
  }
  function paintDiff() {
    if (!S.diffHost) return;
    S.diffHost.textContent = '';
    if (!S.preview) return;
    var p = S.preview;
    var box = add(S.diffHost, el('div', 'mig-preview-box'));
    var dl = add(box, el('dl', 'mig-kv'));
    kv(dl, '兼容', p.compatible ? '是' : '否' + (p.reason ? ' · ' + p.reason : ''));
    kv(dl, '校验值', p.sha_ok ? '通过' : '未通过');
    kv(dl, '来源版本', p.from_version); kv(dl, '当前版本', p.to_version);
    var changes = p.changes || [];
    if (!changes.length) {
      add(box, el('p', 'muted', '没有需要自动应用的启停变更。'));
    } else {
      var scroll = add(box, el('div', 'mig-table-host'));
      var table = add(scroll, el('table', 'mig-table'));
      table.setAttribute('aria-label', '导入差异预览');
      var htr = add(add(table, el('thead')), el('tr'));
      ['类型', '对象', '当前', '导入后', '动作'].forEach(function (h) { add(htr, el('th', null, h)); });
      var body = add(table, el('tbody'));
      changes.forEach(function (c) {
        var tr = add(body, el('tr'));
        [c.kind, c.target, c.from, c.to, c.action].forEach(function (v, i) {
          add(tr, el('td', i === 1 ? 'mig-code' : null, v)).setAttribute('data-label',
            ['类型', '对象', '当前', '导入后', '动作'][i]);
        });
      });
    }
    (p.warnings || []).forEach(function (w) { add(box, el('p', 'mig-warn', '· ' + w)); });
  }
  function paintConfirm() {
    if (!S.confirmHost) return;
    S.confirmHost.textContent = '';
    if (!S.confirm) return;
    var p = add(S.confirmHost, el('section', 'panel mig-confirm'));
    var h = add(p, el('div', 'panel-head'));
    add(h, el('span', 'panel-title', '导入确认'));
    add(h, el('span', 'panel-meta', '二次确认 · 页面内'));
    add(p, el('p', 'mig-warn', '确认后将按上方差异应用插件启停态；失败会中止并回滚已改项，不留半应用状态。' +
      '配置与预设需按提示人工对齐，建议先导出一份当前配置作为回滚点。'));
    var ops = add(p, el('div', 'mig-ops'));
    button(ops, '取消', 'btn-ghost', function () { S.confirm = false; paintConfirm(); });
    button(ops, '确认导入', 'btn-primary mig-btn', doApply);
  }
  function doApply() {
    if (S.busy || !S.preview || !S.preview.compatible) return;
    var manifest;
    try { manifest = JSON.parse(S.fileText).manifest; }
    catch (e) { setMsg('文件内容解析失败，请重新选择文件', 'fail'); return; }
    S.busy = true; S.confirm = false; paintConfirm();
    setMsg('正在应用…失败会中止并回滚已改项，不会留下半应用状态');
    request(APPLY_URL, 'POST', { manifest: manifest }).then(function (r) {
      if (S.destroyed) return;
      S.result = r; paintResult();
      setMsg(r.message + '（' + (r.manual_steps || []).length + ' 项待手工处理）', 'ok');
      S.preview = null; paintDiff();
    }, function (err) {
      if (S.destroyed) return;
      setMsg('导入失败：' + err.message + (err.detail ? '（' + err.detail + '）' : '') +
        '。怎么办：核对文件来源与插件是否已安装，修好后重新预览', 'fail');
    }).then(function () { S.busy = false; });
  }
  function paintResult() {
    if (!S.resultHost) return;
    S.resultHost.textContent = '';
    if (!S.result) return;
    var p = panel(S.resultHost, '导入结果');
    var dl = add(p, el('dl', 'mig-kv'));
    kv(dl, '应用状态', S.result.applied ? '已应用' : '未应用');
    kv(dl, '说明', S.result.message);
    kv(dl, '自动变更数', (S.result.changes || []).length);
    (S.result.manual_steps || []).forEach(function (s) { add(p, el('p', 'mig-warn', '· ' + s)); });
  }
  function render(container) {
    S.gen++; S.root = container; S.destroyed = false; S.busy = false;
    S.file = null; S.fileText = ''; S.preview = null; S.confirm = false; S.result = null;
    injectCSS();
    container.textContent = '';
    var wrap = add(container, el('div', 'mig-wrap'));
    var head = add(wrap, el('div', 'mig-head'));
    add(head, el('h2', 'mig-h2', '配置迁移'));
    button(head, '导出当前配置', 'mig-btn', doExport);
    add(wrap, el('p', 'mig-sub', '导出完整配置（已装插件与版本、启停态、非敏感配置、预设）为版本化 JSON 文件，' +
      '用于换机迁移、环境复制与配置归档。文件绝不包含明文口令、令牌或会话数据。' +
      '导入需先预览差异、再二次确认；与本机「配置快照」不同，本页处理的是跨机文件流转。'));
    S.msg = add(wrap, el('div', 'mig-msg muted'));
    S.infoHost = add(wrap, el('div'));
    var exp = panel(wrap, '导出', '下载 JSON');
    add(exp, el('p', 'mig-sub', '点击上方「导出当前配置」下载文件；文件名带导出时间，内容带 Kore 版本与 sha256 校验值。'));
    var imp = panel(wrap, '导入', '校验 → 预览 → 确认');
    var ops = add(imp, el('div', 'mig-ops'));
    var label = add(ops, el('label', 'mig-file', '选择迁移 JSON 文件'));
    var input = add(label, el('input'));
    input.type = 'file'; input.accept = '.json,application/json';
    input.setAttribute('aria-label', '选择迁移 JSON 文件');
    input.addEventListener('change', function () { readFile(input.files && input.files[0]); });
    button(ops, '预览差异', 'mig-btn', doPreview);
    S.diffHost = add(imp, el('div'));
    S.confirmHost = add(imp, el('div'));
    S.resultHost = add(wrap, el('div'));
    return {
      destroy: function () {
        S.gen++; S.destroyed = true; S.root = null; S.msg = null;
        S.infoHost = null; S.diffHost = null; S.confirmHost = null; S.resultHost = null;
        S.preview = null; S.result = null;
      }
    };
  }
  window.KoreMigrate = { render: render };
})();
