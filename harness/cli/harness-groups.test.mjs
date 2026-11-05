import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, loadRegistryInfo, groupOf, INDEX_MAX_LINES } from './harness.mjs';

// hub gia: domain o vung bat ky harness/<zone>/<name>/manifest.json (zone suy tu duong dan registry)
const hub = (doms = {}) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-'));
  for (const [name, o] of Object.entries(doms)) {
    const d = path.join(r, 'harness', o.zone || 'plugins', o.dir || name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${name}.mjs`), o.code || 'console.log("ran", process.argv.slice(2).join(","))');
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: o.dir || name, kind: 'cli', layer: 'ext', entry: `${name}.mjs`, domain: name, config: { defaults: null, schema: null }, desc: name.toUpperCase(), ...o.man }));
  }
  return r;
};
const idx = (r, a = []) => run(a, r, { capture: true });

test('domain la: ext co manifest chua dang ky -> HKERR goi y ext register, help rut gon, exit 2', () => {
  const r = hub({ ev: { zone: 'observe' } });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hgw-'));
  fs.mkdirSync(path.join(ws, 'hub', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'hub', 'tasks', 'manifest.json'), '{}');
  const u = run(['tasks'], r, { capture: true, workspace: ws, externals: [] });
  expect(u.code).toBe(2);
  const j = JSON.parse(u.stderr.trim().replace(/^HKERR /, ''));
  expect(j).toMatchObject({ code: 'HK_EXT_UNREGISTERED', fix_command: 'harness ext register hub/tasks', severity: 'error', safe: true });
  expect(j.cause).toBeTruthy(); expect(j.next_step).toContain('harness tasks');
  expect(u.text.split('\n').length).toBeLessThanOrEqual(10);
  expect(u.text).toContain('harness --help');
});

test('domain la hoan toan: goi y domain gan ten nhat, khong co -> harness --help', () => {
  const r = hub({ ev: { zone: 'observe' }, report: { zone: 'observe' } });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hgw-'));
  const near = run(['reprot'], r, { capture: true, workspace: ws, externals: [] });
  expect(near.code).toBe(2);
  expect(JSON.parse(near.stderr.trim().slice(6))).toMatchObject({ code: 'HK_UNKNOWN_DOMAIN', fix_command: 'harness report' });
  expect(near.text.split('\n')[0]).toBe('domain la: reprot');
  expect(near.text.split('\n').length).toBeLessThanOrEqual(10);
  const far = run(['zzqqxxww'], r, { capture: true, workspace: ws, externals: [] });
  expect(far.code).toBe(2);
  expect(JSON.parse(far.stderr.trim().slice(6)).fix_command).toBe('harness --help');
});

test('groups: index nhom theo vung, 4 nhom chinh luon co tieu de, domain cu o run', () => {
  const r = hub({ ev: { zone: 'observe' }, gate: { zone: 'constrain' }, old: { zone: 'plugins' }, tl: { zone: 'tools' }, sk: { zone: 'build' } });
  const x = idx(r);
  expect(x.code).toBe(0);
  const t = x.text;
  for (const h of ['== Quan sat (observe) ==', '== Han che (constrain) ==', '== Tien hoa (evolve) ==', '== Build (build) ==']) expect(t).toContain(h);
  expect(t.indexOf('ev - EV')).toBeGreaterThan(t.indexOf('(observe)'));
  expect(t.indexOf('ev - EV')).toBeLessThan(t.indexOf('(constrain)'));
  expect(t.indexOf('old - OLD')).toBeGreaterThan(t.indexOf('(run)'));
  expect(t.indexOf('tl - TL')).toBeGreaterThan(t.indexOf('(run)'));
  expect(t).toMatch(/\(evolve\) ==\n\(chua co domain\)/);
  expect(t.split('\n').length).toBeLessThanOrEqual(INDEX_MAX_LINES);
});

test('groups: --flat in nhu cu (khong tieu de), domain cu giu hanh vi spawn', () => {
  const r = hub({ old: { zone: 'plugins' }, ev: { zone: 'observe' } });
  const f = idx(r, ['--flat']).text;
  expect(f).not.toContain('==');
  expect(f.split('\n').sort()).toEqual(['ev - EV - (khong co lenh con)', 'old - OLD - (khong co lenh con)']);
  expect(idx(r, ['old', 'a', '--flat']).stdout.trim()).toBe('ran a,--flat'); // co sau domain chuyen nguyen
  expect(idx(r, ['old']).text).toBe('old - OLD - (khong co lenh con)');
});

test('groups: <nhom> va --group liet ke domain cua nhom; domain trung ten nhom uu tien domain', () => {
  const r = hub({ ev: { zone: 'observe' }, old: { zone: 'plugins' }, evolve: { zone: 'evolve', dir: 'vault' } });
  const g = idx(r, ['observe']);
  expect(g.code).toBe(0);
  expect(g.text).toBe('== Quan sat (observe) ==\nev - EV - (khong co lenh con)');
  expect(idx(r, ['evolve']).text).toBe('evolve - EVOLVE - (khong co lenh con)');
  expect(idx(r, ['--group', 'evolve']).text).toContain('== Tien hoa (evolve) ==');
  expect(idx(r, ['--group=run']).text).toContain('old - OLD');
  expect(JSON.parse(idx(r, ['--group', 'observe', '--json']).text)).toEqual({ ev: { desc: 'EV', cmds: null, default: 'index', available: true, group: 'observe' } });
  const bad = idx(r, ['--group', 'zzz']);
  expect(bad.code).toBe(2);
  expect(bad.text.split('\n')[0]).toBe('nhom la: zzz');
});

test('groups: domain trung ten giua 2 manifest -> bao loi, khong ghi de im lang', () => {
  const r = hub({ dup: { zone: 'plugins', dir: 'a' } });
  const d = path.join(r, 'harness', 'observe', 'b');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'dup.mjs'), 'console.log("second")');
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: 'b', kind: 'cli', layer: 'ext', entry: 'dup.mjs', domain: 'dup', config: { defaults: null, schema: null }, desc: 'SECOND' }));
  const info = loadRegistryInfo(r);
  expect(info.errors.join('|')).toContain('trung domain dup');
  const t = idx(r).text;
  expect(t).toContain('! registry:');
  expect(t).toContain('trung domain dup');
  expect((t.match(/^dup - /gm) || []).length).toBe(1);
});

test('groups: groupOf suy tu duong dan, khong hardcode domain', () => {
  expect(groupOf({ script: 'harness/observe/evidence/cli.mjs' })).toBe('observe');
  expect(groupOf({ script: 'harness/cli/commands/doctor.mjs' })).toBe('cli');
  expect(groupOf({ script: 'harness/hooks/demo/x.mjs' })).toBe('hooks');
  expect(groupOf({})).toBe('cli');
});

test('groups: index dai bi cat <= INDEX_MAX_LINES kem goi y --flat', () => {
  const doms = {};
  for (let i = 0; i < 50; i++) doms[`d${i}`] = { zone: 'tools' };
  const t = idx(hub(doms)).text;
  expect(t.split('\n').length).toBeLessThanOrEqual(INDEX_MAX_LINES);
  expect(t).toContain('--flat');
});

afterEach(() => { delete process.env.HARNESS_CONFIG_DIR; });
// ---- extRoots (5.1 H0): domain o goc ngoai harness/ chi SPAWN, nhom rieng "Ngoai: <root>/"
const withExt = (roots, doms = {}) => {
  const r = hub(doms);
  fs.mkdirSync(path.join(r, 'config', 'hub'), { recursive: true });
  fs.writeFileSync(path.join(r, 'config', 'hub', 'default.json'), JSON.stringify({ extRoots: roots }));
  process.env.HARNESS_CONFIG_DIR = path.join(r, 'config'); // tuong minh: plugin mode doc config tu fixture
  return r;
};
const putExt = (r, dir, name, code = 'console.log("hub-ran", process.argv.slice(2).join(","))') => {
  const d = path.join(r, ...dir.split('/'));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${name}.mjs`), code);
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: name, kind: 'cli', layer: 'ext', entry: `${name}.mjs`, domain: name, desc: name.toUpperCase() }));
};

