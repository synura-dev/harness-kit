// Chuan HOOK_MODULE (Dot 5.1): moi module constrain `export default {id,events,timeoutMs,onError,handle}`, handle async (event,input,ctx);
// ctx.write === false -> khong ghi file (kiem thu muc tam), ket qua hop le voi validateHookResult, viec ghi nam trong records.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateHookModule, validateHookResult } from '../core/config/shape.mjs';
import bashGuard from './bash-guard/hook.mjs';
import guard, { load as loadGuard } from './guard/hook.mjs';
import modelPolicy, { DEFAULTS as MP_DEFAULTS } from './model-policy/hook.mjs';
import procOrphans, { DEFAULTS as PO_DEFAULTS } from './proc-orphans/hook.mjs';
import worktree, { DEFAULTS as WT_DEFAULTS } from './worktree/hook.mjs';

const MODULES = { 'bash-guard': bashGuard, guard, 'model-policy': modelPolicy, 'proc-orphans': procOrphans, worktree };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hook-std-'));
const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()) : []);
const bash = (command) => ({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command } });

test('moi default export qua validateHookModule va handle la async', () => {
  for (const [name, m] of Object.entries(MODULES)) {
    expect(validateHookModule(m), name).toEqual([]);
    expect(m.handle.constructor.name, name).toBe('AsyncFunction');
  }
});

test('handle(write:false) khong ghi file, tra records hop le', async () => {
  const dir = tmp();
  const env = { ...process.env, HUB_DATA_DIR: path.join(dir, 'data'), CLAUDE_AUDIT_DIR: path.join(dir, 'audit') };
  const prev = { HUB_DATA_DIR: process.env.HUB_DATA_DIR, CLAUDE_AUDIT_DIR: process.env.CLAUDE_AUDIT_DIR };
  Object.assign(process.env, { HUB_DATA_DIR: env.HUB_DATA_DIR, CLAUDE_AUDIT_DIR: env.CLAUDE_AUDIT_DIR });
  let child;
  try {
    const guardLog = path.join(dir, 'guard.jsonl');
    const mpCfg = { ...MP_DEFAULTS, roles: { verifier: { model: 'haiku' } } };
    const ctx = { write: false, env };


    const g = await guard.handle('PreToolUse', bash('echo ' + 'a'.repeat(100001)), { ...ctx, config: { ...loadGuard().config, logFile: guardLog } });
    expect(g.decision).toBe('deny');
    expect(g.records[0].sink).toBe('guard');
    expect(validateHookResult(g)).toEqual([]);

    const b = await bashGuard.handle('PreToolUse', bash('ls'), { ...ctx, config: { enabled: true, default_timeout_ms: 1000, max_timeout_ms: 5000 } });
    expect(validateHookResult(b || {})).toEqual([]);

    const m = await modelPolicy.handle('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'p', subagent_type: 'verifier' } }, { ...ctx, config: mpCfg });
    expect(m.records[0].sink).toBe('gate');
    expect(validateHookResult(m)).toEqual([]);


    const w = await worktree.handle('WorktreeCreate', {}, { ...ctx, cfg: WT_DEFAULTS });
    expect(w).toMatchObject({ decision: 'deny', block: true });
    expect(w.records[0].sink).toBe('worktree');
    expect(validateHookResult(w)).toEqual([]);

    // proc-orphans: tao con chau song duoi chinh process test (root = process hien tai).
    child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 400));
    const self = path.basename(process.execPath).toLowerCase();
    const poCfg = { ...PO_DEFAULTS, rootNames: [self], watchNames: [self], minAgeSec: 0, protectCmd: [], timeoutMs: 10000 };
    const p = await procOrphans.handle('Stop', { hook_event_name: 'Stop', session_id: 'std' }, { ...ctx, cache: false, cfg: poCfg });
    expect(validateHookResult(p)).toEqual([]);
    if (p.records) expect(p.records[0].sink).toBe('audit');

    expect(files(dir)).toEqual([]);
  } finally {
    if (child) child.kill();
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('handle mac dinh (write khong phai false) van tu ghi nhu cu: guard ghi nhat ky', async () => {
  const dir = tmp();
  try {
    const logFile = path.join(dir, 'g.jsonl');
    const r = await guard.handle('PreToolUse', bash('echo ' + 'a'.repeat(100001)), { config: { ...loadGuard().config, logFile } });
    expect(r.records.length).toBeGreaterThan(0);
    expect(fs.existsSync(logFile)).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('proc-orphans: cache quet TTL, ctx.cache:false khong ghi, write:false van ghi cache (khong phai vet audit)', async () => {
  const dir = tmp();
  const env = { ...process.env, HUB_DATA_DIR: path.join(dir, 'data') };
  const self = path.basename(process.execPath).toLowerCase();
  const cfg = { ...PO_DEFAULTS, rootNames: [self], watchNames: [self], minAgeSec: 0, protectCmd: [], timeoutMs: 10000, scanCacheTtlSec: 60 };
  const cache = path.join(dir, 'data', 'system', 'proc-orphans', 'scan-cache.json');
  try {
    const { scanChildren } = await import('./proc-orphans/hook.mjs');
    await scanChildren(cfg, { write: false, cache: false, env });
    expect(fs.existsSync(cache)).toBe(false);
    const r1 = await scanChildren(cfg, { write: false, env });
    expect(fs.existsSync(cache)).toBe(true);
    const r2 = await scanChildren(cfg, { write: false, env });
    expect(r2.rootPid).toBe(r1.rootPid);
    await scanChildren({ ...cfg, scanCacheTtlSec: 0 }, { write: true, env });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 60000);
