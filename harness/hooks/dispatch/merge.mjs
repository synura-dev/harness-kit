// Gop ket qua nhieu module + render dinh dang Claude Code. THUAN: khong I/O.
import { isObj } from '../../core/io/paths.mjs';
import { strongestDecision } from '../../core/config/contract.mjs';

/** Su kien Claude chap nhan {decision:'block', reason} o cap tren cung. */
const BLOCK_EVENTS = Object.freeze(['Stop', 'SubagentStop', 'PostToolUse', 'UserPromptSubmit']);

const join = (list, sep) => list.filter((x) => typeof x === 'string' && x).join(sep);

/** Ap updatedInput (thay toan bo tool_input) len input de module sau thay ban da sua. Khong doi input goc. */
export function applyUpdate(input, updatedInput) {
  return isObj(updatedInput) && isObj(input) ? { ...input, tool_input: updatedInput } : input;
}

/**
 * items: [{id, result}] theo thu tu chay. -> { decision, reason, updatedInput, additionalContext, block, blockReason, path, records }.
 * decision = manh nhat (deny > ask > allow), reason = ly do cua cac module cung muc do (noi ' | ').
 * updatedInput chi giu khi KHONG deny (module chay sau thay input da sua nen ban cuoi chua moi thay doi).
 */
export function mergeResults(items) {
  const rs = (Array.isArray(items) ? items : []).filter((x) => x && isObj(x.result));
  const decision = strongestDecision(rs.map((x) => x.result.decision));
  const reason = decision ? join(rs.filter((x) => x.result.decision === decision).map((x) => x.result.reason), ' | ') : '';
  let updatedInput;
  if (decision !== 'deny') for (const x of rs) if (isObj(x.result.updatedInput)) updatedInput = x.result.updatedInput;
  const blocked = rs.filter((x) => x.result.block === true);
  const path = rs.map((x) => x.result.record && x.result.record.path).find((p) => typeof p === 'string' && p);
  return {
    decision, reason: reason || undefined, updatedInput,
    additionalContext: join(rs.map((x) => x.result.additionalContext), '\n\n') || undefined,
    block: blocked.length > 0, blockReason: join(blocked.map((x) => x.result.reason), ' | ') || 'blocked',
    systemMessage: join(rs.map((x) => x.result.systemMessage), '\n') || undefined,
    path,
    records: rs.flatMap((x) => (Array.isArray(x.result.records) ? x.result.records : [])),
  };
}

/** Ket qua gop -> { stdout, stderr, code } theo dinh dang Claude cho tung su kien. */
export function render(event, m) {
  if (event === 'WorktreeCreate') {
    if (m.path && !m.block) return { stdout: m.path, stderr: '', code: 0 };
    return { stdout: '', stderr: (m.blockReason && m.blockReason !== 'blocked' ? m.blockReason : 'worktree create loi: khong co duong dan') + '\n', code: 1 };
  }
  if (event === 'WorktreeRemove') return { stdout: '', stderr: '', code: 0 };
  if (m.block && BLOCK_EVENTS.includes(event)) return { stdout: JSON.stringify({ decision: 'block', reason: m.blockReason }), stderr: '', code: 0 };
  const hso = { hookEventName: event };
  if (event === 'PreToolUse' && m.decision) {
    hso.permissionDecision = m.decision;
    if (m.reason !== undefined) hso.permissionDecisionReason = m.reason;
  }
  if (event === 'PreToolUse' && m.updatedInput) hso.updatedInput = m.updatedInput;
  if (m.additionalContext) hso.additionalContext = m.additionalContext;
  const out = Object.keys(hso).length > 1 ? { hookSpecificOutput: hso } : {};
  if (m.systemMessage) out.systemMessage = m.systemMessage; // canh bao hien cho nguoi dung, khong chan
  return { stdout: JSON.stringify(out), stderr: '', code: 0 };
}
