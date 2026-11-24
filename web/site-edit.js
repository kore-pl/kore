/* kore 主壳 · 网站 L2 配置编辑器（web/site-edit.js）
   由 web/sites.js 首次渲染建站向导/打开站点详情时懒加载，导出
   window.KoreSiteEdit.renderWizard(host, ctx) 与 render(host, ctx, data)。
   向导一次收齐域名 + 根目录（自动填 /var/www/<域名>）+ SSL + 伪静态，内部串行
   create → bindSSL → setRewrite →（PHP 模板时）setPHP 并逐步回显。data 是 site.get 的完整摘要；
   编辑器覆盖：SSL bindSSL/unbindSSL、伪静态 setRewrite（当前值取自 getRewrite）、
   PHP-FPM getPHP/setPHP/unsetPHP（wordpress/laravel/thinkphp/discuz 依赖，版本来自
   getPHP.available 动态填充）、反向代理 setProxy/unsetProxy（与伪静态互斥）、
   重定向 setRedirect/unsetRedirect、默认文档 setIndex。
   每个写操作只展示插件真实返回（changed/applied/test_passed/reloaded/ssl_bound/
   rewrite_cleared/proxy_cleared），写入成功后由 ctx.after() 重新拉 site.get。 */
(function () {
  'use strict';
  var TEMPLATES = ['none', 'wordpress', 'laravel', 'thinkphp', 'discuz', 'nextjs'];
  // 与后端 isPHPRewriteTemplate（../kore-plugin-site/php.go:79）同一枚举：这四个模板
  // 必须配 PHP-FPM，否则 nginx 当静态处理、页面永远 404。判定只认这四个，不认 nextjs/none。
  var PHP_TEMPLATES = ['wordpress', 'laravel', 'thinkphp', 'discuz'];
  function isPHPTemplate(name) { return PHP_TEMPLATES.indexOf(name) >= 0; }
  function certBase(file) { return String(file || '').replace(/\.(crt|pem)$/i, ''); }
  function autoRoot(domain) { return domain ? '/var/www/' + domain : ''; }
  function paintSteps(host, steps) {
    host.textContent = '';
    if (!steps.length) return;
    var box = document.createElement('div'); box.className = 'wizard-steps'; host.appendChild(box);
    steps.forEach(function (step, index) {
      var line = document.createElement('div');
      line.className = 'wizard-step wizard-step-' + step.state;
      [['wizard-step-no', String(index + 1)], ['wizard-step-name', step.name],
        ['wizard-step-state', step.state === 'ok' ? '成功' : step.state === 'fail' ? '失败' : '跳过'],
        ['wizard-step-detail', step.detail || '']].forEach(function (pair) {
        var cell = document.createElement('span'); cell.className = pair[0]; cell.textContent = pair[1];
        line.appendChild(cell);
      });
      if (step.hint) {
        var hint = document.createElement('span'); hint.className = 'wizard-step-hint'; hint.textContent = step.hint;
        line.appendChild(hint);
      }
      box.appendChild(line);
    });
  }
  // 建站向导：一次表单收齐 域名 + 根目录（自动填 /var/www/<域名>）+ SSL + 伪静态，
  // 提交后按 create → bindSSL → setRewrite 串行执行并逐步回显；任一步失败即停。
  function renderWizard(host, ctx) {
    var el = ctx.ui.el, add = ctx.ui.add, on = ctx.ui.on;
    host.textContent = '';
    var panel = add(host, el('section', 'panel'));
    var head = add(panel, el('div', 'panel-head'));
    add(head, el('span', 'panel-title', '建站向导'));
    add(head, el('span', 'panel-meta', '一次提交：create → bindSSL → setRewrite（PHP 模板再接 setPHP）'));
    var form = add(panel, el('form', 'site-form site-wizard'));
    var w = { rootTouched: false, certs: [], certLoaded: false, certError: '' };
    var domainField = add(form, el('label', 'field'));
    add(domainField, el('span', 'field-label', '域名（小写，至少两个标签）'));
    w.domain = add(domainField, el('input', 'field-input'));
    w.domain.type = 'text'; w.domain.placeholder = 'l2ui.kore.test'; w.domain.autocomplete = 'off';
    w.domain.setAttribute('data-field', 'domain');
    var rootField = add(form, el('label', 'field'));
    var rootLabel = add(rootField, el('span', 'field-label', '站点根目录'));
    w.badge = add(rootLabel, el('span', 'auto-badge', '已自动填入'));
    w.badge.hidden = true;
    w.root = add(rootField, el('input', 'field-input'));
    w.root.type = 'text'; w.root.placeholder = '/var/www/l2ui.kore.test'; w.root.autocomplete = 'off';
    w.root.setAttribute('data-field', 'root');
    var sslLine = add(form, el('label', 'field field-check'));
    w.ssl = add(sslLine, el('input', 'files-checkbox'));
    w.ssl.type = 'checkbox';
    add(sslLine, el('span', null, '同时启用 SSL（证书从 ssl.list 选择）'));
    w.sslBox = add(form, el('div', 'wizard-ssl'));
    w.sslBox.hidden = true;
    var certField = add(w.sslBox, el('label', 'field'));
    add(certField, el('span', 'field-label', '证书（ssl.list）'));
    w.cert = add(certField, el('select', 'field-input'));
    w.cert.setAttribute('data-field', 'ssl-cert');
    var dirField = add(w.sslBox, el('label', 'field'));
    add(dirField, el('span', 'field-label', '证书目录（KORE_SSL_CERT_DIR）'));
    w.certDir = add(dirField, el('input', 'field-input'));
    w.certDir.type = 'text'; w.certDir.value = '/etc/kore/ssl'; w.certDir.autocomplete = 'off';
    w.certDir.setAttribute('data-field', 'ssl-dir');
    w.certHint = add(w.sslBox, el('p', 'field-hint', '选择证书后自动拼接 cert_path 与同名 .key 私钥路径'));
    var rewriteField = add(form, el('label', 'field'));
    add(rewriteField, el('span', 'field-label', '伪静态模板'));
    w.rewrite = add(rewriteField, el('select', 'field-input'));
    w.rewrite.setAttribute('data-field', 'rewrite');
    TEMPLATES.forEach(function (name) {
      var opt = add(w.rewrite, el('option', null, name === 'none' ? 'none（默认，不启用）' : name));
      opt.value = name;
    });
    // PHP-FPM 表单：选 wordpress/laravel/thinkphp/discuz 才显示。建站阶段站点尚未落盘，
    // getPHP.available 无从读取，故这里给「auto 自动检测」+ 可选手填 socket，不硬编码版本；
    // 真正的版本下拉（来自 getPHP.available）在编辑器伪静态面板提供。
    w.phpBox = add(form, el('div', 'wizard-php'));
    w.phpBox.hidden = !isPHPTemplate(w.rewrite.value);
    add(w.phpBox, el('p', 'field-hint', '所选模板需要 PHP-FPM 才能访问；不配置页面会一直 404。版本填 auto 会自动选用已检测到的最高版本；如未检测到，可先留空建站，再到站点详情里选版本。'));
    var phpVerField = add(w.phpBox, el('label', 'field'));
    add(phpVerField, el('span', 'field-label', 'PHP 版本（auto = 自动检测）'));
    w.phpVersion = add(phpVerField, el('input', 'field-input'));
    w.phpVersion.type = 'text'; w.phpVersion.value = 'auto'; w.phpVersion.placeholder = 'auto'; w.phpVersion.autocomplete = 'off';
    w.phpVersion.setAttribute('data-field', 'php-version');
    var phpSockField = add(w.phpBox, el('label', 'field'));
    add(phpSockField, el('span', 'field-label', 'FPM socket（可选，留空自动检测）'));
    w.phpSocket = add(phpSockField, el('input', 'field-input'));
    w.phpSocket.type = 'text'; w.phpSocket.placeholder = '/run/php/php-fpm.sock'; w.phpSocket.autocomplete = 'off';
    w.phpSocket.setAttribute('data-field', 'php-socket');
    w.rewrite.addEventListener('change', function () { w.phpBox.hidden = !isPHPTemplate(w.rewrite.value); });
    var submit = add(form, el('button', 'btn btn-primary site-submit', '创建站点并应用'));
    submit.type = 'submit'; submit.setAttribute('data-action', 'wizard-submit');
    var stepsHost = add(panel, el('div', 'wizard-steps-host'));
    function syncRoot() {
      if (w.rootTouched) return;
      w.root.value = autoRoot(w.domain.value.trim().toLowerCase());
      w.badge.hidden = !w.domain.value.trim();
    }
    function syncCertHint() {
      var dir = (w.certDir.value.trim() || '/etc/kore/ssl').replace(/\/+$/, '');
      w.certHint.textContent = w.cert.value
        ? '证书：' + dir + '/' + w.cert.value + '；私钥：' + dir + '/' + certBase(w.cert.value) + '.key'
        : '证书目录为空或读取失败时，请先在 SSL 页自签或导入';
    }
    function paintCerts() {
      w.cert.textContent = '';
      if (w.certs.length) {
        w.certs.forEach(function (cert) {
          var opt = add(w.cert, el('option', null, (cert.domain || cert.file) + ' · ' + cert.file + '（' + cert.days_left + ' 天）'));
          opt.value = cert.file;
        });
      } else {
        var opt = add(w.cert, el('option', null, w.certError ? '证书列表读取失败，可在 SSL 页检查插件' : '证书目录为空，请先在 SSL 页自签或导入'));
        opt.value = '';
      }
      syncCertHint();
    }
    function loadCerts() {
      if (w.certLoaded) return;
      w.certLoaded = true;
      ctx.setStatus('正在读取证书列表…');
      ctx.invokeSSL('ssl.list', {}).then(function (data) {
        w.certs = Array.isArray(data.certs) ? data.certs : [];
        paintCerts();
      }, function (err) { w.certError = ctx.errText(err); paintCerts(); ctx.setStatus('证书列表读取失败：' + w.certError, 'fail'); });
    }
    w.domain.addEventListener('input', function () {
      w.domain.value = w.domain.value.toLowerCase();
      syncRoot();
    });
    w.root.addEventListener('input', function () {
      w.rootTouched = !!w.root.value.trim();
      w.badge.hidden = true;
    });
    w.ssl.addEventListener('change', function () {
      w.sslBox.hidden = !w.ssl.checked;
      if (w.ssl.checked) loadCerts();
    });
    w.cert.addEventListener('change', syncCertHint);
    w.certDir.addEventListener('input', syncCertHint);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var domain = w.domain.value.trim().toLowerCase();
      var rootPath = w.root.value.trim();
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        ctx.setStatus('域名非法：仅允许小写字母数字、连字符与点，且至少两个标签', 'fail'); w.domain.focus(); return;
      }
      if (!rootPath || rootPath.charAt(0) !== '/') {
        ctx.setStatus('站点根目录必须是绝对路径', 'fail'); w.root.focus(); return;
      }
      if (w.ssl.checked && !w.cert.value) {
        ctx.setStatus('已勾选 SSL，但证书下拉为空：请先在 SSL 页自签/导入，或取消勾选', 'fail'); return;
      }
      var steps = [], stopped = false;
      function record(step) { steps.push(step); paintSteps(stepsHost, steps); }
      function runStep(name, run, describe) {
        if (stopped) { record({ name: name, state: 'skip', detail: '前一步失败，未执行' }); return Promise.resolve(null); }
        ctx.setStatus('正在执行：' + name + '…');
        return run().then(function (res) {
          record({ name: name, state: 'ok', detail: describe(res) });
          return res;
        }, function (err) {
          stopped = true;
          record({ name: name, state: 'fail', detail: ctx.errText(err), hint: ctx.hintFor(name, err) });
          return null;
        });
      }
      var dir = (w.certDir.value.trim() || '/etc/kore/ssl').replace(/\/+$/, '');
      var chain = runStep('创建站点 create', function () {
        return ctx.invoke('site.create', { domain: domain, root: rootPath });
      }, function (r) {
        return (r.vhost_path || '') + '；nginx -t ' + (r.test_skipped ? '未检测' : r.test_passed ? '通过' : '失败') +
          '；reload ' + (r.reload_skipped ? '未执行' : r.reloaded ? '已重载' : '未重载');
      });
      if (w.ssl.checked) {
        chain = chain.then(function () {
          return runStep('绑定证书 bindSSL', function () {
            return ctx.invoke('site.bindSSL', {
              domain: domain, cert_path: dir + '/' + w.cert.value,
              key_path: dir + '/' + certBase(w.cert.value) + '.key', force_https: true
            });
          }, function (r) { return 'ssl_bound=' + r.ssl_bound + '；force_https=' + r.force_https; });
        });
      }
      var needPHP = isPHPTemplate(w.rewrite.value);
      if (w.rewrite.value !== 'none') {
        chain = chain.then(function () {
          return runStep('设置伪静态 setRewrite', function () {
            return ctx.invoke('site.setRewrite', { domain: domain, template: w.rewrite.value });
          }, function (r) {
            return 'template=' + r.template + (r.proxy_cleared ? '；已自动清除反向代理（互斥）' : '');
          });
        });
      }
      // 伪静态是 PHP 模板时串一步 setPHP；失败即停并原样展示后端 message（含"先设 none"怎么办）。
      if (needPHP) {
        chain = chain.then(function () {
          return runStep('启用 PHP-FPM setPHP', function () {
            var params = { domain: domain };
            var ver = w.phpVersion.value.trim();
            var sock = w.phpSocket.value.trim();
            if (ver) params.php_version = ver;
            if (sock) params.socket = sock;
            return ctx.invoke('site.setPHP', params);
          }, function (r) {
            return 'version=' + (r.php_version || 'auto') + '；socket=' + (r.php_socket || '自动检测') +
              (r.php_socket_verified ? '（已验证）' : r.php_hint ? '（' + r.php_hint + '）' : '');
          });
        });
      }
      submit.disabled = true;
      chain.then(function () {
        submit.disabled = false;
        var failed = steps.filter(function (s) { return s.state === 'fail'; });
        if (failed.length) {
          ctx.setStatus('建站未完成：' + failed[0].name + ' 失败，请查看步骤明细后重试', 'fail');
          ctx.after('');
          return;
        }
        ctx.setStatus('已创建 ' + domain + '，共 ' + steps.length + ' 步全部成功', 'ok');
        w.domain.value = ''; w.root.value = ''; w.rootTouched = false; w.badge.hidden = true;
        w.ssl.checked = false; w.sslBox.hidden = true; w.rewrite.value = 'none';
        w.phpBox.hidden = true; w.phpVersion.value = 'auto'; w.phpSocket.value = '';
        ctx.after(domain);
      });
    });
  }
  function renderEditor(host, ctx, data) {
    var el = ctx.ui.el, add = ctx.ui.add, on = ctx.ui.on;
    var domain = data.domain;
    host.textContent = '';
    var root = add(host, el('div', 'site-edit'));
    var status = add(root, el('div', 'site-edit-status muted'));
    status.setAttribute('role', 'status');
    var grid = add(root, el('div', 'site-edit-grid'));
    function panel(title, meta) {
      var box = add(grid, el('section', 'panel site-edit-section'));
      var head = add(box, el('div', 'panel-head'));
      add(head, el('span', 'panel-title', title));
      if (meta) add(head, el('span', 'panel-meta', meta));
      return box;
    }
    function field(form, label, value, placeholder) {
      var box = add(form, el('label', 'field'));
      add(box, el('span', 'field-label', label));
      var input = add(box, el('input', 'field-input'));
      input.type = 'text'; input.autocomplete = 'off';
      input.value = value || '';
      if (placeholder) input.placeholder = placeholder;
      return input;
    }
    function action(ops, label, cls, name, fn) {
      var btn = add(ops, el('button', 'btn ' + cls, label));
      btn.type = 'button';
      btn.setAttribute('data-action', name);
      on(btn, fn);
      return btn;
    }
    function info(r) {
      var parts = [];
      if (r && r.changed !== undefined) parts.push(r.changed ? '已写盘' : '未变更（短路）');
      if (r) {
        if (r.test_skipped) parts.push('nginx -t 未检测');
        else if (r.test_passed !== undefined) parts.push(r.test_passed ? 'nginx -t 通过' : 'nginx -t 失败');
        if (r.reload_skipped) parts.push('reload 未执行');
        else if (r.reloaded !== undefined) parts.push(r.reloaded ? '已 reload' : '未 reload');
        if (r.backup_path) parts.push('已备份');
      }
      return parts.length ? '（' + parts.join(' · ') + '）' : '';
    }
    function run(label, promise, describe) {
      status.textContent = '正在' + label + '…';
      status.className = 'site-edit-status muted';
      promise.then(function (r) {
        var msg = '已' + label + '：' + (describe ? describe(r) : '') + info(r);
        status.textContent = msg;
        status.className = 'site-edit-status row-note-ok';
        ctx.after(msg);
      }, function (err) {
        var hint = ctx.hintFor(label, err);
        status.textContent = label + '失败：' + ctx.errText(err) + (hint ? ' ' + hint : '');
        status.className = 'site-edit-status row-note-fail';
      });
    }
    // ---------------- SSL ----------------
    var sslPanel = panel('SSL 证书', 'bindSSL / unbindSSL');
    var ssl = data.ssl || {};
    if (ssl.bound) {
      var sslTable = add(sslPanel, el('table', 'rows'));
      [['证书路径', ssl.cert_path], ['私钥路径', ssl.key_path], ['强制 HTTPS', ssl.force_https ? '是（80 → 443）' : '否（80/443 并存）']].forEach(function (pair) {
        var tr = add(sslTable, el('tr'));
        add(tr, el('th', null, pair[0]));
        add(tr, el('td', null, pair[1] || '—')).className = 'mono';
      });
      var unbindOps = add(sslPanel, el('div', 'site-edit-ops'));
      action(unbindOps, '解除绑定', 'btn-ghost', 'ssl-unbind', function () {
        run('解除 SSL 绑定', ctx.invoke('site.unbindSSL', { domain: domain }), function (r) { return 'ssl_bound=' + r.ssl_bound; });
      });
    } else {
      add(sslPanel, el('p', 'muted', '当前未绑定证书（纯 HTTP）。从下方选择证书并绑定后，页面会回读 site.get 确认状态。'));
    }
    var sslForm = add(sslPanel, el('form', 'site-edit-form'));
    var certPick = add(sslForm, el('label', 'field'));
    add(certPick, el('span', 'field-label', '证书（来自 ssl.list）'));
    var certSel = add(certPick, el('select', 'field-input'));
    certSel.setAttribute('data-field', 'ssl-cert');
    var dirDefault = ssl.cert_path ? ssl.cert_path.slice(0, ssl.cert_path.lastIndexOf('/')) : '/etc/kore/ssl';
    var certDir = field(sslForm, '证书目录（KORE_SSL_CERT_DIR）', dirDefault, '/etc/kore/ssl');
    certDir.setAttribute('data-field', 'ssl-dir');
    var certHint = add(sslForm, el('p', 'field-hint', '选择证书后自动拼接 cert_path 与同名 .key 私钥路径'));
    var manualCert = field(sslForm, '证书路径（手动）', ssl.cert_path || '', '/etc/kore/ssl/example.crt');
    manualCert.parentNode.hidden = true;
    manualCert.setAttribute('data-field', 'ssl-cert-path');
    var manualKey = field(sslForm, '私钥路径（手动）', ssl.key_path || '', '/etc/kore/ssl/example.key');
    manualKey.parentNode.hidden = true;
    manualKey.setAttribute('data-field', 'ssl-key-path');
    var manualMode = false;
    var forceLine = add(sslForm, el('label', 'field field-check'));
    var force = add(forceLine, el('input', 'files-checkbox'));
    force.type = 'checkbox'; force.checked = ssl.force_https !== false;
    force.setAttribute('data-field', 'ssl-force');
    add(forceLine, el('span', null, '强制 HTTPS（80 跳转到 443）'));
    var sslOps = add(sslForm, el('div', 'site-edit-ops'));
    function certPaths() {
      if (manualMode) return { cert: manualCert.value.trim(), key: manualKey.value.trim() };
      var dir = (certDir.value.trim() || '/etc/kore/ssl').replace(/\/+$/, '');
      var file = certSel.value;
      return file ? { cert: dir + '/' + file, key: dir + '/' + certBase(file) + '.key' } : { cert: '', key: '' };
    }
    function syncHint() {
      var p = certPaths();
      certHint.textContent = p.cert ? '证书：' + p.cert + '；私钥：' + p.key
        : '证书目录为空时，请先在 SSL 页自签或导入；也可直接填手动路径';
    }
    action(sslOps, '绑定证书', 'btn-primary', 'ssl-bind', function () {
      var p = certPaths();
      if (!p.cert || !p.key) { status.textContent = '请先选择证书或填写证书/私钥路径'; status.className = 'site-edit-status row-note-fail'; return; }
      run('绑定证书', ctx.invoke('site.bindSSL', {
        domain: domain, cert_path: p.cert, key_path: p.key, force_https: !!force.checked
      }), function (r) { return 'ssl_bound=' + r.ssl_bound + '；force_https=' + r.force_https; });
    });
    certSel.addEventListener('change', syncHint);
    certDir.addEventListener('input', syncHint);
    manualCert.addEventListener('input', syncHint);
    manualKey.addEventListener('input', syncHint);
    ctx.invokeSSL('ssl.list', {}).then(function (list) {
      var certs = Array.isArray(list.certs) ? list.certs : [];
      certSel.textContent = '';
      if (!certs.length) {
        var empty = add(certSel, el('option', null, '证书目录为空，请先在 SSL 页自签/导入'));
        empty.value = '';
      }
      certs.forEach(function (cert) {
        var opt = add(certSel, el('option', null, (cert.domain || cert.file) + ' · ' + cert.file + '（' + cert.days_left + ' 天）'));
        opt.value = cert.file;
      });
      syncHint();
    }, function (err) {
      manualMode = true;
      certSel.parentNode.hidden = true; certDir.parentNode.hidden = true;
      manualCert.parentNode.hidden = false; manualKey.parentNode.hidden = false;
      add(sslForm, el('p', 'field-hint row-note-fail', '证书列表读取失败：' + ctx.errText(err) + '；已切换为手动路径')).title = ctx.errText(err);
      syncHint();
    });
    // ---------------- 伪静态 ----------------
    var rwPanel = panel('伪静态', 'setRewrite / getRewrite');
    var rwForm = add(rwPanel, el('form', 'site-edit-form'));
    var rwPick = add(rwForm, el('label', 'field'));
    add(rwPick, el('span', 'field-label', '模板（只允许固定枚举，不接受自定义片段）'));
    var rwSel = add(rwPick, el('select', 'field-input'));
    rwSel.setAttribute('data-field', 'rewrite');
    TEMPLATES.forEach(function (name) { add(rwSel, el('option', null, name)).value = name; });
    rwSel.value = (data.rewrite && data.rewrite.template) || 'none';
    var rwNote = add(rwForm, el('p', 'field-hint', '当前值来自 getRewrite'));
    var rwOps = add(rwForm, el('div', 'site-edit-ops'));
    action(rwOps, '保存伪静态', 'btn-primary', 'rewrite-save', function () {
      run('设置伪静态', ctx.invoke('site.setRewrite', { domain: domain, template: rwSel.value }), function (r) {
        return 'template=' + r.template + (r.proxy_cleared ? '；已自动清除反向代理（互斥）' : '');
      });
    });
    ctx.invoke('site.getRewrite', { domain: domain }).then(function (r) {
      rwSel.value = r.template || 'none';
      rwNote.textContent = '当前：' + (r.template || 'none') + (r.enabled ? '' : '（站点已停用，配置仍可读）');
      syncPHPPanel();
    }, function (err) {
      rwNote.textContent = 'getRewrite 读取失败：' + ctx.errText(err) + '；下拉暂用 site.get 的值';
      rwNote.className = 'field-hint row-note-fail';
    });
    // ---------------- PHP-FPM（伪静态依赖 PHP 的四个模板）----------------
    // 版本选项来自 getPHP.available 动态填充，不硬编码版本号；未检测到候选时保留 auto
    // 并给出人话提示。setPHP/unsetPHP 走 ctx.invoke，错误原样展示，不吞 message。
    var phpPanel = panel('PHP-FPM', 'getPHP / setPHP / unsetPHP');
    var phpForm = add(phpPanel, el('form', 'site-edit-form'));
    var phpNote = add(phpForm, el('p', 'field-hint', '读取当前 PHP 状态与本机可用版本中…'));
    var phpVerBox = add(phpForm, el('label', 'field'));
    add(phpVerBox, el('span', 'field-label', 'PHP 版本'));
    var phpVer = add(phpVerBox, el('select', 'field-input'));
    phpVer.setAttribute('data-field', 'php-version');
    var phpSockBox = add(phpForm, el('label', 'field'));
    add(phpSockBox, el('span', 'field-label', 'FPM socket（可选，留空自动检测）'));
    var phpSock = add(phpSockBox, el('input', 'field-input'));
    phpSock.type = 'text'; phpSock.placeholder = '/run/php/php-fpm.sock'; phpSock.autocomplete = 'off';
    phpSock.setAttribute('data-field', 'php-socket');
    var phpOps = add(phpForm, el('div', 'site-edit-ops'));
    var phpState = { available: [], enabled: false, version: '', socket: '', hint: '' };
    function paintPHPOptions() {
      phpVer.textContent = '';
      var autoOpt = add(phpVer, el('option', null, 'auto（自动检测最高版本）'));
      autoOpt.value = 'auto';
      phpState.available.forEach(function (c) {
        var label = c.version ? c.version : '默认';
        var opt = add(phpVer, el('option', null, label + ' · ' + (c.socket || '')));
        opt.value = c.version || '';
      });
      phpVer.value = phpState.version || 'auto';
      phpSock.value = phpState.socket || '';
    }
    function paintPHPNote() {
      if (phpState.enabled) {
        phpNote.textContent = '当前已启用 PHP ' + (phpState.version || 'auto') +
          '（socket ' + (phpState.socket || '自动检测') + '）；换版本或 socket 后点保存即可切换。';
        phpNote.className = 'field-hint';
      } else if (phpState.available.length) {
        phpNote.textContent = '当前未启用 PHP；本机检测到 ' + phpState.available.length +
          ' 个 FPM socket，选版本后点保存。';
        phpNote.className = 'field-hint';
      } else {
        phpNote.textContent = phpState.hint ||
          '本机未检测到可用的 PHP-FPM socket。请先安装 php-fpm（如 php8.2-fpm），或在下方手填 socket 路径后保存。';
        phpNote.className = 'field-hint';
      }
    }
    action(phpOps, '保存 PHP 设置', 'btn-primary', 'php-save', function () {
      var params = { domain: domain };
      var ver = phpVer.value;
      if (ver && ver !== 'auto') params.php_version = ver;
      var sock = phpSock.value.trim();
      if (sock) params.socket = sock;
      run('保存 PHP 设置', ctx.invoke('site.setPHP', params), function (r) {
        return 'php_enabled=' + r.php_enabled + '；version=' + (r.php_version || 'auto') +
          '；socket=' + (r.php_socket || '自动检测') +
          (r.php_socket_verified ? '（已验证）' : r.php_hint ? '（' + r.php_hint + '）' : '');
      });
    });
    action(phpOps, '关闭 PHP', 'btn-ghost', 'php-unset', function () {
      // 后端在 PHP 伪静态模板仍启用时返回 E_INVALID 并带"先 setRewrite none"的怎么办；
      // run() 原样展示 message，不吞错误、不在这里自作主张改伪静态。
      run('关闭 PHP', ctx.invoke('site.unsetPHP', { domain: domain }), function (r) {
        return 'php_enabled=' + r.php_enabled;
      });
    });
    function syncPHPPanel() {
      // 非 PHP 模板（none / nextjs 等）不显示 PHP 表单，避免误导。
      var show = isPHPTemplate(rwSel.value);
      phpPanel.hidden = !show;
      phpPanel.style.display = show ? '' : 'none';
    }
    rwSel.addEventListener('change', syncPHPPanel);
    paintPHPOptions();
    paintPHPNote();
    syncPHPPanel();
    ctx.invoke('site.getPHP', { domain: domain }).then(function (r) {
      phpState.available = Array.isArray(r.available) ? r.available : [];
      phpState.enabled = !!r.php_enabled;
      phpState.version = r.php_version || '';
      phpState.socket = r.php_socket || '';
      phpState.hint = r.hint || '';
      paintPHPOptions();
      paintPHPNote();
    }, function (err) {
      phpNote.textContent = 'PHP 状态读取失败：' + ctx.errText(err) + '；仍可手填 socket 后保存';
      phpNote.className = 'field-hint row-note-fail';
    });
    // ---------------- 反向代理 ----------------
    var pxPanel = panel('反向代理', 'setProxy / unsetProxy');
    var px = data.proxy || {};
    add(pxPanel, el('p', 'field-hint', '反代与伪静态互斥，会自动清除伪静态。upstream 只接受 http://host:port。'));
    if (px.enabled) {
      var pxTable = add(pxPanel, el('table', 'rows'));
      var pxTr = add(pxTable, el('tr'));
      add(pxTr, el('th', null, '上游'));
      add(pxTr, el('td', null, px.upstream || '—')).className = 'mono';
      var pxTr2 = add(pxTable, el('tr'));
      add(pxTr2, el('th', null, 'WebSocket'));
      add(pxTr2, el('td', null, px.ws ? '已开启' : '未开启'));
      var pxOps0 = add(pxPanel, el('div', 'site-edit-ops'));
      action(pxOps0, '解除反代', 'btn-ghost', 'proxy-unset', function () {
        run('解除反向代理', ctx.invoke('site.unsetProxy', { domain: domain }), function (r) { return 'proxy=' + r.proxy; });
      });
    }
    var pxForm = add(pxPanel, el('form', 'site-edit-form'));
    var pxUrl = field(pxForm, '上游地址', px.enabled ? px.upstream : '', 'http://127.0.0.1:3000');
    pxUrl.setAttribute('data-field', 'proxy-upstream');
    var wsLine = add(pxForm, el('label', 'field field-check'));
    var ws = add(wsLine, el('input', 'files-checkbox'));
    ws.type = 'checkbox'; ws.checked = !!px.ws;
    ws.setAttribute('data-field', 'proxy-ws');
    add(wsLine, el('span', null, '启用 WebSocket 升级头'));
    var pxOps = add(pxForm, el('div', 'site-edit-ops'));
    action(pxOps, '保存反代', 'btn-primary', 'proxy-save', function () {
      if (!pxUrl.value.trim()) { status.textContent = '请填写上游地址，例如 http://127.0.0.1:3000'; status.className = 'site-edit-status row-note-fail'; return; }
      run('设置反向代理', ctx.invoke('site.setProxy', { domain: domain, upstream: pxUrl.value.trim(), ws: !!ws.checked }), function (r) {
        return 'upstream=' + r.upstream + (r.rewrite_cleared ? '；已自动清除伪静态（互斥）' : '；伪静态未受影响');
      });
    });
    // ---------------- 默认文档 ----------------
    var ixPanel = panel('默认文档', 'setIndex');
    var ixForm = add(ixPanel, el('form', 'site-edit-form'));
    var ixValue = (data.index && data.index.length ? data.index : ['index.html', 'index.htm', 'index.php']).join(' ');
    var ixInput = field(ixForm, 'index 指令（空格分隔）', ixValue, 'index.html index.htm index.php');
    ixInput.setAttribute('data-field', 'index-files');
    add(ixForm, el('p', 'field-hint', '默认 index.html index.htm index.php；留空提交会回落到这三个默认值。'));
    var ixOps = add(ixForm, el('div', 'site-edit-ops'));
    action(ixOps, '保存默认文档', 'btn-primary', 'index-save', function () {
      var files = ixInput.value.split(/\s+/).filter(function (x) { return x; });
      var params = { domain: domain };
      if (files.length) params.files = files;
      run('设置默认文档', ctx.invoke('site.setIndex', params), function (r) { return 'index=' + (r.index || []).join(' '); });
    });
    // ---------------- 重定向 ----------------
    var rdPanel = panel('重定向', 'setRedirect / unsetRedirect');
    var rules = Array.isArray(data.redirects) ? data.redirects : [];
    if (rules.length) {
      var rdTable = add(rdPanel, el('table', 'rows site-redirect-table'));
      var rdHead = add(rdTable, el('tr'));
      ['来源路径', '目标', '代码', '操作'].forEach(function (label) { add(rdHead, el('th', null, label)); });
      rules.forEach(function (rule) {
        var tr = add(rdTable, el('tr'));
        add(tr, el('td', null, rule.from_path)).className = 'mono';
        add(tr, el('td', null, rule.to_url)).className = 'mono';
        add(tr, el('td', null, String(rule.code)));
        var cell = add(tr, el('td', 'cell-ops'));
        var del = add(cell, el('button', 'btn btn-ghost', '删除'));
        del.type = 'button'; del.setAttribute('data-action', 'redirect-del');
        del.setAttribute('data-path', rule.from_path);
        on(del, function () {
          run('删除重定向', ctx.invoke('site.unsetRedirect', { domain: domain, from_path: rule.from_path }), function (r) {
            return 'removed=' + r.removed + '；剩余 ' + r.redirects + ' 条';
          });
        });
      });
    } else {
      add(rdPanel, el('p', 'muted', '当前没有重定向。'));
    }
    add(rdPanel, el('p', 'field-hint', '上限 32 条；相同 from_path 会被覆盖，code 只允许 301/302。'));
    var rdForm = add(rdPanel, el('form', 'site-edit-form'));
    var rdFrom = field(rdForm, '来源路径（/ 开头）', '', '/old');
    rdFrom.setAttribute('data-field', 'redirect-from');
    var rdTo = field(rdForm, '目标（http(s):// 或站内 /）', '', 'https://example.com/new');
    rdTo.setAttribute('data-field', 'redirect-to');
    var rdCodeField = add(rdForm, el('label', 'field'));
    add(rdCodeField, el('span', 'field-label', '状态码'));
    var rdCode = add(rdCodeField, el('select', 'field-input'));
    rdCode.setAttribute('data-field', 'redirect-code');
    [{ v: '301', t: '301 永久' }, { v: '302', t: '302 临时' }].forEach(function (o) { add(rdCode, el('option', null, o.t)).value = o.v; });
    var rdOps = add(rdForm, el('div', 'site-edit-ops'));
    action(rdOps, '新增重定向', 'btn-primary', 'redirect-add', function () {
      if (!rdFrom.value.trim() || !rdTo.value.trim()) {
        status.textContent = '来源路径与目标都必须填写'; status.className = 'site-edit-status row-note-fail'; return;
      }
      run('新增重定向', ctx.invoke('site.setRedirect', {
        domain: domain, from_path: rdFrom.value.trim(), to_url: rdTo.value.trim(), code: parseInt(rdCode.value, 10)
      }), function (r) { return 'from=' + r.from_path + ' → ' + r.to_url + '（' + r.code + '）；共 ' + r.redirects + ' 条'; });
    });
    // ---------------- 启停快捷入口 ----------------
    var power = panel('站点启停', 'disable / enable');
    add(power, el('p', 'field-hint', '停用只把 vhost 改名为 .conf.disabled，配置与备份全部保留；启用会改回并重新 test/reload。'));
    var powerOps = add(power, el('div', 'site-edit-ops'));
    if (data.enabled) {
      action(powerOps, '停用站点', 'btn-ghost', 'site-disable', function () {
        run('停用站点', ctx.invoke('site.disable', { domain: domain }), function (r) { return 'enabled=' + r.enabled; });
      });
    } else {
      action(powerOps, '启用站点', 'btn-primary', 'site-enable', function () {
        run('启用站点', ctx.invoke('site.enable', { domain: domain }), function (r) { return 'enabled=' + r.enabled; });
      });
    }
  }
  window.KoreSiteEdit = { render: renderEditor, renderWizard: renderWizard };
})();
