/* Kore 全局快捷键组件（R6-6 / PLUGIN-MATURITY §3.3.2 P2）
 *
 * 定位：把「局部有」的快捷键补成全局能力。Ctrl/Cmd+K 全局搜索由 shell.js 实现，
 * 本组件不重做、不接管；只补「快捷键帮助 / 保存 / 关闭 / 主题切换」四类全局入口。
 *
 * 加载方式：懒加载，零框架、零依赖。文件本身不碰 DOM、不注册监听；只有显式
 * 调用 KoreShortcuts.mount() 才生效。接线任务按需注入 /assets/shortcuts.js。
 *
 * ===== 挂载 API（window.KoreShortcuts）=====
 *   mount(options)      初始化并注册全局监听（幂等，重复调用只更新 options）
 *                       options.onboardingAction : function  —— 帮助面板底部「重新查看新手引导」按钮的回调；不传则不显示
 *                       options.onboardingLabel   : string   —— 上面按钮的文案，默认「重新查看新手引导」
 *                       options.scope             : Element  —— 帮助浮层的挂载父节点，默认 document.body
 *   destroy()           移除全局监听与浮层，回到未挂载状态（幂等）
 *   isMounted()         -> boolean
 *   openHelp()          显示快捷键帮助浮层（首次调用才建 DOM + 注入样式）
 *   closeHelp()         隐藏帮助浮层；未建过则什么都不做
 *   toggleHelp()        按当前状态开/关
 *   createTrigger()     -> HTMLButtonElement，文案「快捷键」，桌面显示、手机 CSS 隐藏；
 *                        供接线任务放进顶栏（本组件不自动改 shell.js / app.js 的 DOM）
 *   register(binding)   注册自定义快捷键；binding={id,combo,label,action,event}。
 *                       combo 支持 'Mod+s' / 'Ctrl+S' / 'Cmd+Shift+X' / 'Escape'；
 *                       action='help' | 'event' | 'theme' | 'onboarding' | 'custom'。
 *                       命中保留键位或重复 id / combo 时返回 false，不注册。
 *   unregister(id)      按 id 移除自定义快捷键，返回 boolean
 *   getBindings()       -> 当前全部键位描述的副本（含内置与自定义），供帮助面板/自检读取
 *   isReserved(combo)   -> boolean，注册前冲突检测；保留键位见下
 *
 * ===== 保留键位（绝不占用，注册前检测）=====
 *   Ctrl/Cmd+K      全局搜索       —— web/shell.js:635-642 onGlobalKey 已有
 *   Ctrl/Cmd+Enter  数据库查询      —— web/db.js:803 已有
 *   Esc             抽屉/模态框关闭 —— web/shell.js:226-228、web/search.js、web/files.js:114/834 已有
 *
 * ===== 本组件派发的 DOM 事件（接线契约）=====
 *   kore:shortcut-help   detail={open:boolean, source:'shortcuts'}   帮助浮层开/关时派发
 *   kore:shortcut-save   detail={source:'shortcuts', combo:'Mod+s'}  保存快捷键触发
 *   kore:shortcut-close  detail={source:'shortcuts', combo:'Mod+shift+x'}  关闭快捷键触发
 *   接线任务必须自行监听上面三个事件；本组件只负责发信号，不替别的模块干活。
 *   注意：Mod+S / Mod+Shift+X 会 preventDefault（拦浏览器默认保存/关闭），
 *   所以接线任务务必补上监听，避免用户按了没反应。
 *
 * ===== 横向对齐结论（R6-4 onboarding / R6-5 theme 均已 send_message 确认无异议）=====
 *   window.KoreTheme.toggle()      —— R6-5 深色主题组件（web/theme.js）
 *     r6-theme 确认：主题通过 <html data-kore-theme="system|light|dark"> 与
 *     <html data-kore-effective="light|dark"> 属性 + CSS 变量覆盖生效，无全局 body 覆盖、
 *     无 !important，控件类前缀 kore-theme-* 与本组件 kore-shortcut-* 不重叠。
 *     快捷键 Mod+Shift+D 调用 toggle()；未加载时该条标注「主题组件未加载」，不报错。
 *   window.KoreOnboarding.open()   —— R6-4 首次使用引导组件（web/onboarding.js）
 *     r6-onboarding 确认导出 open()/mount()/close()/toggle()/destroy()/isOpen() 等 API。
 *     本组件只在构建帮助浮层时做存在性判断：若传入 onboardingAction 用回调；
 *     否则若 window.KoreOnboarding.open 存在则软兜底挂「重新查看新手引导」按钮；
 *     再否则不显示该入口。onboarding 的 Esc 只在其 root 上做局部监听并 stopPropagation，
 *     不注册全局键位、不占用保留键位、不派发 kore:shortcut-* 事件，双方零耦合。
 *   本浮层全部使用 --kore-* 变量，随主题属性切换自动生效；class 前缀 kore-shortcut-*，
 *   不写 !important、不改全局样式，手机端 CSS 隐藏触发按钮但键盘快捷键仍可用。
 */
