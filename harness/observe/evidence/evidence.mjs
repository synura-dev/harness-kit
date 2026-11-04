// observe/evidence: bang chung khach quan tu audit (chi DOC). Tat dinh: chi lenh Bash + exit code/su kien that, khong phan doan.
// Schema: {ts, session_id, task_id|null, tool, kind|null, outcome:'pass'|'fail'|'none', exit_code|null, source:'audit', event_id}. Khong chua lenh tho/stdout.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readRecords } from '../../core/io/jsonl-store.mjs';
import { auditRoot, auditReadRoots } from '../../core/audit/audit-write.mjs';
import { verifyKind, verifierOutcome } from '../../core/audit/fingerprint.mjs';

export const LIMITS = Object.freeze({ timeoutMs: 10000, readMaxBytes: 64 * 1048576, days: 2, listLimit: 30, summaryLimit: 200, maxLines: 40 });
export const KINDS = Object.freeze(['test', 'tsc', 'lint', 'build', 'hash', 'health']);
const POST = new Set(['PostToolUse', 'PostToolUseFailure']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Ban ghi audit Bash (PostToolUse|PostToolUseFailure) -> evidence; khac -> null. */
export function toEvidence(rec) {
  if (!rec || rec.tool !== 'Bash' || !POST.has(rec.event)) return null;
  const d = rec.data || {};
  const text = typeof rec.target === 'string' ? rec.target : '';
  const complete = !!text && d.target_truncated !== true && !text.includes('\n'); // lenh day du, 1 dong
  // Ban ghi moi: audit da tinh verify_kind tren lenh day du -> uu tien (ke ca null). Ban ghi cu: tu tinh tu target/cmd_line.
  const fromAudit = Object.prototype.hasOwnProperty.call(d, 'verify_kind') && (d.verify_kind === null || KINDS.includes(d.verify_kind));
  const kind = fromAudit ? d.verify_kind : verifyKind(complete ? text : String(d.cmd_line || text.split('\n', 1)[0]));
  let outcome = 'none';
  if (d.verifier_outcome === 'pass' || d.verifier_outcome === 'fail') outcome = d.verifier_outcome; // audit da xet tren lenh day du
  else if (!fromAudit && complete && kind) {
    outcome = verifierOutcome({ isVerify: true, event: rec.event, ok: rec.ok, exitCode: d.exit_code,
      interrupted: rec.status === 'interrupted', background: d.bg === true });
  }
  const sid = rec.sid || null;
  const event_id = d.tool_use_id ? String(d.tool_use_id)
    : createHash('sha1').update(`${rec.ts}|${sid}|${rec.event}|${text}`).digest('hex').slice(0, 12);
  return { ts: rec.ts, session_id: sid, task_id: d.task_id || null, tool: 'Bash', kind: kind || null, outcome,
    exit_code: Number.isFinite(d.exit_code) ? d.exit_code : null, source: 'audit', event_id };
}

/** Su kien sua file thanh cong (co files_touched) -> ts; khac -> null. */
export function editTs(rec) {
  if (!rec || rec.event !== 'PostToolUse' || rec.ok === false || !EDIT_TOOLS.has(rec.tool)) return null;
  const f = rec.data && rec.data.files_touched;
  return Array.isArray(f) && f.length ? rec.ts : null;
}

const sidMatch = (sid, s) => !s || (typeof sid === 'string' && (sid === s || sid.startsWith(s) || sid.endsWith('-' + s)));

/** File audit type=tool (layout v2 date=/type= va v1 type=/date=), loc theo since/days/session. Moi nhat truoc. */
export function listAuditFiles(root, f = {}) {
  const roots = [].concat(root).filter((r) => r && fs.existsSync(r));
  if (!roots.length) return [];
  const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
  const byDate = new Map();
  const add = (dir, date) => { for (const n of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
    if (!n.endsWith('.jsonl')) continue;
    if (f.session && !n.includes(f.session)) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(path.join(dir, n));
  } };
  for (const root of roots) for (const a of dirs(root)) {
    if (a.startsWith('date=')) { if (dirs(path.join(root, a)).includes('type=tool')) add(path.join(root, a, 'type=tool'), a.slice(5)); }
    else if (a === 'type=tool') for (const d of dirs(path.join(root, a))) if (d.startsWith('date=')) add(path.join(root, a, d), d.slice(5));
  }
  let dates = [...byDate.keys()].sort().reverse();
  if (f.since) dates = dates.filter((d) => d >= String(f.since).slice(0, 10));
  else dates = dates.slice(0, f.days > 0 ? f.days : LIMITS.days);
  return dates.flatMap((d) => byDate.get(d).sort().map((p) => ({ path: p, date: d })));
}

/** Doc audit -> {evidence (moi nhat truoc), edits (ts), raw, files, truncated}. Gioi han timeout + tong byte doc. */
function collect(opts = {}) {
  const root = opts.root || auditRoot();
  const deadline = Date.now() + (opts.timeoutMs > 0 ? opts.timeoutMs : LIMITS.timeoutMs);
  let budget = opts.readMaxBytes > 0 ? opts.readMaxBytes : LIMITS.readMaxBytes;
  const files = listAuditFiles(opts.root ? root : auditReadRoots(), opts);
  const evidence = [], edits = [], raw = [];
  let truncated = null;
  const inScope = (rec) => sidMatch(rec.sid, opts.session) && (!opts.since || String(rec.ts) >= String(opts.since))
    && (!opts.task || (rec.data && rec.data.task_id) === opts.task);
  for (const f of files) {
    const left = deadline - Date.now();
    if (left <= 0) { truncated = 'timeout'; break; }
    if (budget <= 0) { truncated = 'max_bytes'; break; }
    let size = 0; try { size = fs.statSync(f.path).size; } catch { continue; }
    const r = readRecords(f.path, { maxBytes: budget, timeoutMs: left, reverse: true });
    budget -= Math.min(size, budget);
    if (r.truncated) truncated = truncated || (r.truncated === 'timeout' ? 'timeout' : 'max_bytes');
    for (const rec of r.records) {
      if (!rec || !inScope(rec)) continue;
      const t = editTs(rec);
      if (t) { edits.push(t); continue; }
      const e = toEvidence(rec);
      if (!e || (!opts.all && !e.kind)) continue;
      evidence.push(e);
      if (opts.raw) raw.push({ event_id: e.event_id, ts: rec.ts, event: rec.event, ok: rec.ok, status: rec.status, target: rec.target,
        target_truncated: rec.data?.target_truncated ?? null, exit_code: rec.data?.exit_code ?? null, verifier_outcome: rec.data?.verifier_outcome ?? null });
    }
  }
  const desc = (a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);
  evidence.sort(desc);
  edits.sort().reverse();
  return { evidence, edits, raw, files: files.length, truncated };
}

/** Danh sach evidence moi nhat, toi da limit. */
export function list(opts = {}) {
  const c = collect(opts);
  const limit = opts.limit > 0 ? opts.limit : LIMITS.listLimit;
  const items = c.evidence.slice(0, limit);
  const ids = new Set(items.map((e) => e.event_id));
  return { items, raw: c.raw.filter((r) => ids.has(r.event_id)), files: c.files, total: c.evidence.length,
    truncated: c.truncated || (c.evidence.length > limit ? 'limit' : null) };
}

/** Dem pass/fail/none theo kind tren `evidence` (moi nhat truoc); fresh_pass = co pass sau lan sua file cuoi. */
function summarize(evidence, edits = []) {
  const lastEdit = edits.length ? edits.reduce((a, b) => (a > b ? a : b)) : null;
  const kinds = {};
  for (const e of evidence) {
    const k = e.kind || 'none';
    const s = kinds[k] || (kinds[k] = { pass: 0, fail: 0, none: 0, last_outcome: null, last_ts: null, last_pass_ts: null, fresh_pass: false });
    s[e.outcome]++;
    if (!s.last_ts || e.ts > s.last_ts) { s.last_ts = e.ts; s.last_outcome = e.outcome; }
    if (e.outcome === 'pass' && (!s.last_pass_ts || e.ts > s.last_pass_ts)) s.last_pass_ts = e.ts;
  }
  for (const s of Object.values(kinds)) s.fresh_pass = !!s.last_pass_ts && (!lastEdit || s.last_pass_ts > lastEdit) && s.last_outcome === 'pass';
  return { total: evidence.length, last_edit_ts: lastEdit, kinds };
}

/** summary: N evidence moi nhat (limit) + lan sua cuoi trong cung pham vi. */
export function summary(opts = {}) {
  const c = collect(opts);
  const limit = opts.limit > 0 ? opts.limit : LIMITS.summaryLimit;
  const ev = c.evidence.slice(0, limit);
  const ids = new Set(ev.map((e) => e.event_id));
  return { ...summarize(ev, c.edits), task: opts.task || null, session: opts.session || null, files: c.files,
    raw: c.raw.filter((r) => ids.has(r.event_id)), truncated: c.truncated || (c.evidence.length > limit ? 'limit' : null) };
}
