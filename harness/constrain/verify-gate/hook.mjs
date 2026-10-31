// Hook Stop/SubagentStop: verify-gate. Da sua file ma ma khong co bang chung pass (test|tsc|build|lint) sau lan sua cuoi
// -> chan dong 1 lan (decision block) + ghi vet audit type=gate. Deploy can hash + health sau deploy.
// Chan toi da 1 lan/luot (stop_hook_active hoac dau block trong audit). Loi noi bo/timeout/audit hong (> maxBadRatio): fail-open + ghi vet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { auditRoot } from '../../core/audit/audit-write.mjs';
import { dataRoot } from '../../core/io/paths.mjs';
import { resolveDataRel } from '../../core/registry/data-registry.mjs';
import { recordGate } from '../../core/audit/gate-event.mjs';
import { decide, scopeEvents, GATE_HOOK } from './gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// release: allowlist. Hoi cho MOI lenh release tru khi subcommand dau tien (khong-co) la plan|preflight|status|verify (co gia tri: project/env/timeout/...).
const RV = 'project|env|timeout-s|max-bytes|confirm|backup|run|expect-hash|mark|restarts';
const REL_FL = `(?:--(?:${RV})\\s+[^\\s;&|-][^\\s;&|]*|-(?!-(?:${RV})(?:\\s|$))[^\\s;&|]*)\\s+`;
const REL_SAFE = `(?!\\s+(?:${REL_FL})*["']?(?:plan|preflight|status|verify)["']?(?![\\w.-]))`;
const RT = '(?:node|bun|tsx|deno)(?:\\.exe)?';
export const DEFAULTS = {
  enabled: true,
  events: ['Stop', 'SubagentStop'],
  timeoutMs: 4000,
  maxFileBytes: 2097152, // doc duoi moi file audit
  maxTotalBytes: 16777216,
  days: 2, // hom nay + hom qua (UTC)
  traceAllow: false, // ghi vet ca lan cho qua binh thuong
  codeExts: ['mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'go', 'rs', 'java', 'kt', 'cs', 'c', 'h', 'cpp', 'hpp',
    'rb', 'php', 'swift', 'vue', 'svelte', 'sh', 'ps1', 'psm1', 'sql', 'dart', 'scala', 'lua'],
  ignorePaths: [], // tien to duong dan tuyet doi bo qua hoan toan; thu muc tam (os.tmpdir/TEMP/TMP) va file ngoai moi git repo luon bi bo qua
  maxBadRatio: 0.2, // dong audit hong le bi bo qua; ty le hong vuot nguong -> fail-open
  // Deploy theo LENH THUC THI: moi mau neo ^ va thu tren tung doan lenh (&&, ||, ;, |) da bo sudo/env/FOO=bar/timeout/&;
  // ssh: gate xet them lenh tu xa. Chu "deploy" trong duong dan/doi so (cat docs/deploy.log, ls deploy/) khong tinh.
  deployPatterns: [
    '^(?:npm|pnpm|yarn|bun)\\s+(?:run(?:-script)?\\s+)?deploy(?::[\\w-]+)?(?:\\s|$)',
    '^["\']?(?:[^\\s"\']*[\\\\/])?deploy[\\w.-]*\\.(?:sh|ps1|bat|cmd)["\']?(?:\\s|$)',
    '^(?:bash|sh|zsh|pwsh|powershell(?:\\.exe)?|node|bun|python3?)\\s+(?:-\\S+\\s+)*["\']?(?:[^\\s"\']*[\\\\/])?deploy[\\w.-]*\\.(?:sh|ps1|bat|cmd|mjs|cjs|js|ts|py)\\b',
    `^(?:(?:${RT}\\s+)?\\S*harness\\.mjs|harness(?:\\.cmd|\\.exe)?)["']?\\s+(?:\\S+\\s+)*?["']?release["']?(?![\\w.-])${REL_SAFE}`,
    `^${RT}\\s+(?:\\S+\\s+)*?["']?(?:\\S*[\\\\/])?release[\\\\/]cli\\.mjs["']?(?![\\w.-])${REL_SAFE}`,
    '^(?:node|bun)\\s+.*(?:\\bimport\\s*\\(|\\brequire\\s*\\(|\\bfrom\\s+)\\s*["\'`][^"\'`\\n]*(?:release[\\\\/](?:cli|steps|scripts|remote)|\\.{1,2}[\\\\/](?:cli|steps|scripts))\\.mjs',
    '^ssh\\s.*\\b(?:reload|restart)\\b', '^pm2\\s+(?:reload|restart|start|deploy)\\b', '^systemctl\\s+(?:reload|restart|start)\\b',
    '^service\\s+\\S+\\s+(?:reload|restart)\\b', '^kubectl\\s+(?:apply|rollout|set\\s+image)\\b', '^helm\\s+(?:install|upgrade)\\b',
    '^docker(?:\\s+|-)compose\\b.*\\bup\\b', '^(?:fly|flyctl)\\s+deploy\\b', '^vercel\\b(?:.*\\s--prod\\b|\\s+deploy\\b)',
    '^(?:netlify|firebase|serverless|sls)\\s+deploy\\b', '^wrangler\\s+(?:deploy|publish)\\b', '^gcloud\\s.*\\bdeploy\\b', '^railway\\s+up\\b',
    '^git\\s+push\\s+(?:-\\S+\\s+)*(?:heroku|dokku)\\b',
  ],
};
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('verify-gate', { defaults: DEFAULTS, files, env: { HOOK_VERIFY_GATE_ENABLED: 'enabled' } }).config;

