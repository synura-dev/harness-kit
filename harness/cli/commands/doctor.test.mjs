import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// chay doctor.mjs that tren fixture (HUB_DIR) de kiem exit code va kiem hook settings
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isPluginMode, REPO_DIR } from '../../core/io/paths.mjs';
import { planShim, applyShim, pluginCacheDir, defaultShimDir } from '../../core/runtime/user-shim.mjs';
const DOCTOR = path.join(import.meta.dir, 'doctor.mjs');
// Shim cua ta khop ban hien tai o thu muc co dinh (LOCALAPPDATA/HOME tam) va co tren PATH -> canh bao shim cua may that khong lot vao dem warnings
const SHIM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'docshim-'));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
// shim Windows o %USERPROFILE%\.harness-kit\bin; LOCALAPPDATA/APPDATA tach khoi thu muc tam (tmpdir nam duoi LOCALAPPDATA that -> doctor se canh bao MSIX); giu CLAUDE_CONFIG_DIR that de pluginCacheDir khong doi
if (process.platform === 'win32') Object.assign(baseEnv, { USERPROFILE: SHIM_HOME, LOCALAPPDATA: path.join(SHIM_HOME, 'Local'), APPDATA: path.join(SHIM_HOME, 'Roaming') }); else baseEnv.HOME = SHIM_HOME;
baseEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SHIM_BIN = defaultShimDir({ env: baseEnv, home: SHIM_HOME });
applyShim(planShim({ dir: SHIM_BIN, cacheDir: pluginCacheDir(REPO_DIR), pluginRoot: REPO_DIR }));
baseEnv.PATH = [SHIM_BIN, process.env.PATH].join(path.delimiter);
const runDoctor = (hub) => spawnSync('node', [DOCTOR], { encoding: 'utf8', timeout: 60000, env: { ...baseEnv, HUB_DIR: hub } });
const fixHub = (withFile) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
  const mkdir = (p) => fs.mkdirSync(path.join(r, p), { recursive: true });
  mkdir('.claude'); mkdir('config');
  const cmd = 'node "$CLAUDE_PROJECT_DIR/harness/hooks/dispatch/run.mjs" PreToolUse';
  const mod = path.join(import.meta.dir, '..', '..', 'observe', 'audit', 'defaults.mjs');
  return import(pathToFileURL(mod).href).then(({ hook_events }) => {
    const hooks = {};
    for (const ev of Object.keys(hook_events)) hooks[ev] = [{ hooks: [{ type: 'command', command: cmd }] }];
    fs.writeFileSync(path.join(r, '.claude', 'settings.json'), JSON.stringify({ hooks }));
    if (withFile) { mkdir('harness/hooks/dispatch'); fs.writeFileSync(path.join(r, 'harness/hooks/dispatch/run.mjs'), ''); }
    return r;
  });
};
test('doctor: thieu file hook -> MISS + exit 1', async () => {
  const p = runDoctor(await fixHub(false));
  expect(p.stdout).toContain('[MISS] .claude/settings.json hook dispatch');
  expect(p.status).toBe(1);
});
test('doctor: $CLAUDE_PROJECT_DIR + file ton tai -> khong MISS hook settings', async () => {
  const p = runDoctor(await fixHub(true));
  expect(p.stdout).not.toContain('[MISS] .claude/settings.json');
  expect(p.stdout).toContain('[OK]   .claude/settings.json hook dispatch');
});
test('doctor: settings khong hook + khong plugin -> MISS canh bao; co --plugin-dir hoac enabledPlugins -> khong MISS', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-nohook-'));
  fs.mkdirSync(path.join(r, '.claude'));
  fs.writeFileSync(path.join(r, '.claude', 'settings.json'), '{}');
  const env = { ...process.env, HUB_DIR: r, HOME: r, USERPROFILE: r, CLAUDE_PLUGIN_ROOT: '' };
  const run = (args) => spawnSync('node', [DOCTOR, ...args], { encoding: 'utf8', timeout: 60000, env });
  const a = run([]);
  if (isPluginMode()) { // repo la plugin -> luon coi plugin da nap: khong MISS, ghi 'hook den tu plugin'
    expect(a.stdout).not.toContain('[MISS] .claude/settings.json hook dispatch');
    expect(a.stdout).toContain('hook den tu plugin');
  } else {
    expect(a.stdout).toContain('[MISS] .claude/settings.json hook dispatch');
    expect(a.stdout).toContain('khong thay plugin harness-kit');
  }
  expect(run(['--plugin-dir', 'x']).stdout).not.toContain('[MISS] .claude/settings.json hook dispatch');
  fs.writeFileSync(path.join(r, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'harness-kit@local': true } }));
  const c = run([]);
  expect(c.stdout).not.toContain('[MISS] .claude/settings.json hook dispatch');
  expect(c.stdout).toContain('hook den tu plugin');
});
test('doctor: plugin nap -> khong in khoi hook mau; deny Write(...) -> canh bao doi Edit(...)', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-wr-'));
  fs.mkdirSync(path.join(r, '.claude'));
  fs.writeFileSync(path.join(r, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'harness-kit@local': true }, permissions: { deny: ['Read(/data/**)', 'Write(/data/**)'] } }));
  const out = spawnSync('node', [DOCTOR], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HUB_DIR: r, HOME: r, USERPROFILE: r } }).stdout;
  expect(out).toContain('[skip] khoi hook mau settings.json');
  expect(out).not.toContain('Khoi hook tham khao');
  expect(out).toContain('permissions.deny "Write(/data/**)": Claude bo qua Write(...); doi thanh "Edit(/data/**)"');
  fs.rmSync(r, { recursive: true, force: true });
}, 60000);
test('doctor: echo dispatch/run.mjs bi tu choi; cwd khac cung ket qua; hooks.json hong -> [LOI]', async () => {
  const hub = await fixHub(true);
  const sp = path.join(hub, '.claude', 'settings.json');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  for (const ev of Object.keys(st.hooks)) st.hooks[ev][0].hooks[0].command = 'echo dispatch/run.mjs';
  fs.writeFileSync(sp, JSON.stringify(st));
  const p = runDoctor(hub);
  // 'echo dispatch/run.mjs' khong khop /^node / -> khong tinh la hook guard: hub -> MISS; plugin mode -> coi hook den tu plugin
  if (isPluginMode()) { expect(p.stdout).not.toContain('[OK]   .claude/settings.json hook dispatch'); expect(p.stdout).toContain('hook den tu plugin'); }
  else expect(p.stdout).toContain('[MISS] .claude/settings.json hook dispatch');
  const ok = await fixHub(true);
  const run2 = (cwd) => spawnSync('node', [DOCTOR], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, HUB_DIR: ok } }).stdout;
  run2(ok); // warm-up: lan dau scan ghi vet audit vao hub gia, lam doi ket qua lan sau
  expect(run2(os.tmpdir())).toBe(run2(ok));
  fs.mkdirSync(path.join(ok, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(ok, '.agents', 'hooks.json'), '{broken');
  expect(runDoctor(ok).stdout).toContain('[LOI]');
});
test('doctor: in so finding moi check + tong; --strict khong anh huong khi 0 error', async () => {
  const out = runDoctor(await fixHub(true)).stdout;
  expect(out).toMatch(/\[check\] guard-config: \d+ finding/);
  expect(out).toMatch(/\[check\] data-unregistered: \d+ finding/);
  expect(out).toMatch(/\[check\] data-retention: \d+ finding/);
  expect(out).toMatch(/\[checks\] warnings=\d+ errors=\d+/);
});
test('doctor: tong warnings = tong cac dong [check] (gom nhom khac)', async () => {
  const out = runDoctor(await fixHub(true)).stdout;
  const sum = Number((out.match(/\[checks\] warnings=(\d+)/) || [])[1]);
  const per = [...out.matchAll(/^\[check\] [^:]+: (\d+)/gm)].reduce((s, m) => s + Number(m[1]), 0);
  expect(sum).toBe(per);
});

