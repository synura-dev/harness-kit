import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadExternals, runExternal, EXIT, EXT_LIMITS } from './ext-host.mjs';
import { readAuditEvents } from '../audit/scan.mjs';
import { repeatedFailureCandidates } from '../audit/candidates.mjs';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));
const DATA = path.join(tmp, 'data');
const AUDIT = path.join(tmp, 'audit');
fs.mkdirSync(DATA, { recursive: true });
const _old = ['HUB_DATA_DIR', 'CLAUDE_AUDIT_DIR', 'GUARD_LOG_FILE'].map((k) => [k, process.env[k]]);
beforeAll(() => { process.env.HUB_DATA_DIR = DATA; process.env.CLAUDE_AUDIT_DIR = AUDIT; }); // child ke thua; set trong beforeAll de khong ro ri sang file test khac cung process
afterAll(() => { for (const [k, v] of _old) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const mkExt = (name, body, manifest = {}) => {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'main.mjs'), body);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: name, entry: 'main.mjs', domains: [name], requires: { ctx: '^1' }, ...manifest }));
  return { id: name, root };
};
const load = (list, core = {}) => loadExternals(list, { coreDomains: core });
const get = (e) => load([e]).byDomain[e.id];

const good = mkExt('good', `export async function main(ctx, argv) {
  const f = ctx.storage.dataPathFor('x', 'a.json');
  ctx.storage.writeJson(f, { ok: 1 });
  ctx.audit.event({ ok: true, event: 'hi' });
  let blocked = false; try { ctx.storage.writeJson(ctx.paths.dataRoot() + '/evil.json', {}); } catch { blocked = true; }
  return ctx.paths.dataRoot().length > 0 && blocked ? 'OK ' + argv.join(',') + ' ' + f : 'BAD';
}`);
const thrower = mkExt('thrower', `export function main() { throw new Error('boom 12345'); }`);
const crasher = mkExt('crasher', `export function main() { process.stderr.write('error: real cause ABC\\n  at x.mjs:1\\n\\nBun v1.3.14 (Windows x64)\\n'); process.exit(1); }`);
const hang = mkExt('hang', `export function main() { return new Promise(() => setInterval(() => {}, 1000)); }`);
const junk = mkExt('junk', `export function main() { return '<<not json>>'; }`);
const noMain = mkExt('nomain', `export const x = 1;`);

const audit = async () => (await readAuditEvents(AUDIT, 5e6, Date.now() + 5000)).events;
const core = () => ['data ls', 'doctor'].map((a) => spawnSync(process.execPath, [path.join(HARNESS, 'cli', 'harness.mjs'), ...a.split(' ')], { encoding: 'utf8', timeout: 60000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HARNESS_|HUB_DIR$|CLAUDE_PROJECT_DIR$)/.test(k))) }).status);

test('external gia nhan ctx: paths/storage/out thanh cong, ghi ngoai zone bi chan', () => {
  const r = runExternal(get(good), 'good', ['a', 'b']);
  expect(r.stdout).toContain('OK a,b');
  expect(r.code).toBe(0);
  expect(fs.existsSync(path.join(DATA, 'workspaces', 'good', 'x', 'a.json'))).toBe(true);
});

test('domain trung core bi tu choi; trung giua 2 ext bi tu choi', () => {
  const a = load([good], { good: {} });
  expect(a.byDomain.good).toBeUndefined();
  expect(a.errors.join()).toContain('trung core');
  const dup = mkExt('dup', 'export const main=()=>0', { domains: ['good'] });
  expect(Object.keys(load([good, dup]).byDomain)).toEqual(['good']);
});

test('id lay tu dang ky: manifest khai id khac => khong nap, domain vao blocked (id-mismatch)', () => {
  const sp = mkExt('spoofb', 'export const main=()=>0', { id: 'good', domains: ['spoofd'] });
  const r = load([sp]);
  expect(r.byDomain.spoofd).toBeUndefined();
  expect(r.blocked.spoofd).toMatchObject({ id: 'spoofb', reason: 'id-mismatch' });
  expect(r.errors.join()).toContain('khac id dang ky');
  expect(load([good]).byDomain.good.id).toBe('good');
});

test('timeout giet CA CAY: tien trinh chau cua external khong mo coi', () => {
  const pidFile = path.join(tmp, 'grandchild.pid');
  const gc = mkExt('spawner', `import { spawn } from 'node:child_process'; import fs from 'node:fs';
export function main() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
  return new Promise(() => setInterval(() => {}, 1000));
}`);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let pid = 0;
  try {
    expect(runExternal(get(gc), 'spawner', [], { timeoutS: 3 }).code).toBe(EXIT.TIMEOUT);
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    const t = Date.now(); while (alive(pid) && Date.now() - t < 3000) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']);
    expect(alive(pid)).toBe(false);
  } finally { if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* */ } }
}, 60000);

