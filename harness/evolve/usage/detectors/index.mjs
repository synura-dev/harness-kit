// Detector registry. Transcript records -> `skill` (pure, skill.mjs). Audit events -> `agent|command|hook|skillAudit` adapters
// wrapping the former countUsage logic in the same detect(record, ctx) -> event[] interface. No kind-specific code in the collector.
// ctx (audit): {doms: Map<domain,Set<cmd>>, gwFirst, seenAgents: Set, auditSkill: bool, stats: {hookrun_events, hookrun_since}}.
export { detect as skill } from './skill.mjs';
import { detect as skill } from './skill.mjs';

const HARNESS_RE = /(?:^|[\s;&|(])harness\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/;
const dataOf = (e) => (e.data && typeof e.data === 'object' ? e.data : {});
const idOf = (e) => e.tool_use_id || dataOf(e).tool_use_id;

export function command(e, ctx = {}) {
  if (e.gw) {
    if (!e.domain || !e.cmd || e.cmd === '(default)') return [];
    return [{ kind: 'command', id: `${e.domain}.${e.cmd}`, ts: e.ts, session: e.sid, origin: 'gateway', channel: 'gateway' }];
  }
  if (e.tool === 'Bash' && e.event === 'PreToolUse' && (!ctx.gwFirst || e.ts < ctx.gwFirst)) {
    const m = HARNESS_RE.exec(String(dataOf(e).cmd_line || e.target || ''));
    if (m && ctx.doms?.has(m[1]) && m[2] && ctx.doms.get(m[1]).has(m[2])) {
      return [{ kind: 'command', id: `${m[1]}.${m[2]}`, ts: e.ts, session: e.sid, origin: 'audit', channel: 'bash' }];
    }
  }
  return [];
}

export function hook(e, ctx = {}) {
  if (e.gw || e.event !== 'HookRun') return [];
  if (ctx.stats) { ctx.stats.hookrun_events++; if (!ctx.stats.hookrun_since || e.ts < ctx.stats.hookrun_since) ctx.stats.hookrun_since = e.ts; }
  return (dataOf(e).modules || []).filter((m) => m && m.id)
    .map((m) => ({ kind: 'hook', id: m.id, ts: e.ts, session: e.sid, origin: 'audit', channel: 'hookrun', cost: Number(m.ms) || 0 }));
}

// Mot lan goi subagent hien ca o PreToolUse (main) lan su kien cua subagent (agent_id): 'agent' + 'agentsub', collector lay max theo ten.
export function agent(e, ctx = {}) {
  if (e.gw) return [];
  const out = [];
  if ((e.tool === 'Agent' || e.tool === 'Task') && e.event === 'PreToolUse') {
    const n = String(dataOf(e).subagent_type || e.target || '').trim().split(/\s+/)[0];
    if (n) out.push({ kind: 'agent', id: n, ts: e.ts, session: e.sid, origin: 'audit', channel: 'tool', callId: idOf(e) });
  }
  if (e.agent_type && e.agent_id && ctx.seenAgents && !ctx.seenAgents.has(e.agent_id)) {
    ctx.seenAgents.add(e.agent_id);
    out.push({ kind: 'agentsub', id: e.agent_type, ts: e.ts, session: e.sid, origin: 'audit', channel: 'subagent' });
  }
  return out;
}

// Skill tu audit: callId = tool_use_id (khop transcript -> dem 1 lan). Thieu id + dang doc transcript (ctx.auditSkill=false) -> bo, tranh dem doi.
export function skillAudit(e, ctx = {}) {
  if (e.gw || e.tool !== 'Skill' || e.event !== 'PreToolUse') return [];
  const id = idOf(e);
  if (!id && ctx.auditSkill === false) return [];
  const full = String(dataOf(e).skill || e.target || '').trim().split(/\s+/)[0];
  if (!full) return [];
  return [{ kind: 'skill', id: full, short: full.split(':').pop(), ts: e.ts, session: e.sid, origin: 'audit', channel: 'tool', callId: id }];
}

export const detectors = { skill, agent, command, hook };
export const detectAudit = (e, ctx) => [command, hook, agent, skillAudit].flatMap((d) => d(e, ctx));
export const detectTranscript = (r, ctx) => skill(r, ctx);
