import { test, expect } from 'bun:test';
import { parseDate, parseWmicDate, listProcesses } from './proc-list.mjs';

test('parseDate nhan /Date(ms)/ va ISO, rac -> null', () => {
  expect(parseDate('/Date(1000)/')).toBe(1000);
  expect(parseDate('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'));
  expect(parseDate('x')).toBeNull();
});
test('parseWmicDate: tru do lech phut o cuoi (gio local -> UTC dung)', () => {
  expect(parseWmicDate('20260105103000.123456+420')).toBe(Date.UTC(2026, 0, 5, 3, 30, 0, 123)); // UTC+7
  expect(parseWmicDate('20260105103000.000000-300')).toBe(Date.UTC(2026, 0, 5, 15, 30, 0)); // UTC-5
  expect(parseWmicDate('20260105103000.000000+000')).toBe(Date.UTC(2026, 0, 5, 10, 30, 0));
  expect(parseWmicDate('20260105103000')).toBe(new Date(2026, 0, 5, 10, 30, 0).getTime()); // khong do lech: local
  expect(parseWmicDate('rac')).toBeNull(); expect(parseWmicDate('')).toBeNull();
});
test('listProcesses tra mang procs', () => {
  expect(Array.isArray(listProcesses({ timeoutMs: 20000 }).procs)).toBe(true);
});
