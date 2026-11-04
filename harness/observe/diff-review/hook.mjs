// Hook diff-review (SubagentStart): voi subagent ten khop /review/i, tu day goi review tat dinh (cung noi dung `harness review pack`) vao additionalContext.
// Quy uoc, khong config. Khong git / khong diff / loi / het han -> khong y kien (null). Chi stdout cua dispatcher, khong ghi dia, khong goi LLM.
import { capLines } from '../../core/io/out.mjs';
import { collectGit, packOf, packLines } from './cli.mjs';

export const MATCH = /review/i;
export const MAX_LINES = 20;
export const TIMEOUT_MS = 2000; // ngan sach SubagentStart 2500ms
const GIT_MS = 1700; // chua tru thoi gian nap module/dispatcher; git co tran rieng nho hon timeoutMs

export function handle(event, input) {
  try {
    if (event !== 'SubagentStart' || !input || typeof input !== 'object') return null;
    const name = String(input.agent_type || input.agent_name || '');
    if (!MATCH.test(name)) return null;
    const c = collectGit({ cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(), timeoutMs: GIT_MS, withEvidence: false });
    if (c.status !== 'ok' || !c.numstat.length) return null;
    const lines = ['Goi review tat dinh (harness review pack, KHONG chua noi dung diff; doc diff bang lenh cua bundle roi tu phan doan):', ...packLines(packOf(c), { untracked: c.untracked })];
    return { additionalContext: capLines(lines, MAX_LINES).join('\n') };
  } catch { return null; }
}

export default Object.freeze({ id: 'diff-review', events: ['SubagentStart'], timeoutMs: TIMEOUT_MS, onError: 'open', handle });
