// handle() truc tiep (hop dong HOOK_MODULE): khong stdout/exit, ket qua qua validateHookResult.
import { test, expect } from 'bun:test';
import { DEFAULTS, handle, hookModule, toClaudeOutput, decide } from './hook.mjs';
import { handle as agyHandle } from './adapters/agy.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/shape.mjs';

const pre = (ti) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: ti });
const ctx = { config: DEFAULTS };

test('hookModule hop le theo validateHookModule', () => {
  expect(validateHookModule(hookModule)).toEqual([]);
  expect(hookModule.tools.test('Bash')).toBe(true);
  expect(hookModule.tools.test('Edit')).toBe(false);
});
test('thieu timeout -> updatedInput chen timeout, giu truong khac', () => {
  const r = handle('PreToolUse', pre({ command: 'ls', description: 'x' }), ctx);
  expect(r).toEqual({ updatedInput: { command: 'ls', description: 'x', timeout: 120000 } });
  expect(validateHookResult(r)).toEqual([]);
});
test('mau treo -> decision deny kem ly do', () => {
  const r = handle('PreToolUse', pre({ command: 'python -' }), ctx);
  expect(r.decision).toBe('deny');
  expect(r.reason).toContain('bash-guard: python doc stdin');
  expect(validateHookResult(r)).toEqual([]);
});
test('khong y kien -> undefined (da co timeout, background, tool/event khac, tat, input la)', () => {
  expect(handle('PreToolUse', pre({ command: 'ls', timeout: 5 }), ctx)).toBeUndefined();
  expect(handle('PreToolUse', pre({ command: 'ls', run_in_background: true }), ctx)).toBeUndefined();
  expect(handle('PreToolUse', { tool_name: 'Read', tool_input: {} }, ctx)).toBeUndefined();
  expect(handle('PostToolUse', pre({ command: 'ls' }), ctx)).toBeUndefined();
  expect(handle('PreToolUse', pre({ command: 'ls' }), { config: { ...DEFAULTS, enabled: false } })).toBeUndefined();
  for (const bad of [null, [], 5, undefined]) expect(handle('PreToolUse', bad, ctx)).toBeUndefined();
});
test('toClaudeOutput khop decide() cu cho moi nhanh', () => {
  for (const ti of [{ command: 'ls' }, { command: 'python -' }, { command: 'ls', timeout: 1 }, { command: 'ls', run_in_background: true }]) {
    expect(toClaudeOutput(handle('PreToolUse', pre(ti), ctx))).toEqual(decide(pre(ti), DEFAULTS));
  }
  expect(toClaudeOutput(undefined)).toEqual({});
});
test('agy adapter handle: deny heredoc dai, cho qua lenh thuong (khong updatedInput)', () => {
  const call = (CommandLine, name = 'run_command') => ({ conversationId: 'c', toolCall: { name, args: { CommandLine } } });
  const d = agyHandle('PreToolUse', call('cat > f <<EOF\n1\n2\n3\n4\nEOF'), ctx);
  expect(d.decision).toBe('deny');
  expect(validateHookResult(d)).toEqual([]);
  expect(agyHandle('PreToolUse', call('echo hi'), ctx)).toBeUndefined();
  expect(agyHandle('PreToolUse', call('echo hi', 'write_file'), ctx)).toBeUndefined();
  expect(agyHandle('PreToolUse', null, ctx)).toBeUndefined();
});
