import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isoWeek, hasExt, markRun, kickReport, stateFile } from './run.mjs';

test('isoWeek theo gio dia phuong: 00:30 thu Hai khong roi vao tuan truoc', () => {
  assert.equal(isoWeek(new Date(2026, 10, 2, 0, 30).getTime()), '2026-W45'); // thu Hai 2026-11-02 local
  assert.equal(isoWeek(new Date(2026, 10, 1, 23, 30).getTime()), '2026-W44'); // chu nhat truoc
  assert.equal(isoWeek(new Date(2026, 11, 31, 12).getTime()), '2026-W53');
});

test('hasExt khop chinh xac id, khong khop chuoi con', () => {
  const list = () => [{ id: 'tasks-extra', root: '/x/tasks-extra' }, { id: 'obsidian', root: '/x/o' }];
  assert.equal(hasExt('/hub', 'tasks', list), false);
  assert.equal(hasExt('/hub', 'tasks-extra', list), true);
  assert.equal(hasExt('/hub', 'obsidian', list), true);
  assert.equal(hasExt('/hub', 'tasks', () => { throw new Error('x'); }), false);
});

test('markRun ghi loi + lastRun: kickReport ton trong backoff 7 ngay', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rfix-')); const o = { env: { HUB_DATA_DIR: d } }; let n = 0;
  const NOW = Date.parse('2026-11-05T12:00:00Z');
  markRun(o, NOW, 'khong ghi duoc file bao cao');
  const st = JSON.parse(fs.readFileSync(stateFile(o), 'utf8'));
  assert.equal(st.lastRun, NOW); assert.match(st.error, /khong ghi/);
  assert.equal(kickReport(o, { spawnReport: () => { n++; } }, NOW + 11 * 60e3), false);
  assert.equal(n, 0);
  fs.rmSync(d, { recursive: true, force: true });
});
