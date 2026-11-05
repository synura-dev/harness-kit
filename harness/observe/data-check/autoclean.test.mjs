import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle, DEFAULTS } from './hook.mjs';

const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-')); fs.mkdirSync(path.join(d, '.state'), { recursive: true }); fs.writeFileSync(path.join(d, '.state', 'data-scan.json'), JSON.stringify({ ts: new Date().toISOString(), warnings: [] })); return d; };
const cfg = { ...DEFAULTS, autoClean: { ...DEFAULTS.autoClean } };
const sf = (d) => path.join(d, '.state', 'data-check-clean.json');
const ss = (d, extra = {}, env = {}) => handle('SessionStart', { session_id: 's' }, { cfg, env: { HUB_DATA_DIR: d, HOOK_DATA_CHECK_DOCTOR: '0', ...env }, ...extra });

test('chua toi han: khong spawn; toi han: spawn 1 lan (khoa)', async () => {
  const d = mk(); let n = 0; const spawnClean = () => { n++; };
  fs.writeFileSync(sf(d), JSON.stringify({ lastRun: Date.now() - 3600e3, done: true, seen: true, files: 0 }));
  await ss(d, { spawnClean }); assert.equal(n, 0);
  fs.writeFileSync(sf(d), JSON.stringify({ lastRun: Date.now() - 25 * 3600e3, done: true, seen: true, files: 0 }));
  await ss(d, { spawnClean }); assert.equal(n, 1);
  await ss(d, { spawnClean }); assert.equal(n, 1); // khoa 5 phut
  fs.writeFileSync(path.join(d, '.state', 'data-check-clean.lock'), JSON.stringify({ ts: Date.now() - 6 * 60e3 }));
  await ss(d, { spawnClean }); assert.equal(n, 2);
});

test('ket qua phien sau: 1 dong, N=0 im lang, khong lap', async () => {
  const d = mk(); const spawnClean = () => {};
  fs.writeFileSync(sf(d), JSON.stringify({ lastRun: Date.now(), done: true, seen: false, files: 3, bytes: 2097152, ts: '2026-10-30T01:00:00Z' }));
  const r = await ss(d, { spawnClean });
  assert.match(r.additionalContext, /data-clean: da don 3 file \(2\.0 MB\) tu 2026-10-30/);
  assert.deepEqual(await ss(d, { spawnClean }), {});
  fs.writeFileSync(sf(d), JSON.stringify({ lastRun: Date.now(), done: true, seen: false, files: 0, bytes: 0 }));
  assert.deepEqual(await ss(d, { spawnClean }), {});
  fs.writeFileSync(sf(d), JSON.stringify({ lastRun: Date.now(), done: false, seen: false, error: 'boom' }));
  assert.match((await ss(d, { spawnClean })).additionalContext, /data-clean: loi boom/);
});

test('cong tac env va enabled=false tat; fail-open', async () => {
  const d = mk(); let n = 0; const spawnClean = () => { n++; };
  await ss(d, { spawnClean }, { HOOK_DATA_CHECK_AUTOCLEAN: '0' }); assert.equal(n, 0);
  await handle('SessionStart', { session_id: 's' }, { cfg: { ...cfg, autoClean: { ...cfg.autoClean, enabled: false } }, env: { HUB_DATA_DIR: d, HOOK_DATA_CHECK_DOCTOR: '0' }, spawnClean }); assert.equal(n, 0);
  assert.deepEqual(await ss(mk(), { spawnClean: () => { throw new Error('x'); } }), {});
});

test('contract background: write:false (dispatcher) van spawn clean; background:false thi khong', async () => {
  const d = mk(); let n = 0; const spawnClean = () => { n++; };
  fs.writeFileSync(sf(d), JSON.stringify({ lastRun: Date.now() - 25 * 3600e3, done: true, seen: true, files: 0 }));
  assert.deepEqual(await ss(d, { write: false, background: false }), {}); // spawn mac dinh bi no-op, khong nem (seam spawnClean cua test van duoc giu)
  fs.rmSync(path.join(d, '.state', 'data-check-clean.lock'), { force: true });
  fs.writeFileSync(sf(d), JSON.stringify({ lastRun: Date.now() - 25 * 3600e3, done: true, seen: true, files: 0 }));
  await ss(d, { spawnClean, write: false, background: true }); assert.equal(n, 1);
});
