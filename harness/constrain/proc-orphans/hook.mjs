// Hook Stop/SubagentStop: CHI CANH BAO. Ghi vao audit danh sach tien trinh con con song cua session claude.
// GIOI HAN: payload Stop/SubagentStop khong co pid cua agent => khong gan duoc pid voi tung subagent.
// Ta lay to tien claude.exe/agy gan nhat cua hook (process.ppid chain) roi liet ke moi con chau con song (tru chuoi cua hook).
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
  events: ['Stop', 'SubagentStop'],
  minAgeSec: 5,
  watchNames: ['bash.exe', 'sh.exe', 'python.exe', 'python3.exe', 'node.exe', 'bun.exe', 'duckdb.exe', 'ping.exe', 'powershell.exe'],
  rootNames: ['claude.exe', 'agy.exe', 'agy'],
  ignoreNames: ['conhost.exe', 'openconsole.exe'], // luon bo qua (console host), ghi de qua config
  dedupeSec: 21600, // cung chu ky (root pid + tap pid) trong 6h -> khong canh bao lai; 0 = tat
  protectCmd: ['telegram', 'server.ts', 'mcp', 'native-host', 'claude-code'],
  timeoutMs: 3000,
  maxListed: 20,
  scanCacheTtlSec: 60, // cache danh sach tien trinh trong data/system/proc-orphans/scan-cache.json; 0 = tat
};
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('proc-orphans', { defaults: DEFAULTS, files, env: { HOOK_PROC_ORPHANS_ENABLED: 'enabled' } });

/** Thuan: procs [{pid,ppid,name,startMs,cmd}] -> {rootPid, children[]} (khong co root => rootPid null). */
export function findChildren(procs, selfPid, cfg, now = Date.now()) {
  const by = new Map(procs.map((p) => [p.pid, p]));
  const lc = (s) => String(s || '').toLowerCase();
  const shield = new Set();
  const ign = (cfg.ignoreNames || DEFAULTS.ignoreNames).map(lc);
  let root = null;
  for (let p = by.get(selfPid), n = 0; p && n < 64; p = by.get(p.ppid), n++) {
    shield.add(p.pid);
    if (cfg.rootNames.includes(lc(p.name))) { root = p; break; }
  }
  if (!root) return { rootPid: null, children: [] };
  const children = [];
  for (const p of procs) {
    if (shield.has(p.pid) || ign.includes(lc(p.name)) || !cfg.watchNames.includes(lc(p.name))) continue;
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
        const r = findChildren([...c.procs.filter((p) => p.pid !== self.pid), self], self.pid, cfg);
        if (r.rootPid != null) return r;
      }
    } catch {}
  }
  const { listProcesses } = await import('../../core/runtime/proc-list.mjs');
  const { procs } = listProcesses({ timeoutMs: cfg.timeoutMs });
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

/** Chong lap: true = chu ky nay da canh bao trong ttl giay. Cap nhat state (atomic, khoa) tru khi write===false. Fail-open: loi -> false. */
export async function seenRecently(sig, rootPid, cfg, ctx = {}) {
  const ttl = Number.isFinite(cfg.dedupeSec) ? cfg.dedupeSec : 21600;
  if (ttl <= 0) return false;
  try {
    const { dataPathFor } = await import('../../core/io/storage.mjs');
    const { withLock } = await import('../../core/runtime/lockfile.mjs');
    const file = dataPathFor('proc-orphans', 'warned.json', ctx.env ? { env: ctx.env } : {});
    let st = {};
    try { st = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    const now = Date.now();
    const prev = st[String(rootPid)];
    if (prev && prev.sig === sig && now - prev.ts < ttl * 1000 && prev.ts <= now + 1000) return true;
    if (ctx.write === false) return false;
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

export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg ?? load().config;
    if (!cfg.enabled || !input || typeof input !== 'object' || !cfg.events.includes(event)) return {};
    if (ctx.sweep !== false && ctx.write !== false) await sweepProcLedger(); // write:false = khong ghi gi (sweep ghi so PID + stamp)
    const r = await scanChildren(cfg, ctx);
    if (!r.children.length) return {};
    const ts = new Date().toISOString();
    const sid = `claude-${String(input.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;
    const env = {
      ts, sid, type: 'proc', event: 'ProcOrphans', session_id: input.session_id || null, agent_id: input.agent_id || null,
      origin: 'hook', summary: `${event}: ${r.total} tien trinh con con song (root pid ${r.rootPid})`,
      data: { trigger: event, note: 'khong gan duoc pid voi agent; liet ke moi con chau cua session', ...r },
    };
    const wopts = { max_file_bytes: 5242880 };
    if (ctx.write !== false) {
      const { writeEnvelope, auditRoot } = await import('../../core/audit/audit-write.mjs');
      writeEnvelope(env, wopts, auditRoot());
    }
    return { record: { rootPid: r.rootPid, total: r.total }, additionalContext: `proc-orphans: ${r.total} tien trinh con con song (root pid ${r.rootPid}); dung truoc khi bao cao cuoi`, records: [{ sink: 'audit', data: env, opts: wopts }] };
  } catch { return {}; } // fail-open
}

const META = { id: 'proc-orphans', events: DEFAULTS.events, timeoutMs: DEFAULTS.timeoutMs, onError: 'open' };
/** Alias cu (test). */
export const MODULE = Object.freeze({ ...META, handle });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). ctx.write === false: khong ghi audit (cache quet van ghi; ctx.cache === false tat cache). */
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
