// Guard chan agent ghi/sua MOI ban sao dang ky ext (Claude: ~/.claude/plugins/data; agy: ~/.gemini/config/plugin_data) va truong data trong roots.json.
import { test, expect } from 'bun:test';
import { decide } from './hook.mjs';
import { toClaudeInput } from '../../hooks/dispatch/agy.mjs';

const cfg = { denyPatterns: [], allowlist: [], mode: 'enforce' };
const denied = (inp) => { const o = decide(inp, cfg).out; return o.decision === 'deny' || o.hookSpecificOutput?.permissionDecision === 'deny'; };
const AGY_REG = 'C:\\Users\\u\\.gemini\\config\\plugin_data\\harness-kit\\config\\ext\\local.json';
const AGY_DATA = 'C:\\Users\\u\\.gemini\\config\\plugin_data\\harness-kit';
const ROOTS = 'C:\\Users\\u\\.harness-kit\\bin\\roots.json';

test('Claude: Write/Edit vao ban sao plugin_data cua agy va roots.json bi chan', () => {
  for (const file_path of [AGY_REG, ROOTS, `${AGY_DATA}\\config\\ext\\other.json`, '/home/u/.local/bin/roots.json'])
    for (const tool_name of ['Write', 'Edit', 'MultiEdit']) expect(denied({ tool_name, tool_input: { file_path } })).toBe(true);
});

test('Claude: Bash ghi roots.json / plugin_data bi chan; doc thuan va file khac thi qua', () => {
  for (const command of [`echo {} > ${ROOTS}`, `cp x ${AGY_DATA}\\config\\ext\\z.json`, `node -e "fs.writeFileSync('${ROOTS.replace(/\\/g, '/')}','{}')"`])
    expect(denied({ tool_name: 'Bash', tool_input: { command } })).toBe(true);
  expect(denied({ tool_name: 'Write', tool_input: { file_path: 'E:/proj/src/roots.json.md' } })).toBe(false);
  expect(denied({ tool_name: 'Write', tool_input: { file_path: 'E:/proj/data/plugin_data_notes.md' } })).toBe(false);
});

test('agy toolCall run_command: ghi ban sao / roots.json bi chan', () => {
  for (const CommandLine of [`echo {} > ${AGY_REG}`, `Set-Content ${ROOTS} x`, `copy x ${AGY_DATA}\\config\\ext\\local.json`])
    expect(denied({ toolCall: { name: 'run_command', args: { CommandLine } } })).toBe(true);
});

test('agy toolCall write_file/edit_file (qua toClaudeInput): ghi ban sao / roots.json bi chan', () => {
  for (const name of ['write_file', 'edit_file'])
    for (const Path of [AGY_REG, ROOTS, `${AGY_DATA}\\config\\ext\\x.json`]) {
      const inp = toClaudeInput({ toolCall: { name, args: { Path, Content: '{}' } } });
      expect(denied(inp)).toBe(true);
    }
  expect(denied(toClaudeInput({ toolCall: { name: 'write_file', args: { Path: 'E:\\p\\a.txt', Content: 'x' } } }))).toBe(false);
});
