(function () {
  'use strict';

  /**
   * DOM scanning, text-node registration, viewport priority, and
   * MutationObserver / IntersectionObserver setup.
   *
   * @param {{
   *   engine: object,
   *   tracking: import('./content').Tracking,
   *   SKIP_TAGS: Object<string,number>,
   *   PRIORITY: {VISIBLE:0, NEAR:1, FAR:2}
   * }} deps
   * @returns {{
   *   scanSubtree: function(Node): void,
   *   registerNode: function(Text): void,
   *   computePriority: function(Element): number,
   *   updateItemPriority: function(object, number): void,
   *   setupObservers: function(function, function, function): void
   * }}
   */
  window.ScannerModule = function (deps) {
    var engine   = deps.engine;
    var tracking = deps.tracking;
    var SKIP_TAGS = deps.SKIP_TAGS;
    var PRIORITY  = deps.PRIORITY;

    // -------- Element visibility helpers --------

    /** @param {Element} el */
    function isElementRenderable(el) {
      if (!el || !el.isConnected) return false;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    }

    /** @param {Element} el */
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

    // -------- DOM scan --------

    /** @param {Node} root */
    function scanSubtree(root) {
      if (!root || !root.isConnected) return;
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
        if (reconcileTranslated(n)) continue;
        registerNode(n);
      }
    }

    /**
     * If this node was previously translated, decide what to do with it now.
     * Returns true when the scan should skip re-registration.
     * @param {Text} node
     */
    function reconcileTranslated(node) {
      var known = tracking.translatedValueOf.get(node);
      if (known === undefined) return false;

      var current = node.nodeValue;
      var currentTrim = current ? current.replace(/^\s+|\s+$/g, '') : '';

      if (currentTrim === known) return true; // still our translation — nothing to do

      var origNorm = UtilsModule.normalizeText(tracking.originalValueOf.get(node) || '');
      var curNorm  = UtilsModule.normalizeText(currentTrim);
      if (origNorm && origNorm === curNorm) {
        // SPA reverted our write back to the original — re-apply silently
        var leading  = (current.match(/^\s*/) || [''])[0];
        var trailing = (current.match(/\s*$/) || [''])[0];
        try { node.nodeValue = leading + known + trailing; } catch (e) {}
        return true;
      }

      // Content genuinely changed — treat as new text
      tracking.translatedValueOf.delete(node);
      tracking.originalValueOf.delete(node);
      return false;
    }

    /** @param {Text} node */
    function registerNode(node) {
      var parent = node.parentElement;
      if (!parent) return;
      var trimmed = UtilsModule.normalizeText(node.nodeValue);
      if (!trimmed) return;
      if (!UtilsModule.hasTranslatableContent(trimmed)) return;

      // Dedup: skip if this exact node is already tracked
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
      /** @type {import('./content').Item} */
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
        if (engine.intersectionObserver) {
          try { engine.intersectionObserver.observe(parent); } catch (e) {}
        }
      }
      existingSet.add(id);
      engine.queues[item.priority].add(id);
    }

    /** @param {Element} el @returns {0|1|2} */
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

    /**
     * @param {import('./content').Item} item
     * @param {number} newPriority
     */
    function updateItemPriority(item, newPriority) {
      if (item.priority === newPriority) return;
      if (item.status !== 'pending') return;
      engine.queues[item.priority].delete(item.id);
      item.priority = newPriority;
      engine.queues[newPriority].add(item.id);
    }

    // -------- Observers --------

    /**
     * Creates IntersectionObserver and MutationObserver.
     * @param {function(IntersectionObserverEntry[]): void} onIntersect
     * @param {function(MutationRecord[]): void} onMutation
     * @param {function(MutationRecord[]): void} onPdfMutation
     */
    function setupObservers(onIntersect, onMutation, onPdfMutation) {
      if (!engine.intersectionObserver && 'IntersectionObserver' in window &&
          engine.settings.viewportPriority !== false) {
        engine.intersectionObserver = new IntersectionObserver(onIntersect, {
          rootMargin: '200% 0px 200% 0px',
          threshold: [0, 0.01]
        });
      }
      if (!engine.mutationObserver && engine.settings.observeMutations !== false) {
        engine.mutationObserver = new MutationObserver(
          engine.pdfMode ? onPdfMutation : onMutation
        );
        engine.mutationObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: !engine.pdfMode
        });
      }
    }

    return {
      scanSubtree: scanSubtree,
      registerNode: registerNode,
      computePriority: computePriority,
      updateItemPriority: updateItemPriority,
      setupObservers: setupObservers
    };
  };
})();
