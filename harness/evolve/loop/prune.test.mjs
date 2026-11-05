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
