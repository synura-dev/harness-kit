import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, saveBaseline, putObsidian, kickReport, markRun, baselineFile } from './run.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rrun-'));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ev = { ts: new Date(NOW - 86400000).toISOString(), sid: 's1', event: 'PostToolUse', tool: 'Bash', target: 'harness tasks' };

test('buildReport tren du lieu tiem vao: du muc, khong loi, baseline null', async () => {
  const r = await buildReport({ nowMs: NOW, events: [ev], ledger: [], baseline: null, projectDir: null });
  assert.equal(r.results.length, 11); assert.deepEqual(r.errors, []);
  assert.match(r.markdown, /# Bao cao harness tuan 2026-11-05/);
  assert.match(r.markdown, /chua chot/);
});

test('saveBaseline: dry-run khong ghi; that thi ghi va doc lai', async () => {
  const d = mk(); const o = { dataOpts: { env: { HUB_DATA_DIR: d } } };
  const r = await buildReport({ nowMs: NOW, events: [ev], ledger: [], baseline: null });
  assert.equal(saveBaseline(r, { ...o, dryRun: true }).ok, false);
  assert.equal(fs.existsSync(baselineFile(o.dataOpts)), false);
  const b = saveBaseline(r, o);
  if (b.ok) assert.equal(JSON.parse(fs.readFileSync(baselineFile(o.dataOpts), 'utf8')).date, '2026-11-05');
  assert.ok(b.baseline.kpis['kpi-info-fetch']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('putObsidian: goi cong CLI voi --section; loi/qua dai -> ok:false', () => {
  let args;
  assert.equal(putObsidian('# md', { run: (_n, a) => { args = a; return { status: 0 }; } }).ok, true);
  assert.ok(args.includes('obsidian') && args.includes('put') && args.includes('--section') && args.includes('Noi dung=# md'));
  assert.equal(putObsidian('x', { run: () => ({ status: 1, stderr: 'no' }) }).ok, false);
  assert.equal(putObsidian('x'.repeat(30000), { run: () => ({ status: 0 }) }).ok, false);
});

test('kickReport: toi da 1 lan/7 ngay + khoa', () => {
  const d = mk(); const o = { env: { HUB_DATA_DIR: d } }; let n = 0;
  const ctx = { spawnReport: () => { n++; } };
  assert.equal(kickReport(o, ctx, NOW), true); assert.equal(n, 1);
  assert.equal(kickReport(o, ctx, NOW + 60000), false); // khoa
  markRun(o, NOW);
  assert.equal(kickReport(o, ctx, NOW + 3 * 86400000), false); // < 7 ngay
  assert.equal(kickReport(o, ctx, NOW + 8 * 86400000), true); assert.equal(n, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

test('KPI2: co dong pattern (findPatterns) ben canh loi lap', async () => {
  const evs = [];
  for (let i = 0; i < 12; i++) for (const [j, t] of ['bun run build:all', 'git add .', 'git commit -m x'].entries()) evs.push({ ts: new Date(NOW - 3600000 * (i + 1) + j * 1000).toISOString(), sid: 's' + (i % 4), event: 'PostToolUse', tool: 'Bash', ok: true, dur_ms: 5, target: t });
  const r = await buildReport({ nowMs: NOW, events: evs, ledger: [], baseline: null, inventory: undefined });
  const k2 = r.results.find((x) => x.def.id === 'kpi-repeats');
  assert.ok(k2.rows.some((x) => x.key === 'pattern'), JSON.stringify(k2.rows));
});

import { writeReportFile } from './run.mjs';
test('writeReportFile: days=1 ghi harness-daily-YYYY-MM-DD, khong de len file tuan', () => {
  const d = mk(); const o = { env: { HUB_DATA_DIR: d } };
  const w = writeReportFile('W', { dataOpts: o, nowMs: NOW });
  const dd = writeReportFile('D', { dataOpts: o, nowMs: NOW, days: 1 });
  assert.match(path.basename(w), /^harness-weekly-/); assert.equal(path.basename(dd), 'harness-daily-2026-11-05.md');
  assert.equal(fs.readFileSync(w, 'utf8'), 'W');
  fs.rmSync(d, { recursive: true, force: true });
});

test('buildReport: task tu ext projects (tiem), thieu ext -> khong co nguon', async () => {
  const base = { nowMs: NOW, events: [ev], ledger: [], baseline: null, projectDir: null, hubDir: os.tmpdir() };
  const tasks = [{ status: 'completed', modified: new Date(NOW - 3600e3).toISOString() }, { status: 'needs-action', modified: new Date(NOW - 3600e3).toISOString() }];
  const ok = await buildReport({ ...base, tasks, has: () => true });
  assert.match(ok.markdown, /task done\*\*: 0\.50/);
  const miss = await buildReport({ ...base, tasks, has: () => false });
  assert.match(miss.markdown, /thieu ext:projects/);
});

import { resolveReport, REPORT_DEFAULTS } from './run.mjs';
import { parseArgs } from './cli.mjs';
test('tham so tinh toan: mac dinh, ghi de flag/env, gia tri sai -> mac dinh', () => {
  const o = { root: mk(), env: {} };
  assert.deepEqual(resolveReport({}, o), { avgOf: 7, compare: 'all' });
  assert.deepEqual(resolveReport({ avgOf: 3, compare: 'avg' }, o), { avgOf: 3, compare: 'avg' });
  assert.equal(resolveReport({}, { ...o, env: { HARNESS_REPORT_AVG_OF: '5' } }).avgOf, 5);
  assert.deepEqual(resolveReport({ avgOf: -2, compare: 'zz' }, o), { avgOf: 7, compare: 'all' });
  assert.equal(resolveReport({ avgOf: 999 }, o).avgOf, REPORT_DEFAULTS.avgOfMax);
});

test('cli: --avg-of / --compare parse, compare sai -> loi', () => {
  const o = parseArgs(['report', '--avg-of', '3', '--compare=prev']);
  assert.equal(o.avgOf, 3); assert.equal(o.compare, 'prev');
  assert.throws(() => parseArgs(['report', '--compare', 'x']));
});

test('buildReport: --compare prev chi cot truoc, --avg-of doi nhan', async () => {
  const base = { nowMs: NOW, events: [ev], ledger: [], baseline: null, projectDir: null, hubDir: os.tmpdir(), days: 1, has: () => true, tasks: [] };
  const prev = await buildReport({ ...base, compare: 'prev' });
  assert.match(prev.markdown, /hom qua/); assert.doesNotMatch(prev.markdown, /tb \d+ ngay truoc/);
  const avg = await buildReport({ ...base, compare: 'avg', avgOf: 3 });
  assert.match(avg.markdown, /tb 3 ngay truoc/); assert.doesNotMatch(avg.markdown, /hom qua/);
});
