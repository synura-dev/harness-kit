// Dispatcher cho agy (Dot 5.2b): cung loi voi run.mjs, ho so rieng. `node ../harness/hooks/dispatch/agy.mjs <Event>` (cwd = .agents/).
// Chay module co adapter agy: audit (adapters/agy.mjs, tu ghi), bash-guard (adapters/agy.mjs, deny), session (doctor luc SessionStart).
// VERIFIED agy 1.4.3 (xem hooks/README.md): PreToolUse stdout `{}` = deny moi tool -> PHAI in {"decision":"allow"}; PostToolUse/SessionStart in object khong truong la;
// updatedInput bi agy chan -> khong dung. Su kien lay tu argv (payload agy khong co hook_event_name; adapter audit tu suy ra nhu cu).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from './run.mjs';

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

/** session agy: doctor luc SessionStart, MISS/LOI -> stderr; khong chan phien. */
const SESSION_AGY = {
  id: 'session-agy', events: ['SessionStart'], timeoutMs: 9000, onError: 'open',
  async handle() {
    const r = spawnSync(process.execPath, [DOCTOR], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = String(r.stdout || '');
    if (/\[MISS\]|\[LOI\]/.test(out)) process.stderr.write(out);
    return {};
  },
};

const wrap = (m, gate = false) => ({ id: m.id, gate, load: async () => ({ default: m }) });
export const AGY_ORDER = Object.freeze({
  SessionStart: [wrap(AUDIT_AGY), wrap(SESSION_AGY)],
  PreToolUse: [wrap(BASH_GUARD_AGY, true), wrap(AUDIT_AGY)],
  PostToolUse: [wrap(AUDIT_AGY)],
  PostInvocation: [wrap(AUDIT_AGY)],
  Stop: [wrap(AUDIT_AGY)],
});

const ALLOW = '{"decision":"allow"}\n';
const NOOP = '{}\n';

/** Ket qua gop -> dinh dang agy: Pre = {"decision":"allow|deny|ask"[,reason]}, con lai {}. */
export function renderAgy(event, m) {
  if (event !== 'PreToolUse') return { stdout: NOOP, stderr: '', code: 0 };
  if (m.decision === 'deny' || m.decision === 'ask') return { stdout: JSON.stringify(m.reason === undefined ? { decision: m.decision } : { decision: m.decision, reason: m.reason }) + '\n', stderr: '', code: 0 };
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
