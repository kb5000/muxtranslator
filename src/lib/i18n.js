(function () {
  'use strict';

  var _b = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  var _msgs = null; // null = delegate to browser.i18n; object = override messages

  // Sync translation lookup. Uses _msgs if a locale was loaded, else browser.i18n.
  function t(key, subs) {
    if (_msgs) {
      var entry = _msgs[key];
      if (!entry) return key;
      var msg = entry.message || key;
      if (subs && entry.placeholders) {
        Object.keys(entry.placeholders).forEach(function (name) {
          var ph = entry.placeholders[name];
          var idx = parseInt((ph.content || '').replace('$', ''), 10) - 1;
          if (!isNaN(idx) && idx >= 0 && subs[idx] != null) {
            msg = msg.replace(new RegExp('\\$' + name.toUpperCase() + '\\$', 'gi'), subs[idx]);
          }
        });
      }
      return msg;
    }
    try {
      return (subs ? _b.i18n.getMessage(key, subs) : _b.i18n.getMessage(key)) || key;
    } catch (e) { return key; }
  }

  // Load a specific locale's messages.json. Pass '' or null to reset to browser.i18n.
  async function loadLocale(lang) {
    if (!lang) { _msgs = null; return; }
    try {
      var url = _b.runtime.getURL('_locales/' + lang + '/messages.json');
      var r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _msgs = await r.json();
    } catch (e) {
      console.warn('[i18n] failed to load locale "' + lang + '":', e.message);
      _msgs = null;
    }
  }

  // Apply [data-i18n*] attributes to the current document.
  function applyToDocument() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var msg = t(el.getAttribute('data-i18n'));
      if (msg) el.textContent = msg;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var msg = t(el.getAttribute('data-i18n-placeholder'));
      if (msg) el.placeholder = msg;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var msg = t(el.getAttribute('data-i18n-title'));
      if (msg) el.title = msg;
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      var msg = t(el.getAttribute('data-i18n-aria'));
      if (msg) el.setAttribute('aria-label', msg);
    });
  }

  // Async init: read uiLanguage from storage → load override → apply to DOM.
  // Page scripts should await this before rendering any i18n strings.
  async function init() {
    try {
      if (_b && _b.storage && _b.storage.local) {
        var result = await _b.storage.local.get('settings');
        var lang = result && result.settings && result.settings.uiLanguage;
        if (lang) await loadLocale(lang);
      }
    } catch (e) {
      // Storage unavailable or settings not yet written — fall through to browser.i18n
    }
    applyToDocument();
  }

  window.i18n = t;
  window.i18nInit = init;
  window.i18nApply = applyToDocument;
  window.i18nLoadLocale = loadLocale;
  // Allows content.js to push a pre-loaded message map so both i18n instances stay in sync.
  window.i18nSetMsgs = function (msgs) { _msgs = msgs || null; };
})();
