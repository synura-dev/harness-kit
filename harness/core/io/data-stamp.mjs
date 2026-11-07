// Stamp ban ghi du lieu theo CLI: <dataRoot>/.harness-writers.json { "<tool>": {version, schema, at} }. Moi CLI chi cap nhat khoa cua minh luc SessionStart.
// Chi version/schema/at (khong ghi input nguoi dung/args). Khong nem loi (fail-open). Doctor doc + canh bao lech (khong chan).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_SCHEMA = 1;
export const STAMP_FILE = '.harness-writers.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANIFEST = { claude: '.claude-plugin', agy: '.antigravity-plugin' };

/** Doc stamp; file vang/hong/khong phai object -> {}. */
export function readStamps(dataRoot) {
  try {
    const t = fs.readFileSync(path.join(dataRoot, STAMP_FILE), 'utf8');
    const j = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/** Ghi CHI khoa cua tool; giu khoa khac + truong la. Tra true neu ghi duoc. */
export function writeStamp(dataRoot, { tool, version, schema = DATA_SCHEMA, now = Date.now() }) {
  const f = path.join(dataRoot, STAMP_FILE); const tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const own = { version: String(version), schema, at: new Date(now).toISOString() };
    fs.writeFileSync(tmp, JSON.stringify({ ...readStamps(dataRoot), [tool]: own })); // doc lai ngay truoc khi ghi tmp+rename (giam mat khoa tool kia khi 2 SessionStart dong thoi)
    fs.renameSync(tmp, f);
    return true;
  } catch { try { fs.unlinkSync(tmp); } catch {} return false; }
}

const semver = (v) => String(v).split('-')[0].split('.').map((x) => Number(x) || 0);
/** So semver so (0.10.0 > 0.3.12); thieu phan = 0. */
export function cmpVersion(a, b) {
  const x = semver(a); const y = semver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

/** self {tool?, version, schema}; stamps = readStamps(). -> danh sach canh bao (chuoi) cho khoa tool KHAC co schema/version moi hon. */
export function compareStamps(self, stamps) {
  const out = [];
  for (const [tool, s] of Object.entries(stamps || {})) {
    if (tool === self.tool || !s || typeof s !== 'object') continue;
    if (Number(s.schema) > Number(self.schema)) out.push(`${tool} ghi schema ${s.schema} > ${self.schema} (nang cap ban nay)`);
    if (s.version !== undefined && cmpVersion(s.version, self.version) > 0) out.push(`${tool} version ${s.version} > ${self.version} (nen cap nhat)`);
  }
  return out;
}

/** Version cua plugin theo manifest cua tool trong goc plugin; khong co -> ''. */
export function pluginVersion(tool, root = ROOT) {
  try { return String(JSON.parse(fs.readFileSync(path.join(root, MANIFEST[tool], 'plugin.json'), 'utf8')).version || ''); } catch { return ''; }
}

/** Diem goi SessionStart: ghi stamp cua `tool` (version tu manifest). Khong nem; khong co manifest -> false. */
export function stampSession(tool, { dataRoot, root = ROOT, now } = {}) {
  try {
    const version = pluginVersion(tool, root);
    if (!version || !dataRoot) return false;
    return writeStamp(dataRoot, { tool, version, now });
  } catch { return false; }
}
