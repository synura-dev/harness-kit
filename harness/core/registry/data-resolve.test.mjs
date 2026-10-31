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

test('sau mv: ghi -> moi; doc -> moi neu co, khong thi legacy + canh bao 1 lan', () => {
  const { dd, o } = mk({ path: 'workspaces/g/new', legacy: 'old', class: 'log', owner: 'o', zone: 'workspaces' });
  put(dd, 'old');
  let r = resolveDataRel('workspaces/g/rel', o);
  expect(r.rel).toBe('workspaces/g/new');
  expect(r.legacyRel).toBe('old');
  expect(r.exists).toEqual({ new: false, legacy: true });
  expect(r.readRel).toBe('old');
  const w = path.join(dd, 'workspaces', 'g', 'new', 'f.json');
  expect(dataPathFor('workspaces/g/rel', 'f.json', o)).toBe(w);
  const errs = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    expect(dataPathFor('workspaces/g/rel', 'f.json', { ...o, mode: 'read' })).toBe(path.join(dd, 'old', 'f.json'));
    dataPathFor('workspaces/g/rel', 'f.json', { ...o, mode: 'read' });
  } finally { process.stderr.write = orig; }
  expect(errs.filter((e) => e.includes('rule=legacy-read')).length).toBe(1);
  expect(errs.join('')).toMatch(/fix="harness data mv old workspaces\/g\/new --yes"/);
  put(dd, 'workspaces/g/new');
  r = resolveDataRel('workspaces/g/rel', o);
  expect(r.exists.new).toBe(true);
  expect(dataPathFor('workspaces/g/rel', 'f.json', { ...o, mode: 'read' })).toBe(w);
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

test('memory thieu entry: mac dinh memory, khong canh bao no-path', () => {
  const { o } = mk({ zone: 'workspaces', class: 'log', owner: 'o' });
  const w = process.stderr.write; let got = '';
  process.stderr.write = (s) => { got += s; return true; };
  try { expect(resolveDataRel('memory', o).rel).toBe('memory'); } finally { process.stderr.write = w; }
  expect(got).not.toContain('rule=no-path');
});

test('evolve thieu entry: mac dinh evolve, khong canh bao no-path', () => {
  const { o } = mk({ zone: 'workspaces', class: 'log', owner: 'o' });
  const w = process.stderr.write; let got = '';
  process.stderr.write = (s) => { got += s; return true; };
  try { expect(resolveDataRel('evolve', o).rel).toBe('evolve'); } finally { process.stderr.write = w; }
  expect(got).not.toContain('rule=no-path');
});
