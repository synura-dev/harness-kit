import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceOf, fallback } from './agy-native.mjs';
import { native } from '../../cli/commands/agy.mjs';

const SCRIPT = path.join(import.meta.dir, 'agy-native.mjs');
const PLUGIN = path.resolve(import.meta.dir, '..', '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hk-agynat-'));
const run = (event, input, env = {}) => spawnSync(process.execPath, [SCRIPT, event], { input, cwd: PLUGIN, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 });

test('workspaceOf: workspacePaths[0] (dau /), thieu -> cwd', () => {
  expect(workspaceOf(JSON.stringify({ workspacePaths: ['C:/x/y'] }), 'Z:\\c')).toBe(path.resolve('C:/x/y'));
  expect(workspaceOf('{}', 'C:\\cwd')).toBe(path.resolve('C:\\cwd'));
  expect(workspaceOf('khong json', 'C:\\cwd')).toBe(path.resolve('C:\\cwd'));
});

test('fallback: Pre = allow, con lai {}', () => {
  expect(fallback('PreToolUse')).toBe('{"decision":"allow"}\n');
  expect(fallback('Stop')).toBe('{}\n');
});

test('PreToolUse that: ls -> allow; python - -> deny; audit ghi vao workspace tu stdin', () => {
  const ws = tmp();
  const pay = (cmd) => JSON.stringify({ conversationId: 'c1', workspacePaths: [ws.replace(/\\/g, '/')], toolCall: { name: 'run_command', args: { CommandLine: cmd } } });
  const env = { HUB_DATA_DIR: '', HARNESS_CONFIG_DIR: '', CLAUDE_AUDIT_DIR: path.join(ws, 'audit') };
  const a = run('PreToolUse', pay('ls'), env);
  expect(JSON.parse(a.stdout)).toEqual({ decision: 'allow' });
  const d = run('PreToolUse', pay('python -'), env);
  expect(JSON.parse(d.stdout).decision).toBe('deny');
}, 60000);

test('fail-open: dispatch hong (plugin root gia) -> allow/{} + HKERR, exit 0', () => {
  const fake = tmp();
  const dir = path.join(fake, 'harness', 'hooks', 'dispatch');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'agy-native.mjs')); // khong co agy.mjs ben canh
  const r = (ev) => spawnSync(process.execPath, [path.join(dir, 'agy-native.mjs'), ev], { input: '{}', encoding: 'utf8', timeout: 30000 });
  const p = r('PreToolUse'); expect(p.status).toBe(0); expect(JSON.parse(p.stdout)).toEqual({ decision: 'allow' }); expect(p.stderr).toContain('HKERR');
  const s = r('Stop'); expect(s.status).toBe(0); expect(JSON.parse(s.stdout)).toEqual({});
  const bad = run('../x', '{}'); expect(JSON.parse(bad.stdout)).toEqual({}); expect(bad.status).toBe(0);
}, 60000);

test('hooks.json goc plugin: 5 su kien, lenh tuong doi toi agy-native.mjs ton tai', () => {
  const j = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks.json'), 'utf8'))['harness-kit'];
  expect(Object.keys(j).sort()).toEqual(['PostInvocation', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  expect(fs.existsSync(path.join(PLUGIN, 'harness', 'hooks', 'dispatch', 'agy-native.mjs'))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.antigravity-plugin', 'plugin.json'), 'utf8')).version).toBe(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version);
});

test('agy init native: da cai / chua cai + canh bao .agents/hooks.json cu', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.agents'));
  fs.writeFileSync(path.join(d, '.agents', 'hooks.json'), '{"harness-kit":{}}');
  const ok = native({ dir: d, inj: { list: () => JSON.stringify([{ name: 'harness-kit' }]) } });
  expect(ok.code).toBe(0); expect(ok.lines.join('\n')).toContain('[warn]');
  const no = native({ dir: d, inj: { list: () => '[]' } });
  expect(no.code).toBe(1); expect(no.lines.join('\n')).toContain('agy plugin install');
  expect(fs.readFileSync(path.join(d, '.agents', 'hooks.json'), 'utf8')).toBe('{"harness-kit":{}}'); // khong ghi file
});
