import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mod, { handle, clutterOf, pruneState } from './hook.mjs';

const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-')); fs.mkdirSync(path.join(d, '.state'), { recursive: true }); return d; };
const cfg = { enabled: true, timeoutMs: 300, scanTimeoutMs: 300, cacheMaxAgeHours: 24, allowlist: [] };
const W = { rule: 'stray', path: 'a/b', key: 'k1', detail: 'd', fix: 'f' };
const put = (d, o) => fs.writeFileSync(path.join(d, '.state', 'data-scan.json'), JSON.stringify(o));
const ss = (d, sid, extra = {}) => handle('SessionStart', { session_id: sid }, { cfg, env: { HUB_DATA_DIR: d }, ...extra });

test('khong vi pham im lang', async () => {
  const d = mk(); put(d, { ts: new Date().toISOString(), warnings: [] });
  assert.deepEqual(await ss(d, 's1'), {});
});
test('co vi pham day <=5 dong, dedupe trong phien', async () => {
  const d = mk(); put(d, { ts: new Date().toISOString(), warnings: Array.from({ length: 9 }, (_, i) => ({ ...W, key: 'k' + i })) });
  const r = await ss(d, 's2');
  assert.match(r.additionalContext, /data-warn rule=stray/);
  assert.ok(r.additionalContext.split('\n').length <= 5);
  assert.doesNotMatch((await ss(d, 's2')).additionalContext, /key=k0\b/); // lan 2 chi con key chua day
  put(d, { ts: new Date().toISOString(), warnings: [{ ...W, key: 'k0' }] });
  assert.deepEqual(await ss(d, 's2'), {}); // k0 da day
});
test('cache cu tra ngay, spawn nen 1 lan (negative cache + lock)', async () => {
  const d = mk(); put(d, { ts: new Date(Date.now() - 48 * 3600e3).toISOString(), warnings: [W] });
  let called = 0; const spawnScan = () => { called++; };
  const t0 = Date.now();
  const r = await ss(d, 's3', { spawnScan });
  assert.ok(Date.now() - t0 < 300); assert.equal(called, 1); assert.match(r.additionalContext, /data-warn/);
  await ss(d, 's3b', { spawnScan }); assert.equal(called, 1); // negative cache
  fs.unlinkSync(path.join(d, '.state', 'data-check-tried.json'));
  await ss(d, 's3c', { spawnScan }); assert.equal(called, 1); // lock con han
  fs.writeFileSync(path.join(d, '.state', 'data-check-scan.lock'), JSON.stringify({ ts: Date.now() - 5 * 60e3 }));
  await ss(d, 's3d', { spawnScan }); assert.equal(called, 2); // lock het han
  const d2 = mk();
  assert.deepEqual(await ss(d2, 's4', { spawnScan }), {}); // cache vang -> {}
  assert.deepEqual(await ss(mk(), 's5', { spawnScan: () => { throw new Error('x'); } }), {});
});
test('don data-check-*.json cu', async () => {
  const d = mk(); const st = path.join(d, '.state');
  const old = path.join(st, 'data-check-old.json'); const nw = path.join(st, 'data-check-new.json');
  fs.writeFileSync(old, '[]'); fs.writeFileSync(nw, '[]');
  const t = new Date(Date.now() - 9 * 864e5); fs.utimesSync(old, t, t);
  assert.equal(pruneState(d, {}), 1);
  assert.ok(!fs.existsSync(old) && fs.existsSync(nw));
});
test('PostToolUse clutter', async () => {
  const root = mk();
  const go = (f) => handle('PostToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(root, f) } }, { cfg, root });
  assert.match((await go('docs/x.log')).additionalContext, /rule=clutter path=docs\/x\.log/);
  assert.match((await go('out.log')).additionalContext, /clutter/);
  for (const f of ['docs/x.md', 'README.md', 'harness/a.mjs', 'TASKS.md']) assert.deepEqual(await go(f), {}, f);
  assert.equal(clutterOf('docs/x.log', { allowlist: ['docs/x.log'] }, root), null);
});
test('disabled / loi -> {}', async () => {
  assert.deepEqual(await handle('SessionStart', {}, { cfg: { ...cfg, enabled: false } }), {});
  assert.deepEqual(await handle('PostToolUse', null, { cfg }), {});
  assert.deepEqual(await handle('PostToolUse', { tool_input: { file_path: {} } }, { cfg: { enabled: true, allowlist: 5 } }), {});
});
test('canh bao thu muc la 1 lan/ngay', async () => {
  const { unregisteredDirs } = await import('../../cli/harness.mjs');
  const d = mk(); fs.mkdirSync(path.join(d, 'zzodd'));
  const o = { env: { HUB_DATA_DIR: d } }; const w = process.stderr.write; let n = 0;
  process.stderr.write = () => { n++; return true; };
  try { assert.equal(unregisteredDirs(o), 'zzodd'); assert.equal(unregisteredDirs(o), 'zzodd'); } finally { process.stderr.write = w; }
  assert.equal(n, 1);
});
test('module shape', () => { assert.equal(mod.id, 'data-check'); assert.deepEqual(mod.events, ['SessionStart', 'PostToolUse']); });
test('real dispatcher PostToolUse', () => {
  const run = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'dispatch', 'run.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-'));
  const go = (f) => spawnSync(process.execPath, [run, 'PostToolUse'], { env: { ...process.env, HUB_DATA_DIR: tmp, CLAUDE_AUDIT_DIR: path.join(tmp, 'audit'), CLAUDE_PROJECT_DIR: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..') }, input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'dctest', tool_name: 'Write', tool_input: { file_path: f }, cwd: process.cwd() }), encoding: 'utf8', timeout: 8000 }).stdout;
  assert.match(go(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'zz.log')), /rule=clutter/);
  assert.doesNotMatch(go('docs/zz.md'), /clutter/);
});
