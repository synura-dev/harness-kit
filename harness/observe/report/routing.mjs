// Tuan thu dinh tuyen mode (T13, spec G): lop viec tat dinh -> mode ky vong (luat hub AGENTS.md "Subagent", hang so) so voi mode thuc te.
// Chi dung truong audit that: Pre Agent/Task (target=subagent_type, data.model), SubagentStart/Stop (agent_id, agent_type, model, turns, tokens_in/out),
// data.out_len (Read/Grep/Glob/Bash/Web*), cli='agy'. Khong luu noi dung: ca lech chi kem sid rut gon 8 ky tu, lop viec, so.
// Thieu tin hieu (phantom, su kien cu thieu model/out_len) -> `unknown` (khong tinh lech, khong vao mau so).
import { isHookRun } from '../../core/audit/signals.mjs';
import { LIMITS, ROUTING, median, effTokens } from './cost-contract.mjs';

const fam = (m) => { const x = String(m || '').toLowerCase().match(/haiku|sonnet|opus/); return x ? x[0] : null; };
const price = (f) => ROUTING.priceRel[f] ?? null;
const PLAN_RE = /docs\/superpowers\/(plans|specs)\//;
const TEST_RE = /\b(bun test|npm test|tsc)\b/;
const WEB = new Set(['WebSearch', 'WebFetch']);
const READ = new Set(['Read', 'Grep', 'Glob']);
const LEN_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash']);
const WRITE = new Set(['Edit', 'Write']);
const MISS_ORDER = ['missed_agy', 'overuse_opus', 'underuse_haiku', 'under_model', 'builder_over_turns', 'main_overread'];

const CODE_RE = /\.(mjs|cjs|js|ts|tsx|jsx|json|py|sh)$/i;
const NONCODE_RE = /(^|\/)(data|logs?|reports?|tmp|\.tmp)\//i;
const isCodeFile = (f) => CODE_RE.test(f) && !NONCODE_RE.test(f);

/** Phan lop viec + tin hieu tu cac su kien cua mot don vi. legacy = co tool (Read/Grep/Glob/Bash) thieu out_len (khong loai tru duoc large_read).
 *  web_lookup chi khi web chu dao (> nua so call) hoac >= 3 lan web; code_edit chi khi ghi file code (hoac agent builder). */
function classify(evs, agentType) {
  const posts = evs.filter((e) => e.event === 'PostToolUse');
  let web = 0, chars = 0, write = false, plan = false, test = false, legacy = false, risk = false, reads = 0, fail = 0;
  for (const e of evs) if (e.event === 'PostToolUseFailure') fail++;
  for (const e of posts) {
    const d = e.data || {};
    if (WEB.has(e.tool)) web++;
    if (READ.has(e.tool)) reads++;
    if (LEN_TOOLS.has(e.tool)) { if (Number.isFinite(d.out_len)) chars += d.out_len; else if (!WEB.has(e.tool)) legacy = true; }
    const ft = Array.isArray(d.files_touched) ? d.files_touched.map(String) : [];
    if (WRITE.has(e.tool)) {
      if (!ft.length || ft.some(isCodeFile)) write = true; // shortcut: thieu files_touched coi la code
      if (e.tool === 'Write' && ft.some((f) => PLAN_RE.test(f))) plan = true;
    }
    if (e.tool === 'Bash' && TEST_RE.test(String(e.target || ''))) test = true;
    if (ft.some((f) => ROUTING.riskRe.test(f))) risk = true;
  }
  const webMain = web >= 3 || (posts.length > 0 && web / posts.length > 0.5);
  let cls = 'read_small';
  if (webMain) cls = 'web_lookup';
  else if (chars >= ROUTING.largeReadChars) cls = 'large_read';
  else if (agentType === 'planner' || plan) cls = 'plan';
  else if (write || agentType === 'builder') cls = 'code_edit';
  else if (agentType === 'reviewer') cls = 'review';
  else if (test) cls = 'test_run';
  const decided = cls === 'web_lookup' || cls === 'large_read';
  return { cls, risk, reads, chars, fail, calls: posts.length + fail, legacy: legacy && !decided };
}

const expectedMode = (cls, risk) => {
  if (cls === 'web_lookup' || cls === 'large_read') return 'agy';
  if (cls === 'plan') return 'opus';
  if (cls === 'review') return risk ? 'opus' : 'sonnet';
  if (cls === 'code_edit') return 'sonnet';
  return 'haiku';
};

