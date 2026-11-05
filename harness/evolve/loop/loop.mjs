// Vong tien hoa: audit -> candidates (cung error_fp >= 3 lan / 7 ngay, toan may) -> propose (skill) -> check -> apply --approve (version) -> rollback.
// Tai dung core/audit (scan + candidates + signature). Fail-safe: loi bat ky -> khong ap.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { workspaceRoot, toPosix, readJson, dataDir } from '../../core/io/paths.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';
import { dataReadRoots } from '../../core/registry/data-registry.mjs';
import { auditRoot } from '../../core/audit/audit-write.mjs';
import { collectJsonlFiles, readAuditEvents } from '../../core/audit/scan.mjs';
import { repeatedFailureCandidates } from '../../core/audit/candidates.mjs';
import { extractErrorDetails, sanitizeHintPath } from '../../core/audit/signature.mjs';
import { maskSecrets } from '../../core/audit/gate-event.mjs';

export const LIMITS = Object.freeze({
  days: 7, threshold: 3, scanTimeoutMs: 20000, scanMaxBytes: 128 * 1048576, listLimit: 20,
  maxAfterBytes: 256 * 1024, logLimit: 20, sampleChars: 200,
  patternChars: 1000,
});
export const KINDS = Object.freeze(['skill']);
const DAY = 86400000;

const sha = (buf) => (buf == null ? 'absent' : crypto.createHash('sha256').update(buf).digest('hex'));
const readBuf = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
const writeJson = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n', 'utf8'); };
const rootFor = (k) => dataReadRoots(k)[0] || dataPathFor(k);
const ctx = (o = {}) => {
  const hub = path.resolve(o.hubRoot || workspaceRoot());
  const evo = path.resolve(o.dataRoot || rootFor('evolve'));
  const audits = o.auditDir ? [path.resolve(o.auditDir)] : (dataReadRoots('audit').length ? dataReadRoots('audit') : [auditRoot()]);
  return { hub, evo, audits, base: path.resolve(o.dataBase || dataDir()) };
};
const appendLog = (c, rec) => { try { fs.mkdirSync(c.evo, { recursive: true }); fs.appendFileSync(path.join(c.evo, 'applied.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); } catch {} };

// ---- redact ----
// Che secret: maskSecrets cua core (key=value, Authorization, bearer, ghp_/sk-/AKIA, URL user:pass@) + bo sung o day
// (Basic/Bearer dung le, JWT, email). tok = chuoi thay the.
function maskAll(s, tok, email) {
  return maskSecrets(String(s ?? '')).split('***').join(tok)
    .replace(/\b((?:bearer|basic|digest|token)\s+)(?!<SECRET>|\\S\+)[A-Za-z0-9._~+/=\\-]{6,}/gi, `$1${tok}`)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abpr]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._\\-]+)/g, tok)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, email);
}
export function redact(s) {
  return maskAll(sanitizeHintPath(String(s || '')), '<SECRET>', '<EMAIL>').slice(0, LIMITS.sampleChars);
}
/** Redact regex pattern truoc khi ghi evidence/rule: secret -> \S+ (van la regex hop le). Khong compile duoc -> null. */
export function redactPattern(p) {
  if (p == null || p === '') return null;
  const s = maskAll(p, '\\S+', '\\S+@\\S+');
  if (s.length > LIMITS.patternChars) return null;
  try { new RegExp(s, 'i'); return s; } catch { return null; }
}

// ---- candidates ----
function nestedDateDirs(root) {
  const out = [];
  const ls = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
  for (const a of ls(root)) {
    if (a.startsWith('date=')) out.push({ date: a.slice(5), dir: path.join(root, a) });
    else if (a.startsWith('type=')) for (const d of ls(path.join(root, a))) if (d.startsWith('date=')) out.push({ date: d.slice(5), dir: path.join(root, a, d) });
  }
  return out.sort((x, y) => y.date.localeCompare(x.date));
}

