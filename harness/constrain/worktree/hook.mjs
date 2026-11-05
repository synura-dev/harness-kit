// Hook nhom worktree: GOC DUY NHAT tao/don worktree cho Claude (va agy qua dispatch-worker).
//   hook.mjs create  : WorktreeCreate. stdin {name,...}. stdout CHI duong dan tuyet doi. Loi => exit 1 + stderr.
//   hook.mjs remove  : WorktreeRemove. stdin {worktree_path}. An toan (giu khi dirty/chua merge), LUON exit 0.
//   hook.mjs sweep   : SessionStart. `prune --apply` an toan (clean + da merge + qua minAgeHours + khong locked). Fail-open, LUON exit 0.
// Log 1 dong JSONL vao <data>/worktree/hook.jsonl. Dung core/runtime/worktree.mjs (cung ham voi dispatch-worker).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';

import { readJsonStdin } from '../../core/io/stdio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { enabled: true, minAgeHours: 24, sweepTimeoutSec: 20, logMaxBytes: 2097152 };
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('worktree', { defaults: DEFAULTS, files, env: { HOOK_WORKTREE_ENABLED: 'enabled' } });

export async function log(rec, cfg = DEFAULTS) {
  try {
    const { dataPathFor, appendJsonl } = await import('../../core/io/storage.mjs');
    appendJsonl(dataPathFor('worktree', 'hook.jsonl'), { ts: new Date().toISOString(), ...rec }, { maxBytes: cfg.logMaxBytes });
  } catch {}
}


export async function create(inp, cfg = DEFAULTS, emit = (rec) => log(rec, cfg)) {
  const { ensureWorktree, copyWorktreeInclude } = await import('../../core/runtime/worktree.mjs');
  const { workspaceRoot } = await import('../../core/io/paths.mjs');
  const name = inp && inp.name;
  if (!name) throw new Error('thieu name trong stdin WorktreeCreate');
  const root = workspaceRoot();
  const r = ensureWorktree(name, { root });
  const copied = r.created ? copyWorktreeInclude(root, r.worktreePath) : [];
  await emit({ event: 'WorktreeCreate', name, path: r.worktreePath, branch: r.branch, created: r.created, copied, session_id: inp.session_id || null }, cfg);
  return r.worktreePath;
}

export async function remove(inp, cfg = DEFAULTS, emit = (rec) => log(rec, cfg)) {
  const { removeWorktreeAt } = await import('../../core/runtime/worktree.mjs');
  const { workspaceRoot } = await import('../../core/io/paths.mjs');
  const p = inp && (inp.worktree_path || inp.path);
  if (!p) return { skipped: 'thieu worktree_path' };
  const r = removeWorktreeAt(p, { root: workspaceRoot() });
  await emit({ event: 'WorktreeRemove', path: p, removed: r.removed, kept: r.kept, reason: r.reason, error: !!r.error }, cfg);
  return r;
}

