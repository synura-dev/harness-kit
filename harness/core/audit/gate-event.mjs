// Su kien chan/duyet co cau truc (gate|approval) dung chung moi hook (guard, data-gate...).
// Ghi envelope audit v2 vao <audit>/date=D/type=gate/<sid>.jsonl qua writeEnvelope. Fail-open: recordGate khong bao gio nem.
// Khong ghi lenh tho: reason/target bi che secret + cat ngan; rule/hook la id an toan.
import { writeEnvelope, auditRoot } from './audit-write.mjs';
import { safeId } from '../io/safe-id.mjs';

const GATE_KINDS = Object.freeze(['gate', 'approval']);
const DECISIONS = Object.freeze(['block', 'allow', 'ask', 'deny', 'warn']);
export const GATE_TYPE = 'gate';
const EVENT_NAME = Object.freeze({ gate: 'Gate', approval: 'Approval' });
const ALIAS = Object.freeze({ approve: 'allow', approved: 'allow', allowed: 'allow', denied: 'deny', blocked: 'block', reject: 'deny', rejected: 'deny' });

const truncStr = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) : s; };
// Che toi thieu (luon ap dung, them vao redact cua audit neu caller truyen opts.redact). Nhom:
// k1: key=value / key: value (ca "Authorization: <scheme> X"); k2: co CLI cach khoang trang "--password X", "--token X", "--api-key X";
// k3: "bearer X"; con lai: token dang ghp_/sk-/AKIA..., URL co user:pass@.
const SECRET = /((?:api[_-]?key|access[_-]?key|token|secret|passw(?:or)?d|pwd|auth(?:orization)?|cookie)\s*[=:]\s*)("[^"]*"|'[^']*'|(?:(?:bearer|basic|token|digest|negotiate|apikey)\s+)?\S+)|((?<![\w-])--?(?:password|passwd|pass|pwd|token|auth-token|access-token|api[_-]?key|access[_-]?key|secret|client-secret)\s+)("[^"]*"|'[^']*'|\S+)|\b(bearer\s+)\S+|\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{10,}|\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi;
// mysql/psql -p<mat khau> (dinh lien, phan biet hoa thuong: -P la cong). Chi che sau ten lenh, trong cung mot lenh (khong qua | ; &).
const DB_PASS = /\b((?:mysql|mysqldump|mysqladmin|mariadb|psql)(?:\.exe)?\b[^|;&\n]*?\s-p)("[^"]*"|'[^']*'|[^\s"']\S*)/g;
export function maskSecrets(s) {
  return String(s ?? '')
    .replace(DB_PASS, (m, k) => k + '***')
    .replace(SECRET, (m, k1, _v1, k2, _v2, k3) => (k1 || k2 || k3 ? (k1 || k2 || k3) + '***' : '***'));
}
const cleanField = (s, n, redact) => {
  if (s == null || s === '') return null;
  let t = String(s).replace(/\s+/g, ' ').trim();
  try { if (typeof redact === 'function') t = String(redact(t)); } catch {}
  return truncStr(maskSecrets(t), n) || null;
};

/** Chuan hoa decision: alias (approve->allow...) ; khong hop le -> null. */
export function normDecision(d) {
  const s = String(d ?? '').trim().toLowerCase();
  const v = ALIAS[s] || s;
  return DECISIONS.includes(v) ? v : null;
}

/**
 * Chuan hoa ban ghi gate. ev = { kind:'gate'|'approval', decision, hook, rule?, reason?, tool?, target?, tier?, verify_kind?, attempt? }.
 * Tra { kind, decision, hook, rule, reason, tool, target, tier, verify_kind, attempt } hoac null neu kind/decision sai.
 */
export function gateRecord(ev, opts = {}) {
  if (!ev || typeof ev !== 'object') return null;
  const kind = GATE_KINDS.includes(ev.kind) ? ev.kind : null;
  const decision = normDecision(ev.decision);
  if (!kind || !decision) return null;
  return {
    kind, decision,
    hook: safeId(ev.hook, 40) || null,
    rule: safeId(ev.rule, 80) || null,
    reason: cleanField(ev.reason, 200, opts.redact),
    tool: ev.tool ? safeId(ev.tool, 40) || null : null,
    target: cleanField(ev.target, 160, opts.redact),
    tier: ev.tier ? safeId(ev.tier, 20) || null : null,
    verify_kind: ev.verify_kind ? safeId(ev.verify_kind, 20) || null : null,
    attempt: Number.isFinite(ev.attempt) ? ev.attempt : null,
  };
}

