// Hook diff-review (SubagentStart): voi subagent ten khop /review/i, tu day goi review tat dinh (cung noi dung `harness review pack`) vao additionalContext.
// Quy uoc, khong config. Khong git / khong diff / loi -> khong y kien (null); git het han -> bao `truncated: timeout` (khong khang dinh "khong co thay doi").
// Chi stdout cua dispatcher, khong ghi dia, khong goi LLM. Dong dau ghi repo=<toplevel> vi cwd phien co the khong phai repo dang review.
import { capLines } from '../../core/io/out.mjs';
import { collectGit, packOf, packLines } from './cli.mjs';

export const MATCH = /review/i;
export const MAX_LINES = 20;
export const TIMEOUT_MS = 2000; // ngan sach SubagentStart 2500ms
const GIT_MS = 1700; // tran git toi da; thuc te = min(GIT_MS, thoi gian con lai cua module - 150ms)
const HINT = 'Goi tat dinh KHONG chua noi dung diff; doc diff bang lenh cua bundle (git -C <repo>) roi tu phan doan.';

export function handle(event, input, ctx) {
  try {
    if (event !== 'SubagentStart' || !input || typeof input !== 'object') return null;
    const name = String(input.agent_type || input.agent_name || '');
    if (!MATCH.test(name)) return null;
    const left = ctx && Number.isFinite(ctx.deadline) ? ctx.deadline - Date.now() - 150 : GIT_MS;
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const c = collectGit({ cwd, timeoutMs: Math.max(1, Math.min(GIT_MS, left)), withEvidence: false });
    if (c.truncated && (c.status !== 'ok' || !c.numstat.length)) {
      return { additionalContext: `review pack: truncated: ${c.truncated} (chua lay du diff; chay \`harness review pack <repo>\` de lay goi day du)` };
    }
    if (c.status !== 'ok' || !c.numstat.length) return null;
    return { additionalContext: capLines([...packLines(packOf(c), { untracked: c.untracked }), HINT], MAX_LINES).join('\n') };
  } catch { return null; }
}

export default Object.freeze({ id: 'diff-review', events: ['SubagentStart'], timeoutMs: TIMEOUT_MS, onError: 'open', handle });
