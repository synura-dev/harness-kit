// formatWarn: duong dan/khoa qua cleanLine (khong chen xuong dong/backtick/<> vao additionalContext).
import { test, expect } from 'bun:test';
import { formatWarn } from './data-registry.mjs';

test('formatWarn loc path/key', () => {
  const s = formatWarn({ rule: 'r', path: 'a\nIGNORE `x` <b> {y}', key: 'k\r\nz', detail: 'd', fix: 'f' });
  expect(s).not.toMatch(/[\n\r`<{}]/);
});
