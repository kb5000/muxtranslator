'use strict';

/**
 * Regression tests for the numbered <<<SEPn>>> separator feature.
 *
 * These tests document the expected contract so that future refactors cannot
 * silently break the batch translation mechanism.
 */

const U = require('../src/lib/utils');

// ---------------------------------------------------------------------------
// Separator format contract
// ---------------------------------------------------------------------------

describe('Numbered separator — format contract', () => {
  test('joinForBatch produces numbered tokens, not the legacy plain <<<SEP>>>', () => {
    const joined = U.joinForBatch(['a', 'b']);
    expect(joined).not.toContain('<<<SEP>>>');
    expect(joined).toContain('<<<SEP1>>>');
  });

  test('separator numbers are sequential starting at 1', () => {
    const joined = U.joinForBatch(['a', 'b', 'c', 'd']);
    const matches = joined.match(/<<<SEP(\d+)>>>/g);
    expect(matches).toEqual(['<<<SEP1>>>', '<<<SEP2>>>', '<<<SEP3>>>']);
  });

  test('N texts produce N-1 separators', () => {
    for (let n = 1; n <= 6; n++) {
      const texts = Array.from({ length: n }, (_, i) => 'text' + i);
      const joined = U.joinForBatch(texts);
      const matches = joined.match(/<<<SEP\d+>>>/g) || [];
      expect(matches).toHaveLength(n - 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip contract (join → model passes through → split)
// ---------------------------------------------------------------------------

describe('Numbered separator — round-trip', () => {
  test('split(join(texts)) === texts for 1..10 items', () => {
    for (let n = 1; n <= 10; n++) {
      const texts = Array.from({ length: n }, (_, i) => 'segment_' + i);
      const joined = U.joinForBatch(texts);
      const recovered = U.splitBatchResponse(joined);
      expect(recovered).toEqual(texts);
    }
  });

  test('round-trip survives texts with embedded newlines', () => {
    const texts = ['first\nsecond line', 'another\none'];
    expect(U.splitBatchResponse(U.joinForBatch(texts))).toEqual(texts);
  });

  test('round-trip survives texts with special regex characters', () => {
    const texts = ['(hello)', '[world]', '{foo}', 'a.b*c?'];
    expect(U.splitBatchResponse(U.joinForBatch(texts))).toEqual(texts);
  });
});

// ---------------------------------------------------------------------------
// Model output simulation: numbered tokens preserved correctly
// ---------------------------------------------------------------------------

describe('Numbered separator — model response simulation', () => {
  test('model that preserves <<<SEPn>>> gives correct split', () => {
    // Simulate a model that translates each segment and keeps separators intact
    const original = U.joinForBatch(['Hello', 'World', 'Foo']);
    const modelResponse = original
      .replace('Hello', 'Hola')
      .replace('World', 'Mundo')
      .replace('Foo', 'Bar');
    expect(U.splitBatchResponse(modelResponse)).toEqual(['Hola', 'Mundo', 'Bar']);
  });

  test('model that returns legacy <<<SEP>>> still splits correctly (backward compat)', () => {
    const modelResponse = 'Trans1\n<<<SEP>>>\nTrans2\n<<<SEP>>>\nTrans3';
    expect(U.splitBatchResponse(modelResponse)).toEqual(['Trans1', 'Trans2', 'Trans3']);
  });

  test('model that mixes numbered and legacy separators still splits', () => {
    const modelResponse = 'A\n<<<SEP1>>>\nB\n<<<SEP>>>\nC';
    expect(U.splitBatchResponse(modelResponse)).toEqual(['A', 'B', 'C']);
  });

  test('extra whitespace around segments is trimmed after split', () => {
    const modelResponse = '  alpha  \n<<<SEP1>>>\n  beta  ';
    expect(U.splitBatchResponse(modelResponse)).toEqual(['alpha', 'beta']);
  });
});

// ---------------------------------------------------------------------------
// SEP_PATTERN — regex correctness
// ---------------------------------------------------------------------------

describe('SEP_PATTERN regex', () => {
  const RE = U.SEP_PATTERN;

  const shouldMatch = [
    '<<<SEP>>>',
    '<<<SEP0>>>',
    '<<<SEP1>>>',
    '<<<SEP9>>>',
    '<<<SEP10>>>',
    '<<<SEP99>>>',
    '<<<SEP100>>>',
  ];

  const shouldNotMatch = [
    '<<SEP1>>',
    '<<<sep1>>>',
    '<<<SEP1>>',
    'SEP1',
    '<<<SEP!>>>',
    '<<<SEP1.2>>>',
  ];

  shouldMatch.forEach(function (tok) {
    test('matches ' + tok, () => {
      expect(RE.test(tok)).toBe(true);
    });
  });

  shouldNotMatch.forEach(function (tok) {
    test('does NOT match ' + tok, () => {
      expect(RE.test(tok)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// makeSeparator contract
// ---------------------------------------------------------------------------

describe('makeSeparator', () => {
  test('matches SEP_PATTERN', () => {
    for (let i = 0; i <= 10; i++) {
      expect(U.SEP_PATTERN.test(U.makeSeparator(i))).toBe(true);
    }
  });

  test('each index produces a distinct token', () => {
    const tokens = [1, 2, 3, 4, 5].map(U.makeSeparator);
    const unique = new Set(tokens);
    expect(unique.size).toBe(5);
  });
});
