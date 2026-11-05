import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPluginRegistry } from './plugin-registry.mjs';
import { isPluginMode } from '../io/paths.mjs';

const EIGHT = {}; // plugins/ da rong: agy -> hub/agy (extRoots); tasks, play -> hub/; audit/runs/data -> observe, memory -> (bo)
// domain alias qua manifest.domains (S10): dom -> [thu muc, file]
const ALIAS = {};

test('manifest plugins hop le, bang domain khop cli-domains.json', () => {
  const r = loadPluginRegistry();
  expect(r.errors).toEqual([]);
  expect(r.drift).toEqual([]);
  for (const [dom, dir] of Object.entries(EIGHT)) {
    expect(r.domains[dom]).toMatch(new RegExp(`plugins[\\\\/]${dir}[\\\\/]${dir}\\.mjs$`));
    expect(fs.existsSync(r.domains[dom])).toBe(true);
  }
  for (const [dom, [dir, f]] of Object.entries(ALIAS)) expect(r.domains[dom]).toMatch(new RegExp(`plugins[\\\\/]${dir}[\\\\/]${f}\\.mjs$`));
  expect(Object.keys(r.domains).sort()).toEqual([...Object.keys(EIGHT), ...Object.keys(ALIAS)].sort());
});

test('thu muc plugin khong vuot 12 file', () => {
  const r = loadPluginRegistry();
  for (const f of Object.values(r.domains)) expect(fs.readdirSync(path.dirname(f)).length).toBeLessThanOrEqual(12);
});

test('loadHarnessRegistry: 3 vung + cli, khong loi, drift = 0', async () => {
  const { loadHarnessRegistry } = await import('./plugin-registry.mjs');
  const r = loadHarnessRegistry();
  expect(r.errors).toEqual([]);
  expect(r.drift).toEqual([]);
  expect(r.domains.observe).toMatch(/observe[\\/]views[\\/]observe\.mjs$/);
  expect(r.domains.constrain).toMatch(/constrain[\\/]cli[\\/]cli\.mjs$/);
  expect(Object.keys(r.aliases)).toEqual(expect.arrayContaining(["config"]));
  expect(Object.keys(r.domains).filter((d) => !r.ext[d]).sort()).toEqual(["agy", "constrain", "data", "doctor", "evolve", "ext", "install", "observe"]); // plugin mode ship ext, khong ship tool plugin (xuat)
  expect(r.manifests.map((m) => m.dir)).toContain('harness/hooks/dispatch');
});

function tmpPlugins(defs) {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'preg-'));
  const pd = path.join(hub, 'harness', 'plugins');
  for (const [dir, m, withEntry] of defs) {
    fs.mkdirSync(path.join(pd, dir), { recursive: true });
    fs.writeFileSync(path.join(pd, dir, 'manifest.json'), JSON.stringify(m));
    if (withEntry) fs.writeFileSync(path.join(pd, dir, m.entry), '// x');
  }
  return pd;
}
const mk = (id, over = {}) => ({ id, kind: 'cli', layer: 'ext', entry: `${id}.mjs`, domain: id, ...over });

test('phat hien trung domain, thieu entry, kind sai', () => {
  const pd = tmpPlugins([['a', mk('a'), true], ['b', mk('b', { domain: 'a' }), true], ['c', mk('c'), false], ['d', mk('d', { kind: 'zzz' }), true]]);
  const r = loadPluginRegistry({ pluginsDir: pd, aliasPath: null });
  const s = r.errors.join('\n');
  expect(s).toContain('trung domain a');
  expect(s).toContain('c: entry khong ton tai');
  expect(s).toContain('d: kind');
});

test('registry chi tu manifest: khong con so lech voi file alias cu', () => {
  const pd = tmpPlugins([['a', mk('a'), true]]);
  expect(loadPluginRegistry({ pluginsDir: pd }).drift).toEqual([]);
});

