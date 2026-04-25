set shell := ["wsl", "bash", "-c"]

version := `node -p "require('./src/manifest.json').version"`
zip_name := "dist/muxtranslator-v" + version + ".zip"

# pdfjs-dist version used by the bundled PDF viewer. Pinned so the vendored
# files and the viewer code (TextLayer API) stay in sync.
pdfjs_version := "4.10.38"

# Build extension zip for browser upload
build:
    @echo "Building v{{version}}..."
    @mkdir -p dist
    @rm -f "{{zip_name}}"
    cd src && zip -r "../{{zip_name}}" .
    @echo "Done: {{zip_name}}"

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
