// Hook Stop/SubagentStop: CHI CANH BAO. Ghi vao audit danh sach tien trinh con con song cua session claude.
// GIOI HAN: payload Stop/SubagentStop khong co pid cua agent => khong gan duoc pid voi tung subagent.
// Ta lay to tien claude.exe/agy gan nhat cua hook (process.ppid chain) roi liet ke moi con chau con song (tru chuoi cua hook).
// Chong bao gia: SubagentStart/SubagentStop ghi so agent dang chay theo session; con agent khac dang chay -> im (khong quet,
// vi con chau cua no khong phai mo coi). Sau do: cung chu ky im dedupeSec, chu ky khac im throttleSec (pid churn).
// Khong bao gio block stop, khong kill. Fail-open.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';

import { readJsonStdin } from '../../core/io/stdio.mjs';

/** Don *.tmp mo coi cu hon 1h trong thu muc state (toi da 50 file/lan). Tra so file da xoa. */
export function pruneTmp(dir, now = Date.now(), maxAgeMs = 3600e3, max = 50) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (n >= max) break;
      if (!/\.tmp$/.test(f)) continue;
      try { const fp = path.join(dir, f); const st = fs.statSync(fp); if (st.isFile() && now - st.mtimeMs > maxAgeMs) { fs.unlinkSync(fp); n++; } } catch {}
    }
  } catch {}
  return n;
}
const isEntry = (u) => !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(u);

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  enabled: true,
  events: ['Stop', 'SubagentStop', 'SubagentStart'], // SubagentStart: chi ghi so agent dang chay (khong quet)
  minAgeSec: 5,
  watchNames: ['bash.exe', 'sh.exe', 'python.exe', 'python3.exe', 'node.exe', 'bun.exe', 'duckdb.exe', 'ping.exe', 'powershell.exe'],
  rootNames: ['claude.exe', 'agy.exe', 'agy'],
  ignoreNames: ['conhost.exe', 'openconsole.exe'], // luon bo qua (console host), ghi de qua config
  shellNames: ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe'], // shell cua chinh phien: con truc tiep cua root, khong co con nang -> bo
  dedupeSec: 21600, // cung chu ky (root pid + tap pid) trong 6h -> khong canh bao lai; 0 = tat
  throttleSec: 900, // chu ky khac (pid churn): toi da 1 canh bao / root pid / 15 phut; 0 = tat
  liveAgentTtlSec: 7200, // subagent co SubagentStart ma chua SubagentStop: coi la con chay toi da 2h (agent bi giet khong co Stop)
  protectCmd: ['telegram', 'server.ts', 'mcp', 'native-host', 'claude-code'],
  timeoutMs: 3000,
  maxListed: 20,
  scanCacheTtlSec: 60, // cache danh sach tien trinh trong data/system/proc-orphans/scan-cache.json; 0 = tat
};
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('proc-orphans', { defaults: DEFAULTS, files, env: { HOOK_PROC_ORPHANS_ENABLED: 'enabled' } });

/** Mo ta toi da 3 tien trinh bi dem: "name#pid, ..." (+N them). */
export const describeChildren = (children, max = 3) => children.slice(0, max).map((c) => `${c.name}#${c.pid}`).join(', ') + (children.length > max ? ` (+${children.length - max})` : '');
/** Pid con song that (signal 0). EPERM = con song. */
export const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } };
/** Loc danh sach tien trinh da cache: bo con cua chinh hook (powershell lien ke cua listProcesses) va pid da chet (cache cu -> con "ma" bi dem nham). */
export const pruneCached = (procs, selfPid, alive = pidAlive) => procs.filter((p) => p.pid !== selfPid && p.ppid !== selfPid && alive(p.pid));

