import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STORE_DEFAULTS,
  appendRecord,
  appendRecords,
  readRecords,
  queryRecords,
  pruneRecords,
  rotateFile,
  pruneDir
} from './jsonl-store.mjs';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));

test('appendRecord: auto creates parent dir and writes JSON line with timestamp', () => {
  const tmpDir = mkTmp();
  const file = path.join(tmpDir, 'sub', 'store.jsonl');

  const rec = appendRecord(file, { id: 'rec-1', title: 'Task Alpha' });
  expect(rec).not.toBeNull();
  expect(rec.id).toBe('rec-1');
  expect(rec.ts).toBeDefined();
  expect(fs.existsSync(file)).toBe(true);

  const raw = fs.readFileSync(file, 'utf8').trim();
  const parsed = JSON.parse(raw);
  expect(parsed.id).toBe('rec-1');
  expect(parsed.title).toBe('Task Alpha');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('appendRecords: dedupes based on dedupeKey across existing file and new batch', () => {
  const tmpDir = mkTmp();
  const file = path.join(tmpDir, 'dedupe.jsonl');

  // Initial batch
  const b1 = appendRecords(file, [
    { id: '1', title: 'First' },
    { id: '2', title: 'Second' },
    { id: '1', title: 'First Duplicate in Batch' }
  ], { dedupeKey: 'id' });

  expect(b1.addedCount).toBe(2);
  expect(b1.records.map((r) => r.id)).toEqual(['1', '2']);

  // Second batch with duplicate from disk
  const b2 = appendRecords(file, [
    { id: '2', title: 'Second Duplicate from disk' },
    { id: '3', title: 'Third' }
  ], { dedupeKey: 'id' });

  expect(b2.addedCount).toBe(1);
  expect(b2.records[0].id).toBe('3');

  const { records } = readRecords(file);
  expect(records.length).toBe(3);
  expect(records.map((r) => r.id)).toEqual(['1', '2', '3']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('readRecords: returns empty when file missing, parses valid lines, respects reverse', () => {
  const tmpDir = mkTmp();
  const file = path.join(tmpDir, 'missing.jsonl');
  expect(readRecords(file).records).toEqual([]);

  const dataFile = path.join(tmpDir, 'data.jsonl');
  appendRecord(dataFile, { id: 'a' });
  appendRecord(dataFile, { id: 'b' });
  appendRecord(dataFile, { id: 'c' });

  const forward = readRecords(dataFile, { reverse: false });
  expect(forward.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);

  const backward = readRecords(dataFile, { reverse: true });
  expect(backward.records.map((r) => r.id)).toEqual(['c', 'b', 'a']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('readRecords: handles maxBytes truncation safely', () => {
  const tmpDir = mkTmp();
  const file = path.join(tmpDir, 'large.jsonl');

  // Create file with 100 records
  for (let i = 0; i < 100; i++) {
    appendRecord(file, { id: `id-${i}`, payload: 'x'.repeat(100) });
  }

  // Read with very small maxBytes in reverse mode
  const res = readRecords(file, { maxBytes: 500, reverse: true });
  expect(res.truncated).toBe('max_bytes');
  expect(res.records.length).toBeGreaterThan(0);
  expect(res.records.length).toBeLessThan(10);
  // Last items written should appear first
  expect(res.records[0].id).toBe('id-99');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('queryRecords: filters by keyword q, section, status, and honors limit', () => {
  const tmpDir = mkTmp();
  const file = path.join(tmpDir, 'query.jsonl');

  appendRecords(file, [
    { id: '1', section: 'Done', title: 'Fix bug in auth service', text: 'token leak', status: 'completed' },
    { id: '2', section: 'Review', title: 'Implement rate limiting', text: 'redis token bucket', status: 'pending' },
    { id: '3', section: 'Done', title: 'Refactor database models', text: 'postgres migration', status: 'completed' },
    { id: '4', section: 'In progress', title: 'Add diagnostic engine', text: 'ts error parser', status: 'active', tags: ['diag', 'parser'] }
  ]);

  // Query by text keyword
  const qToken = queryRecords(file, { q: 'token' });
  expect(qToken.matches.length).toBe(2);
  expect(qToken.matches.map((m) => m.id)).toEqual(['2', '1']); // Reverse order: 2 then 1

  // Query with section filter
  const qSection = queryRecords(file, { q: 'token', section: 'done' });
  expect(qSection.matches.length).toBe(1);
  expect(qSection.matches[0].id).toBe('1');

  // Query by tag
  const qTag = queryRecords(file, { q: 'diag' });
  expect(qTag.matches.length).toBe(1);
  expect(qTag.matches[0].id).toBe('4');

  // Limit check
  const qLimit = queryRecords(file, { limit: 1 });
  expect(qLimit.matches.length).toBe(1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const DAY = 86400000;
const NOW = Date.parse('2026-06-01T00:00:00Z');
const iso = (d) => new Date(NOW - d * DAY).toISOString();
const writeLines = (f, recs) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

test('pruneRecords: by age, by count, dryRun does not write', () => {
  const d = mkTmp(); const f = path.join(d, 'a.jsonl');
  writeLines(f, [{ id: 1, ts: iso(40) }, { id: 2, ts: iso(20) }, { id: 3, ts: iso(1) }]);
  const dry = pruneRecords(f, { maxAgeDays: 30, now: NOW, dryRun: true, root: d });
  expect(dry).toEqual({ kept: 2, removed: 1, truncated: null });
  expect(readRecords(f).records.length).toBe(3);
  expect(pruneRecords(f, { maxAgeDays: 30, now: NOW, root: d }).removed).toBe(1);
  expect(readRecords(f).records.map((r) => r.id)).toEqual([2, 3]);
  expect(pruneRecords(f, { maxRecords: 1, root: d }).kept).toBe(1);
  expect(readRecords(f).records.map((r) => r.id)).toEqual([3]);
  expect(fs.readdirSync(d)).toEqual(['a.jsonl']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('pruneRecords: max_bytes and timeout report truncated without writing', () => {
  const d = mkTmp(); const f = path.join(d, 'b.jsonl');
  writeLines(f, [{ id: 1, ts: iso(99) }, { id: 2, ts: iso(98) }]);
  expect(pruneRecords(f, { maxAgeDays: 1, now: NOW, maxBytes: 10, root: d }).truncated).toBe('max_bytes');
  expect(pruneRecords(f, { maxAgeDays: 1, now: NOW, timeoutMs: -1, root: d }).truncated).toBe('timeout');
  expect(readRecords(f).records.length).toBe(2);
  fs.rmSync(d, { recursive: true, force: true });
});

test('rotateFile: shrinks oversize file keeping newest lines', () => {
  const d = mkTmp(); const f = path.join(d, 'r.jsonl');
  writeLines(f, Array.from({ length: 50 }, (_, i) => ({ id: i, ts: iso(0), p: 'x'.repeat(50) })));
  const r = rotateFile(f, { maxBytes: 1000, readMaxBytes: 100000, root: d });
  expect(r.removed).toBeGreaterThan(0);
  expect(fs.statSync(f).size).toBeLessThanOrEqual(1000);
  expect(readRecords(f).records.at(-1).id).toBe(49);
  expect(rotateFile(f, { maxBytes: 1000, root: d }).removed).toBe(0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('root bat buoc cho pruneRecords/rotateFile/pruneDir', () => {
  const d = mkTmp(); const f = path.join(d, 'a.jsonl');
  writeLines(f, [{ ts: iso(99) }]);
  expect(() => pruneRecords(f, { maxAgeDays: 1, now: NOW })).toThrow(/root/);
  expect(() => rotateFile(f, { maxBytes: 1 })).toThrow(/root/);
  expect(() => pruneDir(d, { now: NOW })).toThrow(/root/);
  expect(() => pruneDir(d, { now: NOW, root: path.join(d, 'sub') })).toThrow(/ngoai root/);
  expect(readRecords(f).records.length).toBe(1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('traversal blocked', () => {
  const d = mkTmp(); const outside = mkTmp(); const f = path.join(outside, 'x.jsonl');
  writeLines(f, [{ ts: iso(99) }]);
  expect(() => pruneRecords(f, { maxAgeDays: 1, now: NOW, root: d })).toThrow();
  expect(() => rotateFile(path.join(d, '..', path.basename(outside), 'x.jsonl'), { root: d })).toThrow();
  expect(readRecords(f).records.length).toBe(1);
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
});

test('pruneDir: applies retention caps per subdir, supports overrides and dryRun', () => {
  const d = mkTmp();
  writeLines(path.join(d, 'events', 'e.jsonl'), [{ ts: iso(40) }, { ts: iso(5) }]);
  writeLines(path.join(d, 'digests', 'g.jsonl'), [{ ts: iso(100) }, { ts: iso(50) }]);
  const old = new Date(NOW - 20 * DAY);
  fs.mkdirSync(path.join(d, 'runs'));
  fs.writeFileSync(path.join(d, 'runs', 'r1.md'), 'x');
  fs.utimesSync(path.join(d, 'runs', 'r1.md'), old, old);
  fs.mkdirSync(path.join(d, 'baselines'));
  for (let i = 0; i < 4; i++) {
    const p = path.join(d, 'baselines', `b${i}.json`);
    fs.writeFileSync(p, '{}');
    const t = new Date(NOW - i * DAY);
    fs.utimesSync(p, t, t);
  }
  const caps = { retention: { baselinesKeep: 2 } };
  expect(pruneDir(d, { now: NOW, dryRun: true, caps, root: d }).removed).toBe(5);
  expect(fs.existsSync(path.join(d, 'runs', 'r1.md'))).toBe(true);
  expect(pruneDir(d, { now: NOW, caps, root: d }).removed).toBe(5);
  expect(fs.existsSync(path.join(d, 'runs', 'r1.md'))).toBe(false);
  expect(fs.readdirSync(path.join(d, 'baselines')).sort()).toEqual(['b0.json', 'b1.json']);
  expect(readRecords(path.join(d, 'events', 'e.jsonl')).records.length).toBe(1);
  expect(readRecords(path.join(d, 'digests', 'g.jsonl')).records.length).toBe(1);
  fs.rmSync(d, { recursive: true, force: true });
});
