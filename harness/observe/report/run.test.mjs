import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDerived, buildReport, saveBaseline, putObsidian, kickReport, markRun, baselineFile } from './run.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rrun-'));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ev = { ts: new Date(NOW - 86400000).toISOString(), sid: 's1', event: 'PostToolUse', tool: 'Bash', target: 'harness tasks' };

test('buildReport tren du lieu tiem vao: du muc, khong loi, baseline null', async () => {
  const r = await buildReport({ nowMs: NOW, events: [ev], ledger: [], baseline: null, process: [], projectDir: null });
  assert.equal(r.results.length, 23); assert.deepEqual(r.errors, []);
  assert.match(r.markdown, /# Bao cao harness tuan 2026-11-05/);
  assert.match(r.markdown, /chua chot/);
});

test('onError cua derive: tien to = ten derive, khong cung cost-repeat', async () => {
  const sec = { order: 1, id: 'x', title: 'x', source: 'derived', derive: 'roi_x', group_by: ['k'], metric: 'sum:n', window_days: 0, format: 'list', limit: 5 };
  const r = await buildReport({ nowMs: NOW, events: [ev], ledger: [], baseline: null, process: [], sections: [sec], derived: { roi_x: (a) => { a.onError('ids: unavailable'); return []; } } });
  assert.ok(r.errors.includes('roi_x: ids: unavailable'), JSON.stringify(r.errors));
  assert.ok(!r.errors.some((e) => e.startsWith('cost-repeat:')));
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
  const r = await buildReport({ nowMs: NOW, events: evs, ledger: [], baseline: null, process: [], inventory: undefined });
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
  const base = { nowMs: NOW, events: [ev], ledger: [], baseline: null, process: [], projectDir: null, hubDir: os.tmpdir() };
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
  const base = { nowMs: NOW, events: [ev], ledger: [], baseline: null, process: [], projectDir: null, hubDir: os.tmpdir(), days: 1, has: () => true, tasks: [] };
  const prev = await buildReport({ ...base, compare: 'prev' });
  assert.match(prev.markdown, /hom qua/); assert.doesNotMatch(prev.markdown, /tb \d+ ngay truoc/);
  const avg = await buildReport({ ...base, compare: 'avg', avgOf: 3 });
  assert.match(avg.markdown, /tb (\d\/)?3 ngay truoc/); assert.doesNotMatch(avg.markdown, /hom qua/);
});

import { loadTasks, reportName, TASK_LIMIT } from './run.mjs';
test('loadTasks: fail-open (status != 0, JSON hong, khong phai mang) va truyen --limit', () => {
  assert.equal(loadTasks('.', { run: () => ({ status: 1, stdout: '[]' }) }), undefined);
  assert.equal(loadTasks('.', { run: () => ({ status: 0, stdout: '{xx' }) }), undefined);
  assert.equal(loadTasks('.', { run: () => ({ status: 0, stdout: '{"a":1}' }) }), undefined);
  assert.equal(loadTasks('.', { run: () => { throw new Error('x'); } }), undefined);
  let args;
  const ok = loadTasks('.', { run: (_n, a) => { args = a; return { status: 0, stdout: '[{"status":"completed"}]' }; } });
  assert.deepEqual(ok, { tasks: [{ status: 'completed' }], truncated: null });
  assert.ok(args.includes('--limit') && args.includes(String(TASK_LIMIT)));
});

test('loadTasks cham tran limit -> truncated, hien trong bao cao', async () => {
  const many = JSON.stringify(Array.from({ length: TASK_LIMIT }, () => ({ status: 'completed', modified: new Date(NOW - 3600e3).toISOString() })));
  const run = () => ({ status: 0, stdout: many });
  assert.equal(loadTasks('.', { run }).truncated, 'tasks_limit');
  const r = await buildReport({ nowMs: NOW, events: [ev], ledger: [], baseline: null, process: [], projectDir: null, hubDir: os.tmpdir(), has: () => true, runTasks: run });
  assert.equal(r.truncated, 'tasks_limit'); assert.match(r.markdown, /truncated: tasks_limit/);
});

test('buildReport khong spawn task khi khong co muc task_done_rate', async () => {
  let n = 0;
  const sections = [{ id: 'x', source: 'audit', metric: 'count', window_days: 7, format: 'kpi' }];
  await buildReport({ nowMs: NOW, events: [ev], ledger: [], baseline: null, sections, hubDir: os.tmpdir(), has: () => true, runTasks: () => { n++; return { status: 0, stdout: '[]' }; } });
  assert.equal(n, 0);
});

test('reportName/writeReportFile: ten theo cua so + xoay vong 12 file moi ho', () => {
  assert.match(reportName(1, NOW).name, /^harness-daily-\d{4}-\d\d-\d\d$/);
  assert.match(reportName(3, NOW).name, /^harness-3d-\d{4}-\d\d-\d\d$/);
  assert.match(reportName(7, NOW).name, /^harness-weekly-\d{4}-W\d\d$/);
  const d = mk(); const o = { env: { HUB_DATA_DIR: d } };
  for (let i = 0; i < 15; i++) { writeReportFile('d', { dataOpts: o, nowMs: NOW + i * 86400e3, days: 1 }); writeReportFile('w', { dataOpts: o, nowMs: NOW + i * 7 * 86400e3 }); }
  writeReportFile('t', { dataOpts: o, nowMs: NOW, days: 3 });
  const names = fs.readdirSync(path.join(path.dirname(writeReportFile('x', { dataOpts: o, nowMs: NOW, days: 3 }))));
  assert.equal(names.filter((n) => n.startsWith('harness-daily-')).length, 12);
  assert.equal(names.filter((n) => n.startsWith('harness-weekly-')).length, 12);
  assert.equal(names.filter((n) => n.startsWith('harness-3d-')).length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('resolveReport doc tu file config (HARNESS_CONFIG_DIR/report/default.json), flag thang config', () => {
  const c = mk(); fs.mkdirSync(path.join(c, 'report'), { recursive: true });
  fs.writeFileSync(path.join(c, 'report', 'default.json'), '{"avgOf":4,"compare":"prev"}');
  const o = { env: { HARNESS_CONFIG_DIR: c }, root: c };
  assert.deepEqual(resolveReport({}, o), { avgOf: 4, compare: 'prev' });
  assert.deepEqual(resolveReport({ avgOf: 2 }, o), { avgOf: 2, compare: 'prev' });
  fs.rmSync(c, { recursive: true, force: true });
});

test('buildReport: section thieu metric + guard tat khong crash', async () => {
  const sections = [{ id: 'applied', source: 'ledger', format: 'list', window_days: 7 }, { id: 'x', source: 'audit', metric: 'count', window_days: 7, format: 'kpi' }];
  const r = await buildReport({ nowMs: NOW, events: [ev], ledger: [], baseline: null, sections, hubDir: os.tmpdir(), has: () => true });
  assert.equal(r.results.length, 2);
});

test('avg n=0 ky hop le: nhan tb 0/K, gia tri -, khong NaN', async () => {
  const base = { nowMs: NOW, events: [ev], ledger: [], baseline: null, process: [], projectDir: null, hubDir: os.tmpdir(), days: 1, has: () => true, tasks: [], compare: 'avg', avgOf: 3 };
  const r = await buildReport(base);
  assert.match(r.markdown, /tb 0\/3 ngay truoc/); assert.doesNotMatch(r.markdown, /NaN/);
});

test('buildReport: source derived dung opts.derived; khong co muc derived thi khong goi', async () => {
  let calls = 0;
  const derived = { x: () => { calls++; return [{ k: 'a', v: 3 }]; } };
  const ds = { id: 'd', source: 'derived', derive: 'x', group_by: ['k'], metric: 'sum:v', window_days: 7, format: 'kpi' };
  const au = { id: 'x', source: 'audit', metric: 'count', window_days: 7, format: 'kpi' };
  const o = { events: [], ledger: [], inventory: [], baseline: null, derived, hubDir: os.tmpdir() };
  const r = await buildReport({ ...o, sections: [ds] });
  assert.equal(r.results[0].rows[0].vals[0], 3);
  const before = calls;
  await buildReport({ ...o, sections: [au] });
  assert.equal(calls, before);
});

test('buildReport: derive_failed vao errors[] va markdown', async () => {
  const derived = { x: () => { throw new Error('boom'); } };
  const ds = { id: 'd', source: 'derived', derive: 'x', group_by: ['k'], metric: 'sum:v', window_days: 7, format: 'kpi' };
  const r = await buildReport({ events: [], ledger: [], inventory: [], baseline: null, derived, hubDir: os.tmpdir(), sections: [ds] });
  assert.ok(r.errors.some((e) => /d: derive_failed/.test(e)));
  assert.match(r.markdown, /_error: derive_failed_/);
});

test('loadDerived: tren trung giua module canh bao; loi import that ghi nhan, thieu module thi bo qua', async () => {
  const d = mk(); const w = (n, s) => fs.writeFileSync(path.join(d, n), s);
  w('a.mjs', 'export const derive = { x: () => [] };'); w('b.mjs', 'export const derive = { x: () => [] };'); w('c.mjs', 'throw new Error("hong");');
  const r = await loadDerived(['file://' + path.join(d, 'a.mjs'), 'file://' + path.join(d, 'b.mjs'), 'file://' + path.join(d, 'c.mjs'), 'file://' + path.join(d, 'nope.mjs')]);
  assert.ok(typeof r.map.x === 'function');
  assert.ok(r.errors.some((e) => /trung ten derive x/.test(e)));
  assert.ok(r.errors.some((e) => /c\.mjs/.test(e)));
  assert.equal(r.errors.filter((e) => /nope/.test(e)).length, 0);
});