/** sid giong hooks/audit: 'claude-' + session_id da loc ky tu. Rong -> null (khong doan). */
export function sidOf(inp) {
  const cli = inp.cli ? String(inp.cli).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'claude' : 'claude';
  const s = String(inp.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!s) return null;
  return s.startsWith(cli + '-') ? s : `${cli}-${s}`;
}

/** Cac goc audit de DOC: CLAUDE_AUDIT_DIR (neu set) hoac goc moi + legacy theo registry (dedupe). Thay bang dataReadRoots khi co. */
export function auditReadRoots(opts = {}) {
  const env = opts.env || process.env;
  if (env.CLAUDE_AUDIT_DIR) return [env.CLAUDE_AUDIT_DIR];
  try {
    const base = dataRoot(undefined, opts), r = resolveDataRel('audit', opts);
    const out = [path.join(base, ...r.rel.split('/'))];
    if (r.legacyRel) { const l = path.join(base, ...r.legacyRel.split('/')); if (!out.includes(l)) out.push(l); }
    return out;
  } catch { return [auditRoot()]; }
}

/** Doc su kien audit cua sid (type tool/prompt/gate, N ngay). Tra { events, bad, good, truncated }.
 *  Dong cuoi chua ket thuc '\n' (dang ghi do) bi bo, khong tinh hong. Nem loi khi khong doc duoc thu muc goc. */
function readSessionEvents(root, sid, now, cfg, deadline = Infinity) {
  if (!fs.statSync(root).isDirectory()) throw new Error('audit root khong phai thu muc');
  const events = []; let bad = 0, good = 0, total = 0, truncated = null;
  for (let d = (cfg.days || 2) - 1; d >= 0; d--) {
    const day = new Date(now.getTime() - d * 86400000).toISOString().slice(0, 10);
    for (const type of ['prompt', 'tool', 'gate']) {
      const dir = path.join(root, `date=${day}`, `type=${type}`);
      let names; try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      for (const f of names) {
        if (!(f === sid + '.jsonl' || (f.startsWith(sid + '.') && /^\d+\.jsonl$/.test(f.slice(sid.length + 1))))) continue;
        if (Date.now() > deadline) { truncated = 'timeout'; return { events, bad, good, truncated }; }
        const p = path.join(dir, f);
        const size = fs.statSync(p).size, len = Math.min(size, cfg.maxFileBytes || 2097152);
        if (total + len > (cfg.maxTotalBytes || 16777216)) { truncated = 'size'; return { events, bad, good, truncated }; }
        total += len;
        const buf = Buffer.alloc(len), fd = fs.openSync(p, 'r');
        try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
        const lines = buf.toString('utf8').split('\n');
        if (size > len) lines.shift(); // dong dau bi cat giua chung
        lines.pop(); // phan sau '\n' cuoi: rong, hoac dong dang ghi do -> bo
        for (const line of lines) {
          if (!line.trim()) continue;
          try { const e = JSON.parse(line); if (e && typeof e === 'object' && !Array.isArray(e)) { events.push(e); good++; } else bad++; } catch { bad++; }
        }
      }
    }
  }
  return { events, bad, good, truncated };
}

