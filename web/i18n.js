/* kore i18n 骨架（ADR-0021）：中文为主（默认 zh-CN），英文为辅（en-US 懒加载）。
   不做浏览器语言猜测；未翻译 key 回退中文，不显示键名；零依赖，gzip 预算见 frontend-check.sh。 */
(function () {
  'use strict';
  var DEFAULT = 'zh-CN';
  var SUPPORTED = ['zh-CN', 'en-US'];
  var STORE_KEY = 'kore_locale';
  var SRC = { 'zh-CN': '/assets/i18n-zh-CN.js', 'en-US': '/assets/i18n-en-US.js' };
  var GLOBALS = { 'zh-CN': 'KORE_I18N_ZH_CN', 'en-US': 'KORE_I18N_EN_US' };
  var root = typeof window !== 'undefined' ? window : globalThis;
  var locale = DEFAULT;
  var listeners = [];
  var loading = Object.create(null);

  function normalize(value) {
    var v = String(value === undefined || value === null ? '' : value);
    return SUPPORTED.indexOf(v) >= 0 ? v : DEFAULT;
  }
  function table(l) {
    var g = GLOBALS[l];
    var t = g ? root[g] : null;
    return t && typeof t === 'object' ? t : null;
  }
  function remembered() {
    try { return normalize(root.localStorage && root.localStorage.getItem(STORE_KEY)); }
    catch (err) { return DEFAULT; } // 隐私模式抛错按中文
  }
  function persist(l) {
    try { root.localStorage.setItem(STORE_KEY, l); } catch (err) { /* 记忆失败不影响当次切换 */ }
  }
  function interpolate(text, params) {
    if (!params) return text;
    var out = text;
    for (var k in params) out = out.split('{' + k + '}').join(String(params[k]));
    return out;
  }
  // 当前语言 → 中文表 → key（英文缺项即显示中文）。
  function t(key, params) {
    if (!key) return '';
    var s = (table(locale) || {})[key];
    if (typeof s !== 'string' || !s) s = (table(DEFAULT) || {})[key];
    if (typeof s !== 'string' || !s) return String(key);
    return interpolate(s, params);
  }
  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](locale); } catch (err) { /* 单个订阅者失败不阻断其它 */ }
    }
  }
  function load(l) {
    if (table(l)) return Promise.resolve(l);
    if (loading[l]) return loading[l];
    loading[l] = new Promise(function (resolve, reject) {
      if (typeof document === 'undefined') { reject(new Error('no document')); return; }
      var script = document.createElement('script');
      script.src = SRC[l];
      script.async = true;
      script.onload = function () {
        if (table(l)) { resolve(l); return; }
        delete loading[l];
        reject(new Error(SRC[l] + ' 未导出 ' + GLOBALS[l]));
      };
      script.onerror = function () { delete loading[l]; reject(new Error(SRC[l] + ' 加载失败')); };
      document.head.appendChild(script);
    });
    return loading[l];
  }
  function apply(l) {
    locale = l;
    if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = l;
  }
  // 语言包就绪才切换，避免英文包失败后界面半中半英。
  function setLocale(next) {
    var target = normalize(next);
    return load(target).then(function () {
      var changed = target !== locale;
      apply(target);
      persist(target);
      if (changed) notify();
      return locale;
    });
  }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  root.KoreI18n = { t: t, setLocale: setLocale, onChange: onChange, locale: function () { return locale; } };
  var start = remembered();
  apply(DEFAULT);
  if (start !== DEFAULT) {
    load(start).then(function () { apply(start); notify(); }, function () { apply(DEFAULT); });
  }
})();
