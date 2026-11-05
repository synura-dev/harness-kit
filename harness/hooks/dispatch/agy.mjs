// Dispatcher cho agy (Dot 5.2b): cung loi voi run.mjs, ho so rieng. `node ../harness/hooks/dispatch/agy.mjs <Event>` (cwd = .agents/).
// Chay module co adapter agy: audit (adapters/agy.mjs, tu ghi), bash-guard (adapters/agy.mjs, deny), session (doctor luc SessionStart).
// VERIFIED agy 1.4.3 (xem hooks/README.md): PreToolUse stdout `{}` = deny moi tool -> PHAI in {"decision":"allow"}; PostToolUse/SessionStart in object khong truong la;
// updatedInput bi agy chan -> khong dung. Su kien lay tu argv (payload agy khong co hook_event_name; adapter audit tu suy ra nhu cu).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { main } from './run.mjs';
import { TOOL_MAP, getCommand, makePick } from '../../core/io/agy-payload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.resolve(HERE, '..', '..', 'cli', 'commands', 'doctor.mjs');
const AGY_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop'];

const auditDir = async () => (await import('../../core/audit/audit-write.mjs')).auditRoot();

/** Audit agy: Pre -> chi ghi marker thoi gian (event 'pre'); con lai adapter tu suy su kien tu payload. Adapter tu ghi (khong qua records). */
const AUDIT_AGY = {
  id: 'audit-agy', events: AGY_EVENTS, timeoutMs: 2500, onError: 'open',
  async handle(event, input) {
    const a = await import('../../observe/audit/adapters/agy.mjs');
    a.handle(event === 'PreToolUse' ? 'pre' : undefined, input, { root: await auditDir() });
    return {};
  },
};

/** bash-guard agy: deny lenh hep / lap / thay duoc bang cong cu native (tu ghi marker cua no). */
const BASH_GUARD_AGY = {
  id: 'bash-guard-agy', events: ['PreToolUse'], timeoutMs: 2500, onError: 'open',
  async handle(event, input) {
    const a = await import('../../constrain/bash-guard/adapters/agy.mjs');
    const r = a.handle('PreToolUse', input, { root: await auditDir() });
    return r && r.decision === 'deny' ? { decision: 'deny', reason: r.reason } : {};
  },
};

/** Chuan hoa payload agy PreToolUse -> input kieu Claude (cung ham danh gia guard/approval, khong viet luat rieng cho agy).
 *  run_command -> Bash/PowerShell {command}; write_file/edit_file -> Write/Edit {file_path}. Khong ung -> null. */
export function toClaudeInput(input, toolName = 'Bash') {
  const tc = input && typeof input === 'object' ? input.toolCall : null;
  if (!tc || typeof tc !== 'object' || !tc.args || typeof tc.args !== 'object') return null;
  const pick = makePick(tc.args);
  const ws = Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string' ? input.workspacePaths[0] : '';
  const base = { hook_event_name: 'PreToolUse', session_id: String(input.conversationId || input.sessionId || ''), cwd: pick('Cwd', 'cwd') || ws, cli: 'agy' };
  if (tc.name === 'run_command') {
    const command = getCommand(tc.args);
    return { ...base, tool_name: toolName, tool_input: { command: typeof command === 'string' ? command : '' } };
  }
  if (tc.name === 'write_file' || tc.name === 'edit_file') {
    const fp = pick('TargetFile', 'Path', 'FilePath', 'file_path', 'AbsolutePath');
    return { ...base, tool_name: TOOL_MAP[tc.name], tool_input: { file_path: fp || '' } };
  }
  return null;
}

const RANK_D = { deny: 2, ask: 1 };
const strongest = (rs) => rs.reduce((a, r) => ((RANK_D[r && r.decision] || 0) > (RANK_D[a && a.decision] || 0) ? r : a), {});

/** guard agy: luat guard (force push, mongo, file nhay cam...) tren input chuan hoa. Loi -> {} (fail-open). */
const GUARD_AGY = {
  id: 'guard-agy', events: ['PreToolUse'], timeoutMs: 2500, onError: 'open',
  async handle(event, input, ctx) {
    const inp = toClaudeInput(input);
    if (!inp) return {};
    const g = (await import('../../constrain/guard/hook.mjs')).default;
    const r = await g.handle(event, inp, ctx);
    return r && r.decision === 'deny' ? r : (r && r.records ? { records: r.records } : {});
  },
};

