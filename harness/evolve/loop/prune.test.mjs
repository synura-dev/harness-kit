import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdNames, inventoryCommands, inventoryHooks, inventorySkills, inventoryAgents, inventoryRules, countUsage, buildCandidates, pruneCandidates, PRUNE } from './prune.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
const wr = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

test('cmdNames: chuoi, mang, tien to eval', () => {
  assert.deepEqual(cmdNames('register <path> | approve <id> | list'), ['register', 'approve', 'list']);
  assert.deepEqual(cmdNames(['candidates', 'eval run|list|bench']), ['candidates', 'eval']);
});

test('kiem ke: lenh, hook, skill, agent, rule', async () => {
  const root = tmp(), proj = tmp();
  wr(path.join(root, 'harness/a/manifest.json'), JSON.stringify({ kind: 'cli', domain: 'tasks', cmds: ['new', 'set'] }));
  wr(path.join(root, 'harness/b/manifest.json'), JSON.stringify({ kind: 'cli', domain: 'x', domains: { ext: { cmds: 'register <p> | list' } } }));
  wr(path.join(root, 'skills/s1/SKILL.md'), 'x'); wr(path.join(proj, '.claude/skills/s2/SKILL.md'), 'x');
  wr(path.join(proj, '.claude/agents/scout.md'), 'x');
  wr(path.join(proj, 'CLAUDE.md'), '# T\n## Learned rules\n- rule one\n- rule two\n\n## Other\n- not a rule\n');
  assert.deepEqual(inventoryCommands({ pluginRoot: root }).map((c) => c.name).sort(), ['ext.list', 'ext.register', 'tasks.new', 'tasks.set']);
  assert.deepEqual((await inventoryHooks({ order: { A: [{ id: 'g' }, { id: 'h' }], B: [{ id: 'g' }] } })).map((h) => h.name), ['g', 'h']);
  assert.deepEqual(inventorySkills({ pluginRoot: root, projectDir: proj }).map((s) => s.name).sort(), ['s1', 's2']);
  assert.deepEqual(inventoryAgents({ projectDir: proj }).map((a) => a.name), ['scout']);
  assert.equal(inventoryRules({ projectDir: proj }).length, 2);
});

const inv = { commands: [{ type: 'command', name: 'tasks.new', domain: 'tasks', cmd: 'new' }, { type: 'command', name: 'tasks.set', domain: 'tasks', cmd: 'set' }], hooks: [], skills: [{ type: 'skill', name: 'harness' }, { type: 'skill', name: 'old' }], agents: [{ type: 'agent', name: 'scout' }, { type: 'agent', name: 'planner' }], rules: [] };

test('dem dung: gateway, fallback Bash truoc gateway, skill, agent, hook', () => {
  const ev = [
    { gw: true, ts: '2026-11-05T01:00:00Z', sid: 's1', domain: 'tasks', cmd: 'new' },
    { ts: '2026-11-04T01:00:00Z', sid: 's0', event: 'PreToolUse', tool: 'Bash', target: 'harness tasks set X --status done' },
    { ts: '2026-11-05T02:00:00Z', sid: 's1', event: 'PreToolUse', tool: 'Bash', target: 'harness tasks set X' }, // sau gateway: khong dem fallback
    { ts: '2026-11-05T01:00:00Z', sid: 's1', event: 'PreToolUse', tool: 'Skill', target: 'harness-kit:harness' },
    { ts: '2026-11-05T01:00:00Z', sid: 's1', event: 'PreToolUse', tool: 'Agent', target: 'scout' },
    { ts: '2026-11-05T01:00:00Z', sid: 's1', event: 'HookRun', data: { modules: [{ id: 'guard', ms: 5 }, { id: 'audit', ms: 2 }] } },
  ];
  const { usage, sources } = countUsage(ev, inv);
  assert.equal(usage.command.get('tasks.new').count, 1);
  assert.equal(usage.command.get('tasks.set').count, 1);
  assert.equal(sources.command_bash_fallback, 1);
  assert.equal(usage.skill.get('harness').count, 1);
  assert.equal(usage.agent.get('scout').count, 1);
  assert.equal(usage.hook.get('guard').cost, 5);
});

