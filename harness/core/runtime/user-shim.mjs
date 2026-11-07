// Shim `harness` cho shell cua user (PowerShell/cmd/bash ngoai Claude): Claude Code chi them bin/ cua plugin vao PATH cua Bash tool.
// MOT cho co dinh: Windows %USERPROFILE%\.harness-kit\bin (KHONG %LOCALAPPDATA%: Claude desktop la app MSIX, ghi %LOCALAPPDATA% tu tien trinh con bi ao hoa
// vao Packages\Claude_*\LocalCache\Local nen shell that khong thay; goc %USERPROFILE% khong bi ao hoa), POSIX ~/.local/bin. Muc PATH cu %LOCALAPPDATA%\harness-kit\bin duoc thay (migrate). syncUserShim = logic duy nhat, dung boi hook SessionStart
// (build/user-shim, tu dong) va `harness install --shim` (tay): ghi shim, dam bao thu muc co tren PATH user (Windows: HKCU\Environment Path,
// giu REG_EXPAND_SZ, khong setx; POSIX: mot dong co marker trong ~/.profile | ~/.zprofile), xoa shim CUA TA o cho khac (vd %APPDATA%\npm cu).
// Shim TOOL-NEUTRAL: doc roots.json canh no ({agy|claude|local: {root, version}}, moi CLI chi ghi khoa cua minh), bo qua root da vang, chon version cao nhat (so sanh so: 0.1.10 > 0.1.9).
// File co dong SHIM_MARK = cua ta; khong co = file la, chi ghi de khi force. Moi IO tiem duoc (platform/env/home/regPath/setUserPath) de test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from './proc.mjs';

export const SHIM_MARK = 'harness-kit user shim';
const pp = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const key = (platform, p) => { const s = pp(platform).normalize(String(p)).replace(/[\\/]+$/, ''); return platform === 'win32' ? s.toLowerCase() : s; };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const pathDirs = (platform, env) => String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);

/** Ten file shim theo nen: Windows ghi ca harness.cmd (PowerShell/cmd) va harness (Git Bash), nhu npm. File dau = file chinh. */
const shimNames = (platform) => (platform === 'win32' ? ['harness.cmd', 'harness'] : ['harness']);

/** Ban cua plugin tai root (doc plugin.json cua plugin) hoac duoi cung thu muc neu la so ban; '' khi khong ro. Dung de shim chon root moi nhat. */
export function rootVersion(root) {
  try { const v = JSON.parse(read(path.join(root, '.antigravity-plugin', 'plugin.json')) || '{}').version; if (v) return String(v); } catch { /* hong */ }
  const b = path.basename(path.resolve(root));
  return /^\d/.test(b) ? b : '';
}

/** Duong roots.json nam canh shim (shim doc luc chay; moi CLI ghi khoa cua chinh no). */
export const rootsFile = (dir, platform = process.platform) => pp(platform).join(dir, 'roots.json');

