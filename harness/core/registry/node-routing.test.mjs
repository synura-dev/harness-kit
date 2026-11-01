import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPathFor } from '../io/storage.mjs';
import { resetNodeHook } from '../io/node-hook.mjs';
import { hashTree } from '../ext/ext-trust.mjs';
import { buildCtx, normalizeDataEntries } from '../ext/ctx.mjs';
import { loadDataRegistry, resolveDataRel, resolveEntry, dataReadRoots } from './data-registry.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noderoute-'));
const posix = (p) => p.split(path.sep).join('/');
const REG = { entries: {}, reserved: [], patterns: { release: { tool: 'release', zone: 'workspaces', class: 'durable', owner: 'hub/release', legacy: 'release-old' } } };
const mkData = (n) => { const d = fs.mkdtempSync(path.join(tmp, n + '-')); return d; };
beforeEach(() => resetNodeHook());
afterEach(() => resetNodeHook());

test('entry mau khong node -> needsNode, dataPathFor nem (khong ghi nham cho)', () => {
  const env = { HUB_DATA_DIR: mkData('a') };
  expect(resolveDataRel('release', { registry: REG, env }).needsNode).toBe(true);
  expect(() => dataPathFor('release', 'x.json', { registry: REG, env })).toThrow(/node/);
  expect(() => dataPathFor('release', 'x.json', { registry: REG, env, node: '../x' })).toThrow();
});

test('HUB_DATA_DIR dat -> bo hook: ws = node id; artifact theo nut, ban ghi chung o <tool>/runs.jsonl', () => {
  const d = mkData('b'); const env = { HUB_DATA_DIR: d };
  expect(dataPathFor('release', 'a.json', { registry: REG, env, node: 'gem-sb' })).toBe(path.join(d, 'workspaces', 'gem-sb', 'release', 'gem-sb', 'a.json'));
  expect(dataPathFor('release', 'runs.jsonl', { registry: REG, env, node: 'gem-sb', shared: true })).toBe(path.join(d, 'workspaces', 'gem-sb', 'release', 'runs.jsonl'));
});

test('hook da duyet hash -> ws tu workspaceFor; hash lech -> ve node id', () => {
  const ws = fs.mkdtempSync(path.join(tmp, 'hub-'));
  const ext = path.join(ws, 'hub', 'projects'); fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(path.join(ext, 'r.mjs'), "export const workspaceFor = (id) => (id === 'gem-sb' ? 'gemsocial' : null);\n");
  fs.writeFileSync(path.join(ext, 'manifest.json'), '{"id":"projects"}');
  fs.mkdirSync(path.join(ws, 'config', 'hub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'config', 'hub', 'default.json'), JSON.stringify({ projectResolver: 'hub/projects/r.mjs' }));
  const machineFile = path.join(ws, 'm.json');
  fs.writeFileSync(machineFile, JSON.stringify({ extensions: { [ws]: [{ id: 'projects', root: 'hub/projects', hash: hashTree(ext).hash, approvedAt: 'x' }] } }));
  const o = { registry: REG, root: ws, machineFile, warn: () => {}, env: { CLAUDE_PROJECT_DIR: ws } };
  expect(posix(dataPathFor('release', 'a.json', { ...o, node: 'gem-sb' }))).toMatch(/workspaces\/gemsocial\/release\/gem-sb\/a\.json$/);
  fs.appendFileSync(path.join(ext, 'r.mjs'), '// doi code\n'); resetNodeHook();
  expect(posix(dataPathFor('release', 'a.json', { ...o, node: 'gem-sb' }))).toMatch(/workspaces\/gem-sb\/release\/gem-sb\/a\.json$/);
});

test('legacy-read: uu tien <node>/, roi artifact cu khong cap <node>/, roi data[].legacy', () => {
  const d = mkData('c'); const o = { registry: REG, env: { HUB_DATA_DIR: d }, node: 'g', mode: 'read', quiet: true };
  fs.mkdirSync(path.join(d, 'workspaces', 'g', 'release'), { recursive: true });
  fs.writeFileSync(path.join(d, 'workspaces', 'g', 'release', 'old.json'), '{}');
  expect(dataPathFor('release', 'old.json', o)).toBe(path.join(d, 'workspaces', 'g', 'release', 'old.json'));
  fs.mkdirSync(path.join(d, 'workspaces', 'g', 'release', 'g'), { recursive: true });
  fs.writeFileSync(path.join(d, 'workspaces', 'g', 'release', 'g', 'old.json'), '{}');
  expect(dataPathFor('release', 'old.json', o)).toBe(path.join(d, 'workspaces', 'g', 'release', 'g', 'old.json'));
  fs.mkdirSync(path.join(d, 'release-old'), { recursive: true });
  fs.writeFileSync(path.join(d, 'release-old', 'z.json'), '{}');
  expect(dataPathFor('release', 'z.json', o)).toBe(path.join(d, 'release-old', 'z.json'));
  expect(dataPathFor('release', 'z.json', { ...o, mode: 'write' })).toBe(path.join(d, 'workspaces', 'g', 'release', 'g', 'z.json'));
  expect(dataReadRoots('release', o).length).toBeGreaterThan(0);
});

test('registry dan xuat tu manifest: mau + ws dang co; manifest khong path khong ghi vao workspaces/<ext-id>; path cu van chay', () => {
  const d = mkData('dd'); const ext = mkData('ext'); const regFile = path.join(d, 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ entries: {}, reserved: [] }));
  const man = (n, data) => { fs.mkdirSync(path.join(ext, n)); fs.writeFileSync(path.join(ext, n, 'manifest.json'), JSON.stringify({ id: n, data })); };
  man('rel', [{ zone: 'workspaces', tool: 'release', class: 'durable', retentionDays: 90 }, { zone: 'workspaces', class: 'log' }]);
  man('oldx', [{ zone: 'workspaces', path: 'gem/oldtool', tool: 'oldtool', class: 'artifact' }]);
  fs.mkdirSync(path.join(d, 'workspaces', 'gem', 'release', 'gem'), { recursive: true });
  const reg = loadDataRegistry({ env: { HUB_DATA_DIR: d }, registryFile: regFile, extDirs: [ext], workspacesDir: path.join(d, 'none'), noCache: true });
  expect(reg.patterns.release).toMatchObject({ tool: 'release', pattern: 'workspaces/*/release', class: 'durable', retentionDays: 90 });
  expect(reg.entries['workspaces/gem/release']).toMatchObject({ path: 'workspaces/gem/release', workspace: 'gem', class: 'durable', derived: true });
  expect(Object.keys(reg.entries).some((k) => /^workspaces\/(rel|oldx)$/.test(k) || k === 'rel')).toBe(false);
  expect(reg.entries.oldtool).toMatchObject({ path: 'workspaces/gem/oldtool', deprecatedPath: true });
  // ws chua co thu muc: resolveEntry van khop mau (ghi dau duoc dang ky)
  const hit = resolveEntry(path.join(d, 'workspaces', 'newws', 'release', 'newws', 'a.json'), { registry: reg, env: { HUB_DATA_DIR: d } });
  expect(hit.key).toBe('workspaces/newws/release');
  expect(hit.entry).toMatchObject({ class: 'durable' });
});