test('buildCandidates: 0 dung -> pending kem ngay; sau 14 ngay -> propose_remove', () => {
  const { usage } = countUsage([{ ts: '2026-11-05T01:00:00Z', event: 'PreToolUse', tool: 'Skill', target: 'harness' }], inv);
  const a = buildCandidates({ inv, usage, nowMs: NOW });
  const old = a.items.find((i) => i.id === 'skill:old');
  assert.equal(old.kind, 'deprecate'); assert.equal(old.status, 'pending'); assert.equal(old.pending_since, '2026-11-05');
  assert.ok(!a.items.find((i) => i.id === 'skill:harness'));
  const st = { 'skill:old': { pending_since: new Date(NOW - 13 * DAY).toISOString().slice(0, 10) } };
  assert.equal(buildCandidates({ inv, usage, state: st, nowMs: NOW }).items.find((i) => i.id === 'skill:old').status, 'pending');
  st['skill:old'].pending_since = new Date(NOW - 15 * DAY).toISOString().slice(0, 10);
  assert.equal(buildCandidates({ inv, usage, state: st, nowMs: NOW }).items.find((i) => i.id === 'skill:old').status, 'propose_remove');
  assert.deepEqual(Object.keys(old).filter((k) => ['id', 'kind', 'fp', 'count', 'sessions', 'first_ts', 'last_ts', 'sample', 'cost_ms'].includes(k)).length, 9);
});

test('tran: vuot tran -> kind=cap; hook/rule khong bi deprecate', () => {
  const many = { ...inv, agents: Array.from({ length: 9 }, (_, i) => ({ type: 'agent', name: `a${i}` })), rules: [{ type: 'rule', name: 'r1' }], hooks: [{ type: 'hook', name: 'h' }] };
  const { usage } = countUsage([], many);
  const r = buildCandidates({ inv: many, usage, nowMs: NOW });
  assert.equal(r.items.find((i) => i.kind === 'cap').id, 'cap:agent');
  assert.equal(PRUNE.caps.agent, 8);
  assert.ok(!r.items.some((i) => /^(rule|hook):/.test(i.id)));
  assert.equal(buildCandidates({ inv: many, usage, nowMs: NOW, caps: { agent: 20 } }).items.some((i) => i.kind === 'cap'), false);
});

test('pruneCandidates doc audit that (gateway + tool) va timeout', async () => {
  const root = tmp(), proj = tmp(), audit = tmp();
  wr(path.join(root, 'harness/a/manifest.json'), JSON.stringify({ kind: 'cli', domain: 'tasks', cmds: ['new', 'set'] }));
  const d = new Date(NOW).toISOString().slice(0, 10);
  wr(path.join(audit, 'gateway', `date=${d}`, 'gateway.jsonl'), JSON.stringify({ ts: '2026-11-05T01:00:00Z', domain: 'tasks', cmd: 'new', session: 's' }) + '\n');
  const r = await pruneCandidates({ pluginRoot: root, projectDir: proj, auditDirs: [audit], nowMs: NOW, order: {} });
  assert.deepEqual(r.items.filter((i) => i.kind === 'deprecate').map((i) => i.id), ['command:tasks.set']);
  assert.equal(r.sources.command_gateway, 1);
  assert.equal(r.truncated, null);
});

test('countUsage: subagent khong dem doi (PreToolUse + su kien agent_id); gateway (default) khong tao khoa gia', () => {
  const inv = { commands: [], hooks: [], skills: [], agents: [], rules: [] };
  const ev = [
    { ts: '2026-11-05T01:00:00Z', event: 'PreToolUse', tool: 'Agent', data: { subagent_type: 'scout' }, sid: 's' },
    { ts: '2026-11-05T01:00:05Z', event: 'PostToolUse', tool: 'Read', agent_type: 'scout', agent_id: 'a1', sid: 's' },
    { ts: '2026-11-05T01:00:06Z', event: 'PostToolUse', tool: 'Read', agent_type: 'scout', agent_id: 'a1', sid: 's' },
    { gw: true, ts: '2026-11-05T01:00:07Z', domain: 'tasks', cmd: '(default)' },
  ];
  const { usage } = countUsage(ev, inv);
  expect(usage.agent.get('scout').count).toBe(1);
  expect(usage.command.get('tasks.(default)')).toBeUndefined();
});

