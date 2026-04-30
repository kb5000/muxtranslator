(function () {
  'use strict';

  /**
   * @typedef {Object} ProgressState
   * @property {HTMLElement|null} host
   * @property {ShadowRoot|null} shadow
   * @property {number} totalSeen
   * @property {number} completed
   * @property {boolean} visible
   */

  /**
   * All UI widgets: error toast, notification bar, PDF tooltip overlay, progress bar.
   *
   * @param {{ t: function(string, string[]=): string, engine: object }} deps
   * @returns {{
   *   escapeHtml: function(string): string,
   *   showErrorToast: function(string): void,
   *   removeBar: function(): void,
   *   showNotificationBar: function(string, string, object, {onTranslate: function}): void,
   *   progressState: ProgressState,
   *   showProgress: function(): void,
   *   updateProgressTotal: function(): void,
   *   updateProgress: function(): void,
   *   finishProgress: function(function): void,
   *   hideProgressNow: function(): void
   * }}
   */
  window.UIModule = function (deps) {
    var t = deps.t;
    var engine = deps.engine;

    var _errorToastHost = null;
    var _errorToastTimer = null;
    var _tooltipEl = null;

    /** @type {ProgressState} */
    var progressState = { host: null, shadow: null, totalSeen: 0, completed: 0, visible: false };

    // -------- Utility --------

    /** @param {string} s */
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    // -------- Error toast --------

    /** @param {string} msg */
    function showErrorToast(msg) {
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

    // -------- Notification bar --------

    function removeBar() {
      var bar = document.getElementById('muxtranslator-bar');
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    }

    /**
     * @param {string} detectedLang
     * @param {string} targetLang
     * @param {object} settings
     * @param {{ onTranslate: function }} callbacks
     */
    function showNotificationBar(detectedLang, targetLang, settings, callbacks) {
      if (document.getElementById('muxtranslator-bar')) return;
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
        if (callbacks && callbacks.onTranslate) callbacks.onTranslate();
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

    // -------- PDF tooltip overlay (fixed-position, escapes overflow:hidden) --------

    function getTooltipEl() {
      if (!_tooltipEl) {
        _tooltipEl = document.createElement('div');
        _tooltipEl.id = 'muxt-tooltip';
        _tooltipEl.dataset.muxtranslatorSkip = '1';
        (document.body || document.documentElement).appendChild(_tooltipEl);
      }
      return _tooltipEl;
    }

    /**
     * @param {HTMLElement} tip
     * @param {Element} anchor
     */
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

    // Hover listeners for PDF tooltip spans — installed immediately at module creation.
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

    // -------- Progress widget --------

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
        '  <div class="label"><span>' + escapeHtml(t('progressTranslating')) + '</span>' +
        '  <span class="count">0/0</span>' +
        '  <span class="close-btn" title="' + escapeHtml(t('progressHide')) + '">×</span></div>' +
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
      progressState.totalSeen = Math.max(
        progressState.totalSeen,
        progressState.completed + engine.items.size + engine.inFlight
      );
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

    /**
     * Hides the progress widget after a 1.2 s settle delay, but only if
     * there's truly no remaining work (checked via the passed predicate).
     * @param {function(): boolean} hasWork
     */
    function finishProgress(hasWork) {
      if (!progressState.host) return;
      updateProgress();
      setTimeout(function () {
        if (engine.inFlight === 0 && !(hasWork && hasWork())) {
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

    /** Immediate teardown without settle delay — used on pause. */
    function hideProgressNow() {
      if (progressState.host && progressState.host.parentNode) {
        progressState.host.parentNode.removeChild(progressState.host);
      }
      progressState.host = null;
      progressState.shadow = null;
      progressState.visible = false;
    }

    return {
      escapeHtml: escapeHtml,
      showErrorToast: showErrorToast,
      removeBar: removeBar,
      showNotificationBar: showNotificationBar,
      progressState: progressState,
      showProgress: showProgress,
      updateProgressTotal: updateProgressTotal,
      updateProgress: updateProgress,
      finishProgress: finishProgress,
      hideProgressNow: hideProgressNow
    };
  };
})();
