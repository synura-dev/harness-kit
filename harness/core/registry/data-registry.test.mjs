import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as m from './data-registry.mjs';

test('registry thieu -> failed + canh bao ro dung 1 lan (khong im lang)', () => {
  const f = path.join(os.tmpdir(), 'no-such-reg-' + process.pid + '.json');
  const orig = process.stderr.write; const out = [];
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  try {
    const a = m.loadDataRegistry({ registryFile: f, noCache: true });
    m.loadDataRegistry({ registryFile: f, noCache: true });
    expect(a.failed).toBe(true);
  } finally { process.stderr.write = orig; }
  expect(out.filter((l) => l.includes('registry-missing')).length).toBe(1);
});

function mk(reg, ws) {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-'));
  const rf = path.join(hub, 'harness', 'observe', 'storage');
  fs.mkdirSync(rf, { recursive: true });
  if (reg !== undefined) fs.writeFileSync(path.join(rf, 'registry.json'), typeof reg === 'string' ? reg : JSON.stringify(reg));
  if (ws) {
    fs.mkdirSync(path.join(hub, 'config', 'data', 'workspaces'), { recursive: true });
    for (const [n, v] of Object.entries(ws)) fs.writeFileSync(path.join(hub, 'config', 'data', 'workspaces', n), JSON.stringify(v));
  }
  const o = (env = {}) => ({ env: { HUB_DIR: hub, HUB_DATA_DIR: path.join(hub, 'data'), ...env }, registryFile: path.join(rf, 'registry.json'), extDirs: [], noCache: true }); // registry + ext tuong minh -> khong phu thuoc mode
  return { hub, o, p: (...x) => path.join(hub, 'data', ...x) };
}
const R = {
  entries: {
    audit: { owner: 'a', class: 'log', zone: 'system' },
    ok: { owner: 'o', class: 'cache', zone: 'system' },
    half: { owner: 'o' },
    'agy-home': { domain: 'external', owner: 'x', class: 'durable' },
  },
  reserved: ['_inbox', '.state'],
};
const ENF = { HARNESS_DATA_ENFORCE: 'enforce' };
test('checkWrite: off/warn/enforce', () => {
  const t = mk(R);
  expect(m.checkWrite(t.p('zzz', 'a.json'), t.o()).warn.rule).toBe('unregistered');
  expect(m.checkWrite(t.p('zzz', 'a.json'), t.o()).ok).toBe(true);
  expect(m.checkWrite(t.p('zzz', 'a.json'), t.o({ HARNESS_DATA_ENFORCE: 'off' }))).toEqual({ ok: true });
  const e = m.checkWrite(t.p('zzz', 'a.json'), t.o(ENF));
  expect(e.ok).toBe(false);
  expect(e.warn.key).toBe('zzz');
  expect(m.checkWrite(t.p('ok', 'x.json'), t.o(ENF))).toEqual({ ok: true });
});
test('registry.enforce dung khi khong co env', () => {
  const t = mk({ ...R, enforce: 'enforce' });
  expect(m.checkWrite(t.p('zzz', 'a'), t.o()).ok).toBe(false);
});
test('audit mien tru; thieu field -> missing-field', () => {
  const t = mk({ entries: { ...R.entries, audit: { owner: 'a' } } });
  const r = m.checkWrite(t.p('audit', 'e.jsonl'), t.o(ENF));
  expect(r.ok).toBe(true);
  expect(r.warn.rule).toBe('missing-field');
  expect(m.checkWrite(t.p('half', 'e'), t.o(ENF)).ok).toBe(false);
});
test('schema cu: domain external, retentionDays', () => {
  const t = mk({ entries: { a: { owner: 'o', retentionDays: 5 }, ...R.entries } });
  const reg = m.loadDataRegistry(t.o());
  expect(reg.entries['agy-home'].zone).toBe('external');
  expect(m.classRetention(reg.entries.a)).toBe(5);
  expect(m.resolveEntry(t.p('agy-home', 'x', 'y'), t.o()).key).toBe('agy-home');
});
test('config workspace hop nhat + khop theo path', () => {
  const t = mk(R, { 'gem.json': { entries: { 'workspaces/gem/tool1': { owner: 'o', class: 'log' } } }, 'x.example.json': { entries: { bad: { owner: 'o' } } } });
  const reg = m.loadDataRegistry(t.o());
  expect(reg.entries['workspaces/gem/tool1'].workspace).toBe('gem');
  expect(reg.entries['workspaces/gem/tool1'].zone).toBe('workspaces');
  expect(reg.entries.bad).toBeUndefined();
  const t2 = mk(R, { 'gem.json': { workspace: 'gem', entries: { feed: { zone: 'workspaces', class: 'log', tool: 'feed', owner: 'o', workspace: 'gem', project: 'p' } } } });
  expect(m.resolveEntry(t2.p('workspaces', 'gem', 'feed', 'f.json'), t2.o()).key).toBe('workspaces/gem/feed');
  expect(m.checkWrite(t2.p('workspaces', 'gem', 'feed', 'f.json'), t2.o(ENF))).toEqual({ ok: true });
  expect(m.resolveEntry(t.p('workspaces', 'gem', 'tool1', 'date=2026-01-01', 'f.json'), t.o()).key).toBe('workspaces/gem/tool1');
  expect(m.checkWrite(t.p('workspaces', 'gem', 'tool1', 'f'), t.o())).toEqual({ ok: true });
});
test('resolveEntry: path vat ly va ten theo zone', () => {
  const t = mk({ entries: { k: { owner: 'o', class: 'log', zone: 'system', path: 'legacy-dir' }, ok: R.entries.ok } });
  expect(m.resolveEntry(t.p('legacy-dir', 'a'), t.o()).key).toBe('k');
  expect(m.resolveEntry(t.p('system', 'ok', 'a'), t.o()).key).toBe('ok');
  expect(m.resolveEntry(t.p('nope', 'a'), t.o())).toEqual({ key: 'nope', entry: null });
});
test('reserved va ngoai data/ khong canh bao', () => {
  const t = mk(R);
  expect(m.checkWrite(t.p('_inbox', 'a'), t.o())).toEqual({ ok: true });
  expect(m.checkWrite(path.join(t.hub, 'elsewhere'), t.o())).toEqual({ ok: true });
});
test('fail-open: registry hong hoac thieu', () => {
  for (const bad of ['{not json', undefined]) {
    const t = mk(bad);
    expect(m.loadDataRegistry(t.o()).entries).toEqual({});
    expect(m.checkWrite(t.p('zzz', 'a'), t.o(ENF))).toEqual({ ok: true });
  }
});