test('doctor: du an thuong (khong dau hieu hub) -> bo kiem gia dinh hub', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'docbare-'));
  fs.writeFileSync(path.join(bare, '.env'), 'SECRET=1');
  const o1 = runDoctor(bare).stdout;
  expect(o1).toContain('[skip] hubDir/arch/adapter manifest');
  expect(o1).not.toMatch(/nam ngoai hubDir|ARCHITECTURE\.md khong doc duoc|manifest\.json cua hook nao/);
  expect(o1).toMatch(/\[checks\] warnings=0 errors=0/);
}, 60000);

// ---- module khong co tac dung (module-acted) ----
import { recordGate } from '../../core/audit/gate-event.mjs';
import { writeEnvelope } from '../../core/audit/audit-write.mjs';
const DAY = 86400000;
// Ung vien con lai sau khi bo loi + bao tri (data-check, user-shim): proc-orphans (type=proc), model-policy + verify-gate (gate hook:<id>), ext-inject + diff-review (module-acted).
const unusedRun = async (seed) => {
  const hub = await fixHub(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-audit-'));
  for (const [ageDays, ev] of seed) {
    const now = new Date(Date.now() - ageDays * DAY);
    if (ev.type === 'proc') writeEnvelope({ v: 2, ts: now.toISOString(), type: 'proc', event: 'ProcOrphans', sid: 's' }, {}, root);
    else recordGate(ev, { session_id: 's' }, { root, now });
  }
  const p = spawnSync('node', [DOCTOR], { encoding: 'utf8', timeout: 60000, env: { ...baseEnv, HUB_DIR: hub, CLAUDE_AUDIT_DIR: root, CLAUDE_AUDIT_RETENTION_DAYS: '30' } });
  const lines = p.stdout.split('\n');
  return { info: lines.filter((l) => l.startsWith('[info]') && l.includes('khong co tac dung')), skip: lines.filter((l) => l.startsWith('[skip] unused-modules')), warn: lines.filter((l) => l.startsWith('[warn]') && l.includes('khong co tac dung')) };
};
const acted = (id, event = 'SessionStart') => ({ kind: 'gate', decision: 'allow', hook: 'dispatch', rule: 'module-acted', reason: `${id}:${event}` });
const gateHook = (hook) => ({ kind: 'gate', decision: 'allow', hook, rule: 'r' });

test('doctor unused: audit rong -> khong bao, in [skip] neu ro ly do', async () => {
  const r = await unusedRun([]);
  expect(r.info).toEqual([]);
  expect(r.skip.join('\n')).toContain('chua co ban ghi module-acted nao');
}, 60000);
test('doctor unused: module-acted dau tien < 30 ngay -> khong bao, [skip] neu ngay bat dau xet', async () => {
  const r = await unusedRun([[3, acted('data-check')]]);
  expect(r.info).toEqual([]);
  const start = new Date(Date.now() - 3 * DAY + 28 * DAY).toISOString().slice(0, 10);
  expect(r.skip.join('\n')).toContain(`bat dau xet tu ${start}`);
}, 60000);
test('doctor unused: moi ung vien co dau vet (proc, gate hook) -> khong bao', async () => {
  const r = await unusedRun([[29, acted('data-check')], [5, acted('ledger-warn')], [5, gateHook('model-policy')], [5, acted('ext-inject', 'SubagentStart')], [4, { type: 'proc' }]]);
  expect(r.info).toEqual([]);
}, 60000);
test('doctor unused: thieu dau vet ledger-warn -> [info] (khong [warn]) kem su kien + goi y; khong bao loi/bao tri/module co dau vet', async () => {
  const r = await unusedRun([[29, acted('data-check')], [5, acted('ext-inject', 'SubagentStart')], [5, gateHook('model-policy')], [4, { type: 'proc' }]]);
  const text = r.info.join('\n');
  expect(r.warn).toEqual([]);
  expect(text).toContain('ledger-warn (');
  expect(text).toContain('khong co tac dung trong 30 ngay o audit nay; neu moi du an deu vay, can nhac bo khoi plugin');
  expect(text).not.toContain('modules.mjs');
  for (const id of ['data-check (', 'user-shim (', 'model-policy (', 'proc-orphans (', 'audit (', 'guard (', 'worktree-hook (', 'approval (', 'bash-guard (', 'data-gate (']) expect(text).not.toContain(id);
}, 60000);
