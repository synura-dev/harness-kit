// Engine bao cao khai bao: muc JSON (defaults/*.json, ghi de <project>/.harness/report/<ten>.json, {"enabled":false} de tat) -> markdown.
// Khong hardcode tung muc. Chiu thieu field (gia tri thieu = bo qua). Tai dung auditField/matchFilter cua engine luat.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditField, matchFilter } from '../ledger/engine.mjs';
import { isHookRun } from '../../core/audit/signals.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS_DIR = path.join(HERE, 'defaults');
export const LIMITS = Object.freeze({ timeoutMs: 5000, maxDefs: 50, maxFileBytes: 32768, maxRows: 200 });
export const SOURCES = Object.freeze(['audit', 'candidates', 'ledger', 'inventory', 'process', 'derived']);
export const AVG_WINDOWS = 7;
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
const num = (v) => { if (v == null) return null; const n = Array.isArray(v) ? Number(v[v.length - 1]) : Number(v); return Number.isFinite(n) ? n : null; };
/** gia tri so tu danh sach truong 'a|b.c' (lay truong dau co gia tri). */
// 'a|b' = truong dau co gia tri; 'a+b' = tong cac truong co gia tri (null neu khong co truong nao).
function numField(get, spec) {
  for (const alt of String(spec).split('|')) {
    let sum = null;
    for (const f of alt.split('+')) { const v = num(get(f)); if (v != null) sum = (sum ?? 0) + v; }
    if (sum != null) return sum;
  }
  return null;
}

// task = task_id that; khong con rơi ve sid (phien khong co task_id duoc bao rieng bang per_session_notask).
const taskOf = (rec) => { const d = rec.data || {}; return rec.task_id ?? d.task_id ?? d.task ?? null; };

function toRecs(source, inputs, ctx) {
  if (source === 'audit') return (inputs.events || []).map((r) => ({ get: (k) => (k.includes('.') ? dig(r, k) : auditField(r, k, ctx)), sid: r.sid || r.session_id || null, task: taskOf(r), ts: r.ts, n: 1 }));
  if (source === 'candidates') return (inputs.candidates || []).map((c) => ({ get: (k) => c[k], sid: null, task: null, ts: c.last_ts, n: c.count || 0, sess: c.sessions || 0 }));
  if (source === 'ledger') return (inputs.ledger || []).map((e) => ({ get: (k) => e[k], sid: null, task: null, ts: e.last_seen, n: 1, e }));
  if (source === 'process') return (inputs.process || []).map((e) => ({ get: (k) => e[k], sid: null, task: null, ts: null, n: e.n ?? 1, e }));
  if (source === 'derived') return (inputs.derivedRows || []).map((e) => ({ get: (k) => e[k], sid: null, task: null, ts: null, n: e.n ?? 1, e }));
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
    case 'per_task': { const den = (win.audit ? tasks(A) : win.tasks) || 0; return den ? M.filter((r) => r.task != null).length / den : null; }
    case 'per_session_notask': { // can thiep / phien KHONG co task_id
      const withTask = new Set(A.filter((r) => r.task != null).map((r) => r.sid));
      const lacking = new Set(A.map((r) => r.sid).filter((s) => s != null && !withTask.has(s)));
      return lacking.size ? M.filter((r) => lacking.has(r.sid)).length / lacking.size : null;
    }
    case 'per_1000': return win.events ? (cnt / win.events) * 1000 : null;
    case 'sum': { if (win.derived) { const v = M.map((r) => numField(r.get, arg)).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; } return M.reduce((s, r) => s + (numField(r.get, arg) || 0), 0); }
    case 'last': { let best = null; for (const r of M) { const v = r.get(arg); const x = Array.isArray(v) ? v[v.length - 1] : v; if (x != null && (best == null || String(x) > String(best))) best = x; } return best; }
    case 'task_done_rate': { const t = (win.projTasks || []).filter((x) => x && x.status !== 'cancelled'); return t.length ? t.filter((x) => x.status === 'completed').length / t.length : null; } // task tu ext projects, trong cua so theo modified
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
  const win = { audit: def.source === 'audit', derived: def.source === 'derived', ctx, events: events.length,
    sessions: new Set(events.map((r) => r && (r.sid || r.session_id)).filter(Boolean)).size,
    tasks: new Set(events.map((r) => r && taskOf(r)).filter(Boolean)).size, projTasks: inputs.projTasks };
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
    const vals = cols.map((c, i) => colValue(c, g.A, g.M[i], win));
    if (win.derived && vals.every((v) => v == null)) continue; // dong thieu gia tri khong tinh thanh 0
    rows.push({ key, vals });
  }
  const primary = (r) => (typeof r.vals[0] === 'number' ? r.vals[0] : -Infinity);
  rows.sort((a, b) => primary(b) - primary(a) || a.key.localeCompare(b.key));
  return { cols: cols.map((c) => c.as), rows: rows.slice(0, Math.min(def.limit > 0 ? def.limit : 50, LIMITS.maxRows)), total: rows.length, ...(inputs.derivedError ? { error: inputs.derivedError } : {}), ...(inputs.derivedTruncated ? { truncated: inputs.derivedTruncated } : {}) };
}

