// audit view: dung bao cao tu so lieu da quet (view.mjs).
import path from 'node:path';
import { fmtDur, fmtTok } from './util.mjs';

export function formatView(s) {
  const { date, totalEvents, files, truncated, truncatedBytes, verifiedErrors, unverifiedErrors, verifiedGroups, subagentsMap, maxTurnHits, unboundedBash, permPromptsCount, permPromptsTypes, pathGuessingCount, mainExtWrites, tokensMap } = s;
  // Format outputs
  // 1. Repeated errors summary
  const repeatedList = [...verifiedGroups.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);
  let repSummary = 'no repeated groups';
  if (repeatedList.length > 0) {
    const topRep = repeatedList.slice(0, 3).map(([k, c]) => {
      const [t, tgt] = k.split(' | ');
      const cleanTgt = (tgt || '').replace(/["']/g, '').trim();
      const shortTgt = cleanTgt.length > 30 ? cleanTgt.slice(0, 27) + '...' : cleanTgt;
      return `${c}x ${t} (${shortTgt})`;
    }).join(', ');
    repSummary = `${repeatedList.length} repeated groups (top: ${topRep})`;
  }
  // 2. Subagents > 10m
  const longSubs = [...subagentsMap.values()]
    .map((s) => {
      const wall = s.t0 != null && s.t1 != null ? s.t1 - s.t0 : 0;
      const dur = Math.max(s.maxDur, wall);
      return { ...s, dur };
    })
    .filter((s) => s.dur > 600000)
    .sort((a, b) => b.dur - a.dur);
  // 4. Top unbounded bash
  unboundedBash.sort((a, b) => b.dur_ms - a.dur_ms);
  const topBash = unboundedBash.slice(0, 3).map((b) => {
    const cleanTgt = b.target.replace(/\s+/g, ' ').trim();
    const shortTgt = cleanTgt.length > 35 ? cleanTgt.slice(0, 32) + '...' : cleanTgt;
    return `${Math.round(b.dur_ms / 1000)}s (${shortTgt})`;
  });
  // 5. Permission prompts summary
  const permTypesArr = [...permPromptsTypes.entries()].map(([k, c]) => `${c} ${k}`);
  const permTypesStr = permTypesArr.length ? permTypesArr.join(', ') : 'none';
  // 6. External writes summary
  const extProjects = new Set();
  for (const w of mainExtWrites) {
    const norm = w.target.replace(/\\/g, '/');
    const m = norm.match(/^[A-Za-z]:\/(?:[^\/]+\/)?([^\/]+)/);
    extProjects.add(m ? m[1] : path.basename(path.dirname(norm)));
  }
  const extProjectsStr = [...extProjects].slice(0, 3).join(', ');
  // 7. Token outliers
  const topTokens = [...tokensMap.values()]
    .map((t) => ({ ...t, total: t.tin + t.tout }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);
  const outLines = [
    `=== Audit Review: ${date} (${totalEvents} events, ${files.length} files)${truncated ? ' [truncated: timeout]' : ''}${truncatedBytes ? ' [truncated: max-bytes]' : ''} ===`,
    `1. Repeated errors:`,
    `   - Verified: ${verifiedErrors} real errors (${repSummary})`,
    `   - Unverified / False positives: ${unverifiedErrors} rows filtered (error="")`,
    `2. Subagents > 10m (wall clock / dur_ms):`,
    longSubs.length
      ? `   - ${longSubs.length} subagents: ${longSubs.slice(0, 3).map((s) => `${s.id.slice(0, 8)} (${s.type || 'sub'}, ${fmtDur(s.dur)})`).join(', ')}`
      : `   - None (all subagents <= 10m)`,
    `3. Agents hit maxTurns:`,
    maxTurnHits.length
      ? `   - ${maxTurnHits.length} agents: ${maxTurnHits.map((h) => `${h.id.slice(0, 8)} (${h.type}, ${h.turns}/${h.limit})`).join(', ')}`
      : `   - None (0 agents hit maxTurns or status=partial)`,
    `4. Bash commands > 60s without timeout:`,
    unboundedBash.length
      ? `   - ${unboundedBash.length} commands (top: ${topBash.join(', ')})`
      : `   - None (all <= 60s or have timeout)`,
    `5. Permission prompts & Path guessing:`,
    `   - Permission prompts: ${permPromptsCount} (${permTypesStr})`,
    `   - Path guessing: ${pathGuessingCount} errors (directory/file not found in wrong cwd)`,
    `6. Main writes to external project code:`,
    mainExtWrites.length
      ? `   - ${mainExtWrites.length} writes by main outside hub (targets: ${extProjectsStr})`
      : `   - None (no external project writes)`,
    `7. Token outliers (max per session x agent):`,
    ...topTokens.map((t) => `   - ${t.sid.slice(0, 15)} (${t.agent}): ${fmtTok(t.tin)} in / ${fmtTok(t.tout)} out (${fmtTok(t.total)} total)`),
    `============================================================`
  ];
  return {
    date,
    totalEvents,
    totalFiles: files.length,
    verifiedErrors,
    unverifiedErrors,
    repeatedGroups: repeatedList.length,
    longSubagents: longSubs.length,
    maxTurnHits: maxTurnHits.length,
    unboundedBash: unboundedBash.length,
    permPromptsCount,
    pathGuessingCount,
    mainExtWrites: mainExtWrites.length,
    topTokens,
    lines: outLines
  };
}
