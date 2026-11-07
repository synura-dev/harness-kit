import { test, expect } from 'bun:test';
import { sumAgyUsage, stepDurations, exitCodeOf, exitStatusOf } from './agy-usage.mjs';

const L = (o) => JSON.stringify(o);
const model = (i, inp, cr, out) => L({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-29T01:25:22Z', input_tokens: inp, cache_read_tokens: cr, output_tokens: out });

test('sumAgyUsage cong token buoc MODEL, shape sumUsage', () => {
  const r = sumAgyUsage([model(1, 100, 10, 5), model(2, 200, 20, 7)].join('\n'));
  expect(r).toEqual({ input: 300, output: 12, cache_read: 30, cache_creation: 0, total_tokens: 312, msgs: 2, model: null });
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

test('exitCodeOf / exitStatusOf', () => {
  expect(exitCodeOf('foo\nCommand exited with code 3.\n')).toBe(3);
  expect(exitCodeOf('nothing')).toBeNull();
  expect(exitStatusOf('exit status 1')).toBe(1);
  expect(exitStatusOf('boom')).toBeNull();
  expect(exitStatusOf(undefined)).toBeNull();
});
