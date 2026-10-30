// bash-guard cho agy (PreToolUse, run_command). Fail-open: loi -> `{}`, exit 0.
// VERIFIED agy 1.4.3 (2026-10-27): agy phat PreToolUse, stdin khong co hook_event_name;
// `{"decision":"deny","reason":..}` chan duoc tool; `updatedInput` bi protojson tu choi (va chan tool) -> KHONG dung.
// Nen o day chi chuyen quyet dinh deny cua hook.mjs sang dinh dang agy; bo qua updatedInput (khong gan timeout mac dinh).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, load } from '../hook.mjs';
import { readJsonStdin, isMain, writeOut, ALLOW, getSid, getCommand } from '../io.mjs';
import { replaceReason, repeatReason, noteMutation, logDeny } from '../../../core/agy/hints.mjs';

// Chuyen payload agy -> input kieu Claude roi quyet dinh; tra object output agy.
// root = thu muc marker (audit root); khong co -> bo qua kiem lap (fail-open).
export function agyDecide(payload, cfg, root = null) {
  const sid = getSid(payload);
  const tc = payload && typeof payload === 'object' ? payload.toolCall : null;
  if (!tc || typeof tc !== 'object') return ALLOW;
  if (tc.name === 'write_file' || tc.name === 'edit_file') { if (cfg.agy_repeat) noteMutation(root, sid); return ALLOW; }
  if (tc.name !== 'run_command' || !tc.args || typeof tc.args !== 'object') return ALLOW;
  const command = getCommand(tc.args);
  const out = decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, timeout: 1 } }, cfg);
  const h = out && out.hookSpecificOutput;
  if (h && h.permissionDecision === 'deny') return { decision: 'deny', reason: String(h.permissionDecisionReason || 'bash-guard') };
  if (cfg.enabled && cfg.agy_replace) {
    const r = replaceReason(command);
    if (r) { logDeny(root, 'replace'); return { decision: 'deny', reason: 'bash-guard: ' + r }; }
  }
  if (cfg.enabled && cfg.agy_repeat) {
    const r = repeatReason(root, sid, command, cfg.agy_repeat_ttl_ms);
    if (r) { logDeny(root, 'repeat'); return { decision: 'deny', reason: 'bash-guard: ' + r }; }
  }
  return ALLOW;
}

// Module agy (hop dong HOOK_MODULE): ctx.config / ctx.root ghi de; ket qua {decision:'deny', reason} hoac undefined (cho qua). Khong tu ghi stdout.
export function handle(event, input, ctx = {}) {
  const cfg = ctx && ctx.config ? ctx.config : load().config;
  const out = agyDecide(input, cfg, ctx && ctx.root !== undefined ? ctx.root : null);
  return out && out.decision === 'deny' ? { decision: 'deny', reason: out.reason } : undefined;
}

async function main() {
  let out = ALLOW;
  try {
    const payload = readJsonStdin();
    let root = null;
    try { root = (await import('../../../core/audit/audit-write.mjs')).auditRoot(); } catch {}
    const r = handle('PreToolUse', payload, { config: load().config, root });
    out = r && r.decision === 'deny' ? { decision: 'deny', reason: r.reason } : ALLOW;
  } catch { out = ALLOW; }
  writeOut(JSON.stringify(out));
}

if (isMain(import.meta.url)) { await main(); process.exit(0); }
