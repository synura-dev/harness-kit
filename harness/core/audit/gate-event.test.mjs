import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateRecord, gateEnvelope, gateFromPayload, recordGate, normDecision, maskSecrets, GATE_TYPE } from './gate-event.mjs';

test('normDecision: alias va gia tri sai', () => {
  expect(normDecision('Approve')).toBe('allow');
  expect(normDecision('block')).toBe('block');
  expect(normDecision('maybe')).toBeNull();
});

test('gateRecord: kind/decision sai -> null; id an toan, reason che secret + cat', () => {
  expect(gateRecord({ kind: 'x', decision: 'ask' })).toBeNull();
  expect(gateRecord({ kind: 'gate', decision: 'nope' })).toBeNull();
  const g = gateRecord({ kind: 'gate', decision: 'block', hook: 'verify-gate', rule: 'no evidence/../x', reason: 'need test; token=abcSECRET1 ' + 'z'.repeat(400), verify_kind: 'test', attempt: 1 });
  expect(g).toMatchObject({ kind: 'gate', decision: 'block', hook: 'verify-gate', rule: 'noevidence..x', verify_kind: 'test', attempt: 1 });
  expect(g.reason.length).toBeLessThanOrEqual(200);
  expect(JSON.stringify(g)).not.toContain('abcSECRET1');
});

test('maskSecrets: key=value, bearer, token dang ghp_/sk-, url co mat khau', () => {
  const s = maskSecrets('password=hunter2 Authorization: Bearer abc.def ghp_ABCDEFGHIJKLMNOP mongodb://u:p4ss@host/db');
  for (const bad of ['hunter2', 'abc.def', 'ghp_ABCDEFGHIJKLMNOP', 'p4ss']) expect(s).not.toContain(bad);
});

test('maskSecrets: dang cach khoang trang --password/--token/--api-key, mysql/psql -p<X>, Authorization: <scheme> X', () => {
  const cases = [
    ['deploy --password hunter2 --user bob', 'hunter2'],
    ['cli --token "tok en9"', 'tok en9'],
    ['cli --api-key abcd1234 --x', 'abcd1234'],
    ['tool -token s3cr3tval', 's3cr3tval'],
    ['mysql -u root -pS3cret! db', 'S3cret!'],
    ['mysqldump.exe -h h -p"q w" x', 'q w'],
    ['psql -U u -pPgPass9 -d x', 'PgPass9'],
    ["curl -H 'Authorization: Token zzz999' url", 'zzz999'],
    ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
  ];
  for (const [inp, bad] of cases) { const s = maskSecrets(inp); expect(s).not.toContain(bad); expect(s).toContain('***'); }
  expect(maskSecrets('deploy --password hunter2 --user bob')).toBe('deploy --password *** --user bob');
  expect(maskSecrets('mysql -u root -pS3cret! db')).toBe('mysql -u root -p*** db');
  // khong che nham: -P (cong), -p khong dinh gia tri, co khong lien quan, -p ngoai lenh db
  expect(maskSecrets('mysql -u root -P3306 -p db')).toBe('mysql -u root -P3306 -p db');
  expect(maskSecrets('mkdir -p build && ls --passive x')).toBe('mkdir -p build && ls --passive x');
  expect(maskSecrets('echo x | grep -pattern y')).toBe('echo x | grep -pattern y');
});

test('gateFromPayload: PermissionDenied/Request, decision tuong minh, khong co -> null', () => {
  expect(gateFromPayload({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', reason: 'no' })).toMatchObject({ kind: 'approval', decision: 'deny', tool: 'Bash' });
  expect(gateFromPayload({ hook_event_name: 'PermissionRequest' }).decision).toBe('ask');
  expect(gateFromPayload({ hook_event_name: 'PreToolUse', hookSpecificOutput: { permissionDecision: 'allow' } }).decision).toBe('allow');
  expect(gateFromPayload({ hook_event_name: 'PostToolUse' })).toBeNull();
  expect(gateFromPayload(null)).toBeNull();
});

test('gateEnvelope: khung v2, type=gate, event Gate/Approval, sid co tien to cli', () => {
  const now = new Date('2026-10-29T01:02:03Z');
  const e = gateEnvelope({ kind: 'approval', decision: 'ask', hook: 'approval', rule: 'git-push', tool: 'Bash' }, { session_id: 'abc/../x', cwd: 'E:/hub', agent_type: 'builder' }, { now, env: {} });
  expect(e).toMatchObject({ v: 2, type: GATE_TYPE, event: 'Approval', sid: 'claude-abcx', actor: 'sub', status: 'ask', tool: 'Bash', ts: now.toISOString() });
  expect(e.data.gate.rule).toBe('git-push');
  expect(gateEnvelope({ kind: 'bad', decision: 'ask' })).toBeNull();
});

test('recordGate: ghi vao date=/type=gate, fail-open khi root hong', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  try {
    const now = new Date('2026-10-29T05:00:00Z');
    expect(recordGate({ kind: 'gate', decision: 'block', hook: 'verify-gate' }, { session_id: 's1' }, { root, now, env: {} })).toBe(true);
    const f = path.join(root, 'date=2026-10-29', 'type=gate', 'claude-s1.jsonl');
    const rec = JSON.parse(fs.readFileSync(f, 'utf8').trim());
    expect(rec.event).toBe('Gate');
    expect(recordGate({ kind: 'nope', decision: 'block' }, {}, { root })).toBe(false);
    const fileAsRoot = path.join(root, 'date=2026-10-29', 'type=gate', 'claude-s1.jsonl');
    expect(recordGate({ kind: 'gate', decision: 'warn' }, { session_id: 's2' }, { root: fileAsRoot, now })).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
