import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retro, retroAuto, signalsFrom, pickKpi } from './retro.mjs';
import { kpiSnapshot } from '../../observe/report/engine.mjs';
import { workspaceRoot } from '../../core/io/paths.mjs';
import { appendSnapshot, isoWeek } from './series.mjs';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const WEEK = 7 * 86400000;
let tmp, base;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-')); base = { dataDir: tmp, nowMs: NOW, current: true, kpi: { 'kpi-x.a': 5 }, baseline: { 'kpi-x.a': 10 }, processChanges: null, appliedLog: [], proposals: [], ledgerEntries: [] }; });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const ledger = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, fp: `fp${i}`, status: 'open', count: 10 + i, message: `loi ${i}` }));
const seedFlat = (weeks) => { for (let i = weeks; i >= 1; i--) appendSnapshot(path.join(tmp, 'retro', 'series.jsonl'), { week: isoWeek(NOW - i * WEEK), kpi: { 'kpi-x.a': 5 }, selfdev: { self_initiated_rate: 0.5, effective_rate: 0.5, rollback_rate: 0.1 }, nowMs: NOW - i * WEEK }); };

test('ghi <week>.json|md, append series, trend + issues top-3 co key on dinh + bang hieu qua', async () => {
  const proposals = [{ id: 'p_a_rule', kind: 'rule', change: { target: 'evolve/rules/evolve-a.json' }, effect: { verdict: 'worse' } }, { id: 'p_b_rule', kind: 'rule', change: { target: 't' }, effect: { verdict: 'better' } }];
  const r = await retro({ ...base, current: false, ledgerEntries: ledger(5), proposals });
  const week = isoWeek(NOW - WEEK);
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
  expect(r.plan.tasks[0].summary.startsWith('[P0] self-improvement stalled:')).toBe(true);
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
  const r = await retro({ ...base, current: false, events });
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

test('mac dinh tinh TUAN VUA XONG (nhan tuan truoc, cua so tuan truoc); current:true tinh tuan dang chay', async () => {
  const appliedLog = [{ ts: new Date(NOW - 5 * 86400000).toISOString(), op: 'apply', ok: true, id: 'x' }]; // 2026-11-06, tuan truoc
  const prev = await retro({ ...base, current: false, appliedLog });
  expect(prev.week).toBe(isoWeek(NOW - WEEK));
  expect(prev.selfdev.self_initiated_rate).toBe(1);
  const cur = await retro({ ...base, current: true, appliedLog });
  expect(cur.week).toBe(isoWeek(NOW));
  expect(cur.selfdev.self_initiated_rate).toBeNull();
});

test('dedupe task theo key van de (khong gan tuan): van de da tao task khong tao lai, chi lay van de MOI', async () => {
  const calls = [];
  const runner = (c, a) => { if (c === 'projects') calls.push(a[a.indexOf('--summary') + 1]); return { ok: true }; };
  await retro({ ...base, ledgerEntries: ledger(3), runner, apply: true });
  expect(calls.length).toBe(3);
  const more = [...ledger(3), { id: 'n', fp: 'fpNew', status: 'open', count: 1, message: 'loi moi' }];
  const r = await retro({ ...base, nowMs: NOW + WEEK, ledgerEntries: more, runner, apply: true });
  expect(r.issues.map((i) => i.key)).toEqual(['ledger:fpNew']);
  expect(calls.length).toBe(4);
});

test('marker <week>.auto.json chi sau apply thanh cong; xem truoc khong chan; loi -> thu lai', async () => {
  const week = isoWeek(NOW);
  const marker = path.join(tmp, 'retro', `${week}.auto.json`);
  await retro({ ...base, ledgerEntries: ledger(1) }); // xem truoc
  expect(fs.existsSync(marker)).toBe(false);
  let fail = true; const calls = [];
  const runner = (c, a) => { calls.push(c); return fail && c === 'projects' ? { ok: false, err: 'x' } : { ok: true }; };
  const a = await retroAuto({ ...base, ledgerEntries: ledger(1), runner });
  expect(a.errors.length).toBeGreaterThan(0);
  expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject({ attempts: 1, done: false }); // loi: chua chot, thu lai
  fail = false;
  const b = await retroAuto({ ...base, ledgerEntries: ledger(1), runner });
  expect(b.skipped).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject({ attempts: 2, done: true });
  expect((await retroAuto({ ...base, ledgerEntries: ledger(1), runner })).skipped).toBeTruthy();
});

test('retroAuto: du 3 lan thu trong tuan thi chot marker kem loi; timeout cua retro cung duoc thu lai', async () => {
  const runner = (c) => (c === 'projects' ? { ok: false, err: 'down' } : { ok: true });
  const marker = path.join(tmp, 'retro', `${isoWeek(NOW)}.auto.json`);
  for (let i = 1; i <= 3; i++) {
    const r = await retroAuto({ ...base, ledgerEntries: ledger(1), runner });
    expect(r.skipped).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(marker, 'utf8')).attempts).toBe(i);
  }
  const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
  expect(m.done).toBe(true);
  expect(m.errors.join(' ')).toContain('down');
  expect((await retroAuto({ ...base, ledgerEntries: ledger(1), runner })).skipped).toBeTruthy();
  fs.rmSync(path.join(tmp, 'retro'), { recursive: true });
  await retroAuto({ ...base, ledgerEntries: [], runner: () => ({ ok: true }), timeoutS: -1 });
  expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject({ attempts: 1, done: false }); // timeout cua retro -> thu lai
});

