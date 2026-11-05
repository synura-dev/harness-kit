// Hook data-check: canh bao vi pham data dau phien + rac khi ghi file. Chi warn, fail-open.
import fs from 'node:fs';
import path from 'node:path';
import { spawnBackground } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { TOP_FILES } from '../../core/config/contract.mjs';
import { dataRoot, workspaceRoot, toPosix, REPO_DIR } from '../../core/io/paths.mjs';
import { SCAN_CACHE_REL, formatWarn } from '../../core/registry/data-registry.mjs';
import { isStdRootFile } from '../storage/std-root.mjs';
import { doctorAuto } from './doctor-auto.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { enabled: true, timeoutMs: 300, scanTimeoutMs: 8000, retryMinutes: 30, lockMinutes: 2, stateMaxDays: 7, pruneMax: 50, cacheMaxAgeHours: 24, allowlist: [], autoClean: { enabled: true, minIntervalHours: 24, maxFiles: 500, maxBytes: 200000000, timeoutS: 20 } };
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('data-check', { defaults: DEFAULTS, files, env: { HOOK_DATA_CHECK_ENABLED: 'enabled' } });

const JUNK = /\.(log|tmp|txt|out|bak|csv|zip|png|jpe?g)$/i;
const MAX_LINES = 5;
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };

