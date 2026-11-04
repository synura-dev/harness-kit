import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mvCmd, manifest } from './mv.mjs';
import { scanZones } from './data.mjs';
import { loadDataRegistry } from '../../core/registry/data-registry.mjs';

function mk(entries = { 'workspaces/gem/release': { zone: 'workspaces', class: 'artifact', owner: 'o', workspace: 'gem' } }) {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'));
  const dd = path.join(hub, 'data');
  process.env.HUB_DATA_DIR = dd;
  fs.mkdirSync(path.join(dd, 'workspaces', 'gem', 'release', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dd, 'workspaces', 'gem', 'release', 'a.txt'), 'aaa');
  fs.writeFileSync(path.join(dd, 'workspaces', 'gem', 'release', 'sub', 'b.txt'), 'bb');
  const registryFile = path.join(hub, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({ entries, reserved: [] }));
  const wsDir = path.join(hub, 'ws');
  return { hub, dd, registryFile, wsDir, root: dd, hubRoot: hub };
}
const FROM = 'workspaces/gem/release';
const TO = 'workspaces/gem/rel2';
const regOf = (c) => JSON.parse(fs.readFileSync(c.registryFile, 'utf8')).entries;

test('dry-run khong di chuyen, in md5', async () => {
  const c = mk();
  const r = await mvCmd([FROM, TO], c);
  expect(r.code).toBe(0);
  expect(r.lines.join('\n')).toMatch(/dry-run/);
  expect(r.lines.join('\n')).toMatch(/2 file, 5 bytes/);
  expect(fs.existsSync(path.join(c.dd, TO))).toBe(false);
});

test('--yes khop md5, cap nhat registry, rollback nguoc', async () => {
  const c = mk();
  const before = manifest(path.join(c.dd, FROM)).md5;
  const r = await mvCmd([FROM, TO, '--yes'], c);
  expect(r.code).toBe(0);
  expect(r.lines.join('\n')).toMatch(/md5 khop/);
  expect(fs.existsSync(path.join(c.dd, FROM))).toBe(false);
  expect(manifest(path.join(c.dd, TO)).md5).toBe(before);
  const e = regOf(c)['workspaces/gem/release'];
  expect(e.path).toBe(TO);
  expect(e.legacy).toBe(FROM);
  expect(fs.existsSync(path.join(c.dd, '.state', 'mv.lock'))).toBe(false);
  const back = await mvCmd([TO, FROM, '--yes'], c);
  expect(back.code).toBe(0);
  expect(manifest(path.join(c.dd, FROM)).md5).toBe(before);
  const e2 = regOf(c)['workspaces/gem/release'];
  expect(e2.path).toBe(FROM);
  expect(e2.legacy).toBeUndefined();
});

test('tu choi: dich ton tai, traversal, to trong from, from khong ton tai, chua dang ky', async () => {
  const c = mk();
  fs.mkdirSync(path.join(c.dd, TO), { recursive: true });
  expect((await mvCmd([FROM, TO, '--yes'], c)).code).toBe(2);
  fs.rmSync(path.join(c.dd, TO), { recursive: true });
  expect((await mvCmd([FROM, '../x', '--yes'], c)).code).toBe(2);
  expect((await mvCmd(['../x', 'y', '--yes'], c)).code).toBe(2);
  expect((await mvCmd([FROM, FROM + '/sub/z', '--yes'], c)).code).toBe(2);
  expect((await mvCmd(['workspaces/gem/none', TO, '--yes'], c)).code).toBe(2);
  expect((await mvCmd([FROM + '/sub', 'workspaces/gem/s2', '--yes'], c)).code).toBe(2); // chua dang ky
  expect(fs.existsSync(path.join(c.dd, FROM, 'a.txt'))).toBe(true);
});

test('registry failed -> exit 2, khong di chuyen', async () => {
  const c = mk();
  fs.writeFileSync(c.registryFile, '{bad');
  expect((await mvCmd([FROM, TO, '--yes'], c)).code).toBe(2);
  expect(fs.existsSync(path.join(c.dd, FROM))).toBe(true);
});

test('khoa: dang giu -> tu choi; khoa het han -> bo qua', async () => {
  const c = mk();
  const lf = path.join(c.dd, '.state', 'mv.lock');
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  fs.writeFileSync(lf, JSON.stringify({ pid: 1, ts: Date.now() }));
  expect((await mvCmd([FROM, TO, '--yes'], c)).code).toBe(2);
  fs.writeFileSync(lf, JSON.stringify({ pid: 1, ts: Date.now() - 6 * 60 * 1000 }));
  expect((await mvCmd([FROM, TO, '--yes'], c)).code).toBe(0);
});

test('entry trong workspaces/<ws>.json duoc cap nhat', async () => {
  const c = mk({});
  fs.mkdirSync(c.wsDir, { recursive: true });
  fs.writeFileSync(path.join(c.wsDir, 'gem.json'), JSON.stringify({ workspace: 'gem', release: { class: 'artifact', owner: 'o', path: FROM } }));
  const r = await mvCmd([FROM, TO, '--yes'], c);
  expect(r.code).toBe(0);
  const w = JSON.parse(fs.readFileSync(path.join(c.wsDir, 'gem.json'), 'utf8'));
  expect(w.release.path).toBe(TO);
  expect(w.release.legacy).toBe(FROM);
});

test('scan: duplicate khi ton tai ca moi va legacy; thu muc zone cap 1 duoc chap nhan', async () => {
  const c = mk();
  expect((await mvCmd([FROM, TO, '--yes'], c)).code).toBe(0);
  const reg = loadDataRegistry({ registryFile: c.registryFile, workspacesDir: c.wsDir, noCache: true });
  let s = scanZones({ root: c.dd, reg, repoRoot: null, write: false });
  expect(s.warnings.some((w) => w.rule === 'duplicate')).toBe(false);
  expect(s.warnings.some((w) => w.rule === 'unregistered' && w.path === 'workspaces')).toBe(false);
  fs.mkdirSync(path.join(c.dd, FROM), { recursive: true });
  fs.writeFileSync(path.join(c.dd, FROM, 'x'), 'x');
  s = scanZones({ root: c.dd, reg, repoRoot: null, write: false });
  expect(s.warnings.some((w) => w.rule === 'duplicate')).toBe(true);
});

test('mv: md5 lech + rollback rename that bai -> loi voi duong dan chinh xac, khong noi da rename nguoc', async () => {
  const c = mk();
  const realRename = fs.renameSync;
  let n = 0;
  fs.renameSync = (a, b) => {
    n++;
    if (n === 1) { realRename(a, b); fs.writeFileSync(path.join(b, 'extra.txt'), 'x'); return; }
    const e = new Error('EPERM: nope'); e.code = 'EPERM'; throw e;
  };
  let r;
  try { r = await mvCmd([FROM, TO, '--yes'], c); } finally { fs.renameSync = realRename; }
  expect(r.code).not.toBe(0);
  const out = r.lines.join('\n');
  expect(out).toMatch(/rollback rename THAT BAI \(EPERM\)/);
  expect(out).toContain(path.join(c.dd, TO));
  expect(out).toContain(path.join(c.dd, FROM));
  expect(out).not.toMatch(/da rename nguoc/);
});
