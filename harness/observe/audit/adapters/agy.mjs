// Antigravity (AGY) lifecycle hook adapter for audit logging (lives with the audit group; no import from .claude).
// Receives AGY hook JSON on stdin, normalizes fields for audit.mjs, and records audit envelope.
// Always outputs {} and exits 0 (fail-open).

import fs from 'node:fs';
import { readStdinRaw } from '../stdin.mjs';
import { TOOL_MAP, makePick, getSid } from '../../../core/io/agy-payload.mjs';
import path from 'node:path';
import { compile, redact, cut } from '../redact.mjs';
import { fileURLToPath } from 'node:url';
import * as audit from '../audit.mjs';
import os from 'node:os';
import { sumAgyUsage, stepDuration, exitCodeOf, exitStatusOf, agyTranscriptPath } from './agy-usage.mjs';

const TAIL_BYTES = 65536;
const TAIL_MS = 100;
const STOP_BAD = /^(ERROR|MAX_)/;

// Doc DUOI file (toi da TAIL_BYTES), bo dong dau do dang. Loi/khong co file -> null (fail-open).
function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

// Exit code tu noi dung buoc GENERIC cung stepIdx trong duoi transcript.
function stepExit(text, stepIdx) {
  const pat = `"step_index":${Number(stepIdx)}`;
  for (const line of text.split('\n')) {
    if (!line.includes(pat)) continue;
    try { const e = JSON.parse(line); if (e.type === 'GENERIC' && e.step_index === Number(stepIdx)) return exitCodeOf(e.content); } catch {}
  }
  return null;
}

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// has_timeout (ms|null) cho run_command cua agy: nhan dien `timeout N[smhd]` bang regex luc ghi.
function agyTimeoutMs(cmd) {
  if (typeof cmd !== 'string') return null;
  const m = cmd.match(/(?:^|[;&|(]\s*)g?timeout\s+(?:-\S+\s+)*(\d+(?:\.\d+)?)([smhd]?)(?=\s|$)/m);
  if (!m) return null;
  const mul = { '': 1000, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return Math.round(Number(m[1]) * mul);
}

// Marker PreToolUse -> dur_ms = thoi diem Post - Pre theo (conversation, step_idx). Loi thi bo qua (fail-open).
const PRE_TTL_MS = 3600000;
const markerDir = (root) => path.join(root, '.agy_pre');
const markerFile = (root, sid, step) => path.join(markerDir(root), `${String(sid).replace(/[^\w.-]/g, '_')}-${step}.json`);
function writePre(root, sid, step, now) {
  const d = markerDir(root);
  fs.mkdirSync(d, { recursive: true });
  for (const n of fs.readdirSync(d).slice(0, 200)) {
    try { const p = path.join(d, n); if (now - fs.statSync(p).mtimeMs > PRE_TTL_MS) fs.rmSync(p, { force: true }); } catch {}
  }
  fs.writeFileSync(markerFile(root, sid, step), JSON.stringify({ ts: now }));
}
function takePre(root, sid, step, now) {
  try {
    const f = markerFile(root, sid, step);
    const t = JSON.parse(fs.readFileSync(f, 'utf8')).ts;
    fs.rmSync(f, { force: true });
    const d = now - t;
    return Number.isFinite(d) && d >= 0 ? d : null;
  } catch { return null; }
}

function detectError(inp) {
  // Check inp.error
  if (inp.error != null) {
    const msg = typeof inp.error === 'string' ? inp.error.trim() : (inp.error.message || JSON.stringify(inp.error));
    if (msg) return { hasError: true, error: msg };
  }

  // Check inp.status
  if (typeof inp.status === 'string' && /^(error|failed|failure)$/i.test(inp.status)) {
    return { hasError: true, error: inp.status };
  }

  // Check toolResult / tool_result / toolResponse / tool_response / result
  const res = inp.toolResult || inp.tool_result || inp.toolResponse || inp.tool_response || inp.result;
  if (res != null) {
    if (typeof res === 'object') {
      if (res.isError === true || res.is_error === true || res.ok === false || res.success === false) {
        const msg = res.error || res.message || res.stderr || res.output || 'Tool execution failed';
        return { hasError: true, error: typeof msg === 'string' ? msg : JSON.stringify(msg), exitCode: res.exitCode ?? res.exit_code };
      }
      if (typeof res.status === 'string' && /^(error|failed|failure)$/i.test(res.status)) {
        return { hasError: true, error: res.error || res.message || res.status, exitCode: res.exitCode ?? res.exit_code };
      }
      if (res.error) {
        const msg = typeof res.error === 'string' ? res.error : (res.error.message || JSON.stringify(res.error));
        return { hasError: true, error: msg, exitCode: res.exitCode ?? res.exit_code };
      }
      const code = res.exitCode ?? res.exit_code ?? res.code;
      if (typeof code === 'number' && code !== 0) {
        const msg = res.stderr || res.output || res.error || `Exit code ${code}`;
        return { hasError: true, error: typeof msg === 'string' ? msg : `Exit code ${code}`, exitCode: code };
      }
      // Inspect string output or content for exit code or tool failure
      const out = typeof res.output === 'string' ? res.output : (typeof res.content === 'string' ? res.content : null);
      if (out) {
        const exitMatch = out.match(/Command exited with code ([1-9]\d*)/i);
        if (exitMatch) {
          return { hasError: true, error: `Exit code ${exitMatch[1]}`, exitCode: Number(exitMatch[1]) };
        }
        if (/^Encountered error in tool execution:/i.test(out.trim())) {
          return { hasError: true, error: out.trim().split('\n')[0] };
        }
      }
    } else if (typeof res === 'string') {
      const exitMatch = res.match(/Command exited with code ([1-9]\d*)/i) || res.match(/^Exit code ([1-9]\d*)/i);
      if (exitMatch) {
        return { hasError: true, error: `Exit code ${exitMatch[1]}`, exitCode: Number(exitMatch[1]) };
      }
      if (/^Encountered error in tool execution:/i.test(res.trim())) {
        return { hasError: true, error: res.trim().split('\n')[0] };
      }
      if (/^(error|failed):/i.test(res.trim())) {
        return { hasError: true, error: res.trim().split('\n')[0] };
      }
    }
  }

  return { hasError: false };
}

/**
 * Hop dong HOOK_MODULE: chuan hoa payload agy -> ghi 1 ban ghi audit. KHONG in stdout/exit.
 * event === 'pre' hoac ctx.mode === 'pre' -> chi ghi marker thoi gian (khong ghi ban ghi). Con lai su kien lay tu payload.
 * ctx (tuy chon): { mode, cfg, root, capture (file), write:false (chi dung ban ghi, khong ghi file) }. Tra { record } hoac {}. Khong nem.
 */
export function handle(event, input, ctx = {}) {
  try {
    const inp = input && typeof input === 'object' && !Array.isArray(input) ? structuredClone(input) : null;
    const isPre = ctx.mode === 'pre' || event === 'pre';
    if (inp) {
      const diag = { agy_raw_event: String(inp.hook_event_name || inp.hookEventName || inp.event || inp.eventName || ""), pid: process.pid, ppid: process.ppid, argv0: path.basename(String(process.argv0 || process.argv[0] || "")), payload_keys: Object.keys(inp).slice(0, 40) };
      // Tuy chon (mac dinh TAT): HUB_AGY_CAPTURE=<file> ghi stdin tho da redact (moi dong 1 payload) de lay mau that.
      const captureFile = ctx.capture || process.env.HUB_AGY_CAPTURE;
      if (captureFile) {
        try {
          const rc = audit.readAuditConfig();
          fs.appendFileSync(captureFile, cut(redact(JSON.stringify(inp), compile(rc.redact)), 20000) + '\n');
        } catch {}
      }
      // Normalize session & CLI fields
      inp.session_id = getSid(inp) || inp.session_id;
      inp.cli = 'agy';
      if (inp.stepIdx != null) inp.step_idx = inp.stepIdx;
      if (typeof inp.modelName === 'string' && inp.modelName) inp.model = inp.modelName;

      // Che do `pre` (PreToolUse): chi ghi marker thoi gian, khong ghi envelope.
      if (isPre) {
        try {
          if (inp.session_id && inp.step_idx != null) writePre(ctx.root || audit.auditRoot(), inp.session_id, inp.step_idx, Date.now());
        } catch {}
        return {};
      }

      // transcript: payload (SessionStart/PostInvocation/Stop) hoac suy tu conversationId (Post tool khong co); file khong ton tai/loi -> bo
      try {
        let tPath = typeof inp.transcriptPath === 'string' && inp.transcriptPath.endsWith('.jsonl') ? inp.transcriptPath : null;
        if (!tPath && typeof inp.conversationId === 'string' && /^[\w-]+$/.test(inp.conversationId)) {
          const d = agyTranscriptPath(inp.conversationId, ctx.home || os.homedir());
          if (fs.existsSync(d)) tPath = d;
        }
        if (tPath) inp.transcript_path = tPath;
      } catch {}

      // Workspace / cwd (agy cwd = .agents/)
      const wp = Array.isArray(inp.workspacePaths) && typeof inp.workspacePaths[0] === 'string' ? inp.workspacePaths[0] : null;
      inp.cwd = inp.cwd || inp.workspacePath || wp || path.resolve(HERE, '..', '..', '..');

      // Determine event name
      const rawEvent = inp.hook_event_name || inp.hookEventName || inp.event || inp.eventName;
      const tc = inp.toolCall && typeof inp.toolCall === 'object' ? inp.toolCall : {};
      let eventInferred = false;
      const agyName = tc.name || inp.toolName || inp.tool_name;

      if (rawEvent) {
        inp.hook_event_name = rawEvent;
      } else if (agyName) {
        inp.hook_event_name = 'PostToolUse';
      } else if (inp.terminationReason != null || inp.fullyIdle != null) {
        inp.hook_event_name = 'Stop';
        eventInferred = true;
      } else if (inp.invocationNum != null) {
        inp.hook_event_name = 'UserPromptSubmit';
        eventInferred = true;
      } else {
        inp.hook_event_name = 'SessionStart';
        eventInferred = true;
      }

      // Handle tool calls
      const isToolEvent = inp.hook_event_name === 'PostToolUse' || inp.hook_event_name === 'PreToolUse' || !!agyName;
      if (isToolEvent && agyName) {
        const args = tc.args || inp.toolInput || inp.tool_input || {};
        const pick = makePick(args);

        let mappedTool = TOOL_MAP[agyName];
        if (!mappedTool && agyName.startsWith('mcp_')) mappedTool = 'MCP';
        inp.tool_name = mappedTool || agyName;
        inp.tool_input = { ...args };

        // Tool-specific input normalization
        if (inp.tool_name === 'Bash') {
          if (inp.tool_input.command == null) {
            inp.tool_input.command = pick('CommandLine', 'commandLine', 'command', 'cmd');
          }
        } else if (inp.tool_name === 'Read' || inp.tool_name === 'Write' || inp.tool_name === 'Edit') {
          if (inp.tool_input.file_path == null) {
            inp.tool_input.file_path = pick('Path', 'path', 'TargetFile', 'AbsolutePath', 'filePath', 'file_path');
          }
          if (inp.tool_name === 'Read') {
            if (inp.tool_input.offset == null) inp.tool_input.offset = pick('StartLine', 'offset', 'ByteOffset');
            if (inp.tool_input.limit == null) inp.tool_input.limit = pick('EndLine', 'limit');
          }
        } else if (inp.tool_name === 'MCP') {
          let serverName = pick('ServerName', 'serverName', 'server_name', 'server');
          let toolName = pick('ToolName', 'toolName', 'tool_name', 'tool');
          if ((!serverName || !toolName) && agyName.startsWith('mcp_')) {
            const parts = agyName.slice(4).split('_');
            serverName = serverName || parts[0];
            toolName = toolName || parts.slice(1).join('_');
          }
          inp.tool_input.server_name = serverName;
          inp.tool_input.server = serverName;
          inp.tool_input.tool_name = toolName;
          const targetName = serverName && toolName ? `${serverName}/${toolName}` : (toolName || serverName);
          inp.tool_input.name = targetName;
          inp.tool_input.pattern = targetName;
        } else if (inp.tool_name === 'Agent') {
          if (agyName === 'invoke_subagent') {
            const subType = pick('TypeName', 'typeName', 'Role', 'role', 'subagent_type', 'type') || 'subagent';
            inp.tool_input.subagent_type = subType;
            inp.tool_input.prompt = pick('Prompt', 'prompt');
            const ws = pick('Workspace', 'workspace');
            if (ws) inp.tool_input.isolation = ws;
            const mdl = pick('Model', 'model');
            if (mdl) inp.tool_input.model = mdl;
          } else if (agyName === 'send_message') {
            const recipient = pick('Recipient', 'recipient') || 'peer';
            inp.tool_input.subagent_type = recipient;
            inp.tool_input.recipient = recipient;
            const msg = pick('Message', 'message');
            inp.tool_input.prompt = msg;
            inp.tool_input.message = msg;
          }
        }
      }

      // Error detection for tools
      const errInfo = detectError(inp);
      if (errInfo.hasError) {
        inp.ok = false;
        inp.status = 'error';
        inp.tool_response = inp.tool_response || {};
        inp.tool_response.ok = false;
        inp.tool_response.status = 'error';
        if (errInfo.error && !inp.error) inp.error = errInfo.error;
      }

      // Session & Lifecycle normalization (SessionStart, Stop, PostInvocation)
      const isSessionEvent = inp.hook_event_name === 'SessionStart' || inp.hook_event_name === 'Stop' || inp.hook_event_name === 'PostInvocation' || inp.hook_event_name === 'SessionEnd';
      // Task 0: payload agy khong co usage/tokens; token lay tu transcript (core + sumAgyUsage).
      const dur = inp.duration_ms ?? inp.durationMs ?? inp.duration;
      if (dur != null && !isNaN(Number(dur))) inp.duration_ms = Number(dur);

      if (inp.hook_event_name === 'SessionStart') {
        inp.source = inp.source || 'agy';
      } else if (inp.hook_event_name === 'PostInvocation') {
        if (!inp.status) inp.status = 'ok';
      }

      try {
        const cfg = ctx.cfg || audit.readAuditConfig();
        const root = ctx.root || audit.auditRoot();
        const env = audit.buildEnvelope(inp, cfg, new Date(), { root, usage: { sum: sumAgyUsage } });

        try {
          const res = compile(cfg.redact);
          const c = (v) => cut(redact(String(v), res), 80);
          env.data.agy_raw_event = c(diag.agy_raw_event);
          if (eventInferred) env.data.event_inferred = true;
          env.data.pid = diag.pid;
          env.data.ppid = diag.ppid;
          env.data.argv0 = c(diag.argv0);
          env.data.payload_keys = diag.payload_keys.map(c);
        } catch {}

        if (env.tool === 'Bash' && inp.tool_input) env.data.has_timeout = agyTimeoutMs(inp.tool_input.command);
        let exitCode = errInfo.exitCode ?? null;
        if (env.tool && inp.session_id && inp.step_idx != null) {
          if (env.dur_ms == null) {
            const d = takePre(root, inp.session_id, inp.step_idx, Date.now());
            if (d != null) { env.dur_ms = d; env.data.dur_src = 'marker'; }
          }
          // Mot lan doc duoi transcript cho ca dur (khi chua co marker) va exit code.
          const wantDur = env.dur_ms == null;
          const wantExit = exitCode == null && (errInfo.hasError || env.tool === 'Bash');
          if ((wantDur || wantExit) && inp.transcript_path) {
            const text = readTail(inp.transcript_path);
            if (text) {
              if (wantDur) { const d = stepDuration(text, inp.step_idx, Date.now() + TAIL_MS); if (d != null) { env.dur_ms = d; env.data.dur_src = 'transcript'; } }
              if (wantExit) exitCode = stepExit(text, inp.step_idx);
            }
          }
        }
        if (exitCode == null && errInfo.hasError) exitCode = exitStatusOf(errInfo.error); // shortcut: "exit status N" theo tai lieu, chua thay that

        // Post-process envelope if needed
        if (errInfo.hasError) {
          env.ok = false;
          env.status = 'error';
          if (errInfo.error && !env.data.error) env.data.error = errInfo.error;
        }
        if (exitCode != null && (errInfo.hasError || exitCode !== 0)) env.data.exit_code = exitCode;
        if (exitCode != null && exitCode !== 0) { env.ok = false; env.status = 'error'; } // khop detectError "Command exited with code [1-9]"

        // Stop: ly do dung that cua agy
        if (inp.hook_event_name === 'Stop' && typeof inp.terminationReason === 'string') {
          const tr = inp.terminationReason;
          env.data.stop_reason = tr;
          if (inp.executionNum != null) env.data.exec_num = Number(inp.executionNum);
          if (typeof inp.fullyIdle === 'boolean') env.data.fully_idle = inp.fullyIdle;
          if (STOP_BAD.test(tr)) { env.ok = false; env.status = 'error'; }
          if (tr === 'USER_CANCELED') env.data.signal = 'interrupt';
        }

        if (isSessionEvent) {
          if (env.type === 'other') env.type = 'session';
          if (inp.duration_ms != null && env.dur_ms == null) env.dur_ms = Number(inp.duration_ms);
          if (inp.hook_event_name === 'PostInvocation' && (!env.status || env.status === 'unknown')) {
            env.status = 'ok';
          }
        }

        // Re-compute summary after all normalized overrides
        env.summary = audit.summarizeEvent(env);

        if (ctx.write !== false) audit.writeEnvelope(env, cfg, root);
        return { record: env };
      } catch (auditErr) {
        // Silent fail-open
      }
    }
  } catch { /* fail-open */ }
  return {};
}

// Vo mong: doc stdin -> handle() -> in dung output cu ({"decision":"allow"} o che do pre, {} con lai), luon exit 0.
// VERIFIED agy 1.4.3: PostToolUse/SessionStart phai in object khong truong la; decision bi protojson tu choi.
async function main() {
  const isPre = process.argv[2] === 'pre';
  try {
    let raw = '';
    try { raw = await readStdinRaw(); } catch { raw = ''; }
    if (raw && raw.trim()) {
      let inp = {};
      try {
        let text = raw.trim();
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        inp = JSON.parse(text);
      } catch { inp = {}; }
      handle(undefined, inp, { mode: isPre ? 'pre' : undefined });
    }
  } catch { /* fail-open */ } finally {
    process.stdout.write((isPre ? '{"decision":"allow"}' : '{}') + String.fromCharCode(10));
    process.exit(0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
