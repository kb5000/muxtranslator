# MuxTranslator

A Firefox extension that translates web pages and PDFs using any OpenAI-compatible API — bring your own key and model.

![Logo](img/wordmark-light.png)

## Features

### Translation Modes

- **Page translation** — translates the entire visible page in-place, preserving layout and structure
- **PDF translation** — built-in PDF viewer with overlay-based translation; no external tools needed
- **Selection translation** — highlight text on any page and click the "译" badge to translate inline
- **Manual translation** — paste any text into the popup for a quick ad-hoc translation

### Display Options

- **Bilingual display** — choose between translation-only, original + translation side-by-side, or hover tooltip
- **Streaming output** — translations appear word-by-word as the model generates them
- **Auto-detect** — shows a prompt when a foreign-language page is detected

### Provider Support

- **OpenAI-compatible** — works with OpenAI, OpenRouter, Groq, or any endpoint that follows the OpenAI API
- **Ollama** — local model support via Ollama's API; no API key required
- **Google Translate** — Google Cloud Translation API v2
- **DeepL** — DeepL API (free or paid tier)
- **LibreTranslate** — self-hosted or public LibreTranslate instances
- **Feature bindings** — assign different providers to page, selection, manual, and PDF translation independently

### Performance

- **Viewport priority** — translates visible elements first, pre-loads off-screen content in the background
- **Smart batching** — groups text nodes into configurable batches to minimize API calls
- **IndexedDB cache** — caches translations locally so repeated visits reuse results without extra API calls
- **SPA support** — observes DOM mutations to auto-translate content added by React, Vue, infinite scroll, etc.
- **Token usage stats** — tracks prompt and completion tokens per provider and per page session

### Advanced

- **Glossary** — define per-provider term → translation mappings that are injected into every LLM prompt
- **Tool-call mode** — optionally use function calling instead of separator-based parsing for more reliable JSON output from LLM providers
- **Site rules** — configure per-hostname behavior: always translate, always skip, or ask each time
- **Mobile support** — responsive design works on phones and tablets with touch-friendly controls
- **Multilingual UI** — interface available in English and Chinese (Simplified)

## Installation

### From Firefox Add-ons (AMO)

Install directly from [addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/muxtranslator/).

### Manual / Development

1. Clone or download this repository
2. Run `just vendor-pdfjs` once to download the bundled PDF.js library
3. Open Firefox and navigate to `about:debugging`
4. Click **This Firefox** → **Load Temporary Add-on**
5. Select the `src/manifest.json` file from the project folder

## Setup

1. After installation, the settings page opens automatically
2. Click **+ Add** under **Providers** to add your first provider
3. Choose a provider type:
   - **OpenAI-compatible** — enter a Base URL and API key (works with OpenAI, OpenRouter, Groq, etc.)
   - **Ollama** — point at your local Ollama instance (no API key needed)
   - **Google Translate** — enter a Google Cloud API key
   - **DeepL** — enter your DeepL API key and select free or paid tier
   - **LibreTranslate** — enter the instance URL and optional API key
4. Select a model, then set it as the default provider
5. Choose a **Target language** and save

## Usage

| Action | How |
| --- | --- |
| Translate current page | Click the toolbar icon → **Translate** |
| Pause / resume | Click **Pause** or **Resume** in the popup |
| Restore original text | Click **Restore original** in the popup |
| Translate a PDF | Click **📄 Open PDF** in the popup to open the built-in viewer |
| Toggle bilingual display | Popup → **Bilingual display** section → choose display mode |
| Translate selected text | Select text on any page → click the **译** badge |
| Quick translate a snippet | Open popup → paste text into the **Quick translate** box |
| Set a site rule | Open popup → **This site** section → choose behavior |

## Configuration

All settings are on the **Options** page (right-click the toolbar icon → Manage Extension → Preferences, or click the settings link in the popup).

| Setting | Description |
| --- | --- |
| Providers | Add, edit, or delete translation providers |
| Feature bindings | Choose which provider handles page / selection / manual / PDF translation |
| Target language | The language all translations are rendered in |
| Skip languages | Comma-separated language codes to suppress the auto-translate prompt |
| Auto-detect | Show a prompt when a foreign-language page is detected |
| Observe mutations | Re-translate new content added dynamically by the page |
| Max chars per batch | Controls batch granularity (larger = fewer calls, slower per call) |
| Concurrent batches | How many batches run in parallel |
| Glossary | Per-provider term → translation mappings injected into LLM prompts |
| Cache | Enable/disable IndexedDB caching; view entry count; clear cache |

## Privacy

MuxTranslator does not operate any servers. All text sent for translation goes directly from your browser to the API endpoint you configure. No data is collected or shared by this extension.

Your API keys are stored locally in Firefox's extension storage and are never sent anywhere except to the provider URL you specify.

## License

MIT
