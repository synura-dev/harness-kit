// observe/cost: tom tat tat dinh token/chi phi theo model/role/ngay/phien (chi DOC audit, khong phan doan).
// Nguon du lieu: audit v2 data/audit/date=D/type=subagent (SubagentStop: model, turns, tokens_in/out, data.tokens_cache; thoi luong = Stop.ts - Start.ts
// cung agent_id) va type=session (Stop cua main: model + tokens TICH LUY theo phien -> lay ban ghi cuoi moi phien). Khong doc transcript.
// tokens_in = input khong cache; tokens_cache = token doc cache (khong gom cache-creation: audit khong ghi). Cost uoc tinh, gia cap nhat tay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAuditEvents, collectJsonlFiles } from '../../core/audit/scan.mjs';
import { loadConfig } from '../../core/config/config.mjs';
import { auditRoot, auditReadRoots } from '../../core/audit/audit-write.mjs';

export const LIMITS = Object.freeze({ timeoutMs: 10000, readMaxBytes: 64 * 1048576, topLimit: 10, maxLines: 40, since: '7d' });
export const BY = Object.freeze(['model', 'role', 'day', 'session']);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = ['type=subagent', 'type=session'];

const num = (v) => (Number.isFinite(v) ? v : 0);
const hasTok = (e) => Number.isFinite(e.tokens_in) || Number.isFinite(e.tokens_out);

/** '7d' | '24h' | 'YYYY-MM-DD' | ISO -> ISO string (UTC) hoac throw. */
export function sinceToIso(s, now = Date.now()) {
  const v = String(s || LIMITS.since).trim();
  const m = /^(\d+)([dh])$/.exec(v);
  if (m) return new Date(now - Number(m[1]) * (m[2] === 'd' ? 86400000 : 3600000)).toISOString();
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v) && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  throw new Error(`--since khong hop le: ${v} (vd 7d, 24h, 2026-10-29)`);
}

/** Alias model: haiku|sonnet|opus tu id day du, khac -> null. */
export const aliasOf = (model) => { const s = String(model || '').toLowerCase(); return ['haiku', 'sonnet', 'opus'].find((a) => s.includes(a)) || null; };

function loadCostConfig(opts = {}) {
  let defaults = {};
  try { defaults = JSON.parse(fs.readFileSync(path.join(HERE, 'cost.config.json'), 'utf8')); } catch { /* thieu -> rong */ }
  try { return loadConfig('cost', { defaults, configDir: opts.configDir }).config; } catch { return defaults; }
}

/** Chinh sach model theo role qua loadConfig("models"); khong co -> null (bo co cheaper_possible). */
function loadPolicy(opts = {}) {
  try {
    const c = loadConfig('models', { configDir: opts.configDir }).config;
    return c && c.roles && typeof c.roles === 'object' && Object.keys(c.roles).length ? c : null;
  } catch { return null; }
}

/** Gia {in,out,cache} cho model: id day du truoc, roi alias. */
function priceOf(model, cfg) {
  const p = cfg && cfg.prices;
  return (p && (p[model] || p[aliasOf(model)])) || null;
}

/** Chi phi USD uoc tinh hoac null neu thieu gia cho thanh phan co token. */
export function costOf(run, cfg) {
  const p = priceOf(run.model, cfg);
  if (!p) return null;
  let t = 0;
  for (const [tok, k] of [[run.tokens_in, 'in'], [run.tokens_out, 'out'], [run.tokens_cache, 'cache']]) {
    if (!tok) continue;
    if (!Number.isFinite(p[k])) return null;
    t += (tok * p[k]) / 1e6;
  }
  return t;
}

/** Co cheaper_possible: role co chinh sach va model da dung dat hon model chinh sach. */
export function cheaperPossible(run, policy, cfg) {
  const rank = (cfg && cfg.rank) || {};
  const pol = policy && policy.roles && policy.roles[run.role];
  const want = pol && aliasOf(pol.model);
  const used = aliasOf(run.model);
  if (!want || !used || !rank[want] || !rank[used]) return false;
  return rank[used] > rank[want];
}

function dateDirs(root, sinceIso) {
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => /^date=\d{4}-\d{2}-\d{2}$/.test(n)); } catch { return []; }
  const d0 = sinceIso.slice(0, 10);
  return names.filter((n) => n.slice(5) >= d0).sort().reverse();
}

const dirBytes = (dir) => collectJsonlFiles(dir).reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);