test('hang ZONES/CLASSES/CLASS_DEFAULTS', () => {
  expect([...m.ZONES]).toEqual(['system', 'knowledge', 'workspaces', 'external', '_inbox']);
  expect([...m.CLASSES]).toEqual(['log', 'cache', 'artifact', 'durable']);
  expect(m.CLASS_DEFAULTS.log.retentionDays).toBe(30);
  expect(m.CLASS_DEFAULTS.cache.retentionDays).toBe(7);
  expect(m.CLASS_DEFAULTS.artifact.retentionDays).toBeNull();
  expect(m.CLASS_DEFAULTS.durable.retentionDays).toBeNull();
  for (const c of m.CLASSES) expect(m.CLASS_DEFAULTS[c].maxFiles).toBeGreaterThan(0);
  expect(m.DEFAULT_ENFORCE).toBe('warn');
});
test('chu ky export', () => {
  for (const f of ['loadDataRegistry', 'resolveEntry', 'checkWrite', 'classRetention', 'formatWarn']) expect(typeof m[f]).toBe('function');
});
test('classRetention: override > class', () => {
  expect(m.classRetention({ class: 'log' })).toBe(30);
  expect(m.classRetention({ class: 'log', retentionDays: 90 })).toBe(90);
  expect(m.classRetention({ class: 'durable' })).toBeNull();
  expect(m.classRetention(null)).toBeNull();
});
test('formatWarn mau', () => {
  const s = m.formatWarn({ rule: 'unregistered', path: 'system/x', key: 'x', detail: '5210/5000 file', fix: 'harness data register system/x/y --class log' });
  expect(s).toBe('data-warn rule=unregistered path=system/x key=x detail="5210/5000 file" fix="harness data register system/x/y --class log"');
  expect(s).not.toContain('|');
});

test('F2: workspace json hong -> failed + failedFiles; cache doi theo mtime', async () => {
  const fsm = await import('node:fs'); const osm = await import('node:os'); const pm = await import('node:path');
  const { loadDataRegistry } = await import('./data-registry.mjs');
  const hub = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'dr-'));
  const rf = pm.join(hub, 'r.json'); const wd = pm.join(hub, 'ws');
  fsm.mkdirSync(wd);
  fsm.writeFileSync(rf, JSON.stringify({ entries: { a: { class: 'log' } } }));
  fsm.writeFileSync(pm.join(wd, 'bad.json'), '{oops');
  const o = { registryFile: rf, workspacesDir: wd, env: { HUB_DIR: hub, HUB_DATA_DIR: pm.join(hub, 'data') } };
  const r = loadDataRegistry(o);
  expect(r.failed).toBe(true);
  expect(r.failedFiles[0]).toContain('bad.json');
  fsm.writeFileSync(pm.join(wd, 'bad.json'), JSON.stringify({ workspace: 'w', entries: { t: { class: 'log' } } }));
  const t = new Date(Date.now() + 5000); fsm.utimesSync(pm.join(wd, 'bad.json'), t, t);
  const r2 = loadDataRegistry(o);
  expect(r2.failed).toBeUndefined();
  expect(r2.entries['workspaces/w/t']).toBeDefined();
});

