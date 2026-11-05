// audit view: checklist 7 muc cho mot ngay (SKILL.md). Quet su kien o day, dinh dang o view-format.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { loadAgents } from '../../../core/agy/agents.mjs';
import { workspaceRoot, isInside } from '../../../core/io/paths.mjs';
import { auditReadRoots } from '../../../core/audit/audit-write.mjs';
import { isTempPath, readCapped, collectJsonlFiles } from './util.mjs';
import { formatView } from './view-format.mjs';
import { isHookRun } from '../../../core/audit/signals.mjs';

function loadMaxTurns(hub) {
  const map = {};
  try { for (const x of loadAgents(hub).agents) if (x.maxTurns) map[x.name || x.dir] = x.maxTurns; } catch {}
  return map;
}
export async function runAuditReview(targetDate, opts = {}) {
  const hub = opts.hubDir || workspaceRoot();
  const bases = opts.auditDir ? [opts.auditDir] : auditReadRoots();
  const hasDay = (d) => bases.some((b) => fs.existsSync(path.join(b, d)));
  const auditBase = bases[0];
  // Resolve target date: default to today (local or UTC)
  let date = targetDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const localToday = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const utcToday = now.toISOString().slice(0, 10);
    if (hasDay(`date=${localToday}`)) {
      date = localToday;
    } else if (hasDay(`date=${utcToday}`)) {
      date = utcToday;
    } else {
      date = localToday;
    }
  }
  const dateDir = path.join(auditBase, `date=${date}`);
  if (!hasDay(`date=${date}`)) {
    return {
      date,
      totalEvents: 0,
      totalFiles: 0,
      lines: [
        `=== Audit Review: ${date} ===`,
        `No audit logs found at ${dateDir}`,
        `============================================================`
      ]
    };
  }
  const maxTurnsMap = loadMaxTurns(hub);
  const files = bases.flatMap((b) => collectJsonlFiles(path.join(b, `date=${date}`)));
  const deadline = Date.now() + (opts.timeoutMs || 30000);
  let totalEvents = 0;
  let verifiedErrors = 0;
  let unverifiedErrors = 0;
  const verifiedGroups = new Map();
  const subagentsMap = new Map();
  const maxTurnHits = [];
  const unboundedBash = [];
  let permPromptsCount = 0;
  const permPromptsTypes = new Map();
  let pathGuessingCount = 0;
  const mainExtWrites = [];
  const tokensMap = new Map();
  let truncated = false;
  let truncatedBytes = false;
  for (const file of files) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    let content = '';
    try { const r = readCapped(file, opts.maxBytes || 20 * 1024 * 1024); content = r.text; if (r.truncated) truncatedBytes = true; } catch { continue; }
    const lines = content.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      totalEvents++;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      if (isHookRun(e)) continue; // HookRun khong phai tool call (ok/tool/actor null)
      const sid = e.sid || e.session_id || 'unknown';
      const tool = e.tool;
      const target = e.target || '';
      const ok = e.ok;
      const status = e.status;
      const event = e.event;
      const actor = e.actor || (e.agent_id || e.agent_type ? 'sub' : 'main');
      const agent_id = e.agent_id || e.agent?.id || null;
      const agent_type = e.agent_type || e.agent?.type || null;
      const dur_ms = typeof e.dur_ms === 'number' ? e.dur_ms : null;
      const turns = typeof e.turns === 'number' ? e.turns : null;
      const ts = e.ts ? Date.parse(e.ts) : null;
      const data = (e.data && typeof e.data === 'object') ? e.data : {};
      // 1. Errors & false-positive detection
      const isErr = ok === false || status === 'error' || event === 'PostToolUseFailure';
      const errMsg = typeof data.error === 'string' ? data.error.trim() : (data.error?.message || (typeof e.error === 'string' ? e.error.trim() : ''));
      const exitCode = data.exit_code ?? data.exitCode ?? e.exitCode ?? e.exit_code;
      const hasExitErr = typeof exitCode === 'number' && exitCode !== 0;
      if (isErr) {
        if (!errMsg && !hasExitErr && (data.error_len === 0 || !data.error_len)) {
          unverifiedErrors++;
        } else {
          verifiedErrors++;
          const targetKey = `${tool || 'unknown'} | ${target ? target.replace(/\\\\/g, '/').slice(0, 70) : '(no target)'}`;
          verifiedGroups.set(targetKey, (verifiedGroups.get(targetKey) || 0) + 1);
          // Path guessing error detection
          if (/does not exist|no such file or directory|cannot access|is not recognized|EISDIR/i.test(errMsg) ||
              /Note: your current working directory is/i.test(errMsg) ||
              (/cannot find module/i.test(errMsg) && /projects\.mjs/i.test(errMsg))) {
            pathGuessingCount++;
          }
        }
      }
      // 2. Subagents tracking
      if (agent_id || agent_type || (event && event.startsWith('Subagent')) || e.type === 'subagent') {
        const subKey = agent_id || `${sid}:${agent_type || 'sub'}`;
        let sub = subagentsMap.get(subKey);
        if (!sub) {
          sub = { id: agent_id || subKey, type: agent_type, t0: null, t1: null, maxDur: 0, turns: 0, status: null, sid };
          subagentsMap.set(subKey, sub);
        }
        if (agent_type && !sub.type) sub.type = agent_type;
        if (status) sub.status = status;
        if (turns != null) sub.turns = Math.max(sub.turns, turns);
        if (dur_ms != null) sub.maxDur = Math.max(sub.maxDur, dur_ms);
        if (ts != null) {
          sub.t0 = sub.t0 === null ? ts : Math.min(sub.t0, ts);
          sub.t1 = sub.t1 === null ? ts : Math.max(sub.t1, ts);
        }
      }
      // 3. MaxTurns hits
      if (event === 'SubagentStop' || event === 'Stop' || e.type === 'subagent') {
        const limit = agent_type && maxTurnsMap[agent_type];
        if (status === 'partial' || (limit && turns != null && turns >= limit)) {
          maxTurnHits.push({ id: agent_id || sid, type: agent_type, turns, limit, status });
        }
      }
      // 4. Bash commands > 60s without timeout
      const toolLower = String(tool || '').toLowerCase();
      if (['bash', 'run_command', 'powershell'].includes(toolLower) && dur_ms != null && dur_ms > 60000) {
        const hasTimeout = /\btimeout\b/i.test(target);
        if (!hasTimeout) {
          unboundedBash.push({ dur_ms, target, sid });
        }
      }
      // 5. Permission prompts & notifications
      if (e.type === 'permission' || event === 'Notification' || event === 'PermissionRequest' || event === 'PermissionDenied') {
        permPromptsCount++;
        const ptype = data.notification_type || event || 'permission';
        permPromptsTypes.set(ptype, (permPromptsTypes.get(ptype) || 0) + 1);
      }
      // 6. Main session editing/writing external project code
      const isWriteTool = ['write', 'edit', 'multiedit', 'notebookedit', 'write_file', 'edit_file'].includes(toolLower);
      if (isWriteTool && (actor === 'main' || (!agent_id && actor !== 'sub')) && target) {
        const isHub = isInside(target, hub);
        const isTemp = isTempPath(target);
        if (!isHub && !isTemp) {
          mainExtWrites.push({ sid, target, tool });
        }
      }
      // 7. Token outliers per session x agent
      const tokIn = e.tokens_in ?? data.input_tokens ?? null;
      const tokOut = e.tokens_out ?? data.output_tokens ?? null;
      if (tokIn != null || tokOut != null) {
        const agentName = agent_type || agent_id || actor || 'main';
        const tokKey = `${sid}\u0000${agentName}`;
        let t = tokensMap.get(tokKey);
        if (!t) {
          t = { sid, agent: agentName, tin: 0, tout: 0 };
          tokensMap.set(tokKey, t);
        }
        if (tokIn != null) t.tin = Math.max(t.tin, tokIn);
        if (tokOut != null) t.tout = Math.max(t.tout, tokOut);
      }
    }
  }
  return formatView({ date, totalEvents, files, truncated, truncatedBytes, verifiedErrors, unverifiedErrors, verifiedGroups, subagentsMap, maxTurnHits, unboundedBash, permPromptsCount, permPromptsTypes, pathGuessingCount, mainExtWrites, tokensMap });
}