const readRoots = (file) => { try { const o = JSON.parse(read(file) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };

// JS chay bang `node -e`: khong dung " % $ ` (an toan trong ca cmd lan sh). R = duong roots.json ({tool:{root,version}}):
// bo qua khoa co root da vang, chon version cao nhat (so sanh so: 0.1.10 > 0.1.9); het root -> thong bao + exit 3.
const js = (R) => [
  "const f=require('fs'),p=require('path'),c=require('child_process');",
  `const R='${R}';let r={};try{r=JSON.parse(f.readFileSync(R,'utf8'))}catch(e){}`,
  "const L=Object.keys(r).map(k=>r[k]).filter(e=>e&&e.root&&f.existsSync(p.join(e.root,'bin','harness')));",
  "if(!L.length){console.error('harness: khong tim thay plugin harness-kit (roots.json: '+R+'); chay lai phien CLI de shim tu cap nhat');process.exit(3)}",
  "L.sort((x,y)=>String(x.version||'').localeCompare(String(y.version||''),'en',{numeric:true}));",
  "const b=p.join(L.pop().root,'bin','harness');",
  "const s=c.spawnSync(process.execPath,[b,...process.argv.slice(1)],{stdio:'inherit'});process.exit(s.status==null?1:s.status)",
].join('');
const lit = (s) => String(s || '').replace(/\\/g, '/').replace(/'/g, "\\'");

/** [{name, content}] cho nen; noi dung tat dinh theo (dir): shim khong chua root, doc roots.json canh no. */
export function renderShims({ platform = process.platform, dir = '' }) {
  const code = js(lit(rootsFile(dir, platform)));
  const head = `${SHIM_MARK} (sinh boi harness-kit: hook SessionStart / harness install --shim). Go: xoa file nay.`;
  const sh = { name: 'harness', content: `#!/bin/sh\n# ${head}\nexec node -e "${code.replace(/[\\"$`]/g, '\\$&')}" -- "$@"\n` };
  if (platform !== 'win32') return [sh];
  const cmd = ['@echo off', `rem ${head}`, `node -e "${code.replace(/%/g, '%%')}" -- %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n');
  return [{ name: 'harness.cmd', content: cmd }, sh];
}


/** Thu muc co dinh cua shim. Windows: %USERPROFILE%\.harness-kit\bin (khong bi MSIX ao hoa), POSIX: ~/.local/bin. */
export function defaultShimDir({ platform = process.platform, home = os.homedir() } = {}) {
  const P = pp(platform);
  if (platform === 'win32') return P.join(home, '.harness-kit', 'bin');
  return P.join(home, '.local', 'bin');
}

/** Thu muc shim CU cua Windows (%LOCALAPPDATA%\harness-kit\bin; bi MSIX ao hoa) hoac null (POSIX). Chi de migrate/don dep. */
export function legacyShimDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform !== 'win32') return null;
  const k = Object.keys(env).find((x) => x.toLowerCase() === 'localappdata');
  return path.win32.join((k && env[k]) || path.win32.join(home, 'AppData', 'Local'), 'harness-kit', 'bin');
}

/**
 * Windows: tien trinh dang chay trong goi MSIX (Claude desktop)? -> {msix, reason}. Dau hieu: execPath duoi \WindowsApps\, hoac ton tai
 * <LocalAppData>\Packages\Claude_*\LocalCache\Local\harness-kit (noi ghi %LOCALAPPDATA% bi chuyen huong). readdir/exists tiem cho test.
 */
export function msixInfo({ platform = process.platform, env = process.env, execPath = process.execPath, home = os.homedir(), readdir = (d) => fs.readdirSync(d), exists = (f) => fs.existsSync(f) } = {}) {
  if (platform !== 'win32') return { msix: false, reason: null };
  if (/[\\/]WindowsApps[\\/]/i.test(String(execPath))) return { msix: true, reason: 'tien trinh chay duoi \\WindowsApps\\ (goi MSIX)' };
  const P = path.win32;
  const k = Object.keys(env).find((x) => x.toLowerCase() === 'localappdata');
  const local = (k && env[k]) || P.join(home, 'AppData', 'Local');
  try {
    const pk = P.join(local.replace(/[\\/]+$/, '').replace(/[\\/]Packages[\\/].*$/i, ''), 'Packages');
    for (const n of readdir(pk)) {
      const v = P.join(pk, n, 'LocalCache', 'Local', 'harness-kit');
      if (/^Claude_/i.test(n) && exists(v)) return { msix: true, reason: `co ${v} (ghi %LOCALAPPDATA% bi chuyen huong)` };
    }
  } catch { /* khong co Packages: khong phai MSIX */ }
  return { msix: false, reason: null };
}

/** Lenh de chay trong terminal THAT (ngoai Claude): ghi shim + PATH user khong qua ao hoa MSIX. */
export const realTerminalLine = (pluginRoot) => `node "${path.join(pluginRoot, 'bin', 'harness')}" install --shim`;

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
    const legacy = legacyShimDir({ platform, env, home });
    if (onPath(dir, { platform, env }) && !(legacy && onPath(legacy, { platform, env }))) return { state: 'present', where: 'PATH tien trinh' };
    const raw = readUserPath(regPath);
    if (raw == null) return { state: 'error', where, error: 'khong doc duoc PATH user; tu them thu muc vao PATH' };
    const entries = raw.split(';').map((s) => s.trim()).filter(Boolean);
    const exp = userPathDirs({ env, regPath: raw }); // cung loc rong, cung thu tu voi entries
    const isOld = (d) => key(platform, legacy) !== key(platform, dir) && key(platform, d) === key(platform, legacy);
    const hasNew = exp.some((d) => key(platform, d) === key(platform, dir));
    const hasOld = exp.some(isOld);
    if (hasNew && !hasOld) return { state: 'present', where };
    if (!apply) return { state: 'planned', where, migrate: hasOld };
    // Muc cu duoc thay tai cho bang dir (giu thu tu uu tien); muc khac giu nguyen (ke ca %VAR% chua mo rong).
    const out = [];
    let placed = hasNew;
    entries.forEach((e, i) => {
      if (!isOld(exp[i])) { out.push(e); return; }
      if (!placed) { out.push(dir); placed = true; }
    });
    if (!placed) out.push(dir);
    const err = setUserPath(out.join(';'));
    return err ? { state: 'error', where, error: err } : { state: 'added', where, migrate: hasOld };
  }
  const prof = profileFile(platform, home);
  if (onPath(dir, { platform, env })) return { state: 'present', where: 'PATH tien trinh' };
  if ((read(prof) || '').includes(PROFILE_LINE(dir))) return { state: 'present', where: prof };
  if (!apply) return { state: 'planned', where: prof };
  try { fs.appendFileSync(prof, `\n${PROFILE_LINE(dir)}\n`); return { state: 'added', where: prof }; } catch (e) { return { state: 'error', where: prof, error: e.message }; }
}

/** Ke hoach ghi: {dir, files:[{file, content, action: create|update|same|foreign}], blocked}. blocked = co file la ma khong force. */
export function planShim({ dir, platform = process.platform, force = false }) {
  const files = renderShims({ platform, dir }).map(({ name, content }) => {
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
export function strayShims(dir, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const P = pp(platform);
  const legacy = legacyShimDir({ platform, env, home });
  const dirs = [...pathDirs(platform, env), ...(platform === 'win32' && env.APPDATA ? [P.join(env.APPDATA, 'npm')] : []), ...(legacy ? [legacy] : [])];
  const seen = new Set([key(platform, dir)]);
  const out = [];
  for (const d of dirs) {
    if (seen.has(key(platform, d))) continue;
    seen.add(key(platform, d));
    for (const n of shimNames(platform)) { const f = P.join(d, n); if ((read(f) || '').includes(SHIM_MARK)) out.push(f); }
  }
  return out;
}

/** Ghi khoa `tool` vao roots.json canh shim, giu khoa khac; -> true neu file doi. pluginRoot rong -> khong ghi. */
function writeRoot(dir, tool, pluginRoot, platform) {
  if (!pluginRoot) return false;
  const file = rootsFile(dir, platform);
  const roots = readRoots(file);
  const root = path.resolve(pluginRoot);
  const next = { ...roots, [tool]: { root, version: rootVersion(root) } };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (read(file) === text) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

/**
 * Logic DUY NHAT cai/duy tri shim: ghi shim vao dir (mac dinh co dinh), dam bao PATH user, xoa shim cua ta o cho khac.
 * -> {ok, dir, tool, files, blocked, path:{state, where, error?}, removed[], rootsChanged}. apply=false: chi bao, khong ghi gi.
 * tool = khoa trong roots.json ('agy' | 'claude' | 'local' cho `harness install --shim` tay): chi ghi/cap nhat khoa cua minh, giu khoa tool khac.
 */
export function syncUserShim({ dir, apply = true, force = false, platform = process.platform, env = process.env, home = os.homedir(), regPath, setUserPath, pluginRoot, tool = 'local' }) {
  const target = dir || defaultShimDir({ platform, env, home });
  const plan = planShim({ dir: target, platform, force });
  const res = { ok: !plan.blocked, dir: target, tool, files: plan.files, blocked: plan.blocked, path: null, removed: [], rootsChanged: false };
  if (plan.blocked) return res;
  if (apply) { applyShim(plan); res.rootsChanged = writeRoot(target, tool, pluginRoot, platform); }
  res.path = ensureUserPath(target, { platform, env, home, regPath, setUserPath, apply });
  res.removed = strayShims(target, { platform, env, home });
  if (apply) for (const f of res.removed) try { fs.unlinkSync(f); } catch { /* bo qua */ }
  res.ok = res.path.state !== 'error';
  return res;
}

/** Thu muc nam duoi %LOCALAPPDATA% / %APPDATA% (Windows)? Day la goc bi MSIX ao hoa. */
export function virtualizedDir(dir, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return false;
  return ['LOCALAPPDATA', 'APPDATA'].some((n) => {
    const k = Object.keys(env).find((x) => x.toUpperCase() === n);
    return !!(k && env[k]) && `${key(platform, dir)}\\`.startsWith(`${key(platform, env[k])}\\`);
  });
}

/**
 * Trang thai cho doctor (chi doc): {state: ok|missing|stale|foreign|nopath, dir, file, risk}.
 * risk (Windows) = {why} khi thu muc shim duoi %LOCALAPPDATA%/%APPDATA% hoac tien trinh chay trong goi MSIX: shell that co the khong thay shim/PATH.
 */
export function shimStatus({ platform = process.platform, env = process.env, home = os.homedir(), regPath, pluginRoot, tool, execPath, readdir, exists }) {
  const dir = defaultShimDir({ platform, home });
  const msix = msixInfo({ platform, env, home, ...(execPath ? { execPath } : {}), ...(readdir ? { readdir } : {}), ...(exists ? { exists } : {}) });
  const risk = virtualizedDir(dir, { platform, env }) ? { why: `thu muc shim ${dir} nam duoi %LOCALAPPDATA%/%APPDATA% (bi MSIX ao hoa)` } : msix.msix ? { why: msix.reason } : null;
  const plan = planShim({ dir, platform });
  const file = plan.files[0].file;
  if (plan.files[0].action === 'create') return { state: 'missing', dir, file, risk };
  if (plan.blocked) return { state: 'foreign', dir, file, risk };
  const rootOk = !tool || !pluginRoot || readRoots(rootsFile(dir, platform))[tool]?.root === path.resolve(pluginRoot);
  if (!rootOk || plan.files.some((f) => f.action !== 'same')) return { state: 'stale', dir, file, risk };
  const p = ensureUserPath(dir, { platform, env, home, regPath, apply: false });
  return { state: p.state === 'present' ? 'ok' : 'nopath', dir, file, risk };
}
