var SettingsModule = SettingsModule || {};
(function (ns) {
  'use strict';

  ns.STORAGE_KEY = 'settings';
  ns.SCHEMA_VERSION = 2;

  // Prompt defaults — copied into every newly-created LLM provider. Users can
  // edit them per-provider afterwards.
  ns.DEFAULT_SYSTEM_PROMPT =
    "You are a professional translator. Translate the user's text accurately and naturally into the target language, preserving the original formatting, punctuation, and line breaks. If the input contains the exact token '<<<SEP>>>' between segments, you MUST keep that token unchanged in the same positions of your output, translating only the text between tokens. Do not add any explanations, quotes, or extra commentary — output the translation only.";

  ns.DEFAULT_USER_TEMPLATE =
    'Translate the following text to {target_lang}. Preserve any <<<SEP>>> tokens exactly as-is.\n\n{text}';

  ns.PROVIDER_TYPES = ['openai-compatible', 'ollama', 'google-translate', 'deepl', 'libretranslate'];

  ns.DEFAULT_PROVIDER = function () {
    return {
      id: 'default',
      name: 'Default',
      type: 'openai-compatible',
      baseURL: 'https://api.openai.com',
      apiKey: '',
      model: 'gpt-4o-mini',
      systemPrompt: ns.DEFAULT_SYSTEM_PROMPT,
      userPromptTemplate: ns.DEFAULT_USER_TEMPLATE,
      streamingEnabled: true,
      // 'text'      — plain content, segments joined by <<<SEP>>>
      // 'tool-call' — OpenAI tool-calling; model returns JSON array
      outputMode: 'text'
    };
  };

  ns.NEW_PROVIDER = function (type) {
    var t = type || 'openai-compatible';
    var isLLM = t === 'openai-compatible' || t === 'ollama';
    var base = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: t === 'ollama' ? 'Ollama'
          : t === 'google-translate' ? 'Google Translate'
          : t === 'deepl' ? 'DeepL'
          : t === 'libretranslate' ? 'LibreTranslate'
          : 'New Provider',
      type: t,
      baseURL: t === 'ollama' ? 'http://localhost:11434'
             : t === 'google-translate' ? 'https://translation.googleapis.com'
             : t === 'libretranslate' ? 'https://libretranslate.com'
             : t === 'deepl' ? ''
             : 'https://api.openai.com',
      apiKey: '',
      model: isLLM ? (t === 'ollama' ? 'llama3' : 'gpt-4o-mini') : '',
      streamingEnabled: isLLM,
      systemPrompt: isLLM ? ns.DEFAULT_SYSTEM_PROMPT : '',
      userPromptTemplate: isLLM ? ns.DEFAULT_USER_TEMPLATE : '',
      outputMode: 'text',
      endpoint: t === 'deepl' ? 'free' : undefined
    };
    return base;
  };

  ns.DEFAULT_SETTINGS = {
    schemaVersion: ns.SCHEMA_VERSION,
    providers: [ns.DEFAULT_PROVIDER()],
    defaultProviderId: 'default',
    selectionProviderId: null,   // null => use default
    manualProviderId: null,       // null => use default

    siteRules: {},                // hostname -> { mode: 'skip'|'always', providerId?: string }

    tokenStats: {
      prompt_tokens: 0,
      completion_tokens: 0,
      byProvider: {}              // providerId -> { prompt_tokens, completion_tokens, calls }
    },

    targetLanguage: 'zh-CN',
    skipLanguages: ['zh', 'zh-CN', 'zh-TW'],
    cacheEnabled: true,
    maxCharsPerBatch: 3000,       // raised from 1500 per user request
    concurrentBatches: 2,

    observeMutations: true,
    viewportPriority: true,

    selectionEnabled: true,       // show selection badge on text select
    showProgressBar: true,        // show bottom-right progress widget during translation
    uiLanguage: '',               // '' = auto (browser locale); 'en', 'zh_CN', etc.

    // 'ask' = show bar each time, 'auto' = auto-translate, 'never' = no bar/auto
    defaultTranslationMode: 'ask',
    // 'off' = translation only, 'embed' = show original below, 'tooltip' = hover tooltip
    bilingualMode: 'off',

    // Array of { id, source, target, lang } — lang='' means all target languages
    glossary: []
  };

  function getStorage() {
    if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
      return browser.storage.local;
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return {
        get: function (keys) {
          return new Promise(function (resolve, reject) {
            chrome.storage.local.get(keys, function (result) {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(result);
            });
          });
        },
        set: function (items) {
          return new Promise(function (resolve, reject) {
            chrome.storage.local.set(items, function () {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve();
            });
          });
        }
      };
    }
    throw new Error('No storage API available');
  }

  // Migrate v1 flat-config into v2 providers[] shape.
  function migrate(saved) {
    if (!saved || typeof saved !== 'object') return {};
    if (saved.schemaVersion >= 2 && Array.isArray(saved.providers)) return saved;

    // v1 detected (has apiKey/baseURL/model at root). Convert to one provider.
    var hasV1 = saved.apiKey !== undefined || saved.baseURL !== undefined || saved.model !== undefined;
    if (!hasV1) return saved;

    var provider = {
      id: 'default',
      name: 'Default',
      type: 'openai-compatible',
      baseURL: saved.baseURL || 'https://api.openai.com',
      apiKey: saved.apiKey || '',
      model: saved.model || 'gpt-4o-mini',
      systemPrompt: saved.systemPrompt || ns.DEFAULT_SYSTEM_PROMPT,
      userPromptTemplate: saved.userPromptTemplate || ns.DEFAULT_USER_TEMPLATE,
      streamingEnabled: saved.streamingEnabled !== false
    };

    var migrated = {
      schemaVersion: 2,
      providers: [provider],
      defaultProviderId: 'default',
      selectionProviderId: null,
      manualProviderId: null,
      siteRules: {},
      tokenStats: { prompt_tokens: 0, completion_tokens: 0, byProvider: {} },
      targetLanguage: saved.targetLanguage || 'zh-CN',
      skipLanguages: saved.skipLanguages || ['zh', 'zh-CN', 'zh-TW'],
      cacheEnabled: saved.cacheEnabled !== false,
      maxCharsPerBatch: saved.maxCharsPerBatch || 3000,
      concurrentBatches: saved.concurrentBatches || 2,
      observeMutations: saved.observeMutations !== false,
      viewportPriority: saved.viewportPriority !== false,
      selectionEnabled: saved.selectionEnabled !== false
    };
    return migrated;
  }

  ns.getSettings = async function () {
    try {
      var storage = getStorage();
      var result = await storage.get(ns.STORAGE_KEY);
      var saved = result && result[ns.STORAGE_KEY] ? result[ns.STORAGE_KEY] : {};
      var migrated = migrate(saved);
      var merged = Object.assign({}, ns.DEFAULT_SETTINGS, migrated);
      if (!Array.isArray(merged.providers) || merged.providers.length === 0) {
        merged.providers = [ns.DEFAULT_PROVIDER()];
        merged.defaultProviderId = 'default';
      }
      if (!Array.isArray(merged.skipLanguages)) {
        merged.skipLanguages = ns.DEFAULT_SETTINGS.skipLanguages.slice();
      }
      if (!merged.siteRules || typeof merged.siteRules !== 'object') merged.siteRules = {};
      if (!merged.tokenStats || typeof merged.tokenStats !== 'object') {
        merged.tokenStats = { prompt_tokens: 0, completion_tokens: 0, byProvider: {} };
      }
      return merged;
    } catch (e) {
      console.error('[MuxTranslator] getSettings failed:', e);
      return Object.assign({}, ns.DEFAULT_SETTINGS);
    }
  };

  ns.saveSettings = async function (partial) {
    var storage = getStorage();
    var current = await ns.getSettings();
    var next = Object.assign({}, current, partial || {});
    next.schemaVersion = ns.SCHEMA_VERSION;
    var payload = {};
    payload[ns.STORAGE_KEY] = next;
    await storage.set(payload);
    return next;
  };

  ns.getSetting = async function (key) {
    var s = await ns.getSettings();
    return s[key];
  };

  // Returns settings safe to send to content scripts (apiKeys stripped).
  ns.getPublicSettings = async function () {
    var s = await ns.getSettings();
    var pub = JSON.parse(JSON.stringify(s));
    if (Array.isArray(pub.providers)) {
      pub.providers.forEach(function (p) { p.apiKey = ''; });
    }
    return pub;
  };

  // Find a provider by id, falling back to defaultProviderId, then first.
  ns.resolveProvider = function (settings, providerId) {
    if (!settings || !Array.isArray(settings.providers)) return null;
    var id = providerId || settings.defaultProviderId;
    var found = null;
    for (var i = 0; i < settings.providers.length; i++) {
      if (settings.providers[i].id === id) { found = settings.providers[i]; break; }
    }
    return found || settings.providers[0] || null;
  };

  // Resolve site rule for a given hostname. Walks parents ("a.b.example.com"
  // also matches a rule keyed "example.com").
  ns.resolveSiteRule = function (settings, hostname) {
    if (!settings || !settings.siteRules || !hostname) return null;
    var host = String(hostname).toLowerCase();
    if (settings.siteRules[host]) return settings.siteRules[host];
    var parts = host.split('.');
    for (var i = 1; i < parts.length - 1; i++) {
      var parent = parts.slice(i).join('.');
      if (settings.siteRules[parent]) return settings.siteRules[parent];
    }
    return null;
  };

  ns.addTokenUsage = async function (providerId, usage) {
    if (!usage) return;
    var s = await ns.getSettings();
    var stats = s.tokenStats || { prompt_tokens: 0, completion_tokens: 0, byProvider: {} };
    stats.prompt_tokens = (stats.prompt_tokens || 0) + (usage.prompt_tokens || 0);
    stats.completion_tokens = (stats.completion_tokens || 0) + (usage.completion_tokens || 0);
    var per = stats.byProvider[providerId] || { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
    per.prompt_tokens += usage.prompt_tokens || 0;
    per.completion_tokens += usage.completion_tokens || 0;
    per.calls += 1;
    stats.byProvider[providerId] = per;
    await ns.saveSettings({ tokenStats: stats });
  };
})(SettingsModule);
