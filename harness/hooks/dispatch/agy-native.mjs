// harness-kit: entry hook cho plugin agy NATIVE. Cai GLOBAL (`agy plugin install <goc plugin>`, nguon = cache Claude); agy khong bat theo du an nen hook chay moi workspace -> cong theo du an: chi dispatch khi <ws>/.claude/settings.local.json|settings.json co enabledPlugins["harness-kit@..."] = true (local thang project neu co khoa).
// <plugin>/hooks.json goi `node ./harness/hooks/dispatch/agy-native.mjs <Event>` (cwd hook agy = goc plugin).
// Goc plugin = suy tu vi tri file nay; workspace = workspacePaths[0] trong stdin (agy khong co env workspace).
// Thieu/khong hop le -> KHONG dispatch (cwd = goc plugin, audit se ghi nham vao plugin): HKERR + fail-open.
// Dat HARNESS_PLUGIN_DIR + CLAUDE_PROJECT_DIR + applyWorkspaceEnv roi chay agy.mjs <Event>.
// Timeout con: Pre/Post 3500ms (< 5s hooks.json), SessionStart 25000ms (< 30s hooks.json; user-shim goi reg/powershell dong bo).
// Fail-open: loi -> PreToolUse in {"decision":"allow"}, event khac {}; mot dong HKERR ra stderr; exit 0.
import fs from 'node:fs';
import path from 'node:path';
// shortcut: spawnSync truc tiep, khong qua core/runtime/proc.mjs (killTree taskkill dong bo toi 10s + khoi dong them lam hook vuot timeout hooks.json); co trong PROC_EXCEPTIONS.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

export const fallback = (event) => (event === 'PreToolUse' ? '{"decision":"allow"}\n' : '{}\n');
const hkerr = (cause) => 'HKERR ' + JSON.stringify({ code: 'HK-AGY-001', severity: 'warn', cause: String(cause).slice(0, 200), fix_command: 'harness doctor', next_step: 'hook agy bo qua (fail-open); kiem plugin harness-kit', safe: true, source: 'agy-native.mjs' }) + '\n';

/** Workspace tu payload agy (workspacePaths[0], dau / -> chuan hoa); thieu/khong hop le -> ''. */
export function workspaceOf(input) {
  try {
    const j = JSON.parse(input);
    const w = j && Array.isArray(j.workspacePaths) && typeof j.workspacePaths[0] === 'string' ? j.workspacePaths[0].trim() : '';
    return w ? path.resolve(w) : '';
  } catch { return ''; }
}

/** Du an bat plugin kieu Claude? enabledPlugins co khoa /^harness-kit@/ = true; settings.local.json thang settings.json neu co khoa. Thieu/BOM/JSON hong = khong bat. */
export function enabledIn(ws) {
  for (const f of ['settings.local.json', 'settings.json']) {
    try {
      const ep = JSON.parse(fs.readFileSync(path.join(ws, '.claude', f), 'utf8').replace(/^﻿/, '')).enabledPlugins;
      const keys = ep && typeof ep === 'object' ? Object.keys(ep).filter((k) => /^harness-kit@/.test(k)) : [];
      if (keys.length) return keys.some((k) => ep[k] === true);
    } catch { /* thieu/hong -> thu file tiep */ }
  }
  return false;
}

export async function run(event, input, { root = ROOT, baseEnv = process.env } = {}) {
  const fail = (cause) => ({ stdout: fallback(event), stderr: hkerr(cause) });
  if (!/^[A-Za-z]+$/.test(event)) return fail('su kien khong hop le: ' + String(event).slice(0, 40));
  const ws = workspaceOf(input);
  if (!ws) return fail('payload khong co workspacePaths[0]; bo qua dispatch');
  if (!enabledIn(ws)) return { stdout: fallback(event), stderr: '' }; // du an chua bat plugin: im lang, khong ghi gi
  const env = { ...baseEnv, HARNESS_PLUGIN_DIR: root, CLAUDE_PROJECT_DIR: ws };
  try { (await import(pathToFileURL(path.join(root, 'harness', 'core', 'io', 'paths.mjs')).href)).applyWorkspaceEnv(env, ws); } catch { /* plugin mode mac dinh */ }
  const r = spawnSync(process.execPath, [path.join(root, 'harness', 'hooks', 'dispatch', 'agy.mjs'), event], { input, cwd: root, env, encoding: 'utf8', timeout: event === 'SessionStart' ? 25000 : 3500, windowsHide: true });
  const out = String(r.stdout || '').trim();
  if (r.error || r.status !== 0 || !out.startsWith('{')) return fail('dispatch agy loi: ' + String((r.error && r.error.message) || ('exit ' + r.status)));
  return { stdout: out + '\n', stderr: r.stderr || '' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = String(process.argv[2] || '');
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* khong co stdin */ }
  let r;
  try { r = await run(event, input); } catch (e) { r = { stdout: fallback(event), stderr: hkerr(e && e.message) }; }
  if (r.stderr) process.stderr.write(r.stderr);
  process.stdout.write(r.stdout);
  process.exit(0);
}
