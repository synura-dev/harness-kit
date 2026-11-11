import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segment } from './problems.mjs';

// Fixture theo envelope that cua audit.mjs (v2): ts,type,event,sid,agent_id,tool,target,tokens_in/out,origin,data.
let n = 0;
const ts = () => new Date(Date.parse('2026-11-11T10:00:00Z') + (n++) * 1000).toISOString();
const base = (o) => ({ v: 2, ts: ts(), sid: 's1', agent_id: null, agent_type: null, actor: 'main', cwd: '/p', tool: null, target: null, ok: null, tokens_in: null, tokens_out: null, origin: 'project', data: {}, ...o });
const prompt = (kw = [], sid = 's1', extra = {}) => base({ type: 'prompt', event: 'UserPromptSubmit', sid, data: { prompt_kw: kw, prompt_hash: 'h', ...extra } });
const tool = (o = {}) => base({ type: 'tool', event: 'PostToolUse', tool: 'Bash', ok: true, ...o });
const stop = (usage, sid = 's1') => base({ type: 'stop', event: 'Stop', sid, tokens_in: 999999, tokens_out: 999999, data: { usage } });
const U = (input, output, cache_read = 0, cache_creation = 0, msgs = 1) => ({ input, output, cache_read, cache_creation, msgs });

test('2 prompt cung sid -> 2 doan, token = tong data.usage (khong tokens_in tich luy)', () => {
  const ev = [prompt(['alpha']), tool(), stop(U(10, 5, 100, 20, 2)), stop(U(1, 1)), prompt(['beta']), tool(), tool({ event: 'PostToolUseFailure', ok: false }), stop(U(7, 3))];
  const { segments, truncated } = segment(ev);
  assert.equal(truncated, null);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].tokens, { input: 11, output: 6, cache_read: 100, cache_creation: 20 });
  assert.equal(segments[0].turns, 3);
  assert.equal(segments[0].tools, 1);
  assert.equal(segments[1].tools, 2);
  assert.equal(segments[1].tokens.input, 7);
  assert.equal(segments[0].eff_tokens, 11 + 20 + 6 + 10);
  assert.deepEqual(segments[0].prompt_kw, ['alpha']);
  assert.ok(segments[0].wall_ms > 0);
});

test('khoa plan: spec + plan cung slug -> 1 khoa; precision high; family plan:slug', () => {
  const ev = [prompt(), tool({ tool: 'Write', target: 'docs/superpowers/specs/2026-11-11-foo-bar-design.md', data: { files_touched: ['docs/superpowers/specs/2026-11-11-foo-bar-design.md'] } }),
    tool({ tool: 'Edit', data: { files_touched: ['docs/superpowers/plans/2026-11-11-foo-bar.md'] } }), stop(U(1, 1))];
  const s = segment(ev).segments[0];
  assert.equal(s.keys.plan, 'foo-bar');
  assert.equal(s.problem, 'plan:foo-bar');
  assert.equal(s.precision, 'high');
  assert.equal(s.family, 'plan:foo-bar');
});

test('task > plan; task_id high', () => {
  const ev = [prompt(), tool({ data: { task_id: 'T-42', files_touched: ['docs/superpowers/plans/2026-11-11-foo.md'] } }), stop(U(1, 1))];
  const s = segment(ev).segments[0];
  assert.equal(s.problem, 'task:T-42');
  assert.equal(s.precision, 'high');
});

test('branch: worktree agent-a970ef bi bo, worktree ten that duoc giu; git checkout -b', () => {
  const a = segment([prompt(), tool({ cwd: '/r/.worktrees/agent-a970ef' }), stop(U(1, 1))]).segments[0];
  assert.equal(a.keys.branch, null);
  assert.equal(a.problem, null);
  const b = segment([prompt(), tool({ cwd: '/r/.worktrees/kt-t3' }), stop(U(1, 1))]).segments[0];
  assert.equal(b.problem, 'branch:kt-t3');
  assert.equal(b.precision, 'mid');
  const c = segment([prompt(), tool({ target: 'git checkout -b feat-x main' }), stop(U(1, 1))]).segments[0];
  assert.equal(c.keys.branch, 'feat-x');
});

