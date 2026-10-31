// Hop dong data-registry (W0): hang + chu ky + shape. Logic do W1 cai.
// Dat o core/registry/ vi core/io da vuot flatMax=8. Chi import core (fs).

import fs from 'node:fs';
import path from 'node:path';
import { dataRoot, workspaceRoot, isPluginMode, codeRoot } from '../io/paths.mjs';
import { loadConfig } from '../config/config.mjs';

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
const DEFAULT_PATHS = Object.freeze({ audit: 'system/audit' });
const warnedNoPath = new Set();

/** Cac rule canh bao. */
const WARN_RULES = Object.freeze(['unregistered', 'missing-field', 'over-caps', 'retention', 'stray', 'clutter', 'legacy-read', 'duplicate']);

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
/** registry thieu/hong -> moi write ok:true (fail-open); canh bao ro 1 lan/file/tien trinh de khong im lang. */
function warnRegistryOnce(file) {
  if (regWarned.has(file)) return;
  regWarned.add(file);
  try { process.stderr.write(formatWarn({ rule: 'registry-missing', path: file, detail: 'registry.json thieu/hong: moi ghi data duoc cho qua (khong kiem registry)', fix: 'cai/khoi phuc harness/observe/storage/registry.json trong goc ma' }) + '\n'); } catch {}
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
        const segs = (e.path === undefined ? [id] : String(e.path).split(/[\\/]/)).filter(Boolean);
        if (!segs.length || segs.some((x) => x === '.' || x === '..') || path.isAbsolute(String(e.path ?? ''))) continue;
        const rel = [...(e.zone ? [e.zone] : []), ...segs].join('/');
        const key = e.tool ? String(e.tool) : segs[segs.length - 1];
        if (out[key]) continue;
        out[key] = { ...(e.zone ? { zone: e.zone } : {}), ...(e.class ? { class: e.class } : {}), ...(e.zone === 'workspaces' ? { workspace: typeof e.workspace === 'string' && e.workspace ? e.workspace : id } : {}), owner: `${ownerPrefix}/${n}`, ...(e.retentionDays !== undefined && e.retentionDays !== null ? { retentionDays: e.retentionDays } : {}), target: rel, path: rel, ...(e.legacy ? { legacy: String(e.legacy) } : {}) };
      } catch { /* bo muc sai */ }
    }
  }
  return out;
}

const extRootsMemo = new Map();
/** Thu muc ext (tuyet doi) theo config workspace.extRoots (tuong doi goc ma/workspace). opts.extDirs ghi de (test). Loi -> rong. */
function extDirsFor(base, opts) {
  if (Array.isArray(opts.extDirs)) return opts.extDirs.map((d) => ({ abs: d, prefix: path.basename(d) }));
  if (!extRootsMemo.has(base)) {
    let roots = [];
    try { const r = loadConfig('workspace', { root: base, env: opts.env || process.env }).config.extRoots; if (Array.isArray(r)) roots = r.filter((x) => typeof x === 'string' && x && !path.isAbsolute(x) && !x.split(/[\\/]/).includes('..')); } catch { /* khong co */ }
    extRootsMemo.set(base, roots);
  }
  return extRootsMemo.get(base).map((r) => ({ abs: path.join(base, r), prefix: toPosix(r) }));
}

