import { test, expect } from 'bun:test';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { promptTrace, promptSignal, bashSignal, versionStamp, hookRunEnvelope, isHookRun } from './signals.mjs';

test('promptTrace: hash 12 + toi da 8 tu khoa, khong nguyen van', () => {
  const p = 'Hay sua loi dang nhap trong module login, login loi token het han, kiem tra session va cookie roi deploy staging som';
  const t = promptTrace(p);
  expect(t.prompt_hash).toMatch(/^[0-9a-f]{12}$/);
  expect(t.prompt_kw.length).toBeLessThanOrEqual(8);
  expect(t.prompt_kw).toContain('login');
  expect(JSON.stringify(t)).not.toContain('Hay sua loi');
  expect(promptTrace('  ')).toBeNull();
});
test('promptSignal: correction', () => {
  for (const s of ['sai rồi', 'Không phải vậy', 'ko phải vậy', 'ko phải file này', 'làm lại đi', 'that is wrong', "that's wrong", 'undo that', 'undo it', 'Làm sai rồi, không đúng']) expect(promptSignal(s)).toBe('correction');
  for (const s of ['saigon map', 'hãy làm tiếp', 'rewrite the doc', 'Sài Gòn', 'tính sai số', 'sai lệch dữ liệu', 'không phải lo', 'sửa lại README', 'add an undo button', 'revert feature', 'please revert']) expect(promptSignal(s)).toBeNull();
  expect(promptSignal('sai rồi ' + 'x'.repeat(130))).toBe('correction'); // chi xet 300 ky tu dau (khong con bo prompt dai)
});
test('promptSignal: boc channel + cum sua loi tieng Viet', () => {
  const wrapped = `<channel source="plugin:telegram">${'noi dung '.repeat(20)} sai rồi, làm lại</channel>`;
  expect(wrapped.length).toBeGreaterThan(120);
  expect(promptSignal(`<channel source="plugin:telegram">sai rồi</channel><system-reminder>${'x'.repeat(500)}</system-reminder>`)).toBe('correction');
  expect(promptSignal(wrapped)).toBe('correction');
  for (const s of ['tôi đã nói là dùng bun', 'sao lại sửa file đó', 'từ giờ đừng làm vậy']) expect(promptSignal(s)).toBe('correction');
  for (const s of ['đừng cho test', 'dừng lại file cũ', 'Sai Gon', 'từ giờ đến mai', 'sửa lại README', 'abc '.repeat(500)]) expect(promptSignal(s)).toBeNull();
});
test('bashSignal: revert / task_status', () => {
  expect(bashSignal('git revert HEAD')).toBe('revert');
  expect(bashSignal('cd x && git reset --hard HEAD~1')).toBe('revert');
  expect(bashSignal('git -C "E:/a b" checkout -- src/a.js')).toBe('revert');
  expect(bashSignal('git checkout HEAD -- a.js')).toBe('revert');
  expect(bashSignal('git checkout main')).toBeNull();
  expect(bashSignal('git reset --soft HEAD~1')).toBeNull();
  expect(bashSignal('harness tasks set T-1 --status done')).toBe('task_status');
  expect(bashSignal('harness tasks list')).toBeNull();
});
test('versionStamp: hash doi khi file doi', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'a');
  const a = versionStamp({ cwd: d });
  expect(a.harness_kit).toMatch(/^\d/);
  expect(a.rules_hash).toMatch(/^[0-9a-f]{12}$/);
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'abcdef');
  expect(versionStamp({ cwd: d }).rules_hash).not.toBe(a.rules_hash);
  fs.rmSync(d, { recursive: true, force: true });
});
test('hookRunEnvelope', () => {
  const e = hookRunEnvelope('Stop', { session_id: 's1' }, [{ id: 'audit', ms: 3.2 }, { id: 'verify-gate', ms: 40, err: 'timeout' }], 50);
  expect(e.type).toBe('hook'); expect(e.sid).toBe('claude-s1'); expect(e.ok).toBeNull(); expect(e.tool).toBeNull(); expect(e.actor).toBeNull(); expect(e.data.failed).toBe(true); expect(isHookRun(e)).toBe(true);
  expect(e.data.modules[1]).toEqual({ id: 'verify-gate', ms: 40, err: 'timeout' });
  expect(hookRunEnvelope('Stop', {}, [], 1)).toBeNull();
});
test('versionStamp: cache khi khong doi', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs2-'));
  fs.writeFileSync(path.join(d, 'AGENTS.md'), 'a');
  const a = versionStamp({ cwd: d }); const b = versionStamp({ cwd: d });
  expect(b).toEqual(a); expect(b).not.toBe(a);
  fs.rmSync(d, { recursive: true, force: true });
});
