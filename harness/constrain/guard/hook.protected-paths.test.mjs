// guard protectedPaths: mac dinh RONG; them tu config guard (may/du an); Bash/PowerShell/Edit/Write nhac toi -> deny, tru cong harness obsidian.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, configFiles, evaluate, decide, handle, protectedPathHit, isObsidianGateCmd, normPathText, DEFAULTS } from './hook.mjs';

const VAULT = 'E:\\Notes\\Vault';
const cfg = { ...DEFAULTS, protectedPaths: [VAULT] };
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const hit = (cmd, c = cfg) => (evaluate(cmd, c) || {}).id;

test('mac dinh protectedPaths RONG: moi duong dan deu qua', () => {
  assert.deepEqual(DEFAULTS.protectedPaths, []);
  const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pp-'));
  const { config } = load(configFiles(hubRoot), { env: {}, hubRoot });
  assert.deepEqual(config.protectedPaths, []);
  assert.equal(evaluate('cat E:\\Notes\\Vault\\a.md', config), null);
});

test('khop: khong phan biet hoa thuong, \\ / \\\\ va dang /e/ /mnt/e/ /cygdrive/e/', () => {
  for (const c of [
    'cat E:\\Notes\\Vault\\a.md',
    'cat e:/notes/vault/a.md',
    'cat E:/NOTES/VAULT/a.md',
    'cat E:\\\\Notes\\\\Vault\\\\a.md',
    'ls /e/Notes/Vault',
    'ls "/e/notes/vault/sub dir"',
    'ls /mnt/e/Notes/Vault',
    'ls /cygdrive/e/notes/vault',
    'Get-Content "e:\\notes\\VAULT\\a.md"',
    'Get-ChildItem -Path E:\\Notes\\Vault',
    'cd E:\\Notes\\Vault && ls',
    'rg foo --glob=*.md E:/Notes/Vault/',
    'git -C /e/Notes/Vault log',
  ]) assert.equal(hit(c), 'protected-path', c);
});

test('khong khop: thu muc anh em / cha / ten gan giong', () => {
  for (const c of [
    'ls E:\\Notes\\Vault2',
    'ls E:\\Notes',
    'ls E:/Notes/Vault-old',
    'cat /e/other/file',
    'ls /d/Notes/Vault',
    'cat E:\\Notes\\Vault.bak',
    'echo hello',
  ]) assert.equal(hit(c), undefined, c);
});

test('protectedPaths dang /e/... va co dau / cuoi cung duoc chuan hoa', () => {
  assert.equal(hit('cat E:\\Notes\\Vault\\a.md', { ...DEFAULTS, protectedPaths: ['/e/notes/vault/'] }), 'protected-path');
  assert.equal(hit('cat /e/notes/vault/a.md', { ...DEFAULTS, protectedPaths: ['E:\\Notes\\Vault\\'] }), 'protected-path');
  assert.equal(normPathText('/e/x'), 'e:/x');
  assert.equal(normPathText('E:\\\\X\\y'), 'e:/x/y');
  assert.equal(normPathText('e:/a/b'), 'e:/a/b'); // khong nuot nham /a/ thanh o dia
});

test('muc rong/qua ngan/khong phai chuoi bi bo (khong chan tat ca)', () => {
  const c = { ...DEFAULTS, protectedPaths: ['', ' ', '/', 'e', 5, null] };
  assert.equal(hit('ls /e/notes', c), undefined);
  assert.equal(hit('echo x', c), undefined);
});

test('ngoai le: harness obsidian / node ...harness... obsidian (lenh don)', () => {
  for (const c of [
    `harness obsidian query --vault ${VAULT} --tag meta/agent`,
    'harness obsidian query --vault /e/notes/vault',
    `node "E:\\06. Projects\\harness-kit\\harness\\cli\\harness.mjs" obsidian query --vault ${VAULT}`,
    `node --no-warnings E:/proj/harness/cli/harness.mjs obsidian put --vault ${VAULT}`,
    `"C:\\Users\\u\\AppData\\Local\\harness-kit\\bin\\harness.cmd" obsidian query ${VAULT}`,
    `& "C:\\Users\\u\\bin\\harness.cmd" obsidian query ${VAULT}`,
    `C:\\bin\\harness obsidian query ${VAULT}`,
  ]) { assert.equal(isObsidianGateCmd(c), true, c); assert.equal(hit(c), undefined, c); }
});

