import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// --json that su cho doctor / worktree list / evolve list|queue / observe sizes / data stat (spawn CLI that tren hub tam)
const H = path.join(import.meta.dir, '..', 'harness.mjs');
const hub = () => {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'k2-')));
  fs.mkdirSync(path.join(r, 'config'), { recursive: true });
  fs.mkdirSync(path.join(r, 'data', 'zoneA'), { recursive: true });
  fs.writeFileSync(path.join(r, 'data', 'zoneA', 'f.txt'), 'hello');
  const g = (...a) => spawnSync('git', a, { cwd: r, encoding: 'utf8', timeout: 30000 });
  g('init', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '.'); g('commit', '-m', 'i', '--allow-empty');
  return r;
};
const run = (r, args) => spawnSync('node', [H, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HUB_DIR: r } });
const j = (r, args) => JSON.parse(run(r, args).stdout);

test('doctor --json: {checks:[{level,name,detail}]}; text mac dinh giu nguyen', () => {
  const r = hub();
  const o = j(r, ['doctor', '--json']);
  expect(Array.isArray(o.checks)).toBe(true);
  expect(o.checks.length).toBeGreaterThan(0);
  for (const c of o.checks) expect(Object.keys(c).sort()).toEqual(['detail', 'level', 'name']);
  expect(o.checks.some((c) => c.name.startsWith('node '))).toBe(true);
  expect(run(r, ['doctor']).stdout).toContain('[OK]   node ');
});

test('constrain worktree list --json: {items,total}', () => {
  const r = hub();
  const o = j(r, ['constrain', 'worktree', 'list', '--json']);
  expect(o.total).toBe(o.items.length);
  expect(Object.keys(o.items[0]).sort()).toEqual(['branch', 'path', 'source', 'state', 'unmerged']);
  expect(o.items[0].source).toBe('main');
  expect(run(r, ['constrain', 'worktree', 'list']).stdout).toContain('source\tbranch\tstate\tunmerged\tpath');
});

test('evolve list|queue --json: JSON hop le', () => {
  const r = hub();
  expect(Array.isArray(j(r, ['evolve', 'list', '--json']))).toBe(true);
  const q = j(r, ['evolve', 'queue', '--json']);
  expect(Array.isArray(q.items)).toBe(true);
  expect(typeof q.total).toBe('number');
});

test('observe sizes --json: {items:[{zone,bytes}]}', () => {
  const r = hub();
  const o = j(r, ['observe', 'sizes', '--json']);
  expect(o.items.find((x) => x.zone === 'zoneA')).toEqual({ zone: 'zoneA', bytes: 5 });
  expect(o.truncated).toBe(null);
  expect(run(r, ["observe", "sizes"]).stdout).toContain("bytes, ");
});

test('data stat --json: {items,files,bytes,outside_registry,truncated}', () => {
  const r = hub();
  const o = j(r, ['data', 'stat', '--json']);
  expect(Array.isArray(o.items)).toBe(true);
  for (const k of ['files', 'bytes', 'outside_registry']) expect(typeof o[k]).toBe('number');
  expect('truncated' in o).toBe(true);
  expect(run(r, ['data', 'stat']).stdout).toContain('ngoai registry');
});
