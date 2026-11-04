import { test, expect } from 'bun:test';
import { parseDate, listProcesses } from './proc-list.mjs';

test('parseDate nhan /Date(ms)/ va ISO, rac -> null', () => {
  expect(parseDate('/Date(1000)/')).toBe(1000);
  expect(parseDate('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'));
  expect(parseDate('x')).toBeNull();
});
test('listProcesses tra mang procs', () => {
  expect(Array.isArray(listProcesses({ timeoutMs: 20000 }).procs)).toBe(true);
});
