import { test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sinceToIso, aliasOf, costOf, cheaperPossible, collectRuns, summary, top } from './cost.mjs';
import { parseCostArgs } from './cli.mjs';

let root;
const day = new Date().toISOString().slice(0, 10);
const ts = (t) => `${day}T${t}Z`;
const sub = (event, t, id, role, extra = {}) => ({ v: 2, ts: ts(t), type: 'subagent', event, sid: 'claude-s1', agent_id: id, agent_type: role, actor: 'sub',
  turns: null, tokens_in: null, tokens_out: null, model: null, data: {}, ...extra });
const write = (type, sid, recs) => {
  const d = path.join(root, `date=${day}`, `type=${type}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
const main = (t, turns, tin, tout, cache) => ({ v: 2, ts: ts(t), type: 'session', event: 'Stop', sid: 'claude-s1', actor: 'main', turns, tokens_in: tin, tokens_out: tout, model: 'claude-sonnet-5-5', data: { tokens_cache: cache } });
const PRICES = { prices: { haiku: { in: 1, out: 5, cache: 0.1 }, sonnet: { in: 3, out: 15, cache: 0.3 }, opus: { in: 15, out: 75, cache: 1.5 } }, rank: { haiku: 1, sonnet: 2, opus: 3 } };
const POLICY = { roles: { scout: { model: 'haiku' }, builder: { model: 'sonnet' } } };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'));
  write('subagent', 'claude-s1', [
    sub('SubagentStart', '01:00:00', 'a1', 'scout'),
    sub('SubagentStop', '01:01:00', 'a1', 'scout', { turns: 5, tokens_in: 1000, tokens_out: 200, model: 'claude-opus-5-5', data: { tokens_cache: 10000 } }),
    sub('SubagentStart', '02:00:00', 'a2', 'builder'),
    sub('SubagentStop', '02:10:00', 'a2', 'builder', { turns: 9, tokens_in: 5000, tokens_out: 900, model: 'claude-sonnet-5-5', data: { tokens_cache: 20000 } }),
  ]);
  write('session', 'claude-s1', [main('03:00:00', 1, 100, 10, 0), main('03:05:00', 2, 150, 30, 500)]);
});

test('sinceToIso / aliasOf / parseCostArgs', () => {
  expect(sinceToIso('1d', Date.parse('2026-10-29T00:00:00Z'))).toBe('2026-10-28T00:00:00.000Z');
  expect(() => sinceToIso('xyz')).toThrow();
  expect(aliasOf('claude-haiku-5-5')).toBe('haiku');
  expect(aliasOf('gpt')).toBeNull();
  expect(parseCostArgs(['summary', '--by', 'role', '--since=2d', '--json']).by).toBe('role');
  expect(() => parseCostArgs(['summary', '--by', 'x'])).toThrow();
});

test('costOf: thieu gia -> null, co gia -> tinh dung', () => {
  const r = { model: 'claude-sonnet-5-5', tokens_in: 1e6, tokens_out: 1e6, tokens_cache: 1e6 };
  expect(costOf(r, PRICES)).toBeCloseTo(18.3, 6);
  expect(costOf(r, { prices: { sonnet: { in: null, out: 1, cache: 1 } } })).toBeNull();
  expect(costOf(r, {})).toBeNull();
  expect(costOf({ model: 'x', tokens_in: 1 }, PRICES)).toBeNull();
});

test('cheaperPossible theo chinh sach', () => {
  expect(cheaperPossible({ role: 'scout', model: 'claude-opus-5-5' }, POLICY, PRICES)).toBe(true);
  expect(cheaperPossible({ role: 'scout', model: 'claude-haiku-5-5' }, POLICY, PRICES)).toBe(false);
  expect(cheaperPossible({ role: 'main', model: 'claude-opus-5-5' }, POLICY, PRICES)).toBe(false);
  expect(cheaperPossible({ role: 'scout', model: 'claude-opus-5-5' }, null, PRICES)).toBe(false);
});

test('collectRuns: thoi luong tu Start/Stop; main lay ban ghi tich luy cuoi', async () => {
  const c = await collectRuns({ root, since: '2d' });
  expect(c.runs.length).toBe(3);
  expect(c.runs.find((r) => r.agent_id === 'a1').dur_ms).toBe(60000);
  const m = c.runs.find((r) => r.kind === 'main');
  expect(m.tokens_in).toBe(150);
  expect(m.tokens_cache).toBe(500);
});

test('summary theo role/model + cost null khi chua co gia; co gia thi co cost', async () => {
  const s0 = await summary({ root, since: '2d', by: 'role', cfg: { prices: {}, rank: PRICES.rank }, policy: POLICY });
  expect(s0.total.runs).toBe(3);
  expect(s0.total.cost).toBeNull();
  expect(s0.total.cheaper_possible).toBe(1);
  const s1 = await summary({ root, since: '2d', by: 'model', cfg: PRICES, policy: POLICY });
  expect(s1.groups.map((g) => g.key)).toContain('claude-opus-5-5');
  expect(s1.total.cost).toBeGreaterThan(0);
  const s2 = await summary({ root, since: '2d', by: 'day', cfg: PRICES, policy: null });
  expect(s2.groups.length).toBe(1);
  expect(s2.total.cheaper_possible).toBe(0);
});

test('top: sap xep + co cheaper_possible chi khi co chinh sach', async () => {
  const t = await top({ root, since: '2d', limit: 2, cfg: PRICES, policy: POLICY });
  expect(t.items.length).toBe(2);
  expect(t.total).toBe(3);
  expect(t.items[0].cost).toBeGreaterThanOrEqual(t.items[1].cost);
  const opus = (await top({ root, since: '2d', cfg: PRICES, policy: POLICY })).items.find((x) => x.role === 'scout');
  expect(opus.cheaper_possible).toBe(true);
  const np = await top({ root, since: '2d', cfg: PRICES, policy: null });
  expect('cheaper_possible' in np.items[0]).toBe(false);
});

test('tran byte -> truncated max_bytes; thieu thu muc -> rong', async () => {
  const c = await collectRuns({ root, since: '2d', readMaxBytes: 10 });
  expect(c.truncated).toBe('max_bytes');
  const e = await collectRuns({ root: path.join(root, 'none'), since: '2d' });
  expect(e.runs).toEqual([]);
});
