import { test, expect } from 'bun:test';
import { measureDue, metricVerdict } from './effect.mjs';

// T9: do hieu qua theo chi so (target_metric.kpi / pair_recheck); nhanh fp cu o effect.test.mjs
const NOW = Date.parse('2026-10-30T12:00:00Z');
const AT = '2026-10-20T00:00:00Z';
const KEY = 'kpi-context-tax.dup_lines';
const opts = (x = {}) => ({ auditDir: '/nonexistent-audit', retentionDays: 30, auditConfig: {}, ...x });
const mprop = (id, tm, o = {}) => ({ id, kind: 'fix', status: 'applied', applied_at: AT, target_metric: tm, ...o });
const pt = (v, ts = '2026-10-29T00:00:00Z') => ({ week: '2026-W44', ts, kpi: { [KEY]: v } });

test('metricVerdict: kpi so voi baseline theo better, bien 5%', () => {
  const at = Date.parse(AT);
  const v = (series, base = 100, better = 'down') => metricVerdict({ series, kpi: KEY, baseline: base, better, appliedMs: at }).verdict;
  expect(v([pt(94)])).toBe('improved');
  expect(v([pt(95)])).toBe('improved');
  expect(v([pt(100)])).toBe('no_effect');
  expect(v([pt(105)])).toBe('worse');
  expect(v([pt(120)], 100, 'up')).toBe('improved');
  expect(v([pt(94)], null)).toBe('insufficient');
  expect(v([])).toBe('insufficient');
  expect(v([pt(50, '2026-10-19T00:00:00Z')])).toBe('insufficient'); // diem truoc apply = khong co diem moi
  expect(v([{ week: 'w', ts: '2026-10-29T00:00:00Z', kpi: {} }])).toBe('insufficient');
});

test('measureDue: target_metric.kpi doc series, khong doc audit, action keep (khong rollback)', () => {
  let reads = 0;
  const [x] = measureDue([mprop('p_dup_1_fix', { kpi: KEY, better: 'down', baseline: 100 })], NOW, opts({ series: [pt(60)], onRead: () => { reads++; } }));
  expect(reads).toBe(0);
  expect(x.effect).toMatchObject({ metric: KEY, verdict: 'improved', action: 'keep' });
  const [w] = measureDue([mprop('p_dup_2_fix', { kpi: KEY, better: 'down', baseline: 100 })], NOW, opts({ series: [pt(200)] }));
  expect(w.effect).toMatchObject({ verdict: 'worse', action: 'keep' });
  const [i] = measureDue([mprop('p_dup_3_fix', { kpi: KEY, better: 'down', baseline: null })], NOW, opts({ series: [pt(1)] }));
  expect(i.effect).toMatchObject({ verdict: 'insufficient', action: 'none' });
});

test('measureDue: pair_recheck - cap het / score giam -> improved; tang -> worse; y nguyen -> no_effect', () => {
  const tm = { pair_recheck: true, a: { file: 'A.md' }, b: { file: 'B.md' }, baseline: 0.8, better: 'down' };
  const ft = { area: 'doc', a: { path: 'A.md' }, b: { id: 'kb-1' } }; // fix_target long a/b, khong co .path phang
  const pr = (pairs) => measureDue([mprop('p_dup_4_fix', tm, { change: { fix_target: ft } })], NOW, opts({ dupePairs: { pairs, truncated: null } }))[0].effect;
  const P = (s, a = 'A.md', b = 'B.md') => ({ a: { file: a }, b: { file: b }, score: s });
  expect(pr([]).verdict).toBe('improved');
  expect(pr([P(0.9, 'X.md', 'Y.md')]).verdict).toBe('improved'); // cap khac khong tinh
  expect(pr([P(0.5)]).verdict).toBe('improved'); // < 0.6
  expect(pr([P(0.95)]).verdict).toBe('worse');
  expect(pr([P(0.8)]).verdict).toBe('no_effect');
  expect(pr([P(0.8, 'B.md', 'A.md')]).verdict).toBe('no_effect'); // thu tu hai phia khong quan trong
  const e = measureDue([mprop('p_dup_5_fix', tm)], NOW, opts({}))[0].effect;
  expect(e.verdict).toBe('insufficient'); // khong co du lieu dupes
  expect(e.action).toBe('none');
});
