// Tim file thuc thi cho engine play (claude/agy/node...). Ban cua core; phan mo rong ben ngoai giu ban rieng (import core mot chieu).
import path from 'node:path';
import { spawnSync } from '../../core/runtime/proc.mjs';

const ENV_BIN = { claude: 'HUB_CLAUDE_BIN', agy: 'HUB_AGY_BIN' };

/** where (win32) / which lookup co timeout -> danh sach duong dan ung vien. */
function defaultLookup(name, platform = process.platform) {
  const r = spawnSync(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
}

/** @returns {{path, kind:'exe'|'cmd'}|{error}} kind 'cmd' = can cmd.exe /c (win32 .cmd/.bat). */
export function resolveBin(cli, { env = process.env, platform = process.platform, lookup = defaultLookup } = {}) {
  const ov = env[ENV_BIN[cli]];
  const cands = ov && ov.trim() ? [ov.trim()] : lookup(cli, platform);
  if (!cands.length) return { error: `khong tim thay '${cli}' (dat ${ENV_BIN[cli]} hoac them vao PATH)` };
  if (platform !== 'win32') return { path: cands[0], kind: 'exe' };
  const ext = (p) => path.extname(p).toLowerCase();
  const exe = cands.find((p) => ext(p) === '.exe');
  if (exe) return { path: exe, kind: 'exe' };
  const cmd = cands.find((p) => ['.cmd', '.bat'].includes(ext(p)));
  if (cmd) return { path: cmd, kind: 'cmd' };
  return { error: `'${cli}' chi co dang ${cands.map(ext).join(',') || 'khong ro'}; can .exe hoac .cmd (dat ${ENV_BIN[cli]})` };
}
