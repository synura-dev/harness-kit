// harness/constrain/cli/cli.mjs - cong lenh nhom Han che.
// Usage: constrain hooks [--json]            -> module hook cua dispatcher (id, gate, su kien, trang thai nap)
//        constrain worktree list|prune ...   -> chuyen sang cli/commands/worktree.mjs
//        constrain proc [--kill ...]         -> chuyen sang cli/commands/proc-watch.mjs
//        constrain config show|sources ...   -> chuyen sang cli/commands/config.mjs (domain `config` cu la alias)
// Doc-only (hooks): nap thu tung module (import dong, khong chay handler); loi nap -> trang thai error, khong nem.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { samePath } from '../../core/io/paths.mjs';
import { parseCommon, emit } from '../../core/io/out.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LIMITS = { loadTimeoutMs: 5000, spawnTimeoutMs: 110000 }; // < tran cong (120s + 5s): con tu dung truoc khi cong kill
const SUB = { worktree: 'worktree.mjs', proc: 'proc-watch.mjs', config: 'config.mjs' };

/** Tham so chuyen xuong CLI con: rest + co chung (--json/--raw/--max-bytes/--timeout-s) de `config show --raw` khong bi nuot. */
export function forwardArgs(c, rest) {
  const args = [...rest];
  if (c.json) args.push('--json');
  if (c.raw) args.push('--raw');
  if (c.maxBytes) args.push('--max-bytes', String(c.maxBytes));
  if (c.timeoutS) args.push('--timeout-s', String(c.timeoutS));
  return args;
}

/** Liet ke module hook tu dispatcher/modules.mjs: [{id, gate, events:[...], status:'ok'|'error', error?}] + truncated. */
export async function listHookModules({ modulesFile, timeoutMs = LIMITS.loadTimeoutMs } = {}) {
  const file = modulesFile || path.join(HERE, '..', '..', 'hooks', 'dispatch', 'modules.mjs');
  const { ORDER } = await import(pathToFileURL(file).href);
  const byId = new Map();
  for (const [ev, list] of Object.entries(ORDER || {})) {
    for (const e of list) {
      if (!byId.has(e.id)) byId.set(e.id, { id: e.id, gate: !!e.gate, events: [], entry: e });
      byId.get(e.id).events.push(ev);
    }
  }
  const t0 = Date.now();
  let truncated = null;
  const rows = [];
  for (const m of byId.values()) {
    const { entry, ...row } = m;
    if (Date.now() - t0 > timeoutMs) { truncated = 'timeout'; rows.push({ ...row, status: 'unchecked' }); continue; }
    try {
      const mod = (await entry.load()).default;
      rows.push({ ...row, status: mod && typeof mod.handle === 'function' ? 'ok' : 'error', ...(mod && typeof mod.handle === 'function' ? {} : { error: 'khong co handle()' }) });
    } catch (e) { rows.push({ ...row, status: 'error', error: String(e.message).slice(0, 120) }); }
  }
  return { rows, truncated };
}

export async function run(argv, { emitOpts = {}, modulesFile } = {}) {
  const c = parseCommon(argv);
  const [sub, ...rest] = c.rest;
  if (sub === 'hooks') {
    const { rows, truncated } = await listHookModules({ modulesFile });
    const summary = rows.map((r) => `${r.status === 'ok' ? '[x]' : '[!]'} ${r.id}${r.gate ? ' (gate)' : ''} - ${r.events.join(',')}${r.error ? ` ! ${r.error}` : ''}`).join('\n') + (truncated ? `\ntruncated: ${truncated}` : '');
    return { code: rows.some((r) => r.status === 'error') ? 1 : 0, ...emit({ summary: summary || '(none)', data: rows, raw: '', truncated }, { json: c.json, raw: false, maxBytes: c.maxBytes || 65536, ...emitOpts }) };
  }
  if (SUB[sub]) {
    const script = path.join(HERE, '..', '..', 'cli', 'commands', SUB[sub]);
    const args = forwardArgs(c, rest);
    const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', timeout: LIMITS.spawnTimeoutMs });
    if (r.error) { (emitOpts.err || console.error)(r.error.code === 'ETIMEDOUT' ? 'truncated: timeout' : String(r.error.message)); return { code: 2 }; }
    return { code: r.status ?? 1 };
  }
  (emitOpts.err || console.error)('usage: constrain hooks [--json] | worktree list|prune [...] | proc [--kill ...] | config show|sources [...]');
  return { code: 2 };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) run(process.argv.slice(2)).then((r) => { process.exitCode = r.code; });
