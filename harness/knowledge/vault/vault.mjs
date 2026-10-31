// harness/knowledge/vault/vault.mjs - I/O vault: <root>/<kind>/<id>.md. Cong ghi an toan (validate, chong traversal/symlink, secret, atomic).
// Goc: opts.root > config knowledge.root (config/knowledge/*.json | env HARNESS_KNOWLEDGE_ROOT) > registry 'memory' (dataReadRoots goc dau, khong co thi dataPathFor; HUB_DATA_DIR).
import fs from 'node:fs';
import path from 'node:path';
import { workspaceRoot, isInside } from '../../core/io/paths.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { dataReadRoots } from '../../core/registry/data-registry.mjs';
import { loadConfig } from '../../core/config/config.mjs';
import { KINDS, ID_RE, DEFAULT_PROBE_ALLOW, validate, validateProbe, isStale, bodyLinks, todayStr, addDays, findSecret, metaText, isWebSource } from './schema.mjs';
import { parse, stringify } from './frontmatter.mjs';
import { probeNotes } from './probe.mjs';

const READ_CAP = Object.freeze({ files: 2000, fileBytes: 65536 });

function resolveRoot(opt) {
  if (opt) return path.resolve(String(opt));
  try {
    const { config } = loadConfig('knowledge', { defaults: { root: '' } });
    if (typeof config.root === 'string' && config.root.trim()) return path.resolve(workspaceRoot(), config.root.trim());
  } catch { /* fail-open ve mac dinh */ }
  return dataReadRoots('memory')[0] || dataPathFor('memory');
}

/** Allowlist probe: DEFAULT_PROBE_ALLOW + config knowledge.probe.allow (mang chuoi argv). Loi config -> chi mac dinh. */
export function probeAllow() {
  try {
    const { config } = loadConfig('knowledge', { defaults: { root: '' } });
    const extra = config && config.probe && Array.isArray(config.probe.allow) ? config.probe.allow.filter((x) => typeof x === 'string') : [];
    return [...DEFAULT_PROBE_ALLOW, ...extra];
  } catch { return [...DEFAULT_PROBE_ALLOW]; }
}

const lexists = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

/** Duong dan file cho (kind,id); nem Error neu ra ngoai <root>/<kind> hoac dung symlink. */
export function safeFile(root, kind, id) {
  if (!KINDS.includes(kind)) throw new Error(`kind khong hop le: ${kind}`);
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`id khong hop le: ${String(id).slice(0, 80)}`);
  const base = path.resolve(root), dir = path.join(base, kind), f = path.join(dir, `${id}.md`);
  if (!isInside(f, dir) || path.dirname(f) !== dir) throw new Error('duong dan ra ngoai vault');
  for (const p of [base, dir, f]) {
    const st = lexists(p);
    if (st && st.isSymbolicLink()) throw new Error(`tu choi symlink/junction: ${path.relative(base, p) || '.'}`);
  }
  if (fs.existsSync(dir) && !isInside(fs.realpathSync(dir), fs.realpathSync(base))) throw new Error('thu muc kind ra ngoai vault');
  return f;
}

function readVaultFile(f, max = READ_CAP.fileBytes) {
  const fd = fs.openSync(f, 'r');
  try { const st = fs.fstatSync(fd); const b = Buffer.alloc(Math.min(st.size, max)); fs.readSync(fd, b, 0, b.length, 0); return { text: b.toString('utf8'), cut: st.size > max }; } finally { fs.closeSync(fd); }
}

/** Tim file theo id trong moi kind: [{kind, file}]. */
function locate(root, id, kind) {
  const out = [];
  for (const k of kind ? [kind] : KINDS) {
    let f; try { f = safeFile(root, k, id); } catch { continue; }
    const st = lexists(f);
    if (st && st.isFile()) out.push({ kind: k, file: f });
  }
  return out;
}

/** Windows: rename de len file dang bi tien trinh khac mo (indexer/AV/doc song song) nem EPERM/EBUSY/EACCES tam thoi.
 *  Thu lai ngan co tran (RENAME_TRIES lan, tong <= ~RENAME_BUDGET_MS); nen tang khac hoac loi khac nem ngay. */
const RENAME_TRIES = 8, RENAME_BUDGET_MS = 500, RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);
export function renameRetry(from, to, { tries = RENAME_TRIES, budgetMs = RENAME_BUDGET_MS, platform = process.platform, rename = fs.renameSync } = {}) {
  const t0 = Date.now();
  for (let i = 1; ; i++) {
    try { return rename(from, to); } catch (e) {
      if (platform !== 'win32' || !RENAME_RETRY.has(e.code) || i >= tries || Date.now() - t0 >= budgetMs) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10 * i, 80));
    }
  }
}

