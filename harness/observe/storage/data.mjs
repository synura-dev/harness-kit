// harness/data/data.mjs - domain `data`: ls [domain] | stat | clean [--yes] [--days N] | scan | adopt [--yes] [--legacy-harness] | inbox ls|rm|restore|prune | (prune/sizes: dung observe data-prune|sizes).
// Chi thao tac trong data/ (dataRoot()). clean/adopt mac dinh dry-run. Moi lenh ghi vet vao data/audit/date=D/type=data-access/data-cli.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../../core/config/config.mjs';
import { loadNodeHook, hookNodes as hookNodesCore } from '../../core/io/node-hook.mjs';
import { orphanWorkspaces } from './workspaces.mjs';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { parseCommon, emit } from '../../core/io/out.mjs';
import { dataRoot, workspaceRoot, workspaceMarker, isInside, samePath, isPluginMode, codeRoot } from '../../core/io/paths.mjs';
import { readJson, readJsonl, appendJsonl, dataPath, dataPathFor, today } from '../../core/io/storage.mjs';
import { REPO_ROOT_FILES } from '../../core/config/constants.mjs';
import { isStdRootFile } from './std-root.mjs';
import { ZONES, CLASSES, CLASS_DEFAULTS, SCAN_CACHE_REL, loadDataRegistry, classRetention, formatWarn, writeAtomic } from '../../core/registry/data-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LIMITS = { maxFiles: 20000, timeoutS: 20, autoMaxFiles: 500, autoMaxBytes: 200000000, tailMaxLines: 200, tailMaxBytes: 1048576, tailFieldMax: 300 };
const USAGE = 'usage: data ls [domain] | stat | clean [--yes] [--days N] | clean --auto [--yes] (chi log/cache qua han, tran 500 file/200MB/20s) | scan [--json] | query <ws|node> <tool> [--node X] [--last [N]] [--status S] [--since ISO] (doc runs.jsonl) | tree [...] | adopt [--yes] [--legacy-harness] | tail <domain> [--n N] [--type T] [--since 1d] | inbox ls [--limit N] | inbox rm <ngay>/<muc> [--yes] | inbox restore <ngay>/<muc> [--yes] | inbox prune [--days N] [--yes]  (--json --raw --timeout-s N)';

const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
/** Registry hop nhat do loader chung o core (registry.json + config/data/workspaces/*.json, mode Q5 qua HARNESS_DATA_ENFORCE). */
export const loadRegistry = (opts = {}) => loadDataRegistry({ registryFile: process.env.HARNESS_DATA_REGISTRY || undefined, workspacesDir: process.env.HARNESS_DATA_WORKSPACES || undefined, ...opts });

// Duyet de quy co gioi han. Tra {files:[{p,size,mtime}], dirs:[p], truncated}. Khong theo symlink.
export function walk(dir, { maxFiles = LIMITS.maxFiles, deadline = Date.now() + LIMITS.timeoutS * 1000, oldestFirst = false } = {}) {
  const files = [], dirs = [];
  let truncated = null;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
    if (files.length >= maxFiles) { truncated = `max-files ${maxFiles}`; break; }
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    // oldestFirst: ten tang dan (date=YYYY-MM-DD cu truoc); thu muc con day vao stack theo thu tu nguoc de pop ra nho nhat truoc -> cham file qua han truoc khi cat tran.
    if (oldestFirst) ents = ents.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subs = [];
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { dirs.push(p); subs.push(p); }
      else if (e.isFile()) { try { const s = fs.statSync(p); files.push({ p, size: s.size, mtime: s.mtimeMs }); } catch {} }
    }
    if (oldestFirst) subs.reverse();
    stack.push(...subs);
  }
  return { files, dirs, truncated };
}

export function top(root) { try { return fs.readdirSync(root, { withFileTypes: true }); } catch { return []; } }

/** Ten cap 1 da biet: duong dan vat ly (entry.path || key) + reserved. */
const knownTop = (reg) => new Set([...Object.entries(reg.entries).flatMap(([k, e]) => [phys(k, e), phys(k, e).split('/')[0]]), ...Object.values(reg.patterns || {}).map((p) => String(p.pattern || 'workspaces/*').split('/')[0]), ...reg.reserved]);

export function scan(root = dataRoot(), reg = loadRegistry()) {
  const known = knownTop(reg);
  const unknown = top(root).filter((e) => !known.has(e.name)).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  return { root, unknown, known: [...known] };
}

/** Nem Error khi registry khong doc duoc / rong bat thuong: clean/adopt/scan khong bao gio chay tren registry hong. */
export function regUsable(reg, what = 'data') {
  if (reg.failed) throw new Error(`${what} abort: registry khong doc duoc${reg.failedFiles?.length ? ' (' + reg.failedFiles.join(', ') + ')' : ''}; sua file roi chay lai`);
  if (!reg.entries || !Object.keys(reg.entries).length) throw new Error(`${what} abort: registry rong bat thuong`);
}

const rootOk = (n, extra = []) => n.startsWith('.') || REPO_ROOT_FILES.includes(n) || isStdRootFile(n) || extra.includes(n) || n.endsWith('.code-workspace');
const phys = (key, ent) => (ent && ent.path) || key;

