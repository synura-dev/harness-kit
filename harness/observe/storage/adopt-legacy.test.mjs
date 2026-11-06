// bun test harness/observe/storage/adopt-legacy.test.mjs
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptLegacyHarness } from './data.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const fixture = (marker = true) => {
  const ws = tmp();
  if (marker) w(path.join(ws, 'config', 'hub', 'default.json'), '{}');
  w(path.join(ws, '.harness', '.gitignore'), '*\n');
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
  expect(fs.readFileSync(path.join(ws, 'data', 'audit', 'a.jsonl'), 'utf8')).toBe('{"a":1}\n');
  expect(fs.existsSync(path.join(ws, '.harness', 'data', 'new', 'n.json'))).toBe(true);
  expect(fs.existsSync(path.join(ws, 'data', 'new'))).toBe(false);
});

test('--yes: noi jsonl khong trung, chuyen file moi, sqlite trung dich -> _inbox, xoa .harness', () => {
  const ws = fixture();
  const root = path.join(ws, 'data');
  const r = adoptLegacyHarness({ ws, root, yes: true });
  expect(fs.readFileSync(path.join(root, 'audit', 'a.jsonl'), 'utf8')).toBe('{"a":1}\n{"a":2}\n');
  expect(fs.existsSync(path.join(root, 'new', 'n.json'))).toBe(true);
  expect(fs.readFileSync(path.join(root, 'knowledge', 'knowledge.sqlite'), 'utf8')).toBe('current');
  expect(r.inbox).toEqual(['knowledge/knowledge.sqlite']);
  const day = fs.readdirSync(path.join(root, '_inbox'))[0];
  expect(fs.readFileSync(path.join(root, '_inbox', day, 'legacy-harness', 'knowledge', 'knowledge.sqlite'), 'utf8')).toBe('legacy');
  expect(r.removed).toBe(true);
  expect(fs.existsSync(path.join(ws, '.harness'))).toBe(false);
});
