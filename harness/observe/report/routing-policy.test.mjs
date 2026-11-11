import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRoutingPolicy, resolvePolicy, DEFAULT_POLICY } from './routing-policy.mjs';
import { routing } from './routing.mjs';
import { segment } from './problems.mjs';
import { ROUTING } from './cost-contract.mjs';

let n = 0;
const T = (m = 0) => new Date(Date.UTC(2026, 10, 10, 0, 0, 0) + m * 60000 + (n++)).toISOString();
const ev = (o) => ({ v: 2, ts: T(o.m || 0), type: 'tool', cli: 'claude', cwd: '/hub', agent_id: null, agent_type: null, data: {}, ...o });
const prompt = (sid, m, extra = {}) => ev({ sid, m, type: 'prompt', event: 'UserPromptSubmit', data: { prompt_kw: [] }, ...extra });
const stop = (sid, m, extra = {}) => ev({ sid, m, type: 'stop', event: 'Stop', model: 'claude-opus-4', data: { usage: { input: 1000, output: 0, cache_read: 0, cache_creation: 0, msgs: 1 } }, ...extra });
const web = (sid, m, extra = {}) => ev({ sid, m, event: 'PostToolUse', tool: 'WebSearch', ok: true, data: { out_len: 5 }, ...extra });
const val = (r, k) => r.rows.find((x) => x.k === k)?.v;
const run = (events, policy) => routing({ events, segments: segment(events), hubDir: '/hub', policy });
const tmpProject = (content) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rpol-'));
  if (content != null) { fs.mkdirSync(path.join(d, '.harness')); fs.writeFileSync(path.join(d, '.harness', 'routing.json'), typeof content === 'string' ? content : JSON.stringify(content)); }
  return d;
};

test('mac dinh: khong file du an -> source default, web_lookup khong la missed backend', () => {
  const d = tmpProject(null);
  const { policy, source } = loadRoutingPolicy({ projectDir: d });
  expect(source).toBe('default');
  expect(policy.backends).toEqual({});
  const r = run([prompt('s', 0), web('s', 1), stop('s', 2)], policy);
  expect(r.misses.length).toBe(0);
  expect(val(r, 'missed_external')).toBe(0);
  expect(r.rows.some((x) => x.k === 'missed_agy')).toBe(false);
  expect(ROUTING.priceRel).toEqual(DEFAULT_POLICY.prices);
});

test('file du an co backends.agy: tai hien hanh vi cu (missed_agy + missed_external)', () => {
  const d = tmpProject({ backends: { agy: { classes: ['web_lookup', 'large_read'], label: 'Antigravity' } } });
  const { policy, source } = loadRoutingPolicy({ projectDir: d });
  expect(source).toBe('project');
  const r = run([prompt('s', 0), web('s', 1), stop('s', 2)], policy);
  expect(val(r, 'missed_agy')).toBe(1);
  expect(val(r, 'missed_external')).toBe(1);
  expect(r.misses[0]).toMatchObject({ type: 'missed_agy', cls: 'web_lookup' });
});

test('backend nhan dien qua audit cli (khong chi sid prefix)', () => {
  const policy = resolvePolicy({ backends: { gem: { classes: ['web_lookup'] } } }).policy;
  const evs = [prompt('x-1', 0, { cli: 'gem' }), web('x-1', 1, { cli: 'gem' }), stop('x-1', 2, { cli: 'gem', model: 'g' })];
  const r = run(evs, policy);
  expect(val(r, 'missed_gem')).toBe(0); // phien backend khong bi tinh lech
  expect(r.units).toBe(1);
  expect(r.agy.find((x) => x.k === 'share').v).toBe(1);
});

test('file hong -> mac dinh + source ghi chu; schema sai -> mac dinh', () => {
  expect(loadRoutingPolicy({ projectDir: tmpProject('{not json') }).source).toBe('default(invalid project)');
  expect(loadRoutingPolicy({ projectDir: tmpProject({ prices: { opus: -1 } }) }).source).toBe('default(invalid project)');
  expect(loadRoutingPolicy({ projectDir: tmpProject({ backends: { claude: { classes: [] } } }) }).source).toBe('default(invalid project)');
  expect(loadRoutingPolicy({ projectDir: tmpProject({ riskRe: '(' }) }).source).toBe('default(invalid project)');
  expect(loadRoutingPolicy({ projectDir: tmpProject({ bogus: 1 }) }).source).toBe('default(invalid project)');
  const bad = loadRoutingPolicy({ projectDir: tmpProject('{x') });
  expect(bad.policy.expected.code_edit).toBe('sonnet');
});

test('doi luat doi mode ky vong: code_edit -> opus thi builder sonnet la under_model', () => {
  const ed = ev({ sid: 's', m: 1, event: 'PostToolUse', tool: 'Edit', ok: true, data: { files_touched: ['a.mjs'] }, agent_id: 'b', agent_type: 'builder' });
  const evs = [prompt('s', 0),
    ev({ sid: 's', m: 1, event: 'PreToolUse', tool: 'Agent', target: 'builder', data: {} }),
    ev({ sid: 's', m: 1, event: 'SubagentStart', type: 'session', agent_id: 'b', agent_type: 'builder' }), ed,
    ev({ sid: 's', m: 2, event: 'SubagentStop', type: 'stop', agent_id: 'b', agent_type: 'builder', model: 'claude-sonnet-5', turns: 5, tokens_in: 1, tokens_out: 1, data: { tokens_cache: 0 } }),
    stop('s', 3)];
  expect(val(run(evs, resolvePolicy({}).policy), 'under_model')).toBe(0);
  const p2 = resolvePolicy({ expected: { code_edit: 'opus' } }).policy;
  expect(val(run(evs, p2), 'under_model')).toBe(1);
});

test('file vi du hub hop le va dung luat hub', () => {
  const j = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'examples/hub-routing.json'), 'utf8'));
  const r = resolvePolicy(j);
  expect(r.errors).toEqual([]);
  expect(r.policy.backends.agy.classes.sort()).toEqual(['large_read', 'web_lookup']);
});
