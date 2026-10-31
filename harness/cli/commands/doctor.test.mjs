import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkManifest } from '../../core/checks/manifest-check.mjs';

const mk = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
  const w = (rel, s = '') => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), s); };
  return { r, w };
};
const man = (o) => JSON.stringify({ layer: 'ext', config: { defaults: null, schema: null }, ...o });
const cliMan = () => man({ id: 'cli', kind: 'cli', layer: 'core', entry: 'harness.mjs', domain: 'harness', domains: { a: 'a.mjs' } });

test('khong co manifest nao -> khong nem loi, tra mang', () => {
  expect(Array.isArray(checkManifest(mk().r))).toBe(true);
});

test('entry thieu, hook thieu README/config, file chua khai bao, plugin thieu manifest', () => {
  const { r, w } = mk();
  w('harness/cli/manifest.json', cliMan());
  w('harness/cli/harness.mjs'); w('harness/cli/a.mjs'); w('harness/cli/b.mjs'); w('harness/cli/b.test.mjs');
  w('harness/hooks/h1/manifest.json', man({ id: 'h1', kind: 'hook', entry: 'gone.mjs' }));
  w('harness/hooks/h1/x.mjs'); w('harness/hooks/h2/README.md'); w('harness/plugins/p/p.mjs');
  const out = checkManifest(r).join('\n');
  expect(out).toContain('h1: entry khong ton tai');
  expect(out).toContain('hook h2: thieu config JSON/defaults.mjs khong rong hoac adapter hop le');
  expect(out).toContain('chua co manifest.json: harness/plugins/p');
  expect(out).toContain('chua co trong manifest: harness/cli/b.mjs');
  expect(out).not.toContain('harness/cli/a.mjs');
});

test('day du -> khong canh bao', () => {
  const { r, w } = mk();
  w('harness/cli/manifest.json', cliMan());
  w('harness/cli/harness.mjs'); w('harness/cli/a.mjs'); w('harness/cli/a.test.mjs');
  w('harness/hooks/h/manifest.json', man({ id: 'h', kind: 'hook', entry: 'h.mjs' }));
  w('harness/hooks/h/h.mjs'); w('harness/hooks/h/README.md'); w('harness/hooks/h/h.config.json', '{"enabled":true}');
  expect(checkManifest(r)).toEqual([]);
});

// chay doctor.mjs that tren fixture (HUB_DIR) de kiem exit code va kiem hook settings
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isPluginMode } from '../../core/io/paths.mjs';
const DOCTOR = path.join(import.meta.dir, 'doctor.mjs');
const runDoctor = (hub) => spawnSync('node', [DOCTOR], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HUB_DIR: hub } });
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
  expect(out).toMatch(/\[check\] ref: \d+ finding/);
  expect(out).toMatch(/\[check\] import: \d+ finding/);
  expect(out).toMatch(/\[check\] clutter: \d+ finding/);
  expect(out).toMatch(/\[checks\] warnings=\d+ errors=\d+/);
});
test('doctor: tong warnings = tong cac dong [check] (gom nhom khac)', async () => {
  const out = runDoctor(await fixHub(true)).stdout;
  const sum = Number((out.match(/\[checks\] warnings=(\d+)/) || [])[1]);
  const per = [...out.matchAll(/^\[check\] [^:]+: (\d+)/gm)].reduce((s, m) => s + Number(m[1]), 0);
  expect(sum).toBe(per);
});

test('doctor: du an thuong (khong dau hieu hub) -> bo kiem gia dinh hub; co dau hieu hub -> van bao', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'docbare-'));
  fs.writeFileSync(path.join(bare, '.env'), 'SECRET=1');
  const o1 = runDoctor(bare).stdout;
  expect(o1).toContain('[skip] hubDir/arch/adapter manifest');
  expect(o1).not.toMatch(/nam ngoai hubDir|ARCHITECTURE\.md khong doc duoc|manifest\.json cua hook nao/);
  expect(o1).toMatch(/\[checks\] warnings=0 errors=0/);
  const hubf = fs.mkdtempSync(path.join(os.tmpdir(), 'dochub-'));
  fs.mkdirSync(path.join(hubf, 'config', 'hub'), { recursive: true });
  fs.writeFileSync(path.join(hubf, 'config', 'hub', 'default.json'), '{}');
  const o2 = runDoctor(hubf).stdout;
  expect(o2).not.toContain('[skip] hubDir/arch/adapter manifest');
  expect(o2).toMatch(/nam ngoai hubDir/);
  expect(o2).toMatch(/ARCHITECTURE\.md khong doc duoc/);
}, 60000);

test('doctor: .agents/hooks.json co harness-kit nhung thieu shim/local -> exit 1 + HKERR fix_command', async () => {
  const hub = await fixHub(true);
  fs.mkdirSync(path.join(hub, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(hub, '.agents', 'hooks.json'), JSON.stringify({ 'harness-kit': { Stop: [{ type: 'command', command: 'node ./harness-agy-shim.mjs Stop' }] } }));
  const p = runDoctor(hub);
  expect(p.status).toBe(1);
  expect(p.stdout).toContain('"fix_command":"harness agy init"');
});
