import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPluginMode } from '../../core/io/paths.mjs';
import { scan, clean, adopt, stat, loadRegistry, inboxLs, inboxRm, inboxRestore, inboxPrune, inboxTarget } from './data.mjs';

// Registry mac dinh o plugin mode khong co muc workspace gemsocial (du lieu hub) -> bo sung muc tuong ung de fixture mk() khong bi coi la la.
const regOf = () => {
  const r = loadRegistry();
  if (!Object.values(r.entries).some((e) => e.path === 'workspaces/gemsocial/release')) r.entries['workspaces/gemsocial/release'] = { owner: 't', class: 'log', zone: 'workspaces', path: 'workspaces/gemsocial/release', retentionDays: null };
  return r;
};
const mk = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dat-'));
  fs.mkdirSync(path.join(root, 'system', 'play'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces', 'gemsocial', 'release'), { recursive: true });
  fs.mkdirSync(path.join(root, 'weird'));
  fs.writeFileSync(path.join(root, 'system', 'play', 'old.json'), '{}');
  fs.writeFileSync(path.join(root, 'system', 'play', 'new.json'), '{}');
  fs.writeFileSync(path.join(root, 'workspaces', 'gemsocial', 'release', 'runs.jsonl'), '{}');
  fs.writeFileSync(path.join(root, 'stray.log'), 'x');
  const old = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(path.join(root, 'system', 'play', 'old.json'), old, old);
  fs.utimesSync(path.join(root, 'workspaces', 'gemsocial', 'release', 'runs.jsonl'), old, old);
  return root;
};

test('scan: phat hien muc la', () => {
  const root = mk();
  assert.deepEqual(scan(root, regOf()).unknown.map((u) => u.name).sort(), ['stray.log', 'weird']);
});
test('scan: .harness-writers.json (data-stamp) la reserved, khong bao unregistered', () => {
  const root = mk();
  fs.writeFileSync(path.join(root, '.harness-writers.json'), '{}');
  assert.ok(!scan(root, regOf()).unknown.some((u) => u.name === '.harness-writers.json'));
  assert.ok(!scanZones({ root, reg: regOf(), write: false }).warnings.some((w) => w.rule === 'unregistered' && w.path === '.harness-writers.json'));
});
test('clean: dry-run khong xoa; --yes xoa file cu theo retention, giu muc retention null', () => {
  const root = mk();
  const d = clean({ root });
  assert.equal(d.dryRun, true);
  assert.deepEqual(d.removed, [path.join('system', 'play', 'old.json')]);
  assert.ok(fs.existsSync(path.join(root, 'system', 'play', 'old.json')));
  clean({ root, yes: true });
  assert.ok(!fs.existsSync(path.join(root, 'system', 'play', 'old.json')));
  assert.ok(fs.existsSync(path.join(root, 'system', 'play', 'new.json')));
  assert.ok(fs.existsSync(path.join(root, 'workspaces', 'gemsocial', 'release', 'runs.jsonl')));
});
test('adopt: chuyen vao _inbox, khong xoa; sau do scan sach', () => {
  const root = mk();
  assert.equal(adopt({ root, reg: regOf() }).moved.length, 2);
  assert.ok(fs.existsSync(path.join(root, 'stray.log')));
  const a = adopt({ root, reg: regOf(), yes: true });
  assert.ok(fs.existsSync(path.join(a.dest, 'stray.log')));
  assert.equal(scan(root, regOf()).unknown.length, 0);
});
test('stat + registry mac dinh co audit/release', () => {
  const r = loadRegistry();
  assert.ok(r.entries.audit);
  if (!isPluginMode()) assert.ok(Object.values(r.entries).some((e) => (e.path === 'workspaces/gemsocial/release' || e.legacy === 'release'))); // du lieu workspace chi co o hub
  assert.equal(stat(mk(), regOf()).rows.find((x) => x.name === 'weird').registered, false);
});

const mkInbox = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inb-')); // $HUB_DATA_DIR tam
  const d = path.join(root, '_inbox', '2020-01-01');
  fs.mkdirSync(path.join(d, 'tmp', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tmp', 'sub', 'a.txt'), 'abc');
  fs.writeFileSync(path.join(d, 'keep.log'), 'x');
  return root;
};
test('inbox ls: liet ke muc, file, size', () => {
  const l = inboxLs({ root: mkInbox() });
  assert.deepEqual(l.rows.map((r) => r.item).sort(), ['keep.log', 'tmp']);
  assert.equal(l.rows.find((r) => r.item === 'tmp').files, 1);
  assert.equal(inboxLs({ root: mkInbox(), limit: 1 }).rows.length, 1);
});
test('inbox rm: dry-run khong xoa; --yes xoa thu muc con', () => {
  const root = mkInbox();
  const p = path.join(root, '_inbox', '2020-01-01', 'tmp');
  assert.equal(inboxRm({ root, spec: '2020-01-01/tmp' }).dryRun, true);
  assert.ok(fs.existsSync(p));
  inboxRm({ root, spec: '2020-01-01/tmp', yes: true });
  assert.ok(!fs.existsSync(p));
  assert.ok(fs.existsSync(path.join(root, '_inbox', '2020-01-01', 'keep.log')));
});
test('inbox: chan duong dan xau', () => {
  const root = mkInbox();
  for (const bad of ['', '..', '../x', '2020-01-01/../..', '_inbox', '/etc/passwd', 'C:/x/y', '2020-01-01', 'abc/tmp', '2020-01-01/..']) assert.throws(() => inboxTarget(bad, root), undefined, bad);
  assert.throws(() => inboxRm({ root, spec: '_inbox', yes: true }));
  assert.ok(fs.existsSync(path.join(root, '_inbox')));
});
test('inbox restore: khong ghi de; restore khi chua ton tai', () => {
  const root = mkInbox();
  fs.mkdirSync(path.join(root, 'tmp'));
  assert.throws(() => inboxRestore({ root, spec: '2020-01-01/tmp', yes: true }), /khong ghi de/);
  inboxRestore({ root, spec: '2020-01-01/keep.log', yes: true });
  assert.ok(fs.existsSync(path.join(root, 'keep.log')));
});
test('inbox prune: dry-run; --yes xoa muc cu; days sai bi tu choi', () => {
  const root = mkInbox();
  assert.equal(inboxPrune({ root, days: 30 }).removed.length, 2);
  assert.ok(fs.existsSync(path.join(root, '_inbox', '2020-01-01', 'tmp')));
  assert.equal(inboxPrune({ root, days: 30, yes: true }).removed.length, 2);
  assert.equal(inboxLs({ root }).rows.length, 0);
  assert.throws(() => inboxPrune({ root, days: 0 }));
  assert.throws(() => inboxPrune({ root, days: 5000 }));
});

// ---- scanZones ----
import { scanZones } from './data.mjs';
const regZ = { enforce: 'warn', reserved: ['_inbox', '.state'], entries: {
  logs: { zone: 'system', class: 'log', owner: 'x', caps: { maxFiles: 2, maxDepth: 2 } },
  bad: { zone: 'system' },
  keep: { zone: 'knowledge', class: 'durable', owner: 'y' },
  'system/ng/tool': { zone: 'system', class: 'log', owner: 'z' },
} };
test('scanZones: la, thieu truong, caps, retention, inbox cu, cache, key zone/domain/tool', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scz-'));
  const old = new Date(Date.now() - 40 * 86400000);
  fs.mkdirSync(path.join(root, 'logs', 'a', 'b'), { recursive: true });
  for (const n of ['1', '2', '3']) fs.writeFileSync(path.join(root, 'logs', n + '.log'), 'x');
  fs.writeFileSync(path.join(root, 'logs', 'a', 'b', 'deep.log'), 'x');
  fs.utimesSync(path.join(root, 'logs', '1.log'), old, old);
  fs.mkdirSync(path.join(root, 'keep'));
  fs.mkdirSync(path.join(root, 'weird'));
  fs.mkdirSync(path.join(root, 'system', 'ng', 'tool'), { recursive: true });
  fs.mkdirSync(path.join(root, '_inbox', '2020-01-01'), { recursive: true });
  const r = scanZones({ root, reg: regZ, repoRoot: null });
  const rules = r.warnings.map((w) => w.rule + ':' + w.key);
  for (const x of ['unregistered:weird', 'missing-field:bad', 'over-caps:logs', 'retention:logs', 'stray:_inbox']) assert.ok(rules.includes(x), x);
  assert.ok(!rules.includes('unregistered:system'));
  assert.equal(r.warnings.filter((w) => w.rule === 'over-caps').length, 2);
  assert.ok(fs.existsSync(path.join(root, '.state', 'data-scan.json')));
  assert.equal(r.entries.logs.files, 4);
});
test('scanZones: clutter docs va goc repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scz-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'a.md'), '');
  fs.writeFileSync(path.join(repo, 'docs', 'x.log'), '');
  fs.writeFileSync(path.join(repo, 'junk.txt'), '');
  fs.writeFileSync(path.join(repo, 'README.md'), '');
  const r = scanZones({ root, reg: regZ, repoRoot: repo, write: false });
  assert.deepEqual(r.warnings.filter((w) => w.rule === 'clutter').map((w) => w.path).sort(), ['docs/x.log', 'junk.txt']);
});
test('loadRegistry: moi muc co zone/class/owner', () => {
  for (const [k, e] of Object.entries(loadRegistry().entries)) assert.ok(e.zone && e.class && e.owner, k);
});

