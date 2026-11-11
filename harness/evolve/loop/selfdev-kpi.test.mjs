import { test, expect } from 'bun:test';
import { selfdevMetrics, compositeDirection } from './selfdev.mjs';

// T9: chi so chi phi/ngu canh tu kpi (khoa series on dinh); thieu -> bo qua, khong flat gia
const K = {
  'kpi-cost-repeat.repeat_vs_first_ratio': 0.8, 'kpi-cost-repeat.eff_tokens_per_problem': 5000, 'kpi-cost-repeat.key_coverage': 0.9,
  'kpi-context-tax.static_tokens': 9000, 'kpi-context-tax.dup_lines': 4, 'kpi-knowledge.roi_saved_tokens': 12000,
};

test('selfdev nhan 6 chi so tu kpi kem better dung huong', () => {
  const m = selfdevMetrics({ kpi: K });
  const got = Object.fromEntries(['repeat_vs_first_ratio', 'eff_tokens_per_problem', 'static_tokens', 'dup_lines', 'roi_saved_tokens', 'key_coverage'].map((k) => [k, m[k] && [m[k].value, m[k].better]]));
  expect(got).toEqual({ repeat_vs_first_ratio: [0.8, 'down'], eff_tokens_per_problem: [5000, 'down'], static_tokens: [9000, 'down'], dup_lines: [4, 'down'], roi_saved_tokens: [12000, 'up'], key_coverage: [0.9, 'up'] });
});

test('thieu kpi -> khong co khoa (khong flat gia); khoa khong phai so bi bo', () => {
  const m = selfdevMetrics({});
  for (const k of ['repeat_vs_first_ratio', 'static_tokens', 'roi_saved_tokens', 'key_coverage']) expect(k in m).toBe(false);
  const p = selfdevMetrics({ kpi: { 'kpi-context-tax.static_tokens': 100, 'kpi-context-tax.dup_lines': null } });
  expect(Object.keys(p).filter((k) => ['static_tokens', 'dup_lines'].includes(k))).toEqual(['static_tokens']);
});

test('compositeDirection: static_tokens tang -> worse (better down)', () => {
  expect(compositeDirection({ static_tokens: { direction: 'up', better: 'down' }, roi_saved_tokens: { direction: 'up', better: 'up' } })).toBe('worse');
});
