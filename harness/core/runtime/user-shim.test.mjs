import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { legacyShimDir, msixInfo, virtualizedDir, realTerminalLine, SHIM_MARK, renderShims, userPathDirs, defaultShimDir, planShim, applyShim, shimStatus, onPath, ensureUserPath, strayShims, syncUserShim, rootsFile, rootVersion, rootsStatus } from './user-shim.mjs';

// KHONG test nao duoc ghi PATH that: Windows luon truyen regPath + setUserPath gia; POSIX dung home tam.
let tmp;
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
// goc plugin gia: <tmp>/<name>/bin/harness in ra ban + argv, thoat ma 7; ban ghi trong .antigravity-plugin/plugin.json
const fakeRoot = (name, ver) => {
  const r = mk(name);
  fs.mkdirSync(path.join(r, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(r, 'bin', 'harness'), `console.log(JSON.stringify(['${ver}', ...process.argv.slice(2)])); process.exit(7);\n`);
  fs.mkdirSync(path.join(r, '.antigravity-plugin'), { recursive: true });
  fs.writeFileSync(path.join(r, '.antigravity-plugin', 'plugin.json'), JSON.stringify({ version: ver }));
  return r;
};
const sep = process.platform === 'win32' ? ';' : ':';
const noWrite = () => { throw new Error('khong duoc ghi PATH that'); };
// inj chung: home/env/shimDir tam, khong cham PATH may
const mkInj = (home = mk('home')) => ({ env: { LOCALAPPDATA: path.join(tmp, 'Local'), APPDATA: path.join(tmp, 'Roaming'), PATH: '' }, home, regPath: 'C:\\x', setUserPath: () => null });
const rootsOf = (dir) => JSON.parse(fs.readFileSync(rootsFile(dir), 'utf8'));
const runShim = (dir, args = []) => {
  const runs = [];
  const q = (s) => `"${s}"`; // cmd /s /c "<dong lenh>": tu quote vi duong dan co dau cach
  if (process.platform === 'win32') runs.push(spawnSync('cmd.exe', ['/d', '/s', '/c', q([path.join(dir, 'harness.cmd'), ...args].map(q).join(' '))], { encoding: 'utf8', timeout: 20000, windowsVerbatimArguments: true }));
  if (spawnSync('sh', ['-c', 'exit 0'], { timeout: 5000 }).status === 0) runs.push(spawnSync('sh', [path.join(dir, 'harness'), ...args], { encoding: 'utf8', timeout: 20000 }));
  return runs;
};
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "us 'x-")); }); // dau cach + nhay don trong duong dan
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('render: Windows ghi .cmd + sh, POSIX chi sh; co marker; tat dinh', () => {
  const w = renderShims({ platform: 'win32', dir: 'C:\\U\\.harness-kit\\bin' });
  expect(w.map((f) => f.name)).toEqual(['harness.cmd', 'harness']);
  expect(w[0].content).toContain(SHIM_MARK);
  expect(w[0].content).toContain('\r\n');
  expect(w[0].content).toContain('-- %*');
  expect(w[0].content).toContain('roots.json');
  const p = renderShims({ platform: 'linux', dir: '/h/.local/bin' });
  expect(p.map((f) => f.name)).toEqual(['harness']);
  expect(p[0].content.startsWith('#!/bin/sh\n')).toBe(true);
  expect(p[0].content).toContain('"$@"');
  expect(renderShims({ platform: 'linux', dir: '/x' })).toEqual(renderShims({ platform: 'linux', dir: '/x' }));
});

test('render: % trong duong dan duoc nhan doi trong .cmd', () => {
  expect(renderShims({ platform: 'win32', dir: 'C:\\a%b' })[0].content).toContain("C:/a%%b/roots.json");
});

