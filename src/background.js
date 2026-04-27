'use strict';

if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
  var browser = chrome;
}

CacheModule.init().catch(function (e) {
  console.error('[MuxTranslator] cache init error', e);
});

// ----- Provider resolution ------------------------------------------------

async function resolveProviderForRequest(providerId) {
  var s = await SettingsModule.getSettings();
  var provider = SettingsModule.resolveProvider(s, providerId);
  if (!provider) throw new Error('No provider available');
  return { settings: s, provider: provider };
}

// Attach page title/description to provider for LLM context (OpenAI/Ollama only).
function withPageContext(provider, pageContext) {
  if (!pageContext) return provider;
  var isLLM = provider.type === 'openai-compatible' || provider.type === 'ollama';
  if (!isLLM) return provider;
  var title = (pageContext.title || '').trim().slice(0, 200);
  var desc = (pageContext.description || '').trim().slice(0, 500);
  if (!title && !desc) return provider;
  var p = Object.assign({}, provider);
  p._pageContext = { title: title, description: desc };
  return p;
}

// Attach filtered glossary entries to provider (only for LLM types that support it).
function withGlossary(provider, settings, targetLang) {
  var isLLM = provider.type === 'openai-compatible' || provider.type === 'ollama';
  if (!isLLM) return provider;
  var glossary = settings.glossary || [];
  if (!glossary.length) return provider;
  var lang = (targetLang || '').toLowerCase();
  var relevant = glossary.filter(function (e) {
    if (!e.source || !e.target) return false;
    return !e.lang || e.lang.toLowerCase() === lang;
  });
  if (!relevant.length) return provider;
  var p = Object.assign({}, provider);
  p._glossary = relevant;
  return p;
}

// Cache keys combine providerId + model so switching providers never reuses a
// stale translation from a different model/provider.
function cacheModelKey(provider) {
  return (provider.id || 'default') + ':' + (provider.model || '');
}

// ----- Batch translation (non-streaming) ---------------------------------

function resolveHostname(payload, settings) {
  var scope = (payload && payload.cacheScope) || (settings && settings.cacheScope) || 'per-site';
  return scope === 'per-site' ? (payload && payload.hostname) || '' : '';
}

async function translateOne(provider, text, targetLang, cacheEnabled, hostname) {
  var modelKey = cacheModelKey(provider);
  if (cacheEnabled) {
    var hit = await CacheModule.get(text, targetLang, modelKey, hostname);
    if (hit != null) return { text: hit, fromCache: true, usage: null };
  }
  var out = await ProvidersModule.translateBatch(provider, [text], targetLang);
  var translated = (out.translations && out.translations[0]) || '';
  if (cacheEnabled && translated) {
    CacheModule.set(text, targetLang, modelKey, translated, hostname).catch(function () {});
  }
  if (out.usage) {
    SettingsModule.addTokenUsage(provider.id, out.usage).catch(function () {});
  }
  return { text: translated, fromCache: false, usage: out.usage };
}

async function translateBatch(provider, texts, targetLang, cacheEnabled, hostname) {
  if (!texts || !texts.length) return { translations: [], cacheHits: 0 };
  var modelKey = cacheModelKey(provider);
  var results = new Array(texts.length);
  var pending = [];
  var pendingIdx = [];
  var cacheHits = 0;

  for (var i = 0; i < texts.length; i++) {
    if (cacheEnabled) {
      var cached = await CacheModule.get(texts[i], targetLang, modelKey, hostname);
      if (cached != null) { results[i] = cached; cacheHits++; continue; }
    }
    pending.push(texts[i]);
    pendingIdx.push(i);
  }

  if (!pending.length) return { translations: results, cacheHits: cacheHits };

  try {
    var out = await ProvidersModule.translateBatch(provider, pending, targetLang);
    var translations = out.translations || [];
    for (var j = 0; j < pending.length; j++) {
      var translated = translations[j] || '';
      results[pendingIdx[j]] = translated;
      if (cacheEnabled && translated) {
        CacheModule.set(pending[j], targetLang, modelKey, translated, hostname).catch(function () {});
      }
    }
    if (out.usage) SettingsModule.addTokenUsage(provider.id, out.usage).catch(function () {});
  } catch (err) {
    console.warn('[MuxTranslator] batch translate failed, per-item fallback:', err.message);
    for (var k = 0; k < pending.length; k++) {
      try {
        var one = await translateOne(provider, pending[k], targetLang, cacheEnabled, hostname);
        results[pendingIdx[k]] = one.text;
      } catch (e) {
        results[pendingIdx[k]] = '';
      }
    }
  }
  return { translations: results, cacheHits: cacheHits };
}

