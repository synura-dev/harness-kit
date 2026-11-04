import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPath, appendJsonl, readJsonl, writeJson, readJson } from './storage.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stor-'));
const env = { HUB_DATA_DIR: tmp };

test('dataPath: layout + env', () => {
  assert.equal(dataPath('release', null, 'runs.jsonl', { env }), path.join(tmp, 'release', 'runs.jsonl'));
  assert.equal(dataPath('audit', 'x', 'date=2026-01-01', 'a.jsonl', { env }), path.join(tmp, 'audit', 'x', 'date=2026-01-01', 'a.jsonl'));
});
test('dataPath: chan ten sai va thoat data/', () => {
  const bads = [() => dataPath('..', null, { env }), () => dataPath('a/b', null, { env }), () => dataPath('a', '..', { env }), () => dataPath('a', null, '..', 'x', { env }), () => dataPath('a', null, '../x', { env }), () => dataPath('a', null, 'c:evil', { env })];
  for (const bad of bads) assert.throws(bad);
});
test('append/read/write json', () => {
  const f = dataPath('t', 'k', 'a.jsonl', { env });
  assert.ok(appendJsonl(f, { a: 1 }));
  appendJsonl(f, { a: 2 });
  assert.deepEqual(readJsonl(f), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(readJsonl(f, { limit: 1 }), [{ a: 2 }]);
  const j = dataPath('t', 'k', 'b.json', { env });
  writeJson(j, { x: 1 });
  assert.deepEqual(readJson(j), { x: 1 });
  assert.equal(readJson(path.join(tmp, 'none'), 7), 7);
});
test('appendJsonl xoay khi vuot maxBytes', () => {
  const f = dataPath('t', 'k', 'r.jsonl', { env });
  appendJsonl(f, { a: 'x'.repeat(50) });
  appendJsonl(f, { b: 1 }, { maxBytes: 10 });
  assert.ok(fs.existsSync(f + '.old'));
  assert.deepEqual(readJsonl(f), [{ b: 1 }]);
});