(function (global) {
  'use strict';

  var DOC = global.document;
  if (!DOC) return; // Node 下只做语法检查，不执行

  var STYLE_ID = 'kore-shortcuts-css';
  var ROOT_ID = 'kore-shortcuts-help';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var RESERVED = Object.freeze({
    'Escape': '抽屉 / 模态框关闭（shell.js、search.js、files.js）',
    'Mod+k': '全局搜索（shell.js）',
    'Mod+enter': '数据库查询（db.js）'
  });

  // 内置键位：帮助 / 保存 / 关闭 / 主题。搜索不在此列——它归 shell.js。
  var BUILTIN = [
    { id: 'help', combo: 'Mod+/', label: '显示快捷键帮助', action: 'help' },
    { id: 'save', combo: 'Mod+s', label: '保存当前内容', action: 'event', event: 'kore:shortcut-save' },
    { id: 'close', combo: 'Mod+shift+x', label: '关闭当前面板或窗口', action: 'event', event: 'kore:shortcut-close' },
    { id: 'theme', combo: 'Mod+shift+d', label: '切换深浅色主题', action: 'theme' }
  ];

  var SHORTCUT_CSS = '' +
    '.kore-shortcut-trigger{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;' +
    'padding:0 8px;border:1px solid var(--kore-border-1);border-radius:4px;background:var(--kore-bg-2);' +
    'color:var(--kore-text-2);font-size:12px;cursor:pointer;white-space:nowrap}' +
    '.kore-shortcut-trigger:hover{color:var(--kore-text-1);border-color:var(--kore-text-3)}' +
    '@media (max-width:639px){.kore-shortcut-trigger{display:none}}' +
    '.kore-shortcut-mask{position:fixed;inset:0;z-index:var(--z-modal, 1000);background:rgba(0,0,0,.45);' +
    'display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.kore-shortcut-mask[hidden]{display:none}' +
    '.kore-shortcut-panel{width:min(460px,100%);max-height:80vh;overflow:auto;background:var(--kore-bg-1);' +
    'color:var(--kore-text-1);border:1px solid var(--kore-border-1);border-radius:8px;' +
    'box-shadow:0 10px 40px rgba(0,0,0,.3);padding:18px 20px}' +
    '.kore-shortcut-title{margin:0 0 4px;font-size:16px;font-weight:600}' +
    '.kore-shortcut-sub{margin:0 0 14px;font-size:12px;color:var(--kore-text-3);line-height:1.5}' +
    '.kore-shortcut-list{margin:0;padding:0;list-style:none}' +
    '.kore-shortcut-row{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
    'padding:9px 0;border-bottom:1px solid var(--kore-border-1);font-size:13px}' +
    '.kore-shortcut-row:last-child{border-bottom:0}' +
    '.kore-shortcut-keys{display:inline-flex;gap:4px;flex:0 0 auto}' +
    '.kore-shortcut-keys kbd{font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'padding:0 6px;border:1px solid var(--kore-border-1);border-radius:3px;background:var(--kore-bg-2);' +
    'color:var(--kore-text-2)}' +
    '.kore-shortcut-note{font-size:11px;color:var(--kore-warning, #d9a441)}' +
    '.kore-shortcut-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px}' +
    '.kore-shortcut-btn{padding:6px 12px;border:1px solid var(--kore-border-1);border-radius:4px;' +
    'background:var(--kore-bg-2);color:var(--kore-text-1);font-size:12px;cursor:pointer;min-height:32px}' +
    '.kore-shortcut-btn:hover{border-color:var(--kore-text-3)}';

  var state = {
    mounted: false,
    listening: false,
    options: {},
    custom: [],
    root: null,
    mask: null,
    panel: null,
    open: false,
    onKey: null
  };

  function el(tag, cls, text) {
    var node = DOC.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function canonical(combo) {
    var raw = String(combo === undefined || combo === null ? '' : combo).toLowerCase().trim();
    if (!raw) return '';
    if (raw === 'esc' || raw === 'escape') return 'Escape';
    var mod = false, shift = false, alt = false, key = '';
    var parts = raw.split('+');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      if (p === 'mod' || p === 'ctrl' || p === 'control' || p === 'cmd' || p === 'command' || p === 'meta') mod = true;
      else if (p === 'shift') shift = true;
      else if (p === 'alt' || p === 'option') alt = true;
      else key = p;
    }
    if (key === '?') key = '/';
    var head = [];
    if (mod) head.push('Mod');
    if (shift) head.push('Shift');
    if (alt) head.push('Alt');
    return head.join('+') + (key ? '+' + key : '');
  }

  function comboFromEvent(ev) {
    if (ev.key === 'Escape' || ev.key === 'Esc') return 'Escape';
    var key = ev.key ? String(ev.key).toLowerCase() : '';
    if (key === '/' || key === '?') key = '/';
    if (!key || key === 'control' || key === 'meta' || key === 'shift' || key === 'alt') return '';
    if (!ev.ctrlKey && !ev.metaKey) return ''; // 裸键不注册为全局快捷键
    return 'Mod' + (ev.shiftKey ? '+Shift' : '') + (ev.altKey ? '+Alt' : '') + '+' + key;
  }

  function isReserved(combo) {
    var c = canonical(combo);
    return !!(c && RESERVED[c]);
  }

  function allBindings() {
    var out = [];
    for (var i = 0; i < BUILTIN.length; i++) out.push(Object.assign({}, BUILTIN[i]));
    for (var j = 0; j < state.custom.length; j++) out.push(Object.assign({}, state.custom[j]));
    return out;
  }

  function findBinding(combo) {
    var list = allBindings();
    for (var i = 0; i < list.length; i++) if (list[i].combo === combo) return list[i];
    return null;
  }

  function register(binding) {
    if (!binding || typeof binding.id !== 'string' || !binding.id) return false;
    var combo = canonical(binding.combo);
    if (combo && isReserved(combo)) return false;
    var list = allBindings();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === binding.id) return false;
      if (combo && list[i].combo === combo) return false;
    }
    state.custom.push({
      id: binding.id,
      combo: combo,
      label: String(binding.label || binding.id),
      action: binding.action || 'custom',
      event: binding.event || '',
      handler: binding.handler
    });
    if (state.root) renderList();
    return true;
  }

  function unregister(id) {
    for (var i = 0; i < state.custom.length; i++) {
      if (state.custom[i].id === id) {
        state.custom.splice(i, 1);
        if (state.root) renderList();
        return true;
      }
    }
    return false;
  }

  function emit(name, detail) {
    var payload = Object.assign({ source: 'shortcuts' }, detail || {});
    var ev;
    if (typeof CustomEvent === 'function') ev = new CustomEvent(name, { detail: payload, bubbles: true });
    else { ev = DOC.createEvent('CustomEvent'); ev.initCustomEvent(name, true, false, payload); }
    DOC.dispatchEvent(ev);
  }

  function themeAvailable() {
    return !!(global.KoreTheme && typeof global.KoreTheme.toggle === 'function');
  }

  function runBinding(binding, combo) {
    if (!binding) return;
    switch (binding.action) {
      case 'help':
        toggleHelp();
        break;
      case 'event':
        if (binding.event) emit(binding.event, { combo: combo });
        break;
      case 'theme':
        if (themeAvailable()) global.KoreTheme.toggle();
        break;
      case 'onboarding':
        if (typeof state.options.onboardingAction === 'function') state.options.onboardingAction();
        break;
      case 'custom':
        if (typeof binding.handler === 'function') binding.handler();
        break;
      default:
        break;
    }
  }

  function onKey(ev) {
    // 保留键位一律放行：本组件绝不拦 shell.js 的 Ctrl+K、db.js 的 Ctrl+Enter、各处的 Esc。
    var combo = comboFromEvent(ev);
    if (!combo || isReserved(combo)) return;
    var binding = findBinding(combo);
    if (!binding) return;
    // 帮助键在任何焦点下都可用；其余键在输入态交给原组件（例如编辑器里的 Ctrl+S 语义）。
    if (binding.action !== 'help') {
      var t = ev.target;
      var tag = t && t.tagName ? String(t.tagName).toLowerCase() : '';
      var inField = tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable);
      if (inField) return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    runBinding(binding, combo);
  }

  function ensureCss() {
    if (DOC.getElementById(STYLE_ID)) return;
    var s = el('style');
    s.id = STYLE_ID;
    s.textContent = SHORTCUT_CSS;
    DOC.head.appendChild(s);
  }

  function keyCaps(combo) {
    var wrap = el('span', 'kore-shortcut-keys');
    var pieces = String(combo).split('+');
    for (var i = 0; i < pieces.length; i++) wrap.appendChild(el('kbd', null, pieces[i]));
    return wrap;
  }

  function renderList() {
    if (!state.panel) return;
    var old = state.panel.querySelector('.kore-shortcut-list');
    if (old) old.remove();
    var list = el('ul', 'kore-shortcut-list');
    var bindings = allBindings();
    for (var i = 0; i < bindings.length; i++) {
      var b = bindings[i];
      var row = el('li', 'kore-shortcut-row');
      var label = el('span', null, b.label || b.id);
      if (b.action === 'theme' && !themeAvailable()) {
        label.appendChild(el('span', 'kore-shortcut-note', '（主题组件未加载）'));
      }
      row.appendChild(label);
      row.appendChild(keyCaps(b.combo || '—'));
      list.appendChild(row);
    }
    // 保留键位只作说明，不注册、不抢占。
    var reservedKeys = Object.keys(RESERVED);
    for (var j = 0; j < reservedKeys.length; j++) {
      var r = el('li', 'kore-shortcut-row');
      r.appendChild(el('span', 'kore-shortcut-note', '系统已占用：' + RESERVED[reservedKeys[j]]));
      r.appendChild(keyCaps(reservedKeys[j]));
      list.appendChild(r);
    }
    var foot = state.panel.querySelector('.kore-shortcut-foot');
    state.panel.insertBefore(list, foot);
  }

  function build() {
    if (state.root) return;
    ensureCss();
    var mask = el('div', 'kore-shortcut-mask');
    mask.id = ROOT_ID;
    mask.hidden = true;
    var panel = el('div', 'kore-shortcut-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '快捷键帮助');
    panel.appendChild(el('h2', 'kore-shortcut-title', '快捷键'));
    panel.appendChild(el('p', 'kore-shortcut-sub',
      '在电脑上按下面的组合键就能直接操作；手机端没有键盘，入口会隐藏。Esc、Ctrl+K 等系统键位由主壳保留，这里不会抢。'));
    var foot = el('div', 'kore-shortcut-foot');
    var action = state.options.onboardingAction;
    // 没传回调时软兜底：引导组件已加载就自动挂入口，未加载就不显示。
    if (typeof action !== 'function' && global.KoreOnboarding &&
        typeof global.KoreOnboarding.open === 'function') {
      action = function () { global.KoreOnboarding.open(); };
    }
    if (typeof action === 'function') {
      var onboardingBtn = el('button', 'kore-shortcut-btn',
        state.options.onboardingLabel || '重新查看新手引导');
      onboardingBtn.type = 'button';
      onboardingBtn.addEventListener('click', function () {
        closeHelp();
        action();
      });
      foot.appendChild(onboardingBtn);
    }
    var closeBtn = el('button', 'kore-shortcut-btn', '知道了');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closeHelp);
    foot.appendChild(closeBtn);
    panel.appendChild(foot);
    mask.appendChild(panel);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) closeHelp(); });
    var host = state.options.scope || DOC.body;
    host.appendChild(mask);
    state.root = mask;
    state.mask = mask;
    state.panel = panel;
    renderList();
  }

  function openHelp() {
    build();
    if (state.open) return;
    state.open = true;
    state.root.hidden = false;
    emit('kore:shortcut-help', { open: true });
  }

  function closeHelp() {
    if (!state.root || !state.open) return;
    state.open = false;
    state.root.hidden = true;
    emit('kore:shortcut-help', { open: false });
  }

  function toggleHelp() {
    if (state.open) closeHelp();
    else openHelp();
  }

  function createTrigger() {
    var btn = el('button', 'kore-shortcut-trigger', '快捷键');
    btn.type = 'button';
    btn.id = 'kore-shortcut-trigger';
    btn.title = '快捷键帮助（Ctrl / ⌘ + /）';
    btn.setAttribute('aria-label', '快捷键帮助');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', toggleHelp);
    return btn;
  }

  function destroy() {
    if (state.listening && state.onKey) {
      DOC.removeEventListener('keydown', state.onKey);
      state.listening = false;
    }
    if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    state.root = null;
    state.mask = null;
    state.panel = null;
    state.open = false;
    state.onKey = null;
    state.mounted = false;
    state.options = {};
  }

  function mount(options) {
    if (state.mounted) return global.KoreShortcuts; // 幂等；options 以首次 mount 为准
    state.options = options || {};
    state.mounted = true;
    if (!state.listening) {
      state.onKey = onKey;
      DOC.addEventListener('keydown', state.onKey);
      state.listening = true;
    }
    return global.KoreShortcuts;
  }

  global.KoreShortcuts = {
    mount: mount,
    destroy: destroy,
    isMounted: function () { return state.mounted; },
    openHelp: openHelp,
    closeHelp: closeHelp,
    toggleHelp: toggleHelp,
    createTrigger: createTrigger,
    register: register,
    unregister: unregister,
    getBindings: allBindings,
    isReserved: isReserved
  };
})(window);
