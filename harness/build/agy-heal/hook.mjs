// Hook SessionStart agy-heal: sau khi nang version plugin (cache doi duong dan), tu ghi lai <du an>/.agents/harness-agy.local.json {pluginRoot}
// khi file DA TON TAI ma pluginRoot lech (dung phan "ghi local" cua `harness agy init`; khong dong hooks.json/shim/PATH).
// File chua tung co (du an khong dung agy) -> KHONG tao. Ghi mot dong audit (ext). Fail-open, nhe.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_DIR } from '../../core/io/paths.mjs';
import { auditExt } from '../../core/ext/ctx.mjs';

export const DEFAULTS = { enabled: true, events: ['SessionStart'], timeoutMs: 3000 };
const LOCAL = path.join('.agents', 'harness-agy.local.json');

/** healLocal({dir, pluginRoot}) -> 'healed' | 'ok' | 'absent'. Chi sua file local da co. */
export function healLocal({ dir, pluginRoot }) {
  const f = path.join(dir, LOCAL);
  let cur;
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { if (e.code === 'ENOENT') return 'absent'; cur = null; }
  const want = path.resolve(pluginRoot);
  if (cur && cur.pluginRoot === want) return 'ok';
  fs.writeFileSync(f, JSON.stringify({ pluginRoot: want }, null, 2) + '\n');
  return 'healed';
}

export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg || DEFAULTS;
    if (!cfg.enabled || !cfg.events.includes(event)) return {};
    if (!ctx.dir && process.env.NODE_ENV === 'test') return {};
    const dir = ctx.dir || (process.env.CLAUDE_PROJECT_DIR || '').trim() || (input && input.cwd) || process.cwd();
    const pluginRoot = ctx.pluginRoot || REPO_DIR;
    if (!fs.existsSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))) return {};
    const r = healLocal({ dir, pluginRoot });
    if (r === 'healed') (ctx.audit || auditExt)('agy-heal', { event: 'agy-heal', ok: true, status: 'healed', target: '.agents/harness-agy.local.json', summary: 'ghi lai pluginRoot ' + path.resolve(pluginRoot) });
    return {};
  } catch { return {}; } // fail-open
}

const META = { id: 'agy-heal', events: DEFAULTS.events, timeoutMs: DEFAULTS.timeoutMs, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
