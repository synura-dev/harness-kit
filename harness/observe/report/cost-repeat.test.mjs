import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costRepeat, derive, readIndex, indexFile } from './cost-repeat.mjs';

// Fixture theo envelope audit v2 (xem problems.test.mjs). Moi phien: 1 prompt + 1 tool gan task_id + 1 Stop.
let n = 0;
const base = (o) => ({ v: 2, ts: new Date(Date.parse('2026-11-01T10:00:00Z') + (n++) * 1000).toISOString(), sid: 's1', agent_id: null, agent_type: null, actor: 'main', cwd: '/p', tool: null, target: null, ok: null, tokens_in: null, tokens_out: null, origin: 'project', data: {}, ...o });
const sess = (sid, input, { task = 'T1', kw, cacheRead = 0 } = {}) => [
  base({ sid, type: 'prompt', event: 'UserPromptSubmit', data: { prompt_kw: kw || [], prompt_hash: 'h' } }),
  base({ sid, type: 'tool', event: 'PostToolUse', tool: 'Bash', ok: true, data: task ? { task_id: task } : {} }),
  base({ sid, type: 'stop', event: 'Stop', data: { usage: { input, output: 0, cache_read: cacheRead, cache_creation: 0, msgs: 1 } } }),
];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'));
const val = (r, k) => (r.rows.find((x) => x.k === k) || {}).v;

test('khoa o phien 1 (1000) va phien 2,3 (400,600) -> ratio 0.5', () => {
  const r = costRepeat({ events: [...sess('a', 1000), ...sess('b', 400), ...sess('c', 600)], index: {} });
  assert.equal(val(r, 'repeat_vs_first_ratio'), 0.5);
  assert.equal(val(r, 'problems'), 1);
  assert.equal(val(r, 'eff_tokens_per_problem'), 2000);
  assert.equal(val(r, 'repeat_share'), 0.5);
  assert.equal(val(r, 'key_coverage'), 1);
});

test('lap trong cung phien khong tinh; khong co phien sau -> ratio null (bo)', () => {
  const r = costRepeat({ events: [...sess('a', 1000), ...sess('a', 500)], index: {} });
  assert.equal(val(r, 'repeat_vs_first_ratio'), null);
  assert.equal(val(r, 'repeat_share'), 0);
});

test('lan dau nam trong index cu -> moi phien trong cua so deu la lap, khong co mau so lan dau', () => {
  const r = costRepeat({ events: [...sess('b', 400), ...sess('c', 600)], index: { 'task:T1': { first_ts: '2026-10-01T00:00:00Z', last_ts: '2026-10-02T00:00:00Z' } } });
  assert.equal(val(r, 'repeat_share'), 1);
  assert.equal(val(r, 'repeat_vs_first_ratio'), null);
});

test('khoa kw (low) khong vao ty le/problems; chi vao key_coverage', () => {
  const kw = ['alpha', 'beta'];
  const ev = [...sess('a', 1000, { task: null, kw }), ...sess('b', 100, { task: null, kw })];
  const r = costRepeat({ events: ev, index: {} });
  assert.equal(val(r, 'problems'), null);
  assert.equal(val(r, 'repeat_vs_first_ratio'), null);
  assert.equal(val(r, 'key_coverage'), 0);
});

test('persist:false khong tao file; persist:true ghi index atomic (khong con .tmp)', () => {
  const d = tmp(); const dataOpts = { env: { HUB_DATA_DIR: d } };
  const f = indexFile(dataOpts);
  const ev = [...sess('a', 1000), ...sess('b', 400)];
  costRepeat({ events: ev, index: {}, persist: false, dataOpts });
  assert.equal(fs.existsSync(f), false);
  costRepeat({ events: ev, index: {}, persist: true, dataOpts, now: Date.parse('2026-11-02T00:00:00Z') });
  assert.ok(readIndex(f)['task:T1']);
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((x) => x.endsWith('.tmp')), []);
  assert.equal(JSON.stringify(readIndex(f)).includes('prompt'), false);
});

test('sub_tokens bao rieng trong byFamily, khong cong vao eff', () => {
  const ev = [...sess('a', 1000), ...sess('b', 400)];
  ev.splice(2, 0, base({ sid: 'a', type: 'tool', event: 'SubagentStart', agent_id: 'x' }), base({ sid: 'a', type: 'tool', event: 'SubagentStop', agent_id: 'x', tokens_in: 70, tokens_out: 30 }));
  const r = costRepeat({ events: ev, index: {} });
  assert.equal(r.byFamily[0].first_eff, 1000);
  assert.equal(r.byFamily[0].sub_tokens, 100);
});

test('derive: da dang ky, dong bo, qua han -> truncated timeout', () => {
  const ev = sess('a', 100);
  const x = derive.cost_repeat({ events: ev, index: {}, dataOpts: { env: { HUB_DATA_DIR: tmp() } } });
  assert.ok(Array.isArray(x.rows));
  assert.equal(typeof derive.cost_by_family, 'function');
  const t = derive.cost_repeat({ events: [], deadline: Date.now() - 1 });
  assert.equal(t.truncated, 'timeout');
});
