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

test('plugin mode: extRoots (lop plugin) quet duoi goc WORKSPACE, khong duoi thu muc plugin', () => {
  // Plugin gia: .claude-plugin/plugin.json + config/workspace/default.json extRoots ["hub"]; workspace = tmp (co hub/). Khong dat extDirs.
  const plug = fs.mkdtempSync(path.join(tmp, 'plug-'));
  fs.mkdirSync(path.join(plug, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plug, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit-test' }));
  fs.mkdirSync(path.join(plug, 'config', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(plug, 'config', 'workspace', 'default.json'), JSON.stringify({ extRoots: ['hub'] }));
  fs.writeFileSync(reg, JSON.stringify({ enforce: 'warn', entries: { audit: { zone: 'system', class: 'log', owner: 'x', path: 'system/audit' } } }));
  const env = { HUB_DIR: tmp, HUB_DATA_DIR: dd, CLAUDE_PLUGIN_DATA: path.join(tmp, 'pdata'), CLAUDE_PROJECT_DIR: tmp };
  const r = loadDataRegistry({ pluginDir: plug, registryFile: reg, env, noCache: true, workspacesDir: path.join(tmp, 'nows') });
  expect(Object.keys(r.entries).sort()).toEqual(['audit', 'runs', 'tasks']);
  expect(r.entries.runs).toMatchObject({ zone: 'system', path: 'system/runs', owner: 'hub/dispatch' });
  // Khong co hub/ trong workspace -> chi registry (khong quet <plugin>/hub).
  const r2 = loadDataRegistry({ pluginDir: plug, registryFile: reg, env: { ...env, HUB_DIR: plug }, noCache: true, workspacesDir: path.join(tmp, 'nows') });
  expect(Object.keys(r2.entries)).toEqual(['audit']);
});

test('caps trong data[] manifest duoc giu (so nguyen duong), sai bi bo', () => {
  const d = fs.mkdtempSync(path.join(tmp, 'caps-'));
  fs.mkdirSync(path.join(d, 'a'));
  fs.writeFileSync(path.join(d, 'a', 'manifest.json'), JSON.stringify({ id: 'a', data: [{ zone: 'external', path: 'a-home', class: 'durable', tool: 'a-home', caps: { maxFiles: 20000, maxDepth: 12 } }, { zone: 'external', path: 'b', tool: 'b', caps: { maxFiles: -1 } }] }));
  const e = manifestDataEntries(d, 'hub');
  expect(e['a-home']).toMatchObject({ zone: 'external', path: 'external/a-home', caps: { maxFiles: 20000, maxDepth: 12 } });
  expect(e.b.caps).toBeUndefined();
});

test('zone workspaces khong path -> entry mau workspaces/*/<tool>', () => {
  const d = fs.mkdtempSync(path.join(tmp, 'wsx-'));
  fs.mkdirSync(path.join(d, 'jobx'));
  fs.writeFileSync(path.join(d, 'jobx', 'manifest.json'), JSON.stringify({ id: 'jobx', data: [{ zone: 'workspaces', class: 'durable', tool: 'jobx' }] }));
  expect(manifestDataEntries(d, 'hub').jobx).toMatchObject({ zone: 'workspaces', tool: 'jobx', pattern: 'workspaces/*/jobx' });
});
