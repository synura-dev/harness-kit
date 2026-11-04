import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveCmd, orphanWorkspaces, unsafeWorkspaceNodes, runningRuns } from './archive.mjs';
import { scanZones, scan } from './data.mjs';
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
const DEST = '_archive/workspaces/old-20261102-102030Z';
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

test('archive tu choi khi runs.jsonl co running < 24h; running cu hon 24h hoac status khac -> cho qua', async () => {
  const c = mk();
  const f = path.join(c.dd, 'workspaces', 'old', 'release', 'runs.jsonl');
  const rec = (ageH, status) => JSON.stringify({ ts: new Date(c.now.getTime() - ageH * 3600000).toISOString(), run: `r-${status}-${ageH}`, node: 'n', tool: 'release', status }) + '\n';
  fs.writeFileSync(f, rec(30, 'running') + rec(1, 'ok'));
  expect((await archiveCmd(['old'], c)).code).toBe(0);
  fs.appendFileSync(f, rec(2, 'running'));
  const r = await archiveCmd(['old', '--yes'], c);
  expect(r.code).toBe(2);
  expect(r.lines.join('\n')).toMatch(/running.*release:r-running-2/);
  expect(fs.existsSync(path.join(c.dd, 'workspaces', 'old'))).toBe(true);
  expect(runningRuns(c.dd, 'old', c.now.getTime())).toEqual(['release:r-running-2']);
});

test('scan: deprecated-path khi entry co deprecatedPath; entry mau (patterns) -> workspaces la cap 1 da biet', () => {
  const c = mk();
  const reg = { entries: { ...regOf(c), oldtool: { zone: 'workspaces', class: 'artifact', owner: 'o', workspace: 'gem', path: 'workspaces/gem/oldtool', deprecatedPath: true } }, reserved: [] };
  const w = scanZones({ root: c.dd, reg, repoRoot: null, write: false, opts: {} }).warnings.filter((x) => x.rule === 'deprecated-path');
  expect(w.map((x) => x.key)).toEqual(['oldtool']);
  const only = { entries: {}, reserved: [], patterns: { release: { tool: 'release', zone: 'workspaces', pattern: 'workspaces/*/release', class: 'artifact', owner: 'o' } } };
  expect(scan(c.dd, only).unknown.map((x) => x.name)).not.toContain('workspaces');
  expect(scan(c.dd, { entries: {}, reserved: [] }).unknown.map((x) => x.name)).toContain('workspaces');
});

test('archive: stamp UTC co hau to Z', async () => {
  const c = mk();
  const r = await archiveCmd(['old'], c);
  expect(r.lines.join('\n')).toMatch(/old-20261102-102030Z/);
});

test('archive --yes: lay khoa TRUOC moi kiem tra (khoa dang giu -> abort khoa, khong phai mapped); khoa nguoi khac khong bi xoa', async () => {
  const c = mk();
  const lock = path.join(c.dd, '.state', 'mv.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: Date.now() }));
  const r = await archiveCmd(['gem', '--yes'], c); // gem con nut tro toi: neu kiem mapped truoc khoa se bao "con nut tro toi"
  expect(r.code).toBe(2);
  expect(r.lines.join('\n')).toMatch(/mv dang chay/);
  expect(r.lines.join('\n')).not.toMatch(/con nut tro toi/);
  expect(fs.existsSync(lock)).toBe(true);
});

test('archive --yes: lan chay running xuat hien SAU kiem dau (ngay truoc rename) -> tu choi, khoa duoc nha', async () => {
  const c = mk();
  const f = path.join(c.dd, 'workspaces', 'old', 'release', 'runs.jsonl');
  const rec = JSON.stringify({ ts: new Date(c.now.getTime() - 3600000).toISOString(), run: 'late', node: 'n', tool: 'release', status: 'running' }) + '\n';
  c.opts = { beforeRename: () => fs.writeFileSync(f, rec) };
  const r = await archiveCmd(['old', '--yes'], c);
  expect(r.code).toBe(2);
  expect(r.lines.join('\n')).toMatch(/vua co lan chay.*release:late/);
  expect(fs.existsSync(path.join(c.dd, 'workspaces', 'old'))).toBe(true);
  expect(fs.existsSync(path.join(c.dd, '.state', 'mv.lock'))).toBe(false);
});

test('archive: md5 lech + rollback rename that bai -> bao loi voi duong dan chinh xac, code != 0, khong noi da rename nguoc', async () => {
  const c = mk();
  const realRename = fs.renameSync;
  let n = 0;
  fs.renameSync = (a, b) => {
    n++;
    if (n === 1) { realRename(a, b); fs.writeFileSync(path.join(b, 'release', 'extra.txt'), 'x'); return; }
    const e = new Error('EPERM: nope'); e.code = 'EPERM'; throw e;
  };
  let r;
  try { r = await archiveCmd(['old', '--yes'], c); } finally { fs.renameSync = realRename; }
  expect(r.code).not.toBe(0);
  const out = r.lines.join('\n');
  expect(out).toMatch(/rollback rename THAT BAI \(EPERM\)/);
  expect(out).toContain(path.join(c.dd, DEST));
  expect(out).toContain(path.join(c.dd, 'workspaces', 'old'));
  expect(out).not.toMatch(/da rename nguoc/);
});

test('archive: loi ghi registry giua chung -> hoan tac registry khoi phuc dung legacy cu + rename nguoc', async () => {
  const c = mk();
  fs.mkdirSync(path.join(c.dd, 'workspaces', 'old', 'extra'), { recursive: true });
  fs.writeFileSync(path.join(c.dd, 'workspaces', 'old', 'extra', 'z.txt'), 'z');
  const j = JSON.parse(fs.readFileSync(c.registryFile, 'utf8'));
  j.entries['workspaces/old/release'].legacy = 'prev/legacy-release';
  j.entries['workspaces/old/extra'] = { zone: 'workspaces', class: 'artifact', owner: 'o', workspace: 'old' };
  fs.writeFileSync(c.registryFile, JSON.stringify(j));
  const realRename = fs.renameSync;
  let regWrites = 0;
  fs.renameSync = (a, b) => { if (String(b) === c.registryFile) { regWrites++; if (regWrites === 2) throw new Error('EBUSY registry'); } return realRename(a, b); };
  let r;
  try { r = await archiveCmd(['old', '--yes'], c); } finally { fs.renameSync = realRename; }
  expect(r.code).not.toBe(0);
  expect(r.lines.join('\n')).toMatch(/da hoan tac registry va rename nguoc/);
  const e = regOf(c);
  expect(e['workspaces/old/release'].path).toBe('workspaces/old/release');
  expect(e['workspaces/old/release'].legacy).toBe('prev/legacy-release');
  expect(e['workspaces/old/extra'].path).toBeUndefined();
  expect(fs.existsSync(path.join(c.dd, 'workspaces', 'old', 'extra', 'z.txt'))).toBe(true);
});