// ----- Message handlers --------------------------------------------------

async function handleTranslateChunks(payload) {
  var resolved = await resolveProviderForRequest(payload.providerId);
  var targetLang = payload.targetLang || resolved.settings.targetLanguage;
  var pageCtx = resolved.settings.sendPageContext !== false ? payload.pageContext : null;
  var provider = withPageContext(withGlossary(resolved.provider, resolved.settings, targetLang), pageCtx);
  var cacheEnabled = payload.cacheEnabled !== false && resolved.settings.cacheEnabled !== false;
  var hostname = resolveHostname(payload, resolved.settings);
  var result = await translateBatch(provider, payload.texts || [], targetLang, cacheEnabled, hostname);
  return { success: true, data: result };
}

// Tracks AbortControllers for in-flight translation batches, keyed by
// `tabId:batchId`. TRANSLATE_ABORT looks up and aborts by tab so the user's
// pause action instantly cancels any pending network requests.
var inFlightBatches = new Map();

function _bkey(tabId, batchId) { return tabId + ':' + batchId; }

function abortTabBatches(tabId, batchIds) {
  if (!tabId) return 0;
  var cancelled = 0;
  var wantAll = !Array.isArray(batchIds) || batchIds.length === 0;
  var wantSet = wantAll ? null : new Set(batchIds);
  inFlightBatches.forEach(function (rec, key) {
    if (rec.tabId !== tabId) return;
    if (wantSet && !wantSet.has(rec.batchId)) return;
    try { rec.controller.abort(); cancelled++; } catch (e) {}
    inFlightBatches.delete(key);
  });
  return cancelled;
}

async function handleTranslateAbort(payload, sender) {
  var tabId = sender && sender.tab && sender.tab.id;
  var cancelled = abortTabBatches(tabId, payload && payload.batchIds);
  return { success: true, data: { cancelled: cancelled } };
}

