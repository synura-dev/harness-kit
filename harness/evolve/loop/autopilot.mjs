// Autopilot tien hoa: ledger (open/warned, action=propose) -> de xuat -> oracle tren su kien cu -> phan muc tat dinh.
//   Muc 1 (tu ap dung + tu rollback sau 7 ngay): chi them luat canh bao/goi y fix_command/text inject (kind rule|inject).
//   Muc 2 (hang cho review-queue): skill, sua code harness, xoa thanh phan, doi gate. Khong tu ap dung; nguoi duyet qua TTY.
//   Cam (muc 0): cham guard/approval/bash-guard/data-gate/model-policy (duong dan hoac config gate), push/deploy, ngoai repo harness.
// KHONG goi model. Chay theo lo: toi da 1 lan/24h, timeout cung, khoa chong chay trung. Chi import core + evolve (hop dong import).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, dataPathFor, guardWrite } from '../../core/io/storage.mjs';
import { readAuditEvents, collectJsonlFiles } from '../../core/audit/scan.mjs';
import { findCandidates, propose, check, apply, rollback, ctx, nestedDateDirs } from './loop.mjs';
import { ruleDef } from './rule-content.mjs';
import { bgDoneOnExit } from '../../core/runtime/proc.mjs';

export const CFG = Object.freeze({
  intervalHours: 24, timeoutS: 100, maxProposals: 5, maxModelCallsWeek: 0, rollbackAfterDays: 7,
  autonomy: 1, // 0 = chi xep hang (khong tu ap gi); 1 = tu ap muc 1, muc 2 xep hang
  tolerance: 0.25, minSamples: 10, oracleDays: 30, lockStaleS: 300, maxQueue: 200, maxApplied: 100,
});
const H = 3600e3, DAY = 86400000;

// ---- phan muc tat dinh ----
export const LEVEL_BY_KIND = Object.freeze({ rule: 1, inject: 1, skill: 2, code: 2, delete: 2, gate: 2 });
// Muc 0: cam tuyet doi (kem ke ca khi nguoi duyet qua hang: nguoi phai tu sua tay).
const GATE_PATH = /(^|\/)(guard|approval|bash-guard|data-gate|model-policy|verify-gate)(\/|\.|-|$)|^harness\/(constrain|hooks)(\/|$)|^config\/(approval|verify-gate|guard|hub|model-policy|data-gate)/i;
const FORBIDDEN_KIND = /^(push|deploy|publish|release)$/i;
const FORBIDDEN_TEXT = /\bgit\s+push\b|\bdeploy\b|\bnpm\s+publish\b|\bgh\s+release\b/i;

/** Chuan hoa dich tuong doi repo; null neu tuyet doi/thoat/o dia. */
function relTarget(t) {
  if (typeof t !== 'string' || !t || /[\0-\x1f]/.test(t)) return null;
  const s = t.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-z]:/i.test(s) || s.startsWith('//')) return null;
  const out = [];
  for (const seg of s.split('/')) { if (seg === '' || seg === '.') continue; if (seg === '..') return null; out.push(seg.replace(/[. ]+$/, '')); }
  return out.length ? out.join('/') : null;
}

/** change: {kind, target, text?}. -> {level: 0|1|2, reason}. level 0 = tu choi. Thuan. */
export function classifyChange(change = {}) {
  const kind = String(change.kind || '');
  if (FORBIDDEN_KIND.test(kind) || FORBIDDEN_TEXT.test(`${kind} ${change.text || ''}`)) return { level: 0, reason: 'cam: push/deploy' };
  const rel = relTarget(change.target);
  if (rel == null) return { level: 0, reason: `cam: dich ngoai repo harness (${String(change.target).slice(0, 60)})` };
  if (GATE_PATH.test(rel) || /^evolve\/(autopilot|review-queue)/i.test(rel)) return { level: 0, reason: `cam: cham guard/approval/bash-guard/data-gate/model-policy (${rel})` };
  if (kind === 'gate') return { level: 2, reason: 'doi gate -> cho duyet' };
  const lv = LEVEL_BY_KIND[kind];
  if (!lv) return { level: 2, reason: `loai thay doi la (${kind || '-'}) -> cho duyet` };
  if (lv === 1 && !/^(?:[^/]+\/)*(rules\/[^/]+\.json|inject\/[^/]+\.md)$/.test(rel)) return { level: 2, reason: `muc 1 chi file luat/inject, dich ${rel} -> cho duyet` };
  return { level: lv, reason: lv === 1 ? 'chi them canh bao/goi y/inject' : `${kind} -> cho duyet` };
}

