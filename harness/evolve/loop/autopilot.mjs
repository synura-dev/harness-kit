// Autopilot tien hoa: ledger (open/warned, action=propose) -> de xuat -> phan muc tat dinh.
//   Tu ap dung (muc 1): CHI luat canh bao (file JSON evolve/rules/evolve-*.json), rollback duoc; do hieu qua sau >= 7 ngay (effect.mjs: rate/1000 call, truoc vs sau), CHI worse (va autonomy >= 1, luat do autopilot ap) -> tu rollback.
//   Moi thu khac (inject, skill, code, delete, gate) -> hang cho TTY (muc 2). Cam (muc 0): guard/approval/bash-guard/data-gate/model-policy, push/deploy.
// KHONG goi model. Toi da 1 lan/24h, timeout cung, khoa chong chay trung. Chi import core + evolve (hop dong import).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, dataPathFor, guardWrite } from '../../core/io/storage.mjs';
import { findCandidates, propose, check, apply, rollback, ctx, classifyTarget, listProposals, appendLog } from './loop.mjs';
import { measureDue, readBaselineCache, EFFECT } from './effect.mjs';
import { bgDoneOnExit } from '../../core/runtime/proc.mjs';
import { withLock } from '../../core/runtime/lockfile.mjs';

export const CFG = Object.freeze({
  intervalHours: 24, timeoutS: 100, maxProposals: 5,
  autonomy: 1, // 0 = chi xep hang (khong tu ap gi); 1 = tu ap luat canh bao, con lai xep hang
  oracleDays: 30, lockStaleS: 300, maxQueue: 200, maxApplied: 100,
});
const H = 3600e3, DAY = 86400000;

// ---- phan muc tat dinh ----
export const LEVEL_BY_KIND = Object.freeze({ rule: 1, inject: 2, skill: 2, code: 2, delete: 2, gate: 2 });
// Muc 0: cam tuyet doi (kem ke ca khi nguoi duyet qua hang: nguoi phai tu sua tay).
const GATE_PATH = /(^|\/)(guard|approval|bash-guard|data-gate|model-policy)(\/|\.|-|$)|^harness\/(constrain|hooks)(\/|$)|^config\/(approval|guard|hub|model-policy|data-gate)/i;
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
  if (lv === 1 && !/^(?:[^/]+\/)*rules\/evolve-[^/]+\.json$/.test(rel)) return { level: 2, reason: `muc 1 chi file luat evolve-*.json, dich ${rel} -> cho duyet` };
  return { level: lv, reason: lv === 1 ? 'chi them luat canh bao' : `${kind} -> cho duyet` };
}

