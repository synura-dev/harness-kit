// Engine bao cao khai bao: muc JSON (defaults/*.json, ghi de <project>/.harness/report/<ten>.json, {"enabled":false} de tat) -> markdown.
// Khong hardcode tung muc. Chiu thieu field (gia tri thieu = bo qua). Tai dung auditField/matchFilter cua engine luat.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditField, matchFilter } from '../ledger/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS_DIR = path.join(HERE, 'defaults');
export const LIMITS = Object.freeze({ timeoutMs: 5000, maxDefs: 50, maxFileBytes: 32768, maxRows: 200 });
export const SOURCES = Object.freeze(['audit', 'candidates', 'ledger', 'inventory']);
export const FORMATS = Object.freeze(['table', 'kpi', 'list']);
const DAY = 86400000;

export function validateSection(d) {
  const e = [];
  if (!d || typeof d !== 'object') return ['muc khong phai object'];
  if (typeof d.id !== 'string' || !d.id) e.push('id bat buoc');
  if (!SOURCES.includes(d.source)) e.push(`source phai thuoc ${SOURCES.join('|')}`);
  if (d.format && !FORMATS.includes(d.format)) e.push(`format phai thuoc ${FORMATS.join('|')}`);
  if (d.compare && !['prev_window', 'baseline'].includes(d.compare)) e.push('compare phai la prev_window|baseline');
  return e;
}