test('vung nhom moi: <vung>/<nhom>/manifest.json kind cli dang ky domain; kind khac va skills/config khong quet', async () => {
  const { loadHarnessRegistry, readManifests } = await import('./plugin-registry.mjs');
  const hd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zreg-')), 'harness');
  const put = (rel, m) => {
    const d = path.join(hd, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m));
    for (const f of [m.entry, ...Object.values(m.domains || {}).map((v) => (typeof v === 'string' ? v : v.file))]) fs.writeFileSync(path.join(d, f), '// x');
  };
  put('observe/evidence', mk('evidence', { entry: 'cli.mjs' }));
  put('evolve/vault', mk('vault', { entry: 'cli.mjs', domain: 'vault', domains: { vault: { file: 'cli.mjs', cmds: 'get' }, 'vault-index': 'index.mjs' } }));
  put('constrain/gate', { id: 'gate', kind: 'hook', layer: 'ext', entry: 'hook.mjs' });
  put('skills/x', mk('skx'));
  put('config/y', mk('cfy'));
  const r = loadHarnessRegistry({ harnessDir: hd });
  expect(r.errors).toEqual([]);
  expect(Object.keys(r.domains).sort()).toEqual(['evidence', 'vault', 'vault-index']);
  expect(r.domains.evidence).toMatch(/observe[\\/]evidence[\\/]cli\.mjs$/);
  expect(r.meta.vault.cmds).toBe('get');
  expect(r.manifests.map((m) => m.dir).sort()).toEqual(['harness/constrain/gate', 'harness/evolve/vault', 'harness/observe/evidence']);
  expect(readManifests(hd).map((x) => x.dir).sort()).toEqual(['harness/constrain/gate', 'harness/evolve/vault', 'harness/observe/evidence']);
});

test('architecture: sinh on dinh, idempotent, phat hien lech', async () => {
  const { renderArchitecture, applyArchitecture, syncArchitecture, ARCH_BEGIN, ARCH_END } = await import('./plugin-registry.mjs');
  const a = renderArchitecture(), b = renderArchitecture();
  expect(a).toBe(b);
  expect(a).toContain("| `constrain` |");
  expect(a).toContain('flatMax=8');
  expect(applyArchitecture('x', a)).toBeNull();
  const doc = `hand\n${ARCH_BEGIN}\nold\n${ARCH_END}\ntail\n`;
  const once = applyArchitecture(doc, a);
  expect(once.startsWith('hand\n')).toBe(true);
  expect(once.endsWith(`${ARCH_END}\ntail\n`)).toBe(true);
  expect(applyArchitecture(once, a)).toBe(once);
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  fs.mkdirSync(path.join(hub, 'docs'));
  fs.mkdirSync(path.join(hub, 'harness'));
  fs.writeFileSync(path.join(hub, 'docs', 'ARCHITECTURE.md'), doc);
  expect(syncArchitecture(hub, false).changed).toBe(true);
  expect(syncArchitecture(hub, true).changed).toBe(true);
  expect(syncArchitecture(hub, false).changed).toBe(false);
  expect(syncArchitecture(hub, true).changed).toBe(false);
  fs.writeFileSync(path.join(hub, 'docs', 'ARCHITECTURE.md'), 'khong marker');
  expect(syncArchitecture(hub, false).problem).toContain('marker');
});

