import { test, expect } from 'bun:test';
import { routing, derive } from './routing.mjs';
import { segment } from './problems.mjs';
import { ROUTING } from './cost-contract.mjs';

let n = 0;
const T = (m = 0) => new Date(Date.UTC(2026, 10, 10, 0, 0, 0) + m * 60000 + (n++)).toISOString();
const ev = (o) => ({ v: 2, ts: T(o.m || 0), type: 'tool', cli: 'claude', cwd: '/hub', agent_id: null, agent_type: null, data: {}, ...o });
const prompt = (sid, m, extra = {}) => ev({ sid, m, type: 'prompt', event: 'UserPromptSubmit', data: { prompt_kw: [] }, ...extra });
const stop = (sid, m, input = 1000, extra = {}) => ev({ sid, m, type: 'stop', event: 'Stop', model: 'claude-opus-4', data: { usage: { input, output: 0, cache_read: 0, cache_creation: 0, msgs: 1 } }, ...extra });
const post = (sid, m, tool, o = {}) => ev({ sid, m, event: 'PostToolUse', tool, ok: true, ...o });
const rd = (sid, m, len = 10) => post(sid, m, 'Read', { data: { out_len: len } });
const run = (events, opts = {}) => routing({ events, segments: segment(events), hubDir: '/hub', ...opts });
const val = (r, k) => r.rows.find((x) => x.k === k)?.v;
// dispatch: Pre -> SubagentStart -> (tool events cua sub) -> SubagentStop
const dispatch = (sid, m, type, id, { model, turns = 5, tools = [], reqModel, cache = 0 } = {}) => [
  ev({ sid, m, event: 'PreToolUse', tool: 'Agent', target: type, data: reqModel ? { model: reqModel } : {} }),
  ev({ sid, m, event: 'SubagentStart', type: 'session', agent_id: id, agent_type: type }),
  ...tools.map((t) => ({ ...t, agent_id: id, agent_type: type })),
  ev({ sid, m, event: 'SubagentStop', type: 'stop', agent_id: id, agent_type: type, model: model ?? null, turns, tokens_in: 1000, tokens_out: 500, data: cache == null ? {} : { tokens_cache: cache } }),
];

test('hang so gia: haiku1 sonnet3 opus5, agy khong gia', () => {
  expect(ROUTING.priceRel).toEqual({ haiku: 1, sonnet: 3, opus: 5 });
  expect(ROUTING.priceRel.agy).toBeUndefined();
});

test('(1) main WebSearch -> missed_agy web_lookup, chi phi chenh = token', () => {
  const r = run([prompt('s1', 0), post('s1', 1, 'WebSearch', { data: { out_len: 50 } }), stop('s1', 2, 1000)]);
  expect(val(r, 'missed_agy')).toBe(1);
  expect(val(r, 'compliance_rate')).toBe(0);
  expect(r.misses[0]).toMatchObject({ type: 'missed_agy', cls: 'web_lookup', sid: 's1' });
  expect(val(r, 'excess_cost_share')).toBe(0); expect(val(r, 'excess_upper_bound')).toBe(1000);
});

test('(2) scout chay opus -> overuse_opus, khong dem them underuse_haiku', () => {
  const evs = [prompt('s2', 0), ...dispatch('s2', 1, 'scout', 'a1', { model: 'claude-opus-4', tools: [rd('s2', 1)] }), stop('s2', 3, 10)];
  const r = run(evs);
  expect(val(r, 'overuse_opus')).toBe(1);
  expect(val(r, 'underuse_haiku')).toBe(0);
  expect(r.misses.filter((m) => m.cls === 'read_small').length).toBe(1);
  expect(r.misses[0].excess).toBeCloseTo(1500 * (5 - 1) / 5);
});

