var UtilsModule = UtilsModule || {};
(function (ns) {
  'use strict';

  ns.hashText = function (str) {
    if (!str) return '0';
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16);
  };

  ns.normalizeText = function (str) {
    if (!str) return '';
    return str.replace(/\s+/g, ' ').trim();
  };

  ns.fillTemplate = function (template, vars) {
    if (!template) return '';
    return template.replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
    });
  };

  ns.batchTexts = function (texts, maxChars) {
    var batches = [];
    var current = [];
    var count = 0;
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      var len = t.length;
      if (len > maxChars) {
        if (current.length) {
          batches.push(current);
          current = [];
          count = 0;
        }
        batches.push([t]);
        continue;
      }
      if (count + len > maxChars && current.length) {
        batches.push(current);
        current = [];
        count = 0;
      }
      current.push(t);
      count += len;
    }
    if (current.length) batches.push(current);
    return batches;
  };

  ns.detectPageLanguage = function () {
    try {
      var htmlLang = document.documentElement && document.documentElement.lang;
      if (htmlLang && htmlLang.trim()) return htmlLang.trim().toLowerCase();

      var metaCL = document.querySelector('meta[http-equiv="content-language" i]');
      if (metaCL && metaCL.content) return metaCL.content.trim().toLowerCase();

      var metaLang = document.querySelector('meta[name="language" i]');
      if (metaLang && metaLang.content) return metaLang.content.trim().toLowerCase();

      // navigator.language is the user's preferred language, not the page's — don't use it.
    } catch (e) {
      // ignore
    }
    return '';
  };

  ns.shouldSkipLanguage = function (langCode, skipList, targetLang) {
    if (!langCode) return false;
    var lower = String(langCode).toLowerCase();
    var prefix = lower.split('-')[0];

    // If the page is already in the target language, nothing to translate.
    // Compare case-insensitively so "zh-cn" (detected) matches "zh-CN" (target).
    if (targetLang && String(targetLang).toLowerCase() === lower) return true;

    if (!skipList || !skipList.length) return false;
    for (var i = 0; i < skipList.length; i++) {
      var s = String(skipList[i]).toLowerCase().trim();
      if (!s) continue;
      if (s === lower) return true;
      if (s === prefix) return true;
      if (lower.startsWith(s + '-')) return true;
    }
    return false;
  };

  // Returns true if the string contains at least one Unicode letter (any
  // script — Latin, CJK, Cyrillic, Arabic, etc). Pure numeric/symbolic/emoji
  // strings return false and are skipped by the translator so we don't burn
  // tokens on content that has nothing to translate.
  ns.hasTranslatableContent = function (str) {
    if (!str) return false;
    try {
      return /\p{L}/u.test(str);
    } catch (e) {
      // Older engines without Unicode property escapes — fall back to a
      // coarser check that covers common scripts (ASCII letters + CJK).
      return /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(str);
    }
  };

  ns.SEPARATOR = '<<<SEP>>>';          // kept for reference / backward compat
  ns.SEP_PATTERN = /<<<SEP\d*>>>/;    // matches <<<SEP>>>, <<<SEP1>>>, <<<SEP2>>>, …

  ns.makeSeparator = function (n) {
    return '<<<SEP' + n + '>>>';
  };

  ns.joinForBatch = function (texts) {
    var result = '';
    for (var i = 0; i < texts.length; i++) {
      if (i > 0) result += '\n' + ns.makeSeparator(i) + '\n';
      result += texts[i];
    }
    return result;
  };

  ns.splitBatchResponse = function (response) {
    if (!response) return [];
    return response.split(ns.SEP_PATTERN).map(function (s) {
      return s.replace(/^\s+|\s+$/g, '');
    });
  };
})(UtilsModule);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = UtilsModule;
}
