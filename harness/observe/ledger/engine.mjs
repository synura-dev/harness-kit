// Engine luat khai bao: 1 dinh nghia = 1 file JSON. Them luat = them file, khong sua code.
// Dinh nghia: {id?, desc?, enabled?, source:'candidates'|'audit'|'ledger', days?, filter?, group_by?, metric?, threshold, action, cooldown_hours?, message?}
//   filter: {field: gia_tri | [gia_tri..] | {not:..} | {gte:n} | {regex:'..'}} hoac {any:[filter..]}; "$hub" = thu muc hub (scope).
//   metric: count (mac dinh) | sessions | sum:cost_ms. action: log|warn|propose|report.
// Quy uoc thu muc: mac dinh trong defaults/ ; <project>/.harness/rules/*.json CUNG TEN thi THAY (enabled:false = tat). Khong registry, khong config bat buoc.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dataPathFor } from '../../core/io/storage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS_DIR = path.join(HERE, 'defaults');
export const LIMITS = Object.freeze({ timeoutMs: 5000, maxDefs: 50, maxFileBytes: 32768, maxFindings: 200 });
export const SOURCES = Object.freeze(['candidates', 'audit', 'ledger']);
export const ACTIONS = Object.freeze(['log', 'warn', 'propose', 'report']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DAY = 86400000;
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const lc = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Kiem mot dinh nghia; tra mang loi. */
export function validateDef(d) {
  const e = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['dinh nghia phai la object'];
  if (!SOURCES.includes(d.source)) e.push(`source phai thuoc ${SOURCES.join('|')}`);
  if (!ACTIONS.includes(d.action)) e.push(`action phai thuoc ${ACTIONS.join('|')}`);
  if (!(Number(d.threshold) >= 0)) e.push('threshold phai la so >= 0');
  if (d.metric != null && !/^(count|sessions|sum:[a-z_]+)$/.test(String(d.metric))) e.push('metric khong hop le');
  if (d.group_by != null && !Array.isArray(d.group_by)) e.push('group_by phai la mang');
  if (d.cooldown_hours != null && !(Number(d.cooldown_hours) >= 0)) e.push('cooldown_hours phai la so >= 0');
  if (d.min_sessions != null && !(Number(d.min_sessions) >= 0)) e.push('min_sessions phai la so >= 0');
  if (d.allow_paths != null && !(Array.isArray(d.allow_paths) && d.allow_paths.every((x) => typeof x === 'string'))) e.push('allow_paths phai la mang string (glob tuong doi goc hub)');
  return e;
}

/** Nap dinh nghia: defaults/*.json, de len boi <project>/.harness/rules/*.json cung ten. Tra {defs, errors, truncated}. */
export function loadDefinitions({ defaultsDir = DEFAULTS_DIR, projectDir = null, evolveDir, timeoutMs = LIMITS.timeoutMs, maxDefs = LIMITS.maxDefs } = {}) {
  const deadline = Date.now() + timeoutMs;
  const map = new Map(); const errors = []; let truncated = null;
  const readDir = (dir, origin) => {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return; }
    for (const n of names) {
      if (Date.now() > deadline) { truncated = 'timeout'; return; }
      if (map.size >= maxDefs && !map.has(n)) { truncated = truncated || 'max_defs'; continue; }
      try {
        const f = path.join(dir, n);
        if (fs.statSync(f).size > LIMITS.maxFileBytes) throw new Error('file qua lon');
        const t = fs.readFileSync(f, 'utf8');
        const j = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
        if (j && j.enabled === false) { map.delete(n); continue; } // tat bang ghi de
        const errs = validateDef(j);
        if (errs.length) { errors.push({ file: f, errors: errs }); continue; }
        map.set(n, { ...j, id: j.id || n.replace(/\.json$/, ''), origin });
      } catch (err) { errors.push({ file: path.join(dir, n), errors: [String(err && err.message || err)] }); }
    }
  };
  readDir(defaultsDir, 'default');
  // Luat do evolve ap dung: <dataDir>/evolve/rules/*.json (uu tien: defaults < evolve/rules < <project>/.harness/rules). evolveDir=null -> tat.
  if (evolveDir !== null) { let ed = evolveDir; if (ed === undefined) { try { ed = dataPathFor('evolve', 'rules', { quiet: true }); } catch { ed = null; } } if (ed) readDir(ed, 'evolve'); }
  if (projectDir) readDir(path.join(projectDir, '.harness', 'rules'), 'project');
  return { defs: [...map.values()], errors, truncated };
}

