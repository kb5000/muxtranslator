#!/usr/bin/env node
/**
 * translate-locales.js
 *
 * Generates or updates locale files under src/_locales/ using an
 * OpenAI-compatible translation API. English (en) is the source of truth.
 * Only missing keys are translated by default.
 *
 * Usage:
 *   node scripts/translate-locales.js
 *   node scripts/translate-locales.js --locale ja
 *   node scripts/translate-locales.js --locale xx_YY --lang "Language Name"
 *   node scripts/translate-locales.js --force          # retranslate all keys
 *   node scripts/translate-locales.js --keys ruleAlways,ruleSkip  # retranslate specific keys in all locales
 *
 * Config — create scripts/.env (or project-root .env) with:
 *   OPENAI_BASE_URL=https://api.openai.com/v1
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_MODEL=gpt-4o-mini
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'src', '_locales');
const BATCH_SIZE = 25;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadEnv() {
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(ROOT, '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
        if (m) {
          const val = m[2].trim().replace(/^["']|["']$/g, '');
          if (!(m[1] in process.env)) process.env[m[1]] = val;
        }
      }
      console.log(`Loaded config from ${p}`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Language name map (locale code → human-readable name for the LLM)
// ---------------------------------------------------------------------------

const LANG_NAMES = {
  zh_CN: 'Simplified Chinese (zh-CN)',
  zh_TW: 'Traditional Chinese (zh-TW)',
  ja:    'Japanese',
  ko:    'Korean',
  fr:    'French',
  de:    'German',
  es:    'Spanish',
  pt_BR: 'Brazilian Portuguese',
  pt_PT: 'European Portuguese',
  ru:    'Russian',
  ar:    'Arabic',
  hi:    'Hindi',
  it:    'Italian',
  nl:    'Dutch',
  pl:    'Polish',
  tr:    'Turkish',
  vi:    'Vietnamese',
  th:    'Thai',
  id:    'Indonesian',
  uk:    'Ukrainian',
  sv:    'Swedish',
  da:    'Danish',
  fi:    'Finnish',
  nb:    'Norwegian Bokmål',
  cs:    'Czech',
  ro:    'Romanian',
  hu:    'Hungarian',
};

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `\
You are translating UI strings for MuxTranslator, a Firefox browser extension \
that translates web pages and PDFs using LLM APIs (OpenAI-compatible, Ollama, \
Google Translate, DeepL, LibreTranslate).

Rules:
- Keep translations short — these are UI labels, buttons, and status messages.
- Use natural, idiomatic phrasing in the target language.
- Preserve ALL $PLACEHOLDER$ tokens exactly as written (dollar signs, \
uppercase, case-sensitive). Never translate or reword them.
- Do not translate these proper nouns: MuxTranslator, OpenAI, Ollama, \
Google Translate, DeepL, LibreTranslate, PDF, IndexedDB, Token, API, URL, JSON.
- Return ONLY a raw JSON object. No markdown fences, no extra text.`;

async function translateBatch(entries, langName) {
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey  = process.env.OPENAI_API_KEY;
  const model   = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  if (!apiKey) throw new Error('OPENAI_API_KEY is not set. See scripts/.env.example.');

  // Build a rich context object so the model understands each string's role.
  // Key names like "statusCacheCleared" or "btnDelete" are very informative.
  const input = {};
  for (const { key, message } of entries) {
    const placeholders = [...message.matchAll(/\$([A-Z_]+)\$/g)].map(m => m[1]);
    input[key] = placeholders.length
      ? { message, preserve_placeholders: placeholders }
      : { message };
  }

  const userPrompt = [
    `Translate each "message" value to ${langName}.`,
    `Context: each JSON key is the UI string identifier (e.g. "btnDelete" = a delete button, "statusCacheCleared" = a status message shown after clearing cache).`,
    `Strings with "preserve_placeholders" must keep those $TOKENS$ unchanged.`,
    ``,
    `Input:`,
    JSON.stringify(input, null, 2),
    ``,
    `Return: { "key": "translated message", ... }`,
  ].join('\n');

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.1,
    }),
  });

  // console.log(await res.text());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  let content = data.choices[0].message.content.trim();

  // Strip markdown code fences in case the model added them anyway
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse model response as JSON:\n${content}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function withRetry(fn, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      process.stdout.write(`\n  Attempt ${attempt} failed: ${err.message.split('\n')[0]} — retrying in ${delayMs / 1000}s… `);
      await new Promise(r => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
}

// ---------------------------------------------------------------------------
// Validation: warn if a placeholder in the original is missing in translation
// ---------------------------------------------------------------------------

function validatePlaceholders(key, original, translated) {
  const srcTokens = [...original.matchAll(/\$([A-Z_]+)\$/g)].map(m => m[0]);
  for (const token of srcTokens) {
    if (!translated.includes(token)) {
      console.warn(`  ⚠ [${key}] placeholder "${token}" missing in translation: "${translated}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  const force = args.includes('--force');

  const localeIdx = args.indexOf('--locale');
  const langIdx   = args.indexOf('--lang');
  const keysIdx   = args.indexOf('--keys');
  const specifiedLocale = localeIdx !== -1 ? args[localeIdx + 1] : null;
  const specifiedLang   = langIdx   !== -1 ? args[langIdx   + 1] : null;
  const specifiedKeys   = keysIdx   !== -1 ? new Set(args[keysIdx + 1].split(',').map(k => k.trim())) : null;

  // Source of truth
  const enPath = path.join(LOCALES_DIR, 'en', 'messages.json');
  const enMessages = JSON.parse(fs.readFileSync(enPath, 'utf8'));
  const enKeys = Object.keys(enMessages);

  // Determine which locales to process
  let locales;
  if (specifiedLocale) {
    locales = [specifiedLocale];
  } else {
    // Default: translate to every language in LANG_NAMES
    locales = Object.keys(LANG_NAMES);
  }

  for (const locale of locales) {
    const langName = specifiedLang || LANG_NAMES[locale];
    if (!langName) {
      console.warn(`Unknown locale "${locale}". Use --lang "Language Name" to specify it. Skipping.`);
      continue;
    }

    const outDir  = path.join(LOCALES_DIR, locale);
    const outPath = path.join(outDir, 'messages.json');

    let existing = {};
    if (fs.existsSync(outPath)) {
      existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    }

    // Keys to translate: specified keys, missing ones, or all if --force
    const toTranslate = Object.entries(enMessages).filter(([key]) =>
      specifiedKeys ? specifiedKeys.has(key) : (force ? true : !(key in existing))
    );

    if (toTranslate.length === 0) {
      console.log(`[${locale}] Up to date — nothing to translate.`);
      continue;
    }

    console.log(`[${locale}] ${langName} — translating ${toTranslate.length} key(s)…`);

    const result = { ...existing };
    const totalBatches = Math.ceil(toTranslate.length / BATCH_SIZE);

    for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
      const batch   = toTranslate.slice(i, i + BATCH_SIZE);
      const entries = batch.map(([key, val]) => ({ key, message: val.message }));
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${entries.length} keys)… `);

      let translated;
      try {
        translated = await withRetry(() => translateBatch(entries, langName));
      } catch (err) {
        console.error(`\n  Error in batch ${batchNum}: ${err.message}`);
        console.error('  Skipping this batch — existing keys are unchanged.');
        continue;
      }

      // Collect keys missing from the response and retry them individually
      const missing = batch.filter(([key]) => typeof translated[key] !== 'string');
      if (missing.length > 0) {
        process.stdout.write(`\n  Retrying ${missing.length} missing key(s)… `);
        try {
          const retried = await withRetry(() =>
            translateBatch(missing.map(([key, val]) => ({ key, message: val.message })), langName)
          );
          Object.assign(translated, retried);
        } catch (err) {
          console.warn(`failed (${err.message.split('\n')[0]}), keeping English for those keys.`);
        }
      }

      for (const [key, enVal] of batch) {
        const msg = translated[key];
        if (typeof msg !== 'string') {
          result[key] = enVal;
          continue;
        }
        validatePlaceholders(key, enVal.message, msg);
        result[key] = { ...enVal, message: msg };
      }

      console.log('done.');
    }

    // Write output with key order matching en/messages.json
    const ordered = {};
    for (const key of enKeys) {
      if (key in result) ordered[key] = result[key];
    }

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
    console.log(`[${locale}] Written → ${path.relative(ROOT, outPath)}`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