/** Thu muc tam cua may: os.tmpdir(), TEMP, TMP (khong trung). */
const tmpDirsOf = () => [...new Set([os.tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean))];

/** Tra git root (thu muc chua .git, file hoac thu muc -> worktree la du an rieng) cua dir da chuan hoa; cache, toi da 64 cap. */
function makeRootOf(deadline = Infinity) {
  const cache = new Map();
  return (dir) => {
    if (!dir) return null;
    if (cache.has(dir)) return cache.get(dir);
    let d = dir, r = null;
    for (let i = 0; i < 64 && Date.now() <= deadline; i++) {
      const fsd = /^[a-z]:$/i.test(d) ? d + '/' : d;
      try { if (fs.existsSync(path.join(fsd, '.git'))) { r = d.replace(/\/+$/, '') || '/'; break; } } catch {}
      const k = d.replace(/\/+$/, '').lastIndexOf('/');
      const up = k < 0 ? d : k === 0 ? '/' : d.slice(0, k);
      if (up === d || !up) break;
      d = up;
    }
    cache.set(dir, r);
    return r;
  };
}

// Ghi vet qua API chung core/audit/gate-event (type=gate, data.gate={kind,decision,hook,rule,reason,...}); khong nem.
function traceRaw(root, inp, sid, decision, code, extra = {}, now = new Date(), sinkOpts = null) {
  const sub = inp.hook_event_name === 'SubagentStop';
  const ctx = { session_id: sid ? sid : '', cwd: inp.cwd, agent_id: sub ? inp.agent_id : null, agent_type: sub ? inp.agent_type : null };
  const reason = [inp.hook_event_name || '?', extra.missing && extra.missing.length ? 'missing=' + extra.missing.join(',') : '',
    Number.isFinite(extra.edits) ? 'edits=' + extra.edits : '', extra.bad_lines ? 'bad=' + extra.bad_lines : '',
    extra.cwd_assumed ? 'cwd_assumed=' + extra.cwd_assumed : '', extra.error || ''].filter(Boolean).join(' ');
  const ev = { kind: 'gate', decision, hook: GATE_HOOK, rule: code, reason };
  if (sinkOpts && sinkOpts.records) sinkOpts.records.push({ sink: 'gate', data: ev, ctx });
  if (sinkOpts && sinkOpts.write === false) return false;
  return recordGate(ev, ctx, { root, now });
}

/** Chay gate tren payload. Tra { out: object|null, decision, code }. Khong nem. */
export function run(inp, { cfg = load(), root = auditRoot(), now = new Date(), deadline = Infinity, write = true, records = null, readRoots = null } = {}) {
  let sid = null;
  const so = { write, records };
  const trace = (r, i, s, d, c, x, n) => traceRaw(r, i, s, d, c, x, n, so);
  try {
    if (!cfg.enabled) return { out: null, decision: 'allow', code: 'disabled' };
    const event = String(inp.hook_event_name || '');
    if (!(cfg.events || []).includes(event)) return { out: null, decision: 'allow', code: 'event_skip' };
    sid = sidOf(inp);
    if (!sid) { trace(root, inp, null, 'allow', 'fail_open_no_session', {}, now); return { out: null, decision: 'allow', code: 'fail_open_no_session' }; }
    if (event === 'SubagentStop' && !inp.agent_id) { trace(root, inp, sid, 'allow', 'fail_open_no_agent_id', {}, now); return { out: null, decision: 'allow', code: 'fail_open_no_agent_id' }; }
    const rr = readRoots && readRoots.length ? readRoots : [root];
    let events = [], bad = 0, good = 0, truncated = null, okRoots = 0, firstErr = null;
    for (const r0 of rr) {
      if (truncated) break;
      try { const x = readSessionEvents(r0, sid, now, cfg, deadline); events = events.concat(x.events); bad += x.bad; good += x.good; truncated = x.truncated; okRoots++; } catch (e) { firstErr = firstErr || e; }
    }
    if (!okRoots && firstErr) throw firstErr;
    if (rr.length > 1) events.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
    const maxBad = Number.isFinite(cfg.maxBadRatio) ? cfg.maxBadRatio : DEFAULTS.maxBadRatio;
    if (truncated || (bad > 0 && bad / (bad + good) > maxBad)) {
      const code = truncated ? 'fail_open_truncated_' + truncated : 'fail_open_audit_corrupt';
      trace(root, inp, sid, 'allow', code, { bad_lines: bad }, now);
      return { out: null, decision: 'allow', code };
    }
    const scoped = scopeEvents(events, { event, agentId: inp.agent_id ? String(inp.agent_id) : null });
    const r = decide(scoped, cfg, { stopHookActive: inp.stop_hook_active === true, cwd: typeof inp.cwd === 'string' && inp.cwd ? inp.cwd : null, rootOf: makeRootOf(deadline), tmpDirs: tmpDirsOf() });
    const extra = { edits: r.edits, missing: r.missing || [], bad_lines: bad, cwd_assumed: r.cwdAssumed };
    if (r.decision === 'block') {
      trace(root, inp, sid, 'block', r.code, extra, now);
      return { out: { decision: 'block', reason: r.reason }, decision: 'block', code: r.code };
    }
    if (r.code.startsWith('already_blocked') || cfg.traceAllow) trace(root, inp, sid, 'allow', r.code, extra, now);
    return { out: null, decision: 'allow', code: r.code };
  } catch (e) {
    const code = 'fail_open_error';
    trace(root, inp, sid, 'allow', code, { error: String(e && e.message || e).slice(0, 120) }, now);
    return { out: null, decision: 'allow', code };
  }
}

