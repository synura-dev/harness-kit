import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRun, normalizeRun } from '../../core/io/runs-record.mjs';
import { queryRuns, runsFile, routedRunsFile } from './data-query.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dq-'));
const quiet = { warn: () => {} };
const T0 = Date.parse('2026-01-01T00:00:00Z');
const seed = (root, n = 6) => {
  const f = runsFile(root, 'gem', 'release');
  for (let i = 0; i < n; i++) appendRun(f, { ts: new Date(T0 + i * 3600000).toISOString(), run: `r${i}`, node: i % 2 ? 'gem-app' : 'gem-api', tool: 'release', status: i === 3 ? 'fail' : 'ok', cmd: 'deploy', durMs: i }, quiet);
  return f;
};

test('normalizeRun: truong co dinh, id->run, bo truong la, tu choi thieu node/status', () => {
  const a = normalizeRun({ id: 'x1', node: 'n', tool: 't', status: 'ok', extra: 1, env: { A: 'b' } });
  assert.equal(a.rec.run, 'x1'); assert.deepEqual(a.rec.artifacts, []);
  assert.ok(a.dropped.includes('extra') && a.dropped.includes('env(non-string)'));
  assert.ok(!('extra' in a.rec) && !('env' in a.rec));
  assert.equal(normalizeRun({ node: 'n', tool: 't', status: 'weird' }).rec, null);
  assert.equal(normalizeRun({ tool: 't', status: 'ok' }).rec, null);
  assert.equal(normalizeRun({ ts: 'hom nay', node: 'n', tool: 't', status: 'ok' }).rec, null);
  assert.equal(normalizeRun('x').rec, null);
});
test('appendRun: redact secret, cat summary/cmd, khong nem khi loi', () => {
  const root = mkRoot(); const f = path.join(root, 'workspaces', 'w', 't', 'runs.jsonl');
  const r = appendRun(f, { node: 'n', tool: 't', status: 'ok', cmd: 'deploy --token abc123secret password=hunter2 sk-ABCDEFGH12345', summary: 'x'.repeat(500), ref: 'https://h.io/p?key=1' }, quiet);
  assert.equal(r.ok, true);
  const line = JSON.parse(fs.readFileSync(f, 'utf8').trim());
  assert.ok(!/hunter2|abc123secret|ABCDEFGH12345|key=1/.test(JSON.stringify(line)), JSON.stringify(line));
  assert.equal(line.summary.length, 200);
  const warns = [];
  assert.equal(appendRun(f, { node: '../x', tool: 't', status: 'ok' }, { warn: (m) => warns.push(m) }).ok, false);
  assert.ok(warns.length > 0);
  assert.equal(appendRun(null, {}, quiet).ok, false);
  assert.equal(appendRun(path.join(f, 'sub', 'x.jsonl'), { node: 'n', tool: 't', status: 'ok' }, quiet).ok, false); // cha la file -> loi ghi, khong nem
  assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, 1);
});
test('appendRun: vuot maxBytes -> xoay .old', () => {
  const root = mkRoot(); const f = path.join(root, 'workspaces', 'w', 't', 'runs.jsonl'); const warns = [];
  for (let i = 0; i < 4; i++) appendRun(f, { node: 'n', tool: 't', status: 'ok', summary: 'y'.repeat(100) }, { maxBytes: 300, warn: (m) => warns.push(m) });
  assert.ok(fs.existsSync(f + '.old')); assert.ok(warns.some((w) => /rotation/.test(w)));
});
test('queryRuns: last, node, status, since, thu tu on dinh', () => {
  const root = mkRoot(); seed(root);
  const all = queryRuns({ root, ws: 'gem', tool: 'release', last: 200 });
  assert.deepEqual(all.rows.map((x) => x.run), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  assert.deepEqual(queryRuns({ root, ws: 'gem', tool: 'release', last: 2 }).rows.map((x) => x.run), ['r4', 'r5']);
  assert.deepEqual(queryRuns({ root, ws: 'gem', tool: 'release', node: 'gem-app' }).rows.map((x) => x.run), ['r1', 'r3', 'r5']);
  assert.deepEqual(queryRuns({ root, ws: 'gem', tool: 'release', status: 'fail' }).rows.map((x) => x.run), ['r3']);
  assert.deepEqual(queryRuns({ root, ws: 'gem', tool: 'release', since: new Date(T0 + 4 * 3600000).toISOString() }).rows.map((x) => x.run), ['r4', 'r5']);
  assert.equal(queryRuns({ root, ws: 'gem', tool: 'nope' }).rows.length, 0);
  assert.throws(() => queryRuns({ root, ws: '..', tool: 'x' }));
  assert.throws(() => queryRuns({ root, ws: 'gem', tool: 'release', status: 'bad' }));
  assert.throws(() => queryRuns({ root, ws: 'gem', tool: 'release', since: 'zzz' }));
});
test('queryRuns: maxBytes cat -> truncated; timeout -> truncated; dong hong bi bo', () => {
  const root = mkRoot(); const f = seed(root, 20); fs.appendFileSync(f, 'khong-phai-json\n');
  const q = queryRuns({ root, ws: 'gem', tool: 'release', maxBytes: 600, last: 200 });
  assert.match(q.truncated, /^max-bytes/); assert.ok(q.rows.length > 0 && q.rows.length < 20);
  assert.equal(q.rows.at(-1).run, 'r19');
  assert.equal(queryRuns({ root, ws: 'gem', tool: 'release', deadline: Date.now() - 1 }).truncated, 'timeout');
});
test('CLI data query qua goc data tam: text, --json, loi tham so', () => {
  const root = mkRoot(); seed(root);
  const run = (...a) => spawnSync(process.execPath, [path.join(HERE, 'data.mjs'), 'query', ...a], { env: { ...process.env, HUB_DATA_DIR: root }, encoding: 'utf8', timeout: 30000 });
  const t = run('gem', 'release', '--last', '2', '--status', 'ok');
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /r5/); assert.doesNotMatch(t.stdout, /r3/);
  const j = run('gem', 'release', '--node', 'gem-api', '--last', '--json');
  assert.equal(j.status, 0, j.stderr);
  assert.deepEqual(JSON.parse(j.stdout).rows.map((x) => x.run), ['r0', 'r2', 'r4']);
  assert.notEqual(run('gem').status, 0);
  assert.notEqual(run('gem', 'release', '--bogus').status, 0);
});
test('routedRunsFile: tool co entry mau -> dataPathFor (shared), khong mau -> duong tay', () => {
  const root = mkRoot();
  const registry = { entries: {}, reserved: [], patterns: { release: { tool: 'release', zone: 'workspaces', class: 'durable', owner: 'o' } } };
  assert.equal(routedRunsFile(root, 'gem', 'release', { registry, warn: () => {} }), path.join(root, 'workspaces', 'gem', 'release', 'runs.jsonl'));
  assert.equal(routedRunsFile(root, 'gem', 'other', { registry }), runsFile(root, 'gem', 'other'));
  // ban ghi cu o <tool>/runs.jsonl van doc duoc qua dinh tuyen
  const f = seed(root);
  assert.equal(routedRunsFile(root, 'gem', 'release', { registry }), f);
  assert.equal(queryRuns({ root, ws: 'gem', tool: 'release', hookOpts: { registry } }).rows.length, 6);
});
