import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retro } from './retro.mjs';
import { appendSnapshot, isoWeek } from './series.mjs';

// T9: issue context:growth, tri thuc:retire-candidates; F3 tinh tang static_tokens > 10%/tuan la xau
const NOW = Date.parse('2026-11-11T10:00:00Z');
const WEEK = 7 * 86400000;
const ST = 'kpi-context-tax.static_tokens';
let tmp, base;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-kpi-')); base = { dataDir: tmp, nowMs: NOW, current: true, kpi: { [ST]: 1000 }, baseline: {}, processChanges: null, appliedLog: [], proposals: [], ledgerEntries: [] }; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const seed = (vals) => vals.forEach((v, i) => { const n = vals.length - i; appendSnapshot(path.join(tmp, 'retro', 'series.jsonl'), { week: isoWeek(NOW - n * WEEK), kpi: { [ST]: v }, selfdev: { static_tokens: v, self_initiated_rate: 0.5 }, nowMs: NOW - n * WEEK }); });

test('static_tokens +20% so voi tuan truoc -> issue context:growth; +5% -> khong', async () => {
  seed([1000, 800]);
  const r = await retro(base); // 1000 vs 800 = +25%
  expect(r.issues.map((i) => i.key)).toContain('context:growth');
  expect(r.plan.tasks.find((t) => t.key === 'context:growth').summary).toContain('static_tokens');
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
  seed([1000, 960]);
  const q = await retro(base); // +4.2%
  expect(q.issues.map((i) => i.key)).not.toContain('context:growth');
});

test('retire_candidates >= 1 -> issue knowledge:retire-candidates chi liet ke so luong; 0 -> khong', async () => {
  const r = await retro({ ...base, kpi: { 'kpi-knowledge.retire_candidates': 7 } });
  const i = r.issues.find((x) => x.key === 'knowledge:retire-candidates');
  expect(i.summary).toContain('7');
  const z = await retro({ ...base, nowMs: NOW + 30 * WEEK, kpi: { 'kpi-knowledge.retire_candidates': 0 } });
  expect(z.issues.map((x) => x.key)).not.toContain('knowledge:retire-candidates');
});

test('effectRows.suggest: improved=keep, no_effect=xem lai hoac hoan tac, worse=rollback', async () => {
  const mk = (id, verdict) => ({ id, kind: 'fix', change: { target: null }, effect: { verdict } });
  const r = await retro({ ...base, proposals: [mk('a', 'improved'), mk('b', 'no_effect'), mk('c', 'worse'), mk('d', 'better')] });
  expect(r.effects.map((e) => e.suggest)).toEqual(['keep', 'xem lai hoac hoan tac', 'rollback', 'keep']);
});

test('dedupe: issue moi khong tao lai sau khi da emitted; tran 3 task van de van giu', async () => {
  const calls = [];
  const runner = (cmd, args) => { if (cmd === 'projects') calls.push(args); return { ok: true }; };
  const o = { ...base, kpi: { 'kpi-knowledge.retire_candidates': 2 }, runner, apply: true };
  await retro(o);
  expect(calls.length).toBe(1);
  await retro(o);
  expect(calls.length).toBe(1);
});

test('F3: static_tokens tang > 10%/tuan hai tuan lien -> stalled (worse), du cac chi so khac tot', async () => {
  seed([1000, 1200, 1500]); // tuan truoc +20%, tuan nay (kpi 1800) +20%
  const r = await retro({ ...base, kpi: { [ST]: 1800 } });
  expect(r.direction).toBe('worse');
  expect(r.stalled).toBe(true);
});

test('F3: static_tokens tang <= 10% khong tu no bao worse', async () => {
  seed([1000, 1050, 1100]);
  const r = await retro({ ...base, kpi: { [ST]: 1150 } });
  expect(r.direction).not.toBe('worse'); // chi nguong 10% moi tu ep worse (flat van theo luat cu)
});
