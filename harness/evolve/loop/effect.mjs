// Do hieu qua rule sau apply: rate loi cua nhom fp / 1000 tool call, truoc vs sau. Chi do, khong ghi, khong rollback.
// Tai dung: nestedDateDirs/ctx (loop.mjs), collectJsonlFiles (scan.mjs), gom nhom fp cua candidates.mjs, isHookRun, limits audit-config.
// shortcut: doc audit DONG BO (apply la ham dong bo, readAuditEvents la async); captureBaseline trong apply co the chan toi timeout doc (30s) moi rule.
// Gom nhom: chay repeatedFailureCandidates MOT lan tren moi su kien da doc (nhan doi su kien loi bang ban sao __dup de nhom 1 loi van duoc phat), roi dem su kien goc theo ts tung cua so.
import fs from 'node:fs';
import path from 'node:path';
import { collectJsonlFiles } from '../../core/audit/scan.mjs';
import { repeatedFailureCandidates } from '../../core/audit/candidates.mjs';
import { extractErrorDetails } from '../../core/audit/signature.mjs';
import { messageFingerprint } from '../../core/audit/normalize-message.mjs';
import { isHookRun } from '../../core/audit/signals.mjs';
import { loadAuditConfig } from '../../core/config/audit-config.mjs';
import { ctx, nestedDateDirs } from './loop.mjs';

const DAY = 86400000;
const EPS = 1e-9;
export const EFFECT = Object.freeze({ windowDays: 7, better: 0.7, worse: 1.3, minToolCalls: 200, minBaselineErrors: 10, maxRecheckDays: 21, sidePct: 0.3 });
const FINAL = new Set(['better', 'worse', 'unchanged', 'inconclusive']);
const SIDE = ['tokens_per_session', 'corrections_per_session'];
const iso = (ms) => new Date(ms).toISOString();

function limitsOf(o) {
  let cfg = o.auditConfig; // inject (test hermetic); mac dinh doc audit-config that
  if (!cfg) { cfg = {}; try { cfg = loadAuditConfig().config; } catch {} }
  const pick = (...v) => v.find((x) => x > 0); // tung truong mac dinh rieng: thieu/0 khong tat gioi han
  const c = cfg.limits || {}, u = o.limits || {};
  return { retention_days: pick(o.retentionDays, cfg.retention_days, 30), timeout: pick(u.query_timeout_ms, c.query_timeout_ms, 30000), rows: pick(u.query_max_rows, c.query_max_rows, 100000), bytes: pick(u.query_max_bytes, c.query_max_bytes, 209715200) };
}

/** Doc MOT luot cac su kien audit co ts trong [fromMs, toMs]. Tra {events, truncated: null|'timeout'|'max_rows'|'max_bytes'}. */
export function readEvents(audits, fromMs, toMs, o = {}) {
  const L = limitsOf(o);
  const deadline = Date.now() + L.timeout;
  const fromDate = iso(fromMs).slice(0, 10), toDate = iso(toMs).slice(0, 10);
  const events = [];
  let truncated = null, rows = 0, bytes = 0;
  if (typeof o.onRead === 'function') o.onRead();
  outer: for (const { date, dir } of audits.flatMap(nestedDateDirs)) {
    if (date < fromDate || date > toDate) continue;
    for (const f of collectJsonlFiles(dir)) {
      if (Date.now() > deadline) { truncated = 'timeout'; break outer; }
      let size = 0; try { size = fs.statSync(f).size; } catch { continue; }
      if (bytes + size > L.bytes) { truncated = 'max_bytes'; break outer; }
      bytes += size;
      let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (++rows > L.rows) { truncated = 'max_rows'; break outer; }
        let e; try { e = JSON.parse(line); } catch { continue; }
        const t = Date.parse(e && e.ts);
        if (Number.isFinite(t) && t >= fromMs && t <= toMs) events.push(e);
      }
    }
  }
  return { events, truncated };
}

const mfpOf = (e) => { const d = e.data && typeof e.data === 'object' ? e.data : {}; try { return messageFingerprint(extractErrorDetails(e), e.tool || d.tool || 'unknown'); } catch { return null; } };

/** Gom nhom loi MOT lan: [{c, evs}] (evs = su kien goc, gom ca nhom 1 loi). */
export function groupIndex(events, nowMs) {
  const errs = events.filter((e) => e.ok === false && !isHookRun(e));
  const idx = repeatedFailureCandidates(events.concat(errs.map((e) => ({ ...e, __dup: true }))), iso(nowMs)).map((c) => ({ c, evs: c._evs.filter((e) => !e.__dup) }));
  // Map fp -> nhom (nhom dau thang): _fp, _legacy, error_fp va mfp cua moi su kien -> tra cuu O(1) moi proposal
  const byFp = new Map();
  for (const g of idx) {
    const keys = [g.c._fp, ...(g.c._legacy || [])];
    for (const e of g.evs) keys.push(e.data && e.data.error_fp, mfpOf(e));
    for (const k of keys) if (k && !byFp.has(k)) byFp.set(k, g);
  }
  idx.byFp = byFp;
  return idx;
}
/** Su kien loi cua nhom chua fp (on dinh khi bien the mfp nho hon xuat hien). */
export function groupEvents(idx, fp) {
  const g = idx.byFp.get(fp);
  return g ? g.evs : [];
}