test('writeState: atomic, khong de lai file tmp', async () => {
  const { writeState, readState } = await import('./prune.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const pth = await import('node:path');
  const d = fs.mkdtempSync(pth.join(os.tmpdir(), 'pst-')); const f = pth.join(d, 'sub', 'prune-state.json');
  writeState(f, { a: 1 }); writeState(f, { a: 2 });
  expect(readState(f)).toEqual({ a: 2 });
  expect(fs.readdirSync(pth.dirname(f)).filter((n) => n.endsWith('.tmp')).length).toBe(0);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- u59 wire: countEvents, cua so trung thuc, transcript ----
const emptyInv = { commands: [], hooks: [], skills: [{ type: 'skill', name: 'old' }], agents: [], rules: [] };
const W = (e) => ({ skill: { earliest: e }, command: { earliest: e }, agent: { earliest: e }, hook: { earliest: e } });

test('buildCandidates: cua so tre hon days -> insufficient_window, khong pending/propose_remove/state', () => {
  const { usage } = countUsage([], emptyInv);
  const young = new Date(NOW - 8 * DAY).toISOString();
  const r = buildCandidates({ inv: emptyInv, usage, nowMs: NOW, window: W(young) });
  const it = r.items.find((i) => i.id === 'skill:old');
  assert.equal(it.status, 'insufficient_window'); assert.equal(it.window_days, 8);
  assert.equal(it.pending_since, undefined); assert.deepEqual(r.state, {});
  const ok = buildCandidates({ inv: emptyInv, usage, nowMs: NOW, window: W(new Date(NOW - 30 * DAY).toISOString()) });
  assert.equal(ok.items.find((i) => i.id === 'skill:old').status, 'pending');
});

test('countUsage: sessions va last_ts that', () => {
  const { usage } = countUsage([
    { ts: '2026-11-05T01:00:00Z', sid: 's1', event: 'PreToolUse', tool: 'Skill', target: 'old' },
    { ts: '2026-11-05T03:00:00Z', sid: 's2', event: 'PreToolUse', tool: 'Skill', target: 'old' },
    { ts: '2026-11-05T02:00:00Z', sid: 's2', event: 'PreToolUse', tool: 'Skill', target: 'old' },
  ], emptyInv);
  const x = usage.skill.get('old');
  assert.equal(x.count, 3); assert.equal(x.sessions, 2); assert.equal(x.last_ts, '2026-11-05T03:00:00Z');
});

const ISO = (ms) => new Date(ms).toISOString();
const line = (o) => JSON.stringify(o) + '\n';
const asst = (ts, sid, blocks) => line({ type: 'assistant', sessionId: sid, timestamp: ts, message: { role: 'assistant', content: blocks } });
const user = (ts, sid, text) => line({ type: 'user', sessionId: sid, timestamp: ts, message: { role: 'user', content: text } });
const skillUse = (id, name) => ({ type: 'tool_use', id, name: 'Skill', input: { skill: name } });
const readUse = (id, f) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: f } });
async function integ({ tr, audit = '', opts = {} }) {
  const proj = tmp(), auditDir = tmp(), trDir = tmp();
  wr(path.join(proj, '.claude/skills/old/SKILL.md'), 'x'); wr(path.join(proj, '.claude/skills/other/SKILL.md'), 'x');
  wr(path.join(trDir, 'p1', 's.jsonl'), tr);
  const d = ISO(NOW).slice(0, 10);
  if (audit) wr(path.join(auditDir, 'x', `date=${d}`, 'a.jsonl'), audit);
  const r = await pruneCandidates({ pluginRoot: tmp(), projectDir: proj, auditDirs: [auditDir], transcriptRoots: [trDir], nowMs: NOW, order: {}, ...opts });
  return { r, dep: (n) => r.items.find((i) => i.id === `skill:${n}`) };
}