// ---- F2: registry hong, clean theo class, tail ----
import { regUsable, tailDomain } from './data.mjs';
test('regUsable: failed hoac rong -> abort; adopt/clean khong cham thu muc', () => {
  const root = mk();
  const bad = { entries: { play: { class: 'log' } }, reserved: [], failed: true, failedFiles: ['x.json'] };
  assert.throws(() => regUsable(bad, 'clean'), /abort.*x\.json/);
  assert.throws(() => regUsable({ entries: {}, reserved: [] }, 'adopt'), /rong/);
  assert.throws(() => adopt({ root, reg: bad, yes: true }), /abort/);
  assert.throws(() => clean({ root, reg: bad, yes: true }), /abort/);
  assert.ok(fs.existsSync(path.join(root, 'weird')) && fs.existsSync(path.join(root, 'system', 'play', 'old.json')));
});
test('clean: muc moi khong retentionDays, class log -> 30 ngay; artifact khong bao gio', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-'));
  for (const d of ['lg', 'art']) { fs.mkdirSync(path.join(root, d)); fs.writeFileSync(path.join(root, d, 'o.txt'), 'x'); const o = new Date(Date.now() - 400 * 86400000); fs.utimesSync(path.join(root, d, 'o.txt'), o, o); }
  const reg = { entries: { lg: { class: 'log', zone: 'system', owner: 'o' }, art: { class: 'artifact', zone: 'system', owner: 'o' } }, reserved: [] };
  const c = clean({ root, reg, yes: true });
  assert.deepEqual(c.removed, [path.join('lg', 'o.txt')]);
  assert.ok(fs.existsSync(path.join(root, 'art', 'o.txt')));
  assert.equal(clean({ root, reg, yes: true, days: 1 }).removed.length, 0);
});
test('tail: N dong cuoi, cat truong dai, chi domain da dang ky', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const d = path.join(root, 'gateway', 'date=2026-01-01');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'a.jsonl'), [1, 2, 3, 4].map((i) => JSON.stringify({ i, type: i % 2 ? 'a' : 'b', big: 'x'.repeat(500) })).join('\n') + '\n');
  const reg = { entries: { gateway: { class: 'log', zone: 'system', owner: 'o' } }, reserved: [] };
  const t = tailDomain({ root, reg, domain: 'gateway', n: 2 });
  assert.deepEqual(t.rows.map((x) => x.i), [3, 4]);
  assert.ok(t.rows[0].big.length < 400);
  assert.deepEqual(tailDomain({ root, reg, domain: 'gateway', type: 'a' }).rows.map((x) => x.i), [1, 3]);
  assert.throws(() => tailDomain({ root, reg, domain: '..' }), /khong hop le/);
  assert.throws(() => tailDomain({ root, reg, domain: 'nope' }), /chua dang ky/);
  assert.equal(tailDomain({ root, reg, domain: 'gateway', n: 9999 }).rows.length, 4);
  assert.throws(() => tailDomain({ root, reg, domain: 'gateway', since: 'abc' }), /since/);
});
test('tail gateway: chi dong cong (audit/gateway), khong lay dong access cung audit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl2-'));
  const d = path.join(root, 'audit', 'gateway', 'date=2026-01-01');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'gateway.jsonl'), [1, 2, 3].map((i) => JSON.stringify({ i, ts: new Date().toISOString() })).join('\n') + '\n');
  const da = path.join(root, 'audit', 'access', 'date=2026-01-01'); fs.mkdirSync(da, { recursive: true });
  fs.writeFileSync(path.join(da, 'x.jsonl'), JSON.stringify({ i: 99, type: 'data-access' }) + '\n');
  const reg = { entries: { audit: { class: 'log', zone: 'system', owner: 'o', tailPaths: { gateway: 'gateway' } } }, reserved: [] };
  assert.deepEqual(tailDomain({ root, reg, domain: 'gateway', n: 5 }).rows.map((x) => x.i), [1, 2, 3]);
  assert.throws(() => tailDomain({ root, reg: { entries: { audit: { class: 'log', zone: 'system', owner: 'o' } }, reserved: [] }, domain: 'gateway' }), /chua dang ky/);
  assert.throws(() => tailDomain({ root, reg, domain: 'nope' }), /chua dang ky/);
});

