import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStamp, readStamps, compareStamps, stampSession, DATA_SCHEMA, STAMP_FILE } from './data-stamp.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hk-stamp-'));

test('writeStamp: tao file, chi co version/schema/at, khong lo lastUserInput/args', () => {
  const d = tmp();
  writeStamp(d, { tool: 'claude', version: '0.3.12', now: 1000 });
  const j = JSON.parse(fs.readFileSync(path.join(d, STAMP_FILE), 'utf8'));
  expect(Object.keys(j)).toEqual(['claude']);
  expect(Object.keys(j.claude).sort()).toEqual(['at', 'schema', 'version']);
  expect(j.claude.schema).toBe(DATA_SCHEMA);
});

test('writeStamp: chi cap nhat khoa cua tool, giu khoa kia + truong la', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, STAMP_FILE), JSON.stringify({ agy: { version: '9.0.0', schema: 1, at: 'x', extra: 7 }, note: 'giu' }));
  writeStamp(d, { tool: 'claude', version: '1.0.0', now: 5 });
  const j = readStamps(d);
  expect(j.agy).toEqual({ version: '9.0.0', schema: 1, at: 'x', extra: 7 });
  expect(j.note).toBe('giu');
  expect(j.claude.version).toBe('1.0.0');
});

test('readStamps: file hong/vang/khong phai object -> {}', () => {
  const d = tmp();
  expect(readStamps(d)).toEqual({});
  fs.writeFileSync(path.join(d, STAMP_FILE), '{hong');
  expect(readStamps(d)).toEqual({});
  fs.writeFileSync(path.join(d, STAMP_FILE), '[1]');
  expect(readStamps(d)).toEqual({});
});

test('compareStamps: version/schema cua tool kia cao hon -> canh bao; bang/cu hon -> khong; semver so, khong chuoi', () => {
  const self = { tool: 'claude', version: '0.3.12', schema: 1 };
  expect(compareStamps(self, { agy: { version: '0.3.13', schema: 1 } })).toHaveLength(1);
  expect(compareStamps(self, { agy: { version: '0.10.0', schema: 1 } })).toHaveLength(1); // chuoi: '0.10.0' < '0.3.12'
  expect(compareStamps(self, { agy: { version: '0.3.12', schema: 1 } })).toEqual([]);
  expect(compareStamps(self, { agy: { version: '0.3.2', schema: 1 } })).toEqual([]);
  const w = compareStamps(self, { agy: { version: '0.3.12', schema: 2 } });
  expect(w).toHaveLength(1);
  expect(w[0]).toMatch(/schema/);
  expect(compareStamps(self, { claude: { version: '9.9.9', schema: 9 } })).toEqual([]); // khoa cua chinh minh bo qua
  expect(compareStamps(self, { agy: 'rac', x: null })).toEqual([]);
});

test('stampSession: ghi stamp theo manifest cua plugin; loi -> khong nem', () => {
  const d = tmp(); const root = tmp();
  fs.mkdirSync(path.join(root, '.antigravity-plugin'));
  fs.writeFileSync(path.join(root, '.antigravity-plugin', 'plugin.json'), JSON.stringify({ version: '2.0.0' }));
  expect(stampSession('agy', { dataRoot: d, root, now: 1 })).toBe(true);
  expect(readStamps(d).agy.version).toBe('2.0.0');
  expect(stampSession('claude', { dataRoot: d, root, now: 1 })).toBe(false); // khong co manifest claude
});
