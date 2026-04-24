// PDF translation support driven by pdf.js's structured TextContent items.
//
// viewer.js attaches each page's raw `textContent.items` + `viewport` onto
// its .textLayer div; this module reads that data for paragraph aggregation.
// Overlays support multi-layer cycling: when two translated paragraphs overlap
// the user can click to cycle through layers, or right-click to pick one.

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

  // ---------- Data attachment (called by viewer.js) ----------

  ns.attachLayerData = function (layer, textContent, viewport) {
    if (!layer) return;
    layer._muxtPdfItems    = (textContent && textContent.items) || [];
    layer._muxtPdfViewport = viewport || null;
  };

  // ---------- Geometry ----------

  function composeTransform(vt, it) {
    return [
      vt[0]*it[0] + vt[2]*it[1],
      vt[1]*it[0] + vt[3]*it[1],
      vt[0]*it[2] + vt[2]*it[3],
      vt[1]*it[2] + vt[3]*it[3],
      vt[0]*it[4] + vt[2]*it[5] + vt[4],
      vt[1]*it[4] + vt[3]*it[5] + vt[5]
    ];
  }

  function itemToRect(item, viewport) {
    var t = composeTransform(viewport.transform, item.transform);
    var fontHeight = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 12;
    var width      = Math.max(0, (item.width || 0) * viewport.scale);
    var baseline   = t[5];
    return {
      left:     t[4],
      right:    t[4] + width,
      top:      baseline - fontHeight,
      bottom:   baseline,
      height:   fontHeight,
      baseline: baseline
    };
  }

  // ---------- Text classification ----------

  function isCJKChar(ch) {
    if (!ch) return false;
    var code = ch.charCodeAt(0);
    return (code >= 0x3040 && code <= 0x30FF) ||
           (code >= 0x3400 && code <= 0x9FFF) ||
           (code >= 0xAC00 && code <= 0xD7AF) ||
           (code >= 0xFF00 && code <= 0xFFEF);
  }

  function endsSentence(text) {
    if (!text) return false;
    var t = text.replace(/\s+$/, '');
    return t ? /[.!?。！？؟][)"'"'\]]*$/.test(t) : false;
  }

  function hasVisibleText(s) {
    if (!s) return false;
    return /[^\s\u0000-\u001F\u007F\u00A0\u00AD\u180E\u200B-\u200F\u2028-\u202F\u2060-\u206F\u2800\uFEFF\uFFFC\uFFFD]/.test(s);
  }

  // ---------- Line / paragraph aggregation ----------

  function buildLines(rawItems, viewport) {
    var lines = [];
    var curItems = [], curBaseline = null, curHeight = 12;

    function flush() {
      if (!curItems.length) { curBaseline = null; return; }
      var left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      var text = '';
      for (var i = 0; i < curItems.length; i++) {
        var it = curItems[i];
        if (it.rect.left   < left)   left   = it.rect.left;
        if (it.rect.right  > right)  right  = it.rect.right;
        if (it.rect.top    < top)    top    = it.rect.top;
        if (it.rect.bottom > bottom) bottom = it.rect.bottom;
        text += it.str;
      }
      lines.push({
        items:    curItems,
        text:     text.replace(/[ \t\u00A0]+/g, ' '),
        bbox:     { left: left, right: right, top: top, bottom: bottom },
        baseline: curBaseline,
        height:   curHeight
      });
      curItems = []; curBaseline = null; curHeight = 12;
    }

    for (var i = 0; i < rawItems.length; i++) {
      var item = rawItems[i];
      if (!item || typeof item.str !== 'string') continue;
      if (item.str === '' && !item.hasEOL) continue;
      var rect = itemToRect(item, viewport);
      if (!isFinite(rect.baseline)) continue;

      if (curItems.length && curBaseline !== null) {
        var tol = Math.max(rect.height, curHeight) * 0.5;
        if (Math.abs(rect.baseline - curBaseline) > tol) flush();
      }
      if (!curItems.length) {
        curBaseline = rect.baseline;
        curHeight   = rect.height;
      } else if (rect.height > curHeight) {
        curHeight = rect.height;
      }
      curItems.push({ str: item.str, rect: rect, hasEOL: !!item.hasEOL });
      if (item.hasEOL) flush();
    }
    flush();

    var out = [];
    for (var k = 0; k < lines.length; k++) {
      if (hasVisibleText(lines[k].text)) out.push(lines[k]);
    }
    return out;
  }

  function buildParagraphs(lines) {
    var paras = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!paras.length) { paras.push(makePara(line)); continue; }
      var p    = paras[paras.length - 1];
      var prev = p.lines[p.lines.length - 1];
      var lh   = Math.max(line.height, prev.height, 1);
      var gap  = line.bbox.top - prev.bbox.bottom;

      var pageWrap     = gap < -lh * 0.5;
      var bigGap       = gap > lh * 0.9;
      var bigShift     = Math.abs(line.bbox.left - p.bbox.left) > lh * 4;
      var indentStart  = (line.bbox.left - p.bbox.left) > lh * 1.2;

      if (pageWrap || bigGap || bigShift || (endsSentence(prev.text) && indentStart)) {
        paras.push(makePara(line));
      } else {
        p.lines.push(line);
        for (var k = 0; k < line.items.length; k++) p.items.push(line.items[k]);
        if (line.bbox.top    < p.bbox.top)    p.bbox.top    = line.bbox.top;
        if (line.bbox.bottom > p.bbox.bottom) p.bbox.bottom = line.bbox.bottom;
        if (line.bbox.left   < p.bbox.left)   p.bbox.left   = line.bbox.left;
        if (line.bbox.right  > p.bbox.right)  p.bbox.right  = line.bbox.right;
      }
    }
    for (var m = 0; m < paras.length; m++) paras[m].text = stitchParagraphText(paras[m]);
    return paras;
  }

  function makePara(line) {
    return {
      lines: [line], items: line.items.slice(),
      bbox: { left: line.bbox.left, right: line.bbox.right,
              top: line.bbox.top,   bottom: line.bbox.bottom }
    };
  }

  function stitchParagraphText(para) {
    var out = '';
    for (var i = 0; i < para.lines.length; i++) {
      var line = para.lines[i].text.replace(/^\s+|\s+$/g, '');
      if (!line) continue;
      if (!out) { out = line; continue; }
      var lc = out.charAt(out.length - 1), fc = line.charAt(0);
      if (lc === '-' && /[a-z]/i.test(fc)) {
        out = out.slice(0, -1) + line;
      } else if (isCJKChar(lc) && isCJKChar(fc)) {
        out += line;
      } else {
        out += ' ' + line;
      }
    }
    return out;
  }

  // ---------- Main entry ----------

  ns.groupIntoParagraphs = function (layer) {
    if (!layer) return [];
    var items    = layer._muxtPdfItems;
    var viewport = layer._muxtPdfViewport;
    if (!items || !items.length || !viewport) return [];
    return buildParagraphs(buildLines(items, viewport));
  };

  // ---------- Font metrics ----------

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
  }

  function computeFontMetrics(paragraph) {
    var heights = [];
    for (var i = 0; i < paragraph.items.length; i++) {
      var h = paragraph.items[i].rect.height;
      if (h > 0) heights.push(h);
    }
    var medH = median(heights) || 12;
    var fontSize = medH * 0.88;
    var lineHeight = 1.2;
    if (paragraph.lines.length >= 2) {
      var gaps = [];
      for (var j = 1; j < paragraph.lines.length; j++) {
        var g = paragraph.lines[j].baseline - paragraph.lines[j-1].baseline;
        if (g > 0) gaps.push(g);
      }
      var medGap = median(gaps);
      if (medGap > 0 && fontSize > 0) {
        var r = medGap / fontSize;
        if (r > 0.9 && r < 2.2) lineHeight = r;
      }
    }
    return { fontSize: fontSize, lineHeight: lineHeight };
  }

  // ---------- Overlay layer / group cycling ----------
  //
  // When two or more translated overlays occupy the same visual region, they
  // form a "cycle group". Left-clicking the topmost overlay advances to the
  // next; right-clicking opens a picker menu so any layer can be selected
  // directly. A small "N/M" badge confirms the current position.

  var groupsByLayer = new WeakMap(); // WeakMap<layer, Map<gid, Group>>
  var overlayMeta   = new WeakMap(); // WeakMap<overlay, {gid, gmap}>
  var _gSeq = 0;

  function getGmap(layer) {
    var m = groupsByLayer.get(layer);
    if (!m) { m = new Map(); groupsByLayer.set(layer, m); }
    return m;
  }

  function rectsOverlap(a, b) {
    return !(a.right <= b.left || a.left >= b.right ||
             a.bottom <= b.top || a.top >= b.bottom);
  }

  function liveEntries(group) {
    return group.entries.filter(function (e) { return e.overlay.isConnected; });
  }

  // Assign a newly placed overlay to a cycle group, merging any groups whose
  // overlays it overlaps with. Sets up click/right-click handlers the first
  // time each overlay joins a multi-member group.
  function joinGroup(layer, overlay, rect) {
    var gmap = getGmap(layer);
    var hitGids = [];
    gmap.forEach(function (group, gid) {
      var live = liveEntries(group);
      for (var i = 0; i < live.length; i++) {
        if (rectsOverlap(rect, live[i].rect)) { hitGids.push(gid); break; }
      }
    });

    var entry = { overlay: overlay, rect: rect, _h: false };
    var newGid = 'g' + (++_gSeq);

    if (!hitGids.length) {
      var solo = { entries: [entry], cyclePos: 0 };
      gmap.set(newGid, solo);
      overlayMeta.set(overlay, { gid: newGid, gmap: gmap });
      // Even single-member groups are clickable, because the cycle now
      // always includes a "show original" state as its last position.
      addGroupHandlers(solo, newGid, gmap);
      applyCycleState(solo);
      return;
    }

    // Merge all hit groups
    var merged = [];
    hitGids.forEach(function (gid) {
      gmap.get(gid).entries.forEach(function (e) { merged.push(e); });
      gmap.delete(gid);
    });
    merged.push(entry);

    var group = { entries: merged, cyclePos: 0 };
    gmap.set(newGid, group);
    merged.forEach(function (e) {
      overlayMeta.set(e.overlay, { gid: newGid, gmap: gmap });
    });

    addGroupHandlers(group, newGid, gmap);
    applyCycleState(group);
  }

  function addGroupHandlers(group, gid, gmap) {
    group.entries.forEach(function (entry) {
      if (entry._h) return;
      entry._h = true;

      entry.overlay.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var meta = overlayMeta.get(entry.overlay);
        if (!meta) return;
        var g = meta.gmap.get(meta.gid);
        if (!g) return;
        var live = liveEntries(g);
        if (!live.length) return;
        var total = live.length + 1; // +1 = "show original"
        g.cyclePos = (g.cyclePos + 1) % total;
        applyCycleState(g);
        showCycleBadgeForState(g, live);
      });

      entry.overlay.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var meta = overlayMeta.get(entry.overlay);
        if (!meta) return;
        var g = meta.gmap.get(meta.gid);
        if (!g) return;
        var live = liveEntries(g);
        if (!live.length) return;
        showCycleMenu(ev.clientX, ev.clientY, g, live);
      });
    });
  }

  // Cycle positions: 0..live.length-1 show that layer as active (full fill);
  // position live.length is the "show original" state. In every state the
  // non-active members stay visible as dashed outlines so the user can see
  // there are additional boxes to click.
  function applyCycleState(group) {
    var live = liveEntries(group);
    if (!live.length) return;
    var total = live.length + 1;
    var pos = ((group.cyclePos % total) + total) % total;
    var showingOriginal = (pos === live.length);

    live.forEach(function (e, i) {
      var isActive = !showingOriginal && i === pos;
      e.overlay.classList.toggle('muxt-pdf-ghost', !isActive);
      e.overlay.style.opacity       = '';
      e.overlay.style.pointerEvents = 'auto';
      // Keep stacking deterministic — active overlay on top; among ghosts the
      // first member receives clicks when several are stacked at one point.
      if (isActive)          e.overlay.style.zIndex = '15';
      else if (i === 0)      e.overlay.style.zIndex = '13';
      else                   e.overlay.style.zIndex = '12';
    });
  }

  function showCycleBadgeForState(group, live) {
    var total = live.length + 1;
    var pos = ((group.cyclePos % total) + total) % total;
    if (pos === live.length) {
      showCycleBadge(live[0].overlay, '原文');
    } else {
      // Denominator counts layers only — "原文" is a separate state.
      showCycleBadge(live[pos].overlay, (pos + 1) + ' / ' + live.length);
    }
  }

  // ---------- Cycle badge ----------

  var _badge = null, _badgeTimer = null;

  function getCycleBadge() {
    if (_badge && _badge.isConnected) return _badge;
    _badge = document.createElement('div');
    _badge.id = 'muxt-cycle-badge';
    _badge.dataset.muxtranslatorSkip = '1';
    _badge.style.display = 'none';
    (document.body || document.documentElement).appendChild(_badge);
    return _badge;
  }

  function showCycleBadge(activeOverlay, text) {
    var b = getCycleBadge();
    var r = activeOverlay.getBoundingClientRect();
    b.textContent = text;
    b.style.left    = Math.max(4, r.right - 48) + 'px';
    b.style.top     = (r.top + 4) + 'px';
    b.style.display = 'block';
    clearTimeout(_badgeTimer);
    _badgeTimer = setTimeout(function () { b.style.display = 'none'; }, 2500);
  }

  // ---------- Cycle context menu ----------

  var _menu = null;

  function getCycleMenu() {
    if (_menu && _menu.isConnected) return _menu;
    _menu = document.createElement('div');
    _menu.id = 'muxt-cycle-menu';
    _menu.dataset.muxtranslatorSkip = '1';
    _menu.style.display = 'none';
    (document.body || document.documentElement).appendChild(_menu);
    document.addEventListener('mousedown', function (e) {
      if (_menu && _menu.style.display !== 'none' && !_menu.contains(e.target)) {
        _menu.style.display = 'none';
      }
    }, true);
    return _menu;
  }

  function showCycleMenu(cx, cy, group, live) {
    var menu = getCycleMenu();
    menu.innerHTML = '';
    var total = live.length + 1;
    var active = ((group.cyclePos % total) + total) % total;
    live.forEach(function (e, i) {
      var item = document.createElement('div');
      item.className = 'muxt-cycle-menu-item' + (i === active ? ' active' : '');
      var snippet = (e.overlay.textContent || '').replace(/\s+/g, ' ').trim();
      if (snippet.length > 48) snippet = snippet.slice(0, 48) + '\u2026';
      item.textContent = '\u5c42 ' + (i + 1) + '\uff1a ' + snippet;
      item.addEventListener('click', function (ev) {
        ev.stopPropagation();
        group.cyclePos = i;
        applyCycleState(group);
        showCycleBadgeForState(group, live);
        menu.style.display = 'none';
      });
      menu.appendChild(item);
    });
    // "Show original" entry — last cycle position, hides all translations.
    var origIdx = live.length;
    var origItem = document.createElement('div');
    origItem.className = 'muxt-cycle-menu-item muxt-cycle-menu-original'
                      + (active === origIdx ? ' active' : '');
    origItem.textContent = '\u663e\u793a\u539f\u6587';
    origItem.addEventListener('click', function (ev) {
      ev.stopPropagation();
      group.cyclePos = origIdx;
      applyCycleState(group);
      showCycleBadgeForState(group, live);
      menu.style.display = 'none';
    });
    menu.appendChild(origItem);

    menu.style.display = 'block';
    menu.style.left = cx + 'px';
    menu.style.top  = cy + 'px';
    // Clamp within viewport after paint
    requestAnimationFrame(function () {
      var mw = menu.offsetWidth, mh = menu.offsetHeight;
      if (cx + mw > window.innerWidth  - 8) menu.style.left = Math.max(4, cx - mw) + 'px';
      if (cy + mh > window.innerHeight - 8) menu.style.top  = Math.max(4, cy - mh) + 'px';
    });
  }

  // ---------- Overlay application ----------

  ns.applyReplace = function (paragraph, translated, layer) {
    if (!paragraph || !translated || !layer) return null;
    var bbox   = paragraph.bbox;
    var layerW = layer.clientWidth  || bbox.right;
    var layerH = layer.clientHeight || bbox.bottom;
    var left   = Math.max(0, bbox.left);
    var top    = Math.max(0, bbox.top);
    var right  = Math.min(layerW, bbox.right);
    var bottom = Math.min(layerH, bbox.bottom);
    var width  = Math.max(1, right  - left);
    var height = Math.max(1, bottom - top);

    var overlay = document.createElement('div');
    overlay.className = 'muxt-pdf-overlay muxt-pdf-replace';
    overlay.dataset.muxtranslatorSkip = '1';
    overlay.textContent = translated;
    overlay.style.left      = left   + 'px';
    overlay.style.top       = top    + 'px';
    overlay.style.width     = width  + 'px';
    // Use min-height so translations that need more vertical space can grow
    // downward instead of being clipped. We measure the real height after
    // layout and use that for overlap/cycle-group membership.
    overlay.style.minHeight = height + 'px';

    try {
      var fm = computeFontMetrics(paragraph);
      var fs = fm.fontSize;
      var origLen = (paragraph.text || '').length || 1;
      var newLen  = translated.length || 1;
      if (newLen > origLen * 1.15) {
        var scale = Math.sqrt(origLen / newLen);
        if (scale < 0.65) scale = 0.65;
        fs *= scale;
      }
      if (fs && isFinite(fs) && fs > 4)   overlay.style.fontSize   = fs + 'px';
      if (isFinite(fm.lineHeight))         overlay.style.lineHeight = fm.lineHeight.toFixed(2);
    } catch (e) {}

    layer.appendChild(overlay);

    // Measure the actual rendered height (may exceed the original bbox if the
    // translation wraps to more lines) and clamp to the page bottom so the
    // overlay never spills past the page edge.
    var actualH = Math.max(height, overlay.offsetHeight || height);
    if (top + actualH > layerH) actualH = Math.max(height, layerH - top);

    // Register with the cycle system using the *actual* extent so overlays
    // that grew taller merge with anything they now visually overlap.
    joinGroup(layer, overlay, {
      left:   left,
      top:    top,
      right:  left + width,
      bottom: top + actualH
    });

    return overlay;
  };

  ns.applyTooltip = function (paragraph, translated, layer) {
    if (!paragraph || !translated || !layer) return null;
    var bbox = paragraph.bbox;
    var zone = document.createElement('div');
    zone.className = 'muxt-pdf-overlay muxt-pdf-tooltip-zone';
    zone.dataset.muxtranslatorSkip = '1';
    zone.dataset.muxtTranslated = translated;
    zone.style.left   = bbox.left + 'px';
    zone.style.top    = bbox.top  + 'px';
    zone.style.width  = Math.max(1, bbox.right  - bbox.left) + 'px';
    zone.style.height = Math.max(1, bbox.bottom - bbox.top ) + 'px';
    layer.appendChild(zone);
    return zone;
  };

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
    var tw = tip.offsetWidth || 320, th = tip.offsetHeight || 40;
    var top = anchorRect.bottom + 6;
    if (top + th > window.innerHeight - 4) top = Math.max(4, anchorRect.top - th - 6);
    var left = Math.min(anchorRect.left, Math.max(4, window.innerWidth - tw - 8));
    if (left < 4) left = 4;
    tip.style.top = top + 'px'; tip.style.left = left + 'px';
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
      if (e.target && e.target.classList && e.target.classList.contains('muxt-pdf-tooltip-zone')) {
        _tip.style.display = 'none';
      }
    }, true);
  };

  // ---------- Research / debug visualization ----------

  var DEBUG_PALETTE = [
    '#e53935','#1e88e5','#43a047','#fb8c00',
    '#8e24aa','#00acc1','#f4511e','#3949ab',
    '#c0ca33','#d81b60'
  ];

  function hexToRgba(hex, a) {
    var n = parseInt(hex.replace('#',''), 16);
    return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';
  }

  ns.drawDebug = function (layer) {
    if (!layer || !layer.isConnected) return;
    ns.clearDebug(layer);
    var paras = ns.groupIntoParagraphs(layer);
    if (!paras.length) return;
    var frag = document.createDocumentFragment();
    for (var p = 0; p < paras.length; p++) {
      var para = paras[p], color = DEBUG_PALETTE[p % DEBUG_PALETTE.length];
      for (var l = 0; l < para.lines.length; l++) {
        var lb = para.lines[l].bbox;
        var box = document.createElement('div');
        box.className = 'muxt-pdf-debug muxt-pdf-debug-line';
        box.dataset.muxtranslatorSkip = '1';
        box.style.left   = lb.left + 'px';
        box.style.top    = lb.top  + 'px';
        box.style.width  = Math.max(1, lb.right  - lb.left) + 'px';
        box.style.height = Math.max(1, lb.bottom - lb.top ) + 'px';
        box.style.background  = hexToRgba(color, 0.14);
        box.style.borderColor = color;
        box.title = 'P' + p + ' L' + l + ' · ' + para.lines[l].items.length + 'I\n' + para.lines[l].text;
        frag.appendChild(box);
      }
      var head = para.lines[0].bbox;
      var lbl = document.createElement('div');
      lbl.className = 'muxt-pdf-debug muxt-pdf-debug-label';
      lbl.dataset.muxtranslatorSkip = '1';
      lbl.textContent = 'P' + p + ' · ' + para.lines.length + 'L · ' + para.items.length + 'I';
      lbl.style.left       = head.left + 'px';
      lbl.style.top        = Math.max(0, head.top - 13) + 'px';
      lbl.style.background = color;
      frag.appendChild(lbl);
    }
    layer.appendChild(frag);
  };

  ns.clearDebug = function (layer) {
    if (!layer) return;
    var nodes = layer.querySelectorAll('.muxt-pdf-debug');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  };

  ns.drawDebugAll  = function () { document.querySelectorAll('.textLayer').forEach(ns.drawDebug);  };
  ns.clearDebugAll = function () { document.querySelectorAll('.textLayer').forEach(ns.clearDebug); };

  // ---------- Per-item visualization ----------

  ns.drawCharBoxes = function (layer) {
    if (!layer || !layer.isConnected) return;
    ns.clearCharBoxes(layer);
    var items    = layer._muxtPdfItems;
    var viewport = layer._muxtPdfViewport;
    if (!items || !viewport) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || !item.str || !item.str.trim()) continue;
      var rect = itemToRect(item, viewport);
      var hue  = (i * 61) % 360;
      var box  = document.createElement('div');
      box.className = 'muxt-pdf-char-box';
      box.dataset.muxtranslatorSkip = '1';
      box.style.left        = rect.left + 'px';
      box.style.top         = rect.top  + 'px';
      box.style.width       = Math.max(1, rect.right  - rect.left) + 'px';
      box.style.height      = Math.max(1, rect.bottom - rect.top ) + 'px';
      box.style.borderColor = 'hsl(' + hue + ',85%,45%)';
      box.title = 'item ' + i + ': "' + item.str + '"' + (item.hasEOL ? ' [EOL]' : '');
      frag.appendChild(box);
    }
    layer.appendChild(frag);
  };

  ns.clearCharBoxes = function (layer) {
    if (!layer) return;
    var nodes = layer.querySelectorAll('.muxt-pdf-char-box');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  };

  ns.drawCharBoxesAll  = function () { document.querySelectorAll('.textLayer').forEach(ns.drawCharBoxes);  };
  ns.clearCharBoxesAll = function () { document.querySelectorAll('.textLayer').forEach(ns.clearCharBoxes); };

})(PdfModule);

if (typeof module !== 'undefined' && module.exports) module.exports = PdfModule;