test('config/data/workspaces cu: van doc + canh bao deprecated-config 1 dong', () => {
  const d = mkData('ee'); const wsDir = path.join(d, 'cfg'); fs.mkdirSync(wsDir);
  fs.writeFileSync(path.join(wsDir, 'zz.json'), JSON.stringify({ workspace: 'zz', thing: { class: 'log', owner: 'x' } }));
  const regFile = path.join(d, 'registry.json'); fs.writeFileSync(regFile, JSON.stringify({ entries: {}, reserved: [] }));
  const lines = []; const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try { var reg = loadDataRegistry({ env: { HUB_DATA_DIR: d }, registryFile: regFile, extDirs: [], workspacesDir: wsDir, noCache: true }); } finally { process.stderr.write = orig; }
  expect(reg.entries['workspaces/zz/thing']).toMatchObject({ class: 'log' });
  expect(lines.filter((l) => l.includes('rule=deprecated-config') && l.includes('zz.json')).length).toBe(1);
});

test('ctx: muc mau can tool; entryPath theo node, chi ghi trong <ws>/<tool>/, legacy-read', () => {
  expect(normalizeDataEntries([{ zone: 'workspaces', class: 'log' }], 'x').errors.length).toBe(1);
  expect(normalizeDataEntries([{ zone: 'workspaces', tool: 'release', class: 'durable' }], 'x').entries[0]).toMatchObject({ pattern: true, tool: 'release' });
  const d = mkData('ff'); const prev = process.env.HUB_DATA_DIR; process.env.HUB_DATA_DIR = d;
  try {
    const ctx = buildCtx({ extId: 'rel', data: [{ zone: 'workspaces', tool: 'release', class: 'durable', legacy: 'release-old' }] });
    const f = ctx.storage.entryPath('release', 'a.json', { node: 'g' });
    expect(f).toBe(path.join(d, 'workspaces', 'g', 'release', 'g', 'a.json'));
    expect(ctx.storage.entryPath('release', 'runs.jsonl', { node: 'g', shared: true })).toBe(path.join(d, 'workspaces', 'g', 'release', 'runs.jsonl'));
    expect(() => ctx.storage.entryPath('release', 'a.json')).toThrow(/node/);
    expect(() => ctx.storage.entryPath('release', 'a.json', { node: '../g' })).toThrow();
    expect(ctx.storage.writeJson(f, { ok: 1 })).toBe(f);
    expect(() => ctx.storage.writeJson(path.join(d, 'workspaces', 'g', 'other', 'x.json'), {})).toThrow();
    expect(() => ctx.storage.writeJson(path.join(d, 'workspaces', 'x.json'), {})).toThrow();
    fs.mkdirSync(path.join(d, 'release-old'), { recursive: true }); fs.writeFileSync(path.join(d, 'release-old', 'o.json'), '{}');
    expect(ctx.storage.entryPath('release', 'o.json', { node: 'g', mode: 'read' })).toBe(path.join(d, 'release-old', 'o.json'));
  } finally { if (prev === undefined) delete process.env.HUB_DATA_DIR; else process.env.HUB_DATA_DIR = prev; }
});

test('layering: core/io/node-hook khong import cli/', () => {
  const src = fs.readFileSync(new URL('../io/node-hook.mjs', import.meta.url), 'utf8');
  expect(/^\s*import .*cli\//m.test(src)).toBe(false);
});
