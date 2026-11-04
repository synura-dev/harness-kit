import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULTS, load, handle, MODULE } from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';

const script = path.join(import.meta.dir, 'hook.mjs');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 30000 });
function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wt hook '));
  git(d, 'init', '-q', '-b', 'main');
  git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  return d;
}
const run = (mode, input, repo) => spawnSync(process.execPath, [script, mode], { input, encoding: 'utf8', timeout: 60000, env: { ...process.env, HUB_DIR: repo, HUB_DATA_DIR: path.join(repo, 'data') } });

test('mac dinh khi thieu config', () => {
  expect(load([path.join(os.tmpdir(), 'nope-wt.json')]).config.minAgeHours).toBe(DEFAULTS.minAgeHours);
});
test('create: stdout chi la duong dan, idempotent, remove giu/don dung', () => {
  const repo = tmpRepo();
  const r1 = run('create', JSON.stringify({ name: 'agent-abc123' }), repo);
  expect(r1.status).toBe(0);
  const p = path.join(repo, '.worktrees', 'agent-abc123');
  expect(r1.stdout).toBe(p);
  expect(fs.existsSync(p)).toBe(true);
  expect(run('create', JSON.stringify({ name: 'agent-abc123' }), repo).stdout).toBe(p);
  // vi tri tuy mode (hub: data/worktree; plugin: data/system/worktree): tim de quy
  expect(fs.readdirSync(path.join(repo, 'data'), { recursive: true }).map((f) => String(f).replace(/\\/g, '/')).some((f) => /(^|\/)worktree\/hook\.jsonl$/.test(f))).toBe(true);
  fs.writeFileSync(path.join(p, 'dirty.txt'), 'x');
  expect(run('remove', JSON.stringify({ worktree_path: p }), repo).status).toBe(0);
  expect(fs.existsSync(p)).toBe(true); // dirty => giu
  fs.rmSync(path.join(p, 'dirty.txt'));
  expect(run('remove', JSON.stringify({ worktree_path: p }), repo).status).toBe(0);
  expect(fs.existsSync(p)).toBe(false);
  fs.rmSync(repo, { recursive: true, force: true });
});
test('create thieu name => exit 1 + stderr; remove/sweep rac => exit 0', () => {
  const repo = tmpRepo();
  const r = run('create', '{}', repo);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('loi');
  expect(r.stdout).toBe('');
  expect(run('remove', 'rac', repo).status).toBe(0);
  expect(run('sweep', '', repo).status).toBe(0);
  fs.rmSync(repo, { recursive: true, force: true });
});
test('sweep: du an khong phai git -> bo qua som (khong spawn), repo git van chay', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wt plain '));
  const prev = { HUB_DIR: process.env.HUB_DIR, HUB_DATA_DIR: process.env.HUB_DATA_DIR };
  process.env.HUB_DATA_DIR = path.join(plain, 'data');
  try {
    process.env.HUB_DIR = plain;
    const r = await handle('SessionStart', {}, { cfg: DEFAULTS, write: false });
    expect(r.record).toEqual({ removed: 0, skipped: 'no-git' });
    expect(validateHookResult(r)).toEqual([]);
    const repo = tmpRepo();
    process.env.HUB_DIR = repo;
    const g = await handle('SessionStart', {}, { cfg: DEFAULTS, write: false });
    expect(g.record).toEqual({ removed: 0 });
    fs.rmSync(repo, { recursive: true, force: true });
  } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    fs.rmSync(plain, { recursive: true, force: true });
  }
});
test('MODULE hop le; handle(): su kien la hoac cfg tat -> {}', async () => {
  expect(validateHookModule(MODULE)).toEqual([]);
  expect(await handle('PreToolUse', {}, { cfg: DEFAULTS })).toEqual({});
  expect(await handle('SessionStart', {}, { cfg: { ...DEFAULTS, enabled: false } })).toEqual({});
});
test('handle(): WorktreeCreate tra record.path; thieu name -> throw; remove hop le', async () => {
  const repo = tmpRepo();
  const prev = { HUB_DIR: process.env.HUB_DIR, HUB_DATA_DIR: process.env.HUB_DATA_DIR };
  process.env.HUB_DIR = repo;
  process.env.HUB_DATA_DIR = path.join(repo, 'data');
  try {
    const r = await handle('WorktreeCreate', { name: 'agent-h1' }, { cfg: DEFAULTS });
    expect(r.record.path).toBe(path.join(repo, '.worktrees', 'agent-h1'));
    expect(validateHookResult(r)).toEqual([]);
    await expect(handle('WorktreeCreate', {}, { cfg: DEFAULTS })).rejects.toThrow(/thieu name/);
    const rm = await handle('WorktreeRemove', { worktree_path: r.record.path }, { cfg: DEFAULTS });
    expect(validateHookResult(rm)).toEqual([]);
  } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    fs.rmSync(repo, { recursive: true, force: true });
  }
}, 60000);
