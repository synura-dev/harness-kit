// T10b: loi do tren du lieu that (agy segment, under_model am).
import { test, expect } from 'bun:test';
import { routing, derive } from './routing.mjs';
import { segment } from './problems.mjs';

let n = 0;
const T = (m = 0) => new Date(Date.UTC(2026, 10, 10, 0, 0, 0) + m * 60000 + (n++)).toISOString();
const ev = (o) => ({ v: 2, ts: T(o.m || 0), type: 'tool', cli: 'claude', cwd: '/hub', agent_id: null, agent_type: null, data: {}, ...o });
const prompt = (sid, m, extra = {}) => ev({ sid, m, type: 'prompt', event: 'UserPromptSubmit', data: {}, ...extra });
const stop = (sid, m, input, extra = {}) => ev({ sid, m, type: 'stop', event: 'Stop', model: 'claude-opus-4', data: { usage: { input, output: 0, cache_read: 0, cache_creation: 0, msgs: 1 } }, ...extra });
const post = (sid, m, tool, o = {}) => ev({ sid, m, event: 'PostToolUse', tool, ok: true, ...o });
const run = (events) => routing({ events, segments: segment(events), hubDir: '/hub' });
const val = (r, k) => r.rows.find((x) => x.k === k)?.v;
const dispatch = (sid, m, type, id, { model, tools = [] } = {}) => [
  ev({ sid, m, event: 'PreToolUse', tool: 'Agent', target: type }),
  ev({ sid, m, event: 'SubagentStart', type: 'session', agent_id: id, agent_type: type }),
  ...tools.map((t) => ({ ...t, agent_id: id, agent_type: type })),
  ev({ sid, m, event: 'SubagentStop', type: 'stop', agent_id: id, agent_type: type, model, turns: 5, tokens_in: 1000, tokens_out: 500, data: { tokens_cache: 5000 } }),
];
const PLAN = ['docs/superpowers/plans/2026-11-10-y.md'];

test('agy: UserPromptSubmit lap moi invocation (chua Stop) -> 1 doan mang token cua Stop', () => {
  const a = { cli: 'agy' };
  const evs = [prompt('agy-1', 0, a), post('agy-1', 1, 'Read', a), prompt('agy-1', 2, a), post('agy-1', 3, 'Read', a), prompt('agy-1', 4, a), stop('agy-1', 5, 4000, a)];
  const { segments } = segment(evs);
  expect(segments.length).toBe(1);
  expect(segments[0].tools).toBe(2);
  expect(segments[0].tokens.input).toBe(4000);
});

test('agy: Stop usage unavailable -> cost_per_problem null (khong do), khong phai 0', () => {
  const a = { cli: 'agy' };
  const r = run([
    prompt('agy-2', 0, a),
    post('agy-2', 1, 'WebSearch', { ...a, data: { out_len: 5, files_touched: PLAN } }),
    ev({ sid: 'agy-2', m: 2, type: 'stop', event: 'Stop', ...a, data: { usage: 'unavailable', usage_reason: 'no_path' } }),
  ]);
  expect(r.agy.find((x) => x.k === 'cost_per_problem').v).toBeNull();
});

test('under_model: excess am bi kep ve 0, van dem under_model, khong giam excess_cost_share', () => {
  const evs = [prompt('s', 0),
    ...dispatch('s', 1, 'planner', 'p', { model: 'claude-haiku-4', tools: [post('s', 1, 'Write', { data: { files_touched: ['docs/superpowers/plans/2026-11-10-z.md'] } })] }),
    stop('s', 5, 10)];
  const r = run(evs);
  expect(val(r, 'under_model')).toBe(1);
  expect(r.misses.every((m) => m.excess >= 0)).toBe(true);
  const g = derive.routing_misses({ events: evs, from: 0, to: 0, memo: {}, projectDir: '/hub', getSegments: () => segment(evs) }).rows;
  expect(g.find((x) => x.k === 'under_model:plan').excess).toBe(0);
});
