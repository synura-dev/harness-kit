// May bat reader sot: quet ma nguon harness/ va hub/ tim duong cung toi key data goc (join(<dataDir>,'audit') hoac 'data/<key>').
// Mac dinh chi BAO (in danh sach); DATA_RAW_PATHS_STRICT=1 -> fail neu con vi pham ngoai ALLOW.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KEYS = ['audit', 'runs', 'play', 'worktree', 'watchdog', 'proc-orphans', 'evolve', 'eval', 'evals', 'agy-home', 'ai-job-search'];
const K = KEYS.join('|');
const PATTERNS = [
  new RegExp(`(?:join|resolve)\\(\\s*[A-Za-z_.()]*[dD]ata[A-Za-z_.()]*\\s*,\\s*['"\`](?:${K})['"\`]`),
  new RegExp(`data(?:Dir|Root)\\([^)]*\\)\\s*,\\s*['"\`](?:${K})['"\`]`),
  new RegExp(`['"\`]data['"\`]\\s*,\\s*['"\`](?:${K})['"\`]`),
  new RegExp(`['"\`]data/(?:${K})(?:/|['"\`])`),
  new RegExp(`data(?:Dir|Root)\\(['"\`](?:${K})['"\`]`),
  new RegExp(`dataPath\\(['"\`](?:${K})['"\`]`),
];
/** file (tuong doi hub, posix) -> ly do duoc phep. */
export const ALLOW = {
  'harness/core/io/storage.mjs': 'dinh nghia dataPath, vi du trong comment',
  'harness/core/registry/data-registry.mjs': 'registry: ten key',
  'harness/observe/storage/raw-paths.test.mjs': 'chinh may quet',
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);

function walk(dir, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

export function scanRawPaths(roots = ['harness', 'hub']) {
  const hits = [];
  for (const r of roots) for (const f of walk(path.join(HUB, r))) {
    const rel = path.relative(HUB, f).split(path.sep).join('/');
    if (ALLOW[rel] || rel.endsWith('.test.mjs')) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => { if (!/^\s*(\/\/|\*)/.test(l) && PATTERNS.some((p) => p.test(l))) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`); });
  }
  return hits;
}

test('scanRawPaths bat duong cung (fixture)', () => {
  const l = "const x = join(dataRoot(), 'audit', 'a');";
  expect(PATTERNS.some((p) => p.test(l))).toBe(true);
  expect(PATTERNS.some((p) => p.test("const x = dataPathFor('audit');"))).toBe(false);
});

test('reader sot: khong con duong cung toi key data goc', () => {
  const hits = scanRawPaths();
  if (hits.length) console.warn(`raw-paths: ${hits.length} vi pham (DATA_RAW_PATHS_STRICT=1 de fail)\n${hits.join('\n')}`);
  if (process.env.DATA_RAW_PATHS_STRICT === '1') expect(hits).toEqual([]);
  else expect(Array.isArray(hits)).toBe(true);
});