function writeAtomic(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try { fs.writeFileSync(tmp, text, { flag: 'wx' }); renameRetry(tmp, f); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

/** Tao file moi nguyen tu, KHONG ghi de: tmp + hard link (EEXIST neu dich da co; chay dung tren NTFS/Windows).
 *  FS khong ho tro hard link -> fallback open 'wx' (van doc quyen, chi mat tinh nguyen tu cua noi dung). Nem Error code EEXIST khi trung. */
export function writeNew(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    try { fs.linkSync(tmp, f); } catch (e) {
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(e.code)) throw e;
      fs.writeFileSync(f, text, { flag: 'wx' });
    }
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

/** Ghi ghi chu. input: {meta, body}; opts: {root, replace, dryRun, now}. Tra {ok, file, errors, warnings, created}. */
export function put(input, opts = {}) {
  const root = resolveRoot(opts.root);
  const today = todayStr(opts.now);
  const meta = { ...(input.meta || {}) };
  const body = String(input.body || '');
  const ttl = meta.ttl_days; delete meta.ttl_days;
  if (meta.scope === undefined) meta.scope = 'global';
  if (meta.status === undefined) meta.status = 'active';
  if (ttl !== undefined && ttl !== '' && meta.recheck === undefined) {
    const n = Number(ttl);
    if (!Number.isInteger(n) || n <= 0 || n > 3650) return { ok: false, errors: ['ttl_days phai la so nguyen 1..3650'], warnings: [] };
    meta.recheck = addDays(meta.fetched || today, n);
  }
  const existing = typeof meta.id === 'string' && ID_RE.test(meta.id) ? locate(root, meta.id) : [];
  const same = existing.find((x) => x.kind === meta.kind);
  if (existing.length && !opts.replace) return { ok: false, errors: [`id da ton tai (${existing.map((x) => x.kind).join(',')}); dung --replace`], warnings: [] };
  if (existing.length && !same) return { ok: false, errors: [`id da ton tai o kind khac (${existing[0].kind}); khong doi kind qua put`], warnings: [] };
  let prevCreated;
  if (same) { try { prevCreated = parse(readVaultFile(same.file).text).meta.created; } catch {} }
  meta.created = meta.created || prevCreated || today;
  meta.updated = today;
  const v = validate(meta, body, { probeAllow: probeAllow() });
  if (v.errors.length) return { ok: false, errors: v.errors, warnings: v.warnings };
  let f; try { f = safeFile(root, meta.kind, meta.id); } catch (e) { return { ok: false, errors: [e.message], warnings: v.warnings }; }
  const text = stringify(meta, body);
  if (!opts.dryRun) {
    if (same) writeAtomic(f, text); // --replace ban da co: tmp + rename (ghi de co chu dich)
    else {
      // Tao moi: doc quyen tai buoc ghi (khong chi check-then-act) -> 2 put cung id song song chi 1 thanh cong.
      try { writeNew(f, text); } catch (e) {
        if (e.code === 'EEXIST') return { ok: false, errors: [`id da ton tai (${meta.kind}, tao dong thoi); dung --replace`], warnings: v.warnings };
        throw e;
      }
      // Dua kind khac cung id: kiem lai sau khi tao; trung thi go ban minh (an toan: khong de 2 kind cung id).
      const dup = locate(root, meta.id).filter((x) => x.kind !== meta.kind);
      if (dup.length) {
        try { fs.rmSync(f, { force: true }); } catch {}
        return { ok: false, errors: [`id da ton tai o kind khac (${dup[0].kind}, tao dong thoi)`], warnings: v.warnings };
      }
    }
  }
  return { ok: true, file: f, root, created: !same, dryRun: !!opts.dryRun, errors: [], warnings: v.warnings, text };
}

/** Doc 1 ghi chu theo id. */
export function get(id, opts = {}) {
  const root = resolveRoot(opts.root);
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'id khong hop le' };
  const hit = locate(root, id, opts.kind)[0];
  if (!hit) return { ok: false, error: `khong thay ${id}` };
  const r = readVaultFile(hit.file, opts.maxBytes || READ_CAP.fileBytes);
  const p = parse(r.text);
  return { ok: true, file: hit.file, kind: hit.kind, meta: p.meta, body: p.body, text: r.text, cut: r.cut };
}

/** Duyet vault co tran: tra {notes:[{kind,id,file,meta,body,error,cut}], truncated}. */
export function scan(opts = {}) {
  const root = resolveRoot(opts.root);
  const t0 = Date.now(), tmo = (opts.timeoutS || 10) * 1000, cap = opts.maxFiles || READ_CAP.files;
  const notes = []; let truncated = null;
  const baseSt = lexists(root);
  if (!baseSt || baseSt.isSymbolicLink()) return { root, notes, truncated };
  outer: for (const kind of opts.kind ? [opts.kind] : KINDS) {
    const dir = path.join(root, kind); const st = lexists(dir);
    if (!st || !st.isDirectory()) continue;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (Date.now() - t0 > tmo) { truncated = 'timeout'; break outer; }
      if (notes.length >= cap) { truncated = `limit ${cap} files`; break outer; }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const file = path.join(dir, e.name);
      let r; try { r = readVaultFile(file); } catch { continue; }
      const p = parse(r.text);
      notes.push({ kind, id: e.name.slice(0, -3), file, meta: p.meta, body: p.body, error: p.error, cut: r.cut });
    }
  }
  return { root, notes, truncated };
}

