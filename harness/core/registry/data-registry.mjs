// Hop dong data-registry (W0): hang + chu ky + shape. Logic do W1 cai.
// Dat o core/registry/ vi core/io da vuot flatMax=8. Chi import core (fs).

import fs from 'node:fs';
import path from 'node:path';
import { dataRoot, workspaceRoot, isPluginMode, REPO_DIR, isInside } from '../io/paths.mjs';
import { loadConfig } from '../config/config.mjs';
import { workspaceFor, isSafeWs } from '../io/node-hook.mjs';

/** Cac vung cap 1 cua data/. */
export const ZONES = Object.freeze(['system', 'knowledge', 'workspaces', 'external', '_inbox']);

/** Loai du lieu: quyet dinh retention + caps mac dinh. */
export const CLASSES = Object.freeze(['log', 'cache', 'artifact', 'durable']);

/** Mac dinh theo class. retentionDays null = khong tu xoa. */
export const CLASS_DEFAULTS = Object.freeze({
  log: Object.freeze({ retentionDays: 30, maxFiles: 5000, maxDepth: 4 }),
  cache: Object.freeze({ retentionDays: 7, maxFiles: 2000, maxDepth: 3 }),
  artifact: Object.freeze({ retentionDays: null, maxFiles: 2000, maxDepth: 5 }),
  durable: Object.freeze({ retentionDays: null, maxFiles: 5000, maxDepth: 6 }),
});

/** Che do thuc thi (Q5: mac dinh warn). */
const ENFORCE_MODES = Object.freeze(['off', 'warn', 'enforce']);
export const DEFAULT_ENFORCE = 'warn';
/** Duong dan mac dinh khai bao khi registry thieu entry/path (khong roi ve key goc cu). */
// Khoa loi luon dung (hook/evolve) co duong mac dinh: du an sach khong can dang ky, khong canh bao no-path moi hook.
const DEFAULT_PATHS = Object.freeze({ audit: 'system/audit', evolve: 'evolve' });
const warnedNoPath = new Set();

/** Cac rule canh bao. */
const WARN_RULES = Object.freeze(['unregistered', 'missing-field', 'over-caps', 'retention', 'stray', 'clutter', 'legacy-read', 'duplicate', 'deprecated-config', 'deprecated-path', 'orphan-ws']);

/** Duong cache scan (tuong doi dataDir). */
export const SCAN_CACHE_REL = '.state/data-scan.json';

/**
 * @typedef {Object} DataEntry  Muc registry
 * @property {string} [zone] one of ZONES
 * @property {string} [class] one of CLASSES
 * @property {string} [workspace] id workspace (zone=workspaces)
 * @property {string} [tool] ten tool ghi
 * @property {string} [owner] thu muc/script so huu
 * @property {{maxFiles?:number,maxDepth?:number}} [caps]
 * @property {string} [path] vi tri vat ly (mac dinh = key)
 * @property {string} [legacy] vi tri cu (doc fallback + canh bao)
 * @property {string[]} [releaseProjects] id du an release (config/release/projects) ghi vet vao entry nay (tool=release); khop truoc `project`
 * @property {string} [target] dich GD2 (thong tin)
 * @property {number|null} [retentionDays] override retention class
 * @property {string} [note]
 *
 * @typedef {Object} DataRegistry
 * @property {'off'|'warn'|'enforce'} enforce
 * @property {Record<string, DataEntry>} entries
 * @property {string[]} reserved
 *
 * @typedef {Object} DataWarn
 * @property {string} rule one of WARN_RULES
 * @property {string} path duong dan tuong doi dataDir
 * @property {string} key
 * @property {string} detail
 * @property {string} fix
 *
 * @typedef {Object} DataScanResult  Ket qua `data scan --json` (= noi dung cache SCAN_CACHE_REL)
 * @property {string} ts ISO
 * @property {boolean} truncated
 * @property {string} [reason] vd 'timeout'
 * @property {number} files
 * @property {DataWarn[]} warnings
 * @property {Record<string,{zone?:string,class?:string,files:number,bytes:number,depth:number}>} entries
 */

