// GD3: duong da chuyen qua dataPathFor/resolver; prune runs doc lap audit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPathFor } from '../../core/io/storage.mjs';
import { prune } from './prune.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gd3-i2-'));
const reg = { entries: { audit: { path: 'system/audit', legacy: 'audit' }, runs: { path: 'system/runs', legacy: 'runs' }, 'agy-home': { path: 'external/agy-home', legacy: 'agy-home' } } };
const env = (d) => ({ HUB_DATA_DIR: d });

test('dataPathFor ton trong HUB_DATA_DIR va path moi cua entry (gateway)', () => {
  const d = tmp();
  const p = dataPathFor('audit', 'gateway', 'date=2026-10-30', { env: env(d), registry: reg, quiet: true });
  expect(p).toBe(path.join(d, 'system', 'audit', 'gateway', 'date=2026-10-30'));
});

test('prune runs chay doc lap khi audit va runs o cho khac nhau', () => {
  const d = tmp();
  const audit = path.join(d, 'system', 'audit'); const runs = path.join(d, 'elsewhere', 'runs');
  fs.mkdirSync(audit, { recursive: true }); fs.mkdirSync(runs, { recursive: true });
  const old = path.join(runs, 'old.log'); fs.writeFileSync(old, 'x');
  const past = new Date(Date.now() - 90 * 86400000); fs.utimesSync(old, past, past);
  const r = prune({ root: audit, runsRoot: runs, days: 30, yes: true });
  expect(r.removed.some((p) => p.endsWith('old.log'))).toBe(true);
  expect(fs.existsSync(old)).toBe(false);
});
