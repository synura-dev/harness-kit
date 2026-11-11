// Khoa van de theo doan (T3): tach audit events thanh Segment (prompt -> prompt ke tiep, cung sid), gan khoa task > plan > branch > err > kw.
// Pure: khong I/O. Chi doc truong audit.mjs thuc su ghi (xem cost-contract.mjs); khong luu van ban prompt (chi prompt_kw da chuan hoa).
import { isHookRun } from '../../core/audit/signals.mjs';
import { LIMITS, emptySegment, effTokens } from './cost-contract.mjs';

const PLAN_RE = /docs\/superpowers\/(?:specs|plans)\/\d{4}-\d{2}-\d{2}-(.+?)(?:-design)?\.md/;
const WT_RE = /\/\.worktrees\/([^/]+)/;
const AGENT_WT = /^agent-[0-9a-f]{6,}$/;
const GIT_B_RE = /\bgit\s+(?:checkout\s+-b|switch\s+-c)\s+(\S+)|\bgit\s+worktree\s+add\b[^\n]*?\s-b\s+(\S+)/;
const KGET_RE = /\bharness\s+knowledge\s+get\s+([\w.-]+)/;
const KSEARCH_RE = /\bharness\s+knowledge\s+search\b/;
const num = (v) => (Number.isFinite(v) ? v : 0);
const goodBranch = (b) => (b && !AGENT_WT.test(b) ? b : null);

function planOf(e) {
  const paths = [e.target, ...(Array.isArray(e.data && e.data.files_touched) ? e.data.files_touched : [])];
  for (const p of paths) { const m = typeof p === 'string' && p.match(PLAN_RE); if (m) return m[1]; }
  return null;
}
function branchOf(e) {
  const m = typeof e.cwd === 'string' && e.cwd.match(WT_RE);
  if (m && goodBranch(m[1])) return m[1];
  const g = typeof e.target === 'string' && e.target.match(GIT_B_RE);
  return g ? goodBranch((g[1] || g[2]).replace(/^['"]|['"]$/g, '')) : null;
}

function ledgerFamily(ledger, fp) {
  for (const x of Array.isArray(ledger) ? ledger : []) {
    if (x && x.id && (x.fp === fp || (x.evidence && x.evidence.fp === fp) || (Array.isArray(x.legacy_fps) && x.legacy_fps.includes(fp)))) return String(x.id);
  }
  return null;
}

function pick(seg, ledger) {
  const k = seg.keys;
  if (k.task) return ['task:' + k.task, 'high', 'task:' + k.task];
  if (k.plan) return ['plan:' + k.plan, 'high', 'plan:' + k.plan];
  if (k.branch) return ['branch:' + k.branch, 'mid', 'branch:' + k.branch];
  if (k.fp) return ['err:' + k.fp, 'mid', ledgerFamily(ledger, k.fp) || 'err:' + k.fp];
  if (k.kw) return ['kw:' + k.kw, 'low', 'kw:' + k.kw];
  return null;
}

/**
 * @param {object[]} events audit envelope v2
 * @param {{limits?:object, ledger?:object[]}} [opts] ledger: entries {id, fp | evidence.fp | legacy_fps} de gan family cho khoa err
 * @returns {{segments: import('./cost-contract.mjs').Segment[], truncated: string|null}}
 */
export function segment(events, opts = {}) {
  const lim = { ...LIMITS, ...(opts.limits || {}) };
  const out = [];
  let truncated = null;
  const cur = new Map(); // sid -> {seg, subs:{id:max}, started:Set, first, last, stopTs, prev:[problem,precision,family]|null, hasPrompt}
  const close = (st) => {
    const { seg } = st;
    seg.eff_tokens = effTokens(seg.tokens);
    seg.sub_tokens = Object.values(st.subs).reduce((a, b) => a + b, 0);
    seg.end_ts = st.last;
    const a = Date.parse(seg.start_ts), b = Date.parse(st.stopTs);
    seg.wall_ms = Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a : 0;
    seg.keys.kw = seg.prompt_kw.length ? [...seg.prompt_kw].sort().slice(0, 3).join('+') : null;
    const p = pick(seg, opts.ledger);
    if (p) [seg.problem, seg.precision, seg.family] = p;
    else if (st.prev) [seg.problem, seg.precision, seg.family] = st.prev;
    st.carry = seg.problem ? [seg.problem, seg.precision, seg.family] : st.carry;
    // pre-prompt doan rong (khong tool/token) khong co y nghia
    if (!st.hasPrompt && !seg.tools && !seg.turns && !seg.eff_tokens && !seg.sub_tokens && !seg.fetches) return;
    if (out.length >= lim.maxSegments) { truncated = 'max_segments'; return; }
    out.push(seg);
  };
  const open = (sid, e, prev, hasPrompt) => {
    const seg = emptySegment();
    seg.sid = sid; seg.start_ts = e.ts || null;
    const st = { seg, subs: {}, started: new Set(), last: e.ts || null, stopTs: null, prev, hasPrompt, carry: prev };
    cur.set(sid, st);
    return st;
  };
  const evs = (Array.isArray(events) ? events : []).slice(0, lim.maxEvents).filter((e) => e && e.sid && !isHookRun(e) && e.origin !== 'noise');
  evs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); // stable
  for (const e of evs) {
    if (truncated) break;
    let st = cur.get(e.sid);
    if (e.event === 'UserPromptSubmit' || e.type === 'prompt') {
      if (st) close(st);
      const prev = st ? st.carry : null;
      st = open(e.sid, e, prev, true);
      const kw = e.data && e.data.prompt_kw;
      st.seg.prompt_kw = Array.isArray(kw) ? kw.filter((w) => typeof w === 'string').slice(0, 8) : [];
      continue;
    }
    if (!st) st = open(e.sid, e, null, false);
    const seg = st.seg, d = e.data || {};
    st.last = e.ts || st.last;
    if (d.task_id && !seg.keys.task) seg.keys.task = String(d.task_id);
    const pl = planOf(e); if (pl && !seg.keys.plan) seg.keys.plan = pl;
    const br = branchOf(e); if (br && !seg.keys.branch) seg.keys.branch = br;
    if (d.error_fp && !seg.keys.fp) seg.keys.fp = String(d.error_fp);
    if (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') {
      seg.tools++;
      const t = typeof e.target === 'string' ? e.target.trim() : '';
      const g = t.match(KGET_RE);
      if (g) seg.kfetch.push(g[1]);
      if (g || KSEARCH_RE.test(t) || t.startsWith('kpi-info-fetch.json')) seg.fetches++;
    } else if (e.event === 'Stop') {
      const u = d.usage;
      if (u && typeof u === 'object') {
        seg.tokens.input += num(u.input); seg.tokens.output += num(u.output);
        seg.tokens.cache_read += num(u.cache_read); seg.tokens.cache_creation += num(u.cache_creation);
        seg.turns += num(u.msgs);
      }
      st.stopTs = e.ts;
    } else if (e.event === 'SubagentStart' && e.agent_id) {
      st.started.add(e.agent_id);
    } else if (e.event === 'SubagentStop' && e.agent_id && st.started.has(e.agent_id)) {
      const v = d.phantom ? 0 : num(e.tokens_in) + num(e.tokens_out);
      st.subs[e.agent_id] = Math.max(st.subs[e.agent_id] || 0, v);
    }
  }
  for (const st of cur.values()) close(st);
  out.sort((a, b) => (a.start_ts < b.start_ts ? -1 : a.start_ts > b.start_ts ? 1 : 0));
  return { segments: out, truncated };
}
