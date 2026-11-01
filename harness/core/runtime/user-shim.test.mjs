import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SHIM_MARK, renderShims, pluginCacheDir, userPathDirs, defaultShimDir, planShim, applyShim, shimStatus, onPath } from './user-shim.mjs';

let tmp;
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
// cache gia: <tmp>/claude/plugins/cache/mkt/harness-kit/<ver>/bin/harness in ra ban + argv, thoat ma 7
const fakeCache = (vers) => {
  const c = mk('claude', 'plugins', 'cache', 'mkt', 'harness-kit');
  for (const v of vers) { const b = mk('claude', 'plugins', 'cache', 'mkt', 'harness-kit', v, 'bin'); fs.writeFileSync(path.join(b, 'harness'), `console.log(JSON.stringify(['${v}', ...process.argv.slice(2)])); process.exit(7);\n`); }
  return c;
};
const sep = process.platform === 'win32' ? ';' : ':';
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

test('planShim/applyShim: tao, idempotent, cap nhat shim cua ta, tu choi file la tru --force', () => {
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
  const p3 = planShim({ dir, platform: 'linux', cacheDir: '/a', force: true });
  expect(applyShim(p3)).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'harness'), 'utf8')).toContain(SHIM_MARK);
});

test('userPathDirs: mo rong %VAR% khong phan biet hoa thuong; POSIX -> null', () => {
  expect(userPathDirs({ platform: 'win32', env: { LocalAppData: 'C:\\L' }, regPath: '%LOCALAPPDATA%\\agy\\bin;;C:\\x ;%NOPE%\\y' })).toEqual(['C:\\L\\agy\\bin', 'C:\\x', '%NOPE%\\y']);
  expect(userPathDirs({ platform: 'linux' })).toBe(null);
});

test('defaultShimDir Windows: uu tien %APPDATA%\\npm, bo WindowsApps va thu muc khong ghi duoc', () => {
  const a = mk('agy'); const wa = mk('Microsoft', 'WindowsApps'); const npm = mk('Roaming', 'npm');
  const env = { APPDATA: path.join(tmp, 'Roaming') };
  expect(defaultShimDir({ platform: 'win32', env, regPath: [path.join(tmp, 'gone'), wa, a, npm].join(';') }).dir).toBe(npm);
  expect(defaultShimDir({ platform: 'win32', env: {}, regPath: [wa, a].join(';') }).dir).toBe(a);
  expect(defaultShimDir({ platform: 'win32', env: {}, regPath: wa }).dir).toBe(null);
});

test('defaultShimDir POSIX: ~/.local/bin', () => {
  expect(defaultShimDir({ platform: 'linux', home: '/home/u' })).toEqual({ dir: '/home/u/.local/bin', why: 'POSIX mac dinh ~/.local/bin' });
});

test('shimStatus: missing / ok / stale / foreign; bo qua bin trong plugin', () => {
  const cache = fakeCache(['0.1.1']);
  const plug = path.join(cache, '0.1.1');
  const pbin = path.join(plug, 'bin');
  const main = process.platform === 'win32' ? 'harness.cmd' : 'harness';
  fs.writeFileSync(path.join(pbin, main), 'plugin bin, khong marker');
  const dir = mk('bin');
  const env = { PATH: [pbin, dir].join(sep) };
  const st = () => shimStatus({ env, cacheDir: cache, pluginRoot: plug }).state;
  expect(st()).toBe('missing');
  applyShim(planShim({ dir, cacheDir: cache, pluginRoot: plug }));
  expect(st()).toBe('ok');
  applyShim(planShim({ dir, cacheDir: path.join(tmp, 'khac'), pluginRoot: plug }));
  expect(st()).toBe('stale');
  fs.writeFileSync(path.join(dir, main), 'viet tay');
  expect(st()).toBe('foreign');
  expect(onPath(dir, { env })).toBe(true);
});
