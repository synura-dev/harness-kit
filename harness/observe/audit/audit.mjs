// Audit hook entry: stdin JSON -> one envelope (schema v2) line in hive-partitioned jsonl. Never blocks, never prints.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeId } from '../../core/io/safe-id.mjs';
import { fingerprint, isVerifyCommand, verifyKind, verifierOutcome, relFiles } from '../../core/audit/fingerprint.mjs';
import { gateFromPayload } from '../../core/audit/gate-event.mjs';
import { promptTrace, promptSignal, bashSignal, versionStamp } from '../../core/audit/signals.mjs';
import { readStdinRaw } from './stdin.mjs';
import { partitionFile, writeEnvelope } from '../../core/audit/audit-write.mjs';
import { loadAuditConfig, auditRoot, hook_events } from './defaults.mjs';
import { auditReadRoots } from '../../core/audit/audit-write.mjs';
const rootsOf = (r) => (r === auditRoot() ? auditReadRoots() : [r]);
import { originOf } from '../../core/config/audit-config.mjs';
import { readUsageDelta } from './usage-tail.mjs';
import { compile, redact, cut, sanitizeSession, urlTarget, pathTarget } from './redact.mjs';

// DEFAULTS (defaults.mjs) < audit.config.json < audit.config.local.json < env. Never throws.
export function readAuditConfig(file) {
  return loadAuditConfig(file ? [file] : undefined).config;
}
export { auditRoot };

const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const targetKindOf = (kd) => (kd === 'path' || kd === 'url' || kd === 'command' ? kd : 'other');
import { numOrNull as num } from '../../core/io/fmt.mjs';

// project: under cfg.base_path -> first segment after it; worktree (<proj>/.claude/worktrees/<x>) -> <proj>; else cwd basename.
export function projectOf(cwd, cfg = {}) {
  const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!c) return null;
  const bp = String(cfg.base_path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (bp && (c.toLowerCase() + '/').startsWith(bp.toLowerCase() + '/')) {
    const rel = c.slice(bp.length).split('/').filter(Boolean)[0];
    if (rel) return cut(rel, 80);
  }
  const wt = c.match(/^(.*)\/\.claude\/worktrees\/[^/]+/);
  const base = (wt ? wt[1] : c).split('/').pop();
  return base ? cut(base, 80) : null;
}

// Tokens/turns/model from a transcript .jsonl (verified: assistant lines carry message.id/model/usage; one id repeats per content block).
// Returns null when unreadable or larger than maxBytes (never throws).
export function readUsage(file, maxBytes = 8388608) { return readUsageEx(file, maxBytes).usage; }

// -> { usage|null, reason: null|no_path|not_found|too_big|parse_fail } (never throws)
function readUsageEx(file, maxBytes = 8388608, sum = null) {
  let st;
  if (typeof file !== 'string' || !file) return { usage: null, reason: 'no_path' };
  if (!/\.jsonl$/i.test(file)) return { usage: null, reason: 'parse_fail' };
  try { st = fs.statSync(file); } catch { return { usage: null, reason: 'not_found' }; }
  if (!st.isFile()) return { usage: null, reason: 'not_found' };
  if (st.size > maxBytes) return { usage: null, reason: 'too_big' };
  if (sum) { // parser theo tool: sum(text) -> {input, output, cache_read, cache_creation, msgs, model}; loi -> fail-open
    try {
      const r = sum(fs.readFileSync(file, 'utf8'));
      if (!r) return { usage: null, reason: 'parse_fail' };
      if (!r.msgs) return { usage: null, reason: 'no_usage' };
      return { usage: { turns: r.msgs, tokens_in: (r.input || 0) + (r.cache_creation || 0), tokens_out: r.output || 0, tokens_cache: r.cache_read || 0, model: r.model || null }, reason: null };
    } catch { return { usage: null, reason: 'parse_fail' }; }
  }
  const usage = parseUsage(file);
  return usage ? { usage, reason: null } : { usage: null, reason: 'parse_fail' };
}