function readStdin(ms) {
  return new Promise((resolve) => {
    let s = ''; const t = setTimeout(() => resolve(s), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; if (s.length > 1048576) { clearTimeout(t); resolve(s); } });
    process.stdin.on('end', () => { clearTimeout(t); resolve(s); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(s); });
  });
}

/**
 * Hop dong module (HOOK_MODULE, core/config/contract.mjs): handle(event, input, ctx) -> {decision, block, reason?, record}.
 * Khong ghi stdout/exit (vo main lam). Block = decision 'deny' + block true (Stop bi chan 1 lan). input rac/null -> fail-open 'allow'.
 * ctx (tuy chon): {cfg, root, now, deadline}; thieu thi nap mac dinh. Ghi vet audit type=gate nhu truoc.
 */
export function handle(event, input, ctx = {}) {
  const root = ctx.root ?? auditRoot();
  const readRoots = ctx.readRoots ?? (ctx.root ? null : auditReadRoots());
  const now = ctx.now ?? new Date();
  const write = ctx.write !== false;
  const records = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    traceRaw(root, {}, null, 'allow', 'fail_open_bad_stdin', {}, now, { write, records });
    return { decision: 'allow', block: false, record: { code: 'fail_open_bad_stdin' }, records };
  }
  const inp = input.hook_event_name ? input : { ...input, hook_event_name: event };
  const r = run(inp, { cfg: ctx.cfg ?? load(), root, now, deadline: ctx.deadline ?? Infinity, write, records, readRoots });
  if (r.decision === 'block') return { decision: 'deny', block: true, reason: r.out.reason, record: { code: r.code }, records };
  return { decision: 'allow', block: false, record: { code: r.code }, records };
}

const META = { id: 'verify-gate', events: DEFAULTS.events, timeoutMs: DEFAULTS.timeoutMs, onError: 'open' };
/** Alias cu (test): handle dong bo goc. */
export const MODULE = Object.freeze({ ...META, handle });
/** Chuan HOOK_MODULE: async handle(event, input, ctx). ctx.write === false: khong ghi gate, chi tra records. */
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });

export async function main() {
  let cfg = DEFAULTS; try { cfg = load(); } catch {}
  const budget = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULTS.timeoutMs;
  const killer = setTimeout(() => { // tran cung: het gio -> fail-open
    traceRaw(auditRoot(), { hook_event_name: 'timeout' }, null, 'allow', 'fail_open_timeout');
    process.exit(0);
  }, budget + 500);
  killer.unref();
  try {
    const raw = await readStdin(Math.min(1500, budget));
    let inp; try { inp = JSON.parse(raw); } catch { inp = null; }
    const r = handle(String(inp && inp.hook_event_name || ''), inp, { cfg, deadline: Date.now() + budget, write: true });
    if (r.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: r.reason }));
  } catch {} finally { clearTimeout(killer); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().then(() => process.exit(0), () => process.exit(0));
