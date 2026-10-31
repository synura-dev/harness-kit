// ctx.config: nap config qua loader loi; khoa nhay cam khong qua duoc lop du an; version 1.1.0 van thoa ^1.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCtx, loadExtConfig, ctxCompatible, CTX_VERSION, CONFIG_DENY_KEYS } from './ctx.mjs';

const _old = { d: process.env.HUB_DATA_DIR, a: process.env.CLAUDE_AUDIT_DIR };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extc-'));
process.env.HUB_DATA_DIR = path.join(tmp, 'dd');
process.env.CLAUDE_AUDIT_DIR = path.join(tmp, 'audit');
afterAll(() => { for (const [k, v] of [['HUB_DATA_DIR', _old.d], ['CLAUDE_AUDIT_DIR', _old.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, 'config', 'registry'), { recursive: true });
fs.writeFileSync(path.join(ws, 'config', 'registry', 'local.json'), JSON.stringify({ projects_root: 'X', defaults: { max_concurrent: 5 } }));

test('version 1.1.0 va requires ^1 thoa', () => {
  expect(CTX_VERSION).toBe('1.1.0');
  expect(ctxCompatible('^1')).toBe(true);
  expect(ctxCompatible('^2')).toBe(false);
});

test('ctx.config nap lop may + env HARNESS_REGISTRY_*', () => {
  const ctx = buildCtx({ extId: 'cfgt', workspace: ws });
  const r = ctx.config('registry', { defaults: { projects_root: '', defaults: { max_concurrent: 2 }, projects: [] }, env: { ...process.env, HARNESS_REGISTRY_PROJECTS_ROOT: 'ENV' } });
  expect(r.config.defaults.max_concurrent).toBe(5);
  expect(r.config.projects_root).toBe('ENV');
  const r2 = ctx.config('registry', { defaults: { projects_root: '', defaults: { max_concurrent: 2 } }, env: {} });
  expect(r2.config.projects_root).toBe('X');
});

test('khoa nhay cam bi chan o lop du an', () => {
  expect(CONFIG_DENY_KEYS).toEqual(expect.arrayContaining(['extRoots', 'extensions', 'projectResolver', 'ownerRoots', 'knowledge']));
  const r = loadExtConfig('nothing', { defaults: { a: 1 }, root: ws, env: {} });
  expect(r.config.a).toBe(1);
  expect(Array.isArray(r.warnings)).toBe(true);
});