/** Thuan: procs [{pid,ppid,name,startMs,cmd}] -> {rootPid, children[]} (khong co root => rootPid null). */
export function findChildren(procs, selfPid, cfg, now = Date.now()) {
  const by = new Map(procs.map((p) => [p.pid, p]));
  const lc = (s) => String(s || '').toLowerCase();
  const shield = new Set();
  const ign = [...new Set([...DEFAULTS.ignoreNames, ...(cfg.ignoreNames || [])].map(lc))]; // console host luon bo, config chi them
  const shells = new Set([...DEFAULTS.shellNames, ...(cfg.shellNames || [])].map(lc));
  const kids = new Map();
  for (const p of procs) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(p);
  const heavy = (pid, d = 0) => d < 8 && (kids.get(pid) || []).some((k) => (!ign.includes(lc(k.name)) && !shells.has(lc(k.name))) || heavy(k.pid, d + 1));
  let root = null;
  for (let p = by.get(selfPid), n = 0; p && n < 64; p = by.get(p.ppid), n++) {
    shield.add(p.pid);
    if (cfg.rootNames.includes(lc(p.name))) { root = p; break; }
  }
  if (!root) return { rootPid: null, children: [] };
  const children = [];
  for (const p of procs) {
    if (shield.has(p.pid) || ign.includes(lc(p.name))) continue;
    if (!cfg.watchNames.includes(lc(p.name))) continue;
    if (shells.has(lc(p.name)) && p.ppid === root.pid && !heavy(p.pid)) continue; // shell cua phien (Bash/PowerShell tool giu song)
    let q = by.get(p.ppid), n = 0, under = false;
    for (; q && n < 64; q = by.get(q.ppid), n++) if (q.pid === root.pid) { under = true; break; }
    if (!under) continue;
    if (p.startMs != null && now - p.startMs < cfg.minAgeSec * 1000) continue;
    if (cfg.protectCmd.some((k) => lc(p.cmd).includes(k))) continue;
    children.push({ pid: p.pid, name: p.name, ageSec: p.startMs ? Math.round((now - p.startMs) / 1000) : null, cmd: String(p.cmd || '').slice(0, 120) });
  }
  return { rootPid: root.pid, children: children.slice(0, cfg.maxListed), total: children.length };
}

/**
 * Quet tien trinh + findChildren, co cache danh sach tien trinh TTL cfg.scanCacheTtlSec (mac dinh 60s).
 * Quyet dinh khong doi: cache chi tiep cho findChildren (tien trinh hien tai luon duoc dat lai theo pid that); cache khong tim thay root -> quet lai.
 * Cache la trang thai rieng cua module, KHONG phai vet audit/gate: ghi ke ca khi ctx.write === false (dispatcher), tru khi ctx.cache === false (test co lap: khong doc/ghi).
 * ctx.env.HUB_DATA_DIR doi thu muc data (test).
 */
export async function scanChildren(cfg, ctx = {}) {
  const ttl = Number.isFinite(cfg.scanCacheTtlSec) ? cfg.scanCacheTtlSec : 60;
  const { dataPathFor, dataPathsFor } = await import('../../core/io/storage.mjs').then(async (s) => ({ dataPathFor: s.dataPathFor, dataPathsFor: (await import('../../core/registry/data-registry.mjs')).dataPathsFor }));
  const eo = ctx.env ? { env: ctx.env } : {};
  const file = dataPathFor('proc-orphans', 'scan-cache.json', eo);
  const self = { pid: process.pid, ppid: process.ppid, name: path.basename(process.execPath), startMs: Date.now(), cmd: '' };
  if (ttl > 0 && ctx.cache !== false) {
    try {
      const c = JSON.parse(fs.readFileSync(dataPathsFor('proc-orphans', 'scan-cache.json', eo)[0] || file, 'utf8'));
      if (c && Array.isArray(c.procs) && Date.now() - c.ts < ttl * 1000 && c.ts <= Date.now() + 1000) {
        const r = findChildren([...pruneCached(c.procs, self.pid), self], self.pid, cfg);
        if (r.rootPid != null) return r;
      }
    } catch {}
  }
  const { listProcesses } = await import('../../core/runtime/proc-list.mjs');
  const { procs: all } = listProcesses({ timeoutMs: cfg.timeoutMs });
  const procs = all.filter((p) => p.ppid !== process.pid); // powershell dung de liet ke la con cua hook: khong phai tien trinh mo coi
  if (ttl > 0 && ctx.cache !== false) {
    let tmp = null;
    try {
      let okW = true; try { okW = (await import('../../core/io/storage.mjs')).guardWrite(file).ok; } catch {}
      if (!okW) throw new Error('data-enforce');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      pruneTmp(path.dirname(file));
      tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), procs: procs.map((p) => ({ ...p, cmd: String(p.cmd || '').slice(0, 300) })) }));
      fs.renameSync(tmp, file);
    } catch { if (tmp) try { fs.unlinkSync(tmp); } catch {} }
  }
  return findChildren(procs, process.pid, cfg);
}

