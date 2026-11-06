import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLedgerConfig, applyLedgerConfig } from './config.mjs';
import { loadDefinitions, evaluateAll } from './engine.mjs';
import { runJob } from './job.mjs';
import { readState } from './ledger.mjs';
import { cfgWarnLine } from './hook.mjs';
import { render } from './cli.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const c = (o) => ({ id: 'i', kind: 'error', fp: 'f1', count: 3, sessions: 2, first_ts: '2026-11-02T00:00:00Z', last_ts: '2026-11-05T00:00:00Z', sample: 'boom', ...o });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lcfg-'));
const P = 'HARNESS_LEDGER_REPEATED_ERROR_';
const load = (env, dir = tmp()) => loadLedgerConfig({ env, root: dir, configDir: dir });
const machine = (obj) => { const d = tmp(); fs.mkdirSync(path.join(d, 'ledger')); fs.writeFileSync(path.join(d, 'ledger', 'local.json'), JSON.stringify(obj)); return d; };
const run = (cfg, cands, ctx = {}) => {
  const defs = applyLedgerConfig(loadDefinitions({ evolveDir: null }).defs, cfg).filter((d) => d.id === 'repeated-error');
  return evaluateAll(defs, { candidates: cands }, { nowMs: NOW, ...ctx });
};

test('mac dinh (JSON la nguon duy nhat): khong ghi de, hanh vi 3 lan / 2 phien / 7 ngay / exclude rong', () => {
  const cfg = load({});
  assert.deepEqual(cfg.values, {}); assert.deepEqual(cfg.warnings, []);
  assert.deepEqual(cfg.base, { threshold: 3, days: 7, min_sessions: 2, exclude: [] });
  assert.equal(run(cfg, [c({})]).length, 1);
  assert.equal(run(cfg, [c({ count: 2 })]).length, 0);
  assert.equal(run(cfg, [c({ sessions: 1 })]).length, 0);
  assert.equal(run(cfg, [c({ last_ts: '2026-10-20T00:00:00Z' })]).length, 0);
  assert.equal(run(cfg, [c({ sample: 'exit: thoat 2 Khong doc tho knowledge/' })]).length, 1);
});

test('(b) env NOI luat bi bo qua + warning; env SIET duoc nhan', () => {
  const loose = load({ [P + 'THRESHOLD']: '999', [P + 'EXCLUDE']: '[".*"]', [P + 'MIN_SESSIONS']: '5', [P + 'DAYS']: '1' });
  assert.deepEqual(loose.values, {});
  assert.ok(loose.warnings.length >= 4 && loose.warnings.every((w) => /bi bo/.test(w)), loose.warnings.join('|'));
  assert.equal(run(loose, [c({ count: 4 })]).length, 1); // luat van song
  const tight = load({ [P + 'THRESHOLD']: '2', [P + 'MIN_SESSIONS']: '1', [P + 'DAYS']: '30' });
  assert.deepEqual(tight.values, { threshold: 2, min_sessions: 1, days: 30 });
  assert.equal(run(tight, [c({ count: 2, sessions: 1 })]).length, 1);
});

test('(b) tang machine NOI duoc nhan + warning; exclude hoat dong', () => {
  const cfg = load({}, machine({ repeatedErrorThreshold: 10, repeatedErrorExclude: ['boom'] }));
  assert.deepEqual(cfg.values, { threshold: 10, exclude: ['boom'] });
  assert.ok(cfg.warnings.some((w) => /noi luat repeated-error \(tang machine\)/.test(w)));
  assert.equal(run(cfg, [c({ count: 9 })]).length, 0);
  assert.equal(run(cfg, [c({ count: 10, sample: 'zzz' })]).length, 1);
  assert.equal(run(cfg, [c({ count: 50, sample: 'boom' })]).length, 0);
});

test('gia tri sai (boolean, <1, chuoi) -> bo + warning, dung mac dinh', () => {
  const cfg = load({ [P + 'THRESHOLD']: 'true', [P + 'MIN_SESSIONS']: '0', [P + 'DAYS']: '"abc"' });
  assert.deepEqual(cfg.values, {});
  assert.equal(cfg.warnings.length, 3);
});

test('(a) override du an (threshold 2) khong bi ghi de boi cau hinh', () => {
  const proj = tmp(); fs.mkdirSync(path.join(proj, '.harness', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.harness', 'rules', 'repeated-error.json'), JSON.stringify({ threshold: 2 }));
  const raw = loadDefinitions({ evolveDir: null, projectDir: proj, trusted: () => true }).defs;
  assert.equal(raw.find((d) => d.id === 'repeated-error').threshold, 2);
  const none = applyLedgerConfig(raw, load({}));
  assert.equal(none.find((d) => d.id === 'repeated-error').threshold, 2);
  const tight = applyLedgerConfig(raw, load({ [P + 'DAYS']: '14' }));
  const d = tight.find((x) => x.id === 'repeated-error');
  assert.equal(d.threshold, 2); assert.equal(d.days, 14);
  const m = applyLedgerConfig(raw, load({}, machine({ repeatedErrorThreshold: 8 })));
  assert.equal(m.find((x) => x.id === 'repeated-error').threshold, 2); // du an siet hon -> chat hon thang
});

test('(c) regex exclude sai -> warning, van canh bao (fail-open)', () => {
  const cfg = load({}, machine({ repeatedErrorExclude: ['(unclosed'] }));
  const warns = [];
  assert.equal(run(cfg, [c({})], { warn: (w) => warns.push(w) }).length, 1);
  assert.equal(warns.length, 1); assert.match(warns[0], /regex exclude sai/);
});

test('(d) nhieu candidate cung fp: cong sessions/count qua nguong', () => {
  const cfg = load({});
  const f = run(cfg, [c({ count: 2, sessions: 1 }), c({ count: 2, sessions: 1 })]);
  assert.equal(f.length, 1); assert.equal(f[0].count, 4); assert.equal(f[0].sessions, 2);
  assert.equal(run(cfg, [c({ count: 2, sessions: 1 })]).length, 0);
});

test('job chay nen: canh bao cau hinh (machine noi + regex sai) luu state, doc lai duoc, hook hien 1 lan', async () => {
  const dir = tmp(); const dataOpts = { env: { HUB_DATA_DIR: dir } };
  const ledgerConfig = load({}, machine({ repeatedErrorThreshold: 10, repeatedErrorExclude: ['(unclosed'] }));
  const job = () => runJob({ events: [], nowMs: NOW, hubDir: 'E:/hub', dataOpts, projectDir: null, ledgerConfig });
  await job(); await job(); // chay lai: khong nhan doi
  const st = readState(dataOpts);
  assert.equal(st.cfgWarnings.length, 3); // noi threshold + noi exclude + regex sai
  assert.ok(st.cfgWarnings.some((w) => /noi luat/.test(w)) && st.cfgWarnings.some((w) => /regex exclude sai/.test(w)));
  assert.match(render({ limit: 5 }, path.join(dir, 'none.jsonl'), st).summary, /\[warn\] ledger: .*noi luat/);
  assert.match(cfgWarnLine(dataOpts), /^ledger\[cfg\]:/);
  assert.equal(cfgWarnLine(dataOpts), null); // dedupe: khong lap lai
  fs.rmSync(dir, { recursive: true, force: true });
});
