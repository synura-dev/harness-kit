// harness agy init [--dir <du an>] : kiem plugin harness-kit (native) da cai cho du an chua (khong ghi file) + canh bao .agents/hooks.json cu co khoa "harness-kit" (hook doi).
// harness agy rules [--print] : in rule allow de xuat cho ~/.gemini/antigravity-cli/settings.json (khong ghi). --apply: chi khi TTY + go "yes", sao luu .bak-<ngay>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';

export const HOOK_KEY = 'harness-kit';
export const RULES = Object.freeze(['command(harness)']);
export const CLONE_URL = 'https://github.com/synura-dev/harness-kit.git';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const parse = (s) => JSON.parse(String(s).replace(/^\uFEFF/, ''));

/** native: plugin harness-kit da cai chua? Dat khi (a) <du an>/.agents/plugins/harness-kit/.antigravity-plugin/plugin.json ton tai (project scope, uu tien)
 *  HOAC (b) `agy plugin list --json` (global; mang {name, enabled,...}) co harness-kit enabled. + canh bao hooks.json cu cua du an (hook doi).
 *  inj.list = () => stdout JSON (test). Khong ghi file. -> { code, lines } */
export function native({ dir, inj = {} } = {}) {
  const lines = [];
  let code = 0;
  const pdir = path.join(dir, '.agents', 'plugins', 'harness-kit');
  const project = fs.existsSync(path.join(pdir, '.antigravity-plugin', 'plugin.json'));
  let installed = null;
  let disabled = false;
  if (!project) {
    try {
      const out = inj.list ? inj.list() : spawnSync('agy', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }).stdout;
      const j = JSON.parse(String(out || ''));
      // agy 1.5.2: JSON array [{name, enabled, version, path, skills...}]; chi liet ke plugin GLOBAL
      const arr = Array.isArray(j) ? j : (j && (j.plugins || j.items)) || [];
      const me = arr.find((p) => (p && typeof p === 'object' ? p.name === 'harness-kit' : p === 'harness-kit'));
      installed = !!me;
      if (me && typeof me === 'object' && me.enabled === false) disabled = true;
    } catch { /* khong co agy / khong parse duoc */ }
  }
  if (project) lines.push('[OK] plugin harness-kit da cai cho du an (.agents/plugins/harness-kit)', `-> cap nhat: git -C "${pdir}" pull`);
  else if (installed === true && disabled) { code = 1; lines.push('[warn] plugin harness-kit (global) da cai nhung dang tat (enabled=false) -> hook khong chay', '-> chay: agy plugin enable harness-kit'); }
  else if (installed === true) lines.push('[OK] agy da cai plugin harness-kit (global)');
  else { code = 1; lines.push('[THIEU] chua cai plugin harness-kit cho du an', `-> chay: git clone ${CLONE_URL} "${pdir}"`, '-> them dong `plugins/` vao .agents/.gitignore', `-> cap nhat sau nay: git -C "${pdir}" pull`); }
  const raw = read(path.join(dir, '.agents', 'hooks.json'));
  if (raw && /"harness-kit"/.test(raw)) lines.push(`[warn] ${path.join(dir, '.agents', 'hooks.json')} con khoa "${HOOK_KEY}" cu -> hook chay doi khi plugin da cai; xoa khoa do (va .agents/harness-agy-shim.mjs, .agents/harness-agy.local.json) bang tay`);
  return { code, lines };
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
