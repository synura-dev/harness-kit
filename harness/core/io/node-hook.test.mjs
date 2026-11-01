import { test, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspaceFor, listNodes, loadNodeHook, resolveResolverPath, resetNodeHook, isSafeWs } from './node-hook.mjs';
import { hashTree } from '../ext/ext-trust.mjs';

beforeEach(() => resetNodeHook());

const RESOLVER = `export const resolveProject = (id) => ({ project: { path: '/p/' + id } });
export const workspaceFor = (id) => (id === 'gem-sb' || id === 'gem-new' ? 'gemsocial' : id === 'evil' ? '../x' : null);
export const listNodes = () => [{ id: 'gem-sb', workspace: 'gemsocial' }, { id: 'solo' }, { id: '../bad', workspace: 'x' }, { id: 'odd', workspace: 'a/b' }];
`;

/** Workspace tam voi hub/projects/resolver.mjs, config projectResolver, dang ky ext (hash dung) o file may. */
function mk({ register = true, config = 'hub/projects/resolver.mjs', code = RESOLVER } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nodehook-'));
  const ext = path.join(ws, 'hub', 'projects');
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(path.join(ext, 'resolver.mjs'), code);
  fs.writeFileSync(path.join(ext, 'manifest.json'), '{"id":"projects"}');
  fs.mkdirSync(path.join(ws, 'config', 'hub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'config', 'hub', 'default.json'), JSON.stringify(config ? { projectResolver: config } : {}));
  const machineFile = path.join(ws, 'machine-ext.json');
  const writeReg = () => fs.writeFileSync(machineFile, JSON.stringify({ extensions: { [ws]: [{ id: 'projects', root: 'hub/projects', hash: hashTree(ext).hash, approvedAt: 'x' }] } }));
  if (register) writeReg();
  const warns = [];
  return { ws, ext, machineFile, writeReg, warns, o: { root: ws, env: { CLAUDE_PROJECT_DIR: ws }, machineFile, warn: (l) => warns.push(l) } };
}

test('khong cau hinh hook -> workspaceFor = node id, listNodes = []', () => {
  const m = mk({ config: null });
  expect(workspaceFor('abc', m.o)).toBe('abc');
  expect(workspaceFor('a/b c', m.o)).toBe('abc');
  expect(listNodes(m.o)).toEqual([]);
  expect(loadNodeHook(m.o).source).toBe('none');
  expect(m.warns).toEqual([]);
});

test('hook da duyet hash -> workspaceFor/listNodes tu module; null -> node id', () => {
  const m = mk();
  expect(workspaceFor('gem-sb', m.o)).toBe('gemsocial');
  expect(workspaceFor('gem-new', m.o)).toBe('gemsocial');
  expect(workspaceFor('other', m.o)).toBe('other');
  expect(loadNodeHook(m.o).source).toBe('hook');
  expect(listNodes(m.o)).toEqual([{ id: 'gem-sb', workspace: 'gemsocial' }, { id: 'solo', workspace: 'solo' }, { id: 'odd', workspace: 'odd' }]);
  expect(m.warns.some((w) => w.includes('listNodes'))).toBe(true);
});

test('ket qua workspaceFor khong an toan -> node id + canh bao', () => {
  const m = mk();
  expect(workspaceFor('evil', m.o)).toBe('evil');
  expect(m.warns.some((w) => w.includes('rule=resolver'))).toBe(true);
  expect(isSafeWs('../x')).toBe(false);
  expect(isSafeWs('gem.social-1_a')).toBe(true);
});

test('cache theo process: nap 1 lan', () => {
  const m = mk();
  let n = 0;
  const o = { ...m.o, load: (p) => { n++; return { workspaceFor: () => 'w' }; } };
  expect(workspaceFor('x', o)).toBe('w'); expect(workspaceFor('y', o)).toBe('w');
  expect(n).toBe(1);
});

test('hash lech (code sua sau khi duyet) -> khong nap, fail-open + canh bao', () => {
  const m = mk();
  fs.appendFileSync(path.join(m.ext, 'resolver.mjs'), '\n// sua\n');
  expect(workspaceFor('gem-sb', m.o)).toBe('gem-sb');
  expect(listNodes(m.o)).toEqual([]);
  expect(loadNodeHook(m.o).source).toBe('error');
  expect(m.warns.filter((w) => w.includes('hash')).length).toBe(1);
});

test('ext chua dang ky -> khong nap', () => {
  const m = mk({ register: false });
  expect(workspaceFor('gem-sb', m.o)).toBe('gem-sb');
  expect(m.warns.length).toBe(1);
});

test('HUB_DATA_DIR dat -> bo hook du da duyet', () => {
  const m = mk();
  const o = { ...m.o, env: { ...m.o.env, HUB_DATA_DIR: path.join(m.ws, 'tmpdata') } };
  expect(workspaceFor('gem-sb', o)).toBe('gem-sb');
  expect(listNodes(o)).toEqual([]);
  expect(loadNodeHook(o).source).toBe('skipped');
  expect(m.warns).toEqual([]);
});

test('resolver ngoai goc workspace (.., tuyet doi ngoai) -> tu choi', () => {
  const m = mk({ config: '../outside.mjs' });
  expect(resolveResolverPath(m.o).error).toMatch(/\.\./);
  const out = path.join(os.tmpdir(), 'outside-resolver.mjs');
  fs.writeFileSync(out, RESOLVER);
  expect(resolveResolverPath({ ...m.o, projectResolver: out }).error).toMatch(/ngoai goc workspace/);
  expect(workspaceFor('gem-sb', { ...m.o, projectResolver: out })).toBe('gem-sb');
});

test('resolver thieu file / module nem loi -> fail-open', () => {
  const m = mk({ config: 'hub/projects/none.mjs' });
  expect(workspaceFor('a', m.o)).toBe('a');
  const m2 = mk({ code: 'throw new Error("boom");' });
  expect(workspaceFor('a', m2.o)).toBe('a');
  expect(listNodes(m2.o)).toEqual([]);
  expect(m2.warns.some((w) => w.includes('boom'))).toBe(true);
});

test('plugin mode: goc tin cay = workspace (khong phai codeRoot) -> resolver trong workspace duoc nap', () => {
  const m = mk();
  const plug = fs.mkdtempSync(path.join(os.tmpdir(), 'nodehook-plug-'));
  fs.mkdirSync(path.join(plug, '.claude-plugin'));
  fs.writeFileSync(path.join(plug, '.claude-plugin', 'plugin.json'), '{"name":"t"}');
  const o = { env: { CLAUDE_PROJECT_DIR: m.ws }, repoDir: plug, machineFile: m.machineFile, warn: (l) => m.warns.push(l) };
  expect(resolveResolverPath(o).abs).toBe(path.join(m.ws, 'hub', 'projects', 'resolver.mjs'));
  expect(workspaceFor('gem-sb', o)).toBe('gemsocial');
  expect(m.warns).toEqual([]);
});
