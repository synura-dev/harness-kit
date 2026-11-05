// agy dung CUNG luat guard cua Claude (khong viet luat rieng): bang lenh hai chieu qua dispatcher agy that (spawn, stdin agy).
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toClaudeInput, renderAgy, ASK_PREFIX } from './agy.mjs';

const HARNESS = path.resolve(import.meta.dir, '..', '..');
const NEW = path.join(HARNESS, 'hooks', 'dispatch', 'agy.mjs');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agy-destr-'));
const ENV = { ...process.env, HUB_DATA_DIR: path.join(D, 'data'), CLAUDE_AUDIT_DIR: path.join(D, 'audit') };
const run = (cmd) => {
  const p = JSON.stringify({ conversationId: 'conv-destr-' + Math.random(), stepIdx: 1, workspacePaths: [D], toolCall: { name: 'run_command', args: { CommandLine: cmd, Cwd: D } } });
  const r = spawnSync(process.execPath, [NEW, 'PreToolUse'], { input: p, env: ENV, encoding: 'utf8', timeout: 30000 });
  return JSON.parse(r.stdout);
};
const FP = 'echo ' + 'a'.repeat(100001); // guard con chan lenh qua dai; chan cung do quyen native

const DENY = [
  [FP, /command-too-long/],
];
const ALLOW = ['echo hi', 'git status', 'rm file.txt'];

for (const [cmd, why] of DENY) {
  test(`agy deny: ${cmd.slice(0, 20)}... (${cmd.length} ky tu)`, () => {
    const o = run(cmd);
    expect(o.decision).toBe('deny');
    expect(o.reason).toMatch(why);
  }, 60000);
}
for (const cmd of ALLOW) test(`agy allow: ${cmd}`, () => expect(run(cmd)).toEqual({ decision: 'allow' }), 60000);

test('ask -> deny kem "can nguoi duyet" (agy -p khong hoi duoc); deny giu nguyen; allow', () => {
  expect(JSON.parse(renderAgy('PreToolUse', { decision: 'ask', reason: 'approval[git-push]: x' }).stdout)).toEqual({ decision: 'deny', reason: ASK_PREFIX + 'approval[git-push]: x' });
  expect(JSON.parse(renderAgy('PreToolUse', { decision: 'deny', reason: 'r' }).stdout)).toEqual({ decision: 'deny', reason: 'r' });
  expect(JSON.parse(renderAgy('PreToolUse', {}).stdout)).toEqual({ decision: 'allow' });
}, 60000);

test('chuan hoa: run_command -> Bash command; write_file/edit_file -> Write/Edit file_path; tool khac -> null', () => {
  const p = (name, args) => ({ conversationId: 'c', workspacePaths: ['C:/w'], toolCall: { name, args } });
  expect(toClaudeInput(p('run_command', { CommandLine: 'ls' }))).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: 'C:/w', session_id: 'c' });
  expect(toClaudeInput(p('run_command', { CommandLine: 'ls' }), 'PowerShell').tool_name).toBe('PowerShell');
  expect(toClaudeInput(p('write_file', { TargetFile: 'a.txt' }))).toMatchObject({ tool_name: 'Write', tool_input: { file_path: 'a.txt' } });
  expect(toClaudeInput(p('edit_file', { Path: 'b.txt' }))).toMatchObject({ tool_name: 'Edit', tool_input: { file_path: 'b.txt' } });
  expect(toClaudeInput(p('view_file', { Path: 'b.txt' }))).toBeNull();
  expect(toClaudeInput({})).toBeNull();
});
