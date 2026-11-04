// Hook SessionStart user-shim: tu cai/duy tri shim `harness` cho shell cua user (PowerShell/cmd/bash ngoai Claude) moi phien.
// Cung logic voi `harness install --shim` (core/runtime/user-shim.mjs syncUserShim): ghi shim vao thu muc co dinh, them thu muc vao PATH user
// mot lan, xoa shim cu cua ta. Khong ghi de file la. Chay tu nguon (khong co cache plugin) -> bo qua. Chi bao (additionalContext) khi co thay doi/loi.
// Fail-open. Tat: hook.config.local.json {"enabled": false} hoac HOOK_USER_SHIM_ENABLED=0.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHookConfig } from '../../core/config/config.mjs';
import { REPO_DIR } from '../../core/io/paths.mjs';
import { syncUserShim, pluginCacheDir } from '../../core/runtime/user-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = { enabled: true, events: ['SessionStart'], timeoutMs: 15000 };
export const configFiles = () => [path.join(HERE, 'hook.config.json'), path.join(HERE, 'hook.config.local.json')];
export const load = (files = configFiles()) => loadHookConfig('user-shim', { defaults: DEFAULTS, files, env: { HOOK_USER_SHIM_ENABLED: 'enabled' } });

/**
 * Hop dong HOOK_MODULE: handle(event, input, ctx) -> {} | {additionalContext}. Khong decision.
 * ctx (tuy chon): {cfg, pluginRoot, inj} - inj chuyen nguyen cho syncUserShim (platform/env/home/regPath/setUserPath; test).
 */
export async function handle(event, input, ctx = {}) {
  try {
    const cfg = ctx.cfg ?? load().config;
    if (!cfg.enabled || !cfg.events.includes(event)) return {};
    const pluginRoot = ctx.pluginRoot || REPO_DIR;
    const inj = ctx.inj || {};
    // bun test dat NODE_ENV=test (tien trinh con ke thua): test dispatcher chay SessionStart that KHONG duoc ghi shim/PATH cua may; chi chay khi test tiem IO.
    if (!ctx.inj && process.env.NODE_ENV === 'test') return {};
    if (!pluginCacheDir(pluginRoot, inj)) return {};
    const s = syncUserShim({ pluginRoot, ...inj });
    const tag = 'harness-kit user-shim:';
    if (s.blocked) return { additionalContext: `${tag} ${s.files.find((f) => f.action === 'foreign').file} khong do harness-kit sinh, khong ghi de. Muon thay: harness install --shim --force` };
    if (s.path.state === 'error') return { additionalContext: `${tag} khong them duoc ${s.dir} vao PATH user (${s.path.error}); tu them vao PATH` };
    const wrote = s.files.filter((f) => f.action === 'create' || f.action === 'update');
    if (!wrote.length && s.path.state !== 'added' && !s.removed.length) return {};
    const parts = [`lenh \`harness\` cho shell cua user o ${s.dir}`];
    if (wrote.length) parts.push(`${wrote.length} file shim tao/cap nhat`);
    if (s.path.state === 'added') parts.push(`vua them vao PATH user (${s.path.where}); mo terminal moi de dung`);
    if (s.removed.length) parts.push(`da xoa shim cu: ${s.removed.join(', ')}`);
    return { additionalContext: `${tag} ${parts.join('; ')}. Bao user mot dong.` };
  } catch { return {}; } // fail-open
}

const META = { id: 'user-shim', events: DEFAULTS.events, timeoutMs: DEFAULTS.timeoutMs, onError: 'open' };
export default Object.freeze({ ...META, handle: async (event, input, ctx) => handle(event, input, ctx) });
