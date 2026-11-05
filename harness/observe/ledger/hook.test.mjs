import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mod, { handle, kickJob } from './hook.mjs';
import { writeLedger, readLedger, ledgerFile, writeState, applyFindings } from './ledger.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lhook-'));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const finding = (fp) => ({ rule: 'r', fp, key: fp, count: 3, sessions: 1, first_ts: null, last_ts: new Date(NOW).toISOString(), sample: '', action: 'warn', cooldown_hours: 24, message: 'msg ' + fp, occ: [] });

test('module hop le, su kien khac -> {}', async () => {
  assert.equal(mod.id, 'ledger-warn');
  assert.deepEqual(await handle('PreToolUse', { session_id: 'x' }, {}), {});
  assert.deepEqual(await handle('SessionStart', null, {}), {});
});

test('hook chi doc state: khong co so -> {}; khong chay job nang (spawn chi khi het han)', async () => {
  const d = mk(); let spawned = 0;
  const r = await handle('UserPromptSubmit', { session_id: 's1' }, { env: { HUB_DATA_DIR: d }, nowMs: NOW, spawnJob: () => { spawned++; } });
  assert.deepEqual(r, {}); assert.equal(spawned, 0); // UserPromptSubmit khong kick
  fs.rmSync(d, { recursive: true, force: true });
});

test('phat <=3 dong, ghi warn_ts, khong lap lai o lan sau (cooldown)', async () => {
  const d = mk(); const env = { HUB_DATA_DIR: d };
  writeLedger(ledgerFile({ env }), applyFindings([], ['a', 'b', 'c', 'd', 'e'].map(finding), NOW).entries);
  const r = await handle('UserPromptSubmit', { session_id: 's1' }, { env, nowMs: NOW });
  assert.equal(r.additionalContext.split('\n').length, 3);
  const saved = readLedger(ledgerFile({ env }));
  assert.equal(saved.filter((e) => e.warn_ts.length === 1 && e.status === 'warned').length, 3);
  const r2 = await handle('UserPromptSubmit', { session_id: 's1' }, { env, nowMs: NOW + 1000 });
  assert.equal(r2.additionalContext.split('\n').length, 2); // 2 muc con lai, 3 muc dau dang cooldown
  assert.deepEqual(await handle('UserPromptSubmit', { session_id: 's1' }, { env, nowMs: NOW + 2000 }), {});
  fs.rmSync(d, { recursive: true, force: true });
});

test('SessionStart: kick job khi het han, 1 lan (khoa); state moi thi khong kick', async () => {
  const d = mk(); const env = { HUB_DATA_DIR: d }; let n = 0;
  const spawnJob = () => { n++; };
  assert.equal(kickJob({ env }, { spawnJob }, NOW), true);
  assert.equal(kickJob({ env }, { spawnJob }, NOW + 1000), false); // khoa
  assert.equal(n, 1);
  writeState({ env }, { lastRun: NOW });
  fs.rmSync(path.join(d, 'system', 'ledger', 'kick.json'), { force: true });
  assert.equal(kickJob({ env }, { spawnJob }, NOW + 30 * 60e3), false); // <1h
  assert.equal(kickJob({ env }, { spawnJob }, NOW + 61 * 60e3), true);
  fs.rmSync(d, { recursive: true, force: true });
});
