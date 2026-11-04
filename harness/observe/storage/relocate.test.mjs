import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relocateCmd } from './relocate.mjs';
import { mvpartCmd, movePartition } from './mvpart.mjs';
import { tailDomain } from './data.mjs';
import { loadDataRegistry, dataReadRoots, dataPathsFor } from '../../core/registry/data-registry.mjs';

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };

function mk(extra = {}) {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'reloc-'));
  const dd = path.join(hub, 'data');
  process.env.HUB_DATA_DIR = dd;
  fs.mkdirSync(dd, { recursive: true });
  const registryFile = path.join(hub, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({ entries: { audit: { zone: 'system', class: 'log', owner: 'o', tailPaths: { gw: 'gateway' } }, ...extra }, reserved: ['.state'] }));
  return { hub, dd, root: dd, registryFile, wsDir: path.join(hub, 'ws'), hubRoot: hub };
}
const put = (c, rel, text) => { const f = path.join(c.dd, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const regOf = (c) => JSON.parse(fs.readFileSync(c.registryFile, 'utf8')).entries;

test('relocate: dry-run khong ghi; --yes ghi path+legacy; thoat ve cu', async () => {
  const c = mk();
  put(c, 'audit/date=2020-01-01/x.jsonl', '{}\n');
  let r = await relocateCmd(['audit', 'system/audit'], c);
  expect(r.code).toBe(0);
  expect(regOf(c).audit.path).toBeUndefined();
  r = await relocateCmd(['audit', 'system/audit', '--yes'], c);
  expect(r.code).toBe(0);
  expect(regOf(c).audit.path).toBe('system/audit');
  expect(regOf(c).audit.legacy).toBe('audit');
  expect(fs.existsSync(path.join(c.dd, 'audit', 'date=2020-01-01', 'x.jsonl'))).toBe(true);
  r = await relocateCmd(['audit', 'audit', '--yes'], c);
  expect(r.code).toBe(0);
  expect(regOf(c).audit.path).toBe('audit');
  expect(regOf(c).audit.legacy).toBeUndefined();
});

test('relocate: tu choi .., tuyet doi, reserved, key la', async () => {
  const c = mk();
  for (const bad of ['../x', '/abs', 'C:/x', 'a/../b', '.state/x']) expect((await relocateCmd(['audit', bad, '--yes'], c)).code).toBe(2);
  expect((await relocateCmd(['nokey', 'system/x'], c)).code).toBe(2);
  expect(regOf(c).audit.path).toBeUndefined();
});

test('dataReadRoots/dataPathsFor: moi truoc, cu sau, chi ton tai', async () => {
  const c = mk({ audit: { zone: 'system', class: 'log', owner: 'o', path: 'audit' } });
  put(c, 'audit/a.jsonl', 'a');
  expect(dataReadRoots('audit', { noCache: true, registryFile: c.registryFile, workspacesDir: c.wsDir }).length).toBe(1);
  await relocateCmd(['audit', 'system/audit', '--yes'], c);
  const o = { noCache: true, registryFile: c.registryFile, workspacesDir: c.wsDir };
  expect(dataReadRoots('audit', o)).toContain(path.join(c.dd, 'audit')); // trace data-access nay ghi vao goc moi
  put(c, 'system/audit/b.jsonl', 'b');
  expect(dataReadRoots('audit', o)).toEqual([path.join(c.dd, 'system', 'audit'), path.join(c.dd, 'audit')]);
  expect(dataPathsFor('audit', 'b.jsonl', o)).toEqual([path.join(c.dd, 'system', 'audit', 'b.jsonl')]);
});

test('mvpart: chuyen phan vung cu, giu hom nay/hom qua, trung ten -> .legacy', async () => {
  const c = mk();
  await relocateCmd(['audit', 'system/audit', '--yes'], c);
  put(c, 'audit/date=2020-01-01/t/f.jsonl', 'old\n');
  put(c, 'audit/date=2020-01-02/g.jsonl', 'two\n');
  put(c, `audit/date=${dayAgo(0)}/h.jsonl`, 'today\n');
  put(c, `audit/date=${dayAgo(1)}/h.jsonl`, 'yday\n');
  put(c, 'system/audit/date=2020-01-02/g.jsonl', 'NEW\n');
  let r = await mvpartCmd(['audit'], c);
  expect(r.code).toBe(0);
  expect(r.partitions).toBe(2);
  expect(fs.existsSync(path.join(c.dd, 'audit', 'date=2020-01-01'))).toBe(true);
  r = await mvpartCmd(['audit', '--yes'], c);
  expect(r.moved).toBe(2);
  const na = path.join(c.dd, 'system', 'audit');
  expect(fs.readFileSync(path.join(na, 'date=2020-01-01', 't', 'f.jsonl'), 'utf8')).toBe('old\n');
  expect(fs.readFileSync(path.join(na, 'date=2020-01-02', 'g.jsonl'), 'utf8')).toBe('NEW\n');
  expect(fs.readFileSync(path.join(na, 'date=2020-01-02', 'g.legacy.jsonl'), 'utf8')).toBe('two\n');
  expect(fs.existsSync(path.join(c.dd, 'audit', 'date=2020-01-01'))).toBe(false);
  expect(fs.existsSync(path.join(c.dd, 'audit', `date=${dayAgo(0)}`, 'h.jsonl'))).toBe(true);
  expect(fs.existsSync(path.join(c.dd, 'audit', `date=${dayAgo(1)}`, 'h.jsonl'))).toBe(true);
});

test('mvpart: --keep-days 0 giu chi hom nay; EBUSY bo qua phan vung va hoan tac', async () => {
  const c = mk();
  await relocateCmd(['audit', 'system/audit', '--yes'], c);
  put(c, 'audit/date=2020-01-01/a.jsonl', 'a\n');
  put(c, 'audit/date=2020-01-01/b.jsonl', 'b\n');
  put(c, 'audit/date=2020-01-03/c.jsonl', 'c\n');
  put(c, `audit/date=${dayAgo(1)}/h.jsonl`, 'y\n');
  const real = fs.renameSync; let n = 0;
  const fsx = { renameSync: (a, b) => { if (a.includes('date=2020-01-01') && ++n === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real(a, b); } };
  const r = await mvpartCmd(['audit', '--yes', '--keep-days', '0'], { ...c, fsx });
  expect(r.skipped).toEqual(['date=2020-01-01']);
  expect(r.moved).toBe(2); // 2020-01-03 va hom qua
  expect(fs.existsSync(path.join(c.dd, 'audit', 'date=2020-01-01', 'a.jsonl'))).toBe(true);
  expect(fs.existsSync(path.join(c.dd, 'system', 'audit', 'date=2020-01-01', 'a.jsonl'))).toBe(false);
  expect(fs.existsSync(path.join(c.dd, 'system', 'audit', 'date=2020-01-03', 'c.jsonl'))).toBe(true);
});

test('movePartition: md5 lech (dich bi sua giua chung) -> hoan tac', () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const src = path.join(hub, 's'); const dst = path.join(hub, 'd');
  fs.mkdirSync(src); fs.writeFileSync(path.join(src, 'a.jsonl'), 'abc');
  const real = fs.renameSync;
  const fsx = { renameSync: (a, b) => { real(a, b); fs.writeFileSync(b, 'CORRUPT'); } };
  const r = movePartition(src, dst, { maxFiles: 100, deadline: Date.now() + 5000 }, fsx);
  expect(r.skipped).toBe(true);
  expect(fs.readFileSync(path.join(src, 'a.jsonl'), 'utf8')).toBe('CORRUPT');
});

test('tail: doc ca legacy va gop theo ts', () => {
  const c = mk();
  put(c, 'audit/date=2020-01-01/old.jsonl', JSON.stringify({ ts: '2020-01-01T00:00:01Z', n: 1 }) + '\n' + JSON.stringify({ ts: '2020-01-01T00:00:03Z', n: 3 }) + '\n');
  put(c, 'system/audit/date=2020-01-01/new.jsonl', JSON.stringify({ ts: '2020-01-01T00:00:02Z', n: 2 }) + '\n');
  put(c, 'audit/gateway/g.jsonl', JSON.stringify({ ts: '2020-01-01T00:00:09Z', n: 9 }) + '\n');
  const reg = loadDataRegistry({ registryFile: c.registryFile, workspacesDir: c.wsDir, noCache: true });
  reg.entries.audit.path = 'system/audit'; reg.entries.audit.legacy = 'audit';
  const t = tailDomain({ root: c.dd, reg, domain: 'audit', n: 10 });
  expect(t.rows.map((x) => x.n)).toEqual([1, 2, 3, 9]);
  const g = tailDomain({ root: c.dd, reg, domain: 'gw', n: 10 });
  expect(g.rows.map((x) => x.n)).toEqual([9]);
});

test('mvpart: --before chuyen ca hom nay; --rest chuyen file khong theo ngay, bo qua khoa', async () => {
  const c = mk();
  await relocateCmd(['audit', 'system/audit', '--yes'], c);
  const tom = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return ymd(d); })();
  put(c, `audit/date=${dayAgo(0)}/h.jsonl`, 'today\n');
  put(c, 'audit/.state/guard.json', '{"a":1}');
  put(c, 'audit/.state/mvpart.lock', 'x');
  put(c, 'audit/digest.md', 'dg');
  put(c, 'system/audit/digest.md', 'NEW');
  expect((await mvpartCmd(['audit', '--before', 'bad'], c)).code).toBe(2);
  const r = await mvpartCmd(['audit', '--yes', '--before', tom, '--rest'], c);
  expect(r.code).toBe(0);
  expect(r.moved).toBe(1);
  const na = path.join(c.dd, 'system', 'audit');
  expect(fs.readFileSync(path.join(na, `date=${dayAgo(0)}`, 'h.jsonl'), 'utf8')).toBe('today\n');
  expect(fs.readFileSync(path.join(na, '.state', 'guard.json'), 'utf8')).toBe('{"a":1}');
  expect(fs.readFileSync(path.join(na, 'digest.md'), 'utf8')).toBe('NEW');
  expect(fs.readFileSync(path.join(na, 'digest.legacy.md'), 'utf8')).toBe('dg');
  expect(fs.existsSync(path.join(c.dd, 'audit', '.state', 'guard.json'))).toBe(false);
});