const readJ = (f) => { try { if (fs.statSync(f).size > LIMITS.maxFileBytes) return null; return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const listJson = (d) => { try { return fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort(); } catch { return []; } };

/** Nap muc: defaults + ghi de du an (tron nong theo ten file). Tra {sections, errors, truncated}. */
export function loadSections({ defaultsDir = DEFAULTS_DIR, projectDir = null, timeoutMs = LIMITS.timeoutMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  const errors = []; const map = new Map(); let truncated = null;
  const projDir = projectDir ? path.join(projectDir, '.harness', 'report') : null;
  for (const [dir, over] of [[defaultsDir, false], [projDir, true]]) {
    if (!dir) continue;
    for (const n of listJson(dir)) {
      if (Date.now() > deadline) { truncated = 'timeout'; break; }
      if (map.size >= LIMITS.maxDefs && !map.has(n)) { truncated = 'max_defs'; break; }
      const j = readJ(path.join(dir, n));
      if (!j || typeof j !== 'object') { errors.push(`${n}: JSON hong/qua lon`); continue; }
      map.set(n, over && map.has(n) ? { ...map.get(n), ...j } : { id: n.replace(/\.json$/, ''), ...j });
    }
  }
  const sections = [];
  for (const [n, d] of map) {
    if (d.enabled === false) continue;
    const er = validateSection(d);
    if (er.length) { errors.push(`${n}: ${er.join('; ')}`); continue; }
    sections.push(d);
  }
  sections.sort((a, b) => (Number(a.order) || 99) - (Number(b.order) || 99) || a.id.localeCompare(b.id));
  return { sections, errors, truncated };
}

// ---- ban ghi chuan hoa ----
const dig = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const num = (v) => { const n = Array.isArray(v) ? Number(v[v.length - 1]) : Number(v); return Number.isFinite(n) ? n : null; };
/** gia tri so tu danh sach truong 'a|b.c' (lay truong dau co gia tri). */
function numField(get, spec) { for (const f of String(spec).split('|')) { const v = num(get(f)); if (v != null) return v; } return null; }

const taskOf = (rec) => { const d = rec.data || {}; return rec.task_id ?? d.task_id ?? d.task ?? rec.sid ?? rec.session_id ?? null; };

function toRecs(source, inputs, ctx) {
  if (source === 'audit') return (inputs.events || []).map((r) => ({ get: (k) => (k.includes('.') ? dig(r, k) : auditField(r, k, ctx)), sid: r.sid || r.session_id || null, task: taskOf(r), ts: r.ts, n: 1 }));
  if (source === 'candidates') return (inputs.candidates || []).map((c) => ({ get: (k) => c[k], sid: null, task: null, ts: c.last_ts, n: c.count || 0, sess: c.sessions || 0 }));
  if (source === 'ledger') return (inputs.ledger || []).map((e) => ({ get: (k) => e[k], sid: null, task: null, ts: e.last_seen, n: 1, e }));
  if (source === 'inventory') return (inputs.inventory || []).map((e) => ({ get: (k) => e[k], sid: null, task: null, ts: null, n: e.count ?? 1, e }));
  return [];
}

function columns(def) {
  const m = Array.isArray(def.metric) ? def.metric : [def.metric || 'count'];
  return m.map((c, i) => (typeof c === 'string' ? { as: c, metric: c } : { as: c.as || c.metric || `c${i}`, ...c }));
}

function colValue(col, A, M, win) {
  const [m, arg] = String(col.metric).split(/:(.+)/);
  const sids = (xs) => new Set(xs.map((r) => r.sid).filter((x) => x != null)).size;
  const tasks = (xs) => new Set(xs.map((r) => r.task).filter((x) => x != null)).size;
  const cnt = M.reduce((s, r) => s + r.n, 0);
  switch (m) {
    case 'count': return cnt;
    case 'sessions': return sids(M) || M.reduce((s, r) => s + (r.sess || 0), 0);
    case 'per_session': { const den = (win.audit ? sids(A) : win.sessions) || 0; if (!den) return null; return (arg ? M.reduce((s, r) => s + (numField(r.get, arg) || 0), 0) : cnt) / den; }
    case 'per_task': { const den = (win.audit ? tasks(A) : win.tasks) || 0; return den ? cnt / den : null; }
    case 'per_1000': return win.events ? (cnt / win.events) * 1000 : null;
    case 'sum': return M.reduce((s, r) => s + (numField(r.get, arg) || 0), 0);
    case 'last': { let best = null; for (const r of M) { const v = r.get(arg); const x = Array.isArray(v) ? v[v.length - 1] : v; if (x != null && (best == null || String(x) > String(best))) best = x; } return best; }
    case 'rate': { if (!M.length) return null; return M.filter((r) => matchFilter(r.get, col.rate_filter || {}, win.ctx)).length / M.length; }
    default: return null;
  }
}

/** Tinh 1 muc tren dau vao da loc cua so. Tra {cols, rows:[{key, vals[]}]}. */
export function computeSection(def, inputs, ctx = {}) {
  const recs = toRecs(def.source, inputs, ctx);
  const gb = Array.isArray(def.group_by) && def.group_by.length ? def.group_by : null;
  const keyOf = (r) => (gb ? gb.map((k) => String(r.get(k) ?? '-')).join('|') : 'all');
  const events = (inputs.events || []);
  const win = { audit: def.source === 'audit', ctx, events: events.length,
    sessions: new Set(events.map((r) => r && (r.sid || r.session_id)).filter(Boolean)).size,
    tasks: new Set(events.map((r) => r && taskOf(r)).filter(Boolean)).size };
  const cols = columns(def);
  const groups = new Map();
  for (const r of recs) {
    const k = keyOf(r);
    let g = groups.get(k); if (!g) { g = { A: [], M: cols.map(() => []) }; groups.set(k, g); }
    g.A.push(r);
    if (!matchFilter(r.get, def.filter, ctx)) continue;
    cols.forEach((c, i) => { if (!c.filter || matchFilter(r.get, c.filter, ctx)) g.M[i].push(r); });
  }
  const rows = [];
  for (const [key, g] of groups) {
    if (!g.M.some((m) => m.length)) continue;
    rows.push({ key, vals: cols.map((c, i) => colValue(c, g.A, g.M[i], win)) });
  }
  const primary = (r) => (typeof r.vals[0] === 'number' ? r.vals[0] : -Infinity);
  rows.sort((a, b) => primary(b) - primary(a) || a.key.localeCompare(b.key));
  return { cols: cols.map((c) => c.as), rows: rows.slice(0, Math.min(def.limit > 0 ? def.limit : 50, LIMITS.maxRows)), total: rows.length };
}

const inWin = (ts, from, to) => { const t = Date.parse(ts); return Number.isFinite(t) ? t >= from && t < to : false; };

/** Dau vao cho cua so [from,to): events loc theo ts, candidates tinh lai tu events, ledger loc theo last_seen. */
export function windowInputs(def, all, from, to, nowIso) {
  const days0 = !(def.window_days > 0);
  const events = days0 ? (all.events || []) : (all.events || []).filter((e) => e && inWin(e.ts, from, to));
  const inputs = { events, inventory: all.inventory };
  if (def.source === 'candidates') inputs.candidates = all.candidatesFn ? all.candidatesFn(events, nowIso) : (all.candidates || []).filter((c) => days0 || inWin(c.last_ts, from, to));
  if (def.source === 'ledger') inputs.ledger = days0 ? all.ledger || [] : (all.ledger || []).filter((e) => inWin(e.last_seen, from, to));
  return inputs;
}

const R = (v) => (v == null ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : Array.isArray(v) ? v.join(',') : String(v).slice(0, 40));
const dlt = (v, p) => (typeof v === 'number' && typeof p === 'number' ? (p === 0 ? (v === 0 ? '0%' : '+new') : `${v >= p ? '+' : ''}${(((v - p) / Math.abs(p)) * 100).toFixed(0)}%`) : '-');

/** Danh gia 1 muc -> {def, result, prev, base, note}. all: {events, ledger, candidates|candidatesFn, inventory, baseline}. */
export function evaluateSection(def, all, { nowMs = Date.now(), ctx = {} } = {}) {
  const w = def.window_days > 0 ? def.window_days : 0;
  const to = nowMs; const from = w ? nowMs - w * DAY : 0;
  const nowIso = new Date(nowMs).toISOString();
  const cur = computeSection(def, windowInputs(def, all, from, to, nowIso), { ...ctx, nowMs });
  const out = { def, ...cur, prev: null, base: null, note: null };
  if (def.compare === 'prev_window' && w) {
    const p = computeSection(def, windowInputs(def, all, from - w * DAY, from, nowIso), { ...ctx, nowMs });
    out.prev = Object.fromEntries(p.rows.map((r) => [r.key, r.vals[0]]));
  }
  const b = all.baseline && all.baseline.kpis && all.baseline.kpis[def.id];
  if (def.compare && b) out.base = b;
  if (!cur.rows.length) out.note = def.empty_note || 'khong co du lieu';
  else if (cur.cols.length && cur.rows.every((r) => r.vals.every((v) => v == null || v === 0)) && def.source === 'audit') out.note = 'field thieu trong audit (chua co du lieu)';
  return out;
}

/** Gia tri chinh de luu baseline: {key: value} */
export const kpiSnapshot = (res) => Object.fromEntries(res.rows.filter((r) => typeof r.vals[0] === 'number').map((r) => [r.key, r.vals[0]]));

export function renderSection(res) {
  const { def } = res; const fmt = def.format || 'table';
  const L = [`## ${def.title || def.id}`];
  if (!res.rows.length) { L.push(`_${res.note}_`, ''); return L.join('\n'); }
  const cmp = !!(res.prev || res.base);
  if (fmt === 'list') {
    for (const r of res.rows) L.push(`- ${r.key}${r.vals.length && r.vals[0] != null ? ' (' + r.vals.map(R).join(', ') + ')' : ''}`);
    L.push(''); return L.join('\n');
  }
  if (fmt === 'kpi') {
    const r = res.rows[0];
    r.vals.forEach((v, i) => L.push(`- **${res.cols[i]}**: ${R(v)}${i === 0 && res.prev ? ` (tuan truoc ${R(res.prev[r.key])}, ${dlt(v, res.prev[r.key])})` : ''}${i === 0 && res.base ? ` (baseline ${R(res.base[r.key])}, ${dlt(v, res.base[r.key])})` : ''}`));
    if (res.note) L.push(`_${res.note}_`);
    L.push(''); return L.join('\n');
  }
  const head = ['nhom', ...res.cols, ...(res.prev ? ['tuan truoc', 'doi'] : []), ...(res.base ? ['baseline', 'doi'] : [])];
  L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
  for (const r of res.rows) {
    const cells = [r.key, ...r.vals.map(R)];
    if (res.prev) cells.push(R(res.prev[r.key]), dlt(r.vals[0], res.prev[r.key]));
    if (res.base) cells.push(R(res.base[r.key]), dlt(r.vals[0], res.base[r.key]));
    L.push(`| ${cells.join(' | ')} |`);
  }
  if (res.total > res.rows.length) L.push(`_... ${res.total - res.rows.length} nhom nua (limit)_`);
  if (res.note) L.push(`_${res.note}_`);
  void cmp; L.push(''); return L.join('\n');
}

/** Toan bao cao -> markdown. results: evaluateSection[]. */
export function renderReport(results, { days = 7, nowMs = Date.now(), truncated = null, baseline = null, errors = [] } = {}) {
  const L = [`# Bao cao harness tuan ${new Date(nowMs).toISOString().slice(0, 10)} (${days} ngay)`,
    baseline ? `baseline: ${baseline.date}` : 'baseline: chua chot (harness observe report --baseline)'];
  if (truncated) L.push(`truncated: ${truncated}`);
  if (errors.length) L.push(`loi dinh nghia: ${errors.join('; ')}`);
  L.push('');
  for (const r of results) L.push(renderSection(r));
  return L.join('\n');
}
