(function () {
  'use strict';

  if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
    window.browser = chrome;
  }

  if (window.__muxtranslatorLoaded) return;
  window.__muxtranslatorLoaded = true;

  var _i18nMsgs = null;

  function t(key, subs) {
    if (_i18nMsgs) {
      var entry = _i18nMsgs[key];
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
      return (subs ? browser.i18n.getMessage(key, subs) : browser.i18n.getMessage(key)) || key;
    } catch (e) { return key; }
  }

  async function loadI18nOverride(lang) {
    if (!lang) { _i18nMsgs = null; return; }
    try {
      var url = browser.runtime.getURL('_locales/' + lang + '/messages.json');
      var r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _i18nMsgs = await r.json();
    } catch (e) {
      _i18nMsgs = null;
    }
  }

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1,
    NOSCRIPT: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, TEXTAREA: 1, INPUT: 1,
    SELECT: 1, CANVAS: 1, SVG: 1, MATH: 1
  };

  var PRIORITY = { VISIBLE: 0, NEAR: 1, FAR: 2 };

  // ====================================================================
  // TranslationEngine
  // ====================================================================

  var engine = {
    started: false,
    settings: null,
    providerId: null,                // resolved from site rule or default

    items: new Map(),               // id -> Item
    itemsByElement: new WeakMap(),  // Element -> Set<id>
    queues: [new Set(), new Set(), new Set()], // Set<id> by priority (0/1/2)

    inFlight: 0,
    nextId: 1,
    nextBatchId: 1,
    batchItems: new Map(),          // batchId -> Map<itemId, Item>

    intersectionObserver: null,
    mutationObserver: null,
    pendingMutationRoots: null,
    mutationTimer: null,

    // Session token counter (resets on each page load)
    sessionTokens: { prompt: 0, completion: 0 },

    paused: false,         // true = stop dispatching new batches
    progressHidden: false, // true = user dismissed the progress widget
    pdfMode: false         // true = we're translating Firefox's PDF viewer
  };

  // Per-Text-node translation tracking. We store the *translated* value we
  // wrote, and the *original* pre-translation text, so that if an SPA like
  // React overwrites our text back to the original, we can re-apply silently.
  // Keying on the Text node (not its parent) means SPAs that recycle parent
  // elements but create fresh Text nodes don't poison our skip logic.
  var translatedValueOf = new WeakMap();    // Text -> string (what we wrote, trimmed)
  var originalValueOf   = new WeakMap();    // Text -> string (what was there before)
  // Iterable companion to the WeakMaps — needed so Restore can walk every
  // node we've touched. Pruned of disconnected nodes during mutation flushes.
  var translatedNodes   = new Set();
  // Bilingual span elements we created (replacing the original text nodes).
  var bilingualElements = new Set();
  // Overlay elements produced by the PDF pipeline (either opaque replacements
  // or invisible hover zones). Iterated only on restore.
  var pdfOverlays = new Set();

  // -------- Settings helper --------

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

  // -------- DOM scan --------

  function isElementRenderable(el) {
    if (!el || !el.isConnected) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  function shouldSkipSubtree(el) {
    var a = el;
    while (a && a.nodeType === 1) {
      if (SKIP_TAGS[a.tagName]) return true;
      if (a.dataset && a.dataset.muxtranslatorSkip === '1') return true;
      if (a.getAttribute && a.getAttribute('contenteditable') === 'true') return true;
      a = a.parentElement;
    }
    return false;
  }

  function scanSubtree(root) {
    if (!root || !root.isConnected) return;
    // Treat root itself: if it's a text node use its parent
    var startElement = root.nodeType === 1 ? root : root.parentElement;
    if (!startElement) return;

    var walker = document.createTreeWalker(
      startElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          var value = node.nodeValue;
          if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
          var parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest && parent.closest('#muxtranslator-bar, #muxtranslator-progress')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (shouldSkipSubtree(parent)) return NodeFilter.FILTER_REJECT;
          if (!isElementRenderable(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    var n;
    while ((n = walker.nextNode())) {
      // Reconcile against prior translation state for this exact Text node.
      if (reconcileTranslated(n)) continue;
      registerNode(n);
    }
  }

  // If this node was translated before, decide what to do now based on its
  // current value. Returns true if the scan should skip registration.
  function reconcileTranslated(node) {
    var known = translatedValueOf.get(node);
    if (known === undefined) return false;

    var current = node.nodeValue;
    var currentTrim = current ? current.replace(/^\s+|\s+$/g, '') : '';

    if (currentTrim === known) {
      return true; // still shows our translation — nothing to do
    }

    var origNorm = UtilsModule.normalizeText(originalValueOf.get(node) || '');
    var curNorm = UtilsModule.normalizeText(currentTrim);
    if (origNorm && origNorm === curNorm) {
      // SPA reverted our write back to the original — re-apply silently
      var leading = (current.match(/^\s*/) || [''])[0];
      var trailing = (current.match(/\s*$/) || [''])[0];
      try { node.nodeValue = leading + known + trailing; } catch (e) {}
      return true;
    }

    // Content is genuinely different — treat as new text and re-translate
    translatedValueOf.delete(node);
    originalValueOf.delete(node);
    return false;
  }

  function registerNode(node) {
    var parent = node.parentElement;
    if (!parent) return;
    var trimmed = UtilsModule.normalizeText(node.nodeValue);
    if (!trimmed) return;
    // Skip pure numeric / symbolic / emoji strings — nothing to translate.
    if (!UtilsModule.hasTranslatableContent(trimmed)) return;

    // Dedup: if this exact node is already tracked, skip
    var existingSet = engine.itemsByElement.get(parent);
    if (existingSet) {
      var dup = false;
      existingSet.forEach(function (id) {
        var it = engine.items.get(id);
        if (it && it.node === node) dup = true;
      });
      if (dup) return;
    }

    var id = 'ot' + (engine.nextId++);
    var item = {
      id: id,
      node: node,
      element: parent,
      original: node.nodeValue,
      text: trimmed,
      priority: computePriority(parent),
      status: 'pending'
    };
    engine.items.set(id, item);

    if (!existingSet) {
      existingSet = new Set();
      engine.itemsByElement.set(parent, existingSet);
      // Only observe each element once
      if (engine.intersectionObserver) {
        try { engine.intersectionObserver.observe(parent); } catch (e) {}
      }
    }
    existingSet.add(id);

    engine.queues[item.priority].add(id);
  }

  function computePriority(el) {
    try {
      var rect = el.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      if (rect.bottom > 0 && rect.top < vh) return PRIORITY.VISIBLE;
      if (rect.top < vh * 3 && rect.bottom > -vh * 2) return PRIORITY.NEAR;
      return PRIORITY.FAR;
    } catch (e) {
      return PRIORITY.NEAR;
    }
  }

  function updateItemPriority(item, newPriority) {
    if (item.priority === newPriority) return;
    if (item.status !== 'pending') return; // in-flight items stay put
    engine.queues[item.priority].delete(item.id);
    item.priority = newPriority;
    engine.queues[newPriority].add(item.id);
  }

  // -------- Observers --------

  function setupObservers() {
    if (!engine.intersectionObserver && 'IntersectionObserver' in window && engine.settings.viewportPriority !== false) {
      engine.intersectionObserver = new IntersectionObserver(onIntersect, {
        rootMargin: '200% 0px 200% 0px',
        threshold: [0, 0.01]
      });
    }
    if (!engine.mutationObserver && engine.settings.observeMutations !== false) {
      // PDF mode watches for new .textLayer content appearing as the user
      // scrolls — PDF.js renders pages lazily. Regular pages watch text
      // node mutations for SPA-style re-renders.
      engine.mutationObserver = new MutationObserver(engine.pdfMode ? onPdfMutation : onMutation);
      engine.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: !engine.pdfMode
      });
    }
  }

  function onIntersect(entries) {
    var changed = false;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var ids = engine.itemsByElement.get(entry.target);
      if (!ids) continue;
      var newPriority;
      if (!entry.isIntersecting) {
        newPriority = PRIORITY.FAR;
      } else {
        // Within the widened viewport; check if truly visible
        var rect = entry.boundingClientRect;
        var vh = window.innerHeight || document.documentElement.clientHeight;
        if (rect.bottom > 0 && rect.top < vh) {
          newPriority = PRIORITY.VISIBLE;
        } else {
          newPriority = PRIORITY.NEAR;
        }
      }
      ids.forEach(function (id) {
        var it = engine.items.get(id);
        if (!it) return;
        if (it.priority !== newPriority) {
          updateItemPriority(it, newPriority);
          changed = true;
        }
      });
    }
    if (changed) schedulePump();
  }

  function onMutation(mutations) {
    if (!engine.pendingMutationRoots) engine.pendingMutationRoots = new Set();
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'characterData') {
        var node = m.target;
        var known = translatedValueOf.get(node);
        if (known !== undefined) {
          // We translated this node previously. See if our write was preserved,
          // reverted by an SPA, or replaced with new content.
          var current = node.nodeValue || '';
          var trim = current.replace(/^\s+|\s+$/g, '');
          if (trim === known) continue; // still our translation — ignore
          var origNorm = UtilsModule.normalizeText(originalValueOf.get(node) || '');
          var curNorm = UtilsModule.normalizeText(trim);
          if (origNorm && origNorm === curNorm) {
            // SPA reverted us — re-apply synchronously and move on
            try {
              var lead = (current.match(/^\s*/) || [''])[0];
              var trail = (current.match(/\s*$/) || [''])[0];
              node.nodeValue = lead + known + trail;
            } catch (e) {}
            continue;
          }
          // Content changed to something genuinely new — forget and rescan
          translatedValueOf.delete(node);
          originalValueOf.delete(node);
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
    // After restore (or before startEngine), MO may still fire. Drop these
    // silently so we don't pop an empty progress bar or accumulate orphan
    // queue items that nothing will pump.
    if (!engine.started) {
      engine.pendingMutationRoots.clear();
      return;
    }
    var roots = Array.from(engine.pendingMutationRoots);
    engine.pendingMutationRoots.clear();
    var added = 0;
    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      if (!r || !r.isConnected) continue;
      var before = engine.items.size;
      scanSubtree(r);
      added += engine.items.size - before;
    }
    // Prune restorable-nodes set of anything no longer in the DOM so long-
    // lived SPAs don't accumulate references forever.
    if (translatedNodes.size > 512) {
      translatedNodes.forEach(function (n) {
        if (!n || !n.isConnected) translatedNodes.delete(n);
      });
    }
    if (added > 0) {
      showProgress();
      updateProgressTotal();
      // Defer pumping so that bursts of mutations during SPA rendering
      // accumulate into one batch instead of firing many small API calls.
      schedulePump();
    }
  }

  // -------- PDF pipeline --------

  function scanPdfPages() {
    var layers = document.querySelectorAll('.textLayer');
    for (var i = 0; i < layers.length; i++) scanPdfLayer(layers[i]);
  }

  // Convert one .textLayer's spans into paragraph items and queue them.
  // Marked with data-muxt-pdf-processed so the mutation handler doesn't
  // re-enqueue the same paragraphs when PDF.js appends its trailing markers.
  // The flag is cleared when PDF.js wipes the layer (zoom/rotate).
  function scanPdfLayer(layer) {
    if (!layer || !layer.isConnected) return;
    if (layer.dataset && layer.dataset.muxtPdfProcessed === '1') return;
    // Research mode: visualize detected regions instead of translating. We
    // deliberately don't set muxtPdfProcessed so flipping the toggle off
    // later allows the layer to be re-scanned normally.
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

  function registerPdfParagraph(para, layer) {
    var text = UtilsModule.normalizeText(para.text);
    if (!text) return;
    if (!UtilsModule.hasTranslatableContent(text)) return;

    var id = 'ot' + (engine.nextId++);
    var item = {
      id: id,
      kind: 'pdf',
      layer: layer,
      paragraph: para,
      element: layer,       // shared per page — IntersectionObserver target
      original: para.text,
      text: text,
      priority: computePriority(layer),
      status: 'pending'
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
        // PDF.js wipes the text layer on zoom/rotate and repopulates. Allow
        // the fresh content to be re-scanned by dropping our processed flag.
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
      showProgress();
      updateProgressTotal();
      schedulePump();
    }
  }

  // Trailing debounce with a hard ceiling: each call resets the timer so a
  // flurry of mutations ships as one batch, but we never wait longer than
  // MAX_PUMP_WAIT from the first call so the user sees steady progress.
  var pumpTimer = null;
  var pumpFirstAt = 0;
  var DEFAULT_PUMP_DELAY = 2000;
  var MAX_PUMP_WAIT = 3000;
  function schedulePump(delay) {
    if (!engine.started) return;
    var d = delay || DEFAULT_PUMP_DELAY;
    var now = Date.now();
    if (pumpTimer) {
      var remaining = MAX_PUMP_WAIT - (now - pumpFirstAt);
      if (remaining <= 0) return; // existing timer is already at the ceiling
      clearTimeout(pumpTimer);
      pumpTimer = setTimeout(firePump, Math.min(d, remaining));
      return;
    }
    pumpFirstAt = now;
    pumpTimer = setTimeout(firePump, d);
  }
  function firePump() {
    pumpTimer = null;
    pumpFirstAt = 0;
    pump();
  }

  // -------- Queue / batching --------

  function hasWork() {
    return engine.queues[0].size > 0 || engine.queues[1].size > 0 || engine.queues[2].size > 0;
  }

  function takeBatch(maxChars) {
    var batch = [];
    var count = 0;
    for (var p = 0; p < 3; p++) {
      var q = engine.queues[p];
      if (q.size === 0) continue;
      // Iterate in insertion order
      var iter = q.values();
      var entry;
      while ((entry = iter.next()) && !entry.done) {
        var id = entry.value;
        var item = engine.items.get(id);
        if (!item) { q.delete(id); continue; }
        var len = item.text.length;
        if (len > maxChars && batch.length === 0) {
          // single oversize item
          q.delete(id);
          item.status = 'inflight';
          batch.push(item);
          return batch;
        }
        if (count + len > maxChars) {
          if (batch.length > 0) return batch;
          // else: cannot fit even alone? (shouldn't happen since maxChars > len)
        }
        q.delete(id);
        item.status = 'inflight';
        batch.push(item);
        count += len;
        if (count >= maxChars) return batch;
      }
      if (batch.length > 0 && p < 2 && engine.queues[p + 1].size > 0) {
        // Fill remainder from next priority to make batches denser
        continue;
      }
    }
    return batch;
  }

  // Pause: put every in-flight item back into its priority queue and tell
  // background to abort the underlying network requests. Partial callbacks
  // that arrive after this point will find the batch already deleted and
  // are silently dropped by onPartial.
  function cancelInFlightBatches() {
    if (engine.batchItems.size === 0) return;
    var batchIds = [];
    engine.batchItems.forEach(function (itemsMap, batchId) {
      batchIds.push(batchId);
      itemsMap.forEach(function (item) {
        if (!item || item.status === 'done') return;
        item.status = 'queued';
        var q = engine.queues[item.priority || 0];
        if (q) q.add(item.id);
      });
    });
    engine.batchItems.clear();
    try {
      browser.runtime.sendMessage({
        type: 'TRANSLATE_ABORT',
        payload: { batchIds: batchIds }
      }).catch(function () {});
    } catch (e) {}
  }

  // Resume: rescan the page so anything the user added while paused (SPA
  // content, new PDF pages, etc.) is enqueued alongside the re-queued items.
  function rescanForResume() {
    try {
      if (engine.pdfMode) scanPdfPages();
      else if (document.body) scanSubtree(document.body);
    } catch (e) {}
    updateProgressTotal();
  }

  function pump() {
    if (!engine.started) return;
    if (engine.paused) return;
    var max = engine.settings.concurrentBatches || 2;
    var maxChars = engine.settings.maxCharsPerBatch || 3000;
    while (engine.inFlight < max) {
      var batch = takeBatch(maxChars);
      if (!batch.length) break;
      engine.inFlight++;
      runBatch(batch).finally(function () {
        engine.inFlight--;
        updateProgress();
        if (hasWork()) {
          // If a scheduled pump is already pending (mutation storm in
          // progress), let it fire and aggregate everything together.
          // Otherwise continue immediately to maintain throughput.
          if (!pumpTimer) pump();
        } else if (engine.inFlight === 0) {
          finishProgress();
        }
      });
    }
    updateProgress();
  }

  async function runBatch(batch) {
    var batchId = 'b' + (engine.nextBatchId++);
    var itemsMap = new Map();
    for (var i = 0; i < batch.length; i++) itemsMap.set(batch[i].id, batch[i]);
    engine.batchItems.set(batchId, itemsMap);

    // Always ask background to stream — it will fall back to non-stream if the
    // resolved provider doesn't support streaming.
    var msgType = 'TRANSLATE_STREAM';

    var payload = {
      batchId: batchId,
      texts: batch.map(function (it) { return it.text; }),
      itemIds: batch.map(function (it) { return it.id; }),
      targetLang: engine.settings.targetLanguage,
      providerId: engine.providerId,
      cacheEnabled: engine.settings.cacheEnabled
    };

    var ok = false;
    try {
      var res = await browser.runtime.sendMessage({ type: msgType, payload: payload });
      ok = !!(res && res.success);
      if (!ok) {
        console.error('[MuxTranslator] batch failed:', res && res.error);
        for (var m = 0; m < batch.length; m++) dropItem(batch[m], 'error');
      }
    } catch (err) {
      console.error('[MuxTranslator] batch request failed:', err);
      for (var q = 0; q < batch.length; q++) dropItem(batch[q], 'error');
    } finally {
      engine.batchItems.delete(batchId);
    }

    // After background's response arrived (PARTIAL deliveries already awaited
    // on the background side), any items still in-flight were not emitted by
    // the model — drop them.
    if (ok) {
      for (var n = 0; n < batch.length; n++) {
        if (batch[n].status === 'inflight') dropItem(batch[n], 'empty');
      }
    }
  }

  function dropItem(item, reason) {
    if (item.status === 'done') return;
    item.status = 'error';
    cleanupItem(item);
  }

  function createBilingualSpan(original, translated, leading, trailing, mode) {
    var span = document.createElement('span');
    span.className = 'muxt-bilingual muxt-' + mode;
    span.dataset.muxtranslatorSkip = '1';
    span.dataset.muxtOriginal = original;
    span.dataset.muxtTranslated = translated;
    span.dataset.muxtLeading = leading;
    span.dataset.muxtTrailing = trailing;
    if (mode === 'embed') {
      var tSpan = document.createElement('span');
      tSpan.className = 'muxt-translated';
      tSpan.textContent = leading + translated + trailing;
      var oSpan = document.createElement('span');
      oSpan.className = 'muxt-original';
      oSpan.textContent = original;
      span.appendChild(tSpan);
      span.appendChild(oSpan);
    } else {
      span.textContent = leading + translated + trailing;
    }
    return span;
  }

  function applyBilingualMode(newMode) {
    var oldMode = (engine.settings && engine.settings.bilingualMode) || 'off';
    if (engine.settings) engine.settings.bilingualMode = newMode;

    if (newMode === 'off' && oldMode !== 'off') {
      // Convert bilingual spans → plain translated text nodes
      bilingualElements.forEach(function (span) {
        if (!span || !span.isConnected || !span.parentNode) return;
        var translated = span.dataset.muxtTranslated || '';
        var original = span.dataset.muxtOriginal || '';
        var leading = span.dataset.muxtLeading || '';
        var trailing = span.dataset.muxtTrailing || '';
        try {
          var textNode = document.createTextNode(leading + translated + trailing);
          translatedValueOf.set(textNode, translated);
          originalValueOf.set(textNode, original);
          translatedNodes.add(textNode);
          span.parentNode.replaceChild(textNode, span);
        } catch (e) {}
      });
      bilingualElements.clear();
    } else if (newMode !== 'off') {
      // Convert existing bilingual spans to the new display mode
      var spansToConvert = Array.from(bilingualElements);
      spansToConvert.forEach(function (span) {
        if (!span || !span.isConnected || !span.parentNode) { bilingualElements.delete(span); return; }
        var original = span.dataset.muxtOriginal || '';
        var translated = span.dataset.muxtTranslated || '';
        var leading = span.dataset.muxtLeading || '';
        var trailing = span.dataset.muxtTrailing || '';
        try {
          var newSpan = createBilingualSpan(original, translated, leading, trailing, newMode);
          span.parentNode.replaceChild(newSpan, span);
          bilingualElements.delete(span);
          bilingualElements.add(newSpan);
        } catch (e) {}
      });
      // Also convert any plain translated text nodes to bilingual spans
      var nodesToConvert = [];
      translatedNodes.forEach(function (node) { if (node && node.isConnected) nodesToConvert.push(node); });
      nodesToConvert.forEach(function (node) {
        var translated = translatedValueOf.get(node) || '';
        var original = originalValueOf.get(node) || '';
        var current = node.nodeValue || '';
        var leading = (current.match(/^\s*/) || [''])[0];
        var trailing = (current.match(/\s*$/) || [''])[0];
        try {
          var span = createBilingualSpan(original, translated, leading, trailing, newMode);
          node.parentNode.replaceChild(span, node);
          translatedNodes.delete(node);
          bilingualElements.add(span);
        } catch (e) {}
      });
    }
  }

  function finalizeItem(item, translated) {
    if (!translated || item.status === 'done') return;
    try {
      if (item.kind === 'pdf') {
        finalizePdfItem(item, translated);
      } else {
        var original = item.original;
        var leading = (original.match(/^\s*/) || [''])[0];
        var trailing = (original.match(/\s*$/) || [''])[0];
        var bilingualMode = (engine.settings && engine.settings.bilingualMode) || 'off';
        if (bilingualMode !== 'off' && item.node && item.node.isConnected && item.node.parentNode) {
          var span = createBilingualSpan(item.text, translated, leading, trailing, bilingualMode);
          item.node.parentNode.replaceChild(span, item.node);
          bilingualElements.add(span);
        } else {
          // Record what we wrote so future MO/scan passes can detect SPA reverts.
          translatedValueOf.set(item.node, translated);
          originalValueOf.set(item.node, item.text);
          translatedNodes.add(item.node);
          if (item.node && item.node.isConnected) {
            item.node.nodeValue = leading + translated + trailing;
          }
        }
      }
    } catch (e) {
      // node may have been detached
    }
    item.status = 'done';
    cleanupItem(item);
  }

  function finalizePdfItem(item, translated) {
    if (!item.layer || !item.layer.isConnected) return;
    var mode = (engine.settings && engine.settings.pdfMode) || 'replace';
    var overlay = mode === 'tooltip'
      ? PdfModule.applyTooltip(item.paragraph, translated, item.layer)
      : PdfModule.applyReplace(item.paragraph, translated, item.layer);
    if (overlay) pdfOverlays.add(overlay);
  }

  function cleanupItem(item) {
    engine.items.delete(item.id);
    var set = engine.itemsByElement.get(item.element);
    if (set) {
      set.delete(item.id);
      if (set.size === 0) {
        engine.itemsByElement.delete(item.element);
        // Unobserve the element — nothing more to watch
        if (engine.intersectionObserver) {
          try { engine.intersectionObserver.unobserve(item.element); } catch (e) {}
        }
      }
    }
  }

  // -------- UI: error toast --------

  var _errorToastHost = null;
  var _errorToastTimer = null;

  function showErrorToast(msg) {
    // Remove any existing toast first (no stacking)
    if (_errorToastHost && _errorToastHost.parentNode) {
      _errorToastHost.parentNode.removeChild(_errorToastHost);
    }
    clearTimeout(_errorToastTimer);

    var host = document.createElement('div');
    host.dataset.muxtranslatorSkip = '1';
    host.style.cssText =
      'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'max-width:340px;';
    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' +
      '.toast{display:flex;align-items:flex-start;gap:8px;padding:10px 14px;' +
      'background:#1e1e1e;color:#fff;border-radius:8px;font-size:13px;line-height:1.4;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.3);}' +
      '.icon{flex-shrink:0;font-size:15px;margin-top:1px;}' +
      '.body{flex:1;word-break:break-word;}' +
      '.title{font-weight:600;color:#f87171;margin-bottom:2px;}' +
      '.msg{color:#d1d5db;font-size:12px;}' +
      'button{all:unset;cursor:pointer;flex-shrink:0;color:#9ca3af;font-size:16px;line-height:1;padding:0 2px;}' +
      'button:hover{color:#fff;}' +
      '</style>' +
      '<div class="toast">' +
      '  <span class="icon">⚠</span>' +
      '  <div class="body">' +
      '    <div class="title">' + escapeHtml(t('toastErrorTitle')) + '</div>' +
      '    <div class="msg"></div>' +
      '  </div>' +
      '  <button>✕</button>' +
      '</div>';

    shadow.querySelector('.msg').textContent = msg || 'Unknown error';
    shadow.querySelector('button').addEventListener('click', function () {
      if (host.parentNode) host.parentNode.removeChild(host);
      _errorToastHost = null;
    });

    (document.body || document.documentElement).appendChild(host);
    _errorToastHost = host;

    _errorToastTimer = setTimeout(function () {
      if (host.parentNode) host.parentNode.removeChild(host);
      if (_errorToastHost === host) _errorToastHost = null;
    }, 8000);
  }

  // -------- UI: notification bar --------

  function removeBar() {
    var bar = document.getElementById('muxtranslator-bar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }

  function showNotificationBar(detectedLang, targetLang, settings) {
    if (document.getElementById('muxtranslator-bar')) return;
    // Never show on the extension's own pages (e.g. viewer.html has its own toolbar).
    try {
      var proto = window.location.protocol;
      if (proto === 'moz-extension:' || proto === 'chrome-extension:') return;
    } catch (e) {}
    var host = document.createElement('div');
    host.id = 'muxtranslator-bar';
    host.dataset.muxtranslatorSkip = '1';
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' +
      '.bar{display:flex;align-items:center;gap:8px;padding:10px 16px;background:#2563eb;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:14px;}' +
      '.msg{flex:1;line-height:1.4;}' +
      '.msg strong{font-weight:600;}' +
      'button{all:unset;cursor:pointer;padding:6px 14px;border-radius:4px;font-size:13px;font-weight:500;white-space:nowrap;touch-action:manipulation;}' +
      '.yes{background:#fff;color:#2563eb;}' +
      '.yes:hover{background:#f1f5f9;}' +
      '.never{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);}' +
      '.never:hover{background:rgba(255,255,255,.1);}' +
      '.skip{background:transparent;color:rgba(255,255,255,.75);font-size:12px;}' +
      '.skip:hover{color:#fff;}' +
      '@media(max-width:480px){' +
      '.bar{padding:7px 10px;font-size:12px;gap:5px;}' +
      'button{padding:5px 9px;font-size:12px;}' +
      '.skip{font-size:11px;padding:5px 6px;}' +
      '}' +
      '</style>' +
      '<div class="bar">' +
      '  <span class="msg"><strong>' + escapeHtml(detectedLang) +
      '</strong> → <strong>' + escapeHtml(targetLang) + '</strong></span>' +
      '  <button class="yes">' + escapeHtml(t('notifBtnTranslate')) + '</button>' +
      '  <button class="never">' + escapeHtml(t('notifBtnNever')) + '</button>' +
      '  <button class="skip">' + escapeHtml(t('notifBtnIgnore')) + '</button>' +
      '</div>';

    shadow.querySelector('.yes').addEventListener('click', function () {
      removeBar();
      startEngine();
    });
    shadow.querySelector('.never').addEventListener('click', function () {
      removeBar();
      var hostname = '';
      try { hostname = window.location.hostname; } catch (e) {}
      if (!hostname) return;
      var rules = Object.assign({}, (settings && settings.siteRules) || {});
      rules[hostname] = { mode: 'skip' };
      browser.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        payload: { settings: { siteRules: rules } }
      }).catch(function () {});
    });
    shadow.querySelector('.skip').addEventListener('click', removeBar);

    (document.body || document.documentElement).appendChild(host);
  }

  // -------- Tooltip overlay (fixed-position, escapes overflow:hidden) --------

  var _tooltipEl = null;

  function getTooltipEl() {
    if (!_tooltipEl) {
      _tooltipEl = document.createElement('div');
      _tooltipEl.id = 'muxt-tooltip';
      _tooltipEl.dataset.muxtranslatorSkip = '1';
      (document.body || document.documentElement).appendChild(_tooltipEl);
    }
    return _tooltipEl;
  }

  document.addEventListener('mouseover', function (e) {
    var target = e.target;
    if (!target || !target.classList || !target.classList.contains('muxt-tooltip')) return;
    var original = target.dataset.muxtOriginal;
    if (!original) return;
    var tip = getTooltipEl();
    tip.textContent = original;
    tip.style.display = 'block';
    positionTooltip(tip, target);
  }, true);

  document.addEventListener('mouseout', function (e) {
    if (!_tooltipEl) return;
    var target = e.target;
    if (target && target.classList && target.classList.contains('muxt-tooltip')) {
      _tooltipEl.style.display = 'none';
    }
  }, true);

  function positionTooltip(tip, anchor) {
    var rect = anchor.getBoundingClientRect();
    var tipH = tip.offsetHeight || 30;
    var top = rect.top - tipH - 6;
    if (top < 4) top = rect.bottom + 6;
    var left = rect.left;
    var maxLeft = window.innerWidth - 330;
    if (left > maxLeft) left = maxLeft;
    if (left < 4) left = 4;
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // -------- UI: progress --------

  var progressState = { host: null, shadow: null, totalSeen: 0, completed: 0, visible: false };

  function showProgress() {
    if (progressState.host) return;
    if (engine.progressHidden) return;
    if (engine.settings && engine.settings.showProgressBar === false) return;
    var host = document.createElement('div');
    host.id = 'muxtranslator-progress';
    host.dataset.muxtranslatorSkip = '1';
    host.style.cssText =
      'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' +
      '.box{background:#1e293b;color:#fff;padding:10px 14px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.3);min-width:200px;font-size:12px;}' +
      '.label{display:flex;justify-content:space-between;margin-bottom:6px;align-items:center;gap:8px;}' +
      '.bar-outer{height:4px;background:rgba(255,255,255,.2);border-radius:2px;overflow:hidden;}' +
      '.bar-inner{height:100%;background:#22c55e;width:0%;transition:width .25s ease;}' +
      '.count{font-variant-numeric:tabular-nums;opacity:.85;flex:1;text-align:right;}' +
      '.close-btn{all:unset;cursor:pointer;opacity:.5;font-size:14px;line-height:1;padding:0 2px;flex-shrink:0;touch-action:manipulation;}' +
      '.close-btn:hover{opacity:1;}' +
      '@media(pointer:coarse){.close-btn{font-size:18px;padding:4px 6px;}}' +
      '</style>' +
      '<div class="box">' +
      '  <div class="label"><span>' + escapeHtml(t('progressTranslating')) + '</span><span class="count">0/0</span><span class="close-btn" title="' + escapeHtml(t('progressHide')) + '">×</span></div>' +
      '  <div class="bar-outer"><div class="bar-inner"></div></div>' +
      '  <div class="tokens" style="margin-top:6px;opacity:.7;font-variant-numeric:tabular-nums;"></div>' +
      '</div>';
    shadow.querySelector('.close-btn').addEventListener('click', function () {
      engine.progressHidden = true;
      if (progressState.host && progressState.host.parentNode) {
        progressState.host.parentNode.removeChild(progressState.host);
      }
      progressState.host = null;
      progressState.shadow = null;
      progressState.visible = false;
    });
    (document.body || document.documentElement).appendChild(host);
    progressState.host = host;
    progressState.shadow = shadow;
    progressState.visible = true;
  }

  function updateProgressTotal() {
    progressState.totalSeen = Math.max(progressState.totalSeen, progressState.completed + engine.items.size + engine.inFlight);
  }

  function updateProgress() {
    if (!progressState.shadow) return;
    updateProgressTotal();
    var total = progressState.totalSeen;
    var done = progressState.completed;
    if (total === 0) return;
    var pct = Math.round((done / total) * 100);
    progressState.shadow.querySelector('.count').textContent = done + '/' + total;
    progressState.shadow.querySelector('.bar-inner').style.width = pct + '%';
    var tok = progressState.shadow.querySelector('.tokens');
    if (tok) {
      var p = engine.sessionTokens.prompt || 0;
      var c = engine.sessionTokens.completion || 0;
      tok.textContent = (p || c) ? t('progressTokensInOut', [String(p), String(c)]) : '';
    }
  }

  function finishProgress() {
    if (!progressState.host) return;
    updateProgress();
    setTimeout(function () {
      if (engine.inFlight === 0 && !hasWork()) {
        if (progressState.host && progressState.host.parentNode) {
          progressState.host.parentNode.removeChild(progressState.host);
        }
        progressState.host = null;
        progressState.shadow = null;
        progressState.visible = false;
        progressState.completed = 0;
        progressState.totalSeen = 0;
      }
    }, 1200);
  }

  // Immediate teardown of the progress widget without the settle delay.
  // Used on pause so the "translating…" pill disappears the moment the user
  // hits pause. Counters are preserved so resume picks up where it left off.
  function hideProgressNow() {
    if (progressState.host && progressState.host.parentNode) {
      progressState.host.parentNode.removeChild(progressState.host);
    }
    progressState.host = null;
    progressState.shadow = null;
    progressState.visible = false;
  }

  // -------- Engine lifecycle --------

  async function startEngine(opts) {
    if (engine.started) return;
    opts = opts || {};
    engine.settings = await loadSettings();
    engine.providerId = opts.providerId || resolveProviderIdFromRules(engine.settings);
    engine.pdfMode = PdfModule.isPdfViewerPage();

    // Guard: verify a provider actually exists
    if (!Array.isArray(engine.settings.providers) || engine.settings.providers.length === 0) {
      alert(t('alertNoProviders'));
      return;
    }

    engine.started = true;
    removeBar();
    setupObservers();
    if (engine.pdfMode) {
      if ((engine.settings.pdfMode || 'replace') === 'tooltip') {
        PdfModule.installTooltipDelegation();
      }
      scanPdfPages();
    } else {
      scanSubtree(document.body);
    }
    updateProgressTotal();
    // Only show the progress widget if there's actual work — avoids a 0/0
    // flash when the page has nothing to translate or all entries are cached.
    if (hasWork() || engine.inFlight > 0) showProgress();
    pump();
    markPageTranslated();
    emitEngineChanged(true);
  }

  // Broadcast engine on/off transitions so embedded UIs (like the PDF viewer
  // toolbar) can update their own controls without polling.
  function emitEngineChanged(active) {
    try {
      window.dispatchEvent(new CustomEvent('muxt-engine-changed', {
        detail: { active: !!active }
      }));
    } catch (e) {}
  }

  // Walks every node we've ever translated and writes the original text back.
  // Also cancels any pending work and resets engine state so the user can hit
  // "Translate" again later for a clean re-run.
  function restorePage() {
    engine.paused = true;
    var count = 0;
    translatedNodes.forEach(function (node) {
      if (!node || !node.isConnected) return;
      var original = originalValueOf.get(node);
      if (original == null) return;
      try {
        var current = node.nodeValue || '';
        var leading = (current.match(/^\s*/) || [''])[0];
        var trailing = (current.match(/\s*$/) || [''])[0];
        node.nodeValue = leading + original + trailing;
        count++;
      } catch (e) {}
    });
    bilingualElements.forEach(function (span) {
      if (!span || !span.isConnected || !span.parentNode) return;
      var original = span.dataset.muxtOriginal;
      if (original == null) return;
      var leading = span.dataset.muxtLeading || '';
      var trailing = span.dataset.muxtTrailing || '';
      try {
        var textNode = document.createTextNode(leading + original + trailing);
        span.parentNode.replaceChild(textNode, span);
        count++;
      } catch (e) {}
    });
    bilingualElements.clear();

    // PDF overlays (opaque replacement divs and tooltip hover zones). Removing
    // them exposes the original canvas rendering underneath. Also clear the
    // "processed" flag so a subsequent translate run can re-enqueue pages.
    pdfOverlays.forEach(function (el) { PdfModule.removeOverlay(el); });
    pdfOverlays.clear();
    var processedLayers = document.querySelectorAll('.textLayer[data-muxt-pdf-processed]');
    for (var li = 0; li < processedLayers.length; li++) {
      if (processedLayers[li].dataset) delete processedLayers[li].dataset.muxtPdfProcessed;
    }

    // Cancel any scheduled pump — restore clears the queue, so a deferred
    // pump would otherwise briefly repaint the progress widget at 0/0.
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; pumpFirstAt = 0; }

    // Stop observers; they'll be re-created on the next startEngine.
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

    // Drop pending queue + in-flight bookkeeping — results arriving after this
    // point hit onPartial's "item not found" path and are silently ignored.
    engine.queues[0].clear();
    engine.queues[1].clear();
    engine.queues[2].clear();
    engine.items.clear();
    engine.itemsByElement = new WeakMap();
    translatedNodes.clear();
    translatedValueOf = new WeakMap();
    originalValueOf = new WeakMap();
    bilingualElements.clear();

    // Tear down progress UI and unlock re-translation.
    if (progressState.host && progressState.host.parentNode) {
      progressState.host.parentNode.removeChild(progressState.host);
    }
    progressState.host = null;
    progressState.shadow = null;
    progressState.visible = false;
    progressState.completed = 0;
    progressState.totalSeen = 0;
    engine.progressHidden = false;
    engine.started = false;
    engine.paused = false;
    engine.pdfMode = false;
    engine.sessionTokens = { prompt: 0, completion: 0 };
    clearPageTranslatedFlag();
    emitEngineChanged(false);
    return count;
  }

  function resolveProviderIdFromRules(settings) {
    // Per-site rules take highest priority; next, PDF pages may have their
    // own dedicated provider; finally we fall back to the global default.
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

  // Per-page provider memory. Stored in sessionStorage so the choice survives
  // page reloads and back/forward within the same tab, but doesn't leak across
  // unrelated pages. Read on popup open to pre-select the same provider.
  var MUXT_PROVIDER_KEY = 'muxt.lastProviderId';

  function rememberProviderChoice(providerId) {
    if (!providerId) return;
    try { sessionStorage.setItem(MUXT_PROVIDER_KEY, providerId); } catch (e) {}
  }

  function readRememberedProvider() {
    try { return sessionStorage.getItem(MUXT_PROVIDER_KEY) || null; } catch (e) { return null; }
  }

  // Per-URL translation-state flag. Lets us re-trigger translation when the
  // user navigates back/forward (or reloads) to a page they had already
  // translated. Keyed by full URL so unrelated same-origin pages don't
  // auto-translate just because a sibling was translated earlier.
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

  // -------- Incoming messages --------

  browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'TRANSLATE_PAGE':
        rememberProviderChoice(message.payload && message.payload.providerId);
        startEngine(message.payload || {});
        sendResponse({ success: true });
        return false;
      case 'SET_PROVIDER':
        // Remember the user's provider pick even before they hit Translate.
        // If the engine is already running, switching would require stopping
        // and re-running; for simplicity we just update the remembered value
        // so the next translate / resume uses it.
        rememberProviderChoice(message.payload && message.payload.providerId);
        if (engine.started && message.payload && message.payload.providerId) {
          engine.providerId = message.payload.providerId;
        }
        sendResponse({ success: true });
        return false;
      case 'GET_PAGE_INFO':
        sendResponse({
          success: true,
          data: {
            lang: engine.pageLanguage || '',
            isTranslating: engine.started && (engine.inFlight > 0 || hasWork()),
            paused: engine.paused,
            sessionTokens: {
              prompt: engine.sessionTokens.prompt || 0,
              completion: engine.sessionTokens.completion || 0
            },
            bilingualMode: (engine.settings && engine.settings.bilingualMode) || 'off',
            isPdf: PdfModule.isPdfViewerPage(),
            lastProviderId: readRememberedProvider(),
            url: window.location.href,
            title: document.title
          }
        });
        return false;
      case 'SET_BILINGUAL_MODE':
        applyBilingualMode((message.payload && message.payload.mode) || 'off');
        sendResponse({ success: true });
        return false;
      case 'PAUSE_TRANSLATION':
        engine.paused = true;
        cancelInFlightBatches();
        hideProgressNow();
        sendResponse({ success: true });
        return false;
      case 'RESUME_TRANSLATION':
        engine.paused = false;
        rescanForResume();
        if (hasWork() || engine.inFlight > 0) showProgress();
        pump();
        sendResponse({ success: true });
        return false;
      case 'RESTORE_PAGE':
        sendResponse({ success: true, data: { restored: restorePage() } });
        return false;
      case 'TRANSLATION_PARTIAL':
        onPartial(message.payload);
        sendResponse({ success: true });
        return false;
      case 'TRANSLATION_ERROR':
        showErrorToast(message.payload && message.payload.message);
        sendResponse({ success: true });
        return false;
      case 'TRANSLATION_USAGE':
        if (message.payload && message.payload.usage) {
          engine.sessionTokens.prompt += message.payload.usage.prompt_tokens || 0;
          engine.sessionTokens.completion += message.payload.usage.completion_tokens || 0;
          updateProgress();
        }
        sendResponse({ success: true });
        return false;
    }
  });

  function onPartial(payload) {
    if (!payload || !payload.itemId) return;
    var item = engine.items.get(payload.itemId);
    if (!item) return;
    if (payload.text) {
      finalizeItem(item, payload.text);
      progressState.completed++;
      updateProgress();
    } else {
      // empty translation — mark done so we don't retry
      item.status = 'error';
      cleanupItem(item);
    }
  }

  // -------- Selection translation (badge + tooltip) --------

  var selectionState = {
    installed: false,
    badge: null,
    tooltip: null,
    lastSelection: null,   // { text, rect }
    lastTouchEnd: 0        // timestamp — used to suppress redundant mouse events after touch
  };

  function installSelectionHandler() {
    if (selectionState.installed) return;
    selectionState.installed = true;
    document.addEventListener('mouseup', onSelectionMouseUp, true);
    document.addEventListener('mousedown', onSelectionMouseDown, true);
    document.addEventListener('touchend', onSelectionTouchEnd, true);
    document.addEventListener('touchstart', onSelectionTouchStart, true);
    document.addEventListener('selectionchange', onSelectionChange, true);
    window.addEventListener('resize', hideSelectionUI, true);
  }

  function onSelectionMouseDown(e) {
    // If the click is inside the badge or tooltip, don't hide.
    if (e.target && (e.target.closest && e.target.closest('#muxtranslator-sel-badge, #muxtranslator-sel-tooltip'))) return;
    hideSelectionUI();
  }

  function onSelectionChange() {
    // Debounced dismiss when selection is cleared (e.g., user clicks blank)
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) {
      // Don't hide immediately — the badge click also collapses the selection
      // after reading it. We just skip creating a new badge.
    }
  }

  function onSelectionTouchStart(e) {
    if (e.target && e.target.closest && e.target.closest('#muxtranslator-sel-badge, #muxtranslator-sel-tooltip')) return;
    hideSelectionUI();
  }

  function onSelectionTouchEnd(e) {
    if (e.target && e.target.closest && e.target.closest('#muxtranslator-sel-badge, #muxtranslator-sel-tooltip')) return;
    selectionState.lastTouchEnd = Date.now();
    // Defer so the browser has time to update the selection after touch
    setTimeout(function () {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed) return;
      var text = String(sel.toString() || '').trim();
      if (!text || text.length < 2 || text.length > 5000) return;
      var range;
      try { range = sel.getRangeAt(0); } catch (err) { return; }
      var rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      selectionState.lastSelection = { text: text, rect: rect };
      showSelectionBadge(rect);
    }, 200);
  }

  function onSelectionMouseUp(e) {
    // If user clicked inside badge/tooltip, ignore — the element handlers take over
    if (e.target && e.target.closest && e.target.closest('#muxtranslator-sel-badge, #muxtranslator-sel-tooltip')) return;
    // Suppress the synthetic mouse event that mobile browsers fire after touchend
    if (Date.now() - selectionState.lastTouchEnd < 600) return;
    // Defer to let selection finalize
    setTimeout(function () {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed) { hideSelectionUI(); return; }
      var text = String(sel.toString() || '').trim();
      if (!text || text.length < 2 || text.length > 5000) { hideSelectionUI(); return; }

      var range;
      try { range = sel.getRangeAt(0); } catch (err) { return; }
      var rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;

      selectionState.lastSelection = { text: text, rect: rect };
      showSelectionBadge(rect);
    }, 10);
  }

  function hideSelectionUI() {
    if (selectionState.badge && selectionState.badge.parentNode) {
      selectionState.badge.parentNode.removeChild(selectionState.badge);
    }
    if (selectionState.tooltip && selectionState.tooltip.parentNode) {
      selectionState.tooltip.parentNode.removeChild(selectionState.tooltip);
    }
    selectionState.badge = null;
    selectionState.tooltip = null;
  }

  function showSelectionBadge(rect) {
    hideSelectionUI();
    var host = document.createElement('div');
    host.id = 'muxtranslator-sel-badge';
    host.dataset.muxtranslatorSkip = '1';
    var isTouch = window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
    var badgeSize = isTouch ? 44 : 24;
    var top = rect.bottom + window.scrollY + (isTouch ? 8 : 4);
    var left = Math.max(4 + window.scrollX, rect.right + window.scrollX - badgeSize);
    host.style.cssText =
      'all:initial;position:absolute;z-index:2147483647;top:' + top + 'px;left:' + left + 'px;';
    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' +
      '.b{width:24px;height:24px;border-radius:4px;background:#2563eb;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'box-shadow:0 2px 6px rgba(0,0,0,.3);user-select:none;-webkit-user-select:none;touch-action:manipulation;}' +
      '.b:hover{background:#1d4ed8;}' +
      '@media(pointer:coarse){.b{width:44px;height:44px;border-radius:8px;font-size:18px;}}' +
      '</style>' +
      '<div class="b" title="' + escapeHtml(t('selBadgeTitle')) + '">译</div>';
    shadow.querySelector('.b').addEventListener('mousedown', function (ev) {
      // Prevent losing the selection before we capture its text
      ev.preventDefault();
      ev.stopPropagation();
    });
    shadow.querySelector('.b').addEventListener('touchstart', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    });
    shadow.querySelector('.b').addEventListener('touchend', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      translateSelection();
    });
    shadow.querySelector('.b').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      translateSelection();
    });
    (document.body || document.documentElement).appendChild(host);
    selectionState.badge = host;
  }

  async function translateSelection() {
    var snapshot = selectionState.lastSelection;
    if (!snapshot || !snapshot.text) return;
    showSelectionTooltip(snapshot.rect, snapshot.text, null, 'loading');
    try {
      var res = await browser.runtime.sendMessage({
        type: 'TRANSLATE_TEXT',
        payload: { text: snapshot.text, purpose: 'selection' }
      });
      if (res && res.success) {
        showSelectionTooltip(snapshot.rect, snapshot.text, res.data.translated, res.data.fromCache ? 'cache' : 'ok');
      } else {
        showSelectionTooltip(snapshot.rect, snapshot.text, (res && res.error) || 'Failed', 'error');
      }
    } catch (err) {
      showSelectionTooltip(snapshot.rect, snapshot.text, err.message || String(err), 'error');
    }
  }

  function showSelectionTooltip(rect, original, translated, state) {
    // Remove badge now that we're showing the tooltip
    if (selectionState.badge && selectionState.badge.parentNode) {
      selectionState.badge.parentNode.removeChild(selectionState.badge);
      selectionState.badge = null;
    }
    if (selectionState.tooltip && selectionState.tooltip.parentNode) {
      selectionState.tooltip.parentNode.removeChild(selectionState.tooltip);
    }

    var host = document.createElement('div');
    host.id = 'muxtranslator-sel-tooltip';
    host.dataset.muxtranslatorSkip = '1';
    var top = rect.bottom + window.scrollY + 4;
    var left = Math.max(4, rect.left + window.scrollX);
    host.style.cssText =
      'all:initial;position:absolute;z-index:2147483647;top:' + top + 'px;left:' + left + 'px;max-width:420px;';
    var shadow = host.attachShadow({ mode: 'closed' });

    var content;
    if (state === 'loading') {
      content = '<div class="body loading">' + escapeHtml(t('statusTranslating')) + '</div>';
    } else if (state === 'error') {
      content = '<div class="body err">' + escapeHtml(translated || t('labelError')) + '</div>';
    } else {
      var badge = state === 'cache' ? '<span class="tag">' + escapeHtml(t('tagCached')) + '</span>' : '';
      content = '<div class="body"><div class="txt">' + escapeHtml(translated || '') + '</div>' + badge + '</div>';
    }

    shadow.innerHTML =
      '<style>' +
      '.body{background:#1e293b;color:#fff;padding:10px 12px;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,.35);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.5;' +
      'white-space:pre-wrap;word-break:break-word;position:relative;max-height:300px;overflow-y:auto;}' +
      '.loading{opacity:.8;}' +
      '.err{background:#7f1d1d;}' +
      '.tag{display:inline-block;margin-top:6px;padding:1px 6px;background:rgba(255,255,255,.15);' +
      'border-radius:3px;font-size:10px;opacity:.75;}' +
      '.close{position:absolute;top:4px;right:6px;cursor:pointer;opacity:.6;font-size:14px;line-height:1;touch-action:manipulation;}' +
      '.close:hover{opacity:1;}' +
      '@media(pointer:coarse){.close{font-size:20px;top:6px;right:8px;padding:4px;}}' +
      '</style>' +
      '<div>' + content + '<span class="close" title="' + escapeHtml(t('btnClose')) + '">×</span></div>';

    shadow.querySelector('.close').addEventListener('click', hideSelectionUI);
    (document.body || document.documentElement).appendChild(host);
    selectionState.tooltip = host;
  }

  // -------- Init (auto-detect bar + site rules) --------

  async function init() {
    // The bundled PDF viewer (viewer/viewer.html) loads this script directly.
    // Until the user actually picks a PDF there's nothing to translate and
    // showing the "translate this page" bar would be premature, so skip auto
    // init; the muxt-pdf-loaded listener below drives (re-)init once a PDF
    // has rendered. This also re-fires for each new document the user opens.
    var _isExtPage = false;
    try { var _p = window.location.protocol; _isExtPage = _p === 'moz-extension:' || _p === 'chrome-extension:'; } catch (e) {}
    if ((_isExtPage || window.__muxtViewerManaged) && !window.__muxtViewerReady) return;

    engine.pageLanguage = UtilsModule.detectPageLanguage();
    var isPdf = PdfModule.isPdfViewerPage();
    var s = await loadSettings();
    var host = '';
    try { host = window.location && window.location.hostname; } catch (e) {}
    var rule = SettingsModule.resolveSiteRule(s, host);

    // Always set up selection translation listener if feature enabled
    if (s.selectionEnabled !== false) installSelectionHandler();

    if (rule && rule.mode === 'skip') {
      // Respect: no bar, no auto-translate
      return;
    }
    if (rule && rule.mode === 'always' && rule.providerId) {
      // Auto-start with the bound provider, no bar
      startEngine({ providerId: rule.providerId });
      return;
    }

    // If the user had already translated this URL earlier in the session
    // (typical back/forward or reload case), resume automatically and skip
    // the notification bar. Prefer the remembered provider if still valid.
    if (wasPageTranslated()) {
      var remembered = readRememberedProvider();
      var providerExists = remembered && Array.isArray(s.providers) &&
        s.providers.some(function (p) { return p.id === remembered; });
      startEngine(providerExists ? { providerId: remembered } : {});
      return;
    }

    // Apply global default translation mode (site rules above take priority)
    var translationMode = s.defaultTranslationMode || 'ask';
    var isForeignPage = translationMode !== 'never' && engine.pageLanguage &&
      !UtilsModule.shouldSkipLanguage(engine.pageLanguage, s.skipLanguages, s.targetLanguage);
    // PDF viewers rarely expose a language attribute; treat them as translatable
    // candidates in auto/ask modes so the user still gets a prompt.
    if (isPdf && translationMode !== 'never') isForeignPage = true;

    // On the extension's own pages (viewer.html, etc.) the toolbar has its own
    // Translate button — never show the notification bar there.
    // Check the URL protocol rather than a window flag for robustness.
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
        showNotificationBar(detected, s.targetLanguage, s);
      }, 600);
    }
  }

  // Expose a minimal control API so extension pages that embed this script
  // (the bundled PDF viewer) can drive translation without reaching back
  // through message passing. Keep the surface area tiny on purpose.
  window.__muxTranslator = {
    startEngine: startEngine,
    restorePage: restorePage
  };

  // Viewer handshake: each newly-loaded PDF fires this event, and we (re-)run
  // init so the user's auto/ask preference is applied per document — the
  // previous document's engine state was already cleared via restorePage().
  if (window.__muxtViewerManaged) {
    window.addEventListener('muxt-pdf-loaded', function () {
      window.__muxtViewerReady = true;
      init();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
