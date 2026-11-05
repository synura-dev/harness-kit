import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildEnvelope, readAuditConfig, projectOf, readUsage, writeEnvelope } from './audit.mjs';
import { listFiles } from '../views/query/files.mjs';
import { prune } from '../views/prune.mjs';

const cfg = readAuditConfig();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-v2-'));
const T = new Date('2026-10-25T01:02:03Z');

// payload shapes below were captured from a real `claude -p` run (see README "Da xac minh")
const post = { hook_event_name: 'PostToolUse', session_id: 's', cwd: 'E:\\work\\proj-a', tool_name: 'Bash', tool_input: { command: 'echo ok' }, tool_response: { stdout: 'ok', interrupted: false }, tool_use_id: 'toolu_1', duration_ms: 93 };

test('v2 envelope: flat stable keys', () => {
  const e = buildEnvelope(post, cfg, T);
  expect(Object.keys(e)).toEqual(['v', 'ts', 'type', 'event', 'cli', 'sid', 'agent_id', 'agent_type', 'actor', 'project', 'cwd', 'tool', 'target', 'target_kind', 'ok', 'dur_ms', 'turns', 'tokens_in', 'tokens_out', 'status', 'model', 'summary', 'data', 'origin']);
  expect(e).toMatchObject({ v: 2, cli: 'claude', sid: 'claude-s', actor: 'main', agent_id: null, project: 'proj-a', target: 'echo ok', target_kind: 'command', ok: true, dur_ms: 93, status: 'ok' });
  expect(e.summary).toBe('main Bash ok: echo ok (93ms)');
  expect(e.summary.length).toBeLessThanOrEqual(120);
});
test('ok reflects real failure; interrupted', () => {
  const f = buildEnvelope({ ...post, hook_event_name: 'PostToolUseFailure', error: 'Exit code 2\nls: nope', is_interrupt: false, tool_response: undefined }, cfg, T);
  expect(f).toMatchObject({ ok: false, status: 'error' });
  expect(f.data).toMatchObject({ exit_code: 2 });
  expect(f.data.error).toBe('Exit code 2 ls: nope'); // error text now kept (<=error_max)
  expect(buildEnvelope({ ...post, tool_response: { interrupted: true } }, cfg, T)).toMatchObject({ ok: false, status: 'interrupted' });
  expect(buildEnvelope({ ...post, hook_event_name: 'PreToolUse' }, cfg, T)).toMatchObject({ ok: null, status: 'started' });
});
test('PostToolUseFailure keeps redacted error text <=200 and in summary', () => {
  const err = 'Exit code 2\n' + 'x'.repeat(400);
  const e = buildEnvelope({ ...post, hook_event_name: 'PostToolUseFailure', error: err, tool_response: undefined }, cfg, T);
  expect(e.data.error.length).toBeLessThanOrEqual(200);
  expect(e.data.error.startsWith('Exit code 2 x')).toBe(true);
  expect(e.data.error_len).toBe(err.length);
  expect(e.summary).toContain(' | Exit code 2');
  expect(e.summary.length).toBeLessThanOrEqual(120);
  const off = buildEnvelope({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', error: 'boom' }, { ...cfg, error_max: 0 }, T);
  expect(off.data.error).toBeUndefined();
});

test('target_kind path/url/other, subagent actor, summary capped', () => {
  expect(buildEnvelope({ ...post, tool_name: 'Read', tool_input: { file_path: 'a/b.ts' } }, cfg, T).target_kind).toBe('path');
  expect(buildEnvelope({ ...post, tool_name: 'WebFetch', tool_input: { url: 'https://a.com/x?y=1' } }, cfg, T).target_kind).toBe('url');
  expect(buildEnvelope({ ...post, tool_name: 'Grep', tool_input: { pattern: 'x' } }, cfg, T).target_kind).toBe('other');
  const s = buildEnvelope({ ...post, agent_id: 'a1', agent_type: 'builder', tool_input: { command: 'x'.repeat(500) } }, cfg, T);
  expect(s).toMatchObject({ actor: 'sub', agent_id: 'a1', agent_type: 'builder' });
  expect(s.summary.length).toBeLessThanOrEqual(120);
  expect(s.summary.startsWith('builder Bash')).toBe(true);
});
test('projectOf: basename, worktree, base_path', () => {
  expect(projectOf('C:\\a\\b\\hub\\.claude\\worktrees\\agent-1')).toBe('hub');
  expect(projectOf('/x/y/proj/')).toBe('proj');
  expect(projectOf('/base/p1/sub/dir', { base_path: '/base' })).toBe('p1');
  expect(projectOf('')).toBeNull();
});

function transcript(dir, name, lines) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const asst = (id, inp, out, cc = 0, cr = 0, model = 'm-1') => ({ type: 'assistant', message: { id, model, usage: { input_tokens: inp, output_tokens: out, cache_creation_input_tokens: cc, cache_read_input_tokens: cr } } });

test('Stop: tokens/turns/model from transcript (dedupe message.id)', () => {
  const d = tmp();
  const f = transcript(d, 't.jsonl', [asst('m1', 2, 10, 100, 50), asst('m1', 2, 30, 100, 50), asst('m2', 3, 5, 0, 200), { type: 'user' }]);
  expect(readUsage(f)).toEqual({ turns: 2, tokens_in: 105, tokens_out: 35, tokens_cache: 250, model: 'm-1' });
  const e = buildEnvelope({ hook_event_name: 'Stop', session_id: 's', cwd: '/p/x', transcript_path: f }, cfg, T);
  expect(e).toMatchObject({ turns: 2, tokens_in: 105, tokens_out: 35, status: 'stopped', model: 'm-1' });
  expect(e.data.tokens_cache).toBe(250);
  const sub = buildEnvelope({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'a', agent_type: 'b', agent_transcript_path: f }, cfg, T);
  expect(sub.tokens_out).toBe(35);
});
test('transcript missing / too big / not jsonl -> null, envelope still written', () => {
  const d = tmp();
  const f = transcript(d, 't.jsonl', [asst('m1', 2, 10)]);
  expect(readUsage(path.join(d, 'nope.jsonl'))).toBeNull();
  expect(readUsage(f, 5)).toBeNull();
  expect(readUsage(path.join(d, 'x.txt'))).toBeNull();
  const e = buildEnvelope({ hook_event_name: 'Stop', session_id: 's', transcript_path: path.join(d, 'nope.jsonl') }, cfg, T);
  expect(e.tokens_in).toBeNull();
  expect(e.data.usage).toBe('unavailable');
  expect(e.data.usage_reason).toBe('not_found');
});
test('usage_reason: no_path / too_big / parse_fail', () => {
  const d = tmp();
  const f = transcript(d, 't.jsonl', [asst('m1', 2, 10)]);
  const sub = (p, c = cfg) => buildEnvelope({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'a', agent_type: 'b', agent_transcript_path: p }, c, T).data;
  expect(sub(undefined)).toMatchObject({ usage: 'unavailable', usage_reason: 'no_path' });
  expect(sub(f, { ...cfg, transcript_max_bytes: 5 })).toMatchObject({ usage: { msgs: 1 } }); // qua transcript_max_bytes: van co usage tu doc duoi (usage-tail), khong con 'unavailable'
  expect(sub(path.join(d, 'x.txt'))).toMatchObject({ usage_reason: 'parse_fail' });
  expect(JSON.stringify(sub(path.join(d, 'nope.jsonl')))).not.toContain(d.replace(/\\/g, '\\\\'));
  expect(sub(f).usage_reason).toBeUndefined();
});
test('SubagentStop transcript path fallback from transcript_path/session_id/agent_id', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'sess', 'subagents'), { recursive: true });
  transcript(path.join(d, 'sess', 'subagents'), 'agent-a1.jsonl', [asst('m1', 2, 10)]);
  const e = buildEnvelope({ hook_event_name: 'SubagentStop', session_id: 'sess', agent_id: 'a1', agent_type: 'b', transcript_path: path.join(d, 'sess.jsonl') }, cfg, T);
  expect(e.tokens_out).toBe(10);
});
test('HUB_RUN_KIND -> data.run_kind and origin noise (env passed to hook process)', () => {
  expect(buildEnvelope(post, cfg, T, { env: { HUB_RUN_KIND: 'bench' } })).toMatchObject({ origin: 'noise', data: { run_kind: 'bench' } });
  expect(buildEnvelope(post, cfg, T, { env: {} }).origin).toBe('work');
  const root = tmp();
  spawnSync(process.execPath, [path.join(HERE, 'audit.mjs')], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'se', cwd: '/p/q' }), env: { ...process.env, CLAUDE_AUDIT_DIR: root, HUB_RUN_KIND: 'eval' } });
  const line = JSON.parse(fs.readFileSync(listFiles(root, {})[0].path, 'utf8'));
  expect(line).toMatchObject({ origin: 'noise', data: { run_kind: 'eval' } });
});
test('lookupAgentType finds SubagentStart from the previous UTC day', () => {
  const root = tmp();
  const dir = path.join(root, 'date=2026-10-24', 'type=subagent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-s.jsonl'), JSON.stringify({ event: 'SubagentStart', agent_id: 'p1', agent_type: 'scout' }) + '\n');
  const e = buildEnvelope({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'p1' }, cfg, T, { root });
  expect(e.agent_type).toBe('scout');
  expect(e.data.phantom).toBeUndefined();
});
test('Bash cd variants and env-assignment prefixes', () => {
  const bash = (command) => buildEnvelope({ ...post, tool_input: { command } }, cfg, T).data;
  expect(bash('cd /d "E:\\x y" && dir')).toMatchObject({ cd_prefix: true, cmd_head: 'dir' });
  expect(bash('cd x; make all')).toMatchObject({ cd_prefix: true, cmd_head: 'make' });
  const s = bash('FOO=bar BAZ="q r" node a.js');
  expect(s.cmd_head).toBe('node');
  expect(JSON.stringify(s)).not.toContain('bar');
});
test('Bash cmd_head / cd_prefix / target_truncated (target unchanged)', () => {
  const bash = (command) => buildEnvelope({ ...post, tool_input: { command } }, cfg, T);
  const a = bash('cd "E:/x y" && git status --short');
  expect(a.data).toMatchObject({ cmd_head: 'git', cd_prefix: true, target_truncated: false });
  expect(a.target).toBe('cd "E:/x y" && git status --short');
  const b = bash('node ' + 'a'.repeat(300));
  expect(b.data).toMatchObject({ cmd_head: 'node', cd_prefix: false, target_truncated: true });
  expect(b.target.length).toBeLessThanOrEqual(160);
  expect(bash('curl -H "Authorization: Bearer abcdef123456" x').data.cmd_head).toBe('curl');
  expect(buildEnvelope({ ...post, tool_name: 'Read', tool_input: { file_path: 'a' } }, cfg, T).data.cd_prefix).toBeUndefined();
});
test('origin: noise by cwd regex, work otherwise; configurable', () => {
  const o = (cwd, c = cfg) => buildEnvelope({ ...post, cwd }, c, T).origin;
  expect(o('E:\\work\\proj-a')).toBe('work');
  expect(o('E:\\hub\\.claude\\worktrees\\agent-x')).toBe('work');
  for (const c of ['E:\\x\\bench\\r1', 'C:\\t\\scratchpad', 'D:\\zz-eval-1', '/tmp/mcp-test']) expect(o(c)).toBe('noise');
  expect(o('E:\\work\\proj-a', { ...cfg, noise_cwd: ['proj-a'] })).toBe('noise');
  expect(o('E:\\work\\proj-a', { ...cfg, noise_cwd: ['('] })).toBe('work'); // bad regex fail-open
  expect(o('')).toBe('work');
});
test('removed unused len/data fields', () => {
  const e = buildEnvelope({ ...post, tool_name: 'Edit', tool_input: { file_path: 'a', old_string: 'x', new_string: 'y' } }, cfg, T);
  expect(Object.keys(e.data).filter((k) => /_len$/.test(k))).toEqual([]);
  expect(buildEnvelope({ ...post, tool_input: { command: 'ls', description: 'd', run_in_background: true } }, cfg, T).data.run_in_background).toBeUndefined();
});
test('SubagentStop agent_type from SubagentStart (hook process, same agent_id)', () => {
  const root = tmp();
  const run = (inp) => spawnSync(process.execPath, [path.join(HERE, 'audit.mjs')], { input: JSON.stringify({ session_id: 'sa', cwd: '/p/q', ...inp }), env: { ...process.env, CLAUDE_AUDIT_DIR: root } });
  run({ hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'builder' });
  run({ hook_event_name: 'SubagentStart', agent_id: 'ag2', agent_type: 'scout' });
  run({ hook_event_name: 'SubagentStop', agent_id: 'ag1' });
  run({ hook_event_name: 'SubagentStop', agent_id: 'zzz' });
  const lines = listFiles(root, {}).flatMap((f) => fs.readFileSync(f.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  const stops = lines.filter((l) => l.event === 'SubagentStop');
  expect(stops.find((l) => l.agent_id === 'ag1')).toMatchObject({ agent_type: 'builder', actor: 'sub' });
  expect(stops.find((l) => l.agent_id === 'zzz').agent_type).toBeNull();
  expect(fs.existsSync(path.join(root, '.state'))).toBe(false);
});
test('hook_events registers PermissionDenied (matcher *, timeout 3)', async () => {
  const { hook_events } = await import('./defaults.mjs');
  expect(hook_events.PermissionDenied).toEqual({ matcher: '*', timeout: 3 });
});
test('Pre/Post do not create .state; Post without duration_ms -> dur_ms null; prune.marker still works', () => {
  const root = tmp();
  const run = (o) => spawnSync(process.execPath, [path.join(HERE, 'audit.mjs')], { input: JSON.stringify(o), env: { ...process.env, CLAUDE_AUDIT_DIR: root }, timeout: 20000 });
  const base = { session_id: 'sd', cwd: '/p/q', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_x' };
  expect(run({ ...base, hook_event_name: 'PreToolUse' }).status).toBe(0);
  expect(run({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: '' } }).status).toBe(0);
  expect(fs.existsSync(path.join(root, '.state'))).toBe(false);
  const f = listFiles(root, {}).map((x) => x.path).filter((p) => p.includes('type=tool'));
  const rows = f.flatMap((p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  expect(rows.find((r) => r.event === 'PostToolUse').dur_ms).toBeNull();
  const now = new Date('2026-10-25T12:00:00Z');
  prune({ root, days: 5, now, yes: true, onceDay: true });
  expect(fs.readFileSync(path.join(root, '.state', 'prune.marker'), 'utf8').trim()).toBe('2026-10-25');
  expect(prune({ root, days: 5, now, yes: true, onceDay: true }).skipped).toBeTruthy();
});
