import { test, expect } from 'bun:test';
import { sumAgyUsage, stepDurations, stepDuration, exitCodeOf, exitStatusOf } from './agy-usage.mjs';

const L = (o) => JSON.stringify(o);
const model = (i, inp, cr, out) => L({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-29T01:25:22Z', input_tokens: inp, cache_read_tokens: cr, output_tokens: out });

test('sumAgyUsage cong token buoc MODEL, shape sumUsage', () => {
  const r = sumAgyUsage([model(1, 100, 10, 5), model(2, 200, 20, 7)].join('\n'));
  expect(r).toEqual({ input: 300, output: 12, cache_read: 30, cache_creation: 0, total_tokens: 312, msgs: 2, model: null, tool_ms: 0, tool_steps: 0 });
});

test('dedupe theo step_index, lay output lon nhat', () => {
  const r = sumAgyUsage([model(1, 100, 10, 5), model(1, 100, 10, 9), model(1, 100, 10, 3)].join('\n'));
  expect(r.msgs).toBe(1);
  expect(r.output).toBe(9);
});

test('bo dong SYSTEM/GENERIC/JSON hong', () => {
  const t = [L({ step_index: 0, source: 'SYSTEM', type: 'GENERIC', content: 'x' }), '{"input_tokens": broken', model(3, 1, 2, 3)].join('\n');
  const r = sumAgyUsage(t);
  expect(r.msgs).toBe(1);
  expect(r.input).toBe(1);
});

test('het deadline -> null', () => {
  expect(sumAgyUsage(model(1, 1, 1, 1), Date.now() - 1)).toBeNull();
});

test('stepDurations tu Created At/Completed At co mui gio', () => {
  const g = (i, c) => L({ step_index: i, source: 'SYSTEM', type: 'GENERIC', content: c });
  const t = [
    g(5, 'Created At: 2026-10-29T08:25:22+07:00\nCompleted At: 2026-10-29T08:25:24.500+07:00\nok'),
    g(6, 'Created At: 2026-10-29T08:26:00+07:00\nno completed'),
  ].join('\n');
  const m = stepDurations(t);
  expect(m.get(5)).toBe(2500);
  expect(m.has(6)).toBe(false);
});

const gen = (i, c, type = 'GENERIC') => L({ step_index: i, source: 'SYSTEM', type, content: c });
const span = (a, b) => `Created At: ${a}\nCompleted At: ${b}\nx`;

test('dong non-MODEL co input_tokens bi bo', () => {
  const t = L({ step_index: 1, source: 'SYSTEM', type: 'GENERIC', input_tokens: 99, output_tokens: 9 });
  expect(sumAgyUsage(t).msgs).toBe(0);
});

test('stepDurations: am, content khong chuoi, tron Z/+07:00, khong phai GENERIC', () => {
  const t = [
    gen(1, span('2026-10-29T01:00:05Z', '2026-10-29T01:00:00Z')),
    L({ step_index: 2, source: 'SYSTEM', type: 'GENERIC', content: { 'Created At:': 1 } }),
    gen(3, span('2026-10-29T08:00:00+07:00', '2026-10-29T01:00:03Z')),
    gen(4, span('2026-10-29T01:00:00Z', '2026-10-29T01:00:01Z'), 'PLANNER_RESPONSE'),
    gen(5, 'note\n' + span('2026-10-29T01:00:00Z', '2026-10-29T01:00:01Z')),
  ].join('\n');
  const m = stepDurations(t);
  expect([...m.entries()]).toEqual([[3, 3000]]);
});

test('stepDuration tim dung buoc, khong thay/het deadline -> null', () => {
  const t = [gen(10, span('2026-10-29T01:00:00Z', '2026-10-29T01:00:02Z')), gen(11, span('2026-10-29T01:00:00Z', '2026-10-29T01:00:04Z'))].join('\n');
  expect(stepDuration(t, 11)).toBe(4000);
  expect(stepDuration(t, '10')).toBe(2000);
  expect(stepDuration(t, 12)).toBeNull();
  expect(stepDuration(t, 10, Date.now() - 1)).toBeNull();
});

test('exitCodeOf / exitStatusOf', () => {
  expect(exitCodeOf('foo\nCommand exited with code 3.\n')).toBe(3);
  expect(exitCodeOf('nothing')).toBeNull();
  expect(exitStatusOf('exit status 1')).toBe(1);
  expect(exitStatusOf('boom')).toBeNull();
  expect(exitStatusOf(undefined)).toBeNull();
});

test('sumAgyUsage: tool_ms/tool_steps tu dong GENERIC (khong am, khong tinh PLANNER), msgs chi dem buoc token', () => {
  const t = [
    gen(1, span('2026-10-29T01:00:00Z', '2026-10-29T01:00:00Z')),
    gen(2, span('2026-10-29T01:00:00Z', '2026-10-29T01:00:01Z')),
    gen(3, span('2026-10-29T01:00:05Z', '2026-10-29T01:00:00Z')),
    gen(4, span('2026-10-29T01:00:00Z', '2026-10-29T01:00:09Z'), 'PLANNER_RESPONSE'),
    model(5, 10, 0, 2),
  ].join('\n');
  const r = sumAgyUsage(t);
  expect(r.tool_ms).toBe(1000); expect(r.tool_steps).toBe(2); expect(r.msgs).toBe(1);
  const only = sumAgyUsage(gen(1, span('2026-10-29T01:00:00Z', '2026-10-29T01:00:02Z')));
  expect(only.msgs).toBe(0); expect(only.tool_ms).toBe(2000);
  expect(sumAgyUsage(model(1, 1, 1, 1)).tool_steps).toBe(0);
});

test('sumAgyUsage: dedupe GENERIC theo step_index', () => {
  const g = gen(7, span('2026-10-29T01:00:00Z', '2026-10-29T01:00:02Z'));
  expect(sumAgyUsage([g, g].join('\n')).tool_steps).toBe(1);
});
