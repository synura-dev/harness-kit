// harness/core/runtime/worktree.mjs
// Git worktree cho CLI worker. Ten thu muc + branch dung chung 1 ham sanitize, dat theo sessionId (duy nhat).
// Layout: .worktrees/<safeSession>, branch wt-<safeSession>.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from './proc.mjs';
import { workspaceRoot, samePath } from '../io/paths.mjs';

const GIT_TIMEOUT_MS = 30000;
const LOCK_RETRIES = 4;
const LOCK_RE = /index\.lock|cannot lock ref|unable to lock|\.lock'/i;
// Ignored dirs that are safe to lose with the worktree (first path segment). Override via opts.disposable.
// Entry = duong dan tu goc worktree (khop chinh no hoac con cua no). Chi rac sinh tu dong cua worker; tracked/chua commit van bi chan boi dirty.
const DISPOSABLE_IGNORED = ['node_modules', '.worktrees', 'data', 'settings.local.json', '.claude/settings.local.json', '.claude/skills'];

function resolveBaseBranch(root, baseBranch) {
  if (baseBranch) return baseBranch;
  if (process.env.HUB_BASE_BRANCH) return process.env.HUB_BASE_BRANCH;
  const r = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  const b = r.status === 0 ? r.stdout.trim() : '';
  return b || 'main';
}

/** Parse 'git status --porcelain --ignored': { dirty, ignored: non-disposable ignored paths }. */
// Git gop thu muc ignored (vd '.claude/' chi chua skills/): neu la tien to cua muc disposable thi duyet fs (gioi han) xem moi file deu la rac.
function onlyDisposable(dir, rel, disposable, budget = { n: 2000 }) {
  let ents;
  try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return false; }
  for (const e of ents) {
    if (--budget.n < 0) return false;
    const q = `${rel}/${e.name}`;
    if (disposable.some((d) => q === d || q.startsWith(`${d}/`))) continue;
    if (e.isDirectory() && disposable.some((d) => d.startsWith(`${q}/`)) && onlyDisposable(dir, q, disposable, budget)) continue;
    return false;
  }
  return true;
}

function parseStatus(out, disposable = DISPOSABLE_IGNORED, wtPath = null) {
  let dirty = false;
  const ignored = [];
  for (const line of String(out).split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('!! ')) {
      const p = line.slice(3).trim().replace(/^"|"$/g, '');
      const q = p.replace(/\/+$/, '');
      if (disposable.some((d) => q === d || q.startsWith(`${d}/`))) continue;
      if (wtPath && disposable.some((d) => d.startsWith(`${q}/`)) && onlyDisposable(wtPath, q, disposable)) continue;
      ignored.push(p);
    } else dirty = true;
  }
  return { dirty, ignored };
}

export const sanitize = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

function runGit(args, cwd) {
  let res;
  for (let i = 0; i <= LOCK_RETRIES; i++) {
    res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    if (res.status === 0 || !LOCK_RE.test(`${res.stderr || ''}`)) break;
    sleepMs(150 * (i + 1));
  }
  return res;
}

function getWorktreeName(sessionId) {
  const n = sanitize(sessionId);
  if (!n) throw new Error('sessionId rong sau khi sanitize');
  return n;
}
export const getBranchName = (sessionId) => `wt-${getWorktreeName(sessionId)}`;
export function getWorktreePath(sessionId, root = workspaceRoot()) {
  return path.resolve(root, '.worktrees', getWorktreeName(sessionId));
}

export function listWorktrees(root = workspaceRoot(), run = runGit) {
  const res = run(['worktree', 'list', '--porcelain'], root);
  if (res.status !== 0) return [];
  const out = [];
  let cur = {};
  for (const line of res.stdout.split('\n')) {
    const t = line.trim();
    if (!t) { if (cur.path) out.push(cur); cur = {}; continue; }
    if (t.startsWith('worktree ')) cur.path = t.slice(9).trim();
    else if (t.startsWith('HEAD ')) cur.head = t.slice(5).trim();
    else if (t.startsWith('branch ')) cur.branch = t.slice(7).trim();
    else if (t === 'locked' || t.startsWith('locked ')) cur.locked = true;
  }
  if (cur.path) out.push(cur);
  return out;
}

