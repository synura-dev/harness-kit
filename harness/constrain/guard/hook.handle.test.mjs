// Test hop dong module: handle(event, input, ctx) goi truc tiep (khong spawn), khong ghi stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle, hookModule, toOutput, load } from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';

const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-handle-')), 'g.jsonl');
const cfg = () => ({ ...load().config, logFile });
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

test('hookModule hop le theo contract', () => {
  assert.deepEqual(validateHookModule(hookModule), []);
  assert.equal(hookModule.handle, handle);
});

test('handle: force push -> deny kem ly do', async () => {
  const r = await handle('PreToolUse', bash('git push --force origin main'), { config: cfg() });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^guard\[git-force-push\]/);
  assert.deepEqual(validateHookResult(r), []);
  assert.equal(toOutput(r, bash('x')).hookSpecificOutput.permissionDecision, 'deny');
});

test('handle: push thuong khong bi guard chan (approval moi hoi) -> none', async () => {
  assert.deepEqual(await handle('PreToolUse', bash('git push origin main'), { config: cfg() }), {});
});

test('handle: ls -> none; tool khac -> none', async () => {
  assert.deepEqual(await handle('PreToolUse', bash('ls'), { config: cfg() }), {});
  assert.deepEqual(await handle('PreToolUse', { tool_name: 'Read', tool_input: {} }, { config: cfg() }), {});
});

test('handle: agy run_command khong khop -> allow, khop -> deny; toOutput giu dang cu', async () => {
  const ok = { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } };
  const bad = { toolCall: { name: 'run_command', args: { CommandLine: 'mongosh x' } } };
  assert.deepEqual(await handle('PreToolUse', ok, { config: cfg() }), { decision: 'allow' });
  assert.deepEqual(toOutput({ decision: 'allow' }, ok), { decision: 'allow' });
  const r = await handle('PreToolUse', bad, { config: cfg() });
  assert.equal(r.decision, 'deny');
  assert.deepEqual(toOutput(r, bad), { decision: 'deny', reason: r.reason });
});

test('handle: loi noi bo / input rac -> {} (fail-open)', async () => {
  assert.deepEqual(await handle('PreToolUse', null, { config: cfg() }), {});
  assert.deepEqual(await handle('PreToolUse', bash('git push -f'), { config: { denyPatterns: 5, get mode() { throw new Error('boom'); } } }), {});
});