// ---- oracle tat dinh tren su kien cu cua fp ----
/** def luat da sinh; cands = candidate tren su kien cu (nhieu fp). Phai: hop le, bat dung fp muc tieu, khong bat fp khac. */
export function oracleRule(def, fp, cands) {
  if (!def || typeof def !== 'object') return { ok: false, reason: 'luat khong parse duoc' };
  if (def.source !== 'candidates' || def.action !== 'warn' || !(Number(def.threshold) >= 0)) return { ok: false, reason: 'luat sai schema/hanh dong (chi warn tren candidates)' };
  if (typeof def.message !== 'string' || def.message.length > 200) return { ok: false, reason: 'message thieu/qua dai' };
  if (!def.filter || def.filter.fp !== fp || Object.keys(def.filter).length !== 1) return { ok: false, reason: 'filter khong khoa dung 1 fp' };
  const hits = cands.filter((c) => c.fp === def.filter.fp && (c.count || 0) >= Number(def.threshold));
  if (!hits.length) return { ok: false, reason: 'luat khong bat duoc su kien cu cua fp' };
  const others = cands.filter((c) => c.fp !== fp && def.filter.fp === c.fp);
  if (others.length) return { ok: false, reason: 'luat bat fp khac (false positive)' };
  return { ok: true, hits: hits.length, count: hits[0].count, reason: null };
}

// ---- chi so bao ve (audit) ----
const auditField = (r, k) => (k === 'kind' ? (r.data && r.data.verify_kind) ?? r.kind ?? null : (r.signal ?? (r.data && r.data.signal) ?? null)); // khop engine ledger (khong import observe)
const isVerify = (k) => k === 'test' || k === 'build';
/** {verify_fail_rate, correction_rate, verify_n, n}. Thuan. */
export function protectiveRates(events) {
  let vn = 0, vf = 0, corr = 0, n = 0;
  for (const e of events || []) {
    if (!e) continue; n++;
    if (isVerify(auditField(e, 'kind'))) { vn++; if (e.ok === false || e.event === 'PostToolUseFailure') vf++; }
    if (auditField(e, 'signal') === 'correction') corr++;
  }
  return { verify_n: vn, n, verify_fail_rate: vn ? vf / vn : 0, correction_rate: n ? corr / n : 0 };
}
/** Xau di khi tang > tolerance (tuong doi) va du mau. */
export function worsened(before, after, cfg = CFG) {
  const w = (a, b, nA) => nA >= cfg.minSamples && b > a * (1 + cfg.tolerance) && b - a > 0.005;
  return w(before.verify_fail_rate, after.verify_fail_rate, after.verify_n) || w(before.correction_rate, after.correction_rate, after.n);
}
/** Quyet dinh rollback cho 1 moc: fp khong giam hoac chi so xau di. Thuan. */
export function shouldRollback(rec, countNow, ratesNow, cfg = CFG) {
  if (!(countNow < rec.count_before)) return { rollback: true, reason: `count fp khong giam (${rec.count_before} -> ${countNow})` };
  if (worsened(rec.rates_before || {}, ratesNow, cfg)) return { rollback: true, reason: 'chi so bao ve xau di (verify_fail/correction tang)' };
  return { rollback: false, reason: null };
}

