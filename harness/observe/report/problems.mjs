// Khoa van de theo doan (T3): tach audit events thanh Segment (prompt -> prompt ke tiep, cung sid), gan khoa task > plan > branch > err > kw.
// Pure: khong I/O. Chi doc truong audit.mjs thuc su ghi (xem cost-contract.mjs); khong luu van ban prompt (chi prompt_kw da chuan hoa).
// Don vi: tokens/eff_tokens = usage cua phien chinh (eff co trong so cache_read); sub_tokens = tokens_in+tokens_out THO cua subagent (KHONG eff, KHONG trong so).
import { isHookRun } from '../../core/audit/signals.mjs';
import { LIMITS, emptySegment, effTokens } from './cost-contract.mjs';

const PLAN_RE = /docs\/superpowers\/(?:specs|plans)\/\d{4}-\d{2}-\d{2}-(.+?)(?:-design)?\.md/;
const WT_RE = /\/\.worktrees\/([^/]+)/;
const AGENT_WT = /^agent-[0-9a-f]{6,}$/;
const GIT_B_RE = /\bgit\s+(?:checkout\s+-b|switch\s+-c)\s+(\S+)|\bgit\s+worktree\s+add\b[^\n]*?\s-b\s+(\S+)/;
const GIT_WRITE_RE = /\bgit\s+(?:commit|worktree\s+add|checkout\s+-b|switch\s+-c)\b/;
const KCMD_RE = /\bharness\s+knowledge\s+(get|search)\b(.*)$/;
const TARGET_CUT = 160; // audit cat target o 160 ky tu: id o cuoi chuoi bi cat la id cut -> bo
const VALUE_FLAGS = new Set(['--budget', '--limit', '--section', '--max']);
/**
 * Parser chung cho `harness knowledge get|search` trong target Bash (problems + knowledge-roi).
 * Tach lenh noi bang && || ; | newline; get: bo co (--budget N), id = tu dau tien khong co, ho tro `web:<id>`, bo `#anchor`.
 * @returns {{kind:'get'|'search', id?:string|null, budget?:number|null}[]}
 */
