/* web/onboarding.js — kore 主壳「首次使用引导 / 新手检查清单」（R6-4，PLUGIN-MATURITY §3.3.2 P2）
 * ---------------------------------------------------------------------------
 * 零框架、零依赖、零网络。本文件是懒加载模块：不进首屏六件套、不改 shell.js / app.js。
 * 加载 /assets/onboarding.js 后只挂全局对象，不碰 DOM；显式调用 mount() 才生效。
 *
 * ===== 挂载 API（window.KoreOnboarding）=====
 *   mount(options)   初始化（幂等）。options:
 *                      scope       : Element —— 面板挂载父节点，默认 document.body
 *                      autoOpen    : boolean —— 是否允许"按服务端安装一次性标记"自动弹出，默认 true；
 *                                     是否真的自动弹只听服务端 GET /-/onboarding 的 should_auto_open，
 *                                     本机 localStorage 只记用户动作（跳过/完成进度），不决定自动弹。
 *                      installState: {should_auto_open:boolean, ...} —— 可选，调用方已取到服务端状态时直接传入，
 *                                     省去组件内再次请求（shell.js 首屏已探测时用）。
 *                   返回同一 API 对象，便于串联调用。
 *   open()           打开/聚焦引导（无参数），首次打开才建 DOM 并按需注入 onboarding.css
 *   close()          收起引导；用户点「以后再看」时记下跳过状态
 *   toggle()         按当前状态开/关
 *   destroy()        移除 DOM 与监听，回到未挂载状态；保留本机进度
 *   isOpen()         -> boolean
 *   isMounted()      -> boolean
 *   reset()          清除本机进度并重新打开（设置页「重新查看新手引导」可调用）
 *   getState()       -> { done:{[id]:true}, completed, dismissed, remaining, total, open }
 *   STEPS            只读步骤数组（id / title / desc / actionLabel / kind / route）
 *
 * ===== 接线方式（shell.js 首屏渲染后懒加载调用）=====
 *   <script src="/assets/onboarding.js"></script>
 *   window.KoreOnboarding.mount();                         // 仅服务端 should_auto_open 为真时自动弹一次
 *   顶栏/设置页「重新查看新手引导」按钮：
 *     onclick = function () { window.KoreOnboarding.open(); }
 *   快捷键帮助面板入口（R6-6 的 mount 选项，已双向确认）：
 *     window.KoreShortcuts.mount({
 *       onboardingAction: function () { window.KoreOnboarding.open(); },
 *       onboardingLabel: '重新查看新手引导'
 *     });
 *
 * ===== 横向对齐结论（2026-11-24 已与 r6-theme / r6-shortcuts 双向 send_message 确认）=====
 *   R6-5 主题：外观步骤只调 window.KoreTheme.toggle()（存在性判断）；组件不在则降级到设置页。
 *     本文件不读写 localStorage['kore.theme']，不碰 <html data-kore-theme/effective>，
 *     主题真源唯一归 theme.js；本组件 CSS 只引用 var(--kore-*) 令牌，随主题自动生效。
 *   R6-6 快捷键：本组件不注册任何全局键位（不占 Ctrl/Cmd+K、Ctrl/Cmd+Enter、Esc）；
 *     Esc 关闭只在自身面板上做局部 keydown + stopPropagation；快捷键步骤只读展示键位，
 *     可选调 window.KoreShortcuts.openHelp()；不派发 kore:shortcut-* 事件。
 *   R6-6 帮助面板通过 mount({onboardingAction, onboardingLabel}) 挂「重新查看新手引导」，
 *     不反向依赖本文件；本文件也派发 kore:onboarding-open / kore:onboarding-close
 *     （detail={source:'onboarding', open:boolean}）供接线任务选择性监听。
 *
 * ===== 设计纪律 =====
 *   USABILITY 四原则：默认 5 项清单、每项一键直达（核心操作 ≤2 次点击）、无必填字段、
 *   完成态给「再逛一遍」按钮、错误与空态都给人话文案，内部术语零出现。
 *   FRONTEND §3.1：断点交给 CSS media query，JS 不做视口分支；命中区 ≥44px。
 *   FRONTEND §10：role=dialog + aria-modal + Tab 焦点陷阱 + Esc 关闭后焦点归位。
 *   进度存 localStorage['kore.onboarding.v1']，只记用户动作（跳过 / 完成 / 每项进度），
 *   清缓存 / 换浏览器 / 重登都不改变"本次安装是否自动弹"——那由服务端安装标记权威决定。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var KEY = 'kore.onboarding.v1';
  var VERSION = 1;
  var STEPS = [
    { id: 'overview', title: '先看看这台机器现在怎么样',
      desc: '概览页把处理器、内存、磁盘和服务状态放在一屏，打开就能看懂。',
      actionLabel: '去看看', kind: 'route', route: 'dashboard' },
    { id: 'preset', title: '挑一套预设方案直接用',
      desc: '应用商店里选一套预设方案，不用先填端口和路径，装好就能用。',
      actionLabel: '去挑一套', kind: 'route', route: 'store' },
    { id: 'theme', title: '换个顺眼的外观',
      desc: '深色浅色随时切换，点一下就能看到变化，系统会记住你的选择。',
      actionLabel: '换一种外观', kind: 'theme' },
    { id: 'shortcuts', title: '记住两个省事的按键',
      desc: '按 Ctrl / Cmd + K 直接搜功能；按 Ctrl / Cmd + Shift + D 换外观。',
      actionLabel: '看看全部按键', kind: 'shortcuts' },
    { id: 'firsttask', title: '动手做一件正事',
      desc: '去网站页建一个站点，或者去文件页传个文件。默认值已经填好，不会填也能成。',
      actionLabel: '去建一个站点', kind: 'route', route: 'sites' }
  ];

  var options = { scope: null, autoOpen: true, installState: null };
  var state = { done: {}, completed: false, dismissed: false, seen: false };
  var autoOpened = false;
  var mounted = false;
  var openFlag = false;
  var root = null;
  var panel = null;
  var list = null;
  var progress = null;
  var summary = null;
  var lastFocus = null;
  var clickHandler = null;
  var keyHandler = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function emit(name, isOpen) {
    try {
      document.dispatchEvent(new CustomEvent(name, {
        detail: { source: 'onboarding', open: !!isOpen }
      }));
    } catch (err) { /* 老浏览器不支持 CustomEvent 时不影响功能 */ }
  }

  function readState() {
    var raw = null;
    try { raw = window.localStorage.getItem(KEY); } catch (err) { raw = null; }
    var data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (err) { data = null; } }
    var fresh = { done: {}, completed: false, dismissed: false, seen: false };
    if (!data || typeof data !== 'object') return fresh;
    fresh.seen = true;
    fresh.completed = !!data.completed;
    fresh.dismissed = !!data.dismissed;
    // 兼容早期数组形态的完成记录（["overview","preset"]），旧状态不丢弃。
    var saved = Array.isArray(data.done) ? data.done : (data.done && typeof data.done === 'object' ? Object.keys(data.done) : []);
    for (var i = 0; i < saved.length; i++) {
      if (isValidId(saved[i])) fresh.done[saved[i]] = true;
    }
    return fresh;
  }

  function writeState() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({
        v: VERSION, done: state.done, completed: state.completed,
        dismissed: state.dismissed, savedAt: new Date().toISOString()
      }));
    } catch (err) { /* 存不进去只影响刷新后的记忆，不影响本次使用 */ }
    state.seen = true;
  }

  // 服务端安装一次性标记的只读视图（权威）。GET 走公开端点，登录前即可读；
  // 失败 / 超时一律按"不自动弹"处理——绝不能因网络抖动误触发引导。
  function fetchInstallState() {
    return new Promise(function (resolve) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 4000) : null;
      var init = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
      if (ctrl) init.signal = ctrl.signal;
      fetch('/-/onboarding', init).then(function (res) {
        return res.ok ? res.json() : null;
      }).then(function (body) {
        if (timer !== null) clearTimeout(timer);
        resolve(body && body.data ? body.data : null);
      }, function () {
        if (timer !== null) clearTimeout(timer);
        resolve(null);
      });
    });
  }

  // 用户完成 / 跳过后写服务端标记：幂等、需会话。写失败只影响下次是否自动弹，
  // 不能因此打断当前界面；本机仍记一份动作状态供进度展示（见 close / mark）。
  function reportDone() {
    try {
      var csrf = '';
      var parts = document.cookie ? document.cookie.split(';') : [];
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].trim();
        if (kv.indexOf('kore_csrf=') === 0) { csrf = decodeURIComponent(kv.slice('kore_csrf='.length)); break; }
      }
      fetch('/api/v1/onboarding/done', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Kore-CSRF': csrf }
      }).catch(function () { /* 服务端不可达：本机动作照常生效，不阻塞界面 */ });
    } catch (err) { /* 隐私模式 / 无 fetch：不阻塞界面 */ }
  }

  function isValidId(id) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === id) return true;
    return false;
  }

  function remaining() {
    var n = 0;
    for (var i = 0; i < STEPS.length; i++) if (!state.done[STEPS[i].id]) n++;
    return n;
  }

  function ensureCss() {
    if (document.getElementById('kore-onboard-css')) return;
    var link = el('link');
    link.id = 'kore-onboard-css';
    link.rel = 'stylesheet';
    link.href = '/assets/onboarding.css';
    document.head.appendChild(link);
  }

  function navigate(route) {
    if (window.KoreShell && typeof window.KoreShell.navigate === 'function') {
      window.KoreShell.navigate(route);
      return;
    }
    window.location.hash = '#/' + route;
  }

  function stepRow(step, index) {
    var done = !!state.done[step.id];
    var li = el('li', 'kore-onboard-item' + (done ? ' is-done' : ''));
    var head = el('div', 'kore-onboard-item-head');
    var num = el('span', 'kore-onboard-num', done ? '✓' : String(index + 1));
    num.setAttribute('aria-hidden', 'true');
    head.appendChild(num);
    head.appendChild(el('span', 'kore-onboard-item-title', step.title));
    if (done) head.appendChild(el('span', 'kore-onboard-tag', '已完成'));
    li.appendChild(head);
    li.appendChild(el('p', 'kore-onboard-desc', step.desc));
    var ops = el('div', 'kore-onboard-ops');
    if (!done) {
      var go = el('button', 'btn kore-onboard-go', step.actionLabel);
      go.type = 'button';
      go.setAttribute('data-act', 'go');
      go.setAttribute('data-id', step.id);
      ops.appendChild(go);
    }
    var mark = el('button', 'kore-onboard-mark', done ? '撤销标记' : '我已经做了');
    mark.type = 'button';
    mark.setAttribute('data-act', 'mark');
    mark.setAttribute('data-id', step.id);
    mark.setAttribute('aria-pressed', done ? 'true' : 'false');
    ops.appendChild(mark);
    li.appendChild(ops);
    return li;
  }

  function render() {
    if (!panel) return;
    var left = remaining();
    var doneCount = STEPS.length - left;
    if (progress) {
      progress.textContent = '已完成 ' + doneCount + ' / 共 ' + STEPS.length + ' 项';
      progress.setAttribute('aria-valuenow', String(doneCount));
      progress.setAttribute('aria-valuemax', String(STEPS.length));
    }
    if (summary) {
      summary.textContent = left === 0
        ? '都完成了。接下来自由逛逛就行，有问题随时回来再看。'
        : '还剩 ' + left + ' 项，点一下就能去做，不用填任何参数。';
    }
    if (!list) return;
    list.textContent = '';
    if (left === 0) {
      var empty = el('div', 'kore-onboard-empty');
      empty.appendChild(el('strong', 'kore-onboard-empty-title', '新手任务都完成了'));
      empty.appendChild(el('p', 'kore-onboard-desc', '你已经知道东西都放在哪了。想再看一遍，点下面的按钮。'));
      var again = el('button', 'btn kore-onboard-again', '再逛一遍');
      again.type = 'button';
      again.setAttribute('data-act', 'reset');
      empty.appendChild(again);
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < STEPS.length; i++) list.appendChild(stepRow(STEPS[i], i));
  }

  function build() {
    if (root) return;
    root = el('div', 'kore-onboard-backdrop');
    panel = el('div', 'kore-onboard-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'kore-onboard-title');

    var head = el('div', 'kore-onboard-head');
    var titles = el('div', 'kore-onboard-titles');
    var h = el('h2', 'kore-onboard-title', '欢迎使用 Kore');
    h.id = 'kore-onboard-title';
    titles.appendChild(h);
    titles.appendChild(el('p', 'kore-onboard-sub', '跟着这 5 件事走一遍，就能找到常用的功能。'));
    var skip = el('button', 'kore-onboard-skip', '以后再看');
    skip.type = 'button';
    skip.setAttribute('data-act', 'skip');
    head.appendChild(titles);
    head.appendChild(skip);

    progress = el('div', 'kore-onboard-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    summary = el('p', 'kore-onboard-summary');
    list = el('ol', 'kore-onboard-list');

    var foot = el('div', 'kore-onboard-foot');
    foot.appendChild(el('span', 'kore-onboard-footnote', '进度会自动记住，下次打开不重复。'));
    var doneBtn = el('button', 'btn kore-onboard-close', '知道了');
    doneBtn.type = 'button';
    doneBtn.setAttribute('data-act', 'close');
    foot.appendChild(doneBtn);

    panel.appendChild(head);
    panel.appendChild(progress);
    panel.appendChild(summary);
    panel.appendChild(list);
    panel.appendChild(foot);
    root.appendChild(panel);

    clickHandler = function (ev) {
      var t = ev.target;
      while (t && t !== panel && !t.getAttribute) t = t.parentNode;
      if (!t || t === panel) return;
      var act = t.getAttribute('data-act');
      var id = t.getAttribute('data-id');
      if (!act) return;
      if (act === 'skip') { close({ skip: true }); return; }
      if (act === 'close') { close(); return; }
      if (act === 'reset') { reset(); return; }
      if (act === 'mark' && isValidId(id)) {
        if (state.done[id]) delete state.done[id];
        else state.done[id] = true;
        state.completed = remaining() === 0;
        writeState();
        render();
        return;
      }
      if (act === 'go') {
        var step = null;
        for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === id) step = STEPS[i];
        if (!step) return;
        if (step.kind === 'theme' && window.KoreTheme && typeof window.KoreTheme.toggle === 'function') {
          window.KoreTheme.toggle();
        } else if (step.kind === 'shortcuts' && window.KoreShortcuts && typeof window.KoreShortcuts.openHelp === 'function') {
          window.KoreShortcuts.openHelp();
        } else if (step.kind === 'route' && step.route) {
          navigate(step.route);
        } else {
          // 对应组件还没装好：不让用户点了没反应，明确给下一步去处。
          navigate('settings');
        }
        state.done[id] = true;
        state.completed = remaining() === 0;
        writeState();
        render();
      }
    };
    panel.addEventListener('click', clickHandler);

    keyHandler = function (ev) {
      if (ev.key === 'Escape') {
        // 局部处理：别让全局快捷键组件把同一次 Esc 当成抽屉/模态关闭。
        ev.stopPropagation();
        ev.preventDefault();
        close();
        return;
      }
      if (ev.key !== 'Tab') return;
      var nodes = panel.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
      if (!nodes.length) return;
      var first = nodes[0];
      var last = nodes[nodes.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault(); last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault(); first.focus();
      }
    };
    panel.addEventListener('keydown', keyHandler);

    root.addEventListener('click', function (ev) {
      if (ev.target === root) close();
    });
    (options.scope || document.body).appendChild(root);
  }

  function open() {
    if (!mounted) mount();
    ensureCss();
    build();
    if (openFlag || !root) return api;
    lastFocus = document.activeElement;
    root.hidden = false;
    openFlag = true;
    render();
    var first = panel.querySelector('button');
    if (first) first.focus();
    emit('kore:onboarding-open', true);
    return api;
  }

  function close(opts) {
    if (!openFlag) return api;
    if (opts && opts.skip) { state.dismissed = true; writeState(); }
    // 用户看过引导（跳过 / 知道了 / Esc / 点遮罩）即写服务端一次性标记：
    // 之后强刷 / 清 localStorage / 换浏览器 / 重登都不再自动弹（权威在服务端）。
    reportDone();
    root.hidden = true;
    openFlag = false;
    emit('kore:onboarding-close', false);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
    return api;
  }

  function destroy() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null; panel = null; list = null; progress = null; summary = null;
    clickHandler = null; keyHandler = null; lastFocus = null;
    openFlag = false;
    mounted = false;
    return api;
  }

  function reset() {
    try { window.localStorage.removeItem(KEY); } catch (err) { /* 无存储时不阻塞重开 */ }
    state = { done: {}, completed: false, dismissed: false, seen: false };
    if (!root) { destroy(); }
    else render();
    return open();
  }

  function mount(opts) {
    if (mounted) return api;
    mounted = true;
    if (opts && typeof opts === 'object') {
      options = {
        scope: opts.scope && opts.scope.appendChild ? opts.scope : null,
        autoOpen: opts.autoOpen === false ? false : true,
        installState: opts.installState || null
      };
    }
    state = readState();
    // 自动弹出只认服务端安装标记（should_auto_open），本机 localStorage 不参与判定：
    // 清缓存 / 换浏览器 / 重登改不到服务端状态，因此不会重复弹；手动 open() 不受影响。
    if (options.autoOpen && !autoOpened) {
      var decide = function (st) {
        if (st && st.should_auto_open) {
          autoOpened = true;
          open();
          // 安装那一次已经弹出：立即写服务端标记，哪怕用户不点任何按钮就强刷也不再弹。
          // 服务端写是幂等的；close() 里的重复写无害。
          reportDone();
        }
      };
      if (options.installState) decide(options.installState);
      else fetchInstallState().then(decide);
    }
    return api;
  }

  var api = {
    mount: mount,
    open: open,
    close: close,
    toggle: function () { return openFlag ? close() : open(); },
    destroy: destroy,
    isOpen: function () { return openFlag; },
    isMounted: function () { return mounted; },
    reset: reset,
    getState: function () {
      var done = {};
      for (var k in state.done) if (Object.prototype.hasOwnProperty.call(state.done, k)) done[k] = true;
      return { done: done, completed: !!state.completed, dismissed: !!state.dismissed,
        remaining: remaining(), total: STEPS.length, open: openFlag };
    },
    STEPS: STEPS
  };

  window.KoreOnboarding = api;
}());