/** Tra duong dan clutter (tuong doi repo) hoac null. So khop chuoi, khong IO. */
export function clutterOf(file, cfg, root = workspaceRoot()) {
  if (typeof file !== 'string' || !file) return null;
  const rel = toPosix(path.relative(path.resolve(root), path.resolve(root, file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if ((cfg.allowlist || []).some((a) => rel === toPosix(a) || rel.startsWith(toPosix(a).replace(/\/?$/, '/')))) return null;
  const parts = rel.split('/');
  if (parts.length === 1) return !TOP_FILES.includes(rel) && !isStdRootFile(rel) && JUNK.test(rel) ? rel : null;
  if (parts[0] === 'docs' && !/\.md$/i.test(rel)) return rel;
  return null;
}

const wj = (f, o) => { const t = `${f}.${process.pid}.tmp`; try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); return true; } catch { try { fs.unlinkSync(t); } catch {} return false; } };

/** Don *.tmp mo coi (cu hon maxAgeMs, mac dinh 1h) trong thu muc; toi da max file. Tra so file da xoa. */
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

/** Spawn scan nen (detached, khong cho). Negative cache + lock nhe. Tra true neu da spawn. */
function kickScan(dd, cfg, ctx = {}) {
  try {
    const now = Date.now();
    const tried = rd(path.join(dd, '.state', 'data-check-tried.json'));
    if (tried && now - Number(tried.ts) < (cfg.retryMinutes ?? 30) * 60e3) return false;
    const lock = rd(path.join(dd, '.state', 'data-check-scan.lock'));
    if (lock && now - Number(lock.ts) < (cfg.lockMinutes ?? 2) * 60e3) return false;
    wj(path.join(dd, '.state', 'data-check-tried.json'), { ts: now });
    wj(path.join(dd, '.state', 'data-check-scan.lock'), { ts: now, pid: process.pid });
    const go = ctx.spawnScan || (() => {
      const cli = path.join(REPO_DIR, 'harness', 'cli', 'harness.mjs');
      spawnBackground({ cmd: process.execPath, args: [cli, 'data', 'scan', '--json'], key: 'data-scan', deadlineMs: 5 * 60e3, env: { ...process.env, HARNESS_GATEWAY: '1' } });
    });
    go();
    return true;
  } catch { return false; }
}

const CLEAN_REL = ['.state', 'data-check-clean.json'];
const fmtMB = (n) => (n / 1048576).toFixed(1);

/** Don tu dong log/cache qua han: spawn nen khi lan gan nhat >= minIntervalHours. Tra dong thong bao ket qua moi (hoac null). */
export function autoClean(dd, cfg, ctx = {}) {
  try {
    const ac = { ...DEFAULTS.autoClean, ...(cfg.autoClean || {}) };
    const env = ctx.env || process.env;
    if (!ac.enabled || env.HOOK_DATA_CHECK_AUTOCLEAN === '0') return null;
    const sf = path.join(dd, ...CLEAN_REL); const st = rd(sf) || {}; const now = Date.now();
    let line = null;
    if (st.done !== undefined && st.seen === false) {
      if (st.files > 0 || st.error) line = st.error ? `data-clean: loi ${String(st.error).slice(0, 120)} (${st.ts})` : `data-clean: da don ${st.files} file (${fmtMB(st.bytes || 0)} MB) tu ${st.ts}${st.truncated ? ' [truncated: ' + st.truncated + ']' : ''}`;
      wj(sf, { ...st, seen: true });
    }
    const last = Number(st.lastRun) || 0;
    if (now - last >= ac.minIntervalHours * 3600e3) {
      const lf = path.join(dd, '.state', 'data-check-clean.lock'); const lock = rd(lf);
      if (!(lock && now - Number(lock.ts) < 5 * 60e3)) {
        wj(lf, { ts: now, pid: process.pid });
        const go = ctx.spawnClean || (() => {
          const cli = path.join(REPO_DIR, 'harness', 'cli', 'harness.mjs');
          const a = [cli, 'data', 'clean', '--auto', '--yes', '--max-files', String(ac.maxFiles), '--max-bytes', String(ac.maxBytes), '--timeout-s', String(ac.timeoutS)];
          spawnBackground({ cmd: process.execPath, args: a, key: 'data-clean', deadlineMs: (ac.timeoutS + 60) * 1000, env: { ...process.env, HARNESS_GATEWAY: '1' } });
        });
        go();
      }
    }
    return line;
  } catch { return null; }
}

/** Don data-check-*.json cu hon maxDays, toi da maxFiles/lan. */
export function pruneState(dd, cfg = {}, now = Date.now()) {
  let n = 0;
  try {
    const dir = path.join(dd, '.state'); const lim = now - (cfg.stateMaxDays ?? 7) * 864e5;
    for (const f of fs.readdirSync(dir)) {
      if (n >= (cfg.pruneMax ?? 50)) break;
      if (!/^data-check-.+\.json$/.test(f) || f === 'data-check-tried.json' || f === 'data-check-clean.json') continue;
      try { const fp = path.join(dir, f); if (fs.statSync(fp).mtimeMs < lim) { fs.unlinkSync(fp); n++; } } catch {}
    }
  } catch {}
  return n;
}

async function sessionStart(input, cfg, ctx) {
  const dd = dataRoot(null, ctx.env ? { env: ctx.env } : {});
  const file = path.join(dd, SCAN_CACHE_REL);
  const scan = rd(file);
  const age = scan && scan.ts ? Date.now() - Date.parse(scan.ts) : Infinity;
  if (!(age <= cfg.cacheMaxAgeHours * 3600e3)) kickScan(dd, cfg, ctx);
  pruneState(dd, cfg);
  pruneTmp(path.join(dd, '.state'));
  pruneTmp(path.dirname(file));
  const cleanLine = [autoClean(dd, cfg, ctx), ...doctorAuto(dd, cfg, ctx)].filter(Boolean).join('\n') || null;
  const ws = scan && Array.isArray(scan.warnings) ? scan.warnings : [];
  if (!ws.length) return cleanLine ? { additionalContext: cleanLine } : {};
  const sid = String(input.session_id || 'x').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const sf = path.join(dd, '.state', `data-check-${sid}.json`);
  const seen = new Set(rd(sf) || []);
  const fresh = ws.filter((w) => !seen.has(`${w.rule}|${w.key}`));
  if (!fresh.length) return cleanLine ? { additionalContext: cleanLine } : {};
  const shown = fresh.slice(0, MAX_LINES - 1); const lines = shown.map(formatWarn);
  lines.push(`data-check: ${fresh.length}/${ws.length} canh bao. Xem: node harness/cli/harness.mjs data scan`);
  try { fs.mkdirSync(path.dirname(sf), { recursive: true }); fs.writeFileSync(sf, JSON.stringify([...seen, ...shown.map((w) => `${w.rule}|${w.key}`)])); } catch {}
  if (cleanLine) lines.push(cleanLine);
  return { additionalContext: lines.join('\n') };
}

function postWrite(input, cfg, ctx) {
  const ti = input.tool_input || {};
  const rel = clutterOf(ti.file_path || ti.path, cfg, ctx.root || workspaceRoot());
  if (!rel) return {};
  return { additionalContext: `data-warn rule=clutter path=${rel} fix="chuyen scratchpad hoac data/<zone>/<domain>/<tool> qua storage"` };
}

export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg ?? load().config;
    if (ctx.write === false) { const nop = () => {}; ctx = { ...ctx, spawnScan: ctx.spawnScan || nop, spawnClean: ctx.spawnClean || nop, spawnDoctor: ctx.spawnDoctor || nop }; } // write:false: khong spawn nen
    if (!cfg.enabled || !input || typeof input !== 'object') return {};
    if (event === 'PostToolUse') return postWrite(input, cfg, ctx);
    if (event !== 'SessionStart') return {};
    let tm; const to = new Promise((r) => { tm = setTimeout(() => r({}), ctx.budgetMs ?? cfg.timeoutMs + 500); });
    try { return await Promise.race([sessionStart(input, cfg, ctx), to]); } finally { clearTimeout(tm); }
  } catch { return {}; }
}

const META = { id: 'data-check', events: ['SessionStart', 'PostToolUse'], tools: /^(Write|Edit|MultiEdit|NotebookEdit|)$/, timeoutMs: 9000, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
