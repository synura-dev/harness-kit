import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeHooks, buildBlock, init, missingRules, HOOK_KEY, SHIM, LOCAL, RULES } from './agy.mjs';
import { walkAgyHooks, findBadHookCommands } from '../../core/io/paths.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hk-agy-'));
const PLUGIN = path.resolve(import.meta.dir, '..', '..', '..');

test('buildBlock: schema agy sach, lenh tuong doi khong tuyet doi', () => {
  const j = { [HOOK_KEY]: buildBlock() };
  const w = walkAgyHooks(j);
  expect(w.problems).toEqual([]);
  expect(w.handlers.length).toBe(5);
  for (const x of w.handlers) expect(x.command).toBe(`node ./${SHIM} ${x.event}`);
});

test('mergeHooks: giu hook la, bo block harness launcher cu, idempotent', () => {
  const legacy = { harness: { Stop: [{ type: 'command', command: 'node ../bin/harness.mjs --script hooks/dispatch/agy.mjs Stop' }] }, other: { Stop: [{ type: 'command', command: 'node x.mjs' }] } };
  const a = mergeHooks(legacy);
  expect(a.json.harness).toBeUndefined();
  expect(a.json.other).toEqual(legacy.other);
  expect(a.changes.length).toBe(2);
  expect(mergeHooks(a.json).changes).toEqual([]);
});

test('mergeHooks: block "harness" cua nguoi dung (khong phai dispatcher agy) duoc giu', () => {
  const mine = { harness: { Stop: [{ type: 'command', command: 'node my.mjs' }] } };
  expect(mergeHooks(mine).json.harness).toEqual(mine.harness);
});

test('init: ghi hooks.json + shim + local + .gitignore; --check sau do OK; doctor khong bao tuyet doi', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.agents'));
  fs.writeFileSync(path.join(d, '.agents', '.gitignore'), 'x');
  expect(init({ dir: d, check: true }).code).toBe(1);
  expect(init({ dir: d }).code).toBe(0);
  expect(init({ dir: d, check: true }).code).toBe(0);
  expect(fs.readFileSync(path.join(d, '.agents', '.gitignore'), 'utf8')).toBe(`x\n${LOCAL}\n`);
  expect(JSON.parse(fs.readFileSync(path.join(d, '.agents', LOCAL), 'utf8')).pluginRoot).toBe(PLUGIN);
  expect(findBadHookCommands(path.join(d, '.agents', 'hooks.json'), d)).toEqual([]);
  fs.rmSync(d, { recursive: true, force: true });
});

test('init: hooks.json hong -> khong ghi de, exit 1', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.agents'));
  fs.writeFileSync(path.join(d, '.agents', 'hooks.json'), '{bad');
  expect(init({ dir: d }).code).toBe(1);
  expect(fs.readFileSync(path.join(d, '.agents', 'hooks.json'), 'utf8')).toBe('{bad');
  fs.rmSync(d, { recursive: true, force: true });
});

test('missingRules', () => {
  expect(missingRules(null)).toEqual([...RULES]);
  expect(missingRules({ permissions: { allow: [...RULES] } })).toEqual([]);
});

test('shim that: 5 event exit 0, JSON hop le; PreToolUse in decision allow; khong plugin -> fail-open', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.agents'));
  init({ dir: d });
  const shim = path.join(d, '.agents', SHIM);
  const env = { ...process.env, HUB_DATA_DIR: path.join(d, 'data'), CLAUDE_PROJECT_DIR: d };
  for (const ev of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop']) {
    const input = JSON.stringify({ conversationId: 't1', toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } }, workspacePaths: [d.replace(/\\/g, '/')] });
    const r = spawnSync(process.execPath, [shim, ev], { cwd: path.join(d, '.agents'), input, env, encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(0);
    const o = JSON.parse(r.stdout);
    if (ev === 'PreToolUse') expect(o.decision).toBe('allow');
  }
  fs.writeFileSync(path.join(d, '.agents', LOCAL), JSON.stringify({ pluginRoot: path.join(d, 'nope') }));
  const r = spawnSync(process.execPath, [shim, 'PreToolUse'], { cwd: path.join(d, '.agents'), input: '{}', env: { ...env, USERPROFILE: d, HOME: d }, encoding: 'utf8', timeout: 20000 });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).decision).toBe('allow');
  expect(r.stderr).toContain('HK-AGY-001');
  fs.rmSync(d, { recursive: true, force: true });
}, 60000);

test('shim cli: chay cong CLI plugin khong PATH; khong plugin -> HKERR HK-AGY-002 exit 1; tu chua local.json', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.agents'));
  init({ dir: d });
  const shim = path.join(d, '.agents', SHIM);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: d, PATH: path.dirname(process.execPath) };
  const ok = spawnSync(process.execPath, [shim, 'cli', 'agy'], { cwd: d, env, encoding: 'utf8', timeout: 30000 });
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('agy: hook + rule allow');
  fs.rmSync(path.join(d, '.agents', LOCAL));
  const env2 = { ...env, HARNESS_KIT_PLUGIN_DIR: PLUGIN };
  expect(spawnSync(process.execPath, [shim, 'cli', 'agy'], { cwd: d, env: env2, encoding: 'utf8', timeout: 30000 }).status).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(d, '.agents', LOCAL), 'utf8')).pluginRoot).toBe(PLUGIN);
  fs.writeFileSync(path.join(d, '.agents', LOCAL), JSON.stringify({ pluginRoot: path.join(d, 'nope') }));
  const bad = spawnSync(process.execPath, [shim, 'cli', 'agy'], { cwd: d, env: { ...env, USERPROFILE: d, HOME: d }, encoding: 'utf8', timeout: 30000 });
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('HK-AGY-002');
  expect(bad.stderr).toContain('"fix_command":"harness agy init"');
  fs.rmSync(d, { recursive: true, force: true });
}, 90000);
