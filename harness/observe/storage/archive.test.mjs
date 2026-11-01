import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveCmd, orphanWorkspaces, unsafeWorkspaceNodes } from './archive.mjs';
import { scanZones } from './data.mjs';
import { manifest } from './mv.mjs';

function mk() {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  const dd = path.join(hub, 'data');
  process.env.HUB_DATA_DIR = dd;
  for (const ws of ['gem', 'old']) {
    fs.mkdirSync(path.join(dd, 'workspaces', ws, 'release', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dd, 'workspaces', ws, 'release', 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(dd, 'workspaces', ws, 'release', 'sub', 'b.txt'), 'bb');
  }
  const registryFile = path.join(hub, 'registry.json');
  const entries = {
    'workspaces/old/release': { zone: 'workspaces', class: 'artifact', owner: 'o', workspace: 'old' },
    'workspaces/gem/release': { zone: 'workspaces', class: 'artifact', owner: 'o', workspace: 'gem' },
  };
  fs.writeFileSync(registryFile, JSON.stringify({ entries, reserved: [] }));
  const wsDir = path.join(hub, 'ws');
  const nodes = [{ id: 'gemsocial-new', workspace: 'gem' }];
  return { hub, dd, root: dd, registryFile, wsDir, nodes, now: new Date('2026-11-02T10:20:30Z') };
}
const DEST = '_archive/workspaces/old-20261102-102030';
const regOf = (c) => JSON.parse(fs.readFileSync(c.registryFile, 'utf8')).entries;

test('orphanWorkspaces: ten ws khong nut nao tro toi; khong hook/rong -> []', () => {
  const c = mk();
  fs.mkdirSync(path.join(c.dd, 'workspaces', '_x'));
  fs.writeFileSync(path.join(c.dd, 'workspaces', 'file.txt'), 'x');
  expect(orphanWorkspaces(c.dd, c.nodes)).toEqual(['old']);
  expect(orphanWorkspaces(c.dd, null)).toEqual([]);
  expect(orphanWorkspaces(c.dd, [])).toEqual([]);
});

test('scan: orphan-ws chi khi co nodes (hook); khong hook -> bo qua rule', () => {
  const c = mk();
  const reg = { entries: regOf(c), reserved: [] };
  const w1 = scanZones({ root: c.dd, reg, repoRoot: null, write: false, opts: { nodes: c.nodes } }).warnings.filter((w) => w.rule === 'orphan-ws');
  expect(w1.map((w) => w.path)).toEqual(['workspaces/old']);
  expect(w1[0].fix).toMatch(/data archive old/);
  const w2 = scanZones({ root: c.dd, reg, repoRoot: null, write: false, opts: {} }).warnings.filter((w) => w.rule === 'orphan-ws');
  expect(w2).toEqual([]);
});

test('archive dry-run khong di chuyen', async () => {
  const c = mk();
  const r = await archiveCmd(['old'], c);
  expect(r.code).toBe(0);
  expect(r.lines.join('\n')).toMatch(/dry-run: se archive workspaces\/old -> _archive\/workspaces\/old-20261102-102030/);
  expect(r.lines.join('\n')).toMatch(/2 file, 5 bytes/);
  expect(fs.existsSync(path.join(c.dd, 'workspaces', 'old'))).toBe(true);
  expect(fs.existsSync(path.join(c.dd, DEST))).toBe(false);
});

test('archive --yes: md5 khop, registry cap nhat, khong xoa', async () => {
  const c = mk();
  const before = manifest(path.join(c.dd, 'workspaces', 'old')).md5;
  const r = await archiveCmd(['old', '--yes'], c);
  expect(r.code).toBe(0);
  expect(r.lines.join('\n')).toMatch(/md5 khop/);
  expect(fs.existsSync(path.join(c.dd, 'workspaces', 'old'))).toBe(false);
  expect(manifest(path.join(c.dd, DEST)).md5).toBe(before);
  const e = regOf(c);
  expect(e['workspaces/old/release'].path).toBe(`${DEST}/release`);
  expect(e['workspaces/old/release'].legacy).toBe('workspaces/old/release');
  expect(e['workspaces/gem/release'].path).toBeUndefined();
  expect(fs.existsSync(path.join(c.dd, 'workspaces', 'gem'))).toBe(true);
});

test('archive tu choi ws con nut tro toi (ca --yes), khong hook, ten xau, ws khong ton tai', async () => {
  const c = mk();
  let r = await archiveCmd(['gem', '--yes'], c);
  expect(r.code).toBe(2);
  expect(r.lines.join('\n')).toMatch(/con nut tro toi \(gemsocial-new\)/);
  expect(fs.existsSync(path.join(c.dd, 'workspaces', 'gem'))).toBe(true);
  r = await archiveCmd(['old', '--yes'], { ...c, nodes: null });
  expect(r.code).toBe(2);
  expect(fs.existsSync(path.join(c.dd, 'workspaces', 'old'))).toBe(true);
  r = await archiveCmd(['../x', '--yes'], c);
  expect(r.code).toBe(2);
  r = await archiveCmd(['nope', '--yes'], c);
  expect(r.code).toBe(2);
  expect(r.lines.join('\n')).toMatch(/khong ton tai/);
});

test('archive: dich da ton tai -> abort, giu nguyen', async () => {
  const c = mk();
  fs.mkdirSync(path.join(c.dd, DEST), { recursive: true });
  const r = await archiveCmd(['old', '--yes'], c);
  expect(r.code).toBe(2);
  expect(fs.existsSync(path.join(c.dd, 'workspaces', 'old', 'release', 'a.txt'))).toBe(true);
});

test('unsafeWorkspaceNodes: bat workspace khong an toan tu nut tho', () => {
  const raw = [{ id: 'a', workspace: 'ok' }, { id: 'b', workspace: '../x' }, { id: 'c' }, { id: 'd', workspace: 'a/b' }, null];
  expect(unsafeWorkspaceNodes(raw).map((n) => n.id)).toEqual(['b', 'd']);
  expect(unsafeWorkspaceNodes(undefined)).toEqual([]);
});
