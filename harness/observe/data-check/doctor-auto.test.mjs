import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle, DEFAULTS, pruneTmp } from './hook.mjs';
import { runBatch, stateFile, runInWorker } from './doctor-auto.mjs';

const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'da-')); fs.mkdirSync(path.join(d, '.state'), { recursive: true }); fs.writeFileSync(path.join(d, '.state', 'data-scan.json'), JSON.stringify({ ts: new Date().toISOString(), warnings: [] })); return d; };
const cfg = { ...DEFAULTS, autoClean: { ...DEFAULTS.autoClean, enabled: false } };
const ss = (d, extra = {}) => handle('SessionStart', { session_id: 's' }, { cfg, env: { HUB_DATA_DIR: d }, ...extra });
const put = (d, o) => fs.writeFileSync(stateFile(d), JSON.stringify(o));

test('toi han 24h: spawn 1 lan (khoa); chua toi han: khong spawn', async () => {
  const d = mk(); let n = 0; const spawnDoctor = () => { n++; };
  put(d, { lastRun: Date.now() - 3600e3, errors: [], fresh: [], seen: true }); await ss(d, { spawnDoctor }); assert.equal(n, 0);
  put(d, { lastRun: Date.now() - 25 * 3600e3, errors: [], fresh: [], seen: true }); await ss(d, { spawnDoctor }); assert.equal(n, 1);
  await ss(d, { spawnDoctor }); assert.equal(n, 1);
});

test('canh bao loi moi: moi dong 1 loi, tran 5 dong, khong lap', async () => {
  const d = mk(); const spawnDoctor = () => {};
  const fresh = Array.from({ length: 8 }, (_, i) => `ref: a.md:${i} -> x`);
  put(d, { lastRun: Date.now(), errors: fresh, fresh, seen: false });
  const r = await ss(d, { spawnDoctor });
  const lines = r.additionalContext.split('\n').filter((l) => l.startsWith('doctor:'));
  assert.equal(lines.length, 6); assert.match(lines[5], /con 3 loi moi/);
  assert.deepEqual(await ss(d, { spawnDoctor }), {});
});

test('runBatch: chi loi MOI so voi lan truoc', async () => {
  const d = mk();
  await runBatch(d, '.', '.', 1, async () => ['a', 'b']);
  let st = JSON.parse(fs.readFileSync(stateFile(d), 'utf8')); assert.deepEqual(st.fresh, ['a', 'b']); assert.equal(st.seen, false);
  st.seen = true; fs.writeFileSync(stateFile(d), JSON.stringify(st));
  await runBatch(d, '.', '.', 2, async () => ['b', 'c']);
  st = JSON.parse(fs.readFileSync(stateFile(d), 'utf8')); assert.deepEqual(st.fresh, ['c']);
  await runBatch(d, '.', '.', 3, async () => ['b']);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile(d), 'utf8')).fresh, []);
});

test('tat bang env HOOK_DATA_CHECK_DOCTOR=0', async () => {
  const d = mk(); let n = 0;
  await handle('SessionStart', { session_id: 's' }, { cfg, env: { HUB_DATA_DIR: d, HOOK_DATA_CHECK_DOCTOR: '0' }, spawnDoctor: () => { n++; } }); assert.equal(n, 0);
});

test('pruneTmp: chi xoa *.tmp cu > 1h, giu file moi va file khac', () => {
  const d = mk(); const old = path.join(d, 'a.json.1.tmp'); const nw = path.join(d, 'b.json.2.tmp'); const other = path.join(d, 'c.json');
  for (const f of [old, nw, other]) fs.writeFileSync(f, 'x');
  const t = new Date(Date.now() - 2 * 3600e3); fs.utimesSync(old, t, t); fs.utimesSync(other, t, t);
  assert.equal(pruneTmp(d), 1);
  assert.ok(!fs.existsSync(old) && fs.existsSync(nw) && fs.existsSync(other));
});

test('SessionStart don tmp mo coi trong .state', async () => {
  const d = mk(); const f = path.join(d, '.state', 'x.json.99.tmp'); fs.writeFileSync(f, 'x');
  const t = new Date(Date.now() - 2 * 3600e3); fs.utimesSync(f, t, t);
  await ss(d, { spawnDoctor: () => {} }); assert.ok(!fs.existsSync(f));
});

test('runInWorker: worker quet dong bo vo han van bi ngat bang timeout cung', async () => {
  const d = mk(); const f = path.join(d, 'spin.mjs'); fs.writeFileSync(f, 'while (true) {}');
  const t = Date.now();
  assert.equal(await runInWorker(f, {}, 500), 'timeout');
  assert.ok(Date.now() - t < 5000);
  const ok = path.join(d, 'ok.mjs'); fs.writeFileSync(ok, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('x');");
  assert.equal(await runInWorker(ok, {}, 5000), 'done');
});
