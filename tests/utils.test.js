'use strict';

const U = require('../src/lib/utils');

// ---------------------------------------------------------------------------
// hashText
// ---------------------------------------------------------------------------

describe('hashText', () => {
  test('returns "0" for falsy input', () => {
    expect(U.hashText('')).toBe('0');
    expect(U.hashText(null)).toBe('0');
    expect(U.hashText(undefined)).toBe('0');
  });

  test('returns a hex string for non-empty input', () => {
    expect(U.hashText('hello')).toMatch(/^[0-9a-f]+$/);
  });

  test('same input produces the same hash', () => {
    expect(U.hashText('abc')).toBe(U.hashText('abc'));
  });

  test('different inputs produce different hashes', () => {
    expect(U.hashText('foo')).not.toBe(U.hashText('bar'));
  });
});

// ---------------------------------------------------------------------------
// normalizeText
// ---------------------------------------------------------------------------

describe('normalizeText', () => {
  test('collapses internal whitespace', () => {
    expect(U.normalizeText('hello   world')).toBe('hello world');
  });

  test('trims leading and trailing whitespace', () => {
    expect(U.normalizeText('  hi  ')).toBe('hi');
  });

  test('returns empty string for falsy input', () => {
    expect(U.normalizeText('')).toBe('');
    expect(U.normalizeText(null)).toBe('');
  });

  test('collapses newlines and tabs', () => {
    expect(U.normalizeText('a\n\t b')).toBe('a b');
  });
});

// ---------------------------------------------------------------------------
// fillTemplate
// ---------------------------------------------------------------------------

