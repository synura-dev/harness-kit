import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toEvidence, editTs, listAuditFiles, list, summary } from './evidence.mjs';
import { parseArgs } from './cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let root;
let n = 0;
const bash = (ts, target, extra = {}, data = {}) => ({ v: 2, ts, type: 'tool', event: 'PostToolUse', sid: 'claude-s1', tool: 'Bash', target, ok: true, status: 'ok',
  ...extra, data: { tool_use_id: `tu${++n}`, task_id: 'T1', target_truncated: false, bg: false, ...data } });
const edit = (ts, task = 'T1') => ({ v: 2, ts, type: 'tool', event: 'PostToolUse', sid: 'claude-s1', tool: 'Edit', ok: true, data: { files_touched: ['a.mjs'], task_id: task } });
const write = (date, sid, recs) => {
  const d = path.join(root, `date=${date}`, 'type=tool');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
  write('2026-10-27', 'claude-old', [bash('2026-10-27T01:00:00Z', 'bun test', {}, { verifier_outcome: 'pass' })]);
  write('2026-10-28', 'claude-s1', [
    bash('2026-10-28T01:00:00Z', 'bun test a', {}, { verifier_outcome: 'pass' }),
    edit('2026-10-28T02:00:00Z'),
    bash('2026-10-28T03:00:00Z', 'bun test a', { event: 'PostToolUseFailure', ok: false, status: 'error' }, { verifier_outcome: 'fail', exit_code: 1 }),
  ]);
  write('2026-10-29', 'claude-s1', [
    bash('2026-10-29T01:00:00Z', 'tsc --noEmit', {}, { verifier_outcome: 'pass' }),
    bash('2026-10-29T02:00:00Z', 'git rev-parse HEAD', {}, { verifier_outcome: 'none' }),
    bash('2026-10-29T03:00:00Z', 'curl -fsS http://localhost:3000/health', { event: 'PostToolUseFailure', ok: false, status: 'error' }, { verifier_outcome: 'none', exit_code: 7 }),
    bash('2026-10-29T04:00:00Z', 'bun test a | tail -5', {}, { verifier_outcome: 'none' }),
    bash('2026-10-29T05:00:00Z', 'ls -la', {}, { verifier_outcome: 'none' }),
    bash('2026-10-29T06:00:00Z', 'cd "E:/x" && timeout 120 npx bi', {}, { verifier_outcome: 'none', target_truncated: true }),
    bash('2026-10-29T07:00:00Z', 'bun test a', {}, { verifier_outcome: 'pass', task_id: 'T2' }),
    { ...bash('2026-10-29T08:00:00Z', 'bun test a'), event: 'PreToolUse' },
    'not json',
  ]);
  fs.appendFileSync(path.join(root, 'date=2026-10-29', 'type=tool', 'claude-s1.jsonl'), '{broken\n');
});
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

test('toEvidence: schema dung, khong co lenh tho', () => {
  const e = toEvidence(bash('2026-10-29T01:00:00Z', 'tsc --noEmit', {}, { verifier_outcome: 'pass' }));
  expect(Object.keys(e).sort()).toEqual(['event_id', 'exit_code', 'kind', 'outcome', 'session_id', 'source', 'task_id', 'tool', 'ts'].sort());
  expect(e).toMatchObject({ kind: 'tsc', outcome: 'pass', source: 'audit', task_id: 'T1', session_id: 'claude-s1', exit_code: null });
  expect(JSON.stringify(e)).not.toContain('noEmit');
  expect(toEvidence({ ...bash('t', 'bun test'), event: 'PreToolUse' })).toBeNull();
  expect(toEvidence({ ...bash('t', 'x'), tool: 'Edit' })).toBeNull();
});

test('toEvidence: outcome chi tu exit code/su kien, hash/health tu tinh, lenh cat cut -> none', () => {
  expect(toEvidence(bash('t', 'git rev-parse HEAD', {}, { verifier_outcome: 'none' }))).toMatchObject({ kind: 'hash', outcome: 'pass' });
  expect(toEvidence(bash('t', 'curl -fsS http://h/health', { event: 'PostToolUseFailure', ok: false }, { exit_code: 7 }))).toMatchObject({ kind: 'health', outcome: 'fail', exit_code: 7 });
  expect(toEvidence(bash('t', 'curl -fsS http://h/health', { status: 'interrupted', ok: false }))).toMatchObject({ outcome: 'none' });
  expect(toEvidence(bash('t', 'git rev-parse HEAD', {}, { bg: true }))).toMatchObject({ outcome: 'none' });
  expect(toEvidence(bash('t', 'bun test | tail', {}, { verifier_outcome: 'none' }))).toMatchObject({ kind: null, outcome: 'none' });
  expect(toEvidence(bash('t', 'git rev-parse HEAD', {}, { target_truncated: true }))).toMatchObject({ kind: 'hash', outcome: 'none' });
  expect(toEvidence(bash('t', 'git rev-parse HEAD\nls'))).toMatchObject({ kind: 'hash', outcome: 'none' });
  // audit da xet lenh day du -> tin verifier_outcome du target bi cat
  expect(toEvidence(bash('t', 'bun test harness/co', {}, { verifier_outcome: 'pass', target_truncated: true }))).toMatchObject({ kind: 'test', outcome: 'pass' });
});

