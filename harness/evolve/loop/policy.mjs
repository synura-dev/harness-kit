// Policy dich cho vong tien hoa: chuan hoa (Windows), cam tuong minh, realpath trong goc du lieu (junction/symlink), allowlist DENY-BY-DEFAULT.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceRoot, isInside, REPO_DIR, toPosix, dataDir } from '../../core/io/paths.mjs';
import { loadConfig } from '../../core/config/config.mjs';

// ---- policy dich: DENY-BY-DEFAULT ----
// Dich la duong dan LOGIC tuong doi GOC DU LIEU (dataDir: <du an>/.harness/data | <hub>/data | HUB_DATA_DIR), khong tuong doi workspace.
// Chi ghi duoc: skill de xuat <evolve>/skills/<ten>/**.md (cho nguoi duyet; KHONG tu ghi .claude/skills, .agents/skills hay plugin),
// Moi thu khac tu choi. FORBIDDEN chi de bao "chi sua tay" ro rang.
const FORBIDDEN = [
  [/^harness\/constrain(\/|$)/, 'nhom Han che (constrain)'],
  [/^harness\/hooks(\/|$)/, 'ma hook'],
  [/(^|\/)[^/]*bash-guard[^/]*(\/|$)/, 'bash-guard'],
  [/(^|\/)guard(\/|$)/, 'cau hinh/ma guard'],
  [/^config\/(approval|verify-gate|guard|hub)(\/|$)/, 'config cua hook chan/duyet/hub'],
  [/^harness\/evolve(\/|$)/, 'oracle eval / vong tien hoa'],
  [/^\.claude(\/|$)/, '.claude (settings/agents)'],
  [/^\.agents(\/|$)/, '.agents (hooks/agents)'],
  [/^\.git(\/|$)/, '.git'],
  [/^config(\/|$)/, 'config/'],
];
// Vi tri cho phep ghi (tuong doi goc du lieu) la CAU HINH (tool 'evolve'). Mac dinh suy tu vi tri du lieu evolve thuc.
// Cam tuong minh + realpath trong goc du lieu + ngoai plugin root luon thang.
const FALLBACK_LAYOUT = Object.freeze({ skillsDir: 'evolve/skills' });
const SAFE_DIR = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const okDir = (v) => typeof v === 'string' && SAFE_DIR.test(v.toLowerCase()) && !v.split('/').includes('..');
/** Goc du lieu cho policy: o.dataBase > dataDir(). */
export const dataBaseOf = (o = {}) => path.resolve(o.dataBase || dataDir());
function defaultLayout(o, base) {
  const sub = (abs, tail, fb) => {
    if (!abs) return fb;
    const r = toPosix(path.relative(base, path.resolve(abs)));
    return r && !r.startsWith('..') && !path.isAbsolute(r) && okDir(`${r}/${tail}`) ? `${r}/${tail}`.toLowerCase() : fb;
  };
  return { skillsDir: sub(o.dataRoot, 'skills', FALLBACK_LAYOUT.skillsDir) };
}
export function layoutOf(o = {}, root) {
  const def = defaultLayout(o, dataBaseOf(o));
  let raw = o.layout;
  if (!raw) { try { raw = loadConfig('evolve', { root, defaults: {} }).config; } catch { raw = null; } }
  const pick = (k) => (raw && okDir(raw[k]) ? raw[k].toLowerCase() : def[k]);
  const skillsDir = pick('skillsDir');
  const sib = (d, n) => d.replace(/[^/]+$/, n); // rules/inject nam canh skills trong goc evolve
  return { skillsDir, rulesDir: sib(skillsDir, 'rules'), injectDir: sib(skillsDir, 'inject') };
}
function buildAllow(layout) {
  return [
    [new RegExp('^' + esc(layout.skillsDir) + '/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._/-]*\\.md$'), ['skill']],
    [new RegExp('^' + esc(layout.rulesDir) + '/[a-z0-9][a-z0-9._-]*\\.json$'), ['rule']], // muc 1 (autopilot): file luat ledger
    [new RegExp('^' + esc(layout.injectDir) + '/[a-z0-9][a-z0-9._-]*\\.md$'), ['inject']], // muc 1: text inject
  ];
}
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

