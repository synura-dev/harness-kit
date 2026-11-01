import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { legacyShimDir, msixInfo, virtualizedDir, realTerminalLine, SHIM_MARK, renderShims, pluginCacheDir, userPathDirs, defaultShimDir, planShim, applyShim, shimStatus, onPath, ensureUserPath, strayShims, syncUserShim } from './user-shim.mjs';

// KHONG test nao duoc ghi PATH that: Windows luon truyen regPath + setUserPath gia; POSIX dung home tam.
let tmp;
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
// cache gia: <tmp>/claude/plugins/cache/mkt/harness-kit/<ver>/bin/harness in ra ban + argv, thoat ma 7
const fakeCache = (vers) => {
  const c = mk('claude', 'plugins', 'cache', 'mkt', 'harness-kit');
  for (const v of vers) { const b = mk('claude', 'plugins', 'cache', 'mkt', 'harness-kit', v, 'bin'); fs.writeFileSync(path.join(b, 'harness'), `console.log(JSON.stringify(['${v}', ...process.argv.slice(2)])); process.exit(7);\n`); }
  return c;
};
const sep = process.platform === 'win32' ? ';' : ':';
const noWrite = () => { throw new Error('khong duoc ghi PATH that'); };
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "us 'x-")); }); // dau cach + nhay don trong duong dan
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('render: Windows ghi .cmd + sh, POSIX chi sh; co marker; tat dinh', () => {
  const w = renderShims({ platform: 'win32', cacheDir: 'C:\\c\\harness-kit' });
  expect(w.map((f) => f.name)).toEqual(['harness.cmd', 'harness']);
  expect(w[0].content).toContain(SHIM_MARK);
  expect(w[0].content).toContain('\r\n');
  expect(w[0].content).toContain('-- %*');
  const p = renderShims({ platform: 'linux', cacheDir: '/h/.claude/plugins/cache/m/harness-kit' });
  expect(p.map((f) => f.name)).toEqual(['harness']);
  expect(p[0].content.startsWith('#!/bin/sh\n')).toBe(true);
  expect(p[0].content).toContain('"$@"');
  expect(renderShims({ platform: 'linux', cacheDir: '/x' })).toEqual(renderShims({ platform: 'linux', cacheDir: '/x' }));
});

test('render: % trong duong dan duoc nhan doi trong .cmd', () => {
  expect(renderShims({ platform: 'win32', cacheDir: 'C:\\a%b' })[0].content).toContain("'C:/a%%b'");
});

test('shim chay that: chon ban moi nhat theo so (0.1.10 > 0.1.9), giu argv, giu ma thoat', () => {
  const cache = fakeCache(['0.1.9', '0.1.10', '0.2.0-x']);
  fs.rmSync(path.join(cache, '0.2.0-x', 'bin'), { recursive: true }); // thu muc khong co bin/harness bi bo qua
  const dir = mk('bin');
  expect(applyShim(planShim({ dir, cacheDir: cache }))).toBe(true);
  const args = ['--help', 'a b', '-x'];
  const runs = [];
  const q = (s) => `"${s}"`; // cmd /s /c "<dong lenh>": tu quote vi duong dan co dau cach
  if (process.platform === 'win32') runs.push(spawnSync('cmd.exe', ['/d', '/s', '/c', q([path.join(dir, 'harness.cmd'), ...args].map(q).join(' '))], { encoding: 'utf8', timeout: 20000, windowsVerbatimArguments: true }));
  if (spawnSync('sh', ['-c', 'exit 0'], { timeout: 5000 }).status === 0) runs.push(spawnSync('sh', [path.join(dir, 'harness'), ...args], { encoding: 'utf8', timeout: 20000 }));
  expect(runs.length).toBeGreaterThan(0);
  for (const r of runs) {
    expect(r.status).toBe(7);
    expect(JSON.parse(r.stdout.trim().split(/\r?\n/).pop())).toEqual(['0.1.10', ...args]);
  }
});

test('shim khong thay cache -> exit 3 + thong bao', () => {
  const dir = mk('bin');
  applyShim(planShim({ dir, cacheDir: path.join(tmp, 'khong-co') }));
  const r = spawnSync('sh', [path.join(dir, 'harness')], { encoding: 'utf8', timeout: 20000 });
  if (r.error) return; // khong co sh
  expect(r.status).toBe(3);
  expect(r.stderr).toContain('khong tim thay plugin harness-kit');
});