// ---- trang thai ----
export const apDir = (o = {}) => path.join(ctx(o).evo, 'autopilot');
const f = (o, n) => path.join(apDir(o), n);
const wr = (file, j) => { const g = guardWrite(file); if (!g.ok) return false; fs.mkdirSync(path.dirname(file), { recursive: true }); const t = `${file}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(j, null, 2) + '\n'); fs.renameSync(t, file); return true; };
const weekKey = (ms) => Math.floor(ms / (7 * DAY));
export const readState = (o) => { const s = readJson(f(o, 'state.json'), {}) || {}; return { applied: [], week: { key: 0, proposals: 0, modelCalls: 0 }, ...s }; };
export const readQueue = (o) => { const q = readJson(f(o, 'review-queue.json'), []); return Array.isArray(q) ? q : []; };

/** Due: >= intervalHours tu lan chay cuoi. Dung cho hook kick (doc nhanh). */
export function autopilotDue(o = {}, nowMs = Date.now(), cfg = CFG) {
  const last = Number(readState(o).lastRun);
  return !(last && nowMs - last < cfg.intervalHours * H);
}

function lockAcquire(o, nowMs, cfg) {
  const file = f(o, 'lock.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, JSON.stringify({ ts: nowMs, pid: process.pid }), { flag: 'wx' }); return file; } catch {
      const l = readJson(file, null);
      if (l && nowMs - Number(l.ts) < cfg.lockStaleS * 1000) return null;
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
  return null;
}

// ---- ledger (doc/ghi chu ly do; ledger thuoc observe nen doc file du lieu, khong import) ----
const ledgerPath = (o) => (o.ledgerFile ? o.ledgerFile : path.join(dataPathFor('ledger', { quiet: true, ...(o.dataOpts || {}) }), 'ledger.jsonl'));
function readLedgerRaw(file) {
  try { if (fs.statSync(file).size > 2 * 1048576) return []; return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.id); } catch { return []; }
}
function annotate(o, notes) { // notes: Map id -> {status, reason}; ghi lai ca file (tmp + rename), giu nguyen cac truong khac
  if (!notes.size) return;
  const file = ledgerPath(o); const es = readLedgerRaw(file); if (!es.length) return;
  const ts = new Date().toISOString();
  const out = es.map((e) => (notes.has(e.id) ? { ...e, evolve: { ts, ...notes.get(e.id) } } : e));
  const g = guardWrite(file); if (!g.ok) return;
  const t = `${file}.${process.pid}.tmp`; fs.writeFileSync(t, out.map((e) => JSON.stringify(e)).join('\n') + '\n'); fs.renameSync(t, file);
}

async function readEventsWindow(o, days, nowMs, timeoutMs) {
  const c = ctx(o); const deadline = Date.now() + timeoutMs; const from = new Date(nowMs - days * DAY).toISOString().slice(0, 10);
  const events = [];
  for (const { date, dir } of c.audits.flatMap(nestedDateDirs)) {
    if (date < from) continue; if (Date.now() > deadline) break;
    let size = 0; for (const x of collectJsonlFiles(dir)) { try { size += fs.statSync(x).size; } catch {} }
    if (size > 64 * 1048576) continue;
    const r = await readAuditEvents(dir, size + 1, deadline); events.push(...r.events);
  }
  return events.filter((e) => { const t = Date.parse(e.ts); return !Number.isFinite(t) || (t >= nowMs - days * DAY && t <= nowMs + DAY); });
}

/** Chay mot lo. o: {dryRun, force, nowMs, cfg, hubRoot, dataRoot, auditDir, dataBase, ledgerFile, ledgerEntries, confirm...}. */
export async function runAutopilot(o = {}) {
  const cfg = { ...CFG, ...(o.cfg || {}) };
  const nowMs = Number(o.nowMs) || Date.now();
  const dry = !!o.dryRun;
  const res = { dryRun: dry, skipped: null, planned: [], applied: [], queued: [], refused: [], rolledBack: [], kept: [], errors: [] };
  if (!o.force && !autopilotDue(o, nowMs, cfg)) { res.skipped = 'chua toi han (<24h)'; return res; }
  let lock = null;
  if (!dry) { lock = lockAcquire(o, nowMs, cfg); if (!lock) { res.skipped = 'khoa: lo khac dang chay'; return res; } }
  const deadline = Date.now() + (o.timeoutMs || cfg.timeoutS * 1000);
  const timeUp = () => Date.now() > deadline;
  const notes = new Map();
  let st = readState(o); const queue = readQueue(o);
  try {
    if (!dry) { st.lastRun = nowMs; wr(f(o, 'state.json'), st); } // chiem moc ngay: loi giua chung cung khong chay lai trong 24h
    if (weekKey(nowMs) !== st.week.key) st.week = { key: weekKey(nowMs), proposals: 0, modelCalls: 0 };

    // 1) Tu rollback cac moc muc 1 da >= N ngay.
    const due = st.applied.filter((a) => a.status === 'applied' && nowMs - Date.parse(a.ts) >= cfg.rollbackAfterDays * DAY);
    if (due.length) {
      const cands = await findCandidates({ ...o, days: cfg.rollbackAfterDays, threshold: 1, nowMs, timeoutMs: 15000 });
      const rates = protectiveRates(await readEventsWindow(o, cfg.rollbackAfterDays, nowMs, 15000));
      for (const a of due) {
        if (timeUp()) { res.errors.push('timeout'); break; }
        const now = cands.items.find((x) => x.fp === a.fp);
        const d = shouldRollback(a, now ? now.count : 0, rates, cfg);
        if (!d.rollback) { res.kept.push({ ver: a.ver, fp: a.fp }); if (!dry) a.status = 'kept'; continue; }
        if (dry) { res.rolledBack.push({ ver: a.ver, fp: a.fp, reason: d.reason, dry: true }); continue; }
        const r = rollback(a.ver, { ...o, approve: true });
        a.status = r.ok ? 'rolled_back' : 'rollback_failed'; a.reason = r.ok ? d.reason : r.reason;
        (r.ok ? res.rolledBack : res.errors).push(r.ok ? { ver: a.ver, fp: a.fp, reason: d.reason } : `rollback ${a.ver}: ${r.reason}`);
        if (a.entry_id) notes.set(a.entry_id, { status: r.ok ? 'rolled_back' : 'rollback_failed', reason: a.reason, ver: a.ver });
      }
    }

    // 2) Muc ledger can de xuat.
    const entries = o.ledgerEntries || readLedgerRaw(ledgerPath(o));
    const taken = new Set([...st.applied.filter((a) => ['applied', 'kept'].includes(a.status)).map((a) => a.fp), ...queue.filter((q) => q.status === 'pending').map((q) => q.fp)]);
    const todo = entries.filter((e) => ['open', 'warned'].includes(e.status) && e.action === 'propose' && e.fp && !taken.has(e.fp)
      && !(e.evolve && ['applied', 'queued', 'refused'].includes(e.evolve.status))).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, cfg.maxProposals);
    const scan = todo.length ? await findCandidates({ ...o, days: cfg.oracleDays, threshold: 1, nowMs, timeoutMs: 20000 }) : { items: [] };
    const baseRates = todo.length ? protectiveRates(await readEventsWindow(o, cfg.rollbackAfterDays, nowMs, 15000)) : {};

    for (const e of todo) {
      if (timeUp()) { res.errors.push('timeout'); break; }
      const kind = e.evolve_kind || 'rule';
      const target = e.evolve_target || null;
      const cand = scan.items.find((x) => x.fp === e.fp);
      const guess = { kind, target: target || (cand ? `evolve/rules/evolve-${cand.id}.json` : 'evolve/rules/x.json'), text: `${e.message || ''}` };
      const cl = classifyChange(guess);
      if (cl.level === 0) { res.refused.push({ entry: e.id, reason: cl.reason }); notes.set(e.id, { status: 'refused', reason: cl.reason }); continue; }
      const needsModel = !!e.needs_model;
      const toQueue = cl.level === 2 || cfg.autonomy < 1 || (needsModel && st.week.modelCalls >= cfg.maxModelCallsWeek);
      if (!cand && !target) { res.errors.push(`${e.id}: khong co candidate cho fp (het hieu luc?)`); continue; }
      // Oracle tren su kien cu cua fp (muc 1 va hang cho deu can kem ket qua oracle).
      const oc = cand ? oracleRule(ruleDef(cand), e.fp, scan.items) : { ok: false, reason: 'khong co candidate' };
      if (cl.level === 1 && !oc.ok) { res.refused.push({ entry: e.id, reason: `oracle loai: ${oc.reason}` }); notes.set(e.id, { status: 'refused', reason: `oracle loai: ${oc.reason}` }); continue; }
      const plan = { entry: e.id, fp: e.fp, kind, level: toQueue ? 2 : cl.level, oracle: oc.ok ? 'pass' : oc.reason };
      if (dry) { res.planned.push(plan); continue; }
      if (st.week.proposals >= 10 * cfg.maxProposals) break;
      st.week.proposals++;
      let p = null;
      if (cand && ['rule', 'inject', 'skill'].includes(kind)) {
        try { p = await propose(cand.id, { ...o, kind, ...(target ? { target } : {}) }); } catch (err) { res.errors.push(`${e.id}: ${err.message}`); continue; }
        if (p.status === 'blocked') { res.refused.push({ entry: e.id, reason: p.policy.reason }); notes.set(e.id, { status: 'refused', reason: p.policy.reason }); continue; }
        const ck = check(p.id, o); if (!ck.check.ok) { res.refused.push({ entry: e.id, reason: ck.check.reason }); notes.set(e.id, { status: 'refused', reason: ck.check.reason }); continue; }
      }
      if (!toQueue && p) {
        const r = apply(p.id, { ...o, approve: true }); // autopilot LA cong duyet cua muc 1 (bang phan muc tat dinh); policy van chan cam
        if (!r.ok) { res.errors.push(`apply ${p.id}: ${r.reason}`); notes.set(e.id, { status: 'refused', reason: r.reason }); continue; }
        st.applied.push({ pid: p.id, ver: r.ver, fp: e.fp, entry_id: e.id, ts: new Date(nowMs).toISOString(), count_before: cand.count, rates_before: baseRates, status: 'applied', target: r.target });
        res.applied.push({ ...plan, ver: r.ver, target: r.target }); notes.set(e.id, { status: 'applied', ver: r.ver });
      } else {
        const item = { id: `q_${e.fp.replace(/[^A-Za-z0-9]+/g, '').slice(0, 12)}_${kind}`, pid: p && p.id, fp: e.fp, entry_id: e.id, kind, level: 2, target: p ? p.change.target : target, reason: cl.reason, oracle: plan.oracle, ts: new Date(nowMs).toISOString(), status: 'pending' };
        if (queue.length < cfg.maxQueue && !queue.some((q) => q.id === item.id && q.status === 'pending')) queue.push(item);
        res.queued.push({ ...plan, id: item.id }); notes.set(e.id, { status: 'queued', reason: item.reason, queue: item.id });
      }
    }
    if (!dry) {
      st.applied = st.applied.slice(-cfg.maxApplied);
      wr(f(o, 'state.json'), st); wr(f(o, 'review-queue.json'), queue);
      try { annotate(o, notes); } catch {}
    }
  } finally { if (lock) try { fs.rmSync(lock, { force: true }); } catch {} }
  return res;
}

// ---- hang cho (review-queue): nguoi duyet theo lo, approve chi qua TTY ----
export function confirmTty(msg, opts) {
  if (opts.confirm) return Promise.resolve(!!opts.confirm(msg));
  const tty = opts.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) return Promise.resolve(null);
  return import('node:readline').then((rl) => new Promise((res) => {
    const i = rl.createInterface({ input: process.stdin, output: process.stdout });
    i.question(`${msg} [yes/N] `, (a) => { i.close(); res(/^y(es)?$/i.test(a.trim())); });
  }));
}

/** queue: {list} | {approve:id} | {reject:id}. Approve can TTY (agent khong tu duyet); muc 0 van bi policy tu choi. */
export async function queueOp(o = {}) {
  const queue = readQueue(o);
  if (!o.approve && !o.reject) return { code: 0, items: queue.filter((q) => q.status === 'pending'), total: queue.length };
  const id = o.approve || o.reject; const q = queue.find((x) => x.id === id);
  if (!q) return { code: 1, reason: `khong co muc ${id}` };
  if (q.status !== 'pending') return { code: 1, reason: `muc ${id} da ${q.status}` };
  const save = () => wr(f(o, 'review-queue.json'), queue);
  if (o.reject) { q.status = 'rejected'; q.decided = new Date().toISOString(); save(); return { code: 0, id, status: 'rejected' }; }
  const cl = classifyChange({ kind: q.kind, target: q.target });
  if (cl.level === 0) return { code: 3, reason: `tu choi: ${cl.reason}` };
  const ok = await confirmTty(`Duyet ${q.id} (${q.kind} -> ${q.target}; oracle: ${q.oracle})?`, o);
  if (ok === null) return { code: 2, reason: 'queue --approve: can TTY de xac nhan (agent khong tu duyet)' };
  if (!ok) return { code: 1, reason: 'khong dong y' };
  let out = { manual: true };
  if (q.pid) { const r = apply(q.pid, { ...o, approve: true }); if (!r.ok) return { code: r.code || 1, reason: r.reason }; out = { ver: r.ver, target: r.target }; }
  q.status = 'approved'; q.decided = new Date().toISOString(); if (out.ver) q.ver = out.ver; save();
  return { code: 0, id, status: 'approved', ...out };
}

/** Che do CLI/spawn: node autopilot.mjs [--dry-run] [--force]; timeout cung. */
export async function main(argv = process.argv.slice(2)) {
  bgDoneOnExit();
  const hard = setTimeout(() => { console.error('evolve-autopilot: timeout cung'); process.exit(3); }, (CFG.timeoutS + 10) * 1000);
  try { const r = await runAutopilot({ dryRun: argv.includes('--dry-run'), force: argv.includes('--force') }); console.log(JSON.stringify(r)); clearTimeout(hard); return 0; } catch (e) { console.error('evolve-autopilot:', e.message); clearTimeout(hard); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => process.exit(c));
