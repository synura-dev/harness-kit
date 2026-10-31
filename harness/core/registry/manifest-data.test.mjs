// Muc data tu manifest hub/*: gop vao registry, registry.json thang, guard/read-roots nhu entry thuong.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manifestDataEntries, loadDataRegistry, dataReadRoots, resolveEntry } from './data-registry.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdat-'));
const hubDir = path.join(tmp, 'hub');
const dd = path.join(tmp, 'dd');
const reg = path.join(tmp, 'registry.json');
const mk = (n, m) => { fs.mkdirSync(path.join(hubDir, n), { recursive: true }); fs.writeFileSync(path.join(hubDir, n, 'manifest.json'), JSON.stringify(m)); };
mk('tasks', { id: 'tasks', data: [{ zone: 'knowledge', path: 'tasks', class: 'durable', tool: 'tasks', legacy: 'tasks' }] });
mk('dispatch', { id: 'dispatch', data: [{ zone: 'system', path: 'runs', class: 'log', retentionDays: 14, tool: 'runs', legacy: 'runs' }, { zone: 'bogus', path: 'x' }, { path: '../up' }] });
mk('nodata', { id: 'nodata', data: null });
fs.writeFileSync(reg, JSON.stringify({ enforce: 'warn', entries: { audit: { zone: 'system', class: 'log', owner: 'x', path: 'system/audit' } } }));
fs.mkdirSync(path.join(dd, 'knowledge', 'tasks'), { recursive: true });
fs.mkdirSync(path.join(dd, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(dd, 'system', 'runs'), { recursive: true });
const opts = { extDirs: [hubDir], registryFile: reg, env: { ...process.env, HUB_DATA_DIR: dd }, noCache: true, workspacesDir: path.join(tmp, 'nows') };

test('manifestDataEntries doc tasks/runs, bo muc sai', () => {
  const e = manifestDataEntries(hubDir, 'hub');
  expect(Object.keys(e).sort()).toEqual(['runs', 'tasks']);
  expect(e.tasks).toMatchObject({ zone: 'knowledge', class: 'durable', path: 'knowledge/tasks', legacy: 'tasks', owner: 'hub/tasks' });
  expect(e.runs).toMatchObject({ zone: 'system', class: 'log', retentionDays: 14, path: 'system/runs', owner: 'hub/dispatch' });
});

test('loadDataRegistry gop; dataReadRoots + resolveEntry nhu entry thuong', () => {
  const r = loadDataRegistry(opts);
  expect(Object.keys(r.entries).sort()).toEqual(['audit', 'runs', 'tasks']);
  const roots = dataReadRoots('tasks', { ...opts, registry: r });
  expect(roots.length).toBe(2);
  expect(roots[0]).toBe(path.join(dd, 'knowledge', 'tasks'));
  const hit = resolveEntry(path.join(dd, 'system', 'runs', 'a.log'), { ...opts, registry: r });
  expect(hit && hit.key).toBe('runs');
});

test('registry.json thang khi trung key; thieu hub dir van chay', () => {
  fs.writeFileSync(reg, JSON.stringify({ enforce: 'warn', entries: { tasks: { zone: 'knowledge', class: 'artifact', owner: 'o', path: 'knowledge/tasks' } } }));
  expect(loadDataRegistry(opts).entries.tasks.class).toBe('artifact');
  const r2 = loadDataRegistry({ ...opts, extDirs: [path.join(tmp, 'none')] });
  expect(Object.keys(r2.entries)).toEqual(['tasks']);
});

test('zone workspaces tu co workspace = id manifest', () => {
  const d = fs.mkdtempSync(path.join(tmp, 'wsx-'));
  fs.mkdirSync(path.join(d, 'jobx'));
  fs.writeFileSync(path.join(d, 'jobx', 'manifest.json'), JSON.stringify({ id: 'jobx', data: [{ zone: 'workspaces', class: 'durable', tool: 'jobx' }] }));
  expect(manifestDataEntries(d, 'hub').jobx).toMatchObject({ zone: 'workspaces', workspace: 'jobx', path: 'workspaces/jobx' });
});