/** approval agy: cung module approval cua Claude. agy chay lenh qua shell bat ky (Windows: PowerShell) -> danh gia ca Bash va PowerShell, lay muc manh nhat. */
const APPROVAL_AGY = {
  id: 'approval-agy', events: ['PreToolUse'], timeoutMs: 2500, onError: 'open',
  async handle(event, input, ctx) {
    if (!input || !input.toolCall || input.toolCall.name !== 'run_command') return {};
    const a = (await import('../../constrain/approval/hook.mjs')).default;
    const rs = [];
    for (const t of ['Bash', 'PowerShell']) rs.push(await a.handle(event, toClaudeInput(input, t), ctx));
    return strongest(rs);
  },
};

/** session agy: doctor luc SessionStart, MISS/LOI -> stderr; khong chan phien. */
const SESSION_AGY = {
  id: 'session-agy', events: ['SessionStart'], timeoutMs: 9000, onError: 'open',
  async handle() {
    try { // tu sinh lai shim + local.json neu thieu (chi khi du an da dung hook agy cua harness-kit)
      const ws = (process.env.CLAUDE_PROJECT_DIR || '').trim();
      const hj = ws && path.join(ws, '.agents', 'hooks.json');
      if (hj && fs.existsSync(hj) && /"harness-kit"/.test(fs.readFileSync(hj, 'utf8'))) { const { init } = await import('../../cli/commands/agy.mjs'); init({ dir: ws }); }
    } catch (e) { process.stderr.write('HKERR ' + JSON.stringify({ code: 'HK-AGY-003', severity: 'warn', cause: 'khong tu sinh duoc shim agy: ' + String(e && e.message).slice(0, 120), fix_command: 'harness agy init', next_step: 'chay lenh fix_command trong du an', safe: true, source: 'hooks/dispatch/agy.mjs' }) + '\n'); }
    const r = spawnSync(process.execPath, [DOCTOR], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = String(r.stdout || '');
    if (/\[MISS\]|\[LOI\]/.test(out)) process.stderr.write(out);
    return {};
  },
};

const wrap = (m, gate = false) => ({ id: m.id, gate, load: async () => ({ default: m }) });
export const AGY_ORDER = Object.freeze({
  SessionStart: [wrap(AUDIT_AGY), wrap(SESSION_AGY)],
  PreToolUse: [wrap(GUARD_AGY, true), wrap(APPROVAL_AGY, true), wrap(BASH_GUARD_AGY, true), wrap(AUDIT_AGY)],
  PostToolUse: [wrap(AUDIT_AGY)],
  PostInvocation: [wrap(AUDIT_AGY)],
  Stop: [wrap(AUDIT_AGY)],
});

const ALLOW = '{"decision":"allow"}\n';
const NOOP = '{}\n';

export const ASK_PREFIX = 'can nguoi duyet (agy -p khong hoi tuong tac duoc) / needs human approval: ';

/** Ket qua gop -> dinh dang agy: Pre = {"decision":"allow|deny"[,reason]}, con lai {}.
 *  ask -> deny kem ly do "can nguoi duyet" (agy -p khong co hoi tuong tac; schema that chi chac allow/deny). */
export function renderAgy(event, m) {
  if (event !== 'PreToolUse') return { stdout: NOOP, stderr: '', code: 0 };
  if (m.decision === 'ask') return { stdout: JSON.stringify({ decision: 'deny', reason: ASK_PREFIX + (m.reason || 'approval') }) + '\n', stderr: '', code: 0 };
  if (m.decision === 'deny') return { stdout: JSON.stringify(m.reason === undefined ? { decision: 'deny' } : { decision: 'deny', reason: m.reason }) + '\n', stderr: '', code: 0 };
  return { stdout: ALLOW, stderr: '', code: 0 };
}

export const AGY = Object.freeze({
  order: AGY_ORDER,
  render: renderAgy,
  setEvent: false, // adapter audit tu suy su kien nhu cu
  failOut: (e) => ({ stdout: e === 'PreToolUse' ? ALLOW : NOOP, stderr: '', code: 0 }),
  noop: (e) => ({ stdout: e === 'PreToolUse' ? ALLOW : NOOP, stderr: '', code: 0 }),
  // vet gate cua dispatcher: gan session agy (conversationId) de khong roi vao "nosession".
  mapRecords: (records, input) => records.map((r) => (r.sink === 'gate' && !r.ctx ? { ...r, ctx: { cli: 'agy', session_id: (input && (input.conversationId || input.sessionId)) || '' } } : r)),
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main({ event: process.argv[2] || '', only: process.argv[3] || '', profile: AGY }).catch(() => { process.stdout.write(NOOP); process.exit(0); });