const toPosix = (x) => String(x).replace(/\\/g, '/');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Tra cuu CHI own property (ten thu muc constructor/toString/__proto__ khong duoc coi la da dang ky). */
const own = (o, k) => (o && typeof k === 'string' && Object.hasOwn(o, k) ? o[k] : undefined);
/** legacy rel an toan (nhu ctx legacyOf): khong tuyet doi, khong '.'/'..'/o dia. -> 'a/b' | null */
const safeLegacy = (l) => {
  if (typeof l !== 'string' || !l || path.isAbsolute(l) || /^[A-Za-z]:/.test(l)) return null;
  const s = toPosix(l).split('/').filter(Boolean);
  return s.length && !s.some((x) => x === '.' || x === '..') ? s.join('/') : null;
};
/** Doc JSON (bo BOM); loi -> null. Dung chung cho loader va register. */
export const readJ = (file) => { try { const t = fs.readFileSync(file, 'utf8'); return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); } catch { return null; } };
/** Ghi nguyen tu: tmp cung thu muc roi rename. */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const cache = new Map();
const regWarned = new Set();
/** Dau van tay thu muc workspace (cache key): them/bo thu muc ws, tool moi => registry dan xuat doi. */
function wsStamp(dir) {
  const top = path.join(dir, 'workspaces');
  let names = []; try { names = fs.readdirSync(top).sort().slice(0, 100); } catch { return '-'; }
  return mtimeOf(top) + ':' + names.map((n) => mtimeOf(path.join(top, n))).join(',');
}
const MAX_DERIVE_WS = 200;
/** Entry cu the cho thu muc workspaces/<ws>/<tool> dang co, theo mau khai bao trong manifest (reg.patterns). Khong ghi de entry da co. */
function deriveWorkspaceEntries(reg, dir) {
  const top = path.join(dir, 'workspaces');
  let wss = []; try { wss = fs.readdirSync(top, { withFileTypes: true }).filter((d) => d.isDirectory() && isSafeWs(d.name)).map((d) => d.name).sort().slice(0, MAX_DERIVE_WS); } catch { return; }
  for (const ws of wss) {
    let tools = []; try { tools = fs.readdirSync(path.join(top, ws), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).slice(0, 100); } catch { continue; }
    for (const t of tools) {
      const p = own(reg.patterns, t); const key = `workspaces/${ws}/${t}`;
      if (!p || own(reg.entries, key)) continue;
      const { pattern, ...rest } = p;
      reg.entries[key] = normEntry({ ...rest, workspace: ws, path: key, target: key, derived: true }, ws);
    }
  }
}
/** registry thieu/hong -> moi write ok:true (fail-open); canh bao ro 1 lan/file/tien trinh de khong im lang. */
function warnRegistryOnce(file) {
  if (regWarned.has(file)) return;
  regWarned.add(file);
  try { process.stderr.write(formatWarn({ rule: 'registry-missing', path: file, detail: 'registry.json thieu/hong: moi ghi data duoc cho qua (khong kiem registry)', fix: 'cai/khoi phuc harness/observe/storage/registry.json trong goc ma' }) + '\n'); } catch {}
}

/** config/data/workspaces/*.json = cach cu (hub bo o H2): van doc, canh bao 1 dong/file/tien trinh. */
function warnDeprecatedConfig(file) {
  if (regWarned.has('dep:' + file)) return;
  regWarned.add('dep:' + file);
  try { process.stderr.write(formatWarn({ rule: 'deprecated-config', path: toPosix(file), key: path.basename(file, '.json'), detail: 'config/data/workspaces/*.json da loi thoi (registry dan xuat tu manifest tool + thu muc ws)', fix: 'khai bao tool trong manifest data[] (zone workspaces, tool, class) roi xoa file' }) + '\n'); } catch {}
}

function normEntry(e, ws) {
  const o = { ...e };
  if (o.domain === 'external' && !o.zone) o.zone = 'external';
  if (ws) { if (!o.workspace) o.workspace = ws; if (!o.zone) o.zone = 'workspaces'; }
  return o;
}

/**
 * Muc data khai bao trong manifest cua external (<extRoot>/<ten>/manifest.json, extRoots tu config workspace; field data[]). Doc truc tiep manifest
 * (khong can external da dang ky/chay): zone+path => path 'zone/path'; chi path => path; chi zone => 'zone/<id>'. Co limit, khong throw.
 * data[] cho phep them `legacy` (ten cu cap 1). Muc sai bi bo. owner = <extRoot>/<ten>.
 */