describe('fillTemplate', () => {
  test('replaces known placeholders', () => {
    expect(U.fillTemplate('{a} and {b}', { a: 'foo', b: 'bar' }))
      .toBe('foo and bar');
  });

  test('leaves unknown placeholders intact', () => {
    expect(U.fillTemplate('{x}', {})).toBe('{x}');
  });

  test('returns empty string for falsy template', () => {
    expect(U.fillTemplate('', {})).toBe('');
    expect(U.fillTemplate(null, {})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// batchTexts
// ---------------------------------------------------------------------------

describe('batchTexts', () => {
  test('returns empty array for empty input', () => {
    expect(U.batchTexts([], 100)).toEqual([]);
  });

  test('groups texts within maxChars limit', () => {
    const batches = U.batchTexts(['aa', 'bb', 'cc'], 10);
    expect(batches).toEqual([['aa', 'bb', 'cc']]);
  });

  test('splits texts that exceed the per-batch limit', () => {
    const batches = U.batchTexts(['aaaa', 'bbbb'], 5);
    // 'aaaa'(4) + 'bbbb'(4) = 8 > 5, so they must be in separate batches
    expect(batches).toHaveLength(2);
  });

  test('places oversized single texts in their own batch', () => {
    const huge = 'x'.repeat(500);
    const batches = U.batchTexts([huge, 'small'], 100);
    expect(batches[0]).toEqual([huge]);
    expect(batches[1]).toEqual(['small']);
  });
});

// ---------------------------------------------------------------------------
// hasTranslatableContent
// ---------------------------------------------------------------------------

describe('hasTranslatableContent', () => {
  test('returns true for Latin text', () => {
    expect(U.hasTranslatableContent('hello')).toBe(true);
  });

  test('returns true for CJK text', () => {
    expect(U.hasTranslatableContent('你好')).toBe(true);
  });

  test('returns false for pure digits', () => {
    expect(U.hasTranslatableContent('12345')).toBe(false);
  });

  test('returns false for symbols/emoji only', () => {
    expect(U.hasTranslatableContent('!@#$%')).toBe(false);
  });

  test('returns false for falsy input', () => {
    expect(U.hasTranslatableContent('')).toBe(false);
    expect(U.hasTranslatableContent(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldSkipLanguage
// ---------------------------------------------------------------------------

describe('shouldSkipLanguage', () => {
  const skipList = ['zh', 'zh-CN', 'zh-TW'];

  test('returns false for empty langCode', () => {
    expect(U.shouldSkipLanguage('', skipList, 'en')).toBe(false);
  });

  test('skips if langCode matches targetLang', () => {
    expect(U.shouldSkipLanguage('zh-cn', [], 'zh-CN')).toBe(true);
  });

  test('skips if langCode is in skipList', () => {
    expect(U.shouldSkipLanguage('zh-CN', skipList, 'en')).toBe(true);
  });

  test('skips by prefix match', () => {
    expect(U.shouldSkipLanguage('zh-HK', skipList, 'en')).toBe(true);
  });

  test('does not skip languages not in list', () => {
    expect(U.shouldSkipLanguage('en', skipList, 'zh-CN')).toBe(false);
    expect(U.shouldSkipLanguage('ja', skipList, 'zh-CN')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SEP constants
// ---------------------------------------------------------------------------

describe('SEP constants', () => {
  test('SEPARATOR is the legacy plain token', () => {
    expect(U.SEPARATOR).toBe('<<<SEP>>>');
  });

  test('SEP_PATTERN is a RegExp', () => {
    expect(U.SEP_PATTERN).toBeInstanceOf(RegExp);
  });

  test('SEP_PATTERN matches the legacy <<<SEP>>>', () => {
    expect(U.SEP_PATTERN.test('<<<SEP>>>')).toBe(true);
  });

  test('SEP_PATTERN matches numbered separators', () => {
    expect(U.SEP_PATTERN.test('<<<SEP1>>>')).toBe(true);
    expect(U.SEP_PATTERN.test('<<<SEP2>>>')).toBe(true);
    expect(U.SEP_PATTERN.test('<<<SEP99>>>')).toBe(true);
  });

  test('SEP_PATTERN does not match arbitrary text', () => {
    expect(U.SEP_PATTERN.test('<<<foo>>>')).toBe(false);
    expect(U.SEP_PATTERN.test('SEP1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// makeSeparator
// ---------------------------------------------------------------------------

describe('makeSeparator', () => {
  test('generates <<<SEP1>>> for n=1', () => {
    expect(U.makeSeparator(1)).toBe('<<<SEP1>>>');
  });

  test('generates <<<SEP2>>> for n=2', () => {
    expect(U.makeSeparator(2)).toBe('<<<SEP2>>>');
  });

  test('generates <<<SEP10>>> for n=10', () => {
    expect(U.makeSeparator(10)).toBe('<<<SEP10>>>');
  });
});

// ---------------------------------------------------------------------------
// joinForBatch
// ---------------------------------------------------------------------------

describe('joinForBatch', () => {
  test('single text has no separator', () => {
    expect(U.joinForBatch(['hello'])).toBe('hello');
  });

  test('two texts are joined with <<<SEP1>>>', () => {
    expect(U.joinForBatch(['a', 'b'])).toBe('a\n<<<SEP1>>>\nb');
  });

  test('three texts use <<<SEP1>>> and <<<SEP2>>>', () => {
    expect(U.joinForBatch(['x', 'y', 'z'])).toBe('x\n<<<SEP1>>>\ny\n<<<SEP2>>>\nz');
  });

  test('each separator number matches its 1-based position', () => {
    const texts = ['a', 'b', 'c', 'd'];
    const joined = U.joinForBatch(texts);
    expect(joined).toContain('<<<SEP1>>>');
    expect(joined).toContain('<<<SEP2>>>');
    expect(joined).toContain('<<<SEP3>>>');
    expect(joined).not.toContain('<<<SEP4>>>');
  });

  test('handles empty texts array', () => {
    expect(U.joinForBatch([])).toBe('');
  });

  test('handles texts that already contain newlines', () => {
    const result = U.joinForBatch(['line1\nline2', 'other']);
    expect(result).toBe('line1\nline2\n<<<SEP1>>>\nother');
  });
});

// ---------------------------------------------------------------------------
// splitBatchResponse
// ---------------------------------------------------------------------------

describe('splitBatchResponse', () => {
  test('returns empty array for falsy input', () => {
    expect(U.splitBatchResponse('')).toEqual([]);
    expect(U.splitBatchResponse(null)).toEqual([]);
    expect(U.splitBatchResponse(undefined)).toEqual([]);
  });

  test('splits on numbered <<<SEPn>>> tokens', () => {
    const result = U.splitBatchResponse('a\n<<<SEP1>>>\nb\n<<<SEP2>>>\nc');
    expect(result).toEqual(['a', 'b', 'c']);
  });

  test('backward compat: splits on legacy <<<SEP>>> token', () => {
    const result = U.splitBatchResponse('a\n<<<SEP>>>\nb');
    expect(result).toEqual(['a', 'b']);
  });

  test('trims surrounding whitespace from each part', () => {
    const result = U.splitBatchResponse(' hello \n<<<SEP1>>>\n world ');
    expect(result).toEqual(['hello', 'world']);
  });

  test('round-trips with joinForBatch for 1 text', () => {
    const texts = ['only one'];
    const joined = U.joinForBatch(texts);
    expect(U.splitBatchResponse(joined)).toEqual(texts);
  });

  test('round-trips with joinForBatch for multiple texts', () => {
    const texts = ['alpha', 'beta', 'gamma', 'delta'];
    const joined = U.joinForBatch(texts);
    expect(U.splitBatchResponse(joined)).toEqual(texts);
  });

  test('round-trips when texts contain internal newlines', () => {
    const texts = ['line1\nline2', 'other text'];
    const joined = U.joinForBatch(texts);
    expect(U.splitBatchResponse(joined)).toEqual(texts);
  });

  test('handles single segment with no separator', () => {
    expect(U.splitBatchResponse('hello world')).toEqual(['hello world']);
  });
});
