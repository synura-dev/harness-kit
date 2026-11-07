// harness agy init [--dir <du an>] : kiem plugin harness-kit (native) da cai GLOBAL trong agy + du an da bat chua (khong ghi file) + canh bao .agents/hooks.json cu co khoa "harness-kit" (hook doi).
// harness agy rules [--print] : in rule allow de xuat cho ~/.gemini/antigravity-cli/settings.json (khong ghi). --apply: chi khi TTY + go "yes", sao luu .bak-<ngay>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { enabledIn } from '../../hooks/dispatch/agy-native.mjs';

export const HOOK_KEY = 'harness-kit';
export const RULES = Object.freeze(['command(harness)']);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const parse = (s) => JSON.parse(String(s).replace(/^\uFEFF/, ''));

/** native: cai GLOBAL (`agy plugin install <goc plugin>`, nguon = cache Claude). OK khi `agy plugin list --json` (mang {name, enabled, version, path}) co harness-kit enabled;
 *  canh bao khi version != .claude-plugin/plugin.json cua plugin dang chay. Bao them du an nay da bat plugin chua (cong agy-native: enabledPlugins["harness-kit@..."] = true trong .claude/settings*.json)
 *  + canh bao ban clone cu .agents/plugins/harness-kit (hook chay doi voi global) va .agents/hooks.json cu. inj.list/inj.root/inj.version de test. Khong ghi file. -> { code, lines } */
export function native({ dir, inj = {} } = {}) {
  const lines = [];
  let code = 0;
  const root = inj.root || PLUGIN_ROOT;
  let mine = inj.version;
  if (mine === undefined) { try { mine = parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { mine = null; } }
  let me = null;
  try {
    const out = inj.list ? inj.list() : spawnSync('agy', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }).stdout;
    const j = JSON.parse(String(out || ''));
    const arr = Array.isArray(j) ? j : (j && (j.plugins || j.items)) || [];
    me = arr.find((p) => (p && typeof p === 'object' ? p.name === 'harness-kit' : p === 'harness-kit')) || null;
  } catch { /* khong co agy / khong parse duoc */ }
  if (!me) { code = 1; lines.push('[THIEU] agy chua cai plugin harness-kit (global)', `-> chay: agy plugin install "${root}"`); }
  else if (typeof me === 'object' && me.enabled === false) { code = 1; lines.push('[warn] plugin harness-kit (global) da cai nhung dang tat (enabled=false) -> hook khong chay', '-> chay: agy plugin enable harness-kit'); }
  else {
    lines.push('[OK] agy da cai plugin harness-kit (global)');
    if (typeof me === 'object' && mine && me.version && me.version !== mine) lines.push(`[warn] ban cai trong agy ${me.version} != plugin nay ${mine} -> cai lai: agy plugin install "${root}" (hook SessionStart cua Claude tu cap nhat khi mo phien; tat: HARNESS_AGY_AUTOSYNC=0)`);
  }
  if (enabledIn(dir)) lines.push('[OK] du an nay da bat harness-kit (enabledPlugins trong .claude/settings*.json)');
  else { code = 1; lines.push('[THIEU] du an nay chua bat harness-kit -> hook agy khong chay o day', '-> them vao .claude/settings.json: "enabledPlugins": { "harness-kit@synura": true }'); }
  const clone = path.join(dir, '.agents', 'plugins', 'harness-kit');
  if (fs.existsSync(clone)) lines.push(`[warn] con ban clone theo du an ${clone} -> hook chay doi voi ban global; xoa thu muc do`);
  const lw = legacyHooksWarn(dir);
  if (lw) lines.push(lw);
  return { code, lines };
}

/** Canh bao khi .agents/hooks.json cu con khoa "harness-kit" (hook chay doi khi plugin da cai) -> chuoi | null. */
export function legacyHooksWarn(dir) {
  const f = path.join(dir, '.agents', 'hooks.json');
  const raw = read(f);
  return raw && /"harness-kit"/.test(raw) ? `[warn] ${f} con khoa "${HOOK_KEY}" cu -> hook chay doi khi plugin da cai; xoa khoa do (va .agents/harness-agy-shim.mjs, .agents/harness-agy.local.json) bang tay` : null;
}

export const agySettingsFile = (home = os.homedir()) => path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
export function missingRules(settings) {
  const allow = (settings && settings.permissions && Array.isArray(settings.permissions.allow)) ? settings.permissions.allow : [];
  return RULES.filter((r) => !allow.includes(r));
}

async function rules(apply) {
  const f = agySettingsFile();
  let s = null;
  try { s = parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { console.error(`[LOI] khong doc duoc ${f}: ${e.message}`); return 1; } }
  const miss = missingRules(s);
  console.log(`settings agy: ${f}`);
  console.log(`de xuat permissions.allow: ${JSON.stringify(RULES)}`);
  console.log(miss.length ? `thieu: ${JSON.stringify(miss)}` : '[OK] da co du');
  if (!apply || !miss.length) { if (miss.length) console.log('-> khong tu ghi; chay `harness agy rules --apply` trong terminal (TTY) neu dong y'); return 0; }
  if (!process.stdin.isTTY) { console.error('[CHAN] --apply can TTY va go "yes"; khong ghi'); return 2; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((r) => rl.question(`Them ${JSON.stringify(miss)} vao ${f}? go yes: `, (a) => { rl.close(); r(a); }));
  if (String(ans).trim() !== 'yes') { console.log('huy'); return 0; }
  const d = new Date(); const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak-${stamp}`);
  const next = s && typeof s === 'object' ? s : {};
  next.permissions = next.permissions || {};
  next.permissions.allow = [...(Array.isArray(next.permissions.allow) ? next.permissions.allow : []), ...miss];
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(next, null, 2) + '\n');
  console.log(`[ghi] ${f} (sao luu .bak-${stamp})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const sub = a[0] && !a[0].startsWith('--') ? a[0] : 'index';
  const di = a.indexOf('--dir');
  const dir = path.resolve(di >= 0 && a[di + 1] ? a[di + 1] : (process.env.CLAUDE_PROJECT_DIR || '').trim() || process.cwd());
  if (sub === 'init') { const r = native({ dir }); console.log(`du an: ${dir}`); for (const l of r.lines) console.log(l); process.exit(r.code); }
  else if (sub === 'rules') process.exit(await rules(a.includes('--apply')));
  else { console.log('harness agy init [--dir <du an>] | rules [--print|--apply]'); process.exit(sub === 'index' ? 0 : 2); }
}
