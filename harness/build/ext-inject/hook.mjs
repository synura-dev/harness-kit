// Hook ext-inject: chen ngu canh tong quat tu extension. Manifest extension khai
//   "inject": { "events": ["SessionStart","SubagentStart"], "args": ["show","--cwd","{cwd}","--inject"] }
// SessionStart: voi moi ext da dang ky VA hash ok (drift/chua duyet/thieu => bo qua) co event khop, chay SONG SONG (spawn bat dong bo, kill khi het timeout)
//   `harness <domain> <args>` (bin/harness cua plugin, process.execPath, khong shell; domain = domain dau tien trong manifest ext, khong trung domain core;
//   {cwd} chi duoc thay vao args), cat 12 dong/1.5KB, ghi cache theo session (data/system/ext-inject/, khoa session_id + workspace) va chen vao additionalContext.
// SubagentStart: doc cache cua session (khong hash, khong git); ext co arg {agent_type} (chi SubagentStart) duoc spawn theo vai tro agent_type
//   (khop AGENT_RE) o day, cache theo job+agent_type (TTL 30 phut), tran rieng kep 30 dong/3KB, timeout roleTimeoutMs trong budget 2500ms.
// Workspace = CLAUDE_PROJECT_DIR (du phong cwd su kien). Khong hard-code ten ext. Fail-open. Tat: hook.config.local.json {"enabled": false} / HOOK_EXT_INJECT_ENABLED=0.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { REPO_DIR, readJson, isObj, dataDir } from '../../core/io/paths.mjs';
import { listRegistered, hashTree, norm } from '../../core/ext/ext-trust.mjs';
import { manifestDomains } from '../../core/ext/manifest-domains.mjs';
import { loadHarnessRegistry } from '../../core/registry/plugin-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVENTS = ['SessionStart', 'SubagentStart'];
const CACHE_TTL_MS = 24 * 3600 * 1000;

export const DEFAULTS = { enabled: true, events: EVENTS, timeoutMs: 2000, totalMs: 3000, gitTimeoutMs: 1000, maxLines: 12, maxBytes: 1536, roleTimeoutMs: 1500, capLines: 30, capBytes: 3072 };
export const AGENT_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const posInt = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined);
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('ext-inject', { defaults: DEFAULTS, files, env: { HOOK_EXT_INJECT_ENABLED: 'enabled' } });

/** Thuan: cat text theo maxLines roi maxBytes (UTF-8). */
export function clip(text, maxLines, maxBytes) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  t = t.split('\n').slice(0, maxLines).join('\n');
  const buf = Buffer.from(t, 'utf8');
  return buf.length > maxBytes ? buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '') : t;
}

/** Thuan: khai bao inject hop le => {events, args, maxLines?, maxBytes?} | null (maxLines/maxBytes: so duong, kep capLines/capBytes). */
export function parseInject(m) {
  const i = m && m.inject;
  if (!isObj(i) || !Array.isArray(i.events) || !Array.isArray(i.args)) return null;
  if (!i.args.every((a) => typeof a === 'string')) return null;
  const ml = posInt(i.maxLines), mb = posInt(i.maxBytes);
  return { events: i.events.filter((e) => typeof e === 'string'), args: i.args,
    ...(ml && { maxLines: Math.min(ml, DEFAULTS.capLines) }), ...(mb && { maxBytes: Math.min(mb, DEFAULTS.capBytes) }) };
}

/** Domain core (loai tru khoi routing ext). Loi => null (khong biet => bo qua moi inject, fail-closed). */
export function coreDomains(repoDir = REPO_DIR) {
  try {
    const reg = loadHarnessRegistry({ harnessDir: path.join(repoDir, 'harness') });
    return new Set(Object.keys(reg.domains).filter((d) => !(reg.ext && reg.ext[d])));
  } catch { return null; }
}

/** Giet tien trinh + chau chat. win32: kill() chi giet tien trinh goc (chau mo coi) nen dung `taskkill /T /F /PID` (khong shell, fail-open); noi khac kill SIGKILL. */
export function killTree(child) {
  try {
    if (process.platform === 'win32' && child && child.pid) {
      const t = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
      t.on('error', () => { try { child.kill('SIGKILL'); } catch { /* da chet */ } });
      const g = setTimeout(() => { try { t.kill(); child.kill('SIGKILL'); } catch { /* bo qua */ } }, 2000);
      t.on('close', () => clearTimeout(g));
      return;
    }
    child.kill('SIGKILL');
  } catch { /* da chet */ }
}