test('pluginCacheDir: suy tu pluginRoot trong cache, quet CLAUDE_CONFIG_DIR, null khi khong co', () => {
  const cache = fakeCache(['0.1.1']);
  expect(pluginCacheDir(path.join(cache, '0.1.1'))).toBe(cache);
  expect(pluginCacheDir(mk('src', 'harness-kit'), { env: { CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') } })).toBe(cache);
  expect(pluginCacheDir(mk('src2'), { env: {}, home: mk('emptyhome') })).toBe(null);
});

test('planShim/applyShim: tao, idempotent, cap nhat shim cua ta, tu choi file la tru force', () => {
  const dir = mk('bin');
  const p1 = planShim({ dir, platform: 'linux', cacheDir: '/a' });
  expect(p1.files.map((f) => f.action)).toEqual(['create']);
  applyShim(p1);
  expect(planShim({ dir, platform: 'linux', cacheDir: '/a' }).files[0].action).toBe('same');
  expect(planShim({ dir, platform: 'linux', cacheDir: '/b' }).files[0].action).toBe('update');
  fs.writeFileSync(path.join(dir, 'harness'), 'echo cua toi\n');
  const p2 = planShim({ dir, platform: 'linux', cacheDir: '/a' });
  expect(p2.blocked).toBe(true);
  expect(applyShim(p2)).toBe(false);
  expect(fs.readFileSync(path.join(dir, 'harness'), 'utf8')).toBe('echo cua toi\n');
  expect(applyShim(planShim({ dir, platform: 'linux', cacheDir: '/a', force: true }))).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'harness'), 'utf8')).toContain(SHIM_MARK);
});

test('defaultShimDir: thu muc co dinh theo nen', () => {
  // Windows: %USERPROFILE%\.harness-kit\bin, KHONG %LOCALAPPDATA% (MSIX ao hoa)
  expect(defaultShimDir({ platform: 'win32', home: 'C:\\U' })).toBe('C:\\U\\.harness-kit\\bin');
  expect(defaultShimDir({ platform: 'linux', home: '/home/u' })).toBe('/home/u/.local/bin');
  expect(legacyShimDir({ platform: 'win32', env: { LocalAppData: 'C:\\L' } })).toBe('C:\\L\\harness-kit\\bin');
  expect(legacyShimDir({ platform: 'win32', env: {}, home: 'C:\\U' })).toBe('C:\\U\\AppData\\Local\\harness-kit\\bin');
  expect(legacyShimDir({ platform: 'linux', home: '/home/u' })).toBeNull();
});

test('msixInfo / virtualizedDir / shimStatus.risk: nhan ra goc bi MSIX ao hoa va in dong chay trong terminal that', () => {
  const env = { LOCALAPPDATA: 'C:\\U\\AppData\\Local' };
  expect(msixInfo({ platform: 'linux' }).msix).toBe(false);
  expect(msixInfo({ platform: 'win32', env, execPath: 'C:\\Program Files\\WindowsApps\\Claude_1\\app\\claude.exe' }).msix).toBe(true);
  expect(msixInfo({ platform: 'win32', env, execPath: 'C:\\node\\node.exe', readdir: () => { throw new Error('ENOENT'); } }).msix).toBe(false);
  const pk = 'C:\\U\\AppData\\Local\\Packages';
  const via = { platform: 'win32', env, execPath: 'C:\\node\\node.exe', readdir: () => ['Foo_1', 'Claude_pzs8sxrjxfjjc'], exists: (f) => f === `${pk}\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local\\harness-kit` };
  expect(msixInfo(via).msix).toBe(true);
  // cung ket qua khi env.LOCALAPPDATA da la duong dan ao hoa trong goi
  expect(msixInfo({ ...via, env: { LOCALAPPDATA: `${pk}\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local` } }).msix).toBe(true);
  expect(virtualizedDir('C:\\U\\AppData\\Local\\harness-kit\\bin', { platform: 'win32', env })).toBe(true);
  expect(virtualizedDir('C:\\U\\.harness-kit\\bin', { platform: 'win32', env })).toBe(false);
  expect(virtualizedDir('/x', { platform: 'linux', env })).toBe(false);
  const cache = fakeCache(['0.1.1']);
  const base = { platform: 'win32', env, home: 'C:\\U', regPath: 'C:\\x', cacheDir: cache, pluginRoot: path.join(cache, '0.1.1'), readdir: () => [] };
  expect(shimStatus(base).risk).toBeNull();
  expect(shimStatus({ ...base, home: 'C:\\U\\AppData\\Local' }).risk.why).toContain('MSIX');
  expect(shimStatus({ ...base, execPath: 'C:\\Program Files\\WindowsApps\\Claude_1\\claude.exe' }).risk.why).toContain('WindowsApps');
  expect(realTerminalLine('C:\\P\\harness-kit\\0.1.2')).toBe('node "' + path.join('C:\\P\\harness-kit\\0.1.2', 'bin', 'harness') + '" install --shim');
});

test('ensureUserPath migrate: muc %LOCALAPPDATA%\\harness-kit\\bin duoc thay tai cho (giu thu tu, %VAR% khac), dir moi san co thi chi bo muc cu', () => {
  const calls = [];
  const set = (v) => { calls.push(v); return null; };
  const env = { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U', PATH: 'C:\\Windows;C:\\L\\harness-kit\\bin' };
  const dir = 'C:\\U\\.harness-kit\\bin';
  const o = { platform: 'win32', env, home: 'C:\\U', setUserPath: set };
  expect(ensureUserPath(dir, { ...o, regPath: '%USERPROFILE%\\go\\bin;%LOCALAPPDATA%\\harness-kit\\bin;C:\\x' }).migrate).toBe(true);
  expect(calls.pop()).toBe('%USERPROFILE%\\go\\bin;C:\\U\\.harness-kit\\bin;C:\\x');
  expect(ensureUserPath(dir, { ...o, regPath: `C:\\a;${dir};C:\\L\\harness-kit\\bin\\;C:\\b` }).state).toBe('added');
  expect(calls.pop()).toBe(`C:\\a;${dir};C:\\b`);
  expect(ensureUserPath(dir, { ...o, regPath: 'C:\\L\\harness-kit\\bin', apply: false })).toEqual({ state: 'planned', where: 'HKCU\\Environment Path', migrate: true });
  expect(calls).toEqual([]);
});

test('userPathDirs: mo rong %VAR% khong phan biet hoa thuong', () => {
  expect(userPathDirs({ env: { LocalAppData: 'C:\\L' }, regPath: '%LOCALAPPDATA%\\agy\\bin;;C:\\x ;%NOPE%\\y' })).toEqual(['C:\\L\\agy\\bin', 'C:\\x', '%NOPE%\\y']);
});

test('ensureUserPath Windows: noi them cuoi, giu %VAR%, khong ghi khi da co (ke ca dang %VAR%) / dry-run / doc loi', () => {
  const calls = [];
  const set = (v) => { calls.push(v); return null; };
  const env = { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U', PATH: 'C:\\Windows' };
  const dir = 'C:\\U\\.harness-kit\\bin';
  expect(ensureUserPath(dir, { platform: 'win32', env, regPath: '%USERPROFILE%\\.harness-kit\\bin\\;C:\\x', setUserPath: noWrite }).state).toBe('present');
  expect(ensureUserPath(dir, { platform: 'win32', env: { ...env, PATH: dir }, setUserPath: noWrite }).state).toBe('present');
  expect(ensureUserPath(dir, { platform: 'win32', env, regPath: 'C:\\x', setUserPath: noWrite, apply: false }).state).toBe('planned');
  expect(ensureUserPath(dir, { platform: 'win32', env, regPath: null, setUserPath: noWrite }).state).toBe('error');
  expect(ensureUserPath(dir, { platform: 'win32', env, regPath: '%USERPROFILE%\\go\\bin;C:\\x\\;;', setUserPath: set }).state).toBe('added');
  expect(calls).toEqual(['%USERPROFILE%\\go\\bin;C:\\x\\;C:\\U\\.harness-kit\\bin']);
  expect(ensureUserPath(dir, { platform: 'win32', env, regPath: 'C:\\x', setUserPath: () => 'reg add loi: x' })).toEqual({ state: 'error', where: 'HKCU\\Environment Path', error: 'reg add loi: x' });
});

test('ensureUserPath POSIX: them mot dong co marker vao ~/.profile mot lan; macOS ~/.zprofile', () => {
  const home = mk('home');
  const dir = '/h/.local/bin';
  expect(ensureUserPath(dir, { platform: 'linux', env: { PATH: '/usr/bin' }, home }).state).toBe('added');
  expect(ensureUserPath(dir, { platform: 'linux', env: { PATH: '/usr/bin' }, home }).state).toBe('present');
  const prof = fs.readFileSync(path.join(home, '.profile'), 'utf8');
  expect(prof.match(new RegExp(SHIM_MARK, 'g')).length).toBe(1);
  expect(prof).toContain('export PATH="/h/.local/bin:$PATH"');
  expect(ensureUserPath(dir, { platform: 'linux', env: { PATH: `/usr/bin:${dir}` }, home: mk('h2') }).state).toBe('present');
  expect(fs.existsSync(path.join(tmp, 'h2', '.profile'))).toBe(false);
  expect(ensureUserPath(dir, { platform: 'darwin', env: { PATH: '' }, home }).where).toBe(path.posix.join(home, '.zprofile'));
});

test('syncUserShim: ghi shim + PATH + xoa shim cu cua ta (khong dung file la); lan 2 khong doi gi', () => {
  const cache = fakeCache(['0.1.1']);
  const home = mk('home');
  const old = mk('Roaming', 'npm');
  const other = mk('other');
  const target = path.join(home, '.harness-kit', 'bin');
  applyShim(planShim({ dir: old, cacheDir: '/cu' }));
  fs.writeFileSync(path.join(other, process.platform === 'win32' ? 'harness.cmd' : 'harness'), 'cua user');
  const calls = [];
  const inj = { env: { LOCALAPPDATA: path.join(tmp, 'Local'), APPDATA: path.join(tmp, 'Roaming'), PATH: [other, old].join(sep) }, home, regPath: 'C:\\x', setUserPath: (v) => { calls.push(v); return null; } };
  const s = syncUserShim({ pluginRoot: path.join(cache, '0.1.1'), ...inj });
  expect(s.ok).toBe(true);
  if (process.platform === 'win32') expect(s.dir).toBe(target);
  expect(s.files.every((f) => f.action === 'create')).toBe(true);
  expect(s.path.state).toBe('added');
  expect(s.removed.length).toBeGreaterThan(0);
  expect(fs.readdirSync(old)).toEqual([]);
  expect(fs.readFileSync(path.join(other, process.platform === 'win32' ? 'harness.cmd' : 'harness'), 'utf8')).toBe('cua user');
  const again = syncUserShim({ pluginRoot: path.join(cache, '0.1.1'), ...inj, regPath: `C:\\x;${s.dir}`, setUserPath: noWrite });
  expect(again.files.every((f) => f.action === 'same')).toBe(true);
  expect(again.path.state).toBe('present');
  expect(again.removed).toEqual([]);
});

test('syncUserShim dry-run: khong ghi gi; file la -> blocked, khong dung PATH', () => {
  const home = mk('home');
  const inj = { env: { LOCALAPPDATA: path.join(tmp, 'Local'), PATH: '' }, home, regPath: 'C:\\x', setUserPath: noWrite };
  const d = syncUserShim({ pluginRoot: mk('p'), apply: false, ...inj });
  expect(d.ok).toBe(true);
  expect(d.path.state).toBe('planned');
  expect(fs.existsSync(d.dir)).toBe(false);
  fs.mkdirSync(d.dir, { recursive: true });
  fs.writeFileSync(d.files[0].file, 'la');
  const b = syncUserShim({ pluginRoot: mk('p'), ...inj });
  expect(b.blocked).toBe(true);
  expect(b.path).toBe(null);
});

test('strayShims: chi lay file co marker o thu muc khac dich', () => {
  const a = mk('a'); const b = mk('b');
  applyShim(planShim({ dir: a, cacheDir: '/c' }));
  applyShim(planShim({ dir: b, cacheDir: '/c' }));
  const env = { PATH: [a, b].join(sep), LOCALAPPDATA: path.join(tmp, 'Local') }; // home/LOCALAPPDATA tam: thu muc cu that cua may khong lot vao
  const out = strayShims(a, { env, home: tmp });
  expect(out.length).toBeGreaterThan(0);
  expect(out.every((f) => f.startsWith(b))).toBe(true);
});

test('shimStatus: missing / ok / stale / foreign / nopath o thu muc co dinh', () => {
  const cache = fakeCache(['0.1.1']);
  const plug = path.join(cache, '0.1.1');
  const home = mk('home');
  const env = { LOCALAPPDATA: path.join(tmp, 'Local'), PATH: '' };
  const dir = defaultShimDir({ env, home });
  const st = (o = {}) => shimStatus({ env, home, regPath: 'C:\\x', cacheDir: cache, pluginRoot: plug, ...o }).state;
  expect(st()).toBe('missing');
  applyShim(planShim({ dir, cacheDir: cache, pluginRoot: plug }));
  expect(st()).toBe('nopath');
  expect(st({ env: { ...env, PATH: dir } })).toBe('ok');
  expect(onPath(dir, { env: { PATH: dir } })).toBe(true);
  applyShim(planShim({ dir, cacheDir: path.join(tmp, 'khac'), pluginRoot: plug }));
  expect(st({ env: { ...env, PATH: dir } })).toBe('stale');
  fs.writeFileSync(planShim({ dir, cacheDir: cache }).files[0].file, 'viet tay');
  expect(st()).toBe('foreign');
});