export function parseKnowledgeCmds(target) {
  const t = typeof target === 'string' ? target.trim() : '';
  const out = [];
  const parts = t.split(/&&|\|\||[;|\n]/);
  parts.forEach((part, pi) => {
    const m = KCMD_RE.exec(part);
    if (!m) return;
    if (m[1] === 'search') { out.push({ kind: 'search' }); return; }
    const toks = m[2].trim().split(/\s+/).filter(Boolean);
    let id = null, budget = null;
    for (let i = 0; i < toks.length; i++) {
      const k = toks[i];
      if (k.startsWith('--')) {
        const [name, val] = k.split('=');
        if (name === '--budget') budget = Number(val != null ? val : toks[i + 1]);
        if (val == null && VALUE_FLAGS.has(name)) i++;
        continue;
      }
      if (id == null) id = k.replace(/#.*$/, '');
    }
    const last = toks.length ? toks[toks.length - 1].replace(/#.*$/, '') : null;
    const cutId = t.length >= TARGET_CUT && pi === parts.length - 1 && id != null && last === id;
    out.push({ kind: 'get', id: id && !cutId && /^[\w.:-]+$/.test(id) ? id : null, budget: Number.isFinite(budget) ? budget : null });
  });
  return out;
}
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Tu chung chung (prompt_kw da fold/bo dau): khong du de lam khoa van de.
const GENERIC_KW = new Set(['tiep', 'tuc', 'lam', 'ok', 'oke', 'okay', 'di', 'xong', 'continue', 'go', 'proceed', 'yes', 'no', 'y', 'n', 'co', 'roi', 'nhe', 'nua', 'cu', 'vay', 'duoc', 'va', 'thanks', 'cam', 'on', 'next', 'done', 'dung', 'khong']);
const INHERIT_TTL_MS = 6 * 3600000;
const num = (v) => (Number.isFinite(v) ? v : 0);
const goodBranch = (b) => (b && !AGENT_WT.test(b) ? b : null);
const slash = (s) => (typeof s === 'string' ? s.replace(/\\/g, '/') : '');

const isWrite = (e) => WRITE_TOOLS.has(e.tool) || (typeof e.target === 'string' && GIT_WRITE_RE.test(e.target));

function planOf(e) {
  const paths = [e.target, ...(Array.isArray(e.data && e.data.files_touched) ? e.data.files_touched : [])];
  for (const p of paths) { const m = PLAN_RE.exec(slash(p)); if (m) return m[1]; }
  return null;
}
function branchOf(e) {
  const m = WT_RE.exec(slash(e.cwd));
  if (m && goodBranch(m[1])) return m[1];
  const g = GIT_B_RE.exec(slash(e.target));
  return g ? goodBranch((g[1] || g[2]).replace(/^['"]|['"]$/g, '')) : null;
}

function ledgerFamily(ledger, fp) {
  for (const x of Array.isArray(ledger) ? ledger : []) {
    if (x && x.id && (x.fp === fp || (x.evidence && x.evidence.fp === fp) || (Array.isArray(x.legacy_fps) && x.legacy_fps.includes(fp)))) return String(x.id);
  }
  return null;
}

function pick(seg, planWritten, ledger) {
  const k = seg.keys;
  if (k.task) return ['task:' + k.task, 'high', 'task:' + k.task];
  if (k.plan) return ['plan:' + k.plan, planWritten ? 'high' : 'mid', 'plan:' + k.plan];
  if (k.branch) return ['branch:' + k.branch, 'mid', 'branch:' + k.branch];
  if (k.fp) return ['err:' + k.fp, 'mid', ledgerFamily(ledger, k.fp) || 'err:' + k.fp];
  if (k.kw) return ['kw:' + k.kw, 'low', 'kw:' + k.kw];
  return null;
}

/**
 * @param {object[]} events audit envelope v2
 * @param {{limits?:object, ledger?:object[]}} [opts] ledger: entries {id, fp | evidence.fp | legacy_fps} de gan family cho khoa err
 * @returns {{segments: import('./cost-contract.mjs').Segment[], truncated: 'max_events'|'max_segments'|'timeout'|null}}
 */
export function segment(events, opts = {}) {
  const lim = { ...LIMITS, ...(opts.limits || {}) };
  const deadline = Date.now() + lim.timeoutMs;
  const out = [];
  let truncated = null, halt = false;
  const cur = new Map(); // sid -> state doan hien tai (+ carry khoa ke thua)
  const started = new Set(); // agent_id co SubagentStart trong cua so (toan cua so, khong theo doan)
  const subSeen = new Map(); // agent_id -> luy ke da quy cho cac doan truoc (chi cong phan tang them)
  const close = (st) => {
    const { seg } = st;
    seg.eff_tokens = effTokens(seg.tokens);
    seg.end_ts = st.last;
    const a = Date.parse(seg.start_ts), b = Date.parse(st.stopTs);
    seg.wall_ms = Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a : 0;
    const meaningful = seg.prompt_kw.filter((w) => !GENERIC_KW.has(w));
    seg.keys.kw = meaningful.length >= 2 ? [...meaningful].sort().slice(0, 3).join('+') : null;
    seg.keys.plan = st.wPlan || st.rPlan;
    seg.keys.branch = st.wBr || st.rBr;
    const p = pick(seg, !!st.wPlan, opts.ledger);
    const t0 = Date.parse(seg.start_ts);
    const fresh = st.prev && (!Number.isFinite(t0) || !Number.isFinite(st.prevEnd) || t0 - st.prevEnd <= INHERIT_TTL_MS);
    if (p) [seg.problem, seg.precision, seg.family] = p;
    else if (fresh) [seg.problem, seg.precision, seg.family] = st.prev;
    if (seg.problem) { st.carry = [seg.problem, seg.precision, seg.family]; st.carryEnd = Date.parse(st.last); }
    else { st.carry = null; st.carryEnd = NaN; }
    // pre-prompt doan rong (khong tool/token) khong co y nghia
    if (!st.hasPrompt && !seg.tools && !seg.turns && !seg.eff_tokens && !seg.sub_tokens && !seg.fetches) return;
    if (out.length >= lim.maxSegments) { truncated = truncated || 'max_segments'; halt = true; return; }
    out.push(seg);
  };
  const open = (sid, e, prev, prevEnd, hasPrompt) => {
    const seg = emptySegment();
    seg.sid = sid; seg.start_ts = e.ts || null;
    const st = { seg, last: e.ts || null, stopTs: null, prev, prevEnd, hasPrompt, carry: prev, carryEnd: prevEnd, wPlan: null, rPlan: null, wBr: null, rBr: null };
    cur.set(sid, st);
    return st;
  };
  let evs = (Array.isArray(events) ? events : []).filter((e) => e && e.sid && !isHookRun(e) && e.origin !== 'noise');
  evs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); // stable; sort truoc roi moi cat
  if (evs.length > lim.maxEvents) { evs = evs.slice(evs.length - lim.maxEvents); truncated = 'max_events'; } // giu phan MOI nhat
  for (let i = 0; i < evs.length; i++) {
    if (halt) break;
    if (i % 256 === 0 && Date.now() > deadline) { truncated = truncated || 'timeout'; break; }
    const e = evs[i];
    let st = cur.get(e.sid);
    if (e.event === 'UserPromptSubmit' || e.type === 'prompt') {
      let prev = null, prevEnd = NaN;
      if (st) { close(st); prev = st.carry; prevEnd = st.carryEnd; }
      st = open(e.sid, e, prev, prevEnd, true);
      const kw = e.data && e.data.prompt_kw;
      st.seg.prompt_kw = Array.isArray(kw) ? kw.filter((w) => typeof w === 'string').slice(0, 8) : [];
      continue;
    }
    if (!st) st = open(e.sid, e, null, NaN, false);
    const seg = st.seg, d = e.data || {};
    st.last = e.ts || st.last;
    if (d.task_id && !seg.keys.task) seg.keys.task = String(d.task_id);
    const w = isWrite(e);
    const pl = planOf(e); if (pl) { if (w) st.wPlan = st.wPlan || pl; else st.rPlan = st.rPlan || pl; }
    const br = branchOf(e); if (br) { if (w) st.wBr = st.wBr || br; else st.rBr = st.rBr || br; }
    if (d.error_fp && !seg.keys.fp) seg.keys.fp = String(d.error_fp);
    if (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') {
      seg.tools++;
      const t = typeof e.target === 'string' ? e.target.trim() : '';
      const kc = parseKnowledgeCmds(t);
      if (e.event === 'PostToolUse') for (const c of kc) if (c.kind === 'get' && c.id) seg.kfetch.push(c.id); // get loi khong tinh
      if (kc.length || t.startsWith('kpi-info-fetch.json')) seg.fetches++;
    } else if (e.event === 'Stop') {
      const u = d.usage;
      if (u && typeof u === 'object') {
        seg.tokens.input += num(u.input); seg.tokens.output += num(u.output);
        seg.tokens.cache_read += num(u.cache_read); seg.tokens.cache_creation += num(u.cache_creation);
        seg.turns += num(u.msgs);
      }
      st.stopTs = e.ts;
    } else if (e.event === 'SubagentStart' && e.agent_id) {
      started.add(e.agent_id);
    } else if (e.event === 'SubagentStop' && e.agent_id && started.has(e.agent_id)) {
      const v = d.phantom ? 0 : num(e.tokens_in) + num(e.tokens_out);
      const before = subSeen.get(e.agent_id) || 0;
      if (v > before) { seg.sub_tokens += v - before; subSeen.set(e.agent_id, v); }
    }
  }
  for (const st of cur.values()) close(st);
  out.sort((a, b) => (a.start_ts < b.start_ts ? -1 : a.start_ts > b.start_ts ? 1 : 0));
  return { segments: out, truncated };
}
