import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import hook, { handle, cmpVer, spawnArgs, inClaudeCache } from './hook.mjs';

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
  expect(fs.existsSync(path.join(home, '.harness-kit', 'agy-sync.lock'))).toBe(false);
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

test('agy.exe -> spawn thang bang mang args; agy.cmd -> cmd.exe /d /s /c verbatim, duong dan co dau cach va &', async () => {
  await run({ platform: 'win32', which: () => 'C:\\Users\\a b\\agy.exe' });
  expect(calls[0]).toEqual({ cmd: 'C:\\Users\\a b\\agy.exe', args: ['plugin', 'install', plug], key: 'agy-plugin-sync' });
  const s = spawnArgs('C:\\Program Files\\a&b\\agy.cmd', 'C:\\x y\\p&q^r\\harness-kit\\1', { ComSpec: 'cmd.exe' });
  expect(s).toEqual({ cmd: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\Program Files\\a&b\\agy.cmd" plugin install "C:\\x y\\p&q^r\\harness-kit\\1""'], verbatim: true });
  expect(spawnArgs('C:\\a%b\\agy.cmd', 'C:\\p')).toBeNull(); // % khong thoat duoc an toan
  expect(spawnArgs('C:\\a\\agy.cmd', 'C:\\p"q')).toBeNull();
});

test('chi nang cap: mine cu hon / bang / khong doc duoc -> khong spawn; moi hon -> spawn (semver so, 0.10 > 0.9)', async () => {
  put(agyPlugin(home), { version: '0.5.0' });
  expect(await run()).toEqual({});
  put(agyPlugin(home), { version: 'abc' });
  expect(await run()).toEqual({});
  put(agyPlugin(home), { version: '0.4.0' });
  expect(await run()).toEqual({});
  expect(calls).toEqual([]);
  expect(cmpVer('0.10.0', '0.9.9')).toBe(1);
  expect(cmpVer('1.0.0', '0.99.99')).toBe(1);
  expect(cmpVer('x', '1.0.0')).toBeNull();
  put(agyPlugin(home), { version: '0.3.10' });
  expect((await run()).additionalContext).toContain('0.3.10 -> 0.4.0');
  expect(calls.length).toBe(1);
});

test('chi SessionStart source=startup (hoac thieu); resume/compact/clear -> khong spawn', async () => {
  const h = (source) => handle('SessionStart', { source }, { cfg, pluginRoot: plug, inj });
  for (const s of ['resume', 'compact', 'clear']) expect(await h(s)).toEqual({});
  expect(calls).toEqual([]);
  expect((await h('startup')).additionalContext).toBeTruthy();
  expect(calls.length).toBe(1);
});

test('dau thoi gian: kiem truoc which; version khac -> lam moi; tuoi am = het han; lui 10p*2^fails', async () => {
  const stamp = path.join(home, '.harness-kit', 'agy-sync.json');
  let whichCalls = 0;
  const which = () => { whichCalls++; return '/bin/agy'; };
  put(stamp, { version: '0.4.0', at: 1e9 - 1000, fails: 0 });
  expect(await run({ which })).toEqual({});
  expect(whichCalls).toBe(0);
  put(stamp, { version: '0.3.5', at: 1e9 - 1000, fails: 0 }); // dau cua version khac -> khong chan
  expect((await run({ which })).additionalContext).toBeTruthy();
  expect(JSON.parse(fs.readFileSync(stamp, 'utf8'))).toEqual({ version: '0.4.0', at: 1e9, fails: 0 });
  put(stamp, { version: '0.4.0', at: 1e9 + 5000, fails: 0 }); // tuoi am
  expect((await run()).additionalContext).toBeTruthy();
  // that bai lien tiep: fails 0 -> 1 -> 2; cho 10p, 20p, 40p
  put(stamp, { version: '0.4.0', at: 1e9, fails: 0 });
  expect((await run({ now: 1e9 + 10 * 60e3 })).additionalContext).toBeTruthy();
  expect(JSON.parse(fs.readFileSync(stamp, 'utf8')).fails).toBe(1);
  expect(await run({ now: 1e9 + 29 * 60e3 })).toEqual({}); // 19p < 20p
  expect((await run({ now: 1e9 + 31 * 60e3 })).additionalContext).toBeTruthy();
  expect(JSON.parse(fs.readFileSync(stamp, 'utf8')).fails).toBe(2);
  put(stamp, { version: '0.4.0', at: 1e9, fails: 99 }); // tran 24h
  expect(await run({ now: 1e9 + 23 * 3600e3 })).toEqual({});
  expect((await run({ now: 1e9 + 25 * 3600e3 })).additionalContext).toBeTruthy();
});

test('khong ghi duoc dau/khoa -> khong spawn; khoa dang giu -> khong spawn; khoa treo -> don', async () => {
  fs.writeFileSync(path.join(home, '.harness-kit'), 'x'); // thu muc dau la file -> mkdir loi
  expect(await run()).toEqual({});
  fs.rmSync(path.join(home, '.harness-kit'));
  put(path.join(home, '.harness-kit', 'agy-sync.lock'), '');
  expect(await run()).toEqual({});
  expect(calls).toEqual([]);
  const old = new Date(Date.now() - 10 * 60e3);
  fs.utimesSync(path.join(home, '.harness-kit', 'agy-sync.lock'), old, old);
  expect((await run()).additionalContext).toBeTruthy();
  expect(fs.existsSync(path.join(home, '.harness-kit', 'agy-sync.lock'))).toBe(false);
});

test('inClaudeCache: CLAUDE_CONFIG_DIR doi goc cache; ten gan giong khong khop', () => {
  const alt = path.join(tmp, 'alt');
  const p = path.join(alt, 'plugins', 'cache', 'm', 'harness-kit', '1.0.0');
  expect(inClaudeCache(p, { env: { CLAUDE_CONFIG_DIR: alt }, home })).toBe(true);
  expect(inClaudeCache(p, { env: {}, home })).toBe(false);
  expect(inClaudeCache(plug, { env: { CLAUDE_CONFIG_DIR: alt }, home })).toBe(false);
  expect(inClaudeCache(plug + '-x', { env: {}, home })).toBe(true);
  expect(inClaudeCache(path.join(home, '.claude', 'plugins', 'cache-evil', 'x'), { env: {}, home })).toBe(false);
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