test('(h) core/runtime/user-shim.mjs va shim sinh ra khong chua chuoi duong cai cua tool khac', () => {
  const needle = ['.', 'claude'].join('');
  expect(fs.readFileSync(path.join(import.meta.dir, 'user-shim.mjs'), 'utf8').includes(needle)).toBe(false);
  for (const platform of ['win32', 'linux']) for (const f of renderShims({ platform, dir: '/x' })) expect(f.content.includes(needle)).toBe(false);
});

test('(e) shim chay that: hai root con -> chon version cao nhat theo so (0.1.10 > 0.1.9), giu argv, giu ma thoat', () => {
  const dir = mk('bin');
  applyShim(planShim({ dir }));
  fs.writeFileSync(rootsFile(dir), JSON.stringify({ agy: { root: fakeRoot('a', '0.1.9'), version: '0.1.9' }, claude: { root: fakeRoot('c', '0.1.10'), version: '0.1.10' } }));
  const args = ['--help', 'a b', '-x'];
  const runs = runShim(dir, args);
  expect(runs.length).toBeGreaterThan(0);
  for (const r of runs) {
    expect(r.status).toBe(7);
    expect(JSON.parse(r.stdout.trim().split(/\r?\n/).pop())).toEqual(['0.1.10', ...args]);
  }
});

test('(c) khoa tool kia vang -> shim bo qua no, dung khoa con lai; khoa cua chinh tool duoc ghi lai', () => {
  const dir = mk('bin');
  applyShim(planShim({ dir }));
  const alive = fakeRoot('c', '0.1.2');
  fs.writeFileSync(rootsFile(dir), JSON.stringify({ agy: { root: path.join(tmp, 'da-vang'), version: '9.9.9' }, claude: { root: alive, version: '0.1.2' } }));
  for (const r of runShim(dir, ['x'])) { expect(r.status).toBe(7); expect(JSON.parse(r.stdout.trim().split(/\r?\n/).pop())).toEqual(['0.1.2', 'x']); }
  // tool agy chay lai voi root dung: don khoa cua minh (root vang -> root that), khoa claude giu nguyen
  const agyRoot = fakeRoot('a', '0.1.3');
  syncUserShim({ dir, tool: 'agy', pluginRoot: agyRoot, ...mkInj() });
  const r = rootsOf(dir);
  expect(r.agy.root).toBe(path.resolve(agyRoot));
  expect(r.claude.root).toBe(alive);
});

test('scan: root cu bien mat nhung thu muc scan con ban moi hon -> shim chon ban moi; syncUserShim({scan}) ghi {scan} khong ghi root', () => {
  const inj = mkInj();
  const cache = mk('cache', 'harness-kit');
  const mkVer = (v) => { fs.mkdirSync(path.join(cache, v, 'bin'), { recursive: true }); fs.writeFileSync(path.join(cache, v, 'bin', 'harness'), `console.log(JSON.stringify(['${v}', ...process.argv.slice(2)])); process.exit(7);\n`); };
  mkVer('0.1.9'); mkVer('0.1.10');
  const s = syncUserShim({ tool: 'claude', pluginRoot: path.join(cache, '0.1.9'), scan: cache, ...inj });
  expect(rootsOf(s.dir).claude).toEqual({ scan: path.resolve(cache) });
  for (const r of runShim(s.dir, ['x'])) { expect(r.status).toBe(7); expect(JSON.parse(r.stdout.trim().split(/\r?\n/).pop())).toEqual(['0.1.10', 'x']); }
  fs.rmSync(path.join(cache, '0.1.10'), { recursive: true }); // ban moi bi xoa, chi con 0.1.9 -> van chay, khong crash
  for (const r of runShim(s.dir, ['y'])) { expect(r.status).toBe(7); expect(JSON.parse(r.stdout.trim().split(/\r?\n/).pop())).toEqual(['0.1.9', 'y']); }
  expect(syncUserShim({ tool: 'claude', pluginRoot: path.join(cache, '0.1.9'), scan: cache, ...inj }).rootsChanged).toBe(false);
});