test('extRoots: domain o hub/ chay qua spawn, index co nhom "Ngoai: hub/"', () => {
  const r = withExt(['hub'], { ev: { zone: 'observe' } });
  putExt(r, 'hub/fake', 'fake');
  const t = idx(r).text;
  expect(t).toContain('== Ngoai: hub/ ==');
  expect(t.indexOf('fake - FAKE')).toBeGreaterThan(t.indexOf('== Ngoai: hub/ =='));
  expect(idx(r, ['fake', 'a', 'b']).stdout.trim()).toBe('hub-ran a,b');
  expect(idx(r, ['hub']).text).toBe('== Ngoai: hub/ ==\nfake - FAKE - (khong co lenh con)');
  expect(JSON.parse(idx(r, ['--group', 'hub', '--json']).text).fake.group).toBe('hub');
});

test('extRoots: root khong ton tai -> bo qua em, khong loi; thieu config cung vay', () => {
  const r = withExt(['hub', 'nope'], { ev: { zone: 'observe' } });
  expect(loadRegistryInfo(r).errors).toEqual([]);
  expect(idx(r).text).not.toContain('Hub');
  expect(loadRegistryInfo(hub({ ev: { zone: 'observe' } })).errors).toEqual([]);
});

test('extRoots: trung ten voi harness -> harness thang + bao loi', () => {
  const r = withExt(['hub'], { dup: { zone: 'plugins' } });
  putExt(r, 'hub/dup', 'dup', 'console.log("hub-dup")');
  const info = loadRegistryInfo(r);
  expect(info.errors.join('|')).toContain('trung domain dup');
  expect(info.doms.dup.script).toBe('harness/plugins/dup/dup.mjs');
  expect(info.doms.dup.ext).toBeUndefined();
  expect(idx(r, ['dup', 'x']).stdout.trim()).toBe('ran x');
});

