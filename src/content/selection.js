(function () {
  'use strict';

  /**
   * Floating badge + tooltip for translating the user's text selection.
   *
   * @param {{
   *   t: function(string, string[]=): string,
   *   escapeHtml: function(string): string
   * }} deps
   * @returns {{ installSelectionHandler: function(): void }}
   */
  window.SelectionModule = function (deps) {
    var t          = deps.t;
    var escapeHtml = deps.escapeHtml;

    var selectionState = {
      installed:     false,
      badge:         null,
      tooltip:       null,
      lastSelection: null,   // { text: string, rect: DOMRect }
      lastTouchEnd:  0       // suppress synthetic mouse event after touch
    };

    // -------- Public entry point --------

    function installSelectionHandler() {
      if (selectionState.installed) return;
      selectionState.installed = true;
      document.addEventListener('mouseup',        onSelectionMouseUp,    true);
      document.addEventListener('mousedown',      onSelectionMouseDown,  true);
      document.addEventListener('touchend',       onSelectionTouchEnd,   true);
      document.addEventListener('touchstart',     onSelectionTouchStart, true);
      document.addEventListener('selectionchange', onSelectionChange,    true);
      window.addEventListener('resize',           hideSelectionUI,       true);
    }

    // -------- Event handlers --------

    function onSelectionMouseDown(e) {
      if (e.target && e.target.closest &&
          e.target.closest('#muxtranslator-sel-badge, #muxtranslator-sel-tooltip')) return;
      hideSelectionUI();
    }

    function onSelectionChange() {
      // Only used as a future hook — badge dismissal is handled in mousedown/touchstart.
    }

    function onSelectionTouchStart(e) {
      if (e.target && e.target.closest &&
          e.target.closest('#muxtranslator-sel-badge, #muxtranslator-sel-tooltip')) return;
      hideSelectionUI();
    }

    function onSelectionTouchEnd(e) {
      if (e.target && e.target.closest &&
          e.target.closest('#muxtranslator-sel-badge, #muxtranslator-sel-tooltip')) return;
      selectionState.lastTouchEnd = Date.now();
      // Defer so the browser has time to finalise the selection after touch.
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
      if (e.target && e.target.closest &&
          e.target.closest('#muxtranslator-sel-badge, #muxtranslator-sel-tooltip')) return;
      // Suppress synthetic mouse events that mobile browsers fire after touchend.
      if (Date.now() - selectionState.lastTouchEnd < 600) return;
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

    // -------- UI helpers --------

    function hideSelectionUI() {
      if (selectionState.badge && selectionState.badge.parentNode) {
        selectionState.badge.parentNode.removeChild(selectionState.badge);
      }
      if (selectionState.tooltip && selectionState.tooltip.parentNode) {
        selectionState.tooltip.parentNode.removeChild(selectionState.tooltip);
      }
      selectionState.badge   = null;
      selectionState.tooltip = null;
    }

    /** @param {DOMRect} rect */
    function showSelectionBadge(rect) {
      hideSelectionUI();
      var host     = document.createElement('div');
      host.id      = 'muxtranslator-sel-badge';
      host.dataset.muxtranslatorSkip = '1';
      var isTouch  = window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
      var badgeSize = isTouch ? 44 : 24;
      var top  = rect.bottom + window.scrollY + (isTouch ? 8 : 4);
      var left = Math.max(4 + window.scrollX, rect.right + window.scrollX - badgeSize);
      host.style.cssText =
        'all:initial;position:absolute;z-index:2147483647;top:' + top + 'px;left:' + left + 'px;';
      var shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML =
        '<style>' +
        '.b{width:24px;height:24px;border-radius:4px;background:#2563eb;color:#fff;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;' +
        'cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3);user-select:none;' +
        '-webkit-user-select:none;touch-action:manipulation;}' +
        '.b:hover{background:#1d4ed8;}' +
        '@media(pointer:coarse){.b{width:44px;height:44px;border-radius:8px;font-size:18px;}}' +
        '</style>' +
        '<div class="b" title="' + escapeHtml(t('selBadgeTitle')) + '">译</div>';

      shadow.querySelector('.b').addEventListener('mousedown', function (ev) {
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
          type:    'TRANSLATE_TEXT',
          payload: { text: snapshot.text, purpose: 'selection' }
        });
        if (res && res.success) {
          showSelectionTooltip(
            snapshot.rect, snapshot.text,
            res.data.translated,
            res.data.fromCache ? 'cache' : 'ok'
          );
        } else {
          showSelectionTooltip(snapshot.rect, snapshot.text, (res && res.error) || 'Failed', 'error');
        }
      } catch (err) {
        showSelectionTooltip(snapshot.rect, snapshot.text, err.message || String(err), 'error');
      }
    }

    /**
     * @param {DOMRect} rect
     * @param {string} original
     * @param {string|null} translated
     * @param {'loading'|'ok'|'cache'|'error'} state
     */
    function showSelectionTooltip(rect, original, translated, state) {
      if (selectionState.badge && selectionState.badge.parentNode) {
        selectionState.badge.parentNode.removeChild(selectionState.badge);
        selectionState.badge = null;
      }
      if (selectionState.tooltip && selectionState.tooltip.parentNode) {
        selectionState.tooltip.parentNode.removeChild(selectionState.tooltip);
      }

      var host    = document.createElement('div');
      host.id     = 'muxtranslator-sel-tooltip';
      host.dataset.muxtranslatorSkip = '1';
      var top  = rect.bottom + window.scrollY + 4;
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
        var badge = state === 'cache'
          ? '<span class="tag">' + escapeHtml(t('tagCached')) + '</span>'
          : '';
        content = '<div class="body"><div class="txt">' + escapeHtml(translated || '') + '</div>' + badge + '</div>';
      }

      shadow.innerHTML =
        '<style>' +
        '.body{background:#1e293b;color:#fff;padding:10px 12px;border-radius:6px;' +
        'box-shadow:0 4px 20px rgba(0,0,0,.35);' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;' +
        'position:relative;max-height:300px;overflow-y:auto;}' +
        '.loading{opacity:.8;}' +
        '.err{background:#7f1d1d;}' +
        '.tag{display:inline-block;margin-top:6px;padding:1px 6px;' +
        'background:rgba(255,255,255,.15);border-radius:3px;font-size:10px;opacity:.75;}' +
        '.close{position:absolute;top:4px;right:6px;cursor:pointer;opacity:.6;font-size:14px;' +
        'line-height:1;touch-action:manipulation;}' +
        '.close:hover{opacity:1;}' +
        '@media(pointer:coarse){.close{font-size:20px;top:6px;right:8px;padding:4px;}}' +
        '</style>' +
        '<div>' + content + '<span class="close" title="' + escapeHtml(t('btnClose')) + '">×</span></div>';

      shadow.querySelector('.close').addEventListener('click', hideSelectionUI);
      (document.body || document.documentElement).appendChild(host);
      selectionState.tooltip = host;
    }

    return { installSelectionHandler: installSelectionHandler };
  };
})();
