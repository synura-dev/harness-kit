import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLedgerConfig, applyLedgerConfig, DEFAULTS } from './config.mjs';
import { loadDefinitions, evaluateAll } from './engine.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const c = (o) => ({ id: 'i', kind: 'error', fp: 'f1', count: 3, sessions: 2, first_ts: '2026-11-02T00:00:00Z', last_ts: '2026-11-05T00:00:00Z', sample: 'boom', ...o });
const emptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcfg-'));
const run = (cfg, cands) => {
  const defs = applyLedgerConfig(loadDefinitions({ evolveDir: null }).defs, cfg).filter((d) => d.id === 'repeated-error');
  return evaluateAll(defs, { candidates: cands }, { nowMs: NOW });
};

test('mac dinh: khop mac dinh trong code, JSON luat khop', () => {
  const dir = emptyDir();
  const cfg = loadLedgerConfig({ env: {}, root: dir, configDir: dir });
  assert.deepEqual(cfg, { threshold: 3, days: 7, minSessions: 2, exclude: [...DEFAULTS.repeatedErrorExclude] });
  assert.equal(run(cfg, [c({})]).length, 1);
  assert.equal(run(cfg, [c({ count: 2 })]).length, 0);
  assert.equal(run(cfg, [c({ sessions: 1 })]).length, 0);
  assert.equal(run(cfg, [c({ last_ts: '2026-10-20T00:00:00Z' })]).length, 0);
  assert.equal(run(cfg, [c({ sample: 'exit: thoat 2 Khong doc tho knowledge/; dung harness' })]).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ghi de qua env: nguong, cua so, phien, exclude', () => {
  const dir = emptyDir();
  const env = { HARNESS_LEDGER_REPEATED_ERROR_THRESHOLD: '5', HARNESS_LEDGER_REPEATED_ERROR_DAYS: '30', HARNESS_LEDGER_REPEATED_ERROR_MIN_SESSIONS: '1', HARNESS_LEDGER_REPEATED_ERROR_EXCLUDE: '["boom"]' };
  const cfg = loadLedgerConfig({ env, root: dir, configDir: dir });
  assert.equal(cfg.threshold, 5); assert.equal(cfg.days, 30); assert.equal(cfg.minSessions, 1); assert.deepEqual(cfg.exclude, ['boom']);
  assert.equal(run(cfg, [c({ count: 4, sample: 'x' })]).length, 0);
  assert.equal(run(cfg, [c({ count: 5, sessions: 1, sample: 'x', last_ts: '2026-10-20T00:00:00Z' })]).length, 1);
  assert.equal(run(cfg, [c({ count: 9, sample: 'boom' })]).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ghi de qua config/ledger/local.json; gia tri sai -> mac dinh', () => {
  const dir = emptyDir(); fs.mkdirSync(path.join(dir, 'ledger'));
  fs.writeFileSync(path.join(dir, 'ledger', 'local.json'), JSON.stringify({ repeatedErrorThreshold: 10, repeatedErrorExclude: [] }));
  const cfg = loadLedgerConfig({ env: {}, root: dir, configDir: dir });
  assert.equal(cfg.threshold, 10); assert.deepEqual(cfg.exclude, []);
  assert.equal(loadLedgerConfig({ env: { HARNESS_LEDGER_REPEATED_ERROR_THRESHOLD: 'abc' }, root: dir, configDir: emptyDir() }).threshold, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});
