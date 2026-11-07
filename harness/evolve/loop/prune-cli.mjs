// evolve scan deprecate [--days N] [--json] [--record]: giu harness gon (tran + deprecate theo muc dung).
import path from 'node:path';
import { workspaceRoot, dataDir } from '../../core/io/paths.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { dataReadRoots } from '../../core/registry/data-registry.mjs';
import { auditRoot } from '../../core/audit/audit-write.mjs';
import { capLines } from '../../core/io/out.mjs';
import { pruneCandidates, readState, writeState, wireDefaults } from './prune.mjs';
import { listRegistered } from '../../core/ext/ext-trust.mjs';

export async function runPrune(o = {}) {
  const hub = path.resolve(o.hubRoot || process.env.CLAUDE_PROJECT_DIR || workspaceRoot());
  const evo = path.resolve(o.dataRoot || (dataReadRoots('evolve')[0] || dataPathFor('evolve')));
  const auditDirs = o.auditDir ? [path.resolve(o.auditDir)] : (dataReadRoots('audit').length ? dataReadRoots('audit') : [auditRoot()]);
  const stateFile = path.join(evo, 'prune-state.json');
  let extRoots = o.extRoots; // ext hub da dang ky (API ext registry) de dem lenh ext
  if (!extRoots) { try { extRoots = listRegistered({ workspace: hub }).map((e) => e.root); } catch { extRoots = []; } }
  const r = await pruneCandidates({ auditDirs, projectDir: hub, extRoots, ownedPlugins: o.ownedPlugins, days: o.days, timeoutMs: o.timeoutMs, state: readState(stateFile), ...(o.transcriptRoots ? { transcriptRoots: o.transcriptRoots, gateWindow: true } : wireDefaults(evo)), ...(o.transcriptCache ? { transcriptCache: o.transcriptCache } : {}) });
  if (o.record && !r.truncated) writeState(stateFile, r.state);
  const dep = r.items.filter((i) => i.kind === 'deprecate');
  const insuf = dep.filter((i) => i.status === 'insufficient_window');
  const rep = dep.filter((i) => i.status === 'report_only');
  const tag = (i) => (i.source ? `  [${i.source} -> ${i.action}]` : '');
  const extra = [];
  if (o.cost) {
    const top = [...r.inventory].sort((a, b) => b.cost.windowCost - a.cost.windowCost).slice(0, 15);
    extra.push(`chi phi ngu canh (top 15 theo windowCost = desc x ${r.total_sessions} phien + body x so lan dung; token ~ chars/4):`,
      ...top.map((i) => `  ${`${i.kind}:${i.name}`.padEnd(40)} windowCost=${i.cost.windowCost} (desc ${i.cost.desc_tokens}, body ${i.cost.body_tokens}, dung ${i.count}) costPerUse=${Math.round(i.cost.costPerUse)}  ${i.source}`));
  }
  if (o.byProject) {
    const rows = Object.entries(r.usage_detail).filter(([, d]) => Object.keys(d.projects || {}).length).sort((a, b) => b[1].count - a[1].count).slice(0, 30);
    extra.push('theo du an (top 3 moi muc):', ...rows.map(([k, d]) => `  ${k.padEnd(40)} ${Object.entries(d.projects).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${p}=${n}`).join(', ')}`));
  }
  for (const key of o.detail ? String(o.detail).split(',') : []) { // --detail a:x,b:y
    const d = r.usage_detail[key] || r.inventory.map((i) => ({ k: `${i.kind}:${i.name}`, ...i })).find((i) => i.k === key);
    if (!d) extra.push(`detail ${key}: khong co trong kiem ke lan usage`);
    else {
      const kv = (m) => Object.entries(m || {}).map(([k, n]) => `${k}=${n}`).join(', ') || '-';
      extra.push(`detail ${key}: count=${d.count} phien=${d.sessions} tu ${d.first_ts || '-'} den ${d.last_ts || '-'}`,
        `  kenh: ${kv(d.channels)}`, `  ids: ${(d.ids || []).join(', ') || '-'}`, `  phien: ${(d.session_ids || []).join(', ') || '-'}`, `  du an: ${kv(d.projects)}`,
        `  source=${d.source || '-'} action=${d.action || '-'}`, ...(d.cost ? [`  cost: desc=${d.cost.desc_tokens} body=${d.cost.body_tokens} windowCost=${d.cost.windowCost} costPerUse=${Math.round(d.cost.costPerUse)}`] : []),
        ...(d.sample || []).map((s) => `  mau: ${s.ts} ${s.channel}/${s.origin} phien=${s.session} du an=${s.project || '-'} call=${s.callId || '-'}`));
    }
  }
  const tsrc = r.sources.transcript, asrc = r.sources.audit;
  const lines = [
    `evolve prune-candidates: ${dep.length - insuf.length - rep.length} deprecate (${dep.filter((i) => i.status === 'propose_remove').length} propose_remove), ${insuf.length} insufficient_window, ${rep.length} report_only, ${r.items.filter((i) => i.kind === 'cap').length} cap (cua so yeu cau ${r.days} ngay, quet ${r.scanned} su kien)`,
    `du lieu thuc: ${[tsrc && `transcript tu ${String(tsrc.earliest).slice(0, 10)} (${tsrc.window_days} ngay, cache ${tsrc.cache_hits}/${tsrc.files})`, `audit tu ${String(asrc.earliest).slice(0, 10)} (${asrc.window_days} ngay)`].filter(Boolean).join(', ')}; duplicates_dropped=${r.duplicates_dropped}, maintenance_dropped=${r.maintenance_dropped}`,
    'thanh phan: ' + Object.entries(r.counts).map(([t, c]) => `${t} ${c.total}/${c.cap}`).join(', '),
    `phien trong cua so: ${r.total_sessions}`,
    `nguon: gateway=${r.sources.command_gateway} (tu ${r.sources.gateway_since || '-'}), bash_fallback=${r.sources.command_bash_fallback}, hookrun=${r.sources.hookrun_events} (tu ${r.sources.hookrun_since || '-'})`,
    ...r.items.filter((i) => i.kind === 'cap').map((i) => `CAP ${i.sample}`),
    ...r.dupes.pairs.map((p) => `trung mo ta: ${p.a} ~ ${p.b} (${p.score.toFixed(2)})`),
    ...(r.dupes.truncated ? [`trung mo ta: truncated: ${r.dupes.truncated}`] : []),
    ...extra, // truoc danh sach dai (deprecate/report_only) de khong bi cat
    ...dep.map((i) => (i.status === 'insufficient_window' ? `insufficient_window ${i.id}  (du lieu ${i.window_days} ngay < ${r.days})${tag(i)}` : i.status === 'report_only' ? `report_only    ${i.id}${tag(i)}` : `${i.status.padEnd(14)} ${i.id}  tu ${i.pending_since}${i.status === 'pending' ? ` (xet bo sau ${i.propose_after})` : ''}${tag(i)}`)),
    ...r.unevaluated.map((u) => `khong danh gia: ${u}`),
    ...(r.truncated ? [`truncated: ${r.truncated}`] : []),
  ];
  return { code: 0, summary: capLines(lines, 60 + extra.length).join('\n'), data: r, truncated: r.truncated };
}
