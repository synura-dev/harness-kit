// Shim `harness` cho shell cua user (PowerShell/cmd/bash ngoai Claude): Claude Code chi them bin/ cua plugin vao PATH cua Bash tool.
// MOT cho co dinh: Windows %LOCALAPPDATA%\harness-kit\bin, POSIX ~/.local/bin. syncUserShim = logic duy nhat, dung boi hook SessionStart
// (build/user-shim, tu dong) va `harness install --shim` (tay): ghi shim, dam bao thu muc co tren PATH user (Windows: HKCU\Environment Path,
// giu REG_EXPAND_SZ, khong setx; POSIX: mot dong co marker trong ~/.profile | ~/.zprofile), xoa shim CUA TA o cho khac (vd %APPDATA%\npm cu).
// Shim chon ban harness-kit moi nhat trong cache plugin luc chay (so sanh so: 0.1.10 > 0.1.9) nen nang cap plugin khong can cai lai.
// File co dong SHIM_MARK = cua ta; khong co = file la, chi ghi de khi force. Moi IO tiem duoc (platform/env/home/regPath/setUserPath) de test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SHIM_MARK = 'harness-kit user shim';
const pp = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const key = (platform, p) => { const s = pp(platform).normalize(String(p)).replace(/[\\/]+$/, ''); return platform === 'win32' ? s.toLowerCase() : s; };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const pathDirs = (platform, env) => String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);

/** Ten file shim theo nen: Windows ghi ca harness.cmd (PowerShell/cmd) va harness (Git Bash), nhu npm. File dau = file chinh. */
const shimNames = (platform) => (platform === 'win32' ? ['harness.cmd', 'harness'] : ['harness']);

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
  const head = `${SHIM_MARK} (sinh boi harness-kit: hook SessionStart / harness install --shim). Go: xoa file nay.`;
  const sh = { name: 'harness', content: `#!/bin/sh\n# ${head}\nexec node -e "${code.replace(/[\\"$`]/g, '\\$&')}" -- "$@"\n` };
  if (platform !== 'win32') return [sh];
  const cmd = ['@echo off', `rem ${head}`, `node -e "${code.replace(/%/g, '%%')}" -- %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n');
  return [{ name: 'harness.cmd', content: cmd }, sh];
}

/** Thu muc co dinh cua shim. */
export function defaultShimDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const P = pp(platform);
  if (platform === 'win32') return P.join(env.LOCALAPPDATA || P.join(home, 'AppData', 'Local'), 'harness-kit', 'bin');
  return P.join(home, '.local', 'bin');
}

/** Gia tri tho PATH user tren Windows (HKCU\Environment Path, chua mo rong) hoac null khi doc khong duoc. regPath: tiem cho test. */
function readUserPath(regPath) {
  if (regPath !== undefined) return regPath;
  const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const m = r.status === 0 && String(r.stdout).match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im);
  return m ? m[1].trim() : null;
}

/** PATH user tren Windows da mo rong %VAR% (khong phan biet hoa thuong); null khi doc khong duoc. */
export function userPathDirs({ env = process.env, regPath } = {}) {
  const raw = readUserPath(regPath);
  if (raw == null) return null;
  const val = (n) => { const k = Object.keys(env).find((x) => x.toLowerCase() === n.toLowerCase()); return k ? env[k] : null; };
  return raw.split(';').map((s) => s.trim().replace(/%([^%]+)%/g, (all, n) => val(n) ?? all)).filter(Boolean);
}

/** Thu muc co tren PATH cua tien trinh? */
export function onPath(dir, { platform = process.platform, env = process.env } = {}) {
  return pathDirs(platform, env).some((d) => key(platform, d) === key(platform, dir));
}

const PROFILE_LINE = (dir) => `export PATH="${dir}:$PATH" # ${SHIM_MARK}`;
const profileFile = (platform, home) => pp(platform).join(home, platform === 'darwin' ? '.zprofile' : '.profile');

/** Ghi PATH user Windows: reg add REG_EXPAND_SZ (giu %VAR%) roi phat WM_SETTINGCHANGE (xoa bien rong qua .NET) de shell moi thay. */
function setWinUserPath(value) {
  const r = spawnSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) return `reg add loi: ${String(r.stderr || r.error?.message || r.status).trim().slice(0, 200)}`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::SetEnvironmentVariable('HARNESS_KIT_PATH_REFRESH',$null,'User')"], { timeout: 10000, windowsHide: true });
  return null;
}

/**
 * Dam bao dir co tren PATH user -> {state: present|added|planned|error, where, error?}. Khong xoa/doi muc PATH cu, chi noi them dir vao cuoi.
 * apply=false chi bao. setUserPath(value) -> loi|null: tiem cho test (Windows); POSIX ghi profile trong home (test dung home tam).
 */
