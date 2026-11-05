import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULTS, findChildren, load, handle, MODULE, seenRecently, signatureOf } from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';

const script = path.join(import.meta.dir, 'hook.mjs');
const NOW = 1_000_000_000;
const P = (pid, ppid, name, ageSec, cmd = '') => ({ pid, ppid, name, startMs: NOW - ageSec * 1000, cmd });

test('liet ke con chau cua claude, bo chuoi hook, bo protect va qua tre', () => {
  const ps = [P(1, 0, 'claude.exe', 999), P(2, 1, 'bash.exe', 100), P(3, 2, 'node.exe', 1), // self=3
    P(10, 2, 'ping.exe', 60, 'ping'), P(11, 2, 'ping.exe', 2), P(12, 1, 'bun.exe', 90, 'server.ts'), P(13, 77, 'ping.exe', 90)];
  const r = findChildren(ps, 3, DEFAULTS, NOW);
  expect(r.rootPid).toBe(1);
  expect(r.children.map((c) => c.pid)).toEqual([10]);
});
test('khong co root claude => rong', () => {
  expect(findChildren([P(3, 0, 'node.exe', 9)], 3, DEFAULTS, NOW).children).toEqual([]);
});
test('thieu config / config hong van co mac dinh', () => {
  expect(load([path.join(os.tmpdir(), 'nope-po.json')]).config.minAgeSec).toBe(5);
});
test('fail-open: stdin rac va event la', () => {
  for (const input of ['', 'not json', '[]', 'null', '{"hook_event_name":"X"}']) expect(spawnSync(process.execPath, [script], { input, timeout: 20000 }).status).toBe(0);
});
test('chay that voi Stop: exit 0, khong stdout (khong block)', () => {
  const r = spawnSync(process.execPath, [script], { input: '{"hook_event_name":"Stop","session_id":"t-po"}', timeout: 20000, env: { ...process.env, CLAUDE_AUDIT_DIR: path.join(os.tmpdir(), 'po-audit') }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
});
test('MODULE hop le; handle(): event ngoai events, stdin rac, cfg tat -> {} (khong quyet dinh)', async () => {
  expect(validateHookModule(MODULE)).toEqual([]);
  expect(await handle('PreToolUse', { session_id: 'x' }, { cfg: DEFAULTS })).toEqual({});
  expect(await handle('Stop', null, { cfg: DEFAULTS })).toEqual({});
  expect(await handle('Stop', { session_id: 'x' }, { cfg: { ...DEFAULTS, enabled: false } })).toEqual({});
});
test('handle(): Stop that -> khong decision, ket qua hop le voi validateHookResult', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-h-'));
  const prev = process.env.CLAUDE_AUDIT_DIR;
  process.env.CLAUDE_AUDIT_DIR = dir;
  try {
    const r = await handle('Stop', { hook_event_name: 'Stop', session_id: 't-po-h' }, { cfg: DEFAULTS });
    expect(validateHookResult(r)).toEqual([]);
    expect(r.decision).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_AUDIT_DIR; else process.env.CLAUDE_AUDIT_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('conhost/OpenConsole bi bo qua (ke ca khi nam trong watchNames); nen that van canh bao', () => {
  const cfg = { ...DEFAULTS, watchNames: [...DEFAULTS.watchNames, 'conhost.exe', 'openconsole.exe'] };
  const ps = [P(1, 0, 'claude.exe', 999), P(2, 1, 'bash.exe', 100), P(3, 2, 'node.exe', 1),
    P(20, 1, 'conhost.exe', 500), P(21, 1, 'OpenConsole.exe', 500), P(22, 1, 'ping.exe', 60)];
  expect(findChildren(ps, 3, cfg, NOW).children.map((c) => c.pid)).toEqual([22]);
});
test('chuoi to tien cua hook bi bo qua, bao gom shell boc', () => {
  const ps = [P(1, 0, 'claude.exe', 999), P(2, 1, 'bash.exe', 100), P(4, 2, 'bash.exe', 50), P(3, 4, 'node.exe', 1)];
  expect(findChildren(ps, 3, DEFAULTS, NOW).children).toEqual([]);
});
test('chong lap: cung chu ky khong canh bao lan 2, chu ky moi thi canh bao, write:false khong ghi', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-d-'));
  const env = { ...process.env, HUB_DATA_DIR: dir };
  try {
    const a = signatureOf(9, [{ pid: 5 }, { pid: 3 }]);
    expect(a).toBe(signatureOf(9, [{ pid: 3 }, { pid: 5 }]));
    expect(await seenRecently(a, 9, DEFAULTS, { env, write: false })).toBe(false);
    expect(await seenRecently(a, 9, DEFAULTS, { env, write: false })).toBe(false);
    expect(await seenRecently(a, 9, DEFAULTS, { env })).toBe(false);
    expect(await seenRecently(a, 9, DEFAULTS, { env })).toBe(true);
    expect(await seenRecently(signatureOf(9, [{ pid: 3 }, { pid: 5 }, { pid: 6 }]), 9, DEFAULTS, { env })).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
