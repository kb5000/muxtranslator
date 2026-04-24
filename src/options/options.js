(function () {
  'use strict';

  if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
    window.browser = chrome;
  }

  var els = {};
  var state = {
    settings: null,
    openProviderIds: new Set()   // which provider cards are expanded
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
    if (msg) {
      clearTimeout(setStatus._t);
      setStatus._t = setTimeout(function () {
        els.status.textContent = '';
        els.status.className = 'status';
      }, 3000);
    }
  }

  async function init() {
    await i18nInit();

    [
      'addProviderBtn', 'newProviderType', 'providerList',
      'defaultProviderId', 'selectionProviderId', 'manualProviderId', 'pdfProviderId', 'selectionEnabled',
      'editGlossaryBtn', 'glossaryDialog', 'glossaryEntryList',
      'glossarySource', 'glossaryTarget', 'glossaryLang', 'addGlossaryEntryBtn', 'glossaryClose',
      'glossarySummary',
      'addSiteRuleBtn', 'siteRulesList',
      'uiLanguage', 'targetLanguage', 'skipLanguages', 'autoDetect',
      'defaultTranslationMode', 'bilingualMode',
      'observeMutations', 'viewportPriority', 'showProgressBar', 'maxCharsPerBatch', 'concurrentBatches',
      'cacheEnabled', 'clearCacheBtn', 'cacheStats',
      'pdfDevMode',
      'tokenStats', 'resetTokensBtn',
      'saveBtn', 'status',
      'siteRuleDialog', 'srHostname', 'srMode', 'srProviderId', 'srProviderRow', 'srCancel', 'srOK'
    ].forEach(function (id) { els[id] = $(id); });

    if (els.saveBtn) els.saveBtn.addEventListener('click', function () { autoSave(true); });
    els.addProviderBtn.addEventListener('click', onAddProvider);
    els.editGlossaryBtn.addEventListener('click', openGlossaryDialog);
    els.glossaryClose.addEventListener('click', function () { els.glossaryDialog.close(); });
    els.addGlossaryEntryBtn.addEventListener('click', addGlossaryEntry);
    els.clearCacheBtn.addEventListener('click', clearCache);
    els.resetTokensBtn.addEventListener('click', resetTokens);
    els.addSiteRuleBtn.addEventListener('click', openSiteRuleDialog);
    els.srCancel.addEventListener('click', function () { els.siteRuleDialog.close(); });
    els.srOK.addEventListener('click', confirmSiteRule);
    els.srMode.addEventListener('change', function () {
      els.srProviderRow.style.display = els.srMode.value === 'always' ? '' : 'none';
    });

    // UI language: save immediately then reload so the new locale takes effect.
    els.uiLanguage.addEventListener('change', async function () {
      state.settings.uiLanguage = els.uiLanguage.value;
      try {
        await SettingsModule.saveSettings(state.settings);
      } catch (e) { /* best-effort */ }
      window.location.reload();
    });

    // Auto-save: any change to a scalar input triggers a debounced save.
    [
      'targetLanguage', 'skipLanguages',
      'defaultTranslationMode', 'bilingualMode',
      'observeMutations', 'viewportPriority', 'showProgressBar',
      'maxCharsPerBatch', 'concurrentBatches', 'cacheEnabled',
      'defaultProviderId', 'selectionProviderId', 'manualProviderId', 'pdfProviderId',
      'selectionEnabled'
    ].forEach(function (id) {
      var el = els[id];
      if (!el) return;
      var evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(evt, function () { autoSave(); });
    });

    state.settings = await SettingsModule.getSettings();
    render();
  }

  // ----- Auto-save -------------------------------------------------------

  var saveTimer = null;
  function autoSave(immediate) {
    clearTimeout(saveTimer);
    if (immediate) { commit(); return; }
    saveTimer = setTimeout(commit, 400);
  }

  async function commit() {
    state.settings.uiLanguage = els.uiLanguage.value;
    state.settings.targetLanguage = els.targetLanguage.value.trim();
    state.settings.skipLanguages = els.skipLanguages.value
      .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    state.settings.defaultTranslationMode = els.defaultTranslationMode.value;
    state.settings.bilingualMode = els.bilingualMode.value;
    state.settings.observeMutations = els.observeMutations.checked;
    state.settings.viewportPriority = els.viewportPriority.checked;
    state.settings.showProgressBar = els.showProgressBar.checked;
    state.settings.maxCharsPerBatch = Math.max(200, Math.min(16000,
      parseInt(els.maxCharsPerBatch.value, 10) || 3000));
    state.settings.concurrentBatches = Math.max(1, Math.min(8,
      parseInt(els.concurrentBatches.value, 10) || 2));
    state.settings.cacheEnabled  = els.cacheEnabled.checked;
    state.settings.pdfDevMode    = !!(els.pdfDevMode && els.pdfDevMode.checked);

    state.settings.defaultProviderId = els.defaultProviderId.value;
    state.settings.selectionProviderId = els.selectionProviderId.value || null;
    state.settings.manualProviderId = els.manualProviderId.value || null;
    state.settings.pdfProviderId = els.pdfProviderId.value || null;
    state.settings.selectionEnabled = els.selectionEnabled.checked;

    try {
      await SettingsModule.saveSettings(state.settings);
      setStatus(i18n('statusSaved'), 'success');
    } catch (e) {
      setStatus(i18n('statusSaveFailed', [e.message]), 'error');
    }
  }

  function render() {
    renderProviders();
    renderBindings();
    renderGlossarySummary();
    renderSiteRules();
    renderScalars();
    renderCacheStats();
    renderTokenStats();
  }

  // ----- Providers -------------------------------------------------------

  function renderProviders() {
    var list = els.providerList;
    list.innerHTML = '';
    (state.settings.providers || []).forEach(function (p) {
      list.appendChild(buildProviderCard(p));
    });
  }

  function buildProviderCard(p) {
    var card = document.createElement('div');
    card.className = 'provider-card' + (state.openProviderIds.has(p.id) ? ' open' : '');

    var header = document.createElement('div');
    header.className = 'provider-header';
    header.innerHTML =
      '<div class="provider-title">' +
      '  <span class="name"></span>' +
      '  <span class="type"></span>' +
      '  <span class="badge"></span>' +
      '</div>' +
      '<div class="provider-actions">' +
      '  <button type="button" class="del danger"></button>' +
      '  <button type="button" class="toggle"></button>' +
      '</div>';
    header.querySelector('.name').textContent = p.name || i18n('labelUnnamed');
    header.querySelector('.type').textContent = shortType(p.type);
    header.querySelector('.badge').textContent =
      (p.id === state.settings.defaultProviderId ? i18n('badgeDefault') : '');
    header.querySelector('.del').textContent = i18n('btnDelete');
    header.querySelector('.toggle').textContent = state.openProviderIds.has(p.id) ? i18n('btnCollapse') : i18n('btnEdit');
    header.querySelector('.toggle').addEventListener('click', function () {
      if (state.openProviderIds.has(p.id)) state.openProviderIds.delete(p.id);
      else state.openProviderIds.add(p.id);
      renderProviders();
    });
    header.querySelector('.del').addEventListener('click', function () {
      onDeleteProvider(p.id);
    });

    card.appendChild(header);

    if (state.openProviderIds.has(p.id)) {
      card.appendChild(buildProviderBody(p));
    }
    return card;
  }

  function buildProviderBody(p) {
    var body = document.createElement('div');
    body.className = 'provider-body';

    // Name
    body.appendChild(textField(i18n('labelName'), 'text', p.name || '',
      function (v) { p.name = v; renderProviders(); }));

    // DeepL plan selector (free / paid)
    if (p.type === 'deepl') {
      var epWrap = document.createElement('label');
      epWrap.textContent = i18n('labelDeepLPlan');
      var epSel = document.createElement('select');
      var optFree = document.createElement('option');
      optFree.value = 'free'; optFree.textContent = i18n('deepLPlanFree');
      var optPaid = document.createElement('option');
      optPaid.value = 'paid'; optPaid.textContent = i18n('deepLPlanPaid');
      epSel.appendChild(optFree);
      epSel.appendChild(optPaid);
      epSel.value = p.endpoint || 'free';
      epSel.addEventListener('change', function () { p.endpoint = epSel.value; autoSave(); });
      epWrap.appendChild(epSel);
      body.appendChild(epWrap);
    }

    // Base URL
    var baseURLLabel = (p.type === 'google-translate' || p.type === 'deepl')
      ? i18n('labelBaseURLProxy') : i18n('labelBaseURL');
    body.appendChild(textField(baseURLLabel, 'text', p.baseURL || '', function (v) { p.baseURL = v.trim(); }));

    // API key
    var apiKeyLabel = p.type === 'google-translate' ? i18n('labelApiKeyGoogle')
                    : p.type === 'libretranslate' ? i18n('labelApiKeyOptional')
                    : i18n('labelApiKey');
    body.appendChild(textField(apiKeyLabel, 'password', p.apiKey || '', function (v) { p.apiKey = v; }));

    // Model picker with Fetch button (not shown for non-LLM providers)
    if (p.type === 'deepl' || p.type === 'libretranslate') {
      return body;
    }
    var modelWrap = document.createElement('div');
    modelWrap.appendChild(labelFor(i18n('labelModel')));
    var row = document.createElement('div');
    row.className = 'row';
    var selectEl = document.createElement('select');
    selectEl.className = 'flex';
    var currentOpt = document.createElement('option');
    currentOpt.value = p.model || '';
    currentOpt.textContent = p.model || i18n('labelNotSet');
    selectEl.appendChild(currentOpt);
    selectEl.value = p.model || '';
    var fetchBtn = document.createElement('button');
    fetchBtn.type = 'button';
    fetchBtn.textContent = i18n('btnFetch');
    row.appendChild(selectEl);
    row.appendChild(fetchBtn);
    modelWrap.appendChild(row);

    var manualInput = document.createElement('input');
    manualInput.type = 'text';
    manualInput.placeholder = i18n('placeholderModelId');
    manualInput.spellcheck = false;
    modelWrap.appendChild(manualInput);

    selectEl.addEventListener('change', function () {
      p.model = selectEl.value;
      manualInput.value = '';
      autoSave();
    });
    manualInput.addEventListener('change', function () {
      if (manualInput.value.trim()) { p.model = manualInput.value.trim(); autoSave(); }
    });
    fetchBtn.addEventListener('click', async function () {
      fetchBtn.disabled = true;
      setStatus(i18n('statusFetchingModels', [p.name]));
      try {
        var res = await browser.runtime.sendMessage({
          type: 'GET_MODELS',
          payload: { provider: sanitizeForTransit(p) }
        });
        if (!res || !res.success) throw new Error((res && res.error) || 'Unknown error');
        var models = res.data.models || [];
        if (!models.length) {
          setStatus(i18n('errorNoModels'), 'error');
          return;
        }
        var prev = p.model;
        selectEl.innerHTML = '';
        if (prev && models.indexOf(prev) === -1) {
          var savedOpt = document.createElement('option');
          savedOpt.value = prev;
          savedOpt.textContent = prev + i18n('suffixSaved');
          selectEl.appendChild(savedOpt);
        }
        models.forEach(function (m) {
          var o = document.createElement('option');
          o.value = m; o.textContent = m;
          selectEl.appendChild(o);
        });
        if (prev) selectEl.value = prev;
        setStatus(i18n('statusLoadedModels', [String(models.length)]), 'success');
      } catch (err) {
        setStatus(i18n('errorFetchFailed', [err.message]), 'error');
      } finally {
        fetchBtn.disabled = false;
      }
    });

    body.appendChild(modelWrap);

    // Output mode (OpenAI-compatible only)
    if (p.type === 'openai-compatible') {
      var modeWrap = document.createElement('label');
      modeWrap.textContent = i18n('labelOutputMode');
      var modeSel = document.createElement('select');
      var optText = document.createElement('option');
      optText.value = 'text';
      optText.textContent = i18n('outputModeText');
      var optTool = document.createElement('option');
      optTool.value = 'tool-call';
      optTool.textContent = i18n('outputModeTool');
      modeSel.appendChild(optText);
      modeSel.appendChild(optTool);
      modeSel.value = p.outputMode === 'tool-call' ? 'tool-call' : 'text';
      modeSel.addEventListener('change', function () { p.outputMode = modeSel.value; autoSave(); });
      modeWrap.appendChild(modeSel);
      var modeHint = document.createElement('span');
      modeHint.className = 'hint';
      modeHint.textContent = i18n('hintToolMode');
      modeWrap.appendChild(modeHint);
      body.appendChild(modeWrap);
    }

    // Streaming toggle
    if (p.type !== 'google-translate') {
      var streamLabel = document.createElement('label');
      streamLabel.className = 'inline';
      var streamCB = document.createElement('input');
      streamCB.type = 'checkbox';
      streamCB.checked = p.streamingEnabled !== false;
      streamCB.addEventListener('change', function () { p.streamingEnabled = streamCB.checked; autoSave(); });
      var streamSpan = document.createElement('span');
      streamSpan.textContent = i18n('labelStreamingEnabled');
      streamLabel.appendChild(streamCB);
      streamLabel.appendChild(streamSpan);
      body.appendChild(streamLabel);
    }

    // Prompts (only for LLM providers)
    if (p.type === 'openai-compatible' || p.type === 'ollama') {
      body.appendChild(textareaField(i18n('labelSystemPrompt'), p.systemPrompt || '', 4,
        function (v) { p.systemPrompt = v; }));
      body.appendChild(textareaField(i18n('labelUserPromptTemplate'),
        p.userPromptTemplate || '', 3,
        function (v) { p.userPromptTemplate = v; }));
    }

    return body;
  }

  function labelFor(text) {
    var span = document.createElement('div');
    span.style.fontSize = '13px';
    span.style.fontWeight = '500';
    span.style.marginBottom = '4px';
    span.textContent = text;
    return span;
  }

  function textField(labelText, type, value, onChange) {
    var label = document.createElement('label');
    label.textContent = labelText;
    var input = document.createElement('input');
    input.type = type;
    input.value = value;
    input.spellcheck = false;
    if (type === 'password') input.autocomplete = 'off';
    input.addEventListener('input', function () { onChange(input.value); autoSave(); });
    label.appendChild(input);
    return label;
  }

  function textareaField(labelText, value, rows, onChange) {
    var label = document.createElement('label');
    label.textContent = labelText;
    var ta = document.createElement('textarea');
    ta.rows = rows;
    ta.value = value;
    ta.spellcheck = false;
    ta.addEventListener('input', function () { onChange(ta.value); autoSave(); });
    label.appendChild(ta);
    return label;
  }

  function sanitizeForTransit(p) {
    return {
      id: p.id, name: p.name, type: p.type,
      baseURL: p.baseURL, apiKey: p.apiKey, model: p.model,
      systemPrompt: p.systemPrompt, userPromptTemplate: p.userPromptTemplate,
      streamingEnabled: p.streamingEnabled,
      outputMode: p.outputMode,
      endpoint: p.endpoint
    };
  }

  function onAddProvider() {
    var type = els.newProviderType.value;
    var provider = SettingsModule.NEW_PROVIDER(type);
    var ids = (state.settings.providers || []).map(function (p) { return p.id; });
    while (ids.indexOf(provider.id) !== -1) provider.id = 'p' + Math.random().toString(36).slice(2, 8);
    state.settings.providers = (state.settings.providers || []).concat([provider]);
    state.openProviderIds.add(provider.id);
    render();
    autoSave(true);
  }

  function onDeleteProvider(id) {
    if ((state.settings.providers || []).length <= 1) {
      setStatus(i18n('errorCannotDeleteLast'), 'error');
      return;
    }
    if (!confirm(i18n('confirmDeleteProvider'))) return;
    state.settings.providers = state.settings.providers.filter(function (p) { return p.id !== id; });
    if (state.settings.defaultProviderId === id) {
      state.settings.defaultProviderId = state.settings.providers[0].id;
    }
    if (state.settings.selectionProviderId === id) state.settings.selectionProviderId = null;
    if (state.settings.manualProviderId === id) state.settings.manualProviderId = null;
    if (state.settings.pdfProviderId === id) state.settings.pdfProviderId = null;
    var rules = state.settings.siteRules || {};
    Object.keys(rules).forEach(function (host) {
      if (rules[host].providerId === id) delete rules[host];
    });
    state.settings.siteRules = rules;
    state.openProviderIds.delete(id);
    render();
    autoSave(true);
  }

  function shortType(type) {
    if (type === 'openai-compatible') return i18n('typeOpenAI');
    if (type === 'ollama') return i18n('typeOllama');
    if (type === 'google-translate') return i18n('typeGoogle');
    if (type === 'deepl') return i18n('typeDeepL');
    if (type === 'libretranslate') return i18n('typeLibreTranslate');
    return type;
  }

  // ----- Bindings --------------------------------------------------------

  function renderBindings() {
    var providers = state.settings.providers || [];
    function fill(selectEl, currentId, includeEmpty) {
      selectEl.innerHTML = '';
      if (includeEmpty) {
        var emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = i18n('labelUseDefault');
        selectEl.appendChild(emptyOpt);
      }
      providers.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + ' (' + shortType(p.type) + ')';
        selectEl.appendChild(opt);
      });
      selectEl.value = currentId || '';
    }
    fill(els.defaultProviderId, state.settings.defaultProviderId, false);
    fill(els.selectionProviderId, state.settings.selectionProviderId || '', true);
    fill(els.manualProviderId, state.settings.manualProviderId || '', true);
    fill(els.pdfProviderId, state.settings.pdfProviderId || '', true);
    els.selectionEnabled.checked = state.settings.selectionEnabled !== false;
  }

  // ----- Glossary --------------------------------------------------------

  function renderGlossarySummary() {
    var entries = state.settings.glossary || [];
    els.glossarySummary.textContent = entries.length
      ? i18n('glossaryCount', [String(entries.length)])
      : i18n('glossaryNone');
  }

  function openGlossaryDialog() {
    els.glossaryDialog.classList.add('glossary-dialog');
    els.glossarySource.placeholder = i18n('placeholderGlossarySource');
    els.glossaryTarget.placeholder = i18n('placeholderGlossaryTarget');
    els.glossaryLang.placeholder = i18n('placeholderGlossaryLang');
    renderGlossaryDialog();
    if (typeof els.glossaryDialog.showModal === 'function') {
      els.glossaryDialog.showModal();
    } else {
      els.glossaryDialog.setAttribute('open', '');
    }
  }

  function renderGlossaryDialog() {
    var list = els.glossaryEntryList;
    list.innerHTML = '';
    var entries = state.settings.glossary || [];
    if (!entries.length) {
      list.innerHTML = '<div class="hint">' + escapeHtml(i18n('glossaryEmpty')) + '</div>';
      return;
    }
    entries.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'glossary-row';

      var src = document.createElement('span');
      src.className = 'g-source';
      src.textContent = entry.source;

      var arrow = document.createElement('span');
      arrow.className = 'g-arrow';
      arrow.textContent = '→';

      var tgt = document.createElement('span');
      tgt.className = 'g-target';
      tgt.textContent = entry.target;

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger';
      delBtn.textContent = i18n('btnDelete');
      delBtn.addEventListener('click', function () {
        state.settings.glossary = (state.settings.glossary || []).filter(function (e) {
          return e.id !== entry.id;
        });
        renderGlossaryDialog();
        renderGlossarySummary();
        autoSave(true);
      });

      row.appendChild(src);
      row.appendChild(arrow);
      row.appendChild(tgt);
      if (entry.lang) {
        var langBadge = document.createElement('span');
        langBadge.className = 'g-lang';
        langBadge.textContent = entry.lang;
        row.appendChild(langBadge);
      }
      row.appendChild(delBtn);
      list.appendChild(row);
    });
  }

  function addGlossaryEntry() {
    var source = els.glossarySource.value.trim();
    var target = els.glossaryTarget.value.trim();
    if (!source || !target) return;
    var lang = els.glossaryLang.value.trim();
    var entry = {
      id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      source: source,
      target: target,
      lang: lang
    };
    state.settings.glossary = (state.settings.glossary || []).concat([entry]);
    els.glossarySource.value = '';
    els.glossaryTarget.value = '';
    els.glossaryLang.value = '';
    els.glossarySource.focus();
    renderGlossaryDialog();
    renderGlossarySummary();
    autoSave(true);
  }

  // ----- Site rules ------------------------------------------------------

  function renderSiteRules() {
    var list = els.siteRulesList;
    list.innerHTML = '';
    var rules = state.settings.siteRules || {};
    var hosts = Object.keys(rules).sort();
    if (!hosts.length) {
      list.innerHTML = '<div class="hint">' + escapeHtml(i18n('siteRuleNone')) + '</div>';
      return;
    }
    hosts.forEach(function (host) {
      var rule = rules[host];
      var row = document.createElement('div');
      row.className = 'rule-row';
      row.innerHTML =
        '<span class="host"></span>' +
        '<span class="mode"></span>' +
        '<button type="button" class="del danger"></button>';
      row.querySelector('.host').textContent = host;
      var modeText = rule.mode === 'skip'
        ? i18n('modeAlwaysSkip')
        : i18n('siteRuleModeAlwaysWith', [describeProvider(rule.providerId)]);
      row.querySelector('.mode').textContent = modeText;
      row.querySelector('.del').textContent = i18n('btnDelete');
      row.querySelector('.del').addEventListener('click', function () {
        delete state.settings.siteRules[host];
        renderSiteRules();
        autoSave(true);
      });
      list.appendChild(row);
    });
  }

  function describeProvider(id) {
    var p = (state.settings.providers || []).find(function (p) { return p.id === id; });
    return p ? p.name : (id || '?');
  }

  function openSiteRuleDialog() {
    els.srHostname.value = '';
    els.srMode.value = 'skip';
    els.srProviderRow.style.display = 'none';
    els.srProviderId.innerHTML = '';
    (state.settings.providers || []).forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      els.srProviderId.appendChild(opt);
    });
    if (typeof els.siteRuleDialog.showModal === 'function') {
      els.siteRuleDialog.showModal();
    } else {
      els.siteRuleDialog.setAttribute('open', '');
    }
  }

  function confirmSiteRule() {
    var host = els.srHostname.value.trim().toLowerCase();
    if (!host) return;
    var mode = els.srMode.value;
    var rule = { mode: mode };
    if (mode === 'always') rule.providerId = els.srProviderId.value;
    state.settings.siteRules = state.settings.siteRules || {};
    state.settings.siteRules[host] = rule;
    els.siteRuleDialog.close();
    renderSiteRules();
    autoSave(true);
  }

  // ----- Scalars ---------------------------------------------------------

  function renderScalars() {
    var s = state.settings;
    els.uiLanguage.value = s.uiLanguage || '';
    els.targetLanguage.value = s.targetLanguage || '';
    els.skipLanguages.value = (s.skipLanguages || []).join(', ');
    els.defaultTranslationMode.value = s.defaultTranslationMode || 'ask';
    els.bilingualMode.value = s.bilingualMode || 'off';
    els.observeMutations.checked = s.observeMutations !== false;
    els.viewportPriority.checked = s.viewportPriority !== false;
    els.showProgressBar.checked = s.showProgressBar !== false;
    els.maxCharsPerBatch.value = s.maxCharsPerBatch || 3000;
    els.concurrentBatches.value = s.concurrentBatches || 2;
    els.cacheEnabled.checked = s.cacheEnabled !== false;
    if (els.pdfDevMode) els.pdfDevMode.checked = !!s.pdfDevMode;
  }

  // ----- Cache & token stats --------------------------------------------

  async function renderCacheStats() {
    try {
      var res = await browser.runtime.sendMessage({ type: 'GET_CACHE_STATS', payload: {} });
      if (res && res.success) els.cacheStats.textContent = i18n('cachedEntries', [String(res.data.count)]);
    } catch (e) { els.cacheStats.textContent = ''; }
  }

  function renderTokenStats() {
    var stats = state.settings.tokenStats || {};
    var html = '<div class="row"><span>' + escapeHtml(i18n('statsTotalPrompt')) + '</span><span><strong>' +
      fmt(stats.prompt_tokens) + '</strong></span></div>';
    html += '<div class="row"><span>' + escapeHtml(i18n('statsTotalCompletion')) + '</span><span><strong>' +
      fmt(stats.completion_tokens) + '</strong></span></div>';

    var byP = stats.byProvider || {};
    var pids = Object.keys(byP);
    var charTypes = { 'google-translate': true, 'deepl': true, 'libretranslate': true };
    if (pids.length) {
      pids.forEach(function (pid) {
        var p = (state.settings.providers || []).find(function (x) { return x.id === pid; });
        var name = p ? p.name : pid;
        var s = byP[pid];
        var isCharBased = p && charTypes[p.type];
        var inLabel = isCharBased ? i18n('labelCharsIn') : i18n('labelPrompt');
        var outLabel = isCharBased ? i18n('labelCharsOut') : i18n('labelCompletion');
        html += '<div class="provider-stat"><div class="row"><span>' + escapeHtml(name) +
          '</span><span>' + escapeHtml(i18n('statsCalls', [String(s.calls)])) + '</span></div>' +
          '<div class="row"><span>&nbsp;&nbsp;' + escapeHtml(inLabel) + ' / ' + escapeHtml(outLabel) + '</span><span>' +
          fmt(s.prompt_tokens) + ' / ' + fmt(s.completion_tokens) + '</span></div></div>';
      });
    }
    els.tokenStats.innerHTML = html;
  }

  function fmt(n) { return (n || 0).toLocaleString(); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function clearCache() {
    if (!confirm(i18n('confirmClearCache'))) return;
    try {
      var res = await browser.runtime.sendMessage({ type: 'CLEAR_CACHE', payload: {} });
      if (res && res.success) {
        setStatus(i18n('statusCacheCleared'), 'success');
        renderCacheStats();
      } else {
        setStatus(i18n('errorClearFailed'), 'error');
      }
    } catch (e) {
      setStatus(i18n('errorClearFailedWith', [e.message]), 'error');
    }
  }

  async function resetTokens() {
    if (!confirm(i18n('confirmResetTokens'))) return;
    try {
      await browser.runtime.sendMessage({ type: 'RESET_TOKEN_STATS', payload: {} });
      state.settings.tokenStats = { prompt_tokens: 0, completion_tokens: 0, byProvider: {} };
      renderTokenStats();
      setStatus(i18n('statusTokensReset'), 'success');
    } catch (e) {
      setStatus(i18n('errorResetFailed', [e.message]), 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
