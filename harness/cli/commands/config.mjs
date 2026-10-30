// harness/cli/commands/config.mjs - doc-only: cac lop nguon config. Usage: config.mjs show [tool|guard] [id] [--raw] [--max-bytes N] [--timeout-s N]
// Che gia tri khoa co ten chua token/key/secret/password.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot, samePath } from '../../core/io/paths.mjs';
import { parseCommon, emit } from '../../core/io/out.mjs';
import { loadConfig } from '../../core/config/config.mjs';

// Quy uoc: tach ten khoa theo camelCase/_/-/. thanh tu; che neu 1 tu thuoc SECRET_WORDS hoac ket thuc bang token/secret/password/apikey/credential (so nhieu ok); "keyboard" khong bi che.
const SECRET_WORDS = new Set(['token', 'key', 'secret', 'password', 'passwd', 'auth', 'authorization', 'credential', 'credentials', 'cookie', 'bearer', 'pat', 'session', 'keys', 'tokens', 'secrets']);
function isSecretKey(k) {
  const words = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => SECRET_WORDS.has(w) || /(token|secret|password|passwd|apikey|credential)s?$/.test(w));
}
// inSecret: dang trong gia tri cua khoa secret -> che moi gia tri la (ke ca mang/object long nhau).
export function redactConfig(v, inSecret = false) {
  if (Array.isArray(v)) return v.map((x) => redactConfig(x, inSecret));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactConfig(x, inSecret || isSecretKey(k))]));
  return inSecret && v !== null ? '***' : v;
}
const NOPARSE = (f) => `(khong parse duoc, khong in de tranh lo secret) ${f}`;
const redactText = (t, f) => { try { return JSON.stringify(redactConfig(JSON.parse(t)), null, 2); } catch { return NOPARSE(f); } };

export function layers(cfg, kind, id) {
  const L = [];
  const add = (rel, role) => L.push({ file: rel, role, exists: fs.existsSync(path.join(cfg, rel)) });
  if (!kind || kind === 'tool') ['manifest.json', 'tools.json'].forEach((f) => add(f, 'base'));
  const sub = (d) => { try { return fs.readdirSync(path.join(cfg, d)).filter((n) => !id || n.includes(id)).map((n) => `${d}/${n}`); } catch { return []; } };
  if (!kind || kind === 'guard') sub('guard').forEach((f) => add(f, 'guard'));
  try { fs.readdirSync(cfg).filter((n) => /\.local\.json$/.test(n) && (!id || n.includes(id))).forEach((f) => add(f, 'local')); } catch {}
  return L;
}

export function run(argv, { cfgDir = path.join(workspaceRoot(), 'config'), emitOpts = {} } = {}) {
  const c = parseCommon(argv);
  const [cmd, kind, id] = c.rest;
  const err = emitOpts.err || console.error;
  if (cmd === 'sources') {
    // S7: doc qua core/config/config.mjs; in tang nguon theo khoa (KHONG in gia tri), canh bao legacy.
    if (!kind) { err('usage: config.mjs sources <tool> [project] [--json]'); return { code: 2 }; }
    const r = loadConfig(kind, { root: path.dirname(cfgDir), configDir: cfgDir, project: id });
    const rows = Object.entries(r.sources).map(([k, s]) => ({ key: k, source: s }));
    const summary = [...rows.map((x) => `${x.key} <- ${x.source}`), ...r.warnings.map((w) => `! ${w}`)].join('\n') || '(none)';
    return { code: 0, ...emit({ summary, data: { sources: r.sources, warnings: r.warnings }, raw: '', truncated: null }, { json: c.json, raw: false, maxBytes: c.maxBytes || 65536, ...emitOpts }) };
  }
  if (cmd !== 'show' || (kind && !['tool', 'guard'].includes(kind))) { err('usage: config.mjs show [tool|guard] [id] [--raw] [--max-bytes N] [--timeout-s N] [--json]'); return { code: 2 }; }
  const o = { json: c.json, raw: c.raw, maxBytes: c.maxBytes || 65536, ...emitOpts };
  const t0 = Date.now(), tmo = (c.timeoutS || 10) * 1000;
  const L = layers(cfgDir, kind, id);
  let truncated = null, raw = '';
  for (const l of L) {
    if (!l.exists) continue;
    if (Date.now() - t0 > tmo) { truncated = 'timeout'; break; }
    const f = path.join(cfgDir, l.file);
    try { if (fs.statSync(f).isFile()) raw += `# ${l.file}\n${redactText(fs.readFileSync(f, 'utf8').slice(0, 262144), l.file)}\n\n`; } catch {}
  }
  const summary = L.map((l) => `${l.exists ? '[x]' : '[ ]'} ${l.file} (${l.role})`).join('\n') || '(none)';
  return { code: 0, ...emit({ summary, data: L, raw, truncated }, o) };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exit(run(process.argv.slice(2)).code);