/** Scan theo zone: unregistered, missing-field, over-caps, retention, stray (_inbox cu), clutter (docs/ + goc repo). Ghi cache. */
export function scanZones({ root = dataRoot(), reg = loadRegistry(), repoRoot = REPO_ROOT, now = Date.now(), opts = {}, write = true } = {}) {
  const warnings = []; const entries = {}; let files = 0; let truncated = false; let reason;
  const W = (rule, p, key, detail, fix) => warnings.push({ rule, path: p, key, detail, fix });
  // key dang cu (ten cap 1) hoac '<zone>/<domain>/<tool>' (W3 register): nhan ca ten cap 1 cua duong dan.
  const byPath = knownTop(reg);
  for (const u of top(root)) {
    if (!byPath.has(u.name) && !ZONES.includes(u.name) && !Object.hasOwn(reg.entries, u.name)) W('unregistered', u.name, u.name, 'muc la ngoai registry', `harness data adopt --yes`);
  }
  for (const [key, ent] of Object.entries(reg.entries)) {
    for (const f of ['zone', 'class', 'owner']) if (!ent[f]) W('missing-field', key, key, `thieu ${f}`, `them "${f}" cho muc ${key} trong registry`);
    if (ent.zone && !ZONES.includes(ent.zone)) W('missing-field', key, key, `zone sai: ${ent.zone}`, `zone thuoc ${ZONES.join('|')}`);
    if (ent.class && !CLASSES.includes(ent.class)) W('missing-field', key, key, `class sai: ${ent.class}`, `class thuoc ${CLASSES.join('|')}`);
    if (ent.zone === 'workspaces' && !ent.workspace) W('missing-field', key, key, 'thieu workspace', 'them "workspace" cho muc zone=workspaces');
    const p = phys(key, ent); const abs = path.join(root, p);
    if (ent.deprecatedPath) W('deprecated-path', p, key, 'path cu the khai bao trong manifest data[] (workspaces/<ws>/<tool> co dinh)', 'khai bao {zone:"workspaces", tool, class} (khong path) de dung mau workspaces/*/<tool>');
    if (!isInside(abs, root) || samePath(abs, root) || !fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    const w = st.isDirectory() ? walk(abs, opts) : { files: [{ p: abs, size: st.size, mtime: st.mtimeMs }], truncated: null };
    if (w.truncated) { truncated = true; reason = w.truncated; }
    const bytes = w.files.reduce((a, f) => a + f.size, 0);
    const depth = w.files.reduce((a, f) => Math.max(a, path.relative(abs, f.p).split(path.sep).length), 0);
    files += w.files.length;
    entries[key] = { zone: ent.zone, class: ent.class, files: w.files.length, bytes, depth };
    const cd = CLASS_DEFAULTS[ent.class] || {};
    const maxFiles = ent.caps?.maxFiles ?? cd.maxFiles; const maxDepth = ent.caps?.maxDepth ?? cd.maxDepth;
    if (maxFiles != null && w.files.length > maxFiles) W('over-caps', p, key, `${w.files.length}/${maxFiles} file`, 'harness data clean (dry-run) hoac nang caps.maxFiles');
    if (maxDepth != null && depth > maxDepth) W('over-caps', p, key, `do sau ${depth}/${maxDepth}`, 'gom thu muc hoac nang caps.maxDepth');
    const r = classRetention(ent);
    if (r != null) {
      const old = w.files.filter((f) => f.mtime < now - r * 86400000).length;
      if (old) W('retention', p, key, `${old} file qua ${r} ngay`, `harness data clean --days ${r} (dry-run, them --yes de xoa)`);
    }
  }
  if (Array.isArray(opts.nodes)) for (const ws of orphanWorkspaces(root, opts.nodes)) W('orphan-ws', `workspaces/${ws}`, `workspaces/${ws}`, 'workspace khong nut nao tro toi', 'xu ly thu cong (workspace khong con nut)');
  for (const d of top(inboxDir(root))) {
    if (d.isDirectory() && DATE_RE.test(d.name) && Date.parse(d.name + 'T00:00:00Z') < now - 30 * 86400000) W('stray', `_inbox/${d.name}`, '_inbox', '_inbox qua 30 ngay', 'harness data inbox prune --days 30 (dry-run)');
  }
  if (repoRoot) {
    const dw = walk(path.join(repoRoot, 'docs'), opts);
    for (const f of dw.files) if (!f.p.toLowerCase().endsWith('.md')) { const rel = path.relative(repoRoot, f.p).replace(/\\/g, '/'); W('clutter', rel, 'docs', 'file khong .md trong docs', 'chuyen vao scratchpad hoac zone dung'); }
    let extra = Array.isArray(opts.repoRootFiles) ? opts.repoRootFiles : null;
    if (!extra) { try { const c = loadConfig('workspace', { root: repoRoot }).config.repoRootFiles; extra = Array.isArray(c) ? c.filter((x) => typeof x === 'string') : []; } catch { extra = []; } }
    for (const e of top(repoRoot)) if (e.isFile() && !rootOk(e.name, extra)) W('clutter', e.name, 'repo-root', 'file la o goc repo', 'xoa hoac chuyen vao thu muc dung');
  }
  const res = { ts: new Date(now).toISOString(), truncated, ...(reason ? { reason } : {}), files, warnings, entries };
  if (write) { try { writeAtomic(path.join(root, SCAN_CACHE_REL), JSON.stringify(res, null, 1)); } catch {} }
  return res;
}

export function stat(root = dataRoot(), reg = loadRegistry(), opts = {}) {
  const rows = []; let truncated = null;
  for (const e of top(root)) {
    const w = e.isDirectory() ? walk(path.join(root, e.name), opts) : { files: (() => { try { const s = fs.statSync(path.join(root, e.name)); return [{ size: s.size }]; } catch { return []; } })(), truncated: null };
    if (w.truncated) truncated = w.truncated;
    rows.push({ name: e.name, files: w.files.length, bytes: w.files.reduce((a, f) => a + f.size, 0), registered: knownTop(reg).has(e.name) });
  }
  return { rows, truncated };
}

/** Xoa file cu hon retention (mtime) cua muc dang ky; chi trong root. days ghi de moi retention (chi voi muc co retention). */
export function clean({ root = dataRoot(), reg = loadRegistry(), yes = false, days = null, now = Date.now(), opts = {} } = {}) {
  regUsable(reg, 'clean');
  const res = { dryRun: !yes, removed: [], bytes: 0, truncated: null };
  for (const [name, ent] of Object.entries(reg.entries)) {
    const cr = classRetention(ent);
    const d = days != null ? (cr == null ? null : days) : cr;
    if (d == null) continue;
    const dir = path.join(root, phys(name, ent));
    if (!isInside(dir, root) || samePath(dir, root) || !fs.existsSync(dir)) continue;
    const w = walk(dir, opts);
    if (w.truncated) res.truncated = w.truncated;
    const cut = now - d * 86400000;
    for (const f of w.files) {
      if (f.mtime >= cut || !isInside(f.p, root)) continue;
      if (yes) { try { fs.rmSync(f.p, { force: true }); } catch { continue; } }
      res.removed.push(path.relative(root, f.p)); res.bytes += f.size;
    }
    if (yes) for (const sub of w.dirs.sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(sub); } catch {} } // chi xoa thu muc rong
  }
  return res;
}

