// ROI tri thuc (Task 5): moi doc id -> so lan get, so doan, token da phuc vu (out_len/4), tiet kiem uoc tinh (eff_tokens).
// UOC TINH TUONG QUAN, khong phai nhan qua: so doan co doc voi doan cung family khong co doc.
// Pure + dong bo; danh sach id (de tim "khong lay") lay luoi qua a.memo (derivedCtx) khi derive knowledge_retire|knowledge_kpi can.
// Chi do chi so: KHONG luu noi dung doc/stdout.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { isHookRun } from '../../core/audit/signals.mjs';
import { LIMITS, median } from './cost-contract.mjs';
import { segment, parseKnowledgeCmds } from './problems.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'harness.mjs');
export const ROI = Object.freeze({ bytesPerToken: 4, idsTimeoutMs: 10000, noSavingMinSide: 5, lossShare: 0.2 });

/** Cac lenh knowledge cua 1 su kien Bash (parser chung problems.mjs). Chi PostToolUse (get loi khong tinh). */
export function parseFetch(e) {
  if (!e || e.event !== 'PostToolUse' || e.tool !== 'Bash') return [];
  return parseKnowledgeCmds(e.target);
}

/** Ly do ngan tu stderr: ma HKERR neu co. */
const reasonOf = (r) => {
  const m = /HKERR (\{.*\})/.exec(String((r && r.stderr) || ''));
  try { const c = m && JSON.parse(m[1]).code; if (c) return 'ids_unavailable:' + String(c).slice(0, 60); } catch { /* fail-open */ }
  return 'ids_unavailable';
};

/** Danh sach id tu `harness knowledge export --json --no-text`. Uu tien `harness` tren PATH (shim -> ban plugin da dang ky; registry ext theo thu muc du lieu plugin), ENOENT -> CLI theo import.meta.
 *  Loi/qua han -> {unavailable: ids_unavailable[:HKERR_CODE]} (fail-open). */
export function loadDocIds({ run = spawnSync, cli = CLI, timeoutMs = ROI.idsTimeoutMs, cwd } = {}) {
  const args = ['knowledge', 'export', '--json', '--no-text'];
  const o = { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, cwd: cwd || undefined, maxBuffer: 16 * 1024 * 1024 };
  try {
    let r = run('harness', args, o);
    if (r && r.error && r.error.code === 'ENOENT') r = run(process.execPath, ['--no-warnings', cli, ...args], o);
    if (!r || r.status !== 0) return { unavailable: reasonOf(r) };
    const j = JSON.parse(r.stdout);
    const ids = (j && Array.isArray(j.docs) ? j.docs : []).map((d) => d && d.id).filter((x) => typeof x === 'string');
    return ids.length ? { ids, truncated: j.truncated ? 'ids_truncated' : null } : { unavailable: 'ids_unavailable' };
  } catch { return { unavailable: 'ids_unavailable' }; }
}

// Token output cua chinh cac lenh get (de tru khoi eff phia "co doc"): gan event vao doan theo sid + khoang ts.
function getTokensBySeg(evs, segments) {
  const bySid = new Map();
  for (const s of segments) { const l = bySid.get(s.sid) || []; l.push(s); bySid.set(s.sid, l); }
  const tok = new Map();
  for (const e of evs) {
    if (!parseFetch(e).some((c) => c.kind === 'get') || !e.data || !Number.isFinite(e.data.out_len)) continue;
    const seg = (bySid.get(e.sid) || []).find((s) => e.ts >= s.start_ts && e.ts <= s.end_ts);
    if (seg) tok.set(seg, (tok.get(seg) || 0) + e.data.out_len / ROI.bytesPerToken);
  }
  return tok;
}

/** Tiet kiem cua 1 doc: cung family (precision high|mid), doan co id (da tru token get) vs doan khong co. null khi < minSide moi ben. */
function saving(id, segs, getTok, minSide) {
  const fam = new Map();
  for (const s of segs) {
    if (!s.family || (s.precision !== 'high' && s.precision !== 'mid')) continue;
    const f = fam.get(s.family) || { w: [], o: [] };
    if (s.kfetch.includes(id)) f.w.push({ eff: s.eff_tokens - (getTok.get(s) || 0), nd: new Set(s.kfetch).size });
    else f.o.push(s.eff_tokens);
    fam.set(s.family, f);
  }
  let nW = 0, nO = 0, per = 0, total = 0, medO = 0;
  for (const f of fam.values()) {
    if (!f.w.length || !f.o.length) continue;
    const mo = median(f.o);
    nW += f.w.length; nO += f.o.length; medO += f.w.length * mo;
    for (const w of f.w) { per += mo - w.eff; total += (mo - w.eff) / w.nd; } // doan lay nd doc: chia deu, khong cong trung
  }
  return nW >= minSide && nO >= minSide ? { per_use: per / nW, total, nW, nO, medO: medO / nW } : null;
}

