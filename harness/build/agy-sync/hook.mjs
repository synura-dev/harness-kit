// Hook SessionStart agy-sync: giu ban cai plugin harness-kit trong agy (global, ~/.gemini/config/plugins/harness-kit) khop version plugin Claude.
// Duong re (khong spawn): doc version ban cai agy; bang version plugin nay -> thoi. Khac/thieu va co agy tren PATH -> `agy plugin install "<goc plugin>"`
// chay NEN (spawnBackground: detached, windowsHide, khong chan SessionStart) + bao mot dong. Chi chay khi goc plugin nam trong cache Claude (khong chep ban dev .git/data).
// Chong chay lap: dau thoi gian ~/.harness-kit/agy-sync.json (cung version, < 10 phut) + khoa spawnBackground. Fail-open. Tat: HARNESS_AGY_AUTOSYNC=0 hoac hook.config.local.json {"enabled": false}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { REPO_DIR } from '../../core/io/paths.mjs';
import { spawnBackground } from '../../core/runtime/proc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP_TTL_MS = 10 * 60e3;

export const DEFAULTS = { enabled: true, events: ['SessionStart'], timeoutMs: 4000 };
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('agy-sync', { defaults: DEFAULTS, files, env: { HOOK_AGY_SYNC_ENABLED: 'enabled' } });

const versionOf = (f) => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')).version; return typeof v === 'string' && v ? v : null; } catch { return null; } };
const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

/** Goc plugin nam duoi <claude>/plugins/cache? */
export function inClaudeCache(pluginRoot, { env, home }) {
  const cache = norm(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'cache')) + '/';
  return norm(pluginRoot).startsWith(cache);
}

/** agy tren PATH (co PATHEXT tren Windows) -> duong dan file | null. */
export function whichAgy({ env, platform }) {
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const d of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) { const f = path.join(d, 'agy' + e); try { if (fs.statSync(f).isFile()) return f; } catch { /* khong co */ } }
  }
  return null;
}

const defaultSpawn = ({ cmd, args, key }) => spawnBackground({ cmd, args, key, deadlineMs: 5 * 60e3 });

/**
 * Hop dong HOOK_MODULE: handle(event, input, ctx) -> {} | {additionalContext}.
 * ctx (tuy chon, test): {cfg, pluginRoot, inj:{env, home, platform, now, spawn, which}}.
 */
export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg ?? load().config;
    if (!cfg.enabled || !cfg.events.includes(event)) return {};
    const inj = ctx.inj || {};
    // bun test dat NODE_ENV=test: test dispatcher chay SessionStart that KHONG duoc cai plugin vao agy cua may; chi chay khi test tiem IO.
    if (!ctx.inj && process.env.NODE_ENV === 'test') return {};
    const env = inj.env || process.env;
    if (env.HARNESS_AGY_AUTOSYNC === '0') return {};
    const home = inj.home || os.homedir();
    const pluginRoot = ctx.pluginRoot || REPO_DIR;
    if (!inClaudeCache(pluginRoot, { env, home })) return {};
    const mine = versionOf(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
    if (!mine) return {};
    const installed = versionOf(path.join(home, '.gemini', 'config', 'plugins', 'harness-kit', '.antigravity-plugin', 'plugin.json'));
    if (installed === mine) return {};
    if (!installed && !fs.existsSync(path.join(home, '.gemini'))) return {}; // may khong co agy
    const platform = inj.platform || process.platform;
    const agy = (inj.which || whichAgy)({ env, platform });
    if (!agy) return {};
    const now = inj.now ?? Date.now();
    const stampFile = path.join(home, '.harness-kit', 'agy-sync.json');
    try { const s = JSON.parse(fs.readFileSync(stampFile, 'utf8')); if (s && s.version === mine && now - Number(s.at) < STAMP_TTL_MS) return {}; } catch { /* chua co dau */ }
    try { fs.mkdirSync(path.dirname(stampFile), { recursive: true }); fs.writeFileSync(stampFile, JSON.stringify({ version: mine, at: now })); } catch { return {}; } // khong ghi duoc dau -> khong spawn (tranh lap vo han)
    const install = ['plugin', 'install', pluginRoot];
    // .cmd/.bat tren Windows khong spawn truc tiep duoc: qua cmd.exe /c
    const cmd = /\.(cmd|bat)$/i.test(agy) ? (env.ComSpec || 'cmd.exe') : agy;
    const args = cmd === agy ? install : ['/c', agy, ...install];
    const pid = (inj.spawn || defaultSpawn)({ cmd, args, key: 'agy-plugin-sync' });
    if (!pid) return {};
    return { additionalContext: `agy plugin harness-kit: cap nhat ${installed || '(chua cai)'} -> ${mine}` };
  } catch { return {}; } // fail-open
}

const META = { id: 'agy-sync', events: DEFAULTS.events, timeoutMs: DEFAULTS.timeoutMs, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
