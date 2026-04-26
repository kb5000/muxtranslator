// In-extension PDF viewer. Hosts pdfjs-dist to render PDFs into DOM whose
// structure (.page / .canvasWrapper / .textLayer / span) matches Firefox's
// native PDF viewer, so content.js's PDF pipeline works unmodified.
//
// Why this exists: Firefox's content_scripts cannot reliably inject into
// its native PDF viewer for local file:// URLs. By rendering the PDF inside
// an extension page (moz-extension://) we control the DOM and the scripts
// that run there.
//
// Requires pdfjs-dist v4 ESM build to be vendored at ./pdfjs/ — see the
// `vendor-pdfjs` recipe in the project justfile.

import * as pdfjs from './pdfjs/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.mjs', import.meta.url).href;

const viewerEl   = document.getElementById('viewer');
const fileInput  = document.getElementById('muxt-file-input');
const docTitleEl = document.getElementById('muxt-doc-title');
const statusEl   = document.getElementById('muxt-status');
const emptyState = document.getElementById('muxt-empty-state');
const debugBtn   = document.getElementById('muxt-debug-btn');
const charsBtn   = document.getElementById('muxt-chars-btn');
const devControls = document.getElementById('muxt-dev-controls');
const translateBtn = document.getElementById('muxt-translate-btn');

// ---------- Developer mode ----------
// Controlled from Settings (options page) via the pdfDevMode setting.
// When enabled, the Regions / Chars debug buttons appear in the toolbar.
function setDevMode(on) {
  devControls.hidden = !on;
  if (!on) {
    window.__muxtPdfDebug = false;
    window.__muxtPdfChars = false;
    debugBtn.classList.remove('active');
    charsBtn.classList.remove('active');
    const Pdf = window.PdfModule;
    if (Pdf) { Pdf.clearDebugAll(); Pdf.clearCharBoxesAll(); }
  }
}

// Read pdfDevMode from persisted settings on startup, and apply i18n.
(async () => {
  try {
    await window.i18nInit();
    const res = await window.browser.runtime.sendMessage({ type: 'GET_SETTINGS', payload: {} });
    if (res && res.success) setDevMode(!!res.data.settings.pdfDevMode);
  } catch (e) {}
})();

// Render scale. PDF.js scales the canvas up by devicePixelRatio for crispness.
const RENDER_SCALE = 1.4;

document.addEventListener('dragover', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.items).some(it => it.kind === 'file')) {
    e.preventDefault();
  }
});
document.addEventListener('drop', async (e) => {
  if (!e.dataTransfer) return;
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) { e.preventDefault(); await openFile(file); }
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) await openFile(file);
});

// Research mode: toggle region-visualization overlays on all rendered pages.
// When active, translations are torn down and the PDF aggregator's detected
// paragraphs/lines/columns are painted as coloured rectangles by
// PdfModule.drawDebug (see ../content/pdf.js).
debugBtn.addEventListener('click', () => {
  const on = !window.__muxtPdfDebug;
  window.__muxtPdfDebug = on;
  debugBtn.classList.toggle('active', on);
  const Pdf = window.PdfModule;
  if (on) {
    // Strip any live translation overlays so the debug view is clean.
    try {
      if (window.__muxTranslator && window.__muxTranslator.restorePage) {
        window.__muxTranslator.restorePage();
      }
    } catch (_) {}
    if (Pdf && Pdf.drawDebugAll) Pdf.drawDebugAll();
  } else {
    if (Pdf && Pdf.clearDebugAll) Pdf.clearDebugAll();
  }
});

// Quick-translate button: toggle between translating the current PDF and
// restoring the original. The actual state label is driven by the
// `muxt-engine-changed` event below so popup/auto-translate/site-rule flows
// also keep this button in sync.
translateBtn.addEventListener('click', () => {
  const api = window.__muxTranslator;
  if (!api) return;
  if (translateBtn.classList.contains('active')) {
    try { api.restorePage(); } catch (_) {}
  } else {
    try { api.startEngine(); } catch (_) {}
  }
});

// Listen for engine on/off transitions from content.js regardless of which
// pathway triggered them (this button, popup, auto-translate, site rule…).
window.addEventListener('muxt-engine-changed', (ev) => {
  const active = ev && ev.detail && ev.detail.active;
  setTranslateBtnState(active ? 'active' : 'idle');
});

function setTranslateBtnState(state) {
  // state: 'disabled' | 'idle' | 'active'
  if (!translateBtn) return;
  if (state === 'disabled') {
    translateBtn.disabled = true;
    translateBtn.classList.remove('active');
    translateBtn.querySelector('span').textContent = '翻译';
  } else if (state === 'active') {
    translateBtn.disabled = false;
    translateBtn.classList.add('active');
    translateBtn.querySelector('span').textContent = '还原原文';
  } else {
    translateBtn.disabled = false;
    translateBtn.classList.remove('active');
    translateBtn.querySelector('span').textContent = '翻译';
  }
}

