// Chi phi lan dau vs lan lap theo khoa van de (T4). Lap = phien SAU cung khoa (lap trong cung phien khong tinh).
// Chi khoa precision high|mid vao ty le (kw = low chi tinh vao key_coverage). sub_tokens (tho in+out subagent) bao rieng, khong cong voi eff_tokens.
// Index problems-index.json (khoa -> {first_ts,last_ts}) chi ghi khi persist (--weekly), atomic; khong luu noi dung prompt.
import fs from 'node:fs';
import path from 'node:path';
import { guardWrite } from '../../core/io/storage.mjs';
import { ledgerDir } from '../ledger/ledger.mjs';
import { LIMITS, median } from './cost-contract.mjs';
import { segment } from './problems.mjs';

const DAY = 86400000;
export const indexFile = (dataOpts) => path.join(ledgerDir(dataOpts), 'problems-index.json');

export function readIndex(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j.keys === 'object' && j.keys ? j.keys : {}; } catch { return {}; }
}

/** Ghi atomic (temp + rename); TTL indexTtlDays theo last_ts, tran maxProblems theo last_ts moi nhat. */
export function writeIndex(file, keys, nowMs, lim = LIMITS) {
  const alive = Object.entries(keys).filter(([, v]) => Date.parse(v.last_ts) >= nowMs - lim.indexTtlDays * DAY)
    .sort((a, b) => Date.parse(b[1].last_ts) - Date.parse(a[1].last_ts)).slice(0, lim.maxProblems);
  if (!guardWrite(file).ok) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, keys: Object.fromEntries(alive) }) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { try { fs.unlinkSync(tmp); } catch { /* bo qua */ } return false; }
}

/** @returns {{rows:{k:string,v:number|null}[], byFamily:object[], truncated:string|null}} */
export function costRepeat({ events = [], index, persist = false, now = Date.now(), ledger, dataOpts, deadline } = {}) {
  const seg = segment(events, { ledger });
  let truncated = seg.truncated;
  const segs = seg.segments;
  const idx = index || readIndex(indexFile(dataOpts));
  const good = segs.filter((s) => s.problem && (s.precision === 'high' || s.precision === 'mid'));
  const keys = new Map(); // khoa -> {family, sess: Map sid -> {eff, start, sub}}
  for (const s of good) {
    let g = keys.get(s.problem); if (!g) { g = { family: s.family || s.problem, sess: new Map() }; keys.set(s.problem, g); }
    const x = g.sess.get(s.sid) || { eff: 0, start: s.start_ts, sub: 0 };
    x.eff += s.eff_tokens; x.sub += s.sub_tokens; if (s.start_ts && (!x.start || s.start_ts < x.start)) x.start = s.start_ts;
    g.sess.set(s.sid, x);
  }
  let totalEff = 0, repeatEff = 0, firstEff = 0;
  const ratios = [], fam = new Map();
  for (const [key, g] of keys) {
    if (deadline && Date.now() > deadline) { truncated = truncated || 'timeout'; break; }
    const ss = [...g.sess.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const old = idx[key] && ss.length && Date.parse(idx[key].first_ts) < Date.parse(ss[0].start);
    const first = old ? null : ss[0];
    const reps = old ? ss : ss.slice(1);
    const rEff = reps.reduce((a, x) => a + x.eff, 0);
    totalEff += ss.reduce((a, x) => a + x.eff, 0); repeatEff += rEff;
    if (first) { firstEff += first.eff; if (reps.length && first.eff > 0) ratios.push((rEff / reps.length) / first.eff); }
    const f = fam.get(g.family) || { k: g.family, first_eff: 0, repeat_eff: 0, repeats: 0, sub_tokens: 0 };
    f.first_eff += first ? first.eff : 0; f.repeat_eff += rEff; f.repeats += reps.length; f.sub_tokens += ss.reduce((a, x) => a + x.sub, 0);
    fam.set(g.family, f);
  }
  const n = keys.size;
  const cr = segs.reduce((a, s) => a + s.tokens.cache_read, 0);
  const ctx = segs.reduce((a, s) => a + s.tokens.input + s.tokens.cache_creation + s.tokens.cache_read, 0);
  const rows = [
    { k: 'repeat_vs_first_ratio', v: median(ratios) },
    { k: 'eff_tokens_per_problem', v: n ? totalEff / n : null },
    { k: 'problems', v: n || null },
    { k: 'repeat_share', v: totalEff ? repeatEff / totalEff : null },
    { k: 'key_coverage', v: segs.length ? good.length / segs.length : null },
    { k: 'cache_read_share', v: ctx ? cr / ctx : null },
  ];
  if (persist && good.length) {
    const next = { ...idx };
    for (const [key, g] of keys) {
      const starts = [...g.sess.values()].map((x) => x.start).filter(Boolean).sort();
      if (!starts.length) continue;
      const lastTs = [...good].filter((s) => s.problem === key).map((s) => s.end_ts || s.start_ts).filter(Boolean).sort().pop() || starts[starts.length - 1];
      const o = next[key];
      next[key] = { first_ts: o && o.first_ts < starts[0] ? o.first_ts : starts[0], last_ts: o && o.last_ts > lastTs ? o.last_ts : lastTs };
    }
    writeIndex(indexFile(dataOpts), next, now);
  }
  const byFamily = [...fam.values()].sort((a, b) => (b.first_eff + b.repeat_eff) - (a.first_eff + a.repeat_eff)).slice(0, 50);
  return { rows, byFamily, truncated };
}

/** Nap index tu lich su dai (--bootstrap-days): tinh va ghi index, tra so khoa trong index. */
export function bootstrapIndex({ events, now = Date.now(), ledger, dataOpts } = {}) {
  costRepeat({ events, persist: true, now, ledger, dataOpts });
  return Object.keys(readIndex(indexFile(dataOpts))).length;
}

// Memo theo mang events (2 section cung cua so chia nhau 1 lan segment); persist chi chay trong lan tinh dau.
const memo = new WeakMap();
function shared(a) {
  const ev = a.events || [];
  if (a.deadline && Date.now() > a.deadline) return { rows: [], byFamily: [], truncated: 'timeout' };
  let r = memo.get(ev);
  if (!r) { r = costRepeat({ events: ev, persist: !!a.persist, now: a.now, ledger: a.ledger, dataOpts: a.dataOpts, deadline: a.deadline }); memo.set(ev, r); }
  return r;
}

export const derive = {
  cost_repeat: (a) => { const r = shared(a); return { rows: r.rows, truncated: r.truncated }; },
  cost_by_family: (a) => { const r = shared(a); return { rows: r.byFamily, truncated: r.truncated }; },
};
