// PDF translation support for Firefox's built-in PDF.js viewer.
//
// This module is intentionally decoupled from the main translation engine.
// It exposes pure helpers for:
//   - detecting that the current page is a PDF viewer,
//   - aggregating the PDF.js .textLayer spans into coherent paragraphs via
//     geometry (so translation has enough context to stay fluent), and
//   - applying a translated paragraph back to the layer either as an opaque
//     replacement overlay or a hover-only tooltip that leaves the original
//     layout intact.
//
// Engine integration (queues, batching, pumping, restore bookkeeping) lives
// in content.js.

var PdfModule = PdfModule || {};
(function (ns) {
  'use strict';

  // ---------- Detection ----------

  ns.isPdfViewerPage = function () {
    try {
      if (document.contentType === 'application/pdf') return true;
    } catch (e) {}
    if (document.querySelector('div.pdfViewer, #viewer.pdfViewer')) return true;
    if (document.getElementById('viewerContainer') &&
        document.querySelector('.page .textLayer, .page .canvasWrapper')) return true;
    return false;
  };

  // ---------- Span collection ----------

  // Returns the "real" text spans in a .textLayer, excluding our own overlays
  // and structural markers PDF.js adds (endOfContent sentinel, empty spacers).
  ns.collectLayerSpans = function (layer) {
    if (!layer) return [];
    var out = [];
    var spans = layer.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (!s.textContent) continue;
      if (s.dataset && s.dataset.muxtranslatorSkip === '1') continue;
      if (s.classList && s.classList.contains('endOfContent')) continue;
      // Skip spans that only contain whitespace — they're spacers, not text.
      if (!s.textContent.trim()) continue;
      out.push(s);
    }
    return out;
  };

  // ---------- Aggregation ----------

  function isCJKChar(ch) {
    if (!ch) return false;
    var code = ch.charCodeAt(0);
    return (code >= 0x3040 && code <= 0x30FF) ||  // Hiragana / Katakana
           (code >= 0x3400 && code <= 0x9FFF) ||  // CJK Unified Ideographs
           (code >= 0xAC00 && code <= 0xD7AF) ||  // Hangul
           (code >= 0xFF00 && code <= 0xFFEF);    // Fullwidth forms
  }

  function endsSentence(text) {
    if (!text) return false;
    // Trailing whitespace-insensitive: does the visible ending look terminal?
    var t = text.replace(/\s+$/, '');
    if (!t) return false;
    return /[.!?。！？؟][)"'”’\]]*$/.test(t);
  }

  function concatLineText(lineItems) {
    // Join a line's spans in reading order. PDF.js sometimes emits whitespace
    // as its own span, so trust the raw concatenation instead of inserting
    // our own spaces.
    var raw = '';
    for (var i = 0; i < lineItems.length; i++) raw += lineItems[i].text;
    // Collapse runs of whitespace (pdf.js can emit tabs/NBSPs) but do NOT
    // trim — leading/trailing space matters for joining lines below.
    return raw.replace(/[ \t\u00A0]+/g, ' ');
  }

  // Group geometry-bearing items into visual lines (same y band).
  function groupLines(items) {
    if (!items.length) return [];
    // Sort primarily by vertical center, with a tolerance so minor baseline
    // jitter on the same line doesn't re-order across x.
    items.sort(function (a, b) {
      var dy = a.cy - b.cy;
      var tol = Math.max(a.height, b.height) * 0.5;
      if (Math.abs(dy) <= tol) return a.rect.left - b.rect.left;
      return dy;
    });

    var lines = [];
    var cur = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!cur) {
        cur = { items: [it], top: it.rect.top, bottom: it.rect.bottom, height: it.height };
        lines.push(cur);
        continue;
      }
      var curMid = (cur.top + cur.bottom) / 2;
      var tol = Math.max(cur.height, it.height) * 0.5;
      if (Math.abs(it.cy - curMid) <= tol) {
        cur.items.push(it);
        if (it.rect.top < cur.top) cur.top = it.rect.top;
        if (it.rect.bottom > cur.bottom) cur.bottom = it.rect.bottom;
        if (it.height > cur.height) cur.height = it.height;
      } else {
        cur = { items: [it], top: it.rect.top, bottom: it.rect.bottom, height: it.height };
        lines.push(cur);
      }
    }
    // Reading order within a line is strictly left-to-right.
    for (var j = 0; j < lines.length; j++) {
      lines[j].items.sort(function (a, b) { return a.rect.left - b.rect.left; });
      lines[j].text = concatLineText(lines[j].items);
    }
    return lines;
  }

  // Merge lines into paragraphs using gap + sentence-break + indent heuristics.
  function groupParagraphs(lines) {
    var paras = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!paras.length) { paras.push(makePara(line)); continue; }

      var prev = lines[i - 1];
      var gap = line.top - prev.bottom;
      var lh = Math.max(line.height, prev.height, 1);

      // Two strong signals that we've crossed a paragraph boundary:
      //   1. Vertical gap significantly larger than a single line height.
      //   2. Previous line ended a sentence AND this line starts with a
      //      capital letter or a new indent (best-effort; avoids splitting
      //      lines that wrap mid-sentence).
      var bigGap = gap > lh * 0.7;
      var sentenceBreak = endsSentence(prev.text);
      var indentShift = Math.abs(line.items[0].rect.left - prev.items[0].rect.left) > lh * 1.5;

      if (bigGap || (sentenceBreak && indentShift)) {
        paras.push(makePara(line));
      } else {
        var p = paras[paras.length - 1];
        p.lines.push(line);
        p.items.push.apply(p.items, line.items);
        if (line.top < p.bbox.top) p.bbox.top = line.top;
        if (line.bottom > p.bbox.bottom) p.bbox.bottom = line.bottom;
        var first = line.items[0].rect.left;
        var last = line.items[line.items.length - 1].rect.right;
        if (first < p.bbox.left) p.bbox.left = first;
        if (last > p.bbox.right) p.bbox.right = last;
      }
    }
    for (var k = 0; k < paras.length; k++) paras[k].text = buildParagraphText(paras[k]);
    return paras;
  }

  function makePara(line) {
    return {
      lines: [line],
      items: line.items.slice(),
      bbox: {
        left: line.items[0].rect.left,
        right: line.items[line.items.length - 1].rect.right,
        top: line.top,
        bottom: line.bottom
      }
    };
  }

  function buildParagraphText(para) {
    var out = '';
    for (var i = 0; i < para.lines.length; i++) {
      var lineText = para.lines[i].text;
      if (!lineText) continue;
      if (i === 0) { out = lineText.replace(/^\s+|\s+$/g, ''); continue; }
      var stripped = lineText.replace(/^\s+|\s+$/g, '');
      if (!stripped) continue;
      var lastChar = out.charAt(out.length - 1);
      var firstChar = stripped.charAt(0);
      // Soft-hyphen wrap: "inter-\nnational" → "international".
      if (lastChar === '-' && /[a-z]/i.test(firstChar)) {
        out = out.slice(0, -1) + stripped;
      } else if (isCJKChar(lastChar) && isCJKChar(firstChar)) {
        out += stripped;
      } else {
        out += ' ' + stripped;
      }
    }
    return out;
  }

  // Main entry point: given a .textLayer, produce translatable paragraphs.
  // Each returned paragraph carries its text, the original spans, and the
  // viewport-space bounding box so callers can position overlays.
  ns.groupIntoParagraphs = function (spans) {
    if (!spans || !spans.length) return [];
    var items = [];
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      var rect = s.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) continue;
      items.push({
        span: s,
        rect: rect,
        text: s.textContent,
        cy: rect.top + rect.height / 2,
        height: rect.height
      });
    }
    if (!items.length) return [];
    var lines = groupLines(items);
    return groupParagraphs(lines);
  };

  // ---------- Application: replace (opaque overlay) ----------

  // The PDF.js text layer is transparent text positioned over a canvas that
  // already shows the original text. To display a translation we add an
  // absolutely-positioned opaque div on top of the paragraph's bounding box.
  // We don't mutate the original spans, so text selection of the source
  // remains possible in the margins; the overlay itself is also selectable.
  ns.applyReplace = function (paragraph, translated, layer) {
    if (!paragraph || !translated || !layer) return null;
    var layerRect = layer.getBoundingClientRect();
    var bbox = paragraph.bbox;

    var overlay = document.createElement('div');
    overlay.className = 'muxt-pdf-overlay muxt-pdf-replace';
    overlay.dataset.muxtranslatorSkip = '1';
    overlay.textContent = translated;

    overlay.style.left   = (bbox.left - layerRect.left) + 'px';
    overlay.style.top    = (bbox.top  - layerRect.top ) + 'px';
    overlay.style.width  = Math.max(1, bbox.right - bbox.left) + 'px';
    overlay.style.minHeight = Math.max(1, bbox.bottom - bbox.top) + 'px';

    // Mirror the source font size so dense paragraphs don't overflow too far.
    // PDF.js commonly applies CSS transforms to its spans, so trust the
    // visually-rendered height over the computed font-size.
    try {
      var firstItem = paragraph.lines[0].items[0];
      var fs = firstItem.height * 0.82; // ~font-size for line-height 1.2
      if (fs && isFinite(fs) && fs > 4) overlay.style.fontSize = fs + 'px';
    } catch (e) {}

    layer.appendChild(overlay);
    return overlay;
  };

  // ---------- Application: tooltip (hover-only, non-destructive) ----------

  // Leaves the PDF unchanged. Instead, attach an invisible hover zone over the
  // paragraph bbox that, on mouseenter, shows the translation in a floating
  // card positioned near the paragraph. The zone uses pointer-events:auto but
  // is semi-transparent background so selection of original text through it
  // still works while you're not hovering the card itself.
  ns.applyTooltip = function (paragraph, translated, layer) {
    if (!paragraph || !translated || !layer) return null;
    var layerRect = layer.getBoundingClientRect();
    var bbox = paragraph.bbox;

    var zone = document.createElement('div');
    zone.className = 'muxt-pdf-overlay muxt-pdf-tooltip-zone';
    zone.dataset.muxtranslatorSkip = '1';
    zone.dataset.muxtTranslated = translated;
    zone.style.left   = (bbox.left - layerRect.left) + 'px';
    zone.style.top    = (bbox.top  - layerRect.top ) + 'px';
    zone.style.width  = Math.max(1, bbox.right - bbox.left) + 'px';
    zone.style.height = Math.max(1, bbox.bottom - bbox.top) + 'px';

    layer.appendChild(zone);
    return zone;
  };

  // ---------- Cleanup ----------

  ns.removeOverlay = function (overlay) {
    if (overlay && overlay.parentNode) {
      try { overlay.parentNode.removeChild(overlay); } catch (e) {}
    }
  };

  // ---------- Shared hover tooltip for tooltip-mode zones ----------

  var _tip = null;
  function getTip() {
    if (_tip && _tip.isConnected) return _tip;
    _tip = document.createElement('div');
    _tip.id = 'muxt-pdf-tooltip';
    _tip.dataset.muxtranslatorSkip = '1';
    _tip.style.display = 'none';
    (document.body || document.documentElement).appendChild(_tip);
    return _tip;
  }

  function positionTip(tip, anchorRect) {
    var tw = tip.offsetWidth || 320;
    var th = tip.offsetHeight || 40;
    var top = anchorRect.bottom + 6;
    if (top + th > window.innerHeight - 4) {
      top = Math.max(4, anchorRect.top - th - 6);
    }
    var left = anchorRect.left;
    var maxLeft = Math.max(4, window.innerWidth - tw - 8);
    if (left > maxLeft) left = maxLeft;
    if (left < 4) left = 4;
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }

  ns.installTooltipDelegation = function () {
    if (ns._tooltipInstalled) return;
    ns._tooltipInstalled = true;
    document.addEventListener('mouseover', function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains('muxt-pdf-tooltip-zone')) return;
      var translated = t.dataset.muxtTranslated;
      if (!translated) return;
      var tip = getTip();
      tip.textContent = translated;
      tip.style.display = 'block';
      positionTip(tip, t.getBoundingClientRect());
    }, true);
    document.addEventListener('mouseout', function (e) {
      if (!_tip) return;
      var t = e.target;
      if (t && t.classList && t.classList.contains('muxt-pdf-tooltip-zone')) {
        _tip.style.display = 'none';
      }
    }, true);
  };
})(PdfModule);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PdfModule;
}
