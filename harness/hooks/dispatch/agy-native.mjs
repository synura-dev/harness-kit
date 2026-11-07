// harness-kit: entry hook cho plugin agy NATIVE (`agy plugin install <repo>`). Thay shim theo du an (.agents/harness-agy-shim.mjs).
// <plugin>/hooks.json goi `node ./harness/hooks/dispatch/agy-native.mjs <Event>` (cwd hook agy = goc plugin).
// Goc plugin = suy tu vi tri file nay; workspace = workspacePaths[0] trong stdin (agy khong co env workspace), thieu -> process.cwd().
// Dat HARNESS_PLUGIN_DIR + CLAUDE_PROJECT_DIR + applyWorkspaceEnv roi chay agy.mjs <Event>.
// Fail-open: loi -> PreToolUse in {"decision":"allow"}, event khac {}; mot dong HKERR ra stderr; exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

export const fallback = (event) => (event === 'PreToolUse' ? '{"decision":"allow"}\n' : '{}\n');
const hkerr = (cause) => 'HKERR ' + JSON.stringify({ code: 'HK-AGY-001', severity: 'warn', cause: String(cause).slice(0, 200), fix_command: 'harness doctor', next_step: 'hook agy bo qua (fail-open); kiem plugin harness-kit', safe: true, source: 'agy-native.mjs' }) + '\n';

/** Workspace tu payload agy (workspacePaths[0], dau / -> chuan hoa); thieu/khong hop le -> cwd. */
export function workspaceOf(input, cwd = process.cwd()) {
  let ws = '';
  try { const j = JSON.parse(input); if (j && Array.isArray(j.workspacePaths) && typeof j.workspacePaths[0] === 'string') ws = j.workspacePaths[0].trim(); } catch { /* khong phai JSON */ }
  return path.resolve(ws || cwd);
}

export async function run(event, input, { root = ROOT, cwd = process.cwd(), baseEnv = process.env } = {}) {
  const fail = (cause) => ({ stdout: fallback(event), stderr: hkerr(cause) });
  if (!/^[A-Za-z]+$/.test(event)) return fail('su kien khong hop le: ' + String(event).slice(0, 40));
  const env = { ...baseEnv, HARNESS_PLUGIN_DIR: root, CLAUDE_PROJECT_DIR: workspaceOf(input, cwd) };
  try { (await import(pathToFileURL(path.join(root, 'harness', 'core', 'io', 'paths.mjs')).href)).applyWorkspaceEnv(env, env.CLAUDE_PROJECT_DIR); } catch { /* plugin mode mac dinh */ }
  let spawnSync; // import dong: import tinh hong se lam hook crash (chan moi tool)
  try { ({ spawnSync } = await import(pathToFileURL(path.join(root, 'harness', 'core', 'runtime', 'proc.mjs')).href)); } catch (e) { return fail('proc.mjs: ' + (e && e.message)); }
  const r = spawnSync(process.execPath, [path.join(root, 'harness', 'hooks', 'dispatch', 'agy.mjs'), event], { input, cwd: root, env, encoding: 'utf8', timeout: event === 'SessionStart' ? 9500 : 4500, windowsHide: true });
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
