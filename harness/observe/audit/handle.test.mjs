// bun test harness/observe/audit/handle.test.mjs - hop dong HOOK_MODULE: handle(event, input, ctx) goi truc tiep, khong stdout/exit.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle, hook, readAuditConfig } from './audit.mjs';
import { handle as agyHandle } from './adapters/agy.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-handle-'));
function readAll(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(readAll(p));
    else if (p.endsWith('.jsonl')) out = out.concat(fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  }
  return out;
}
const NOW = new Date('2026-10-29T10:00:00Z');

test('hook descriptor hop le theo validateHookModule; ket qua hop le theo validateHookResult', () => {
  expect(validateHookModule(hook)).toEqual([]);
  expect(hook.events).toContain('PreToolUse');
  const root = tmp();
  const r = handle('PostToolUse', { session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: {} }, { root, now: NOW });
  expect(validateHookResult(r)).toEqual([]);
  expect(r.decision).toBeUndefined();
  expect(r.record.event).toBe('PostToolUse');
  fs.rmSync(root, { recursive: true, force: true });
});

test('handle ghi dung 1 ban ghi v2 (event lay tu doi so khi payload thieu)', () => {
  const root = tmp();
  handle('SessionStart', { session_id: 's1', cwd: root, source: 'startup' }, { root, now: NOW });
  const recs = readAll(root);
  expect(recs.length).toBe(1);
  expect(recs[0].v).toBe(2);
  expect(recs[0].event).toBe('SessionStart');
  expect(recs[0].ts).toBe(NOW.toISOString());
  fs.rmSync(root, { recursive: true, force: true });
});

test('ctx.write:false -> chi tra record, khong ghi file; input hong -> {} khong nem', () => {
  const root = tmp();
  const r = handle('Stop', { session_id: 's2', cwd: root }, { root, write: false, now: NOW });
  expect(r.record.event).toBe('Stop');
  expect(fs.readdirSync(root).length).toBe(0);
  expect(handle('Stop', null)).toEqual({});
  expect(handle('Stop', [1])).toEqual({});
  fs.rmSync(root, { recursive: true, force: true });
});

test('ban ghi tu handle() giong buildEnvelope truc tiep (khong doi dinh dang)', async () => {
  const { buildEnvelope } = await import('./audit.mjs');
  const root = tmp();
  const inp = { hook_event_name: 'PostToolUse', session_id: 's3', cwd: root, tool_name: 'Edit', tool_input: { file_path: path.join(root, 'a.txt') }, tool_response: {} };
  const viaHandle = handle(undefined, inp, { root, write: false, now: NOW }).record;
  const direct = buildEnvelope(inp, readAuditConfig(), NOW, { root });
  expect(viaHandle).toEqual(direct);
  fs.rmSync(root, { recursive: true, force: true });
});

test('adapters/agy handle(): toolCall -> ban ghi agy; pre -> chi marker, khong ban ghi; input khong hop le -> {}', () => {
  const root = tmp();
  const inp = { toolCall: { name: 'run_command', args: { CommandLine: 'echo hello' } }, conversationId: 'conv-h', stepIdx: 1, workspacePaths: [root] };
  const before = JSON.stringify(inp);
  const pre = agyHandle('pre', inp, { root });
  expect(pre).toEqual({});
  expect(fs.existsSync(path.join(root, '.agy_pre'))).toBe(true);
  expect(readAll(root).length).toBe(0);
  const post = agyHandle(undefined, inp, { root });
  expect(validateHookResult(post)).toEqual([]);
  expect(post.record.cli).toBe('agy');
  expect(post.record.tool).toBe('Bash');
  expect(post.record.sid).toBe('agy-conv-h');
  expect(post.record.dur_ms).not.toBeNull(); // dur tu marker pre
  expect(JSON.stringify(inp)).toBe(before); // khong doi input cua nguoi goi
  expect(readAll(root).length).toBe(1);
  expect(agyHandle(undefined, 'x')).toEqual({});
  fs.rmSync(root, { recursive: true, force: true });
});
