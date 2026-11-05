// guard protectedPaths: PowerShell, Read, Grep, Glob cung bi chan (khong chi Bash/Edit/Write).
import test from 'node:test';
import assert from 'node:assert/strict';
import mod, { decide, DEFAULTS } from './hook.mjs';

const VAULT = 'E:\\Notes\\Vault';
const cfg = { ...DEFAULTS, protectedPaths: [VAULT] };
const d = (i) => decide(i, cfg).out.hookSpecificOutput?.permissionDecision;

test('protectedPaths: moi tool deu bi chan', () => {
  assert.equal(d({ tool_name: 'PowerShell', tool_input: { command: 'Get-Content ' + VAULT + '\\a.md' } }), 'deny');
  assert.equal(d({ tool_name: 'Read', tool_input: { file_path: VAULT + '\\a.md' } }), 'deny');
  assert.equal(d({ tool_name: 'Grep', tool_input: { pattern: 'x', path: VAULT } }), 'deny');
  assert.equal(d({ tool_name: 'Glob', tool_input: { pattern: VAULT + '\\**\\*.md' } }), 'deny');
  assert.equal(d({ tool_name: 'Read', tool_input: { file_path: 'E:\\Other\\a.md' } }), undefined);
});
test('guard dang ky Read/Grep/Glob', () => {
  for (const t of ['Read', 'Grep', 'Glob', 'PowerShell']) assert.ok(mod.tools.test(t), t);
});