// ---- trang thai ----
export const apDir = (o = {}) => path.join(ctx(o).evo, 'autopilot');
const f = (o, n) => path.join(apDir(o), n);
const wr = (file, j) => { const g = guardWrite(file); if (!g.ok) return false; fs.mkdirSync(path.dirname(file), { recursive: true }); const t = `${file}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(j, null, 2) + '\n'); fs.renameSync(t, file); return true; };
const weekKey = (ms) => Math.floor(ms / (7 * DAY));
export const readState = (o) => { const s = readJson(f(o, 'state.json'), {}) || {}; return { applied: [], week: { key: 0, proposals: 0 }, ...s }; };
export const readQueue = (o) => { const q = readJson(f(o, 'review-queue.json'), []); return Array.isArray(q) ? q : []; };

/** Due: >= intervalHours tu lan chay cuoi. Dung cho hook kick (doc nhanh). */
export function autopilotDue(o = {}, nowMs = Date.now(), cfg = CFG) {
  const last = Number(readState(o).lastRun);
  return !(last && nowMs - last < cfg.intervalHours * H);
}

// shortcut: khoa kieu wx + xoa khoa cu (stale) co race nho khi hai lo cung thay khoa het han; chap nhan (lo chay <= 1/24h).
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
  const file = ledgerPath(o);
  const g = guardWrite(file); if (!g.ok) return;
  // doc-sua-ghi duoi CUNG khoa file voi observe/ledger (updateLedger): <ledger>.lock; khong lay duoc khoa -> bo qua lan chu thich nay
  withLock(file, () => {
    const es = readLedgerRaw(file); if (!es.length) return;
    const ts = new Date().toISOString();
    const out = es.map((e) => (notes.has(e.id) ? { ...e, evolve: { ts, ...notes.get(e.id) } } : e));
    const t = `${file}.${process.pid}.tmp`; fs.writeFileSync(t, out.map((e) => JSON.stringify(e)).join('\n') + '\n'); fs.renameSync(t, file);
  }, { retries: 40, waitMs: 25 });
}

const shaOf = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** Moc 'applying' mo coi (crash giua apply va luu state): neu dich da la after cua de xuat -> hoan tat co kiem (manifest+de xuat+moc 'applied'); khong thi bo moc (apply tu khoi phuc khi loi). */
export function recoverApplying(o, st) {
  const notes = []; let changed = false; const c = ctx(o);
  for (const a of st.applied) {
    if (a.status !== 'applying') continue;
    changed = true; a.status = 'abandoned';
    try {
      const pj = path.join(c.evo, 'proposals', `${a.pid}.json`); const p = readJson(pj, null);
      const vroot = path.join(c.evo, 'versions'); let man = null, mf = null;
      for (const d of fs.readdirSync(vroot).sort().reverse()) { const m = readJson(path.join(vroot, d, 'manifest.json'), null); if (m && m.id === a.pid) { man = m; mf = path.join(vroot, d, 'manifest.json'); break; } }
      if (!p || !man || !p.change) { notes.push(`moc applying mo coi ${a.pid}: bo (khong thay version/de xuat)`); continue; }
      const cur = pol(p, o); const now = cur ? fs.readFileSync(cur) : null;
      if (!now || shaOf(now) !== p.change.after_sha) { notes.push(`moc applying mo coi ${a.pid}: dich khong la ban after, bo moc`); continue; }
      man.after_sha = p.change.after_sha; man.status = 'applied'; fs.writeFileSync(mf, JSON.stringify(man, null, 2) + '\n');
      p.status = 'applied'; p.ver = man.ver; fs.writeFileSync(pj, JSON.stringify(p, null, 2) + '\n');
      a.ver = man.ver; a.status = 'applied'; notes.push(`moc applying mo coi ${a.pid}: hoan tat co kiem (ver ${man.ver})`);
    } catch (e) { notes.push(`recover ${a.pid}: ${e.message}`); }
  }
  return { changed, notes };
}
const pol = (p, o) => { const r = classifyTarget(p.change.target, p.kind, o); return r.ok ? r.abs : null; };

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
    const save = () => { if (wr(f(o, 'state.json'), st)) return true; res.errors.push('khong ghi duoc state.json (guard/IO)'); return false; };
    if (!dry) { st.lastRun = nowMs; if (!save()) return res; } // chiem moc ngay: loi giua chung cung khong chay lai trong 24h
    if (!dry) { const rec = recoverApplying(o, st); if (rec.changed) { res.errors.push(...rec.notes); save(); } }
    if (weekKey(nowMs) !== st.week.key) st.week = { key: weekKey(nowMs), proposals: 0 };
    // effect -> proposal JSON (nguon su that) + dong op:effect. Doc lai tu dia (rollback dong thoi khong bi ghi de); chi ghi khi verdict/ly do doi.
    const record = (p, effect) => {
      const e = effect.truncated && !(p.effect && p.effect.baseline) ? { ...effect, baseline: null } : effect; // khong luu baseline hoi to bi cat
      if (p.effect && p.effect.verdict === e.verdict && p.effect.reason === e.reason) return true;
      const pf = path.join(ctx(o).evo, 'proposals', `${p.id}.json`);
      const fresh = readJson(pf, null);
      if (!fresh || fresh.status !== 'applied') return false;
      if (!wr(pf, { ...fresh, effect: e })) { res.errors.push(`khong ghi duoc effect ${p.id} (guard/IO)`); return false; }
      appendLog(ctx(o), { op: 'effect', id: p.id, ver: p.ver, verdict: e.verdict, action: e.action, reason: e.reason });
      p.effect = e; // ban doc trong lan chay nay (dung cho loai fp o buoc 2)
      return true;
    };
    const refuseRoll = (p, reason) => { res.refused.push({ entry: p.id, reason }); appendLog(ctx(o), { op: 'rollback', id: p.id, ver: p.ver, ok: false, reason }); };

    // 1) Do hieu qua luat da ap (effect.mjs, MOT luot doc audit): proposal.effect la nguon su that; keep/rollback theo verdict.
    // Do ca luat ap tay (chu y). shortcut: luat muc 2 chi ghi effect, khong tu rollback.
    // Timeout doc audit theo audit-config (loadAuditConfig dien san query_timeout_ms 30000), nen mac dinh nen o.bgTimeoutMs khong bao gio thang config.
    // shortcut: chua co timeout rieng cho duong nen (job.mjs); muon thi truyen o.limits.query_timeout_ms tu call site.
    const eo = o;
    let auditCache = null; // doc audit MOT lan/lo cho baseline cua moi luat vua ap
    // shortcut: doc MOT lan toi da 1000 de xuat gan nhat (dung cho do + loai fp); vuot tran thi de xuat cu nhat roi khoi pham vi.
    const all = listProposals(o, 1000);
    const pend = all.filter((p) => p.kind === 'rule' && p.status === 'applied');
    const blockOf = (p, effect) => { // ly do khong duoc tu rollback (null = duoc)
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(String(p.ver))) return 'ver khong hop le';
      const m = readJson(path.join(ctx(o).evo, 'versions', p.ver, 'manifest.json'), null);
      if (!m || m.id !== p.id) return `${effect.verdict}: manifest khong khop de xuat`;
      if (classifyChange({ kind: m.kind, target: m.target }).level !== 1 || classifyChange({ kind: p.kind, target: p.change && p.change.target }).level !== 1) return `${effect.verdict}: rollback can nguoi (khong phai muc 1)`;
      return null;
    };
    // Chi rollback khi worse (effect.mjs), chi luat do autopilot tu ap (co trong state.applied) va autonomy >= 1; luat ap tay/autonomy 0: ghi effect + refused de nguoi quyet.
    const whyNot = (p, effect, a) => (cfg.autonomy < 1 ? 'autonomy<1: khong tu rollback' : !a ? `${effect.verdict}: luat ap tay, nguoi quyet dinh rollback` : blockOf(p, effect));
    const RB_MAX = 3; // rollback that bai: ghi effect.rollback_error/attempts, thu lai o lan chay sau toi da RB_MAX roi de nguoi
    const patchEffect = (p, patch) => {
      const pf = path.join(ctx(o).evo, 'proposals', `${p.id}.json`); const fresh = readJson(pf, null);
      if (!fresh || fresh.status !== 'applied') return;
      const e = { ...(fresh.effect || {}), ...patch };
      if (wr(pf, { ...fresh, effect: e })) p.effect = e;
    };
    const due = pend.length ? measureDue(pend, nowMs, eo) : [];
    const retry = pend.filter((p) => p.effect && p.effect.verdict === 'worse' && p.effect.rollback_error && (p.effect.rollback_attempts || 0) < RB_MAX).map((p) => ({ id: p.id, effect: p.effect }));
    for (const { id, effect } of [...due, ...retry]) {
      if (timeUp()) { res.errors.push('timeout'); break; }
      const p = pend.find((x) => x.id === id);
      const a = st.applied.find((x) => x.pid === id);
      const who = { ver: p.ver, fp: p.evidence && p.evidence.fp };
      const roll = effect.action === 'rollback';
      if (dry) { if (roll) { const why = whyNot(p, effect, a); if (why) res.refused.push({ entry: p.id, reason: why, dry: true }); else res.rolledBack.push({ ...who, reason: effect.reason, verdict: effect.verdict, dry: true }); } else if (effect.action === 'keep') res.kept.push({ ...who, verdict: effect.verdict, dry: true }); continue; }
      if (!record(p, effect)) continue;
      if (effect.action === 'keep') { res.kept.push({ ...who, verdict: effect.verdict }); if (a) a.status = 'kept'; continue; }
      if (!roll) continue; // insufficient: do lai lan sau
      // chi tu rollback luat muc 1 va manifest khop de xuat (khong tin ver trong file de xuat)
      const why = whyNot(p, effect, a);
      if (why) {
        refuseRoll(p, why);
        if (effect.rollback_error) patchEffect(p, { rollback_attempts: (effect.rollback_attempts || 0) + 1 }); // retry bi tu choi cung tinh la lan thu: khong log vo han
        if (!a || cfg.autonomy < 1) { // luat ap tay worse: nhac nguoi dung qua chu thich ledger (cung kenh voi rollback cua autopilot)
          const le = (o.ledgerEntries || readLedgerRaw(ledgerPath(o))).find((x) => x.fp && x.fp === who.fp);
          if (le) notes.set(le.id, { status: 'worse', reason: `rule ${p.id} worse: consider evolve rollback ${p.ver}`, ver: p.ver });
        }
        continue;
      }
      const r = rollback(p.ver, { ...o, approve: true, force: false }); // --force cua autopilot chi bo cong 24h, khong bo kiem "dich bi sua tay"
      if (a) { a.status = r.ok ? 'rolled_back' : 'rollback_failed'; a.reason = r.ok ? effect.reason : r.reason; }
      if (!r.ok) {
        const n = (effect.rollback_attempts || 0) + 1;
        patchEffect(p, { rollback_error: String(r.reason).slice(0, 200), rollback_attempts: n });
        if (n >= RB_MAX) appendLog(ctx(o), { op: 'rollback', id: p.id, ver: p.ver, ok: false, reason: `bo sau ${n} lan that bai, can nguoi xu ly: ${r.reason}` });
      }
      (r.ok ? res.rolledBack : res.errors).push(r.ok ? { ...who, reason: effect.reason, verdict: effect.verdict } : `rollback ${p.ver}: ${r.reason}`);
      if (a && a.entry_id) notes.set(a.entry_id, { status: r.ok ? 'rolled_back' : 'rollback_failed', reason: a.reason, ver: p.ver });
    }

    // 2) Muc ledger can de xuat.
    const entries = o.ledgerEntries || readLedgerRaw(ledgerPath(o));
    // fp bi rollback do hieu qua 'worse' khong de xuat lai trong EFFECT.excludeDays ngay ke tu luc do.
    const byEffect = all.filter((p) => p.kind === 'rule' && p.status === 'rolled_back' && p.effect && p.effect.verdict === 'worse' && !(nowMs - Date.parse(p.effect.measured_at) >= EFFECT.excludeDays * DAY));
    const badPids = new Set(byEffect.map((p) => p.id));
    const ruleBad = new Set([...byEffect.map((p) => p.evidence && p.evidence.fp), ...st.applied.filter((a) => badPids.has(a.pid)).map((a) => a.fp)]); // chi loai kind rule
    const taken = new Set([
      ...st.applied.filter((a) => ['applied', 'kept'].includes(a.status)).map((a) => a.fp), ...queue.filter((q) => q.status === 'pending').map((q) => q.fp)]);
    const todo = entries.filter((e) => ['open', 'warned'].includes(e.status) && e.action === 'propose' && e.fp && !taken.has(e.fp) && !((e.evolve_kind || 'rule') === 'rule' && ruleBad.has(e.fp))
      && !notes.has(e.id) && !(e.evolve && ['applied', 'queued', 'refused', 'worse'].includes(e.evolve.status))).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, cfg.maxProposals);
    const scan = todo.length ? await findCandidates({ ...o, days: cfg.oracleDays, threshold: 1, nowMs, timeoutMs: 20000 }) : { items: [] };

    for (const e of todo) {
      if (timeUp()) { res.errors.push('timeout'); break; }
      const kind = e.evolve_kind || 'rule';
      const target = e.evolve_target || null;
      const cand = scan.items.find((x) => x.fp === e.fp);
      const guess = { kind, target: target || (cand ? `evolve/rules/evolve-${cand.id}.json` : 'evolve/rules/x.json'), text: `${e.message || ''}` };
      const cl = classifyChange(guess);
      if (cl.level === 0) { res.refused.push({ entry: e.id, reason: cl.reason }); notes.set(e.id, { status: 'refused', reason: cl.reason }); continue; }
      const toQueue = cl.level === 2 || cfg.autonomy < 1;
      if (!cand && !target) { res.errors.push(`${e.id}: khong co candidate cho fp (het hieu luc?)`); continue; }
      const plan = { entry: e.id, fp: e.fp, kind, level: toQueue ? 2 : cl.level };
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
        // Ghi moc 'applying' (fp, dich, count truoc) vao state TRUOC khi apply: crash giua chung van con moc de rollback/hoan tat.
        const rec = { pid: p.id, ver: null, fp: e.fp, entry_id: e.id, ts: new Date(nowMs).toISOString(), status: 'applying', target: p.change.target };
        st.applied.push(rec);
        if (!save()) { st.applied.pop(); notes.set(e.id, { status: 'refused', reason: 'khong ghi duoc moc applying' }); continue; }
        auditCache ||= readBaselineCache(nowMs, eo);
        const r = apply(p.id, { ...o, nowMs, auditCache, approve: true }); // autopilot LA cong duyet cua muc 1 (bang phan muc tat dinh); policy van chan cam
        if (!r.ok) { st.applied.pop(); save(); res.errors.push(`apply ${p.id}: ${r.reason}`); notes.set(e.id, { status: 'refused', reason: r.reason }); continue; }
        rec.ver = r.ver; rec.status = 'applied'; rec.target = r.target;
        if (!save()) { res.errors.push(`${p.id}: da ap (ver ${r.ver}) nhung chua luu moc 'applied'; lan chay sau se hoan tat tu moc applying`); }
        res.applied.push({ ...plan, ver: r.ver, target: r.target }); notes.set(e.id, { status: 'applied', ver: r.ver });
      } else {
        const item = { id: `q_${e.fp.replace(/[^A-Za-z0-9]+/g, '').slice(0, 12)}_${kind}`, pid: p && p.id, fp: e.fp, entry_id: e.id, kind, level: 2, target: p ? p.change.target : target, after_sha: p ? p.change.after_sha : null, reason: cl.reason, ts: new Date(nowMs).toISOString(), status: 'pending' };
        if (queue.length < cfg.maxQueue && !queue.some((q) => q.id === item.id && q.status === 'pending')) queue.push(item);
        res.queued.push({ ...plan, id: item.id }); notes.set(e.id, { status: 'queued', reason: item.reason, queue: item.id });
      }
    }
    if (!dry) {
      st.applied = st.applied.slice(-cfg.maxApplied);
      save(); if (!wr(f(o, 'review-queue.json'), queue)) res.errors.push('khong ghi duoc review-queue.json (guard/IO)');
      try { annotate(o, notes); } catch {}
    }
  } finally { if (lock) try { fs.rmSync(lock, { force: true }); } catch {} }
  return res;
}

// ---- hang cho (review-queue): nguoi duyet theo lo, approve chi qua TTY ----
const isTestEnv = () => process.env.NODE_ENV === 'test'; // bun test tu dat NODE_ENV=test; ngoai test opts.confirm bi bo qua
export function confirmTty(msg, opts) {
  if (opts.confirm && isTestEnv()) return Promise.resolve(!!opts.confirm(msg));
  const tty = opts.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) return Promise.resolve(null);
  return import('node:readline').then((rl) => new Promise((res) => {
    const i = rl.createInterface({ input: process.stdin, output: process.stdout });
    i.question(`${msg} [yes/N] `, (a) => { i.close(); res(/^y(es)?$/i.test(a.trim())); });
  }));
}

const PREVIEW_LINES = 40;
/** Doc change.after cua de xuat gan muc hang: {text, sha} (sha tinh lai tu noi dung that). */
function afterOf(o, q) {
  if (!q.pid || !/^[A-Za-z0-9_.-]{1,80}$/.test(q.pid)) return { text: null, sha: null };
  const p = readJson(path.join(ctx(o).evo, 'proposals', `${q.pid}.json`), null);
  const text = p && p.change && typeof p.change.after === 'string' ? p.change.after : null;
  return { text, sha: text == null ? null : crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
}

/** queue: {list} | {approve:id} | {reject:id}. Approve can TTY (agent khong tu duyet); muc 0 van bi policy tu choi. */
export async function queueOp(o = {}) {
  const queue = readQueue(o);
  if (!o.approve && !o.reject) return { code: 0, items: queue.filter((q) => q.status === 'pending').map((q) => { const a = afterOf(o, q); return { ...q, sha: a.sha, after_preview: a.text == null ? null : a.text.split('\n').slice(0, PREVIEW_LINES).join('\n'), after_truncated: a.text != null && a.text.split('\n').length > PREVIEW_LINES }; }), total: queue.length };
  const id = o.approve || o.reject; const q = queue.find((x) => x.id === id);
  if (!q) return { code: 1, reason: `khong co muc ${id}` };
  if (q.status !== 'pending') return { code: 1, reason: `muc ${id} da ${q.status}` };
  const save = () => wr(f(o, 'review-queue.json'), queue);
  if (o.reject) { q.status = 'rejected'; q.decided = new Date().toISOString(); save(); return { code: 0, id, status: 'rejected' }; }
  const cl = classifyChange({ kind: q.kind, target: q.target });
  if (cl.level === 0) return { code: 3, reason: `tu choi: ${cl.reason}` };
  // Gan sha: noi dung nguoi duyet thay phai la noi dung luc xep hang.
  const now = afterOf(o, q);
  if (q.pid) {
    if (!q.after_sha) return { code: 4, reason: 'muc hang khong co sha luc xep hang; xep lai' };
    if (now.sha !== q.after_sha) return { code: 4, reason: `noi dung de xuat doi sau khi xep hang (sha ${String(now.sha).slice(0, 12)} != ${String(q.after_sha).slice(0, 12)})` };
  }
  const shown = now.text == null ? '' : `\n--- noi dung (${PREVIEW_LINES} dong dau, sha256 ${now.sha}) ---\n${now.text.split('\n').slice(0, PREVIEW_LINES).join('\n')}\n---`;
  const ok = await confirmTty(`Duyet ${q.id} (${q.kind} -> ${q.target})?${shown}`, o);
  if (ok === null) return { code: 2, reason: 'queue --approve: can TTY de xac nhan (agent khong tu duyet)' };
  if (!ok) return { code: 1, reason: 'khong dong y' };
  let out = { manual: true };
  if (!isTestEnv() && !(o.isTTY ?? process.stdin.isTTY)) return { code: 2, reason: 'queue --approve: can TTY de ap dung muc 2' };
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
