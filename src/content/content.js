(function () {
  'use strict';

  if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
    window.browser = chrome;
  }

  if (window.__muxtranslatorLoaded) return;
  window.__muxtranslatorLoaded = true;

  // ====================================================================
  // JSDoc shared typedefs (referenced by ui.js / scanner.js / pump.js)
  // ====================================================================

  /**
   * @typedef {'pending'|'inflight'|'done'|'error'} ItemStatus
   *
   * @typedef {Object} Item
   * @property {string}      id
   * @property {Text}        [node]       - DOM text node (absent for pdf items)
   * @property {Element}     element      - observed element (parent for text, layer for PDF)
   * @property {string}      original     - raw text including surrounding whitespace
   * @property {string}      text         - normalised text sent to the API
   * @property {0|1|2}       priority     - VISIBLE=0, NEAR=1, FAR=2
   * @property {ItemStatus}  status
   * @property {'pdf'}       [kind]
   * @property {Element}     [layer]      - .textLayer element (PDF only)
   * @property {object}      [paragraph]  - PdfModule paragraph descriptor (PDF only)
   *
   * @typedef {Object} Engine
   * @property {boolean}                              started
   * @property {object|null}                          settings
   * @property {string|null}                          providerId
   * @property {Map<string, Item>}                    items
   * @property {WeakMap<Element, Set<string>>}        itemsByElement
   * @property {[Set<string>,Set<string>,Set<string>]} queues
   * @property {number}                               inFlight
   * @property {number}                               nextId
   * @property {number}                               nextBatchId
   * @property {Map<string, Map<string, Item>>}       batchItems
   * @property {IntersectionObserver|null}            intersectionObserver
   * @property {MutationObserver|null}                mutationObserver
   * @property {Set<Element>|null}                    pendingMutationRoots
   * @property {number|null}                          mutationTimer
   * @property {{prompt:number, completion:number}}   sessionTokens
   * @property {boolean}                              paused
   * @property {boolean}                              progressHidden
   * @property {boolean}                              pdfMode
   * @property {string}                               [pageLanguage]
   *
   * @typedef {Object} Tracking
   * @property {WeakMap<Text, string>} translatedValueOf  - translated text we wrote
   * @property {WeakMap<Text, string>} originalValueOf    - original text before translation
   * @property {Set<Text>}             translatedNodes     - every text node we've written to
   * @property {Set<Element>}          bilingualElements   - bilingual <span> elements we created
   * @property {Set<Element>}          pdfOverlays         - PDF overlay elements
   */

  // ====================================================================
  // i18n
  // ====================================================================

  var _i18nMsgs = null;

  /**
   * @param {string} key
   * @param {string[]} [subs]
   */
  function t(key, subs) {
    if (_i18nMsgs) {
      var entry = _i18nMsgs[key];
      if (!entry) return key;
      var msg = entry.message || key;
      if (subs && entry.placeholders) {
        Object.keys(entry.placeholders).forEach(function (name) {
          var ph  = entry.placeholders[name];
          var idx = parseInt((ph.content || '').replace('$', ''), 10) - 1;
          if (!isNaN(idx) && idx >= 0 && subs[idx] != null) {
            msg = msg.replace(new RegExp('\\$' + name.toUpperCase() + '\\$', 'gi'), subs[idx]);
          }
        });
      }
      return msg;
    }
    try {
      return (subs ? browser.i18n.getMessage(key, subs) : browser.i18n.getMessage(key)) || key;
    } catch (e) { return key; }
  }

  /** @param {string} lang */
  async function loadI18nOverride(lang) {
    if (!lang) { _i18nMsgs = null; return; }
    try {
      var url = browser.runtime.getURL('_locales/' + lang + '/messages.json');
      var r   = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _i18nMsgs = await r.json();
    } catch (e) {
      _i18nMsgs = null;
    }
  }

  // ====================================================================
  // Constants
  // ====================================================================

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1,
    NOSCRIPT: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, TEXTAREA: 1, INPUT: 1,
    SELECT: 1, CANVAS: 1, SVG: 1, MATH: 1
  };

  var PRIORITY = { VISIBLE: 0, NEAR: 1, FAR: 2 };

  // ====================================================================
  // Engine state
  // ====================================================================

  /** @type {Engine} */
  var engine = {
    started:  false,
    settings: null,
    providerId: null,

    items:          new Map(),
    itemsByElement: new WeakMap(),
    queues:         [new Set(), new Set(), new Set()],

    inFlight:    0,
    nextId:      1,
    nextBatchId: 1,
    batchItems:  new Map(),

    intersectionObserver:  null,
    mutationObserver:      null,
    pendingMutationRoots:  null,
    mutationTimer:         null,

    sessionTokens: { prompt: 0, completion: 0 },
    paused:         false,
    progressHidden: false,
    pdfMode:        false
  };

  /** @type {Tracking} */
  var tracking = {
    translatedValueOf: new WeakMap(),
    originalValueOf:   new WeakMap(),
    translatedNodes:   new Set(),
    bilingualElements: new Set(),
    pdfOverlays:       new Set()
  };

  // ====================================================================
  // Settings
  // ====================================================================

  async function loadSettings() {
    try {
      var res = await browser.runtime.sendMessage({ type: 'GET_SETTINGS', payload: {} });
      if (res && res.success) {
        var s = res.data.settings;
        await loadI18nOverride(s.uiLanguage || '');
        return s;
      }
    } catch (e) {
      console.warn('[MuxTranslator] loadSettings failed:', e);
    }
    return Object.assign({}, SettingsModule.DEFAULT_SETTINGS);
  }

  // ====================================================================
  // Module instantiation
  // ====================================================================

  var ui        = UIModule({ t: t, engine: engine });
  var scanner   = ScannerModule({ engine: engine, tracking: tracking, SKIP_TAGS: SKIP_TAGS, PRIORITY: PRIORITY });
  var pump      = PumpModule({
    engine:   engine,
    tracking: tracking,
    ui:       ui,
    rescan:   function () {
      if (engine.pdfMode) scanPdfPages();
      else if (document.body) scanner.scanSubtree(document.body);
      ui.updateProgressTotal();
    }
  });
  var selection = SelectionModule({ t: t, escapeHtml: ui.escapeHtml });

  // ====================================================================
  // Observers
  // ====================================================================

  function setupObservers() {
    scanner.setupObservers(onIntersect, onMutation, onPdfMutation);
  }

  function onIntersect(entries) {
    var changed = false;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var ids   = engine.itemsByElement.get(entry.target);
      if (!ids) continue;
      var newPriority;
      if (!entry.isIntersecting) {
        newPriority = PRIORITY.FAR;
      } else {
        var rect = entry.boundingClientRect;
        var vh   = window.innerHeight || document.documentElement.clientHeight;
        newPriority = (rect.bottom > 0 && rect.top < vh) ? PRIORITY.VISIBLE : PRIORITY.NEAR;
      }
      ids.forEach(function (id) {
        var it = engine.items.get(id);
        if (it && it.priority !== newPriority) {
          scanner.updateItemPriority(it, newPriority);
          changed = true;
        }
      });
    }
    if (changed) pump.schedulePump();
  }

  function onMutation(mutations) {
    if (!engine.pendingMutationRoots) engine.pendingMutationRoots = new Set();
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'characterData') {
        var node  = m.target;
        var known = tracking.translatedValueOf.get(node);
        if (known !== undefined) {
          var current = node.nodeValue || '';
          var trim    = current.replace(/^\s+|\s+$/g, '');
          if (trim === known) continue;
          var origNorm = UtilsModule.normalizeText(tracking.originalValueOf.get(node) || '');
          var curNorm  = UtilsModule.normalizeText(trim);
          if (origNorm && origNorm === curNorm) {
            // SPA reverted — re-apply synchronously
            try {
              var lead  = (current.match(/^\s*/) || [''])[0];
              var trail = (current.match(/\s*$/) || [''])[0];
              node.nodeValue = lead + known + trail;
            } catch (e) {}
            continue;
          }
          tracking.translatedValueOf.delete(node);
          tracking.originalValueOf.delete(node);
        }
        var el = node.parentElement;
        if (el) engine.pendingMutationRoots.add(el);
      } else if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType === 1) {
            if (n.id === 'muxtranslator-bar' || n.id === 'muxtranslator-progress') continue;
            engine.pendingMutationRoots.add(n);
          } else if (n.nodeType === 3 && n.parentElement) {
            engine.pendingMutationRoots.add(n.parentElement);
          }
        }
      }
    }
    clearTimeout(engine.mutationTimer);
    engine.mutationTimer = setTimeout(flushMutations, 300);
  }

  function flushMutations() {
    if (!engine.pendingMutationRoots) return;
    if (!engine.started) { engine.pendingMutationRoots.clear(); return; }
    var roots = Array.from(engine.pendingMutationRoots);
    engine.pendingMutationRoots.clear();
    var added = 0;
    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      if (!r || !r.isConnected) continue;
      var before = engine.items.size;
      scanner.scanSubtree(r);
      added += engine.items.size - before;
    }
    if (tracking.translatedNodes.size > 512) {
      tracking.translatedNodes.forEach(function (n) {
        if (!n || !n.isConnected) tracking.translatedNodes.delete(n);
      });
    }
    if (added > 0) {
      ui.showProgress();
      ui.updateProgressTotal();
      pump.schedulePump();
    }
  }

  // ====================================================================
  // PDF pipeline
  // ====================================================================

  function scanPdfPages() {
    var layers = document.querySelectorAll('.textLayer');
    for (var i = 0; i < layers.length; i++) scanPdfLayer(layers[i]);
  }

  function scanPdfLayer(layer) {
    if (!layer || !layer.isConnected) return;
    if (layer.dataset && layer.dataset.muxtPdfProcessed === '1') return;
    if (window.__muxtPdfDebug) {
      try { PdfModule.drawDebug(layer); } catch (e) {}
      return;
    }
    var paragraphs = PdfModule.groupIntoParagraphs(layer);
    if (!paragraphs.length) return;
    layer.dataset.muxtPdfProcessed = '1';
    for (var i = 0; i < paragraphs.length; i++) {
      registerPdfParagraph(paragraphs[i], layer);
    }
  }

  /** @param {object} para @param {Element} layer */
  function registerPdfParagraph(para, layer) {
    var text = UtilsModule.normalizeText(para.text);
    if (!text) return;
    if (!UtilsModule.hasTranslatableContent(text)) return;

    var id = 'ot' + (engine.nextId++);
    /** @type {Item} */
    var item = {
      id:        id,
      kind:      'pdf',
      layer:     layer,
      paragraph: para,
      element:   layer,
      original:  para.text,
      text:      text,
      priority:  scanner.computePriority(layer),
      status:    'pending'
    };
    engine.items.set(id, item);

    var set = engine.itemsByElement.get(layer);
    if (!set) {
      set = new Set();
      engine.itemsByElement.set(layer, set);
      if (engine.intersectionObserver) {
        try { engine.intersectionObserver.observe(layer); } catch (e) {}
      }
    }
    set.add(id);
    engine.queues[item.priority].add(id);
  }

  function onPdfMutation(mutations) {
    if (!engine.pendingMutationRoots) engine.pendingMutationRoots = new Set();
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type !== 'childList') continue;
      for (var j = 0; j < m.addedNodes.length; j++) {
        var n = m.addedNodes[j];
        if (n.nodeType !== 1) continue;
        if (n.dataset && n.dataset.muxtranslatorSkip === '1') continue;
        if (n.classList && n.classList.contains('textLayer')) {
          engine.pendingMutationRoots.add(n);
        } else if (n.closest) {
          var layer = n.closest('.textLayer');
          if (layer) engine.pendingMutationRoots.add(layer);
        }
        if (n.querySelectorAll) {
          var nested = n.querySelectorAll('.textLayer');
          for (var k = 0; k < nested.length; k++) engine.pendingMutationRoots.add(nested[k]);
        }
      }
      for (var r = 0; r < m.removedNodes.length; r++) {
        var rn = m.removedNodes[r];
        if (rn.nodeType !== 1) continue;
        // PDF.js wipes the text layer on zoom/rotate — allow it to be re-scanned.
        if (rn.classList && rn.classList.contains('textLayer') && rn.dataset) {
          delete rn.dataset.muxtPdfProcessed;
        }
      }
    }
    clearTimeout(engine.mutationTimer);
    engine.mutationTimer = setTimeout(flushPdfMutations, 500);
  }

  function flushPdfMutations() {
    if (!engine.pendingMutationRoots) return;
    if (!engine.started) { engine.pendingMutationRoots.clear(); return; }
    var layers = Array.from(engine.pendingMutationRoots);
    engine.pendingMutationRoots.clear();
    var before = engine.items.size;
    for (var i = 0; i < layers.length; i++) {
      if (layers[i] && layers[i].isConnected) scanPdfLayer(layers[i]);
    }
    if (engine.items.size - before > 0) {
      ui.showProgress();
      ui.updateProgressTotal();
      pump.schedulePump();
    }
  }

  // ====================================================================
  // Engine lifecycle
  // ====================================================================

  /** @param {{ providerId?: string, targetLanguage?: string }} [opts] */
  async function startEngine(opts) {
    if (engine.started) return;
    opts = opts || {};
    engine.settings    = await loadSettings();
    engine.providerId  = opts.providerId || resolveProviderIdFromRules(engine.settings);
    if (opts.targetLanguage) engine.settings.targetLanguage = opts.targetLanguage;
    engine.pdfMode = PdfModule.isPdfViewerPage();

    if (!Array.isArray(engine.settings.providers) || engine.settings.providers.length === 0) {
      alert(t('alertNoProviders'));
      return;
    }

    engine.started = true;
    ui.removeBar();
    setupObservers();

    if (engine.pdfMode) {
      if ((engine.settings.pdfMode || 'replace') === 'tooltip') {
        PdfModule.installTooltipDelegation();
      }
      scanPdfPages();
    } else {
      scanner.scanSubtree(document.body);
    }

    ui.updateProgressTotal();
    if (pump.hasWork() || engine.inFlight > 0) ui.showProgress();
    pump.pump();
    markPageTranslated();
    writeTabState('on');
    emitEngineChanged(true);
  }

  function emitEngineChanged(active) {
    try {
      window.dispatchEvent(new CustomEvent('muxt-engine-changed', {
        detail: { active: !!active }
      }));
    } catch (e) {}
  }

  /** @returns {number} count of nodes restored */
  function restorePage() {
    engine.paused = true;
    var count = 0;

    tracking.translatedNodes.forEach(function (node) {
      if (!node || !node.isConnected) return;
      var original = tracking.originalValueOf.get(node);
      if (original == null) return;
      try {
        var current  = node.nodeValue || '';
        var leading  = (current.match(/^\s*/) || [''])[0];
        var trailing = (current.match(/\s*$/) || [''])[0];
        node.nodeValue = leading + original + trailing;
        count++;
      } catch (e) {}
    });

    tracking.bilingualElements.forEach(function (span) {
      if (!span || !span.isConnected || !span.parentNode) return;
      var original = span.dataset.muxtOriginal;
      if (original == null) return;
      var leading  = span.dataset.muxtLeading  || '';
      var trailing = span.dataset.muxtTrailing || '';
      try {
        var textNode = document.createTextNode(leading + original + trailing);
        span.parentNode.replaceChild(textNode, span);
        count++;
      } catch (e) {}
    });
    tracking.bilingualElements.clear();

    tracking.pdfOverlays.forEach(function (el) { PdfModule.removeOverlay(el); });
    tracking.pdfOverlays.clear();
    var processedLayers = document.querySelectorAll('.textLayer[data-muxt-pdf-processed]');
    for (var li = 0; li < processedLayers.length; li++) {
      if (processedLayers[li].dataset) delete processedLayers[li].dataset.muxtPdfProcessed;
    }

    pump.cancelScheduledPump();

    if (engine.mutationObserver) {
      engine.mutationObserver.disconnect();
      engine.mutationObserver = null;
    }
    if (engine.intersectionObserver) {
      engine.intersectionObserver.disconnect();
      engine.intersectionObserver = null;
    }
    if (engine.mutationTimer) { clearTimeout(engine.mutationTimer); engine.mutationTimer = null; }
    engine.pendingMutationRoots = null;

    engine.queues[0].clear();
    engine.queues[1].clear();
    engine.queues[2].clear();
    engine.items.clear();
    engine.itemsByElement = new WeakMap();

    tracking.translatedNodes.clear();
    tracking.translatedValueOf = new WeakMap();
    tracking.originalValueOf   = new WeakMap();

    ui.hideProgressNow();
    ui.progressState.completed  = 0;
    ui.progressState.totalSeen  = 0;
    engine.progressHidden = false;
    engine.started        = false;
    engine.paused         = false;
    engine.pdfMode        = false;
    engine.sessionTokens  = { prompt: 0, completion: 0 };
    writeTabState('off');

    clearPageTranslatedFlag();
    emitEngineChanged(false);
    return count;
  }

  /** @param {object} settings @returns {string} */
  function resolveProviderIdFromRules(settings) {
    var host = '';
    try { host = window.location && window.location.hostname; } catch (e) {}
    if (host) {
      var rule = SettingsModule.resolveSiteRule(settings, host);
      if (rule && rule.mode === 'always' && rule.providerId) return rule.providerId;
    }
    if (PdfModule.isPdfViewerPage() && settings.pdfProviderId) {
      return settings.pdfProviderId;
    }
    return settings.defaultProviderId;
  }

  // ====================================================================
  // Session storage persistence
  // ====================================================================

  var MUXT_PROVIDER_KEY  = 'muxt.lastProviderId';
  var MUXT_LANG_KEY      = 'muxt.lastTargetLang';
  var MUXT_TAB_STATE_KEY = 'muxt.tabState';
  var MUXT_TAB_HOST_KEY  = 'muxt.tabHost';

  /** @param {string} providerId */
  function rememberProviderChoice(providerId) {
    if (!providerId) return;
    try { sessionStorage.setItem(MUXT_PROVIDER_KEY, providerId); } catch (e) {}
  }

  function readRememberedProvider() {
    try { return sessionStorage.getItem(MUXT_PROVIDER_KEY) || null; } catch (e) { return null; }
  }

  /** @param {string} lang */
  function rememberTargetLang(lang) {
    if (!lang) return;
    try { sessionStorage.setItem(MUXT_LANG_KEY, lang); } catch (e) {}
  }

  function readRememberedTargetLang() {
    try { return sessionStorage.getItem(MUXT_LANG_KEY) || null; } catch (e) { return null; }
  }

  function muxtTranslatedKey() {
    try { return 'muxt.translated.' + window.location.href; } catch (e) { return null; }
  }

  function markPageTranslated() {
    var k = muxtTranslatedKey();
    if (!k) return;
    try { sessionStorage.setItem(k, '1'); } catch (e) {}
  }

  function clearPageTranslatedFlag() {
    var k = muxtTranslatedKey();
    if (!k) return;
    try { sessionStorage.removeItem(k); } catch (e) {}
  }

  function wasPageTranslated() {
    var k = muxtTranslatedKey();
    if (!k) return false;
    try { return sessionStorage.getItem(k) === '1'; } catch (e) { return false; }
  }

  /** @returns {{ state: string|null, host: string|null }} */
  function readTabState() {
    try {
      return {
        state: sessionStorage.getItem(MUXT_TAB_STATE_KEY),
        host:  sessionStorage.getItem(MUXT_TAB_HOST_KEY)
      };
    } catch (e) { return { state: null, host: null }; }
  }

  /** @param {'on'|'off'} state */
  function writeTabState(state) {
    var h = '';
    try { h = window.location.hostname; } catch (e) {}
    try {
      sessionStorage.setItem(MUXT_TAB_STATE_KEY, state);
      sessionStorage.setItem(MUXT_TAB_HOST_KEY,  h);
    } catch (e) {}
  }

  // ====================================================================
  // Message handler
  // ====================================================================

  browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'TRANSLATE_PAGE':
        rememberProviderChoice(message.payload && message.payload.providerId);
        startEngine(message.payload || {});
        sendResponse({ success: true });
        return false;
      case 'SET_PROVIDER':
        rememberProviderChoice(message.payload && message.payload.providerId);
        if (engine.started && message.payload && message.payload.providerId) {
          engine.providerId = message.payload.providerId;
        }
        sendResponse({ success: true });
        return false;
      case 'SET_TARGET_LANG':
        rememberTargetLang(message.payload && message.payload.targetLang);
        if (engine.started && message.payload && message.payload.targetLang) {
          engine.settings.targetLanguage = message.payload.targetLang;
        }
        sendResponse({ success: true });
        return false;
      case 'GET_PAGE_INFO':
        sendResponse({
          success: true,
          data: {
            lang:          engine.pageLanguage || '',
            isTranslating: engine.started && (engine.inFlight > 0 || pump.hasWork()),
            paused:        engine.paused,
            sessionTokens: {
              prompt:     engine.sessionTokens.prompt     || 0,
              completion: engine.sessionTokens.completion || 0
            },
            bilingualMode: (engine.settings && engine.settings.bilingualMode) || 'off',
            isPdf:         PdfModule.isPdfViewerPage(),
            lastProviderId: readRememberedProvider(),
            lastTargetLang: readRememberedTargetLang(),
            url:   window.location.href,
            title: document.title
          }
        });
        return false;
      case 'SET_BILINGUAL_MODE':
        pump.applyBilingualMode((message.payload && message.payload.mode) || 'off');
        sendResponse({ success: true });
        return false;
      case 'PAUSE_TRANSLATION':
        engine.paused = true;
        pump.cancelInFlightBatches();
        ui.hideProgressNow();
        sendResponse({ success: true });
        return false;
      case 'RESUME_TRANSLATION':
        engine.paused = false;
        pump.rescanForResume();
        if (pump.hasWork() || engine.inFlight > 0) ui.showProgress();
        pump.pump();
        sendResponse({ success: true });
        return false;
      case 'RESTORE_PAGE':
        sendResponse({ success: true, data: { restored: restorePage() } });
        return false;
      case 'TRANSLATION_PARTIAL':
        pump.onPartial(message.payload);
        sendResponse({ success: true });
        return false;
      case 'TRANSLATION_ERROR':
        ui.showErrorToast(message.payload && message.payload.message);
        sendResponse({ success: true });
        return false;
      case 'TRANSLATION_USAGE':
        if (message.payload && message.payload.usage) {
          engine.sessionTokens.prompt     += message.payload.usage.prompt_tokens     || 0;
          engine.sessionTokens.completion += message.payload.usage.completion_tokens || 0;
          ui.updateProgress();
        }
        sendResponse({ success: true });
        return false;
    }
  });

  // ====================================================================
  // Init (auto-detect + site rules)
  // ====================================================================

  async function init() {
    // The bundled PDF viewer loads this script directly. Skip auto-init until
    // the muxt-pdf-loaded event fires per document (see bottom of file).
    var _isExtPage = false;
    try {
      var _p = window.location.protocol;
      _isExtPage = _p === 'moz-extension:' || _p === 'chrome-extension:';
    } catch (e) {}
    if ((_isExtPage || window.__muxtViewerManaged) && !window.__muxtViewerReady) return;

    engine.pageLanguage = UtilsModule.detectPageLanguage();
    var isPdf = PdfModule.isPdfViewerPage();
    var s     = await loadSettings();
    var host  = '';
    try { host = window.location && window.location.hostname; } catch (e) {}
    var rule = SettingsModule.resolveSiteRule(s, host);

    if (s.selectionEnabled !== false) selection.installSelectionHandler();

    if (rule && rule.mode === 'skip') return;

    if (rule && rule.mode === 'always' && rule.providerId) {
      startEngine({ providerId: rule.providerId });
      return;
    }

    // Tab-level state: if the user translated (or stopped) on the same hostname
    // earlier in this tab session, carry that choice forward without re-asking.
    var tabData = readTabState();
    if (tabData.host === host && tabData.state) {
      if (tabData.state === 'on') {
        var rememberedTab = readRememberedProvider();
        var providerExistsTab = rememberedTab && Array.isArray(s.providers) &&
          s.providers.some(function (p) { return p.id === rememberedTab; });
        startEngine(providerExistsTab ? { providerId: rememberedTab } : {});
        return;
      }
      if (tabData.state === 'off') return;  // user stopped — don't translate, don't ask
    }

    if (wasPageTranslated()) {
      var remembered = readRememberedProvider();
      var providerExists = remembered && Array.isArray(s.providers) &&
        s.providers.some(function (p) { return p.id === remembered; });
      startEngine(providerExists ? { providerId: remembered } : {});
      return;
    }

    var translationMode = s.defaultTranslationMode || 'ask';
    // Unknown page language (no <html lang> or meta) → treat as possibly foreign rather than skip.
    var isForeignPage   = translationMode !== 'never' && (
      !engine.pageLanguage ||
      !UtilsModule.shouldSkipLanguage(engine.pageLanguage, s.skipLanguages, s.targetLanguage)
    );
    if (isPdf && translationMode !== 'never') isForeignPage = true;

    var onExtensionPage = false;
    try {
      var _proto = window.location.protocol;
      onExtensionPage = _proto === 'moz-extension:' || _proto === 'chrome-extension:';
    } catch (e) {}
    if (onExtensionPage) {
      if (translationMode === 'auto' && isForeignPage) startEngine();
      return;
    }

    if (translationMode === 'auto') {
      if (isForeignPage) startEngine();
      return;
    }
    if (translationMode === 'never') return;

    // 'ask' (default): show the notification bar on foreign pages.
    if (isForeignPage) {
      setTimeout(function () {
        var detected = engine.pageLanguage || (isPdf ? 'PDF' : '?');
        ui.showNotificationBar(detected, s.targetLanguage, s, {
          onTranslate: function () { startEngine(); }
        });
      }, 600);
    }
  }

  // ====================================================================
  // Public API (used by the embedded PDF viewer)
  // ====================================================================

  window.__muxTranslator = {
    startEngine: startEngine,
    restorePage: restorePage
  };

  if (window.__muxtViewerManaged) {
    window.addEventListener('muxt-pdf-loaded', function () {
      window.__muxtViewerReady = true;
      init();
    });
  }

  // ====================================================================
  // Soft-navigation support (Turbo, Turbolinks, PJAX, React Router, …)
  // ====================================================================

  /**
   * Reset all engine/tracking state without touching the DOM.
   * Used when a soft navigation swaps the body — the old nodes are already
   * gone so we only need to wipe the engine's bookkeeping.
   */
  function resetEngineForNavigation() {
    pump.cancelScheduledPump();
    pump.cancelInFlightBatches();

    if (engine.mutationObserver) {
      try { engine.mutationObserver.disconnect(); } catch (e) {}
      engine.mutationObserver = null;
    }
    if (engine.intersectionObserver) {
      try { engine.intersectionObserver.disconnect(); } catch (e) {}
      engine.intersectionObserver = null;
    }
    if (engine.mutationTimer) { clearTimeout(engine.mutationTimer); engine.mutationTimer = null; }
    engine.pendingMutationRoots = null;

    engine.queues[0].clear();
    engine.queues[1].clear();
    engine.queues[2].clear();
    engine.items.clear();
    engine.itemsByElement = new WeakMap();
    engine.batchItems.clear();

    tracking.translatedNodes.clear();
    tracking.translatedValueOf = new WeakMap();
    tracking.originalValueOf   = new WeakMap();
    tracking.bilingualElements.clear();
    tracking.pdfOverlays.clear();

    ui.hideProgressNow();
    ui.progressState.completed = 0;
    ui.progressState.totalSeen = 0;
    engine.progressHidden = false;
    engine.started        = false;
    engine.paused         = false;
    engine.pdfMode        = false;
    engine.inFlight       = 0;

    emitEngineChanged(false);
  }

  function installSpaNavigationHandler() {
    // PDF viewer manages its own lifecycle via muxt-pdf-loaded; skip.
    if (window.__muxtViewerManaged) return;

    var lastHref = window.location.href;
    var spaTimer = null;

    function onUrlChange() {
      var newHref = window.location.href;
      if (newHref === lastHref) return;
      var oldHref = lastHref;
      lastHref = newHref;

      // Hash-only change (e.g. anchor jump) — DOM is unchanged, nothing to do.
      try {
        var oldBase = new URL(oldHref);
        var newBase = new URL(newHref);
        if (oldBase.pathname + oldBase.search === newBase.pathname + newBase.search) return;
      } catch (e) {}

      ui.removeBar();

      // Always reset: frameworks like Turbo/PJAX swap the body on every
      // navigation, leaving the engine holding stale references.
      // Tab state (sessionStorage) carries the on/off decision across pages.
      resetEngineForNavigation();

      clearTimeout(spaTimer);
      spaTimer = setTimeout(function () {
        var detected = UtilsModule.detectPageLanguage();
        if (detected) engine.pageLanguage = detected;
        init();
      }, 500);
    }

    try {
      var _push    = history.pushState.bind(history);
      var _replace = history.replaceState.bind(history);
      history.pushState    = function () { _push.apply(this, arguments);    onUrlChange(); };
      history.replaceState = function () { _replace.apply(this, arguments); onUrlChange(); };
    } catch (e) {}
    window.addEventListener('popstate', onUrlChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
  installSpaNavigationHandler();
})();
