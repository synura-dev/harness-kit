import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extgate-'));
const _old = { d: process.env.HUB_DATA_DIR, a: process.env.CLAUDE_AUDIT_DIR };
process.env.HUB_DATA_DIR = path.join(tmp, 'data');
process.env.CLAUDE_AUDIT_DIR = path.join(tmp, 'audit');
afterAll(() => { for (const [k, v] of [['HUB_DATA_DIR', _old.d], ['CLAUDE_AUDIT_DIR', _old.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
const { run } = await import('./harness.mjs');
const reg = await import('./commands/ext-registry.mjs');

const ws = path.join(tmp, 'ws');
const machineFile = path.join(tmp, 'machine', 'local.json');
const registry = { workspace: ws, machineFile };
const mk = (name, body) => {
  const d = path.join(ws, name); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'main.mjs'), body);
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: name, entry: 'main.mjs', domains: [name] }));
  return d;
};
const auditText = () => {
  let s = ''; const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : (s += fs.readFileSync(path.join(d, e.name), 'utf8')); } catch { /* none */ } };
  walk(process.env.CLAUDE_AUDIT_DIR); return s;
};

test('cong chay external dang ky khi hash khop; sua file => CHAN exit 66; approve lai => chay; ext khac va core khong anh huong', async () => {
  fs.mkdirSync(ws, { recursive: true });
  const a = mk('exta', `export const main = () => 'A-ok';`);
  mk('extb', `export const main = () => 'B-ok';`);
  for (const n of ['exta', 'extb']) expect((await reg.register(n, { ...registry, confirm: () => true })).code).toBe(0);
  const go = (d) => run([d], root, { capture: true, registry });
  expect(go('exta').code).toBe(0);
  expect(go('exta').stdout).toContain('A-ok');

  fs.writeFileSync(path.join(a, 'main.mjs'), `export const main = () => 'A-changed';`);
  const blocked = go('exta');
  expect(blocked.code).toBe(66);
  expect(blocked.stdout).toBe('');
  expect(blocked.stderr).toContain('ext approve exta');
  expect(go('extb').stdout).toContain('B-ok'); // ext khac khong anh huong
  expect(run(['data', 'ls'], root, { capture: true, registry }).code).toBe(0); // core khong anh huong
  const log = auditText();
  expect(log).toContain('ext-blocked');
  expect(log).toContain('ext:exta');

  expect((await reg.approve('exta', { ...registry, confirm: () => true })).code).toBe(0);
  const again = go('exta');
  expect(again.code).toBe(0);
  expect(again.stdout).toContain('A-changed');
}, 120000);

test('gia mao id: ext B sua manifest thanh id cua A (A con nguyen) => CHAN 66, code B khong chay', async () => {
  fs.mkdirSync(ws, { recursive: true });
  mk('spa', `export const main = () => 'SPA-ok';`);
  const b = mk('spb', `export const main = () => 'SPB-ok';`);
  for (const n of ['spa', 'spb']) expect((await reg.register(n, { ...registry, confirm: () => true })).code).toBe(0);
  fs.writeFileSync(path.join(b, 'main.mjs'), `export const main = () => 'SPB-evil';`);
  fs.writeFileSync(path.join(b, 'manifest.json'), JSON.stringify({ id: 'spa', entry: 'main.mjs', domains: ['spb'] }));
  const r = run(['spb'], root, { capture: true, registry });
  expect(r.code).toBe(66);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('id manifest');
  // A van chay binh thuong; trust check theo root: hash cay A khong duoc dung de duyet cay B
  expect(run(['spa'], root, { capture: true, registry }).stdout).toContain('SPA-ok');
  expect(reg.isExtensionTrusted('spa', { ...registry, root: b })).toBe(false);
  expect(reg.isExtensionTrusted('spa', { ...registry, root: path.join(ws, 'spa') })).toBe(true);
}, 120000);

test('dang ky lop may hong JSON => cong CHAN 66 kem huong dan, khong ghi de file; core van chay', () => {
  const bad = path.join(tmp, 'machine-bad', 'local.json'); fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{ hong');
  const r = run(['exta'], root, { capture: true, registry: { workspace: ws, machineFile: bad } });
  expect(r.code).toBe(66); expect(r.stdout).toBe(''); expect(r.stderr).toContain('hong');
  expect(fs.readFileSync(bad, 'utf8')).toBe('{ hong');
  expect(run(['data', 'ls'], root, { capture: true, registry: { workspace: ws, machineFile: bad } }).code).toBe(0);
});

test('external chua dang ky khong chay qua cong (khong co externals tuong minh)', () => {
  const r = run(['khongco'], root, { capture: true, registry });
  expect(r.code).not.toBe(0);
});