const MANIFEST_SCAN_MAX = 40;
/** caps trong data[] manifest: chi maxFiles/maxDepth so nguyen duong; khac -> bo. */
const capsOf = (c) => { if (!isObj(c)) return null; const o = {}; for (const k of ['maxFiles', 'maxDepth']) if (Number.isInteger(c[k]) && c[k] > 0) o[k] = c[k]; return Object.keys(o).length ? o : null; };
export function manifestDataEntries(extDir, ownerPrefix = path.basename(extDir)) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(extDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().slice(0, MANIFEST_SCAN_MAX); } catch { return out; }
  for (const n of names) {
    const m = readJ(path.join(extDir, n, 'manifest.json'));
    if (!isObj(m) || !Array.isArray(m.data)) continue;
    const id = typeof m.id === 'string' && m.id ? m.id : n;
    for (const e of m.data) {
      try {
        if (!isObj(e)) continue;
        if (e.zone !== undefined && !ZONES.includes(e.zone)) continue;
        if (e.class !== undefined && !CLASSES.includes(e.class)) continue;
        if (e.path === undefined && e.zone === undefined) continue;
        if (e.path === undefined && e.zone === 'workspaces') {
          // Mau workspaces/*/<tool>: KHONG path/workspace. Thieu tool / tool khong an toan -> bo (khong ghi nham vao workspaces/<ext-id>).
          const tl = e.tool === undefined ? '' : String(e.tool);
          if (!isSafeWs(tl) || out[tl]) continue;
          out[tl] = { zone: 'workspaces', tool: tl, pattern: `workspaces/*/${tl}`, ...(e.class ? { class: e.class } : {}), owner: `${ownerPrefix}/${n}`, ...(e.retentionDays !== undefined && e.retentionDays !== null ? { retentionDays: e.retentionDays } : {}), ...(capsOf(e.caps) ? { caps: capsOf(e.caps) } : {}), ...(e.legacy ? { legacy: String(e.legacy) } : {}) };
          continue;
        }
        const segs = (e.path === undefined ? [id] : String(e.path).split(/[\\/]/)).filter(Boolean);
        if (!segs.length || segs.some((x) => x === '.' || x === '..') || path.isAbsolute(String(e.path ?? ''))) continue;
        const rel = [...(e.zone ? [e.zone] : []), ...segs].join('/');
        const key = e.tool ? String(e.tool) : segs[segs.length - 1];
        if (out[key]) continue;
        out[key] = { ...(e.zone ? { zone: e.zone } : {}), ...(e.class ? { class: e.class } : {}), ...(e.zone === 'workspaces' ? { workspace: typeof e.workspace === 'string' && e.workspace ? e.workspace : id } : {}), owner: `${ownerPrefix}/${n}`, ...(e.retentionDays !== undefined && e.retentionDays !== null ? { retentionDays: e.retentionDays } : {}), ...(capsOf(e.caps) ? { caps: capsOf(e.caps) } : {}), target: rel, path: rel, ...(e.zone === 'workspaces' ? { deprecatedPath: true } : {}) };
      } catch { /* bo muc sai */ }
    }
  }
  return out;
}

const extRootsMemo = new Map();
/**
 * Thu muc ext (tuyet doi) theo config workspace.extRoots, LUON tuong doi goc workspace (base) ca hai mode: hub mode config doc tu
 * <hub>/config; plugin mode tu lop plugin + lop may (lop du an bi chan extRoots), nhung ext van nam trong workspace, khong trong plugin.
 * opts.extDirs ghi de (test). Loi -> rong.
 */
function extDirsFor(base, codeDir, opts) {
  if (Array.isArray(opts.extDirs)) return opts.extDirs.map((d) => ({ abs: d, prefix: path.basename(d) }));
  const env = opts.env || process.env;
  const mk = [base, codeDir, env.CLAUDE_PLUGIN_DATA || '', env.HARNESS_CONFIG_DIR || ''].join('\0');
  if (!extRootsMemo.has(mk)) {
    let roots = [];
    // Plugin mode, lop plugin/may khong khai extRoots -> doc <workspace>/config/workspace|hub (cung file hub mode dung). Chi de PHAN LOAI
    // data (doc manifest data[], khong chay ma ext); chay ma ext van qua dang ky lop may + hash. Hub mode: lan doc dau da la file nay.
    const cfgOf = (e) => { try { const r = loadConfig('workspace', { root: base, env: e, repoDir: codeDir }).config.extRoots; return Array.isArray(r) && r.length ? r : null; } catch { return null; } };
    try { const r = cfgOf(env) || (isPluginMode(codeDir) ? cfgOf({ ...env, HARNESS_CONFIG_DIR: path.join(base, 'config') }) : null); if (Array.isArray(r)) roots = r.filter((x) => typeof x === 'string' && x && !path.isAbsolute(x) && !x.split(/[\\/]/).includes('..')); } catch { /* khong co */ }
    extRootsMemo.set(mk, roots);
  }
  return extRootsMemo.get(mk).map((r) => ({ abs: path.join(base, r), prefix: toPosix(r) }));
}

