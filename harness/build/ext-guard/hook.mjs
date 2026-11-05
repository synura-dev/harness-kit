// Hook ext-guard: guard tong quat tu extension. Manifest extension khai (ghim vao REGISTRY luc ext register/approve; luc chay doc TU REGISTRY, khong doc manifest tren dia)
//   "guard": { "event": "PreToolUse", "matcher": "<regex tool_name>", "args": ["guard"] }
// PreToolUse: voi moi ext da dang ky VA hash ok (drift/chua duyet => chan) co matcher khop tool_name, chay
//   `harness <domain> <args>` (khong shell) voi JSON su kien tren stdin, timeout 2500ms (config), dispatcher cap budget rieng 3000ms cho module nay.
//   exit 0 = qua; exit 2 = chan (deny, ly do = stderr); exit khac/timeout/loi/hash lech = FAIL-CLOSED (chan + audit) cho tool da khop matcher. Khong hard-code ten ext.
import path from 'node:path';
import { spawn } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { REPO_DIR, isObj } from '../../core/io/paths.mjs';
import { listRegistered, hashTree } from '../../core/ext/ext-trust.mjs';
import { killTree } from '../ext-inject/hook.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { timeoutMs: 2500, maxReason: 500 };
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('ext-guard', { defaults: DEFAULTS, files });

/** Thuan: khai bao guard trong registry {event, matcher, args, domain} => {matcher: RegExp (tim kiem nhu matcher hook Claude Code, KHONG ep neo), args, domain} | null. */
export function parseGuard(g) {
  if (!isObj(g) || g.event !== 'PreToolUse' || typeof g.matcher !== 'string' || typeof g.domain !== 'string' || !g.domain || !Array.isArray(g.args) || !g.args.every((a) => typeof a === 'string')) return null;
  try { return { matcher: new RegExp(g.matcher), args: g.args, domain: g.domain }; } catch { return null; }
}

/** Chay that: spawn harness <domain> <args>, stdin = JSON su kien, het timeout => kill. -> Promise<{code, stderr} | {error}>. Khong reject. */
export function defaultRun(domain, args, { cwd, timeoutMs, env, stdin, bin }) {
  return new Promise((resolve) => {
    let err = '', done = false, child, timer;
    const fin = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    try {
      child = spawn(process.execPath, [bin || path.join(REPO_DIR, 'bin', 'harness'), domain, ...args], { cwd, env: { ...(env || process.env), CLAUDE_PROJECT_DIR: cwd, HARNESS_STDIN_FORWARD: '1' }, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
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

/** Hop dong HOOK_MODULE. ctx (test): {cfg, env, list(ws), hashOf(root), run(domain,args,opts)}. Khong doc manifest tren dia. */
export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg ?? load().config;
    if (event !== 'PreToolUse') return {}; // khong co cong tat: guard la cong an toan
    const inp = isObj(input) ? input : {};
    const tool = typeof inp.tool_name === 'string' ? inp.tool_name : '';
    if (!tool) return {};
    const env = ctx.env || process.env;
    const ws = path.resolve(typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.trim() ? env.CLAUDE_PROJECT_DIR.trim() : (typeof inp.cwd === 'string' && inp.cwd ? inp.cwd : process.cwd()));
    let list;
    // Khong doc duoc registry => khong biet matcher => fail-open CO ghi audit (khong the chan mu moi tool).
    try { list = ctx.list ? ctx.list(ws) : listRegistered({ workspace: ws, gitTimeoutMs: 1000 }); } catch { return { records: [rec('registry-unreadable', 'ext-guard: khong doc duoc registry, bo qua (fail-open)')] }; }
    const hashOf = ctx.hashOf || ((root) => { const h = hashTree(root); return h.truncated ? null : h.hash; });
    const run = ctx.run || defaultRun;
    const records = [], denies = [];
    const stdin = JSON.stringify(inp);
    const deny = (id, rule, why) => { denies.push(`ext-guard[${id}]: ${why}`); records.push(rec(rule, why, 'deny')); };
    for (const e of list) {
      try {
        const g = parseGuard(e.guard);
        if (!g || !g.matcher.test(tool)) continue;
        ctx.guardMatched = true; // dispatcher: het budget/loi truoc khi tra loi => CHAN (fail-closed)
        if (hashOf(e.root) !== e.hash) { deny(e.id, 'hash-drift', `guard ${e.id} chua duyet: harness ext approve ${e.id}`); continue; }
        const r = await Promise.resolve(run(g.domain, g.args, { cwd: ws, timeoutMs: cfg.timeoutMs, env, stdin })).catch(() => ({ error: 'run' }));
        if (r && r.code === 0) continue;
        if (r && r.code === 2) {
          const why = String(r.stderr || '').replace(/\s+/g, ' ').trim().slice(0, cfg.maxReason || 500) || 'blocked';
          denies.push(`ext-guard[${e.id}]: ${why}`);
          records.push(rec('ext-deny', `ext ${e.id}: ${why}`, 'deny'));
        } else deny(e.id, 'fail-closed', `guard ${e.id} loi (${(r && (r.error || `exit ${r.code}`)) || 'loi'}), chan`);
      } catch { deny(e.id, 'fail-closed', `guard ${e.id} loi, chan`); }
    }
    const out = {};
    if (denies.length) { out.decision = 'deny'; out.reason = denies.join(' | '); }
    if (records.length) out.records = records;
    return out;
  } catch { return {}; }
}

const META = { id: 'ext-guard', events: ['PreToolUse'], timeoutMs: 2800, onError: 'open', failClosedOnMatch: true };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