/**
 * Hop dong module (HOOK_MODULE): handle(event, input, ctx) -> {record?, records?}. Chi canh bao: KHONG co decision (none).
 * Audit type=proc (ProcOrphans) khi co con chau song: tra qua records [{sink:'audit', data, opts}], chi tu ghi khi ctx.write !== false.
 * Khong ghi stdout/exit. Loi/stdin rac -> {} (fail-open). ctx (tuy chon): {cfg, write, env}; thieu cfg thi nap mac dinh.
 */
/** Chu ky canh bao: root pid + tap pid da sort. */
export const signatureOf = (rootPid, children) => JSON.stringify([rootPid, children.map((c) => c.pid).sort((a, b) => a - b)]);

/**
 * Chong lap: true = da canh bao gan day cho root pid nay: cung chu ky trong dedupeSec, chu ky khac trong throttleSec.
 * Cap nhat state (atomic, khoa) tru khi ctx.cache===false. ctx.now (test). Fail-open: loi -> false.
 */
export async function seenRecently(sig, rootPid, cfg, ctx = {}) {
  const thr = Number.isFinite(cfg.throttleSec) ? Math.max(0, cfg.throttleSec) : 900;
  const ttl = Math.max(thr, Number.isFinite(cfg.dedupeSec) ? cfg.dedupeSec : 21600);
  if (ttl <= 0) return false;
  try {
    const { dataPathFor } = await import('../../core/io/storage.mjs');
    const { withLock } = await import('../../core/runtime/lockfile.mjs');
    const file = dataPathFor('proc-orphans', 'warned.json', ctx.env ? { env: ctx.env } : {});
    let st = {};
    try { st = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    const now = ctx.now ?? Date.now();
    const prev = st[String(rootPid)];
    if (prev && now - prev.ts < (prev.sig === sig ? ttl : thr) * 1000 && prev.ts <= now + 1000) return true;
    if (ctx.cache === false) return false; // trang thai module (nhu scan-cache): ghi ca khi write:false (dispatcher)
    fs.mkdirSync(path.dirname(file), { recursive: true });
    withLock(file, () => {
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
      for (const k of Object.keys(cur)) if (!cur[k] || now - cur[k].ts > ttl * 1000) delete cur[k];
      cur[String(rootPid)] = { sig, ts: now };
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cur));
      fs.renameSync(tmp, file);
    });
    return false;
  } catch { return false; }
}

/**
 * So subagent dang chay theo session (data proc-orphans/live-agents.json: {session_id: {agent_id: ts}}).
 * SubagentStart them agent_id, SubagentStop xoa (khoa, atomic; ghi ca khi write:false, tru ctx.cache===false). Muc qua liveAgentTtlSec bi bo.
 * Tra so agent KHAC agent hien tai con chay. ctx.now (test). Fail-open: loi -> 0 (canh bao nhu cu).
 */
