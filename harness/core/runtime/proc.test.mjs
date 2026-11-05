import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { spawnSync, spawn, spawnBackground, sweepLedger, ledgerPath, isRunning, ledgerDone, isAlive, killTree, matchEntry, sweepBackground, SWEEP, readLedger } from './proc.mjs';
import { withLock, acquireLock } from './lockfile.mjs';
import { checkProcDirect, scanProcDirect, PROC_EXCEPTIONS } from '../checks/proc-check.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'proc-t-'));
const read = (d) => readLedger(ledgerPath(d));
const seed = (f, entries) => fs.writeFileSync(f, entries.map((e) => JSON.stringify({ op: 'add', ...e }) + '\n').join(''));

test('spawnSync/spawn luon windowsHide:true, ke ca khi nguoi goi dat false', () => {
  const seen = [];
  const orig = [cp.spawnSync, cp.spawn];
  cp.spawnSync = (...a) => { seen.push(a[a.length - 1]); return { status: 0 }; };
  cp.spawn = (...a) => { seen.push(a[a.length - 1]); return {}; };
  try {
    spawnSync('x', ['a'], { windowsHide: false });
    spawnSync('x', { encoding: 'utf8' });
    spawn('x', ['a'], { windowsHide: false });
    spawn('x');
  } finally { [cp.spawnSync, cp.spawn] = orig; }
  expect(seen.length).toBe(4);
  for (const o of seen) expect(o.windowsHide).toBe(true);
});

test('spawnSync qua han -> loi ETIMEDOUT va tien trinh bi giet', () => {
  const t = Date.now();
  const r = spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { timeout: 500, stdio: 'ignore' });
  expect(r.error?.code).toBe('ETIMEDOUT');
  expect(Date.now() - t).toBeLessThan(10000);
  if (r.pid) expect(isAlive(r.pid)).toBe(false);
});