/** Loi lap cung dau van tay >= threshold lan trong `days` ngay, toan may. Tra {items, scanned, truncated}. */
export async function findCandidates(o = {}) {
  const c = ctx(o);
  const days = o.days > 0 ? o.days : LIMITS.days;
  const threshold = o.threshold > 0 ? o.threshold : LIMITS.threshold;
  const nowMs = Number(o.nowMs) || Date.now();
  const fromMs = nowMs - days * DAY;
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  const deadline = Date.now() + (o.timeoutMs > 0 ? o.timeoutMs : LIMITS.scanTimeoutMs);
  const maxBytes = o.maxBytes > 0 ? o.maxBytes : LIMITS.scanMaxBytes;
  let used = 0, truncated = null, scanned = 0;
  const events = [];
  for (const { date, dir } of c.audits.flatMap(nestedDateDirs)) {
    if (date < fromDate) continue;
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
    let size = 0;
    for (const f of collectJsonlFiles(dir)) { try { size += fs.statSync(f).size; } catch {} }
    if (used + size > maxBytes) { truncated = 'max_bytes'; break; }
    used += size;
    const r = await readAuditEvents(dir, size + 1, deadline);
    scanned += r.scannedEvents;
    for (const ev of r.events) {
      const t = Date.parse(ev.ts);
      if (Number.isFinite(t) && (t < fromMs || t > nowMs + DAY)) continue;
      if (o.source && ev.source !== o.source) continue; // loc theo nguon (vd ext:<id>); mac dinh khong loc
      events.push(ev);
    }
    if (r.truncated) { truncated = r.truncated; break; }
  }
  const nowIso = new Date(nowMs).toISOString();
  const items = repeatedFailureCandidates(events, nowIso)
    .filter((x) => x.evidenceCount >= threshold)
    .map((x) => {
      const evs = (x._evs || []).slice().sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
      const last = evs[evs.length - 1] || {};
      return {
        id: x.id, fp: x._fp || null, count: x.evidenceCount, tool: last.tool || (last.data && last.data.tool) || 'unknown',
        sessions: new Set(evs.map((e) => e.sid || e.session_id || '-')).size,
        first_ts: evs[0] ? evs[0].ts || null : null, last_ts: last.ts || null,
        sample: redact(extractErrorDetails(last)), pattern: redactPattern(x.pattern), hint: redact(x.hint),
      };
    })
    .sort((a, b) => b.count - a.count);
  return { items, total: items.length, scanned, days, threshold, truncated };
}

import { classifyTarget as classifyRaw, same, layoutOf as layoutRaw } from './policy.mjs';
// Policy luon nhan goc du lieu/evolve THUC (ctx) de suy dich mac dinh: <dataDir>/<evolve>/skills.
const polOpts = (o = {}) => { const c = ctx(o); return { ...o, hubRoot: c.hub, dataBase: c.base, dataRoot: c.evo }; };
export const classifyTarget = (target, kind, o = {}) => classifyRaw(target, kind, polOpts(o));
const layoutOf = (o = {}) => layoutRaw(polOpts(o), ctx(o).hub);

// ---- proposals ----
const pFile = (c, id) => path.join(c.evo, 'proposals', `${id}.json`);
const assertSafeId = (id) => { if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(id)) throw new Error(`id khong hop le: ${String(id).slice(0, 80)}`); return id; };
function loadProposal(id, o = {}) { const j = readJson(pFile(ctx(o), assertSafeId(id))); if (!j) throw new Error(`khong tim thay de xuat ${id}`); return j; }
const saveProposal = (p, o) => writeJson(pFile(ctx(o), p.id), p);
export function listProposals(o = {}) {
  const d = path.join(ctx(o).evo, 'proposals');
  let names = []; try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort(); } catch {}
  return names.slice(-LIMITS.listLimit).map((n) => readJson(path.join(d, n))).filter(Boolean);
}

// Doc dich chi khi qua policy (khong doc file ngoai allowlist).
const polAbs = (target, kind, o) => { const p = classifyTarget(target, kind, o); return p.ok ? p.abs : null; };

