import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyFindings, claimDue, resolveOutcome, readLedger, writeLedger, ledgerFile, readState } from './ledger.mjs';
import { runJob } from './job.mjs';

const H = 3600e3;
const T0 = Date.parse('2026-11-05T00:00:00Z');
const f = (o = {}) => ({ rule: 'r', fp: 'fp1', key: 'k', count: 3, sessions: 1, first_ts: new Date(T0).toISOString(), last_ts: new Date(T0).toISOString(), sample: 's', action: 'warn', cooldown_hours: 24, message: 'canh bao', occ: [{ sid: 'claude-s1', ts: new Date(T0).toISOString() }], ...o });

test('finding moi -> open + due; claimDue phat toi da 3 dong, ghi warn_ts, het due', () => {
  const { entries } = applyFindings([], [f({ fp: 'a' }), f({ fp: 'b' }), f({ fp: 'c' }), f({ fp: 'd' })], T0);
  assert.ok(entries.every((e) => e.status === 'open' && e.due));
  const r = claimDue(entries, T0, { sid: 'claude-s1' });
  assert.equal(r.lines.length, 3);
  const warned = r.entries.filter((e) => e.status === 'warned');
  assert.equal(warned.length, 3); assert.equal(warned[0].warn_count, 1); assert.equal(warned[0].warn_ts.length, 1);
  assert.equal(r.entries.filter((e) => e.due).length, 1); // muc thu 4 con cho
});

test('cooldown: khong canh bao lai trong cooldown, du fp van lap', () => {
  let e = applyFindings([], [f()], T0).entries;
  e = claimDue(e, T0, { sid: 'claude-s1' }).entries;
  const t1 = T0 + 5 * H;
  e = applyFindings(e, [f({ occ: [{ sid: 'claude-s9', ts: new Date(t1).toISOString() }], last_ts: new Date(t1).toISOString() })], t1).entries;
  assert.equal(e[0].due, false);
  assert.equal(claimDue(e, t1).lines.length, 0);
  const t2 = T0 + 25 * H; // het cooldown, van con lap o phien khac
  e = applyFindings(e, [f({ occ: [{ sid: 'claude-s9', ts: new Date(t2).toISOString() }] })], t2).entries;
  assert.equal(e[0].due, true);
  // hook kiem lai cooldown ke ca khi due da bi dat sai
  const stale = [{ ...e[0], due: true, warn_ts: [new Date(t2 - H).toISOString()] }];
  assert.equal(claimDue(stale, t2).lines.length, 0);
});

test('ignored: fp lap trong CUNG phien sau canh bao', () => {
  let e = applyFindings([], [f()], T0).entries;
  e = claimDue(e, T0 + H, { sid: 'claude-s1' }).entries;
  const t = T0 + 2 * H;
  e = applyFindings(e, [f({ occ: [{ sid: 'claude-s1', ts: new Date(t).toISOString() }] })], t).entries;
  assert.equal(e[0].status, 'ignored'); assert.equal(e[0].ignored_count, 1);
});

test('acted: khong lap trong 24h; phien khac lap thi chua acted; acted -> open khi tai phat; resolved sau 7 ngay', () => {
  let e = applyFindings([], [f()], T0).entries;
  e = claimDue(e, T0 + H, { sid: 'claude-s1' }).entries;
  const t1 = T0 + 10 * H; // phien khac lap -> van warned
  let r = applyFindings(e, [f({ occ: [{ sid: 'claude-s2', ts: new Date(t1).toISOString() }] })], t1).entries;
  assert.equal(r[0].status, 'warned');
  const t2 = T0 + 26 * H; // khong con xuat hien
  r = applyFindings(e, [], t2).entries;
  assert.equal(r[0].status, 'acted'); assert.ok(r[0].acted); assert.equal(r[0].due, false);
  const t3 = t2 + 2 * H; // tai phat sau acted
  assert.equal(resolveOutcome(r[0], f({ occ: [{ sid: 'claude-s3', ts: new Date(t3).toISOString() }] }), t3).status, 'open');
  const t4 = T0 + 9 * 24 * H;
  assert.equal(applyFindings(r, [], t4).entries[0].status, 'resolved');
});

test('action report: khong bao gio due', () => {
  const e = applyFindings([], [f({ action: 'report' })], T0).entries;
  assert.equal(e[0].due, false);
});

test('runJob: audit gia -> so, doc/ghi qua HUB_DATA_DIR tam, job lan 2 khong nhan doi', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const dataOpts = { env: { HUB_DATA_DIR: dir } };
  const iso = new Date(T0).toISOString();
  const err = (i) => ({ ts: iso, sid: 'claude-x' + (i % 2), tool: 'Bash', ok: false, event: 'PostToolUseFailure', actor: 'main', project: 'p', data: { tool: 'Bash', error: 'ENOENT boom thing' }, target: 'x' });
  const events = [err(0), err(1), err(2), err(3)];
  const hubDir = 'E:/hub';
  const r1 = await runJob({ events, nowMs: T0 + H, hubDir, dataOpts, projectDir: null });
  assert.equal(r1.errors.length, 0);
  const file = ledgerFile(dataOpts);
  const a = readLedger(file);
  assert.ok(a.some((e) => e.rule === 'repeated-error' && e.due));
  assert.ok(readState(dataOpts).lastRun);
  await runJob({ events, nowMs: T0 + 2 * H, hubDir, dataOpts, projectDir: null });
  assert.equal(readLedger(file).filter((e) => e.rule === 'repeated-error').length, 1);
  writeLedger(file, []); fs.rmSync(dir, { recursive: true, force: true });
});

test('ledger close: dry-run khong ghi, --yes dong muc khop kind+match', async () => {
  const { closeMain, closable } = await import('./cli.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lclose-'));
  const file = path.join(dir, 'ledger.jsonl');
  const mk = (id, rule, sample) => ({ id, rule, fp: id, status: 'open', sample, message: sample, first_seen: 'x', last_seen: 'x', warn_count: 0, warn_ts: [], due: false });
  writeLedger(file, [mk('1', 'repeated-pattern', 'Edit:.mjs'), mk('2', 'repeated-pattern', 'Bash:git add'), mk('3', 'other', 'Edit:.mjs')]);
  assert.equal(closable(readLedger(file), { kind: 'repeated-pattern', match: 'edit' }).length, 1);
  const log = console.log; console.log = () => {};
  try {
    closeMain(['--kind', 'repeated-pattern'], file);
    assert.equal(readLedger(file).filter((e) => e.status === 'resolved').length, 0);
    closeMain(['--kind', 'repeated-pattern', '--match', 'Edit:', '--yes'], file);
  } finally { console.log = log; }
  const st = Object.fromEntries(readLedger(file).map((e) => [e.id, e.status]));
  assert.deepEqual(st, { 1: 'resolved', 2: 'open', 3: 'open' });
  fs.rmSync(dir, { recursive: true, force: true });
});