test('so PID: them, khoa theo key, xoa khi xong', () => {
  const d = tmp();
  const pid = spawnBackground({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{},30000)'], key: 'k1', deadlineMs: 60000, dir: d });
  try {
    expect(pid).toBeGreaterThan(0);
    const e = read(d);
    expect(e.length).toBe(1);
    expect(e[0].pid).toBe(pid); expect(e[0].key).toBe('k1'); expect(e[0].deadline).toBeGreaterThan(Date.now());
    expect(e[0].cmd).toContain('setTimeout');
    expect(isRunning('k1', { dir: d })).toBe(true);
    expect(spawnBackground({ cmd: process.execPath, args: ['-e', '0'], key: 'k1', dir: d })).toBeNull(); // khoa: khong chay trung
    ledgerDone({ key: 'k1' }, { dir: d });
    expect(read(d).length).toBe(0);
  } finally { killTree(pid); }
});

test('sweepLedger: PID chet -> xoa; qua han + con song -> kill; con han -> giu; khong dung lenh -> khong kill', () => {
  const d = tmp();
  const f = ledgerPath(d);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const now = 1e12;
  seed(f, [
    { pid: 1, key: 'dead', cmd: 'a', deadline: now + 1e6 },
    { pid: 2, key: 'over', cmd: 'b', deadline: now - 1 },
    { pid: 3, key: 'fresh', cmd: 'c', deadline: now + 1e6 },
    { pid: 4, key: 'reused', cmd: 'd', deadline: now - 1 },
  ]);
  const killed = [];
  const r = sweepLedger({ dir: d, now, alive: (p) => p !== 1, kill: (p) => killed.push(p), matches: (p) => p !== 4 });
  expect(killed).toEqual([2]);
  expect(r).toEqual({ removed: 3, killed: 1 });
  expect(read(d).map((e) => e.key)).toEqual(['fresh']);
});

test('sweepLedger: kill chay SAU khi nha khoa so (khoa khong bi giu trong luc taskkill) va muc da bo khoi so', () => {
  const d = tmp();
  const f = ledgerPath(d);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const now = 1e12;
  seed(f, [{ pid: 2, key: 'over', cmd: 'b', deadline: now - 1 }, { pid: 3, key: 'fresh', cmd: 'c', deadline: now + 1e6 }]);
  const seen = [];
  sweepLedger({ dir: d, now, alive: () => true, kill: (p) => seen.push({ p, locked: fs.existsSync(`${f}.lock`), keys: read(d).map((e) => e.key) }), matches: () => true });
  expect(seen).toEqual([{ p: 2, locked: false, keys: ['fresh'] }]);
});

test('check proc-direct bat goi thang child_process, bo qua test/ngoai le', () => {
  const v = checkProcDirect([
    { path: 'harness/a.mjs', text: "import { spawn } from 'node:child_process';" },
    { path: 'harness/b.mjs', text: "const { x } = await import('node:child_process');" },
    { path: 'harness/c.mjs', text: "const c = require('child_process');" },
    { path: 'harness/d.mjs', text: "Bun.spawnSync(['git']);" },
    { path: 'harness/ok.mjs', text: "import { spawn } from '../core/runtime/proc.mjs';\n// child_process chi la comment" },
    { path: 'harness/a.test.mjs', text: "import cp from 'node:child_process';" },
    { path: 'harness/core/runtime/proc.mjs', text: "import cp from 'node:child_process';" },
  ]);
  expect(v.map((x) => x.file)).toEqual(['harness/a.mjs', 'harness/b.mjs', 'harness/c.mjs', 'harness/d.mjs']);
});

test('cay repo hien tai khong con goi thang child_process', () => {
  const root = path.resolve(import.meta.dir, '..', '..', '..');
  expect(scanProcDirect(root)).toEqual([]);
  expect(Object.keys(PROC_EXCEPTIONS).length).toBeLessThanOrEqual(6);
});

test('matchEntry: can ca duong dan script day du va thoi diem tao khop; lenh rong -> null', () => {
  const e = { needle: 'C:/x/job.mjs', startedAt: 1000000 };
  expect(matchEntry(e, { cmd: 'node "C:\\x\\job.mjs" 25', startMs: 1000500 })).toBe(true);
  expect(matchEntry(e, { cmd: 'node C:/x/job.mjs', startMs: 1000000 + 3600e3 })).toBe(false); // PID tai dung (start lech)
  expect(matchEntry(e, { cmd: 'node other.mjs 25', startMs: 1000000 })).toBe(false); // token cuoi trung nhung script khac
  expect(matchEntry(e, { cmd: null, startMs: 1000000 })).toBeNull();
  expect(matchEntry(e, { cmd: '', startMs: 1000000 })).toBeNull();
  expect(matchEntry(e, undefined)).toBeNull();
  expect(matchEntry({ startedAt: 1 }, { cmd: 'x', startMs: 1 })).toBeNull(); // muc thieu needle
});

test('sweepLedger: khong xac minh duoc (null) -> khong kill, giu muc; qua han + 24h -> xoa khong kill', () => {
  const d = tmp(); const f = ledgerPath(d); fs.mkdirSync(path.dirname(f), { recursive: true });
  const now = 1e12;
  seed(f, [
    { pid: 5, key: 'unk', cmd: 'a', deadline: now - 1000 },
    { pid: 6, key: 'old', cmd: 'b', deadline: now - SWEEP.staleAfterMs - 1 },
  ]);
  const killed = [];
  const r = sweepLedger({ dir: d, now, alive: () => true, kill: (p) => killed.push(p), matches: () => null });
  expect(killed).toEqual([]); expect(r).toEqual({ removed: 1, killed: 0 });
  expect(read(d).map((e) => e.key)).toEqual(['unk']);
});

test('spawnBackground ghi script day du + startedAt; PID tai dung (khac script) -> xoa muc, khong kill', () => {
  const d = tmp(); const script = path.join(d, 'child.mjs'); fs.writeFileSync(script, 'setTimeout(()=>{},30000)');
  const pid = spawnBackground({ cmd: process.execPath, args: [script, '25'], key: 'k', deadlineMs: -1, dir: d });
  try {
    const e = read(d)[0]; expect(e.script).toBe(path.resolve(script)); expect(e.startedAt).toBeGreaterThan(0);
    const killed = [];
    sweepLedger({ dir: d, now: Date.now(), alive: () => true, kill: (p) => killed.push(p), matches: (p, c, en) => matchEntry(en, { cmd: 'node other 25', startMs: e.startedAt }) });
    expect(killed).toEqual([]);
    expect(read(d).length).toBe(0);
  } finally { killTree(pid); }
});

test('sweepBackground khong quet dong bo: kick nen toi da 1 lan/gio', () => {
  const d = tmp(); const calls = [];
  const spawn = (o) => { calls.push(o); return 123; };
  expect(sweepBackground({ dir: d, spawn })).toEqual({ kicked: true });
  expect(sweepBackground({ dir: d, spawn })).toEqual({ kicked: false });
  expect(calls.length).toBe(1); expect(calls[0].key).toBe('proc-sweep'); expect(calls[0].args[0]).toMatch(/proc-sweep\.mjs$/);
});

test('withLock: loai tru lan nhau, khoa mo coi (stale) bi don, het retry -> ok:false', () => {
  const d = tmp(); const f = path.join(d, 'x.json');
  const rel = acquireLock(f);
  expect(withLock(f, () => 1, { retries: 1, waitMs: 5 }).ok).toBe(false);
  rel();
  expect(withLock(f, () => 7).value).toBe(7);
  fs.writeFileSync(`${f}.lock`, '{}'); const old = new Date(Date.now() - 60000); fs.utimesSync(`${f}.lock`, old, old);
  expect(withLock(f, () => 8, { staleMs: 1000 }).value).toBe(8);
});

test('so PID: ghi dong thoi tu nhieu tien trinh khong mat muc', async () => {
  const d = tmp();
  const code = `import('${new URL('./proc.mjs', import.meta.url).href}').then(m=>{for(let i=0;i<5;i++)m.spawnBackground({cmd:process.execPath,args:['-e','setTimeout(()=>{},20000)'],key:'k'+process.pid+'_'+i,dir:${JSON.stringify(d)}});})`;
  const ps = [0, 1, 2].map(() => cp.spawn(process.execPath, ['-e', code], { stdio: 'ignore' }));
  await Promise.all(ps.map((p) => new Promise((r) => p.on('exit', r))));
  const es = read(d);
  try { expect(es.length).toBe(15); } finally { for (const e of es) killTree(e.pid); }
}, 30000);