// Ten file luat mac dinh cua observe/ledger (chi doc ten thu muc, khong import observe).
function defaultLedgerNames() {
  try { return new Set(fs.readdirSync(path.join(REPO_DIR, 'harness', 'observe', 'ledger', 'defaults')).map((x) => x.toLowerCase())); } catch { return new Set(); }
}
const hubOf = (o) => path.resolve(o.hubRoot || workspaceRoot());
/** {ok, forbidden, reason, rel, abs}. Chuan hoa -> cam -> realpath trong goc du lieu (bat junction/symlink) -> cam theo vi tri that (du lieu/workspace/plugin root) -> allowlist. */
export function classifyTarget(target, kind, o = {}) {
  const n = normalizeTarget(target);
  if (n.error) return { ok: false, forbidden: false, reason: n.error };
  const forb = (key) => FORBIDDEN.find(([re]) => re.test(key));
  let f = forb(n.key);
  if (f) return { ok: false, forbidden: true, reason: `dich cam: ${f[1]} (${n.key})`, rel: n.rel };
  const baseReal = realpathDeep(dataBaseOf(o));
  if (!baseReal) return { ok: false, forbidden: false, reason: 'goc du lieu khong xac dinh', rel: n.rel };
  const abs = path.join(baseReal, ...n.rel.split('/'));
  const real = realpathDeep(abs);
  if (!real) return { ok: false, forbidden: false, reason: 'khong xac dinh duoc realpath', rel: n.rel };
  const realRel = relKey(baseReal, real);
  if (realRel == null) return { ok: false, forbidden: false, reason: `realpath ngoai goc du lieu (junction/symlink?): ${n.rel}`, rel: n.rel };
  if (!same(realRel, n.rel)) return { ok: false, forbidden: false, reason: `realpath lech dich (junction/symlink?): ${n.rel} -> ${realRel}`, rel: n.rel };
  // Goc du lieu co the bi tro (HUB_DATA_DIR) vao workspace/plugin: cam theo vi tri that so voi workspace va plugin root (chi phan du lieu cua plugin).
  const hubReal = realOrNull(hubOf(o));
  const hubRel = hubReal ? relKey(hubReal, real) : null;
  const repoReal = realOrNull(path.resolve(REPO_DIR));
  const repoRel = repoReal ? relKey(repoReal, real) : null;
  f = forb(realRel.toLowerCase()) || (hubRel != null ? forb(hubRel.toLowerCase()) : null) || (repoRel != null ? forb(repoRel.toLowerCase()) : null);
  if (f) return { ok: false, forbidden: true, reason: `dich cam: ${f[1]} (${realRel})`, rel: n.rel };
  if (repoRel != null && !/^(\.harness\/)?data\//i.test(repoRel)) return { ok: false, forbidden: true, reason: `dich cam: plugin root (${repoRel})`, rel: n.rel };
  const hit = buildAllow(layoutOf(o, hubOf(o))).find(([re]) => re.test(n.key));
  if (!hit) return { ok: false, forbidden: false, reason: `dich ngoai allowlist (deny-by-default): ${n.rel}`, rel: n.rel };
  if (!hit[1].includes(kind)) return { ok: false, forbidden: false, reason: `kind ${kind} khong duoc ghi vao ${n.rel}`, rel: n.rel };
  if (kind === 'rule' || kind === 'inject') {
    const base = n.key.split('/').pop();
    if (!base.startsWith('evolve-')) return { ok: false, forbidden: false, reason: `file ${kind} do evolve tao phai co tien to evolve- (${base})`, rel: n.rel };
    if (defaultLedgerNames().has(base)) return { ok: false, forbidden: false, reason: `trung ten file mac dinh cua ledger (${base})`, rel: n.rel };
  }
  return { ok: true, forbidden: false, reason: null, rel: n.rel, abs };
}

