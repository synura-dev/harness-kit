// Tich hop: audit envelope mang signal/prompt/version; gate verify_fail; dispatch do tre module.
import { test, expect } from 'bun:test';
import { buildEnvelope, readAuditConfig } from './audit.mjs';
import { gateEnvelope } from '../../core/audit/gate-event.mjs';
import { dispatch, CLAUDE, latencyRecord } from '../../hooks/dispatch/run.mjs';

const cfg = readAuditConfig();
const b = (inp) => buildEnvelope({ session_id: 's1', cwd: process.cwd(), ...inp }, cfg, new Date('2026-11-05T00:00:00Z'), {});

test('UserPromptSubmit: hash + tu khoa, khong nguyen van, signal=correction', () => {
  const e = b({ hook_event_name: 'UserPromptSubmit', prompt: 'Không phải, làm lại phần login giúp mình' });
  expect(e.data.prompt_hash).toMatch(/^[0-9a-f]{12}$/);
  expect(e.data.prompt_kw).toContain('login');
  expect(e.data.signal).toBe('correction');
  expect(JSON.stringify(e)).not.toContain('làm lại phần login');
  expect(b({ hook_event_name: 'UserPromptSubmit', prompt: 'tiep tuc nhe' }).data.signal).toBeUndefined();
});

test('SessionStart: data.version co harness_kit + rules_hash', () => {
  const e = b({ hook_event_name: 'SessionStart', source: 'startup' });
  expect(e.data.version.harness_kit).toMatch(/^\d/);
  expect(e.sid).toBe('claude-s1');
});

test('Bash PostToolUse: git reset --hard -> revert; harness tasks set --status -> task_status', () => {
  const post = (command) => b({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} });
  expect(post('git reset --hard HEAD~1').data.signal).toBe('revert');
  expect(post('harness tasks set T1 --status done').data.signal).toBe('task_status');
  expect(post('ls').data.signal).toBeUndefined();
});

test('interrupt: tool_response.interrupted / is_interrupt -> signal=interrupt; Stop khong co', () => {
  expect(b({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'sleep 9' }, tool_response: { interrupted: true } }).data.signal).toBe('interrupt');
  expect(b({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, is_interrupt: true }).data.signal).toBe('interrupt');
  expect(b({ hook_event_name: 'Stop', stop_hook_active: false }).data.signal).toBeUndefined();
});

test('gate verify_fail gan vao data.signal', () => {
  const e = gateEnvelope({ kind: 'gate', decision: 'block', hook: 'verify-gate', rule: 'no_evidence', signal: 'verify_fail' }, { session_id: 's1' });
  expect(e.data.signal).toBe('verify_fail');
  expect(gateEnvelope({ kind: 'gate', decision: 'allow', hook: 'verify-gate' }, { session_id: 's1' }).data.signal).toBeUndefined();
});

test('dispatch: do tre tung module + latencyRecord theo chinh sach', async () => {
  const mod = (id, over = {}) => ({ id, events: ['Stop', 'PreToolUse'], timeoutMs: 100, onError: 'open', handle: async () => ({}), ...over });
  const entry = (m) => ({ id: m.id, gate: false, load: async () => ({ default: m }) });
  const p = { ...CLAUDE, order: { Stop: [entry(mod('a')), entry(mod('b', { handle: async () => { throw new Error('x'); } }))], PreToolUse: [entry(mod('a'))] } };
  const cfg2 = { maxInputBytes: 1e6, budgetsMs: { Stop: 1500, PreToolUse: 1500 } };
  const stdin = (ev) => JSON.stringify({ hook_event_name: ev, session_id: 's1' });
  const r = await dispatch({ event: 'Stop', stdin: stdin('Stop'), cfg: cfg2, profile: p });
  expect(r.timings.map((t) => t.id)).toEqual(['a', 'b']);
  expect(r.timings[1].err).toMatch(/^error:/);
  const rec = latencyRecord('Stop', r.input, r.timings, r.totalMs);
  expect(rec.sink).toBe('audit'); expect(rec.data.type).toBe('hook'); expect(rec.data.ok).toBeNull(); expect(rec.data.data.failed).toBe(true);
  const r2 = await dispatch({ event: 'PreToolUse', stdin: stdin('PreToolUse'), cfg: cfg2, profile: p });
  expect(latencyRecord('PreToolUse', r2.input, r2.timings, 5)).toBeNull(); // nhanh + khong loi -> bo qua
  expect(latencyRecord('PreToolUse', r2.input, [{ id: 'a', ms: 500 }], 500)).not.toBeNull(); // cham -> ghi
});
