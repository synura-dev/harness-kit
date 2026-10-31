// bun test harness/core/io/paths.test.mjs
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHub, dataDir, isInside, findBadLinks, findBadHookCommands, walkAgyHooks, REPO_DIR, isPluginMode } from './paths.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));

test('mac dinh = thu muc chua repo', () => {
  const r = resolveHub({ env: {} , repoDir: tmp() });
  expect(r.source).toBe('default');
  // hub mode: hubDir = repo; plugin mode (repo co .claude-plugin/plugin.json): hubDir = cwd (du an)
  expect(resolveHub({ env: {} }).hubDir).toBe(isPluginMode() ? path.resolve(process.cwd()) : REPO_DIR);
});

test('thu tu: env > paths.local.json > default', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'config'));
  const other = tmp();
  fs.writeFileSync(path.join(repo, 'config', 'paths.local.json'), JSON.stringify({ hubDir: other }));
  expect(resolveHub({ env: {}, repoDir: repo })).toEqual({ hubDir: path.resolve(other), source: 'paths.local.json' });
  const envDir = tmp();
  expect(resolveHub({ env: { HUB_DIR: envDir }, repoDir: repo })).toEqual({ hubDir: path.resolve(envDir), source: 'env' });
  fs.writeFileSync(path.join(repo, 'config', 'paths.local.json'), '{bad');
  expect(resolveHub({ env: {}, repoDir: repo }).source).toBe('default');
});

test('dataDir: HUB_DATA_DIR > HUB_DIR > repo; mac dinh <repo>/data/<kind>', () => {
  const repo = tmp(), hub = tmp(), data = tmp();
  expect(dataDir('bench', { env: {}, repoDir: repo })).toBe(path.join(repo, 'data', 'bench'));
  expect(dataDir('bench', { env: { HUB_DIR: hub }, repoDir: repo })).toBe(path.join(path.resolve(hub), 'data', 'bench'));
  expect(dataDir('bench', { env: { HUB_DIR: hub, HUB_DATA_DIR: data }, repoDir: repo })).toBe(path.join(path.resolve(data), 'bench'));
  expect(dataDir(undefined, { env: {}, repoDir: repo })).toBe(path.join(repo, 'data'));
  expect(dataDir('x', { env: { HUB_DATA_DIR: '  ' }, repoDir: repo })).toBe(path.join(repo, 'data', 'x'));
  // REPO_DIR co .harness/data (workspace dung chung voi hook plugin) thi dung do; neu khong thi data/
  const wsRoot = resolveHub({ env: {} }).hubDir;
  const expBase = isPluginMode() || fs.existsSync(path.join(wsRoot, '.harness', 'data')) ? path.join(wsRoot, '.harness', 'data') : path.join(wsRoot, 'data');
  expect(dataDir('evals', { env: {} })).toBe(path.join(expBase, 'evals'));
});

test('isInside', () => {
  const d = tmp();
  expect(isInside(path.join(d, 'a', 'b'), d)).toBe(true);
  expect(isInside(d, d)).toBe(true);
  expect(isInside(path.join(d, '..'), d)).toBe(false);
});

test('findBadLinks: link hong va link ngoai hub', () => {
  const hub = tmp(); const outside = tmp();
  const sk = path.join(hub, '.claude', 'skills');
  fs.mkdirSync(sk, { recursive: true });
  fs.mkdirSync(path.join(hub, 'good'));
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(path.join(hub, 'good'), path.join(sk, 'good'), type);
  fs.symlinkSync(outside, path.join(sk, 'out'), type);
  fs.symlinkSync(path.join(hub, 'missing'), path.join(sk, 'broken'), type);
  const bad = findBadLinks(sk, hub).map((b) => `${b.name}:${b.problem}`).sort();
  expect(bad).toEqual(['broken:hong', 'out:ngoai-hub']);
});

test('findBadHookCommands: bat duong dan tuyet doi', () => {
  const hub = tmp();
  const f = path.join(hub, 'hooks.json');
  const abs = path.join(tmp(), 'x.mjs').replace(/\\/g, '/');
  fs.writeFileSync(f, JSON.stringify({ h: { PostToolUse: [{ matcher: '*', hooks: [{ command: 'node .agents/x.mjs' }, { command: `node "${abs}"` }] }] } }));
  const bad = findBadHookCommands(f, hub);
  expect(bad.length).toBe(2);
  expect(bad.map((b) => b.problem).sort()).toEqual(['agents-prefix', 'ngoai-hub']);
});

test('walkAgyHooks: chap nhan layout agy, tu choi layout Claude', () => {
  const good = {
    a: { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: 'node hooks/a.mjs' }] }], SessionStart: [{ command: 'node hooks/s.mjs' }] },
    b: { enabled: false, Stop: [{ command: 'x' }] },
  };
  const w = walkAgyHooks(good);
  expect(w.problems).toEqual([]);
  expect(w.handlers.map((h) => h.command)).toEqual(['node hooks/a.mjs', 'node hooks/s.mjs', 'x']);
  // layout Claude
  expect(walkAgyHooks({ hooks: { PostToolUse: [{ hooks: [{ command: 'x' }] }] } }).problems.length).toBeGreaterThan(0);
  // SessionStart boc matcher/hooks (sai), PostToolUse phang (sai), event la
  expect(walkAgyHooks({ a: { SessionStart: [{ hooks: [{ command: 'x' }] }] } }).problems.length).toBe(1);
  expect(walkAgyHooks({ a: { PostToolUse: [{ command: 'x' }] } }).problems.length).toBe(1);
  expect(walkAgyHooks({ a: { Nope: [] } }).problems.length).toBe(1);
});

import { workspaceRoot, hubDir, dataRoot, codeRoot } from './paths.mjs';
test('workspaceRoot/dataRoot/codeRoot: ten trung tinh, hubDir/dataDir la alias', () => {
  const env = { HUB_DIR: tmp(), HUB_DATA_DIR: '' };
  expect(workspaceRoot({ env })).toBe(hubDir({ env }));
  expect(dataRoot('x', { env })).toBe(dataDir('x', { env }));
  expect(codeRoot()).toBe(REPO_DIR);
});
