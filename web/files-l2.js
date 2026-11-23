/* kore 主壳 · 文件管理 L2 操作（web/files-l2.js）
   由 web/files.js 首次执行 L2 动作时懒加载，导出 window.KoreFilesL2.bind(ctx)。
   覆盖 file.upload / download / extract / compress / chmod / move / copy 与批量删除：
   所有失败都原样展示后端 code + message + detail，并附本页的可执行提示。
   单帧可承载约 5.95 MiB（8 MiB 帧上限 − 64 KiB 余量，base64 膨胀 4/3），
   因此前端在 5 MiB 处先拦截，不把必然失败的请求打到后端。 */
(function () {
  'use strict';
  var LIMIT_HINT = '单帧上限 8 MiB，大文件请先压缩或用终端上传';
  function bind(ctx) {
    var el = ctx.ui.el, add = ctx.ui.add, on = ctx.ui.on;
    function fail(ui, err) { ui.msg.textContent = ctx.errText(err) + (ctx.hintFor('', err) ? ' ' + ctx.hintFor('', err) : ''); }
    function dialog(opts) {
      var mask = el('div', 'kore-modal');
      mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
      var form = add(mask, el('form', 'kore-modal-box'));
      add(form, el('div', 'kore-modal-title', opts.title));
      if (opts.text) add(form, el('p', 'kore-modal-text', opts.text));
      var fields = opts.fields || [], inputs = {};
      fields.forEach(function (f) {
        if (f.type === 'check') {
          var line = add(form, el('label', 'field field-check'));
          var input = add(line, el('input', 'files-checkbox'));
          input.type = 'checkbox'; input.checked = !!f.value;
          if (f.key) input.setAttribute('data-field', f.key);
          add(line, el('span', null, f.label));
          if (f.hint) add(form, el('p', 'field-hint', f.hint));
          inputs[f.key] = input;
          return;
        }
        var box = add(form, el('label', 'field'));
        add(box, el('span', 'field-label', f.label));
        var control;
        if (f.type === 'select') {
          control = add(box, el('select', 'field-input'));
          (f.options || []).forEach(function (o) {
            var opt = add(control, el('option', null, o.label));
            opt.value = o.value;
          });
          control.value = f.value;
        } else {
          control = add(box, el('input', 'field-input'));
          control.type = 'text'; control.autocomplete = 'off';
          control.value = f.value || '';
          if (f.placeholder) control.placeholder = f.placeholder;
        }
        if (f.key) control.setAttribute('data-field', f.key);
        inputs[f.key] = control;
        if (f.hint) add(box, el('span', 'field-hint', f.hint));
      });
      var msg = add(form, el('div', 'kore-modal-msg'));
      msg.setAttribute('role', 'alert');
      var ops = add(form, el('div', 'kore-modal-actions'));
      var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
      var ok = add(ops, el('button', 'btn btn-primary', opts.okLabel || '确定')); ok.type = 'submit';
      function close() {
        document.removeEventListener('keydown', esc);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
      }
      function esc(ev) { if (ev.key === 'Escape') close(); }
      cancel.addEventListener('click', close);
      mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
      document.addEventListener('keydown', esc);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var values = {};
        fields.forEach(function (f) {
          var input = inputs[f.key];
          values[f.key] = f.type === 'check' ? input.checked : input.value.trim();
        });
        ok.disabled = true; msg.textContent = '';
        Promise.resolve().then(function () {
          return opts.onSubmit(values, { close: close, msg: msg, ok: ok });
        }).then(function (keep) {
          ok.disabled = false;
          if (!keep) close();
        }, function (err) {
          ok.disabled = false;
          msg.textContent = ctx.errText(err) + (ctx.hintFor(opts.action || '', err) ? ' ' + ctx.hintFor(opts.action || '', err) : '');
        });
      });
      document.body.appendChild(mask);
      var first = form.querySelector('input:not([type=checkbox]), select');
      if (first) first.focus();
      return close;
    }
    function readBase64(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || '');
          var comma = text.indexOf(',');
          resolve(comma >= 0 ? text.slice(comma + 1) : text);
        };
        reader.onerror = function () {
          reject(new Error('读取本地文件失败：' + (reader.error && reader.error.message ? reader.error.message : file.name)));
        };
        reader.readAsDataURL(file);
      });
    }
    function uploadSeq(files, overwrite, ui) {
      var failed = [], chain = Promise.resolve();
      files.forEach(function (file, index) {
        chain = chain.then(function () {
          var step = '上传第 ' + (index + 1) + '/' + files.length + ' 个：' + file.name;
          ui.msg.textContent = step;
          ctx.setStatus(step + '…');
          return readBase64(file).then(function (b64) {
            return ctx.invoke('file.upload', {
              path: ctx.state.path || '.', filename: file.name, data_base64: b64, overwrite: !!overwrite
            });
          }).then(function () {}, function (err) {
            failed.push(file.name + '：' + ctx.errText(err));
          });
        });
      });
      return chain.then(function () { return failed; });
    }
    function uploadFiles(files) {
      var usable = [], blocked = [];
      for (var i = 0; i < files.length; i++) {
        if (files[i].size > ctx.maxInline) blocked.push(files[i].name); else usable.push(files[i]);
      }
      if (!usable.length) {
        ctx.setStatus('未上传：' + blocked.join('、') + ' 超过 5 MiB。' + LIMIT_HINT, 'fail');
        return Promise.resolve();
      }
      var text = '目标目录 ' + ctx.disp(ctx.state.path) + '，共 ' + usable.length + ' 个文件。';
      if (blocked.length) text += ' 已跳过 ' + blocked.length + ' 个超过 5 MiB 的文件：' + blocked.join('、') + '。' + LIMIT_HINT;
      return dialog({
        title: '上传文件', text: text, action: 'upload', okLabel: '开始上传',
        fields: [{ key: 'overwrite', type: 'check', value: true, label: '覆盖同名文件', hint: '不勾选时同名文件会返回 E_CONFLICT 并记为失败' }],
        onSubmit: function (values, ui) {
          return uploadSeq(usable, values.overwrite, ui).then(function (failed) {
            return ctx.refresh().then(function () {
              if (!failed.length) {
                ctx.setStatus('已上传 ' + usable.length + ' 个文件到 ' + ctx.disp(ctx.state.path), 'ok');
                return false;
              }
              ctx.setStatus('上传完成：成功 ' + (usable.length - failed.length) + ' 个，失败 ' + failed.length + ' 个', 'fail');
              ui.msg.textContent = '失败明细：' + failed.join('；');
              return true;
            });
          });
        }
      });
    }
    function download(entry) {
      if (entry.size > ctx.maxInline) {
        ctx.setStatus('未下载：' + ctx.disp(entry.path) + ' 为 ' + ctx.fmtSize(entry.size) + '，超过 5 MiB。' + LIMIT_HINT, 'fail');
        return Promise.resolve();
      }
      return ctx.invoke('file.download', { path: entry.path }).then(function (data) {
        var raw = atob(data.data_base64 || '');
        var bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        var a = document.createElement('a');
        a.href = url; a.download = data.filename || entry.name; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        ctx.setStatus('已下载 ' + ctx.disp(entry.path) + '（' + ctx.fmtSize(data.size_bytes) + '）', 'ok');
      });
    }
    function stamp() {
      var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }
    function dirBase(path) { return path ? path.split('/').pop() : 'root'; }
    function compress(entries) {
      if (!entries || !entries.length) { ctx.setStatus('请先勾选要压缩的文件或目录', 'fail'); return Promise.resolve(); }
      return dialog({
        title: '压缩 ' + entries.length + ' 项', action: 'compress', okLabel: '开始压缩',
        text: '将打包：' + entries.map(function (e) { return e.name; }).join('、'),
        fields: [
          { key: 'name', label: '归档文件名（相对当前目录）', value: dirBase(ctx.state.path) + '-' + stamp() + '.zip' },
          { key: 'format', type: 'select', label: '格式', value: 'zip', options: [{ value: 'zip', label: 'zip' }, { value: 'tar.gz', label: 'tar.gz' }] }
        ],
        onSubmit: function (values) {
          var name = values.name;
          if (!name || /^\/|(^|\/)\.\.(\/|$)/.test(name)) throw new Error('归档文件名不能为空、不能以 / 开头、不能包含 ..');
          var archive = ctx.join(ctx.state.path, name);
          return ctx.invoke('file.compress', {
            paths: entries.map(function (e) { return e.path; }), archive_path: archive, format: values.format
          }).then(function (res) {
            ctx.state.checked = {};
            return ctx.refresh().then(function () {
              ctx.setStatus('已生成 ' + ctx.disp(res.archive_path || archive) + '（' + ctx.fmtSize(res.size_bytes) + '，' + res.entries + ' 项，' + res.format + '）', 'ok');
              return false;
            });
          });
        }
      });
    }
    function stripArchive(name) { return String(name).replace(/\.(zip|tar\.gz|tgz|tar)$/i, ''); }
    function defaultDest(entry) {
      var p = entry.path, slash = p.lastIndexOf('/');
      var dir = slash >= 0 ? p.slice(0, slash) : '';
      var base = stripArchive(slash >= 0 ? p.slice(slash + 1) : p);
      return dir ? dir + '/' + base : base;
    }
    function extract(entry) {
      return dialog({
        title: '解压 ' + entry.name, action: 'extract', okLabel: '开始解压',
        text: '归档：' + ctx.disp(entry.path),
        fields: [
          { key: 'dest', label: '目标目录（相对根目录）', value: defaultDest(entry), hint: '默认同目录下同名文件夹；不存在会自动创建' },
          { key: 'overwrite', type: 'check', value: false, label: '覆盖已存在的同名文件' }
        ],
        onSubmit: function (values) {
          if (!values.dest) throw new Error('目标目录不能为空');
          return ctx.invoke('file.extract', { archive_path: entry.path, dest_dir: values.dest, overwrite: !!values.overwrite })
            .then(function (res) {
              var skipped = res.skipped && res.skipped.length ? '，跳过 ' + res.skipped.length + ' 项' : '';
              return ctx.refresh().then(function () {
                ctx.setStatus('已解压 ' + res.extracted + ' 项到 ' + ctx.disp(values.dest) + '（' + res.format + '，' + ctx.fmtSize(res.bytes) + skipped + '）', 'ok');
                return false;
              });
            });
        }
      });
    }
    function chmod(entry) {
      var fields = [{ key: 'mode', label: '八进制权限（如 0755）', value: entry.mode || '0755' }];
      if (entry.is_dir) fields.push({ key: 'recursive', type: 'check', value: false, label: '递归应用到目录内所有条目', hint: '递归前会整树校验；目录缺少执行位会被拒绝' });
      return dialog({
        title: '修改权限 · ' + entry.name, action: 'chmod', okLabel: '应用权限',
        text: '路径：' + ctx.disp(entry.path), fields: fields,
        onSubmit: function (values) {
          if (!/^(0o)?[0-7]{3,4}$/i.test(values.mode)) throw new Error('mode 必须是 0 到 0777 的八进制权限，例如 0755');
          return ctx.invoke('file.chmod', { path: entry.path, mode: values.mode, recursive: !!values.recursive })
            .then(function (res) {
              return ctx.refresh().then(function () {
                ctx.setStatus('已把 ' + ctx.disp(res.path) + ' 权限改为 ' + res.mode + '（变更 ' + res.changed + ' 项）', 'ok');
                return false;
              });
            });
        }
      });
    }
    function move(entry) {
      return dialog({
        title: '移动 / 重命名 · ' + entry.name, action: 'move', okLabel: '移动',
        text: '当前路径：' + ctx.disp(entry.path) + '（目标父目录必须已存在）',
        fields: [
          { key: 'dst', label: '目标路径（相对根目录）', value: ctx.join(ctx.state.path, entry.name) },
          { key: 'overwrite', type: 'check', value: false, label: '覆盖同名目标' }
        ],
        onSubmit: function (values) {
          if (!values.dst) throw new Error('目标路径不能为空');
          return ctx.invoke('file.move', { src: entry.path, dst: values.dst, overwrite: !!values.overwrite })
            .then(function (res) {
              ctx.state.checked = {};
              return ctx.refresh().then(function () {
                ctx.setStatus('已移动 ' + ctx.disp(res.from) + ' → ' + ctx.disp(res.to) + '（' + res.method + '）', 'ok');
                return false;
              });
            });
        }
      });
    }
    // copy 走「目录选择器」：在弹层里浏览目录并选目标，不让人手写路径（复用 file.list）。
    function copy(entry) {
      var mask = el('div', 'kore-modal');
      mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true');
      var box = add(mask, el('form', 'kore-modal-box'));
      add(box, el('div', 'kore-modal-title', '复制到 · ' + entry.name));
      add(box, el('p', 'kore-modal-text',
        '源：' + ctx.disp(entry.path) + '。选择目标目录后复制为同名副本；目标已存在时需要勾选「覆盖同名」。'));
      var target = ctx.state.path || '';
      var nav = add(box, el('div', 'files-actions'));
      var pathText = add(nav, el('span', 'files-selected muted', ''));
      var up = add(nav, el('button', 'btn btn-ghost', '上一级')); up.type = 'button';
      var browser = add(box, el('div', 'files-list-host'));
      var sureLine = add(box, el('label', 'field field-check'));
      var overwrite = add(sureLine, el('input', 'files-checkbox')); overwrite.type = 'checkbox';
      add(sureLine, el('span', null, '覆盖同名目标'));
      var msg = add(box, el('div', 'kore-modal-msg')); msg.setAttribute('role', 'alert');
      var ops = add(box, el('div', 'kore-modal-actions'));
      var cancel = add(ops, el('button', 'btn btn-ghost', '取消')); cancel.type = 'button';
      var ok = add(ops, el('button', 'btn btn-primary', '复制到这里')); ok.type = 'submit';
      function close() { document.removeEventListener('keydown', esc); if (mask.parentNode) mask.parentNode.removeChild(mask); }
      function esc(ev) { if (ev.key === 'Escape') close(); }
      cancel.addEventListener('click', close);
      mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
      document.addEventListener('keydown', esc);
      up.addEventListener('click', function () {
        if (!target) return;
        var slash = target.lastIndexOf('/');
        target = slash >= 0 ? target.slice(0, slash) : '';
        render();
      });
      function render() {
        pathText.textContent = '目标目录：' + ctx.disp(target);
        up.disabled = !target;
        browser.textContent = '';
        ctx.invoke('file.list', { path: target || '.' }).then(function (data) {
          var dirs = (data.entries || []).filter(function (item) { return item.is_dir; })
            .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh-CN'); });
          if (!dirs.length) {
            add(browser, el('div', 'panel-empty', '这个目录下没有子目录；可直接点「复制到这里」。'));
            return;
          }
          dirs.forEach(function (dir) {
            var row = add(browser, el('div', 'files-actions'));
            var btn = add(row, el('button', 'btn btn-ghost', '进入 ' + dir.name + '/')); btn.type = 'button';
            btn.addEventListener('click', function () { target = dir.path; render(); });
          });
        }, function (err) {
          add(browser, el('div', 'panel-empty', '目录读取失败：' + ctx.errText(err)));
        });
      }
      box.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var dst = target ? target + '/' + entry.name : entry.name;
        if (dst === entry.path) { msg.textContent = '目标与原路径相同，请换一个目录'; return; }
        ok.disabled = true; msg.textContent = '';
        ctx.invoke('file.copy', { src: entry.path, dst: dst, overwrite: !!overwrite.checked }).then(function (res) {
          ctx.setStatus('已复制 ' + ctx.disp(res.from) + ' → ' + ctx.disp(res.to) +
            '（' + (res.kind === 'dir' ? res.entries + ' 项' : ctx.fmtSize(res.bytes)) + '）', 'ok');
          close(); ctx.refresh();
        }, function (err) {
          ok.disabled = false;
          if (err && err.code === 'E_CONFLICT') {
            msg.textContent = '';
            dialog({
              title: '目标已存在', okLabel: '覆盖复制', action: 'copy',
              text: '目标位置已有同名项。覆盖会用当前内容替换它（文件替换文件、空目录替换空目录），此操作不可撤销。',
              onSubmit: function (_, inner) {
                return ctx.invoke('file.copy', { src: entry.path, dst: dst, overwrite: true }).then(function (res) {
                  inner.close(); close();
                  ctx.setStatus('已覆盖复制 ' + ctx.disp(res.from) + ' → ' + ctx.disp(res.to), 'ok');
                  ctx.refresh();
                  return false;
                }, function (err2) {
                  inner.msg.textContent = ctx.errText(err2);
                  return true;
                });
              }
            });
            return;
          }
          msg.textContent = ctx.errText(err) + (ctx.hintFor('copy', err) ? ' ' + ctx.hintFor('copy', err) : '');
        });
      });
      render();
      document.body.appendChild(mask);
      ok.focus();
    }
    function removeMany(entries) {
      if (!entries || !entries.length) { ctx.setStatus('请先勾选要删除的条目', 'fail'); return Promise.resolve(); }
      var names = entries.slice(0, 8).map(function (e) { return ctx.disp(e.path); }).join('、');
      if (entries.length > 8) names += ' 等 ' + entries.length + ' 项';
      return dialog({
        title: '移入回收站确认', action: 'delete', okLabel: '移入回收站',
        text: '将把：' + names + ' 移入回收站，可在「回收站」里恢复。彻底删除需要到回收站里再操作一次。',
        fields: [{ key: 'recursive', type: 'check', value: false, label: '递归删除非空目录（连同目录内全部内容）', hint: '不勾选时非空目录会返回 E_CONFLICT 并跳过' }],
        onSubmit: function (values, ui) {
          // 批量删除走 file.batch（单请求、逐项结果）：部分失败不静默，按成功/失败分组展示。
          var items = entries.map(function (entry) {
            return { path: entry.path, recursive: !!values.recursive };
          });
          ui.msg.textContent = '正在提交批量删除 ' + items.length + ' 项…';
          return ctx.invoke('file.batch', { op: 'delete', items: items }).then(function (data) {
            var okList = [], failList = [];
            (data.items || []).forEach(function (item) {
              if (item.ok) okList.push(ctx.disp(item.path));
              else failList.push(ctx.disp(item.path) + '：' + (item.error ? (item.error.message || item.error.code) : '失败'));
            });
            ctx.state.checked = {};
            return ctx.refresh().then(function () {
              if (!failList.length) {
                ctx.setStatus('已移入回收站：' + data.succeeded + ' 项（可在「回收站」恢复）', 'ok');
                return false;
              }
              ctx.setStatus('批量删除：成功 ' + data.succeeded + ' 项 / 失败 ' + data.failed + ' 项（失败项未进回收站）', 'fail');
              ui.msg.textContent = '成功 ' + data.succeeded + ' 项：' + (okList.slice(0, 5).join('、') || '—') +
                (okList.length > 5 ? ' 等' : '') + '；失败 ' + data.failed + ' 项：' + failList.slice(0, 5).join('；') +
                (failList.length > 5 ? ' 等' : '') + '（失败项保持原样，可勾选「递归删除」重试）';
              return true;
            });
          }, function (err) {
            ui.msg.textContent = ctx.errText(err) + (ctx.hintFor('batch', err) ? ' ' + ctx.hintFor('batch', err) : '');
            return true;
          });
        }
      });
    }
    return {
      uploadFiles: uploadFiles, download: download, compress: compress, extract: extract,
      chmod: chmod, move: move, copy: copy, removeMany: removeMany
    };
  }
  window.KoreFilesL2 = { bind: bind };
})();