function parseUsage(file) {
  try {
    const by = new Map();
    let model = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const m = e && e.type === 'assistant' && e.message;
      if (!m || !m.usage || typeof m.usage !== 'object') continue;
      const id = m.id || e.uuid || String(by.size);
      const prev = by.get(id);
      if (!prev || (m.usage.output_tokens || 0) >= (prev.output_tokens || 0)) by.set(id, m.usage);
      if (m.model && m.model !== '<synthetic>') model = m.model;
    }
    let tin = 0, tout = 0, cache = 0;
    for (const u of by.values()) {
      tin += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      cache += u.cache_read_input_tokens || 0;
      tout += u.output_tokens || 0;
    }
    return { turns: by.size, tokens_in: tin, tokens_out: tout, tokens_cache: cache, model };
  } catch { return null; }
}

export { originOf }; // ban that o core/config/audit-config.mjs (alias toi 2026-10-29)

// SubagentStop often lacks agent_type: find it from the SubagentStart line (same agent_id) in today's session file. Bounded tail read; null on any problem.
export function lookupAgentType(root, sid, agentId, now, maxBytes = 1048576) {
  try {
    if (!root || !sid || !agentId) return null;
    const days = [now.toISOString().slice(0, 10), new Date(now.getTime() - 86400000).toISOString().slice(0, 10)];
    const cands = [];
    for (const rt of rootsOf(root)) for (const day of days) {
      const dir = path.join(rt, `date=${day}`, 'type=subagent');
      let names = []; try { names = fs.readdirSync(dir); } catch {}
      for (const f of names) if (f === sid + '.jsonl' || (f.startsWith(sid + '.') && f.endsWith('.jsonl'))) cands.push(path.join(dir, f));
    }
    for (const p of cands) {
      const size = fs.statSync(p).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(p, 'r');
      try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('SubagentStart') || !line.includes(agentId)) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e && e.event === 'SubagentStart' && e.agent_id === agentId && e.agent_type) return String(e.agent_type);
      }
    }
  } catch {}
  return null;
}

export function summarizeEvent(e, max = 120) {
  const who = e.actor === 'sub' ? (e.agent_type || 'sub') : 'main';
  let s;
  if (e.tool) s = `${who} ${e.tool} ${e.status || e.event}${e.target ? ': ' + e.target : ''}${e.dur_ms != null ? ` (${e.dur_ms}ms)` : ''}`;
  else if (e.tokens_out != null) s = `${who} ${e.event}: ${e.turns} turns, ${e.tokens_in}/${e.tokens_out} tokens in/out`;
  else s = `${who} ${e.event}${e.status ? ': ' + e.status : ''}`;
  if (e.event === 'PostToolUseFailure' && e.data && e.data.error) s += ' | ' + e.data.error;
  return cut(s.replace(/\s+/g, ' '), max);
}

const FILE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;

// Dem so lan cung error_fp da xuat hien trong phien (hom nay + hom qua). Doc duoi gioi han; 0 khi loi.
function countPriorFp(root, sid, fp, now, maxBytes = 262144) {
  let n = 0;
  try {
    const needle = `"error_fp":"${fp}"`;
    for (const [rt, day] of rootsOf(root).flatMap((r) => [now.toISOString().slice(0, 10), new Date(now.getTime() - 86400000).toISOString().slice(0, 10)].map((d) => [r, d]))) {
      const base = path.join(rt, `date=${day}`);
      let types = []; try { types = fs.readdirSync(base); } catch { continue; }
      for (const t of types) {
        const dir = path.join(base, t);
        let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
        for (const f of names) {
          if (!(f === sid + '.jsonl' || (f.startsWith(sid + '.') && f.endsWith('.jsonl')))) continue;
          const p = path.join(dir, f);
          const size = fs.statSync(p).size, len = Math.min(size, maxBytes), buf = Buffer.alloc(len);
          const fd = fs.openSync(p, 'r');
          try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
          for (const line of buf.toString('utf8').split('\n')) if (line.includes(needle)) n++;
        }
      }
    }
  } catch {}
  return n;
}