test('scout chay sonnet -> underuse_haiku; reviewer thuong sonnet dung; reviewer rui ro sonnet -> under_model', () => {
  const evs = [prompt('s', 0),
    ...dispatch('s', 1, 'scout', 'a', { model: 'claude-sonnet-5', tools: [rd('s', 1)] }),
    ...dispatch('s', 2, 'reviewer', 'b', { model: 'claude-sonnet-5', tools: [rd('s', 2)] }),
    ...dispatch('s', 3, 'reviewer', 'c', { model: 'claude-sonnet-5', tools: [post('s', 3, 'Read', { data: { out_len: 5, files_touched: ['src/auth/guard.mjs'] } })] }),
    stop('s', 5, 10)];
  const r = run(evs);
  expect(val(r, 'underuse_haiku')).toBe(1);
  expect(val(r, 'under_model')).toBe(1);
  expect(val(r, 'overuse_opus')).toBe(0);
});

test('(3) builder turns 41 -> builder_over_turns; 20 turns dung', () => {
  const ed = (s, m) => post(s, m, 'Edit', { data: { files_touched: ['a.mjs'] } });
  const bad = run([prompt('s3', 0), ...dispatch('s3', 1, 'builder', 'b1', { model: 'claude-sonnet-5', turns: 41, tools: [ed('s3', 1)] }), stop('s3', 3, 10)]);
  expect(val(bad, 'builder_over_turns')).toBe(1);
  expect(bad.misses[0].cls).toBe('code_edit');
  const ok = run([prompt('s3', 0), ...dispatch('s3', 1, 'builder', 'b1', { model: 'claude-sonnet-5', turns: 20, tools: [ed('s3', 1)] }), stop('s3', 3, 10)]);
  expect(val(ok, 'builder_over_turns')).toBe(0);
  expect(val(ok, 'compliance_rate')).toBe(1);
});

test('(4) main 3 Read khong dispatch -> main_overread; 2 Read dung', () => {
  const r = run([prompt('s4', 0), rd('s4', 1), rd('s4', 1), rd('s4', 1), stop('s4', 2, 1000)]);
  expect(val(r, 'main_overread')).toBe(1);
  expect(r.misses[0].type).toBe('main_overread');
  const ok = run([prompt('s4', 0), rd('s4', 1), rd('s4', 1), stop('s4', 2, 1000)]);
  expect(val(ok, 'main_overread')).toBe(0);
  expect(val(ok, 'compliance_rate')).toBe(1);
});

test('large_read (>=400k ky tu) o main -> missed_agy large_read', () => {
  const r = run([prompt('s', 0), rd('s', 1, 450000), stop('s', 2)]);
  expect(r.misses[0]).toMatchObject({ type: 'missed_agy', cls: 'large_read' });
});

test('(5) phien agy web_lookup roi Claude cung khoa co Edit <=24h -> redo; agy khong tinh gia', () => {
  const plan = ['docs/superpowers/plans/2026-11-10-x.md'];
  const agy = [
    prompt('agy-1', 0, { cli: 'agy' }),
    post('agy-1', 1, 'WebSearch', { cli: 'agy', data: { out_len: 5, files_touched: plan } }),
    stop('agy-1', 2, 4000, { cli: 'agy', model: 'gemini' }),
  ];
  const cl = [
    prompt('c-1', 60),
    post('c-1', 61, 'Write', { data: { files_touched: plan } }),
    post('c-1', 62, 'Edit', { data: { files_touched: plan } }),
    stop('c-1', 63, 1000),
  ];
  const r = run([...agy, ...cl]);
  expect(r.agy.find((x) => x.k === 'redo_rate').v).toBe(1);
  const share = r.agy.find((x) => x.k === 'share').v;
  expect(share).toBeGreaterThan(0);
  expect(r.agy.find((x) => x.k === 'cost_per_problem').v).toBe(4000);
  expect(r.agyNote).toMatch(/unpriced/);
});

test('(6) phantom -> unknown, khong vao mau so, unknown_share', () => {
  const evs = [prompt('s6', 0),
    ...dispatch('s6', 1, 'scout', 'p1', { model: null, tools: [rd('s6', 1)] }),
    ...dispatch('s6', 2, 'builder', 'p2', { model: 'claude-sonnet-5', turns: 5, tools: [post('s6', 2, 'Edit', { data: { files_touched: ['a.mjs'] } })] }),
    stop('s6', 4, 10)];
  const r = run(evs);
  expect(r.unknown).toBeGreaterThanOrEqual(1);
  expect(val(r, 'unknown_share')).toBeGreaterThan(0);
  expect(val(r, 'overuse_opus')).toBe(0);
  expect(val(r, 'compliance_rate')).toBe(1);
});

