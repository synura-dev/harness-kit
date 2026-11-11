// Tu ha cap rule evolve vo ich: 14 ngay warned >= 5, acted == 0, ignored/warned >= 0.5.
// Do autopilot ap -> rollback (loop.rollback); ap tay -> chi ghi demote_suggested. Bo qua protected / mac dinh plugin / rule du an (chi rule evolve/rules/evolve-*.json).
// demoteRules thuan; demoteRun la wrapper I/O (guard 24h, tran 10 rule, timeout 10s). Goi tu observe/ledger/job.mjs sau autopilot.
import path from 'node:path';
import { readJson, guardWrite } from '../../core/io/storage.mjs';
import fs from 'node:fs';
import { rollback, appendLog, ctx, listProposals } from './loop.mjs';
import { readState, apDir } from './autopilot.mjs';
import { readLedger, ledgerFile } from '../../observe/ledger/ledger.mjs';

const DAY = 86400000;
export const DEMOTE = Object.freeze({ days: 14, minWarned: 5, ignoredRatio: 0.5, maxPerRun: 10, guardHours: 24, timeoutMs: 10000 });
const EVOLVE_RULE = /^(?:[^/]+\/)*evolve\/rules\/evolve-[^/]+\.json$/; // khong khop .harness/rules, rule mac dinh plugin, guard

/** Thuan. rules: [{pid, ver, fp, entry_id?, target, source, protected?, autopilot}]. Tra [{action:'rollback'|'suggest', pid, ver, fp, warned, ignored}]. */
export function demoteRules({ ledgerEntries = [], rules = [], nowMs = Date.now(), cfg = DEMOTE } = {}) {
  const since = nowMs - cfg.days * DAY;
  const inWin = (t) => { const ms = Date.parse(t); return Number.isFinite(ms) && ms >= since && ms <= nowMs; };
  const out = [];
  for (const r of rules) {
    if (out.length >= cfg.maxPerRun) break;
    if (r.protected || r.source !== 'evolve' || !EVOLVE_RULE.test(String(r.target || ''))) continue;
    const e = ledgerEntries.find((x) => (r.entry_id && x.id === r.entry_id) || (r.fp && x.fp === r.fp));
    if (!e) continue;
    const warned = (e.warn_ts || []).filter(inWin).length;
    const acted = e.acted && inWin(e.acted) ? 1 : 0;
    const ignored = e.ignored && inWin(e.ignored) ? Number(e.ignored_count) || 0 : 0;
    if (warned < cfg.minWarned || acted > 0 || ignored / warned < cfg.ignoredRatio) continue;
    out.push({ action: r.autopilot ? 'rollback' : 'suggest', pid: r.pid, ver: r.ver, fp: r.fp, warned, ignored });
  }
  return out;
}

/** Tu state.applied (autopilot) + de xuat rule da ap (tay). */
function collectRules(o) {
  const st = readState(o);
  const ap = new Map(st.applied.filter((a) => a.status === 'applied' && a.ver).map((a) => [a.pid, a]));
  const rules = [...ap.values()].map((a) => ({ pid: a.pid, ver: a.ver, fp: a.fp, entry_id: a.entry_id, target: a.target, source: 'evolve', autopilot: true }));
  for (const p of listProposals(o, 1000)) {
    if (p.kind !== 'rule' || p.status !== 'applied' || ap.has(p.id)) continue;
    rules.push({ pid: p.id, ver: p.ver, fp: p.evidence && p.evidence.fp, target: p.change && p.change.target, source: 'evolve', autopilot: false });
  }
  return rules;
}

/** Wrapper I/O. Tra {rolledBack[], suggested[], errors[], skipped?, truncated?}. o co the inject: ledgerEntries, rules, rollbackFn, logFn, stateFile, nowMs. */
export function demoteRun(o = {}) {
  const nowMs = Number(o.nowMs) || Date.now();
  const res = { rolledBack: [], suggested: [], errors: [] };
  const sf = o.stateFile || path.join(apDir(o), 'demote-state.json');
  const last = Number((readJson(sf, {}) || {}).lastRun);
  if (last && nowMs - last < DEMOTE.guardHours * 3600e3) return { ...res, skipped: 'guard-24h' };
  const deadline = Date.now() + DEMOTE.timeoutMs;
  const log = o.logFn || ((rec) => appendLog(ctx(o), rec));
  const rb = o.rollbackFn || ((ver) => rollback(ver, { ...o, approve: true, force: false })); // khong --force: dich bi sua tay thi de nguoi
  const entries = o.ledgerEntries || readLedger(o.ledgerFile || ledgerFile(o.dataOpts));
  const todo = demoteRules({ ledgerEntries: entries, rules: o.rules || collectRules(o), nowMs });
  for (const d of todo) {
    if (Date.now() > deadline) { res.truncated = 'timeout'; break; }
    if (d.action === 'rollback') {
      const r = rb(d.ver);
      if (r && r.ok) { res.rolledBack.push(d.pid); log({ op: 'demote', id: d.pid, ver: d.ver, ok: true, warned: d.warned, ignored: d.ignored }); }
      else res.errors.push(`${d.pid}: ${(r && r.reason) || 'rollback loi'}`);
    } else { res.suggested.push(d.pid); log({ op: 'demote_suggested', id: d.pid, ver: d.ver, warned: d.warned, ignored: d.ignored }); }
  }
  if (!res.truncated && guardWrite(sf).ok) { try { fs.mkdirSync(path.dirname(sf), { recursive: true }); fs.writeFileSync(sf, JSON.stringify({ lastRun: nowMs }) + '\n'); } catch {} }
  return res;
}