/** Hop nhat registry.json (+ config/data/workspaces/*.json). Loi doc -> registry rong (fail-open, failed=true). */
export function loadDataRegistry(opts = {}) {
  const env = opts.env || process.env;
  const hub = workspaceRoot(opts);
  const dir = dataRoot(undefined, opts);
  // opts.pluginDir: goc ma plugin (test gia lap plugin mode); mac dinh REPO_DIR. Khong dung opts.repoDir (= goc workspace o cac caller).
  const codeDir = opts.pluginDir || REPO_DIR;
  const plug = isPluginMode(codeDir);
  const file = opts.registryFile || path.join(plug ? codeDir : hub, 'harness', 'observe', 'storage', 'registry.json');
  const wsDir = opts.workspacesDir || path.join(hub, 'config', 'data', 'workspaces');
  let names = [];
  try { names = fs.readdirSync(wsDir).filter((n) => n.endsWith('.json') && !n.endsWith('.example.json')).sort(); } catch {}
  // Goc extRoots = workspace ca hai mode (truoc day plugin mode lay codeRoot() -> quet <plugin>/hub khong ton tai, mat muc manifest hub).
  const extDirs = extDirsFor(hub, codeDir, opts);
  const ck = [wsStamp(dir), file, mtimeOf(file), extDirs.map((d) => d.abs).join(';'), wsDir, ...names.map((n) => n + ':' + mtimeOf(path.join(wsDir, n))), dir, env.HARNESS_DATA_ENFORCE || ''].join('\n');
  if (!opts.noCache && cache.has(ck)) return cache.get(ck);
  const reg = { enforce: DEFAULT_ENFORCE, entries: {}, patterns: Object.create(null), reserved: [], dataDir: dir, failedFiles: [] };
  try {
    const j = readJ(file);
    if (!isObj(j)) throw new Error('registry');
    if (ENFORCE_MODES.includes(j.enforce)) reg.enforce = j.enforce;
    if (Array.isArray(j.reserved)) reg.reserved = j.reserved.map(String);
    if (isObj(j.entries)) for (const [k, v] of Object.entries(j.entries)) if (isObj(v)) reg.entries[k] = normEntry(v);
    // Muc tu manifest external (extRoots): registry.json thang neu cung key (cho phep ghi de / chuyen dan).
    for (const d of extDirs) for (const [k, v] of Object.entries(manifestDataEntries(d.abs, d.prefix))) if (!reg.entries[k]) reg.entries[k] = normEntry(v);
    // Entry mau (workspaces/*/<tool>) tach khoi entries: chi cu the hoa theo thu muc ws dang co hoac luc ghi (resolveEntry/resolveDataRel).
    for (const [k, v] of Object.entries(reg.entries)) if (v.pattern) { reg.patterns[v.tool || k] = v; delete reg.entries[k]; }
    for (const n of names) {
      warnDeprecatedConfig(path.join(wsDir, n));
      const w = readJ(path.join(wsDir, n));
      if (!isObj(w)) { reg.failedFiles.push(path.join(wsDir, n)); reg.failed = true; continue; }
      const ws = typeof w.workspace === 'string' ? w.workspace : n.slice(0, -5);
      const src = isObj(w.entries) ? w.entries : w;
      for (const [k, v] of Object.entries(src)) if (isObj(v) && !k.startsWith('_') && k !== 'workspace') reg.entries[k.includes('/') ? k : `workspaces/${ws}/${k}`] = normEntry({ tool: k.includes('/') ? undefined : k, ...(k.includes('/') ? {} : { path: k }), ...v }, ws);
    }
    if (Object.keys(reg.patterns).length) deriveWorkspaceEntries(reg, dir);
  } catch { reg.entries = {}; reg.patterns = Object.create(null); reg.failed = true; reg.failedFiles.push(file); warnRegistryOnce(file); }
  if (!opts.noCache) cache.set(ck, reg);
  return reg;
}

