(function () {
  'use strict';

  /**
   * Batch scheduling, execution, DOM finalization, and bilingual-mode switching.
   *
   * @param {{
   *   engine: object,
   *   tracking: import('./content').Tracking,
   *   ui: object,
   *   rescan: function(): void
   * }} deps
   * @returns {{
   *   schedulePump: function(number=): void,
   *   cancelScheduledPump: function(): void,
   *   pump: function(): void,
   *   hasWork: function(): boolean,
   *   cancelInFlightBatches: function(): void,
   *   rescanForResume: function(): void,
   *   dropItem: function(object, string): void,
   *   finalizeItem: function(object, string): void,
   *   applyBilingualMode: function(string): void,
   *   onPartial: function(object): void
   * }}
   */
  window.PumpModule = function (deps) {
    var engine   = deps.engine;
    var tracking = deps.tracking;
    var ui       = deps.ui;
    var rescan   = deps.rescan;

    var DEFAULT_PUMP_DELAY = 2000;
    var MAX_PUMP_WAIT      = 3000;

    var pumpTimer   = null;
    var pumpFirstAt = 0;

    // -------- Queue helpers --------

    function hasWork() {
      return engine.queues[0].size > 0 || engine.queues[1].size > 0 || engine.queues[2].size > 0;
    }

    /** @param {number} maxChars @returns {import('./content').Item[]} */
    function takeBatch(maxChars) {
      var batch = [];
      var count = 0;
      for (var p = 0; p < 3; p++) {
        var q = engine.queues[p];
        if (q.size === 0) continue;
        var iter = q.values();
        var entry;
        while ((entry = iter.next()) && !entry.done) {
          var id   = entry.value;
          var item = engine.items.get(id);
          if (!item) { q.delete(id); continue; }
          var len = item.text.length;
          if (len > maxChars && batch.length === 0) {
            // single oversize item — send it alone
            q.delete(id);
            item.status = 'inflight';
            batch.push(item);
            return batch;
          }
          if (count + len > maxChars) {
            if (batch.length > 0) return batch;
          }
          q.delete(id);
          item.status = 'inflight';
          batch.push(item);
          count += len;
          if (count >= maxChars) return batch;
        }
        if (batch.length > 0 && p < 2 && engine.queues[p + 1].size > 0) continue;
      }
      return batch;
    }

    // -------- Pump scheduling --------

    function schedulePump(delay) {
      if (!engine.started) return;
      var d   = delay || DEFAULT_PUMP_DELAY;
      var now = Date.now();
      if (pumpTimer) {
        var remaining = MAX_PUMP_WAIT - (now - pumpFirstAt);
        if (remaining <= 0) return;
        clearTimeout(pumpTimer);
        pumpTimer = setTimeout(firePump, Math.min(d, remaining));
        return;
      }
      pumpFirstAt = now;
      pumpTimer   = setTimeout(firePump, d);
    }

    function firePump() {
      pumpTimer   = null;
      pumpFirstAt = 0;
      pump();
    }

    function cancelScheduledPump() {
      if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; pumpFirstAt = 0; }
    }

    // -------- Pump --------

    function pump() {
      if (!engine.started) return;
      if (engine.paused) return;
      var max      = engine.settings.concurrentBatches || 2;
      var maxChars = engine.settings.maxCharsPerBatch  || 3000;
      while (engine.inFlight < max) {
        var batch = takeBatch(maxChars);
        if (!batch.length) break;
        engine.inFlight++;
        runBatch(batch).finally(function () {
          engine.inFlight--;
          ui.updateProgress();
          if (hasWork()) {
            if (!pumpTimer) pump();
          } else if (engine.inFlight === 0) {
            ui.finishProgress(hasWork);
          }
        });
      }
      ui.updateProgress();
    }

    /** @param {import('./content').Item[]} batch */
    async function runBatch(batch) {
      var batchId  = 'b' + (engine.nextBatchId++);
      var itemsMap = new Map();
      for (var i = 0; i < batch.length; i++) itemsMap.set(batch[i].id, batch[i]);
      engine.batchItems.set(batchId, itemsMap);

      var pageTitle = '';
      var pageDesc  = '';
      try {
        pageTitle = document.title || '';
        var metaDesc = document.querySelector('meta[name="description"]');
        pageDesc = (metaDesc && metaDesc.getAttribute('content')) || '';
      } catch (e) {}

      var payload = {
        batchId:      batchId,
        texts:        batch.map(function (it) { return it.text; }),
        itemIds:      batch.map(function (it) { return it.id; }),
        targetLang:   engine.settings.targetLanguage,
        providerId:   engine.providerId,
        cacheEnabled: engine.settings.cacheEnabled,
        cacheScope:   engine.settings.cacheScope,
        hostname:     window.location.hostname,
        pageContext:  { title: pageTitle, description: pageDesc }
      };

      var ok = false;
      try {
        var res = await browser.runtime.sendMessage({ type: 'TRANSLATE_STREAM', payload: payload });
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

      // Items still in-flight after the batch response were not emitted by the model.
      if (ok) {
        for (var n = 0; n < batch.length; n++) {
          if (batch[n].status === 'inflight') dropItem(batch[n], 'empty');
        }
      }
    }

    // -------- In-flight management --------

    /**
     * Put every in-flight item back into its priority queue and abort the
     * underlying network requests.
     */
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

    /**
     * Rescan the page so anything added while paused gets enqueued too.
     * Delegates to the rescan callback provided by content.js (which knows
     * whether this is a PDF page or a regular page).
     */
    function rescanForResume() {
      try { rescan(); } catch (e) {}
    }

    // -------- Item lifecycle --------

    /**
     * @param {import('./content').Item} item
     * @param {string} _reason
     */
    function dropItem(item, _reason) {
      if (item.status === 'done') return;
      item.status = 'error';
      cleanupItem(item);
    }

    /** @param {import('./content').Item} item */
    function cleanupItem(item) {
      engine.items.delete(item.id);
      var set = engine.itemsByElement.get(item.element);
      if (set) {
        set.delete(item.id);
        if (set.size === 0) {
          engine.itemsByElement.delete(item.element);
          if (engine.intersectionObserver) {
            try { engine.intersectionObserver.unobserve(item.element); } catch (e) {}
          }
        }
      }
    }

    // -------- Bilingual display --------

    /**
     * @param {string} original
     * @param {string} translated
     * @param {string} leading
     * @param {string} trailing
     * @param {string} mode  'embed' | 'replace'
     */
    function createBilingualSpan(original, translated, leading, trailing, mode) {
      var span = document.createElement('span');
      span.className = 'muxt-bilingual muxt-' + mode;
      span.dataset.muxtranslatorSkip = '1';
      span.dataset.muxtOriginal   = original;
      span.dataset.muxtTranslated = translated;
      span.dataset.muxtLeading    = leading;
      span.dataset.muxtTrailing   = trailing;
      if (mode === 'embed') {
        var tSpan = document.createElement('span');
        tSpan.className   = 'muxt-translated';
        tSpan.textContent = leading + translated + trailing;
        var oSpan = document.createElement('span');
        oSpan.className   = 'muxt-original';
        oSpan.textContent = original;
        span.appendChild(tSpan);
        span.appendChild(oSpan);
      } else {
        span.textContent = leading + translated + trailing;
      }
      return span;
    }

    /** @param {string} newMode */
    function applyBilingualMode(newMode) {
      var oldMode = (engine.settings && engine.settings.bilingualMode) || 'off';
      if (engine.settings) engine.settings.bilingualMode = newMode;

      if (newMode === 'off' && oldMode !== 'off') {
        // Convert bilingual spans → plain translated text nodes
        tracking.bilingualElements.forEach(function (span) {
          if (!span || !span.isConnected || !span.parentNode) return;
          var translated = span.dataset.muxtTranslated || '';
          var original   = span.dataset.muxtOriginal   || '';
          var leading    = span.dataset.muxtLeading    || '';
          var trailing   = span.dataset.muxtTrailing   || '';
          try {
            var textNode = document.createTextNode(leading + translated + trailing);
            tracking.translatedValueOf.set(textNode, translated);
            tracking.originalValueOf.set(textNode, original);
            tracking.translatedNodes.add(textNode);
            span.parentNode.replaceChild(textNode, span);
          } catch (e) {}
        });
        tracking.bilingualElements.clear();
      } else if (newMode !== 'off') {
        // Switch existing bilingual spans to the new display mode
        var spansToConvert = Array.from(tracking.bilingualElements);
        spansToConvert.forEach(function (span) {
          if (!span || !span.isConnected || !span.parentNode) {
            tracking.bilingualElements.delete(span);
            return;
          }
          var original   = span.dataset.muxtOriginal   || '';
          var translated = span.dataset.muxtTranslated || '';
          var leading    = span.dataset.muxtLeading    || '';
          var trailing   = span.dataset.muxtTrailing   || '';
          try {
            var newSpan = createBilingualSpan(original, translated, leading, trailing, newMode);
            span.parentNode.replaceChild(newSpan, span);
            tracking.bilingualElements.delete(span);
            tracking.bilingualElements.add(newSpan);
          } catch (e) {}
        });
        // Also convert plain translated text nodes to bilingual spans
        var nodesToConvert = [];
        tracking.translatedNodes.forEach(function (node) {
          if (node && node.isConnected) nodesToConvert.push(node);
        });
        nodesToConvert.forEach(function (node) {
          var translated = tracking.translatedValueOf.get(node) || '';
          var original   = tracking.originalValueOf.get(node)   || '';
          var current    = node.nodeValue || '';
          var leading    = (current.match(/^\s*/) || [''])[0];
          var trailing   = (current.match(/\s*$/) || [''])[0];
          try {
            var span = createBilingualSpan(original, translated, leading, trailing, newMode);
            node.parentNode.replaceChild(span, node);
            tracking.translatedNodes.delete(node);
            tracking.bilingualElements.add(span);
          } catch (e) {}
        });
      }
    }

    // -------- Finalization --------

    /**
     * @param {import('./content').Item} item
     * @param {string} translated
     */
    function finalizeItem(item, translated) {
      if (!translated || item.status === 'done') return;
      try {
        if (item.kind === 'pdf') {
          finalizePdfItem(item, translated);
        } else {
          var original     = item.original;
          var leading      = (original.match(/^\s*/) || [''])[0];
          var trailing     = (original.match(/\s*$/) || [''])[0];
          var bilingualMode = (engine.settings && engine.settings.bilingualMode) || 'off';
          if (bilingualMode !== 'off' && item.node && item.node.isConnected && item.node.parentNode) {
            var span = createBilingualSpan(item.text, translated, leading, trailing, bilingualMode);
            item.node.parentNode.replaceChild(span, item.node);
            tracking.bilingualElements.add(span);
          } else {
            tracking.translatedValueOf.set(item.node, translated);
            tracking.originalValueOf.set(item.node, item.text);
            tracking.translatedNodes.add(item.node);
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

    /** @param {import('./content').Item} item @param {string} translated */
    function finalizePdfItem(item, translated) {
      if (!item.layer || !item.layer.isConnected) return;
      var mode    = (engine.settings && engine.settings.pdfMode) || 'replace';
      var overlay = mode === 'tooltip'
        ? PdfModule.applyTooltip(item.paragraph, translated, item.layer)
        : PdfModule.applyReplace(item.paragraph, translated, item.layer);
      if (overlay) tracking.pdfOverlays.add(overlay);
    }

    // -------- Streaming partial handler --------

    /** @param {{ itemId: string, text: string }} payload */
    function onPartial(payload) {
      if (!payload || !payload.itemId) return;
      var item = engine.items.get(payload.itemId);
      if (!item) return;
      if (payload.text) {
        finalizeItem(item, payload.text);
        ui.progressState.completed++;
        ui.updateProgress();
      } else {
        item.status = 'error';
        cleanupItem(item);
      }
    }

    return {
      schedulePump:        schedulePump,
      cancelScheduledPump: cancelScheduledPump,
      pump:                pump,
      hasWork:             hasWork,
      cancelInFlightBatches: cancelInFlightBatches,
      rescanForResume:     rescanForResume,
      dropItem:            dropItem,
      finalizeItem:        finalizeItem,
      applyBilingualMode:  applyBilingualMode,
      onPartial:           onPartial
    };
  };
})();
