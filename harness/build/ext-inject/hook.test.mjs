import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, clip, parseInject, defaultRun, handle } from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/contract.mjs';
import mod from './hook.mjs';
import { hashTree, extensionStatus } from '../../core/ext/ext-trust.mjs';

const INJ = { inject: { events: ['SessionStart', 'SubagentStart'], args: ['show', '--cwd', '{cwd}', '--inject'] } };
const mk = (over = {}) => {
  const calls = [];
  const ctx = {
    cfg: DEFAULTS,
    list: () => [{ id: 'alpha', root: '/x/alpha' }],
    readManifest: () => INJ,
    status: () => 'ok',
    run: (id, args, o) => { calls.push({ id, args, o }); return 'line1\nline2'; },
    ...over,
  };
  return { ctx, calls };
};

test('ext co inject chay voi {cwd} thay bang cwd su kien va chen vao additionalContext', async () => {
  const { ctx, calls } = mk();
  const cwd = path.resolve('/proj/a');
  const r = await handle('SessionStart', { cwd }, ctx);
  expect(r).toEqual({ additionalContext: 'line1\nline2' });
  expect(calls).toHaveLength(1);
  expect(calls[0].id).toBe('alpha');
  expect(calls[0].args).toEqual(['show', '--cwd', cwd, '--inject']);
  expect(validateHookResult(r)).toEqual([]);
});
test('nhieu ext: noi output theo thu tu, ext khong khai inject bi bo qua', async () => {
  const { ctx } = mk({ list: () => [{ id: 'a', root: 'a' }, { id: 'b', root: 'b' }, { id: 'c', root: 'c' }], readManifest: (r) => (r === 'b' ? {} : INJ), run: (id) => `out-${id}` });
  expect((await handle('SubagentStart', { cwd: '/p' }, ctx)).additionalContext).toBe('out-a\n\nout-c');
});
test('ext drift/chua duyet bi bo qua, khong chay', async () => {
  for (const s of ['drift', 'missing', 'unregistered']) {
    const { ctx, calls } = mk({ status: () => s });
    expect(await handle('SessionStart', { cwd: '/p' }, ctx)).toEqual({});
    expect(calls).toHaveLength(0);
  }
});
test('drift that: extensionStatus tren cay doi noi dung => khong chay', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-ws-'));
  const root = path.join(ws, 'ext'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'alpha', ...INJ }));
  const machineFile = path.join(ws, 'local.json');
  fs.writeFileSync(machineFile, JSON.stringify({ extensions: { [ws]: [{ id: 'alpha', root: 'ext', hash: hashTree(root).hash }] } }));
  const calls = [];
  const base = { cfg: DEFAULTS, list: () => [{ id: 'alpha', root }], status: (id) => extensionStatus(id, { workspace: ws, machineFile }).status, run: (id) => { calls.push(id); return 'ok'; } };
  expect((await handle('SessionStart', { cwd: ws }, base)).additionalContext).toBe('ok');
  fs.writeFileSync(path.join(root, 'evil.mjs'), 'x');
  expect(await handle('SessionStart', { cwd: ws }, base)).toEqual({});
  expect(calls).toHaveLength(1);
  fs.rmSync(ws, { recursive: true, force: true });
});
test('timeout/loi/exit!=0 (run tra rong hoac nem) fail-open, ext sau van chay', async () => {
  const { ctx } = mk({ list: () => [{ id: 'a', root: 'a' }, { id: 'b', root: 'b' }], run: (id) => { if (id === 'a') throw new Error('boom'); return 'fine'; } });
  expect(await handle('SessionStart', { cwd: '/p' }, ctx)).toEqual({ additionalContext: 'fine' });
  expect(await handle('SessionStart', { cwd: '/p' }, mk({ run: () => '' }).ctx)).toEqual({});
  expect(await handle('SessionStart', { cwd: '/p' }, mk({ list: () => { throw new Error('x'); } }).ctx)).toEqual({});
});
test('defaultRun that: timeout 1ms => rong (khong nem)', () => {
  expect(defaultRun('alpha', ['show'], { cwd: os.tmpdir(), timeoutMs: 1, maxBytes: 1536 })).toBe('');
});
test('cat 12 dong va 1.5KB', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  const r = await handle('SessionStart', { cwd: '/p' }, mk({ run: () => many }).ctx);
  expect(r.additionalContext.split('\n')).toHaveLength(12);
  expect(r.additionalContext.endsWith('l11')).toBe(true);
  expect(Buffer.byteLength(clip('x'.repeat(5000), 12, 1536))).toBe(1536);
  expect(clip('a\r\nb', 12, 1536)).toBe('a\nb');
});
test('event khong khop khai bao inject / event ngoai SessionStart|SubagentStart: khong chay', async () => {
  const { ctx, calls } = mk({ readManifest: () => ({ inject: { events: ['SubagentStart'], args: ['x'] } }) });
  expect(await handle('SessionStart', { cwd: '/p' }, ctx)).toEqual({});
  expect(await handle('PreToolUse', { cwd: '/p' }, ctx)).toEqual({});
  expect(await handle('SessionStart', { cwd: '/p' }, { ...ctx, cfg: { ...DEFAULTS, enabled: false }, readManifest: () => INJ })).toEqual({});
  expect(calls).toHaveLength(0);
});
test('parseInject chi nhan khai bao hop le; MODULE hop le', () => {
  expect(parseInject(INJ).args).toHaveLength(4);
  for (const bad of [null, {}, { inject: { events: 'x', args: [] } }, { inject: { events: [], args: [1] } }]) expect(parseInject(bad)).toBeNull();
  expect(validateHookModule(mod)).toEqual([]);
});
