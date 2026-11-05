// Nguon candidate mac dinh cho job ledger: quy trinh lap (kind='pattern') + prune (kind='deprecate'|'cap').
// Moi nguon: async (events, nowIso, ctx{defs, hubDir, nowMs, dryRun}) -> candidate[]. Thieu luat tuong ung (tat/khong co) -> [] (khong chay).
import path from 'node:path';
import { detectPatterns, compileRegexList } from '../../evolve/loop/patterns.mjs';
import { pruneCandidates, readState, writeState } from '../../evolve/loop/prune.mjs';
import { dataReadRoots } from '../../core/registry/data-registry.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { auditRoot } from '../../core/audit/audit-write.mjs';
import { listRegistered } from '../../core/ext/ext-trust.mjs';

/** Thu muc ext hub da dang ky (qua API ext registry, khong doc file tho). Loi -> []. */
export function registeredExtRoots(hubDir) {
  try { return listRegistered({ workspace: hubDir }).map((e) => e.root); } catch { return []; }
}

export function patternSource(events, nowIso, ctx = {}) {
  const def = (ctx.defs || []).find((d) => d.id === 'repeated-pattern');
  if (!def) return [];
  const ev = events.filter((e) => e && (e.event === 'PostToolUse' || e.event === 'UserPromptSubmit'));
  const o = { minCount: Number(def.threshold) || undefined, minSessions: Number(def.min_sessions) || undefined };
  if (Array.isArray(def.ignore)) o.ignore = compileRegexList(def.ignore);
  if (Array.isArray(def.info)) o.info = compileRegexList(def.info);
  return detectPatterns(ev, o).items;
}

export async function pruneSource(events, nowIso, ctx = {}) {
  const defs = ctx.defs || [];
  if (!defs.some((d) => d.id === 'deprecate' || d.id === 'cap')) return [];
  const hub = path.resolve(ctx.hubDir);
  const evo = dataReadRoots('evolve')[0] || dataPathFor('evolve', { quiet: true });
  const stateFile = path.join(evo, 'prune-state.json');
  const auditDirs = dataReadRoots('audit').length ? dataReadRoots('audit') : [auditRoot()];
  const r = await pruneCandidates({ auditDirs, projectDir: hub, extRoots: registeredExtRoots(hub), nowMs: ctx.nowMs, state: readState(stateFile) });
  if (!ctx.dryRun && !r.truncated) writeState(stateFile, r.state); // che do job luon --record (tru dry-run)
  return r.items;
}

export const defaultCandidateSources = () => [patternSource, pruneSource];
