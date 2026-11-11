import { test, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selfdevMetrics, compositeDirection } from './selfdev.mjs';
import { retro } from './retro.mjs';
import { proposeMetricFix, proposeRoutingFix } from './loop.mjs';
import { render, parseArgs } from './cli.mjs';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const RM = (key, excess, n, upper = 0) => ({ key, excess, n, upper });
let tmp, base;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-route-')); base = { dataDir: tmp, nowMs: NOW, current: true, kpi: { 'kpi-routing.unknown_share': 0.1 }, baseline: {}, processChanges: null, appliedLog: [], proposals: [], ledgerEntries: [] }; });

test('selfdev: routing_compliance up, missed_agy down, excess_cost_share down; agy.share khong vao selfdev; thieu -> vang', () => {
  const m = selfdevMetrics({ kpi: { 'kpi-routing.compliance_rate': 0.8, 'kpi-routing.missed_agy': 2, 'kpi-routing.excess_cost_share': 0.1, 'kpi-agy.share': 0.3 } });
  expect([m.routing_compliance, m.missed_agy, m.excess_cost_share]).toEqual([{ value: 0.8, better: 'up' }, { value: 2, better: 'down' }, { value: 0.1, better: 'down' }]);
  expect(Object.keys(m).some((k) => /agy_share|^share$/.test(k))).toBe(false);
  const e = selfdevMetrics({});
  for (const k of ['routing_compliance', 'missed_agy', 'excess_cost_share']) expect(k in e).toBe(false);
  expect(compositeDirection({ routing_compliance: { direction: 'down', better: 'up' } })).toBe('worse');
});

test('retro: top-3 ca lech theo excess, khoa routing:<loai>:<lop>, n>=3', async () => {
  const rows = [RM('overuse_opus:code', 900, 5), RM('missed_agy:web', 0, 4, 5000), RM('under_model:test', 500, 3), RM('overuse_opus:doc', 100, 2), RM('underuse_haiku:read', 300, 9)];
  const r = await retro({ ...base, routingMisses: rows });
  const keys = r.issues.map((i) => i.key).filter((k) => k.startsWith('routing:'));
  expect(keys).toEqual(['routing:overuse_opus:code', 'routing:under_model:test', 'routing:underuse_haiku:read']); // top-3 theo excess (maxIssues cap), n<3 bo, missed_agy upper khong cong excess
  expect(JSON.stringify(r.issues)).not.toMatch(/W\d\d/);
});

test('retro: unknown_share >= 0.5 hoac thieu -> khong issue routing', async () => {
  const rows = [RM('overuse_opus:code', 900, 5)];
  expect((await retro({ ...base, kpi: { 'kpi-routing.unknown_share': 0.5 }, routingMisses: rows })).issues).toEqual([]);
  expect((await retro({ ...base, kpi: {}, routingMisses: rows })).issues).toEqual([]);
});

test('proposeRoutingFix: id on dinh p_route_<sha8>_fix, baseline tu series, khong ghi file dich, dedupe, khong luu prompt', () => {
  const dr = path.join(tmp, 'ev'); fs.mkdirSync(path.join(dr, 'retro'), { recursive: true });
  fs.writeFileSync(path.join(dr, 'retro', 'series.jsonl'), JSON.stringify({ week: '2026-W45', ts: '2026-11-10T00:00:00Z', kpi: { 'kpi-routing.compliance_rate': 0.6 } }) + '\n');
  const o = { dataRoot: dr, nowMs: NOW };
  const p = proposeRoutingFix({ kpi: 'kpi-routing.compliance_rate', better: 'up', note: 'doi luat haiku' }, o);
  expect(p.id).toMatch(/^p_route_[0-9a-f]{8}_fix$/);
  expect(p.kind).toBe('fix');
  expect(p.target_metric).toEqual({ kpi: 'kpi-routing.compliance_rate', better: 'up', baseline: 0.6 });
  expect(p.change.target).toBeNull();
  expect(proposeRoutingFix({ kpi: 'kpi-routing.compliance_rate', better: 'up' }, o)).toBeNull();
  expect(() => proposeRoutingFix({ kpi: 'kpi-context-tax.dup_lines', better: 'down' }, o)).toThrow();
  expect(() => proposeRoutingFix({ kpi: 'kpi-routing.missed_agy', better: 'sideways' }, o)).toThrow();
  expect(typeof proposeMetricFix).toBe('function');
});

test('CLI propose-metric: parse + render tao de xuat', async () => {
  const o = parseArgs(['propose-metric', '--kpi', 'kpi-routing.missed_agy', '--better', 'down', '--note', 'x']);
  expect([o.cmd, o.kpi, o.better, o.note]).toEqual(['propose-metric', 'kpi-routing.missed_agy', 'down', 'x']);
  const r = await render({ ...o, dataRoot: path.join(tmp, 'ev2') });
  expect(r.code).toBe(0);
  expect(r.summary).toContain('p_route_');
});
