import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFiles, buildRegistry, buildScanInput } from './scan-input.mjs';

const mk = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'si-'));
  const w = (rel, s = '') => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), s); };
  return { r, w };
};

test('collectFiles: doc noi dung, data chi lay kich thuoc, bo node_modules', () => {
  const { r, w } = mk();
  w('harness/cli/a.mjs', 'x\ny'); w('data/big.jsonl', 'abc'); w('harness/node_modules/z.mjs', 'z'); w('outside/q.md', 'q');
  const { files, truncated } = collectFiles(r);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  expect(by['harness/cli/a.mjs'].lines).toBe(2);
  expect(by['data/big.jsonl'].content).toBeUndefined();
  expect(by['data/big.jsonl'].bytes).toBe(3);
  expect(by['harness/node_modules/z.mjs']).toBeUndefined();
  expect(by['outside/q.md']).toBeUndefined();
  expect(truncated).toBe(false);
});

test('collectFiles: limit -> truncated', () => {
  const { r, w } = mk();
  w('harness/a.mjs', '1'); w('harness/b.mjs', '2'); w('harness/c.mjs', '3');
  const res = collectFiles(r, { maxFiles: 2 });
  expect(res.files.length).toBe(2);
  expect(res.truncated).toBe('limit');
});

test('buildRegistry: manifest -> dir/entry tuong doi, registered tu manifest.domains, referenced', () => {
  const { r, w } = mk();
  w('harness/hooks/h/manifest.json', JSON.stringify({ id: 'h', kind: 'hook', layer: 'ext', entry: 'h.mjs', tests: ['h.test.mjs'] }));
  w('harness/cli/manifest.json', JSON.stringify({ id: 'cli', kind: 'cli', layer: 'core', entry: 'harness.mjs', domain: 'harness', domains: { d: { file: 'd.mjs', desc: 'D' } } }));
  w('harness/cli/d.mjs', "import x from '../../harness/config/used.json'");
  const { files } = collectFiles(r);
  const reg = buildRegistry(r, files);
  expect(reg.manifests.find((m) => m.dir === 'harness/hooks/h')).toMatchObject({ entry: 'h.mjs', tests: ['h.test.mjs'] });
  expect(reg.registered).toContain('harness/cli/d.mjs');
  expect(reg.referenced).toContain('config/used.json');
});

test('buildRegistry: plugin co manifest.json khong mo coi; hook: file duoc import la helper', () => {
  const { r, w } = mk();
  w('harness/plugins/p/manifest.json', JSON.stringify({ id: 'p', kind: 'cli', layer: 'ext', entry: 'p.mjs', domain: 'p', tests: ['p.test.mjs'], config: { defaults: null, schema: null }, files: { helpers: [] } }));
  w('harness/plugins/p/p.mjs', 'x'); w('harness/plugins/p/p.test.mjs', 'x');
  w('harness/hooks/h/manifest.json', JSON.stringify({ id: 'h', kind: 'hook', layer: 'ext', entry: 'h.mjs', tests: ['h.test.mjs'] }));
  w('harness/hooks/h/h.mjs', "import './used.mjs'"); w('harness/hooks/h/used.mjs', 'x'); w('harness/hooks/h/lone.mjs', 'x'); w('harness/hooks/h/h.test.mjs', 'x');
  const { files } = collectFiles(r);
  const reg = buildRegistry(r, files);
  expect(reg.manifests.find((m) => m.dir === 'harness/plugins/p')).toMatchObject({ entry: 'p.mjs', tests: ['p.test.mjs'] });
  const h = reg.manifests.find((m) => m.dir === 'harness/hooks/h');
  expect(h.files.helpers).toContain('used.mjs');
  expect(h.files.helpers).not.toContain('lone.mjs');
});

test('buildScanInput: thieu manifest khong nem loi; exists thuc', () => {
  const { r, w } = mk();
  w('harness/cli/a.mjs', 'x');
  const si = buildScanInput(r);
  expect(si.registry.manifests).toEqual([]);
  expect(si.exists('harness/cli/a.mjs')).toBe(true);
  expect(si.exists('harness/cli/nope.mjs')).toBe(false);
});

import { makeIgnore, literalRefs } from './scan-input.mjs';

test('collectFiles: bo file gitignore/*.local.* nhung giu data/', () => {
  const { r, w } = mk();
  w('.gitignore', 'config/guard/*.json\n!config/guard/*.example.json\ndata/\n');
  w('config/guard/g.json', '{"a":1}'); w('config/guard/g.example.json', '{"a":1}');
  w('config/x.local.json', '{"a":1}'); w('data/k.txt', '');
  const paths = collectFiles(r).files.map((x) => x.path).sort();
  expect(paths).toEqual(['config/guard/g.example.json', 'data/k.txt']);
});

test('makeIgnore: cha bi ignore thi con cung ignore', () => {
  const ig = makeIgnore('tmp/\n*.log\n');
  expect(ig('tmp/a/b.txt')).toBe(true);
  expect(ig('x/y.log')).toBe(true);
  expect(ig('src/a.txt')).toBe(false);
});

test('helper-match: trung ten khac thu muc / chuoi con khong duoc tinh', () => {
  const { r, w } = mk();
  w('harness/hooks/h/manifest.json', JSON.stringify({ id: 'h', kind: 'hook', layer: 'ext', entry: 'hook.mjs' }));
  w('harness/hooks/h/hook.mjs', "import { a } from './lib/util.mjs'; // my-util.mjs\n");
  w('harness/hooks/h/lib/util.mjs', 'export const a = 1;');
  w('harness/hooks/h/util.mjs', 'export const b = 2;'); // cung ten, khac duong dan: mo coi
  w('harness/hooks/h/my.mjs', 'export const c = 3;');
  const { files } = collectFiles(r);
  const h = buildRegistry(r, files).manifests.find((m) => m.dir === 'harness/hooks/h');
  expect(h.files.helpers).toContain('lib/util.mjs');
  expect(h.files.helpers).not.toContain('util.mjs');
  expect(h.files.helpers).not.toContain('my.mjs');
});

test('literalRefs: import tuong doi + literal path.join', () => {
  const t = literalRefs({ path: 'harness/hooks/h/hook.mjs', content: "import x from './a/b.mjs'; join(HERE,'hook.config.json'); import('../_shared/c')" });
  expect(t.has('harness/hooks/h/a/b.mjs')).toBe(true);
  expect(t.has('harness/hooks/h/hook.config.json')).toBe(true);
  expect(t.has('harness/hooks/_shared/c.mjs')).toBe(true);
});
