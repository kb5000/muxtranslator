'use strict';

// settings.js uses browser/chrome storage only inside async functions that we
// won't call here. Set them to undefined so the module-level code loads cleanly.
global.browser = undefined;
global.chrome = undefined;

// settings.js declares `var SettingsModule = SettingsModule || {}` at its own
// scope, so requiring it works; the module.exports guard at the bottom exports
// the populated object.
const S = require('../src/lib/settings');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('SettingsModule constants', () => {
  test('SCHEMA_VERSION is a number', () => {
    expect(typeof S.SCHEMA_VERSION).toBe('number');
  });

  test('STORAGE_KEY is a non-empty string', () => {
    expect(typeof S.STORAGE_KEY).toBe('string');
    expect(S.STORAGE_KEY.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SYSTEM_PROMPT / DEFAULT_USER_TEMPLATE
// ---------------------------------------------------------------------------

describe('Default prompts mention numbered separators', () => {
  test('system prompt references numbered separator format', () => {
    expect(S.DEFAULT_SYSTEM_PROMPT).toMatch(/<<<SEP\d/);
  });

  test('user template references numbered separator format', () => {
    expect(S.DEFAULT_USER_TEMPLATE).toMatch(/<<<SEP/);
  });

  test('system prompt does not exclusively reference the legacy <<<SEP>>> token', () => {
    // The legacy plain token should no longer be the primary instruction.
    // The prompt should mention numbered variants like <<<SEP1>>> or <<<SEPn>>>.
    expect(S.DEFAULT_SYSTEM_PROMPT).not.toMatch(/exact token '<<<SEP>>>'/);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_PROVIDER
// ---------------------------------------------------------------------------

describe('DEFAULT_PROVIDER', () => {
  let p;
  beforeEach(() => { p = S.DEFAULT_PROVIDER(); });

  test('returns an object with required fields', () => {
    expect(p).toHaveProperty('id');
    expect(p).toHaveProperty('name');
    expect(p).toHaveProperty('type');
    expect(p).toHaveProperty('model');
  });

  test('type is openai-compatible', () => {
    expect(p.type).toBe('openai-compatible');
  });

  test('systemPrompt is the current default', () => {
    expect(p.systemPrompt).toBe(S.DEFAULT_SYSTEM_PROMPT);
  });

  test('userPromptTemplate is the current default', () => {
    expect(p.userPromptTemplate).toBe(S.DEFAULT_USER_TEMPLATE);
  });

  test('streaming is enabled by default', () => {
    expect(p.streamingEnabled).toBe(true);
  });

  test('each call returns a fresh object', () => {
    const p2 = S.DEFAULT_PROVIDER();
    expect(p).not.toBe(p2);
  });
});

// ---------------------------------------------------------------------------
// NEW_PROVIDER
// ---------------------------------------------------------------------------

describe('NEW_PROVIDER', () => {
  test('creates an openai-compatible provider by default', () => {
    const p = S.NEW_PROVIDER('openai-compatible');
    expect(p.type).toBe('openai-compatible');
    expect(p.systemPrompt).toBe(S.DEFAULT_SYSTEM_PROMPT);
  });

  test('creates an ollama provider', () => {
    const p = S.NEW_PROVIDER('ollama');
    expect(p.type).toBe('ollama');
    expect(p.baseURL).toBe('http://localhost:11434');
  });

  test('non-LLM providers have no system prompt', () => {
    const g = S.NEW_PROVIDER('google-translate');
    expect(g.systemPrompt).toBeFalsy();
  });

  test('deepl provider defaults to free endpoint', () => {
    const d = S.NEW_PROVIDER('deepl');
    expect(d.endpoint).toBe('free');
  });

  test('each call generates a unique id', () => {
    const ids = new Set();
    for (let i = 0; i < 10; i++) ids.add(S.NEW_PROVIDER('openai-compatible').id);
    expect(ids.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// resolveProvider
// ---------------------------------------------------------------------------

describe('resolveProvider', () => {
  const settings = {
    providers: [
      { id: 'p1', name: 'First' },
      { id: 'p2', name: 'Second' }
    ],
    defaultProviderId: 'p1'
  };

  test('resolves by explicit id', () => {
    expect(S.resolveProvider(settings, 'p2').name).toBe('Second');
  });

  test('falls back to defaultProviderId when id is null', () => {
    expect(S.resolveProvider(settings, null).name).toBe('First');
  });

  test('falls back to first provider when defaultProviderId not found', () => {
    const s = { providers: [{ id: 'x', name: 'X' }], defaultProviderId: 'missing' };
    expect(S.resolveProvider(s, null).name).toBe('X');
  });

  test('returns null for empty providers list', () => {
    expect(S.resolveProvider({ providers: [], defaultProviderId: '' }, null)).toBeNull();
  });

  test('returns null for missing settings', () => {
    expect(S.resolveProvider(null, 'p1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveSiteRule
// ---------------------------------------------------------------------------

describe('resolveSiteRule', () => {
  const settings = {
    siteRules: {
      'example.com': { mode: 'skip' },
      'news.bbc.co.uk': { mode: 'always', providerId: 'p1' }
    }
  };

  test('resolves exact hostname match', () => {
    const rule = S.resolveSiteRule(settings, 'example.com');
    expect(rule).toEqual({ mode: 'skip' });
  });

  test('resolves subdomain via parent rule', () => {
    const rule = S.resolveSiteRule(settings, 'sub.example.com');
    expect(rule).toEqual({ mode: 'skip' });
  });

  test('returns null for unknown hostname', () => {
    expect(S.resolveSiteRule(settings, 'other.com')).toBeNull();
  });

  test('returns null when siteRules is empty', () => {
    expect(S.resolveSiteRule({ siteRules: {} }, 'example.com')).toBeNull();
  });

  test('returns null for missing settings', () => {
    expect(S.resolveSiteRule(null, 'example.com')).toBeNull();
  });

  test('handles case-insensitive hostname lookup', () => {
    const rule = S.resolveSiteRule(settings, 'EXAMPLE.COM');
    expect(rule).toEqual({ mode: 'skip' });
  });
});

// ---------------------------------------------------------------------------
// PROVIDER_TYPES
// ---------------------------------------------------------------------------

describe('PROVIDER_TYPES', () => {
  test('is a non-empty array', () => {
    expect(Array.isArray(S.PROVIDER_TYPES)).toBe(true);
    expect(S.PROVIDER_TYPES.length).toBeGreaterThan(0);
  });

  test('includes expected provider types', () => {
    expect(S.PROVIDER_TYPES).toContain('openai-compatible');
    expect(S.PROVIDER_TYPES).toContain('ollama');
    expect(S.PROVIDER_TYPES).toContain('google-translate');
    expect(S.PROVIDER_TYPES).toContain('deepl');
  });
});
