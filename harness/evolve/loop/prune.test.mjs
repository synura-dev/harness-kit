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
  const one = user(t, 's1', 'hi') + asst(t, 's1', [readUse('r1', '/x/skills/old/SKILL.md')]);
  assert.equal((await integ({ tr: one })).dep('old'), undefined);
  const many = user(t, 's1', 'hi') + asst(t, 's1', Array.from({ length: 20 }, (_, i) => readUse(`r${i}`, `/x/skills/s${i}/SKILL.md`)).concat([readUse('rr', '/x/skills/old/SKILL.md')]));
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

// ---- wire2: slash khong dem doi, total_sessions chinh xac, source/action, cost, dupes, detail ----
const slashU = (ts, sid, uuid, name) => line({ type: 'user', uuid, sessionId: sid, timestamp: ts, message: { role: 'user', content: `<command-name>/${name}</command-name>` } });

test('integ: slash o audit (UserPromptSubmit) + transcript dem 1 lan (audit khong sinh su kien slash)', async () => {
  const t = ISO(NOW - DAY);
  const audit = line({ ts: t, sid: 's1', event: 'UserPromptSubmit', data: { prompt: '<command-name>/old</command-name>' }, target: '/old' });
  const { r } = await integ({ tr: slashU(t, 's1', 'u1', 'old'), audit });
  assert.equal(r.usage_counts.skill.old, 1);
});

test('integ: total_sessions = phien phan biet tren MOI dong transcript trong cua so (ke ca dong khong khop prefilter)', async () => {
  const t = ISO(NOW - DAY);
  const tr = user(t, 's1', 'hi') + asst(t, 's1', [skillUse('t1', 'old')]) + asst(t, 's2', [{ type: 'text', text: 'khong khop' }]) + user(t, 's3', 'chao') + asst(ISO(NOW - 60 * DAY), 's0', [{ type: 'text', text: 'cu' }]);
  const { r } = await integ({ tr });
  assert.equal(r.total_sessions, 3);
});

test('integ: source/action cho moi muc kiem ke; skill project -> delete_in_repo, plugin -> edit_plugin_repo', async () => {
  const pr = tmp(); wr(path.join(pr, 'skills/ps/SKILL.md'), '---\nname: ps\ndescription: abc\n---\nbody');
  const { r } = await integ({ tr: '', opts: { pluginRoot: pr } });
  const inv = (k, n) => r.inventory.find((i) => i.kind === k && i.name === n);
  assert.equal(inv('skill', 'old').source, 'project'); assert.equal(inv('skill', 'old').action, 'delete_in_repo');
  assert.equal(inv('skill', 'ps').source, 'plugin'); assert.equal(inv('skill', 'ps').action, 'edit_plugin_repo');
  assert.ok(r.inventory.every((i) => i.source && i.action));
});

test('buildCandidates: canPropose=false (builtin/third_party/unknown/account) -> report_only, khong pending/propose_remove', () => {
  const inv = { ...emptyInv, skills: ['builtin', 'third_party', 'unknown', 'account'].map((s) => ({ name: `n-${s}`, source: s, action: 'report_only' })) };
  const r = buildCandidates({ inv, usage: countUsage([], emptyInv).usage, nowMs: NOW, window: W(new Date(NOW - 30 * DAY).toISOString()), waitDays: 0 });
  const dep = r.items.filter((i) => i.kind === 'deprecate');
  assert.equal(dep.length, 4);
  for (const i of dep) { assert.equal(i.status, 'report_only'); assert.equal(i.action, 'report_only'); assert.ok(i.source); }
  assert.deepEqual(r.state, {});
});

test('integ: skill tai khoan (anthropic-skills:*) chi liet ke khi thay trong usage, source account, khong deprecate', async () => {
  const t = ISO(NOW - DAY);
  const { r } = await integ({ tr: asst(t, 's1', [skillUse('a1', 'anthropic-skills:pdf')]) });
  const x = r.inventory.find((i) => i.kind === 'skill' && i.name === 'pdf');
  assert.equal(x.source, 'account'); assert.equal(x.action, 'disable_on_claude_ai'); assert.equal(x.count, 1);
  assert.equal(r.items.find((i) => i.id === 'skill:pdf'), undefined);
});

test('integ: cost {desc,body,windowCost,costPerUse} theo total_sessions; dupes tu mo ta skill', async () => {
  const proj = tmp(), trDir = tmp(), auditDir = tmp();
  const sk = (d) => `---\nname: x\ndescription: ${d}\n---\n${'b'.repeat(40)}`;
  wr(path.join(proj, '.claude/skills/a/SKILL.md'), sk('quan ly tri thuc luu tru bao cao nghien cuu'));
  wr(path.join(proj, '.claude/skills/b/SKILL.md'), sk('quan ly tri thuc luu tru bao cao nghien cuu'));
  const t = ISO(NOW - DAY);
  wr(path.join(trDir, 'p1', 's.jsonl'), user(t, 's1', 'hi') + asst(t, 's1', [skillUse('t1', 'a')]) + user(t, 's2', 'hi'));
  const r = await pruneCandidates({ pluginRoot: tmp(), projectDir: proj, auditDirs: [auditDir], transcriptRoots: [trDir], nowMs: NOW, order: {} });
  const a = r.inventory.find((i) => i.name === 'a');
  assert.equal(r.total_sessions, 2);
  assert.ok(a.cost.desc_tokens > 0); assert.equal(a.cost.body_tokens, 10);
  assert.equal(a.cost.windowCost, a.cost.desc_tokens * 2 + 10 * 1);
  assert.equal(a.cost.costPerUse, a.cost.windowCost);
  assert.equal(r.dupes.pairs.length, 1);
});

test('integ: usage_detail co channels, sessions, ids day du, projects cho --detail', async () => {
  const t = ISO(NOW - DAY);
  const { r } = await integ({ tr: asst(t, 's1', [skillUse('t1', 'superpowers:old')]) });
  const d = r.usage_detail['skill:old'];
  assert.equal(d.count, 1); assert.deepEqual(d.channels, { tool: 1 }); assert.deepEqual(d.ids, ['superpowers:old']); assert.deepEqual(d.session_ids, ['s1']);
});
