// Unified translation provider dispatcher.
// Interface implemented by each provider type:
//   translateBatch(provider, texts, targetLang, signal) -> { translations: string[], usage }
//   translateStream(provider, texts, targetLang, callbacks, signal) -> { usage }
//       callbacks: { onSegment(index, text), onUsage(usage) }
//   fetchModels(provider) -> string[]
//   supportsStreaming(provider) -> boolean

var ProvidersModule = ProvidersModule || {};
(function (ns) {
  'use strict';

  // ------------------------------------------------------------------
  // Public dispatcher
  // ------------------------------------------------------------------

  ns.supportsStreaming = function (provider) {
    if (!provider) return false;
    if (provider.type === 'google-translate' ||
        provider.type === 'deepl' ||
        provider.type === 'libretranslate') return false;
    return provider.streamingEnabled !== false;
  };

  ns.translateBatch = async function (provider, texts, targetLang, signal) {
    var impl = getImpl(provider);
    return impl.translateBatch(provider, texts, targetLang, signal);
  };

  ns.translateStream = async function (provider, texts, targetLang, callbacks, signal) {
    var impl = getImpl(provider);
    if (!ns.supportsStreaming(provider) || !impl.translateStream) {
      // Fallback: translateBatch then emit all segments at once
      var result = await impl.translateBatch(provider, texts, targetLang, signal);
      if (callbacks && callbacks.onSegment) {
        for (var i = 0; i < result.translations.length; i++) {
          callbacks.onSegment(i, result.translations[i]);
        }
      }
      if (callbacks && callbacks.onUsage && result.usage) callbacks.onUsage(result.usage);
      return { usage: result.usage };
    }
    return impl.translateStream(provider, texts, targetLang, callbacks || {}, signal);
  };

  ns.fetchModels = async function (provider) {
    var impl = getImpl(provider);
    if (!impl.fetchModels) return [];
    return impl.fetchModels(provider);
  };

  function getImpl(provider) {
    if (!provider || !provider.type) throw new Error('Provider type missing');
    var impl = IMPLS[provider.type];
    if (!impl) throw new Error('Unknown provider type: ' + provider.type);
    return impl;
  }

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  function normalizeBaseURL(baseURL) {
    if (!baseURL) return '';
    return String(baseURL).trim().replace(/\/+$/, '');
  }

  function joinWithSep(texts) {
    return UtilsModule.joinForBatch(texts);
  }

  function splitBySep(response) {
    return response.split(UtilsModule.SEP_PATTERN).map(function (s) {
      return s.replace(/^\s+|\s+$/g, '');
    });
  }

  // Build glossary block to append to system prompts (LLM providers only).
  // provider._glossary is pre-filtered for the target language by background.js.
  function buildGlossaryBlock(provider) {
    var g = provider._glossary;
    if (!g || !g.length) return '';
    var lines = g.map(function (e) { return '- ' + e.source + ' → ' + e.target; });
    return '\n\nGlossary (translate these terms exactly as listed):\n' + lines.join('\n');
  }

  // Build page context block to prepend to system prompts (LLM providers only).
  // provider._pageContext is set by background.js withPageContext().
  function buildPageContextBlock(provider) {
    var ctx = provider._pageContext;
    if (!ctx) return '';
    var parts = [];
    if (ctx.title) parts.push('Title: ' + ctx.title);
    if (ctx.description) parts.push('Description: ' + ctx.description);
    if (!parts.length) return '';
    return 'Page context:\n' + parts.join('\n') + '\n\n';
  }

  // Build user prompt from template + {text} + {target_lang}
  function buildUserPrompt(provider, texts, targetLang) {
    var combined = joinWithSep(texts);
    return UtilsModule.fillTemplate(provider.userPromptTemplate || '{text}', {
      text: combined,
      target_lang: targetLang
    });
  }

  // Tool-call mode uses its own fixed prompts so users' text-mode templates
  // (which reference <<<SEP>>> and injected numbering) don't leak into the
  // model's output. Input is delivered as a clean JSON array of strings so
  // the model treats each item as a distinct unit.
  var TOOL_SYSTEM_PROMPT =
    "You are a professional translator. The user message contains a JSON array of strings. " +
    "Translate each string accurately and naturally into the target language, preserving " +
    "the original formatting, punctuation, and whitespace inside each string. " +
    "Respond by calling the output_translations function with an array of translated " +
    "strings — exactly one translation per input, in the same order and with the same length. " +
    "Do not merge, split, reorder, or add commentary.";

  function buildToolMessages(provider, texts, targetLang) {
    return [
      { role: 'system', content: buildPageContextBlock(provider) + TOOL_SYSTEM_PROMPT + buildGlossaryBlock(provider) },
      { role: 'user', content:
          'Target language: ' + targetLang + '\n\n' +
          'Input (JSON array of ' + texts.length + ' strings):\n' +
          JSON.stringify(texts)
      }
    ];
  }

  // Tool definition forcing the model to return an array of translations,
  // one per input, in order.
  function translationTool() {
    return [{
      type: 'function',
      function: {
        name: 'output_translations',
        description: 'Output the translations of the given input texts. Return one string per input, in the same order.',
        parameters: {
          type: 'object',
          properties: {
            translations: {
              type: 'array',
              description: 'One translated string per input text, in order.',
              items: { type: 'string' }
            }
          },
          required: ['translations']
        }
      }
    }];
  }

  function forcedToolChoice() {
    return { type: 'function', function: { name: 'output_translations' } };
  }

  // Incremental parser for a JSON payload of the shape
  //   { "translations": ["a", "b", ...] }
  // Feed it the raw `function.arguments` delta strings as they stream in;
  // it calls onString(text) once per fully-closed array element.
  //
  // We rely on the schema: before the first '[' there cannot be any string
  // literal (only the object key "translations"), so scanning for '[' is safe.
  function createTranslationsStreamer(onString) {
    var state = 'init';       // init → array → string → escape → unicode
    var buf = '';
    var uni = '';
    var done = false;

    return {
      feed: function (chunk) {
        if (done || !chunk) return;
        for (var i = 0; i < chunk.length; i++) {
          var c = chunk.charAt(i);
          if (state === 'init') {
            if (c === '[') state = 'array';
          } else if (state === 'array') {
            if (c === '"') { state = 'string'; buf = ''; }
            else if (c === ']') { state = 'end'; done = true; return; }
          } else if (state === 'string') {
            if (c === '"') { onString(buf); buf = ''; state = 'array'; }
            else if (c === '\\') { state = 'escape'; }
            else buf += c;
          } else if (state === 'escape') {
            if (c === '"') { buf += '"'; state = 'string'; }
            else if (c === '\\') { buf += '\\'; state = 'string'; }
            else if (c === '/') { buf += '/'; state = 'string'; }
            else if (c === 'n') { buf += '\n'; state = 'string'; }
            else if (c === 't') { buf += '\t'; state = 'string'; }
            else if (c === 'r') { buf += '\r'; state = 'string'; }
            else if (c === 'b') { buf += '\b'; state = 'string'; }
            else if (c === 'f') { buf += '\f'; state = 'string'; }
            else if (c === 'u') { state = 'unicode'; uni = ''; }
            else { buf += c; state = 'string'; }
          } else if (state === 'unicode') {
            uni += c;
            if (uni.length === 4) {
              buf += String.fromCharCode(parseInt(uni, 16));
              state = 'string';
            }
          }
        }
      },
      done: function () { return done; }
    };
  }

  // ------------------------------------------------------------------
  // OpenAI-compatible
  // ------------------------------------------------------------------

  var OpenAI = {};

  OpenAI.endpoint = function (baseURL, path) {
    var b = normalizeBaseURL(baseURL).replace(/\/chat\/completions$/, '');
    if (/\/v\d+$/.test(b)) return b + path;
    return b + '/v1' + path;
  };

  OpenAI.headers = function (apiKey) {
    var h = { 'Content-Type': 'application/json' };
    if (apiKey) h['Authorization'] = 'Bearer ' + apiKey;
    return h;
  };

  OpenAI.fetchModels = async function (provider) {
    var res = await fetch(OpenAI.endpoint(provider.baseURL, '/models'), {
      method: 'GET',
      headers: OpenAI.headers(provider.apiKey)
    });
    if (!res.ok) {
      var text = await res.text().catch(function () { return ''; });
      throw new Error('HTTP ' + res.status + ' ' + res.statusText + (text ? ': ' + text.slice(0, 200) : ''));
    }
    var json = await res.json();
    var data = json && (json.data || json.models || json);
    if (!Array.isArray(data)) return [];
    return data.map(function (m) {
      return typeof m === 'string' ? m : (m && (m.id || m.name || m.model));
    }).filter(Boolean);
  };

  OpenAI.translateBatch = async function (provider, texts, targetLang, signal) {
    if (!provider.model) throw new Error('model is required');
    var isTool = provider.outputMode === 'tool-call';
    var messages = isTool
      ? buildToolMessages(provider, texts, targetLang)
      : [
          { role: 'system', content: buildPageContextBlock(provider) + (provider.systemPrompt || '') + buildGlossaryBlock(provider) },
          { role: 'user', content: buildUserPrompt(provider, texts, targetLang) }
        ];
    var body = {
      model: provider.model,
      messages: messages,
      temperature: 0.3,
      stream: false
    };
    if (isTool) {
      body.tools = translationTool();
      body.tool_choice = forcedToolChoice();
    }
    var res = await fetch(OpenAI.endpoint(provider.baseURL, '/chat/completions'), {
      method: 'POST',
      headers: OpenAI.headers(provider.apiKey),
      body: JSON.stringify(body),
      signal: signal
    });
    if (!res.ok) {
      var errText = await res.text().catch(function () { return ''; });
      throw new Error('HTTP ' + res.status + ' ' + res.statusText + (errText ? ': ' + errText.slice(0, 300) : ''));
    }
    var json = await res.json();
    var translations;
    if (isTool) {
      var msg = json.choices && json.choices[0] && json.choices[0].message;
      var tc = msg && msg.tool_calls && msg.tool_calls[0];
      var args = tc && tc.function && tc.function.arguments;
      var arr = [];
      if (args) {
        try { arr = (JSON.parse(args) || {}).translations || []; } catch (e) {}
      }
      translations = padToLength(arr, texts.length);
    } else {
      var content =
        (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) ||
        (json.choices && json.choices[0] && json.choices[0].text) || '';
      var pieces = splitBySep(content.trim());
      translations = padToLength(pieces, texts.length);
    }
    return {
      translations: translations,
      usage: extractUsage(json)
    };
  };

  OpenAI.translateStream = async function (provider, texts, targetLang, callbacks, signal) {
    if (!provider.model) throw new Error('model is required');
    var isTool = provider.outputMode === 'tool-call';
    var messages = isTool
      ? buildToolMessages(provider, texts, targetLang)
      : [
          { role: 'system', content: buildPageContextBlock(provider) + (provider.systemPrompt || '') + buildGlossaryBlock(provider) },
          { role: 'user', content: buildUserPrompt(provider, texts, targetLang) }
        ];
    var body = {
      model: provider.model,
      messages: messages,
      temperature: 0.3,
      stream: true,
      stream_options: { include_usage: true }  // ignored by servers that don't support it
    };
    if (isTool) {
      body.tools = translationTool();
      body.tool_choice = forcedToolChoice();
    }
    var res = await fetch(OpenAI.endpoint(provider.baseURL, '/chat/completions'), {
      method: 'POST',
      headers: OpenAI.headers(provider.apiKey),
      body: JSON.stringify(body),
      signal: signal
    });
    if (!res.ok) {
      var errText = await res.text().catch(function () { return ''; });
      throw new Error('HTTP ' + res.status + ' ' + res.statusText + (errText ? ': ' + errText.slice(0, 300) : ''));
    }
    if (!res.body || !res.body.getReader) {
      // Server returned a non-streaming body despite stream:true — fall through
      // to the non-streaming path, which already handles both output modes.
      return await OpenAI.translateBatch(provider, texts, targetLang, signal).then(function (r) {
        if (callbacks.onSegment) r.translations.forEach(function (t, i) { callbacks.onSegment(i, t); });
        if (callbacks.onUsage && r.usage) callbacks.onUsage(r.usage);
        return { usage: r.usage };
      });
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    var usage = null;

    // --- tool-call branch --------------------------------------------------
    if (isTool) {
      var emittedTool = 0;
      var streamer = createTranslationsStreamer(function (text) {
        if (emittedTool < texts.length && callbacks.onSegment) {
          callbacks.onSegment(emittedTool, text);
        }
        emittedTool++;
      });

      function handleToolEvent(rawEvent) {
        processOpenAIEvent(rawEvent, function (_delta, ev) {
          if (!ev) return;
          var tc = ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.tool_calls;
          if (tc && tc[0] && tc[0].function && typeof tc[0].function.arguments === 'string') {
            streamer.feed(tc[0].function.arguments);
          }
          if (ev.usage) usage = ev.usage;
        });
      }

      while (true) {
        var chunkT = await reader.read();
        if (chunkT.done) break;
        buffer += decoder.decode(chunkT.value, { stream: true });
        var eventEndT;
        while ((eventEndT = findEventEnd(buffer)) !== -1) {
          var rawT = buffer.slice(0, eventEndT.start);
          buffer = buffer.slice(eventEndT.end);
          handleToolEvent(rawT);
        }
      }
      if (buffer.trim()) handleToolEvent(buffer);

      // Fill any segments the model didn't produce with blanks.
      while (emittedTool < texts.length) {
        if (callbacks.onSegment) callbacks.onSegment(emittedTool, '');
        emittedTool++;
      }
      if (usage && callbacks.onUsage) callbacks.onUsage(usage);
      return { usage: usage };
    }

    // --- text/<<<SEPn>>> branch -------------------------------------------
    var accum = '';
    var emitted = 0;
    var SEP_RE = UtilsModule.SEP_PATTERN;

    function emitReady(final) {
      var parts = accum.split(SEP_RE);
      var completeCount = final ? parts.length : parts.length - 1;
      while (emitted < completeCount && emitted < texts.length) {
        var seg = parts[emitted].replace(/^\s+|\s+$/g, '');
        if (callbacks.onSegment) callbacks.onSegment(emitted, seg);
        emitted++;
      }
    }

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var eventEnd;
      while ((eventEnd = findEventEnd(buffer)) !== -1) {
        var rawEvent = buffer.slice(0, eventEnd.start);
        buffer = buffer.slice(eventEnd.end);
        processOpenAIEvent(rawEvent, function (delta, ev) {
          if (delta) { accum += delta; emitReady(false); }
          if (ev && ev.usage) usage = ev.usage;
        });
      }
    }
    if (buffer.trim()) {
      processOpenAIEvent(buffer, function (delta, ev) {
        if (delta) { accum += delta; emitReady(false); }
        if (ev && ev.usage) usage = ev.usage;
      });
    }

    // Stream done — emit any remaining segments
    var finalParts = accum.split(SEP_RE);
    if (finalParts.length === texts.length) {
      emitReady(true);
    } else {
      // Separator mismatch: the model didn't preserve <<<SEPn>>> tokens reliably.
      // Emit whatever we streamed (padded/truncated to the expected count)
      // instead of fanning out per-item.
      var trimmed = finalParts.map(function (s) { return s.replace(/^\s+|\s+$/g, ''); });
      var padded = padToLength(trimmed, texts.length);
      for (var i = emitted; i < texts.length; i++) {
        if (callbacks.onSegment) callbacks.onSegment(i, padded[i] || '');
      }
    }
    if (usage && callbacks.onUsage) callbacks.onUsage(usage);
    return { usage: usage };
  };

  function findEventEnd(buffer) {
    var i1 = buffer.indexOf('\n\n');
    var i2 = buffer.indexOf('\r\n\r\n');
    if (i1 === -1 && i2 === -1) return -1;
    if (i1 === -1) return { start: i2, end: i2 + 4 };
    if (i2 === -1) return { start: i1, end: i1 + 2 };
    return i1 < i2 ? { start: i1, end: i1 + 2 } : { start: i2, end: i2 + 4 };
  }

  function processOpenAIEvent(rawEvent, cb) {
    if (!rawEvent) return;
    var lines = rawEvent.split(/\r?\n/);
    var dataParts = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') === 0) {
        var payload = line.slice(5);
        if (payload.charAt(0) === ' ') payload = payload.slice(1);
        dataParts.push(payload);
      }
    }
    if (!dataParts.length) return;
    var data = dataParts.join('\n');
    if (data === '[DONE]') return;
    try {
      var json = JSON.parse(data);
      var delta = (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) ||
                  (json.choices && json.choices[0] && json.choices[0].text) || '';
      cb(delta, json);
    } catch (e) { /* skip malformed */ }
  }

  function extractUsage(json) {
    if (!json || !json.usage) return null;
    return {
      prompt_tokens: json.usage.prompt_tokens || 0,
      completion_tokens: json.usage.completion_tokens || 0
    };
  }

  function mergeUsage(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
      completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0)
    };
  }

  function padToLength(arr, n) {
    if (arr.length === n) return arr;
    if (arr.length > n) return arr.slice(0, n);
    var out = arr.slice();
    while (out.length < n) out.push('');
    return out;
  }

  // ------------------------------------------------------------------
  // Ollama (native /api/chat + /api/tags)
  // ------------------------------------------------------------------

  var Ollama = {};

  Ollama.base = function (p) { return normalizeBaseURL(p.baseURL); };

  Ollama.fetchModels = async function (provider) {
    var res = await fetch(Ollama.base(provider) + '/api/tags', { method: 'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var json = await res.json();
    if (!json || !Array.isArray(json.models)) return [];
    return json.models.map(function (m) { return m.name || m.model; }).filter(Boolean);
  };

  Ollama.translateBatch = async function (provider, texts, targetLang, signal) {
    if (!provider.model) throw new Error('model is required');
    var userPrompt = buildUserPrompt(provider, texts, targetLang);
    var body = {
      model: provider.model,
      messages: [
        { role: 'system', content: buildPageContextBlock(provider) + (provider.systemPrompt || '') + buildGlossaryBlock(provider) },
        { role: 'user', content: userPrompt }
      ],
      stream: false,
      options: { temperature: 0.3 }
    };
    var res = await fetch(Ollama.base(provider) + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
    var json = await res.json();
    var content = (json && json.message && json.message.content) || '';
    var pieces = splitBySep(content.trim());
    return {
      translations: padToLength(pieces, texts.length),
      usage: {
        prompt_tokens: json.prompt_eval_count || 0,
        completion_tokens: json.eval_count || 0
      }
    };
  };

  Ollama.translateStream = async function (provider, texts, targetLang, callbacks, signal) {
    if (!provider.model) throw new Error('model is required');
    var userPrompt = buildUserPrompt(provider, texts, targetLang);
    var body = {
      model: provider.model,
      messages: [
        { role: 'system', content: buildPageContextBlock(provider) + (provider.systemPrompt || '') + buildGlossaryBlock(provider) },
        { role: 'user', content: userPrompt }
      ],
      stream: true,
      options: { temperature: 0.3 }
    };
    var res = await fetch(Ollama.base(provider) + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
    if (!res.body || !res.body.getReader) {
      return Ollama.translateBatch(provider, texts, targetLang, signal).then(function (r) {
        if (callbacks.onSegment) r.translations.forEach(function (t, i) { callbacks.onSegment(i, t); });
        if (callbacks.onUsage && r.usage) callbacks.onUsage(r.usage);
        return { usage: r.usage };
      });
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    var accum = '';
    var emitted = 0;
    var usage = null;
    var SEP_RE = UtilsModule.SEP_PATTERN;

    function emitReady(final) {
      var parts = accum.split(SEP_RE);
      var completeCount = final ? parts.length : parts.length - 1;
      while (emitted < completeCount && emitted < texts.length) {
        var seg = parts[emitted].replace(/^\s+|\s+$/g, '');
        if (callbacks.onSegment) callbacks.onSegment(emitted, seg);
        emitted++;
      }
    }

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // Ollama streams newline-delimited JSON
      var nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        var line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          var obj = JSON.parse(line);
          var delta = obj && obj.message && obj.message.content;
          if (delta) { accum += delta; emitReady(false); }
          if (obj && obj.done) {
            usage = {
              prompt_tokens: obj.prompt_eval_count || 0,
              completion_tokens: obj.eval_count || 0
            };
          }
        } catch (e) { /* skip malformed */ }
      }
    }
    if (buffer.trim()) {
      try {
        var obj2 = JSON.parse(buffer.trim());
        var delta2 = obj2 && obj2.message && obj2.message.content;
        if (delta2) accum += delta2;
        if (obj2 && obj2.done) {
          usage = {
            prompt_tokens: obj2.prompt_eval_count || 0,
            completion_tokens: obj2.eval_count || 0
          };
        }
      } catch (e) {}
    }

    var finalParts = accum.split(SEP_RE);
    if (finalParts.length === texts.length) {
      emitReady(true);
    } else {
      // See OpenAI.translateStream comment: no per-item retries on separator
      // mismatch. Pad from what we streamed.
      var trimmed2 = finalParts.map(function (s) { return s.replace(/^\s+|\s+$/g, ''); });
      var padded2 = padToLength(trimmed2, texts.length);
      for (var i = emitted; i < texts.length; i++) {
        if (callbacks.onSegment) callbacks.onSegment(i, padded2[i] || '');
      }
    }
    if (usage && callbacks.onUsage) callbacks.onUsage(usage);
    return { usage: usage };
  };

  // ------------------------------------------------------------------
  // Google Translate (v2 REST)
  // ------------------------------------------------------------------

  var Google = {};

  Google.base = function (p) {
    var b = normalizeBaseURL(p.baseURL) || 'https://translation.googleapis.com';
    return b.replace(/\/$/, '');
  };

  Google.fetchModels = async function () {
    // Google Translate doesn't have selectable models — return a placeholder.
    return ['base'];
  };

  Google.translateBatchFree = async function (texts, targetLang, signal) {
    var target = targetLang || 'en';
    var requests = texts.map(function (text) {
      var url = 'https://translate.googleapis.com/translate_a/single' +
        '?client=gtx&sl=auto&tl=' + encodeURIComponent(target) +
        '&dt=t&q=' + encodeURIComponent(text);
      return fetch(url, { signal: signal })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (json) {
          if (!Array.isArray(json) || !Array.isArray(json[0])) return '';
          return json[0].map(function (seg) { return (seg && seg[0]) || ''; }).join('');
        })
        .catch(function (e) {
          if (e && e.name === 'AbortError') throw e;
          return '';
        });
    });
    var translated = await Promise.all(requests);
    var inChars = 0; texts.forEach(function (t) { inChars += (t || '').length; });
    var outChars = 0; translated.forEach(function (t) { outChars += (t || '').length; });
    return {
      translations: translated,
      usage: { prompt_tokens: inChars, completion_tokens: outChars }
    };
  };

  Google.translateBatch = async function (provider, texts, targetLang, signal) {
    if (!provider.apiKey) return Google.translateBatchFree(texts, targetLang, signal);
    var url = Google.base(provider) + '/language/translate/v2?key=' + encodeURIComponent(provider.apiKey);
    var body = {
      q: texts,
      target: targetLang || 'en',
      format: 'text'
    };
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
    });
    if (!res.ok) {
      var errText = await res.text().catch(function () { return ''; });
      throw new Error('HTTP ' + res.status + ' ' + res.statusText + (errText ? ': ' + errText.slice(0, 300) : ''));
    }
    var json = await res.json();
    var arr = json && json.data && json.data.translations;
    if (!Array.isArray(arr)) throw new Error('Unexpected Google response shape');
    var translated = arr.map(function (t) { return t.translatedText || ''; });
    var inChars = 0; texts.forEach(function (t) { inChars += (t || '').length; });
    var outChars = 0; translated.forEach(function (t) { outChars += (t || '').length; });
    return {
      translations: translated,
      usage: { prompt_tokens: inChars, completion_tokens: outChars }
    };
  };

  // ------------------------------------------------------------------
  // DeepL (v2 REST)
  // ------------------------------------------------------------------

  var DeepL = {};

  DeepL.base = function (p) {
    if (p.baseURL && p.baseURL.trim()) return normalizeBaseURL(p.baseURL);
    return p.endpoint === 'paid'
      ? 'https://api.deepl.com'
      : 'https://api-free.deepl.com';
  };

  DeepL.targetLang = function (lang) {
    if (!lang) return 'EN-US';
    var u = lang.toUpperCase();
    if (u === 'ZH-CN' || u === 'ZH-HANS') return 'ZH';
    if (u === 'ZH-TW' || u === 'ZH-HANT') return 'ZH';
    if (u === 'EN') return 'EN-US';
    return u;
  };

  DeepL.translateBatch = async function (provider, texts, targetLang, signal) {
    if (!provider.apiKey) throw new Error('DeepL requires an API key');
    var url = DeepL.base(provider) + '/v2/translate';
    var body = { text: texts, target_lang: DeepL.targetLang(targetLang) };
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'DeepL-Auth-Key ' + provider.apiKey
      },
      body: JSON.stringify(body),
      signal: signal
    });
    if (!res.ok) {
      var errText = await res.text().catch(function () { return ''; });
      throw new Error('HTTP ' + res.status + ' ' + res.statusText + (errText ? ': ' + errText.slice(0, 300) : ''));
    }
    var json = await res.json();
    if (!json || !Array.isArray(json.translations)) throw new Error('Unexpected DeepL response shape');
    var translated = json.translations.map(function (t) { return t.text || ''; });
    var inChars = 0; texts.forEach(function (t) { inChars += (t || '').length; });
    var outChars = 0; translated.forEach(function (t) { outChars += (t || '').length; });
    return {
      translations: translated,
      usage: { prompt_tokens: inChars, completion_tokens: outChars }
    };
  };

  // ------------------------------------------------------------------
  // LibreTranslate (REST, one request per text in parallel)
  // ------------------------------------------------------------------

  var LibreTranslate = {};

  LibreTranslate.base = function (p) {
    return normalizeBaseURL(p.baseURL || 'https://libretranslate.com');
  };

  LibreTranslate.normLang = function (lang) {
    if (!lang) return 'en';
    return lang.toLowerCase().split('-')[0].split('_')[0];
  };

  LibreTranslate.translateBatch = async function (provider, texts, targetLang, signal) {
    var base = LibreTranslate.base(provider);
    var target = LibreTranslate.normLang(targetLang);
    var requests = texts.map(function (text) {
      var body = { q: text, source: 'auto', target: target, format: 'text' };
      if (provider.apiKey) body.api_key = provider.apiKey;
      return fetch(base + '/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error('HTTP ' + res.status + ': ' + t.slice(0, 200));
          });
        }
        return res.json();
      }).then(function (json) {
        return (json && json.translatedText) || '';
      });
    });
    var translated = await Promise.all(requests);
    var inChars = 0; texts.forEach(function (t) { inChars += (t || '').length; });
    var outChars = 0; translated.forEach(function (t) { outChars += (t || '').length; });
    return {
      translations: translated,
      usage: { prompt_tokens: inChars, completion_tokens: outChars }
    };
  };

  // ------------------------------------------------------------------

  var IMPLS = {
    'openai-compatible': OpenAI,
    'ollama': Ollama,
    'google-translate': Google,
    'deepl': DeepL,
    'libretranslate': LibreTranslate
  };
})(ProvidersModule);
