# MuxTranslator

A Firefox extension that translates web pages using any OpenAI-compatible API — bring your own key and model.

![Logo](img/wordmark-light.png)

## Features

- **Page translation** — translates the entire visible page in-place, preserving layout
- **Streaming output** — translations appear word-by-word as the model generates them
- **Multiple providers** — supports any OpenAI-compatible endpoint, Ollama (local models), and Google Translate
- **Selection translation** — highlight text and click the "译" badge to translate a snippet inline
- **Manual translation** — paste any text into the popup for a quick translation
- **Site rules** — configure per-hostname behavior: always translate, always skip, or ask each time
- **Smart batching** — groups text nodes into batches to minimize API calls; configurable batch size and concurrency
- **Viewport priority** — translates visible elements first, pre-loads off-screen content in the background
- **SPA support** — observes DOM mutations to auto-translate content added by React, Vue, infinite scroll, etc.
- **IndexedDB cache** — caches translations locally so repeated visits don't cost extra API calls
- **Token usage stats** — tracks prompt and completion tokens per provider and per page session
- **Multilingual UI** — interface available in English and Chinese (Simplified)

## Installation

### From Firefox Add-ons (AMO)

Install directly from [addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/muxtranslator/).

### Manual / Development

1. Clone or download this repository
2. Open Firefox and navigate to `about:debugging`
3. Click **This Firefox** → **Load Temporary Add-on**
4. Select the `manifest.json` file from the project folder

## Setup

1. After installation, the settings page opens automatically
2. Click **+ Add** under **Providers** to add your first provider
3. Choose a provider type:
   - **OpenAI-compatible** — enter a Base URL and API key (works with OpenAI, OpenRouter, Groq, etc.)
   - **Ollama** — point at your local Ollama instance (no API key needed)
   - **Google Translate** — enter a Google Cloud API key
4. Select a model, then set it as the default provider
5. Choose a **Target language** and save

## Usage

| Action                    | How                                                            |
| ------------------------- | -------------------------------------------------------------- |
| Translate current page    | Click the toolbar icon →**Translate**                   |
| Pause / resume            | Click**Pause** or **Resume** in the popup          |
| Restore original text     | Click**Restore original** in the popup                   |
| Translate selected text   | Select text on any page → click the**译** badge         |
| Quick translate a snippet | Open popup → paste text into the**Quick translate** box |
| Set a site rule           | Open popup →**This site** section → choose behavior    |

## Configuration

All settings are in the **Options** page (right-click the toolbar icon → Manage Extension → Preferences, or open the popup and click the settings link).

| Setting             | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| Providers           | Add, edit, or delete translation providers                           |
| Feature bindings    | Choose which provider handles page / selection / manual translation  |
| Target language     | The language all translations are rendered in                        |
| Skip languages      | Comma-separated language codes to suppress the auto-translate prompt |
| Auto-detect         | Show a prompt when a foreign-language page is detected               |
| Observe mutations   | Re-translate new content added dynamically by the page               |
| Max chars per batch | Controls batch granularity (larger = fewer calls, slower per call)   |
| Concurrent batches  | How many batches run in parallel                                     |
| Cache               | Enable/disable IndexedDB caching; view entry count; clear cache      |

## Privacy

MuxTranslator does not operate any servers. All text sent for translation goes directly from your browser to the API endpoint you configure. No data is collected or shared by this extension.

Your API keys are stored locally in Firefox's extension storage and are never sent anywhere except to the provider URL you specify.

## License

MIT
