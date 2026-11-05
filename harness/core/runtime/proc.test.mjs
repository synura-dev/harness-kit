import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { spawnSync, spawn, spawnBackground, sweepLedger, ledgerPath, isRunning, ledgerDone, isAlive, killTree } from './proc.mjs';
import { checkProcDirect, scanProcDirect, PROC_EXCEPTIONS } from '../checks/proc-check.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'proc-t-'));
const read = (d) => JSON.parse(fs.readFileSync(ledgerPath(d), 'utf8')).entries;

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
  fs.writeFileSync(f, JSON.stringify({ entries: [
    { pid: 1, key: 'dead', cmd: 'a', deadline: now + 1e6 },
    { pid: 2, key: 'over', cmd: 'b', deadline: now - 1 },
    { pid: 3, key: 'fresh', cmd: 'c', deadline: now + 1e6 },
    { pid: 4, key: 'reused', cmd: 'd', deadline: now - 1 },
  ] }));
  const killed = [];
  const r = sweepLedger({ dir: d, now, alive: (p) => p !== 1, kill: (p) => killed.push(p), matches: (p) => p !== 4 });
  expect(killed).toEqual([2]);
  expect(r).toEqual({ removed: 3, killed: 1 });
  expect(read(d).map((e) => e.key)).toEqual(['fresh']);
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
