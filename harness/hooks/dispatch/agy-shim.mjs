// harness-kit: shim hook agy. `harness agy init` chep file nay vao <du an>/.agents/harness-agy-shim.mjs (KHONG sua tay ban chep).
// .agents/hooks.json goi `node ./harness-agy-shim.mjs <Event>` (cwd hook agy = .agents/, VERIFIED) -> khong duong dan tuyet doi, khong launcher.
// Tim goc plugin (theo may, khong commit): env HARNESS_KIT_PLUGIN_DIR > .agents/harness-agy.local.json {pluginRoot} (do init ghi, gitignored)
//   > ~/.claude/plugins/installed_plugins.json (harness-kit@*, uu tien projectPath = du an, roi lastUpdated moi nhat).
// Roi chay <plugin>/harness/hooks/dispatch/agy.mjs <Event> voi workspace = .agents/.. (CLAUDE_PROJECT_DIR).
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

function fail(cause) {
  process.stderr.write('HKERR ' + JSON.stringify({ code: 'HK-AGY-001', severity: 'warn', cause, fix_command: 'harness agy init', next_step: 'hook agy bo qua (fail-open); chay harness agy init trong du an', safe: true, source: '.agents/harness-agy-shim.mjs' }) + '\n');
  process.stdout.write(FALLBACK);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* khong co stdin */ }
  if (!/^[A-Za-z]+$/.test(EVENT)) fail('su kien khong hop le: ' + EVENT.slice(0, 40));
  const root = candidates().find(valid);
  if (!root) fail('khong tim thay plugin harness-kit (env/harness-agy.local.json/installed_plugins.json)');
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
