/* web/theme.js — kore 主壳「深浅色主题」切换逻辑（R6-5）
 * ---------------------------------------------------------------------------
 * 零依赖、零框架。挂载后立即可用（挂载即 init，幂等）。
 *
 * 【挂载 API】window.KoreTheme（ES module 或普通 script 均可，本文件为 IIFE）
 *   init()            初始化：读取偏好 → 写 <html> 属性 → 监听系统主题变化（幂等）
 *   set(mode)         设置偏好；mode ∈ 'light' | 'dark' | 'system'，持久化到
 *                     localStorage['kore.theme']，返回归一化后的 mode
 *   get()             返回当前偏好字符串（'system' | 'light' | 'dark'）
 *   getEffective()    返回实际生效的 'light' | 'dark'（system 按系统偏好解析）
 *   toggle()          在 light/dark 间切换（以当前生效值为准），返回新 mode
 *   onChange(cb)      注册变化回调 cb({mode, effective})，返回取消注册函数
 *   createToggle()    生成一个中文文案的 <button class="kore-theme-toggle">，
 *                     点击即 toggle，文案/aria 随主题自动更新（需配套 theme.css）
 *   destroyToggle(btn) 解绑 createToggle 生成的按钮回调
 *   MODES             只读常量 ['system','light','dark']
 *   STORAGE_KEY       存储键 'kore.theme'
 *
 * 【DOM 契约】<html data-kore-theme="<mode>" data-kore-effective="<light|dark>">
 *   前者是用户选择（供设置 UI 显示），后者是实际生效（theme.css 据此覆盖令牌）。
 *   theme.css 未加载时本脚本仍安全：属性照写，只是视觉不变色。
 *
 * 【接线建议】顶栏「设置」或外观设置卡里：
 *   <link rel="stylesheet" href="/assets/theme.css">   // 按需注入，不进首屏
 *   <script src="/assets/theme.js"></script>            // 挂载即生效
 *   const off = KoreTheme.onChange(({mode}) => updateSelect(mode));
 *   设置项三选一（跟随系统 / 浅色 / 深色）直接调 KoreTheme.set(value)。
 *
 * 【横向对齐 — 2026-11-24 已双向 send_message 确认】
 *   - R6-4 onboarding（window.KoreOnboarding）：外观步骤调 KoreTheme.toggle()，
 *     组件不存在则降级跳设置页；不读写 localStorage['kore.theme']、不碰 DOM 属性，
 *     主题真源唯一归本文件；其 CSS 只用 var(--kore-*) 令牌，自动随主题生效。
 *   - R6-6 shortcuts（window.KoreShortcuts）：绑定 Ctrl/Cmd+Shift+D →
 *     KoreTheme.toggle()（存在性判断 + 未加载标注）；其浮层用 kore-shortcut-* 前缀
 *     与 --kore-* 令牌，不覆盖全局、不用 !important，与本组件零选择器冲突。
 *   切换机制：HTML 属性 data-kore-theme + data-kore-effective（非 class），
 *   令牌在 theme.css 按 data-kore-effective 覆盖，所有 var(--kore-*) 消费者自动生效。
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'kore.theme';
  var THEME_ATTR = 'data-kore-theme';
  var EFFECTIVE_ATTR = 'data-kore-effective';
  var MODES = ['system', 'light', 'dark'];
  var VALID = { system: true, light: true, dark: true };

  var listeners = [];
  var mediaQuery = null;
  var inited = false;

  function normalize(mode) {
    return VALID[mode] ? mode : 'system';
  }

  function readStored() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null; // 隐私模式/禁用存储：降级为跟随系统，不抛错
    }
  }

  function writeStored(mode) {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch (err) {
      // 存不进去也要让本次切换生效，只是刷新后不保留
    }
  }

  function get() {
    return normalize(readStored());
  }

  function systemPrefersLight() {
    if (!window.matchMedia) return false; // 老浏览器无媒体查询：默认深色
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  function getEffective() {
    var mode = get();
    if (mode === 'system') return systemPrefersLight() ? 'light' : 'dark';
    return mode;
  }

  function notify() {
    var payload = { mode: get(), effective: getEffective() };
    listeners.slice().forEach(function (cb) {
      try {
        cb(payload);
      } catch (err) {
        // 单个消费者报错不影响主题应用与其它监听者
      }
    });
  }

  function apply() {
    var root = document.documentElement;
    var mode = get();
    var effective = getEffective();
    root.setAttribute(THEME_ATTR, mode);
    root.setAttribute(EFFECTIVE_ATTR, effective);
    notify();
  }

  function set(mode) {
    var normalized = normalize(mode);
    writeStored(normalized);
    apply();
    return normalized;
  }

  function toggle() {
    return set(getEffective() === 'dark' ? 'light' : 'dark');
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function () {
      var idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }

  function renderToggle(btn) {
    var effective = getEffective();
    var label = effective === 'dark' ? '切换为浅色' : '切换为深色';
    btn.textContent = label;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', effective === 'dark' ? 'true' : 'false');
  }

  function createToggle() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kore-theme-toggle';
    renderToggle(btn);
    btn.__koreThemeOff = onChange(function () { renderToggle(btn); });
    btn.addEventListener('click', function () { toggle(); });
    return btn;
  }

  function destroyToggle(btn) {
    if (!btn) return;
    if (typeof btn.__koreThemeOff === 'function') {
      btn.__koreThemeOff();
      btn.__koreThemeOff = null;
    }
  }

  function init() {
    if (inited) {
      apply(); // 重复调用也要同步一次属性，保持幂等
      return api;
    }
    inited = true;

    if (window.matchMedia) {
      mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
      var onSystemChange = function () {
        if (get() === 'system') apply(); // 只有跟随系统时才响应系统切换
      };
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', onSystemChange);
      } else if (mediaQuery.addListener) {
        mediaQuery.addListener(onSystemChange);
      }
    }

    apply();
    return api;
  }

  var api = {
    init: init,
    set: set,
    get: get,
    getEffective: getEffective,
    toggle: toggle,
    onChange: onChange,
    createToggle: createToggle,
    destroyToggle: destroyToggle,
    MODES: MODES.slice(),
    STORAGE_KEY: STORAGE_KEY
  };

  window.KoreTheme = api;
  init(); // 挂载即生效；接线任务无需再手动调 init()
})();
