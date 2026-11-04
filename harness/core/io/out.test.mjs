import { test, expect } from 'bun:test';
import { parseCommon, emit } from './out.mjs';

test('parseCommon', () => {
  const c = parseCommon(['x', '--json', '--raw', '--max-bytes', '10', '--timeout-s=5', 'y']);
  expect(c).toEqual({ json: true, raw: true, maxBytes: 10, timeoutS: 5, rest: ['x', 'y'] });
});
test('emit summary / json / raw', () => {
  expect(emit({ summary: 's', data: { a: 1 }, raw: 'R' }, { write: false }).text).toBe('s');
  expect(JSON.parse(emit({ summary: 's', data: { a: 1 } }, { json: true, write: false }).text)).toEqual({ a: 1 });
  expect(emit({ summary: 's', raw: 'R' }, { raw: true, write: false }).text).toBe('R');
});
test('emit truncated mot nhan', () => {
  expect(emit({ summary: 'abcdef' }, { maxBytes: 3, write: false })).toEqual({ text: 'abc', label: 'truncated: max-bytes 3' });
  expect(emit({ summary: 'x', truncated: 'timeout' }, { write: false }).label).toBe('truncated: timeout');
});
