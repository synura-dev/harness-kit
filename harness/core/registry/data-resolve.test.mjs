import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataRel } from './data-registry.mjs';
import { dataPathFor } from '../io/storage.mjs';

function mk(entry) {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const dd = path.join(hub, 'data');
  fs.mkdirSync(dd, { recursive: true });
  const registryFile = path.join(hub, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({ entries: { 'workspaces/g/rel': entry } }));
  return { dd, o: { env: { HUB_DATA_DIR: dd }, registryFile, workspacesDir: path.join(hub, 'ws'), noCache: true } };
}
const put = (dd, rel) => { fs.mkdirSync(path.join(dd, rel), { recursive: true }); };

test('chua chuyen: rel = entry.path hoac key, legacy null', () => {
  const { o } = mk({ zone: 'workspaces', class: 'log', owner: 'o' });
  const r = resolveDataRel('workspaces/g/rel', o);
  expect(r.rel).toBe('workspaces/g/rel');
  expect(r.legacyRel).toBeNull();
  expect(resolveDataRel('khong-co', o).rel).toBe('khong-co');
});

test('dataPathFor chan thoat dataDir', () => {
  const { o } = mk({ path: 'a' });
  expect(() => dataPathFor('workspaces/g/rel', '..', o)).toThrow();
});

test('audit thieu entry/path: dung mac dinh system/audit, khong roi ve key', () => {
  const { o } = mk({ zone: 'workspaces', class: 'log', owner: 'o' });
  expect(resolveDataRel('audit', o).rel).toBe('system/audit');
});

test('key khac thieu entry: canh bao no-path qua stderr, van tra key', () => {
  const { o } = mk({ zone: 'workspaces', class: 'log', owner: 'o' });
  const w = process.stderr.write; let got = '';
  process.stderr.write = (s) => { got += s; return true; };
  try { expect(resolveDataRel('zz-khong-co', o).rel).toBe('zz-khong-co'); } finally { process.stderr.write = w; }
  expect(got).toContain('rule=no-path');
});

test('evolve thieu entry: mac dinh duong khai bao, khong canh bao no-path', () => {
  const { o } = mk({ zone: 'workspaces', class: 'log', owner: 'o' });
  const w = process.stderr.write; let got = '';
  process.stderr.write = (s) => { got += s; return true; };
  try { expect(resolveDataRel('evolve', o).rel).toBe('evolve'); } finally { process.stderr.write = w; }
  expect(got).not.toContain('rule=no-path');
});

test('evolve thieu entry: mac dinh evolve, khong canh bao no-path', () => {
  const { o } = mk({ zone: 'workspaces', class: 'log', owner: 'o' });
  const w = process.stderr.write; let got = '';
  process.stderr.write = (s) => { got += s; return true; };
  try { expect(resolveDataRel('evolve', o).rel).toBe('evolve'); } finally { process.stderr.write = w; }
  expect(got).not.toContain('rule=no-path');
});