const noteLine = (n) => {
  const s = n.meta.quote || String(n.body).split(/\r?\n/).map((x) => x.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return s.length > 100 ? s.slice(0, 99) + '…' : s;
};

/** Loc: {kind, scope, tags[], status ('any' = moi), text, stale, fresh, limit}. Mac dinh bo archived. */
export function query(f = {}, opts = {}) {
  const today = todayStr(opts.now);
  const s = scan({ ...opts, kind: f.kind });
  const text = f.text ? String(f.text).toLowerCase() : null;
  const tags = (f.tags || []).filter(Boolean);
  const hits = s.notes.filter((n) => {
    const m = n.meta;
    if (f.scope && m.scope !== f.scope) return false;
    if (f.status && f.status !== 'any' ? m.status !== f.status : !f.status && m.status === 'archived') return false;
    if (tags.length && !tags.every((t) => Array.isArray(m.tags) && m.tags.includes(t))) return false;
    const st = isStale(m, today);
    if (f.stale && !st) return false;
    if (f.fresh && st) return false;
    if (text && ![n.id, m.quote, m.source, (m.tags || []).join(' '), n.body].join('\n').toLowerCase().includes(text)) return false;
    return true;
  });
  const limit = f.limit > 0 ? f.limit : 10;
  // source + web + secret (ten mau nghi secret trong meta (de quy moi gia tri long, co tran) + body, null neu sach): cho knowledge/inject loc truoc khi chen.
  const items = hits.slice(0, limit).map((n) => ({ id: n.id, kind: n.kind, scope: n.meta.scope || null, status: n.meta.status || null, tags: n.meta.tags || [], recheck: n.meta.recheck || null, stale: isStale(n.meta, today), line: noteLine(n), source: typeof n.meta.source === 'string' ? n.meta.source : null, web: isWebSource(n.meta.source), secret: findSecret([metaText(n.meta), n.body].join('\n')) }));
  return { root: s.root, total: hits.length, items, truncated: s.truncated };
}

/** Kiem: sai schema, id/kind lech ten file/thu muc, link gay, qua recheck. Tra {errors:[{id,msg}], warnings:[...]}. */
export function check(opts = {}) {
  const today = todayStr(opts.now);
  const s = scan(opts);
  const ids = new Set(s.notes.map((n) => n.id));
  const errors = [], warnings = [];
  const allow = probeAllow();
  for (const n of s.notes) {
    const add = (arr, msg) => arr.push({ id: n.id, kind: n.kind, msg });
    if (n.error) add(errors, n.error);
    if (n.cut) add(warnings, 'file qua lon, chi doc phan dau');
    if (n.meta.id !== n.id) add(errors, `id frontmatter (${n.meta.id}) khac ten file`);
    if (n.meta.kind !== n.kind) add(errors, `kind frontmatter (${n.meta.kind}) khac thu muc`);
    const v = validate(n.meta, n.body, { probeAllow: allow });
    for (const x of v.errors) add(errors, x);
    for (const x of v.warnings) add(warnings, x);
    const links = new Set([...(Array.isArray(n.meta.links) ? n.meta.links : []), ...bodyLinks(n.body)]);
    for (const l of links) if (!ids.has(l)) add(errors, `link gay [[${l}]]`);
    if (n.meta.status !== 'archived' && isStale(n.meta, today)) add(warnings, `qua han recheck (${n.meta.recheck || n.meta.status})`);
  }
  // --probe: chay probe (opt-in). Lech -> stale-probe (canh bao); probe loi/timeout/khong thay lenh -> probe-error (canh bao).
  let probe = null;
  if (opts.probe) {
    probe = probeNotes(s.notes, { allow, timeoutS: opts.timeoutS || 10, validate: validateProbe });
    for (const x of [...probe.stale, ...probe.errors]) warnings.push({ id: x.id, kind: x.kind, msg: x.msg });
  }
  return { root: s.root, count: s.notes.length, errors, warnings, probe, truncated: s.truncated || (probe && probe.truncated) || null };
}

/** Prune: ung vien = chua archived va het han. Mac dinh chi bao; apply -> status: archived (khong xoa file). */
export function prune(opts = {}) {
  const today = todayStr(opts.now);
  const s = scan(opts);
  const cands = s.notes.filter((n) => !n.error && n.meta.status !== 'archived' && isStale(n.meta, today));
  const applied = [], failed = [];
  if (opts.apply) {
    for (const n of cands) {
      try {
        const f = safeFile(s.root, n.kind, n.id);
        if (n.cut) throw new Error('file qua lon');
        writeAtomic(f, stringify({ ...n.meta, status: 'archived', updated: today }, n.body));
        applied.push(n.id);
      } catch (e) { failed.push({ id: n.id, msg: e.message }); }
    }
  }
  return { root: s.root, candidates: cands.map((n) => ({ id: n.id, kind: n.kind, recheck: n.meta.recheck || null, status: n.meta.status || null })), applied, failed, apply: !!opts.apply, truncated: s.truncated };
}
