// Doc JSONL -> dong phang, loc, gioi han (timeout/max_bytes/max_rows).
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadAuditConfig, originOf } from '../../../core/config/audit-config.mjs';

let _noiseCfg;
const noiseCfg = () => (_noiseCfg ??= { noise_cwd: loadAuditConfig().config.noise_cwd || [] });

import { numOrNull as num } from '../../../core/io/fmt.mjs';
const str = (v) => (v === undefined || v === null ? null : v);
// v1 va v2 -> cung 1 dong phang. v1: session_id, agent{id,type}, data.input_tokens; v2: sid, agent_id, tokens_in.
export function toRow(e, type, date) {
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  const a = e.agent && typeof e.agent === 'object' ? e.agent : null;
  const agent_id = str(e.agent_id ?? (a ? a.id : null));
  const agent_type = str(e.agent_type ?? (a ? a.type : null));
  const kind = e.target_kind ?? null;
  return {
    type, date, ts: e.ts ?? null, v: e.v ?? 1, event: e.event ?? null, session_id: e.sid ?? e.session_id ?? null,
    agent_id, agent_type, actor: e.actor ?? (a || agent_id || agent_type ? 'sub' : 'main'),
    project: e.project ?? null, cwd: e.cwd ?? null, tool: e.tool ?? null, target: e.target ?? null, target_kind: kind,
    ok: typeof e.ok === 'boolean' ? e.ok : null, dur_ms: num(e.dur_ms), turns: num(e.turns),
    in_tok: num(e.tokens_in ?? d.input_tokens), out_tok: num(e.tokens_out ?? d.output_tokens),
    cli: e.cli ?? d.cli ?? 'claude', tool_use_id: d.tool_use_id ?? null,
    step_idx: Number.isFinite(Number(e.step_idx ?? d.step_idx)) ? Number(e.step_idx ?? d.step_idx) : null,
    status: e.status ?? null, model: e.model ?? null, summary: e.summary ?? null,
    origin: e.origin === 'noise' || e.origin === 'work' || e.origin === 'dispatch' ? e.origin : originOf(e.cwd, noiseCfg()), // older lines: computed from cwd
    phantom: d.phantom === true,
  };
}

export function rowMatches(r, f) {
  if (f.session && r.session_id !== f.session) return false;
  if (f.cli && r.cli !== f.cli) return false;
  if (f.tool && r.tool !== f.tool) return false;
  if (f.event && r.event !== f.event) return false;
  if (f.project && r.project !== f.project) return false;
  if (f.actor && r.actor !== f.actor) return false;
  if (f.origin && r.origin !== f.origin) return false;
  if (r.phantom && !f.includePhantom) return false; // phantom SubagentStop (no agent_type/Start/transcript): excluded unless --include-phantom
  if (f.ok !== undefined && f.ok !== null && String(r.ok) !== String(f.ok)) return false;
  if (f.agent) {
    if (f.agent === 'main') { if (r.actor !== 'main') return false; }
    else if (r.agent_id !== f.agent && r.agent_type !== f.agent) return false;
  }
  return true;
}

export async function nodeRows(files, f, lim) {
  const rows = [];
  const seen = f.dedupe === true ? new Set() : null;
  let bytes = 0, n = 0;
  for (const file of files) {
    let size = 0;
    try { size = statSync(file.path).size; } catch {}
    if (bytes + size > lim.maxBytes) { lim.truncated = 'max_bytes'; break; }
    bytes += size;
    const rl = createInterface({ input: createReadStream(file.path, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if ((++n & 1023) === 0 && Date.now() > lim.deadline) { lim.truncated = 'timeout'; break; }
      const s = line.trim();
      if (!s) continue;
      let e;
      try { e = JSON.parse(s); } catch { continue; }
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const r = toRow(e, file.type, file.date);
      if (rowMatches(r, f)) {
        if (seen) { // opt-in dedupe: exact same-cli double-writes only
          const k = [r.cli, r.session_id, r.agent_id, r.tool_use_id, r.event, r.tool, r.target, String(r.ts || '').slice(0, 19)].join('');
          if (seen.has(k)) continue;
          seen.add(k);
        }
        rows.push(r);
        if (rows.length >= lim.maxRows) { lim.truncated = 'max_rows'; break; }
      }
    }
    rl.close();
    if (lim.truncated) break;
  }
  return rows;
}