function buildChange(kind, cand, o) {
  const note = `[evolve ${cand.id}] ${cand.hint}`;
  const slug = `evolve-${cand.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const ev = `Bang chung: fp=${cand.fp || '-'}, ${cand.count} lan / ${cand.sessions} phien (${cand.first_ts} .. ${cand.last_ts}), tool=${cand.tool}.\nMau (redacted): ${cand.sample}\n`;
  if (kind === 'skill') {
    const target = o.target || `${layoutOf(o).skillsDir}/${slug}/SKILL.md`;
    const a = polAbs(target, kind, o);
    if (a && fs.existsSync(a)) throw new Error(`${target} da ton tai`);
    return { target, after: `---\nname: ${slug}\ndescription: Tranh loi lap ${cand.tool} (${cand.fp || cand.id}). Dung khi gap loi khop pattern nay.\n---\n\n${note}\n\n${ev}` };
  }
  throw new Error(`kind la: ${kind} (${KINDS.join('|')})`);
}

/** Tao file de xuat kem bang chung tu candidate (quet lai audit). */
export async function propose(cid, o = {}) {
  const c = ctx(o);
  const kind = o.kind || 'skill';
  if (!KINDS.includes(kind)) throw new Error(`kind la: ${kind} (${KINDS.join('|')})`);
  const scan = await findCandidates(o);
  const cand = scan.items.find((x) => x.id === cid);
  if (!cand) throw new Error(`khong co candidate ${cid} (nguong ${scan.threshold} lan/${scan.days} ngay)`);
  const ch = buildChange(kind, cand, o);
  if (Buffer.byteLength(ch.after) > LIMITS.maxAfterBytes) throw new Error('noi dung de xuat qua lon');
  const pol = classifyTarget(ch.target, kind, o);
  const id = assertSafeId(`p_${cid}_${kind}`);
  const p = {
    id, candidate: cid, kind, created: new Date().toISOString(), status: pol.ok ? 'proposed' : 'blocked',
    evidence: { fp: cand.fp, count: cand.count, sessions: cand.sessions, window_days: scan.days, threshold: scan.threshold, first_ts: cand.first_ts, last_ts: cand.last_ts, tool: cand.tool, sample: cand.sample, pattern: cand.pattern },
    change: { target: pol.rel || toPosix(String(ch.target)), before_sha: pol.ok ? sha(readBuf(targetAbs(kind, pol, c))) : null, after: ch.after, after_sha: sha(Buffer.from(ch.after, 'utf8')) },
    policy: { ok: pol.ok, forbidden: pol.forbidden, reason: pol.reason }, check: null, ver: null,
  };
  saveProposal(p, o);
  appendLog(c, { op: 'propose', id, kind, target: p.change.target, policy: pol.ok ? 'ok' : pol.reason });
  return p;
}

// ---- ghi dich (file truc tiep). abs LUON suy tu classifyTarget, khong lay tu file proposals/versions ----
const targetAbs = (kind, pol) => pol.abs;

function writeTarget(kind, pol, buf, c, o, tag) {
  const abs = targetAbs(kind, pol);
  if (buf == null) { fs.rmSync(abs, { force: true }); return; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

// Khoi phuc ban truoc (buf = byte file cu | null = chua ton tai).
const restoreTarget = writeTarget;

// ---- oracle: evolve chi de xuat skill (ngoai config/) nen khong co gi de eval tren ban sao config; oracle luon bo qua (ghi ro). ----
// ok=true nghia la "qua cac kiem policy/sha, khong co eval de chay" (apply phu thuoc ok + after_sha); verdict='skipped' de KHONG goi la PASS.
export const ORACLE_SKIPPED = 'skipped (khong co dich config de eval)';
const runOracle = (kind, afterBuf) => ({ ok: true, verdict: 'skipped', reason: null, oracle: ORACLE_SKIPPED, kind, after_sha: sha(afterBuf) });

const afterOf = (p) => (p && p.change && typeof p.change.after === 'string' ? Buffer.from(p.change.after, 'utf8') : null);

/** Oracle: eval truoc/sau tren ban sao config, gan sha(after). Eval te di hoac loi -> loai. Khong dung file that. */
export function check(id, o = {}) {
  const c = ctx(o);
  const p = loadProposal(id, o);
  const done = (res) => { p.check = { ts: new Date().toISOString(), ...res }; p.status = res.ok ? 'checked' : 'rejected'; saveProposal(p, o); appendLog(c, { op: 'check', id, ok: res.ok, reason: res.reason || null }); return p; };
  const pol = classifyTarget(p.change && p.change.target, p.kind, o);
  if (!pol.ok) return done({ ok: false, reason: `khong danh gia: ${pol.reason}` });
  const after = afterOf(p);
  if (!after || after.length > LIMITS.maxAfterBytes) return done({ ok: false, reason: 'change.after khong hop le/qua lon' });
  if (sha(after) !== p.change.after_sha) return done({ ok: false, reason: 'after_sha lech noi dung after' });
  if (sha(readBuf(pol.abs)) !== p.change.before_sha) return done({ ok: false, reason: 'dich da doi tu luc propose (stale); propose lai' });
  return done(runOracle(p.kind, after));
}

// ---- apply / rollback ----
const verDir = (c, ver) => path.join(c.evo, 'versions', assertSafeId(ver));
const manualHelp = (p, c) => `Dich ${p.change && p.change.target} chi nguoi sua tay. Noi dung de xuat: ${toPosix(pFile(c, p.id))} (truong change.after); bang chung: fp=${p.evidence && p.evidence.fp}, ${p.evidence && p.evidence.count} lan.`;

/** Ap co version. Khong tin file de xuat: phan loai lai dich, kiem sha(after)/before, TU CHAY LAI oracle tren dung buffer se ghi. */
export function apply(id, o = {}) {
  const c = ctx(o);
  const p = loadProposal(id, o);
  const refuse = (code, reason, extra = {}) => { appendLog(c, { op: 'apply', id, ok: false, reason }); return { ok: false, code, reason, ...extra }; };
  const pol = classifyTarget(p.change && p.change.target, p.kind, o);
  if (pol.forbidden) return refuse(3, `tu choi (ke ca co --approve): ${pol.reason}`, { manual: manualHelp(p, c) });
  if (!o.approve) return refuse(2, 'can nguoi duyet: chay lai voi --approve');
  if (!pol.ok) return refuse(3, `tu choi: ${pol.reason}`, { manual: manualHelp(p, c) });
  if (p.status === 'applied') return refuse(4, `da ap (ver ${p.ver})`);
  const afterBuf = afterOf(p);
  if (!afterBuf || afterBuf.length > LIMITS.maxAfterBytes) return refuse(4, 'change.after khong hop le/qua lon');
  const afterSha = sha(afterBuf);
  if (afterSha !== p.change.after_sha) return refuse(4, 'after_sha lech noi dung after (de xuat bi sua?)');
  if (!p.check || p.check.ok !== true || p.check.after_sha !== afterSha) return refuse(4, 'chua qua oracle cho dung after nay: chay `evolve check <id>` truoc');
  const abs = targetAbs(p.kind, pol, c);
  const stale = () => sha(readBuf(abs)) !== p.change.before_sha;
  if (stale()) return refuse(4, 'dich da doi tu luc propose (stale)');
  const ck = runOracle(p.kind, afterBuf);
  if (!ck.ok || ck.after_sha !== afterSha) return refuse(4, `oracle chay lai trong apply loai: ${ck.reason || 'sha lech'}`, { check: ck });
  if (stale()) return refuse(4, 'dich da doi trong luc chay oracle (stale)');
  const orig = readBuf(abs);
  const ver = `v${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)}-${crypto.randomBytes(2).toString('hex')}`;
  const vd = verDir(c, ver);
  try {
    fs.mkdirSync(vd, { recursive: true });
    if (orig != null) fs.writeFileSync(path.join(vd, 'before.bin'), orig);
    const m = { ver, id, kind: p.kind, target: pol.rel, existed: orig != null, before_sha: sha(orig), after_sha: null, ts: new Date().toISOString(), status: 'applying', oracle: ck.oracle || null };
    writeJson(path.join(vd, 'manifest.json'), m);
    writeTarget(p.kind, pol, afterBuf, c, o, p.id);
    const now = readBuf(abs);
    if (now == null) throw new Error('ghi xong nhung khong thay dich');
    if (sha(now) !== afterSha) throw new Error('ghi xong nhung sha lech after');
    m.after_sha = sha(now); m.status = 'applied';
    writeJson(path.join(vd, 'manifest.json'), m);
  } catch (e) {
    try { restoreTarget(p.kind, pol, orig, c, o, p.id); } catch {}
    return refuse(5, `ap loi, da khoi phuc: ${e.message}`);
  }
  p.status = 'applied'; p.ver = ver; saveProposal(p, o);
  appendLog(c, { op: 'apply', id, ok: true, ver, target: pol.rel });
  return { ok: true, code: 0, ver, target: pol.rel };
}

/** Khoi phuc dung byte truoc khi ap. Can --approve; dich suy lai tu target da chuan hoa + allowlist (khong tin manifest.abs). */
export function rollback(ver, o = {}) {
  const c = ctx(o);
  let vd; try { vd = verDir(c, ver); } catch (e) { return { ok: false, code: 1, reason: e.message }; }
  const m = readJson(path.join(vd, 'manifest.json'));
  if (!m) return { ok: false, code: 1, reason: `khong co version ${ver}` };
  if (m.ver !== ver) return { ok: false, code: 4, reason: `manifest ver lech (${String(m.ver).slice(0, 40)})` };
  if (m.status !== 'applied') return { ok: false, code: 4, reason: `version ${ver} o trang thai ${m.status}` };
  const pol = classifyTarget(m.target, m.kind, o);
  if (pol.forbidden) return { ok: false, code: 3, reason: `tu choi (ke ca co --approve): ${pol.reason}` };
  if (!o.approve) return { ok: false, code: 2, reason: 'can nguoi duyet: chay lai voi --approve' };
  if (!pol.ok) return { ok: false, code: 3, reason: `tu choi: ${pol.reason}` };
  const abs = targetAbs(m.kind, pol, c);
  if (m.abs != null && !same(path.resolve(String(m.abs)), path.resolve(abs))) return { ok: false, code: 3, reason: 'manifest.abs khong khop dich suy tu target (gia mao?)' };
  if (sha(readBuf(abs)) !== m.after_sha && !o.force) return { ok: false, code: 4, reason: 'dich da bi sua sau apply; kiem tay hoac --force' };
  let b = null;
  if (m.existed) {
    b = readBuf(path.join(vd, 'before.bin'));
    if (b == null || sha(b) !== m.before_sha) return { ok: false, code: 5, reason: 'snapshot hong (sha lech)' };
  } else if (m.before_sha !== 'absent') return { ok: false, code: 5, reason: 'manifest mau thuan (existed=false nhung before_sha != absent)' };
  try {
    restoreTarget(m.kind, pol, b, c, o, ver);
    if (sha(readBuf(abs)) !== m.before_sha) throw new Error('khoi phuc khong khop byte');
  } catch (e) { appendLog(c, { op: 'rollback', ver, ok: false, reason: e.message }); return { ok: false, code: 5, reason: e.message }; }
  m.status = 'rolled_back'; m.rolled_back_ts = new Date().toISOString();
  writeJson(path.join(vd, 'manifest.json'), m);
  try { const pf = pFile(c, assertSafeId(m.id)); const p = readJson(pf); if (p) { p.status = 'rolled_back'; writeJson(pf, p); } } catch {}
  appendLog(c, { op: 'rollback', ver, ok: true, id: m.id, target: pol.rel });
  return { ok: true, code: 0, ver, target: pol.rel };
}

export function readLog(o = {}) {
  const f = path.join(ctx(o).evo, 'applied.jsonl');
  let st; try { st = fs.statSync(f); } catch { return { items: [], total: 0 }; }
  const max = 1048576, fd = fs.openSync(f, 'r');
  try {
    const len = Math.min(st.size, max), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (st.size > max) lines.shift();
    const items = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const lim = o.limit > 0 ? o.limit : LIMITS.logLimit;
    return { items: items.slice(-lim), total: items.length, truncated: st.size > max ? 'max-bytes' : null };
  } finally { fs.closeSync(fd); }
}

// Dung lai boi evolve patterns (doc audit cung cach, cung tran).
export { ctx as auditCtx, nestedDateDirs };