/** Tao worktree; that bai => throw. @returns {{worktreePath, branch}} */
export function createWorktree(sessionId, { baseBranch, root = workspaceRoot() } = {}) {
  baseBranch = resolveBaseBranch(root, baseBranch);
  const worktreePath = getWorktreePath(sessionId, root);
  const branch = getBranchName(sessionId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const res = runGit(['worktree', 'add', '-b', branch, worktreePath, baseBranch], root);
  if (res.error || res.status !== 0) {
    throw new Error(`createWorktree that bai: ${(res.stderr || res.stdout || res.error?.message || '').trim()}`);
  }
  return { worktreePath, branch };
}

/** Idempotent: da co worktree dang ky o duong dan do => dung lai (created:false). Cung quy uoc ten/duong dan voi createWorktree. */
export function ensureWorktree(name, opts = {}) {
  const root = opts.root || workspaceRoot();
  const wtPath = getWorktreePath(name, root);
  if (fs.existsSync(wtPath) && listWorktrees(root).some((w) => w.path && samePath(w.path, wtPath))) {
    return { worktreePath: wtPath, branch: getBranchName(name), created: false };
  }
  return { ...createWorktree(name, opts), created: true };
}

/** Copy duong dan literal (moi dong 1, # = comment, bo qua glob) trong <root>/.worktreeinclude vao worktree. Khong ghi de. */
export function copyWorktreeInclude(root, wtPath) {
  const copied = [];
  let txt;
  try { txt = fs.readFileSync(path.join(root, '.worktreeinclude'), 'utf8'); } catch { return copied; }
  const rootAbs = path.resolve(root);
  for (const line of txt.split(/\r?\n/)) {
    const rel = line.trim();
    if (!rel || rel.startsWith('#') || /[*?[\]!]/.test(rel)) continue;
    const src = path.resolve(rootAbs, rel);
    const dst = path.resolve(wtPath, rel);
    if (!src.toLowerCase().startsWith(rootAbs.toLowerCase() + path.sep) || !fs.existsSync(src) || fs.existsSync(dst)) continue;
    try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.cpSync(src, dst, { recursive: true, force: false }); copied.push(rel); } catch {}
  }
  return copied;
}

/**
 * Don worktree an toan: khong --force, khong rm -rf, branch chi xoa bang -d.
 * @returns {{removed: boolean, kept: string[], reason: string}} removed = worktree da go; kept = thu giu lai ('worktree'|'branch')
 */
