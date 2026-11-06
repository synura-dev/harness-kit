// bun test harness/observe/storage/adopt-legacy.test.mjs
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptLegacyHarness } from './data.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-')); made.push(d); return d; };
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const rd = (f) => fs.readFileSync(f, 'utf8');
const bare = (marker = true) => { const ws = tmp(); if (marker) w(path.join(ws, 'config', 'hub', 'default.json'), '{}'); w(path.join(ws, '.harness', '.gitignore'), '*\n'); return ws; };
const fixture = (marker = true) => {
  const ws = bare(marker);
  w(path.join(ws, '.harness', 'data', 'audit', 'a.jsonl'), '{"a":1}\n{"a":2}\n');
  w(path.join(ws, '.harness', 'data', 'new', 'n.json'), '{}');
  w(path.join(ws, '.harness', 'data', 'knowledge', 'knowledge.sqlite'), 'legacy');
  w(path.join(ws, 'data', 'audit', 'a.jsonl'), '{"a":1}\n');
  w(path.join(ws, 'data', 'knowledge', 'knowledge.sqlite'), 'current');
  return ws;
};

test('khong co dau hieu workspace -> khong lam gi', () => {
  const ws = fixture(false);
  const r = adoptLegacyHarness({ ws, root: path.join(ws, 'data'), yes: true });
  expect(r.applicable).toBe(false);
  expect(fs.existsSync(path.join(ws, '.harness', 'data', 'audit', 'a.jsonl'))).toBe(true);
});

test('dry-run khong doi gi', () => {
  const ws = fixture();
  const r = adoptLegacyHarness({ ws, root: path.join(ws, 'data') });
  expect(r.dryRun).toBe(true);
  expect(r.appended).toEqual([{ file: 'audit/a.jsonl', lines: 1 }]);
  expect(rd(path.join(ws, 'data', 'audit', 'a.jsonl'))).toBe('{"a":1}\n');
  expect(fs.existsSync(path.join(ws, '.harness', 'data', 'new', 'n.json'))).toBe(true);
  expect(fs.existsSync(path.join(ws, 'data', 'new'))).toBe(false);
});

test('--yes: noi jsonl khong trung, chuyen file moi, sqlite trung dich -> _inbox, xoa .harness', () => {
  const ws = fixture();
  const root = path.join(ws, 'data');
  const r = adoptLegacyHarness({ ws, root, yes: true });
  expect(rd(path.join(root, 'audit', 'a.jsonl'))).toBe('{"a":1}\n{"a":2}\n');
  expect(fs.existsSync(path.join(root, 'new', 'n.json'))).toBe(true);
  expect(rd(path.join(root, 'knowledge', 'knowledge.sqlite'))).toBe('current');
  expect(r.inbox).toEqual(['knowledge/knowledge.sqlite']);
  const day = fs.readdirSync(path.join(root, '_inbox'))[0];
  expect(rd(path.join(root, '_inbox', day, 'legacy-harness', 'knowledge', 'knowledge.sqlite'))).toBe('legacy');
  expect(r.removed).toBe(true);
  expect(r.errors).toEqual([]);
  expect(fs.existsSync(path.join(ws, '.harness'))).toBe(false);
});

test('(1) dataRoot trung/long .harness/data (HUB_DATA_DIR=<ws>/.harness/data) -> loi, khong mat du lieu', () => {
  const ws = fixture();
  const src = path.join(ws, '.harness', 'data');
  for (const root of [src, path.join(src, 'audit'), path.join(ws, '.harness')]) {
    const r = adoptLegacyHarness({ ws, root, yes: true });
    expect(r.errors.length).toBe(1);
    expect(r.removed).toBe(false);
  }
  expect(rd(path.join(src, 'audit', 'a.jsonl'))).toBe('{"a":1}\n{"a":2}\n');
});

test('(2) sqlite + -wal/-shm la mot nhom: dich co db -> ca nhom vao _inbox, khong -wal canh db dich', () => {
  const ws = bare(); const root = path.join(ws, 'data');
  for (const s of ['', '-wal', '-shm']) w(path.join(ws, '.harness', 'data', 'k', 'k.sqlite' + s), 'L' + s);
  w(path.join(root, 'k', 'k.sqlite'), 'current');
  const r = adoptLegacyHarness({ ws, root, yes: true });
  expect(r.inbox.sort()).toEqual(['k/k.sqlite', 'k/k.sqlite-shm', 'k/k.sqlite-wal']);
  expect(fs.readdirSync(path.join(root, 'k'))).toEqual(['k.sqlite']);
  expect(rd(path.join(root, 'k', 'k.sqlite'))).toBe('current');
});