/** Co `.git` (thu muc hoac file cua worktree) o dir hoac tren no khong. Chi stat, khong spawn git. */
export function hasGitAncestor(dir) {
  let d = path.resolve(dir);
  for (;;) {
    try { fs.statSync(path.join(d, '.git')); return true; } catch {}
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

export const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;

/** Sweep nen: khong chan SessionStart. Throttle 1 lan/6h bang stamp trong data; background:false -> khong chay. Hanh vi prune giu nguyen. */
export async function sweep(cfg = DEFAULTS, emit = (rec) => log(rec, cfg), opts = {}) {
  const { workspaceRoot } = await import('../../core/io/paths.mjs');
  if (opts.background === false) return { removed: 0, skipped: 'no-background' };
  // Du an khong phai git: khong co worktree de don -> bo qua som.
  if (!hasGitAncestor(workspaceRoot())) return { removed: 0, skipped: 'no-git' };
  const { dataPathFor } = await import('../../core/io/storage.mjs');
  const stamp = dataPathFor('worktree', 'sweep.stamp');
  const now = opts.now ?? Date.now();
  try { if (now - fs.statSync(stamp).mtimeMs < (opts.intervalMs ?? SWEEP_INTERVAL_MS)) return { removed: 0, skipped: 'throttled' }; } catch {}
  const cli = path.join(HERE, '..', '..', 'cli', 'commands', 'worktree.mjs');
  const spawnBg = opts.spawnBackground || (await import('../../core/runtime/proc.mjs')).spawnBackground;
  const pid = spawnBg({ cmd: process.execPath, args: [cli, 'prune', '--apply', '--min-age-hours', String(cfg.minAgeHours), '--timeout', String(cfg.sweepTimeoutSec)], key: 'worktree-sweep', deadlineMs: (cfg.sweepTimeoutSec + 10) * 1000, cwd: workspaceRoot() });
  if (pid) { try { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, String(now)); } catch {} }
  return { removed: 0, started: !!pid };
}

const EVENT_OF = Object.freeze({ create: 'WorktreeCreate', remove: 'WorktreeRemove', sweep: 'SessionStart' });
const MODE_OF = Object.freeze({ WorktreeRemove: 'remove', SessionStart: 'sweep' });

/**
 * Hop dong module (HOOK_MODULE): handle(event, input, ctx) theo su kien: WorktreeCreate | WorktreeRemove | SessionStart (= sweep).
 * Tra {record}: create -> record.path (duong dan tuyet doi). Khong ghi stdout/exit (vo main lam).
 * Nhat ky -> records [{sink:'worktree', data}]; chi tu ghi khi ctx.write !== false.
 * create loi: ctx.write === false -> {decision:'deny', block:true, reason, records} (dispatcher xu ly); nguoc lai log roi THROW (vo in stderr + exit 1).
 * remove/sweep loi -> log, tra {record:{error}} (fail-open).
 * ctx (tuy chon): {cfg, write}; thieu thi nap mac dinh.
 */
export async function handle(event, input, ctx = {}) {
  const cfg = ctx.cfg ?? load().config;
  const records = [];
  const emit = async (rec) => { records.push({ sink: 'worktree', data: { ts: new Date().toISOString(), ...rec } }); if (ctx.write !== false) await log(rec, cfg); };
  if (event === 'WorktreeCreate') {
    try { return { record: { path: await create(input, cfg, emit) }, records }; }
    catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      await emit({ event, error: msg });
      if (ctx.write === false) return { decision: 'deny', block: true, reason: 'worktree create loi: ' + msg, records };
      throw e;
    }
  }
  if (event !== 'WorktreeRemove' && event !== 'SessionStart') return {};
  if (!cfg.enabled) return {};
  try {
    if (event === 'WorktreeRemove') return { record: await remove(input, cfg, emit), records };
    return { record: await sweep(cfg, emit, { background: ctx.background, ...(ctx.sweep || {}) }), records };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    await emit({ event: MODE_OF[event], error: msg });
    return { record: { error: msg }, records };
  }
}

const META = { id: 'worktree-hook', events: ['WorktreeCreate', 'WorktreeRemove', 'SessionStart'], timeoutMs: 60000, onError: 'open' };
/** Alias cu (test). */
export const MODULE = Object.freeze({ ...META, handle });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). onError 'open': loi remove/sweep bo qua; create loi -> deny khi write:false, nguoc lai throw (vo exit 1). */
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });

async function main(mode) {
  const cfg = load().config;
  const event = EVENT_OF[mode] || '';
  if (mode === 'create') {
    // Khong tat duoc theo config: thieu path = subagent khong chay. enabled chi ap cho remove/sweep.
    try { const r = await handle(event, readJsonStdin(), { cfg, write: true }); process.stdout.write(r.record.path); process.exit(0); }
    catch (e) { process.stderr.write(`worktree create loi: ${e.message || e}\n`); process.exit(1); }
  }
  try { await handle(event, readJsonStdin(), { cfg, write: true }); } catch {}
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
