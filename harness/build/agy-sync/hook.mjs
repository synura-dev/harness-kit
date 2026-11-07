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

const BACKOFF_CAP_MS = 24 * 3600e3;
const LOCK_STALE_MS = 60e3;

/** So sanh major.minor.patch (so): a>b 1, a<b -1, bang 0; khong doc duoc -> null. */
export function cmpVer(a, b) {
  const p = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v)); return m ? [+m[1], +m[2], +m[3]] : null; };
  const x = p(a); const y = p(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** Khoa doc quyen (open 'wx'); khoa cu > 60s coi la treo -> xoa thu lai mot lan. Tra fd | null (nguoi khac giu). Loi khac -> nem. */
function lockOpen(f) {
  for (let i = 0; i < 2; i++) {
    try { return fs.openSync(f, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(f).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(f); continue; } } catch { /* mat khoa */ }
      return null;
    }
  }
  return null;
}
function lockClose(fd, f) { try { fs.closeSync(fd); } catch { /* bo qua */ } try { fs.unlinkSync(f); } catch { /* bo qua */ } }

/**
 * Lenh cai: .exe/khong duoi -> spawn thang (mang args, khong qua shell). .cmd/.bat -> cmd.exe /d /s /c "<dong day du co nhay kep>" + verbatim;
 * tu choi (null) neu duong dan chua % hoac " (cmd khong thoat duoc an toan); & ^ trong nhay kep an toan.
 */
export function spawnArgs(agy, pluginRoot, env = process.env) {
  if (!/\.(cmd|bat)$/i.test(agy)) return { cmd: agy, args: ['plugin', 'install', pluginRoot] };
  if (/[%"\r\n]/.test(agy + pluginRoot)) return null;
  return { cmd: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `""${agy}" plugin install "${pluginRoot}""`], verbatim: true };
}

const defaultSpawn = ({ cmd, args, key, verbatim }) => spawnBackground({ cmd, args, key, verbatim, deadlineMs: 5 * 60e3 });

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
    // chi khi mo phien moi (startup); resume/compact/clear khong cai lai. Thieu source -> coi nhu startup.
    const source = input && typeof input === 'object' ? input.source : undefined;
    if (source !== undefined && source !== 'startup') return {};
    const installed = versionOf(path.join(home, '.gemini', 'config', 'plugins', 'harness-kit', '.antigravity-plugin', 'plugin.json'));
    if (installed === mine) return {};
    if (!installed && !fs.existsSync(path.join(home, '.gemini'))) return {}; // may khong co agy
    // chi NANG CAP: da cai thi chi khi mine > installed (khong ha cap; version khong doc duoc -> bo qua)
    if (installed) { const c = cmpVer(mine, installed); if (c === null || c <= 0) return {}; }
    const now = inj.now ?? Date.now();
    const dir = path.join(home, '.harness-kit');
    const stampFile = path.join(dir, 'agy-sync.json');
    const lockFile = path.join(dir, 'agy-sync.lock');
    let lock;
    try { fs.mkdirSync(dir, { recursive: true }); lock = lockOpen(lockFile); } catch { return {}; } // khong ghi duoc -> khong spawn (tranh lap vo han)
    if (lock === null) return {}; // phien khac dang phat
    try {
      let fails = 0;
      try {
        const s = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
        if (s && s.version === mine) {
          const wait = Math.min(BACKOFF_CAP_MS, STAMP_TTL_MS * 2 ** Math.min(Number(s.fails) || 0, 30));
          const age = now - Number(s.at);
          if (age >= 0 && age < wait) return {}; // dang cho / lui (lan truoc khong cai duoc)
          fails = (Number(s.fails) || 0) + 1; // lan truoc cung version ma van chua khop = that bai
        }
      } catch { /* chua co dau */ }
      const platform = inj.platform || process.platform;
      const agy = (inj.which || whichAgy)({ env, platform });
      if (!agy) return {};
      const sp = spawnArgs(agy, pluginRoot, env);
      if (!sp) return {};
      try { fs.writeFileSync(stampFile, JSON.stringify({ version: mine, at: now, fails })); } catch { return {}; }
      const pid = (inj.spawn || defaultSpawn)({ ...sp, key: 'agy-plugin-sync' });
      if (!pid) return {};
      return { additionalContext: `agy plugin harness-kit: cap nhat ${installed || '(chua cai)'} -> ${mine}` };
    } finally { lockClose(lock, lockFile); }
  } catch { return {}; } // fail-open
}

const META = { id: 'agy-sync', events: DEFAULTS.events, timeoutMs: DEFAULTS.timeoutMs, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
