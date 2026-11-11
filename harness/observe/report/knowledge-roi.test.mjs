import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { parseFetch, computeRoi, loadDocIds, derive } from './knowledge-roi.mjs';
import { buildReport } from './run.mjs';

let n = 0;
const ts = () => new Date(Date.UTC(2026, 10, 1, 0, 0, n++)).toISOString();
// 1 doan = prompt + doc plan + (cac get) + Stop; family qua khoa plan (precision high|mid) hoac kw (low)
const seg = (sid, { gets = [], out_len, eff = 1000, plan = 'p1', kw, target, fail } = {}) => {
  const evs = [{ ts: ts(), sid, event: 'UserPromptSubmit', type: 'prompt', data: { prompt_kw: kw || [] } }];
  if (!kw) evs.push({ ts: ts(), sid, event: 'PostToolUse', tool: 'Read', target: `docs/superpowers/plans/2026-11-01-${plan}.md` });
  for (const g of gets) evs.push({ ts: ts(), sid, event: fail ? 'PostToolUseFailure' : 'PostToolUse', tool: 'Bash', target: target || `harness knowledge get ${g}`, ...(out_len != null ? { data: { out_len } } : {}) });
  evs.push({ ts: ts(), sid, event: 'Stop', data: { usage: { input: eff, output: 0, cache_read: 0, cache_creation: 0, msgs: 1 } } });
  return evs;
};

test('parseFetch: cac lenh, web:, co truoc id, get loi khong tinh', () => {
  const ok = { event: 'PostToolUse', tool: 'Bash' };
  assert.deepEqual(parseFetch({ ...ok, target: 'harness knowledge get 2026-11-07-agent-allocation --budget 800' }), [{ kind: 'get', id: '2026-11-07-agent-allocation', budget: 800 }]);
  assert.equal(parseFetch({ ...ok, target: 'harness knowledge get --budget 5 web:x' })[0].id, 'web:x');
  assert.equal(parseFetch({ ...ok, target: 'harness knowledge search foo' })[0].kind, 'search');
  assert.deepEqual(parseFetch({ ...ok, target: 'ls' }), []);
  assert.deepEqual(parseFetch({ ...ok, event: 'PostToolUseFailure', target: 'harness knowledge get a' }), []);
  assert.deepEqual(parseFetch(null), []);
});

test('computeRoi: served = out_len/4, khong out_len -> budget/null; coverage; never_fetched', () => {
  const events = [...seg('a', { gets: ['doc-a'], out_len: 400 }), ...seg('b', { gets: ['doc-b'] })];
  const r = computeRoi({ events, docIds: ['doc-a', 'doc-b', 'doc-c'] });
  assert.equal(r.docs.find((x) => x.id === 'doc-a').served_tokens, 100);
  assert.equal(r.docs.find((x) => x.id === 'doc-b').served_tokens, null);
  assert.equal(r.kpi.tokens_measured_share, 0.5); assert.equal(r.kpi.fetches, 2);
  assert.deepEqual(r.neverFetched, ['doc-c']);
  assert.equal(r.kpi.roi_saved_tokens, null); // mau nho
});

test('get loi khong vao fetches/doc', () => {
  const r = computeRoi({ events: seg('a', { gets: ['doc-a'], fail: true }) });
  assert.equal(r.docs.length, 0); assert.equal(r.kpi.fetches, 0);
});

test('saving: tru token get khoi eff phia co doc', () => {
  const ev = [];
  for (let i = 0; i < 3; i++) ev.push(...seg('w' + i, { gets: ['doc-x'], out_len: 4000, eff: 1800 }), ...seg('o' + i, { eff: 1000 }));
  const x = computeRoi({ events: ev }).docs.find((d) => d.id === 'doc-x');
  assert.equal(x.saving, 200); // 1000 - (1800 - 1000)
});

test('saving: family kw (precision low) bi bo -> null', () => {
  const ev = [];
  for (let i = 0; i < 4; i++) ev.push(...seg('w' + i, { gets: ['doc-x'], eff: 500, kw: ['alpha', 'beta'] }), ...seg('o' + i, { eff: 1000, kw: ['alpha', 'beta'] }));
  assert.equal(computeRoi({ events: ev }).docs.find((d) => d.id === 'doc-x').saving, null);
});

test('roi_saved_tokens: doan lay 2 doc chia deu, khong cong trung', () => {
  const ev = [];
  for (let i = 0; i < 3; i++) ev.push(...seg('w' + i, { gets: ['d1', 'd2'], eff: 800 }), ...seg('o' + i, { eff: 1000 }));
  const r = computeRoi({ events: ev });
  const d1 = r.docs.find((d) => d.id === 'd1');
  assert.equal(d1.saved_total, 300); // 3 doan * 200 / 2 doc
  assert.equal(r.kpi.roi_saved_tokens, 600); // = 3 * 200 tong thuc, khong phai 1200
});

