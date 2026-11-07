import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import hook, { handle, load } from './hook.mjs';
import { pluginCacheDir } from '../../core/runtime/claude-cache.mjs';
import { rootsFile } from '../../core/runtime/user-shim.mjs';

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
  const dir = path.join(inj.home, process.platform === 'win32' ? '.harness-kit' : '.local', 'bin');
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
  const main = fs.readdirSync(path.join(inj.home, process.platform === 'win32' ? '.harness-kit' : '.local', 'bin')).sort().at(-1);
  const f = path.join(inj.home, process.platform === 'win32' ? '.harness-kit' : '.local', 'bin', process.platform === 'win32' ? 'harness.cmd' : main);
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

const shimDir = () => path.join(inj.home, process.platform === 'win32' ? '.harness-kit' : '.local', 'bin');
const roots = () => JSON.parse(fs.readFileSync(rootsFile(shimDir()), 'utf8'));

test('(i) claude: ghi khoa claude; claude-cache.pluginCacheDir suy tu pluginRoot trong cache, quet CLAUDE_CONFIG_DIR, null khi khong co', async () => {
  await handle('SessionStart', {}, { cfg, pluginRoot: plug, inj });
  expect(Object.keys(roots())).toEqual(['claude']);
  expect(roots().claude).toEqual({ scan: path.dirname(plug), data: path.join(tmp, 'claude', 'plugins', 'data', 'harness-kit-mkt') }); // data = thu muc du lieu plugin cua Claude (ext approve sao chep vao day)
  const cache = path.dirname(plug);
  expect(pluginCacheDir(plug)).toBe(cache);
  const src = path.join(tmp, 'src', 'harness-kit'); fs.mkdirSync(src, { recursive: true });
  expect(pluginCacheDir(src, { env: { CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') } })).toBe(cache);
  expect(pluginCacheDir(path.join(tmp, 'src2'), { env: {}, home: path.join(tmp, 'emptyhome') })).toBe(null);
});

test('agy: tool agy khong can cache Claude, chi khoa agy; claude them khoa khong xoa agy', async () => {
  const agyRoot = path.join(tmp, 'gem', 'harness-kit');
  fs.mkdirSync(path.join(agyRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(agyRoot, 'bin', 'harness'), '');
  const r = await handle('SessionStart', {}, { cfg, pluginRoot: agyRoot, tool: 'agy', inj });
  expect(r.additionalContext).toContain('khoa agy');
  expect(Object.keys(roots())).toEqual(['agy']);
  await handle('SessionStart', {}, { cfg, pluginRoot: plug, inj });
  expect(Object.keys(roots()).sort()).toEqual(['agy', 'claude']);
  // goc agy khong co bin/harness -> bo qua, khong ghi
  expect(await handle('SessionStart', {}, { cfg, pluginRoot: path.join(tmp, 'khong-co'), tool: 'agy', inj })).toEqual({});
});

test('(g) HOOK_USER_SHIM_ENABLED=0 -> config tat, hook khong ghi gi', async () => {
  const files = [path.join(tmp, 'none.json')];
  const prev = process.env.HOOK_USER_SHIM_ENABLED;
  process.env.HOOK_USER_SHIM_ENABLED = '0';
  try {
    const c = load(files).config;
    expect(c.enabled).toBeFalsy(); // env 0 -> so 0
    expect(await handle('SessionStart', {}, { cfg: c, pluginRoot: plug, tool: 'agy', inj })).toEqual({});
    expect(fs.existsSync(shimDir())).toBe(false);
  } finally { if (prev === undefined) delete process.env.HOOK_USER_SHIM_ENABLED; else process.env.HOOK_USER_SHIM_ENABLED = prev; }
});

test('META chuan HOOK_MODULE', () => {
  expect(hook.id).toBe('user-shim');
  expect(hook.events).toEqual(['SessionStart']);
  expect(typeof hook.handle).toBe('function');
});
