// Shim `harness` cho shell cua user (PowerShell/cmd/bash ngoai Claude): Claude Code chi them bin/ cua plugin vao PATH cua Bash tool.
// Opt-in qua `harness install --shim`. KHONG sua PATH/registry: chi ghi file vao mot thu muc DA co tren PATH (mac dinh: Windows %APPDATA%\npm
// neu co tren PATH user, khong thi thu muc ghi duoc dau tien; POSIX ~/.local/bin). Shim chon ban harness-kit moi nhat trong cache plugin luc chay
// (so sanh so: 0.1.10 > 0.1.9), nen nang cap plugin khong can cai lai. File co dong SHIM_MARK = cua ta; khong co = file la, chi ghi de khi --force.
// Thuan + tiem duoc (platform/env/home/regPath) de test; chi applyShim ghi dia.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SHIM_MARK = 'harness-kit user shim';
const pp = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const key = (platform, p) => { const s = pp(platform).normalize(String(p)).replace(/[\\/]+$/, ''); return platform === 'win32' ? s.toLowerCase() : s; };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return isDir(d); } catch { return false; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** Ten file shim theo nen: Windows ghi ca harness.cmd (PowerShell/cmd) va harness (Git Bash), nhu npm. File dau = file chinh. */
const shimNames =(platform) => (platform === 'win32' ? ['harness.cmd', 'harness'] : ['harness']);

/** Thu muc cache chua cac ban harness-kit (<config>/plugins/cache/<mkt>/harness-kit) hoac null (chay tu nguon, chua cai plugin). */
export function pluginCacheDir(pluginRoot, { env = process.env, home = os.homedir() } = {}) {
  const parent = path.dirname(path.resolve(pluginRoot));
  if (path.basename(parent) === 'harness-kit' && path.basename(path.dirname(path.dirname(parent))) === 'cache') return parent;
  const cache = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'cache');
  let mkts = [];
  try { mkts = fs.readdirSync(cache).sort(); } catch { return null; }
  for (const m of mkts) if (isDir(path.join(cache, m, 'harness-kit'))) return path.join(cache, m, 'harness-kit');
  return null;
}