/** Chay that, bat dong bo: harness <domain> <args> khong shell; het timeout => kill. -> Promise<stdout | null> (null = loi/timeout/exit!=0; '' = chay xong khong co gi). Khong reject. */
export function defaultRun(domain, args, { cwd, timeoutMs, maxBytes, env, bin }) {
  return new Promise((resolve) => {
    let out = '', done = false, child, timer;
    const cap = Math.max(maxBytes * 8, 65536);
    const fin = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const FAIL = null;
    try {
      child = spawn(process.execPath, [bin || path.join(REPO_DIR, 'bin', 'harness'), domain, ...args], { cwd, env: { ...(env || process.env), CLAUDE_PROJECT_DIR: cwd }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return fin(FAIL); }
    timer = setTimeout(() => { killTree(child); fin(FAIL); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < cap) out += d; });
    child.on('error', () => fin(FAIL));
    child.on('close', (code) => fin(code === 0 ? out : FAIL));
  });
}

const cacheFile = (dir, sid, ws) => path.join(dir, `${crypto.createHash('sha256').update(`${sid}\0${norm(ws)}`).digest('hex').slice(0, 24)}.json`);
function readCache(dir, sid, ws) {
  const j = readJson(cacheFile(dir, sid, ws));
  const ok = j && j.sid === sid && typeof j.text === 'string';
  return { text: ok ? j.text : '', roleJobs: ok && Array.isArray(j.roleJobs) ? j.roleJobs : [] };
}
function writeCache(dir, sid, ws, text, roleJobs = []) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) { // don cache cu (>24h)
      try { const p = path.join(dir, f); if (now - fs.statSync(p).mtimeMs > CACHE_TTL_MS) fs.rmSync(p, { force: true }); } catch { /* bo qua */ }
    }
    fs.writeFileSync(cacheFile(dir, sid, ws), JSON.stringify({ sid, ws, text, roleJobs }));
  } catch { /* cache la tien ich, khong lam hong hook */ }
}

const OUT_TTL_MS = 30 * 60 * 1000;
const outFile = (dir, key) => path.join(dir, `out-${key}.json`);
function readOutCache(dir, key, now, ttl) {
  const j = readJson(outFile(dir, key));
  return j && typeof j.text === 'string' && now - j.at < ttl ? j.text : null;
}
function writeOutCache(dir, key, text, now) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(outFile(dir, key), JSON.stringify({ at: now, text })); } catch { /* bo qua */ }
}

/**
 * Hop dong HOOK_MODULE: handle(event, input, ctx) -> {} | {additionalContext}. Khong decision. Fail-open.
 * ctx (test): {cfg, env, list(workspace, opts), hashOf(root), readManifest(root), core(), run(domain, args, opts), cacheDir}.
 */
