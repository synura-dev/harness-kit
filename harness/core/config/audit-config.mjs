// Single source of truth for audit defaults. audit.config.json / audit.config.local.json only override.
export const DEFAULTS = {
  retention_days: 30,
  max_file_bytes: 5242880,
  default_type: "other",
  schema_version: 2,
  base_path: "",
  transcript_max_bytes: 8388608,
  noise_cwd: ["(^|/)(bench|scratch[^/]*|zz-eval[^/]*|mcp-test)(/|$)"],
  bash_target_max: 160,
  error_max: 200,
  agent_lookup_max_bytes: 1048576,
  limits: {
    digest_max_rows: 200,
    query_timeout_ms: 30000,
    query_max_bytes: 209715200,
    query_max_rows: 100000,
    migrate_max_files: 2000,
  },
  events: {
    PreToolUse: "tool",
    PostToolUse: "tool",
    PostToolUseFailure: "tool",
    PostToolBatch: "tool",
    SessionStart: "session",
    SessionEnd: "session",
    Stop: "session",
    PostInvocation: "session",
    PreInvocation: "session",
    Setup: "session",
    SubagentStart: "subagent",
    SubagentStop: "subagent",
    UserPromptSubmit: "prompt",
    UserPromptExpansion: "prompt",
    PermissionRequest: "permission",
    PermissionDenied: "permission",
    Notification: "permission",
  },
  ok_events: {
    PostToolUse: true,
    PostToolUseFailure: false,
  },
  event_data: {
    "*": ["cli","step_idx","permission_mode","source","reason","notification_type","from_model","to_model","model"],
  },
  tools: [
    {"match":"Bash","target":["command"],"kind":"command","data":["timeout"]},
    {"match":"Read","target":["file_path"],"kind":"path","data":["offset","limit"]},
    {"match":"Write","target":["file_path"],"kind":"path"},
    {"match":"Edit","target":["file_path"],"kind":"path","data":["replace_all"]},
    {"match":"MultiEdit","target":["file_path"],"kind":"path"},
    {"match":"NotebookEdit","target":["notebook_path"],"kind":"path","data":["edit_mode"],"len":["new_source"]},
    {"match":"Grep","target":["pattern"],"kind":"pattern","data":["glob","type"]},
    {"match":"Glob","target":["pattern"],"kind":"pattern"},
    {"match":"WebFetch","target":["url"],"kind":"url","len":["prompt"]},
    {"match":"WebSearch","target":["query"],"kind":"pattern"},
    {"match":"Agent","target":["subagent_type"],"kind":"pattern","data":["isolation","model","run_in_background"],"len":["prompt"]},
    {"match":"Task","target":["subagent_type"],"kind":"pattern","data":["model"],"len":["prompt"]},
    {"match":"Skill","target":["skill"],"kind":"pattern"},
    {"match":"mcp__*","target":["file_path","path","url","query","name","id"],"kind":"auto","len":["message","body"]},
    {"match":"MCP","target":["name","pattern","tool_name"],"kind":"pattern","data":["server","server_name","tool_name"]},
  ],
  default_tool: {
    target: ["file_path","path","url","command","pattern"],
    kind: "auto",
  },
  redact: [
    "(token|key|secret|password|bearer|authorization)\\s*[=:]\\s*((bearer|basic)\\s+)?\\S+",
    "bearer\\s+[A-Za-z0-9._~+/=-]{3,}",
    "(?<![\\w-])--(?!no-)[\\w-]*(?:password|passwd|passphrase|pass(?=\\s)|secret(?:[-_]?key)?|token|api[-_]?key|private[-_]?key)(?:-[\\w-]*)?(?<!-file)(?<!-dir)(?<!-path)\\s+(?:\"[^\"]*\"|'[^']*'|\\S+)",
    "(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}",
    "(?<![A-Za-z0-9])AKIA[0-9A-Z]{10,}",
    "(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{10,}",
    "sk-[A-Za-z0-9_-]{8,}",
    "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}",
    "github_pat_[A-Za-z0-9_]{8,}",
    "\\d{6,}:[A-Za-z0-9_-]{30,}",
    "eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]*",
    "[a-z][a-z0-9+.-]{0,31}://[^\\s/:@]+:[^\\s/@]+@",
    "\"(token|password|passwd|secret|api_?key|access_?token|authorization)\"\\s*:\\s*\"[^\"]*\"",
    "(https?://[^\\s?#]+)\\?[^\\s]*",
  ],
  sensitive_files: ["^\\.env","^access\\.json$","\\.pem$","\\.key$"],
};


import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from './config.mjs';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'observe', 'audit'); // noi dat audit.config.json
// Data root: CLAUDE_AUDIT_DIR (compat) || <HUB_DATA_DIR || <hub>/data>/audit.
export { auditRoot } from '../audit/audit-write.mjs';
export const configFiles = () => [path.join(HERE, 'audit.config.json'), path.join(HERE, 'audit.config.local.json')];
// -> { config, warnings }. Env overrides: CLAUDE_AUDIT_RETENTION_DAYS, CLAUDE_AUDIT_MAX_FILE_BYTES.
export const loadAuditConfig = (files = configFiles()) => loadHookConfig('audit', {
  defaults: DEFAULTS, files,
  env: { CLAUDE_AUDIT_RETENTION_DAYS: 'retention_days', CLAUDE_AUDIT_MAX_FILE_BYTES: 'max_file_bytes' },
});

// 'noise' when cwd matches any cfg.noise_cwd regex (case-insensitive, slashes normalized), else 'work'. Label only.
export function originOf(cwd, cfg = {}) {
  const c = String(cwd || '').replace(/\\/g, '/');
  for (const p of cfg.noise_cwd || []) { try { if (new RegExp(p, 'i').test(c)) return 'noise'; } catch {} }
  return 'work';
}