/** Rut su kien duyet tu payload hook neu co: PermissionDenied -> deny, PermissionRequest -> ask, hoac decision tuong minh. */
export function gateFromPayload(inp, opts = {}) {
  if (!inp || typeof inp !== 'object') return null;
  const ev = String(inp.hook_event_name || '');
  const hso = inp.hookSpecificOutput && typeof inp.hookSpecificOutput === 'object' ? inp.hookSpecificOutput : {};
  const explicit = [hso.permissionDecision, inp.permission_decision, inp.decision].find((x) => typeof x === 'string' && x);
  let decision = explicit ? normDecision(explicit) : null;
  if (!decision && ev === 'PermissionDenied') decision = 'deny';
  if (!decision && ev === 'PermissionRequest') decision = 'ask';
  if (!decision) return null;
  const reason = [hso.permissionDecisionReason, inp.reason].find((x) => typeof x === 'string' && x);
  return gateRecord({ kind: 'approval', decision, hook: opts.hook || 'payload', rule: inp.rule, reason, tool: inp.tool_name }, opts);
}

/** Envelope audit v2 cho su kien gate (cung khung voi audit hook; data.gate = ban ghi). null neu ev sai. */
export function gateEnvelope(ev, ctx = {}, opts = {}) {
  const g = gateRecord(ev, opts);
  if (!g) return null;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const cli = safeId(ctx.cli || 'claude', 20).replace(/\./g, '') || 'claude';
  const raw = String(ctx.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'nosession';
  const sid = raw.startsWith(cli + '-') ? raw : `${cli}-${raw}`;
  const agent_id = ctx.agent_id ? truncStr(String(ctx.agent_id), 80) : null;
  const agent_type = ctx.agent_type ? truncStr(String(ctx.agent_type), 60) : null;
  const tid = (opts.env || process.env).HUB_TASK_ID || ctx.task_id;
  const data = { gate: g, task_id: tid ? safeId(String(tid)) : null };
  if (ev.signal) data.signal = safeId(ev.signal, 20) || undefined; // tin hieu ket qua (vd verify_fail)
  if (ctx.tool_use_id) data.tool_use_id = truncStr(String(ctx.tool_use_id).replace(/[^A-Za-z0-9_-]/g, ''), 80);
  const summary = truncStr(`${agent_id || agent_type ? agent_type || 'sub' : 'main'} ${g.kind} ${g.decision}${g.hook ? ' ' + g.hook : ''}${g.rule ? ':' + g.rule : ''}${g.reason ? ' | ' + g.reason : ''}`, 120);
  return {
    v: 2, ts: now.toISOString(), type: GATE_TYPE, event: EVENT_NAME[g.kind], cli, sid, agent_id, agent_type,
    actor: agent_id || agent_type ? 'sub' : 'main', project: ctx.project ? truncStr(String(ctx.project), 80) : null,
    cwd: truncStr(ctx.cwd || '', 240), tool: g.tool, target: null, target_kind: null, ok: null, dur_ms: null,
    turns: null, tokens_in: null, tokens_out: null, status: g.decision, model: null, summary, data, origin: ctx.origin || null,
  };
}

/**
 * API chung cho hook: recordGate(ev, ctx, opts) -> true khi da ghi, false khi bo qua/loi. KHONG nem.
 * ev: xem gateRecord. ctx: payload hook (session_id, cwd, agent_id, agent_type, tool_use_id, cli) hoac tuong tu.
 * opts: { root (mac dinh auditRoot()), cfg ({max_file_bytes}), now, redact(fn), env }.
 */
export function recordGate(ev, ctx = {}, opts = {}) {
  try {
    const env = gateEnvelope(ev, ctx || {}, opts);
    if (!env) return false;
    writeEnvelope(env, opts.cfg || {}, opts.root || auditRoot());
    return true;
  } catch { return false; }
}