test('extRoots: root khong hop le (ra ngoai goc / trong harness) -> bao loi, khong quet', () => {
  const r = withExt(['../x', 'harness/y'], { ev: { zone: 'observe' } });
  expect(loadRegistryInfo(r).errors.join('|')).toContain('extRoots');
});

test('groups: groupOf domain extRoot -> nhom theo goc', () => {
  expect(groupOf({ script: 'hub/x/x.mjs', ext: 'hub' })).toBe('hub');
});

// ---- 5.5 aliases: ten cu chay domain dich; trung domain that -> loi; index chi in domain that (alias ghi kem)
const aliasHub = (man) => hub({ ob: { zone: 'observe', code: 'console.log("ob", process.argv.slice(2).join(","))', man } });
test('aliases: <alias> chay domain dich, dich lenh con qua aliasMap, index khong co dong alias', () => {
  const r = aliasHub({ aliases: ['old', 'oq', 'dd'], aliasMap: { old: { pass: ['view'], fallback: ['view'] }, oq: { fallback: ['query'] }, dd: { map: { prune: ['data-prune'] } } } });
  expect(idx(r, ['old', 'x']).stdout.trim()).toBe('ob view,x');
  expect(idx(r, ['old', 'view', 'y']).stdout.trim()).toBe('ob view,y');
  expect(idx(r, ['oq', '--report', 's']).stdout.trim()).toBe('ob query,--report,s');
  expect(idx(r, ['dd', 'prune', '--yes']).stdout.trim()).toBe('ob data-prune,--yes');
  const bad = idx(r, ['dd', 'zzz']);
  expect(bad.code).toBe(2);
  expect(bad.text).toContain('lenh la: zzz');
  const f = idx(r, ['--flat']).text;
  expect(f.split('\n')).toEqual(['ob - OB - (khong co lenh con) [alias: old, oq, dd]']);
  expect(idx(r, ['old']).text).toContain('ob - OB');
  expect(loadRegistryInfo(r).errors).toEqual([]);
});

test('aliases: alias trung domain that / alias trung nhau -> loi registry, domain that thang', () => {
  const r = hub({ ob: { zone: 'observe', man: { aliases: ['real', 'dup'] } }, real: { zone: 'plugins' }, other: { zone: 'tools', man: { aliases: ['dup'] } } });
  const e = loadRegistryInfo(r).errors.join('|');
  expect(e).toContain('alias real trung domain that');
  expect(e).toContain('alias dup trung alias');
  expect(idx(r, ['real', 'a']).stdout.trim()).toBe('ran a');
});