test('editTs: chi Edit/Write thanh cong co files_touched', () => {
  expect(editTs(edit('2026-10-28T02:00:00Z'))).toBe('2026-10-28T02:00:00Z');
  expect(editTs({ ...edit('t'), ok: false })).toBeNull();
  expect(editTs({ ...edit('t'), data: {} })).toBeNull();
  expect(editTs(bash('t', 'ls'))).toBeNull();
});

test('listAuditFiles: mac dinh 2 ngay moi nhat, --since, --session', () => {
  expect(listAuditFiles(root).map((f) => f.date)).toEqual(['2026-10-29', '2026-10-28']);
  expect(listAuditFiles(root, { since: '2026-10-27' }).length).toBe(3);
  expect(listAuditFiles(root, { since: '2026-10-27', session: 'old' }).map((f) => f.date)).toEqual(['2026-10-27']);
  expect(listAuditFiles(path.join(root, 'nope'))).toEqual([]);
});

test('list: moi nhat truoc, bo lenh khong phai bang chung, limit + truncated', () => {
  const r = list({ root });
  expect(r.items.map((e) => e.kind)).toEqual(['test', 'health', 'hash', 'tsc', 'test', 'test']);
  expect(r.truncated).toBeNull();
  const a = list({ root, all: true });
  expect(a.total).toBe(9);
  const l = list({ root, limit: 2 });
  expect(l.items.length).toBe(2);
  expect(l.truncated).toBe('limit');
  expect(list({ root, task: 'T2' }).items.map((e) => e.ts)).toEqual(['2026-10-29T07:00:00Z']);
  expect(list({ root, since: '2026-10-29T02:30:00Z' }).items.length).toBe(2);
  const raw = list({ root, raw: true, limit: 1 }).raw;
  expect(raw.length).toBe(1);
  expect(raw[0].verifier_outcome).toBe('pass');
});

test('summary --task: dem theo kind, pass sau lan sua cuoi', () => {
  const s = summary({ root, task: 'T1' });
  expect(s.last_edit_ts).toBe('2026-10-28T02:00:00Z');
  expect(s.kinds.test).toMatchObject({ pass: 1, fail: 1, last_outcome: 'fail', fresh_pass: false });
  expect(s.kinds.tsc).toMatchObject({ pass: 1, fresh_pass: true });
  expect(s.kinds.hash).toMatchObject({ pass: 1, fresh_pass: true });
  expect(s.kinds.health).toMatchObject({ fail: 1, fresh_pass: false });
  const t2 = summary({ root, task: 'T2' });
  expect(t2.last_edit_ts).toBeNull();
  expect(t2.kinds.test).toMatchObject({ pass: 1, fresh_pass: true });
});

test('gioi han: read-max-bytes nho -> truncated max_bytes, timeout nho van dung em', () => {
  expect(summary({ root, readMaxBytes: 50 }).truncated).toBe('max_bytes');
  const t = list({ root, timeoutMs: 1 });
  expect(Array.isArray(t.items)).toBe(true);
});

test('parseArgs + CLI that tren fixture (CLAUDE_AUDIT_DIR)', () => {
  expect(parseArgs(['summary', '--task', 'T1', '--limit=5', '--json'])).toMatchObject({ cmd: 'summary', task: 'T1', limit: 5, json: true });
  expect(() => parseArgs(['list', '--bogus'])).toThrow();
  const run = (args) => spawnSync(process.execPath, [path.join(HERE, 'cli.mjs'), ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, CLAUDE_AUDIT_DIR: root } });
  const s = run(['summary', '--task', 'T1']);
  expect(s.status).toBe(0);
  expect(s.stdout).toContain('test   pass=1 fail=1');
  const j = JSON.parse(run(['list', '--json', '--limit', '3']).stdout);
  expect(j.items.length).toBe(3);
  expect(run(['bad']).status).toBe(2);
});

test('uu tien verify_kind tu audit (lenh day du) khi target bi cat; ban ghi cu van tu tinh', () => {
  const cutT = 'cd "E:/very/long/path/that/was/cut/by/audit/at/160/characters/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" && b';
  expect(toEvidence(bash('t', cutT, {}, { target_truncated: true, verify_kind: 'test', verifier_outcome: 'pass' }))).toMatchObject({ kind: 'test', outcome: 'pass' });
  // audit noi null (lenh day du khong phai verify) -> tin audit, khong tu suy tu target
  expect(toEvidence(bash('t', 'bun test', {}, { verify_kind: null, verifier_outcome: 'none' }))).toMatchObject({ kind: null, outcome: 'none' });
  // gia tri la -> bo qua, tu tinh nhu ban ghi cu
  expect(toEvidence(bash('t', 'bun test', {}, { verify_kind: 'weird', verifier_outcome: 'none' }))).toMatchObject({ kind: 'test', outcome: 'pass' });
  expect(toEvidence(bash('t', 'git rev-parse HEAD', {}, {}))).toMatchObject({ kind: 'hash', outcome: 'pass' });
});
