// Suc khoe config guard: file config guard ton tai nhung JSON hong -> luat tu file do (vd protectedPaths) mat hieu luc. Chi doc, khong nem.
import fs from 'node:fs';
import path from 'node:path';
import { pluginLayerDirs } from './config.mjs';
import { isPluginMode } from '../io/paths.mjs';

const MAX_BYTES = 1048576;
const jsonFilesIn = (d) => { try { return fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort().map((n) => path.join(d, n)); } catch { return []; } };

/** Cac file config guard co the ton tai: loi (hook.config.json), hub config/guard/*.json + projects/*.json, plugin mode: may + du an. */
function guardConfigFiles({ hubRoot, env = process.env, repoDir } = {}) {
  const out = [path.join(hubRoot, 'harness', 'constrain', 'guard', 'hook.config.json')];
  const gd = path.join(hubRoot, 'config', 'guard');
  out.push(...jsonFilesIn(gd), ...jsonFilesIn(path.join(gd, 'projects')));
  try {
    if (isPluginMode(repoDir || hubRoot)) {
      const d = pluginLayerDirs({ env, repoDir: repoDir || hubRoot });
      if (d.machineDir) out.push(path.join(d.machineDir, 'guard', 'local.json'));
      if (d.projectDir) out.push(path.join(d.projectDir, 'guard', 'project.json'));
    }
  } catch { /* khong co lop plugin */ }
  return [...new Set(out)];
}

/** -> [{file, problem}] cho moi file ton tai nhung khong doc/parse duoc thanh object JSON. */
export function guardConfigHealth(opts = {}) {
  const bad = [];
  for (const f of guardConfigFiles(opts)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_BYTES) { bad.push({ file: f, problem: 'qua lon' }); continue; }
    try {
      let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      const j = JSON.parse(t);
      if (!j || typeof j !== 'object' || Array.isArray(j)) bad.push({ file: f, problem: 'goc khong phai object' });
    } catch { bad.push({ file: f, problem: 'JSON hong' }); }
  }
  // Registry co the bi tach: primary (id <ten>@<mkt>) va legacy (<ten>) cung co config nhung khac nhau.
  try {
    const repoDir = opts.repoDir || opts.hubRoot;
    if (isPluginMode(repoDir)) {
      const d = pluginLayerDirs({ env: opts.env || process.env, repoDir });
      const n = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
      const legacyCfg = path.join(d.legacyDir, 'config');
      // Cung thu muc cha (data root) de pd ngoai cache khong bao gia; split = registry legacy con nhung may dang dung thu muc khac.
      if (n(path.dirname(d.primaryDir)) === n(path.dirname(d.legacyDir)) && n(d.machineDir) !== n(legacyCfg) && fs.existsSync(path.join(legacyCfg, 'ext', 'local.json'))) {
        bad.push({ file: path.join(legacyCfg, 'ext', 'local.json'), problem: `ext registry bi tach: ${legacyCfg} con registry nhung dang dung ${d.machineDir}`, split: true });
      }
    }
  } catch { /* bo qua */ }
  return bad;
}
