// Policy dich cho vong tien hoa: chuan hoa (Windows), cam tuong minh, realpath (junction/symlink), allowlist DENY-BY-DEFAULT.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceRoot, isInside, REPO_DIR, toPosix } from '../../core/io/paths.mjs';

// ---- policy dich: DENY-BY-DEFAULT ----
// Chi ghi duoc: skill moi harness/skills/**/*.md, fact qua cong knowledge. Moi thu khac tu choi. FORBIDDEN chi de bao "chi sua tay" ro rang.
const FORBIDDEN = [
  [/^harness\/constrain(\/|$)/, 'nhom Han che (constrain)'],
  [/^harness\/hooks(\/|$)/, 'ma hook'],
  [/(^|\/)[^/]*bash-guard[^/]*(\/|$)/, 'bash-guard'],
  [/(^|\/)guard(\/|$)/, 'cau hinh/ma guard'],
  [/^config\/(approval|verify-gate|guard|hub|knowledge)(\/|$)/, 'config cua hook chan/duyet/hub'],
  [/^harness\/evolve(\/|$)/, 'oracle eval / vong tien hoa'],
  [/^\.claude(\/|$)/, '.claude (settings/agents)'],
  [/^\.agents(\/|$)/, '.agents (hooks/agents)'],
  [/^\.git(\/|$)/, '.git'],
];
const ALLOW = [
  [/^harness\/skills\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*\.md$/, ['skill']],
  [/^data\/memory\/fact\/[a-z0-9][a-z0-9-]*\.md$/, ['fact']],
];
const CASE_FOLD = process.platform === 'win32' || process.platform === 'darwin';
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i;

/** Chuan hoa dich tuong doi: \ -> /, bo cham/khoang trang cuoi moi doan (Windows), chan .., tuyet doi, ADS (:), ten thiet bi, 8.3 (~N). */
function normalizeTarget(target) {
  if (typeof target !== 'string' || !target || target.length > 400 || /[\0-\x1f<>"|?*]/.test(target)) return { error: 'dich rong/ky tu khong hop le' };
  if (target.includes(':')) return { error: 'dich chua ":" (o dia/ADS)' };
  const t = target.replace(/\\/g, '/');
  if (t.startsWith('/') || path.isAbsolute(target) || path.win32.isAbsolute(target)) return { error: 'dich tuyet doi' };
  const segs = [];
  for (const raw of t.split('/')) {
    if (raw === '.') continue;
    if (raw === '') return { error: 'dich co doan rong' };
    const s = raw.replace(/[. ]+$/, '');
    if (raw === '..' || s === '') return { error: 'dich chua .. / doan chi co cham-khoang trang' };
    if (RESERVED.test(s) || /~\d/.test(s)) return { error: `doan dich khong hop le: ${s}` };
    segs.push(s);
  }
  if (!segs.length) return { error: 'dich rong' };
  return { rel: segs.join('/'), key: segs.join('/').toLowerCase() };
}

const realOrNull = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
/** realpath cua abs ke ca khi chua ton tai: realpath to tien gan nhat da ton tai + phan con lai. */
function realpathDeep(abs) {
  let cur = abs; const rest = [];
  for (let i = 0; i < 64; i++) {
    let st = null; try { st = fs.lstatSync(cur); } catch {}
    if (st) { const r = realOrNull(cur); return r == null ? null : path.join(r, ...rest.reverse()); }
    const up = path.dirname(cur);
    if (up === cur) return null;
    rest.push(path.basename(cur)); cur = up;
  }
  return null;
}
const relKey = (root, abs) => { if (!isInside(abs, root)) return null; const r = toPosix(path.relative(root, abs)); return r && !r.startsWith('..') ? r : null; };
export const same = (a, b) => (CASE_FOLD ? a.toLowerCase() === b.toLowerCase() : a === b);

/** {ok, forbidden, reason, rel, abs, knowledgeId}. Chuan hoa -> cam -> realpath (bat junction/symlink) -> allowlist. */
export function classifyTarget(target, kind, o = {}) {
  const c = { hub: path.resolve(o.hubRoot || workspaceRoot()) };
  const n = normalizeTarget(target);
  if (n.error) return { ok: false, forbidden: false, reason: n.error };
  const forb = (key) => FORBIDDEN.find(([re]) => re.test(key));
  let f = forb(n.key);
  if (f) return { ok: false, forbidden: true, reason: `dich cam: ${f[1]} (${n.key})`, rel: n.rel };
  const hubReal = realOrNull(c.hub);
  if (!hubReal) return { ok: false, forbidden: false, reason: 'hub khong ton tai', rel: n.rel };
  const abs = path.join(hubReal, ...n.rel.split('/'));
  const real = realpathDeep(abs);
  if (!real) return { ok: false, forbidden: false, reason: 'khong xac dinh duoc realpath', rel: n.rel };
  const realRel = relKey(hubReal, real);
  if (realRel == null) return { ok: false, forbidden: false, reason: `realpath ngoai hub (junction/symlink?): ${n.rel}`, rel: n.rel };
  if (!same(realRel, n.rel)) return { ok: false, forbidden: false, reason: `realpath lech dich (junction/symlink?): ${n.rel} -> ${realRel}`, rel: n.rel };
  const repoReal = realOrNull(path.resolve(REPO_DIR));
  const repoRel = repoReal ? relKey(repoReal, real) : null;
  f = forb(realRel.toLowerCase()) || (repoRel != null ? forb(repoRel.toLowerCase()) : null);
  if (f) return { ok: false, forbidden: true, reason: `dich cam: ${f[1]} (${realRel})`, rel: n.rel };
  const hit = ALLOW.find(([re]) => re.test(n.key));
  if (!hit) return { ok: false, forbidden: false, reason: `dich ngoai allowlist (deny-by-default): ${n.rel}`, rel: n.rel };
  if (!hit[1].includes(kind)) return { ok: false, forbidden: false, reason: `kind ${kind} khong duoc ghi vao ${n.rel}`, rel: n.rel };
  const knowledgeId = kind === 'fact' ? path.posix.basename(n.key, '.md') : null;
  return { ok: true, forbidden: false, reason: null, rel: n.rel, abs, knowledgeId };
}

