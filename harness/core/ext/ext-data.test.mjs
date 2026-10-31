// Manifest external: dinh dang domain(s) + khai bao data cho ctx.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadExternals } from './ext-host.mjs';

const _old = { d: process.env.HUB_DATA_DIR, a: process.env.CLAUDE_AUDIT_DIR };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extd-'));
const DATA = path.join(tmp, 'dd');
process.env.HUB_DATA_DIR = DATA;
process.env.CLAUDE_AUDIT_DIR = path.join(tmp, 'audit');
afterAll(() => { for (const [k, v] of [['HUB_DATA_DIR', _old.d], ['CLAUDE_AUDIT_DIR', _old.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const mk = (name, manifest) => {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export const main = () => 0;');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: name, entry: 'main.mjs', requires: { ctx: '^1' }, ...manifest }));
  return { id: name, root };
};

test('manifest: domain string, domains mang, domains object deu nap duoc; data khai bao di theo ext', () => {
  const a = mk('fmt-a', { domain: 'fa' });
  const b = mk('fmt-b', { domains: ['fb1', 'fb2'] });
  const c = mk('fmt-c', { domain: 'fc', domains: { fc2: { file: 'main.mjs' } }, data: [{ zone: 'knowledge', path: 'fmt-c', class: 'durable', tool: 'fc' }, { zone: 'bad', path: 'x' }] });
  const r = loadExternals([a, b, c], { coreDomains: {} });
  expect(Object.keys(r.byDomain).sort()).toEqual(['fa', 'fb1', 'fb2', 'fc', 'fc2']);
  expect(r.byDomain.fc.data.length).toBe(2);
  expect(r.errors.some((e) => e.includes('zone khong hop le'))).toBe(true);
});

test('manifest that hub/tasks va hub/dispatch nap duoc', () => {
  const root = path.resolve(import.meta.dir, '..', '..', '..');
  const r = loadExternals([{ root: path.join(root, 'hub', 'tasks') }, { root: path.join(root, 'hub', 'dispatch') }], { coreDomains: {} });
  expect(r.errors).toEqual([]);
  expect(Object.keys(r.byDomain).sort()).toEqual(['dispatch-worker', 'tasks']);
});

test('ctx: ghi chi trong zone mac dinh + muc data khai bao; entryPath thieu khai bao nem', async () => {
  const { buildCtx } = await import('./ctx.mjs');
  const ctx = buildCtx({ extId: 'dd', data: [{ zone: 'knowledge', path: 'dd', class: 'durable', tool: 'dd' }] });
  const p = ctx.storage.entryPath('dd', 'a.jsonl');
  expect(p).toBe(path.join(DATA, 'knowledge', 'dd', 'a.jsonl'));
  expect(ctx.storage.appendJsonl(p, { a: 1 })).toBeTruthy();
  const other = path.join(DATA, 'knowledge', 'other', 'x.json');
  expect(() => ctx.storage.writeJson(other, {})).toThrow();
  expect(() => ctx.storage.entryPath('nope')).toThrow();
  expect(ctx.storage.guardWrite(other).ok).toBe(false);
});
