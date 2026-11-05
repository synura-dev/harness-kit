import { test, expect } from 'bun:test';
import { normalizeMessage, messageFingerprint, normalizeFull } from './normalize-message.mjs';
import { repeatedFailureCandidates } from './candidates.mjs';

const fp = (t) => messageFingerprint(t, 'Bash');

test('worktree agent id khac nhau -> cung fp', () => {
  const a = 'This agent is isolated in the worktree .\\.worktrees\\agent-adf96dcdb0dfd7e11, but this command targets a path outside it';
  const b = 'This agent is isolated in the worktree .\\.worktrees\\agent-0123abcd4567ef890, but this command targets a path outside it';
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

test('loi khac nhau sau 50 ky tu khong gop', () => {
  const head = 'bun test failed with an error in the suite while running the case named ';
  expect(fp(head + 'alpha one')).not.toBe(fp(head + 'beta two'));
  const mk = (i, m) => ({ ok: false, tool: 'Bash', ts: `2026-11-05T0${i}:00:00Z`, data: { error: m } });
  const out = repeatedFailureCandidates([mk(1, head + 'alpha'), mk(2, head + 'alpha'), mk(3, head + 'beta'), mk(4, head + 'beta')], 'x');
  expect(out.length).toBe(2);
  expect(normalizeMessage(head + 'alpha').length).toBeLessThanOrEqual(50); // chi cat khi hien thi
});
test('ban bi cat "..." gop voi ban day du khi tien to >= 80', () => {
  const full = 'This agent is isolated in the worktree .\\.worktrees\\agent-adf96dcdb0dfd7e11, but this command targets a path outside the worktree root';
  const cut = full.slice(0, 125) + '...';
  expect(normalizeFull(cut).truncated).toBe(true);
  const mk = (i, m) => ({ ok: false, tool: 'Bash', ts: `2026-11-05T0${i}:00:00Z`, data: { error: m } });
  expect(repeatedFailureCandidates([mk(1, cut), mk(2, full)], 'x').length).toBe(1);
  const shortCut = 'This agent is isolated in the worktree .\\.worktrees\\agent-adf96dcdb0dfd7e11, but this comm...';
  expect(repeatedFailureCandidates([mk(1, shortCut), mk(2, full)], 'x').length).toBe(0); // tien to < 80: khong gop
});
test('id/fp on dinh theo thu tu va cua so truot', () => {
  const mk = (i, m) => ({ ok: false, tool: 'Bash', ts: `2026-11-05T0${i}:00:00Z`, data: { error: m } });
  const A = 'build step failed for target agent-aaaaaaaa1111 because of missing dependency in lockfile entry', B = 'build step failed for target agent-bbbbbbbb2222 because of missing dependency in lockfile entry';
  const evs = [mk(1, A), mk(2, B), mk(3, A), mk(4, B)];
  const id = (x) => repeatedFailureCandidates(x, 'n')[0].id;
  expect(id(evs.slice().reverse())).toBe(id(evs));
  expect(id(evs.slice(1))).toBe(id(evs)); // cua so truot bo su kien dau
  expect(repeatedFailureCandidates(evs, 'n')[0]._fp).toBe(repeatedFailureCandidates(evs.slice().reverse(), 'n')[0]._fp);
});
test('duong dan Windows co dau cach/[]/-: mot <path> duy nhat', () => {
  const g = 'E:\\11. Agents\\Work\\Company - Gemsocial - Era\\[New] Gemsocial';
  expect(normalizeMessage(`Path does not exist: ${g}\\apps\\server\\src\\x.ts`, 200)).toBe('Path does not exist: <path>');
  expect(fp(`Path does not exist: ${g}\\apps\\server`)).toBe(fp(`Path does not exist: ${g}\\.claude\\worktrees\\foo`));
  expect(normalizeMessage(`File does not exist. Note: your current working directory is ${g}.`, 200)).toBe('File does not exist. Note: your current working directory is <path>');
  expect(normalizeMessage(`Path does not exist: ${g}\\apps\\server\\src...`, 200)).toBe('Path does not exist: <path>');
});
test('khong gop nham: nghia khac -> fp khac', () => {
  expect(fp('Path does not exist: E:\\a b\\c.ts')).not.toBe(fp('File does not exist: E:\\a b\\c.ts'));
  expect(normalizeMessage('E:\\a\\b.ts not found, retry', 200)).toBe('<path> not found, retry');
});
test('guard worktree: moi ly do phia sau -> cung fp; loi khac van khac', () => {
  const p = (id, r) => `This agent is isolated in the worktree E:\\11. Agents\\.worktrees\\agent-${id}, but this command ${r}. Refusing to run it`;
  const a = fp(p('a8a872069519f6d8a', 'names git in a form too complex to verify'));
  expect(fp(p('a83730c8c0078cb40', 'runs bun with run --cwd in a plain command'))).toBe(a);
  expect(fp(p('a2299033b41637e2a', 'is too complex to verify'))).toBe(a);
  expect(fp('Refusing to run it: something else')).not.toBe(a);
});
test('POSIX co dau cach giua chuoi', () => {
  expect(normalizeMessage('Path does not exist: /e/11. Agents/Work/Company - Gemsocial - Era/[New] Gemsocial/apps/x.ts, retry', 200)).toBe('Path does not exist: <path>, retry');
  expect(normalizeMessage('copy /a/b to /c/d failed', 200)).toBe('copy <path> to <path> failed');
});
test('HookRun khong tinh la loi tool', () => {
  const h = { type: 'hook', event: 'HookRun', ok: false, tool: 'Bash', ts: 't', data: { error: 'x' } };
  expect(repeatedFailureCandidates([h, h, h], 'n').length).toBe(0);
});