export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg ?? load().config;
    if (!cfg.enabled || !EVENTS.includes(event)) return {};
    const env = ctx.env || process.env;
    const inp = isObj(input) ? input : {};
    const evCwd = path.resolve(typeof inp.cwd === 'string' && inp.cwd ? inp.cwd : process.cwd());
    const ws = path.resolve(typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.trim() ? env.CLAUDE_PROJECT_DIR.trim() : evCwd);
    const sid = typeof inp.session_id === 'string' ? inp.session_id : '';
    const cdir = ctx.cacheDir || dataDir('system/ext-inject', { env });

    if (event === 'SubagentStart') { // doc cache; chi spawn cho role job (ext {agent_type})
      const c = sid ? readCache(cdir, sid, ws) : { text: '', roleJobs: [] };
      const at = typeof inp.agent_type === 'string' && AGENT_RE.test(inp.agent_type) ? inp.agent_type : '';
      const texts = [c.text];
      if (at) {
        const now = ctx.now ?? Date.now();
        const left = () => (Number.isFinite(ctx.deadline) ? ctx.deadline - Date.now() - 300 : Infinity); // job tuan tu: tinh lai truoc moi job
        const run = ctx.run || defaultRun;
        for (const j of c.roleJobs) {
          try {
            const args = j.args.map((a) => a.split('{agent_type}').join(at));
            const key = crypto.createHash('sha256').update([norm(ws), j.key, j.domain, ...j.args, at].join('\0')).digest('hex').slice(0, 32);
            let t = readOutCache(cdir, key, now, cfg.cacheTtlMs ?? OUT_TTL_MS);
            if (t === null) {
              const timeoutMs = Math.min(cfg.roleTimeoutMs, left()); if (timeoutMs < 100) break; const o = await run(j.domain, args, { cwd: ws, timeoutMs, maxBytes: j.maxBytes, env });
              if (typeof o !== 'string') continue;
              t = clip(o, j.maxLines, j.maxBytes);
              writeOutCache(cdir, key, t, now);
            }
            texts.push(t);
          } catch { /* fail-open: bo vai tro loi */ }
        }
      }
      const text = texts.filter(Boolean).join('\n\n');
      return text ? { additionalContext: text } : {};
    }

    // SessionStart. Dang ky doc MOT lan (1 lan git ngan); hash chi tinh cho ext co inject khop event.
    const list = ctx.list ? ctx.list(ws, { gitTimeoutMs: cfg.gitTimeoutMs }) : listRegistered({ workspace: ws, gitTimeoutMs: cfg.gitTimeoutMs });
    const readManifest = ctx.readManifest || ((root) => readJson(path.join(root, 'manifest.json')));
    const hashOf = ctx.hashOf || ((root) => { const h = hashTree(root); return h.truncated ? null : h.hash; });
    const run = ctx.run || defaultRun;
    let core; // tinh lazy, chi khi co ext can chay
    const jobs = [];
    const roleJobs = [];
    const parts = [];
    for (const e of list) {
      try {
        const m = readManifest(e.root);
        const inj = parseInject(m);
        if (!inj) continue;
        const hasAt = inj.args.some((a) => a.includes('{agent_type}')), isRole = hasAt && inj.events.includes('SubagentStart'); // spawn theo vai tro o SubagentStart, khong chay o SessionStart
        if (hasAt ? !isRole : !inj.events.includes(event)) continue;
        if (hashOf(e.root) !== e.hash) continue; // drift/chua duyet/thieu: bo qua
        parts.push(e.root, e.hash, JSON.stringify(inj));
        core = core === undefined ? (ctx.core ? ctx.core() : coreDomains()) : core;
        if (!core) continue;
        const domain = manifestDomains(m).find((d) => !core.has(d));
        if (!domain) continue; // khong co domain rieng (trung core): khong dinh tuyen
        const args = inj.args.map((a) => a.split('{cwd}').join(evCwd));
        const maxLines = inj.maxLines ?? cfg.maxLines, maxBytes = inj.maxBytes ?? cfg.maxBytes;
        if (isRole) { roleJobs.push({ domain, args, maxLines, maxBytes, key: e.hash }); continue; }
        jobs.push(() => Promise.resolve(run(domain, args, { cwd: ws, timeoutMs: cfg.timeoutMs, maxBytes, env })).then((o) => (typeof o === 'string' ? clip(o, maxLines, maxBytes) : null), () => null));
      } catch { /* mot ext loi khong anh huong ext khac */ }
    }
    // Cache theo hash ext da dang ky + manifest inject (+ workspace, cwd su kien). Hash doi => lam moi. TTL ngan de output dong khong cu qua lau.
    const ckey = jobs.length ? crypto.createHash('sha256').update([norm(ws), evCwd, ...parts].join('\0')).digest('hex').slice(0, 32) : '';
    const hit = ckey ? readOutCache(cdir, ckey, ctx.now ?? Date.now(), cfg.cacheTtlMs ?? OUT_TTL_MS) : null;
    if (hit !== null) { if (sid) writeCache(cdir, sid, ws, hit, roleJobs); return hit ? { additionalContext: hit } : {}; }
    let total;
    // tran tong khong vuot phan con lai cua dispatcher (ctx.deadline) tru bien 300ms de con ghi cache/tra ket qua
    const totalMs = Number.isFinite(ctx.deadline) ? Math.max(100, Math.min(cfg.totalMs, ctx.deadline - Date.now() - 300)) : cfg.totalMs;
    const deadline = new Promise((r) => { total = setTimeout(() => r(null), totalMs); });
    const outs = await Promise.race([Promise.all(jobs.map((j) => j())), deadline]);
    clearTimeout(total);
    const text = (outs || []).filter(Boolean).join('\n\n');
    const complete = !!outs && outs.every((o) => o !== null); // chi cache khi MOI ext thanh cong; loi/timeout -> khong cache (lan sau thu lai)
    if (sid && complete) writeCache(cdir, sid, ws, text, roleJobs);
    else if (sid && roleJobs.length) writeCache(cdir, sid, ws, '', roleJobs); // ext thuong loi: van giu role job (khong luu text do)
    if (ckey && complete) writeOutCache(cdir, ckey, text, ctx.now ?? Date.now());
    return text ? { additionalContext: text } : {};
  } catch { return {}; }
}

// SessionStart: dispatcher budget 5000, ext-inject xep CUOI (sau cac module re), totalMs 3000 < timeoutMs 3500 < phan budget con lai; SubagentStart chi doc cache, budget 2500 < timeout 3s.
const META = { id: 'ext-inject', events: DEFAULTS.events, timeoutMs: 3500, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