test('integ: skill chi trong transcript (Skill tool) -> khong deprecate', async () => {
  const t = ISO(NOW - DAY);
  const { dep } = await integ({ tr: asst(t, 's1', [skillUse('t1', 'old')]) });
  assert.equal(dep('old'), undefined); assert.ok(dep('other'));
});

test('integ: doc SKILL.md <5/turn tinh la dung; 20 doc / 1 turn = khong dung', async () => {
  const t = ISO(NOW - DAY);
  const one = user(t, 's1', 'hi') + asst(t, 's1', [readUse('r1', '/x/old/SKILL.md')]);
  assert.equal((await integ({ tr: one })).dep('old'), undefined);
  const many = user(t, 's1', 'hi') + asst(t, 's1', Array.from({ length: 20 }, (_, i) => readUse(`r${i}`, `/x/s${i}/SKILL.md`)).concat([readUse('rr', '/x/old/SKILL.md')]));
  const m = await integ({ tr: many });
  assert.ok(m.dep('old')); assert.equal(m.r.maintenance_dropped, 21);
});

test('integ: transcript bi cat -> truncated, khong co deprecate', async () => {
  const { r } = await integ({ tr: asst(ISO(NOW - DAY), 's1', [skillUse('t1', 'old')]), opts: { transcriptLimits: { maxFiles: 0 } } });
  assert.equal(r.truncated, 'max_files');
  assert.equal(r.items.filter((i) => i.kind === 'deprecate').length, 0);
});

test('integ: record cu trong file moi (mtime moi) ngoai cua so -> khong dem', async () => {
  const old = asst(ISO(NOW - 60 * DAY), 's0', [skillUse('t0', 'old')]);
  const { r, dep } = await integ({ tr: old });
  assert.ok(dep('old'));
  assert.equal(r.sources.transcript.earliest, ISO(NOW - 60 * DAY)); // earliest truoc loc ts
});

test('integ: cung mot call o audit + transcript dem 1 lan', async () => {
  const t = ISO(NOW - DAY);
  const audit = line({ ts: t, sid: 's1', event: 'PreToolUse', tool: 'Skill', target: 'old', data: { skill: 'old', tool_use_id: 'T1' } });
  const { r } = await integ({ tr: asst(t, 's1', [skillUse('T1', 'old')]), audit });
  assert.equal(r.usage_counts.skill.old, 1); assert.equal(r.duplicates_dropped, 1);
});

test('integ: audit Skill khong co tool_use_id bi bo khi doc transcript (khong dem doi)', async () => {
  const t = ISO(NOW - DAY);
  const audit = line({ ts: t, sid: 's1', event: 'PreToolUse', tool: 'Skill', target: 'old', data: { skill: 'old' } });
  const { r } = await integ({ tr: asst(t, 's1', [skillUse('T1', 'old')]), audit });
  assert.equal(r.usage_counts.skill.old, 1);
});

test('integ: gateWindow: du lieu 8 ngay -> insufficient_window, khong pending; sources co earliest+window_days', async () => {
  const t = ISO(NOW - 8 * DAY);
  const audit = line({ ts: t, sid: 's1', event: 'PreToolUse', tool: 'Agent', data: { subagent_type: 'x' } });
  const { r } = await integ({ tr: asst(t, 's1', [skillUse('T1', 'zzz')]), audit, opts: { gateWindow: true } });
  assert.equal(r.sources.audit.window_days, 8);
  assert.equal(r.items.filter((i) => i.status === 'pending' || i.status === 'propose_remove').length, 0);
  assert.equal(r.items.find((i) => i.id === 'skill:old').status, 'insufficient_window');
});
