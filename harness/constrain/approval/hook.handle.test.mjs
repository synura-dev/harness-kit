// Test hop dong module: handle(event, input, ctx) goi truc tiep (khong spawn), khong ghi stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle, hookModule, toOutput, loadApproval } from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-handle-'));
const ctx = () => ({ config: loadApproval().config, auditRoot: root });
const bash = (command, tool_name = 'Bash') => ({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name, tool_input: { command } });

test('hookModule hop le theo contract', () => {
  assert.deepEqual(validateHookModule(hookModule), []);
  assert.equal(hookModule.handle, handle);
});

test('handle: git push -> ask; force push -> deny', () => {
  const a = handle('PreToolUse', bash('git push origin main'), ctx());
  assert.equal(a.decision, 'ask'); assert.match(a.reason, /^approval\[/); assert.deepEqual(validateHookResult(a), []);
  const d = handle('PreToolUse', bash('git push --force origin main'), ctx());
  assert.equal(d.decision, 'deny');
  assert.equal(toOutput(d).hookSpecificOutput.permissionDecision, 'deny');
});

test('handle: ls -> none; tool khac -> none; input rac -> none', () => {
  assert.deepEqual(handle('PreToolUse', bash('ls'), ctx()), {});
  assert.deepEqual(handle('PreToolUse', { tool_name: 'Read' }, ctx()), {});
  assert.deepEqual(handle('PreToolUse', null, ctx()), {});
  assert.deepEqual(toOutput({}), {});
});

test('handle: loi noi bo -> {} (fail-open), ghi gate fail-open', () => {
  const cfg = { ...loadApproval().config, get denyRules() { throw new Error('boom'); } };
  assert.deepEqual(handle('PreToolUse', bash('git push origin main'), { config: cfg, auditRoot: root }), {});
});