test('su kien cu thieu out_len -> unknown, khong phai lech', () => {
  const old = post('s7', 1, 'Read', { data: {} });
  const r = run([prompt('s7', 0), old, stop('s7', 2)]);
  expect(r.misses.length).toBe(0);
  expect(val(r, 'unknown_share')).toBe(1);
  expect(val(r, 'compliance_rate')).toBeNull();
});

test('(7) vuot maxEvents -> truncated', () => {
  const evs = [prompt('s8', 0), rd('s8', 1), rd('s8', 1), rd('s8', 1), stop('s8', 2)];
  const r = routing({ events: evs, segments: segment(evs), limits: { maxEvents: 3 } });
  expect(r.truncated).toBe('max_events');
});

test('output khong chua prompt/target day du: chi sid 8 ky tu', () => {
  const r = run([prompt('abcdefghijkl', 0), post('abcdefghijkl', 1, 'WebFetch', { target: 'https://secret.example/x', data: { out_len: 1 } }), stop('abcdefghijkl', 2)]);
  expect(r.misses[0].sid).toBe('abcdefgh');
  expect(JSON.stringify(r)).not.toContain('secret.example');
});

test('derive: 3 ten, rows {k,v}; routing_misses nhom theo loai:lop', () => {
  expect(Object.keys(derive).sort()).toEqual(['agy_kpi', 'routing_kpi', 'routing_misses']);
  const events = [prompt('s', 0), post('s', 1, 'WebSearch', { data: { out_len: 1 } }), stop('s', 2)];
  const a = { events, from: 0, to: 0, getSegments: () => segment(events) };
  expect(derive.routing_kpi(a).rows.find((x) => x.k === 'missed_agy').v).toBe(1);
  expect(derive.routing_misses(a).rows[0]).toMatchObject({ k: 'missed_agy:web_lookup', n: 1 });
  expect(derive.agy_kpi(a).rows.map((x) => x.k)).toContain('share');
});

// ---- review round T13 ----
test('R1 reviewer opus khong la overuse_opus; review_opus_share trung tinh', () => {
  const r = run([prompt('s', 0), ...dispatch('s', 1, 'reviewer', 'a', { model: 'claude-opus-4', tools: [rd('s', 1)] }), stop('s', 3, 10)]);
  expect(val(r, 'overuse_opus')).toBe(0);
  expect(val(r, 'compliance_rate')).toBe(1);
  expect(val(r, 'review_opus_share')).toBe(1);
});

test('R1 riskRe theo thanh phan duong dan: auth/guard khop, author/permanent khong', () => {
  for (const p of ['src/auth/x.mjs', 'harness/guard/hook.mjs', 'deploy.sh', 'a/permission.json']) expect(ROUTING.riskRe.test(p)).toBe(true);
  for (const p of ['src/author.mjs', 'docs/permanent.md', 'a/guardian/x.mjs']) expect(ROUTING.riskRe.test(p)).toBe(false);
});

test('R2 web phu (1/6 call) khong la missed_agy; web chu dao (>=3 lan) la missed_agy, excess_upper_bound tach rieng', () => {
  const minor = run([prompt('s', 0), post('s', 1, 'WebSearch', { data: { out_len: 1 } }), ...[1, 2, 3, 4, 5].map(() => rd('s', 1)), stop('s', 2)], { hubDir: null });
  expect(val(minor, 'missed_agy')).toBe(0);
  const many = [prompt('s', 0), ...[1, 2, 3].map(() => post('s', 1, 'WebFetch', { data: { out_len: 1 } })), ...[1, 2, 3, 4, 5, 6, 7].map(() => rd('s', 1)), stop('s', 2)];
  const r = run(many);
  expect(val(r, 'missed_agy')).toBe(1);
  expect(val(r, 'excess_cost_share')).toBe(0);
  expect(val(r, 'excess_upper_bound')).toBe(1000);
});