test('err: error_fp -> mid; family = id ledger chua fp; khong ledger -> err:<fp>', () => {
  const ev = [prompt(), tool({ ok: false, data: { error_fp: 'abc123' } }), stop(U(1, 1))];
  const s0 = segment(ev).segments[0];
  assert.equal(s0.problem, 'err:abc123');
  assert.equal(s0.precision, 'mid');
  assert.equal(s0.family, 'err:abc123');
  const s1 = segment(ev, { ledger: [{ id: 'L-9', evidence: { fp: 'abc123' } }, { id: 'L-1', fp: 'zzz' }] }).segments[0];
  assert.equal(s1.family, 'L-9');
});

test('kw: chi tu khoa da chuan hoa, low; khong luu van ban prompt', () => {
  const s = segment([prompt(['zeta', 'alpha', 'mid', 'omega']), stop(U(1, 1))]).segments[0];
  assert.equal(s.keys.kw, 'alpha+mid+omega');
  assert.equal(s.precision, 'low');
  assert.equal(s.family, 'kw:alpha+mid+omega');
  assert.ok(!JSON.stringify(s).includes('prompt_hash'));
});

test('thua khoa: doan khong khoa ke thua khoa doan truoc cung sid, khong qua sid', () => {
  const ev = [prompt(), tool({ data: { task_id: 'T-1' } }), stop(U(5, 5)), prompt([]), tool(), stop(U(2, 2)),
    prompt([], 's2'), tool({ sid: 's2' }), stop(U(3, 3), 's2')];
  const { segments } = segment(ev);
  assert.equal(segments.length, 3);
  assert.equal(segments[1].problem, 'task:T-1');
  assert.equal(segments[1].precision, 'high');
  assert.equal(segments[2].problem, null);
});

test('fetches + kfetch', () => {
  const ev = [prompt(), tool({ target: 'harness knowledge get 2026-11-07-agent-allocation --budget 800' }), tool({ target: 'harness knowledge search foo' }),
    tool({ target: 'cat kpi-info-fetch.json' }), tool({ target: 'kpi-info-fetch.json --x' }), tool({ target: 'ls' }), stop(U(1, 1))];
  const s = segment(ev).segments[0];
  assert.equal(s.fetches, 3);
  assert.deepEqual(s.kfetch, ['2026-11-07-agent-allocation']);
});

test('subagent: MAX luy ke theo agent_id, phantom = 0, agent khong co Start bi bo', () => {
  const ss = (id) => base({ type: 'session', event: 'SubagentStart', agent_id: id, agent_type: 'builder' });
  const sp = (id, i, o, data = {}) => base({ type: 'stop', event: 'SubagentStop', agent_id: id, agent_type: 'builder', tokens_in: i, tokens_out: o, data });
  const ev = [prompt(), ss('a1'), ss('a2'), ss('ph'), sp('a1', 100, 10), sp('a1', 300, 30), sp('a2', 50, 5), sp('ph', null, null, { phantom: true, usage: 'unavailable' }), sp('zz', 999, 999), stop(U(1, 1))];
  const s = segment(ev).segments[0];
  assert.equal(s.sub_tokens, 330 + 55);
  const p = segment([prompt(), ss('ph'), sp('ph', null, null, { phantom: true }), stop(U(1, 1))]).segments[0];
  assert.equal(p.sub_tokens, 0);
});

test('bo HookRun va origin noise', () => {
  const ev = [prompt(), base({ type: 'hook', event: 'HookRun' }), stop(U(4, 4)), prompt([], 's1', {}), base({ ...stop(U(100, 100)), origin: 'noise' })];
  const { segments } = segment(ev);
  assert.equal(segments.length, 2);
  assert.equal(segments[1].tokens.input, 0);
  assert.equal(segments[0].tokens.input, 4);
});

test('vuot maxSegments -> truncated max_segments', () => {
  const ev = []; for (let i = 0; i < 5; i++) ev.push(prompt(), stop(U(1, 1)));
  const r = segment(ev, { limits: { maxSegments: 3 } });
  assert.equal(r.segments.length, 3);
  assert.equal(r.truncated, 'max_segments');
});