/** Khop muc theo path vat ly (entry.path || key), roi theo zone/domain/tool, roi ten cap 1 legacy. */
export function resolveEntry(abs, opts = {}) {
  const reg = opts.registry || loadDataRegistry(opts);
  const rel = toPosix(path.relative(dataRoot(undefined, opts), abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { key: '', entry: null };
  const segs = rel.split('/');
  let best = null;
  for (const [k, e] of Object.entries(reg.entries)) {
    const p = toPosix(e.path || k).replace(/\/+$/, '');
    if ((rel === p || rel.startsWith(p + '/')) && (!best || p.length > best.len)) best = { key: k, entry: e, len: p.length };
  }
  if (best) return { key: best.key, entry: best.entry };
  if (segs[0] === 'workspaces' && segs.length >= 3 && isSafeWs(segs[1]) && own(reg.patterns, segs[2])) {
    const { pattern, ...rest } = own(reg.patterns, segs[2]); const pth = `workspaces/${segs[1]}/${segs[2]}`;
    return { key: pth, entry: normEntry({ ...rest, workspace: segs[1], path: pth, target: pth, derived: true }, segs[1]) };
  }
  const tries = ZONES.includes(segs[0]) ? [segs.slice(0, 3).join('/'), segs.slice(0, 2).join('/'), segs[1], segs[2]] : [segs[0]];
  for (const k of tries) if (k && own(reg.entries, k)) return { key: k, entry: reg.entries[k] };
  return { key: ZONES.includes(segs[0]) && segs[1] ? segs.slice(0, 2).join('/') : segs[0], entry: null };
}

/** Muc: env HARNESS_DATA_ENFORCE > registry.enforce > warn. audit khong bao gio enforce. */
export function checkWrite(abs, opts = {}) {
  try {
    const env = opts.env || process.env;
    const reg = opts.registry || loadDataRegistry(opts);
    if (reg.failed) return { ok: true };
    const rel = toPosix(path.relative(dataRoot(undefined, opts), abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: true };
    const segs = rel.split('/');
    if (reg.reserved.includes(segs[0]) && !own(reg.entries, segs[0])) return { ok: true };
    let mode = ENFORCE_MODES.includes(env.HARNESS_DATA_ENFORCE) ? env.HARNESS_DATA_ENFORCE : reg.enforce;
    if (mode === 'off') return { ok: true };
    const { key, entry } = resolveEntry(abs, { ...opts, registry: reg });
    const isAudit = key === 'audit' || key === 'system/audit' || segs[0] === 'audit' || (segs[0] === 'system' && segs[1] === 'audit');
    if (isAudit && mode === 'enforce') mode = 'warn';
    const pth = segs.slice(0, Math.min(segs.length, 3)).join('/');
    let warn = null;
    if (!entry) warn = { rule: 'unregistered', path: pth, key, detail: 'key chua dang ky trong registry', fix: `them data[] vao manifest ext (zone/class/retention)` };
    else {
      const miss = ['class', 'zone', 'owner'].filter((f) => !entry[f]);
      if (miss.length) warn = { rule: 'missing-field', path: pth, key, detail: 'thieu ' + miss.join(','), fix: `harness data register ${key} --class log --owner <owner>` };
    }
    if (!warn) return { ok: true };
    return { ok: mode !== 'enforce', warn };
  } catch { return { ok: true }; }
}
/** @param {DataEntry|null} entry @returns {number|null} retention ngay: override > class default */
export function classRetention(entry) {
  if (!entry) return null;
  if (entry.retentionDays !== undefined) return entry.retentionDays;
  return CLASS_DEFAULTS[entry.class]?.retentionDays ?? null;
}

/** Dong canh bao: data-warn rule= path= key= detail="..." fix="..." */
export function formatWarn(w) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, "'")}"`;
  return `data-warn rule=${w.rule} path=${w.path} key=${w.key} detail=${q(w.detail)} fix=${q(w.fix)}`;
}