function drMk(patternLegacy) {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'drown-'));
  const dd = path.join(hub, 'data');
  const env = { HUB_DIR: hub, HUB_DATA_DIR: dd };
  fs.mkdirSync(path.join(dd, 'workspaces', 'gem', 'real'), { recursive: true });
  for (const n of ['constructor', 'toString', '__proto__']) fs.mkdirSync(path.join(dd, 'workspaces', 'gem', n), { recursive: true });
  fs.mkdirSync(path.join(hub, 'outside'), { recursive: true });
  const rf = path.join(hub, 'r.json');
  const ent = { zone: 'workspaces', tool: 'real', pattern: 'workspaces/*/real', class: 'log', owner: 'o', ...(patternLegacy ? { legacy: patternLegacy } : {}) };
  fs.writeFileSync(rf, JSON.stringify({ entries: { real: ent } }));
  return { hub, dd, env, o: { registryFile: rf, workspacesDir: path.join(hub, 'ws'), env, noCache: true } };
}

test('patterns/entries: chi own property (constructor/toString/__proto__ khong duoc coi la da dang ky)', () => {
  const { dd, env, o } = drMk();
  const reg = m.loadDataRegistry(o);
  expect(Object.getPrototypeOf(reg.patterns)).toBe(null);
  expect(Object.keys(reg.entries)).toEqual(['workspaces/gem/real']);
  for (const n of ['constructor', 'toString', '__proto__']) {
    expect(m.resolveEntry(path.join(dd, 'workspaces', 'gem', n, 'x'), { registry: reg, env }).entry).toBe(null);
  }
  expect(m.resolveEntry(path.join(dd, 'constructor', 'x'), { registry: reg, env }).entry).toBe(null);
  expect(m.resolveEntry(path.join(dd, 'workspaces', 'gem', 'real', 'x'), { registry: reg, env }).entry).not.toBe(null);
  expect(m.checkWrite(path.join(dd, 'workspaces', 'gem', 'constructor', 'x'), { registry: reg, env }).warn?.rule).toBe('unregistered');
});

test('dataReadRoots: legacy cua pattern ra ngoai dataDir (.. / tuyet doi) bi loc', () => {
  for (const lg of ['../outside', '..\\outside', path.join(os.tmpdir())]) {
    const { dd, env, o } = drMk(lg);
    const reg = m.loadDataRegistry(o);
    const roots = m.dataReadRoots('real', { registry: reg, node: 'n1', env });
    for (const r of roots) expect(path.relative(dd, r).startsWith('..')).toBe(false);
    expect(m.resolveDataRel('real', { registry: reg, node: 'n1', env }).legacyRels.length).toBe(1);
  }
});

test('setEntryPath: restoreLegacy khoi phuc legacy cu (co/khong co) khi hoan tac', () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'drleg-'));
  const rf = path.join(hub, 'r.json');
  fs.writeFileSync(rf, JSON.stringify({ entries: { 'a/b': { class: 'log', legacy: 'old/L' }, 'c/d': { class: 'log' } } }));
  const o = { registryFile: rf, workspacesDir: path.join(hub, 'ws'), env: { HUB_DIR: hub } };
  const u = m.setEntryPath('a/b', 'x/y', o);
  expect(u.hadLegacy).toBe(true);
  expect(u.prevLegacy).toBe('old/L');
  m.setEntryPath('x/y', 'a/b', { ...o, restoreLegacy: { had: u.hadLegacy, value: u.prevLegacy } });
  const j = JSON.parse(fs.readFileSync(rf, 'utf8')).entries['a/b'];
  expect(j.path).toBe('a/b');
  expect(j.legacy).toBe('old/L');
  const u2 = m.setEntryPath('c/d', 'e/f', o);
  expect(u2.hadLegacy).toBe(false);
  m.setEntryPath('e/f', 'c/d', { ...o, restoreLegacy: { had: false } });
  expect(JSON.parse(fs.readFileSync(rf, 'utf8')).entries['c/d'].legacy).toBeUndefined();
});
