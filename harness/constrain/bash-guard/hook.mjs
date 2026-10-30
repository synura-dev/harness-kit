// bash-guard (PreToolUse, matcher Bash): gan timeout mac dinh cho Bash va chan vai mau treo hep. Fail-open tuyet doi.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { readJsonStdin, isMain, writeOut } from './io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  enabled: true,
  default_timeout_ms: 120000,
  max_timeout_ms: 600000,
  deny_message: 'Write file vao scratchpad roi chay (khong dung python - / python -c nhieu dong / heredoc dai).',
  heredoc_max_lines: 3,
  agy_replace: true, // agy: deny lenh don gian thay duoc bang Read/Glob/Grep
  agy_repeat: true, // agy: deny lenh read-only giong het vua chay
  agy_repeat_ttl_ms: 60000,
};

export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('bash-guard', { defaults: DEFAULTS, files, env: { BASH_GUARD_ENABLED: 'enabled' } });

const PY = String.raw`(?:^|[;&|(]\s*)(?:py|python3?)(?:\.exe)?`;
const RE_PY_STDIN = new RegExp(PY + String.raw`(?:\s+-[A-Za-z])*\s+-(?=\s|$)`, 'm');
const RE_PY_C = new RegExp(PY + String.raw`\s+-c\s`, 'm');

// -> ly do (string) neu thuoc mau hep can chan, nguoc lai null.
export function denyReason(cmd, cfg) {
  if (typeof cmd !== 'string') return null;
  if (RE_PY_STDIN.test(cmd)) return 'python doc stdin (python -)';
  if (RE_PY_C.test(cmd) && cmd.includes('\n')) return 'python -c nhieu dong';
  const m = cmd.match(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n([\s\S]*)/);
  if (m) {
    const lines = m[3].split('\n');
    const end = lines.findIndex((l) => l.trim() === m[2]);
    const n = end < 0 ? lines.length : end;
    if (n > (cfg.heredoc_max_lines ?? 3)) return `heredoc ${n} dong`;
  }
  return null;
}

// Quyet dinh thuan: tra ve doi tuong output hook ({} = khong lam gi).
export function decide(inp, cfg) {
  if (!cfg.enabled || !inp || typeof inp !== 'object' || Array.isArray(inp)) return {};
  if (inp.hook_event_name !== 'PreToolUse' || inp.tool_name !== 'Bash') return {};
  const ti = inp.tool_input;
  if (!ti || typeof ti !== 'object' || Array.isArray(ti)) return {};
  const why = denyReason(ti.command, cfg);
  if (why) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `bash-guard: ${why}. ${cfg.deny_message}` } };
  }
  if (ti.run_in_background === true) return {};
  const max = Number.isFinite(cfg.max_timeout_ms) ? cfg.max_timeout_ms : 600000;
  const def = Math.min(Number.isFinite(cfg.default_timeout_ms) ? cfg.default_timeout_ms : 120000, max);
  if (ti.timeout == null && def > 0) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, timeout: def } } };
  }
  return {};
}

// Module hook (hop dong HOOK_MODULE, core/config/contract.mjs): dispatcher goi handle(); khong tu ghi stdout/exit.
const META = { id: 'bash-guard', events: ['PreToolUse'], tools: /^Bash$/, timeoutMs: 2000, onError: 'open' };
/** Alias cu (test): handle dong bo goc. */
export const hookModule = Object.freeze({ ...META, handle });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). Module thuan: khong ghi file nao (ctx.write khong anh huong). */
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });

/** handle(event, input, ctx) -> {decision?, reason?, updatedInput?} | undefined. ctx.config ghi de (test); mac dinh load(). Thuan tru viec doc config. */
export function handle(event, input, ctx = {}) {
  const cfg = ctx && ctx.config ? ctx.config : load().config;
  const out = decide(input && typeof input === 'object' && !Array.isArray(input) ? { ...input, hook_event_name: event } : input, cfg);
  const h = out && out.hookSpecificOutput;
  if (!h) return undefined;
  if (h.permissionDecision === 'deny') return { decision: 'deny', reason: h.permissionDecisionReason };
  if (h.updatedInput) return { updatedInput: h.updatedInput };
  return undefined;
}

/** Ket qua handle -> JSON output Claude PreToolUse ({} khi khong y kien). */
export function toClaudeOutput(r) {
  if (!r || (!r.decision && !r.updatedInput)) return {};
  const h = { hookEventName: 'PreToolUse' };
  if (r.decision) { h.permissionDecision = r.decision; h.permissionDecisionReason = r.reason; }
  if (r.updatedInput) h.updatedInput = r.updatedInput;
  return { hookSpecificOutput: h };
}

function main() {
  let out = {};
  try {
    const inp = readJsonStdin();
    out = toClaudeOutput(handle(inp && inp.hook_event_name, inp, {}));
  } catch { out = {}; }
  writeOut(JSON.stringify(out));
}

if (isMain(import.meta.url)) { main(); process.exit(0); }
