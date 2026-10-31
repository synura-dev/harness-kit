// harness agy init [--check] [--dir <du an>] : sinh/GOP <du an>/.agents/hooks.json (khoa rieng "harness-kit"), chep shim .agents/harness-agy-shim.mjs,
//   ghi .agents/harness-agy.local.json {pluginRoot} (theo may, gitignored qua .agents/.gitignore). Lenh trong hooks.json: `node ./harness-agy-shim.mjs <Event>`
//   (tuong doi; cwd hook agy = .agents/ VERIFIED). Ly do khong dung %USERPROFILE%/$HOME/~ trong command: xem harness/hooks/README.md (muc agy).
//   Giu moi hook khac; bo block cu "harness" chi khi MOI lenh cua no la dispatcher agy (launcher cu). --check: chi bao lech, exit 1 neu lech.
// harness agy rules [--print] : in rule allow de xuat cho ~/.gemini/antigravity-cli/settings.json (khong ghi). --apply: chi khi TTY + go "yes", sao luu .bak-<ngay>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const HOOK_KEY = 'harness-kit';
export const SHIM = 'harness-agy-shim.mjs';
export const LOCAL = 'harness-agy.local.json';
export const RULES = Object.freeze(['command(node ./.agents/harness-agy-shim.mjs)', 'command(harness)']);
/** Lenh CLI cho agy trong brief/rules mau: khong PATH, khong launcher (shim sinh boi harness agy init). */
export const CLI_PREFIX = `node ./.agents/${SHIM} cli`;
export const cliHint = (cmd = '<domain> [lenh]') => `${CLI_PREFIX} ${cmd}`;
export const FIX_COMMAND = 'harness agy init';
const PRE_MATCH = 'run_command|write_file|edit_file';
const POST_MATCH = 'run_command|write_file|edit_file|read_file|view_file|call_mcp_tool|send_message|invoke_subagent|mcp_.*';

const h = (ev, timeout = 5) => ({ type: 'command', command: `node ./${SHIM} ${ev}`, timeout });
export function buildBlock() {
  return {
    SessionStart: [h('SessionStart', 10)],
    PreToolUse: [{ matcher: PRE_MATCH, hooks: [h('PreToolUse')] }],
    PostToolUse: [{ matcher: POST_MATCH, hooks: [h('PostToolUse')] }],
    PostInvocation: [h('PostInvocation')],
    Stop: [h('Stop')],
  };
}

const cmdsOf = (spec) => {
  const out = [];
  for (const [ev, list] of Object.entries(spec || {})) {
    if (ev === 'enabled' || !Array.isArray(list)) continue;
    for (const it of list) for (const x of Array.isArray(it && it.hooks) ? it.hooks : [it]) out.push(String((x && x.command) || ''));
  }
  return out;
};
const isLegacy = (spec) => { const c = cmdsOf(spec); return c.length > 0 && c.every((s) => /dispatch[\\/]agy\.mjs|harness-agy-shim\.mjs/.test(s)); };

/** Gop thuan: existing (object|null) -> { json, changes:[string] }. Khong dung hook khac. */
export function mergeHooks(existing) {
  const j = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const changes = [];
  if (j.harness && isLegacy(j.harness)) { delete j.harness; changes.push('bo block "harness" cu (launcher dispatcher agy)'); }
  const want = buildBlock();
  if (JSON.stringify(j[HOOK_KEY]) !== JSON.stringify(want)) { changes.push(j[HOOK_KEY] ? `cap nhat khoa "${HOOK_KEY}"` : `them khoa "${HOOK_KEY}"`); j[HOOK_KEY] = want; }
  return { json: j, changes };
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const parse = (s) => JSON.parse(String(s).replace(/^﻿/, ''));

/** init: { dir, check, pluginRoot } -> { code, lines } */
export function init({ dir, check = false, pluginRoot = PLUGIN } = {}) {
  const ag = path.join(dir, '.agents');
  const lines = [];
  const hooksFile = path.join(ag, 'hooks.json');
  const raw = read(hooksFile);
  let cur = null;
  if (raw != null && raw.trim()) { try { cur = parse(raw); } catch (e) { return { code: 1, lines: [`[LOI] ${hooksFile} khong parse duoc (${e.message}); khong ghi de, sua tay roi chay lai`] }; } }
  const { json, changes } = mergeHooks(cur);
  const shimSrc = fs.readFileSync(path.join(PLUGIN, 'harness', 'hooks', 'dispatch', 'agy-shim.mjs'), 'utf8');
  const shimFile = path.join(ag, SHIM);
  if (read(shimFile) !== shimSrc) changes.push(`${read(shimFile) == null ? 'tao' : 'cap nhat'} .agents/${SHIM}`);
  const localFile = path.join(ag, LOCAL);
  const local = (() => { try { return parse(read(localFile)); } catch { return null; } })();
  const wantRoot = path.resolve(pluginRoot);
  if (!local || local.pluginRoot !== wantRoot) changes.push(`ghi .agents/${LOCAL} (pluginRoot theo may)`);
  const giFile = path.join(ag, '.gitignore');
  const gi = read(giFile) || '';
  const giOk = gi.split(/\r?\n/).some((l) => l.trim() === LOCAL);
  if (!giOk) changes.push(`.agents/.gitignore them ${LOCAL}`);
  if (check) return { code: changes.length ? 1 : 0, lines: changes.length ? changes.map((c) => '[lech] ' + c).concat('-> chay: harness agy init') : ['[OK] .agents/hooks.json + shim agy khop'] };
  fs.mkdirSync(ag, { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify(json, null, 2) + '\n');
  if (read(shimFile) !== shimSrc) fs.writeFileSync(shimFile, shimSrc);
  fs.writeFileSync(localFile, JSON.stringify({ pluginRoot: wantRoot }, null, 2) + '\n');
  if (!giOk) fs.writeFileSync(giFile, gi + (gi && !gi.endsWith('\n') ? '\n' : '') + LOCAL + '\n');
  lines.push(...(changes.length ? changes.map((c) => '[ghi] ' + c) : ['[OK] khong doi']));
  return { code: 0, lines };
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
  if (sub === 'init') { const r = init({ dir, check: a.includes('--check') }); console.log(`du an: ${dir}`); for (const l of r.lines) console.log(l); process.exit(r.code); }
  else if (sub === 'rules') process.exit(await rules(a.includes('--apply')));
  else { console.log('harness agy init [--check] [--dir <du an>] | rules [--print|--apply]'); process.exit(sub === 'index' ? 0 : 2); }
}
