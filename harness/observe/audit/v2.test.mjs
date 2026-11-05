import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildEnvelope, readAuditConfig, projectOf, readUsage, writeEnvelope } from './audit.mjs';
import { runReport, listFiles, formatMd, formatJsonl, toRow } from '../views/query/query.mjs';
import { writeDigest, aggregate } from '../views/digest.mjs';
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

test('digest drops legacy phantom aggregates unless includePhantom', () => {
  const rows = [
    { session_id: 's', event: 'SubagentStop', agent_id: 'a1', agent_type: null, ts: '2026-10-25T00:00:00Z', ok: null },
    { session_id: 's', event: 'SubagentStop', agent_id: 'a2', agent_type: 'builder', ts: '2026-10-25T00:00:00Z', ok: null },
  ];
  expect(aggregate(rows).map((a) => a.agent_id)).toEqual(['a2']);
  expect(aggregate(rows, { includePhantom: true }).length).toBe(2);
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
test('phantom SubagentStop (no agent_type/Start): labeled, transcript not read; query excludes unless --include-phantom', async () => {
  const d = tmp();
  const f = transcript(d, 't.jsonl', [asst('m1', 2, 10)]);
  const real = buildEnvelope({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'x', agent_transcript_path: f }, cfg, T);
  expect(real.data.phantom).toBeUndefined(); // no agent_type but readable transcript -> real subagent
  expect(real.tokens_out).toBe(10);
  const ph = buildEnvelope({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'x', agent_transcript_path: path.join(d, 'nope.jsonl') }, cfg, T);
  expect(ph.data).toMatchObject({ phantom: true, usage: 'unavailable', usage_reason: 'no_transcript' });
  expect(ph.tokens_out).toBeNull();
  const root = tmp();
  writeEnvelope(ph, cfg, root);
  writeEnvelope(buildEnvelope({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'y', agent_type: 'b', agent_transcript_path: f }, cfg, T), cfg, root);
  const { nodeRows } = await import('../views/query/query.mjs');
  const n = async (f2) => (await nodeRows(listFiles(root, {}), f2, { deadline: Date.now() + 5000, maxBytes: 1e8, maxRows: 1e5, truncated: null })).length;
  expect(await n({})).toBe(1);
  expect(await n({ includePhantom: true })).toBe(2);
  expect(runReport).toBeTypeOf('function');
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
test('origin boundaries: workbench/benchmark-app are work; bench/ noise; old line without origin computed from cwd', () => {
  const o = (cwd) => buildEnvelope({ ...post, cwd }, cfg, T).origin;
  expect(o('E:/x/workbench')).toBe('work');
  expect(o('E:/x/benchmark-app')).toBe('work');
  expect(o('E:/x/bench/a')).toBe('noise');
  expect(toRow({ event: 'PreToolUse', cwd: 'E:\\x\\zz-eval-3' }, 'tool', '2026-10-24').origin).toBe('noise');
  expect(toRow({ event: 'PreToolUse', cwd: 'E:\\x\\real' }, 'tool', '2026-10-24').origin).toBe('work');
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
test('query --origin filters (old lines without origin = work)', async () => {
  const root = tmp();
  writeEnvelope(buildEnvelope({ ...post, cwd: '/x/bench/a' }, cfg, T), cfg, root);
  writeEnvelope(buildEnvelope({ ...post, cwd: '/x/real' }, cfg, T), cfg, root);
  const old = buildEnvelope({ ...post, cwd: '/x/old' }, cfg, T); delete old.origin;
  writeEnvelope({ ...old, sid: 'claude-old' }, cfg, root);
  const { nodeRows } = await import('../views/query/query.mjs');
  const count = async (origin) => (await nodeRows(listFiles(root, {}), origin ? { origin } : {}, { deadline: Date.now() + 5000, maxBytes: 1e8, maxRows: 1e5, truncated: null })).length;
  const all = await count(), work = await count('work'), noise = await count('noise');
  expect(all).toBe(3); expect(work).toBe(2); expect(noise).toBe(1);
});
test('hook process: Stop writes v2 line under date=/type=, exits 0 silently', () => {
  const root = tmp();
  const f = transcript(tmp(), 't.jsonl', [asst('m1', 1, 2)]);
  const r = spawnSync(process.execPath, [path.join(HERE, 'audit.mjs')], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sx', cwd: '/p/q', transcript_path: f }), env: { ...process.env, CLAUDE_AUDIT_DIR: root } });
  expect(r.status).toBe(0);
  expect(r.stdout.length + r.stderr.length).toBe(0);
  const files = listFiles(root, {});
  expect(files.length).toBe(1);
  expect(files[0].path.replace(/\\/g, '/')).toMatch(/date=\d{4}-\d{2}-\d{2}\/type=session\/claude-sx\.jsonl$/);
  const line = JSON.parse(fs.readFileSync(files[0].path, 'utf8'));
  expect(line).toMatchObject({ v: 2, event: 'Stop', tokens_in: 1, tokens_out: 2, turns: 1, project: 'q' });
});

// ---- query / digest / prune over mixed v1 + v2 data ----
function mixedRoot() {
  const root = tmp();
  const put = (rel, objs) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, objs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n'); };
  const e = (o) => buildEnvelope({ ...post, session_id: 'claude-s1', ...o }, cfg, new Date(o.__ts || '2026-10-25T10:00:00Z'));
  put('date=2026-10-25/type=tool/claude-s1.jsonl', [
    e({ hook_event_name: 'PostToolUse', __ts: '2026-10-25T10:00:00Z' }),
    e({ hook_event_name: 'PostToolUseFailure', error: 'Exit code 1', __ts: '2026-10-25T10:00:30Z' }),
    'not json',
    e({ agent_id: 'a1', agent_type: 'builder', tool_name: 'Edit', tool_input: { file_path: 'f.ts' }, __ts: '2026-10-25T10:01:00Z' }),
  ]);
  put('date=2026-10-25/type=session/claude-s1.jsonl', [
    { v: 2, ts: '2026-10-25T10:05:00Z', type: 'session', event: 'Stop', sid: 'claude-s1', agent_id: null, agent_type: null, actor: 'main', project: 'proj-a', tokens_in: 1000, tokens_out: 50, turns: 3 },
    { v: 2, ts: '2026-10-25T10:06:00Z', type: 'session', event: 'Stop', sid: 'claude-s1', agent_id: null, agent_type: null, actor: 'main', project: 'proj-a', tokens_in: 1500, tokens_out: 90, turns: 4 },
    { v: 2, ts: '2026-10-25T10:06:00Z', type: 'session', event: 'SubagentStop', sid: 'claude-s1', agent_id: 'a1', agent_type: 'builder', actor: 'sub', project: 'proj-a', tokens_in: 200, tokens_out: 20, turns: 2 },
  ]);
  // v1 legacy layout + record
  put('type=tool/date=2026-10-24/old.jsonl', [{ v: 1, ts: '2026-10-24T09:00:00Z', type: 'tool', event: 'PostToolUse', session_id: 'old', agent: { id: 'z', type: 'scout' }, cwd: '/x', tool: 'Read', target: 'a', ok: true, dur_ms: 5, data: { input_tokens: 3, output_tokens: 4 } }]);
  return root;
}
const node = (root, name, f = {}) => runReport(name, f, { backend: 'node', root });

test('query reads v1 + v2 and new filters', async () => {
  const root = mixedRoot();
  expect(listFiles(root, {}).length).toBe(3);
  expect(listFiles(root, { date: '2026-10-24' }).map((x) => x.type)).toEqual(['tool']);
  const all = (await node(root, 'events')).sections[0].rows;
  expect(all.length).toBe(7);
  const rows = (f) => node(root, 'events', f).then((r) => r.sections[0].rows);
  expect((await rows({ ok: 'false' })).length).toBe(1);
  expect((await rows({ event: 'Stop' })).length).toBe(2);
  expect((await rows({ actor: 'sub' })).length).toBe(3);
  expect((await rows({ project: 'proj-a' })).length).toBe(6);
  expect((await rows({ project: 'proj-a', session: 'claude-s1', agent: 'builder' })).length).toBe(2);
  const v1 = toRow({ v: 1, agent: { id: 'z', type: 'scout' }, session_id: 'old', data: { input_tokens: 3 } }, 'tool', 'd');
  expect(v1).toMatchObject({ agent_id: 'z', agent_type: 'scout', actor: 'sub', session_id: 'old', in_tok: 3 });
});
test('tokens report: non-empty, max per agent (cumulative), not summed', async () => {
  const root = mixedRoot();
  const rows = (await node(root, 'tokens')).sections[0].rows;
  expect(rows).toContainEqual({ session_id: 'claude-s1', actor: 'main', agent_id: null, in_tok: 1500, out_tok: 90 });
  expect(rows).toContainEqual({ session_id: 'claude-s1', actor: 'sub', agent_id: 'a1', in_tok: 200, out_tok: 20 });
  expect(rows).toContainEqual({ session_id: 'old', actor: 'sub', agent_id: 'z', in_tok: 3, out_tok: 4 });
});
test('formats md / jsonl and truncated reporting', async () => {
  const root = mixedRoot();
  const r = await runReport('events', {}, { backend: 'node', root, maxRows: 2 });
  expect(r.truncated).toBe('max_rows');
  expect(formatMd(r)).toContain('| ts | type |');
  expect(formatMd(r)).toContain('truncated: max_rows');
  const jl = formatJsonl(r).split('\n');
  expect(JSON.parse(jl[0]).event).toBeTruthy();
  expect(jl[jl.length - 1]).toBe('truncated: max_rows');
});
test('digest: table per session x agent, bounded', async () => {
  const root = mixedRoot();
  const r = await writeDigest('2026-10-25', { root });
  expect(r.file.replace(/\\/g, '/')).toMatch(/digest\/2026-10-25\.md$/);
  const md = fs.readFileSync(r.file, 'utf8');
  expect(md).toContain('| session | project | agent | tools | errors | tokens (in/out) | duration |');
  expect(md).toMatch(/\| claude-s1 \| proj-a \| main \| 2 \| 1 \| 1500\/90 \| 6m00s \|/);
  expect(md).toMatch(/\| claude-s1 \| proj-a \| builder \| 1 \| 0 \| 200\/20 \|/);
  const t = await writeDigest('2026-10-25', { root, maxRows: 1 });
  expect(t.truncated).toBe('max_rows');
  expect(fs.readFileSync(t.file, 'utf8')).toContain('truncated: max_rows');
  expect(aggregate([]).length).toBe(0);
});
test('cli --digest and --format md', () => {
  const root = mixedRoot();
  const q = path.join(HERE, '..', 'views', 'query', 'query.mjs');
  const env = { ...process.env, CLAUDE_AUDIT_DIR: root };
  const d = spawnSync(process.execPath, [q, '--digest', '2026-10-25'], { env, encoding: 'utf8', timeout: 20000 });
  expect(d.status).toBe(0);
  expect(fs.existsSync(path.join(root, 'digest', '2026-10-25.md'))).toBe(true);
  expect(spawnSync(process.execPath, [q, '--digest', 'bad'], { env, encoding: 'utf8', timeout: 20000 }).status).toBe(1);
  const m = spawnSync(process.execPath, [q, '--report', 'tokens', '--format', 'md', '--backend', 'node', '--ok', 'false'], { env, encoding: 'utf8', timeout: 20000 });
  expect(m.status).toBe(0);
  expect(m.stdout).toContain('## tokens');
});
test('prune handles v2 date dirs, v1 dirs and digest files', () => {
  const root = mixedRoot();
  fs.mkdirSync(path.join(root, 'digest'), { recursive: true });
  fs.writeFileSync(path.join(root, 'digest', '2026-01-01.md'), 'x');
  fs.writeFileSync(path.join(root, 'digest', '2026-10-25.md'), 'x');
  fs.mkdirSync(path.join(root, 'date=2026-01-01', 'type=tool'), { recursive: true });
  fs.mkdirSync(path.join(root, 'type=tool', 'date=2026-01-02'), { recursive: true });
  const now = new Date('2026-10-25T12:00:00Z');
  expect(prune({ root, days: 5, now }).removed.length).toBe(3); // v1 old, v2 old, digest old (v1 10-24 is kept)
  prune({ root, days: 5, now, yes: true });
  expect(fs.existsSync(path.join(root, 'date=2026-01-01'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'type=tool', 'date=2026-01-02'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'digest', '2026-01-01.md'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'digest', '2026-10-25.md'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'date=2026-10-25', 'type=tool', 'claude-s1.jsonl'))).toBe(true);
});

test('cli prefix, fallback sid, dedupe and --cli filter', async () => {
  const { buildEnvelope } = await import('./audit.mjs');
  const { sanitizeSession } = await import('./redact.mjs');
  const a = buildEnvelope({ hook_event_name: 'PostToolUse', cli: 'agy', cwd: '/x' }, {});
  const b = buildEnvelope({ hook_event_name: 'PostToolUse', cli: 'agy', cwd: '/y' }, {});
  expect(a.cli).toBe('agy');
  expect(a.sid).toMatch(/^agy-nosession-/);
  expect(a.sid).not.toBe(b.sid);
  expect(sanitizeSession('', 'seed')).toBe(sanitizeSession('', 'seed'));
  expect(buildEnvelope({ session_id: 'q' }, {}).sid).toBe('claude-q');
  const { rowMatches, nodeRows } = await import('../views/query/query.mjs');
  expect(rowMatches({ cli: 'agy' }, { cli: 'claude' })).toBe(false);
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'dd-'));
  const e = { v: 2, ts: '2026-10-25T10:00:00.100Z', event: 'PostToolUse', cli: 'agy', sid: 'agy-1', tool: 'Bash', target: 'ls' };
  const p = join(d, 'x.jsonl');
  writeFileSync(p, [e, { ...e, ts: '2026-10-25T10:00:00.900Z' }, { ...e, ts: '2026-10-25T10:00:02Z' }].map((x) => JSON.stringify(x)).join(String.fromCharCode(10)));
  const lim = () => ({ deadline: Date.now() + 5000, maxBytes: 1e6, maxRows: 100, truncated: null });
  expect((await nodeRows([{ path: p, type: 'tool', date: 'x' }], { dedupe: true }, lim())).length).toBe(2);
  expect((await nodeRows([{ path: p, type: 'tool', date: 'x' }], {}, lim())).length).toBe(3);
  // two SubagentStop, same sid + second, different agent_id: both kept even with dedupe
  const ss = { v: 2, ts: '2026-10-25T10:00:00.100Z', event: 'SubagentStop', cli: 'claude', sid: 'claude-1' };
  const p2 = join(d, 'y.jsonl');
  writeFileSync(p2, [{ ...ss, agent_id: 'a1' }, { ...ss, agent_id: 'a2' }, { ...ss, agent_id: 'a2' }].map((x) => JSON.stringify(x)).join(String.fromCharCode(10)));
  expect((await nodeRows([{ path: p2, type: 'session', date: 'x' }], { dedupe: true }, lim())).length).toBe(2);
  // old row without cli matches --cli claude; agy row does not
  const p3 = join(d, 'z.jsonl');
  writeFileSync(p3, [{ ts: '2026-10-25T10:00:00Z', event: 'PostToolUse', session_id: 'old' }, e].map((x) => JSON.stringify(x)).join(String.fromCharCode(10)));
  const cl = await nodeRows([{ path: p3, type: 'tool', date: 'x' }], { cli: 'claude' }, lim());
  expect(cl.length).toBe(1);
  expect(cl[0].session_id).toBe('old');
  rmSync(d, { recursive: true, force: true });
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
