import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as R from './ext-registry.mjs';
import { main } from './ext-cmd.mjs';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });

function setup() {
  const ws = tmp('extws-'); const mf = path.join(tmp('extm-'), 'config', 'ext', 'local.json');
  const root = path.join(ws, 'ext', 'demo'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export const main = () => 1;');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'demo', entry: 'main.mjs', domains: ['demo'] }));
  fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'a');
  return { ws, mf, root, opts: { workspace: ws, machineFile: mf, confirm: () => true, coreDomains: new Set(['data', 'audit']) } };
}

test('hashTree bo .git nhung hash node_modules (doi node_modules => doi hash), doi noi dung thi doi hash', () => {
  const { root } = setup();
  fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'a');
  const a = R.hashTree(root).hash;
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'b');
  expect(R.hashTree(root).hash).toBe(a);
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'b');
  const b = R.hashTree(root).hash;
  expect(b).not.toBe(a);
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export const main = () => 2;');
  expect(R.hashTree(root).hash).not.toBe(b);
});

test('symlink/junction trong cay => rejected (fail-closed): register tu choi, dang ky cu => khong tin', async () => {
  const { ws, root, opts } = setup();
  expect((await R.register('ext/demo', opts)).code).toBe(0);
  const outside = path.join(ws, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'evil.mjs'), 'x');
  fs.symlinkSync(outside, path.join(root, 'lib'), 'junction'); // junction khong can quyen admin tren Windows
  const t = R.hashTree(root);
  expect(t.truncated).toBe(true); expect(t.rejected).toContain('lib');
  expect(R.isExtensionTrusted('demo', opts)).toBe(false);
  fs.writeFileSync(path.join(outside, 'evil.mjs'), 'y'); // doi target ngoai cay: van khong tin
  expect(R.isExtensionTrusted('demo', opts)).toBe(false);
  const ap = await R.approve('demo', opts);
  expect(ap.code).toBe(2); expect(ap.text).toContain('symlink');
  const s2 = setup(); fs.symlinkSync(outside, path.join(s2.root, 'lib'), 'junction');
  const rg = await R.register('ext/demo', s2.opts);
  expect(rg.code).toBe(2); expect(rg.text).toContain('symlink');
});

test('register ghi lop may theo luoc do; list/verify ok; sua code => lech, chan den approve', async () => {
  const { ws, mf, root, opts } = setup();
  const r = await R.register('ext/demo', opts);
  expect(r.code).toBe(0);
  const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const [k] = Object.keys(j.extensions);
  expect(path.resolve(k)).toBe(path.resolve(ws));
  const e = j.extensions[k][0];
  expect(e).toMatchObject({ id: 'demo', root: 'ext/demo' });
  expect(e.hash).toMatch(/^[0-9a-f]{64}$/); expect(e.approvedAt).toBeTruthy();
  expect(R.isExtensionTrusted('demo', opts)).toBe(true);
  expect(R.verify(opts).code).toBe(0);
  expect(R.list(opts).text).toContain('demo');
  expect(R.listRegistered(opts)[0]).toMatchObject({ id: 'demo', root: path.resolve(ws, 'ext/demo'), hash: e.hash });
  fs.writeFileSync(path.join(root, 'main.mjs'), 'evil');
  expect(R.isExtensionTrusted('demo', opts)).toBe(false);
  const v = R.verify(opts); expect(v.code).toBe(1); expect(v.text).toContain('ext approve demo');
  expect((await R.approve('demo', { ...opts, confirm: () => false })).code).toBe(1);
  expect(R.isExtensionTrusted('demo', opts)).toBe(false);
  expect((await R.approve('demo', opts)).code).toBe(0);
  expect(R.isExtensionTrusted('demo', opts)).toBe(true);
  expect(R.isExtensionTrusted('khong-co', opts)).toBe(false);
});

test('khong TTY (khong confirm, isTTY false) => tu choi, khong ghi', async () => {
  const { mf, opts } = setup();
  const o = { ...opts, confirm: undefined, isTTY: false };
  const r = await R.register('ext/demo', o);
  expect(r.code).toBe(2); expect(r.text).toContain('TTY');
  expect(fs.existsSync(mf)).toBe(false);
  await R.register('ext/demo', opts);
  fs.appendFileSync(path.join(opts.workspace, 'ext', 'demo', 'main.mjs'), '//x');
  expect((await R.approve('demo', o)).code).toBe(2);
});

test('register tu choi: domain trung core, root ngoai workspace, manifest hong, entry ..', async () => {
  const { ws, root, opts } = setup();
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'demo', entry: 'main.mjs', domains: ['demo', 'data'] }));
  expect((await R.register('ext/demo', opts)).text).toContain('trung core');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'demo', entry: '../x.mjs', domains: ['demo'] }));
  expect((await R.register('ext/demo', opts)).text).toContain('entry');
  expect((await R.register('../..', opts)).code).toBe(2);
  expect((await R.register('ext/nothing', opts)).code).toBe(2);
  expect(ws).toBeTruthy();
});

test('ext-cmd main: lenh la => 2; verify chua co => 0', async () => {
  const { opts } = setup();
  expect((await main(['zzz'], opts)).code).toBe(2);
  expect((await main(['verify'], opts)).code).toBe(0);
});

