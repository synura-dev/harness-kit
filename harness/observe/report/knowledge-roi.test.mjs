import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFetch, computeRoi, loadDocIds, derive } from './knowledge-roi.mjs';
import { buildReport } from './run.mjs';
import os from 'node:os';

let n = 0;
const ts = () => new Date(Date.UTC(2026, 10, 1, 0, 0, n++)).toISOString();
// 1 doan = prompt + (get?) + Stop; family qua khoa plan
const seg = (sid, { get, out_len, eff = 1000, plan = 'p1' }) => {
  const evs = [{ ts: ts(), sid, event: 'UserPromptSubmit', type: 'prompt', data: { prompt_kw: [] } }];
  evs.push({ ts: ts(), sid, event: 'PostToolUse', tool: 'Read', target: `docs/superpowers/plans/2026-11-01-${plan}.md` });
  if (get) evs.push({ ts: ts(), sid, event: 'PostToolUse', tool: 'Bash', target: `harness knowledge get ${get}`, ...(out_len != null ? { data: { out_len } } : {}) });
  evs.push({ ts: ts(), sid, event: 'Stop', data: { usage: { input: eff, output: 0, cache_read: 0, cache_creation: 0, msgs: 1 } } });
  return evs;
};

test('parseFetch: get + --budget, search, target cat 160 ky tu khong crash', () => {
  const g = parseFetch({ event: 'PostToolUse', tool: 'Bash', target: 'harness knowledge get 2026-11-07-agent-allocation --budget 800' });
  assert.deepEqual(g, { kind: 'get', id: '2026-11-07-agent-allocation', budget: 800 });
  assert.equal(parseFetch({ event: 'PostToolUse', tool: 'Bash', target: 'harness knowledge search foo' }).kind, 'search');
  assert.equal(parseFetch({ event: 'PostToolUse', tool: 'Bash', target: 'harness knowledge get ' + 'x'.repeat(160) }).kind, 'get');
  assert.equal(parseFetch({ event: 'PostToolUse', tool: 'Bash', target: 'ls' }), null);
  assert.equal(parseFetch(null), null);
});

test('computeRoi: served = out_len/4 (do duoc), cu khong out_len -> budget/null; coverage', () => {
  const events = [...seg('a', { get: 'doc-a', out_len: 400 }), ...seg('b', { get: 'doc-b' })];
  const r = computeRoi({ events, docIds: ['doc-a', 'doc-b', 'doc-c'] });
  const a = r.docs.find((x) => x.id === 'doc-a'), b = r.docs.find((x) => x.id === 'doc-b');
  assert.equal(a.served_tokens, 100); assert.equal(b.served_tokens, null);
  assert.equal(r.kpi.tokens_measured_share, 0.5); assert.equal(r.kpi.fetches, 2);
  assert.deepEqual(r.neverFetched, ['doc-c']); assert.equal(r.kpi.never_fetched_count, 1);
  assert.equal(a.saving, null); assert.equal(r.kpi.roi_saved_tokens, null); // mau nho
});

test('computeRoi: >=3 mau moi ben cung family -> saving; hay lay khong tiet kiem -> co lenh retire', () => {
  const ev = [];
  for (let i = 0; i < 3; i++) ev.push(...seg('w' + i, { get: 'doc-x', eff: 800 }), ...seg('o' + i, { eff: 1000 }), ...seg('l' + i, { get: 'doc-y', eff: 1200 }));
  const r = computeRoi({ events: ev });
  const x = r.docs.find((d) => d.id === 'doc-x'), y = r.docs.find((d) => d.id === 'doc-y');
  assert.ok(x.saving > 0 && x.saved_total === x.saving * 3); assert.equal(x.fetched_no_saving, false);
  assert.ok(y.saving < 0 && y.fetched_no_saving); assert.deepEqual(r.noSaving, ['doc-y']);
  assert.equal(r.neverFetched, null); // khong co docIds
});

test('derive: khong co docIds -> rows retire + truncated ly do; kpi khoa on dinh', () => {
  const events = seg('a', { get: 'doc-a', out_len: 40 });
  const t = derive.knowledge_retire({ events });
  assert.equal(t.truncated, 'ids_unavailable');
  const k = derive.knowledge_kpi({ events, docIds: [] });
  assert.deepEqual(k.map((x) => x.k).sort(), ['fetches', 'never_fetched_count', 'retire_candidates', 'roi_saved_tokens', 'tokens_measured_share', 'tokens_served']);
  assert.equal(k.find((x) => x.k === 'roi_saved_tokens').v, null);
});

test('loadDocIds: parse export; loi -> unavailable', () => {
  const ok = loadDocIds({ run: () => ({ status: 0, stdout: JSON.stringify({ docs: [{ id: 'a' }, { id: 'b' }], errors: [] }) }) });
  assert.deepEqual(ok.ids, ['a', 'b']);
  assert.equal(loadDocIds({ run: () => ({ status: 1, stdout: '' }) }).unavailable, 'ids_unavailable');
  assert.equal(loadDocIds({ run: () => ({ status: 0, stdout: 'x' }) }).unavailable, 'ids_unavailable');
  assert.equal(loadDocIds({ run: () => { throw new Error('boom'); } }).unavailable, 'ids_unavailable');
});

test('buildReport: muc knowledge-*; id doc co ngay khong vao series kpi-knowledge', async () => {
  const events = seg('a', { get: '2026-11-07-agent-allocation', out_len: 400 });
  const r = await buildReport({ nowMs: Date.UTC(2026, 10, 3), events, ledger: [], baseline: null, process: [], inventory: [], projectDir: null, hubDir: os.tmpdir(), docIds: ['2026-11-07-agent-allocation', '2026-01-01-never'] });
  assert.deepEqual(r.errors, []);
  assert.match(r.markdown, /never_fetched:2026-01-01-never/);
  const kpi = r.results.find((x) => x.def.id === 'kpi-knowledge');
  assert.deepEqual(kpi.rows.map((x) => x.key).sort(), ['fetches', 'never_fetched_count', 'retire_candidates', 'tokens_measured_share', 'tokens_served']);
});