async function handleTranslateStream(payload, sender) {
  var tabId = sender && sender.tab && sender.tab.id;
  if (!tabId) throw new Error('TRANSLATE_STREAM requires a tab sender');

  var batchId = payload.batchId;
  var texts = payload.texts || [];
  var itemIds = payload.itemIds || [];

  var controller = new AbortController();
  var key = _bkey(tabId, batchId);
  inFlightBatches.set(key, { tabId: tabId, batchId: batchId, controller: controller });

  var resolved = await resolveProviderForRequest(payload.providerId);
  var targetLang = payload.targetLang || resolved.settings.targetLanguage;
  var pageCtx = resolved.settings.sendPageContext !== false ? payload.pageContext : null;
  var provider = withPageContext(withGlossary(resolved.provider, resolved.settings, targetLang), pageCtx);
  var cacheEnabled = payload.cacheEnabled !== false && resolved.settings.cacheEnabled !== false;
  var modelKey = cacheModelKey(provider);
  var hostname = resolveHostname(payload, resolved.settings);

  var emitPromises = [];
  function emit(itemId, text, fromCache) {
    try {
      var p = browser.tabs.sendMessage(tabId, {
        type: 'TRANSLATION_PARTIAL',
        payload: {
          batchId: batchId,
          itemId: itemId,
          text: text,
          fromCache: !!fromCache
        }
      });
      if (p && typeof p.then === 'function') emitPromises.push(p.catch(function () {}));
    } catch (e) {}
  }

  // Retry a set of pending[] indices (those that got empty translations) as one
  // batch call. Results are emitted and cached; on failure all slots emit ''.
  async function retryEmptyBatch(indices) {
    if (!indices.length) return;
    var retryTexts = indices.map(function (ri) { return pending[ri]; });
    console.warn('[MuxTranslator] retrying ' + indices.length + ' empty segment(s) as batch');
    try {
      var ro = await ProvidersModule.translateBatch(provider, retryTexts, targetLang);
      var rtrs = ro.translations || [];
      for (var ri = 0; ri < indices.length; ri++) {
        var idx = indices[ri];
        var t = rtrs[ri] || '';
        emit(pendingIds[idx], t, false);
        if (cacheEnabled && t) {
          CacheModule.set(pending[idx], targetLang, modelKey, t, hostname).catch(function () {});
        }
      }
      if (ro.usage) SettingsModule.addTokenUsage(provider.id, ro.usage).catch(function () {});
    } catch (e) {
      for (var rj = 0; rj < indices.length; rj++) emit(pendingIds[indices[rj]], '', false);
    }
  }

  // Cache phase
  var pending = [];
  var pendingIds = [];
  for (var i = 0; i < texts.length; i++) {
    var cached = null;
    if (cacheEnabled) cached = await CacheModule.get(texts[i], targetLang, modelKey, hostname);
    if (cached != null) emit(itemIds[i], cached, true);
    else { pending.push(texts[i]); pendingIds.push(itemIds[i]); }
  }

  if (pending.length === 0) {
    await Promise.all(emitPromises);
    return { success: true, data: { batchId: batchId, cacheHits: texts.length, apiCalls: 0 } };
  }

  var streamed = ProvidersModule.supportsStreaming(provider);
  var aborted = false;
  try {
    if (streamed) {
      var streamEmitted = new Set();
      await ProvidersModule.translateStream(provider, pending, targetLang, {
        onSegment: function (index, text) {
          if (index < 0 || index >= pending.length) return;
          if (text) {
            streamEmitted.add(index);
            emit(pendingIds[index], text, false);
            if (cacheEnabled) {
              CacheModule.set(pending[index], targetLang, modelKey, text, hostname).catch(function () {});
            }
          }
          // Empty text: defer for per-item retry below
        },
        onUsage: function (usage) {
          if (usage) {
            SettingsModule.addTokenUsage(provider.id, usage).catch(function () {});
            try {
              var pu = browser.tabs.sendMessage(tabId, {
                type: 'TRANSLATION_USAGE',
                payload: { batchId: batchId, usage: usage }
              });
              if (pu && typeof pu.then === 'function') emitPromises.push(pu.catch(function () {}));
            } catch (e) {}
          }
        }
      }, controller.signal);
      // Retry any items the model left empty (separator mismatch, skipped items, etc.)
      var streamRetryIdxs = [];
      for (var si = 0; si < pending.length; si++) {
        if (!streamEmitted.has(si)) streamRetryIdxs.push(si);
      }
      await retryEmptyBatch(streamRetryIdxs);
    } else {
      var out = await ProvidersModule.translateBatch(provider, pending, targetLang, controller.signal);
      var trs = out.translations || [];
      var batchEmpties = [];
      for (var m = 0; m < pending.length; m++) {
        if (trs[m]) {
          emit(pendingIds[m], trs[m], false);
          if (cacheEnabled) {
            CacheModule.set(pending[m], targetLang, modelKey, trs[m], hostname).catch(function () {});
          }
        } else {
          batchEmpties.push(m);
        }
      }
      if (out.usage) {
        SettingsModule.addTokenUsage(provider.id, out.usage).catch(function () {});
        try {
          var pu2 = browser.tabs.sendMessage(tabId, {
            type: 'TRANSLATION_USAGE',
            payload: { batchId: batchId, usage: out.usage }
          });
          if (pu2 && typeof pu2.then === 'function') emitPromises.push(pu2.catch(function () {}));
        } catch (e) {}
      }
      await retryEmptyBatch(batchEmpties);
    }
  } catch (err) {
    // AbortError: the user paused — drop the batch quietly. Content.js has
    // already re-queued its items so they'll be picked up on resume.
    if (controller.signal.aborted || (err && err.name === 'AbortError')) {
      aborted = true;
    } else {
      console.warn('[MuxTranslator] batch failed:', err && err.message);
      for (var n = 0; n < pending.length; n++) {
        emit(pendingIds[n], '', false);
      }
      try {
        browser.tabs.sendMessage(tabId, {
          type: 'TRANSLATION_ERROR',
          payload: { message: err && err.message || 'Translation failed' }
        }).catch(function () {});
      } catch (e) {}
    }
  } finally {
    inFlightBatches.delete(key);
  }

  await Promise.all(emitPromises);
  return {
    success: true,
    data: {
      batchId: batchId,
      cacheHits: texts.length - pending.length,
      apiCalls: aborted ? 0 : 1,
      streamed: streamed,
      aborted: aborted
    }
  };
}