// ---- truong ao cua su kien audit ----
const absPath = (p, cwd) => (/^([a-z]:)?[\\/]/i.test(p) ? lc(p) : lc(path.posix.normalize(`${lc(cwd)}/${String(p).replace(/\\/g, '/')}`)));
const globRe = (g) => new RegExp('^' + lc(g).replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*') + '$');
/** Moi file cua su kien deu khop 1 glob allow_paths (tuong doi goc hub)? Khong co file -> false (van tinh). */
export function allowedByPaths(rec, globs, hubDir) {
  const files = rec.data && Array.isArray(rec.data.files_touched) ? rec.data.files_touched : [];
  const hub = lc(hubDir);
  if (!files.length || !hub || !Array.isArray(globs) || !globs.length) return false;
  const res = globs.map(globRe);
  return files.every((f) => { const p = absPath(f, rec.cwd || ''); if (!(p === hub || p.startsWith(hub + '/'))) return false; const rel = p.slice(hub.length + 1); return res.some((r) => r.test(rel)); });
}
function resolveScope(rec, hubDir) {
  const hub = lc(hubDir);
  const abs = absPath;
  const inHub = (p) => p === hub || p.startsWith(hub + '/');
  const files = rec.data && Array.isArray(rec.data.files_touched) ? rec.data.files_touched : [];
  const target = files[0] ? abs(files[0], rec.cwd || '') : lc(rec.cwd || '');
  if (!hub || !target) return 'unknown';
  if (!inHub(target)) return 'other';
  return /\/projects\/[^/]+\/repo(\/|$)/.test(target) ? 'other' : 'hub';
}

/** Gia tri truong (that + ao) cua mot su kien audit. */
export function auditField(rec, field, ctx = {}) {
  const d = rec.data || {};
  switch (field) {
    case 'actor': return rec.actor || (rec.agent_id || rec.agent_type ? 'sub' : 'main');
    case 'tool': return rec.tool || d.tool;
    case 'kind': return d.verify_kind ?? rec.kind ?? null;
    case 'signal': return rec.signal ?? d.signal ?? null;
    case 'project': return rec.project ?? null;
    case 'sid': return rec.sid || rec.session_id || null;
    case 'event': return rec.event;
    case 'ok': return rec.ok;
    case 'scope': return resolveScope(rec, ctx.hubDir);
    case 'edit': return EDIT_TOOLS.has(rec.tool) && rec.event === 'PostToolUse' && rec.ok !== false;
    default: return rec[field] ?? d[field];
  }
}

const norm = (v, ctx) => (v === '$hub' ? ctx.hubDir : v);
function matchOne(val, cond, ctx) {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('not' in cond) return !matchOne(val, cond.not, ctx);
    if ('gte' in cond) return Number(val) >= Number(cond.gte);
    if ('regex' in cond) { try { return new RegExp(cond.regex, 'i').test(String(val ?? '')); } catch { return false; } }
    return false;
  }
  if (Array.isArray(cond)) return cond.some((c) => matchOne(val, c, ctx));
  return val === norm(cond, ctx) || (typeof val === 'boolean' ? String(val) === String(cond) : false);
}

/** rec khop filter? get(field) -> gia tri. */
export function matchFilter(get, filter, ctx = {}) {
  if (!filter || typeof filter !== 'object') return true;
  if (Array.isArray(filter.any)) return filter.any.some((f) => matchFilter(get, f, ctx));
  return Object.entries(filter).every(([k, c]) => matchOne(get(k), c, ctx));
}

const fmt = (tpl, vars) => String(tpl || '{rule}: {key} {value}').replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k]))).replace(/\s+/g, ' ').trim().slice(0, 200);

function finish(def, key, g) {
  const value = g.value;
  return {
    rule: def.id, fp: g.fp, key, value, count: g.count, sessions: g.sessions, first_ts: g.first_ts, last_ts: g.last_ts, sample: g.sample || '',
    action: def.action, cooldown_hours: def.cooldown_hours ?? 24, occ: (g.occ || []).slice(-50),
    message: fmt(def.message, { rule: def.id, key, count: g.count, sessions: g.sessions, value, sample: g.sample || '', days: def.days ?? 7 }),
  };
}
const passes = (def, value) => value >= Number(def.threshold);
const metricOf = (def, g) => { const m = def.metric || 'count'; return m === 'count' ? g.count : m === 'sessions' ? g.sessions : g.cost; };

