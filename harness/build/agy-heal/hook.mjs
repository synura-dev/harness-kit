// Hook SessionStart agy-heal: sau khi nang version plugin (cache doi duong dan), tu ghi lai <du an>/.agents/harness-agy.local.json {pluginRoot}
// khi file DA TON TAI ma pluginRoot lech (dung phan "ghi local" cua `harness agy init`; khong dong hooks.json/shim/PATH).
// File chua tung co (du an khong dung agy) -> KHONG tao. Ghi mot dong audit (ext). Fail-open, nhe.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_DIR } from '../../core/io/paths.mjs';
import { auditExt } from '../../core/ext/ctx.mjs';

export const DEFAULTS = { enabled: true, events: ['SessionStart'], timeoutMs: 3000 };
const LOCAL = path.join('.agents', 'harness-agy.local.json');

const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
const same = (a, b) => { try { return norm(a) === norm(b); } catch { return false; } };
const inCache = (p) => /[\\/]\.claude[\\/]plugins[\\/]cache[\\/]/.test(path.resolve(String(p)) + path.sep);

/** healLocal({dir, pluginRoot, audit}) -> 'healed' | 'ok' | 'absent' | 'skip'. Chi sua file thuong da co, JSON hop le, root cu da mat/cache cu, root moi trong cache. */
export function healLocal({ dir, pluginRoot, audit }) {
  const f = path.join(dir, LOCAL);
  let st;
  try { st = fs.lstatSync(f); } catch (e) { return e.code === 'ENOENT' ? 'absent' : 'skip'; }
  if (!st.isFile()) return 'skip'; // symlink/junction/thu muc
  let cur;
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch {
    if (audit) audit('agy-heal', { event: 'agy-heal', ok: false, status: 'skip', target: '.agents/harness-agy.local.json', summary: 'JSON hong, bo qua' });
    return 'skip';
  }
  if (!cur || typeof cur !== 'object') return 'skip';
  if (!inCache(pluginRoot)) return 'skip'; // REPO_DIR la worktree dev
  const want = path.resolve(pluginRoot);
  if (typeof cur.pluginRoot === 'string') {
    if (same(cur.pluginRoot, want)) return 'ok';
    if (fs.existsSync(cur.pluginRoot) && !inCache(cur.pluginRoot)) return 'skip'; // nguoi dung ghim dev
  }
  const tmpf = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpf, JSON.stringify({ pluginRoot: want }, null, 2) + '\n');
  try { fs.renameSync(tmpf, f); } catch (e) { try { fs.unlinkSync(tmpf); } catch {} throw e; }
  return 'healed';
}

export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg || DEFAULTS;
    if (!cfg.enabled || !cfg.events.includes(event)) return {};
    if (!ctx.dir && process.env.NODE_ENV === 'test') return {};
    const dir = ctx.dir || (process.env.CLAUDE_PROJECT_DIR || '').trim() || (input && input.cwd) || process.cwd();
    const pluginRoot = ctx.pluginRoot || (process.env.HARNESS_KIT_PLUGIN_DIR || '').trim() || REPO_DIR;
    if (!fs.existsSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))) return {};
    const r = healLocal({ dir, pluginRoot, audit: ctx.audit || auditExt });
    if (r === 'healed') (ctx.audit || auditExt)('agy-heal', { event: 'agy-heal', ok: true, status: 'healed', target: '.agents/harness-agy.local.json', summary: 'ghi lai pluginRoot ' + path.resolve(pluginRoot) });
    return {};
  } catch { return {}; } // fail-open
}

const META = { id: 'agy-heal', events: DEFAULTS.events, timeoutMs: DEFAULTS.timeoutMs, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
