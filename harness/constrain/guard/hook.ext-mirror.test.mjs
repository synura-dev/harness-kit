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

test('TB-2/Thap-4: plugins\\data cua Claude + seg\\..\\ ; redirect stderr (2>&1, >$null, > NUL) khong bi coi la ghi', () => {
  expect(denied({ tool_name: 'Write', tool_input: { file_path: 'C:\\Users\\u\\.claude\\plugins\\data\\harness-kit-mkt\\other.json' } })).toBe(true);
  expect(denied({ tool_name: 'PowerShell', tool_input: { command: 'mv C:\\Users\\u\\.harness-kit\\x\\..\\bin b' } })).toBe(true);
  expect(denied({ tool_name: 'PowerShell', tool_input: { command: 'Rename-Item C:\\Users\\u\\.claude\\plugins\\data\\harness-kit-mkt c2' } })).toBe(true);
  for (const command of ['"$HOME\\.harness-kit\\bin\\harness.cmd" knowledge get x 2>&1', '"$HOME\\.harness-kit\\bin\\harness.cmd" doctor >$null', '"$HOME\\.harness-kit\\bin\\harness.cmd" doctor > NUL', '"$HOME\\.harness-kit\\bin\\harness.cmd" doctor 2>&1 | head'])
    expect(denied({ tool_name: 'PowerShell', tool_input: { command } })).toBe(false);
  expect(denied({ tool_name: 'PowerShell', tool_input: { command: 'echo x > "$HOME\\.harness-kit\\bin\\roots.json"' } })).toBe(true);
  expect(denied({ tool_name: 'PowerShell', tool_input: { command: 'echo x 2> "$HOME\\.harness-kit\\bin\\harness.cmd"' } })).toBe(true);
});

const PD = 'C:\\Users\\u\\.gemini\\config\\plugin_data\\harness-kit';
test('CAO-2: redirect/Out-File/Set-Content vao roots.json voi duong trong nhay don/kep bi chan', () => {
  for (const command of [
    `echo '{}' > "$HOME\\.harness-kit\\bin\\roots.json"`, `echo "{}" > '$HOME\\.harness-kit\\bin\\roots.json'`,
    `printf '{}' >> "C:\\Users\\u\\.harness-kit\\bin\\roots.json"`,
    `'{}' | Out-File '${ROOTS}'`, `'{}' | Out-File "${ROOTS}"`, `Set-Content '${ROOTS}' '{}'`, `Set-Content "${ROOTS}" "{}"`,
  ]) expect(denied({ tool_name: 'PowerShell', tool_input: { command } })).toBe(true);
  expect(denied({ tool_name: 'Bash', tool_input: { command: `git commit -m "nhac bin/roots.json va config/ext/local.json" -- x` } })).toBe(false);
});

test('TB-3: duong co .\\ thua, plugin_data khong can config\\ phia sau, resolve cho tool ghi file', () => {
  for (const file_path of [
    'C:\\Users\\u\\.gemini\\config\\plugin_data\\.\\harness-kit\\config\\ext\\x.json', 'C:\\Users\\u\\.gemini\\config\\.\\plugin_data\\harness-kit\\config\\ext\\x.json',
    PD, `${PD}\\x.txt`, 'C:\\Users\\u\\.gemini\\config\\plugin_data\\harness-kit\\..\\harness-kit\\a', 'C:\\Users\\u\\.harness-kit\\bin\\.\\roots.json',
    'C:\\Users\\u\\.harness-kit\\bin\\..\\bin\\roots.json',
  ]) for (const tool_name of ['Write', 'Edit']) expect(denied({ tool_name, tool_input: { file_path } })).toBe(true);
  expect(denied(toClaudeInput({ toolCall: { name: 'replace_file_content', args: { TargetFile: PD + '\\config', ReplacementContent: 'x' } } }))).toBe(true);
});

test('TB-3: shell doi ten/junction/link/ghi quanh plugin_data va .harness-kit\\bin bi chan; doc thuan thi qua', () => {
  for (const command of [
    `Rename-Item ${PD}\\config c2`, `ren ${PD}\\config c2`, `mv ${PD} x`, `Move-Item C:\\Users\\u\\.harness-kit\\bin C:\\t`,
    `New-Item -ItemType Junction -Path C:\\t -Target ${PD}`, `New-Item -ItemType SymbolicLink -Path ${PD}\\config -Target C:\\t`, `mklink /J C:\\t ${PD}`,
    `Rename-Item C:\\Users\\u\\.gemini\\config\\plugin_data\\.\\harness-kit\\config c2`, 'rm -rf ~/.gemini/config/plugin_data/harness-kit', `Remove-Item -Recurse ${PD}`,
  ]) expect(denied({ tool_name: 'PowerShell', tool_input: { command } })).toBe(true);
  for (const command of [`ls ${PD}`, 'Get-ChildItem C:\\Users\\u\\.harness-kit\\bin', 'git status'])
    expect(denied({ tool_name: 'PowerShell', tool_input: { command } })).toBe(false);
});