async function handleTranslateText(payload) {
  var s = await SettingsModule.getSettings();
  var providerId = payload.providerId
    || (payload.purpose === 'selection' ? s.selectionProviderId : null)
    || (payload.purpose === 'manual' ? s.manualProviderId : null)
    || s.defaultProviderId;
  var baseProvider = SettingsModule.resolveProvider(s, providerId);
  if (!baseProvider) throw new Error('No provider available');
  var targetLang = payload.targetLang || s.targetLanguage;
  var provider = withGlossary(baseProvider, s, targetLang);
  var cacheEnabled = s.cacheEnabled !== false;
  var out = await translateOne(provider, payload.text || '', targetLang, cacheEnabled);
  return {
    success: true,
    data: {
      translated: out.text,
      fromCache: out.fromCache,
      providerId: provider.id,
      providerName: provider.name
    }
  };
}

async function handleGetModels(payload) {
  // The options page can pass a full provider (transient, not yet saved) or
  // an existing providerId.
  var provider = payload.provider;
  if (!provider && payload.providerId) {
    var s = await SettingsModule.getSettings();
    provider = SettingsModule.resolveProvider(s, payload.providerId);
  }
  if (!provider) throw new Error('No provider specified');
  var models = await ProvidersModule.fetchModels(provider);
  return { success: true, data: { models: models } };
}

async function handleGetSettings(sender) {
  var isContentScript = sender && sender.tab;
  var settings = isContentScript
    ? await SettingsModule.getPublicSettings()
    : await SettingsModule.getSettings();
  return { success: true, data: { settings: settings } };
}

async function handleSaveSettings(payload) {
  var saved = await SettingsModule.saveSettings(payload.settings || {});
  var pub = JSON.parse(JSON.stringify(saved));
  if (Array.isArray(pub.providers)) pub.providers.forEach(function (p) { p.apiKey = ''; });
  return { success: true, data: { settings: pub } };
}

async function handleClearCache() {
  var ok = await CacheModule.clear();
  return { success: true, data: { cleared: ok } };
}

async function handleGetCacheStats() {
  var stats = await CacheModule.getStats();
  return { success: true, data: stats };
}

async function handleGetCacheHostnames() {
  var hostnames = await CacheModule.getHostnames();
  return { success: true, data: { hostnames: hostnames } };
}

async function handleClearCacheByHostname(payload) {
  var hostname = payload && payload.hostname;
  if (!hostname) return { success: false, error: 'No hostname provided' };
  var ok = await CacheModule.clearByHostname(hostname);
  return { success: ok, data: { cleared: ok } };
}

async function handleResetTokenStats() {
  await SettingsModule.saveSettings({
    tokenStats: { prompt_tokens: 0, completion_tokens: 0, byProvider: {} }
  });
  return { success: true };
}

async function routeMessage(message, sender) {
  if (!message || !message.type) throw new Error('Invalid message');
  switch (message.type) {
    case 'TRANSLATE_CHUNKS':      return handleTranslateChunks(message.payload || {});
    case 'TRANSLATE_STREAM':      return handleTranslateStream(message.payload || {}, sender);
    case 'TRANSLATE_ABORT':       return handleTranslateAbort(message.payload || {}, sender);
    case 'TRANSLATE_TEXT':        return handleTranslateText(message.payload || {});
    case 'GET_MODELS':            return handleGetModels(message.payload || {});
    case 'GET_SETTINGS':          return handleGetSettings(sender);
    case 'SAVE_SETTINGS':         return handleSaveSettings(message.payload || {});
    case 'CLEAR_CACHE':               return handleClearCache();
    case 'GET_CACHE_STATS':           return handleGetCacheStats();
    case 'GET_CACHE_HOSTNAMES':       return handleGetCacheHostnames();
    case 'CLEAR_CACHE_BY_HOSTNAME':   return handleClearCacheByHostname(message.payload || {});
    case 'RESET_TOKEN_STATS':     return handleResetTokenStats();
    default: throw new Error('Unknown message type: ' + message.type);
  }
}

browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  routeMessage(message, sender)
    .then(function (response) { sendResponse(response); })
    .catch(function (err) {
      console.error('[MuxTranslator] handler error:', err);
      sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
    });
  return true;
});

browser.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    try { browser.runtime.openOptionsPage(); } catch (e) {}
  }
});
