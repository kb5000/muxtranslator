(function () {
  'use strict';

  if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
    window.browser = chrome;
  }

  // Common translation targets. If the saved target isn't in this list it
  // still gets added on the fly so the user never loses their current value.
  var COMMON_TARGETS = [
    ['zh-CN', '中文 (简体)'],
    ['zh-TW', '中文 (繁體)'],
    ['en',    'English'],
    ['ja',    '日本語'],
    ['ko',    '한국어'],
    ['es',    'Español'],
    ['fr',    'Français'],
    ['de',    'Deutsch'],
    ['pt',    'Português'],
    ['ru',    'Русский'],
    ['it',    'Italiano'],
    ['ar',    'العربية'],
    ['hi',    'हिन्दी'],
    ['vi',    'Tiếng Việt'],
    ['th',    'ไทย']
  ];

  var els = {};
  var state = {
    currentTabId: null,
    host: '',
    settings: null,
    translationPaused: false
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(el, msg, kind) {
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function init() {
    await i18nInit();

    [
      'pageLang', 'targetLang', 'siteHost',
      'providerSelect', 'translateBtn', 'pauseBtn', 'restoreBtn', 'translateStatus',
      'ruleAsk', 'ruleSkip', 'ruleAlways',
      'bilingualOff', 'bilingualEmbed', 'bilingualTooltip',
      'manualInput', 'manualBtn', 'manualStatus', 'manualResult',
      'tokPrompt', 'tokCompletion',
      'openOptions', 'openPdf'
    ].forEach(function (id) { els[id] = $(id); });

    els.openOptions.addEventListener('click', function () {
      browser.runtime.openOptionsPage();
      window.close();
    });
    if (els.openPdf) {
      els.openPdf.addEventListener('click', function () {
        browser.tabs.create({ url: browser.runtime.getURL('viewer/viewer.html') });
        window.close();
      });
    }
    els.translateBtn.addEventListener('click', onTranslatePage);
    // Changing the provider dropdown alone (without clicking Translate) is
    // enough to remember the choice on this page — the popup pre-selects
    // this value on its next open, even if the user never started translating.
    els.providerSelect.addEventListener('change', function () {
      if (!state.currentTabId) return;
      try {
        browser.tabs.sendMessage(state.currentTabId, {
          type: 'SET_PROVIDER',
          payload: { providerId: els.providerSelect.value }
        }).catch(function () {});
      } catch (e) {}
    });
    els.pauseBtn.addEventListener('click', onTogglePause);
    els.restoreBtn.addEventListener('click', onRestore);
    els.targetLang.addEventListener('change', onTargetLangChange);
    els.manualBtn.addEventListener('click', onManualTranslate);
    els.manualInput.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        onManualTranslate();
      }
    });

    els.ruleAsk.addEventListener('click', function () { setRule('ask'); });
    els.ruleSkip.addEventListener('click', function () { setRule('skip'); });
    els.ruleAlways.addEventListener('click', function () { setRule('always'); });

    els.bilingualOff.addEventListener('click', function () { setBilingual('off'); });
    els.bilingualEmbed.addEventListener('click', function () { setBilingual('embed'); });
    els.bilingualTooltip.addEventListener('click', function () { setBilingual('tooltip'); });

    // Load settings & populate providers
    state.settings = await SettingsModule.getSettings();
    populateProviders(state.settings);
    populateTargetLang(state.settings.targetLanguage);
    renderTokenStats({ prompt: 0, completion: 0 });

    // Query active tab
    try {
      var tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0]) {
        state.currentTabId = tabs[0].id;
        var url = tabs[0].url || '';
        try { state.host = new URL(url).hostname; } catch (e) { state.host = ''; }
        els.siteHost.textContent = state.host || i18n('statusNotAPage');

        // Reflect existing site rule
        reflectCurrentRule();

        try {
          var info = await browser.tabs.sendMessage(state.currentTabId, { type: 'GET_PAGE_INFO' });
          if (info && info.success) {
            els.pageLang.textContent = info.data.lang || i18n('statusUnknown');
            state.translationPaused = !!info.data.paused;
            els.pauseBtn.textContent = state.translationPaused ? i18n('btnResume') : i18n('btnPause');
            if (info.data.sessionTokens) renderTokenStats(info.data.sessionTokens);
            reflectCurrentBilingual(info.data.bilingualMode || 'off');
            // Bilingual toggles are meaningless on PDF pages (overlays replace
            // the canvas, not the DOM) — hide the whole section there.
            if (info.data.isPdf) {
              var bi = document.querySelector('.bilingual-section');
              if (bi) bi.style.display = 'none';
            }
            // Restore the per-page provider pick, if the user selected one
            // earlier on this URL. Falls back silently if the provider has
            // since been renamed/deleted.
            if (info.data.lastProviderId) {
              var hasOpt = Array.from(els.providerSelect.options).some(function (o) {
                return o.value === info.data.lastProviderId;
              });
              if (hasOpt) els.providerSelect.value = info.data.lastProviderId;
            }
            if (info.data.isTranslating) {
              setStatus(els.translateStatus, state.translationPaused ? i18n('statusPaused') : i18n('statusTranslatingInProgress'));
              els.translateBtn.disabled = true;
            }
          }
        } catch (e) {
          els.pageLang.textContent = i18n('statusUnavailable');
          els.translateBtn.disabled = true;
          els.pauseBtn.disabled = true;
          els.restoreBtn.disabled = true;
          els.bilingualOff.disabled = true;
          els.bilingualEmbed.disabled = true;
          els.bilingualTooltip.disabled = true;
          setStatus(els.translateStatus, i18n('statusCannotTranslate'), 'error');
        }
      }
    } catch (e) {
      console.warn('[MuxTranslator popup] tab query failed:', e);
    }
  }

  function populateProviders(settings) {
    var select = els.providerSelect;
    select.innerHTML = '';
    (settings.providers || []).forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + ' (' + shortType(p.type) + ')';
      if (p.id === settings.defaultProviderId) opt.selected = true;
      select.appendChild(opt);
    });
    // If a site rule is bound to a specific provider, default-select that
    var rule = SettingsModule.resolveSiteRule(settings, state.host);
    if (rule && rule.mode === 'always' && rule.providerId) {
      select.value = rule.providerId;
    }
  }

  function populateTargetLang(current) {
    els.targetLang.innerHTML = '';
    var seen = false;
    COMMON_TARGETS.forEach(function (pair) {
      var opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1] + ' (' + pair[0] + ')';
      if (pair[0] === current) { opt.selected = true; seen = true; }
      els.targetLang.appendChild(opt);
    });
    if (current && !seen) {
      var opt = document.createElement('option');
      opt.value = current;
      opt.textContent = current;
      opt.selected = true;
      els.targetLang.insertBefore(opt, els.targetLang.firstChild);
    }
  }

  async function onTargetLangChange() {
    var newLang = els.targetLang.value;
    if (!newLang) return;
    try {
      state.settings = await SettingsModule.saveSettings({ targetLanguage: newLang });
      setStatus(els.translateStatus, i18n('statusTargetSet', [newLang]), 'success');
    } catch (e) {
      setStatus(els.translateStatus, i18n('statusSaveFailed', [e.message || String(e)]), 'error');
    }
  }

  function shortType(type) {
    if (type === 'openai-compatible') return 'OpenAI';
    if (type === 'ollama') return 'Ollama';
    if (type === 'google-translate') return 'Google';
    return type;
  }

  function renderTokenStats(st) {
    st = st || { prompt: 0, completion: 0 };
    els.tokPrompt.textContent = fmt(st.prompt || 0);
    els.tokCompletion.textContent = fmt(st.completion || 0);
  }

  function fmt(n) { return (n || 0).toLocaleString(); }

  function reflectCurrentRule() {
    var rule = SettingsModule.resolveSiteRule(state.settings, state.host);
    els.ruleAsk.classList.toggle('active', !rule);
    els.ruleSkip.classList.toggle('active', rule && rule.mode === 'skip');
    els.ruleAlways.classList.toggle('active', rule && rule.mode === 'always');
  }

  function reflectCurrentBilingual(mode) {
    mode = mode || 'off';
    els.bilingualOff.classList.toggle('active', mode === 'off');
    els.bilingualEmbed.classList.toggle('active', mode === 'embed');
    els.bilingualTooltip.classList.toggle('active', mode === 'tooltip');
  }

  async function setBilingual(mode) {
    if (!state.currentTabId) return;
    try {
      await browser.tabs.sendMessage(state.currentTabId, {
        type: 'SET_BILINGUAL_MODE',
        payload: { mode: mode }
      });
      reflectCurrentBilingual(mode);
    } catch (e) {
      setStatus(els.translateStatus, i18n('statusFailed', [e.message || String(e)]), 'error');
    }
  }

  async function setRule(mode) {
    if (!state.host) return;
    var rules = Object.assign({}, state.settings.siteRules || {});
    if (mode === 'ask') {
      delete rules[state.host];
    } else if (mode === 'skip') {
      rules[state.host] = { mode: 'skip' };
    } else if (mode === 'always') {
      rules[state.host] = { mode: 'always', providerId: els.providerSelect.value };
    }
    state.settings = await SettingsModule.saveSettings({ siteRules: rules });
    reflectCurrentRule();
  }

  async function onTogglePause() {
    if (!state.currentTabId) return;
    var willPause = !state.translationPaused;
    try {
      await browser.tabs.sendMessage(state.currentTabId, {
        type: willPause ? 'PAUSE_TRANSLATION' : 'RESUME_TRANSLATION'
      });
      state.translationPaused = willPause;
      els.pauseBtn.textContent = willPause ? i18n('btnResume') : i18n('btnPause');
      setStatus(els.translateStatus, willPause ? i18n('statusPaused') : i18n('statusResumed'), 'success');
    } catch (e) {
      setStatus(els.translateStatus, i18n('statusFailed', [e.message || String(e)]), 'error');
    }
  }

  async function onRestore() {
    if (!state.currentTabId) return;
    try {
      var res = await browser.tabs.sendMessage(state.currentTabId, { type: 'RESTORE_PAGE' });
      if (res && res.success) {
        var n = (res.data && res.data.restored) || 0;
        setStatus(els.translateStatus, i18n('statusRestoredNodes', [String(n)]), 'success');
        els.translateBtn.disabled = false;
        state.translationPaused = false;
        els.pauseBtn.textContent = i18n('btnPause');
      } else {
        setStatus(els.translateStatus, (res && res.error) || i18n('statusRestoreFailed'), 'error');
      }
    } catch (e) {
      setStatus(els.translateStatus, i18n('statusFailed', [e.message || String(e)]), 'error');
    }
  }

  async function onTranslatePage() {
    if (!state.currentTabId) return;
    try {
      await browser.tabs.sendMessage(state.currentTabId, {
        type: 'TRANSLATE_PAGE',
        payload: { providerId: els.providerSelect.value }
      });
      setStatus(els.translateStatus, i18n('statusStarted'), 'success');
      setTimeout(function () { window.close(); }, 400);
    } catch (e) {
      setStatus(els.translateStatus, i18n('statusFailed', [e.message || String(e)]), 'error');
    }
  }

  async function onManualTranslate() {
    var text = els.manualInput.value.trim();
    if (!text) return;
    els.manualBtn.disabled = true;
    setStatus(els.manualStatus, i18n('statusTranslating'));
    els.manualResult.hidden = true;
    try {
      var res = await browser.runtime.sendMessage({
        type: 'TRANSLATE_TEXT',
        payload: {
          text: text,
          purpose: 'manual'
        }
      });
      if (res && res.success) {
        els.manualResult.textContent = res.data.translated || i18n('statusEmpty');
        els.manualResult.hidden = false;
        setStatus(els.manualStatus,
          res.data.fromCache ? i18n('statusCached') : i18n('statusDone', [res.data.providerName || '']),
          'success');
      } else {
        setStatus(els.manualStatus, (res && res.error) || i18n('statusFailed', ['']), 'error');
      }
    } catch (e) {
      setStatus(els.manualStatus, e.message || String(e), 'error');
    } finally {
      els.manualBtn.disabled = false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
