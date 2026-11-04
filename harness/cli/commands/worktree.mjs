// harness/cli/commands/worktree.mjs - thay + don MOI worktree (Claude `.claude/worktrees/*`, harness `.worktrees/*`, main).
// Usage: node harness/cli/commands/worktree.mjs list [--json] [--base main] [--timeout N=60] [--max N=100]
//        node harness/cli/commands/worktree.mjs prune [--apply] [--base main] [--timeout N=60] [--max N=100]
// prune mac dinh DRY-RUN (chi in ke hoach). --apply moi thuc hien, qua removeWorktreeAt (duong dan that;
// khong --force, branch chi -d). Bo qua: main/other, locked, dirty, con commit chua merge, khong doc duoc trang thai.
// --min-age-hours N: chi don worktree co thu muc >= N gio tuoi (dung cho sweep tu dong).
// Qua han -> `truncated: timeout` (hoac `max`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspaceRoot, samePath, isInside } from '../../core/io/paths.mjs';
import { listWorktrees, removeWorktreeAt } from '../../core/runtime/worktree.mjs';

export const limits = { timeoutMs: 60000, max: 100, gitTimeoutMs: 15000 };
const branchName = (b) => (b || '').replace(/^refs\/heads\//, '');

export function sourceOf(wtPath, root, isMain) {
  if (isMain) return 'main';
  if (isInside(wtPath, path.join(root, '.claude', 'worktrees'))) return 'claude';
  if (isInside(wtPath, path.join(root, '.worktrees'))) return 'harness';
  return 'other';
}

export function inspectAll(root, { base = 'main', timeoutMs = limits.timeoutMs, max = limits.max } = {}) {
  const t0 = Date.now();
  const left = () => Math.max(1000, Math.min(limits.gitTimeoutMs, timeoutMs - (Date.now() - t0)));
  const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: left() });
  const all = listWorktrees(root);
  let truncated = null;
  if (all.length > max) truncated = 'max';
  const rows = [];
  for (const [i, w] of all.slice(0, max).entries()) {
    if (Date.now() - t0 > timeoutMs) { truncated = 'timeout'; break; }
    const branch = branchName(w.branch);
    const source = sourceOf(w.path, all[0].path, i === 0);
    let ageHours = null;
    try { ageHours = (Date.now() - fs.statSync(w.path).mtimeMs) / 3600000; } catch {}
    const row = { source, ageHours, path: w.path, branch: branch || '(detached)', state: 'clean', locked: !!w.locked, prunable: false, dirty: null, unmerged: null };
    if (!fs.existsSync(w.path)) { row.prunable = true; row.state = 'prunable'; }
    else {
      const st = git(['status', '--porcelain'], w.path);
      row.dirty = st.status === 0 ? st.stdout.split('\n').filter((l) => l.trim()).length : null;
      if (row.dirty === null) row.state = 'unknown';
      else if (row.dirty > 0) row.state = 'dirty';
    }
    if (w.locked) row.state = row.state === 'clean' ? 'locked' : `${row.state}+locked`;
    if (branch && source !== 'main') {
      const c = git(['rev-list', '--count', `${base}..${branch}`], root);
      row.unmerged = c.status === 0 ? parseInt(c.stdout.trim(), 10) : null;
    }
    rows.push(row);
  }
  return { rows, truncated };
}

/** Ke hoach: moi row -> { action: 'remove'|'skip', why }. Thuan tuy, khong ghi gi. */
export function planPrune(rows, { minAgeHours = 0 } = {}) {
  return rows.map((r) => {
    let why = null;
    if (r.source === 'main') why = 'worktree chinh';
    else if (r.source === 'other') why = 'ngoai .claude/worktrees va .worktrees';
    else if (r.locked) why = 'locked';
    else if (minAgeHours > 0 && !r.prunable && !(r.ageHours >= minAgeHours)) why = `chua du ${minAgeHours}h tuoi`;
    else if (r.prunable) why = null;
    else if (r.dirty === null) why = 'khong doc duoc trang thai';
    else if (r.dirty > 0) why = `dirty (${r.dirty} file)`;
    else if (!r.branch || r.branch === '(detached)') why = 'detached, khong biet da merge chua';
    if (!why && !r.prunable) {
      if (r.unmerged === null) why = 'khong dem duoc commit chua merge';
      else if (r.unmerged > 0) why = `${r.unmerged} commit chua merge`;
    }
    return { ...r, action: why ? 'skip' : 'remove', why: why || (r.prunable ? 'thu muc da mat, prune' : 'sach + da merge') };
  });
}

export function applyPlan(plan, root, base) {
  return plan.map((p) => {
    if (p.action !== 'remove') return p;
    const res = removeWorktreeAt(p.path, { root, baseBranch: base });
    return { ...p, result: res.error ? `loi: ${res.reason}` : res.removed ? 'removed' : 'giu lai', detail: res.reason, kept: res.kept };
  });
}

function main(argv) {
  const cmd = argv[0];
  const opts = { base: 'main', timeoutMs: limits.timeoutMs, max: limits.max };
  let json = false, apply = false, minAgeHours = 0;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--apply' && cmd === 'prune') apply = true;
    else if (a === '--min-age-hours' && Number(argv[i + 1]) >= 0) minAgeHours = Number(argv[++i]);
    else if (a === '--base' && argv[i + 1]) opts.base = argv[++i];
    else if (a === '--timeout' && Number(argv[i + 1]) > 0) opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--max' && Number(argv[i + 1]) > 0) opts.max = Number(argv[++i]);
    else { console.error(`co la: ${a}`); return 1; }
  }
  if (cmd !== 'list' && cmd !== 'prune') { console.error('usage: worktree.mjs list|prune [--json] [--apply] [--base main] [--timeout N] [--max N]'); return 1; }
  const root = workspaceRoot();
  const { rows, truncated } = inspectAll(root, opts);
  if (cmd === 'list') {
    if (json) console.log(JSON.stringify({ rows, truncated }, null, 2));
    else {
      console.log(['source', 'branch', 'state', 'unmerged', 'path'].join('\t'));
      for (const r of rows) console.log([r.source, r.branch, r.state, r.unmerged ?? '-', r.path].join('\t'));
      console.log(`total ${rows.length}`);
      if (truncated) console.log(`truncated: ${truncated}`);
    }
    return 0;
  }
  let plan = planPrune(rows, { minAgeHours });
  if (apply) plan = applyPlan(plan, root, opts.base);
  console.log(apply ? 'prune --apply' : 'prune DRY-RUN (them --apply de thuc hien)');
  for (const p of plan) console.log([p.action.toUpperCase(), p.source, p.branch, p.why, p.result ? `=> ${p.result}${p.detail && p.detail !== 'ok' ? ` (${p.detail})` : ''}` : '', p.path].filter(Boolean).join('\t'));
  console.log(`total ${plan.length}, remove ${plan.filter((p) => p.action === 'remove').length}, skip ${plan.filter((p) => p.action === 'skip').length}`);
  if (truncated) console.log(`truncated: ${truncated}`);
  return 0;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