test('worktree doc dang ky cua hub goc; hash tinh tren cay worktree', async () => {
  const hub = tmp('exthub-'); const mf = path.join(tmp('extm-'), 'ext', 'local.json');
  git(hub, 'init', '-q');
  const root = path.join(hub, 'ext', 'demo'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export const main = () => 1;');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'demo', entry: 'main.mjs', domains: ['demo'] }));
  git(hub, 'add', '-A'); git(hub, 'commit', '-qm', 'i');
  const hopts = { workspace: hub, machineFile: mf, confirm: () => true, coreDomains: new Set() };
  expect((await R.register('ext/demo', hopts)).code).toBe(0);
  const wt = path.join(tmp('extwt-'), 'wt');
  expect(git(hub, 'worktree', 'add', '-q', wt, '-b', 'b1').status).toBe(0);
  const wopts = { workspace: wt, machineFile: mf };
  expect(R.registryWorkspace(wt).isWorktree).toBe(true);
  expect(R.registryWorkspace(hub).isWorktree).toBe(false);
  expect(R.listRegistered(wopts)[0].root).toBe(path.resolve(wt, 'ext/demo'));
  expect(R.isExtensionTrusted('demo', wopts)).toBe(true);
  fs.writeFileSync(path.join(wt, 'ext', 'demo', 'main.mjs'), 'changed');
  expect(R.isExtensionTrusted('demo', wopts)).toBe(false);
  expect(R.isExtensionTrusted('demo', hopts)).toBe(true);
  git(hub, 'worktree', 'remove', '--force', wt);
});

test('local.json hong JSON => fail-closed: khong ghi de, register/approve/list/verify bao loi, khong tin', async () => {
  const { mf, opts } = setup();
  expect((await R.register('ext/demo', opts)).code).toBe(0);
  const broken = fs.readFileSync(mf, 'utf8').slice(0, -5) + ' ,,';
  fs.writeFileSync(mf, broken);
  const r = await R.register('ext/demo', opts);
  expect(r.code).toBe(2); expect(r.text).toContain('hong');
  expect(fs.readFileSync(mf, 'utf8')).toBe(broken); // khong ghi de
  expect((await R.approve('demo', opts)).code).toBe(2);
  expect(fs.readFileSync(mf, 'utf8')).toBe(broken);
  expect(R.isExtensionTrusted('demo', opts)).toBe(false);
  expect(() => R.listRegistered(opts)).toThrow(/hong/);
  expect(R.verify(opts).code).toBe(1);
  expect(R.list(opts).code).toBe(2);
  fs.writeFileSync(mf, JSON.stringify({ extensions: [] })); // sai kieu cung fail-closed
  expect((await R.register('ext/demo', opts)).code).toBe(2);
  expect(JSON.parse(fs.readFileSync(mf, 'utf8'))).toEqual({ extensions: [] });
});

test('audit chi ghi id/root tuong doi/hash8 (khong lo duong dan tuyet doi)', () => {
  expect(R.hash8('a'.repeat(64))).toHaveLength(8);
});

test('remove: dry-run khong ghi, --yes go, khong can TTY; verify/list khong con bao ext da go', async () => {
  const { root, opts } = setup();
  expect((await R.register('ext/demo', opts)).code).toBe(0);
  const noTty = { ...opts, confirm: undefined, isTTY: false };
  const dry = R.remove('demo', noTty);
  expect(dry.code).toBe(0); expect(dry.text).toContain('dry-run');
  expect(R.list(opts).text).toContain('demo');
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export const main = () => 9;'); // lech hash: verify se bao loi truoc khi go
  expect(R.verify(opts).code).toBe(1);
  expect(R.remove('demo', { ...noTty, yes: true }).text).toContain('da go');
  expect(R.verify(opts).code).toBe(0);
  expect(R.list(opts).text).not.toContain('demo');
  expect(R.remove('demo', { ...noTty, yes: true }).code).toBe(2);
  expect((await main(['remove', 'demo', '--yes'], opts)).code).toBe(2);
});

test('guard: register ghim khai bao vao registry; manifest doi/xoa khoa guard khong anh huong; approve lai ghi cho ext cu', async () => {
  const { ws, mf, root, opts } = setup();
  const mfst = path.join(root, 'manifest.json');
  const G = { event: 'PreToolUse', matcher: 'mcp__x__.*', args: ['guard'] };
  fs.writeFileSync(mfst, JSON.stringify({ id: 'demo', entry: 'main.mjs', domains: ['demo'], guard: G }));
  expect((await R.register('ext/demo', opts)).code).toBe(0);
  const g = R.listRegistered(opts).find((e) => e.id === 'demo').guard;
  expect(g).toEqual({ ...G, domain: 'demo' });
  fs.writeFileSync(mfst, JSON.stringify({ id: 'demo', entry: 'main.mjs', domains: ['demo'] })); // xoa khoa guard tren dia
  expect(R.listRegistered(opts).find((e) => e.id === 'demo').guard).toEqual(g);
  expect((await R.approve('demo', opts)).code).toBe(0); // manifest khong co guard: registry giu guard
  expect(R.listRegistered(opts).find((e) => e.id === 'demo').guard).toEqual(g);
  fs.writeFileSync(mfst, JSON.stringify({ id: 'demo', entry: 'main.mjs', domains: ['demo'], guard: { ...G, matcher: 'Write' } }));
  expect((await R.approve('demo', opts)).code).toBe(0); // khai bao doi: approve ghi lai
  expect(R.listRegistered(opts).find((e) => e.id === 'demo').guard.matcher).toBe('Write');
  fs.writeFileSync(mfst, JSON.stringify({ id: 'demo', entry: 'main.mjs', domains: ['demo'], guard: { event: 'PreToolUse', matcher: '(', args: [] } }));
  expect((await R.register('ext/demo', opts)).code).toBe(2); // guard sai bi tu choi
});
