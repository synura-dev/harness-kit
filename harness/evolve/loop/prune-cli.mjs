// evolve prune-candidates [--days N] [--json] [--record]: giu harness gon (tran + deprecate theo muc dung).
import path from 'node:path';
import { workspaceRoot, dataDir } from '../../core/io/paths.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { dataReadRoots } from '../../core/registry/data-registry.mjs';
import { auditRoot } from '../../core/audit/audit-write.mjs';
import { capLines } from '../../core/io/out.mjs';
import { pruneCandidates, readState, writeState } from './prune.mjs';
import { listRegistered } from '../../core/ext/ext-trust.mjs';

export async function runPrune(o = {}) {
  const hub = path.resolve(o.hubRoot || process.env.CLAUDE_PROJECT_DIR || workspaceRoot());
  const evo = path.resolve(o.dataRoot || (dataReadRoots('evolve')[0] || dataPathFor('evolve')));
  const auditDirs = o.auditDir ? [path.resolve(o.auditDir)] : (dataReadRoots('audit').length ? dataReadRoots('audit') : [auditRoot()]);
  const stateFile = path.join(evo, 'prune-state.json');
  let extRoots = o.extRoots; // ext hub da dang ky (API ext registry) de dem lenh ext
  if (!extRoots) { try { extRoots = listRegistered({ workspace: hub }).map((e) => e.root); } catch { extRoots = []; } }
  const r = await pruneCandidates({ auditDirs, projectDir: hub, extRoots, days: o.days, timeoutMs: o.timeoutMs, state: readState(stateFile) });
  if (o.record && !r.truncated) writeState(stateFile, r.state);
  const dep = r.items.filter((i) => i.kind === 'deprecate');
  const lines = [
    `evolve prune-candidates: ${dep.length} deprecate (${dep.filter((i) => i.status === 'propose_remove').length} propose_remove), ${r.items.filter((i) => i.kind === 'cap').length} cap / ${r.days} ngay (quet ${r.scanned} su kien)`,
    'thanh phan: ' + Object.entries(r.counts).map(([t, c]) => `${t} ${c.total}/${c.cap}`).join(', '),
    `nguon: gateway=${r.sources.command_gateway} (tu ${r.sources.gateway_since || '-'}), bash_fallback=${r.sources.command_bash_fallback}, hookrun=${r.sources.hookrun_events} (tu ${r.sources.hookrun_since || '-'})`,
    ...r.items.filter((i) => i.kind === 'cap').map((i) => `CAP ${i.sample}`),
    ...dep.map((i) => `${i.status.padEnd(14)} ${i.id}  tu ${i.pending_since}${i.status === 'pending' ? ` (xet bo sau ${i.propose_after})` : ''}`),
    ...r.unevaluated.map((u) => `khong danh gia: ${u}`),
    ...(r.truncated ? [`truncated: ${r.truncated}`] : []),
  ];
  return { code: 0, summary: capLines(lines, 60).join('\n'), data: r, truncated: r.truncated };
}