/** Danh gia 1 dinh nghia tren dau vao {events, candidates, ledger} -> finding[]. ctx: {hubDir, nowMs}. */
export function evaluate(def, inputs = {}, ctx = {}) {
  const now = ctx.nowMs || Date.now();
  const from = now - (def.days > 0 ? def.days : 7) * DAY;
  const inWin = (ts) => { const t = Date.parse(ts); return !Number.isFinite(t) || t >= from; };
  const gb = Array.isArray(def.group_by) && def.group_by.length ? def.group_by : null;
  const groups = new Map();
  const add = (key, rec, n, sid, ts, cost, sample, occ, fp) => {
    let g = groups.get(key);
    if (!g) { g = { count: 0, sids: new Set(), cost: 0, first_ts: null, last_ts: null, sample: '', occ: [], fp }; groups.set(key, g); }
    g.count += n; if (sid != null) g.sids.add(sid); g.cost += cost || 0;
    if (ts) { if (!g.first_ts || ts < g.first_ts) g.first_ts = ts; if (!g.last_ts || ts >= g.last_ts) { g.last_ts = ts; if (sample) g.sample = sample; } }
    if (occ) g.occ.push(...occ); else if (sid != null || ts) g.occ.push({ sid, ts });
  };
  if (def.source === 'audit') {
    for (const rec of inputs.events || []) {
      if (!rec || !inWin(rec.ts)) continue;
      const get = (k) => auditField(rec, k, ctx);
      if (!matchFilter(get, def.filter, ctx)) continue;
      if (def.allow_paths && allowedByPaths(rec, def.allow_paths, ctx.hubDir)) continue; // ngoai le khai bao trong luat
      const key = (gb || ['all']).map((k) => (k === 'all' ? 'all' : String(get(k) ?? '-'))).join('|');
      add(key, rec, 1, get('sid'), rec.ts, Number(rec.duration_ms ?? (rec.data && rec.data.duration_ms)) || 0,
        `${rec.tool || ''} ${String(rec.target || '').split('\n')[0].slice(0, 120)}`.trim(), null, `${def.id}:${hash(key)}`);
    }
  } else if (def.source === 'candidates') {
    for (const c of inputs.candidates || []) {
      if (!c || !inWin(c.last_ts)) continue;
      const get = (k) => c[k];
      if (!matchFilter(get, def.filter, ctx)) continue;
      const key = gb ? gb.map((k) => String(get(k) ?? '-')).join('|') : c.fp;
      const g0 = groups.get(key);
      add(key, c, c.count || 0, null, c.last_ts, c.cost_ms, c.sample, c.occ, gb ? `${def.id}:${hash(key)}` : c.fp);
      const g = groups.get(key); g.sessMax = Math.max(g0 ? g0.sessMax : 0, c.sessions || 0); g.sessSum = (g0 ? g0.sessSum : 0) + (c.sessions || 0);
      if (!g.first_ts || (c.first_ts && c.first_ts < g.first_ts)) g.first_ts = c.first_ts || g.first_ts;
    }
  } else if (def.source === 'ledger') {
    for (const e of inputs.ledger || []) {
      const get = (k) => e[k];
      if (!matchFilter(get, def.filter, ctx)) continue;
      const key = (gb || ['all']).map((k) => (k === 'all' ? 'all' : String(get(k) ?? '-'))).join('|');
      add(key, e, 1, e.rule, e.last_seen, 0, e.message, null, `${def.id}:${hash(key)}`);
    }
  }
  const out = [];
  for (const [key, g] of groups) {
    const sessions = g.sessSum != null ? g.sessSum : g.sids.size;
    const gg = { ...g, sessions };
    const value = metricOf(def, gg);
    if (passes(def, value) && !(Number(def.min_sessions) > 0 && sessions < Number(def.min_sessions))) out.push(finish(def, key, { ...gg, value }));
    if (out.length >= LIMITS.maxFindings) break;
  }
  return out.sort((a, b) => b.value - a.value);
}

/** Chay tat ca dinh nghia (tru nguon ledger neu inputs.ledger khong co). Tra finding[]. */
export function evaluateAll(defs, inputs, ctx, sources = SOURCES) {
  return defs.filter((d) => sources.includes(d.source)).flatMap((d) => evaluate(d, inputs, ctx));
}
