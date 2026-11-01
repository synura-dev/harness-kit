// Luu tru du lieu chay: duong dan chuan data/<domain>/<tool>/<date=YYYY-MM-DD | run-id>/... (goc = dataRoot(): $HUB_DATA_DIR | <hub>/data).
// dataPath kiem ten (safe-id) + chan thoat khoi data/; helper ghi tu tao thu muc. appendJsonl khong nem loi (tra null khi that bai).
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot, isInside, ensureDataIgnore } from './paths.mjs';
import { checkWrite, formatWarn, resolveDataRel, pickNodeRead } from '../registry/data-registry.mjs';

const SEG = /^[A-Za-z0-9_][A-Za-z0-9_.=-]{0,95}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const today = (d = new Date()) => d.toISOString().slice(0, 10);
export const dateDir = (d) => `date=${today(d)}`;

/** dataPath(domain, tool|null, ...parts[, {env, repoDir}]) -> duong dan tuyet doi trong data/. Nem Error neu ten sai / thoat data/. */
export function dataPath(domain, tool, ...rest) {
  let opts = {};
  if (rest.length && rest[rest.length - 1] && typeof rest[rest.length - 1] === 'object') opts = rest.pop();
  if (!ID.test(String(domain ?? ''))) throw new Error(`domain khong hop le: ${domain}`);
  if (tool != null && !ID.test(String(tool))) throw new Error(`tool khong hop le: ${tool}`);
  const segs = [];
  for (const p of rest) {
    for (const s of String(p).split(/[\\/]/)) {
      if (s === '') continue;
      if (s === '.' || s === '..' || !SEG.test(s)) throw new Error(`doan duong dan khong hop le: ${s}`);
      segs.push(s);
    }
  }
  const root = dataRoot(undefined, opts);
  const out = path.join(root, String(domain), ...(tool != null ? [String(tool)] : []), ...segs);
  if (!isInside(out, root)) throw new Error('duong dan thoat khoi data/');
  return out;
}

const legacyWarned = new Set();
/**
 * dataPathFor(key, ...parts[, {mode:'write'|'read', env, repoDir}]) -> duong dan tuyet doi theo registry (path moi / legacy).
 * write (mac dinh) -> luon path moi. read -> path moi neu ton tai, khong thi legacy kem canh bao data-warn rule=legacy-read (1 lan/key/tien trinh).
 */
export function dataPathFor(key, ...rest) {
  let opts = {};
  if (rest.length && rest[rest.length - 1] && typeof rest[rest.length - 1] === 'object') opts = rest.pop();
  const root = dataRoot(undefined, opts);
  const r = resolveDataRel(key, opts);
  if (r.needsNode) throw new Error(`data '${key}' khai bao theo mau ${r.rel}: can opts {node}`);
  const segs = [];
  for (const p of rest) for (const s of String(p).split(/[\\/]/)) {
    if (s === '') continue;
    if (s === '.' || s === '..' || !SEG.test(s)) throw new Error(`doan duong dan khong hop le: ${s}`);
    segs.push(s);
  }
  let base = r.rel;
  if (r.pattern) {
    if (opts.mode === 'read') {
      const p = pickNodeRead(r, segs, root);
      base = p.rel;
      if (p.legacy && !opts.quiet && !legacyWarned.has(key)) {
        legacyWarned.add(key);
        try { process.stderr.write(formatWarn({ rule: 'legacy-read', path: p.rel, key, detail: 'doc tu duong dan cu (chua co cap <node>/)', fix: `ghi moi vao ${r.rel}` }) + '\n'); } catch {}
      }
    }
  } else if (opts.mode === 'read' && r.usingLegacy) {
    base = r.legacyRel;
    if (!opts.quiet && !legacyWarned.has(key)) {
      legacyWarned.add(key);
      try { process.stderr.write(formatWarn({ rule: 'legacy-read', path: r.legacyRel, key, detail: 'doc tu duong dan cu', fix: `harness data mv ${r.legacyRel} ${r.rel} --yes` }) + '\n'); } catch {}
    }
  }
  const out = path.join(root, ...base.split('/'), ...segs);
  if (!isInside(out, root)) throw new Error('duong dan thoat khoi dataDir');
  return out;
}

const warned = new Map();
const errSeen = new Set();
function errOnce(key, msg) { if (errSeen.has(key)) return; errSeen.add(key); try { process.stderr.write(msg + '\n'); } catch {} }
// warn: 1 lan/key/tiep trinh ra stderr; enforce: ok=false. Loi bat ky -> cho ghi (fail-open).
export function guardWrite(file) {
  try {
    const r = checkWrite(file);
    const k = r.warn ? r.warn.key + ':' + r.warn.rule : '';
    if (r.warn && !warned.has(k)) { warned.set(k, 1); process.stderr.write(formatWarn(r.warn) + '\n'); }
    return { ok: r.ok, warn: r.warn };
  } catch { return { ok: true }; }
}

export function writeJson(file, obj) {
  const g = guardWrite(file);
  if (!g.ok) throw new Error('data-enforce: ' + formatWarn(g.warn));
  ensureDataIgnore(); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return file;
}

export function readJson(file, fallback = null) {
  try { const t = fs.readFileSync(file, 'utf8'); return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); } catch { return fallback; }
}

/** Them 1 dong JSON; tuy chon maxBytes (vuot -> doi sang <file>.old). Tra file hoac null khi loi. */
export function appendJsonl(file, rec, { maxBytes } = {}) {
  try {
    const g = guardWrite(file);
    if (!g.ok) { errOnce(file, 'data-enforce: chan ghi ' + (g.warn ? formatWarn(g.warn) : file)); return null; }
    ensureDataIgnore(); fs.mkdirSync(path.dirname(file), { recursive: true });
    if (maxBytes) { try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.old'); } catch {} }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    return file;
  } catch (e) { errOnce(file, `data-enforce: appendJsonl loi ${path.basename(file)}: ${e && e.message}`); return null; }
}

/** Doc toi da `limit` dong cuoi (mac dinh 200), bo dong hong. */
export function readJsonl(file, { limit = 200, maxBytes = 4194304 } = {}) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const rows = [];
      for (const l of buf.toString('utf8').split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch {} }
      return rows.slice(-limit);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}