/** @returns {{docs: object[], kpi: object, noSaving: string[], neverFetched: string[]|null, truncated: string|null}} */
export function computeRoi({ events, segs, docIds, limits } = {}) {
  const lim = { ...LIMITS, ...(limits || {}) };
  const evs = (Array.isArray(events) ? events : []).filter((e) => e && !isHookRun(e));
  const { segments, truncated } = segs || segment(evs, { limits: lim });
  const getTok = getTokensBySeg(evs, segments);
  const d = new Map();
  const row = (id) => { let r = d.get(id); if (!r) { r = { id, gets: 0, sids: new Set(), served: null }; d.set(id, r); } return r; };
  for (const s of segments) for (const id of s.kfetch) { const r = row(id); r.gets++; r.sids.add(s.sid); }
  let fetchEv = 0, measured = 0, servedTotal = 0;
  for (const e of evs) {
    const cmds = parseFetch(e);
    if (!cmds.length) continue;
    fetchEv++;
    const len = e.data && Number.isFinite(e.data.out_len) ? e.data.out_len : null;
    if (len != null) measured++;
    for (const c of cmds) {
      const tok = len != null ? len / ROI.bytesPerToken / cmds.length : c.budget;
      if (tok == null) continue;
      servedTotal += tok;
      if (c.id) { const r = row(c.id); r.served = (r.served || 0) + tok; }
    }
  }
  let savedTotal = null;
  const docs = [...d.values()].map((r) => {
    const sv = saving(r.id, segments, getTok, lim.minSide);
    if (sv) savedTotal = (savedTotal || 0) + sv.total;
    return {
      id: r.id, gets: r.gets, sessions: r.sids.size, served_tokens: r.served != null ? Math.round(r.served) : null,
      saving: sv ? Math.round(sv.per_use) : null, saved_total: sv ? Math.round(sv.total) : null,
      fetched_no_saving: !!sv && sv.nW >= ROI.noSavingMinSide && sv.nO >= ROI.noSavingMinSide && sv.per_use < -ROI.lossShare * sv.medO,
    };
  }).sort((a, b) => b.gets - a.gets || (a.id < b.id ? -1 : 1));
  const neverFetched = Array.isArray(docIds) ? docIds.filter((id) => !d.has(id)).sort() : null;
  const noSaving = docs.filter((x) => x.fetched_no_saving).map((x) => x.id);
  const kpi = {
    fetches: docs.reduce((n, x) => n + x.gets, 0), tokens_served: Math.round(servedTotal),
    tokens_measured_share: fetchEv ? Math.round((measured / fetchEv) * 100) / 100 : null,
    roi_saved_tokens: savedTotal == null ? null : Math.round(savedTotal), retire_candidates: noSaving.length,
    never_fetched_count: neverFetched ? neverFetched.length : null,
  };
  return { docs, kpi, noSaving, neverFetched, truncated };
}

// Id tri thuc lay luoi, memo trong a.memo (derivedCtx, 1 lan / buildReport). a.docIds (tiem) > a.listIds() > loadDocIds that.
function idsOf(a) {
  if (a.docIds !== undefined) return { ids: a.docIds };
  const m = a.memo || {};
  if (!m.knowledgeIds) {
    m.knowledgeIds = (a.listIds || loadDocIds)({ cwd: a.projectDir });
    if (m.knowledgeIds.unavailable && a.onError) a.onError('ids: ' + m.knowledgeIds.unavailable);
  }
  return m.knowledgeIds;
}
const compute = (a, withIds) => {
  const l = withIds ? idsOf(a) : {};
  const segs = a.getSegments ? a.getSegments({ from: a.from, to: a.to }) : undefined;
  return { r: computeRoi({ events: a.events, segs, docIds: l.ids }), l };
};
const idsTrunc = (r, l) => r.truncated || l.unavailable || l.truncated || null;
const out = (rows, t) => (t ? { rows, truncated: t } : rows);

/** derive (dong bo). knowledge_roi khong can danh sach id nen khong spawn CLI. */
export const derive = {
  knowledge_roi: (a) => { const { r } = compute(a, false); return out(r.docs.map((x) => ({ id: x.id, gets: x.gets, sessions: x.sessions, served_tokens: x.served_tokens, saving: x.saving, saved_total: x.saved_total })), r.truncated); },
  knowledge_retire: (a) => {
    const { r, l } = compute(a, true);
    const rows = [...r.noSaving.map((id) => ({ id: 'no_saving:' + id, n: r.docs.find((x) => x.id === id).gets })), ...(r.neverFetched || []).map((id) => ({ id: 'never_fetched:' + id, n: 0 }))];
    return out(rows, idsTrunc(r, l));
  },
  knowledge_kpi: (a) => { const { r, l } = compute(a, true); return out(Object.entries(r.kpi).map(([k, v]) => ({ k, v })), idsTrunc(r, l)); },
};
