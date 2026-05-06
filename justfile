set shell := ["wsl", "bash", "-c"]

version := `node -p "require('./src/manifest.firefox.json').version"`

# pdfjs-dist version used by the bundled PDF viewer. Pinned so the vendored
# files and the viewer code (TextLayer API) stay in sync.
pdfjs_version := "4.10.38"

# Translate missing i18n keys in all locale files from en/messages.json
i18n:
    node scripts/translate-locales.js

# Switch active manifest to Firefox (for unpacked dev in Firefox)
use-firefox:
    ln -sf manifest.firefox.json src/manifest.json
    @echo "Switched to Firefox manifest."

# Switch active manifest to Chrome (for unpacked dev in Chrome)
use-chrome:
    ln -sf manifest.chrome.json src/manifest.json
    @echo "Switched to Chrome manifest."

# Build both Firefox and Chrome zips
build: build-firefox build-chrome

# Build Firefox extension zip
build-firefox:
    @echo "Building Firefox v{{version}}..."
    @mkdir -p dist
    @rm -f "dist/muxtranslator-firefox-v{{version}}.zip"
    rm -f src/manifest.json && cp src/manifest.firefox.json src/manifest.json
    cd src && zip -r "../dist/muxtranslator-firefox-v{{version}}.zip" . -x "manifest.firefox.json" -x "manifest.chrome.json"
    ln -sf manifest.firefox.json src/manifest.json
    @echo "Done: dist/muxtranslator-firefox-v{{version}}.zip"

# Build Chrome extension zip
build-chrome:
    @echo "Building Chrome v{{version}}..."
    @mkdir -p dist
    @rm -f "dist/muxtranslator-chrome-v{{version}}.zip"
    rm -f src/manifest.json && cp src/manifest.chrome.json src/manifest.json
    cd src && zip -r "../dist/muxtranslator-chrome-v{{version}}.zip" . -x "manifest.firefox.json" -x "manifest.chrome.json"
    ln -sf manifest.firefox.json src/manifest.json
    @echo "Done: dist/muxtranslator-chrome-v{{version}}.zip"

# Download pdfjs-dist and vendor the ESM build + optional asset dirs into
# src/viewer/pdfjs/. Run once after cloning; re-run to bump the pinned version.
vendor-pdfjs:
    @echo "Vendoring pdfjs-dist v{{pdfjs_version}}..."
    @mkdir -p src/viewer/pdfjs
    @rm -rf /tmp/muxt-pdfjs
    @mkdir -p /tmp/muxt-pdfjs
    curl -sSL "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-{{pdfjs_version}}.tgz" -o /tmp/muxt-pdfjs/pdfjs.tgz
    tar -xzf /tmp/muxt-pdfjs/pdfjs.tgz -C /tmp/muxt-pdfjs
    cp /tmp/muxt-pdfjs/package/build/pdf.mjs src/viewer/pdfjs/
    cp /tmp/muxt-pdfjs/package/build/pdf.worker.mjs src/viewer/pdfjs/
    @# cmaps & standard_fonts are optional — needed for some CJK / embedded-font PDFs.
    @# Comment these out if you want to ship a smaller zip.
    cp -r /tmp/muxt-pdfjs/package/cmaps src/viewer/pdfjs/
    cp -r /tmp/muxt-pdfjs/package/standard_fonts src/viewer/pdfjs/
    @rm -rf /tmp/muxt-pdfjs
    @echo "Vendored: src/viewer/pdfjs/"