const inWin = (ts, from, to) => { const t = Date.parse(ts); return Number.isFinite(t) ? t >= from && t < to : false; };

/** Dau vao cho cua so [from,to): events loc theo ts, candidates tinh lai tu events, ledger loc theo last_seen. */
export function windowInputs(def, all, from, to, nowIso) {
  const days0 = !(def.window_days > 0);
  // HookRun khong phai tool call: bo khoi moi so lieu (ke ca mau so per_1000).
  const events = (days0 ? (all.events || []) : (all.events || []).filter((e) => e && inWin(e.ts, from, to))).filter((e) => !isHookRun(e));
  const inputs = { events, inventory: all.inventory, process: all.process };
  if (all.tasks) inputs.projTasks = days0 ? all.tasks : all.tasks.filter((t) => inWin(t && t.modified, from, to));
  if (def.source === 'candidates') inputs.candidates = all.candidatesFn ? all.candidatesFn(events, nowIso) : (all.candidates || []).filter((c) => days0 || inWin(c.last_ts, from, to));
  if (def.source === 'ledger') inputs.ledger = days0 ? all.ledger || [] : (all.ledger || []).filter((e) => inWin(e.last_seen, from, to));
  // derived: producer do all.derived[def.derive] cap; thieu/throw -> rong (fail-open), throw ghi error.
  if (def.source === 'derived') {
    const fn = all.derived && all.derived[def.derive];
    // fn({events,from,to,deadline}) -> rows | {rows, truncated}; dong bo (Promise bi tu choi); producer tu kiem deadline va tra truncated.
    if (typeof fn === 'function') {
      try {
        const r = fn({ events, from, to, deadline: Date.now() + LIMITS.timeoutMs });
        if (r && typeof r.then === 'function') { r.then(null, () => {}); inputs.derivedError = 'derive_async_unsupported'; }
        else { inputs.derivedRows = Array.isArray(r) ? r : r && Array.isArray(r.rows) ? r.rows : []; if (r && r.truncated) inputs.derivedTruncated = r.truncated; }
      } catch { inputs.derivedError = 'derive_failed'; }
    }
  }
  return inputs;
}

/** Ten cot/tieu de theo do dai cua so: 1 ngay, 7 tuan, khac N ngay. */
export const winNames = (w, k = AVG_WINDOWS) => (w === 1 ? { prev: 'hom qua', avg: `tb ${k} ngay truoc`, title: 'ngay' } : w === 7 ? { prev: 'tuan truoc', avg: `tb ${k} tuan truoc`, title: 'tuan' } : { prev: `${w} ngay truoc`, avg: `tb ${k}x${w} ngay truoc`, title: `${w} ngay` });
const R = (v) => (v == null ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : Array.isArray(v) ? v.join(',') : String(v).slice(0, 40));
const dlt = (v, p) => (typeof v === 'number' && typeof p === 'number' ? (p === 0 ? (v === 0 ? '0%' : '+new') : `${v >= p ? '+' : ''}${(((v - p) / Math.abs(p)) * 100).toFixed(0)}%`) : '-');