test('tran output qua supervisor => 125', () => {
  const big = mkExt('bigout', `export function main() { process.stdout.write('x'.repeat(400000)); return new Promise(() => setInterval(() => {}, 1000)); }`);
  expect(runExternal(get(big), 'bigout', [], { timeoutS: 20, maxBytes: 1000 }).code).toBe(EXIT.OVERFLOW);
}, 60000);

test('plugin thieu -> exit 3 kem huong dan', () => {
  const r = runExternal(get(good), 'good', [], { coreDir: path.join(tmp, 'khong-co-plugin') });
  expect(r.code).toBe(3);
  expect(r.stderr).toContain('plugin');
  const j = JSON.parse(r.stderr.split('\n')[0].replace(/^HKERR /, ''));
  expect(j).toMatchObject({ code: 'HK_EXT_MISSING_CORE', severity: 'error', safe: true, source: 'ext:good/good' });
  expect(j.fix_command).toBeTruthy(); expect(j.next_step).toBeTruthy(); expect(j.cause).toContain('missing-core');
  expect(r.stderr.split('\n')[1]).toContain('ext good/good: missing-core');
});

test('ext-fail: HKERR dong dau + audit co code/fix_command/next_step, exit giu nguyen', async () => {
  const r = runExternal(get(thrower), 'thrower');
  expect(r.code).toBe(EXIT.FAIL);
  expect(r.stderr.startsWith('HKERR {')).toBe(true);
  expect(JSON.parse(r.stderr.split('\n')[0].slice(6)).code).toBe('HK_EXT_EXIT');
  const ev = (await audit()).filter((e) => e.status === 'ext-fail' && e.source === 'ext:thrower').pop();
  expect(ev.data).toMatchObject({ code: 'HK_EXT_EXIT', reason: 'exit' });
  expect(ev.data.fix_command).toBeTruthy(); expect(ev.data.next_step).toBeTruthy();
});

test('ext-fail: why bo dong footer Bun, stderr tail den tay nguoi dung', () => {
  const r = runExternal(get(crasher), 'crasher');
  expect(r.code).toBe(1);
  const l2 = r.stderr.split('\n')[1];
  expect(l2).toContain('at x.mjs:1');
  expect(l2).not.toContain('Bun v');
  expect(r.stderr).toContain('error: real cause ABC');
});

test('external loi khong lam hong core: throw, treo, rac, khong main, manifest hong', async () => {
  expect(runExternal(get(thrower), 'thrower').code).toBe(EXIT.FAIL);
  expect(runExternal(get(hang), 'hang', [], { timeoutS: 2 }).code).toBe(EXIT.TIMEOUT);
  expect(runExternal(get(junk), 'junk', [], { json: true }).code).toBe(EXIT.BAD_OUTPUT);
  expect(runExternal(get(noMain), 'nomain').code).toBe(EXIT.FAIL);
  const badRoot = path.join(tmp, 'badm'); fs.mkdirSync(badRoot);
  fs.writeFileSync(path.join(badRoot, 'manifest.json'), '{ khong phai json');
  const bm = load([{ id: 'badm', root: badRoot }]);
  expect(Object.keys(bm.byDomain)).toEqual([]);
  expect(bm.errors.length).toBe(1);
  // good van chay sau khi cac ext khac hong
  expect(runExternal(get(good), 'good').code).toBe(0);
  const ev = (await audit()).filter((e) => e.status === 'ext-fail');
  expect(ev.every((e) => e.source.startsWith('ext:'))).toBe(true);
  expect(ev.map((e) => e.source)).toEqual(expect.arrayContaining(['ext:thrower', 'ext:hang', 'ext:junk', 'ext:nomain', 'ext:badm']));
  expect(core()).toEqual([0, 0]); // data ls, doctor
}, 120000);

test('3 loi cung dau van tay -> evolve candidate co source ext', async () => {
  const flaky = mkExt('flaky', `export function main(ctx) { ctx.audit.event({ ok: false, event: 'job', error: 'ECONNRESET talking to api 10.0.0.5' }); return 0; }`);
  for (let i = 0; i < 3; i++) runExternal(get(flaky), 'flaky');
  const evs = (await audit()).filter((e) => e.source === 'ext:flaky' && e.event === 'job');
  expect(evs.length).toBe(3);
  const c = repeatedFailureCandidates(evs, new Date().toISOString());
  expect(c.length).toBe(1);
  expect(c[0].source).toBe('ext:flaky');
  expect(c[0].evidenceCount).toBe(3);
}, 60000);

