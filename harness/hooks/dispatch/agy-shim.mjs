// harness-kit: shim hook agy. `harness agy init` chep file nay vao <du an>/.agents/harness-agy-shim.mjs (KHONG sua tay ban chep).
// .agents/hooks.json goi `node ./harness-agy-shim.mjs <Event>` (cwd hook agy = .agents/, VERIFIED) -> khong duong dan tuyet doi, khong launcher.
// Tim goc plugin (theo may, khong commit): env HARNESS_KIT_PLUGIN_DIR > .agents/harness-agy.local.json {pluginRoot} (do init ghi, gitignored)
//   > ~/.claude/plugins/installed_plugins.json (harness-kit@*, uu tien projectPath = du an, roi lastUpdated moi nhat).
// Roi chay <plugin>/harness/hooks/dispatch/agy.mjs <Event> voi workspace = .agents/.. (CLAUDE_PROJECT_DIR).
// Che do CLI: `node ./harness-agy-shim.mjs cli <lenh...>` (cwd bat ky; workspace = .agents/..) chay cong CLI cua plugin (bin/harness) bang process.execPath + duong dan tuyet doi, khong PATH.
//   Loi (khong thay plugin / spawn loi): mot dong HKERR (HK-AGY-002, severity error, fix_command) + exit 1; ma thoat CLI duoc giu nguyen.
// Tu chua: khi tim duoc plugin ma .agents/harness-agy.local.json thieu/lech -> ghi lai (best effort).
// Fail-open: khong thay plugin / loi -> PreToolUse in {"decision":"allow"}, event khac {}; mot dong HKERR ra stderr; exit 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(HERE, '..');
const EVENT = String(process.argv[2] || '');
const FALLBACK = EVENT === 'PreToolUse' ? '{"decision":"allow"}\n' : '{}\n';
const DISPATCH = ['harness', 'hooks', 'dispatch', 'agy.mjs'];
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const valid = (r) => typeof r === 'string' && r.trim() !== '' && fs.existsSync(path.join(r.trim(), ...DISPATCH));
const same = (a, b) => { const n = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase(); try { return n(a) === n(b); } catch { return false; } };

export function candidates({ env = process.env, here = HERE, ws = WS, home = os.homedir() } = {}) {
  const out = [];
  if (env.HARNESS_KIT_PLUGIN_DIR) out.push(env.HARNESS_KIT_PLUGIN_DIR);
  const local = readJson(path.join(here, 'harness-agy.local.json'));
  if (local && local.pluginRoot) out.push(local.pluginRoot);
  const inst = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const ents = [];
  for (const [k, list] of Object.entries((inst && inst.plugins) || {})) if (/^harness-kit@/.test(k) && Array.isArray(list)) ents.push(...list);
  ents.sort((a, b) => (same(b.projectPath || '', ws) - same(a.projectPath || '', ws)) || String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || '')));
  for (const e of ents) if (e && e.installPath) out.push(e.installPath);
  return out;
}

const FIX = 'harness agy init';
function hkerr(code, severity, cause, next, safe) {
  return 'HKERR ' + JSON.stringify({ code, severity, cause, fix_command: FIX, next_step: next, safe, source: '.agents/harness-agy-shim.mjs' }) + '\n';
}
function fail(cause) {
  process.stderr.write(hkerr('HK-AGY-001', 'warn', cause, 'hook agy bo qua (fail-open); chay harness agy init trong du an', true));
  process.stdout.write(FALLBACK);
  process.exit(0);
}
function healLocal(root) {
  try {
    const f = path.join(HERE, 'harness-agy.local.json');
    const want = path.resolve(root.trim());
    const cur = readJson(f);
    if (!cur || cur.pluginRoot !== want) fs.writeFileSync(f, JSON.stringify({ pluginRoot: want }, null, 2) + '\n');
  } catch { /* chi la tu chua, bo qua */ }
}
function runCli(args) {
  const root = candidates().find(valid);
  if (!root) { process.stderr.write(hkerr('HK-AGY-002', 'error', 'khong tim thay plugin harness-kit (env/harness-agy.local.json/installed_plugins.json)', 'cai plugin harness-kit (/plugin install harness-kit@synura) roi chay lai', false)); process.exit(1); }
  healLocal(root);
  const env = { ...process.env, HARNESS_PLUGIN_DIR: path.resolve(root.trim()) };
  if (!(env.CLAUDE_PROJECT_DIR || '').trim()) env.CLAUDE_PROJECT_DIR = WS;
  const r = spawnSync(process.execPath, [path.join(root.trim(), 'bin', 'harness'), ...args], { stdio: 'inherit', env, windowsHide: true });
  if (r.error) { process.stderr.write(hkerr('HK-AGY-002', 'error', String(r.error.message).slice(0, 200), 'kiem node va plugin harness-kit', false)); process.exit(1); }
  process.exit(r.status === null ? 1 : r.status);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (EVENT === 'cli') runCli(process.argv.slice(3));
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* khong co stdin */ }
  if (!/^[A-Za-z]+$/.test(EVENT)) fail('su kien khong hop le: ' + EVENT.slice(0, 40));
  const root = candidates().find(valid);
  if (!root) fail('khong tim thay plugin harness-kit (env/harness-agy.local.json/installed_plugins.json)');
  healLocal(root);
  const env = { ...process.env, HARNESS_PLUGIN_DIR: path.resolve(root.trim()) };
  if (!(env.CLAUDE_PROJECT_DIR || '').trim()) env.CLAUDE_PROJECT_DIR = WS;
  try { (await import(pathToFileURL(path.join(root.trim(), 'harness', 'core', 'io', 'paths.mjs')).href)).applyWorkspaceEnv(env, env.CLAUDE_PROJECT_DIR); } catch { /* plugin mode mac dinh */ }
  const r = spawnSync(process.execPath, [path.join(root.trim(), ...DISPATCH), EVENT], { input, cwd: HERE, env, encoding: 'utf8', timeout: EVENT === 'SessionStart' ? 9500 : 4500, windowsHide: true });
  if (r.stderr) process.stderr.write(r.stderr);
  const out = String(r.stdout || '').trim();
  if (r.error || r.status !== 0 || !out.startsWith('{')) fail('dispatch agy loi: ' + String((r.error && r.error.message) || ('exit ' + r.status)).slice(0, 200));
  process.stdout.write(out + '\n');
  process.exit(0);
}
