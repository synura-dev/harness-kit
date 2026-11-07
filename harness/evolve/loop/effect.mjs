// Do hieu qua rule sau apply: rate loi cua nhom fp / 1000 tool call, truoc vs sau. Chi do, khong ghi, khong rollback.
// Tai dung: nestedDateDirs/ctx (loop.mjs), collectJsonlFiles (scan.mjs), gom nhom fp cua candidates.mjs, isHookRun, limits audit-config.
// shortcut: doc audit DONG BO (apply la ham dong bo, readAuditEvents la async); nhom fp < 2 su kien trong cua so duoc tinh 0 (candidates.mjs chi phat nhom >= 2).
import fs from 'node:fs';
import path from 'node:path';
import { collectJsonlFiles } from '../../core/audit/scan.mjs';
import { repeatedFailureCandidates } from '../../core/audit/candidates.mjs';
import { isHookRun } from '../../core/audit/signals.mjs';
import { loadAuditConfig } from '../../core/config/audit-config.mjs';
import { ctx, nestedDateDirs } from './loop.mjs';

const DAY = 86400000;
const EPS = 1e-9;
export const EFFECT = Object.freeze({ windowDays: 7, better: 0.7, worse: 1.3, minToolCalls: 200, minBaselineErrors: 3, maxRecheckDays: 21, sidePct: 0.3 });
const FINAL = new Set(['better', 'worse', 'unchanged', 'inconclusive']);
const SIDE = ['tokens_per_session', 'corrections_per_session'];
const iso = (ms) => new Date(ms).toISOString();

function limitsOf(o) {
  let cfg = {};
  try { cfg = loadAuditConfig().config; } catch {}
  return { retention_days: cfg.retention_days || 30, timeout: 30000, rows: 100000, bytes: 209715200, ...(cfg.limits && { timeout: cfg.limits.query_timeout_ms, rows: cfg.limits.query_max_rows, bytes: cfg.limits.query_max_bytes }),
    ...(o.limits && { ...(o.limits.query_timeout_ms && { timeout: o.limits.query_timeout_ms }), ...(o.limits.query_max_rows && { rows: o.limits.query_max_rows }), ...(o.limits.query_max_bytes && { bytes: o.limits.query_max_bytes }) }) };
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

/** Thong ke mot cua so tren cac su kien da doc (thuan). */
export function statsOf(events, fp, fromMs, toMs) {
  const win = events.filter((e) => { const t = Date.parse(e.ts); return t >= fromMs && t <= toMs; });
  const calls = win.filter((e) => e.type === 'tool' && !isHookRun(e) && (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure'));
  const group = repeatedFailureCandidates(win, iso(toMs)).find((c) => c._fp === fp || (c._legacy || []).includes(fp));
  const target = group ? group.evidenceCount : 0;
  const sids = new Set(calls.map((e) => e.sid || '-'));
  const stops = win.filter((e) => e.event === 'Stop' && !isHookRun(e));
  const tok = stops.reduce((s, e) => s + (Number(e.tokens_in) || 0) + (Number(e.tokens_out) || 0), 0);
  const corr = calls.filter((e) => e.data && (e.data.signal === 'correction' || e.data.signal === 'interrupt')).length;
  return {
    window_days: Math.round((toMs - fromMs) / DAY * 100) / 100, from: iso(fromMs), to: iso(toMs), target_count: target, tool_calls: calls.length,
    rate_per_1000: calls.length ? (target * 1000) / calls.length : null, sessions: sids.size,
    tokens_per_session: stops.length ? tok / stops.length : null, corrections_per_session: sids.size ? corr / sids.size : null,
  };
}

/** Doc audit roi tinh mot cua so (dung cho baseline luc apply). auditDir: thu muc audit hoac mang. */
export function computeWindow(auditDir, fp, fromMs, toMs, o = {}) {
  const { events, truncated } = readEvents([].concat(auditDir).map((d) => path.resolve(d)), fromMs, toMs, o);
  return { ...statsOf(events, fp, fromMs, toMs), truncated };
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

const ACTION = { better: 'keep', inconclusive: 'keep', unchanged: 'rollback', worse: 'rollback', insufficient: 'none' };

function appliedMs(p, o) {
  const t = Date.parse(p.applied_at || (p.effect && p.effect.baseline && p.effect.baseline.to));
  if (Number.isFinite(t)) return t;
  try { // fallback: dong apply ok cuoi cung trong applied.jsonl
    const lines = fs.readFileSync(path.join(ctx(o).evo, 'applied.jsonl'), 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) { const r = JSON.parse(lines[i]); if (r.op === 'apply' && r.ok && r.id === p.id) return Date.parse(r.ts); }
  } catch {}
  return NaN;
}

/** Baseline luc apply: 7 ngay truoc nowMs. Tra {baseline} hoac {baseline:null, reason}. Khong nem. */
export function captureBaseline(p, nowMs, o = {}) {
  try {
    const fp = p.evidence && p.evidence.fp;
    if (!fp) return { baseline: null, reason: 'no_fp' };
    const w = computeWindow(ctx(o).audits, fp, nowMs - EFFECT.windowDays * DAY, nowMs, o);
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
  const from = Math.min(...due.map((d) => (d.retro ? d.at - EFFECT.windowDays * DAY : d.afterFrom)));
  const { events, truncated } = readEvents(ctx(o).audits, from, nowMs, o);
  return due.map(({ p, at, afterFrom, retro }) => {
    const fp = p.evidence && p.evidence.fp;
    const after = statsOf(events, fp, afterFrom, nowMs);
    const baseline = (p.effect && p.effect.baseline) || (retro ? statsOf(events, fp, at - EFFECT.windowDays * DAY, at) : null);
    const ageDays = (nowMs - at) / DAY;
    const v = !baseline ? { verdict: 'insufficient', reason: 'no_baseline', side: [] }
      : truncated ? { verdict: ageDays > EFFECT.maxRecheckDays ? 'inconclusive' : 'insufficient', reason: 'truncated', side: [] }
      : verdictOf(baseline, after, { ageDays });
    return { id: p.id, effect: { metric: 'target_rate_per_1000', baseline, after, verdict: v.verdict, reason: v.reason, measured_at: iso(nowMs), action: ACTION[v.verdict], side: v.side, ...(truncated ? { truncated } : {}) } };
  });
}