// ---- manifest `tty`: lenh nguoi dung chay inherit stdio chi khi CLI cha co TTY ----
const ttyExt = mkExt('ttyx', `export function main(ctx, argv) { return 'OUT ' + argv.join(' '); }`, { tty: ['tags approve', 'retire'] });
const yes = () => true, no = () => false;
// inherit => stdout khong duoc bat (r.stdout rong); piped => r.stdout co 'OUT'
test('tty: lenh danh dau + cha co TTY -> inherit (khong bat stdout)', () => {
  const r = runExternal(get(ttyExt), 'ttyx', ['tags', 'approve', 'x'], { isTTY: yes });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
});
test('tty: lenh khong danh dau + cha co TTY -> van piped', () => {
  expect(runExternal(get(ttyExt), 'ttyx', ['list'], { isTTY: yes }).stdout).toContain('OUT list');
});
test('tty: lenh danh dau + cha khong TTY -> van piped', () => {
  expect(runExternal(get(ttyExt), 'ttyx', ['retire', 'a'], { isTTY: no }).stdout).toContain('OUT retire a');
});
test('tty: khop theo token nguyen (tags approvex, tags, approve tags, retirex khong khop)', () => {
  for (const a of [['tags', 'approvex'], ['tags'], ['approve', 'tags'], ['retirex']]) expect(runExternal(get(ttyExt), 'ttyx', a, { isTTY: yes }).stdout).toContain('OUT');
});
test('tty: inherit van co timeout + HKERR khi exit != 0', () => {
  const h = mkExt('ttyhang', `export function main() { return new Promise(() => setInterval(() => {}, 1000)); }`, { tty: ['go'] });
  expect(runExternal(get(h), 'ttyhang', ['go'], { isTTY: yes, timeoutS: 2 }).code).toBe(EXIT.TIMEOUT);
  const t = mkExt('ttythrow', `export function main() { throw new Error('boom'); }`, { tty: ['go'] });
  const r = runExternal(get(t), 'ttythrow', ['go'], { isTTY: yes });
  expect(r.code).toBe(EXIT.FAIL);
  expect(r.stderr).toContain('HKERR');
}, 60000);
test('tty: inherit co tran rieng (ttyTimeoutS 600) va timeout khong nham voi ext tu thoat 124', () => {
  expect(EXT_LIMITS.ttyTimeoutS).toBe(600);
  const h = mkExt('ttyhang2', `export function main() { return new Promise(() => setInterval(() => {}, 1000)); }`, { tty: ['go'] });
  // khong dat timeoutS: tran inherit lay tu ttyTimeoutS (2s o day) chu khong phai 30s mac dinh
  const r = runExternal(get(h), 'ttyhang2', ['go'], { isTTY: yes, ttyTimeoutS: 2 });
  expect(r.code).toBe(EXIT.TIMEOUT); expect(r.stderr).toContain('qua 2s');
  const e = mkExt('tty124', `export function main() { process.exit(124); }`, { tty: ['go'] });
  const x = runExternal(get(e), 'tty124', ['go'], { isTTY: yes });
  expect(x.status).toBe('exit'); expect(x.stderr).not.toContain('truncated: timeout');
  const e2 = mkExt('tty197', `export function main() { process.exit(197); }`, { tty: ['go'] });
  expect(runExternal(get(e2), 'tty197', ['go'], { isTTY: yes }).status).toBe('exit');
}, 60000);
test('tty: opts.isTTY chi duoc tin duoi test runner; ngoai test doc TTY that', () => {
  const saved = [process.env.BUN_TEST, process.env.NODE_ENV]; delete process.env.BUN_TEST; delete process.env.NODE_ENV;
  try { expect(runExternal(get(ttyExt), 'ttyx', ['retire', 'a'], { isTTY: yes }).stdout).toContain('OUT retire a'); } // test khong co TTY that -> piped
  finally { if (saved[0] !== undefined) process.env.BUN_TEST = saved[0]; if (saved[1] !== undefined) process.env.NODE_ENV = saved[1]; }
});
test('tty: manifest tty sai bi tu choi', () => {
  const bad = [['a', 'x'], ['b', [1]], ['c', ['']], ['d', ['  ']], ['e', Array(33).fill('a b')], ['f', ['x'.repeat(81)]]];
  for (const [n, v] of bad) {
    const l = load([mkExt('ttybad' + n, `export function main() { return 1; }`, { tty: v })]);
    expect(Object.keys(l.byDomain)).toEqual([]);
    expect(l.errors.join()).toContain('tty');
  }
});
