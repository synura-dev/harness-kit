import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, clip, parseInject, defaultRun, handle, coreDomains } from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/shape.mjs';
import mod from './hook.mjs';
import { hashTree } from '../../core/ext/ext-trust.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const INJ = { domain: 'alpha-dom', inject: { events: ['SessionStart', 'SubagentStart'], args: ['show', '--cwd', '{cwd}', '--inject'] } };
const mk = (over = {}) => {
  const calls = [];
  const ctx = {
    cfg: DEFAULTS,
    env: { CLAUDE_PROJECT_DIR: path.resolve('/proj') },
    cacheDir: tmp('ei-cache-'),
    list: () => [{ id: 'alpha', root: '/x/alpha', hash: 'h1' }],
    readManifest: () => INJ,
    hashOf: () => 'h1',
    core: () => new Set(['tasks', 'ext']),
    run: async (domain, args, o) => { calls.push({ domain, args, o }); return 'line1\nline2'; },
    ...over,
  };
  return { ctx, calls };
};
const S = (extra = {}) => ({ session_id: 's1', cwd: path.resolve('/proj'), ...extra });

test('SessionStart: chay `harness <domain> <args>`, {cwd} thay vao args, chen additionalContext', async () => {
  const { ctx, calls } = mk();
  const r = await handle('SessionStart', S(), ctx);
  expect(r).toEqual({ additionalContext: 'line1\nline2' });
  expect(calls).toHaveLength(1);
  expect(calls[0].domain).toBe('alpha-dom');
  expect(calls[0].args).toEqual(['show', '--cwd', path.resolve('/proj'), '--inject']);
  expect(validateHookResult(r)).toEqual([]);
});
test('cache: SessionStart ghi, SubagentStart chi doc (khong spawn/hash/list)', async () => {
  const { ctx } = mk();
  await handle('SessionStart', S(), ctx);
  const boom = () => { throw new Error('khong duoc goi'); };
  const sub = { ...ctx, list: boom, hashOf: boom, readManifest: boom, run: boom, core: boom };
  expect(await handle('SubagentStart', S({ cwd: path.resolve('/proj/sub') }), sub)).toEqual({ additionalContext: 'line1\nline2' });
  expect(await handle('SubagentStart', S({ session_id: 'other' }), sub)).toEqual({}); // khac session
  expect(await handle('SubagentStart', S(), { ...sub, env: { CLAUDE_PROJECT_DIR: path.resolve('/proj2') } })).toEqual({}); // khac workspace
  expect(await handle('SubagentStart', { cwd: '/proj' }, sub)).toEqual({}); // khong session_id
});
test('workspace = CLAUDE_PROJECT_DIR du cwd su kien la thu muc con; {cwd} la cwd su kien', async () => {
  const ws = path.resolve('/proj'); const sub = path.resolve('/proj/a/b');
  const { ctx, calls } = mk();
  let listed;
  ctx.list = (w) => { listed = w; return [{ id: 'alpha', root: '/x', hash: 'h1' }]; };
  await handle('SessionStart', S({ cwd: sub }), ctx);
  expect(listed).toBe(ws);
  expect(calls[0].o.cwd).toBe(ws);
  expect(calls[0].args[2]).toBe(sub);
  const m2 = mk({ env: {} }); let l2;
  m2.ctx.list = (w) => { l2 = w; return []; };
  await handle('SessionStart', S({ cwd: sub }), m2.ctx); // khong co env -> fallback cwd su kien
  expect(l2).toBe(sub);
});
test('domain routing: domain tu manifest (domains object/array), bo domain core, khong co domain rieng thi bo qua', async () => {
  const run = async (d) => `out-${d}`;
  const t = async (m) => (await handle('SessionStart', S(), mk({ readManifest: () => ({ ...m, inject: INJ.inject }), run }).ctx)).additionalContext;
  expect(await t({ domain: 'foo' })).toBe('out-foo');
  expect(await t({ domains: { tasks: 'x.mjs', bar: 'y.mjs' } })).toBe('out-bar'); // tasks la core
  expect(await t({ domains: ['ext', 'baz'] })).toBe('out-baz');
  expect(await t({ domain: 'tasks' })).toBeUndefined(); // trung core
  expect(await t({})).toBeUndefined(); // khong domain
  expect(await handle('SessionStart', S(), mk({ core: () => null }).ctx)).toEqual({}); // khong biet core => bo qua
});
test('coreDomains doc registry that cua plugin va co domain core', () => {
  const c = coreDomains();
  expect(c instanceof Set && c.size > 0).toBe(true);
  expect(c.has('ext')).toBe(true);
});
test('nhieu ext: noi theo thu tu, ext khong khai inject bi bo qua', async () => {
  const { ctx } = mk({ list: () => [{ id: 'a', root: 'a', hash: 'h1' }, { id: 'b', root: 'b', hash: 'h1' }, { id: 'c', root: 'c', hash: 'h1' }],
    readManifest: (r) => (r === 'b' ? { domain: 'b' } : { ...INJ, domain: `d-${r}` }), run: async (d) => `out-${d}` });
  expect((await handle('SessionStart', S(), ctx)).additionalContext).toBe('out-d-a\n\nout-d-c');
});
test('ext drift (hash lech) / thieu bi bo qua, khong chay', async () => {
  for (const hashOf of [() => 'other', () => null]) {
    const { ctx, calls } = mk({ hashOf });
    expect(await handle('SessionStart', S(), ctx)).toEqual({});
    expect(calls).toHaveLength(0);
  }
});
test('drift that: hashTree cay doi noi dung => khong chay', async () => {
  const dir = tmp('ei-ext-');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(INJ));
  const pinned = hashTree(dir).hash;
  const calls = [];
  const { ctx } = mk({ list: () => [{ id: 'alpha', root: dir, hash: pinned }], run: async (d) => { calls.push(d); return 'ok'; } });
  delete ctx.hashOf; delete ctx.readManifest; // dung ban that
  expect((await handle('SessionStart', S(), ctx)).additionalContext).toBe('ok');
  fs.writeFileSync(path.join(dir, 'evil.mjs'), 'x');
  expect(await handle('SessionStart', S({ session_id: 's2' }), ctx)).toEqual({});
  expect(calls).toHaveLength(1);
});
test('loi/rong fail-open, ext sau van chay; list nem => {}', async () => {
  const { ctx } = mk({ list: () => [{ id: 'a', root: 'a', hash: 'h1' }, { id: 'b', root: 'b', hash: 'h1' }], readManifest: (r) => ({ ...INJ, domain: `d-${r}` }),
    run: async (d) => { if (d === 'd-a') throw new Error('boom'); return 'fine'; } });
  expect(await handle('SessionStart', S(), ctx)).toEqual({ additionalContext: 'fine' });
  expect(await handle('SessionStart', S(), mk({ run: async () => '' }).ctx)).toEqual({});
  expect(await handle('SessionStart', S(), mk({ list: () => { throw new Error('x'); } }).ctx)).toEqual({});
});
test('tran tong totalMs: run treo => tra {} dung han, khong treo hook', async () => {
  const t0 = Date.now();
  const r = await handle('SessionStart', S(), mk({ cfg: { ...DEFAULTS, totalMs: 200 }, run: () => new Promise(() => {}) }).ctx);
  expect(r).toEqual({});
  expect(Date.now() - t0).toBeLessThan(1500);
});
test('defaultRun that: timeout => kill tien trinh con (khong con ghi marker), tra rong', async () => {
  const dir = tmp('ei-kill-');
  const marker = path.join(dir, 'marker');
  const bin = path.join(dir, 'slow.mjs');
  fs.writeFileSync(bin, `import fs from 'node:fs'; setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'x'), 1500); setInterval(() => {}, 1000);`);
  const t0 = Date.now();
  expect(await defaultRun('d', [], { cwd: dir, timeoutMs: 300, maxBytes: 1536, bin })).toBeNull();
  expect(Date.now() - t0).toBeLessThan(1200);
  await new Promise((r) => setTimeout(r, 2000));
  expect(fs.existsSync(marker)).toBe(false);
});
test('defaultRun that: timeout giet ca chau (khong mo coi, khong ghi marker)', async () => {
  const dir = tmp('ei-tree-');
  const marker = path.join(dir, 'grand-marker');
  const grand = path.join(dir, 'grand.mjs');
  const bin = path.join(dir, 'parent.mjs');
  fs.writeFileSync(grand, `import fs from 'node:fs'; setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'x'), 1500); setInterval(() => {}, 1000);`);
  fs.writeFileSync(bin, `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(grand)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
  expect(await defaultRun('d', [], { cwd: dir, timeoutMs: 600, maxBytes: 1536, bin })).toBeNull();
  await new Promise((r) => setTimeout(r, 2500));
  expect(fs.existsSync(marker)).toBe(false);
});
test('defaultRun that: exit 0 tra stdout; exit != 0 tra rong', async () => {
  const dir = tmp('ei-run-');
  const ok = path.join(dir, 'ok.mjs'); const bad = path.join(dir, 'bad.mjs');
  fs.writeFileSync(ok, `console.log('hi ' + process.argv.slice(2).join(' '));`);
  fs.writeFileSync(bad, `console.log('x'); process.exit(3);`);
  expect((await defaultRun('d', ['a'], { cwd: dir, timeoutMs: 5000, maxBytes: 1536, bin: ok })).trim()).toBe('hi d a');
  expect(await defaultRun('d', [], { cwd: dir, timeoutMs: 5000, maxBytes: 1536, bin: bad })).toBeNull();
});
test('cat 12 dong va 1.5KB', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  const r = await handle('SessionStart', S(), mk({ run: async () => many }).ctx);
  expect(r.additionalContext.split('\n')).toHaveLength(12);
  expect(r.additionalContext.endsWith('l11')).toBe(true);
  expect(Buffer.byteLength(clip('x'.repeat(5000), 12, 1536))).toBe(1536);
  expect(clip('a\r\nb', 12, 1536)).toBe('a\nb');
});
test('event khong khop khai bao inject / event ngoai: khong chay', async () => {
  const { ctx, calls } = mk({ readManifest: () => ({ domain: 'x', inject: { events: ['SubagentStart'], args: ['x'] } }) });
  expect(await handle('SessionStart', S(), ctx)).toEqual({});
  expect(await handle('PreToolUse', S(), ctx)).toEqual({});
  expect(await handle('SessionStart', S(), { ...ctx, cfg: { ...DEFAULTS, enabled: false }, readManifest: () => INJ })).toEqual({});
  expect(calls).toHaveLength(0);
});
test('parseInject chi nhan khai bao hop le; MODULE hop le', () => {
  expect(parseInject(INJ).args).toHaveLength(4);
  for (const bad of [null, {}, { inject: { events: 'x', args: [] } }, { inject: { events: [], args: [1] } }]) expect(parseInject(bad)).toBeNull();
  expect(validateHookModule(mod)).toEqual([]);
});

test('cache theo hash ext: hit khong spawn, hash doi => lam moi', async () => {
  const { ctx, calls } = mk();
  await handle('SessionStart', S({ session_id: 'a' }), ctx);
  expect(calls).toHaveLength(1);
  const r2 = await handle('SessionStart', S({ session_id: 'b' }), ctx);
  expect(r2).toEqual({ additionalContext: 'line1\nline2' });
  expect(calls).toHaveLength(1); // hit
  const c2 = { ...ctx, list: () => [{ id: 'alpha', root: '/x/alpha', hash: 'h2' }], hashOf: () => 'h2' };
  await handle('SessionStart', S({ session_id: 'c' }), c2);
  expect(calls).toHaveLength(2); // miss
  await handle('SessionStart', S({ session_id: 'd' }), { ...c2, now: Date.now() + 3600e3 * 2 });
  expect(calls).toHaveLength(3); // het TTL
});

test('ext loi/timeout => KHONG cache (khong ghi cache session lan out); ext ok het => cache', async () => {
  const two = { list: () => [{ id: 'a', root: 'a', hash: 'h1' }, { id: 'b', root: 'b', hash: 'h1' }], readManifest: (r) => ({ ...INJ, domain: 'd-' + r }) };
  const bad = mk({ ...two, run: async (d) => (d === 'd-a' ? null : 'fine') });
  expect(await handle('SessionStart', S(), bad.ctx)).toEqual({ additionalContext: 'fine' });
  expect(fs.readdirSync(bad.ctx.cacheDir)).toEqual([]);
  const ok = mk({ ...two, run: async (d) => (d === 'd-a' ? '' : 'fine') }); // rong hop le van la thanh cong
  await handle('SessionStart', S(), ok.ctx);
  expect(fs.readdirSync(ok.ctx.cacheDir).length).toBe(2);
  const hang = mk({ run: () => new Promise(() => {}), cfg: { ...DEFAULTS, totalMs: 100 } });
  await handle('SessionStart', S(), hang.ctx);
  expect(fs.readdirSync(hang.ctx.cacheDir)).toEqual([]);
});
test('ctx.deadline cat totalMs (con 300ms bien); ghi cache ngay khi xong', async () => {
  const t0 = Date.now();
  const m = mk({ run: () => new Promise(() => {}) });
  await handle('SessionStart', S(), { ...m.ctx, deadline: Date.now() + 500 });
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(DEFAULTS.totalMs).toBeLessThan(DEFAULTS.totalMs + 1);
  expect(mod.timeoutMs).toBeGreaterThan(DEFAULTS.totalMs);
});