/** Thong ke mot cua so tren cac su kien da doc; gevs = su kien loi cua nhom fp (groupEvents). */
export function statsOf(events, gevs, fromMs, toMs) {
  const inWin = (e) => { const t = Date.parse(e.ts); return t >= fromMs && t <= toMs; };
  const win = events.filter(inWin);
  const calls = win.filter((e) => e.type === 'tool' && !isHookRun(e) && (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure'));
  const target = gevs.filter(inWin).length;
  const sids = new Set(calls.map((e) => e.sid || '-'));
  const stops = win.filter((e) => e.event === 'Stop' && !isHookRun(e));
  // data.usage_mode (audit.mjs:293,300): cumulative -> lay max theo sid; delta/thieu -> cong don
  const perSid = new Map();
  for (const e of stops) {
    const k = e.sid || '-', n = (Number(e.tokens_in) || 0) + (Number(e.tokens_out) || 0);
    const s = perSid.get(k) || { sum: 0, max: 0 };
    if (e.data && e.data.usage_mode === 'cumulative') s.max = Math.max(s.max, n); else s.sum += n;
    perSid.set(k, s);
  }
  const tok = [...perSid.values()].reduce((t, s) => t + s.sum + s.max, 0);
  const stopSids = new Set(perSid.keys());
  // signal correction nam tren UserPromptSubmit, interrupt tren tool event: dem moi su kien (khong HookRun) co signal
  const corr = win.filter((e) => !isHookRun(e) && e.data && (e.data.signal === 'correction' || e.data.signal === 'interrupt')).length;
  return {
    window_days: Math.round((toMs - fromMs) / DAY * 100) / 100, from: iso(fromMs), to: iso(toMs), target_count: target, tool_calls: calls.length,
    rate_per_1000: calls.length ? (target * 1000) / calls.length : null, sessions: sids.size,
    tokens_per_session: stopSids.size ? tok / stopSids.size : null, corrections_per_session: sids.size ? corr / sids.size : null,
  };
}

/** Doc audit roi tinh mot cua so (dung cho baseline luc apply). auditDir: thu muc audit hoac mang. */
export function computeWindow(auditDir, fp, fromMs, toMs, o = {}) {
  const { events, truncated } = readEvents([].concat(auditDir).map((d) => path.resolve(d)), fromMs, toMs, o);
  return { ...statsOf(events, groupEvents(groupIndex(events, toMs), fp), fromMs, toMs), truncated };
}

/** So sanh baseline vs after tren rate_per_1000. ageDays = tuoi ke tu apply; qua maxRecheckDays ma van thieu mau -> inconclusive. */
export function verdictOf(baseline, after, { ageDays = 0 } = {}) {
  const side = SIDE.filter((k) => baseline[k] > 0 && after[k] != null && after[k] >= baseline[k] * (1 + EFFECT.sidePct) - EPS);
  let reason = null;
  if (!(baseline.target_count >= EFFECT.minBaselineErrors) || !(baseline.rate_per_1000 > 0)) reason = 'low_baseline';
  else if (!(after.tool_calls >= EFFECT.minToolCalls) || after.rate_per_1000 == null) reason = 'low_tool_calls';
  if (reason) return { verdict: ageDays > EFFECT.maxRecheckDays ? 'inconclusive' : 'insufficient', reason, side };
  const b = baseline.rate_per_1000, a = after.rate_per_1000;
  const verdict = a <= b * EFFECT.better + EPS ? 'better' : a >= b * EFFECT.worse - EPS ? 'worse' : 'unchanged';
  return { verdict, reason: `rate ${b.toFixed(2)} -> ${a.toFixed(2)} /1000`, side };
}

const ACTION = { better: 'keep', inconclusive: 'keep', unchanged: 'keep', worse: 'rollback', insufficient: 'none' }; // chi worse moi rollback; unchanged = giu, verdict cuoi

const APPLIED_TAIL = 1048576;
function appliedMs(p, o) {
  const t = Date.parse(p.applied_at || (p.effect && p.effect.baseline && p.effect.baseline.to));
  if (Number.isFinite(t)) return t;
  try { // fallback: dong apply ok cuoi cung trong applied.jsonl
    // doc tail co tran (shortcut: dong apply cu hon tran -> NaN, proposal khong do)
    const fd = fs.openSync(path.join(ctx(o).evo, 'applied.jsonl'), 'r');
    let text = '';
    try { const size = fs.fstatSync(fd).size, n = Math.min(size, APPLIED_TAIL); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n); text = b.toString('utf8'); } finally { fs.closeSync(fd); }
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let r; try { r = JSON.parse(lines[i]); } catch { continue; } // dong hong/bi cat dau: bo qua
      const t = r && r.op === 'apply' && r.ok && r.id === p.id ? Date.parse(r.ts) : NaN;
      if (Number.isFinite(t)) return t;
    }
  } catch {}
  return NaN;
}

