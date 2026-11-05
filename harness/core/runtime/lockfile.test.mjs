import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, withLock } from './lockfile.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lockf-')), 'x.json');

test('lockfile: lay/nha khoa; khoa dang giu -> khong lay duoc', () => {
  const f = tmpFile();
  const r = acquireLock(f, { retries: 0 });
  expect(typeof r).toBe('function');
  expect(acquireLock(f, { retries: 1, waitMs: 1 })).toBeNull();
  r();
  expect(fs.existsSync(`${f}.lock`)).toBe(false);
  expect(withLock(f, () => 7).value).toBe(7);
});

test('lockfile: release khong xoa khoa cua nguoi khac (khoa da bi don/chiem lai)', () => {
  const f = tmpFile();
  const r = acquireLock(f, { retries: 0 });
  fs.writeFileSync(`${f}.lock`, JSON.stringify({ pid: 999999, ts: Date.now(), n: 'other' }));
  r();
  expect(fs.existsSync(`${f}.lock`)).toBe(true);
  expect(JSON.parse(fs.readFileSync(`${f}.lock`, 'utf8')).n).toBe('other');
});

test('lockfile: khoa stale duoc don an toan (rename) va lay duoc; khoa moi khong bi don', () => {
  const f = tmpFile();
  fs.writeFileSync(`${f}.lock`, '{}');
  const old = new Date(Date.now() - 60000); fs.utimesSync(`${f}.lock`, old, old);
  const r = acquireLock(f, { staleMs: 15000, retries: 2, waitMs: 1 });
  expect(typeof r).toBe('function');
  expect(fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.stale.'))).toEqual([]);
  expect(acquireLock(f, { staleMs: 15000, retries: 1, waitMs: 1 })).toBeNull(); // khoa vua lay (moi) khong bi coi stale
  r();
});
