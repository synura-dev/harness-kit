// Hook SessionStart/SubagentStart ext-inject: chen ngu canh tong quat tu extension. Manifest extension khai
//   "inject": { "events": ["SessionStart","SubagentStart"], "args": ["show","--cwd","{cwd}","--inject"] }
// Voi moi extension da dang ky VA hash ok (extensionStatus; drift/chua duyet => bo qua) co event khop: chay `harness <ext-id> <args>`
// (bin/harness cua plugin, process.execPath, khong shell; {cwd} = cwd cua su kien), timeout, fail-open, cat dong/byte, noi vao additionalContext.
// Khong hard-code ten extension nao. Tat: hook.config.local.json {"enabled": false} hoac HOOK_EXT_INJECT_ENABLED=0.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { REPO_DIR, readJson, isObj } from '../../core/io/paths.mjs';
import { listRegistered, extensionStatus } from '../../core/ext/ext-trust.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVENTS = ['SessionStart', 'SubagentStart'];

export const DEFAULTS = { enabled: true, events: EVENTS, timeoutMs: 3000, totalMs: 6000, maxLines: 12, maxBytes: 1536 };
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

/** Thuan: khai bao inject hop le => {events, args} | null. */
export function parseInject(m) {
  const i = m && m.inject;
  if (!isObj(i) || !Array.isArray(i.events) || !Array.isArray(i.args)) return null;
  if (!i.args.every((a) => typeof a === 'string')) return null;
  return { events: i.events.filter((e) => typeof e === 'string'), args: i.args };
}

/** Chay that: harness <id> <args> khong shell. -> stdout hoac '' (loi/timeout/exit!=0). */
export function defaultRun(id, args, { cwd, timeoutMs, maxBytes }) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
  const r = spawnSync(process.execPath, [path.join(REPO_DIR, 'bin', 'harness'), id, ...args], { cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: Math.max(maxBytes * 8, 65536) });
  return r.error || r.status !== 0 ? '' : String(r.stdout || '');
}

/**
 * Hop dong HOOK_MODULE: handle(event, input, ctx) -> {} | {additionalContext}. Khong decision. Fail-open.
 * ctx (test): {cfg, list(workspace), status(id, workspace), readManifest(root), run(id, args, opts)}.
 */
export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg ?? load().config;
    if (!cfg.enabled || !EVENTS.includes(event)) return {};
    const cwd = path.resolve(isObj(input) && typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
    const list = ctx.list || ((ws) => listRegistered({ workspace: ws }));
    const status = ctx.status || ((id, ws) => extensionStatus(id, { workspace: ws }).status);
    const readManifest = ctx.readManifest || ((root) => readJson(path.join(root, 'manifest.json')));
    const run = ctx.run || defaultRun;
    const deadline = Date.now() + (cfg.totalMs || DEFAULTS.totalMs);
    const parts = [];
    for (const e of list(cwd)) {
      try {
        const left = deadline - Date.now();
        if (left <= 0) break; // het tran tong: bo ext con lai
        const inj = parseInject(readManifest(e.root));
        if (!inj || !inj.events.includes(event)) continue;
        if (status(e.id, cwd) !== 'ok') continue; // drift/chua duyet/thieu: bo qua
        const args = inj.args.map((a) => a.split('{cwd}').join(cwd));
        const out = clip(run(e.id, args, { cwd, timeoutMs: Math.min(cfg.timeoutMs, left), maxBytes: cfg.maxBytes }), cfg.maxLines, cfg.maxBytes);
        if (out) parts.push(out);
      } catch { /* mot ext loi khong anh huong ext khac */ }
    }
    return parts.length ? { additionalContext: parts.join('\n\n') } : {};
  } catch { return {}; }
}

const META = { id: 'ext-inject', events: DEFAULTS.events, timeoutMs: 7000, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