// Truong cho vong Observe->Diagnose (additive, trong data): task_id, error_fp, attempt/retry_of, files_touched, verify_kind, verifier_outcome.
// Khong ghi noi dung lenh/loi tho: chi hash + duong dan tuong doi.
function addOutcomeFields(data, c) {
  const { inp, ti, tr, tool, event, ok, sid, res, cfg, now, opts } = c;
  const env = opts.env || process.env;
  const tid = env.HUB_TASK_ID || inp.task_id;
  data.task_id = tid ? safeId(String(tid)) : null;
  const post = event === 'PostToolUse' || event === 'PostToolUseFailure';
  if (!post) return;
  if (ok === false || event === 'PostToolUseFailure') {
    const raw = typeof inp.error === 'string' ? inp.error : [tr.error, tr.stderr].find((x) => typeof x === 'string' && x);
    const fp = raw ? fingerprint(redact(raw, res), tool || '') : null;
    data.error_fp = fp;
    if (fp && opts.root) {
      const prior = countPriorFp(opts.root, sid, fp, now, cfg.agent_lookup_max_bytes || 262144);
      data.attempt = prior + 1;
      if (prior > 0) data.retry_of = prior;
    }
  }
  if (tool && FILE_TOOLS.test(tool) && event === 'PostToolUse' && ok !== false) {
    const fl = relFiles([ti.file_path, ti.notebook_path, ti.path].filter((x) => typeof x === 'string'), inp.cwd, cfg.files_touched_max || 10);
    if (fl.length) data.files_touched = fl.map((f) => cut(redact(f, res), 200));
  }
  if (tool === 'Bash') {
    // Xet tren LENH DAY DU (truoc khi cat target ~160 ky tu); chi ghi loai, khong ghi lenh tho.
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    const kind = verifyKind(cmd);
    data.verify_kind = kind;
    const trCode = [tr.exit_code, tr.exitCode, tr.returncode, tr.code].find((x) => typeof x === 'number' && isFinite(x));
    data.verifier_outcome = verifierOutcome({
      isVerify: !!kind || isVerifyCommand(cmd), event, ok, exitCode: data.exit_code ?? trCode,
      interrupted: tr.interrupted === true || inp.is_interrupt === true, background: ti.run_in_background === true,
    });
  }
}

// Tin hieu (data.signal), vet prompt (prompt_hash/prompt_kw, khong nguyen van), dau phien ban luc SessionStart (data.version). Chi hook ghi.
// Khong thu duoc: Stop (payload khong co co interrupt; chi tool events co interrupted/is_interrupt), gate_override (can doi chieu truoc-sau, khong re).
function addSignalFields(data, c) {
  const { inp, ti, tool, event, status } = c;
  let signal = null;
  if (event === 'UserPromptSubmit' && typeof inp.prompt === 'string') {
    const t = promptTrace(inp.prompt);
    if (t) { data.prompt_hash = t.prompt_hash; data.prompt_kw = t.prompt_kw; }
    signal = promptSignal(inp.prompt);
  } else if (event === 'SessionStart') {
    data.version = versionStamp({ cwd: inp.cwd });
  } else if (tool === 'Bash' && event === 'PostToolUse') {
    signal = bashSignal(ti.command);
  }
  if (!signal && status === 'interrupted') signal = 'interrupt';
  if (signal) data.signal = signal;
}

