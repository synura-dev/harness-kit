// Hook ext-guard: guard tong quat tu extension. Manifest extension khai
//   "guard": { "event": "PreToolUse", "matcher": "<regex tool_name>", "args": ["guard"] }
// PreToolUse: voi moi ext da dang ky VA hash ok (drift/chua duyet => bo qua + canh bao) co matcher khop tool_name, chay
//   `harness <domain> <args>` (khong shell) voi JSON su kien tren stdin, timeout < budget PreToolUse (2500ms).
//   exit 0 = qua; exit 2 = chan (deny, ly do = stderr); exit khac/timeout/loi = fail-open + ghi canh bao. Khong hard-code ten ext.
import path from 'node:path';
import { spawn } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { REPO_DIR, readJson, isObj } from '../../core/io/paths.mjs';
import { listRegistered, hashTree } from '../../core/ext/ext-trust.mjs';
import { manifestDomains } from '../../core/ext/manifest-domains.mjs';
import { coreDomains, killTree } from '../ext-inject/hook.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { enabled: true, timeoutMs: 2300, maxReason: 500 };
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('ext-guard', { defaults: DEFAULTS, files, env: { HOOK_EXT_GUARD_ENABLED: 'enabled' } });

/** Thuan: khai bao guard hop le => {matcher: RegExp, args} | null (regex hong/khac PreToolUse => null). */
export function parseGuard(m) {
  const g = m && m.guard;
  if (!isObj(g) || g.event !== 'PreToolUse' || typeof g.matcher !== 'string' || !Array.isArray(g.args) || !g.args.every((a) => typeof a === 'string')) return null;
  try { return { matcher: new RegExp(`^(?:${g.matcher})$`), args: g.args }; } catch { return null; }
}

/** Chay that: spawn harness <domain> <args>, stdin = JSON su kien, het timeout => kill. -> Promise<{code, stderr} | {error}>. Khong reject. */
export function defaultRun(domain, args, { cwd, timeoutMs, env, stdin, bin }) {
  return new Promise((resolve) => {
    let err = '', done = false, child, timer;
    const fin = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    try {
      child = spawn(process.execPath, [bin || path.join(REPO_DIR, 'bin', 'harness'), domain, ...args], { cwd, env: { ...(env || process.env), CLAUDE_PROJECT_DIR: cwd }, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch { return fin({ error: 'spawn' }); }
    timer = setTimeout(() => { killTree(child); fin({ error: 'timeout' }); }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
    child.stdin.on('error', () => {});
    child.on('error', () => fin({ error: 'spawn' }));
    child.on('close', (code) => fin({ code, stderr: err }));
    try { child.stdin.end(stdin); } catch { /* bo qua */ }
  });
}

const rec = (rule, reason, decision = 'allow') => ({ sink: 'gate', data: { kind: 'gate', decision, hook: 'ext-guard', rule, reason } });

/** Hop dong HOOK_MODULE. ctx (test): {cfg, env, list(ws), hashOf(root), readManifest(root), core(), run(domain,args,opts)}. */
export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg ?? load().config;
    if (!cfg.enabled || event !== 'PreToolUse') return {};
    const inp = isObj(input) ? input : {};
    const tool = typeof inp.tool_name === 'string' ? inp.tool_name : '';
    if (!tool) return {};
    const env = ctx.env || process.env;
    const ws = path.resolve(typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.trim() ? env.CLAUDE_PROJECT_DIR.trim() : (typeof inp.cwd === 'string' && inp.cwd ? inp.cwd : process.cwd()));
    const list = ctx.list ? ctx.list(ws) : listRegistered({ workspace: ws, gitTimeoutMs: 1000 });
    const readManifest = ctx.readManifest || ((root) => readJson(path.join(root, 'manifest.json')));
    const hashOf = ctx.hashOf || ((root) => { const h = hashTree(root); return h.truncated ? null : h.hash; });
    const run = ctx.run || defaultRun;
    let core;
    const records = [], denies = [];
    const stdin = JSON.stringify(inp);
    for (const e of list) {
      try {
        const m = readManifest(e.root);
        const g = parseGuard(m);
        if (!g || !g.matcher.test(tool)) continue;
        if (hashOf(e.root) !== e.hash) { records.push(rec('hash-drift', `ext ${e.id}: hash lech/chua duyet, bo qua guard`)); continue; }
        core = core === undefined ? (ctx.core ? ctx.core() : coreDomains()) : core;
        const domain = core && manifestDomains(m).find((d) => !core.has(d));
        if (!domain) { records.push(rec('no-domain', `ext ${e.id}: khong co domain rieng, bo qua guard`)); continue; }
        const r = await Promise.resolve(run(domain, g.args, { cwd: ws, timeoutMs: cfg.timeoutMs, env, stdin })).catch(() => ({ error: 'run' }));
        if (r && r.code === 0) continue;
        if (r && r.code === 2) {
          const why = String(r.stderr || '').replace(/\s+/g, ' ').trim().slice(0, cfg.maxReason || 500) || 'blocked';
          denies.push(`ext-guard[${e.id}]: ${why}`);
          records.push(rec('ext-deny', `ext ${e.id}: ${why}`, 'deny'));
        } else records.push(rec('fail-open', `ext ${e.id}: ${(r && (r.error || `exit ${r.code}`)) || 'loi'}`));
      } catch { records.push(rec('fail-open', `ext ${e.id}: loi guard`)); }
    }
    const out = {};
    if (denies.length) { out.decision = 'deny'; out.reason = denies.join(' | '); }
    if (records.length) out.records = records;
    return out;
  } catch { return {}; }
}

const META = { id: 'ext-guard', events: ['PreToolUse'], timeoutMs: 2400, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