test('extRoots: quet <root>/<con>/manifest.json, ext[dom]=root, root khong ton tai bo qua, gioi han manifest', async () => {
  const { loadHarnessRegistry } = await import('./plugin-registry.mjs');
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'xreg-'));
  fs.mkdirSync(path.join(hub, 'harness'));
  for (const n of ['aa', 'bb', 'cc']) {
    const d = path.join(hub, 'hub', n);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${n}.mjs`), '// x');
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(mk(n)));
  }
  const hd = path.join(hub, 'harness');
  const r = loadHarnessRegistry({ harnessDir: hd, extRoots: ['hub', 'khong-co'] });
  expect(r.errors).toEqual([]);
  expect(Object.keys(r.domains).sort()).toEqual(['aa', 'bb', 'cc']);
  expect(r.ext.aa).toBe('hub');
  expect(r.manifests.map((m) => m.dir).sort()).toEqual(['hub/aa', 'hub/bb', 'hub/cc']);
  const t = loadHarnessRegistry({ harnessDir: hd, extRoots: ['hub'], extLimits: { maxManifests: 2 } });
  expect(Object.keys(t.domains).length).toBe(2);
  expect(t.errors.join('|')).toContain('truncated');
  expect(loadHarnessRegistry({ harnessDir: hd, extRoots: ['/abs'] }).errors.length).toBe(1);
  expect(Object.keys(loadHarnessRegistry({ harnessDir: hd }).domains)).toEqual([]);
});

test('5.5 aliases: manifest + domains, aliasMap, translateAlias, loi trung', async () => {
  const { loadHarnessRegistry, translateAlias } = await import('./plugin-registry.mjs');
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  const put = (dir, m) => { const d = path.join(hub, 'harness', 'observe', dir); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m)); fs.writeFileSync(path.join(d, m.entry), '// x'); };
  put('a', mk('a', { aliases: ['a-old'], aliasMap: { 'a-old': { fallback: ['x'] } } }));
  put('b', { ...mk('b'), domains: { b: { file: 'b.mjs', aliases: ['b-old'] }, b2: 'b.mjs' } });
  const r = loadHarnessRegistry({ harnessDir: path.join(hub, 'harness') });
  expect(r.errors).toEqual([]);
  expect(Object.keys(r.domains).sort()).toEqual(['a', 'b', 'b2']);
  expect(r.aliases['a-old']).toEqual({ domain: 'a', map: { fallback: ['x'] } });
  expect(r.aliases['b-old'].domain).toBe('b');
  expect(r.meta.a.aliases).toEqual(['a-old']);
  put('c', mk('c', { aliases: ['a', 'a-old'] }));
  const e = loadHarnessRegistry({ harnessDir: path.join(hub, 'harness') });
  expect(e.errors.join('|')).toContain('alias a trung domain that');
  expect(e.errors.join('|')).toContain('alias a-old trung alias');
  expect(Object.keys(e.aliases).sort()).toEqual(['a-old', 'b-old']);
  expect(translateAlias({ map: { p: ['dp'] } }, ['p', '--yes'])).toEqual({ args: ['dp', '--yes'] });
  expect(translateAlias({ pass: ['v'], fallback: ['v'] }, ['q'])).toEqual({ args: ['v', 'q'] });
  expect(translateAlias({ pass: ['v'], fallback: ['v'] }, ['v', 'q'])).toEqual({ args: ['v', 'q'] });
  expect(translateAlias({ map: { p: ['dp'] } }, ['z']).error).toContain('lenh la: z');
  expect(translateAlias(null, ['z'])).toEqual({ args: ['z'] });
});

test('5.5 architecture: quet extRoots, nhom Hub rieng, alias ghi kem', async () => {
  const { renderArchitecture } = await import('./plugin-registry.mjs');
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'archx-'));
  const w = (dir, m) => { const d = path.join(hub, ...dir.split('/')); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m)); fs.writeFileSync(path.join(d, m.entry), '// x'); };
  w('harness/observe/o', mk('o', { aliases: ['o-old'] }));
  w('hub/tasks', mk('tasks'));
  const t = renderArchitecture({ harnessDir: path.join(hub, 'harness'), extRoots: ['hub'] });
  expect(t).toContain('| `tasks` | `hub/tasks/tasks.mjs` |');
  expect(t).toContain('**hub/**');
  expect(t).toContain('(alias: o-old)');
  expect(t.indexOf('`o`')).toBeLessThan(t.indexOf('**hub/**'));
  expect(renderArchitecture({ harnessDir: path.join(hub, 'harness') })).not.toContain('tasks');
});
