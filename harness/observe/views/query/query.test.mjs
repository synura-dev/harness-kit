import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runReport, listFiles, duckdbAvailable } from './query.mjs';
import { prune } from '../prune.mjs';

let root, outside;
const ev = (o) => JSON.stringify({ v: 1, ts: '2026-10-20T10:00:00Z', type: 'tool', event: 'post', session_id: 's1', agent: null, cwd: '/x', tool: 'Edit', target: 'a.ts', ok: true, dur_ms: 10, data: {}, ...o });
const put = (type, date, name, lines) => {
  const d = join(root, `type=${type}`, `date=${date}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), lines.join('\n') + '\n');
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'audit-root-'));
  outside = mkdtempSync(join(tmpdir(), 'audit-out-'));
  writeFileSync(join(outside, 'keep.txt'), 'x');
  process.env.CLAUDE_AUDIT_DIR = root;
  put('tool', '2026-10-20', 's1.jsonl', [
    ev({ ts: '2026-10-20T10:00:01Z' }),
    'khong phai json {{{',
    ev({ ts: '2026-10-20T10:00:02Z', agent: { id: 'a1', type: 'builder' }, tool: 'Write', target: 'b.ts', dur_ms: 500 }),
    ev({ ts: '2026-10-20T10:00:03Z', tool: 'Bash', target: 'ls', ok: false, dur_ms: 90, data: { input_tokens: 5, output_tokens: 7 } }),
    '',
  ]);
  put('tool', '2026-10-21', 's2.jsonl', [ev({ session_id: 's2', ts: '2026-10-21T09:00:00Z', tool: 'Read', target: 'a.ts', dur_ms: null })]);
  put('prompt', '2026-10-20', 's1.jsonl', [ev({ type: 'prompt', event: 'submit', tool: null, target: null, ok: null, dur_ms: null })]);
  put('tool', '2026-01-01', 'old.jsonl', [ev({ session_id: 'old' })]);
  mkdirSync(join(root, '.state'), { recursive: true });
  writeFileSync(join(root, '.state', 'x.jsonl'), ev({}));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

const node = (name, f = {}) => runReport(name, f, { backend: 'node', root });

test('cat tia phan vung', () => {
  expect(listFiles(root, { type: 'prompt' }).length).toBe(1);
  expect(listFiles(root, { date: '2026-10-21' }).map((f) => f.type)).toEqual(['tool']);
  expect(listFiles(root, { since: '2026-10-20', until: '2026-10-20' }).length).toBe(2);
  expect(listFiles(root, {}).some((f) => f.path.includes('.state'))).toBe(false);
});

test('dong hong bi bo qua', async () => {
  const r = await node('events', { date: '2026-10-20', type: 'tool' });
  expect(r.sections[0].rows.length).toBe(3);
});

test('summary / slow / errors / writes / hot-files / tokens / subagents', async () => {
  const f = { since: '2026-10-20', until: '2026-10-21' };
  const s = await node('summary', f);
  expect(s.sections[0].rows.find((x) => x.type === 'tool').n).toBe(4);
  expect((await node('slow', f)).sections[0].rows[0].dur_ms).toBe(500);
  expect((await node('errors', f)).sections[0].rows.map((x) => x.tool)).toEqual(['Bash']);
  const w = await node('writes', f);
  expect(w.sections[0].rows).toEqual([{ actor: 'main', n: 1 }, { actor: 'sub', n: 1 }]);
  expect((await node('hot-files', f)).sections[0].rows[0]).toEqual({ target: 'a.ts', n: 2 });
  expect((await node('tokens', f)).sections[0].rows).toEqual([{ session_id: 's1', actor: 'main', agent_id: null, in_tok: 5, out_tok: 7 }]);
  expect((await node('subagents', f)).sections[0].rows[0].agent_id).toBe('a1');
  expect((await node('events', { session: 's2' })).sections[0].rows.length).toBe(1);
  expect((await node('events', { agent: 'builder' })).sections[0].rows.length).toBe(1);
});

test('checkpoint report', async () => {
  const r = await node('checkpoint', { session: 's1', date: '2026-10-20' });
  expect(r.report).toBe('checkpoint');
  expect(r.sections.length).toBe(4);
  expect(r.sections.map((s) => s.title)).toEqual(['last_prompt', 'edits_and_commits', 'errors_and_unresolved', 'stop_summary']);
});

test('timeline can --session', async () => {
  await expect(node('timeline')).rejects.toThrow('--session');
  expect((await node('timeline', { session: 's1', date: '2026-10-20' })).sections[0].rows.length).toBe(4);
});

test('prune dry-run khong xoa, --yes xoa dung phan cu, khong dung ngoai root', () => {
  const now = new Date('2026-10-24T00:00:00Z');
  const d = prune({ root, days: 30, now });
  expect(d.dryRun).toBe(true);
  expect(d.removed.length).toBe(1);
  expect(existsSync(join(root, 'type=tool', 'date=2026-01-01'))).toBe(true);
  const y = prune({ root, days: 30, yes: true, now, onceDay: true });
  expect(y.removed.length).toBe(1);
  expect(existsSync(join(root, 'type=tool', 'date=2026-01-01'))).toBe(false);
  expect(existsSync(join(root, 'type=tool', 'date=2026-10-20'))).toBe(true);
  expect(existsSync(join(root, '.state', 'x.jsonl'))).toBe(true);
  expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  expect(prune({ root, days: 0, yes: true, now, onceDay: true }).skipped).toBeTruthy();
});

test('backend node chay khi khong co duckdb', async () => {
  const r = await runReport('summary', {}, { backend: 'node', root });
  expect(r.backend).toBe('node');
});

const hasDuck = !!duckdbAvailable();
(hasDuck ? test : test.skip)('duckdb va node cho ket qua giong nhau (skip neu khong co duckdb)', async () => {
  const f = { since: '2026-10-20', until: '2026-10-21', session: undefined };
  for (const name of ['summary', 'slow', 'errors', 'writes', 'hot-files', 'tokens', 'subagents', 'events']) {
    const a = await runReport(name, f, { backend: 'node', root });
    const b = await runReport(name, f, { backend: 'duckdb', root });
    expect(b.backend.startsWith('duckdb')).toBe(true);
    expect(b.sections).toEqual(a.sections);
  }
  const a = await runReport('timeline', { session: 's1' }, { backend: 'node', root });
  const b = await runReport('timeline', { session: 's1' }, { backend: 'duckdb', root });
  expect(b.sections).toEqual(a.sections);
});

test('gioi han: max_rows cat va bao truncated', async () => {
  const r = await runReport('events', {}, { backend: 'node', root, maxRows: 2 });
  expect(r.truncated).toBe('max_rows');
  expect(r.sections[0].rows.length).toBeLessThanOrEqual(2);
});
test('gioi han: max_bytes dung som', async () => {
  const r = await runReport('events', {}, { backend: 'node', root, maxBytes: 1 });
  expect(r.truncated).toBe('max_bytes');
  expect(r.files).toBeGreaterThan(0);
});
test('gioi han: timeout dung em, khong treo', async () => {
  const t0 = Date.now();
  const r = await runReport('events', {}, { backend: 'node', root, timeoutMs: 1 });
  await new Promise((x) => setTimeout(x, 0));
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(r.truncated === 'timeout' || r.truncated === null).toBe(true);
});
test('du lieu nho: khong truncated', async () => {
  const r = await runReport('events', {}, { backend: 'node', root });
  expect(r.truncated).toBeNull();
});
test('cli --timeout: gia tri sai bi tu choi, gia tri hop le chay', async () => {
  const { spawnSync } = await import('node:child_process');
  const q = join(dirname(fileURLToPath(import.meta.url)), 'query.mjs');
  const env = { ...process.env, CLAUDE_AUDIT_DIR: root };
  expect(spawnSync(process.execPath, [q, '--timeout', '0'], { env, encoding: 'utf8', timeout: 20000 }).status).toBe(1);
  const ok = spawnSync(process.execPath, [q, '--backend', 'node', '--timeout', '5', '--max-rows', '1'], { env, encoding: 'utf8', timeout: 20000 });
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('truncated: max_rows');
});
test('prune: timeout tong dung em', () => {
  const r = prune({ root, days: 0, yes: false, timeoutMs: -1 });
  expect(r.truncated === null || r.truncated === 'timeout').toBe(true);
});

test('prune: data/runs/*.log|json cu theo mtime; dry-run khong xoa', async () => {
  const { utimesSync, mkdtempSync: mk } = await import('node:fs');
  const base = mk(join(tmpdir(), 'prune-runs-'));
  const aroot = join(base, 'audit'), runs = join(base, 'runs');
  mkdirSync(aroot, { recursive: true }); mkdirSync(runs, { recursive: true });
  for (const n of ['old.log', 'old.json', 'new.log', 'x.txt']) writeFileSync(join(runs, n), 'x');
  const old = new Date('2026-01-01T00:00:00Z');
  for (const n of ['old.log', 'old.json', 'x.txt']) utimesSync(join(runs, n), old, old);
  utimesSync(join(runs, 'new.log'), new Date('2026-10-23T00:00:00Z'), new Date('2026-10-23T00:00:00Z'));
  const now = new Date('2026-10-24T00:00:00Z');
  try {
    const d = prune({ root: aroot, runsRoot: runs, days: 30, now });
    expect(d.removed.map((p) => basename(p)).sort()).toEqual(['old.json', 'old.log']);
    expect(existsSync(join(runs, 'old.log'))).toBe(true);
    prune({ root: aroot, runsRoot: runs, days: 30, now, yes: true });
    expect(existsSync(join(runs, 'old.log'))).toBe(false);
    expect(existsSync(join(runs, 'new.log'))).toBe(true);
    expect(existsSync(join(runs, 'x.txt'))).toBe(true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