/** Danh gia 1 muc -> {def, result, prev, base, note}. all: {events, ledger, candidates|candidatesFn, inventory, baseline}. */
export function evaluateSection(def, all, { nowMs = Date.now(), ctx = {}, avgOf = AVG_WINDOWS, compare = "all" } = {}) {
  const w = def.window_days > 0 ? def.window_days : 0;
  const to = nowMs; const from = w ? nowMs - w * DAY : 0;
  const nowIso = new Date(nowMs).toISOString();
  const cur = computeSection(def, windowInputs(def, all, from, to, nowIso), { ...ctx, nowMs });
  const out = { def, ...cur, prev: null, avg: null, w, k: avgOf, base: null, note: null };
  if (def.compare === "prev_window" && w && def.source !== 'derived' && ["all", "prev", "avg"].includes(compare)) {
    // prev = cua so lien truoc; avg = trung binh toi da avgOf cua so truoc. Ky rong / ngoai dai du lieu da doc / gia tri null bi bo khoi mau so.
    const tsList = (all.events || []).map((e) => Date.parse(e && e.ts)).filter(Number.isFinite);
    const dataStart = tsList.length ? tsList.reduce((a, b) => Math.min(a, b)) : null;
    const ws = [];
    for (let k = 1; k <= (compare === "prev" ? 1 : avgOf); k++) {
      const a = from - k * w * DAY; const b = from - (k - 1) * w * DAY;
      const rows = computeSection(def, windowInputs(def, all, a, b, nowIso), { ...ctx, nowMs }).rows;
      ws.push({ map: Object.fromEntries(rows.map((r) => [r.key, r.vals[0]])), ok: rows.length > 0 && (dataStart == null || b > dataStart) });
    }
    if (compare !== "avg") out.prev = ws[0].map;
    if (compare !== "prev") {
      const used = ws.filter((x) => x.ok); out.avg = {}; out.n = used.length;
      for (const key of new Set(used.flatMap((x) => Object.keys(x.map)))) {
        const v = used.map((x) => (key in x.map ? x.map[key] : 0)).filter((x) => typeof x === 'number');
        if (v.length) out.avg[key] = v.reduce((p, c) => p + c, 0) / v.length;
      }
    }
  }
  const b = all.baseline && all.baseline.kpis && all.baseline.kpis[def.id];
  if (def.compare && b && ["all", "baseline"].includes(compare)) out.base = b;
  if (!cur.rows.length) out.note = def.empty_note || 'khong co du lieu';
  else if (cur.cols.length && cur.rows.every((r) => r.vals.every((v) => v == null || v === 0)) && def.source === 'audit') out.note = 'field thieu trong audit (chua co du lieu)';
  return out;
}

/** Gia tri chinh de luu baseline: {key: value} */
export const kpiSnapshot = (res) => Object.fromEntries(res.rows.filter((r) => typeof r.vals[0] === 'number').map((r) => [r.key, r.vals[0]]));

export function renderSection(res) {
  const { def } = res; const fmt = def.format || 'table';
  const L = [`## ${def.title || def.id}`];
  if (res.error) L.push(`_error: ${res.error}_`);
  if (!res.rows.length) { L.push(`_${res.note}_`, ''); return L.join('\n'); }
  const nm = winNames(res.w || 7, res.n != null && res.n < res.k ? `${res.n}/${res.k}` : res.k);
  if (fmt === 'list') {
    for (const r of res.rows) L.push(`- ${r.key}${r.vals.length && r.vals[0] != null ? ' (' + r.vals.map(R).join(', ') + ')' : ''}`);
    L.push(''); return L.join('\n');
  }
  if (fmt === 'kpi') {
    const gb = Array.isArray(def.group_by) && def.group_by.length;
    for (const r of gb ? res.rows : [res.rows[0]]) r.vals.forEach((v, i) => L.push(`- ${gb ? r.key + ' ' : ''}**${res.cols[i]}**: ${R(v)}${i === 0 && res.prev ? ` (${nm.prev} ${R(res.prev[r.key])}, ${dlt(v, res.prev[r.key])})` : ''}${i === 0 && res.avg ? ` (${nm.avg} ${R(res.avg[r.key])}, ${dlt(v, res.avg[r.key])})` : ''}${i === 0 && res.base ? ` (baseline ${R(res.base[r.key])}, ${dlt(v, res.base[r.key])})` : ''}`));
    if (res.note) L.push(`_${res.note}_`);
    L.push(''); return L.join('\n');
  }
  const head = ['nhom', ...res.cols, ...(res.prev ? [nm.prev, 'doi'] : []), ...(res.avg ? [nm.avg, 'doi'] : []), ...(res.base ? ['baseline', 'doi'] : [])];
  L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
  for (const r of res.rows) {
    const cells = [r.key, ...r.vals.map(R)];
    if (res.prev) cells.push(R(res.prev[r.key]), dlt(r.vals[0], res.prev[r.key]));
    if (res.avg) cells.push(R(res.avg[r.key]), dlt(r.vals[0], res.avg[r.key]));
    if (res.base) cells.push(R(res.base[r.key]), dlt(r.vals[0], res.base[r.key]));
    L.push(`| ${cells.join(' | ')} |`);
  }
  if (res.total > res.rows.length) L.push(`_... ${res.total - res.rows.length} nhom nua (limit)_`);
  if (res.note) L.push(`_${res.note}_`);
  L.push(''); return L.join('\n');
}

/** Toan bao cao -> markdown. results: evaluateSection[]. */
export function renderReport(results, { days = 7, nowMs = Date.now(), truncated = null, baseline = null, errors = [] } = {}) {
  const L = [`# Bao cao harness ${winNames(days).title} ${((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`)(new Date(nowMs))} (${days} ngay)`,
    baseline ? `baseline: ${baseline.date}` : 'baseline: chua chot (harness observe report --baseline)'];
  if (truncated) L.push(`truncated: ${truncated}`);
  if (errors.length) L.push(`loi dinh nghia: ${errors.join('; ')}`);
  L.push('');
  for (const r of results) L.push(renderSection(r));
  return L.join('\n');
}