test('R3 main_overread chi o phien hub; >20k ky tu cung la overread', () => {
  const evs = [prompt('s', 0), rd('s', 1), rd('s', 1), rd('s', 1), stop('s', 2)];
  expect(val(run(evs, { hubDir: '/other' }), 'main_overread')).toBe(0);
  expect(val(run(evs, { hubDir: null }), 'main_overread')).toBe(0);
  const big = run([prompt('s', 0), rd('s', 1, 25000), stop('s', 2)]);
  expect(val(big, 'main_overread')).toBe(1);
});

test('R4 dispatch eff = in+out+0.1*cache; thieu cache -> khong tron vao eff (raw)', () => {
  const a = run([prompt('s', 0), ...dispatch('s', 1, 'scout', 'a', { model: 'claude-opus-4', cache: 10000, tools: [rd('s', 1)] }), stop('s', 3, 10)]);
  expect(a.misses[0].excess).toBeCloseTo((1000 + 500 + 1000) * 4 / 5);
  expect(a.unit).toBe('eff_tokens');
  const b = run([prompt('s', 0), ...dispatch('s', 1, 'scout', 'a', { model: 'claude-opus-4', cache: null, tools: [rd('s', 1)] }), stop('s', 3, 10)]);
  expect(val(b, 'overuse_opus')).toBe(1);
  expect(b.misses[0].excess).toBe(0);
  expect(b.rawDispatch).toBe(1);
});

test('R5 Start khong co Pre (resume) va Pre thieu subagent_type -> unknown, dem unmatched_starts', () => {
  const resume = [prompt('s', 0), ev({ sid: 's', m: 1, event: 'SubagentStart', type: 'session', agent_id: 'z', agent_type: 'scout' }),
    ev({ sid: 's', m: 2, event: 'SubagentStop', type: 'stop', agent_id: 'z', agent_type: 'scout', model: 'claude-opus-4', turns: 1, tokens_in: 1, tokens_out: 1 })];
  const r = run(resume);
  expect(r.unmatchedStarts).toBe(1);
  expect(r.unknown).toBe(1);
  expect(val(r, 'overuse_opus')).toBe(0);
  const noType = run([prompt('s', 0), ev({ sid: 's', m: 1, event: 'PreToolUse', tool: 'Agent', target: '' }),
    ev({ sid: 's', m: 1, event: 'SubagentStart', type: 'session', agent_id: 'y', agent_type: 'scout' })]);
  expect(noType.unknown).toBe(1);
  expect(noType.unmatchedStarts).toBe(0);
});

test('R6 Bash thieu out_len -> legacy unknown', () => {
  const r = run([prompt('s', 0), post('s', 1, 'Bash', { target: 'ls', data: {} }), stop('s', 2)]);
  expect(val(r, 'unknown_share')).toBe(1);
});

test('R7 haiku Write vao data/report khong la code_edit; Edit .mjs la code_edit', () => {
  const w = run([prompt('s', 0), ...dispatch('s', 1, 'scout', 'a', { model: 'claude-haiku-4', tools: [post('s', 1, 'Write', { data: { files_touched: ['data/report/x.json'] } })] }), stop('s', 3, 10)]);
  expect(w.misses.length).toBe(0);
  expect(val(w, 'compliance_rate')).toBe(1);
  const c = run([prompt('s', 0), ...dispatch('s', 1, 'scout', 'a', { model: 'claude-haiku-4', tools: [post('s', 1, 'Edit', { data: { files_touched: ['src/x.mjs'] } })] }), stop('s', 3, 10)]);
  expect(c.byClass.code_edit).toBeDefined();
});

test('R8 model_param_ignored: yeu cau haiku, chay sonnet', () => {
  const r = run([prompt('s', 0), ...dispatch('s', 1, 'scout', 'a', { model: 'claude-sonnet-5', reqModel: 'haiku', tools: [rd('s', 1)] }), stop('s', 3, 10)]);
  expect(val(r, 'model_param_ignored')).toBe(1);
});
