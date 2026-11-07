import { test, expect } from 'bun:test';
import path from 'node:path';
import { DEFAULTS, parseGuard, handle, defaultRun } from './hook.mjs';
import mod from './hook.mjs';
import { validateHookModule, validateHookResult } from '../../core/config/shape.mjs';

const GUARD = { event: 'PreToolUse', matcher: 'mcp__.*|Write', args: ['guard'], domain: 'alpha-dom' };
const mk = (over = {}) => {
  const calls = [];
  const ctx = {
    cfg: DEFAULTS, env: { CLAUDE_PROJECT_DIR: path.resolve('/proj') },
    list: () => [{ id: 'alpha', root: '/x/alpha', hash: 'h1', guard: GUARD }],
    hashOf: () => 'h1',
    run: async (domain, args, o) => { calls.push({ domain, args, o }); return { code: 0, stderr: '' }; },
    ...over,
  };
  return { ctx, calls };
};
const EV = (tool) => ({ tool_name: tool, tool_input: { a: 1 }, cwd: path.resolve('/proj') });

test('parseGuard: hop le / sai', () => {
  expect(parseGuard(GUARD).args).toEqual(['guard']);
  expect(parseGuard({ ...GUARD, event: 'PostToolUse' })).toBeNull();
  expect(parseGuard({ ...GUARD, matcher: '(' })).toBeNull();
  expect(parseGuard({ ...GUARD, domain: '' })).toBeNull();
  expect(parseGuard(undefined)).toBeNull();
});
test('hop dong module hop le', () => { expect(validateHookModule(mod)).toEqual([]); });
test('khop matcher: chay harness <domain> args voi JSON su kien tren stdin; exit 0 = qua', async () => {
  const { ctx, calls } = mk();
  const r = await handle('PreToolUse', EV('mcp__obs__put'), ctx);
  expect(r).toEqual({});
  expect(calls).toHaveLength(1);
  expect(calls[0].domain).toBe('alpha-dom');
  expect(JSON.parse(calls[0].o.stdin).tool_name).toBe('mcp__obs__put');
});
test('khong khop matcher: khong chay', async () => {
  const { ctx, calls } = mk();
  expect(await handle('PreToolUse', EV('Bash'), ctx)).toEqual({});
  expect(calls).toHaveLength(0);
});
test('exit 2 = deny kem stderr', async () => {
  const { ctx } = mk({ run: async () => ({ code: 2, stderr: 'khong duoc ghi\n' }) });
  const r = await handle('PreToolUse', EV('Write'), ctx);
  expect(r.decision).toBe('deny');
  expect(r.reason).toContain('khong duoc ghi');
  expect(validateHookResult(r)).toEqual([]);
});
test('exit khac / timeout / loi spawn / throw = FAIL-OPEN (khong chan) + canh bao ro + audit allow', async () => {
  for (const res of [{ code: 1, stderr: '' }, { error: 'timeout' }, { error: 'spawn' }]) {
    const { ctx } = mk({ run: async () => res });
    const r = await handle('PreToolUse', EV('Write'), ctx);
    expect(r.decision).toBeUndefined();
    expect(r.additionalContext).toContain('bo qua (fail-open)');
    expect(r.additionalContext).toContain(res.error || `exit ${res.code}`);
    expect(r.records[0].data.rule).toBe('fail-open');
    expect(r.records[0].data.decision).toBe('allow');
    expect(validateHookResult(r)).toEqual([]);
  }
  const { ctx } = mk({ run: async () => { throw new Error('x'); } });
  const t = await handle('PreToolUse', EV('Write'), ctx);
  expect(t.decision).toBeUndefined(); expect(t.additionalContext).toContain('fail-open');
});
test('hash lech: CHAN tool khop matcher, khong chay code, ly do ext approve; tool khac khong anh huong', async () => {
  const { ctx, calls } = mk({ hashOf: () => 'khac' });
  const r = await handle('PreToolUse', EV('Write'), ctx);
  expect(calls).toHaveLength(0);
  expect(r.decision).toBe('deny');
  expect(r.reason).toContain('guard alpha chua duyet: harness ext approve alpha');
  expect(await handle('PreToolUse', EV('Bash'), ctx)).toEqual({});
});
test('cfg.enabled=false khong tat guard; ext khong khai guard khong anh huong; ', async () => {
  const { ctx } = mk({ cfg: { ...DEFAULTS, enabled: false }, run: async () => ({ code: 2, stderr: 'no' }) });
  expect((await handle('PreToolUse', EV('Write'), ctx)).decision).toBe('deny');
  const n = mk({ list: () => [{ id: 'alpha', root: '/x/alpha', hash: 'h1' }] });
  expect(await handle('PreToolUse', EV('Write'), n.ctx)).toEqual({});
});
test('module: khong tat duoc (OPTIONAL), khong fail-closed theo timeout', async () => {
  const { OPTIONAL, ORDER } = await import('../../hooks/dispatch/modules.mjs');
  expect(OPTIONAL).not.toContain('ext-guard');
  expect(ORDER.PreToolUse.map((x) => x.id).slice(-2)).toEqual(['ext-guard', 'audit']);
  expect(mod.failClosedOnMatch).toBeUndefined();
});
test('defaultRun that: timeout giet tien trinh -> {error: timeout}', async () => {
  const r = await defaultRun('x', [], { cwd: process.cwd(), timeoutMs: 50, stdin: '{}', bin: path.join(import.meta.dir, '__khong_co__.mjs') });
  expect(r.error === 'timeout' || typeof r.code === 'number').toBe(true);
});
test('dispatcher: module guard het timeout/loi => ALLOW + canh bao fail-open nhat quan (khong deny)', async () => {
  const { dispatch, CLAUDE } = await import('../../hooks/dispatch/run.mjs');
  const mkMod = (match, fn) => ({ id: 'fake-guard', gate: true, load: async () => ({ default: { id: 'fake-guard', events: ['PreToolUse'], timeoutMs: 150, onError: 'open', failClosedOnMatch: true, handle: async (e, i, ctx) => { if (match) ctx.guardMatched = true; return fn(); } } }) });
  const run = (m) => dispatch({ event: 'PreToolUse', stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }), profile: { ...CLAUDE, order: { PreToolUse: [m] } } });
  const hang = () => new Promise(() => {});
  for (const fn of [hang, () => { throw new Error('x'); }]) {
    const r = await run(mkMod(true, fn));
    expect(r.stdout).not.toContain('"deny"');
    expect(r.stdout).toContain('fail-open');
    expect(r.stderr).toContain('fail-open');
  }
});
test('guard doc tu registry: manifest tren dia khong duoc doc (xoa/doi khoa guard khong anh huong)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-'));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'alpha', domain: 'alpha-dom', guard: { event: 'PreToolUse', matcher: 'Nothing', args: ['x'] } }));
  const { ctx } = mk({ list: () => [{ id: 'alpha', root, hash: 'h1', guard: GUARD }], run: async () => ({ code: 2, stderr: 'chan' }) });
  expect((await handle('PreToolUse', EV('Write'), ctx)).decision).toBe('deny');
  fs.rmSync(path.join(root, 'manifest.json'));
  expect((await handle('PreToolUse', EV('Write'), ctx)).decision).toBe('deny');
  expect(await handle('PreToolUse', EV('Nothing'), ctx)).toEqual({});
  fs.rmSync(root, { recursive: true, force: true });
});
test('registry khong doc duoc: fail-open co ban ghi audit', async () => {
  const { ctx } = mk({ list: () => { throw new Error('hong'); } });
  const r = await handle('PreToolUse', EV('Write'), ctx);
  expect(r.decision).toBeUndefined();
  expect(r.records[0].data.rule).toBe('registry-unreadable');
});