test('(d) ca hai root vang -> shim in thong bao + exit 3, khong crash', () => {
  const dir = mk('bin');
  applyShim(planShim({ dir }));
  fs.writeFileSync(rootsFile(dir), JSON.stringify({ agy: { root: path.join(tmp, 'v1') }, claude: { root: path.join(tmp, 'v2') } }));
  const runs = runShim(dir);
  expect(runs.length).toBeGreaterThan(0);
  for (const r of runs) { expect(r.status).toBe(3); expect(r.stderr).toContain('khong tim thay plugin harness-kit'); }
});

test('shim khong co roots.json -> exit 3 + thong bao', () => {
  const dir = mk('bin');
  applyShim(planShim({ dir }));
  for (const r of runShim(dir)) { expect(r.status).toBe(3); expect(r.stderr).toContain('khong tim thay plugin harness-kit'); }
});

test('(a) agy-only: khong co cache/thu muc cua tool kia -> ghi shim + roots.json chi khoa agy, shim chay duoc', () => {
  const R = fakeRoot('agyplug', '0.4.0');
  fs.mkdirSync(path.join(R, 'harness', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(R, 'harness', 'cli', 'harness.mjs'), '');
  const inj = mkInj();
  const s = syncUserShim({ tool: 'agy', pluginRoot: R, ...inj });
  expect(s.ok).toBe(true);
  expect(s.rootsChanged).toBe(true);
  expect(Object.keys(rootsOf(s.dir))).toEqual(['agy']);
  expect(rootsOf(s.dir).agy).toEqual({ root: path.resolve(R), version: '0.4.0' });
  for (const r of runShim(s.dir, ['doctor'])) { expect(r.status).toBe(7); expect(JSON.parse(r.stdout.trim().split(/\r?\n/).pop())).toEqual(['0.4.0', 'doctor']); }
  // lan 2 khong doi gi
  const again = syncUserShim({ tool: 'agy', pluginRoot: R, ...inj });
  expect(again.rootsChanged).toBe(false);
  expect(again.files.every((f) => f.action === 'same')).toBe(true);
});

test('(b) tool claude them khoa claude, KHONG xoa khoa agy con ton tai', () => {
  const inj = mkInj();
  const A = fakeRoot('a', '0.4.0');
  const C = fakeRoot('c', '0.4.1');
  const s = syncUserShim({ tool: 'agy', pluginRoot: A, ...inj });
  syncUserShim({ tool: 'claude', pluginRoot: C, ...inj });
  const r = rootsOf(s.dir);
  expect(Object.keys(r).sort()).toEqual(['agy', 'claude']);
  expect(r.agy.root).toBe(path.resolve(A));
  expect(r.claude.version).toBe('0.4.1');
});

test('(f) shim cu (co SHIM_MARK) bi ghi de; file la (khong SHIM_MARK) KHONG bi ghi de', () => {
  const inj = mkInj();
  const R = fakeRoot('a', '0.4.0');
  const dir = defaultShimDir({ env: inj.env, home: inj.home });
  fs.mkdirSync(dir, { recursive: true });
  const oldName = process.platform === 'win32' ? 'harness.cmd' : 'harness';
  fs.writeFileSync(path.join(dir, oldName), `# ${SHIM_MARK} cu, khong co roots.json\n`);
  const s = syncUserShim({ tool: 'agy', pluginRoot: R, ...inj });
  expect(s.blocked).toBe(false);
  expect(fs.readFileSync(path.join(dir, oldName), 'utf8')).toContain('roots.json');
  expect(fs.existsSync(rootsFile(dir))).toBe(true);
  // file la
  fs.writeFileSync(path.join(dir, oldName), 'cua toi\n');
  fs.rmSync(rootsFile(dir));
  const b = syncUserShim({ tool: 'agy', pluginRoot: R, ...inj });
  expect(b.blocked).toBe(true);
  expect(fs.readFileSync(path.join(dir, oldName), 'utf8')).toBe('cua toi\n');
  expect(fs.existsSync(rootsFile(dir))).toBe(false);
});

test('rootVersion: doc plugin.json, roi ten thu muc so ban, roi rong', () => {
  expect(rootVersion(fakeRoot('x', '1.2.3'))).toBe('1.2.3');
  expect(rootVersion(mk('c', '0.7.1'))).toBe('0.7.1');
  expect(rootVersion(mk('src'))).toBe('');
});

test('planShim/applyShim: tao, idempotent, cap nhat shim cua ta (khac noi dung), tu choi file la tru force', () => {
  const dir = mk('bin');
  const p1 = planShim({ dir, platform: 'linux' });
  expect(p1.files.map((f) => f.action)).toEqual(['create']);
  applyShim(p1);
  expect(planShim({ dir, platform: 'linux' }).files[0].action).toBe('same');
  fs.writeFileSync(path.join(dir, 'harness'), `# ${SHIM_MARK} ban cu\n`);
  expect(planShim({ dir, platform: 'linux' }).files[0].action).toBe('update');
  fs.writeFileSync(path.join(dir, 'harness'), 'echo cua toi\n');
  const p2 = planShim({ dir, platform: 'linux' });
  expect(p2.blocked).toBe(true);
  expect(applyShim(p2)).toBe(false);
  expect(fs.readFileSync(path.join(dir, 'harness'), 'utf8')).toBe('echo cua toi\n');
  expect(applyShim(planShim({ dir, platform: 'linux', force: true }))).toBe(true);
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
  const base = { platform: 'win32', env, home: 'C:\\U', regPath: 'C:\\x', pluginRoot: fakeRoot('p', '0.1.1'), readdir: () => [] };
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
  const root = fakeRoot('p', '0.1.1');
  const home = mk('home');
  const old = mk('Roaming', 'npm');
  const other = mk('other');
  const target = path.join(home, '.harness-kit', 'bin');
  applyShim(planShim({ dir: old }));
  fs.writeFileSync(path.join(other, process.platform === 'win32' ? 'harness.cmd' : 'harness'), 'cua user');
  const calls = [];
  const inj = { env: { LOCALAPPDATA: path.join(tmp, 'Local'), APPDATA: path.join(tmp, 'Roaming'), PATH: [other, old].join(sep) }, home, regPath: 'C:\\x', setUserPath: (v) => { calls.push(v); return null; } };
  const s = syncUserShim({ pluginRoot: root, tool: 'agy', ...inj });
  expect(s.ok).toBe(true);
  if (process.platform === 'win32') expect(s.dir).toBe(target);
  expect(s.files.every((f) => f.action === 'create')).toBe(true);
  expect(s.path.state).toBe('added');
  expect(s.removed.length).toBeGreaterThan(0);
  expect(fs.readdirSync(old)).toEqual([]);
  expect(fs.readFileSync(path.join(other, process.platform === 'win32' ? 'harness.cmd' : 'harness'), 'utf8')).toBe('cua user');
  const again = syncUserShim({ pluginRoot: root, tool: 'agy', ...inj, regPath: `C:\\x;${s.dir}`, setUserPath: noWrite });
  expect(again.files.every((f) => f.action === 'same')).toBe(true);
  expect(again.path.state).toBe('present');
  expect(again.removed).toEqual([]);
});

test('syncUserShim dry-run: khong ghi gi; file la -> blocked, khong dung PATH', () => {
  const home = mk('home');
  const inj = { env: { LOCALAPPDATA: path.join(tmp, 'Local'), PATH: '' }, home, regPath: 'C:\\x', setUserPath: noWrite };
  const d = syncUserShim({ pluginRoot: mk('p'), tool: 'agy', apply: false, ...inj });
  expect(d.ok).toBe(true);
  expect(d.path.state).toBe('planned');
  expect(fs.existsSync(d.dir)).toBe(false);
  fs.mkdirSync(d.dir, { recursive: true });
  fs.writeFileSync(d.files[0].file, 'la');
  const b = syncUserShim({ pluginRoot: mk('p'), tool: 'agy', ...inj });
  expect(b.blocked).toBe(true);
  expect(b.path).toBe(null);
});

test('strayShims: chi lay file co marker o thu muc khac dich', () => {
  const a = mk('a'); const b = mk('b');
  applyShim(planShim({ dir: a }));
  applyShim(planShim({ dir: b }));
  const env = { PATH: [a, b].join(sep), LOCALAPPDATA: path.join(tmp, 'Local') }; // home/LOCALAPPDATA tam: thu muc cu that cua may khong lot vao
  const out = strayShims(a, { env, home: tmp });
  expect(out.length).toBeGreaterThan(0);
  expect(out.every((f) => f.startsWith(b))).toBe(true);
});

test('rootsStatus: roots.json thieu / hong / khong co root hop le -> stale; co root con bin/harness hoac scan ton tai -> ok', () => {
  const dir = mk('rs'); const plug = fakeRoot('rp', '0.1.1');
  expect(rootsStatus(dir)).toBe('missing');
  fs.writeFileSync(rootsFile(dir), '{bad');
  expect(rootsStatus(dir)).toBe('invalid');
  fs.writeFileSync(rootsFile(dir), JSON.stringify({ agy: { root: path.join(tmp, 'da-vang') } }));
  expect(rootsStatus(dir)).toBe('invalid');
  fs.writeFileSync(rootsFile(dir), JSON.stringify({ agy: { root: path.join(tmp, 'da-vang') }, claude: { root: plug } }));
  expect(rootsStatus(dir)).toBe('ok');
  fs.writeFileSync(rootsFile(dir), JSON.stringify({ claude: { scan: tmp } }));
  expect(rootsStatus(dir)).toBe('ok');
});

test('writeRoot: ghi atomic (khong de lai .tmp), giu khoa tool kia', () => {
  const home = mk('home2'); const A = fakeRoot('wa', '0.2.0'); const B = fakeRoot('wb', '0.2.1');
  const s = syncUserShim({ tool: 'agy', pluginRoot: A, ...mkInj(home) });
  syncUserShim({ tool: 'claude', pluginRoot: B, ...mkInj(home) });
  expect(Object.keys(rootsOf(s.dir)).sort()).toEqual(['agy', 'claude']);
  expect(fs.readdirSync(s.dir).filter((f) => f.includes('.tmp'))).toEqual([]);
});

test('shimStatus: missing / ok / stale / foreign / nopath o thu muc co dinh; co tool -> khoa roots lech = stale', () => {
  const plug = fakeRoot('p', '0.1.1');
  const home = mk('home');
  const env = { LOCALAPPDATA: path.join(tmp, 'Local'), PATH: '' };
  const dir = defaultShimDir({ env, home });
  const st = (o = {}) => shimStatus({ env, home, regPath: 'C:\\x', pluginRoot: plug, ...o }).state;
  expect(st()).toBe('missing');
  applyShim(planShim({ dir }));
  expect(st()).toBe('nopath');
  expect(st({ env: { ...env, PATH: dir } })).toBe('ok');
  expect(onPath(dir, { env: { PATH: dir } })).toBe(true);
  expect(st({ env: { ...env, PATH: dir }, tool: 'agy' })).toBe('stale'); // chua co khoa agy
  fs.writeFileSync(rootsFile(dir), JSON.stringify({ agy: { root: path.resolve(plug) } }));
  expect(st({ env: { ...env, PATH: dir }, tool: 'agy' })).toBe('ok');
  fs.writeFileSync(path.join(dir, 'harness'), `# ${SHIM_MARK} ban cu\n`);
  fs.writeFileSync(path.join(dir, 'harness.cmd'), `# ${SHIM_MARK} ban cu\n`);
  expect(st({ env: { ...env, PATH: dir } })).toBe('stale');
  fs.writeFileSync(planShim({ dir }).files[0].file, 'viet tay');
  expect(st()).toBe('foreign');
});
