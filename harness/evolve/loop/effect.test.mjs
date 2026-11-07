import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EFFECT, verdictOf, computeWindow, measureDue } from './effect.mjs';
import { extractErrorDetails } from '../../core/audit/signature.mjs';
import { messageFingerprint } from '../../core/audit/normalize-message.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const DAY = 86400000;
let tmp, audit;
const ev = (ts, sid, extra = {}) => ({ v: 2, ts, type: 'tool', event: 'PostToolUse', sid, tool: 'Bash', ok: true, status: 'ok', data: {}, ...extra });
const errEv = (ts, sid, error) => ev(ts, sid, { event: 'PostToolUseFailure', ok: false, status: 'error', data: { error, error_fp: 'zz' } });
const FP = messageFingerprint(extractErrorDetails(errEv('2026-10-29T00:00:00Z', 's', 'cannot find module foo')), 'Bash');
const write = (date, sid, recs) => {
  const d = path.join(audit, `date=${date}`, 'type=tool');
  fs.mkdirSync(d, { recursive: true });
  fs.appendFileSync(path.join(d, `${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
// n tool call ok + e loi trong 1 ngay (gio tang dan)
const day = (date, sid, n, e, extra = []) => {
  const recs = [];
  for (let i = 0; i < n; i++) recs.push(ev(`${date}T01:${String(i % 60).padStart(2, '0')}:00Z`, sid));
  for (let i = 0; i < e; i++) recs.push(errEv(`${date}T02:${String(i % 60).padStart(2, '0')}:00Z`, sid, 'cannot find module foo'));
  write(date, sid, [...recs, ...extra]);
};
const base = (o = {}) => ({ window_days: 7, from: 'x', to: 'y', target_count: 10, tool_calls: 1000, rate_per_1000: 10, sessions: 5, tokens_per_session: 1000, corrections_per_session: 1, ...o });
const aft = (rate, o = {}) => ({ tool_calls: 1000, target_count: rate, rate_per_1000: rate, tokens_per_session: 1000, corrections_per_session: 1, ...o });
const prop = (id, o = {}) => ({ id, kind: 'rule', status: 'applied', ver: 'v1', applied_at: '2026-10-20T00:00:00Z', evidence: { fp: FP }, effect: { baseline: base() }, ...o });
const opts = (x = {}) => ({ auditDir: audit, ...x });

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-eff-')); audit = path.join(tmp, 'audit'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('verdictOf: bien chinh xac 0.7 / 1.3 va giua', () => {
  expect(verdictOf(base(), aft(7)).verdict).toBe('better');
  expect(verdictOf(base(), aft(6.9)).verdict).toBe('better');
  expect(verdictOf(base(), aft(7.1)).verdict).toBe('unchanged');
  expect(verdictOf(base(), aft(10)).verdict).toBe('unchanged');
  expect(verdictOf(base(), aft(12.9)).verdict).toBe('unchanged');
  expect(verdictOf(base(), aft(13)).verdict).toBe('worse');
  expect(verdictOf(base(), aft(20)).verdict).toBe('worse');
});

test('verdictOf: insufficient (mau nho / baseline it), het 21 ngay -> inconclusive', () => {
  const small = aft(0, { tool_calls: EFFECT.minToolCalls - 1 });
  expect(verdictOf(base(), small, { ageDays: 8 })).toMatchObject({ verdict: 'insufficient', reason: 'low_tool_calls' });
  expect(verdictOf(base({ target_count: 2, rate_per_1000: 2 }), aft(0), { ageDays: 8 })).toMatchObject({ verdict: 'insufficient', reason: 'low_baseline' });
  expect(verdictOf(base(), small, { ageDays: 21 }).verdict).toBe('insufficient');
  expect(verdictOf(base(), small, { ageDays: 21.5 })).toMatchObject({ verdict: 'inconclusive', reason: 'low_tool_calls' });
});

test('verdictOf: metric phu te hon >= 30% -> side, verdict khong doi', () => {
  const r = verdictOf(base(), aft(5, { tokens_per_session: 1300, corrections_per_session: 1.3 }));
  expect(r.verdict).toBe('better');
  expect(r.side).toEqual(['tokens_per_session', 'corrections_per_session']);
  expect(verdictOf(base(), aft(5, { tokens_per_session: 1299 })).side).toEqual([]);
});

test('computeWindow: dem dung, loai HookRun', () => {
  const stop = (ts, sid, ti, to) => ({ v: 2, ts, type: 'session', event: 'Stop', sid, ok: true, tokens_in: ti, tokens_out: to, data: {} });
  const sig = (ts, sid, s) => ev(ts, sid, { data: { signal: s } });
  day('2026-10-29', 's1', 20, 3, [{ v: 2, ts: '2026-10-29T03:00:00Z', type: 'hook', event: 'HookRun', sid: 's1', ok: false, data: { error: 'cannot find module foo' } },
    stop('2026-10-29T04:00:00Z', 's1', 600, 400), sig('2026-10-29T05:00:00Z', 's1', 'correction'), sig('2026-10-29T05:01:00Z', 's1', 'interrupt'), sig('2026-10-29T05:02:00Z', 's1', 'revert')]);
  day('2026-10-28', 's2', 10, 0, [stop('2026-10-28T04:00:00Z', 's2', 1000, 0)]);
  day('2026-10-10', 's3', 50, 5); // ngoai cua so
  const r = computeWindow(audit, FP, NOW - 7 * DAY, NOW, opts());
  expect(r.target_count).toBe(3);
  expect(r.tool_calls).toBe(20 + 3 + 3 + 10); // 20 ok + 3 loi + 3 ev tin hieu + 10; HookRun/Stop khong tinh
  expect(r.rate_per_1000).toBeCloseTo((3 * 1000) / 36, 5);
  expect(r.sessions).toBe(2);
  expect(r.tokens_per_session).toBe(1000);
  expect(r.corrections_per_session).toBe(1);
  expect(r.truncated).toBe(null);
});

test('measureDue: hai proposal den han -> MOT luot doc audit; chua den han / verdict cuoi bi bo qua', () => {
  day('2026-10-26', 's1', 300, 1); day('2026-10-27', 's1', 300, 1);
  let reads = 0;
  const ps = [prop('a'), prop('b'), prop('late', { applied_at: '2026-10-28T00:00:00Z' }),
    prop('done', { effect: { baseline: base(), verdict: 'worse' } }), prop('sk', { kind: 'skill' })];
  const out = measureDue(ps, NOW, opts({ onRead: () => { reads++; } }));
  expect(reads).toBe(1);
  expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  expect(out[0].effect).toMatchObject({ metric: 'target_rate_per_1000', verdict: 'better', action: 'keep' });
  expect(out[0].effect.after.target_count).toBe(2);
  expect(out[0].effect.baseline.target_count).toBe(10);
  expect(typeof out[0].effect.measured_at).toBe('string');
});

test('measureDue: unchanged/worse -> action rollback', () => {
  day('2026-10-26', 's1', 300, 3); day('2026-10-27', 's1', 300, 3);
  const [x] = measureDue([prop('a')], NOW, opts());
  expect(x.effect.verdict).toBe('unchanged');
  expect(x.effect.action).toBe('rollback');
});

test('measureDue: truncated -> insufficient reason truncated, khong hanh dong', () => {
  day('2026-10-26', 's1', 300, 1); day('2026-10-27', 's1', 300, 1);
  const [x] = measureDue([prop('a')], NOW, opts({ limits: { query_max_rows: 10 } }));
  expect(x.effect).toMatchObject({ verdict: 'insufficient', reason: 'truncated', action: 'none' });
});

test('measureDue: khong baseline -> tinh bu tu audit neu con trong cua so, khong thi no_baseline', () => {
  // apply 2026-10-20: baseline 10-13..10-20, con trong retention 30 ngay tinh tu NOW
  day('2026-10-15', 's0', 200, 4); day('2026-10-26', 's1', 300, 1); day('2026-10-27', 's1', 300, 1);
  const [x] = measureDue([prop('a', { effect: undefined })], NOW, opts());
  expect(x.effect.baseline).toMatchObject({ target_count: 4, tool_calls: 204 });
  expect(x.effect.verdict).toBe('better');
  const [y] = measureDue([prop('old', { effect: undefined, applied_at: '2026-09-01T00:00:00Z' })], NOW, opts());
  expect(y.effect).toMatchObject({ verdict: 'insufficient', reason: 'no_baseline' });
});
