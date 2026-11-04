import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEnvelope, partitionFile, auditRoot } from './audit-write.mjs';

const env = { ts: '2026-01-02T00:00:00Z', sid: 's1', type: 'proc' };

test('writeEnvelope ghi vao date=/type=/sid.jsonl', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));
  writeEnvelope(env, { max_file_bytes: 1000 }, root);
  const f = path.join(root, 'date=2026-01-02', 'type=proc', 's1.jsonl');
  expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual(env);
  fs.rmSync(root, { recursive: true, force: true });
});
test('partitionFile chuyen part khi day', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));
  writeEnvelope(env, { max_file_bytes: 60 }, root);
  expect(path.basename(partitionFile(root, env, 60, 50))).toBe('s1.1.jsonl');
  fs.rmSync(root, { recursive: true, force: true });
});
test('auditRoot ton trong CLAUDE_AUDIT_DIR', () => {
  const o = process.env.CLAUDE_AUDIT_DIR;
  process.env.CLAUDE_AUDIT_DIR = 'zz';
  expect(auditRoot()).toBe('zz');
  if (o === undefined) delete process.env.CLAUDE_AUDIT_DIR; else process.env.CLAUDE_AUDIT_DIR = o;
});