/**
 * Phan giai duong dan vat ly cua key. rel = ghi = doc.
 * @returns {{rel:string, legacyRel:string|null, readRel:string, usingLegacy:boolean, exists:{new:boolean,legacy:boolean}}}
 */
export function resolveDataRel(key, opts = {}) {
  const reg = opts.registry || loadDataRegistry(opts);
  const pat = own(reg.patterns, key);
  if (pat) {
    // Entry mau workspaces/*/<tool>: can opts.node. Khong node -> needsNode (KHONG doan duong dan, khong ghi nham cho).
    const tool = pat.tool || key;
    if (opts.node === undefined || opts.node === null) return { rel: `workspaces/*/${tool}`, legacyRel: null, legacyRels: [], readRel: `workspaces/*/${tool}`, usingLegacy: false, exists: { new: false, legacy: false }, pattern: true, needsNode: true };
    const node = String(opts.node);
    if (!isSafeWs(node)) throw new Error(`node khong hop le: ${node}`);
    const ws = workspaceFor(node, opts);
    const base = `workspaces/${ws}/${tool}`;
    const rel = opts.shared ? base : `${base}/${node}`;
    // Doc cu: cap <node>/ chua co (artifact cu nam o <tool>/...) roi `legacy` khai bao trong manifest.
    const lg = safeLegacy(pat.legacy);
    const legacyRels = [...(opts.shared ? [] : [base]), ...(lg ? [lg] : [])];
    const rt = dataRoot(undefined, opts);
    const exs = (r) => { try { return fs.existsSync(path.join(rt, ...r.split('/'))); } catch { return false; } };
    return { rel, legacyRel: legacyRels[0] || null, legacyRels, readRel: rel, usingLegacy: false, exists: { new: exs(rel), legacy: legacyRels.some(exs) }, pattern: true, needsNode: false, node, ws };
  }
  const e = own(reg.entries, key);
  let base = e && e.path;
  if (!base) {
    base = DEFAULT_PATHS[key];
    if (!base) {
      base = key;
      if (!opts.quiet && !warnedNoPath.has(key)) { warnedNoPath.add(key); try { process.stderr.write(formatWarn({ rule: 'no-path', path: key, key, detail: 'registry khong co entry/path; dung ten key lam duong dan', fix: `harness data register ${key} --class log` }) + '\n'); } catch {} }
    }
  }
  const rel = toPosix(base).replace(/\/+$/, '');
  const root = dataRoot(undefined, opts);
  const ex = (r) => { try { return !!r && fs.existsSync(path.join(root, r)); } catch { return false; } };
  return { rel, legacyRel: null, legacyRels: [], readRel: rel, usingLegacy: false, exists: { new: ex(rel), legacy: false } };
}

/** Cac goc DOC cua key: chi path moi neu ton tai (tuyet doi). Khong ghi stderr. */
export function dataReadRoots(key, opts = {}) {
  const r = resolveDataRel(key, opts);
  const root = dataRoot(undefined, opts);
  if (r.needsNode || !r.exists.new) return [];
  const x = path.join(root, ...r.rel.split('/'));
  return isInside(x, root) ? [x] : [];
}

/** Chon goc DOC cho entry mau theo node: rel moi neu <rel>/<segs> ton tai, khong thi legacy dau tien co <legacy>/<segs>. -> {rel, legacy:boolean} */
export function pickNodeRead(r, segs, root) {
  const ok = (b) => { try { return fs.existsSync(path.join(root, ...b.split('/'), ...segs)); } catch { return false; } };
  if (ok(r.rel)) return { rel: r.rel, legacy: false };
  for (const l of r.legacyRels || []) if (ok(l)) return { rel: l, legacy: true };
  return { rel: r.rel, legacy: false };
}

/** dataPathsFor(key, ...parts) -> mang duong dan ton tai (moi truoc, cu sau), noi them parts cho moi goc. */
export function dataPathsFor(key, ...parts) {
  let opts = {};
  if (parts.length && parts[parts.length - 1] && typeof parts[parts.length - 1] === 'object') opts = parts.pop();
  const segs = parts.flatMap((p) => String(p).split(/[\\/]/)).filter(Boolean);
  if (segs.some((s) => s === '.' || s === '..')) throw new Error('doan duong dan khong hop le');
  return dataReadRoots(key, opts).map((b) => path.join(b, ...segs)).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

