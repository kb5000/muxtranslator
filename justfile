version := `node -p "require('./src/manifest.json').version"`
zip_name := "dist/muxtranslator-v" + version + ".zip"

# Build extension zip for browser upload
build:
    @echo "Building v{{version}}..."
    @mkdir -p dist
    @rm -f "{{zip_name}}"
    cd src && zip -r "../{{zip_name}}" .
    @echo "Done: {{zip_name}}"