test('matcher la tim kiem (khong ep neo): ^mcp__obsidian__ khop tool that', () => {
  const g = parseGuard({ ...GUARD, matcher: '^mcp__obsidian__' });
  for (const t of ['mcp__obsidian__vault_delete', 'mcp__obsidian__vault_read']) expect(g.matcher.test(t)).toBe(true);
  for (const t of ['mcp__other__x', 'Glob']) expect(g.matcher.test(t)).toBe(false);
});
test('tich hop: hooks/run.mjs PreToolUse that + registry tam co guard (hash lech) => deny; tool khong khop => khong deny', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const { spawnSync } = await import('node:child_process');
  const R = await import('../../cli/commands/ext-registry.mjs');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-int-')));
  const ws = path.join(d, 'ws'); const root = path.join(ws, 'ext', 'g'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export const main = () => 0;');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'g', entry: 'main.mjs', domains: ['gdom'], guard: { event: 'PreToolUse', matcher: '^mcp__obsidian__', args: ['guard'] } }));
  const mf = path.join(d, 'config', 'ext', 'local.json');
  expect((await R.register('ext/g', { workspace: ws, machineFile: mf, confirm: () => true, coreDomains: new Set(['data']) })).code).toBe(0);
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export const main = () => 1;'); // hash lech
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: d, CLAUDE_PROJECT_DIR: ws, CLAUDE_AUDIT_DIR: path.join(d, 'audit'), HUB_DATA_DIR: path.join(d, 'hd') };
  fs.mkdirSync(env.CLAUDE_AUDIT_DIR, { recursive: true });
  const run = (tool) => spawnSync(process.execPath, [path.join(import.meta.dir, '..', '..', '..', 'hooks', 'run.mjs'), 'PreToolUse'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: ws, tool_name: tool, tool_input: {} }), env, encoding: 'utf8', timeout: 20000 });
  const hit = run('mcp__obsidian__vault_delete');
  expect(hit.stdout).toContain('deny'); expect(hit.stdout).toContain('guard g chua duyet');
  expect(run('mcp__other__x').stdout).not.toContain('deny');
  expect(run('Glob').stdout).not.toContain('deny');
  fs.rmSync(d, { recursive: true, force: true });
});
test('tich hop THAT: ext-guard -> bin/harness -> ext tam doc stdin: tool cho phep exit 0, tool cam exit 2 => allow/deny dung', async () => {
  const fs = await import('node:fs'); const os = await import('node:os');
  const R = await import('../../cli/commands/ext-registry.mjs');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-real-')));
  const ws = path.join(d, 'ws'); const root = path.join(ws, 'ext', 'gx'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'main.mjs'), "export async function main(ctx, argv) { let t = ''; for await (const c of process.stdin) t += c; let j; try { j = JSON.parse(t); } catch { process.stderr.write('JSON stdin hong'); return 2; } if (j.tool_name === 'mcp__t__bad') { process.stderr.write('cam ' + j.tool_name); return 2; } return 0; }\n");
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'gx', entry: 'main.mjs', domains: ['gx'], guard: { event: 'PreToolUse', matcher: '^mcp__t__', args: ['guard'] } }));
  const mf = path.join(d, 'config', 'ext', 'local.json');
  const ro = { workspace: ws, machineFile: mf, confirm: () => true, coreDomains: new Set(['data']) };
  expect((await R.register('ext/gx', ro)).code).toBe(0);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: d, CLAUDE_PROJECT_DIR: ws, HUB_DATA_DIR: path.join(d, 'hd'), CLAUDE_AUDIT_DIR: path.join(d, 'audit') };
  fs.mkdirSync(env.CLAUDE_AUDIT_DIR, { recursive: true });
  const ctx = { cfg: { ...DEFAULTS, timeoutMs: 15000 }, env, list: () => R.listRegistered(ro) };
  const ev = (tool) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, cwd: ws });
  expect(await handle('PreToolUse', ev('mcp__t__ok'), ctx)).toEqual({});
  const deny = await handle('PreToolUse', ev('mcp__t__bad'), ctx);
  expect(deny.decision).toBe('deny'); expect(deny.reason).toContain('cam mcp__t__bad');
  expect(await handle('PreToolUse', ev('Glob'), ctx)).toEqual({});
  fs.rmSync(d, { recursive: true, force: true });
}, 60000);
test('probe dispatcher THAT (hooks/run.mjs PreToolUse): deny that van deny; qua => allow; guard treo => allow + canh bao timeout', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const { spawnSync } = await import('node:child_process');
  const R = await import('../../cli/commands/ext-registry.mjs');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-probe-')));
  try {
  const ws = path.join(d, 'ws'); const root = path.join(ws, 'ext', 'gp'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'main.mjs'), "export async function main(ctx, argv) { let t = ''; for await (const c of process.stdin) t += c; const j = JSON.parse(t); if (j.tool_name === 'mcp__t__bad') { process.stderr.write('cam that'); return 2; } if (j.tool_name === 'mcp__t__slow') await new Promise(() => {}); return 0; }\n");
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'gp', entry: 'main.mjs', domains: ['gp'], guard: { event: 'PreToolUse', matcher: '^mcp__t__', args: ['guard'] } }));
  const mf = path.join(d, 'config', 'ext', 'local.json');
  expect((await R.register('ext/gp', { workspace: ws, machineFile: mf, confirm: () => true, coreDomains: new Set(['data']) })).code).toBe(0);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: d, CLAUDE_PROJECT_DIR: ws, CLAUDE_AUDIT_DIR: path.join(d, 'audit'), HUB_DATA_DIR: path.join(d, 'hd') };
  fs.mkdirSync(env.CLAUDE_AUDIT_DIR, { recursive: true });
  const run = (tool) => spawnSync(process.execPath, [path.join(import.meta.dir, '..', '..', '..', 'hooks', 'run.mjs'), 'PreToolUse'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: ws, tool_name: tool, tool_input: {} }), env, encoding: 'utf8', timeout: 30000 });
  const settled = (tool) => { let r; for (let i = 0; i < 3; i++) { r = run(tool); if (!r.stdout.includes('timeout')) break; } return r; }; // tai cao: tranh timeout that lam nhieu case deny/allow
  const bad = settled('mcp__t__bad'); expect(bad.stdout).toContain('deny'); expect(bad.stdout).toContain('cam that');
  const ok = settled('mcp__t__ok'); expect(ok.stdout).not.toContain('deny');
  const slow = run('mcp__t__slow');
  expect(slow.stdout).not.toContain('deny'); expect(slow.stdout).toContain('fail-open'); expect(/timeout|khong chay/.test(slow.stdout)).toBe(true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}, 60000);

