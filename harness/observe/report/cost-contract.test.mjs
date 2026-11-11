import { test, expect } from 'bun:test';
import { LIMITS, emptySegment, effTokens, median, foldText } from './cost-contract.mjs';

test('LIMITS giu hang so hop dong', () => {
  expect(LIMITS).toEqual({ maxEvents: 200000, maxSegments: 5000, maxProblems: 2000, timeoutMs: 15000, lookbackDays: 28, indexTtlDays: 90, cacheReadWeight: 0.1, minSide: 3, maxDupPairs: 50, maxBlocks: 3000 });
});
test('effTokens', () => {
  expect(effTokens({ input: 10, cache_creation: 20, output: 30, cache_read: 100 })).toBeCloseTo(70);
  expect(effTokens({})).toBe(0);
  expect(effTokens(null)).toBe(0);
});
test('median chan/le/rong', () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(median([])).toBeNull();
});
test('foldText', () => {
  expect(foldText('Đường dẫn')).toBe('duong dan');
  expect(foldText('  Hello \n\t World ')).toBe('hello world');
});
test('emptySegment doc lap nhau', () => {
  const a = emptySegment(); const b = emptySegment();
  a.kfetch.push('x'); a.tokens.input = 5;
  expect(b.kfetch).toEqual([]); expect(b.tokens.input).toBe(0);
  expect(Object.keys(a).sort()).toEqual(['eff_tokens', 'end_ts', 'family', 'fetches', 'keys', 'kfetch', 'precision', 'problem', 'prompt_kw', 'sid', 'start_ts', 'sub_tokens', 'tokens', 'tools', 'turns', 'wall_ms'].sort());
});
