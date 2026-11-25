/* kore 主壳 · 网站管理（web/sites.js）
   入口 window.KoreSites.render(container)，零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/site/site.list）；方法段写完整限定名。
   本页负责：站点列表与 site.get 完整摘要、启停/删除，以及懒加载 site-edit.js 提供的
   建站向导与 L2 配置编辑器。结果只展示插件真实字段（test_passed / reloaded / applied /
   changed / ssl_bound / rewrite_cleared 等），不把"配置写过了"说成"站点已生效"。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/site/';
  // plugin：'' 未知 / 'ready' 已装可用 / 'missing' 未安装（E_NOTFOUND）；
  // nginxMode/nginxReason 来自 site.list 的探测结果（off 时页面要给「怎么办」）。
  var S = { sites: [], detail: null, editor: null, editorReady: null,
    plugin: '', nginxMode: '', nginxReason: '', storeEntry: null };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function on(node, fn) { node.addEventListener('click', fn); return node; }
  // 本地化（ADR-0021）：切英文后本页用户可见文案走 en-US 表；语言包未就绪/缺键时
  // i18n.t 返回键名本身，这里以 hit !== key 拦截并回退到原中文，中文态零影响、不露裸键。
  function tr(key, fallback) {
    var i18n = window.KoreI18n;
    if (i18n && typeof i18n.t === 'function') {
      var hit = i18n.t(key);
      if (hit && hit !== key) return hit;
    }
    return fallback;
  }
  // PHP 伪静态模板判定，与后端 isPHPRewriteTemplate（php.go:79）对齐：
  // 这四个模板依赖 PHP-FPM，站点详情里给出人话提示，避免只显示模板名让人以为不用配。
  function isPHPTemplate(name) { return ['wordpress', 'laravel', 'thinkphp', 'discuz'].indexOf(name) >= 0; }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim();
      if (kv.indexOf(name + '=') === 0) return decodeURIComponent(kv.slice(name.length + 1));
    }
    return '';
  }
  function request(plugin, method, params) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少 CSRF 令牌，请刷新页面或重新登录'));
    return fetch('/api/v1/invoke/' + plugin + '/' + method, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kore-CSRF': token },
      body: JSON.stringify(params || {})
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || '';
          err.detail = data.detail || '';
          throw err;
        }
        return data;
      });
    });
  }
  function invoke(method, params) { return request('site', method, params); }
  // SSL 证书列表属于 ssl 插件，不能走 site 的限定名（域与插件不一致会 E_INVALID）。
  function invokeSSL(method, params) { return request('ssl', method, params); }
  // invokePlugin 供跨插件只读探测使用（例如 runtime-php.versions）；只读方法，失败一律降级。
  function invokePlugin(plugin, method, params) { return request(plugin, method, params); }
  // 商店 / 插件管理 API（不是插件方法）：整页只有「缺站点插件时一键安装」用，
  // 复用同一套 CSRF 双提交；错误同样归一成 {code, message}。
  function apiJSON(method, url, body) {
    var token = cookie('kore_csrf');
    if (!token) return Promise.reject(new Error('缺少刷新令牌（kore_csrf），请刷新页面或重新登录'));
    var init = { method: method, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Kore-CSRF': token } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = {}; } }
        if (!res.ok) {
          var err = new Error((data.code ? data.code + '：' : '') +
            (data.message || ('请求失败（HTTP ' + res.status + '）')));
          err.code = data.code || '';
          err.detail = data.detail || '';
          throw err;
        }
        return data;
      });
    });
  }
  // 用户看到的错误只留白话 message；错误码只作排查线索挂在 err.code 上，
  // 不进正文（G-33 A4：不让用户读 E_NOTFOUND 这类内部码）。
  function errText(err) {
    var text = err && err.message ? String(err.message) : '未知错误';
    text = text.replace(/^E_[A-Z_]+[：:]\s*/, '');
    if (err && err.detail && text.indexOf(err.detail) < 0) text += '（' + err.detail + '）';
    return text;
  }
  function hintFor(action, err) {
    var msg = err ? String(err.message || '') : '';
    var code = err && err.code ? String(err.code) : '';
    if (code === 'E_NOTFOUND' || (/未安装|未启用/.test(msg) && /站点插件|site/.test(msg))) {
      return '站点插件还没安装或已被停用：点上方「安装站点插件」一键装好（也可到软件商店安装），装好后重试即可。';
    }
    if (/nginx|NGINX/.test(msg) && /没有|未检测|找不到|not found|missing/.test(msg)) {
      return '本机没有可用的 nginx：站点配置能保存但浏览器打不开。请先安装 nginx 并启动，或到「连接配置」改用已有的 nginx 容器。';
    }
    if (code === 'E_CONFLICT') return '目标已存在或状态冲突：刷新后按当前状态重试。';
    if (/nginx 配置校验失败/.test(msg)) return '配置未通过 nginx -t，插件已回滚；请检查路径、端口或模板是否冲突。';
    if (/重载失败/.test(msg)) return '文件已写入但 nginx 未确认；页面的 applied/reloaded 会如实显示。';
    if (/证书|私钥|cert_path|key_path/.test(msg)) return '证书与私钥必须是存在的绝对路径，且与证书域名匹配。';
    if (/upstream/.test(msg)) return '反代只接受 http://host:port，不支持 https 或带路径的地址。';
    if (/template/.test(msg)) return '伪静态只支持 none / wordpress / laravel / thinkphp / discuz / nextjs。';
    if (/PHP-FPM|php_version|socket|PHP 伪静态|依赖 PHP/.test(msg)) return '这是 PHP 模板必须要 PHP-FPM 才能访问：请在 PHP-FPM 面板选一个已检测到的版本保存；若提示要先切回 none，请先把伪静态改成 none 再关闭 PHP。';
    if (/from_path|to_url|code/.test(msg)) return '重定向只允许 / 开头的来源路径与 http(s):// 或站内 / 目标，code 为 301/302。';
    if (/docker|container/.test(msg)) return '容器模式需要填运行中的容器名，并确认 conf.d 已挂载到宿主目录；不确定就先用默认的自动检测模式。';
    if (/nginx_mode|host_conf_dir|docker_conf_dir/.test(msg)) return '连接配置决定插件去哪里读写 nginx 片段；改错会让站点操作失败，保存前请对照宿主的 nginx 配置。';
    if (/认证|E_UNAUTHORIZED/.test(msg)) return '当前会话没有该操作权限：请用管理员账号登录后重试。';
    return '';
  }
  function chip(tone, text) {
    var c = el('span', 'chip chip-' + tone), dot = el('span', 'dot');
    if (tone === 'ok' || tone === 'warn' || tone === 'fail') dot.classList.add(tone);
    c.appendChild(dot); c.appendChild(el('span', null, text)); return c;
  }
  // 三态：通过 / 未检测（环境限制）/ 失败。没测不能显示成测挂。
  function flag(value, skipped, yes, no, detail) {
    if (skipped) {
      var na = chip('na', '未检测（未配置 nginx）');
      na.title = '本机没有可用的 nginx，未执行该项检测；这不是站点故障';
      return na;
    }
    var badge = value ? chip('ok', yes) : chip('fail', no);
    if (!value && detail) badge.title = detail;
    return badge;
  }
  function summarize(text) {
    var line = String(text || '').split('\n')[0].trim();
    return line.length > 90 ? line.slice(0, 90) + '…' : line;
  }
  function setStatus(text, tone) {
    if (!S.status) return;
    S.status.textContent = text;
    S.status.className = 'site-status ' + (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function row(label, value) {
    var tr = el('tr');
    tr.appendChild(el('th', null, label));
    var td = el('td');
    if (value && value.nodeType === 1) td.appendChild(value);
    else td.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    tr.appendChild(td); return tr;
  }
  function showResult(title, data, failed) {
    if (!S.resultHost) return;
    var box = el('section', 'panel site-result' + (failed ? ' site-result-fail' : ''));
    var head = add(box, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', title));
    add(head, el('span', 'panel-meta', failed ? '未完成' : '插件返回'));
    if (failed) {
      add(box, el('div', 'site-result-error', errText(data) + (hintFor('', data) ? ' ' + hintFor('', data) : '')));
      S.resultHost.replaceChildren(box);
      return;
    }
    var table = add(box, el('table', 'rows'));
    if (data.domain) table.appendChild(row('域名', data.domain));
    if (data.vhost_path) table.appendChild(row('vhost 路径', el('span', 'mono', data.vhost_path)));
    if (data.backup_path) table.appendChild(row('备份路径', el('span', 'mono', data.backup_path)));
    table.appendChild(row('nginx -t', flag(data.test_passed, data.test_skipped, '通过', '失败', data.test_output)));
    table.appendChild(row('已 reload', flag(data.reloaded, data.reload_skipped, '已重载', '未重载')));
    if (data.applied !== undefined) table.appendChild(row('整体生效', flag(data.applied, false, '已生效', '未生效')));
    if (data.changed !== undefined) table.appendChild(row('配置变更', data.changed ? '是' : '否（与当前字节一致，已短路）'));
    if (data.enabled !== undefined) table.appendChild(row('启用状态', data.enabled ? '已启用' : '已停用'));
    if (data.created !== undefined) table.appendChild(row('新建片段', data.created ? '是' : '否（覆盖已有）'));
    if (data.deleted !== undefined) table.appendChild(row('已删除', data.deleted ? '是' : '无托管站点可删'));
    S.resultHost.replaceChildren(box);
  }
  function confirmBox(text, onOk) {
    var mask = el('div', 'kore-modal');
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
    var box = add(mask, el('div', 'kore-modal-box'));
    add(box, el('div', 'kore-modal-title', tr('sites.delete.title', '删除确认')));
    add(box, el('p', 'kore-modal-text', text));
    var msg = add(box, el('div', 'kore-modal-msg'));
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', tr('sites.delete.cancel', '取消'))); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary', tr('sites.delete.confirm', '确认删除'))); ok.type = 'button';
    function close() {
      document.removeEventListener('keydown', esc);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }
    function esc(ev) { if (ev.key === 'Escape') close(); }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    document.addEventListener('keydown', esc);
    ok.addEventListener('click', function () { ok.disabled = true; onOk(close, msg, ok); });
    document.body.appendChild(mask);
  }
  function removeSite(domain) {
    confirmBox('将删除站点 ' + domain + ' 的托管 vhost 并 reload nginx；插件会先备份原 vhost。', function (close, msg, ok) {
      invoke('site.delete', { domain: domain }).then(function (data) {
        close();
        showResult('删除结果 · ' + domain, data, false);
        setStatus('已处理删除：' + domain, 'ok');
        if (S.detail && S.detail.domain === domain) { S.detail = null; paintDetail(); }
        load();
      }, function (err) {
        ok.disabled = false;
        msg.textContent = errText(err);
        showResult('删除失败 · ' + domain, err, true);
      });
    });
  }
  function toggleSite(site) {
    var action = site.enabled ? 'site.disable' : 'site.enable';
    var label = site.enabled ? '停用' : '启用';
    setStatus('正在' + label + ' ' + site.domain + '…');
    invoke(action, { domain: site.domain }).then(function (data) {
      showResult(label + '结果 · ' + site.domain, data, false);
      setStatus('已' + label + ' ' + site.domain + '（applied=' + data.applied + '，reloaded=' + data.reloaded + '）', 'ok');
      load();
      if (S.detail && S.detail.domain === site.domain) openDetail(site.domain);
    }, function (err) {
      showResult(label + '失败 · ' + site.domain, err, true);
      setStatus(label + '失败：' + errText(err), 'fail');
    });
  }
  function openDetail(domain, silent) {
    if (!silent) setStatus('正在读取 ' + domain + ' 的完整配置…');
    return invoke('site.get', { domain: domain }).then(function (data) {
      S.detail = data; paintDetail();
      if (!silent) setStatus('已读取 ' + domain + ' 的完整配置', 'ok');
    }, function (err) {
      showResult('详情读取失败 · ' + domain, err, true);
      if (!silent) setStatus('详情读取失败：' + errText(err), 'fail');
    });
  }
  // ensureEdit 只在首次渲染向导/打开详情时注入 site-edit.js；失败允许下次重试。
  function ensureEdit() {
    if (S.editor) return Promise.resolve(S.editor);
    if (!S.editorReady) {
      S.editorReady = new Promise(function (resolve, reject) {
        if (window.KoreSiteEdit && typeof window.KoreSiteEdit.render === 'function' &&
          typeof window.KoreSiteEdit.renderWizard === 'function') { resolve(); return; }
        var script = document.createElement('script');
        script.src = '/assets/site-edit.js'; script.async = true;
        script.onload = function () {
          if (!window.KoreSiteEdit || typeof window.KoreSiteEdit.render !== 'function' ||
            typeof window.KoreSiteEdit.renderWizard !== 'function') {
            reject(new Error('site-edit.js 未导出 KoreSiteEdit.render / renderWizard')); return;
          }
          resolve();
        };
        script.onerror = function () { reject(new Error('site-edit.js 加载失败')); };
        document.head.appendChild(script);
      });
      S.editorReady.catch(function () { S.editorReady = null; });
    }
    return S.editorReady.then(function () {
      if (!S.editor) S.editor = window.KoreSiteEdit;
      return S.editor;
    });
  }
  function moduleCtx(domain, isEditor) {
    return {
      domain: domain || '', invoke: invoke, invokeSSL: invokeSSL, invokePlugin: invokePlugin,
      ui: { el: el, add: add, on: on },
      errText: errText, hintFor: hintFor, setStatus: setStatus,
      after: isEditor
        ? function (msg) {
          if (msg) setStatus(msg, 'ok');
          if (!domain) return;
          load(true).then(function () { return openDetail(domain, true); }).then(function () { if (msg) setStatus(msg, 'ok'); });
        }
        : function (created, steps) {
          if (created) paintCreated(created, steps);
          load(true);
        }
    };
  }
  function loadWizard() {
    if (!S.wizardHost) return;
    S.wizardHost.textContent = '';
    add(S.wizardHost, el('div', 'stub', '正在加载一键建站表单…'));
    ensureEdit().then(function (mod) {
      if (!S.wizardHost) return;
      S.wizardHost.textContent = '';
      mod.renderWizard(S.wizardHost, moduleCtx('', false));
    }, function (err) {
      if (!S.wizardHost) return;
      S.wizardHost.textContent = '';
      add(S.wizardHost, el('div', 'site-result-error', '一键建站表单加载失败：' + errText(err)));
    });
  }
  function loadEditor(data) {
    if (!S.editHost) return;
    var host = S.editHost, domain = data.domain;
    ensureEdit().then(function (mod) {
      if (S.editHost !== host || !S.detail || S.detail.domain !== domain) return;
      host.textContent = '';
      mod.render(host, moduleCtx(domain, true), data);
    }, function (err) {
      if (S.editHost !== host) return;
      host.textContent = '';
      add(host, el('div', 'site-result-error', '配置编辑器加载失败：' + errText(err)));
    });
  }
  // ---------------- 缺插件：一页装好（新用户第一次点进「网站」的落点） ----------------
  // 一键安装 = 读商店索引拿版本 → store/install(download) → plugins/<id>/enable。
  // 只用既有 API，不改后端；失败按「怎么办」给下一步，不把错误码甩给用户。
  function storeEntry(id) {
    return apiJSON('GET', '/api/v1/store/plugins').then(function (data) {
      var list = data && Array.isArray(data.plugins) ? data.plugins : [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i];
      }
      return null;
    });
  }
  function installStorePlugin(entry) {
    return apiJSON('POST', '/api/v1/store/install',
      { id: entry.id, version: entry.version, download: true });
  }
  function enablePlugin(id) {
    return apiJSON('POST', '/api/v1/plugins/' + encodeURIComponent(id) + '/enable', {});
  }
  function installStatus(text, tone) {
    if (!S.installStatus) return;
    S.installStatus.textContent = text;
    S.installStatus.className = 'site-install-status ' +
      (tone === 'fail' ? 'row-note-fail' : tone === 'ok' ? 'row-note-ok' : 'muted');
  }
  function paintMissingPlugin() {
    if (!S.wizardHost) return;
    S.wizardHost.textContent = '';
    var card = add(S.wizardHost, el('section', 'panel site-install-card'));
    var head = add(card, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', '还差一步：装好「站点」插件就能建站'));
    add(head, el('span', 'panel-meta', '内核不自带 Web 服务，装完才有网站管理'));
    var body = add(card, el('div', 'site-install-body'));
    body.style.padding = '0 var(--kore-space-4) var(--kore-space-3)';
    add(body, el('p', 'site-install-text',
      'Kore 内核本身不带 Web 服务。装好站点插件后，在上面填一个域名、点一次，就能建好第一个站点（用本机 nginx 直接生效）。'));
    var pick = add(body, el('label', 'field field-check'));
    S.withFile = add(pick, el('input', 'files-checkbox'));
    S.withFile.type = 'checkbox'; S.withFile.checked = true;
    S.withFile.setAttribute('data-field', 'install-file');
    add(pick, el('span', null, '同时安装文件管理插件（用来自动创建站点目录和默认首页，建议保留）'));
    var ops = add(body, el('div', 'site-edit-ops'));
    ops.style.padding = '0 0 var(--kore-space-3)';
    S.installBtn = add(ops, el('button', 'btn btn-primary site-install-btn', '一键安装站点插件'));
    S.installBtn.type = 'button';
    S.installBtn.setAttribute('data-action', 'install-site-plugin');
    on(S.installBtn, installMissingPlugin);
    var store = add(ops, el('button', 'btn btn-ghost', '去软件商店自己挑'));
    store.type = 'button';
    on(store, function () {
      if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('store');
    });
    S.installStatus = add(body, el('div', 'site-install-status muted'));
    S.installStatus.setAttribute('role', 'status');
    if (S.listHost) {
      S.listHost.textContent = '';
      var empty = add(S.listHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '站点插件装好后，这里会列出你已经建好的站点。'));
    }
  }
  function installMissingPlugin() {
    if (S.installBtn) S.installBtn.disabled = true;
    installStatus('正在读取商店索引…');
    var wantFile = !!(S.withFile && S.withFile.checked);
    storeEntry('site').then(function (entry) {
      if (!entry) throw new Error('商店索引里没有站点插件，请到软件商店刷新索引后重试');
      S.storeEntry = entry;
      var mb = Math.max(1, Math.round((entry.size_bytes || 0) / 1024 / 1024));
      installStatus('正在安装站点插件 v' + entry.version + '（首次约 ' + mb + ' MB，需要联网）…');
      return installStorePlugin(entry);
    }).then(function () {
      if (!wantFile) return null;
      installStatus('站点插件已装好，正在安装文件管理插件…');
      return storeEntry('file').then(function (entry) {
        if (!entry) return null;
        return installStorePlugin(entry);
      });
    }).then(function () {
      installStatus('正在启用站点插件…');
      return enablePlugin('site');
    }).then(function () {
      if (!wantFile) return null;
      return enablePlugin('file').then(null, function () { return null; });
    }).then(function () {
      S.plugin = 'ready';
      installStatus('站点插件已装好，填个域名就能建站。', 'ok');
      setStatus('站点插件已装好：在上面填域名 → 点「一键创建站点」，几秒就能建好第一个站点', 'ok');
      load(true);
      loadWizard();
    }, function (err) {
      if (S.installBtn) S.installBtn.disabled = false;
      // 已装过按成功处理：这里不做覆盖重装（重装会重置插件配置）。
      if (/已安装|已存在|E_CONFLICT/.test(errText(err))) {
        S.plugin = 'ready';
        installStatus('站点插件已经装好了，填个域名就能建站。', 'ok');
        load(true); loadWizard();
        return;
      }
      installStatus('安装没完成：' + errText(err) + ' ' + hintFor('', err), 'fail');
    });
  }
  // nginx 不可用时给「怎么办」：配置能写、浏览器打不开这件事必须说清楚（否则新人以为站点坏了）。
  function paintNginxNotice() {
    if (!S.nginxHost) return;
    S.nginxHost.textContent = '';
    if (S.plugin !== 'ready' || String(S.nginxMode) !== 'off') return;
    var box = add(S.nginxHost, el('section', 'panel site-nginx-note'));
    add(box, el('span', 'panel-title', '本机还没有可用的 nginx'));
    add(box, el('p', 'site-nginx-text',
      '站点配置可以照常保存，但浏览器打不开：请先安装 nginx 并启动，再点「刷新」重试；本机已有 nginx 容器时，到「连接配置」把运行方式改成 docker 并填容器名。' +
      (S.nginxReason ? '（检测结果：' + S.nginxReason + '）' : '')));
    box.style.padding = 'var(--kore-space-3) var(--kore-space-4)';
    var ops = add(box, el('div', 'site-edit-ops'));
    ops.style.padding = 'var(--kore-space-2) 0 0';
    var cfg = add(ops, el('button', 'btn', '打开连接配置'));
    cfg.type = 'button';
    on(cfg, function () { if (S.configToggle) S.configToggle(); });
  }
  // 建站成功后的出口：立刻能在浏览器看到结果；打不开时给 hosts / nginx 两条「怎么办」。
  function paintCreated(domain, steps) {
    if (!S.wizardHost || !domain) return;
    S.wizardHost.textContent = '';
    var sslOk = false, dirSkipped = '';
    (steps || []).forEach(function (s) {
      if (s.name === '绑定证书' && s.state === 'ok') sslOk = true;
      if (s.name === '创建站点目录' && s.state === 'skip') dirSkipped = String(s.detail || '');
    });
    var url = (sslOk ? 'https://' : 'http://') + domain;
    var card = add(S.wizardHost, el('section', 'panel site-created'));
    var head = add(card, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', '站点已建好 · ' + domain));
    add(head, el('span', 'panel-meta', '下一步：在浏览器打开看看'));
    var body = add(card, el('div', 'site-created-body'));
    body.style.padding = '0 var(--kore-space-4) var(--kore-space-3)';
    var line = add(body, el('div', 'site-created-url'));
    line.style.margin = 'var(--kore-space-2) 0 var(--kore-space-3)';
    line.style.wordBreak = 'break-all';
    add(line, el('span', 'mono', url));
    var ops = add(body, el('div', 'site-edit-ops'));
    ops.style.padding = '0 0 var(--kore-space-3)';
    var open = add(ops, el('button', 'btn btn-primary site-open-btn', '在浏览器打开'));
    open.type = 'button';
    open.setAttribute('data-action', 'site-open');
    on(open, function () { window.open(url + '/', '_blank', 'noopener'); });
    var copy = add(ops, el('button', 'btn btn-ghost', '复制访问地址'));
    copy.type = 'button';
    on(copy, function () {
      var fail = function () { setStatus('浏览器不允许自动复制：请手动选中地址 ' + url + ' 复制', 'fail'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { setStatus('访问地址已复制：' + url, 'ok'); }, fail);
      } else { fail(); }
    });
    var manage = add(ops, el('button', 'btn btn-ghost', '管理这个站点'));
    manage.type = 'button';
    on(manage, function () {
      openDetail(domain).then(function () {
        if (S.detailHost && S.detailHost.scrollIntoView) S.detailHost.scrollIntoView({ block: 'start' });
      });
    });
    var again = add(ops, el('button', 'btn btn-ghost', '再建一个站点'));
    again.type = 'button';
    on(again, function () { loadWizard(); });
    add(body, el('p', 'field-hint',
      '打不开怎么办：先确认域名已解析到这台机器（本机测试可在 /etc/hosts 加一行「127.0.0.1 ' + domain + '」），再确认 nginx 已运行并 reload。'));
    if (dirSkipped) {
      add(body, el('p', 'row-note-fail', '站点目录没创建成功，页面可能 404：' + dirSkipped));
      var fixOps = add(body, el('div', 'site-edit-ops'));
      fixOps.style.padding = '0 0 var(--kore-space-2)';
      var goFiles = add(fixOps, el('button', 'btn', '去文件管理建目录'));
      goFiles.type = 'button';
      on(goFiles, function () {
        if (window.KoreShell && typeof window.KoreShell.navigate === 'function') window.KoreShell.navigate('files');
      });
    }
  }
  // ---------------- 运行状态（site.status）----------------
  // 三态口径：presence 用 present/absent/unknown 表达；unknown 是「查不到」，
  // 不等于「不存在」，必须显示原因而不是让人以为目录丢了、进而误删站点。
  function dirStateText(state) {
    if (state === 'present') return '存在';
    if (state === 'absent') return '不存在';
    if (state === 'unknown') return '未知（查不到，不等于不存在）';
    return '—';
  }
  function paintStatus(host, data) {
    if (!host) return;
    host.textContent = '';
    var box = add(host, el('div', 'site-status-box'));
    var table = add(box, el('table', 'rows'));
    table.appendChild(row('配置片段', flag(data.conf_exists, false, '存在', '缺失')));
    table.appendChild(row('配置校验', flag(data.test_passed, data.test_skipped, '通过', '失败', data.test_output)));
    var dirCell = el('span', 'site-state');
    var tone = data.site_dir_state === 'present' ? 'ok' : data.site_dir_state === 'absent' ? 'fail' : 'na';
    dirCell.appendChild(chip(tone, dirStateText(data.site_dir_state)));
    if (data.site_dir_reason) {
      var why = add(dirCell, el('span', 'muted', '：' + summarize(data.site_dir_reason)));
      why.title = data.site_dir_reason;
    }
    table.appendChild(row('站点目录', dirCell));
    table.appendChild(row('已加载', flag(data.loaded, !data.load_checked, '已加载', '未加载')));
    table.appendChild(row('托管状态', data.managed ? '由本插件托管' : '不在插件清单（外部配置）'));
    table.appendChild(row('命令通道', (data.nginx_mode || '—') + (data.nginx_reason ? '（' + data.nginx_reason + '）' : '')));
    if (data.test_output && !data.test_passed) {
      var out = add(box, el('p', 'row-note-fail site-test-brief', summarize(data.test_output)));
      out.title = data.test_output;
    }
  }
  function loadStatus(domain, host) {
    if (!host) return;
    host.textContent = '';
    add(host, el('p', 'muted', '正在检查 ' + domain + ' 的实际运行状态…'));
    invoke('site.status', { domain: domain }).then(function (data) {
      paintStatus(host, data);
    }, function (err) {
      host.textContent = '';
      add(host, el('div', 'site-result-error', '状态检查失败：' + errText(err) +
        (hintFor('site.status', err) ? ' ' + hintFor('site.status', err) : '')));
    });
  }
  // ---------------- 连接配置（site.config.get / set）----------------
  function paintConfig(host, data) {
    host.textContent = '';
    if (!data || !data.schema) {
      add(host, el('div', 'site-result-error', '连接配置返回为空：请升级站点插件后重试。'));
      return;
    }
    var panel = add(host, el('section', 'panel'));
    var head = add(panel, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', data.schema.title || '站点服务连接配置'));
    var sourceText = { file: '配置文件', env: '环境变量', default: '默认值' }[data.source] || data.source || '';
    add(head, el('span', 'panel-meta', sourceText ? '当前来源：' + sourceText : ''));
    add(panel, el('p', 'field-hint', '决定插件去哪里读写 nginx 片段、以及用哪套命令校验/reload。保存后立即生效；不确定就用默认值。'));
    var form = add(panel, el('form', 'site-form'));
    var inputs = {};
    var values = data.values || {};
    (data.schema.fields || []).forEach(function (f) {
      var box = add(form, el('label', 'field'));
      add(box, el('span', 'field-label', f.label + (f.required ? '' : '（可选）')));
      var input;
      if (f.type === 'select' && Array.isArray(f.options)) {
        input = add(box, el('select', 'field-input'));
        f.options.forEach(function (optValue) {
          var opt = add(input, el('option', null, optValue));
          opt.value = optValue;
        });
      } else if (f.type === 'bool') {
        // 布尔字段：整行 label 即点击热区，<640px 由 .field-bool 撑到 ≥44px（裁决41）
        box.classList.add('field-bool');
        input = add(box, el('input', 'files-checkbox'));
        input.type = 'checkbox';
      } else {
        input = add(box, el('input', 'field-input'));
        input.type = f.type === 'int' ? 'number' : 'text';
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.placeholder) input.placeholder = f.placeholder;
        // 连接配置全是路径 / 主机 / 命令，手机键盘不许自动大写与纠错
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('spellcheck', 'false');
      }
      var current = values[f.key];
      if (current === undefined || current === null) {
        try { current = JSON.parse(f.default); } catch (e) { current = ''; }
      }
      if (f.type === 'bool') input.checked = !!current;
      else input.value = current === undefined || current === null ? '' : String(current);
      if (f.help) add(box, el('p', 'field-hint', f.help));
      inputs[f.key] = { field: f, node: input };
    });
    var ops = add(form, el('div', 'site-edit-ops'));
    var save = add(ops, el('button', 'btn btn-primary', '保存连接配置'));
    save.type = 'submit';
    var msg = add(panel, el('div', 'site-status muted'));
    msg.setAttribute('role', 'status');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var out = {};
      Object.keys(inputs).forEach(function (key) {
        var item = inputs[key], f = item.field;
        if (f.type === 'bool') out[key] = !!item.node.checked;
        else if (f.type === 'int') { var n = parseInt(item.node.value, 10); out[key] = isNaN(n) ? 0 : n; }
        else out[key] = item.node.value.trim();
      });
      save.disabled = true;
      invoke('site.config.set', { values: out }).then(function (r) {
        save.disabled = false;
        var warn = Array.isArray(r.warnings) && r.warnings.length ? '；提示：' + r.warnings.join('；') : '';
        msg.textContent = '已保存并生效（applied=' + r.applied + '，需要重启=' + r.restart_required + '）' + warn;
        msg.className = 'site-status row-note-ok';
      }, function (err) {
        save.disabled = false;
        msg.textContent = '保存失败：' + errText(err) + (hintFor('site.config.set', err) ? ' ' + hintFor('site.config.set', err) : '');
        msg.className = 'site-status row-note-fail';
      });
    });
  }
  function loadConfig(host) {
    if (!host) return;
    host.textContent = '';
    add(host, el('p', 'muted', '正在读取连接配置…'));
    invoke('site.config.get', {}).then(function (data) {
      paintConfig(host, data);
    }, function (err) {
      host.textContent = '';
      add(host, el('div', 'site-result-error', '连接配置读取失败：' + errText(err) +
        (hintFor('site.config.get', err) ? ' ' + hintFor('site.config.get', err) : '') +
        '（插件未启用或版本过旧时会出现）'));
    });
  }
  // ---------------- 克隆站点（site.clone）----------------
  function fmtBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KiB';
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MiB';
    return (v / 1073741824).toFixed(2) + ' GiB';
  }
  // 建议域名：把第一段换成 <第一段>-clone（src.example.com → src-clone.example.com）。
  function suggestCloneDomain(domain) {
    var parts = String(domain || '').split('.');
    if (!parts.length) return '';
    parts[0] = parts[0].replace(/-clone\d*$/, '') + '-clone';
    return parts.join('.');
  }
  function cloneErrorText(err) {
    var code = err && err.code ? err.code : '';
    if (code === 'E_CONFLICT') return '该域名已有站点，请换一个域名。';
    if (code === 'E_NOTFOUND') return '请选择一个已托管的站点（当前站点可能不在插件清单里）。';
    if (code === 'E_INVALID' && /KORE_STATE_DIR/.test(String(err.message || ''))) {
      return '复制站点目录只允许在插件的数据目录内进行；可以关闭「复制站点目录」，只克隆配置。';
    }
    var text = errText(err);
    var hint = hintFor('site.clone', err);
    return text + (hint ? ' ' + hint : '');
  }
  // 克隆面板：一个表单完成（源站点自动带出、新域名预填、copy_root 默认关并有说明）。
  function buildClonePanel(box, d) {
    var panel = add(box, el('section', 'panel site-edit-section'));
    var head = add(panel, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', '克隆站点'));
    add(head, el('span', 'panel-meta', '复制当前站点的全部配置到新域名（做测试环境）'));
    var form = add(panel, el('form', 'site-form'));
    var domainField = add(form, el('label', 'field'));
    add(domainField, el('span', 'field-label', '新域名（至少两个标签，全小写）'));
    var newDomain = add(domainField, el('input', 'field-input'));
    newDomain.type = 'text';
    newDomain.autocomplete = 'off';
    // 手机键盘：域名要能直接打出 . / -，且不能被自动大写（例：Demo.Kore.Test 不是合法域名）
    newDomain.setAttribute('autocapitalize', 'off');
    newDomain.setAttribute('autocorrect', 'off');
    newDomain.setAttribute('spellcheck', 'false');
    newDomain.setAttribute('inputmode', 'url');
    newDomain.value = suggestCloneDomain(d.domain);
    newDomain.setAttribute('data-field', 'clone-domain');
    var copyLine = add(form, el('label', 'field field-check'));
    var copyRoot = add(copyLine, el('input', 'files-checkbox'));
    copyRoot.type = 'checkbox';
    add(copyLine, el('span', null, '同时复制站点文件（默认关闭）'));
    var copyHint = add(form, el('p', 'field-hint',
      '关闭 = 新站点共用源目录（不复制文件），适合先验证配置；勾选后会把文件复制到新目录。'));
    var rootField = add(form, el('label', 'field'));
    rootField.style.display = 'none';
    add(rootField, el('span', 'field-label', '新站点目录（勾选复制时必填）'));
    var newRoot = add(rootField, el('input', 'field-input'));
    newRoot.type = 'text';
    newRoot.autocomplete = 'off';
    newRoot.setAttribute('autocapitalize', 'off');
    newRoot.setAttribute('autocorrect', 'off');
    newRoot.setAttribute('spellcheck', 'false');
    newRoot.setAttribute('inputmode', 'url');
    newRoot.value = d.root ? String(d.root).replace(/\/+$/, '') + '-clone' : '';
    newRoot.setAttribute('data-field', 'clone-root');
    copyRoot.addEventListener('change', function () {
      rootField.style.display = copyRoot.checked ? '' : 'none';
      copyHint.textContent = copyRoot.checked
        ? '会把源目录的文件复制到新目录；目录必须在插件数据目录内（宿主路径会明确报错并提示改用只克隆配置）。'
        : '关闭 = 新站点共用源目录（不复制文件），适合先验证配置。';
    });
    var msg = add(form, el('div', 'site-status muted'));
    msg.setAttribute('role', 'status');
    var ops = add(form, el('div', 'site-edit-ops'));
    var submit = add(ops, el('button', 'btn btn-primary', '克隆站点'));
    submit.type = 'submit';
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var target = newDomain.value.trim().toLowerCase();
      if (!target) { msg.textContent = '请填写新域名。'; msg.className = 'site-status row-note-fail'; return; }
      if (target === d.domain) { msg.textContent = '新域名不能和源站点相同。'; msg.className = 'site-status row-note-fail'; return; }
      if (copyRoot.checked && !newRoot.value.trim()) {
        msg.textContent = '勾选了复制站点文件，请填写新站点目录（或取消勾选只克隆配置）。';
        msg.className = 'site-status row-note-fail';
        return;
      }
      var params = { source_domain: d.domain, new_domain: target };
      if (copyRoot.checked) {
        params.copy_root = true;
        params.root = newRoot.value.trim();
      }
      submit.disabled = true;
      submit.textContent = '正在克隆…';
      msg.textContent = '正在复制配置' + (copyRoot.checked ? '与站点文件' : '') + '，随后校验并 reload nginx…';
      msg.className = 'site-status muted';
      invoke('site.clone', params).then(function (r) {
        submit.disabled = false;
        submit.textContent = '克隆站点';
        var lines = [
          '配置已复制到 ' + r.domain + (r.ssl_copied ? '（含 SSL）' : '') +
            '；伪静态 ' + (r.rewrite_copied ? '已复制' : '无') +
            '；反向代理 ' + (r.proxy_copied ? '已复制' : '无') +
            '；重定向 ' + (r.redirect_count || 0) + ' 条'
        ];
        lines.push(r.root_copied
          ? '站点文件：已复制 ' + (r.copied_files || 0) + ' 个文件，共 ' + fmtBytes(r.copied_bytes)
          : '站点文件：未复制（与源站点共用目录 ' + (r.root || '—') + '）');
        lines.push('nginx 校验：' + (r.test_skipped ? '未检测（本机未配置 nginx）' : r.test_passed ? '通过' : '失败') +
          '；reload：' + (r.reload_skipped ? '未执行' : r.reloaded ? '已完成' : '未完成') +
          '；整体生效：' + (r.applied ? '是' : '否'));
        if (r.hint) lines.push(r.hint);
        msg.textContent = lines.join('；');
        msg.className = 'site-status ' + (r.applied ? 'row-note-ok' : 'row-note-fail');
        setStatus('已克隆站点：' + r.domain + (r.applied ? '（已生效）' : '（未完全生效，见详情）'), r.applied ? 'ok' : 'fail');
        load();
      }, function (err) {
        submit.disabled = false;
        submit.textContent = '克隆站点';
        var text = cloneErrorText(err);
        if (err && err.hint && text.indexOf(err.hint) < 0) text += '（' + err.hint + '）';
        msg.textContent = '克隆失败：' + text;
        msg.className = 'site-status row-note-fail';
      });
    });
  }
  // ---------------- 流量统计（site.traffic，只读）----------------
  var TRAFFIC_REASONS = {
    no_log_file: '未开启访问日志，或在默认路径找不到日志文件',
    permission_denied: '日志文件存在，但插件没有读取权限',
    no_entries: '日志文件里没有可解析的访问记录'
  };
  function trafficEmptyText(r) {
    var why = TRAFFIC_REASONS[r.reason] || r.reason || '没有可用的访问日志';
    var lines = [why + '。'];
    if (r.reason === 'no_log_file') lines.push('在站点配置里加 `access_log /var/log/nginx/' + r.domain + '.access.log;` 后续访问就会开始记录。');
    if (r.reason === 'permission_denied') lines.push('日志通常是 root:adm 0640，需要让插件用户可读，或把日志放到插件数据目录后用日志路径指定。');
    if (r.reason === 'no_entries') lines.push('确认 access_log 使用 nginx 默认的 combined 格式。');
    if (r.hint) lines.push(r.hint);
    return lines.join(' ');
  }
  function paintTraffic(host, r) {
    host.textContent = '';
    if (!r.available) {
      var empty = add(host, el('div', 'empty-state'));
      add(empty, el('p', 'empty-state-text', trafficEmptyText(r)));
      if (r.tried && r.tried.length) {
        add(empty, el('p', 'field-hint', '已尝试：' + r.tried.join('、')));
      }
      add(empty, el('div', 'field-hint',
        '统计口径：最近 ' + (r.lines || 0) + ' 行日志；当前没有数据，不展示任何推算值。'));
      return;
    }
    var summary = add(host, el('table', 'rows site-traffic-table'));
    summary.appendChild(row('请求数', String(r.total_requests || 0)));
    summary.appendChild(row('发送字节', fmtBytes(r.bytes_sent)));
    summary.appendChild(row('独立 IP', String(r.unique_ips || 0)));
    summary.appendChild(row('时间范围', (r.window_start || '—') + ' ~ ' + (r.window_end || '—')));
    summary.appendChild(row('解析行数', (r.parsed || 0) + ' 行' + (r.skipped ? '（跳过 ' + r.skipped + ' 行）' : '')));
    var statusRows = (r.status || []).map(function (x) { return x.class + '：' + x.count; });
    if (statusRows.length) summary.appendChild(row('状态分布', statusRows.join(' · ')));
    function topTable(title, items, key) {
      if (!items || !items.length) return;
      var box = add(host, el('details', 'site-traffic-detail'));
      box.open = items.length <= 5;
      add(box, el('summary', null, title + '（' + items.length + '）'));
      var t = add(box, el('table', 'rows site-traffic-table'));
      items.forEach(function (item, i) {
        t.appendChild(row(String(i + 1), el('span', 'mono', item[key]) + ' · ' + item.count + ' 次'));
      });
    }
    topTable('热门路径 Top 10', r.top_paths, 'path');
    topTable('请求来源 IP Top 10', r.top_ips, 'ip');
    if (r.hint) add(host, el('p', 'field-hint', r.hint));
  }
  function loadTraffic(domain, host) {
    if (!host) return;
    host.textContent = '';
    add(host, el('p', 'muted', '正在读取访问日志统计…'));
    invoke('site.traffic', { domain: domain, lines: 500 }).then(function (r) {
      paintTraffic(host, r);
    }, function (err) {
      host.textContent = '';
      add(host, el('div', 'site-result-error', '流量统计读取失败：' + errText(err) + '（插件 0.4.2 之前没有该方法，请升级插件）'));
    });
  }
  function buildTrafficPanel(box, d) {
    var panel = add(box, el('section', 'panel site-edit-section'));
    var head = add(panel, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', '流量统计'));
    add(head, el('span', 'panel-meta', '解析 nginx 访问日志（只读）'));
    var refresh = add(head, el('button', 'btn btn-ghost', '刷新'));
    refresh.type = 'button';
    var host = add(panel, el('div', 'site-traffic-host'));
    on(refresh, function () { loadTraffic(d.domain, host); });
    loadTraffic(d.domain, host);
  }

  // ---------------- 访问保护（site.setPassword / clearPassword）----------------
  function passwordErrorText(err) {
    var code = err && err.code ? err.code : '';
    if (code === 'E_INVALID' && /密码/.test(String(err.message || ''))) {
      return '密码不符合要求：至少 8 个字符，不能包含换行。请换一个更长的密码。';
    }
    if (code === 'E_INVALID' && /用户名/.test(String(err.message || ''))) {
      return '用户名不合法：只允许字母、数字、点、下划线、连字符，1–32 位，且以字母或数字开头。';
    }
    if (code === 'E_NOTFOUND') return '站点不在插件清单里，请刷新站点列表后重试。';
    return errText(err);
  }
  function buildAccessPanel(box, d) {
    var panel = add(box, el('section', 'panel site-edit-section'));
    var head = add(panel, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', '访问保护'));
    var stateHost = add(head, el('span', 'site-state'));
    function paintState(mode, username) {
      stateHost.textContent = '';
      if (mode === 'protected') stateHost.appendChild(chip('ok', '已保护' + (username ? ' · ' + username : '')));
      else if (mode === 'public') stateHost.appendChild(chip('na', '公开访问'));
      else stateHost.appendChild(chip('na', '未确认'));
    }
    paintState(S.authState ? S.authState[d.domain] : undefined, S.authUser ? S.authUser[d.domain] : '');
    add(panel, el('p', 'field-hint',
      '开启后浏览器会弹出登录框；密码只保存为加盐哈希，本页面不会显示，也不会回传。'));
    var form = add(panel, el('form', 'site-form'));
    var userField = add(form, el('label', 'field'));
    add(userField, el('span', 'field-label', '用户名'));
    var username = add(userField, el('input', 'field-input'));
    username.type = 'text';
    username.value = 'site';
    username.autocomplete = 'username';
    username.setAttribute('data-field', 'auth-username');
    var passField = add(form, el('label', 'field'));
    add(passField, el('span', 'field-label', '密码（至少 8 个字符）'));
    var password = add(passField, el('input', 'field-input'));
    password.type = 'password';
    password.autocomplete = 'new-password';
    password.setAttribute('data-field', 'auth-password');
    var msg = add(form, el('div', 'site-status muted'));
    msg.setAttribute('role', 'status');
    var ops = add(form, el('div', 'site-edit-ops'));
    var submit = add(ops, el('button', 'btn btn-primary', '启用密码保护'));
    submit.type = 'submit';
    var clear = add(ops, el('button', 'btn btn-ghost', '关闭密码保护'));
    clear.type = 'button';
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var user = username.value.trim(), pass = password.value;
      if (!user) { msg.textContent = '请填写用户名。'; msg.className = 'site-status row-note-fail'; return; }
      if (!pass) { msg.textContent = '请填写密码（至少 8 个字符）。'; msg.className = 'site-status row-note-fail'; return; }
      submit.disabled = true;
      submit.textContent = '正在设置…';
      invoke('site.setPassword', { domain: d.domain, username: user, password: pass }).then(function (r) {
        submit.disabled = false;
        submit.textContent = '启用密码保护';
        password.value = '';
        S.authState = S.authState || {}; S.authState[d.domain] = true;
        S.authUser = S.authUser || {}; S.authUser[d.domain] = r.username || user;
        paintState('protected', S.authUser[d.domain]);
        msg.textContent = '已设置访问保护（用户名 ' + (r.username || user) + '）' + (r.changed ? '' : '；密码未变化') +
          '。密码不会显示也不回传，请自己妥善保存。';
        msg.className = 'site-status row-note-ok';
        setStatus('已为 ' + d.domain + ' 开启访问保护', 'ok');
      }, function (err) {
        submit.disabled = false;
        submit.textContent = '启用密码保护';
        msg.textContent = '设置失败：' + passwordErrorText(err);
        msg.className = 'site-status row-note-fail';
      });
    });
    on(clear, function () {
      clear.disabled = true;
      invoke('site.clearPassword', { domain: d.domain }).then(function (r) {
        clear.disabled = false;
        S.authState = S.authState || {}; S.authState[d.domain] = false;
        paintState('public');
        msg.textContent = r.changed ? '已关闭访问保护，站点恢复公开访问。' : '该站点本来就没有开启密码保护。';
        msg.className = 'site-status row-note-ok';
        setStatus('已关闭 ' + d.domain + ' 的访问保护', 'ok');
      }, function (err) {
        clear.disabled = false;
        msg.textContent = '关闭失败：' + passwordErrorText(err);
        msg.className = 'site-status row-note-fail';
      });
    });
    add(panel, el('p', 'field-hint',
      '说明：插件当前不提供"读取是否已开启"的接口，所以重新打开详情时状态显示为「未确认」；以设置/关闭的成功提示为准。'));
  }
  function paintDetail() {
    if (!S.detailHost) return;
    var d = S.detail;
    S.detailHost.textContent = '';
    S.editHost = null;
    if (!d) return;
    var box = add(S.detailHost, el('section', 'panel site-detail'));
    var head = add(box, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', tr('sites.detail.title', '站点详情') + ' · ' + d.domain));
    add(head, el('span', 'panel-meta', d.enabled ? tr('sites.detail.running', '运行中') : tr('sites.detail.stopped', '已停用')));
    var close = add(head, el('button', 'btn btn-ghost', tr('sites.detail.collapse', '收起')));
    close.type = 'button';
    on(close, function () { S.detail = null; paintDetail(); });
    var table = add(box, el('table', 'rows'));
    table.appendChild(row('启用状态', d.enabled ? chip('ok', '已启用') : chip('na', '已停用（配置保留）')));
    // 访问地址永远可见：建完之后最常做的事就是「打开看看」，不让用户自己拼 URL。
    var visitUrl = ((d.ssl && d.ssl.force_https) ? 'https://' : 'http://') + d.domain;
    var visitCell = el('span', 'site-visit');
    visitCell.appendChild(el('span', 'mono', visitUrl));
    var visitOpen = add(visitCell, el('button', 'btn btn-ghost btn-sm site-open-btn', '打开'));
    visitOpen.type = 'button';
    visitOpen.setAttribute('data-action', 'site-open');
    on(visitOpen, function () { window.open(visitUrl + '/', '_blank', 'noopener'); });
    var visitCopy = add(visitCell, el('button', 'btn btn-ghost btn-sm', '复制'));
    visitCopy.type = 'button';
    on(visitCopy, function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(visitUrl).then(function () { setStatus('访问地址已复制：' + visitUrl, 'ok'); },
          function () { setStatus('浏览器不允许自动复制：请手动选中地址 ' + visitUrl + ' 复制', 'fail'); });
      } else {
        setStatus('浏览器不允许自动复制：请手动选中地址 ' + visitUrl + ' 复制', 'fail');
      }
    });
    table.appendChild(row('访问地址', visitCell));
    table.appendChild(row('站点根目录', el('span', 'mono', d.root || '—')));
    table.appendChild(row('监听端口', d.port || '—'));
    table.appendChild(row('默认文档', (d.index || []).join(' ') || '—'));
    var sslCell = el('span', 'site-state');
    if (d.ssl && d.ssl.bound) {
      sslCell.appendChild(chip('ok', '已绑定'));
      sslCell.appendChild(el('span', 'muted', d.ssl.force_https ? '强制 HTTPS' : 'HTTP/HTTPS 并存'));
    } else {
      sslCell.appendChild(chip('na', '未绑定'));
    }
    table.appendChild(row('SSL', sslCell));
    var rwTemplate = (d.rewrite && d.rewrite.template) || 'none';
    var rwCell = el('span', null, rwTemplate);
    if (isPHPTemplate(rwTemplate)) {
      rwCell.appendChild(el('span', 'muted', d.php && d.php.enabled
        ? ' · PHP ' + (d.php.version || 'auto') + ' 已启用'
        : ' · 未启用 PHP（页面会 404，请在下方 PHP-FPM 面板配置）'));
    }
    table.appendChild(row('伪静态', rwCell));
    table.appendChild(row('反向代理', d.proxy && d.proxy.enabled
      ? el('span', 'mono', d.proxy.upstream + (d.proxy.ws ? ' · WebSocket' : ''))
      : '未启用'));
    table.appendChild(row('重定向', (d.redirects || []).length + ' 条'));
    table.appendChild(row('vhost 路径', el('span', 'mono', d.vhost_path || '—')));
    table.appendChild(row('在插件清单内', d.managed ? '是' : '否'));
    table.appendChild(row('站点目录', d.site_dir_exists ? '存在' : '缺失或未创建'));
    if (d.site_dir_state && d.site_dir_state !== 'present') {
      table.appendChild(row('目录判定', dirStateText(d.site_dir_state) + (d.site_dir_reason ? '（' + d.site_dir_reason + '）' : '')));
    }
    var statusPanel = add(box, el('section', 'panel site-edit-section'));
    var statusHead = add(statusPanel, el('div', 'panel-head'));
    add(statusHead, el('span', 'panel-title', tr('sites.status.title', '运行状态')));
    add(statusHead, el('span', 'panel-meta', tr('sites.status.meta', '配置 / 校验 / 目录 / 加载')));
    var recheck = add(statusHead, el('button', 'btn btn-ghost', tr('sites.status.recheck', '重新检查')));
    recheck.type = 'button';
    var statusHost = add(statusPanel, el('div', 'site-status-host'));
    on(recheck, function () { loadStatus(d.domain, statusHost); });
    loadStatus(d.domain, statusHost);
    buildClonePanel(box, d);
    buildTrafficPanel(box, d);
    buildAccessPanel(box, d);
    S.editHost = add(box, el('div', 'site-edit-host'));
    loadEditor(d);
  }
  function paintList() {
    if (!S.listHost) return;
    S.listHost.textContent = '';
    if (S.listMeta) S.listMeta.textContent = S.sites.length ? '共 ' + S.sites.length + ' 个站点' : '';
    if (!S.sites.length) {
      var empty = add(S.listHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', tr('sites.empty.hint', '还没有站点：在上方填域名、点「一键创建站点」，目录会自动推断，几秒就能建好第一个站点。')));
      var cta = add(empty, el('button', 'btn btn-primary', tr('sites.empty.cta', '创建第一个站点')));
      cta.type = 'button';
      on(cta, function () {
        var input = document.querySelector('[data-field="domain"]');
        if (input) { input.focus(); input.scrollIntoView({ block: 'center' }); }
      });
      return;
    }
    var table = add(S.listHost, el('table', 'sites-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    [tr('sites.col.domain', '域名'), tr('sites.col.status', '生效状态'), tr('sites.col.actions', '操作')].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.sites.forEach(function (site) {
      var trEl = add(body, el('tr', site.enabled ? '' : 'site-off'));
      trEl.setAttribute('data-site', site.domain);
      var domain = add(trEl, el('td', 'site-domain'));
      domain.dataset.label = '域名';
      var link = add(domain, el('button', 'site-link mono', site.domain));
      link.type = 'button';
      link.setAttribute('data-action', 'site-detail');
      link.setAttribute('data-site', site.domain);
      on(link, function () { openDetail(site.domain); });
      var state = add(trEl, el('td', 'site-state'));
      state.dataset.label = '生效状态';
      if (!site.enabled) state.appendChild(chip('na', site.disabled ? '已停用' : '未启用'));
      state.appendChild(flag(site.exists, false, 'vhost 存在', 'vhost 缺失'));
      state.appendChild(flag(site.test_ok, site.test_skipped, 'nginx -t 通过', 'nginx -t 失败', site.test_output));
      state.appendChild(flag(site.reloaded, site.reload_skipped, '已加载', '未加载'));
      if (!site.test_ok && !site.test_skipped && site.test_output) {
        var why = add(state, el('span', 'row-note-fail site-test-brief', summarize(site.test_output)));
        why.title = site.test_output;
      }
      var ops = add(trEl, el('td', 'cell-ops'));
      ops.dataset.label = '操作';
      var manage = add(ops, el('button', 'btn', tr('sites.action.manage', '管理')));
      manage.type = 'button'; manage.setAttribute('data-action', 'site-manage');
      on(manage, function () { openDetail(site.domain); });
      if (site.exists || site.disabled) {
        var toggle = add(ops, el('button', 'btn btn-ghost', site.enabled ? tr('sites.action.disable', '停用') : tr('sites.action.enable', '启用')));
        toggle.type = 'button';
        toggle.setAttribute('data-action', site.enabled ? 'site-disable' : 'site-enable');
        on(toggle, function () { toggleSite(site); });
      }
      var check = add(ops, el('button', 'btn btn-ghost', tr('sites.action.status', '状态'))); check.type = 'button';
      check.setAttribute('data-action', 'site-status');
      var live = add(state, el('div', 'site-live-status muted'));
      on(check, function () {
        live.textContent = '检查中…';
        live.className = 'site-live-status muted';
        invoke('site.status', { domain: site.domain }).then(function (d) {
          live.textContent = '';
          live.className = 'site-live-status';
          live.appendChild(flag(d.test_passed, d.test_skipped, '配置通过', '配置失败', d.test_output));
          live.appendChild(chip(d.site_dir_state === 'present' ? 'ok' : d.site_dir_state === 'absent' ? 'fail' : 'na',
            '目录' + dirStateText(d.site_dir_state)));
          live.appendChild(flag(d.loaded, !d.load_checked, '已加载', '未加载'));
        }, function (err) {
          live.textContent = '检查失败：' + errText(err);
          live.className = 'site-live-status row-note-fail';
        });
      });
      var del = add(ops, el('button', 'btn btn-ghost sites-del', tr('sites.action.delete', '删除'))); del.type = 'button';
      del.setAttribute('data-action', 'site-delete');
      on(del, function () { removeSite(site.domain); });
    });
  }
  function load(silent) {
    if (!silent) setStatus(tr('sites.load.loading', '正在读取站点列表…'));
    return invoke('site.list', {}).then(function (data) {
      S.plugin = 'ready';
      S.nginxMode = data && data.nginx_mode ? String(data.nginx_mode) : '';
      S.nginxReason = data && data.nginx_reason ? String(data.nginx_reason) : '';
      S.sites = Array.isArray(data.sites) ? data.sites : [];
      paintNginxNotice();
      paintList();
      if (!silent) setStatus(S.sites.length ? tr('sites.load.ok', '站点列表已刷新') : tr('sites.load.none', '还没有站点：在上方填一个域名、点「一键创建站点」就能建好第一个'), 'ok');
    }, function (err) {
      if (err && err.code === 'E_NOTFOUND') {
        // 新用户第一次点进「网站」的常见状态：内核没装站点插件。给一键安装入口，不留死胡同。
        S.plugin = 'missing';
        paintNginxNotice();
        paintMissingPlugin();
        if (!silent) setStatus('网站管理要先装站点插件：点下面的「一键安装站点插件」，装好就能建站', 'fail');
        return;
      }
      if (!silent) setStatus(tr('sites.load.failed', '站点列表读取失败：') + errText(err) + (hintFor('', err) ? ' ' + hintFor('', err) : ''), 'fail');
    });
  }
  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', tr('sites.title', '网站管理')));
    add(head, el('p', 'view-sub', tr('sites.subtitle', '填域名一次提交即可建站：目录自动推断并可选自动创建；SSL 与伪静态收在高级选项，点域名继续管理。')));
    S.resultHost = add(root, el('div', 'site-result-host'));
    S.wizardHost = add(root, el('div', 'site-wizard-host'));
    S.nginxHost = add(root, el('div', 'site-nginx-host'));
    S.configHost = add(root, el('div', 'site-config-host'));
    S.configHost.hidden = true;
    var cfgToggle = add(head, el('button', 'btn btn-ghost', tr('sites.config.button', '连接配置')));
    cfgToggle.type = 'button';
    cfgToggle.setAttribute('data-action', 'site-config');
    // 存一份切换函数：nginx 未检测到的提示条里也放同一个入口，不复制状态。
    S.configToggle = function () {
      S.configHost.hidden = !S.configHost.hidden;
      cfgToggle.textContent = S.configHost.hidden ? tr('sites.config.button', '连接配置') : tr('sites.config.collapse', '收起连接配置');
      if (!S.configHost.hidden && !S.configHost.dataset.loaded) {
        S.configHost.dataset.loaded = '1';
        loadConfig(S.configHost);
      }
    };
    on(cfgToggle, S.configToggle);
    S.status = add(root, el('div', 'site-status muted'));
    S.status.setAttribute('role', 'status');
    var listPanel = add(root, el('section', 'panel'));
    var listHead = add(listPanel, el('div', 'panel-head'));
    add(listHead, el('span', 'panel-title', tr('sites.list.title', '站点列表')));
    S.listMeta = add(listHead, el('span', 'panel-meta', ''));
    var refresh = add(listHead, el('button', 'btn btn-ghost', tr('sites.refresh', '刷新'))); refresh.type = 'button';
    refresh.setAttribute('data-action', 'site-refresh');
    on(refresh, function () { load(); });
    S.listHost = add(listPanel, el('div', 'sites-list-host'));
    S.detailHost = add(root, el('div', 'site-detail-host'));
  }
  function render(container) {
    if (!container) return null;
    container.textContent = '';
    S.sites = []; S.detail = null; S.editor = null; S.editorReady = null;
    S.plugin = ''; S.nginxMode = ''; S.nginxReason = ''; S.storeEntry = null;
    var root = add(container, el('section', 'sites'));
    build(root);
    load();
    loadWizard();
  }
  window.KoreSites = { render: render };
})();
