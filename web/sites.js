/* kore 主壳 · 网站管理（web/sites.js）
   入口 window.KoreSites.render(container)，零框架 / 零 CDN / 无外链。
   调用形态：POST /api/v1/invoke/<id>/<id>.<action>（本例 /api/v1/invoke/site/site.list）；方法段写完整限定名。
   本页负责：站点列表与 site.get 完整摘要、启停/删除，以及懒加载 site-edit.js 提供的
   建站向导与 L2 配置编辑器。结果只展示插件真实字段（test_passed / reloaded / applied /
   changed / ssl_bound / rewrite_cleared 等），不把"配置写过了"说成"站点已生效"。 */
(function () {
  'use strict';
  var API = '/api/v1/invoke/site/';
  var S = { sites: [], detail: null, editor: null, editorReady: null };
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
  function errText(err) {
    var text = err && err.message ? String(err.message) : '未知错误';
    if (err && err.detail && text.indexOf(err.detail) < 0) text += '（' + err.detail + '）';
    return text;
  }
  function hintFor(action, err) {
    var msg = err ? String(err.message || '') : '';
    if (err && err.code === 'E_CONFLICT') return '目标已存在或状态冲突：刷新后按当前状态重试。';
    if (/nginx 配置校验失败/.test(msg)) return '配置未通过 nginx -t，插件已回滚；请检查路径、端口或模板是否冲突。';
    if (/重载失败/.test(msg)) return '文件已写入但 nginx 未确认；页面的 applied/reloaded 会如实显示。';
    if (/证书|私钥|cert_path|key_path/.test(msg)) return '证书与私钥必须是存在的绝对路径，且与证书域名匹配。';
    if (/upstream/.test(msg)) return '反代只接受 http://host:port，不支持 https 或带路径的地址。';
    if (/template/.test(msg)) return '伪静态只支持 none / wordpress / laravel / thinkphp / discuz / nextjs。';
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
    add(box, el('div', 'kore-modal-title', '删除确认'));
    add(box, el('p', 'kore-modal-text', text));
    var msg = add(box, el('div', 'kore-modal-msg'));
    var ops = add(box, el('div', 'kore-modal-actions'));
    var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
    var ok = add(ops, el('button', 'btn btn-primary', '确认删除')); ok.type = 'button';
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
        : function (created) { load(true).then(function () { if (created) return openDetail(created, true); }); }
    };
  }
  function loadWizard() {
    if (!S.wizardHost) return;
    S.wizardHost.textContent = '';
    add(S.wizardHost, el('div', 'stub', '正在加载建站向导…'));
    ensureEdit().then(function (mod) {
      if (!S.wizardHost) return;
      S.wizardHost.textContent = '';
      mod.renderWizard(S.wizardHost, moduleCtx('', false));
    }, function (err) {
      if (!S.wizardHost) return;
      S.wizardHost.textContent = '';
      add(S.wizardHost, el('div', 'site-result-error', '建站向导加载失败：' + errText(err)));
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
        input = add(box, el('input', 'files-checkbox'));
        input.type = 'checkbox';
      } else {
        input = add(box, el('input', 'field-input'));
        input.type = f.type === 'int' ? 'number' : 'text';
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.placeholder) input.placeholder = f.placeholder;
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
  function paintDetail() {
    if (!S.detailHost) return;
    var d = S.detail;
    S.detailHost.textContent = '';
    S.editHost = null;
    if (!d) return;
    var box = add(S.detailHost, el('section', 'panel site-detail'));
    var head = add(box, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', '站点详情 · ' + d.domain));
    add(head, el('span', 'panel-meta', d.enabled ? '运行中' : '已停用'));
    var close = add(head, el('button', 'btn btn-ghost', '收起'));
    close.type = 'button';
    on(close, function () { S.detail = null; paintDetail(); });
    var table = add(box, el('table', 'rows'));
    table.appendChild(row('启用状态', d.enabled ? chip('ok', '已启用') : chip('na', '已停用（配置保留）')));
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
    table.appendChild(row('伪静态', (d.rewrite && d.rewrite.template) || 'none'));
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
    add(statusHead, el('span', 'panel-title', '运行状态'));
    add(statusHead, el('span', 'panel-meta', '配置 / 校验 / 目录 / 加载'));
    var recheck = add(statusHead, el('button', 'btn btn-ghost', '重新检查'));
    recheck.type = 'button';
    var statusHost = add(statusPanel, el('div', 'site-status-host'));
    on(recheck, function () { loadStatus(d.domain, statusHost); });
    loadStatus(d.domain, statusHost);
    buildClonePanel(box, d);
    S.editHost = add(box, el('div', 'site-edit-host'));
    loadEditor(d);
  }
  function paintList() {
    if (!S.listHost) return;
    S.listHost.textContent = '';
    if (S.listMeta) S.listMeta.textContent = S.sites.length ? '共 ' + S.sites.length + ' 个站点' : '';
    if (!S.sites.length) {
      var empty = add(S.listHost, el('div', 'panel-empty empty-state'));
      add(empty, el('p', 'empty-state-text', '还没有站点：用上面的建站向导创建第一个站点，向导会自动填好根目录。'));
      var cta = add(empty, el('button', 'btn btn-primary', '创建第一个站点'));
      cta.type = 'button';
      on(cta, function () {
        var input = document.querySelector('[data-field="domain"]');
        if (input) { input.focus(); input.scrollIntoView({ block: 'center' }); }
      });
      return;
    }
    var table = add(S.listHost, el('table', 'sites-table'));
    var head = add(table, el('thead')), htr = add(head, el('tr'));
    ['域名', '生效状态', '操作'].forEach(function (label) { add(htr, el('th', null, label)); });
    var body = add(table, el('tbody'));
    S.sites.forEach(function (site) {
      var tr = add(body, el('tr', site.enabled ? '' : 'site-off'));
      tr.setAttribute('data-site', site.domain);
      var domain = add(tr, el('td', 'site-domain'));
      domain.dataset.label = '域名';
      var link = add(domain, el('button', 'site-link mono', site.domain));
      link.type = 'button';
      link.setAttribute('data-action', 'site-detail');
      link.setAttribute('data-site', site.domain);
      on(link, function () { openDetail(site.domain); });
      var state = add(tr, el('td', 'site-state'));
      state.dataset.label = '生效状态';
      if (!site.enabled) state.appendChild(chip('na', site.disabled ? '已停用' : '未启用'));
      state.appendChild(flag(site.exists, false, 'vhost 存在', 'vhost 缺失'));
      state.appendChild(flag(site.test_ok, site.test_skipped, 'nginx -t 通过', 'nginx -t 失败', site.test_output));
      state.appendChild(flag(site.reloaded, site.reload_skipped, '已加载', '未加载'));
      if (!site.test_ok && !site.test_skipped && site.test_output) {
        var why = add(state, el('span', 'row-note-fail site-test-brief', summarize(site.test_output)));
        why.title = site.test_output;
      }
      var ops = add(tr, el('td', 'cell-ops'));
      ops.dataset.label = '操作';
      var manage = add(ops, el('button', 'btn', '管理'));
      manage.type = 'button'; manage.setAttribute('data-action', 'site-manage');
      on(manage, function () { openDetail(site.domain); });
      if (site.exists || site.disabled) {
        var toggle = add(ops, el('button', 'btn btn-ghost', site.enabled ? '停用' : '启用'));
        toggle.type = 'button';
        toggle.setAttribute('data-action', site.enabled ? 'site-disable' : 'site-enable');
        on(toggle, function () { toggleSite(site); });
      }
      var check = add(ops, el('button', 'btn btn-ghost', '状态')); check.type = 'button';
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
      var del = add(ops, el('button', 'btn btn-ghost sites-del', '删除')); del.type = 'button';
      del.setAttribute('data-action', 'site-delete');
      on(del, function () { removeSite(site.domain); });
    });
  }
  function load(silent) {
    if (!silent) setStatus('正在读取站点列表…');
    return invoke('site.list', {}).then(function (data) {
      S.sites = Array.isArray(data.sites) ? data.sites : [];
      paintList();
      if (!silent) setStatus(S.sites.length ? '站点列表已刷新' : '还没有站点，用上方向导创建第一个站点', 'ok');
    }, function (err) { if (!silent) setStatus('站点列表读取失败：' + errText(err), 'fail'); });
  }
  function build(root) {
    var head = add(root, el('header', 'view-head'));
    add(head, el('h2', 'view-title', '网站管理'));
    add(head, el('p', 'view-sub', '向导一次收齐域名、根目录、SSL 与伪静态；点域名查看完整配置并继续管理。'));
    S.resultHost = add(root, el('div', 'site-result-host'));
    S.wizardHost = add(root, el('div', 'site-wizard-host'));
    S.configHost = add(root, el('div', 'site-config-host'));
    S.configHost.hidden = true;
    var cfgToggle = add(head, el('button', 'btn btn-ghost', '连接配置'));
    cfgToggle.type = 'button';
    cfgToggle.setAttribute('data-action', 'site-config');
    on(cfgToggle, function () {
      S.configHost.hidden = !S.configHost.hidden;
      cfgToggle.textContent = S.configHost.hidden ? '连接配置' : '收起连接配置';
      if (!S.configHost.hidden && !S.configHost.dataset.loaded) {
        S.configHost.dataset.loaded = '1';
        loadConfig(S.configHost);
      }
    });
    S.status = add(root, el('div', 'site-status muted'));
    S.status.setAttribute('role', 'status');
    var listPanel = add(root, el('section', 'panel'));
    var listHead = add(listPanel, el('div', 'panel-head'));
    add(listHead, el('span', 'panel-title', '站点列表'));
    S.listMeta = add(listHead, el('span', 'panel-meta', ''));
    var refresh = add(listHead, el('button', 'btn btn-ghost', '刷新')); refresh.type = 'button';
    on(refresh, load);
    S.listHost = add(listPanel, el('div', 'sites-list-host'));
    S.detailHost = add(root, el('div', 'site-detail-host'));
  }
  function render(container) {
    if (!container) return null;
    container.textContent = '';
    S.sites = []; S.detail = null; S.editor = null; S.editorReady = null;
    var root = add(container, el('section', 'sites'));
    build(root);
    load();
    loadWizard();
  }
  window.KoreSites = { render: render };
})();
