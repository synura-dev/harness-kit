// evolve dupes-content: khoi trung noi dung giua CLAUDE/AGENTS/agents/memory/knowledge; --propose -> toi da 3 de xuat kind fix theo chi so (khong sua file).
import { capLines } from '../../core/io/out.mjs';
import { workspaceRoot } from '../../core/io/paths.mjs';
import { collectSources, findContentDupes, runExport } from '../usage/content-dupes.mjs';
import { proposeMetricFix } from './loop.mjs';

export const MAX_PROPOSE = 3;

export async function runDupes(o) {
  const root = o.root || workspaceRoot();
  const run = o.run || ((x) => runExport({ ...x, cwd: root }));
  const { sources, truncated: t1 } = await collectSources({ root, run, timeoutMs: o.timeoutMs });
  const found = findContentDupes(sources, { ...(o.thresholdF ? { threshold: o.thresholdF } : {}), timeoutMs: o.timeoutMs });
  const pairs = found.pairs.slice(0, o.limit || 20);
  const proposed = [];
  if (o.propose) for (const p of pairs) { if (proposed.length >= MAX_PROPOSE) break; const r = proposeMetricFix(p, o); if (r) proposed.push(r.id); }
  const truncated = found.truncated || t1 || undefined;
  const lines = [`evolve dupes-content: ${found.pairs.length} cap trung (${sources.length} nguon)${truncated ? ` truncated: ${truncated}` : ''}`,
    ...pairs.map((p) => `${p.score}  ${p.a.loc}  <->  ${p.b.loc}`), ...(o.propose ? [`de xuat moi: ${proposed.length}${proposed.length ? ` (${proposed.join(', ')})` : ''}`] : [])];
  return { code: 0, summary: capLines(lines, 40).join('\n'), data: { pairs, proposed, truncated: truncated || null }, truncated };
}
