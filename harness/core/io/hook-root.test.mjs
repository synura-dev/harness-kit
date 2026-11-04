import { test, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookNodes, workspaceFor, loadNodeHook, resetNodeHook } from './node-hook.mjs';
import { codeRoot } from './paths.mjs';
import { hashTree } from '../ext/ext-trust.mjs';

beforeEach(() => resetNodeHook());

const RESOLVER = `export const workspaceFor = (id) => (id === 'gem-new' ? 'gemsocial' : null);
export const listNodes = () => [{ id: 'gem-new', workspace: 'gemsocial' }, { id: 'solo' }];
`;

/** Workspace gia lap (khac codeRoot) co resolver da duyet; env nhu bin/harness: CLAUDE_PROJECT_DIR + HUB_DATA_DIR=<ws>/data. */
function mk(dataEnv = (ws) => path.join(ws, 'data')) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hookroot-'));
  const ext = path.join(ws, 'hub', 'projects');
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(path.join(ext, 'resolver.mjs'), RESOLVER);
  fs.writeFileSync(path.join(ext, 'manifest.json'), '{"id":"projects"}');
  fs.mkdirSync(path.join(ws, 'config', 'hub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'config', 'hub', 'default.json'), JSON.stringify({ projectResolver: 'hub/projects/resolver.mjs' }));
  const machineFile = path.join(ws, 'machine-ext.json');
  fs.writeFileSync(machineFile, JSON.stringify({ extensions: { [ws]: [{ id: 'projects', root: 'hub/projects', hash: hashTree(ext).hash, approvedAt: 'x' }] } }));
  const warns = [];
  return { ws, warns, o: { env: { CLAUDE_PROJECT_DIR: ws, HUB_DATA_DIR: dataEnv(ws) }, machineFile, warn: (l) => warns.push(l) } };
}

test('che do plugin (codeRoot != goc workspace), khong truyen root: hookNodes tim nut theo CLAUDE_PROJECT_DIR', () => {
  const m = mk();
  expect(path.resolve(codeRoot())).not.toBe(path.resolve(m.ws));
  const nodes = hookNodes(m.o);
  expect(nodes).toEqual([{ id: 'gem-new', workspace: 'gemsocial' }, { id: 'solo', workspace: 'solo' }]);
  expect(workspaceFor('gem-new', m.o)).toBe('gemsocial');
  expect(loadNodeHook(m.o).source).toBe('hook');
  expect(m.warns).toEqual([]);
});

test('HUB_DATA_DIR = <ws>/.harness/data cung khong bi coi la ghi de', () => {
  const m = mk((ws) => path.join(ws, '.harness', 'data'));
  expect(hookNodes(m.o)?.length).toBe(2);
});

test('HUB_DATA_DIR ghi de that (sandbox) + resolver khai bao -> null va dung 1 dong data-warn rule=hook', () => {
  const m = mk((ws) => path.join(ws, 'sandbox-tmp'));
  expect(hookNodes(m.o)).toBe(null);
  expect(hookNodes(m.o)).toBe(null);
  const w = m.warns.filter((l) => l.includes('rule=hook'));
  expect(w.length).toBe(1);
  expect(w[0]).toContain('data-warn');
});

test('resolver khai bao nhung chua duyet hash -> null + data-warn rule=hook (khong im lang)', () => {
  const m = mk();
  fs.writeFileSync(m.o.machineFile, JSON.stringify({ extensions: {} }));
  expect(hookNodes({ ...m.o, warn: (l) => m.warns.push(l) })).toBe(null);
  expect(m.warns.some((l) => l.includes('rule=hook'))).toBe(true);
});

test('khong cau hinh resolver -> null, khong canh bao', () => {
  const m = mk();
  fs.writeFileSync(path.join(m.ws, 'config', 'hub', 'default.json'), '{}');
  expect(hookNodes(m.o)).toBe(null);
  expect(m.warns).toEqual([]);
});