test('fetched_no_saving: can n>=5 moi ben va lo > 20% trung vi', () => {
  const mk = (nw, effW) => { const ev = []; for (let i = 0; i < nw; i++) ev.push(...seg('w' + i, { gets: ['doc-y'], eff: effW }), ...seg('o' + i, { eff: 1000 })); return computeRoi({ events: ev }); };
  assert.deepEqual(mk(5, 1300).noSaving, ['doc-y']);
  assert.deepEqual(mk(4, 1300).noSaving, []); // n < 5
  assert.deepEqual(mk(5, 1100).noSaving, []); // lo 10% < 20%
});

test('derive: ids lay luoi, memo 1 lan; knowledge_roi khong goi; khong co ids -> truncated ly do', () => {
  const events = seg('a', { gets: ['doc-a'], out_len: 40 });
  let calls = 0; const memo = {};
  const listIds = () => { calls++; return { ids: ['doc-a', 'doc-z'] }; };
  derive.knowledge_roi({ events, memo, listIds }); assert.equal(calls, 0);
  const rows = derive.knowledge_retire({ events, memo, listIds });
  const k = derive.knowledge_kpi({ events, memo, listIds });
  assert.equal(calls, 1);
  assert.deepEqual(rows.map((x) => x.id), ['never_fetched:doc-z']);
  assert.equal(k.find((x) => x.k === 'never_fetched_count').v, 1);
  assert.equal(derive.knowledge_retire({ events, memo: {}, listIds: () => ({ unavailable: 'ids_unavailable' }) }).truncated, 'ids_unavailable');
});

test('loadDocIds: parse export; loi -> unavailable', () => {
  const ok = loadDocIds({ run: () => ({ status: 0, stdout: JSON.stringify({ docs: [{ id: 'a' }, { id: 'b' }], errors: [] }) }) });
  assert.deepEqual(ok.ids, ['a', 'b']);
  assert.equal(loadDocIds({ run: () => ({ status: 1, stdout: '' }) }).unavailable, 'ids_unavailable');
  assert.equal(loadDocIds({ run: () => ({ status: 0, stdout: 'x' }) }).unavailable, 'ids_unavailable');
  assert.equal(loadDocIds({ run: () => { throw new Error('boom'); } }).unavailable, 'ids_unavailable');
});

test('buildReport: muc knowledge-*; docIds tiem, khong spawn CLI; chi khoa on dinh vao kpi', async () => {
  const events = seg('a', { gets: ['2026-11-07-agent-allocation'], out_len: 400 });
  const r = await buildReport({ nowMs: Date.UTC(2026, 10, 3), events, ledger: [], baseline: null, process: [], inventory: [], projectDir: null, hubDir: os.tmpdir(), docIds: ['2026-11-07-agent-allocation', '2026-01-01-never'] });
  assert.deepEqual(r.errors, []);
  assert.match(r.markdown, /never_fetched:2026-01-01-never/);
  const kpi = r.results.find((x) => x.def.id === 'kpi-knowledge');
  assert.deepEqual(kpi.rows.map((x) => x.key).sort(), ['fetches', 'never_fetched_count', 'retire_candidates', 'tokens_measured_share', 'tokens_served']);
});

test('loadDocIds: uu tien harness tren PATH; ENOENT -> fallback CLI import.meta', () => {
  const cmds = [];
  const okOut = JSON.stringify({ docs: [{ id: 'a' }] });
  const r1 = loadDocIds({ run: (c) => { cmds.push(c); return { status: 0, stdout: okOut }; } });
  assert.deepEqual(r1.ids, ['a']); assert.deepEqual(cmds, ['harness']);
  cmds.length = 0;
  const r2 = loadDocIds({ run: (c) => { cmds.push(c); return c === 'harness' ? { error: { code: 'ENOENT' }, status: null } : { status: 0, stdout: okOut }; } });
  assert.deepEqual(r2.ids, ['a']); assert.equal(cmds.length, 2); assert.notEqual(cmds[1], 'harness');
});

test('loadDocIds: HKERR code vao ly do; buildReport.errors[] hien ly do', async () => {
  const stderr = 'HKERR ' + JSON.stringify({ code: 'HK_EXT_UNREGISTERED', cause: 'x' }) + '\n';
  const run = () => ({ status: 2, stdout: '', stderr });
  assert.equal(loadDocIds({ run }).unavailable, 'ids_unavailable:HK_EXT_UNREGISTERED');
  const events = seg('a', { gets: ['doc-a'], out_len: 400 });
  const r = await buildReport({ nowMs: Date.UTC(2026, 10, 3), events, ledger: [], baseline: null, process: [], inventory: [], projectDir: null, hubDir: os.tmpdir(), listIds: () => loadDocIds({ run }) });
  assert.ok(r.errors.some((m) => m.includes('ids_unavailable:HK_EXT_UNREGISTERED')), JSON.stringify(r.errors));
});
