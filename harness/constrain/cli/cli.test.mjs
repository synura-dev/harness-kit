import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listHookModules, run, forwardArgs } from './cli.mjs';
import { parseCommon } from '../../core/io/out.mjs';

test('hooks: liet ke module that cua dispatcher, moi module nap duoc va co handle()', async () => {
  const { rows, truncated } = await listHookModules();
  expect(truncated).toBeNull();
  const ids = rows.map((r) => r.id);
  for (const id of ['guard', 'approval', 'bash-guard', 'audit', 'verify-gate']) expect(ids).toContain(id);
  expect(rows.every((r) => r.status === 'ok')).toBe(true);
  expect(rows.find((r) => r.id === 'guard').gate).toBe(true);
  expect(rows.find((r) => r.id === 'audit').events).toContain('PreToolUse');
});

test('hooks: module loi nap -> status error, khong nem', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'constrain-'));
  const f = path.join(d, 'modules.mjs');
  fs.writeFileSync(f, "export const ORDER = { Stop: [{ id: 'bad', load: () => Promise.reject(new Error('boom')) }, { id: 'nohandle', load: async () => ({ default: {} }) }] };\n");
  const { rows } = await listHookModules({ modulesFile: f });
  expect(rows.map((r) => [r.id, r.status])).toEqual([['bad', 'error'], ['nohandle', 'error']]);
  fs.rmSync(d, { recursive: true, force: true });
});

test('usage: lenh con la -> code 2', async () => {
  const errs = [];
  expect((await run(['bogus'], { emitOpts: { err: (m) => errs.push(m) } })).code).toBe(2);
  expect(errs.join('')).toContain('usage');
});

test('config: forward --raw/--max-bytes/--timeout-s/--json xuong CLI con (khong bi nuot)', () => {
  const c = parseCommon(['config', 'show', '--raw', '--max-bytes', '123', '--timeout-s', '7', '--json']);
  expect(forwardArgs(c, c.rest.slice(1))).toEqual(['show', '--json', '--raw', '--max-bytes', '123', '--timeout-s', '7']);
  expect(forwardArgs(parseCommon(['config', 'show']), ['show'])).toEqual(['show']);
});
