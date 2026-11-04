// Kiem registry = manifest.json cua tung extension (CHI CANH BAO, khong bao gio nem loi).
// checkManifest(root) -> string[]: manifest hong/thieu, hook thieu README/config, file .mjs chua khai bao.
// checkRegistry(root) -> string[]: domain CLI (cli/ + plugins/ + tools/) khai bao dung, script ton tai, default=run co timeout.
import fs from 'node:fs';
import path from 'node:path';
import { KIND_RULES } from '../config/contract.mjs';
import { toPosix } from '../io/paths.mjs';
import { loadHarnessRegistry } from '../registry/plugin-registry.mjs';

const LIMIT = 500; // gioi han so muc quet moi thu muc
const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).slice(0, LIMIT); } catch { return []; } };

// JSON hop le (parse duoc, object/mang). Object rong "{}" KHONG hop le (che luat).
function jsonNonEmpty(f) {
  try {
    const t = fs.readFileSync(f, 'utf8');
    const j = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
    return !!j && typeof j === 'object' && Object.keys(j).length > 0;
  } catch { return false; }
}
const fileNonEmpty = (f) => { try { return fs.statSync(f).size > 0; } catch { return false; } };

// hook hop le neu co: JSON khong rong, defaults.mjs khong rong, hoac adapters/ co it nhat 1 file adapter
function hookHasConfig(dir, files) {
  if (files.some((f) => /\.json$/.test(f) && jsonNonEmpty(path.join(dir, f)))) return true;
  if (files.includes('defaults.mjs') && fileNonEmpty(path.join(dir, 'defaults.mjs'))) return true;
  return ls(path.join(dir, 'adapters')).some((e) => e.isFile() && /\.(mjs|json)$/.test(e.name) && fileNonEmpty(path.join(dir, 'adapters', e.name)));
}

const norm = toPosix;
// file .mjs (khong test) duoc manifest khai bao: entry, helpers, file cua domains, config.defaults
function declared(m) {
  const set = new Set([m.entry, ...((m.files && m.files.helpers) || []), m.config && m.config.defaults]);
  for (const v of Object.values(m.domains || {})) set.add(typeof v === 'string' ? v : v.file);
  return new Set([...set].filter(Boolean).map((x) => path.posix.normalize(norm(x))));
}

export function checkManifest(root) {
  const w = [];
  const hd = path.join(root, 'harness');
  const reg = loadHarnessRegistry({ harnessDir: hd });
  for (const e of reg.errors) w.push(`manifest: ${e}`);
  const dirs = new Set(reg.manifests.map((m) => m.dir));
  // nhom hook: can manifest, README.md va config JSON hoac defaults (bo qua thu muc bat dau bang "_")
  const hooksDir = path.join(hd, 'hooks');
  for (const d of ls(hooksDir)) {
    if (!d.isDirectory()) continue;
    const rel = `harness/hooks/${d.name}`;
    if (!d.name.startsWith('_')) {
      const files = ls(path.join(hooksDir, d.name)).map((e) => e.name);
      if (KIND_RULES.hook.includes('README') && !files.includes('README.md')) w.push(`hook ${d.name}: thieu README.md`);
      if (KIND_RULES.hook.includes('defaults-or-hook-config-non-empty') && !hookHasConfig(path.join(hooksDir, d.name), files)) w.push(`hook ${d.name}: thieu config JSON/defaults.mjs khong rong hoac adapter hop le`);
    }
    if (!dirs.has(rel) && !fs.existsSync(path.join(hooksDir, d.name, 'manifest.json'))) w.push(`chua co manifest.json: ${rel}`);
  }
  for (const z of ['plugins', 'tools']) {
    for (const d of ls(path.join(hd, z))) {
      if (d.isDirectory() && !fs.existsSync(path.join(hd, z, d.name, 'manifest.json'))) w.push(`chua co manifest.json: harness/${z}/${d.name}`);
    }
  }
  // moi manifest: entry/helpers ton tai; file .mjs trong thu muc (khong de quy) phai duoc khai bao (tru test, defaults.mjs)
  for (const m of reg.manifests) {
    const abs = path.join(root, m.dir);
    const dec = declared(m);
    for (const f of dec) if (!fs.existsSync(path.join(abs, f))) w.push(`manifest ${m.dir}: file khai bao khong ton tai: ${f}`);
    if (m.kind === 'hook') continue; // hook: clutter-check lo file mo coi
    for (const e of ls(abs)) {
      if (e.isFile() && /\.mjs$/.test(e.name) && !/\.test\.mjs$/.test(e.name) && !dec.has(e.name) && e.name !== 'defaults.mjs') w.push(`chua co trong manifest: ${m.dir}/${e.name}`);
    }
  }
  return w;
}

export function checkRegistry(root) {
  const w = [];
  const reg = loadHarnessRegistry({ harnessDir: path.join(root, 'harness') });
  // shim co timeout mac dinh khi spawn? (kiem bang nguon harness.mjs)
  let shimTimeout = false;
  try {
    const src = fs.readFileSync(path.join(root, 'harness', 'cli', 'harness.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const m = /DEFAULT_TIMEOUT_S\s*=\s*(\d+)/.exec(src);
    shimTimeout = (m ? Number(m[1]) > 0 : false) || /\btimeout:\s*(?!0\b)[\w(]/.test(src);
  } catch { /* ignore */ }
  for (const [k, meta] of Object.entries(reg.meta)) {
    if (meta.default === 'run' && !shimTimeout) w.push(`domain ${k}: default=run thieu timeout (shim khong co timeout mac dinh)`);
  }
  return w;
}