// Orthogonal toggle: per-character bounding boxes. Independent of regions
// so you can stack them (regions + chars together) or view chars alone to
// see the raw PDF content stream without aggregator coloring.
charsBtn.addEventListener('click', () => {
  const on = !window.__muxtPdfChars;
  window.__muxtPdfChars = on;
  charsBtn.classList.toggle('active', on);
  const Pdf = window.PdfModule;
  if (on) {
    try {
      if (window.__muxTranslator && window.__muxTranslator.restorePage) {
        window.__muxTranslator.restorePage();
      }
    } catch (_) {}
    if (Pdf && Pdf.drawCharBoxesAll) Pdf.drawCharBoxesAll();
  } else {
    if (Pdf && Pdf.clearCharBoxesAll) Pdf.clearCharBoxesAll();
  }
});

async function openFile(file) {
  docTitleEl.textContent = file.name;
  statusEl.textContent = 'Loading…';
  emptyState.style.display = 'none';

  // If the previous PDF was translated, wipe overlays and engine state
  // before we rebuild the DOM with a new document.
  try {
    if (window.__muxTranslator && window.__muxTranslator.restorePage) {
      window.__muxTranslator.restorePage();
    }
  } catch (_) {}
  viewerEl.textContent = '';

  try {
    const buf = await file.arrayBuffer();
    await renderDocument(buf);
    statusEl.textContent = '';
    // Tell content.js the PDF is live so it can run its init logic
    // (auto-translate / show bar based on user settings).
    window.dispatchEvent(new CustomEvent('muxt-pdf-loaded'));
    setTranslateBtnState('idle');
  } catch (err) {
    console.error('[MuxTranslator PDF] load failed:', err);
    statusEl.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
  }
}

async function renderDocument(data) {
  const task = pdfjs.getDocument({
    data,
    // These optional asset dirs live next to pdf.mjs. If absent, most PDFs
    // still render; complex CJK / embedded-font PDFs may look degraded but
    // the text layer (what we translate) remains populated.
    cMapUrl: new URL('./pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('./pdfjs/standard_fonts/', import.meta.url).href,
  });
  const pdf = await task.promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    statusEl.textContent = `Page ${i} / ${pdf.numPages}`;
    await renderPage(pdf, i);
  }
}

async function renderPage(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  // DOM structure mirrors Firefox's native PDF viewer so content.js's PDF
  // aggregation doesn't care whether it's running there or here.
  const pageDiv = document.createElement('div');
  pageDiv.className = 'page';
  pageDiv.dataset.pageNumber = String(pageNum);
  pageDiv.style.width  = viewport.width  + 'px';
  pageDiv.style.height = viewport.height + 'px';

  const canvasWrapper = document.createElement('div');
  canvasWrapper.className = 'canvasWrapper';
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.floor(viewport.width  * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width  = viewport.width  + 'px';
  canvas.style.height = viewport.height + 'px';
  canvasWrapper.appendChild(canvas);
  pageDiv.appendChild(canvasWrapper);

  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  textLayerDiv.style.width  = viewport.width  + 'px';
  textLayerDiv.style.height = viewport.height + 'px';
  pageDiv.appendChild(textLayerDiv);

  viewerEl.appendChild(pageDiv);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const textContent = await page.getTextContent();

  // Attach the raw TextContent items + viewport to the layer BEFORE rendering
  // spans. content.js's PDF pipeline reads this data directly (no DOM
  // scraping), so the paragraph aggregator has authoritative geometry the
  // moment the MutationObserver notices new spans appear.
  if (window.PdfModule && window.PdfModule.attachLayerData) {
    window.PdfModule.attachLayerData(textLayerDiv, textContent, viewport);
  }

  // pdfjs v4 API: `new TextLayer({...}).render()`. Fall back to the v3
  // `renderTextLayer` helper for older vendored builds.
  if (typeof pdfjs.TextLayer === 'function') {
    const tl = new pdfjs.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport
    });
    await tl.render();
  } else if (typeof pdfjs.renderTextLayer === 'function') {
    await pdfjs.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
      textDivs: []
    }).promise;
  }

  // If research mode is on, paint the aggregator's detected regions onto
  // this freshly-rendered layer. drawDebug is a no-op on empty layers.
  if (window.__muxtPdfDebug && window.PdfModule && window.PdfModule.drawDebug) {
    try { window.PdfModule.drawDebug(textLayerDiv); } catch (_) {}
  }
  if (window.__muxtPdfChars && window.PdfModule && window.PdfModule.drawCharBoxes) {
    try { window.PdfModule.drawCharBoxes(textLayerDiv); } catch (_) {}
  }
}