/** Doc san cua so baseline cho nhieu apply: tra {events, truncated, fromMs, toMs} de truyen o.auditCache. */
export function readBaselineCache(nowMs, o = {}) {
  const fromMs = nowMs - EFFECT.windowDays * DAY;
  return { ...readEvents(ctx(o).audits, fromMs, nowMs, o), fromMs, toMs: nowMs };
}

/** Baseline luc apply: 7 ngay truoc nowMs. Tra {baseline} hoac {baseline:null, reason}. Khong nem. */
export function captureBaseline(p, nowMs, o = {}) {
  try {
    const fp = p.evidence && p.evidence.fp;
    if (!fp) return { baseline: null, reason: 'no_fp' };
    const from = nowMs - EFFECT.windowDays * DAY, c = o.auditCache; // auditCache = ket qua readEvents doc san (autopilot doc MOT lan/lo)
    const w = c && c.fromMs <= from && c.toMs >= nowMs ? { ...statsOf(c.events, groupEvents(groupIndex(c.events, nowMs), fp), from, nowMs), truncated: c.truncated }
      : computeWindow(ctx(o).audits, fp, from, nowMs, o);
    if (w.truncated) return { baseline: null, reason: 'truncated' };
    const { truncated, ...baseline } = w;
    return { baseline };
  } catch (e) { return { baseline: null, reason: `error: ${String(e.message).slice(0, 80)}` }; }
}

/** Proposal rule da apply, chua co verdict cuoi, da den han -> [{id, effect}]. MOT luot doc audit. Khong ghi. */
export function measureDue(proposals, now, o = {}) {
  const nowMs = typeof now === 'number' ? now : Number(now) || Date.now();
  const L = limitsOf(o);
  const due = [];
  for (const p of proposals) {
    if (!p || p.kind !== 'rule' || p.status !== 'applied') continue;
    if (p.effect && FINAL.has(p.effect.verdict)) continue;
    const at = appliedMs(p, o);
    if (!Number.isFinite(at) || nowMs < at + EFFECT.windowDays * DAY) continue;
    const afterFrom = Math.max(at, nowMs - EFFECT.windowDays * DAY);
    const retro = !(p.effect && p.effect.baseline) && at - EFFECT.windowDays * DAY >= nowMs - L.retention_days * DAY;
    due.push({ p, at, afterFrom, retro });
  }
  if (!due.length) return [];
  const audits = ctx(o).audits;
  // shortcut: audit rat lon (> query_max_rows trong 7 ngay) -> luot chinh luon truncated, proposal giu insufficient mai va bi doc lai moi lan chay.
  const A = readEvents(audits,Math.min(...due.map((d) => d.afterFrom)), nowMs, o); // luot chinh: cua so after
  const idxA = groupIndex(A.events, nowMs);
  // Baseline tinh bu doc o luot rieng (gioi han theo khoang cua chung) de khong keo cua so luot chinh ve 30 ngay truoc.
  const retros = due.filter((d) => d.retro);
  const B = retros.length ? readEvents(audits, Math.min(...retros.map((d) => d.at - EFFECT.windowDays * DAY)), Math.max(...retros.map((d) => d.at)), o) : null;
  const idxB = B && groupIndex(B.events, nowMs);
  return due.map(({ p, at, afterFrom, retro }) => {
    const fp = p.evidence && p.evidence.fp;
    const after = statsOf(A.events, groupEvents(idxA, fp), afterFrom, nowMs);
    const bFrom = at - EFFECT.windowDays * DAY;
    const baseline = (p.effect && p.effect.baseline) || (retro && !B.truncated ? statsOf(B.events, groupEvents(idxB, fp), bFrom, at) : null);
    const truncated = A.truncated || (retro && B.truncated) || null;
    const ageDays = (nowMs - at) / DAY;
    const v = truncated ? { verdict: 'insufficient', reason: 'truncated', side: [] } // cat luon insufficient, khong chot
      : !baseline ? { verdict: ageDays > EFFECT.maxRecheckDays ? 'inconclusive' : 'insufficient', reason: 'no_baseline', side: [] }
      : verdictOf(baseline, after, { ageDays });
    return { id: p.id, effect: { metric: 'target_rate_per_1000', ver: p.ver || null, baseline, after, verdict: v.verdict, reason: v.reason, measured_at: iso(nowMs), action: ACTION[v.verdict], side: v.side, ...(truncated ? { truncated } : {}) } };
  });
}