const NO_AUTO_ZONES = ['knowledge', 'external', 'workspaces'];
/** Han tu xoa cua muc cho don tu dong: retentionDays khai bao ro (so > 0) luon duoc dung; han suy tu class chi cho muc zone system. knowledge/external/workspaces (theo zone hoac thu muc cap 1) khong khai bao ro -> null (khong bao gio bi dung). */
export function autoRetention(name, ent) {
  if (Number.isFinite(ent.retentionDays) && ent.retentionDays > 0) return ent.retentionDays;
  if (ent.zone !== 'system' || NO_AUTO_ZONES.includes(String(phys(name, ent)).replace(/\\/g, '/').split('/')[0])) return null;
  const d = classRetention(ent);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/** Don tu dong: chi class log/cache, file qua han, bo qua hom nay (gio dia phuong) va audit ngay hien tai; tran file/bytes/giay; khong di theo symlink. */
export function cleanAuto({ root = dataRoot(), reg = loadRegistry(), yes = false, now = Date.now(), maxFiles = LIMITS.autoMaxFiles, maxBytes = LIMITS.autoMaxBytes, timeoutS = LIMITS.timeoutS, walkMax = LIMITS.maxFiles } = {}) {
  regUsable(reg, 'clean');
  const res = { auto: true, dryRun: !yes, files: 0, bytes: 0, byEntry: {}, truncated: null, more: false }; // more = cham tran CUA LUOT NAY (max-files/max-bytes) khi con viec
  const deadline = Date.now() + timeoutS * 1000;
  const d0 = new Date(now); const midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
  const dateTag = `date=${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  let realRoot; try { realRoot = fs.realpathSync(root); } catch { return res; }
  outer: for (const [name, ent] of Object.entries(reg.entries)) {
    if (ent.class !== 'log' && ent.class !== 'cache') continue;
    const d = autoRetention(name, ent); if (d == null) continue;
    const dir = path.join(root, phys(name, ent));
    if (!isInside(dir, root) || samePath(dir, root)) continue;
    let ls; try { ls = fs.lstatSync(dir); } catch { continue; }
    if (ls.isSymbolicLink() || !ls.isDirectory()) continue;
    try { if (!isInside(fs.realpathSync(dir), realRoot)) continue; } catch { continue; }
    const w = walk(dir, { deadline, maxFiles: walkMax, oldestFirst: true });
    if (w.truncated) res.truncated = w.truncated;
    const cut = Math.min(now - d * 86400000, midnight);
    w.files.sort((a, b) => a.mtime - b.mtime); // cu nhat truoc
    for (const f of w.files) {
      if (f.mtime >= cut || !isInside(f.p, root)) continue;
      const rel = path.relative(root, f.p).split(path.sep);
      if (rel.includes(dateTag) || rel.some((x) => x === '.state' || x === '_inbox')) continue;
      if (res.files >= maxFiles) { res.truncated = `max-files ${maxFiles}`; res.more = true; break outer; }
      if (f.size > maxBytes) continue; // file don le vuot tran byte: bo qua file do, khong chan cac muc sau
      if (res.bytes + f.size > maxBytes) { res.truncated = `max-bytes ${maxBytes}`; res.more = true; break outer; }
      if (Date.now() > deadline) { res.truncated = 'timeout'; break outer; }
      try { if (fs.lstatSync(f.p).isSymbolicLink()) continue; if (yes) fs.unlinkSync(f.p); } catch { continue; }
      res.files++; res.bytes += f.size; res.byEntry[name] = (res.byEntry[name] || 0) + 1;
    }
    if (yes) for (const sub of w.dirs.sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(sub); } catch {} }
  }
  return res;
}

/** Chuyen muc la vao data/_inbox/<date>/ (khong xoa). */
export function adopt({ root = dataRoot(), reg = loadRegistry(), yes = false } = {}) {
  regUsable(reg, 'adopt');
  const { unknown } = scan(root, reg);
  const dest = path.join(root, '_inbox', today());
  const moved = [];
  for (const u of unknown) {
    const to = path.join(dest, u.name);
    if (yes) { try { fs.mkdirSync(dest, { recursive: true }); if (fs.existsSync(to)) continue; fs.renameSync(path.join(root, u.name), to); } catch { continue; } }
    moved.push(u.name);
  }
  return { dryRun: !yes, dest, moved };
}


/** Gom du lieu lac <ws>/.harness/data vao dataRoot (chi khi workspace co dau hieu). jsonl: noi dong chua co; file khac: chuyen neu dich chua co, neu co -> _inbox/<ngay>/legacy-harness/. Dry-run mac dinh. */
export function adoptLegacyHarness({ ws = workspaceRoot(), root = dataRoot(), yes = false, maxFiles = LIMITS.maxFiles, timeoutS = LIMITS.timeoutS, now = new Date() } = {}) {
  const res = { dryRun: !yes, applicable: !!workspaceMarker(ws), appended: [], moved: [], inbox: [], removed: false, truncated: null };
  const src = path.join(ws, '.harness', 'data');
  if (!res.applicable || !fs.existsSync(src)) return res;
  const w = walk(src, { maxFiles, deadline: Date.now() + timeoutS * 1000 });
  res.truncated = w.truncated || null;
  const inbox = path.join(root, '_inbox', today(now), 'legacy-harness');
  const deadline = Date.now() + timeoutS * 1000;
  for (const f of w.files) {
    if (Date.now() > deadline) { res.truncated = 'timeout'; break; }
    const rel = path.relative(src, f.p); const to = path.join(root, rel); const relP = rel.replace(/\\/g, '/');
    try {
      if (rel.endsWith('.jsonl')) {
        const have = new Set(fs.existsSync(to) ? fs.readFileSync(to, 'utf8').split(/\r?\n/) : []);
        const add = []; for (const l of fs.readFileSync(f.p, 'utf8').split(/\r?\n/)) if (l.trim() && !have.has(l)) { have.add(l); add.push(l); }
        res.appended.push({ file: relP, lines: add.length });
        if (yes) { if (add.length) { fs.mkdirSync(path.dirname(to), { recursive: true }); const cur = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : ''; fs.appendFileSync(to, (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n'); } fs.unlinkSync(f.p); }
      } else if (!fs.existsSync(to)) {
        res.moved.push(relP);
        if (yes) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(f.p, to); }
      } else {
        res.inbox.push(relP);
        if (yes) { const d = path.join(inbox, rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.renameSync(f.p, d); }
      }
    } catch { /* bo qua file loi, giu nguyen nguon */ }
  }
  if (yes && !res.truncated) {
    // Xoa .harness neu chi con thu muc rong + .gitignore
    const left = []; const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else left.push(p); } };
    const hd = path.join(ws, '.harness');
    try { rec(hd); if (left.every((p) => path.relative(hd, p) === '.gitignore')) { fs.rmSync(hd, { recursive: true, force: true }); res.removed = true; } } catch { /* giu lai */ }
  }
  return res;
}

// ---- inbox: quan ly _inbox/<YYYY-MM-DD>/<muc> ----
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ITEM = /^[A-Za-z0-9_][A-Za-z0-9_.=-]{0,95}$/;
const inboxDir = (root) => path.join(root, '_inbox');

/** Phan giai '<ngay>/<muc>' -> {date,item,abs}; nem Error neu rong, '..', tuyet doi, chinh _inbox, hoac thoat _inbox. */
export function inboxTarget(spec, root = dataRoot()) {
  const s = String(spec ?? '').trim().replace(/\\/g, '/');
  if (!s) throw new Error('thieu <ngay>/<muc>');
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.startsWith('/')) throw new Error('khong nhan duong dan tuyet doi');
  const parts = s.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) throw new Error("khong nhan '..'");
  if (parts.length !== 2 || parts[0] === '_inbox') throw new Error('dung dang <ngay>/<muc> (khong phai chinh _inbox)');
  const [date, item] = parts;
  if (!DATE_RE.test(date)) throw new Error('ngay phai dang YYYY-MM-DD');
  if (!SAFE_ITEM.test(item)) throw new Error('ten muc khong hop le');
  const abs = path.join(inboxDir(root), date, item);
  if (!isInside(abs, inboxDir(root)) || samePath(abs, inboxDir(root))) throw new Error('thoat khoi _inbox');
  return { date, item, abs };
}

const sizeOf = (p, opts) => { let st; try { st = fs.lstatSync(p); } catch { return { files: 0, bytes: 0, truncated: null }; } if (!st.isDirectory()) return { files: 1, bytes: st.size, truncated: null }; const w = walk(p, opts); return { files: w.files.length, bytes: w.files.reduce((a, f) => a + f.size, 0), truncated: w.truncated }; };

export function inboxLs({ root = dataRoot(), limit = 200, opts = {} } = {}) {
  const rows = []; let truncated = null;
  for (const d of top(inboxDir(root))) {
    if (!d.isDirectory()) continue;
    for (const e of top(path.join(inboxDir(root), d.name))) {
      if (rows.length >= limit) { truncated = `limit ${limit}`; break; }
      const sz = sizeOf(path.join(inboxDir(root), d.name, e.name), opts);
      if (sz.truncated) truncated = sz.truncated;
      rows.push({ date: d.name, item: e.name, dir: e.isDirectory(), files: sz.files, bytes: sz.bytes });
    }
  }
  return { rows, truncated };
}

/** Xoa 1 muc trong _inbox (API fs, khong shell). Dry-run mac dinh. */
export function inboxRm({ root = dataRoot(), spec, yes = false, opts = {} } = {}) {
  const t = inboxTarget(spec, root);
  if (!fs.existsSync(t.abs)) throw new Error(`khong co: ${t.date}/${t.item}`);
  const sz = sizeOf(t.abs, opts);
  if (yes) {
    fs.rmSync(t.abs, { recursive: true, force: true });
    try { fs.rmdirSync(path.dirname(t.abs)); } catch {} // don thu muc ngay neu rong
  }
  return { dryRun: !yes, target: `${t.date}/${t.item}`, files: sz.files, bytes: sz.bytes };
}

/** Chuyen <ngay>/<muc> ve goc dataDir (cung cap voi _inbox); khong ghi de. */
export function inboxRestore({ root = dataRoot(), spec, yes = false } = {}) {
  const t = inboxTarget(spec, root);
  if (!fs.existsSync(t.abs)) throw new Error(`khong co: ${t.date}/${t.item}`);
  const to = path.join(root, t.item);
  if (!isInside(to, root) || samePath(to, root)) throw new Error('dich khong hop le');
  if (fs.existsSync(to)) throw new Error(`da ton tai ${t.item}, khong ghi de`);
  if (yes) { fs.renameSync(t.abs, to); try { fs.rmdirSync(path.dirname(t.abs)); } catch {} }
  return { dryRun: !yes, from: `${t.date}/${t.item}`, to: t.item };
}

/** Xoa muc _inbox co thu muc ngay cu hon N ngay (1..3650, mac dinh 30). */
export function inboxPrune({ root = dataRoot(), days = 30, yes = false, now = Date.now(), opts = {} } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('--days phai 1..3650');
  const cut = now - days * 86400000;
  const removed = []; let bytes = 0;
  for (const d of top(inboxDir(root))) {
    if (!d.isDirectory() || !DATE_RE.test(d.name) || Date.parse(d.name + 'T00:00:00Z') >= cut) continue;
    for (const e of top(path.join(inboxDir(root), d.name))) {
      if (!SAFE_ITEM.test(e.name)) continue;
      const r = inboxRm({ root, spec: `${d.name}/${e.name}`, yes, opts });
      removed.push(r.target); bytes += r.bytes;
    }
  }
  return { dryRun: !yes, days, removed, bytes };
}

const SINCE_RE = /^(\d+)([dhm])$/;
const cutField = (v, max) => (typeof v === 'string' && v.length > max ? v.slice(0, max) + `...(+${v.length - max})` : v);

/** Doc N dong cuoi tu .jsonl moi nhat cua domain da dang ky (domain chi lay tu registry). */
export function tailDomain({ root = dataRoot(), reg = loadRegistry(), domain, n = 20, type = null, since = null, now = Date.now(), opts = {} } = {}) {
  regUsable(reg, 'tail');
  const dom = String(domain ?? '');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(dom)) throw new Error('domain khong hop le');
  const cnt = Math.min(Math.max(Math.floor(Number(n)) || 20, 1), LIMITS.tailMaxLines);
  let cut = 0;
  if (since) { const m = SINCE_RE.exec(since); if (!m) throw new Error('--since dang 1d|12h|30m'); cut = now - Number(m[1]) * { d: 86400000, h: 3600000, m: 60000 }[m[2]]; }
  const dirs = [];
  for (const [k, e] of Object.entries(reg.entries)) {
    const p = phys(k, e).replace(/\\/g, '/').replace(/\/+$/, '');
    if (k === dom || k.split('/').pop() === dom || p === dom || p.split('/').pop() === dom || e.tool === dom) { dirs.push(path.join(root, p)); }
  }
  for (const [k, e] of Object.entries(reg.entries)) { // alias tuong minh: entry.tailPaths[alias] = thu muc con (vd audit -> gateway)
    const sub = e.tailPaths && Object.prototype.hasOwnProperty.call(e.tailPaths, dom) ? String(e.tailPaths[dom]) : null;
    if (sub && !/(^|[\\/])\.\.([\\/]|$)/.test(sub) && !path.isAbsolute(sub)) { dirs.push(path.join(root, phys(k, e), sub)); }
  }
  if (!dirs.length) throw new Error(`domain chua dang ky: ${dom}`);
  const deadline = opts.deadline ?? Date.now() + LIMITS.timeoutS * 1000;
  let files = []; let truncated = null;
  for (const d of dirs) {
    if (!isInside(d, root) || samePath(d, root) || !fs.existsSync(d)) continue;
    const w = walk(d, { ...opts, deadline });
    if (w.truncated) truncated = w.truncated;
    files.push(...w.files.filter((x) => x.p.endsWith('.jsonl') && x.mtime >= cut));
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let rows = [];
  for (const f of files) {
    if (rows.length >= cnt) break;
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
    let r = readJsonl(f.p, { limit: cnt, maxBytes: LIMITS.tailMaxBytes });
    if (type) r = r.filter((x) => x && (x.type === type || f.p.split(path.sep).includes(`type=${type}`)));
    if (cut) r = r.filter((x) => !x || !x.ts || Date.parse(x.ts) >= cut || Number.isNaN(Date.parse(x.ts)));
    rows = [...r, ...rows];
  }
  // gop 2 goc (moi + legacy): sap xep on dinh theo ts neu co (dong khong ts giu vi tri)
  if (dirs.length > 1) { const tv = (x) => (x && x.ts ? Date.parse(x.ts) : NaN); const idx = rows.map((x, i) => [x, i]); idx.sort((a, b) => { const ta = tv(a[0]); const tb = tv(b[0]); return Number.isNaN(ta) || Number.isNaN(tb) ? a[1] - b[1] : ta - tb || a[1] - b[1]; }); rows = idx.map((x) => x[0]); }
  rows = rows.slice(-cnt).map((x) => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'string' ? cutField(v, LIMITS.tailFieldMax) : v])) : x));
  return { domain: dom, files: files.length, rows, truncated };
}

const fmtB = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n > 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

function logAccess(cmd, args, extra = {}) {
  appendJsonl(dataPathFor('audit', `date=${today()}`, 'type=data-access', 'data-cli.jsonl'), { ts: new Date().toISOString(), cmd, args: args.filter((a) => /^--?[a-z-]+$|^\d+$/.test(a)), ...extra });
}

/** Nut tu hook (null khi khong co hook / hook thieu listNodes): dung cho orphan-ws va archive. Goc workspace luon duoc truyen (hookNodes trong node-hook). */
function hookNodes() { return hookNodesCore({ root: workspaceRoot() }); }

export async function run(argv = process.argv.slice(2)) {
  const o = parseCommon(argv);
  const [cmd, ...r] = o.rest;
  const yes = r.includes('--yes');
  const di = r.indexOf('--days');
  const days = di >= 0 && Number(r[di + 1]) >= 0 ? Number(r[di + 1]) : null;
  const opts = { deadline: Date.now() + (o.timeoutS || LIMITS.timeoutS) * 1000 };
  const root = dataRoot();
  const reg = loadRegistry();
  try {
    if (cmd === 'ls') {
      const dom = r.find((x) => !x.startsWith('--'));
      if (dom) {
        const dir = dataPath(dom, null);
        const w = walk(dir, opts);
        const lines = w.files.slice(0, 100).map((f) => `${fmtB(f.size).padStart(8)} ${path.relative(dir, f.p).replace(/\\/g, '/')}`);
        logAccess('ls', r, { domain: dom });
        return { code: 0, ...emit({ summary: `${dom}: ${w.files.length} file\n${lines.join('\n')}`, data: { domain: dom, files: w.files.length }, truncated: w.truncated || (w.files.length > 100 ? 'limit 100' : null), raw: JSON.stringify(w.files) }, o) };
      }
      const s = stat(root, reg, opts);
      logAccess('ls', r);
      return { code: 0, ...emit({ summary: s.rows.map((x) => `${x.name.padEnd(20)} ${String(x.files).padStart(6)} file ${fmtB(x.bytes).padStart(8)}${x.registered ? '' : '  [la]'}`).join('\n'), data: s, truncated: s.truncated }, o) };
    }
    if (cmd === 'stat') {
      const s = stat(root, reg, opts);
      logAccess('stat', r);
      const tot = s.rows.reduce((a, x) => a + x.bytes, 0);
      const nFiles = s.rows.reduce((a, x) => a + x.files, 0); const outside = s.rows.filter((x) => !x.registered).length;
      return { code: 0, ...emit({ summary: `${s.rows.length} muc, ${nFiles} file, ${fmtB(tot)}; ngoai registry: ${outside}`, data: { items: s.rows, files: nFiles, bytes: tot, outside_registry: outside, truncated: s.truncated }, truncated: s.truncated }, o) };
    }
    if (cmd === 'scan' || cmd === 'clean' || cmd === 'adopt') regUsable(reg, cmd);
    if (cmd === 'scan') {
      const s = scanZones({ root, reg, opts: { ...opts, nodes: hookNodes() } });
      logAccess('scan', r, { warnings: s.warnings.length });
      const summary = s.warnings.length ? s.warnings.map(formatWarn).join('\n') : `khong vi pham (${s.files} file)`;
      return { code: s.warnings.some((w) => w.rule !== 'deprecated-path') ? 1 : 0, ...emit({ summary, data: s, truncated: s.truncated ? (s.reason || 'timeout') : null }, o) };
    }
    if (cmd === 'tree') {
      let mod = null;
      try { mod = await import(new URL('./tree.mjs', import.meta.url)); } catch {}
      const fn = mod && mod.treeCmd;
      if (!fn) { console.error(`data ${cmd}: chua cai`); return { code: 1 }; }
      // Provider/owner roots tu config workspace (projectResolver: module export resolveProject; ownerRoots). Thieu -> bo qua.
      let hc = {}; try { hc = loadConfig('workspace', { root: workspaceRoot() }).config || {}; } catch {}
      let resolveProject, resolverFailed = false;
      {
        // Ma thuc thi: goc tin cay = goc workspace (ca plugin mode), khong '..'/tuyet doi ra ngoai, chi nap khi ext chua resolver da duyet hash (core/io/node-hook.mjs).
        // register --project can resolver du khi HUB_DATA_DIR dat (hook ghi du lieu thi bo qua, o day khong).
        const nh = loadNodeHook({ env: { ...process.env, HUB_DATA_DIR: '' }, root: workspaceRoot() });
        if (nh.source === 'error') resolverFailed = true;
        else if (nh.mod && typeof nh.mod.resolveProject === 'function') resolveProject = (id) => { const { project } = nh.mod.resolveProject(id); return project && project.path ? { path: project.path } : null; };
      }
      const out = await fn(r.filter((x) => x !== '--json'), { root, reg, o, hubRoot: workspaceRoot(), dataDir: root, resolverFailed, resolveProject, ownerRoots: hc.ownerRoots, registryFile: process.env.HARNESS_DATA_REGISTRY || undefined, wsDir: process.env.HARNESS_DATA_WORKSPACES || undefined });
      for (const l of out.lines || []) console.log(l);
      return { code: out.code ?? 0 };
    }
    if (cmd === 'clean' && r.includes('--auto')) {
      const ai = (n, dflt) => { const i = r.indexOf(n); return i >= 0 && Number(r[i + 1]) > 0 ? Number(r[i + 1]) : dflt; };
      let c; let err = null;
      try { c = cleanAuto({ root, reg, yes, maxFiles: ai('--max-files', LIMITS.autoMaxFiles), maxBytes: o.maxBytes || LIMITS.autoMaxBytes, timeoutS: o.timeoutS || LIMITS.timeoutS }); } catch (e) { err = e; }
      if (yes) { try {
        const sf = path.join(root, '.state', 'data-check-clean.json'); let prev = {}; try { prev = JSON.parse(fs.readFileSync(sf, 'utf8')) || {}; } catch {}
        const more = !err && c?.more && c.files > 0; // chi giu lastRun cu khi luot nay THUC SU xoa duoc va cham tran cua chinh no (phien sau lam tiep, khoa 5 phut chan lap); luot khong xoa gi thi tien
        writeAtomic(sf, JSON.stringify({ lastRun: more ? (Number(prev.lastRun) || 0) : Date.now(), done: !err, ts: new Date().toISOString(), files: c?.files ?? 0, bytes: c?.bytes ?? 0, truncated: c?.truncated ?? null, error: err ? err.message : null, seen: false }));
      } catch {} }
      if (err) throw err;
      logAccess('clean', r, { auto: true, files: c.files, bytes: c.bytes, byEntry: c.byEntry, truncated: c.truncated, yes });
      return { code: 0, ...emit({ summary: `${c.dryRun ? 'dry-run auto: se xoa' : 'auto da xoa'} ${c.files} file (${fmtB(c.bytes)})${c.dryRun ? ' - them --yes de xoa' : ''}${Object.keys(c.byEntry).length ? '\n' + Object.entries(c.byEntry).map(([k, v]) => `${k}: ${v}`).join('\n') : ''}`, data: c, truncated: c.truncated }, o) };
    }
    if (cmd === 'clean') {
      const c = clean({ root, reg, yes, days, opts });
      logAccess('clean', r, { removed: c.removed.length, yes });
      return { code: 0, ...emit({ summary: `${c.dryRun ? 'dry-run: se xoa' : 'da xoa'} ${c.removed.length} file (${fmtB(c.bytes)})${c.dryRun ? ' - them --yes de xoa' : ''}\n${c.removed.slice(0, 20).join('\n')}`, data: c, truncated: c.truncated }, o) };
    }
    if (cmd === 'adopt' && r.includes('--legacy-harness')) {
      const a = adoptLegacyHarness({ yes, timeoutS: o.timeoutS || LIMITS.timeoutS });
      logAccess('adopt', r, { legacyHarness: true, appended: a.appended.length, moved: a.moved.length, inbox: a.inbox.length, yes });
      if (!a.applicable) return { code: 1, ...emit({ summary: 'adopt --legacy-harness: workspace khong co dau hieu (config/workspace|hub/default.json), khong lam gi', data: a }, o) };
      return { code: 0, ...emit({ summary: `${a.dryRun ? 'dry-run: se gom' : 'da gom'} .harness/data: noi ${a.appended.length} jsonl, chuyen ${a.moved.length}, vao _inbox ${a.inbox.length}${a.removed ? ', da xoa .harness' : ''}${a.dryRun ? ' (them --yes)' : ''}`, data: a, truncated: a.truncated }, o) };
    }
    if (cmd === 'adopt') {
      const a = adopt({ root, reg, yes });
      logAccess('adopt', r, { moved: a.moved.length, yes });
      return { code: 0, ...emit({ summary: `${a.dryRun ? 'dry-run: se chuyen' : 'da chuyen'} ${a.moved.length} muc -> ${path.relative(root, a.dest)}${a.dryRun ? ' (them --yes)' : ''}\n${a.moved.join('\n')}`, data: a }, o) };
    }
    if (cmd === 'tail') {
      const flag = (name) => { const i = r.indexOf(name); return i >= 0 ? r[i + 1] : null; };
      const dom = r.find((x, i) => !x.startsWith('--') && !/^--(n|type|since)$/.test(r[i - 1] || ''));
      const t = tailDomain({ root, reg, domain: dom, n: flag('--n') ?? 20, type: flag('--type'), since: flag('--since'), opts });
      logAccess('tail', r, { domain: dom, rows: t.rows.length });
      return { code: 0, ...emit({ summary: t.rows.map((x) => JSON.stringify(x)).join('\n') || '(khong co dong)', data: t, truncated: t.truncated }, o) };
    }
    if (cmd === 'query') { const { queryCli } = await import('./data-query.mjs'); return queryCli(r, { o, root, opts, logAccess }); } // data-workspaces P1b: runs.jsonl
    if (cmd === 'inbox') {
      const [sub, ...ir] = r;
      const arg = ir.find((x, i) => !x.startsWith('--') && !/^--(days|limit)$/.test(ir[i - 1] || ''));
      const li = r.indexOf('--limit');
      const limit = li >= 0 && Number(r[li + 1]) > 0 ? Math.floor(Number(r[li + 1])) : 200;
      if (sub === 'ls') {
        const l = inboxLs({ root, limit, opts });
        logAccess('inbox ls', r, { rows: l.rows.length });
        return { code: 0, ...emit({ summary: l.rows.length ? l.rows.map((x) => `${x.date}/${x.item}`.padEnd(40) + ` ${String(x.files).padStart(6)} file ${fmtB(x.bytes).padStart(8)}`).join('\n') : '_inbox trong', data: l, truncated: l.truncated }, o) };
      }
      if (sub === 'rm') {
        const x = inboxRm({ root, spec: arg, yes, opts });
        logAccess('inbox rm', r, { target: x.target, files: x.files, yes });
        return { code: 0, ...emit({ summary: `${x.dryRun ? 'dry-run: se xoa' : 'da xoa'} _inbox/${x.target} (${x.files} file, ${fmtB(x.bytes)})${x.dryRun ? ' - them --yes' : ''}`, data: x }, o) };
      }
      if (sub === 'restore') {
        const x = inboxRestore({ root, spec: arg, yes });
        logAccess('inbox restore', r, { target: x.from, yes });
        return { code: 0, ...emit({ summary: `${x.dryRun ? 'dry-run: se chuyen' : 'da chuyen'} _inbox/${x.from} -> ${x.to}${x.dryRun ? ' - them --yes' : ''}`, data: x }, o) };
      }
      if (sub === 'prune') {
        const dd = r.indexOf('--days');
        const x = inboxPrune({ root, days: dd >= 0 ? Number(r[dd + 1]) : 30, yes, opts });
        logAccess('inbox prune', r, { removed: x.removed.length, yes });
        return { code: 0, ...emit({ summary: `${x.dryRun ? 'dry-run: se xoa' : 'da xoa'} ${x.removed.length} muc cu hon ${x.days} ngay (${fmtB(x.bytes)})${x.dryRun ? ' - them --yes' : ''}\n${x.removed.join('\n')}`, data: x }, o) };
      }
    }
    if (cmd === 'prune' || cmd === 'sizes') { console.error(`data ${cmd} da chuyen: dung \`harness observe ${cmd === 'prune' ? 'data-prune' : 'sizes'}\``); return { code: 2 }; }
  } catch (e) { console.error(`data ${cmd}: ${e.message}`); return { code: /abort:/.test(e.message) ? 2 : 1 }; }
  console.error(USAGE);
  return { code: 2 };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) run().then((r) => process.exit(r.code));
