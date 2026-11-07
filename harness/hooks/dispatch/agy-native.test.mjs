import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceOf, fallback, isEnabled, run as runFn } from './agy-native.mjs';

const SCRIPT = path.join(import.meta.dir, 'agy-native.mjs');
const PLUGIN = path.resolve(import.meta.dir, '..', '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hk-agynat-'));
const cleanEnv = () => { const e = { ...process.env }; for (const k of ['CLAUDE_AUDIT_DIR', 'HUB_DATA_DIR', 'HARNESS_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'HARNESS_PLUGIN_DIR']) delete e[k]; return e; };
const run = (event, input) => spawnSync(process.execPath, [SCRIPT, event], { input, cwd: PLUGIN, env: cleanEnv(), encoding: 'utf8', timeout: 30000 });
const enable = (ws, v = true, f = 'settings.json') => { fs.mkdirSync(path.join(ws, '.claude'), { recursive: true }); fs.writeFileSync(path.join(ws, '.claude', f), JSON.stringify({ enabledPlugins: { 'harness-kit@synura': v } })); };
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
  enable(ws);
  const pay = (cmd) => JSON.stringify({ conversationId: 'c1', workspacePaths: [ws.replace(/\\/g, '/')], toolCall: { name: 'run_command', args: { CommandLine: cmd } } });
  expect(JSON.parse(run('PreToolUse', pay('ls')).stdout)).toEqual({ decision: 'allow' });
  expect(JSON.parse(run('PreToolUse', pay('python -')).stdout).decision).toBe('deny');
  expect(listAll(ws).filter((p) => /^\.harness\/data\/.*audit\/.+\.(json|jsonl)$/.test(p)).length).toBeGreaterThan(0);
}, 60000);

test('thieu workspacePaths: khong dispatch, fail-open dung dinh dang IM LANG (khong HKERR), khong ghi vao goc plugin', () => {
  const before = listAll(path.join(PLUGIN, '.harness')).length;
  const p = run('PreToolUse', JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }));
  expect(p.status).toBe(0); expect(JSON.parse(p.stdout)).toEqual({ decision: 'allow' }); expect(p.stderr).toBe('');
  const s = run('Stop', ''); expect(JSON.parse(s.stdout)).toEqual({}); expect(s.stderr).toBe('');
  expect(listAll(path.join(PLUGIN, '.harness')).length).toBe(before);
});

// Cong workspace tool-neutral: mac dinh BAT; opt-out chi HARNESS_AGY=0 va <ws>/.harness/agy.off; KHONG doc .claude/*.
const cleanWs = () => { const w = tmp(); fs.mkdirSync(path.join(w, '.git')); return w; };
test('isEnabled (a)-(c): ws sach -> true; HARNESS_AGY=0 -> false; .harness/agy.off -> false', () => {
  const home = tmp();
  const ws = cleanWs();
  expect(isEnabled(ws, { env: {}, home })).toBe(true);
  expect(isEnabled(ws, { env: { HARNESS_AGY: '0' }, home })).toBe(false);
  expect(isEnabled(ws, { env: { HARNESS_AGY: '1' }, home })).toBe(true);
  fs.mkdirSync(path.join(ws, '.harness')); fs.writeFileSync(path.join(ws, '.harness', 'agy.off'), '');
  expect(isEnabled(ws, { env: {}, home })).toBe(false);
});

test('isEnabled (d): khoa .claude cu khong con hieu luc va khong bi doc (spy fs)', async () => {
  const home = tmp();
  const ws = cleanWs();
  fs.mkdirSync(path.join(ws, '.claude'));
  fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'harness-kit@synura': false } }));
  const touched = [];
  const restore = ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'openSync'].map((k) => {
    const orig = fs[k];
    fs[k] = (...a) => { touched.push(String(a[0])); return orig(...a); };
    return () => { fs[k] = orig; };
  });
  try {
    expect(isEnabled(ws, { env: {}, home })).toBe(true);
    const pay = JSON.stringify({ workspacePaths: [ws.replace(/\\/g, '/')] });
    const r = await runFn('Stop', pay, { root: fakeRoot('console.log("{}")'), baseEnv: cleanEnv() });
    expect(JSON.parse(r.stdout)).toEqual({});
  } finally { restore.forEach((f) => f()); }
  expect(touched.filter((t) => /[\\/]\.claude([\\/]|$)/.test(t))).toEqual([]);
});

test('isEnabled (f)(g): ws khong ton tai / la file / = home / goc o dia / = goc plugin -> false', () => {
  const home = tmp();
  const base = tmp();
  const file = path.join(base, 'f.txt'); fs.writeFileSync(file, 'x');
  expect(isEnabled(path.join(base, 'khong-co'), { env: {}, home })).toBe(false);
  expect(isEnabled(file, { env: {}, home })).toBe(false);
  expect(isEnabled(home, { env: {}, home })).toBe(false);
  expect(isEnabled(path.parse(base).root, { env: {}, home })).toBe(false);
  expect(isEnabled('', { env: {}, home })).toBe(false);
  expect(isEnabled(PLUGIN, { env: {}, home })).toBe(false);
  const root = cleanWs();
  expect(isEnabled(root, { env: {}, home, root })).toBe(false);
});

test('run() (h): ws sach -> dispatch chay; agy.off -> fallback im lang; thieu workspacePaths -> im lang', async () => {
  const ws = cleanWs();
  const pay = JSON.stringify({ workspacePaths: [ws.replace(/\\/g, '/')] });
  const root = fakeRoot('console.log(JSON.stringify({ok:1}))');
  expect(JSON.parse((await runFn('Stop', pay, { root, baseEnv: cleanEnv() })).stdout)).toEqual({ ok: 1 });
  expect(await runFn('PreToolUse', pay, { root, baseEnv: { ...cleanEnv(), HARNESS_AGY: '0' } })).toEqual({ stdout: fallback('PreToolUse'), stderr: '' });
  fs.mkdirSync(path.join(ws, '.harness')); fs.writeFileSync(path.join(ws, '.harness', 'agy.off'), '');
  expect(await runFn('PreToolUse', pay, { root, baseEnv: cleanEnv() })).toEqual({ stdout: fallback('PreToolUse'), stderr: '' });
  expect(await runFn('Stop', '{}', { root, baseEnv: cleanEnv() })).toEqual({ stdout: '{}\n', stderr: '' });
});

const fakeRoot = (agyBody) => {
  const root = tmp();
  const dir = path.join(root, 'harness', 'hooks', 'dispatch');
  fs.mkdirSync(dir, { recursive: true });
  if (agyBody != null) fs.writeFileSync(path.join(dir, 'agy.mjs'), agyBody);
  return root;
};
const runFake = (body, ev) => { const ws = tmp(); enable(ws); return runFn(ev, JSON.stringify({ workspacePaths: [ws.replace(/\\/g, '/')] }), { root: fakeRoot(body), baseEnv: cleanEnv() }); };

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
