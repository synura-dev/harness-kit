// So su co (ledger): jsonl trong data/system/ledger (qua dataPathFor/guardWrite, khong ghi tho ngoai API data).
// Muc: {id, rule, fp, status:'open'|'warned'|'acted'|'ignored'|'resolved', first_seen, last_seen, warn_count, warn_ts[], acted, ignored, ...}
// acted/ignored suy tat dinh: sau canh bao, fp con lap trong CUNG phien -> ignored; khong lap trong actedAfterHours -> acted.
import fs from 'node:fs';
import path from 'node:path';
import { dataPathFor, guardWrite, readJson } from '../../core/io/storage.mjs';
import { ensureDataIgnore } from '../../core/io/paths.mjs';
import { withLock } from '../../core/runtime/lockfile.mjs';

export const STATUSES = Object.freeze(['open', 'warned', 'acted', 'ignored', 'resolved']);
export const POLICY = Object.freeze({ actedAfterHours: 24, resolveAfterHours: 168, maxEntries: 1000, maxWarnTs: 20, maxBytes: 2 * 1048576, maxWarnLines: 3 });
export const JOB = Object.freeze({ timeoutS: 25, scanMaxBytes: 128 * 1048576, minIntervalHours: 1, lockMinutes: 5 });
const H = 3600e3;

export const ledgerDir = (opts = {}) => dataPathFor('ledger', { quiet: true, ...opts });
export const ledgerFile = (opts) => path.join(ledgerDir(opts), 'ledger.jsonl');
export const stateFile = (opts) => path.join(ledgerDir(opts), 'state.json');
export const pendingFile = (opts) => path.join(ledgerDir(opts), 'warn-pending.json');
export const pendingPathFor = (file) => path.join(path.dirname(file), 'warn-pending.json');

/** Doc so (gioi han byte). Loi/thieu file -> []. */
export function readLedger(file, { maxBytes = POLICY.maxBytes } = {}) {
  try {
    if (fs.statSync(file).size > maxBytes) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.id);
  } catch { return []; }
}

function atomicWrite(file, text) {
  const g = guardWrite(file);
  if (!g.ok) return false;
  try {
    ensureDataIgnore(); fs.mkdirSync(path.dirname(file), { recursive: true });
    const t = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(t, text, 'utf8'); fs.renameSync(t, file);
    return true;
  } catch { return false; }
}
/** Tom tat nho cac muc can canh bao ({id, rule}); hook chi doc file nay. */
export const pendingOf = (entries) => entries.filter((e) => e && e.due && e.message).map((e) => ({ id: e.id, rule: e.rule }));

export function writeLedger(file, entries) {
  const keep = entries.length > POLICY.maxEntries
    ? [...entries].sort((a, b) => (a.status === 'resolved') - (b.status === 'resolved') || String(b.last_seen).localeCompare(String(a.last_seen))).slice(0, POLICY.maxEntries)
    : entries;
  const text = keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : '');
  return atomicWritePair(file, text, pendingPathFor(file), JSON.stringify({ ts: Date.now(), bytes: Buffer.byteLength(text), pending: pendingOf(keep) }) + '\n'); // tom tat nho de hook khong phai parse ca so
}

// Ghi so + tom tat CUNG giao dich (goi duoi khoa file): ghi ca hai tmp truoc, roi rename lien tiep. Tom tat mang `bytes` cua so -> lech (crash giua hai rename) thi readPending coi la hong.
function atomicWritePair(file, text, pfile, ptext) {
  const gf = guardWrite(file), gp = guardWrite(pfile);
  if (!gf.ok || !gp.ok) return false;
  const t1 = `${file}.${process.pid}.tmp`, t2 = `${pfile}.${process.pid}.tmp`;
  try {
    ensureDataIgnore(); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(t1, text, 'utf8'); fs.writeFileSync(t2, ptext, 'utf8');
    fs.renameSync(t1, file); fs.renameSync(t2, pfile);
    return true;
  } catch { for (const t of [t1, t2]) { try { fs.unlinkSync(t); } catch { /* khong co */ } } return false; }
}
export const REBUILD_MIN_INTERVAL_MS = 10 * 60e3;
export const rebuildStampFile = (file) => path.join(path.dirname(file), 'warn-pending.rebuild.json');
/** Cho phep rebuild tom tat khi hong/thieu toi da 1 lan/10 phut (stamp); true = duoc phep va da danh dau. */
export function claimRebuild(file, nowMs = Date.now()) {
  const sf = rebuildStampFile(file);
  try { const j = JSON.parse(fs.readFileSync(sf, 'utf8')); if (nowMs - Number(j.ts) < REBUILD_MIN_INTERVAL_MS) return false; } catch { /* chua co stamp */ }
  atomicWrite(sf, JSON.stringify({ ts: nowMs }) + '\n');
  return true;
}

/** Doc tom tat canh bao; null neu thieu/hong (hook se doc so day du mot lan de tu lanh). */
export function readPending(file) {
  try {
    const j = JSON.parse(fs.readFileSync(pendingPathFor(file), 'utf8'));
    if (!Array.isArray(j.pending)) return null;
    if (Number.isFinite(j.bytes) && fs.statSync(file).size !== j.bytes) return null; // lech so (crash giua hai rename / so bi sua ngoai)
    return j.pending;
  } catch { return null; }
}

