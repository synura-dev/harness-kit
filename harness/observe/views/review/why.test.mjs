import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEvents, why, map, parseSince } from './review.mjs';

function fixture(rows, extra = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-why-'));
  const day = new Date().toISOString().slice(0, 10);
  const d = path.join(tmp, `date=${day}`, 'type=tool');
  fs.mkdirSync(d, { recursive: true });
  const base = Date.now() - 60000;
  const lines = rows.map((r, i) => JSON.stringify({ ts: new Date(base + i * 1000).toISOString(), sid: 'claude-abc12345', tool: r.tool || 'Bash', data: r.data }));
  fs.writeFileSync(path.join(d, 's.jsonl'), [...lines, ...extra].join('\n'));
  return tmp;
}

const rows = [
  { data: { task_id: 'T1', error_fp: 'aaaa', attempt: 1, error: 'fail at C:\\secret\\x.js line 12' } },
  { data: { task_id: 'T1', error_fp: 'aaaa', attempt: 2 } },
  { data: { task_id: 'T1', error_fp: 'aaaa', attempt: 3 } },
  { data: { task_id: 'T1', verifier_outcome: 'fail' } },
  { tool: 'Edit', data: { task_id: 'T1', files_touched: ['a.js'] } },
  { tool: 'Edit', data: { task_id: 'T1', files_touched: ['a.js'] } },
  { tool: 'Edit', data: { task_id: 'T1', files_touched: ['C:/abs/a.js'] } },
  { data: { task_id: 'T2', verifier_outcome: 'pass' } },
  { tool: 'Edit', data: { task_id: 'T2', files_touched: ['docs/x.md'] } },
];

test('why: nhom loi lap, thu lai, bo dang, churn; khong lo duong dan', () => {
  const r = loadEvents(fixture(rows, ['not json', '{"x":1}']));
  expect(r.skipped).toBe(2);
  const out = why(r).join('\n');
  expect(out).toContain('3x fp=aaaa max_attempt=3');
  expect(out).toContain('T1: Bash fp=aaaa attempt=3');
  expect(out).toContain('verifier fail cuoi');
  expect(out).toContain('x3');
  expect(out).not.toContain('secret');
  expect(out).not.toContain('C:');
  expect(out.split('\n').length).toBeLessThanOrEqual(40);
});

test('map + loc task + du lieu cu thieu truong', () => {
  const tmp = fixture([...rows, { data: {} }, { data: null }]);
  const r = loadEvents(tmp, { task: 'T2' });
  const out = map(r).join('\n');
  expect(out).toContain('T2: 1 lan cham, verifier=pass');
  expect(out).not.toContain('T1');
  expect(map(loadEvents(tmp)).length).toBeLessThanOrEqual(40);
});

test('thu muc rong / since khong vo', () => {
  expect(loadEvents(path.join(os.tmpdir(), 'khong-ton-tai-xyz')).events.length).toBe(0);
  expect(parseSince('7d', 1e12)).toBe(1e12 - 7 * 86400000);
});
