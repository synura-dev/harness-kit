import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanAuto } from './data.mjs';

const DAY = 86400000;
const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ca-'));
const put = (root, rel, ageDays, size = 10) => {
  const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'.repeat(size));
  const t = new Date(Date.now() - ageDays * DAY); fs.utimesSync(p, t, t); return p;
};
const reg = () => ({ entries: {
  lg: { class: 'log', zone: 'system', owner: 'o' },
  cc: { class: 'cache', zone: 'system', owner: 'o' },
  pl: { class: 'log', zone: 'system', owner: 'o', retentionDays: 14 },
  art: { class: 'artifact', zone: 'system', owner: 'o', retentionDays: 1 },
  dur: { class: 'durable', zone: 'system', owner: 'o' },
  audit: { class: 'log', zone: 'system', owner: 'o', retentionDays: 90 },
}, reserved: [] });

test('auto: xoa log/cache qua han, giu artifact/durable/hom nay/audit hom nay', () => {
  const r = mkRoot();
  const old = put(r, 'lg/a.log', 40); const fresh = put(r, 'lg/b.log', 1); const today = put(r, 'lg/c.log', 0);
  const oc = put(r, 'cc/x.json', 10); const op = put(r, 'pl/y.log', 20); const keepPl = put(r, 'pl/z.log', 10);
  const art = put(r, 'art/o.bin', 400); const dur = put(r, 'dur/o.json', 400);
  const now = new Date(); const tag = `date=${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const au = put(r, `audit/${tag}/e.jsonl`, 100); const auOld = put(r, 'audit/date=2020-01-01/e.jsonl', 100);
  const dry = cleanAuto({ root: r, reg: reg() });
  assert.equal(dry.dryRun, true); assert.equal(dry.files, 4); assert.ok(fs.existsSync(old));
  const res = cleanAuto({ root: r, reg: reg(), yes: true });
  assert.equal(res.files, 4); assert.equal(res.byEntry.lg, 1);
  for (const p of [old, oc, op, auOld]) assert.ok(!fs.existsSync(p), p);
  for (const p of [fresh, today, keepPl, art, dur, au]) assert.ok(fs.existsSync(p), p);
});

test('auto: tran maxFiles dung em', () => {
  const r = mkRoot();
  for (let i = 0; i < 5; i++) put(r, `lg/f${i}.log`, 60);
  const res = cleanAuto({ root: r, reg: reg(), yes: true, maxFiles: 2 });
  assert.equal(res.files, 2); assert.match(res.truncated, /max-files 2/);
  assert.equal(fs.readdirSync(path.join(r, 'lg')).length, 3);
  const b = cleanAuto({ root: r, reg: reg(), yes: true, maxBytes: 15 });
  assert.equal(b.files, 1); assert.match(b.truncated, /max-bytes/);
});

test('auto: symlink ra ngoai khong bi di theo / xoa dich', () => {
  const r = mkRoot(); const out = mkRoot();
  const target = put(out, 'victim.log', 100);
  put(r, 'cc/keep.json', 0);
  try { fs.symlinkSync(out, path.join(r, 'lg'), 'junction'); } catch {}
  try { fs.mkdirSync(path.join(r, 'pl')); fs.symlinkSync(target, path.join(r, 'pl', 'l.log')); } catch {}
  const res = cleanAuto({ root: r, reg: reg(), yes: true });
  assert.equal(res.files, 0); assert.ok(fs.existsSync(target));
});

test('auto: registry hong abort, khong xoa', () => {
  const r = mkRoot(); const f = put(r, 'lg/a.log', 90);
  assert.throws(() => cleanAuto({ root: r, reg: { failed: true, entries: {}, reserved: [] }, yes: true }), /abort/);
  assert.throws(() => cleanAuto({ root: r, reg: { entries: {}, reserved: [] }, yes: true }), /abort/);
  assert.ok(fs.existsSync(f));
});
