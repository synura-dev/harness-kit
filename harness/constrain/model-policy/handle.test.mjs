// handle() truc tiep (hop dong HOOK_MODULE): ket qua {decision, reason, updatedInput, record}, khong stdout/exit/audit.
import { test, expect } from 'bun:test';
import { handle, hookModule, toClaudeOutput, decideModel, DEFAULTS } from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';

const CFG = { ...DEFAULTS, default: { model: 'sonnet' }, opusAllowed: [],
  roles: { builder: { model: 'sonnet', allowOpus: false }, verifier: { model: 'haiku' }, planner: { model: 'opus', allowOpus: true } } };
const ctx = { config: CFG };
const call = (ti, name = 'Agent') => ({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: ti });

test('hookModule hop le theo validateHookModule', () => {
  expect(validateHookModule(hookModule)).toEqual([]);
  expect(hookModule.tools.test('Agent') && hookModule.tools.test('Task')).toBe(true);
  expect(hookModule.tools.test('Bash')).toBe(false);
});
test('thieu model -> allow + updatedInput dien model + record gate', () => {
  const ti = { prompt: 'p', subagent_type: 'verifier' };
  const r = handle('PreToolUse', call(ti), ctx);
  expect(r.decision).toBe('allow');
  expect(r.updatedInput).toEqual({ prompt: 'p', subagent_type: 'verifier', model: 'haiku' });
  expect(r.record.rule).toBe('model-filled');
  expect(validateHookResult(r)).toEqual([]);
  expect(ti).toEqual({ prompt: 'p', subagent_type: 'verifier' });
});
test('opus ngoai chinh sach -> ask, khong updatedInput', () => {
  const r = handle('PreToolUse', call({ prompt: 'p', subagent_type: 'builder', model: 'opus' }), ctx);
  expect(r.decision).toBe('ask');
  expect(r.reason).toMatch(/^model-policy: .*builder/);
  expect(r.updatedInput).toBeUndefined();
  expect(r.record.rule).toBe('opus-not-allowed');
  expect(validateHookResult(r)).toEqual([]);
});
test('khong y kien -> undefined; model-pass chi co record khi logAllow', () => {
  expect(handle('PreToolUse', call({ prompt: 'p', subagent_type: 'planner', model: 'opus' }), ctx)).toBeUndefined();
  expect(handle('PreToolUse', call({ command: 'ls' }, 'Bash'), ctx)).toBeUndefined();
  expect(handle('PostToolUse', call({ prompt: 'p' }), ctx)).toBeUndefined();
  expect(handle('PreToolUse', null, ctx)).toBeUndefined();
  const r = handle('PreToolUse', call({ prompt: 'p', subagent_type: 'builder', model: 'haiku' }), { config: { ...CFG, logAllow: true } });
  expect(r.decision).toBeUndefined();
  expect(r.record.rule).toBe('model-pass');
});
test('mode audit: chi record would-*, khong decision', () => {
  const r = handle('PreToolUse', call({ prompt: 'p', subagent_type: 'builder' }), { config: { ...CFG, mode: 'audit' } });
  expect(r.decision).toBeUndefined();
  expect(r.updatedInput).toBeUndefined();
  expect(r.record.reason).toMatch(/^would-fill/);
});
test('toClaudeOutput khop decideModel().out cu', () => {
  for (const ti of [{ prompt: 'p', subagent_type: 'builder' }, { prompt: 'p', subagent_type: 'builder', model: 'opus' }, { prompt: 'p', subagent_type: 'planner', model: 'opus' }]) {
    expect(toClaudeOutput(handle('PreToolUse', call(ti), ctx))).toEqual(decideModel(call(ti), CFG).out);
  }
  expect(toClaudeOutput(undefined)).toEqual({});
});