/** Doc audit -> runs[] {kind,ts,day,sid,role,model,turns,tokens_*,dur_ms,agent_id}. Tran byte + timeout; truncated: timeout|max_bytes|null. */
export async function collectRuns(o = {}) {
  const root = o.root || auditRoot();
  const sinceIso = sinceToIso(o.since);
  const deadline = Date.now() + (o.timeoutMs > 0 ? o.timeoutMs : LIMITS.timeoutMs);
  let budget = o.readMaxBytes > 0 ? o.readMaxBytes : LIMITS.readMaxBytes;
  let truncated = null;
  const starts = new Map(); const subs = new Map(); const mains = new Map();
  let scanned = 0;
  const roots = o.root ? [root] : auditReadRoots();
  const pairs = roots.flatMap((rt) => dateDirs(rt, sinceIso).map((dn) => [rt, dn])).sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  outer: for (const [rt, dn] of pairs) {
    for (const t of TYPES) {
      const dir = path.join(rt, dn, t);
      if (!fs.existsSync(dir)) continue;
      const size = dirBytes(dir);
      const r = await readAuditEvents(dir, budget, deadline);
      budget -= Math.min(budget, size);
      scanned += r.scannedEvents;
      for (const e of r.events) {
        if (e.event === 'SubagentStart' && e.agent_id) starts.set(e.agent_id, e.ts);
        else if (e.event === 'SubagentStop' && e.agent_id && hasTok(e) && String(e.ts) >= sinceIso) subs.set(e.agent_id, e);
        else if (e.type === 'session' && e.event === 'Stop' && e.actor === 'main' && e.sid && hasTok(e) && String(e.ts) >= sinceIso) {
          const p = mains.get(e.sid);
          if (!p || num(e.turns) > num(p.turns) || (num(e.turns) === num(p.turns) && String(e.ts) > String(p.ts))) mains.set(e.sid, e);
        }
      }
      if (r.truncated) { truncated = r.truncated; break outer; }
    }
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
  }
  const mk = (e, kind) => {
    const d = e.data || {};
    const st = kind === 'sub' ? starts.get(e.agent_id) : null;
    const dur = st && Date.parse(e.ts) >= Date.parse(st) ? Date.parse(e.ts) - Date.parse(st) : (Number.isFinite(e.dur_ms) ? e.dur_ms : null);
    return { kind, ts: e.ts, day: String(e.ts).slice(0, 10), sid: e.sid || null, agent_id: e.agent_id || null,
      role: kind === 'sub' ? (e.agent_type || 'unknown') : 'main', model: e.model || null, turns: Number.isFinite(e.turns) ? e.turns : null,
      tokens_in: num(e.tokens_in), tokens_out: num(e.tokens_out), tokens_cache: num(d.tokens_cache), dur_ms: dur };
  };
  const runs = [...[...subs.values()].map((e) => mk(e, 'sub')), ...[...mains.values()].map((e) => mk(e, 'main'))];
  return { runs, truncated, scanned, since: sinceIso };
}

const key = (r, by) => (by === 'model' ? r.model || 'unknown' : by === 'role' ? r.role : by === 'day' ? r.day : r.sid || 'unknown');

/** Gom nhom: {groups[], total, by}. cost = tong neu moi run co gia, nguoc lai null (cost_missing = so run thieu gia). */
function aggregateRuns(runs, by, cfg, policy) {
  const g = new Map();
  const blank = (k) => ({ key: k, runs: 0, turns: 0, tokens_in: 0, tokens_out: 0, tokens_cache: 0, cost: 0, cost_missing: 0, cheaper_possible: 0 });
  const add = (a, r) => {
    const c = costOf(r, cfg);
    a.runs++; a.turns += num(r.turns); a.tokens_in += r.tokens_in; a.tokens_out += r.tokens_out; a.tokens_cache += r.tokens_cache;
    if (c === null) a.cost_missing++; else a.cost += c;
    if (cheaperPossible(r, policy, cfg)) a.cheaper_possible++;
  };
  const total = blank('total');
  for (const r of runs) { const k = key(r, by); if (!g.has(k)) g.set(k, blank(k)); add(g.get(k), r); add(total, r); }
  const fin = (a) => ({ ...a, cost: a.cost_missing === 0 && a.runs > 0 ? Math.round(a.cost * 1e6) / 1e6 : null });
  const tok = (a) => a.tokens_in + a.tokens_out + a.tokens_cache;
  const groups = [...g.values()].map(fin).sort((a, b) => tok(b) - tok(a) || String(a.key).localeCompare(String(b.key)));
  return { by, groups, total: fin(total) };
}

const ctx = (o) => ({ cfg: o.cfg || loadCostConfig(o), policy: o.policy === undefined ? loadPolicy(o) : o.policy });

export async function summary(o = {}) {
  const { cfg, policy } = ctx(o);
  const by = o.by || 'model';
  if (!BY.includes(by)) throw new Error(`--by phai la ${BY.join('|')}`);
  const c = await collectRuns(o);
  return { ...aggregateRuns(c.runs, by, cfg, policy), since: c.since, scanned: c.scanned, truncated: c.truncated, policy: !!policy,
    priced: !!(cfg && cfg.prices && Object.values(cfg.prices).some((p) => p && Number.isFinite(p.out))) };
}

export async function top(o = {}) {
  const { cfg, policy } = ctx(o);
  const c = await collectRuns(o);
  const items = c.runs.map((r) => {
    const x = { ts: r.ts, kind: r.kind, role: r.role, model: r.model, sid: r.sid, agent_id: r.agent_id, turns: r.turns,
      tokens_in: r.tokens_in, tokens_out: r.tokens_out, tokens_cache: r.tokens_cache, dur_ms: r.dur_ms, cost: costOf(r, cfg) };
    if (policy) x.cheaper_possible = cheaperPossible(r, policy, cfg);
    return x;
  });
  const tok = (x) => x.tokens_in + x.tokens_out + x.tokens_cache;
  items.sort((a, b) => ((b.cost ?? -1) - (a.cost ?? -1)) || (tok(b) - tok(a)) || String(a.ts).localeCompare(String(b.ts)));
  const limit = o.limit > 0 ? o.limit : LIMITS.topLimit;
  return { items: items.slice(0, limit), total: items.length, since: c.since, scanned: c.scanned, truncated: c.truncated, policy: !!policy };
}