// JS chay bang `node -e`: khong dung " % $ ` (an toan trong ca cmd lan sh). D = thu muc cache, F = bin co dinh (khi khong co cache).
const js = (D, F) => [
  "const f=require('fs'),p=require('path'),c=require('child_process');",
  `const D='${D}';let b='${F}';`,
  "if(!b){let v;try{v=f.readdirSync(D).filter(x=>f.existsSync(p.join(D,x,'bin','harness'))).sort((x,y)=>x.localeCompare(y,'en',{numeric:true})).pop()}catch(e){}",
  "if(!v){console.error('harness: khong tim thay plugin harness-kit trong '+D);process.exit(3)}b=p.join(D,v,'bin','harness')}",
  "const r=c.spawnSync(process.execPath,[b,...process.argv.slice(1)],{stdio:'inherit'});process.exit(r.status==null?1:r.status)",
].join('');
const lit = (s) => String(s || '').replace(/\\/g, '/').replace(/'/g, "\\'");

/** [{name, content}] cho nen; noi dung tat dinh theo (cacheDir, pluginRoot). */
export function renderShims({ platform = process.platform, cacheDir, pluginRoot }) {
  const code = js(lit(cacheDir), cacheDir ? '' : lit(path.join(pluginRoot, 'bin', 'harness')));
  const head = `${SHIM_MARK} (sinh boi: harness install --shim). Go: xoa file nay.`;
  const sh = { name: 'harness', content: `#!/bin/sh\n# ${head}\nexec node -e "${code.replace(/[\\"$`]/g, '\\$&')}" -- "$@"\n` };
  if (platform !== 'win32') return [sh];
  const cmd = ['@echo off', `rem ${head}`, `node -e "${code.replace(/%/g, '%%')}" -- %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n');
  return [{ name: 'harness.cmd', content: cmd }, sh];
}

/** PATH muc user tren Windows (HKCU\Environment Path, mo rong %VAR%); null khi doc khong duoc. regPath: tiem cho test. */
export function userPathDirs({ platform = process.platform, env = process.env, regPath } = {}) {
  if (platform !== 'win32') return null;
  let raw = regPath;
  if (raw === undefined) {
    const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const m = r.status === 0 && String(r.stdout).match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im);
    raw = m ? m[1].trim() : null;
  }
  if (raw == null) return null;
  const val = (n) => { const k = Object.keys(env).find((x) => x.toLowerCase() === n.toLowerCase()); return k ? env[k] : null; };
  return raw.split(';').map((s) => s.trim().replace(/%([^%]+)%/g, (all, n) => val(n) ?? all)).filter(Boolean);
}

/** Thu muc mac dinh -> {dir, why} hoac {dir:null, why}. Khong tao/sua gi tren Windows; POSIX tra ~/.local/bin (applyShim tao neu thieu). */
export function defaultShimDir({ platform = process.platform, env = process.env, home = os.homedir(), regPath } = {}) {
  const P = pp(platform);
  if (platform !== 'win32') return { dir: P.join(home, '.local', 'bin'), why: 'POSIX mac dinh ~/.local/bin' };
  const user = userPathDirs({ platform, env, regPath });
  const pool = (user || (env.PATH || env.Path || '').split(';').filter((d) => key(platform, d).startsWith(key(platform, home))))
    .filter((d) => !/[\\/]Microsoft[\\/]WindowsApps$/i.test(d.replace(/[\\/]+$/, '')) && writable(d));
  const src = user ? 'PATH user (HKCU)' : 'PATH tien trinh, trong thu muc home';
  const npm = env.APPDATA && pool.find((d) => key(platform, d) === key(platform, P.join(env.APPDATA, 'npm')));
  if (npm) return { dir: npm, why: `%APPDATA%\\npm co tren ${src}` };
  if (pool.length) return { dir: pool[0], why: `thu muc ghi duoc dau tien tren ${src}` };
  return { dir: null, why: `khong co thu muc ghi duoc tren ${src}; dung --dir <thu muc da co tren PATH>` };
}

/** Thu muc co tren PATH cua tien trinh? */
export function onPath(dir, { platform = process.platform, env = process.env } = {}) {
  const sep = platform === 'win32' ? ';' : ':';
  return String(env.PATH || env.Path || '').split(sep).filter(Boolean).some((d) => key(platform, d) === key(platform, dir));
}

/** Ke hoach ghi: {dir, files:[{file, content, action: create|update|same|foreign}], blocked}. blocked = co file la ma khong --force. */
export function planShim({ dir, platform = process.platform, cacheDir, pluginRoot, force = false }) {
  const files = renderShims({ platform, cacheDir, pluginRoot }).map(({ name, content }) => {
    const file = pp(platform).join(dir, name);
    const cur = read(file);
    const action = cur == null ? 'create' : cur === content ? 'same' : cur.includes(SHIM_MARK) ? 'update' : force ? 'update' : 'foreign';
    return { file, content, action };
  });
  return { dir, files, blocked: files.some((f) => f.action === 'foreign') };
}

/** Ghi theo ke hoach (bo qua same); chmod 755 file sh. Khong ghi gi khi blocked. */
export function applyShim(plan) {
  if (plan.blocked) return false;
  fs.mkdirSync(plan.dir, { recursive: true });
  for (const f of plan.files) {
    if (f.action === 'same') continue;
    fs.writeFileSync(f.file, f.content);
    if (!f.file.endsWith('.cmd')) try { fs.chmodSync(f.file, 0o755); } catch { /* Windows: bo qua */ }
  }
  return true;
}

/**
 * Trang thai shim tren PATH cho doctor: {state: ok|missing|stale|foreign, file?}.
 * Lay file shim chinh dau tien tren PATH, bo qua bin/ ben trong plugin (Bash tool cua Claude) va cache plugin.
 */
export function shimStatus({ platform = process.platform, env = process.env, cacheDir, pluginRoot }) {
  const P = pp(platform);
  const sep = platform === 'win32' ? ';' : ':';
  const skip = [cacheDir, pluginRoot].filter(Boolean).map((d) => key(platform, d));
  const main = shimNames(platform)[0];
  for (const d of String(env.PATH || env.Path || '').split(sep).filter(Boolean)) {
    const k = key(platform, d);
    if (skip.some((s) => k === s || k.startsWith(s + (platform === 'win32' ? '\\' : '/')))) continue;
    const file = P.join(d, main);
    const cur = read(file);
    if (cur == null) continue;
    if (!cur.includes(SHIM_MARK)) return { state: 'foreign', file };
    const plan = planShim({ dir: d, platform, cacheDir, pluginRoot });
    return { state: plan.files.every((f) => f.action === 'same') ? 'ok' : 'stale', file };
  }
  return { state: 'missing' };
}