test('scanZones: repoRootFiles mo rong (opts) cho phep file goc, khong con cung TASKS.md', () => {
  const rr = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  fs.writeFileSync(path.join(rr, 'TASKS.md'), 'x');
  const base = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'dz-')), repoRoot: rr, write: false };
  const p = (o) => scanZones({ ...base, opts: o }).warnings.filter((w) => w.rule === 'clutter').map((w) => w.path);
  assert.deepEqual(p({ repoRootFiles: [] }), ['TASKS.md']);
  assert.deepEqual(p({ repoRootFiles: ['TASKS.md'] }), []);
});

test('scan: chi deprecated-path (canh bao) -> exit 0; co vi pham that -> exit 1', async () => {
  const { run } = await import('./data.mjs');
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'dscan-'));
  const dd = path.join(hub, 'data');
  fs.mkdirSync(path.join(dd, 'workspaces', 'gem', 'oldtool'), { recursive: true });
  fs.writeFileSync(path.join(dd, 'workspaces', 'gem', 'oldtool', 'a.txt'), 'a');
  const rf = path.join(hub, 'registry.json');
  const ent = { zone: 'workspaces', class: 'artifact', owner: 'o', workspace: 'gem', path: 'workspaces/gem/oldtool', deprecatedPath: true };
  fs.writeFileSync(rf, JSON.stringify({ entries: { oldtool: ent }, reserved: [] }));
  const saved = { d: process.env.HUB_DATA_DIR, r: process.env.HARNESS_DATA_REGISTRY, w: process.env.HARNESS_DATA_WORKSPACES };
  const log = console.log;
  try {
    process.env.HUB_DATA_DIR = dd; process.env.HARNESS_DATA_REGISTRY = rf; process.env.HARNESS_DATA_WORKSPACES = path.join(hub, 'ws');
    console.log = () => {};
    const s = scanZones({ root: dd, reg: { entries: { oldtool: ent }, reserved: [] }, repoRoot: null, write: false, opts: {} });
    expect(s.warnings.map((w) => w.rule)).toEqual(['deprecated-path']);
    expect((await run(['scan'])).code).toBe(0);
    fs.mkdirSync(path.join(dd, 'strayzone'), { recursive: true });
    fs.writeFileSync(path.join(dd, 'strayzone', 'x.txt'), 'x');
    expect((await run(['scan'])).code).toBe(1);
  } finally {
    console.log = log;
    for (const [k, v] of [['HUB_DATA_DIR', saved.d], ['HARNESS_DATA_REGISTRY', saved.r], ['HARNESS_DATA_WORKSPACES', saved.w]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