test('series: moi tuan chi append 1 lan (auto nhieu lan = 1 dong); --current khong bao gio append', async () => {
  const runner = () => ({ ok: false, err: 'x' });
  for (let i = 0; i < 5; i++) await retroAuto({ ...base, current: false, ledgerEntries: ledger(1), runner });
  const lines = fs.readFileSync(path.join(tmp, 'retro', 'series.jsonl'), 'utf8').trim().split('\n').filter((l) => JSON.parse(l).week === isoWeek(NOW - WEEK));
  expect(lines.length).toBe(1);
  const cur = path.join(tmp, 'retro', 'series.jsonl');
  const before = fs.readFileSync(cur, 'utf8');
  await retro({ ...base, current: true });
  expect(fs.readFileSync(cur, 'utf8')).toBe(before);
});

test('signalsFrom loc ts < asOf (khong tron su kien tuan dang chay)', () => {
  const asOf = Date.parse('2026-11-09T00:00:00Z');
  const s = signalsFrom([{ sid: 'a', ts: '2026-11-08T10:00:00Z', signal: 'correction' }, { sid: 'b', ts: '2026-11-10T10:00:00Z', signal: 'correction' }], asOf);
  expect(s).toEqual({ sessions: 1, corrections: 1, interrupts: 0 });
});

test('emitted: moi key co ts; resolved roi mo lai -> cho phep task moi; don key > 90 ngay', async () => {
  const calls = [];
  const runner = (c, a) => { if (c === 'projects') calls.push(a); return { ok: true }; };
  const e = (status) => [{ id: 'e', fp: 'fpR', status, count: 5, message: 'loi' }];
  await retro({ ...base, ledgerEntries: e('open'), runner, apply: true });
  const ef = path.join(tmp, 'retro', 'emitted.json');
  expect(typeof JSON.parse(fs.readFileSync(ef, 'utf8'))['ledger:fpR'].ts).toBe('string');
  await retro({ ...base, nowMs: NOW + WEEK, ledgerEntries: e('open'), runner, apply: true });
  expect(calls.length).toBe(1); // van open: khong tao lai
  await retro({ ...base, nowMs: NOW + 2 * WEEK, ledgerEntries: e('resolved'), runner, apply: true }); // ghi nhan resolved
  await retro({ ...base, nowMs: NOW + 3 * WEEK, ledgerEntries: e('open'), runner, apply: true }); // mo lai
  expect(calls.length).toBe(2);
  const old = JSON.parse(fs.readFileSync(ef, 'utf8'));
  old['ledger:ancient'] = { ts: new Date(NOW - 100 * 86400000).toISOString() };
  fs.writeFileSync(ef, JSON.stringify(old));
  await retro({ ...base, nowMs: NOW + 4 * WEEK, ledgerEntries: [], runner, apply: true });
  expect(JSON.parse(fs.readFileSync(ef, 'utf8'))['ledger:ancient']).toBeUndefined();
});

