import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import hook, { handle } from './hook.mjs';

// KHONG ghi PATH that: luon tiem regPath + setUserPath gia, LOCALAPPDATA/home tam.
let tmp; let plug; let inj; let calls;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ushook-'));
  plug = path.join(tmp, 'claude', 'plugins', 'cache', 'mkt', 'harness-kit', '0.1.1');
  fs.mkdirSync(path.join(plug, 'bin'), { recursive: true });
  calls = [];
  inj = { env: { LOCALAPPDATA: path.join(tmp, 'Local'), PATH: '' }, home: path.join(tmp, 'home'), regPath: 'C:\\x', setUserPath: (v) => { calls.push(v); return null; } };
  fs.mkdirSync(inj.home);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const cfg = { enabled: true, events: ['SessionStart'] };

test('SessionStart lan dau: tao shim + them PATH, bao mot dong; lan sau im lang', async () => {
  const r = await handle('SessionStart', {}, { cfg, pluginRoot: plug, inj });
  expect(r.additionalContext).toContain('harness-kit user-shim:');
  if (process.platform === 'win32') expect(calls.length).toBe(1);
  const dir = path.join(tmp, 'Local', 'harness-kit', 'bin');
  const again = await handle('SessionStart', {}, { cfg, pluginRoot: plug, inj: { ...inj, regPath: `C:\\x;${dir}`, home: inj.home, env: { ...inj.env, PATH: process.platform === 'win32' ? '' : dir } } });
  expect(again).toEqual({});
});

test('tat / su kien khac / chay tu nguon (khong cache) -> khong lam gi', async () => {
  expect(await handle('SessionStart', {}, { cfg: { ...cfg, enabled: false }, pluginRoot: plug, inj })).toEqual({});
  expect(await handle('Stop', {}, { cfg, pluginRoot: plug, inj })).toEqual({});
  const src = path.join(tmp, 'src', 'harness-kit');
  fs.mkdirSync(src, { recursive: true });
  expect(await handle('SessionStart', {}, { cfg, pluginRoot: src, inj })).toEqual({});
  expect(calls).toEqual([]);
});

test('file la o thu muc dich -> khong ghi de, bao lenh --force; loi -> fail-open', async () => {
  await handle('SessionStart', {}, { cfg, pluginRoot: plug, inj });
  const main = fs.readdirSync(path.join(tmp, 'Local', 'harness-kit', 'bin')).sort().at(-1);
  const f = path.join(tmp, 'Local', 'harness-kit', 'bin', process.platform === 'win32' ? 'harness.cmd' : main);
  fs.writeFileSync(f, 'la');
  const r = await handle('SessionStart', {}, { cfg, pluginRoot: plug, inj });
  expect(r.additionalContext).toContain('--force');
  expect(fs.readFileSync(f, 'utf8')).toBe('la');
  expect(await handle('SessionStart', {}, { cfg, pluginRoot: plug, inj: { ...inj, setUserPath: () => { throw new Error('x'); }, regPath: 'C:\\y' } })).toBeDefined();
});

test('duoi bun test (NODE_ENV=test) khong tiem IO -> khong dung may that', async () => {
  expect(process.env.NODE_ENV).toBe('test');
  expect(await handle('SessionStart', {}, { cfg, pluginRoot: plug })).toEqual({});
});

test('META chuan HOOK_MODULE', () => {
  expect(hook.id).toBe('user-shim');
  expect(hook.events).toEqual(['SessionStart']);
  expect(typeof hook.handle).toBe('function');
});