/** Hop nhat registry.json (+ config/data/workspaces/*.json). Loi doc -> registry rong (fail-open, failed=true). */
export function loadDataRegistry(opts = {}) {
  const env = opts.env || process.env;
  const hub = workspaceRoot(opts);
  const dir = dataRoot(undefined, opts);
  const file = opts.registryFile || path.join(isPluginMode() ? codeRoot() : hub, 'harness', 'observe', 'storage', 'registry.json');
  const wsDir = opts.workspacesDir || path.join(hub, 'config', 'data', 'workspaces');
  let names = [];
  try { names = fs.readdirSync(wsDir).filter((n) => n.endsWith('.json') && !n.endsWith('.example.json')).sort(); } catch {}
  const extBase = isPluginMode() ? codeRoot() : hub;
  const extDirs = extDirsFor(extBase, opts);
  const ck = [file, mtimeOf(file), extDirs.map((d) => d.abs).join(';'), wsDir, ...names.map((n) => n + ':' + mtimeOf(path.join(wsDir, n))), dir, env.HARNESS_DATA_ENFORCE || ''].join('\n');
  if (!opts.noCache && cache.has(ck)) return cache.get(ck);
  const reg = { enforce: DEFAULT_ENFORCE, entries: {}, reserved: [], dataDir: dir, failedFiles: [] };
  try {
    const j = readJ(file);
    if (!isObj(j)) throw new Error('registry');
    if (ENFORCE_MODES.includes(j.enforce)) reg.enforce = j.enforce;
    if (Array.isArray(j.reserved)) reg.reserved = j.reserved.map(String);
    if (isObj(j.entries)) for (const [k, v] of Object.entries(j.entries)) if (isObj(v)) reg.entries[k] = normEntry(v);
    // Muc tu manifest external (extRoots): registry.json thang neu cung key (cho phep ghi de / chuyen dan).
    for (const d of extDirs) for (const [k, v] of Object.entries(manifestDataEntries(d.abs, d.prefix))) if (!reg.entries[k]) reg.entries[k] = normEntry(v);
    for (const n of names) {
      const w = readJ(path.join(wsDir, n));
      if (!isObj(w)) { reg.failedFiles.push(path.join(wsDir, n)); reg.failed = true; continue; }
      const ws = typeof w.workspace === 'string' ? w.workspace : n.slice(0, -5);
      const src = isObj(w.entries) ? w.entries : w;
      for (const [k, v] of Object.entries(src)) if (isObj(v) && !k.startsWith('_') && k !== 'workspace') reg.entries[k.includes('/') ? k : `workspaces/${ws}/${k}`] = normEntry({ tool: k.includes('/') ? undefined : k, ...(k.includes('/') ? {} : { path: k }), ...v }, ws);
    }
  } catch { reg.entries = {}; reg.failed = true; reg.failedFiles.push(file); warnRegistryOnce(file); }
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
  const tries = ZONES.includes(segs[0]) ? [segs.slice(0, 3).join('/'), segs.slice(0, 2).join('/'), segs[1], segs[2]] : [segs[0]];
  for (const k of tries) if (k && reg.entries[k]) return { key: k, entry: reg.entries[k] };
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
    if (reg.reserved.includes(segs[0]) && !reg.entries[segs[0]]) return { ok: true };
    let mode = ENFORCE_MODES.includes(env.HARNESS_DATA_ENFORCE) ? env.HARNESS_DATA_ENFORCE : reg.enforce;
    if (mode === 'off') return { ok: true };
    const { key, entry } = resolveEntry(abs, { ...opts, registry: reg });
    const isAudit = key === 'audit' || key === 'system/audit' || segs[0] === 'audit' || (segs[0] === 'system' && segs[1] === 'audit');
    if (isAudit && mode === 'enforce') mode = 'warn';
    const pth = segs.slice(0, Math.min(segs.length, 3)).join('/');
    let warn = null;
    if (!entry) warn = { rule: 'unregistered', path: pth, key, detail: 'key chua dang ky trong registry', fix: `harness data register ${key} --class log` };
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
 * Phan giai duong dan vat ly cua key (tuong thich sau `data mv`).
 * rel = ghi (luon moi); readRel = doc (moi neu ton tai, khong thi legacy neu ton tai).
 * @returns {{rel:string, legacyRel:string|null, readRel:string, usingLegacy:boolean, exists:{new:boolean,legacy:boolean}}}
 */
export function resolveDataRel(key, opts = {}) {
  const reg = opts.registry || loadDataRegistry(opts);
  const e = reg.entries[key];
  let base = e && e.path;
  if (!base) {
    base = DEFAULT_PATHS[key];
    if (!base) {
      base = key;
      if (!opts.quiet && !warnedNoPath.has(key)) { warnedNoPath.add(key); try { process.stderr.write(formatWarn({ rule: 'no-path', path: key, key, detail: 'registry khong co entry/path; dung ten key lam duong dan', fix: `harness data register ${key} --class log` }) + '\n'); } catch {} }
    }
  }
  const rel = toPosix(base).replace(/\/+$/, '');
  const legacyRel = e && e.legacy ? toPosix(e.legacy).replace(/\/+$/, '') : null;
  const root = dataRoot(undefined, opts);
  const ex = (r) => { try { return !!r && fs.existsSync(path.join(root, r)); } catch { return false; } };
  const exists = { new: ex(rel), legacy: ex(legacyRel) };
  const usingLegacy = !exists.new && exists.legacy;
  return { rel, legacyRel, readRel: usingLegacy ? legacyRel : rel, usingLegacy, exists };
}

/** Cap nhat entry co phys path === from (registry.json hoac workspaces/<ws>.json): path=to, legacy=from (ve lai legacy cu thi bo legacy). Tra {key,file}|null. */
export function setEntryPath(from, to, opts = {}) {
  const hub = workspaceRoot(opts);
  const file = opts.registryFile || path.join(isPluginMode() ? codeRoot() : hub, 'harness', 'observe', 'storage', 'registry.json');
  const wsDir = opts.workspacesDir || path.join(hub, 'config', 'data', 'workspaces');
  const norm = (x) => toPosix(x).replace(/\/+$/, '');
  const apply = (v) => {
    v.path = to;
    if (opts.dropLegacy) delete v.legacy;
    else if (v.legacy !== undefined && norm(v.legacy) === norm(to)) delete v.legacy; else v.legacy = from;
  };
  const j = readJ(file);
  if (isObj(j) && isObj(j.entries)) {
    for (const [k, v] of Object.entries(j.entries)) {
      if (isObj(v) && norm(v.path || k) === norm(from)) { apply(v); writeAtomic(file, JSON.stringify(j, null, 2) + '\n'); cache.clear(); return { key: k, file }; }
    }
  }
  let names = [];
  try { names = fs.readdirSync(wsDir).filter((n) => n.endsWith('.json') && !n.endsWith('.example.json')).sort(); } catch {}
  for (const n of names) {
    const wf = path.join(wsDir, n);
    const w = readJ(wf);
    if (!isObj(w)) continue;
    const ws = typeof w.workspace === 'string' ? w.workspace : n.slice(0, -5);
    const src = isObj(w.entries) ? w.entries : w;
    for (const [k, v] of Object.entries(src)) {
      if (!isObj(v) || k.startsWith('_') || k === 'workspace') continue;
      const key = k.includes('/') ? k : `workspaces/${ws}/${k}`;
      if (norm(v.path || k) === norm(from)) { apply(v); writeAtomic(wf, JSON.stringify(w, null, 2) + '\n'); cache.clear(); return { key, file: wf }; }
    }
  }
  return null;
}

/**
 * Cac goc DOC cua key theo thu tu [path moi, legacy], chi nhung goc ton tai (tuyet doi).
 * Reader doc gop 2 noi trong giai doan relocate/mvpart. Khong ghi stderr.
 * @returns {string[]}
 */
export function dataReadRoots(key, opts = {}) {
  const r = resolveDataRel(key, opts);
  const root = dataRoot(undefined, opts);
  const out = [];
  if (r.exists.new) out.push(path.join(root, ...r.rel.split('/')));
  if (r.legacyRel && r.exists.legacy && r.legacyRel !== r.rel) out.push(path.join(root, ...r.legacyRel.split('/')));
  return out;
}

/** dataPathsFor(key, ...parts) -> mang duong dan ton tai (moi truoc, cu sau), noi them parts cho moi goc. */
export function dataPathsFor(key, ...parts) {
  let opts = {};
  if (parts.length && parts[parts.length - 1] && typeof parts[parts.length - 1] === 'object') opts = parts.pop();
  const segs = parts.flatMap((p) => String(p).split(/[\\/]/)).filter(Boolean);
  if (segs.some((s) => s === '.' || s === '..')) throw new Error('doan duong dan khong hop le');
  return dataReadRoots(key, opts).map((b) => path.join(b, ...segs)).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

/**
 * Doctor: key da bo legacy ma goc cu (ten key o goc du lieu) van con muc => co tien trinh ghi nham duong cu.
 * @returns {string[]} canh bao (rong neu on)
 */
export function checkLegacyWrites(opts = {}) {
  const out = [];
  try {
    const reg = opts.registry || loadDataRegistry(opts);
    const root = dataRoot(undefined, opts);
    for (const key of Object.keys(DEFAULT_PATHS)) {
      const e = reg.entries[key];
      const p = (e && e.path) || DEFAULT_PATHS[key];
      if ((e && e.legacy) || toPosix(p) === key) continue;
      let n = 0;
      try { n = fs.readdirSync(path.join(root, key)).length; } catch { continue; }
      if (n > 0) out.push(formatWarn({ rule: 'legacy-write', path: key, key, detail: `${key} o goc con ${n} muc sau khi entry da bo legacy (co tien trinh ghi duong cu)`, fix: `harness data mvpart ${key} --before <ngay> --rest --drop-legacy` }));
    }
  } catch { /* fail-open */ }
  return out;
}
