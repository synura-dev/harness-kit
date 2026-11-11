// Thay doi quy trinh tu git log: chi ten file + so lan sua (khong doc diff). Spec 4.2. Fail-open.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_PATHS = Object.freeze(['AGENTS.md', 'CLAUDE.md', '.claude/agents/', '.agents/agents/', '.claude/memory/']);
const DAY = 86400000;
const REPEAT_DAYS = 14;

/** Tuan ISO 'YYYY-Www' (UTC). */
export function isoWeek(ms) {
  const d = new Date(ms); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = d.getUTCFullYear();
  const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/** Ghi de paths qua <project>/.harness/report/process-changes.json (tuy chon). */
function configPaths(projectDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(projectDir, '.harness', 'report', 'process-changes.json'), 'utf8'));
    return Array.isArray(j.paths) && j.paths.length ? j.paths.filter((p) => typeof p === 'string') : null;
  } catch { return null; }
}
const inPaths = (f, paths) => paths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));

export function processChanges({ projectDir, sinceDays = 28, paths, timeoutMs = 8000, maxCommits = 500, nowMs = Date.now() } = {}) {
  const none = { items: [], weeks: [], files: [], repeat: [], truncated: 'no_git' };
  if (!projectDir) return none;
  const want = paths || configPaths(projectDir) || DEFAULT_PATHS;
  let out;
  try {
    const since = new Date(nowMs - sinceDays * DAY).toISOString();
    const r = spawnSync('git', ['-c', `safe.directory=${projectDir}`, '-C', projectDir, 'log', `--since=${since}`, '-n', String(maxCommits + 1), '--name-only', '--format=%x01%H%x09%cI'], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (r.error || r.status !== 0) return none;
    out = r.stdout;
  } catch { return none; }
  let commits = out.split('\x01').filter(Boolean).map((blk) => {
    const [head, ...rest] = blk.split('\n');
    return { ts: Date.parse(head.split('\t')[1]), files: rest.map((s) => s.trim()).filter(Boolean) };
  }).filter((c) => Number.isFinite(c.ts));
  let truncated = null;
  if (commits.length > maxCommits) { commits = commits.slice(0, maxCommits); truncated = 'max_commits'; }

  const weeks = new Map(); const files = new Map();
  for (const c of commits) {
    const fs_ = c.files.filter((f) => inPaths(f, want));
    if (!fs_.length) continue;
    const wk = weeks.get(isoWeek(c.ts)) || { changes: 0, files: new Set() };
    wk.changes++; fs_.forEach((f) => wk.files.add(f)); weeks.set(isoWeek(c.ts), wk);
    for (const f of fs_) { const e = files.get(f) || { path: f, edits: 0, last_ts: 0, recent: 0 }; e.edits++; e.last_ts = Math.max(e.last_ts, c.ts); if (c.ts >= nowMs - REPEAT_DAYS * DAY) e.recent++; files.set(f, e); }
  }
  return {
    weeks: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, w]) => ({ week, changes: w.changes, files: w.files.size })),
    files: [...files.values()].map((e) => ({ path: e.path, edits: e.edits, last_ts: new Date(e.last_ts).toISOString() })),
    repeat: [...files.values()].filter((e) => e.recent >= 2).map((e) => ({ path: e.path, edits: e.recent })),
    truncated,
  };
}

/** Hang cho report engine (nguon `process`): changes/tuan + file sua lap. */
export function processRows(pc) {
  if (!pc) return undefined;
  return [...(pc.weeks || []).map((w) => ({ label: `thay doi ${w.week}`, n: w.changes })), ...(pc.repeat || []).map((r) => ({ label: `lap ${r.path}`, n: r.edits }))];
}
