// ROI tri thuc (Task 5): moi doc id -> so lan get, so doan, token da phuc vu (out_len/4), tiet kiem uoc tinh (eff_tokens).
// Pure + dong bo; danh sach id (de tim "chua tung lay") tiem tu run.mjs qua tham so `docIds` (khong co -> bo danh sach, bao ly do).
// Chi do chi so: KHONG luu noi dung doc/stdout. Don vi saving = eff_tokens trung binh moi doan co dung doc (duong = tiet kiem).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { isHookRun } from '../../core/audit/signals.mjs';
import { LIMITS, median } from './cost-contract.mjs';
import { segment } from './problems.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'harness.mjs');
const GET_RE = /\bharness\s+knowledge\s+get\s+([\w.-]+)(?:[^\n]*?--budget[ =](\d+))?/;
const SEARCH_RE = /\bharness\s+knowledge\s+search\b/;
export const ROI = Object.freeze({ bytesPerToken: 4, idsTimeoutMs: 10000 });

/** Phan tich 1 su kien Bash: {kind:'get'|'search', id?, budget?} | null. Target co the bi cat 160 ky tu: van parse phan co. */
export function parseFetch(e) {
  if (!e || e.event !== 'PostToolUse' || e.tool !== 'Bash' || typeof e.target !== 'string') return null;
  const t = e.target.trim();
  const g = GET_RE.exec(t);
  if (g) return { kind: 'get', id: g[1], budget: g[2] ? Number(g[2]) : null };
  return SEARCH_RE.test(t) ? { kind: 'search' } : null;
}

/** Danh sach id tu `harness knowledge export --json --no-text`. Loi/qua han -> {unavailable: ly do} (fail-open). */
export function loadDocIds({ run = spawnSync, cli = CLI, timeoutMs = ROI.idsTimeoutMs, cwd } = {}) {
  try {
    const r = run(process.execPath, ['--no-warnings', cli, 'knowledge', 'export', '--json', '--no-text'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, cwd: cwd || undefined, maxBuffer: 16 * 1024 * 1024 });
    if (!r || r.status !== 0) return { unavailable: 'ids_unavailable' };
    const j = JSON.parse(r.stdout);
    const ids = (j && Array.isArray(j.docs) ? j.docs : []).map((d) => d && d.id).filter((x) => typeof x === 'string');
    return ids.length ? { ids, truncated: j.truncated ? 'ids_truncated' : null } : { unavailable: 'ids_unavailable' };
  } catch { return { unavailable: 'ids_unavailable' }; }
}

/** Tiet kiem trung binh/doan: cung family, doan co id vs doan khong co. null khi < minSide moi ben (gop cac family co ca hai ben). */
function saving(id, segs, minSide) {
  const fam = new Map();
  for (const s of segs) {
    if (!s.family) continue;
    const f = fam.get(s.family) || { w: [], o: [] };
    (s.kfetch.includes(id) ? f.w : f.o).push(s.eff_tokens);
    fam.set(s.family, f);
  }
  let nW = 0, nO = 0, sum = 0;
  for (const f of fam.values()) {
    if (!f.w.length || !f.o.length) continue;
    nW += f.w.length; nO += f.o.length;
    sum += f.w.length * (median(f.o) - median(f.w));
  }
  return nW >= minSide && nO >= minSide ? { per_use: sum / nW, total: sum } : null;
}

/** @returns {{docs: object[], kpi: object, noSaving: string[], neverFetched: string[]|null, truncated: string|null}} */
export function computeRoi({ events, docIds, limits } = {}) {
  const lim = { ...LIMITS, ...(limits || {}) };
  const evs = (Array.isArray(events) ? events : []).filter((e) => e && !isHookRun(e));
  const { segments, truncated } = segment(evs, { limits: lim });
  const d = new Map(); // id -> {gets, sids:Set, served}
  const row = (id) => { let r = d.get(id); if (!r) { r = { id, gets: 0, sids: new Set(), served: null }; d.set(id, r); } return r; };
  for (const s of segments) for (const id of s.kfetch) { const r = row(id); r.gets++; r.sids.add(s.sid); }
  let fetchEv = 0, measured = 0, servedTotal = 0;
  for (const e of evs) {
    const p = parseFetch(e);
    if (!p) continue;
    fetchEv++;
    const len = e.data && Number.isFinite(e.data.out_len) ? e.data.out_len : null;
    const tok = len != null ? len / ROI.bytesPerToken : p.budget;
    if (len != null) measured++;
    if (tok != null) { servedTotal += tok; if (p.id) { const r = row(p.id); r.served = (r.served || 0) + tok; } }
  }
  let savedTotal = null;
  const docs = [...d.values()].map((r) => {
    const sv = saving(r.id, segments, lim.minSide);
    if (sv) savedTotal = (savedTotal || 0) + sv.total;
    return { id: r.id, gets: r.gets, sessions: r.sids.size, served_tokens: r.served != null ? Math.round(r.served) : null, saving: sv ? Math.round(sv.per_use) : null, saved_total: sv ? Math.round(sv.total) : null, fetched_no_saving: !!sv && r.gets >= lim.minSide && sv.per_use <= 0 };
  }).sort((a, b) => b.gets - a.gets || (a.id < b.id ? -1 : 1));
  const neverFetched = Array.isArray(docIds) ? docIds.filter((id) => !d.has(id)).sort() : null;
  const noSaving = docs.filter((x) => x.fetched_no_saving).map((x) => x.id);
  const fetches = docs.reduce((n, x) => n + x.gets, 0);
  const kpi = {
    fetches, tokens_served: Math.round(servedTotal), tokens_measured_share: fetchEv ? Math.round((measured / fetchEv) * 100) / 100 : null,
    roi_saved_tokens: savedTotal == null ? null : Math.round(savedTotal), retire_candidates: noSaving.length,
    never_fetched_count: neverFetched ? neverFetched.length : null,
  };
  return { docs, kpi, noSaving, neverFetched, truncated };
}

const wrap = (pick) => (a) => {
  const r = computeRoi({ events: a.events, docIds: a.docIds });
  const out = pick(r);
  const t = r.truncated || (out.needIds ? (a.docIds === undefined ? a.docIdsReason || 'ids_unavailable' : a.idsTruncated || null) : null);
  return t ? { rows: out.rows, truncated: t } : out.rows;
};

/** derive (dong bo). `docIds` do run.mjs tiem vao tham so; thieu -> khong co danh sach "chua tung lay", truncated ghi ly do. */
export const derive = {
  knowledge_roi: wrap((r) => ({ rows: r.docs.map((x) => ({ id: x.id, gets: x.gets, sessions: x.sessions, served_tokens: x.served_tokens, saving: x.saving, saved_total: x.saved_total })) })),
  knowledge_retire: wrap((r) => ({
    needIds: true,
    rows: [...r.noSaving.map((id) => ({ id: 'no_saving:' + id, n: r.docs.find((x) => x.id === id).gets })), ...(r.neverFetched || []).map((id) => ({ id: 'never_fetched:' + id, n: 0 }))],
  })),
  knowledge_kpi: wrap((r) => ({ rows: Object.entries(r.kpi).map(([k, v]) => ({ k, v })) })),
};