/** Loai lech chinh (1 / don vi) cho mode thuc te `act` (haiku|sonnet|opus) so voi ky vong `exp`; null = dung. */
function modelMiss(exp, act, cls) {
  if (exp === 'agy') return 'missed_agy';
  if (act === 'opus' && cls === 'review') return null; // opus la mac dinh an toan cho review (cuoi dot): bao trung tinh review_opus_share
  if (act === 'opus' && exp !== 'opus') return 'overuse_opus';
  if (exp === 'haiku' && act === 'sonnet') return 'underuse_haiku';
  if (price(act) < price(exp)) return 'under_model';
  return null;
}

/**
 * @param {{events:object[], segments:object[]|{segments:object[],truncated:string|null}, from?:number, to?:number, deadline?:number, limits?:object}} a
 * @returns {{rows:{k:string,v:number|null}[], agy:{k:string,v:number|null}[], misses:object[], byClass:object, units:number, unknown:number, agyNote:string, truncated:string|null}}
 */
export function routing({ events = [], segments = [], from = 0, to = 0, deadline, limits, hubDir = null } = {}) {
  // main_overread chi o phien hub (cwd = hubDir, lay tu projectDir cua run.mjs); khong biet hub -> khong ket luan
  const inHub = (evsU) => !!hubDir && evsU.some((e) => typeof e.cwd === 'string' && (e.cwd === hubDir || e.cwd.startsWith(hubDir.replace(/\/$/, '') + '/')));
  const lim = { ...LIMITS, ...(limits || {}) };
  const segIn = Array.isArray(segments) ? { segments, truncated: null } : segments || { segments: [], truncated: null };
  let truncated = segIn.truncated || null;
  let evs = (Array.isArray(events) ? events : []).filter((e) => e && e.sid && !isHookRun(e) && e.origin !== 'noise');
  if (to > 0) evs = evs.filter((e) => { const t = Date.parse(e.ts); return Number.isFinite(t) && t >= from && t < to; });
  evs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (evs.length > lim.maxEvents) { evs = evs.slice(evs.length - lim.maxEvents); truncated = truncated || 'max_events'; }

  const segsBySid = new Map();
  for (const s of segIn.segments) { if (!segsBySid.has(s.sid)) segsBySid.set(s.sid, []); segsBySid.get(s.sid).push(s); }
  for (const l of segsBySid.values()) l.sort((a, b) => String(a.start_ts).localeCompare(String(b.start_ts)));
  const segOf = (e) => { let r = null; for (const s of segsBySid.get(e.sid) || []) { if (s.start_ts <= e.ts) r = s; else break; } return r; };
  const info = new Map(); // seg -> {main:[], all:[], pre:0, model}
  const get = (s) => { let x = info.get(s); if (!x) { x = { main: [], all: [], pre: 0, model: null }; info.set(s, x); } return x; };
  const byAgent = new Map(), starts = [], pres = [], stops = new Map(); // sid|agent_id -> ...
  for (let i = 0; i < evs.length; i++) {
    if (deadline && i % 256 === 0 && Date.now() > deadline) { truncated = truncated || 'timeout'; break; }
    const e = evs[i];
    const s = segOf(e);
    if (s) { get(s).all.push(e); if (!e.agent_id) get(s).main.push(e); }
    if (e.agent_id) { const k = `${e.sid}|${e.agent_id}`; if (!byAgent.has(k)) byAgent.set(k, []); if (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') byAgent.get(k).push(e); }
    if (e.event === 'PreToolUse' && (e.tool === 'Agent' || e.tool === 'Task')) { pres.push(e); if (s) get(s).pre++; }
    else if (e.event === 'SubagentStart' && e.agent_id) starts.push({ e, used: false });
    else if (e.event === 'SubagentStop' && e.agent_id) {
      const k = `${e.sid}|${e.agent_id}`; const o = stops.get(k) || { model: null, turns: 0, tin: 0, tout: 0, cache: null, ts: e.ts };
      if (fam(e.model)) o.model = e.model; o.turns = Math.max(o.turns, Number(e.turns) || 0); o.ts = e.ts;
      o.tin = Math.max(o.tin, Number(e.tokens_in) || 0); o.tout = Math.max(o.tout, Number(e.tokens_out) || 0);
      const tc = e.data && e.data.tokens_cache; if (Number.isFinite(tc)) o.cache = Math.max(o.cache || 0, tc);
      stops.set(k, o);
    } else if (e.event === 'Stop' && !e.agent_id && s && fam(e.model)) get(s).model = fam(e.model);
  }

  const units = []; // {src:'dispatch'|'main'|'agy', cls, exp, act, eff, wall, fail, calls, miss, unknown, problem, sid, builder}
  // (a) dispatch: Pre -> SubagentStart ke tiep cung sid + agent_type
  for (const p of pres) {
    // Pre thieu subagent_type: ghep Start ke tiep bat ky loai (de khong dem them unmatched_start), don vi van unknown
    const typed = typeof p.target === 'string' && p.target !== '';
    const st = starts.find((x) => !x.used && x.e.sid === p.sid && (!typed || x.e.agent_type === p.target) && x.e.ts >= p.ts);
    const u = { src: 'dispatch', sid: p.sid, unknown: true, eff: null, wall: null, fail: 0, calls: 0, miss: null, problem: null, req: fam(p.data && p.data.model) };
    if (st && !typed) st.used = true;
    else if (st) {
      st.used = true;
      const k = `${p.sid}|${st.e.agent_id}`; const c = classify(byAgent.get(k) || [], st.e.agent_type); const stop = stops.get(k);
      const act = stop ? fam(stop.model) : null;
      // eff cung don vi voi segment (in+out+0.1*cache); thieu data.tokens_cache -> eff null (raw, khong tron vao eff)
      u.cls = c.cls; u.fail = c.fail; u.calls = c.calls; u.exp = expectedMode(c.cls, c.risk);
      u.eff = stop && stop.cache != null ? effTokens({ input: stop.tin, output: stop.tout, cache_read: stop.cache }) : null;
      u.act = act; u.turns = stop ? stop.turns : 0; u.builder = st.e.agent_type === 'builder';
      const w = stop ? Date.parse(stop.ts) - Date.parse(p.ts) : NaN; u.wall = Number.isFinite(w) && w > 0 ? w : null;
      if (act && !c.legacy) {
        u.unknown = false;
        u.miss = modelMiss(u.exp, act, c.cls);
        if (!u.miss && u.builder && u.turns > ROUTING.builderTurns) u.miss = 'builder_over_turns';
      }
    }
    units.push(u);
  }
  // Start khong co Pre (resume) hoac thua: unknown, dem rieng (khong bo im lang)
  let unmatchedStarts = 0;
  for (const x of starts) if (!x.used) { unmatchedStarts++; units.push({ src: 'dispatch', sid: x.e.sid, unknown: true, eff: null, miss: null, fail: 0, calls: 0, unmatched: true }); }
  // (b)(c) segment main / agy
  for (const s of segIn.segments) {
    const x = info.get(s); if (!x) continue;
    const isAgy = String(s.sid).startsWith('agy-') || x.all.some((e) => e.cli === 'agy');
    const evsU = isAgy ? x.all : x.main;
    if (!evsU.some((e) => e.event === 'PostToolUse')) continue;
    const c = classify(evsU, null);
    const u = { src: isAgy ? 'agy' : 'main', sid: s.sid, cls: c.cls, exp: expectedMode(c.cls, c.risk), act: isAgy ? 'agy' : 'main', eff: s.eff_tokens || 0, wall: s.wall_ms || null, fail: c.fail, calls: c.calls, miss: null, unknown: false, problem: s.problem || null, start: s.start_ts, end: s.end_ts, write: evsU.some((e) => e.event === 'PostToolUse' && WRITE.has(e.tool)), model: x.model };
    if (!isAgy) {
      if (u.exp === 'agy') u.miss = 'missed_agy';
      else if ((c.reads >= 3 || c.chars > ROUTING.overreadChars) && !x.pre && inHub(evsU)) u.miss = 'main_overread';
      else if (c.legacy) u.unknown = true;
    }
    units.push(u);
  }

  const known = units.filter((u) => u.src !== 'agy' && !u.unknown);
  const misses = [];
  const cnt = Object.fromEntries(MISS_ORDER.map((k) => [k, 0]));
  let excess = 0, upper = 0;
  for (const u of known) {
    if (!u.miss) continue;
    cnt[u.miss]++;
    let ex = 0, ub = 0;
    if (u.miss === 'missed_agy') ub = u.eff || 0; // can tren (khong tach duoc token cua luot web): rieng, KHONG cong vao excess_cost_share
    else if (u.miss === 'main_overread') { const p = price(u.model); ex = p ? (u.eff * (p - 1)) / p : 0; }
    else if (u.src === 'dispatch' && u.miss !== 'builder_over_turns') { const pa = price(u.act), pe = price(u.exp); ex = pa && pe && u.eff != null ? (u.eff * (pa - pe)) / pa : 0; }
    excess += ex; upper += ub;
    misses.push({ type: u.miss, cls: u.cls, sid: String(u.sid).slice(0, 8), excess: ex, upper: ub });
  }
  const knownEff = known.reduce((a, u) => a + (u.eff || 0), 0);
  const nKnown = known.length;
  const rate = (a, b) => (b ? a / b : null);
  const reviews = known.filter((u) => u.src === 'dispatch' && u.cls === 'review');
  const rows = [
    { k: 'compliance_rate', v: rate(known.filter((u) => !u.miss).length, nKnown) },
    ...MISS_ORDER.map((k) => ({ k, v: cnt[k] })),
    { k: 'review_opus_share', v: rate(reviews.filter((u) => u.act === 'opus').length, reviews.length) }, // trung tinh
    { k: 'model_param_ignored', v: known.filter((u) => u.src === 'dispatch' && u.req && u.act && u.req !== u.act).length }, // tham so model khi dispatch khong duoc theo
    { k: 'excess_upper_bound', v: upper }, // token (can tren) cua missed_agy; khac don vi voi excess_cost_share
    { k: 'excess_cost_share', v: rate(excess, knownEff) },
    { k: 'unknown_share', v: rate(units.filter((u) => u.src !== 'agy' && u.unknown).length, units.filter((u) => u.src !== 'agy').length) },
  ];

  // agy vs Claude theo lop viec (token, khong gia agy)
  const agyU = units.filter((u) => u.src === 'agy');
  const claudeU = known;
  const byClass = {};
  const stat = (arr) => ({ n: arr.length, median_eff: median(arr.map((u) => u.eff).filter((x) => x != null)), median_wall_ms: median(arr.map((u) => u.wall).filter((w) => w > 0)), error_rate: rate(arr.reduce((a, u) => a + u.fail, 0), arr.reduce((a, u) => a + u.calls, 0)) });
  for (const cls of new Set([...agyU, ...claudeU].map((u) => u.cls))) byClass[cls] = { agy: stat(agyU.filter((u) => u.cls === cls)), claude: stat(claudeU.filter((u) => u.cls === cls)) };
  const probs = (arr) => new Set(arr.map((u) => u.problem).filter(Boolean)).size;
  const cpp = (arr) => { const p = probs(arr); return p ? arr.reduce((a, u) => a + (u.eff || 0), 0) / p : null; };
  const claudeSegs = units.filter((u) => u.src === 'main' && !u.unknown);
  const withProb = agyU.filter((u) => u.problem);
  const redo = withProb.filter((a) => claudeSegs.some((c) => c.problem === a.problem && c.write && Date.parse(c.start) > Date.parse(a.end) && Date.parse(c.start) - Date.parse(a.end) <= ROUTING.redoMs));
  const err = (arr) => rate(arr.reduce((a, u) => a + u.fail, 0), arr.reduce((a, u) => a + u.calls, 0));
  const agy = [
    { k: 'share', v: rate(agyU.length, agyU.length + claudeU.length) },
    { k: 'cost_per_problem', v: cpp(agyU) },
    { k: 'redo_rate', v: rate(redo.length, withProb.length) },
    { k: 'error_rate', v: err(agyU) },
    { k: 'claude_cost_per_problem', v: cpp(claudeSegs) },
    { k: 'claude_error_rate', v: err(claudeU) },
  ];
  return { rows, agy, misses, byClass, unit: 'eff_tokens', rawDispatch: known.filter((u) => u.src === 'dispatch' && u.eff == null).length, unmatchedStarts, units: units.length, unknown: units.filter((u) => u.src !== 'agy' && u.unknown).length, agyNote: 'agy cost: tokens, unpriced', truncated };
}

// Cache theo (from,to) trong a.memo: 3 section dung chung 1 lan tinh.
const calc = (a) => {
  const k = `routing|${a.from}|${a.to}`;
  if (a.memo && a.memo[k]) return a.memo[k];
  if (a.deadline && Date.now() > a.deadline) return { rows: [], agy: [], misses: [], truncated: 'timeout' };
  const segments = a.getSegments ? a.getSegments({ from: a.from, to: a.to }) : [];
  const r = routing({ events: a.events || [], segments, from: a.from, to: a.to, deadline: a.deadline, hubDir: a.projectDir });
  if (a.memo) a.memo[k] = r;
  return r;
};

export const derive = {
  routing_kpi: (a) => { const r = calc(a); return { rows: r.rows, truncated: r.truncated }; },
  agy_kpi: (a) => { const r = calc(a); return { rows: r.agy, truncated: r.truncated }; },
  routing_misses: (a) => {
    const r = calc(a); const g = new Map();
    for (const m of r.misses) { const k = `${m.type}:${m.cls}`; const x = g.get(k) || { k, n: 0, excess: 0, upper: 0 }; x.n++; x.excess += m.excess; x.upper += m.upper; g.set(k, x); }
    return { rows: [...g.values()].sort((x, y) => y.excess - x.excess || y.n - x.n), truncated: r.truncated };
  },
};