test('ngoai le KHONG ap dung khi noi lenh/redirect/sai cong', () => {
  for (const c of [
    `harness obsidian query && cat ${VAULT}\\a.md`,
    `harness obsidian query ; type ${VAULT}\\a.md`,
    `harness obsidian query | cat ${VAULT}\\a.md`,
    `harness obsidian query > ${VAULT}\\a.md`,
    `harness obsidian query $(cat ${VAULT}\\a.md)`,
    `harness obsidian query\ncat ${VAULT}\\a.md`,
    `harness data ls ${VAULT}`,
    `harness obsidianx ${VAULT}`,
    `echo harness obsidian ${VAULT}`,
    `node evil.mjs obsidian ${VAULT}`,
    `node harness.mjs query obsidian ${VAULT}`,
  ]) assert.equal(hit(c), 'protected-path', c);
});

test('decide: Bash/PowerShell deny kem ly do; mode audit chi would-block; ngoai le allow', () => {
  const d = decide(bash(`cat ${VAULT}\\a.md`), cfg);
  assert.equal(d.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.out.hookSpecificOutput.permissionDecisionReason, /^guard\[protected-path\]: /);
  assert.equal(d.entry.id, 'protected-path');
  assert.equal(decide({ tool_name: 'PowerShell', tool_input: { command: `Get-Content ${VAULT}\\a.md` } }, cfg).out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decide({ toolCall: { name: 'run_command', args: { CommandLine: `type ${VAULT}\\a.md` } } }, cfg).out.decision, 'deny');
  assert.equal(decide(bash(`cat ${VAULT}\\a.md`), { ...cfg, mode: 'audit' }).entry.action, 'would-block');
  assert.deepEqual(decide(bash(`harness obsidian query ${VAULT}`), cfg).out, {});
});

test('Edit/Write vao duong dan bao ve -> deny (khong co ngoai le obsidian); ngoai vault -> qua', () => {
  for (const tool_name of ['Edit', 'Write', 'MultiEdit']) {
    const r = decide({ tool_name, tool_input: { file_path: `${VAULT}\\sub\\a.md` } }, cfg);
    assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny', tool_name);
  }
  assert.deepEqual(decide({ tool_name: 'Write', tool_input: { file_path: 'E:\\Other\\a.md' } }, cfg).out, {});
  assert.equal(protectedPathHit(`harness obsidian ${VAULT}`, cfg, { file: true }).id, 'protected-path');
});

test('handle: deny qua ctx.config; ctx.config rong -> khong chan', async () => {
  const r = await handle('PreToolUse', bash(`cat ${VAULT}\\a.md`), { config: cfg, write: false });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /protected-path/);
  assert.deepEqual(await handle('PreToolUse', bash(`cat ${VAULT}\\a.md`), { config: { ...DEFAULTS }, write: false }), {});
});

test('config: guard.local.json (may) va config/guard/projects/<id>.json (du an) deu them protectedPaths (hop nhat)', () => {
  const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pp-'));
  const gd = path.join(hubRoot, 'config', 'guard');
  fs.mkdirSync(path.join(gd, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'guard.local.json'), JSON.stringify({ protectedPaths: ['E:\\Notes\\Vault'] }));
  fs.writeFileSync(path.join(gd, 'projects', 'p1.json'), JSON.stringify({ protectedPaths: ['D:\\Secret'], mode: 'audit' }));
  const a = load(configFiles(hubRoot), { env: {}, hubRoot });
  assert.deepEqual(a.config.protectedPaths, ['E:\\Notes\\Vault']);
  const b = load(configFiles(hubRoot), { env: { GUARD_PROJECT: 'p1' }, hubRoot });
  assert.deepEqual([...b.config.protectedPaths].sort(), ['D:\\Secret', 'E:\\Notes\\Vault']);
  assert.equal(b.config.mode, 'enforce'); // khoa khac cua du an van bi bo
  assert.equal(evaluate('type d:/secret/x.txt', b.config).id, 'protected-path');
  assert.equal(evaluate('type /e/notes/vault/x.md', b.config).id, 'protected-path');
});

test('config: protectedPaths khong phai chuoi bi loc; lop du an khong tat duoc muc cua may', () => {
  const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pp-'));
  const gd = path.join(hubRoot, 'config', 'guard');
  fs.mkdirSync(path.join(gd, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'guard.local.json'), JSON.stringify({ protectedPaths: ['E:\\Notes\\Vault', 7] }));
  fs.writeFileSync(path.join(gd, 'projects', 'p2.json'), JSON.stringify({ protectedPaths: [] }));
  const r = load(configFiles(hubRoot), { env: { GUARD_PROJECT: 'p2' }, hubRoot });
  assert.deepEqual(r.config.protectedPaths, ['E:\\Notes\\Vault']);
});
