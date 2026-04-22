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
}
