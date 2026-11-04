// Fail-loud: gate onError open loi -> van allow ({}, exit 0) nhung 1 dong stderr `HKERR <json>` (HK-GATE-001).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { dispatch, CLAUDE, writeRecords } from './run.mjs';

const mod = (id, over = {}) => ({ id, events: ['PreToolUse'], timeoutMs: 100, onError: 'open', handle: async () => ({}), ...over });
const entry = (m, gate = false) => ({ id: m.id, gate, load: async () => ({ default: m }) });
const profile = (...entries) => ({ ...CLAUDE, order: { PreToolUse: entries } });
const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } });
const cfg = { maxInputBytes: 1000000, budgetsMs: { PreToolUse: 1500 } };
const run = (p, stdin = input) => dispatch({ event: 'PreToolUse', stdin, cfg, profile: p });
const hk = (source) => ({ code: 'HK-GATE-001', severity: 'warn', cause: 'gate hook loi, bo qua (fail-open)', fix_command: 'harness doctor', next_step: 'chay harness doctor', safe: true, source });
const HK = (m, kind) => `HKERR ${JSON.stringify(hk(`${m}:${kind}`))}\n`;
const allow = (r) => { expect(r.code).toBe(0); expect(r.stdout).toBe('{}'); };

test('gate onError open loi/timeout -> allow + 1 dong HKERR; khong lo noi dung', async () => {
  const boom = mod('gboom', { handle: async () => { throw new Error('SECRETINPUT'); } });
  const hang = mod('ghang', { timeoutMs: 30, handle: () => new Promise(() => {}) });
  const r = await run(profile(entry(boom, true), entry(hang, true)));
  allow(r);
  expect(r.stderr).toBe(HK('gboom', 'error:Error') + HK('ghang', 'timeout'));
  expect(r.stderr).not.toContain('SECRETINPUT');
  const nonGate = await run(profile(entry(boom, false)));
  expect(nonGate.stderr || '').toBe('');
});

test('dong HKERR la JSON hop dong (parse duoc, du truong schema)', async () => {
  const boom = mod('gj', { handle: async () => { throw new Error('x'); } });
  const r = await run(profile(entry(boom, true)));
  expect(r.stderr.startsWith('HKERR ')).toBe(true);
  expect(JSON.parse(r.stderr.slice(6))).toEqual(hk('gj:error:Error'));
});

test('parseInput loi tren PreToolUse -> allow + HKERR; oversize van allow', async () => {
  const r = await dispatch({ event: 'PreToolUse', stdin: 'not json {secret', cfg, profile: profile() });
  allow(r);
  expect(r.stderr).toBe(HK('dispatch', 'badjson'));
  const o = await dispatch({ event: 'PreToolUse', stdin: input, cfg: { ...cfg, maxInputBytes: 5 }, profile: profile() });
  allow(o);
  expect(o.stderr).toBe(HK('dispatch', 'oversize'));
  const s = await dispatch({ event: 'Stop', stdin: 'bad', cfg, profile: profile() });
  expect(s.stderr || '').toBe('');
});

test('gate onError:closed -> van deny, KHONG them warn', async () => {
  const boom = mod('gc', { onError: 'closed', handle: async () => { throw new Error('x'); } });
  const r = await run(profile(entry(boom, true)));
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('deny');
  expect(r.stderr || '').toBe('');
});

test('gate bad-result -> allow + warn', async () => {
  const bad = mod('gbad', { handle: async () => ({ decision: 'nonsense' }) });
  const r = await run(profile(entry(bad, true)));
  allow(r);
  expect(r.stderr).toBe(HK('gbad', 'bad-result'));
});

test('gate load-failed / bad-module -> allow + warn', async () => {
  const lf = { id: 'glf', gate: true, load: async () => { throw new Error('nope'); } };
  const r = await run(profile(lf));
  allow(r);
  expect(r.stderr).toBe(HK('glf', 'load-failed'));
  const bm = { id: 'gbm', gate: true, load: async () => ({ default: { id: 'gbm' } }) };
  const r2 = await run(profile(bm));
  allow(r2);
  expect(r2.stderr).toBe(HK('gbm', 'bad-module'));
});

test('gate bi bo vi budget -> allow + warn', async () => {
  const r = await dispatch({ event: 'PreToolUse', stdin: input, cfg, startedAt: Date.now() - 5000, profile: profile(entry(mod('gbud'), true)) });
  allow(r);
  expect(r.stderr).toBe(HK('gbud', 'budget'));
});

test('budget-timeout toan cuc (nap module treo) -> allow + warn', async () => {
  const hang = { id: 'gh', gate: true, load: () => new Promise((res) => setTimeout(() => res({ default: mod('gh') }), 400)) };
  const r = await dispatch({ event: 'PreToolUse', stdin: input, cfg: { ...cfg, budgetsMs: { PreToolUse: 100 } }, profile: profile(hang) });
  allow(r);
  expect(r.stderr).toBe(HK('dispatch', 'budget-timeout'));
});

test('dispatch-error (loi ngoai module) -> allow + warn', async () => {
  const r = await dispatch({ event: 'PreToolUse', stdin: input, cfg, profile: { ...CLAUDE, order: { PreToolUse: 5 } } });
  allow(r);
  expect(r.stderr).toBe(HK('dispatch', 'dispatch-error'));
});

test('HK-WRITE-001: thu muc audit khong ghi duoc -> toi da MOT dong JSON cho nhieu record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkw-'));
  const blocker = path.join(dir, 'file'); fs.writeFileSync(blocker, 'x');
  const prev = process.env.CLAUDE_AUDIT_DIR; process.env.CLAUDE_AUDIT_DIR = path.join(blocker, 'sub');
  const real = fs.writeSync; const lines = [];
  fs.writeSync = (fd, s, ...a) => (fd === 2 ? (lines.push(String(s)), 0) : real(fd, s, ...a));
  try {
    const rec = { sink: 'audit', data: { ts: '2026-01-01T00:00:00Z', type: 'gate', sid: 's' } };
    await writeRecords([rec, rec, rec], {});
  } finally {
    fs.writeSync = real;
    if (prev === undefined) delete process.env.CLAUDE_AUDIT_DIR; else process.env.CLAUDE_AUDIT_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  expect(lines.length).toBe(1);
  const j = JSON.parse(lines[0].slice(6));
  expect(lines[0].startsWith('HKERR ')).toBe(true);
  expect(j.code).toBe('HK-WRITE-001');
  expect(j.cause).toContain('3');
  expect(j.source).toMatch(/^audit:/);
  for (const k of ['severity', 'cause', 'fix_command', 'next_step', 'safe', 'source']) expect(j[k]).toBeDefined();
});

test('gate loi + gate khac deny -> van deny (stderr khong doi quyet dinh)', async () => {
  const boom = mod('gerr', { handle: async () => { throw new Error('x'); } });
  const deny = mod('gdeny', { handle: async () => ({ decision: 'deny', reason: 'no' }) });
  for (const order of [[boom, deny], [deny, boom]]) {
    const r = await run(profile(...order.map((m) => entry(m, true))));
    expect(r.stdout).toContain('deny');
  }
});
