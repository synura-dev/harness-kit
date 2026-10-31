import { test, expect } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DEFAULTS, decide, denyReason, load } from './hook.mjs';

const script = path.join(import.meta.dir, 'hook.mjs');
const pre = (ti, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: ti, ...extra });
const cfg = DEFAULTS;

test('defaults load with missing config', () => {
  expect(load([path.join(os.tmpdir(), 'nonexistent-bg.json')]).config).toEqual(DEFAULTS);
});
test('missing timeout -> updatedInput with default, keeps other fields', () => {
  const o = decide(pre({ command: 'ls', description: 'x' }), cfg).hookSpecificOutput;
  expect(o.updatedInput).toEqual({ command: 'ls', description: 'x', timeout: 120000 });
});
test('existing timeout / background untouched', () => {
  expect(decide(pre({ command: 'ls', timeout: 5000 }), cfg)).toEqual({});
  expect(decide(pre({ command: 'ls', run_in_background: true }), cfg)).toEqual({});
});
test('default clamped to max', () => {
  const o = decide(pre({ command: 'ls' }), { ...cfg, default_timeout_ms: 900000, max_timeout_ms: 300000 });
  expect(o.hookSpecificOutput.updatedInput.timeout).toBe(300000);
});
test('other tools/events ignored', () => {
  expect(decide({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }, cfg)).toEqual({});
  expect(decide({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, cfg)).toEqual({});
  expect(decide({ ...pre({ command: 'ls' }) }, { ...cfg, enabled: false })).toEqual({});
});
test('deny narrow patterns', () => {
  for (const c of ['python -', 'python3 - <<EOF\nprint(1)\nEOF', 'cd x && python3 -', 'echo hi | python -', 'python -c "a\nb"',
    'cat > f <<EOF\n1\n2\n3\n4\nEOF'])
    expect(denyReason(c, cfg)).not.toBeNull();
  const d = decide(pre({ command: 'python -' }), cfg).hookSpecificOutput;
  expect(d.permissionDecision).toBe('deny');
});
test('allow normal commands', () => {
  for (const c of ['python script.py', 'python -c "print(1)"', 'python -m pytest', 'python -V', 'git commit -m "x - y"', 'echo python -', 'cat <<EOF\na\nb\nEOF', 'ls -la | grep python'])
    expect(denyReason(c, cfg)).toBeNull();
});
test('fail-open on garbage stdin (exit 0, valid JSON)', () => {
  for (const input of ['', 'not json', '[]', 'null', '{"tool_input":5}']) {
    const r = spawnSync(process.execPath, [script], { input });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.toString() || '{}')).toEqual({});
  }
});
test('end-to-end stdin', () => {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(pre({ command: 'ls' })) });
  expect(JSON.parse(r.stdout.toString()).hookSpecificOutput.updatedInput.timeout).toBe(120000);
});
