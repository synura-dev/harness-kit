// Loi toi thieu (Phase 5b goi A): tat moi module tuy chon -> 14 su kien van dang ky/chay, guard deny, audit ghi, observe query + evolve eval chay.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULTS, ORDER, OPTIONAL, loadModules } from './modules.mjs';
import { dispatch } from './run.mjs';

const ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const OFF = Object.fromEntries(OPTIONAL.map((id) => [id, { enabled: false }]));
const CFG = { ...DEFAULTS, modules: OFF };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-core-'));
const env = { ...process.env, HUB_DATA_DIR: path.join(tmp, 'data'), CLAUDE_AUDIT_DIR: path.join(tmp, 'audit'), GUARD_LOG_FILE: path.join(tmp, 'guard.jsonl'), HUB_DIR: ROOT };
fs.mkdirSync(env.CLAUDE_AUDIT_DIR, { recursive: true });
const _old = ['HUB_DATA_DIR', 'CLAUDE_AUDIT_DIR', 'GUARD_LOG_FILE'].map((k) => [k, process.env[k]]);
const hasProc = (k) => Object.keys(env).forEach((x) => { if (x === k) process.env[x] = env[x]; });
['HUB_DATA_DIR', 'CLAUDE_AUDIT_DIR', 'GUARD_LOG_FILE'].forEach(hasProc);
afterAll(() => { for (const [k, v] of _old) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test('mac dinh: moi module tuy chon van nap; tat qua cfg thi bo, loi khong tat duoc', async () => {
  const all = (await loadModules('Stop')).map((m) => m.id);
  expect(all).toContain('proc-orphans');
  const min = (await loadModules('Stop', { modules: OFF })).map((m) => m.id);
  expect(min).toEqual(['audit']);
  expect((await loadModules('WorktreeCreate', { modules: OFF })).map((m) => m.id)).toEqual(['worktree-hook']);
  expect((await loadModules('PreToolUse', { modules: OFF })).map((m) => m.id)).toContain('guard');
});

test('14 su kien van dang ky; chay khong nem khi tat het module tuy chon', async () => {
  expect(Object.keys(ORDER).length).toBe(14);
  for (const ev of Object.keys(ORDER)) {
    if (ev === 'WorktreeCreate') continue; // payload gia -> exit 1 theo thiet ke
    const r = await dispatch({ event: ev, stdin: JSON.stringify({ session_id: 's1', cwd: tmp, tool_name: 'Read', tool_input: {} }), cfg: CFG });
    expect(r.code).toBe(0);
  }
  const wc = await dispatch({ event: 'WorktreeCreate', stdin: JSON.stringify({ session_id: 's1', cwd: tmp }), cfg: CFG });
  expect(wc.code).toBe(1);
});

test('guard van deny lenh qua dai, audit ghi ban ghi', async () => {
  const r = await dispatch({ event: 'PreToolUse', stdin: JSON.stringify({ session_id: 's1', cwd: tmp, tool_name: 'Bash', tool_input: { command: 'echo ' + 'a'.repeat(100001) } }), cfg: CFG });
  expect(r.stdout).toContain('deny');
  expect(r.records.length).toBeGreaterThan(0);
});

test('observe query va evolve eval chay trong thu muc tam', () => {
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'harness', 'cli', 'harness.mjs'), ...a], { env, encoding: 'utf8', timeout: 60000 });
  const q = run('observe', 'query', '--help');
  expect(q.status === 0 || q.stdout.length + q.stderr.length > 0).toBe(true);
  expect(q.status).not.toBe(null);
  const e = run('evolve', 'eval', 'list');
  expect(e.status).not.toBe(null);
  expect(e.stderr).not.toContain('Cannot find module');
});