/**
 * Doc-sua-ghi so duoi khoa file. fn(entries) -> entries moi | null/undefined (khong ghi). Khong lay duoc khoa -> {ok:false} (fail-open: bo qua lan ghi nay).
 * Moi nguoi ghi so (job, hook, autopilot annotate) deu di qua day (hoac withLock cung khoa trong core).
 */
export function updateLedger(file, fn, { lock } = {}) {
  const r = withLock(file, () => { const next = fn(readLedger(file)); return next ? writeLedger(file, next) : false; }, lock);
  return r.ok ? { ok: true, wrote: r.value === true } : { ok: false, wrote: false };
}
export const readState = (opts) => readJson(stateFile(opts), {}) || {};
export const writeState = (opts, st) => atomicWrite(stateFile(opts), JSON.stringify(st) + '\n');

const iso = (ms) => new Date(ms).toISOString();

/** Suy acted/ignored/resolved cho muc `warned|acted` dua tren cac lan lap (finding.occ) sau lan canh bao cuoi. Thuan. */
export function resolveOutcome(e, finding, nowMs, policy = POLICY) {
  const lastWarn = e.warn_ts && e.warn_ts.length ? Date.parse(e.warn_ts[e.warn_ts.length - 1]) : null;
  if (!lastWarn) return e;
  const after = ((finding && finding.occ) || []).filter((o) => o.ts && Date.parse(o.ts) > lastWarn);
  if (e.status === 'warned') {
    if (after.some((o) => o.sid && o.sid === e.warned_sid)) return { ...e, status: 'ignored', ignored: iso(nowMs), ignored_count: (e.ignored_count || 0) + 1 };
    if (!after.length && nowMs - lastWarn >= policy.actedAfterHours * H) return { ...e, status: 'acted', acted: iso(nowMs) };
    return e;
  }
  if (e.status === 'acted') {
    if (after.length) return { ...e, status: 'open' }; // tai phat sau khi da xu ly
    if (nowMs - Date.parse(e.last_seen || e.first_seen) >= policy.resolveAfterHours * H) return { ...e, status: 'resolved' };
  }
  return e;
}

/** Ap finding vao so. Tra {entries, changed}. Thuan: khong IO. Dat due=true khi action canh bao va het cooldown. */
export function applyFindings(entries, findings, nowMs, policy = POLICY, { partial = false } = {}) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const seen = new Set();
  const fById = new Map(findings.map((f) => [`${f.rule}|${f.fp}`, f]));
  const out = [];
  for (const [id, f] of fById) {
    seen.add(id);
    let e = byId.get(id) || { id, rule: f.rule, fp: f.fp, status: 'open', first_seen: f.first_ts || iso(nowMs), last_seen: iso(nowMs), warn_count: 0, warn_ts: [], due: false };
    e = resolveOutcome(e, f, nowMs, policy);
    const lastWarn = e.warn_ts.length ? Date.parse(e.warn_ts[e.warn_ts.length - 1]) : 0;
    const warnable = f.action === 'warn' || f.action === 'propose';
    out.push({
      ...e, last_seen: f.last_ts || iso(nowMs), action: f.action, count: f.count, message: f.message, sample: f.sample, cooldown_hours: f.cooldown_hours,
      due: warnable && e.status !== 'resolved' && e.status !== 'acted' && nowMs - lastWarn >= f.cooldown_hours * H,
    });
  }
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    if (partial) { out.push(e); continue; } // pass phu (luat tren so): giu nguyen muc khac
    out.push({ ...resolveOutcome(e, null, nowMs, policy), due: false }); // khong con xuat hien: khong duoc canh bao them
  }
  return { entries: out };
}

/**
 * Hook doc state: chon toi da `max` muc due (kiem lai cooldown), ghi warn_ts. Thuan. Tra {lines, entries, changed}.
 * Khong tinh nang: chi doc muc da tinh san.
 */
export function claimDue(entries, nowMs, { sid = null, max = POLICY.maxWarnLines, policy = POLICY } = {}) {
  const lines = []; let changed = false;
  const out = entries.map((e) => {
    if (lines.length >= max || !e.due || !e.message) return e;
    const lastWarn = e.warn_ts && e.warn_ts.length ? Date.parse(e.warn_ts[e.warn_ts.length - 1]) : 0;
    if (nowMs - lastWarn < (e.cooldown_hours ?? 24) * H) return { ...e, due: false }; // tuong tranh/cooldown
    lines.push(`ledger[${e.rule}]: ${e.message}`);
    changed = true;
    return { ...e, due: false, status: 'warned', warned_sid: sid, warn_count: (e.warn_count || 0) + 1, warn_ts: [...(e.warn_ts || []), iso(nowMs)].slice(-policy.maxWarnTs) };
  });
  return { lines, entries: out, changed };
}

/** Het han (>= minIntervalHours tu lan cuoi)? Doc state nhanh, khong tinh nang. */
export function jobDue(dataOpts, nowMs = Date.now(), cfg = JOB) {
  const st = readState(dataOpts);
  return !(Number(st.lastRun) && nowMs - Number(st.lastRun) < cfg.minIntervalHours * 3600e3);
}