test('emitted.json ghi ngay sau MOI spawn thanh cong', async () => {
  const seen = [];
  const runner = (c) => { seen.push(fs.existsSync(path.join(tmp, 'retro', 'emitted.json')) ? Object.keys(JSON.parse(fs.readFileSync(path.join(tmp, 'retro', 'emitted.json'), 'utf8'))).length : 0); return { ok: true }; };
  await retro({ ...base, ledgerEntries: ledger(3), runner, apply: true });
  expect(seen.slice(0, 4)).toEqual([0, 1, 2, 3]);
});

test('summary task + body knowledge qua redact (token, email, duong dan)', async () => {
  const hubPath = path.join(workspaceRoot(), 'secret', 'x.md');
  const msg = `loi sk-abcdef1234567890XYZ user a.b@example.com file ${hubPath}`;
  const calls = [];
  const runner = (c, a) => { calls.push([c, a]); return { ok: true }; };
  await retro({ ...base, ledgerEntries: [{ id: 'e', fp: 'f', status: 'open', count: 3, message: msg }], runner, apply: true });
  const sum = calls.find(([c]) => c === 'projects')[1].join(' ');
  const kb = calls.find(([c]) => c === 'knowledge')[1];
  const body = fs.readFileSync(kb[kb.indexOf('--body-file') + 1], 'utf8');
  for (const t of [sum, body]) { expect(t).not.toContain('sk-abcdef1234567890XYZ'); expect(t).not.toContain('a.b@example.com'); expect(t).not.toContain(hubPath); }
});

test('KPI series chi lay section kpi-* (allowlist)', () => {
  const mk = (id, key) => ({ def: { id }, rows: [{ key, vals: [3] }] });
  expect(pickKpi([mk('kpi-size', 'skill'), mk('cost-session', 'sid123'), mk('subagent-vs-main', 'actor')], kpiSnapshot)).toEqual({ 'kpi-size.skill': 3 });
});

test('pickKpi bo hang co nhan tuan hoac ten file (khoa khong on dinh)', () => {
  const mk = (id, ...keys) => ({ def: { id }, rows: keys.map((key) => ({ key, vals: [2] })) });
  const k = pickKpi([mk('kpi-process-changes', 'thay doi 2026-W44', 'lap AGENTS.md', 'lap .claude/agents/x.md'), mk('kpi-size', 'skill')], kpiSnapshot);
  expect(k).toEqual({ 'kpi-size.skill': 2 });
});

test('process.changes_week + process.repeat_files vao kpi voi khoa on dinh', async () => {
  const week = isoWeek(NOW - WEEK);
  const pc = { weeks: [{ week, changes: 3, files: 2 }, { week: '2026-W01', changes: 9, files: 1 }], files: [], repeat: [{ path: 'AGENTS.md', edits: 2 }, { path: 'CLAUDE.md', edits: 3 }] };
  const r = await retro({ ...base, current: false, processChanges: pc });
  expect(r.kpi['process.changes_week']).toBe(3);
  expect(r.kpi['process.repeat_files']).toBe(2);
  expect(Object.keys(r.kpi).some((k) => /AGENTS|W\d\d/.test(k))).toBe(false);
});

test('top-3: ledger trung fp -> chi 1 van de (giu count cao nhat)', async () => {
  const dup = [{ id: 'a', fp: 'same', status: 'open', count: 3, message: 'Ripgrep timeout' }, { id: 'b', fp: 'same', status: 'warned', count: 7, message: 'Ripgrep timeout' }, { id: 'c', fp: 'o', status: 'open', count: 2, message: 'khac' }];
  const r = await retro({ ...base, ledgerEntries: dup });
  expect(r.issues.map((i) => i.key)).toEqual(['ledger:same', 'ledger:o']);
  expect(r.issues[0].summary).toContain('x7');
});

test('signalsFrom bo HookRun nhu engine report', () => {
  const s = signalsFrom([{ sid: 'a', type: 'hook', signal: 'correction' }, { sid: 'h', event: 'HookRun' }, { sid: 'a', signal: 'correction' }]);
  expect(s).toEqual({ sessions: 1, corrections: 1, interrupts: 0 });
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