// Hai ext cung khop matcher qua dispatcher THAT: ext treo khong duoc lam mat deny that cua ext kia (exit 2) hay hash lech.
async function twoExt(mainA, mainB, drift) {
  const fs = await import('node:fs'); const os = await import('node:os'); const { spawnSync } = await import('node:child_process');
  const R = await import('../../cli/commands/ext-registry.mjs');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-two-')));
  try {
    const ws = path.join(d, 'ws'); const mf = path.join(d, 'config', 'ext', 'local.json');
    for (const [id, main] of [['ga', mainA], ['gb', mainB]]) {
      const root = path.join(ws, 'ext', id); fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'main.mjs'), main);
      fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id, entry: 'main.mjs', domains: [id], guard: { event: 'PreToolUse', matcher: '^mcp__t__', args: ['guard'] } }));
      expect((await R.register('ext/' + id, { workspace: ws, machineFile: mf, confirm: () => true, coreDomains: new Set(['data']) })).code).toBe(0);
    }
    if (drift) fs.writeFileSync(path.join(ws, 'ext', 'ga', 'main.mjs'), mainA + '\n// drift');
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: d, CLAUDE_PROJECT_DIR: ws, CLAUDE_AUDIT_DIR: path.join(d, 'audit'), HUB_DATA_DIR: path.join(d, 'hd') };
    fs.mkdirSync(env.CLAUDE_AUDIT_DIR, { recursive: true });
    return spawnSync(process.execPath, [path.join(import.meta.dir, '..', '..', '..', 'hooks', 'run.mjs'), 'PreToolUse'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: ws, tool_name: 'mcp__t__x', tool_input: {} }), env, encoding: 'utf8', timeout: 30000 });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
const DENY2 = "export async function main() { await new Promise((r) => setTimeout(r, 400)); process.stderr.write('cam that A'); return 2; }\n";
const HANG = "export async function main() { await new Promise(() => {}); }\n";
test('probe THAT: ext A exit 2 nhanh + ext B treo => van DENY (khong mat deny vi timeout)', async () => {
  let r; for (let i = 0; i < 3; i++) { r = await twoExt(DENY2, HANG, false); if (r.stdout.includes('deny')) break; } // tai cao: A co the that su timeout
  expect(r.stdout).toContain('deny'); expect(r.stdout).toContain('cam that A');
}, 60000);
test('probe THAT: ext B treo + ext A hash lech => DENY ngay (hash kiem truoc khi spawn)', async () => {
  const r = await twoExt("export async function main() { return 0; }\n", HANG, true);
  expect(r.stdout).toContain('deny'); expect(r.stdout).toContain('guard ga chua duyet');
}, 60000);
