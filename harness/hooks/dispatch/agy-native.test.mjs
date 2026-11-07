import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceOf, fallback, run as runFn } from './agy-native.mjs';
import { native } from '../../cli/commands/agy.mjs';

const SCRIPT = path.join(import.meta.dir, 'agy-native.mjs');
const PLUGIN = path.resolve(import.meta.dir, '..', '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hk-agynat-'));
const cleanEnv = () => { const e = { ...process.env }; for (const k of ['CLAUDE_AUDIT_DIR', 'HUB_DATA_DIR', 'HARNESS_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'HARNESS_PLUGIN_DIR']) delete e[k]; return e; };
const run = (event, input) => spawnSync(process.execPath, [SCRIPT, event], { input, cwd: PLUGIN, env: cleanEnv(), encoding: 'utf8', timeout: 30000 });
const listAll = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map((p) => String(p).replace(/\\/g, '/')) : []);

test('workspaceOf: workspacePaths[0] (dau /); thieu/khong hop le -> rong (khong cwd)', () => {
  expect(workspaceOf(JSON.stringify({ workspacePaths: ['C:/x/y'] }))).toBe(path.resolve('C:/x/y'));
  expect(workspaceOf('{}')).toBe('');
  expect(workspaceOf(JSON.stringify({ workspacePaths: [5] }))).toBe('');
  expect(workspaceOf('khong json')).toBe('');
});

test('fallback: Pre = allow, con lai {}', () => {
  expect(fallback('PreToolUse')).toBe('{"decision":"allow"}\n');
  expect(fallback('Stop')).toBe('{}\n');
});

test('PreToolUse that: ls -> allow; python - -> deny; audit that roi vao workspace tu stdin (khong override env)', () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, '.git')); // dau hieu workspace de applyWorkspaceEnv dat du lieu trong <ws>
  const pay = (cmd) => JSON.stringify({ conversationId: 'c1', workspacePaths: [ws.replace(/\\/g, '/')], toolCall: { name: 'run_command', args: { CommandLine: cmd } } });
  expect(JSON.parse(run('PreToolUse', pay('ls')).stdout)).toEqual({ decision: 'allow' });
  expect(JSON.parse(run('PreToolUse', pay('python -')).stdout).decision).toBe('deny');
  expect(listAll(ws).filter((p) => /^\.harness\/data\/.*audit\/.+\.(json|jsonl)$/.test(p)).length).toBeGreaterThan(0);
}, 60000);

test('thieu workspacePaths: khong dispatch, HKERR, fail-open dung dinh dang, khong ghi vao goc plugin', () => {
  const before = listAll(path.join(PLUGIN, '.harness')).length;
  const p = run('PreToolUse', JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }));
  expect(p.status).toBe(0); expect(JSON.parse(p.stdout)).toEqual({ decision: 'allow' }); expect(p.stderr).toContain('HKERR');
  const s = run('Stop', ''); expect(JSON.parse(s.stdout)).toEqual({}); expect(s.stderr).toContain('HKERR');
  expect(listAll(path.join(PLUGIN, '.harness')).length).toBe(before);
});

const fakeRoot = (agyBody) => {
  const root = tmp();
  const dir = path.join(root, 'harness', 'hooks', 'dispatch');
  fs.mkdirSync(dir, { recursive: true });
  if (agyBody != null) fs.writeFileSync(path.join(dir, 'agy.mjs'), agyBody);
  return root;
};
const PAY = JSON.stringify({ workspacePaths: [os.tmpdir().replace(/\\/g, '/')] });
const runFake = (body, ev) => runFn(ev, PAY, { root: fakeRoot(body), baseEnv: cleanEnv() });

test('run(): dispatch thieu / exit != 0 / output khong phai JSON -> fail-open + HKERR; output JSON hop le duoc giu', async () => {
  for (const body of [null, 'process.exit(3)', 'console.log("khong json")']) {
    const r = await runFake(body, 'PreToolUse');
    expect(JSON.parse(r.stdout)).toEqual({ decision: 'allow' }); expect(r.stderr).toContain('HKERR');
  }
  expect(JSON.parse((await runFake('console.log(JSON.stringify({ok:1}))', 'Stop')).stdout)).toEqual({ ok: 1 });
  expect(JSON.parse((await runFake('process.exit(1)', 'Stop')).stdout)).toEqual({});
});

test('su kien sai -> {} + HKERR, exit 0', () => {
  const bad = run('../x', '{}');
  expect(JSON.parse(bad.stdout)).toEqual({}); expect(bad.status).toBe(0); expect(bad.stderr).toContain('HKERR');
});

test('hooks.json goc plugin: 5 su kien, lenh tuong doi toi agy-native.mjs ton tai, SessionStart timeout rong', () => {
  const j = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks.json'), 'utf8'))['harness-kit'];
  expect(Object.keys(j).sort()).toEqual(['PostInvocation', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  expect(j.SessionStart[0].timeout).toBeGreaterThanOrEqual(30);
  expect(fs.existsSync(path.join(PLUGIN, 'harness', 'hooks', 'dispatch', 'agy-native.mjs'))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.antigravity-plugin', 'plugin.json'), 'utf8')).version).toBe(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version);
});

test('agy init native: da cai / tat / chua cai + canh bao .agents/hooks.json cu', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.agents'));
  fs.writeFileSync(path.join(d, '.agents', 'hooks.json'), '{"harness-kit":{}}');
  const ok = native({ dir: d, inj: { list: () => JSON.stringify([{ name: 'harness-kit', enabled: true }]) } });
  expect(ok.code).toBe(0); expect(ok.lines.join('\n')).toContain('[warn]');
  const off = native({ dir: d, inj: { list: () => JSON.stringify([{ name: 'harness-kit', enabled: false }]) } });
  expect(off.code).toBe(1); expect(off.lines.join('\n')).toContain('agy plugin enable');
  const no = native({ dir: d, inj: { list: () => '[{"name":"egm","enabled":true}]' } });
  expect(no.code).toBe(1); expect(no.lines.join('\n')).toContain('git clone');
  expect(no.lines.join('\n')).toMatch(/plugins[\\/]harness-kit/);
  // project scope: plugin.json trong .agents/plugins/harness-kit -> OK, khong can agy list
  const pj = path.join(d, '.agents', 'plugins', 'harness-kit', '.antigravity-plugin');
  fs.mkdirSync(pj, { recursive: true }); fs.writeFileSync(path.join(pj, 'plugin.json'), '{}');
  const pr = native({ dir: d, inj: { list: () => { throw new Error('khong duoc goi'); } } });
  expect(pr.code).toBe(0); expect(pr.lines.join('\n')).toContain('pull');
  expect(fs.readFileSync(path.join(d, '.agents', 'hooks.json'), 'utf8')).toBe('{"harness-kit":{}}'); // khong ghi file
});
