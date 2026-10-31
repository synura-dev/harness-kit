import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFlat as loadConfig } from './config.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-t-'));
const w = (n, s) => { const f = path.join(dir, n); fs.writeFileSync(f, typeof s === 'string' ? s : JSON.stringify(s)); return f; };
const defaults = { a: 1, o: { x: 1, y: 2 }, list: [1, 2, 3] };

test('missing file -> defaults, no warning', () => {
  const r = loadConfig({ defaults, files: [path.join(dir, 'nope.json')] });
  expect(r.config).toEqual(defaults);
  expect(r.warnings).toEqual([]);
});
test('broken JSON skipped with warning', () => {
  const r = loadConfig({ defaults, files: [w('bad.json', '{oops')] });
  expect(r.config).toEqual(defaults);
  expect(r.warnings.length).toBe(1);
});
test('non-object JSON skipped with warning', () => {
  const r = loadConfig({ defaults, files: [w('arr.json', '[1]'), w('num.json', '5')] });
  expect(r.config).toEqual(defaults);
  expect(r.warnings.length).toBe(2);
});
test('partial config deep-merges, layers in order', () => {
  const r = loadConfig({ defaults, files: [w('p1.json', { o: { y: 9 } }), w('p2.json', { o: { z: 3 }, a: 2 })] });
  expect(r.config).toEqual({ a: 2, o: { x: 1, y: 9, z: 3 }, list: [1, 2, 3] });
});
test('arrays replace', () => {
  expect(loadConfig({ defaults, files: [w('l.json', { list: [7] })] }).config.list).toEqual([7]);
});
test('env override with coercion and nested path', () => {
  process.env.T_CFG_A = '42'; process.env.T_CFG_Y = 'hi';
  const r = loadConfig({ defaults, env: { T_CFG_A: 'a', T_CFG_Y: 'o.y', T_CFG_NONE: 'o.q' } });
  expect(r.config.a).toBe(42);
  expect(r.config.o).toEqual({ x: 1, y: 'hi' });
  expect('q' in r.config.o).toBe(false);
});
test('unknown keys kept', () => {
  expect(loadConfig({ defaults, files: [w('u.json', { weird: { k: 1 } })] }).config.weird).toEqual({ k: 1 });
});
test('does not mutate defaults; no throw on junk input', () => {
  const d = { o: { x: 1 } };
  loadConfig({ defaults: d, files: [w('m.json', { o: { x: 2 } })] });
  expect(d.o.x).toBe(1);
  expect(() => loadConfig()).not.toThrow();
  expect(() => loadConfig({ defaults: null, files: 'x', env: null })).not.toThrow();
  expect(() => loadConfig({ files: [null, 5, dir] })).not.toThrow();
});
test('__proto__ not polluted', () => {
  loadConfig({ defaults, files: [w('pp.json', '{"__proto__":{"polluted":1}}')] });
  expect({}.polluted).toBeUndefined();
});