export function removeWorktree(sessionId, { baseBranch, root = workspaceRoot(), disposable = DISPOSABLE_IGNORED, run = runGit, sleep = sleepMs } = {}) {
  baseBranch = resolveBaseBranch(root, baseBranch);
  const wtPath = getWorktreePath(sessionId, root);
  const branch = getBranchName(sessionId);
  const kept = [];
  const reasons = [];
  let removed = false;

  if (fs.existsSync(wtPath)) {
    const st = run(['status', '--porcelain', '--ignored'], wtPath);
    const ps = st.status === 0 ? parseStatus(st.stdout, disposable, wtPath) : null;
    if (!ps) {
      kept.push('worktree');
      reasons.push('khong doc duoc git status');
    } else if (ps.dirty) {
      kept.push('worktree');
      reasons.push('worktree dirty');
    } else if (ps.ignored.length) {
      kept.push('worktree');
      reasons.push('ignored files present');
    } else {
      let rm = run(['worktree', 'remove', wtPath], root);
      // Windows: handle cua child vua thoat co the con giu cwd => retry, roi don thu muc rong da het dang ky.
      for (let i = 0; i < 4 && rm.status !== 0 && /Permission denied|being used/i.test(rm.stderr || ''); i++) { sleep(500 * (i + 1)); rm = run(['worktree', 'remove', wtPath], root); }
      if (rm.status !== 0 && !listWorktrees(root, run).some((w) => w.path && path.resolve(w.path).toLowerCase() === wtPath.toLowerCase())) {
        try { if (fs.readdirSync(wtPath).length === 0) { fs.rmdirSync(wtPath); rm = { status: 0 }; } } catch {}
      }
      if (rm.status === 0) removed = true;
      else { kept.push('worktree'); reasons.push(`worktree remove loi: ${(rm.stderr || '').trim()}`); }
    }
  } else {
    // Bay: worktree do nguon khac tao (vd .claude/worktrees/) dang ky voi branch wt-<session> o duong dan khac => khong bao removed.
    const other = listWorktrees(root, run).find((w) => w.branch && w.branch.replace(/^refs\/heads\//, '') === branch && w.path && !samePath(w.path, wtPath));
    if (other) {
      kept.push('worktree');
      reasons.push(`worktree that o ${other.path}, khong phai ${wtPath}; dung removeWorktreeAt(duongDan)`);
    } else {
      run(['worktree', 'prune'], root);
      removed = true;
      reasons.push('worktree da khong ton tai');
    }
  }

  const cnt = run(['rev-list', '--count', `${baseBranch}..${branch}`], root);
  if (cnt.status !== 0) {
    const ex = run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root);
    if (ex.status === 0) { kept.push('branch'); reasons.push('khong dem duoc commit'); }
  } else if (parseInt(cnt.stdout.trim(), 10) > 0) {
    kept.push('branch');
    reasons.push('branch con commit chua merge');
  } else if (!kept.includes('worktree')) {
    const d = run(['branch', '-d', branch], root);
    if (d.status !== 0) { kept.push('branch'); reasons.push(`branch -d loi: ${(d.stderr || '').trim()}`); }
  } else {
    kept.push('branch');
  }
  return { removed, kept, reason: reasons.join('; ') || 'ok' };
}

const shortBranch = (b) => (b || '').replace(/^refs\/heads\//, '');

/**
 * Don worktree theo DUONG DAN THAT (lay tu listWorktrees), khong suy tu sessionId. An toan nhu removeWorktree:
 * khong --force, branch chi -d, retry Permission denied, giu lai khi dirty / con commit chua merge.
 * Duong dan khong khop worktree nao da dang ky (hoac la worktree chinh) => { removed:false, error:true }.
 * @returns {{removed: boolean, kept: string[], reason: string, error?: boolean, branch?: string}}
 */
export function removeWorktreeAt(wtPath, { baseBranch, root = workspaceRoot(), disposable = DISPOSABLE_IGNORED, run = runGit, sleep = sleepMs } = {}) {
  baseBranch = resolveBaseBranch(root, baseBranch);
  const list = listWorktrees(root, run);
  const entry = wtPath ? list.find((w) => w.path && samePath(w.path, wtPath)) : null;
  if (!entry) return { removed: false, kept: [], error: true, reason: `duong dan khong khop worktree nao: ${wtPath}` };
  if (samePath(entry.path, list[0].path)) return { removed: false, kept: ['worktree'], error: true, reason: 'day la worktree chinh, khong don' };
  if (entry.locked) return { removed: false, kept: ['worktree'], reason: 'worktree locked' };
  const branch = shortBranch(entry.branch);
  const kept = [];
  const reasons = [];
  let removed = false;

  if (!fs.existsSync(entry.path)) {
    run(['worktree', 'prune'], root);
    removed = !listWorktrees(root, run).some((w) => w.path && samePath(w.path, entry.path));
    if (removed) reasons.push('thu muc da mat, da prune'); else { kept.push('worktree'); reasons.push('prune khong go duoc dang ky'); }
  } else {
    const st = run(['status', '--porcelain', '--ignored'], entry.path);
    const ps = st.status === 0 ? parseStatus(st.stdout, disposable, entry.path) : null;
    if (!ps) { kept.push('worktree'); reasons.push('khong doc duoc git status'); }
    else if (ps.dirty) { kept.push('worktree'); reasons.push('worktree dirty'); }
    else if (ps.ignored.length) { kept.push('worktree'); reasons.push('ignored files present'); }
    else {
      let rm = run(['worktree', 'remove', entry.path], root);
      for (let i = 0; i < 4 && rm.status !== 0 && /Permission denied|being used/i.test(rm.stderr || ''); i++) { sleep(500 * (i + 1)); rm = run(['worktree', 'remove', entry.path], root); }
      if (rm.status !== 0 && !listWorktrees(root, run).some((w) => w.path && samePath(w.path, entry.path))) {
        try { if (fs.readdirSync(entry.path).length === 0) { fs.rmdirSync(entry.path); rm = { status: 0 }; } } catch {}
      }
      if (rm.status === 0) removed = true;
      else { kept.push('worktree'); reasons.push(`worktree remove loi: ${(rm.stderr || '').trim()}`); }
    }
  }

  if (!branch) return { removed, kept, reason: reasons.join('; ') || 'ok', branch };
  const cnt = run(['rev-list', '--count', `${baseBranch}..${branch}`], root);
  if (cnt.status !== 0) { kept.push('branch'); reasons.push('khong dem duoc commit'); }
  else if (parseInt(cnt.stdout.trim(), 10) > 0) { kept.push('branch'); reasons.push('branch con commit chua merge'); }
  else if (!kept.includes('worktree')) {
    const d = run(['branch', '-d', branch], root);
    if (d.status !== 0) { kept.push('branch'); reasons.push(`branch -d loi: ${(d.stderr || '').trim()}`); }
  } else kept.push('branch');
  return { removed, kept, reason: reasons.join('; ') || 'ok', branch };
}
