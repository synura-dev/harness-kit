import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle, kickJob } from './hook.mjs';
import { runJob } from './job.mjs';
import { render } from './cli.mjs';
import { spawnBackground } from '../../core/runtime/proc.mjs';
import { readState, writeState, recordJobError, jobHealth, ledgerDir, JOB } from './ledger.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jerr-'));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

test('dispatcher truyen write:false van kick job (nguyen nhan goc: job khong bao gio chay)', async () => {
  const d = mk(); let n = 0;
  await handle('SessionStart', { session_id: 's' }, { env: { HUB_DATA_DIR: d }, nowMs: NOW, write: false, spawnJob: () => { n++; } });
  assert.equal(n, 1);
  rm(d);
});

test('kick: spawnJob nem loi -> state.lastError kind=kick', () => {
  const d = mk(); const env = { HUB_DATA_DIR: d };
  assert.equal(kickJob({ env }, { spawnJob: () => { throw new Error('boom'); } }, NOW), false);
  const st = readState({ env });
  assert.match(st.lastError, /^kick: boom/); assert.equal(st.lastErrorAt, NOW);
  rm(d);
});

test('spawnBackground: onError nhan loi spawn (cmd khong ton tai / loi dong bo)', async () => {
  const errs = [];
  const bad = spawnBackground({ cmd: path.join(os.tmpdir(), 'khong-ton-tai-xyz.exe'), args: [], key: 'jerr-bad', dir: mk(), onError: (w) => errs.push(w) });
  assert.equal(bad, null);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(errs.length >= 1 && /^spawn/.test(errs[0]));
  assert.equal(spawnBackground({ cmd: 'x', args: [], key: 'k', env: null, dir: 5, onError: () => { throw new Error('cb'); } }), null); // callback loi khong nem
});

test('lan kick truoc khong ghi lastRun (job chet/timeout cung) -> unfinished', () => {
  const d = mk(); const env = { HUB_DATA_DIR: d };
  kickJob({ env }, { spawnJob: () => {} }, NOW);
  assert.equal(readState({ env }).lastError, undefined);
  kickJob({ env }, { spawnJob: () => {} }, NOW + (JOB.lockMinutes + 1) * 60e3);
  assert.match(readState({ env }).lastError, /^unfinished/);
  rm(d);
});

test('runJob chay tron ghi lastRun va xoa loi cu', async () => {
  const d = mk(); const env = { HUB_DATA_DIR: d }; const dataOpts = { env };
  const base = { dataOpts, nowMs: NOW, events: [], hubDir: d, projectDir: null };
  recordJobError(dataOpts, 'exit', 'cu', NOW - 5000);
  const r = await runJob({ ...base });
  assert.equal(r.truncated, null);
  assert.equal(readState(dataOpts).lastError, undefined); // chay tron xoa loi cu
  assert.equal(jobHealth(readState(dataOpts)), null);
  rm(d);
});

test('jobHealth + hook: loi hien 1 lan qua additionalContext, cooldown; observe ledger hien; loi cu hon lastRun thi im', async () => {
  const d = mk(); const env = { HUB_DATA_DIR: d }; const dataOpts = { env };
  recordJobError(dataOpts, 'timeout', 'job qua 60s', NOW - 1000);
  const ctx = { env, nowMs: NOW, cfg: { kick: false }, spawnJob: () => {}, spawnReport: () => {}, sweep: false };
  const r1 = await handle('SessionStart', { session_id: 's' }, ctx);
  assert.match(r1.additionalContext, /ledger\[job\].*timeout: job qua 60s/);
  const r2 = await handle('SessionStart', { session_id: 's' }, { ...ctx, nowMs: NOW + 3600e3 });
  assert.ok(!r2.additionalContext || !/ledger\[job\]/.test(r2.additionalContext)); // cooldown
  const r3 = await handle('SessionStart', { session_id: 's' }, { ...ctx, nowMs: NOW + 25 * 3600e3 });
  assert.match(r3.additionalContext, /ledger\[job\]/); // het cooldown
  const out = render({ limit: 5 }, path.join(ledgerDir(dataOpts), 'ledger.jsonl'), readState(dataOpts));
  assert.match(out.summary, /\[warn\] job loi: timeout/);
  writeState(dataOpts, { lastRun: NOW + 30 * 3600e3, lastError: 'x', lastErrorAt: NOW });
  assert.equal(jobHealth(readState(dataOpts)), null);
  rm(d);
});
