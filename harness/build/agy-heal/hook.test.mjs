import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import hook, { handle } from './hook.mjs';

let tmp; let plug; let dir; let logs;
const lf = () => path.join(dir, '.agents', 'harness-agy.local.json');
const ctx = (o = {}) => ({ dir, pluginRoot: plug, audit: (id, ev) => logs.push([id, ev]), ...o });
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agyheal-'));
  plug = path.join(tmp, '.claude', 'plugins', 'cache', 'harness-kit', '0.3.2');
  fs.mkdirSync(path.join(plug, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plug, '.claude-plugin', 'plugin.json'), '{}');
  dir = path.join(tmp, 'proj'); fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  logs = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('lech -> tu sua + 1 dong audit', async () => {
  fs.writeFileSync(lf(), JSON.stringify({ pluginRoot: '/old/0.3.1' }));
  await handle('SessionStart', {}, ctx());
  expect(JSON.parse(fs.readFileSync(lf(), 'utf8')).pluginRoot).toBe(path.resolve(plug));
  expect(logs.length).toBe(1);
});
test('khop -> khong ghi', async () => {
  fs.writeFileSync(lf(), JSON.stringify({ pluginRoot: path.resolve(plug) }));
  const t = new Date(Date.now() - 60000); fs.utimesSync(lf(), t, t);
  const m = fs.statSync(lf()).mtimeMs;
  await handle('SessionStart', {}, ctx());
  expect(fs.statSync(lf()).mtimeMs).toBe(m);
  expect(logs.length).toBe(0);
});
test('khong co file -> khong tao', async () => {
  await handle('SessionStart', {}, ctx());
  expect(fs.existsSync(lf())).toBe(false);
  expect(logs.length).toBe(0);
});
test('symlink -> khong ghi', async () => {
  const real = path.join(tmp, 'real.json'); fs.writeFileSync(real, '{"pluginRoot":"/old/x"}');
  try { fs.symlinkSync(real, lf()); } catch { return; }
  await handle('SessionStart', {}, ctx());
  expect(fs.readFileSync(real, 'utf8')).toBe('{"pluginRoot":"/old/x"}');
});
test('JSON hong -> khong ghi + audit', async () => {
  fs.writeFileSync(lf(), '{bad');
  await handle('SessionStart', {}, ctx());
  expect(fs.readFileSync(lf(), 'utf8')).toBe('{bad');
  expect(logs.length).toBe(1);
});
test('root cu ton tai ngoai cache -> khong ghi', async () => {
  const dev = path.join(tmp, 'dev'); fs.mkdirSync(dev);
  fs.writeFileSync(lf(), JSON.stringify({ pluginRoot: dev }));
  await handle('SessionStart', {}, ctx());
  expect(JSON.parse(fs.readFileSync(lf(), 'utf8')).pluginRoot).toBe(dev);
});
test('root cu la cache ban cu -> ghi', async () => {
  const old = path.join(tmp, '.claude', 'plugins', 'cache', 'harness-kit', '0.3.1'); fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(lf(), JSON.stringify({ pluginRoot: old }));
  await handle('SessionStart', {}, ctx());
  expect(JSON.parse(fs.readFileSync(lf(), 'utf8')).pluginRoot).toBe(path.resolve(plug));
});
test('khac hoa/thuong -> khong ghi', async () => {
  const up = path.resolve(plug).toUpperCase();
  fs.writeFileSync(lf(), JSON.stringify({ pluginRoot: up }));
  await handle('SessionStart', {}, ctx());
  expect(JSON.parse(fs.readFileSync(lf(), 'utf8')).pluginRoot).toBe(up);
});
test('pluginRoot ngoai cache (worktree dev) -> khong ghi', async () => {
  fs.writeFileSync(lf(), JSON.stringify({ pluginRoot: '/old/0.3.1' }));
  const dev = path.join(tmp, 'devplug'); fs.mkdirSync(path.join(dev, '.claude-plugin'), { recursive: true }); fs.writeFileSync(path.join(dev, '.claude-plugin', 'plugin.json'), '{}');
  await handle('SessionStart', {}, ctx({ pluginRoot: dev }));
  expect(JSON.parse(fs.readFileSync(lf(), 'utf8')).pluginRoot).toBe('/old/0.3.1');
});
test('loi -> fail-open', async () => {
  fs.writeFileSync(lf(), '{"pluginRoot":"x"}');
  expect(await handle('SessionStart', {}, ctx({ audit: () => { throw new Error('boom'); } }))).toEqual({});
  expect(await handle('SessionStart', {}, ctx({ dir: null, pluginRoot: {} }))).toEqual({});
  expect(hook.onError).toBe('open');
});
