// Core (khong tren duong agy): tim thu muc cache plugin Claude (noi duy nhat user-shim biet duong cai cua Claude). Duong agy KHONG import file nay.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

/** Thu muc cache chua cac ban harness-kit (<config>/plugins/cache/<mkt>/harness-kit) hoac null (chay tu nguon, chua cai plugin). */
export function pluginCacheDir(pluginRoot, { env = process.env, home = os.homedir() } = {}) {
  const parent = path.dirname(path.resolve(pluginRoot));
  if (path.basename(parent) === 'harness-kit' && path.basename(path.dirname(path.dirname(parent))) === 'cache') return parent;
  const cache = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'cache');
  let mkts = [];
  try { mkts = fs.readdirSync(cache).sort(); } catch { return null; }
  for (const m of mkts) if (isDir(path.join(cache, m, 'harness-kit'))) return path.join(cache, m, 'harness-kit');
  return null;
}
