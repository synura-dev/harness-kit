import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceOf, fallback, enabledIn, run as runFn } from './agy-native.mjs';
import { native } from '../../cli/commands/agy.mjs';

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

// Cong qua entry that (spawn agy-native.mjs): khong bat -> fallback, stderr rong, khong tao gi trong ws (ke ca .harness).
test('cong du an (entry that): khong bat -> fallback im lang, khong ghi file; local false thang project true; BOM; JSON hong; gia tri khong boolean; enabledPlugins mang/null', () => {
  const put = (ws, f, txt) => { fs.mkdirSync(path.join(ws, '.claude'), { recursive: true }); fs.writeFileSync(path.join(ws, '.claude', f), txt); };
  const ep = (o) => JSON.stringify({ enabledPlugins: o });
  const K = 'harness-kit@synura';
  const off = {
    thieu: () => {},
    false: (w) => put(w, 'settings.json', ep({ [K]: false })),
    'local false thang project true': (w) => { put(w, 'settings.json', ep({ [K]: true })); put(w, 'settings.local.json', ep({ [K]: false })); },
    'JSON hong': (w) => put(w, 'settings.json', '{khong json'),
    'chuoi "true"': (w) => put(w, 'settings.json', ep({ [K]: 'true' })),
    'so 1': (w) => put(w, 'settings.json', ep({ [K]: 1 })),
    null: (w) => put(w, 'settings.json', ep({ [K]: null })),
    'enabledPlugins mang': (w) => put(w, 'settings.json', '{"enabledPlugins":["harness-kit@synura"]}'),
    'enabledPlugins null': (w) => put(w, 'settings.json', '{"enabledPlugins":null}'),
    'khoa khac': (w) => put(w, 'settings.json', ep({ 'x@y': true })),
  };
  for (const [name, setup] of Object.entries(off)) {
    const ws = tmp(); fs.mkdirSync(path.join(ws, '.git')); setup(ws);
    const before = listAll(ws);
    const pay = JSON.stringify({ workspacePaths: [ws.replace(/\\/g, '/')], toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } });
    const p = run('PreToolUse', pay);
    expect(JSON.parse(p.stdout), name).toEqual({ decision: 'allow' }); expect(p.stderr, name).toBe(''); expect(p.status, name).toBe(0);
    expect(JSON.parse(run('Stop', pay).stdout), name).toEqual({});
    expect(listAll(ws), name).toEqual(before);
    expect(fs.existsSync(path.join(ws, '.harness')), name).toBe(false);
  }
  // bat: BOM, local true thang project false, khoa thu hai = true
  const on = {
    project: (w) => put(w, 'settings.json', ep({ [K]: true })),
    BOM: (w) => put(w, 'settings.json', '﻿' + ep({ [K]: true })),
    'local true thang project false': (w) => { put(w, 'settings.json', ep({ [K]: false })); put(w, 'settings.local.json', ep({ [K]: true })); },
    'local rieng khoa khac': (w) => { put(w, 'settings.json', ep({ 'harness-kit@a': false })); put(w, 'settings.local.json', ep({ 'harness-kit@b': true })); },
  };
  for (const [name, setup] of Object.entries(on)) {
    const ws = tmp(); fs.mkdirSync(path.join(ws, '.git')); setup(ws);
    expect(enabledIn(ws), name).toBe(true);
  }
  const ws = tmp(); fs.mkdirSync(path.join(ws, '.git')); on.BOM(ws);
  const pay = JSON.stringify({ workspacePaths: [ws.replace(/\\/g, '/')], toolCall: { name: 'run_command', args: { CommandLine: 'python -' } } });
  expect(JSON.parse(run('PreToolUse', pay).stdout).decision).toBe('deny'); // bat that qua entry -> dispatch that
}, 90000);

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

test('agy init native: global da cai / lech version / tat / chua cai + cong du an + clone cu + hooks.json cu', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.agents'));
  fs.writeFileSync(path.join(d, '.agents', 'hooks.json'), '{"harness-kit":{}}');
  const L = (o) => ({ root: '/p/root', version: '0.3.9', list: () => JSON.stringify(o) });
  const txt = (r) => r.lines.join('\n');
  const no = native({ dir: d, inj: L([{ name: 'egm', enabled: true }]) });
  expect(no.code).toBe(1); expect(txt(no)).toContain('agy plugin install "/p/root"'); expect(txt(no)).toContain('[warn] ' + path.join(d, '.agents', 'hooks.json'));
  expect(txt(no)).toContain('enabledPlugins');
  const off = native({ dir: d, inj: L([{ name: 'harness-kit', enabled: false, version: '0.3.9' }]) });
  expect(off.code).toBe(1); expect(txt(off)).toContain('agy plugin enable');
  const old = native({ dir: d, inj: L([{ name: 'harness-kit', enabled: true, version: '0.3.8' }]) });
  expect(txt(old)).toContain('0.3.8 != plugin nay 0.3.9'); expect(txt(old)).toContain('agy plugin install');
  enable(d);
  const ok = native({ dir: d, inj: L([{ name: 'harness-kit', enabled: true, version: '0.3.9' }]) });
  expect(ok.code).toBe(0); expect(txt(ok)).toContain('[OK] agy da cai'); expect(txt(ok)).toContain('du an nay da bat'); expect(txt(ok)).not.toContain('clone');
  fs.mkdirSync(path.join(d, '.agents', 'plugins', 'harness-kit'), { recursive: true });
  expect(txt(native({ dir: d, inj: L([{ name: 'harness-kit', enabled: true, version: '0.3.9' }]) }))).toContain('ban clone theo du an');
  expect(fs.readFileSync(path.join(d, '.agents', 'hooks.json'), 'utf8')).toBe('{"harness-kit":{}}'); // khong ghi file
});