test('(2) sqlite nhom khi dich chua co db: ca nhom chuyen sang dich', () => {
  const ws = bare(); const root = path.join(ws, 'data');
  for (const s of ['', '-wal']) w(path.join(ws, '.harness', 'data', 'k', 'k.sqlite' + s), 'L' + s);
  const r = adoptLegacyHarness({ ws, root, yes: true });
  expect(r.moved.sort()).toEqual(['k/k.sqlite', 'k/k.sqlite-wal']);
  expect(r.inbox).toEqual([]);
});

test('(3)(8) chay lai cung ngay khong ghi de _inbox (hau to .N)', () => {
  const ws = bare(); const root = path.join(ws, 'data');
  w(path.join(root, 'x.bin'), 'cur');
  w(path.join(ws, '.harness', 'data', 'x.bin'), 'one');
  adoptLegacyHarness({ ws, root, yes: true });
  w(path.join(ws, '.harness', 'data', 'x.bin'), 'two');
  w(path.join(ws, '.harness', '.gitignore'), '*\n');
  adoptLegacyHarness({ ws, root, yes: true });
  const day = fs.readdirSync(path.join(root, '_inbox'))[0];
  const dir = path.join(root, '_inbox', day, 'legacy-harness');
  expect(fs.readdirSync(dir).sort()).toEqual(['x.bin', 'x.bin.1']);
  expect(rd(path.join(dir, 'x.bin'))).toBe('one');
  expect(rd(path.join(dir, 'x.bin.1'))).toBe('two');
  expect(rd(path.join(root, 'x.bin'))).toBe('cur');
});

test('(4) loi thao tac (_inbox la FILE) -> errors[], khong xoa .harness, khong bao da chuyen', () => {
  const ws = bare(); const root = path.join(ws, 'data');
  w(path.join(ws, '.harness', 'data', 'a.json'), '{}');
  w(path.join(root, 'a.json'), 'cur');
  w(path.join(root, '_inbox'), 'file');
  const r = adoptLegacyHarness({ ws, root, yes: true });
  expect(r.errors.length).toBe(1);
  expect(r.inbox).toEqual([]);
  expect(r.removed).toBe(false);
  expect(fs.existsSync(path.join(ws, '.harness', 'data', 'a.json'))).toBe(true);
});

test('(6) jsonl: dich thieu newline cuoi -> chen newline; vuot tran kich thuoc -> _inbox', () => {
  const ws = bare(); const root = path.join(ws, 'data');
  w(path.join(root, 'a.jsonl'), '{"a":1}');
  w(path.join(ws, '.harness', 'data', 'a.jsonl'), '{"a":2}\n');
  w(path.join(ws, '.harness', 'data', 'big.jsonl'), '{"b":"' + 'x'.repeat(200) + '"}\n');
  const r = adoptLegacyHarness({ ws, root, yes: true, maxJsonlBytes: 100 });
  expect(rd(path.join(root, 'a.jsonl'))).toBe('{"a":1}\n{"a":2}\n');
  expect(r.inbox).toEqual(['big.jsonl']);
  expect(fs.existsSync(path.join(root, 'big.jsonl'))).toBe(false);
});

test('(7) dich la symlink/junction ra ngoai dataRoot -> errors[]', () => {
  const ws = bare(); const root = path.join(ws, 'data'); const out = tmp();
  fs.mkdirSync(root, { recursive: true });
  try { fs.symlinkSync(out, path.join(root, 'link'), 'junction'); } catch { return; }
  w(path.join(ws, '.harness', 'data', 'link', 'f.json'), '{}');
  const r = adoptLegacyHarness({ ws, root, yes: true });
  expect(r.errors.length).toBe(1);
  expect(fs.readdirSync(out)).toEqual([]);
  expect(r.removed).toBe(false);
});

test('(8) .harness con file khac -> khong xoa; truncated -> khong xoa', () => {
  const ws = bare(); const root = path.join(ws, 'data');
  w(path.join(ws, '.harness', 'data', 'a.json'), '{}');
  w(path.join(ws, '.harness', 'other.txt'), 'giu');
  expect(adoptLegacyHarness({ ws, root, yes: true }).removed).toBe(false);
  expect(fs.existsSync(path.join(ws, '.harness', 'other.txt'))).toBe(true);
  const ws2 = bare(); w(path.join(ws2, '.harness', 'data', 'a', 'a.json'), '{}'); w(path.join(ws2, '.harness', 'data', 'b', 'b.json'), '{}');
  const t = adoptLegacyHarness({ ws: ws2, root: path.join(ws2, 'data'), yes: true, maxFiles: 1 });
  expect(t.truncated).toBeTruthy();
  expect(t.removed).toBe(false);
  expect(fs.existsSync(path.join(ws2, '.harness'))).toBe(true);
});
