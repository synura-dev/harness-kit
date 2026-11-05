import { test, expect } from 'bun:test';
import { normalizeMessage, messageFingerprint } from './normalize-message.mjs';
import { repeatedFailureCandidates } from './candidates.mjs';

const fp = (t) => messageFingerprint(t, 'Bash');

test('worktree agent id khac nhau -> cung fp', () => {
  const a = 'This agent is isolated in the worktree .\\.worktrees\\agent-adf96dcdb0dfd7e11, but this comm...';
  const b = 'This agent is isolated in the worktree .\\.worktrees\\agent-0123abcd4567ef890, but this command targets';
  expect(fp(a)).toBe(fp(b));
});
test('Path does not exist voi duong dan khac -> cung fp', () => {
  const a = 'Path does not exist: E:\\11. Agents\\Projects\\proxy\\src\\errors.ts';
  const b = 'Path does not exist: C:\\x\\y\\Projects\\proxy\\lib\\errors.ts';
  expect(fp(a)).toBe(fp(b));
  expect(fp(a)).not.toBe(fp('Permission denied: E:\\a\\b.ts'));
});
test('File does not exist + cwd', () => {
  const a = 'File does not exist. Note: your current working directory is .\\.worktrees\\agent-aaaaaaaa1111.';
  const b = 'File does not exist. Note: your current working directory is E:\\11. Agents\\.worktrees\\agent-bbbbbbbb2222.';
  expect(fp(a)).toBe(fp(b));
});
test('POSIX, nhay, so, timestamp, uuid', () => {
  expect(normalizeMessage('open "/home/u/a b/c.txt" at 2026-11-05T10:00:00Z line 42')).toBe('open <path> at <ts> line N');
  expect(normalizeMessage('id 123e4567-e89b-12d3-a456-426614174000 failed')).toBe('id <id> failed');
  expect(normalizeMessage('   ')).toBe('');
  expect(fp('')).toBeNull();
});
test('candidates gop loi chi khac id/duong dan', () => {
  const mk = (i, err) => ({ ok: false, tool: 'Bash', ts: `2026-11-05T0${i}:00:00Z`, data: { error: err, error_fp: 'fp' + i } });
  const evs = [1, 2, 3].map((i) => mk(i, `isolated in the worktree .\\.worktrees\\agent-a${i}b${i}c${i}d${i}e${i}f${i}1234, but this`));
  const out = repeatedFailureCandidates(evs, '2026-11-05T00:00:00Z');
  expect(out.length).toBe(1);
  expect(out[0].evidenceCount).toBe(3);
});
