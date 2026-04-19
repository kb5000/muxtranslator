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

// Cache keys combine providerId + model so switching providers never reuses a
// stale translation from a different model/provider.
function cacheModelKey(provider) {
  return (provider.id || 'default') + ':' + (provider.model || '');
}

// ----- Batch translation (non-streaming) ---------------------------------

async function translateOne(provider, text, targetLang, cacheEnabled) {
  var modelKey = cacheModelKey(provider);
  if (cacheEnabled) {
    var hit = await CacheModule.get(text, targetLang, modelKey);
    if (hit != null) return { text: hit, fromCache: true, usage: null };
  }
  var out = await ProvidersModule.translateBatch(provider, [text], targetLang);
  var translated = (out.translations && out.translations[0]) || '';
  if (cacheEnabled && translated) {
    CacheModule.set(text, targetLang, modelKey, translated).catch(function () {});
  }
  if (out.usage) {
    SettingsModule.addTokenUsage(provider.id, out.usage).catch(function () {});
  }
  return { text: translated, fromCache: false, usage: out.usage };
}

async function translateBatch(provider, texts, targetLang, cacheEnabled) {
  if (!texts || !texts.length) return { translations: [], cacheHits: 0 };
  var modelKey = cacheModelKey(provider);
  var results = new Array(texts.length);
  var pending = [];
  var pendingIdx = [];
  var cacheHits = 0;

  for (var i = 0; i < texts.length; i++) {
    if (cacheEnabled) {
      var cached = await CacheModule.get(texts[i], targetLang, modelKey);
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
        CacheModule.set(pending[j], targetLang, modelKey, translated).catch(function () {});
      }
    }
    if (out.usage) SettingsModule.addTokenUsage(provider.id, out.usage).catch(function () {});
  } catch (err) {
    console.warn('[MuxTranslator] batch translate failed, per-item fallback:', err.message);
    for (var k = 0; k < pending.length; k++) {
      try {
        var one = await translateOne(provider, pending[k], targetLang, cacheEnabled);
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
  var provider = resolved.provider;
  var targetLang = payload.targetLang || resolved.settings.targetLanguage;
  var cacheEnabled = payload.cacheEnabled !== false && resolved.settings.cacheEnabled !== false;
  var result = await translateBatch(provider, payload.texts || [], targetLang, cacheEnabled);
  return { success: true, data: result };
}

async function handleTranslateStream(payload, sender) {
  var tabId = sender && sender.tab && sender.tab.id;
  if (!tabId) throw new Error('TRANSLATE_STREAM requires a tab sender');

  var batchId = payload.batchId;
  var texts = payload.texts || [];
  var itemIds = payload.itemIds || [];

  var resolved = await resolveProviderForRequest(payload.providerId);
  var provider = resolved.provider;
  var targetLang = payload.targetLang || resolved.settings.targetLanguage;
  var cacheEnabled = payload.cacheEnabled !== false && resolved.settings.cacheEnabled !== false;
  var modelKey = cacheModelKey(provider);

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

  // Cache phase
  var pending = [];
  var pendingIds = [];
  for (var i = 0; i < texts.length; i++) {
    var cached = null;
    if (cacheEnabled) cached = await CacheModule.get(texts[i], targetLang, modelKey);
    if (cached != null) emit(itemIds[i], cached, true);
    else { pending.push(texts[i]); pendingIds.push(itemIds[i]); }
  }

  if (pending.length === 0) {
    await Promise.all(emitPromises);
    return { success: true, data: { batchId: batchId, cacheHits: texts.length, apiCalls: 0 } };
  }

  var streamed = ProvidersModule.supportsStreaming(provider);
  try {
    if (streamed) {
      await ProvidersModule.translateStream(provider, pending, targetLang, {
        onSegment: function (index, text) {
          if (index < 0 || index >= pending.length) return;
          emit(pendingIds[index], text, false);
          if (cacheEnabled && text) {
            CacheModule.set(pending[index], targetLang, modelKey, text).catch(function () {});
          }
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
      });
    } else {
      var out = await ProvidersModule.translateBatch(provider, pending, targetLang);
      var trs = out.translations || [];
      for (var m = 0; m < pending.length; m++) {
        emit(pendingIds[m], trs[m] || '', false);
        if (cacheEnabled && trs[m]) {
          CacheModule.set(pending[m], targetLang, modelKey, trs[m]).catch(function () {});
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
    }
  } catch (err) {
    // Batch failed. Emit empty translations so content.js cleans up the
    // items and stops waiting. Do NOT fan out to per-item translateOne —
    // that ignores the user's pause state, fires one API call per item,
    // and rarely succeeds when the whole-batch call just failed.
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

  await Promise.all(emitPromises);
  return {
    success: true,
    data: { batchId: batchId, cacheHits: texts.length - pending.length, apiCalls: 1, streamed: streamed }
  };
}

async function handleTranslateText(payload) {
  var s = await SettingsModule.getSettings();
  var providerId = payload.providerId
    || (payload.purpose === 'selection' ? s.selectionProviderId : null)
    || (payload.purpose === 'manual' ? s.manualProviderId : null)
    || s.defaultProviderId;
  var provider = SettingsModule.resolveProvider(s, providerId);
  if (!provider) throw new Error('No provider available');
  var targetLang = payload.targetLang || s.targetLanguage;
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
    case 'TRANSLATE_TEXT':        return handleTranslateText(message.payload || {});
    case 'GET_MODELS':            return handleGetModels(message.payload || {});
    case 'GET_SETTINGS':          return handleGetSettings(sender);
    case 'SAVE_SETTINGS':         return handleSaveSettings(message.payload || {});
    case 'CLEAR_CACHE':           return handleClearCache();
    case 'GET_CACHE_STATS':       return handleGetCacheStats();
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