export async function liveAgents(event, input, cfg, ctx = {}) {
  const sid = String(input.session_id || ''), aid = String(input.agent_id || '');
  if (!sid) return 0;
  try {
    const ttl = (Number.isFinite(cfg.liveAgentTtlSec) ? cfg.liveAgentTtlSec : 7200) * 1000;
    const now = ctx.now ?? Date.now();
    const { dataPathFor } = await import('../../core/io/storage.mjs');
    const file = dataPathFor('proc-orphans', 'live-agents.json', ctx.env ? { env: ctx.env } : {});
    const read = () => {
      let st = {}; try { st = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
      for (const s of Object.keys(st)) {
        const a = st[s] && typeof st[s] === 'object' ? st[s] : {};
        for (const k of Object.keys(a)) if (!(now - a[k] < ttl && a[k] <= now + 1000)) delete a[k];
        if (Object.keys(a).length) st[s] = a; else delete st[s];
      }
      return st;
    };
    let st = read();
    if (aid && (event === 'SubagentStart' || event === 'SubagentStop') && ctx.cache !== false) {
      const { withLock } = await import('../../core/runtime/lockfile.mjs');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const r = withLock(file, () => {
        const cur = read();
        if (event === 'SubagentStart') (cur[sid] ||= {})[aid] = now;
        else if (cur[sid]) { delete cur[sid][aid]; if (!Object.keys(cur[sid]).length) delete cur[sid]; }
        const tmp = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(cur));
        fs.renameSync(tmp, file);
        return cur;
      });
      if (r.ok) st = r.value;
    }
    return Object.keys(st[sid] || {}).filter((k) => k !== aid).length;
  } catch { return 0; }
}

export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg ?? load().config;
    if (!cfg.enabled || !input || typeof input !== 'object' || !cfg.events.includes(event)) return {};
    const live = await liveAgents(event, input, cfg, ctx);
    if (event === 'SubagentStart') return {}; // chi ghi so, khong quet
    if (ctx.sweep !== false && ctx.write !== false) await sweepProcLedger(); // write:false = khong ghi gi (sweep ghi so PID + stamp)
    if (live > 0) return {}; // con subagent khac dang chay: con chau cua no khong phai mo coi -> im, khong quet
    const r = typeof ctx.scan === 'function' ? await ctx.scan() : await scanChildren(cfg, ctx); // ctx.scan: seam cho test
    if (!r.children.length) return {};
    // khoa chong lap theo nguoi nhan (main / tung subagent): canh bao cho subagent khong che canh bao cho main
    if (await seenRecently(signatureOf(r.rootPid, r.children), `${r.rootPid}:${input.agent_id || 'main'}`, cfg, ctx)) return {};
    const ts = new Date().toISOString();
    const sid = `claude-${String(input.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;
    const env = {
      ts, sid, type: 'proc', event: 'ProcOrphans', session_id: input.session_id || null, agent_id: input.agent_id || null,
      origin: 'hook', summary: `${event}: ${r.total} tien trinh con con song (root pid ${r.rootPid}): ${describeChildren(r.children)}`,
      data: { trigger: event, note: 'khong gan duoc pid voi agent; liet ke moi con chau cua session', ...r },
    };
    const wopts = { max_file_bytes: 5242880 };
    if (ctx.write !== false) {
      const { writeEnvelope, auditRoot } = await import('../../core/audit/audit-write.mjs');
      writeEnvelope(env, wopts, auditRoot());
    }
    return { record: { rootPid: r.rootPid, total: r.total }, additionalContext: `proc-orphans: ${r.total} tien trinh con con song (root pid ${r.rootPid}: ${describeChildren(r.children)}); dung truoc khi bao cao cuoi`, records: [{ sink: 'audit', data: env, opts: wopts }] };
  } catch { return {}; } // fail-open
}

const META = { id: 'proc-orphans', events: DEFAULTS.events, timeoutMs: DEFAULTS.timeoutMs, onError: 'open' };
/** Alias cu (test). */
export const MODULE = Object.freeze({ ...META, handle });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). ctx.write === false: khong ghi audit (cache quet + state warned/live-agents van ghi; ctx.cache === false tat ghi). */
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });

async function main() {
  try {
    const inp = readJsonStdin();
    const cfg = load().config;
    await handle(String(inp && inp.hook_event_name || ''), inp, { cfg, write: true });
  } catch {} // fail-open
}

if (isEntry(import.meta.url)) { await main(); process.exit(0); }

/** Don so PID tac vu nen (proc.mjs): PID chet -> xoa muc; qua han + con song + dung lenh -> kill. Fail-open. */
export async function sweepProcLedger() {
  try { return await (await import('../../core/runtime/proc.mjs')).sweepBackground(); } catch { return null; }
}
