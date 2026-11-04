import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPathFor } from '../../core/io/storage.mjs';
import { buildEnvelope, writeEnvelope, readAuditConfig } from './audit.mjs';

const cfg = readAuditConfig();
const base = { session_id: 's1', cwd: 'E:\\hub', tool_name: 'Bash' };
const fail = (cmd, err, extra = {}) => ({ ...base, hook_event_name: 'PostToolUseFailure', tool_input: { command: cmd }, error: err, ...extra });

test('task_id tu env, null neu khong', () => {
  expect(buildEnvelope({ ...base, hook_event_name: 'PreToolUse' }, cfg, new Date(), { env: { HUB_TASK_ID: 'T14' } }).data.task_id).toBe('T14');
  expect(buildEnvelope({ ...base, hook_event_name: 'PreToolUse' }, cfg, new Date(), { env: {} }).data.task_id).toBeNull();
});

test('error_fp on dinh giua hai loi chi khac duong dan/so dong; khong lo secret/lenh tho', () => {
  const e1 = buildEnvelope(fail('bun test x', 'Exit code 1\nerror at C:\\a\\b.ts:10:2 token=SECRETVALUE123'), cfg, new Date(), { env: {} });
  const e2 = buildEnvelope(fail('bun test y', 'Exit code 1\nerror at D:\\zzz\\b.ts:99:7 token=OTHERSECRET999'), cfg, new Date(), { env: {} });
  expect(e1.data.error_fp).toMatch(/^[0-9a-f]{10}$/);
  expect(e1.data.error_fp).toBe(e2.data.error_fp);
  const s = JSON.stringify(e1);
  expect(s).not.toContain('SECRETVALUE123');
  expect(s).not.toContain('bun test x'.repeat(2));
  expect(e1.data.verifier_outcome).toBe('fail');
});

test('khong co error_fp khi tool thanh cong; verifier pass chi cho lenh verify', () => {
  const ok = { ...base, hook_event_name: 'PostToolUse', tool_input: { command: 'bun test' }, tool_response: {} };
  const e = buildEnvelope(ok, cfg, new Date(), { env: {} });
  expect(e.data.error_fp).toBeUndefined();
  expect(e.data.verifier_outcome).toBe('pass');
  const n = buildEnvelope({ ...ok, tool_input: { command: 'ls -la' } }, cfg, new Date(), { env: {} });
  expect(n.data.verifier_outcome).toBe('none');
  const f = buildEnvelope(fail('git status', 'Exit code 128\nfatal'), cfg, new Date(), { env: {} });
  expect(f.data.verifier_outcome).toBe('none');
  const p = buildEnvelope(fail('bun test | tail', 'Exit code 1\nx'), cfg, new Date(), { env: {} });
  expect(p.data.verifier_outcome).toBe('none');
});

test('files_touched tuong doi cwd, tran N, chi voi tool sua file', () => {
  const inp = { session_id: 's1', cwd: 'E:\\hub', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'E:\\hub\\harness\\a.mjs', old_string: 'secret=abc', new_string: 'x' }, tool_response: {} };
  const e = buildEnvelope(inp, cfg, new Date(), { env: {} });
  expect(e.data.files_touched).toEqual(['harness/a.mjs']);
  expect(JSON.stringify(e)).not.toContain('secret=abc');
  expect(buildEnvelope({ ...inp, tool_name: 'Read' }, cfg, new Date(), { env: {} }).data.files_touched).toBeUndefined();
});