export function ensureUserPath(dir, { platform = process.platform, env = process.env, home = os.homedir(), regPath, setUserPath = setWinUserPath, apply = true } = {}) {
  if (platform === 'win32') {
    const where = 'HKCU\\Environment Path';
    if (onPath(dir, { platform, env })) return { state: 'present', where: 'PATH tien trinh' };
    const raw = readUserPath(regPath);
    if (raw == null) return { state: 'error', where, error: 'khong doc duoc PATH user; tu them thu muc vao PATH' };
    if (userPathDirs({ env, regPath: raw }).some((d) => key(platform, d) === key(platform, dir))) return { state: 'present', where };
    if (!apply) return { state: 'planned', where };
    const err = setUserPath(raw ? `${raw.replace(/;+$/, '')};${dir}` : dir);
    return err ? { state: 'error', where, error: err } : { state: 'added', where };
  }
  const prof = profileFile(platform, home);
  if (onPath(dir, { platform, env })) return { state: 'present', where: 'PATH tien trinh' };
  if ((read(prof) || '').includes(PROFILE_LINE(dir))) return { state: 'present', where: prof };
  if (!apply) return { state: 'planned', where: prof };
  try { fs.appendFileSync(prof, `\n${PROFILE_LINE(dir)}\n`); return { state: 'added', where: prof }; } catch (e) { return { state: 'error', where: prof, error: e.message }; }
}

/** Ke hoach ghi: {dir, files:[{file, content, action: create|update|same|foreign}], blocked}. blocked = co file la ma khong force. */
export function planShim({ dir, platform = process.platform, cacheDir, pluginRoot, force = false }) {
  const files = renderShims({ platform, cacheDir, pluginRoot }).map(({ name, content }) => {
    const file = pp(platform).join(dir, name);
    const cur = read(file);
    const action = cur == null ? 'create' : cur === content ? 'same' : cur.includes(SHIM_MARK) || force ? 'update' : 'foreign';
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

/** Shim CUA TA (co SHIM_MARK) o thu muc khac dir: tren PATH tien trinh + %APPDATA%\npm (cho cu). */
export function strayShims(dir, { platform = process.platform, env = process.env } = {}) {
  const P = pp(platform);
  const dirs = [...pathDirs(platform, env), ...(platform === 'win32' && env.APPDATA ? [P.join(env.APPDATA, 'npm')] : [])];
  const seen = new Set([key(platform, dir)]);
  const out = [];
  for (const d of dirs) {
    if (seen.has(key(platform, d))) continue;
    seen.add(key(platform, d));
    for (const n of shimNames(platform)) { const f = P.join(d, n); if ((read(f) || '').includes(SHIM_MARK)) out.push(f); }
  }
  return out;
}

/**
 * Logic DUY NHAT cai/duy tri shim: ghi shim vao dir (mac dinh co dinh), dam bao PATH user, xoa shim cua ta o cho khac.
 * -> {ok, dir, cacheDir, files, blocked, path:{state, where, error?}, removed[]}. apply=false: chi bao, khong ghi gi.
 */
export function syncUserShim({ dir, apply = true, force = false, platform = process.platform, env = process.env, home = os.homedir(), regPath, setUserPath, pluginRoot }) {
  const target = dir || defaultShimDir({ platform, env, home });
  const cacheDir = pluginCacheDir(pluginRoot, { env, home });
  const plan = planShim({ dir: target, platform, cacheDir, pluginRoot, force });
  const res = { ok: !plan.blocked, dir: target, cacheDir, files: plan.files, blocked: plan.blocked, path: null, removed: [] };
  if (plan.blocked) return res;
  if (apply) applyShim(plan);
  res.path = ensureUserPath(target, { platform, env, home, regPath, setUserPath, apply });
  res.removed = strayShims(target, { platform, env });
  if (apply) for (const f of res.removed) try { fs.unlinkSync(f); } catch { /* bo qua */ }
  res.ok = res.path.state !== 'error';
  return res;
}

/** Trang thai cho doctor (chi doc): {state: ok|missing|stale|foreign|nopath, dir, file?}. */
export function shimStatus({ platform = process.platform, env = process.env, home = os.homedir(), regPath, cacheDir, pluginRoot }) {
  const dir = defaultShimDir({ platform, env, home });
  const plan = planShim({ dir, platform, cacheDir, pluginRoot });
  const file = plan.files[0].file;
  if (plan.files[0].action === 'create') return { state: 'missing', dir, file };
  if (plan.blocked) return { state: 'foreign', dir, file };
  if (plan.files.some((f) => f.action !== 'same')) return { state: 'stale', dir, file };
  const p = ensureUserPath(dir, { platform, env, home, regPath, apply: false });
  return { state: p.state === 'present' ? 'ok' : 'nopath', dir, file };
}
