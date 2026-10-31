import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fmtDur, fmtTok, runAuditReview, isTempPath, readCapped } from './review.mjs';

test('fmtDur formats seconds, minutes, hours', () => {
  expect(fmtDur(5000)).toBe('5s');
  expect(fmtDur(65000)).toBe('1m05s');
  expect(fmtDur(3665000)).toBe('1h01m');
  expect(fmtDur(null)).toBe('0s');
});

test('fmtTok formats token counts', () => {
  expect(fmtTok(500)).toBe('500');
  expect(fmtTok(1500)).toBe('1.5k');
  expect(fmtTok(1200000)).toBe('1.2M');
  expect(fmtTok(0)).toBe('0');
});

test('runAuditReview: non-existent date handled safely', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rev-'));
  const res = await runAuditReview('1999-01-01', { auditDir: tmp });
  expect(res.totalEvents).toBe(0);
  expect(res.lines.some((l) => l.includes('No audit logs found'))).toBe(true);
});

test('runAuditReview: correctly separates verified vs unverified false-positive errors', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rev-'));
  const dateDir = path.join(tmp, 'date=2026-10-27', 'type=tool');
  fs.mkdirSync(dateDir, { recursive: true });

  const rows = [
    // False positive error with empty error string
    {
      v: 2,
      ts: '2026-10-27T10:00:00.000Z',
      type: 'tool',
      tool: 'Read',
      target: 'file1.txt',
      ok: false,
      status: 'error',
      data: { error: '', error_len: 0 }
    },
    // Real verified error
    {
      v: 2,
      ts: '2026-10-27T10:01:00.000Z',
      type: 'tool',
      tool: 'Read',
      target: 'file2.txt',
      ok: false,
      status: 'error',
      data: { error: 'File not found', error_len: 14 }
    },
    // Long bash without timeout
    {
      v: 2,
      ts: '2026-10-27T10:02:00.000Z',
      type: 'tool',
      tool: 'Bash',
      target: 'sleep 70',
      ok: true,
      dur_ms: 70000,
      tokens_in: 1000,
      tokens_out: 200,
      sid: 'sess-1'
    }
  ];

  fs.writeFileSync(path.join(dateDir, 'tool.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));

  const res = await runAuditReview('2026-10-27', { auditDir: tmp, hubDir: tmp });
  expect(res.totalEvents).toBe(3);
  expect(res.verifiedErrors).toBe(1);
  expect(res.unverifiedErrors).toBe(1);
  expect(res.unboundedBash).toBe(1);
  expect(res.lines.length).toBeLessThanOrEqual(35);
});

test('isTempPath: os.tmpdir() va .gemini la tam; ten temp/tmp bat ky thi khong', () => {
  expect(isTempPath(path.join(os.tmpdir(), 'x', 'a.js'))).toBe(true);
  expect(isTempPath('C:/Users/u/.gemini/a.js')).toBe(true);
  expect(isTempPath('D:/work/temp/app/a.js')).toBe(false);
  expect(isTempPath('D:/work/tmp/a.js')).toBe(false);
});

test('readCapped / --max-bytes: cat file lon, bao truncated', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cap-'));
  const f = path.join(tmp, 'a.jsonl');
  fs.writeFileSync(f, ['{"a":1}', '{"a":2}', '{"a":3}'].join('\n') + '\n');
  const r = readCapped(f, 12);
  expect(r.truncated).toBe(true);
  expect(r.text).toBe('{"a":3}\n');
  expect(readCapped(f, 1000).truncated).toBe(false);
  const dateDir = path.join(tmp, 'date=2026-10-27', 'type=tool'); fs.mkdirSync(dateDir, { recursive: true });
  fs.writeFileSync(path.join(dateDir, 'x.jsonl'), '{"v":2,"type":"tool","tool":"Read","ok":true}\n'.repeat(50));
  const res = await runAuditReview('2026-10-27', { auditDir: tmp, maxBytes: 100 });
  expect(res.lines.join('\n')).toContain('truncated: max-bytes');
});

test('readCapped: file mot dong qua lon -> rong nhung truncated; --max-bytes sai -> exit 2', async () => {
  const { spawnSync } = await import('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cap2-'));
  const f = path.join(tmp, 'b.jsonl');
  fs.writeFileSync(f, 'x'.repeat(100));
  expect(readCapped(f, 10)).toEqual({ text: '', truncated: true });
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'observe.mjs');
  for (const v of ['abc', '-5', '0']) {
    const r = spawnSync(process.execPath, [decodeURIComponent(cli), 'view', '--max-bytes', v], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  }
});