test('retry_of/attempt dem lap cung fingerprint trong phien', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-'));
  try {
    const now = new Date();
    const run = () => { const e = buildEnvelope(fail('bun test', 'Exit code 1\nboom at /a/b.ts:3'), cfg, now, { root, env: {} }); writeEnvelope(e, cfg, root); return e; };
    const a = run(), b = run(), c = run();
    expect(a.data.attempt).toBe(1); expect(a.data.retry_of).toBeUndefined();
    expect(b.data.attempt).toBe(2); expect(b.data.retry_of).toBe(1);
    expect(c.data.attempt).toBe(3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('du lieu cu va su kien khong phai Post van build duoc', () => {
  const e = buildEnvelope({ hook_event_name: 'SessionStart', session_id: 's' }, cfg, new Date(), { env: {} });
  expect(e.data.task_id).toBeNull();
  expect(e.data.verifier_outcome).toBeUndefined();
});

test('hook CLI that: PostToolUseFailure verify (co/khong "Exit code N") -> fail; khong verify/interrupted -> none; khong lo secret', async () => {
  const { spawnSync } = await import('node:child_process');
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-clif-'));
  const entry = path.join(import.meta.dir, 'audit.mjs');
  const cases = [
    ['a', 'bun test', 'Exit code 1\nfail TOKEN=zzsecret99', {}, 'fail'],
    ['b', 'node harness/cli/commands/doctor.mjs', 'Exit code 2\nx', {}, 'fail'],
    ['c', 'tsc --noEmit', 'Exit code 2\nerror TS1', {}, 'fail'],
    // Du lieu that: error bi cat 200 ky tu, khong co "Exit code N"; PostToolUseFailure + verify + khong interrupted => fail.
    ['d', 'bun test', 'tests failed', {}, 'fail'],
    ['g', 'git status', 'tests failed (khong co Exit code)', {}, 'none'],
    ['h', 'bun test', 'tests failed', { is_interrupt: true }, 'none'],
    ['e', 'git status', 'Exit code 128\nfatal', {}, 'none'],
    ['f', 'bun test', 'Exit code 1\nx', { is_interrupt: true }, 'none'],
  ];
  try {
    for (const [sid, cmd, error, extra] of cases) {
      const inp = { hook_event_name: 'PostToolUseFailure', session_id: sid, cwd: 'E:/x', tool_name: 'Bash', tool_input: { command: cmd }, error, ...extra };
      const r = spawnSync(process.execPath, [entry], { input: JSON.stringify(inp), env: { ...process.env, HUB_DIR: hub, HUB_DATA_DIR: '', CLAUDE_AUDIT_DIR: '' }, timeout: 15000 });
      expect(r.status).toBe(0);
    }
    const rows = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else rows.push(...fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))); } };
    walk(dataPathFor('audit', { env: { HUB_DIR: hub, HUB_DATA_DIR: '' }, quiet: true }));
    for (const [sid, , , , want] of cases) expect(rows.find((r) => r.sid === 'claude-' + sid).data.verifier_outcome).toBe(want);
    expect(JSON.stringify(rows)).not.toContain('zzsecret99');
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

test('hook CLI that: stdin PostToolUse bun test -> pass; exit code khac 0 -> fail; lenh thuong -> none; khong lo secret; rac -> rc 0', async () => {
  const { spawnSync } = await import('node:child_process');
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-cli-'));
  const entry = path.join(import.meta.dir, 'audit.mjs');
  const run = (obj, input) => spawnSync(process.execPath, [entry], { input: input ?? JSON.stringify(obj), env: { ...process.env, HUB_DIR: hub, HUB_DATA_DIR: '', CLAUDE_AUDIT_DIR: '' }, timeout: 15000 });
  const post = (cmd, tr, sid) => ({ hook_event_name: 'PostToolUse', session_id: sid, cwd: 'E:/x', tool_name: 'Bash', tool_input: { command: cmd }, tool_response: tr, tool_use_id: 'tu1' });
  try {
    expect(run(post('bun test', { stdout: 'ok', stderr: '', interrupted: false }, 'p')).status).toBe(0);
    expect(run(post('bun test', { stdout: '', exit_code: 1 }, 'f')).status).toBe(0);
    expect(run(post('echo TOKEN=abc123secret', { stdout: 'x' }, 'n')).status).toBe(0);
    expect(run(null, '{not json').status).toBe(0);
    const rows = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else rows.push(...fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))); } };
    walk(dataPathFor('audit', { env: { HUB_DIR: hub, HUB_DATA_DIR: '' }, quiet: true }));
    const by = (s) => rows.find((r) => r.sid === 'claude-' + s);
    expect(by('p').data.verifier_outcome).toBe('pass');
    expect(by('f').data.verifier_outcome).toBe('fail');
    expect(by('n').data.verifier_outcome).toBe('none');
    expect(JSON.stringify(by('n'))).not.toContain('abc123secret');
    expect(rows.length).toBe(3);
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

test('verify_kind + verifier_outcome tinh tren lenh day du, du target bi cat', () => {
  const long = 'cd "E:/' + 'a'.repeat(300) + '/project" && bun test';
  const e = buildEnvelope({ ...base, hook_event_name: 'PostToolUse', tool_input: { command: long }, tool_response: {} }, cfg, new Date(), { env: {} });
  expect(e.data.target_truncated).toBe(true);
  expect(e.data.verify_kind).toBe('test');
  expect(e.data.verifier_outcome).toBe('pass');
  const h = buildEnvelope({ ...base, hook_event_name: 'PostToolUseFailure', tool_input: { command: 'curl -fsS http://localhost:3000/health' }, error: 'Exit code 22' }, cfg, new Date(), { env: {} });
  expect(h.data).toMatchObject({ verify_kind: 'health', verifier_outcome: 'fail' });
  const n = buildEnvelope({ ...base, hook_event_name: 'PostToolUse', tool_input: { command: 'ls -la' }, tool_response: {} }, cfg, new Date(), { env: {} });
  expect(n.data.verify_kind).toBeNull();
  expect(buildEnvelope({ ...base, hook_event_name: 'PreToolUse', tool_input: { command: 'bun test' } }, cfg, new Date(), { env: {} }).data.verify_kind).toBeUndefined();
});

test('su kien duyet co cau truc tu payload PermissionDenied/PermissionRequest; khong lo secret', () => {
  const d = buildEnvelope({ ...base, hook_event_name: 'PermissionDenied', tool_input: { command: 'git push' }, reason: 'denied token=zzSECRET42' }, cfg, new Date(), { env: {} });
  expect(d.data.gate).toMatchObject({ kind: 'approval', decision: 'deny', hook: 'audit', tool: 'Bash' });
  expect(JSON.stringify(d)).not.toContain('zzSECRET42');
  expect(buildEnvelope({ ...base, hook_event_name: 'PermissionRequest', tool_input: { command: 'x' } }, cfg, new Date(), { env: {} }).data.gate.decision).toBe('ask');
  expect(buildEnvelope({ ...base, hook_event_name: 'PostToolUse', tool_input: { command: 'x' }, tool_response: {} }, cfg, new Date(), { env: {} }).data.gate).toBeUndefined();
});
