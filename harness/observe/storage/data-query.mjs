// `harness data query <ws> <tool>`: doc <dataRoot>/workspaces/<ws>/<tool>/runs.jsonl (data-workspaces P1b). Chi doc, co gioi han.
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot, isInside } from '../../core/io/paths.mjs';
import { workspaceFor } from '../../core/io/node-hook.mjs';
import { RUN_STATUS } from '../../core/io/runs-record.mjs';
import { emit } from '../../core/io/out.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { loadDataRegistry } from '../../core/registry/data-registry.mjs';

export const QUERY_LIMITS = { defaultLast: 20, maxLast: 200, maxBytes: 1048576, timeoutS: 20 };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

export function runsFile(root, ws, tool) {
  if (!ID_RE.test(String(ws))) throw new Error('workspace khong hop le');
  if (!ID_RE.test(String(tool))) throw new Error('tool khong hop le');
  const f = path.join(root, 'workspaces', ws, tool, 'runs.jsonl');
  if (!isInside(f, root)) throw new Error('duong dan ngoai data root');
  return f;
}

/**
 * Duong runs.jsonl theo dinh tuyen P1a: dataPathFor(tool,'runs.jsonl',{node:ws,shared:true,mode:'read'}) khi tool co entry mau (registry.patterns),
 * goc = `root` (HUB_DATA_DIR ep, ws da giai nen nen khong qua hook lan nua). Tool khong co mau / loi dinh tuyen / ra ngoai root -> duong tay (runsFile).
 */
export function routedRunsFile(root, ws, tool, hookOpts = {}) {
  const hand = runsFile(root, ws, tool);
  try {
    const env = { ...(hookOpts.env || process.env), HUB_DATA_DIR: root };
    const registry = hookOpts.registry || loadDataRegistry({ ...hookOpts, env });
    if (!registry.patterns || !registry.patterns[tool]) return hand;
    const f = dataPathFor(tool, 'runs.jsonl', { ...hookOpts, env, registry, node: ws, shared: true, mode: 'read', quiet: true });
    return isInside(f, root) ? f : hand;
  } catch { return hand; }
}

/** Doc ban ghi runs da loc (tail). Ws khong ton tai thi coi arg la node id (workspaceFor). File thieu -> rows rong. */
export function queryRuns({ root = dataRoot(), ws, tool, node = null, last = QUERY_LIMITS.defaultLast, status = null, since = null, maxBytes = QUERY_LIMITS.maxBytes, deadline = Date.now() + QUERY_LIMITS.timeoutS * 1000, hookOpts = {} } = {}) {
  if (status && !RUN_STATUS.includes(status)) throw new Error(`--status phai la ${RUN_STATUS.join('|')}`);
  let cut = null;
  if (since != null) { cut = Date.parse(since); if (Number.isNaN(cut)) throw new Error('--since phai la ISO'); }
  const cnt = Math.min(Math.max(Math.floor(Number(last)) || QUERY_LIMITS.defaultLast, 1), QUERY_LIMITS.maxLast);
  let wsName = ws;
  if (ID_RE.test(String(ws)) && !fs.existsSync(path.join(root, 'workspaces', String(ws)))) { try { const w = workspaceFor(ws, hookOpts); if (w && w !== ws) wsName = w; } catch {} }
  const file = routedRunsFile(root, wsName, tool, hookOpts);
  let truncated = null; let rows = [];
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    let lines = buf.toString('utf8').split('\n');
    if (size > len) { lines = lines.slice(1); truncated = `max-bytes ${maxBytes} (chi doc phan cuoi file)`; }
    for (const l of lines) {
      if (Date.now() > deadline) { truncated = 'timeout'; break; }
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      if (node && r.node !== node) continue;
      if (status && r.status !== status) continue;
      if (cut != null && !(Date.parse(r.ts) >= cut)) continue;
      rows.push(r);
    }
  } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  const total = rows.length;
  rows = rows.slice(-cnt);
  return { ws: wsName, tool, file: path.relative(root, file).replace(/\\/g, '/'), total, rows, truncated };
}

const fmtRow = (r) => [r.ts, r.node, r.status, r.run, r.durMs != null ? `${r.durMs}ms` : '-', r.cmd || '-', r.summary || ''].join('  ').trimEnd();

/** CLI: args = phan sau `query` (da bo --json/--raw/--timeout-s). Nem Error khi sai tham so (data.mjs bat va thoat 1). */
export function queryCli(args, { o = {}, root = dataRoot(), opts = {}, logAccess = null } = {}) {
  const pos = []; const f = { last: null, node: null, status: null, since: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--last') f.last = /^\d+$/.test(args[i + 1] ?? '') ? args[++i] : QUERY_LIMITS.defaultLast;
    else if (a === '--node' || a === '--status' || a === '--since') { const v = args[++i]; if (v == null || v.startsWith('--')) throw new Error(`${a} can gia tri`); f[a.slice(2)] = v; }
    else if (a.startsWith('--')) throw new Error(`co khong ho tro: ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2) throw new Error('usage: data query <ws> <tool> [--node X] [--last [N]] [--status S] [--since ISO] [--json]');
  const q = queryRuns({ root, ws: pos[0], tool: pos[1], node: f.node, last: f.last ?? QUERY_LIMITS.defaultLast, status: f.status, since: f.since, deadline: opts.deadline });
  if (logAccess) logAccess('query', args, { ws: q.ws, tool: q.tool, rows: q.rows.length });
  emit({ summary: q.rows.map(fmtRow).join('\n') || '(khong co ban ghi)', data: q, truncated: q.truncated }, o);
  return { code: 0 };
}