test('mvpart: --drop-legacy bo legacy khoi registry khi legacy trong', async () => {
  const c = mk();
  await relocateCmd(['audit', 'system/audit', '--yes'], c);
  put(c, 'audit/guard/g.jsonl', 'g\n');
  const r = await mvpartCmd(['audit', '--yes', '--before', '2999-01-01', '--force', '--rest', '--drop-legacy'], c);
  expect(r.code).toBe(0);
  expect(regOf(c).audit.legacy).toBeUndefined();
  expect(regOf(c).audit.path).toBe('system/audit');
  expect(fs.readFileSync(path.join(c.dd, 'system', 'audit', 'guard', 'g.jsonl'), 'utf8')).toBe('g\n');
  expect(fs.existsSync(path.join(c.dd, 'audit', 'guard'))).toBe(false);
});

test('mvpart --rest: khong chuyen thu muc date= (giu bao ve hom nay)', async () => {
  const c = mk();
  await relocateCmd(['audit', 'system/audit', '--yes'], c);
  put(c, `audit/date=${dayAgo(0)}/h.jsonl`, 'today\n');
  put(c, 'audit/digest.md', 'dg');
  const r = await mvpartCmd(['audit', '--yes', '--rest'], c);
  expect(r.code).toBe(0);
  expect(fs.existsSync(path.join(c.dd, 'audit', `date=${dayAgo(0)}`, 'h.jsonl'))).toBe(true);
  expect(fs.existsSync(path.join(c.dd, 'system', 'audit', 'digest.md'))).toBe(true);
});