// opts.root (audit root) enables the SubagentStop agent_type lookup; omitted -> no file access.
export function buildEnvelope(inp, cfg, now = new Date(), opts = {}) {
  const res = compile(cfg.redact);
  const sens = (cfg.sensitive_files || []).map((s) => new RegExp(s, 'i'));
  const event = String(inp.hook_event_name || 'unknown');
  const type = (cfg.events && cfg.events[event]) || cfg.default_type || 'other';
  const tool = inp.tool_name ? String(inp.tool_name) : null;
  const ti = inp.tool_input && typeof inp.tool_input === 'object' ? inp.tool_input : {};
  const tr = inp.tool_response && typeof inp.tool_response === 'object' ? inp.tool_response : {};
  const data = {};
  let target = null, target_kind = null;

  if (tool) {
    const rule = (cfg.tools || []).find((r) => globRe(r.match).test(tool)) || cfg.default_tool || {};
    const kind = rule.kind || 'auto';
    for (const k of rule.target || []) {
      if (ti[k] == null || typeof ti[k] === 'object') continue;
      const v = String(ti[k]);
      const kd = kind === 'auto' ? (k === 'url' ? 'url' : k === 'command' ? 'command' : /path/.test(k) ? 'path' : 'pattern') : kind;
      if (kd === 'path') target = pathTarget(v, sens);
      else if (kd === 'url') target = urlTarget(v) || cut(redact(v, res), 160);
      else if (kd === 'command') {
        const full = redact(v, res), max = cfg.bash_target_max || 160;
        target = cut(full, max);
        data.target_truncated = full.length > max;
        const cdm = full.match(/^\s*cd\s+(?:\/d\s+)?(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*/i);
        data.cd_prefix = !!cdm;
        let rest = (cdm ? full.slice(cdm[0].length) : full).trim();
        for (let i = 0; i < 10; i++) { const m = rest.match(/^\w+=(?:"[^"]*"|'[^']*'|\S*)\s+/); if (!m) break; rest = rest.slice(m[0].length); } // skip FOO=bar prefixes (never expose values)
        const head = rest.match(/^[^\s]+/);
        if (head) data.cmd_head = cut(head[0], 40);
      }
      else target = cut(redact(v, res), 120);
      target_kind = targetKindOf(kd);
      break;
    }
    if (tool === 'Bash') { // do tuan thu timeout: has_timeout (ms|null), bg, cmd_line (dong dau da redact)
      data.has_timeout = typeof ti.timeout === 'number' && isFinite(ti.timeout) ? ti.timeout : null;
      data.bg = ti.run_in_background === true;
      if (typeof ti.command === 'string') data.cmd_line = cut(redact(ti.command, res).split(/\r?\n/, 1)[0].trim().replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, (m) => m.replace(/=(?:"[^"]*"|'[^']*'|\S*)/g, '=***')), 100);
    }
    for (const k of rule.data || []) if (ti[k] != null && typeof ti[k] !== 'object') data[k] = typeof ti[k] === 'string' ? cut(redact(ti[k], res), 80) : ti[k];
    for (const k of rule.len || []) if (typeof ti[k] === 'string') data[k + '_len'] = ti[k].length;
  }
  if (inp.tool_use_id) data.tool_use_id = cut(String(inp.tool_use_id).replace(/[^A-Za-z0-9_-]/g, ''), 80);
  if (typeof inp.prompt === 'string') data.prompt_len = inp.prompt.length;
  if (typeof inp.message === 'string') data.message_len = inp.message.length;
  if (typeof inp.error === 'string') {
    data.error_len = inp.error.length;
    const em = cfg.error_max == null ? 200 : cfg.error_max; // 0 disables storing error text
    if (em > 0) data.error = cut(redact(inp.error, res).replace(/\s+/g, ' ').trim(), em);
    const m = inp.error.match(/^Exit code (\d+)/);
    if (m) data.exit_code = Number(m[1]);
  }
  const ed = [...((cfg.event_data || {})['*'] || []), ...((cfg.event_data || {})[event] || [])];
  for (const k of ed) if (inp[k] != null && typeof inp[k] !== 'object' && k !== 'model') data[k] = cut(redact(inp[k], res), 80);

  // ok = real tool outcome: PostToolUse true (false if interrupted), PostToolUseFailure false, others null.
  let ok = cfg.ok_events && event in cfg.ok_events ? cfg.ok_events[event] : null;
  let status = null;
  if (event === 'PreToolUse') status = 'started';
  else if (event === 'PostToolUse') {
    if (tr.interrupted === true) { ok = false; status = 'interrupted'; }
    else if (tr.status === 'error' || tr.ok === false || inp.ok === false) { ok = false; status = 'error'; }
    else status = typeof tr.status === 'string' ? cut(tr.status, 30) : 'ok';
  } else if (event === 'PostToolUseFailure') status = inp.is_interrupt === true ? 'interrupted' : 'error';
  else if (event === 'Stop' || event === 'SubagentStop') status = 'stopped';
  else if (event === 'PostInvocation') status = typeof inp.status === 'string' ? cut(inp.status, 30) : 'ok';
  else if (event === 'SessionEnd') status = inp.reason ? cut(String(inp.reason), 30) : null;
  else if (event === 'SessionStart') status = inp.source ? cut(String(inp.source), 30) : null;

  let turns = num(inp.turns), tokens_in = num(inp.tokens_in), tokens_out = num(inp.tokens_out);
  let model = inp.model ? cut(String(inp.model), 60) : null;
  const agent_id = inp.agent_id ? String(inp.agent_id) : null;
  let agent_type = inp.agent_type ? String(inp.agent_type) : null;
  const cli = inp.cli ? cut(String(inp.cli).replace(/[^A-Za-z0-9_-]/g, ''), 20) || 'claude' : 'claude';
  const rawSid = sanitizeSession(inp.session_id, `${cli}|${inp.cwd || ''}|${process.ppid}|${now.toISOString().slice(0, 10)}`);
  const sid = rawSid.startsWith(cli + '-') ? rawSid : `${cli}-${rawSid}`;
  if (!agent_type && agent_id && event === 'SubagentStop' && opts.root) {
    agent_type = lookupAgentType(opts.root, sid, agent_id, now, cfg.agent_lookup_max_bytes || 1048576);
    if (agent_type) agent_type = cut(agent_type, 60);
  }
  if (event === 'Stop' || event === 'SubagentStop') {
    let file = event === 'SubagentStop' ? inp.agent_transcript_path : inp.transcript_path;
    if (event === 'SubagentStop' && !file && typeof inp.transcript_path === 'string' && inp.session_id && agent_id) {
      file = path.join(path.dirname(inp.transcript_path), String(inp.session_id), 'subagents', 'agent-' + agent_id + '.jsonl');
    }
    const sum = typeof opts.usage?.sum === 'function' ? opts.usage.sum : null;
    const { usage: u, reason } = readUsageEx(file, cfg.transcript_max_bytes || 8388608, sum);
    if (!u && event === 'SubagentStop' && !agent_type && (reason === 'no_path' || reason === 'not_found')) {
      // phantom: no agent_type, no matching SubagentStart, no readable transcript -> label.
      data.phantom = true; data.usage = 'unavailable'; data.usage_reason = 'no_transcript';
    } else if (u) { turns = u.turns; tokens_in = u.tokens_in; tokens_out = u.tokens_out; data.tokens_cache = u.tokens_cache; data.usage_mode = 'cumulative'; model = model || u.model; }
    else if (tokens_in == null && tokens_out == null) { data.usage = 'unavailable'; data.usage_reason = reason; }
    try { // usage moi ke tu Stop truoc (doc duoi transcript, tran 512KB/200ms, offset theo transcript trong state audit)
      const d = readUsageDelta(file, { root: typeof opts.root === 'string' ? opts.root : null, ...(sum ? { sum } : {}) });
      if (d && !(sum && !u && reason === 'no_usage' && !d.msgs)) { // parser rieng khong thay usage nao: khong ghi token 0 gia
        const { model: dm, ...usage } = d;
        data.usage = usage; delete data.usage_reason; delete data.phantom;
        if (tokens_in == null && tokens_out == null) { tokens_in = (d.input || 0) + (d.cache_creation || 0); tokens_out = d.output || 0; if (turns == null) turns = d.msgs; data.usage_mode = 'delta'; }
        model = model || dm;
      }
    } catch { /* fail-open */ }
    if (!model && opts.usage?.model) model = cut(String(opts.usage.model), 60); // model mac dinh cua tool: chi khi parser/payload khong co
  }
  if (event === 'SubagentStop') { // payload has no status/turns (verified); record only if a future payload adds them
    if (typeof inp.status === 'string') data.payload_status = cut(inp.status, 30);
    if (Number.isFinite(inp.turns)) data.payload_turns = inp.turns;
  }
  const runKind = (opts.env || process.env).HUB_RUN_KIND;
  if (runKind) data.run_kind = cut(String(runKind).replace(/[^A-Za-z0-9_.-]/g, ''), 20);
  const runId = (opts.env || process.env).HUB_RUN_ID;
  if (runId) data.run_id = safeId(runId);
  try { addSignalFields(data, { inp, ti, tool, event, status }); } catch {} // tin hieu + vet prompt + dau phien ban (re, fail-open)
  try { addOutcomeFields(data, { inp, ti, tr, tool, event, ok, status, sid, res, cfg, now, opts }); } catch {} // fail-open: khong lam mat su kien
  try { const g = gateFromPayload(inp, { hook: 'audit', redact: (s) => redact(s, res) }); if (g) data.gate = g; } catch {} // su kien duyet co cau truc neu payload co
  const env = {
    v: 2, ts: now.toISOString(), type, event,
    cli, sid, agent_id, agent_type, actor: agent_id || agent_type ? 'sub' : 'main',
    project: projectOf(inp.cwd, cfg), cwd: cut(inp.cwd || '', 240),
    tool, target, target_kind, ok, dur_ms: num(inp.duration_ms), turns, tokens_in, tokens_out, status, model, summary: '', data,
    origin: data.run_kind ? 'noise' : data.run_id ? 'dispatch' : originOf(inp.cwd, cfg),
  };
  env.summary = summarizeEvent(env);
  return env;
}

// partitionFile/writeEnvelope: nguon duy nhat o core/audit/audit-write.mjs.
export { partitionFile, writeEnvelope };

/**
 * Hop dong HOOK_MODULE: ghi 1 ban ghi audit, KHONG in stdout/exit. Khong y kien gate (khong decision).
 * ctx (tuy chon): { cfg, root, now, env, write:false (chi dung ban ghi, khong ghi file) }.
 * Tra { record: envelope, records: [{sink:'audit', data: envelope}] } (da ghi roi tru khi ctx.write === false -> dispatcher ghi tu records) hoac {} khi payload khong hop le. Khong nem.
 */
export function handle(event, input, ctx = {}) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const inp = event && !input.hook_event_name ? { ...input, hook_event_name: String(event) } : input;
    const cfg = ctx.cfg || readAuditConfig();
    const root = ctx.root || auditRoot();
    const opts = { root };
    if (ctx.env) opts.env = ctx.env;
    const env = buildEnvelope(inp, cfg, ctx.now || new Date(), opts);
    if (ctx.write !== false) writeEnvelope(env, cfg, root);
    return { record: env, records: [{ sink: 'audit', data: env }] };
  } catch { return {}; }
}

const META = { id: 'audit', events: Object.freeze(Object.keys(hook_events)), timeoutMs: 2500, onError: 'open' };
/** Alias cu (test): dang handle(input, ctx). Chuan dispatcher la export default. */
export const hook = Object.freeze({ ...META, handle: (input, ctx) => handle(input && input.hook_event_name, input, ctx) });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). ctx.write === false: khong ghi file, envelope nam trong records. */
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event || (input && input.hook_event_name), input, ctx) });

// Vo mong: doc stdin -> handle() -> khong in gi, luon exit 0.
export async function main() {
  try {
    const raw = await readStdinRaw();
    if (!raw.trim()) return;
    const inp = JSON.parse(raw);
    handle(undefined, inp, { write: true });
  } catch {}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { main().finally(() => process.exit(0)); }
