// Wrapper hook plugin: `node hooks/run.mjs <Event> [module]` (hooks/hooks.json goi qua ${CLAUDE_PLUGIN_ROOT}).
// Khong dua vao khoi `env` cua settings: tu suy bien moi truong roi chuyen sang dispatcher harness/hooks/dispatch/run.mjs.
// Quy tac (chi dat khi bien CHUA co):
//   - HARNESS_PLUGIN_DIR = CLAUDE_PLUGIN_ROOT | goc plugin (tinh tu vi tri file nay).
//   - Du an co dau hieu workspace tuy bien (core/io/paths.mjs WORKSPACE_MARKERS: config/workspace/default.json | config/hub/default.json)
//     -> HUB_DATA_DIR=<du an>/data, HARNESS_CONFIG_DIR=<du an>/config. Du an thuong: mac dinh plugin mode (<du an>/.harness/...).
// Loi: fail-open (`{}` exit 0; WorktreeCreate exit 1) nhung LUON ghi mot dong `HKERR {...}` ra stderr (HK-HOOK-001/002).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyWorkspaceEnv, hkerr } from '../harness/core/io/paths.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const has = (env, k) => typeof env[k] === 'string' && env[k].trim();

/** Suy bien moi truong cho hook (thuan, testable). Sua env tai cho va tra ve env. */
export function deriveEnv(env = process.env) {
  if (!has(env, 'HARNESS_PLUGIN_DIR')) env.HARNESS_PLUGIN_DIR = has(env, 'CLAUDE_PLUGIN_ROOT') ? path.resolve(env.CLAUDE_PLUGIN_ROOT.trim()) : PLUGIN;
  if (has(env, 'CLAUDE_PROJECT_DIR')) applyWorkspaceEnv(env, env.CLAUDE_PROJECT_DIR);
  return env;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = String(process.argv[2] || '');
  try {
    if (!/^[A-Za-z]+$/.test(event)) throw new Error('su kien khong hop le: ' + event.slice(0, 40));
    try { deriveEnv(process.env); } catch (e) { hkerr('HK-HOOK-002', 'suy workspace loi: ' + (e && e.message), { source: 'hooks/run.mjs', next_step: 'dung mac dinh plugin mode; kiem config/ cua du an' }); }
    const run = path.join(PLUGIN, 'harness', 'hooks', 'dispatch', 'run.mjs');
    const { main } = await import(pathToFileURL(run).href);
    await main({ event, only: process.argv[3] || '' });
  } catch (e) {
    hkerr('HK-HOOK-001', 'wrapper hook loi (' + event.slice(0, 40) + '): ' + (e && e.message), { source: 'hooks/run.mjs', next_step: 'hook bi bo qua (fail-open); chay harness doctor' });
    if (event === 'WorktreeCreate') process.exit(1);
    process.stdout.write(event === 'WorktreeRemove' ? '' : '{}');
    process.exit(0);
  }
}