test('mvpart: --before tuong lai xa bi chan tru khi --force', async () => {
  const c = mk();
  await relocateCmd(['audit', 'system/audit', '--yes'], c);
  put(c, 'audit/date=2020-01-01/a.jsonl', 'a\n');
  expect((await mvpartCmd(['audit', '--yes', '--before', '2999-01-01'], c)).code).toBe(2);
  expect((await mvpartCmd(['audit', '--yes', '--before', '2999-01-01', '--force'], c)).code).toBe(0);
});

test('movePartition: writer ghi file moi giua chung -> khong bi xoa, duoc chuyen not', () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const src = path.join(hub, 's'); const dst = path.join(hub, 'd');
  fs.mkdirSync(src); fs.writeFileSync(path.join(src, 'a.jsonl'), 'abc');
  const real = fs.renameSync;
  let once = 0;
  const fsx = { renameSync: (a, b) => { real(a, b); if (once++) return; fs.mkdirSync(path.join(src, 'sub'), { recursive: true }); fs.writeFileSync(path.join(src, 'sub', 'new.jsonl'), 'NEWLOG'); } };
  const r = movePartition(src, dst, { maxFiles: 100, deadline: Date.now() + 5000 }, fsx);
  expect(r.moved).toBe(true);
  expect(fs.readFileSync(path.join(dst, 'sub', 'new.jsonl'), 'utf8')).toBe('NEWLOG');
  expect(fs.existsSync(src)).toBe(false);
});

test('movePartition: file la khong chuyen duoc -> giu thu muc va bao con lai', () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const src = path.join(hub, 's'); const dst = path.join(hub, 'd');
  fs.mkdirSync(src); fs.writeFileSync(path.join(src, 'a.jsonl'), 'abc');
  const real = fs.renameSync; let n = 0;
  const fsx = { renameSync: (a, b) => { if (++n > 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); real(a, b); fs.writeFileSync(path.join(src, 'x.jsonl'), 'X'); }};// Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
  const r = movePartition(src, dst, { maxFiles: 100, deadline: Date.now() + 5000 }, fsx);
  expect(r.moved).toBe(true);
  expect(r.conLai).toEqual(['x.jsonl']);
  expect(fs.readFileSync(path.join(src, 'x.jsonl'), 'utf8')).toBe('X');
});

test('movePartition: rollback khong de file moi cua writer', () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const src = path.join(hub, 's'); const dst = path.join(hub, 'd');
  fs.mkdirSync(src); fs.writeFileSync(path.join(src, 'a.jsonl'), 'abc');
  const real = fs.renameSync;
  const fsx = { renameSync: (a, b) => { real(a, b); fs.writeFileSync(b, 'CORRUPT'); fs.writeFileSync(a, 'WRITER'); } };
  const r = movePartition(src, dst, { maxFiles: 100, deadline: Date.now() + 5000 }, fsx);
  expect(r.skipped).toBe(true);
  expect(fs.readFileSync(path.join(src, 'a.jsonl'), 'utf8')).toBe('WRITER');
  expect(fs.readFileSync(path.join(dst, 'a.jsonl'), 'utf8')).toBe('CORRUPT');
});
