import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import hook, { handle } from './hook.mjs';

// KHONG cham ~/.gemini that, KHONG chay agy that: home/spawn/which luon duoc tiem.
let tmp; let home; let plug; let calls; let inj;
const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)); };
const agyPlugin = (h) => path.join(h, '.gemini', 'config', 'plugins', 'harness-kit', '.antigravity-plugin', 'plugin.json');
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agysync-'));
  home = path.join(tmp, 'home');
  plug = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'harness-kit', '0.4.0');
  put(path.join(plug, '.claude-plugin', 'plugin.json'), { version: '0.4.0' });
  put(agyPlugin(home), { version: '0.3.9' });
  calls = [];
  inj = { env: {}, home, platform: 'linux', now: 1e9, which: () => '/bin/agy', spawn: (a) => { calls.push(a); return 123; } };
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const cfg = { enabled: true, events: ['SessionStart'] };
const run = (o = {}) => handle('SessionStart', {}, { cfg, pluginRoot: plug, inj: { ...inj, ...o } });

test('version khac -> spawn dung mot lan + bao mot dong; stamp chan lan hai, het han thi thu lai', async () => {
  const r = await run();
  expect(r.additionalContext).toBe('agy plugin harness-kit: cap nhat 0.3.9 -> 0.4.0');
  expect(calls).toEqual([{ cmd: '/bin/agy', args: ['plugin', 'install', plug], key: 'agy-plugin-sync' }]);
  expect(await run({ now: 1e9 + 60000 })).toEqual({});
  expect(calls.length).toBe(1);
  expect((await run({ now: 1e9 + 11 * 60e3 })).additionalContext).toContain('0.3.9 -> 0.4.0');
  expect(calls.length).toBe(2);
});

test('cung version (ke ca file co BOM) -> khong spawn', async () => {
  put(agyPlugin(home), '\uFEFF' + JSON.stringify({ version: '0.4.0' }));
  expect(await run()).toEqual({});
  expect(calls).toEqual([]);
});

test('chua cai agy nhung ~/.gemini co -> cai; khong co ~/.gemini -> khong lam gi', async () => {
  fs.rmSync(path.join(home, '.gemini', 'config'), { recursive: true });
  expect((await run()).additionalContext).toContain('(chua cai) -> 0.4.0');
  expect(calls.length).toBe(1);
  fs.rmSync(path.join(home, '.gemini'), { recursive: true });
  fs.rmSync(path.join(home, '.harness-kit'), { recursive: true });
  expect(await run()).toEqual({});
  expect(calls.length).toBe(1);
});

test('chay tu nguon (ngoai cache) / tat bang env / khong co agy tren PATH / tat cfg -> khong spawn', async () => {
  const src = path.join(tmp, 'src', 'harness-kit');
  put(path.join(src, '.claude-plugin', 'plugin.json'), { version: '0.4.0' });
  expect(await handle('SessionStart', {}, { cfg, pluginRoot: src, inj })).toEqual({});
  expect(await run({ env: { HARNESS_AGY_AUTOSYNC: '0' } })).toEqual({});
  expect(await run({ which: () => null })).toEqual({});
  expect(await handle('SessionStart', {}, { cfg: { ...cfg, enabled: false }, pluginRoot: plug, inj })).toEqual({});
  expect(await handle('Stop', {}, { cfg, pluginRoot: plug, inj })).toEqual({});
  expect(calls).toEqual([]);
});

test('agy.cmd tren Windows -> qua cmd.exe /c', async () => {
  await run({ platform: 'win32', which: () => 'C:\\bin\\agy.cmd', env: { ComSpec: 'cmd.exe' } });
  expect(calls[0].cmd).toBe('cmd.exe');
  expect(calls[0].args).toEqual(['/c', 'C:\\bin\\agy.cmd', 'plugin', 'install', plug]);
});

test('loi (spawn nem, spawn khong co pid, plugin.json hong, home sai) -> fail-open {}', async () => {
  expect(await run({ spawn: () => { throw new Error('boom'); } })).toEqual({});
  fs.rmSync(path.join(home, '.harness-kit'), { recursive: true, force: true });
  expect(await run({ spawn: () => null })).toEqual({});
  put(path.join(plug, '.claude-plugin', 'plugin.json'), '{hong');
  expect(await run()).toEqual({});
  expect(hook.id).toBe('agy-sync');
  expect(await hook.handle('SessionStart', {}, { cfg, pluginRoot: plug, inj: { ...inj, home: 5 } })).toEqual({});
});
