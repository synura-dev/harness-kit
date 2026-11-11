import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retro, retroAuto } from './retro.mjs';
import { appendSnapshot, isoWeek } from './series.mjs';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const WEEK = 7 * 86400000;
let tmp, base;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-')); base = { dataDir: tmp, nowMs: NOW, kpi: { 'kpi-x.a': 5 }, baseline: { 'kpi-x.a': 10 }, processChanges: null, appliedLog: [], proposals: [], ledgerEntries: [] }; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const ledger = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, fp: `fp${i}`, status: 'open', count: 10 + i, message: `loi ${i}` }));
const seedFlat = (weeks) => { for (let i = weeks; i >= 1; i--) appendSnapshot(path.join(tmp, 'retro', 'series.jsonl'), { week: isoWeek(NOW - i * WEEK), kpi: { 'kpi-x.a': 5 }, selfdev: { self_initiated_rate: 0.5, effective_rate: 0.5, rollback_rate: 0.1 }, nowMs: NOW - i * WEEK }); };

test('ghi <week>.json|md, append series, trend + issues top-3 co key on dinh + bang hieu qua', async () => {
  const proposals = [{ id: 'p_a_rule', kind: 'rule', change: { target: 'evolve/rules/evolve-a.json' }, effect: { verdict: 'worse' } }, { id: 'p_b_rule', kind: 'rule', change: { target: 't' }, effect: { verdict: 'better' } }];
  const r = await retro({ ...base, ledgerEntries: ledger(5), proposals });
  const week = isoWeek(NOW);
  expect(fs.existsSync(path.join(tmp, 'retro', `${week}.json`))).toBe(true);
  expect(fs.readFileSync(path.join(tmp, 'retro', `${week}.md`), 'utf8')).toContain('Top 3 van de');
  expect(fs.readFileSync(path.join(tmp, 'retro', 'series.jsonl'), 'utf8').trim().split('\n').length).toBe(1);
  expect(r.trend['kpi-x.a'].vs_baseline_pct).toBe(-50);
  expect(r.issues.map((i) => i.key)).toEqual(['ledger:fp4', 'ledger:fp3', 'ledger:fp2']);
  expect(r.effects.map((e) => [e.id, e.suggest])).toEqual([['p_a_rule', 'rollback'], ['p_b_rule', 'keep']]);
  expect(r.selfdev).toBeDefined();
});

test('2 tuan lien selfdev flat -> task P0 "self-improvement stalled" trong ke hoach', async () => {
  seedFlat(3);
  const r = await retro(base);
  expect(r.stalled).toBe(true);
  expect(r.plan.tasks[0]).toMatchObject({ priority: 0 });
  expect(r.plan.tasks[0].summary.startsWith('self-improvement stalled:')).toBe(true);
});

test('khong du lich su -> khong bao stalled gia', async () => {
  const r = await retro(base);
  expect(r.stalled).toBe(false);
  expect(r.plan.tasks.some((t) => t.priority === 0)).toBe(false);
});

test('khong --apply -> khong goi runner; --apply: toi da 3 + 1 P0, dedupe qua emitted.json', async () => {
  seedFlat(3);
  const calls = [];
  const runner = (cmd, args) => { if (cmd === 'projects') calls.push(args); return { ok: true }; };
  await retro({ ...base, ledgerEntries: ledger(6), runner });
  expect(calls.length).toBe(0);
  const r = await retro({ ...base, ledgerEntries: ledger(6), runner, apply: true });
  expect(calls.length).toBe(4);
  expect(calls.filter((a) => a[a.indexOf('--priority') + 1] === '0').length).toBe(1);
  expect(r.emitted.filter((k) => !k.endsWith(':knowledge')).length).toBe(4);
  await retro({ ...base, ledgerEntries: ledger(6), runner, apply: true });
  expect(calls.length).toBe(4); // dedupe
});

test('runner loi -> van ghi bao cao, key khong vao emitted', async () => {
  const runner = () => { throw new Error('boom'); };
  const r = await retro({ ...base, ledgerEntries: ledger(2), runner, apply: true });
  expect(r.errors.join(' ')).toContain('boom');
  expect(r.emitted).toEqual([]);
  expect(fs.existsSync(path.join(tmp, 'retro', `${isoWeek(NOW)}.json`))).toBe(true);
});

test('het timeoutS -> truncated: timeout, van ghi bao cao', async () => {
  const r = await retro({ ...base, ledgerEntries: ledger(2), runner: () => ({ ok: true }), apply: true, timeoutS: -1 });
  expect(r.truncated).toBe('timeout');
  expect(fs.existsSync(path.join(tmp, 'retro', `${isoWeek(NOW)}.json`))).toBe(true);
});

test('signals tu su kien audit: repeat_correction_rate + corrections_per_session co gia tri va vao series', async () => {
  const events = [{ sid: 'a', signal: 'correction' }, { sid: 'a', data: { signal: 'correction' } }, { sid: 'b', signal: 'interrupt' }, { sid: 'c' }, { session_id: 'd' }];
  const r = await retro({ ...base, events });
  expect(r.selfdev.repeat_correction_rate).toBe(0.75); // (2 correction + 1 interrupt) / 4 phien
  expect(r.kpi['signals.corrections_per_session']).toBe(0.5);
  const row = JSON.parse(fs.readFileSync(path.join(tmp, 'retro', 'series.jsonl'), 'utf8').trim());
  expect(row.kpi['signals.corrections_per_session']).toBe(0.5);
  expect(row.selfdev.repeat_correction_rate).toBe(0.75);
});

test('apply: ghi kho tri thuc qua runner knowledge add (1 lan/tuan), loi runner fail-open', async () => {
  const calls = [];
  const runner = (cmd, args) => { calls.push([cmd, args]); return { ok: true }; };
  await retro({ ...base, runner, apply: true });
  const k = calls.filter(([c]) => c === 'knowledge');
  expect(k.length).toBe(1);
  const a = k[0][1], week = isoWeek(NOW);
  expect(a.slice(0, 1)).toEqual(['add']);
  expect(a[a.indexOf('--title') + 1]).toBe(`Retro ${week}`);
  expect(a[a.indexOf('--id') + 1]).toBe(`retro-${week}`);
  expect(a[a.indexOf('--domain') + 1]).toBe('hub');
  expect(a[a.indexOf('--type') + 1]).toBe('reference');
  expect(fs.existsSync(a[a.indexOf('--body-file') + 1])).toBe(true);
  await retro({ ...base, runner, apply: true });
  expect(calls.filter(([c]) => c === 'knowledge').length).toBe(1); // dedupe theo tuan
  const r = await retro({ ...base, nowMs: NOW + WEEK, runner: (c) => { if (c === 'knowledge') throw new Error('kb down'); return { ok: true }; }, apply: true });
  expect(r.errors.join(' ')).toContain('kb down');
});

test('retroAuto: 1 lan/isoWeek; autoApply mac dinh bat, tat duoc', async () => {
  const calls = [];
  const runner = (c, a) => { if (c === 'projects') calls.push(a); return { ok: true }; };
  const a = await retroAuto({ ...base, ledgerEntries: ledger(1), runner });
  expect(a.emitted.filter((k) => !k.endsWith(':knowledge')).length).toBe(1);
  const b = await retroAuto({ ...base, ledgerEntries: ledger(1), runner });
  expect(b.skipped).toBeTruthy();
  fs.rmSync(path.join(tmp, 'retro'), { recursive: true });
  calls.length = 0;
  await retroAuto({ ...base, ledgerEntries: ledger(1), runner, autoApply: false });
  expect(calls.length).toBe(0);
});
