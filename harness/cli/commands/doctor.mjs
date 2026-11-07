// node harness/cli/commands/doctor.mjs  — read-only checks; prints hooks block for THIS machine. Never writes settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from '../../core/runtime/proc.mjs';
import { fileURLToPath } from 'node:url';
import { ver } from '../../core/runtime/proc-list.mjs';
import { parseCommon, emit } from '../../core/io/out.mjs';
import { workspaceRoot, resolveHub, isInside, REPO_DIR, findBadLinks, findBadHookCommands, walkAgyHooks, isPluginMode, workspaceMarker } from '../../core/io/paths.mjs';

// --json: gom cac dong `[level] name - detail` thanh {checks:[{level,name,detail}]}; khoi hook mau (khong co tien to) bo qua.
const JSON_MODE = process.argv.includes('--json');
const jsonChecks = [];
const t = setTimeout(() => {
  console.error('timeout');
  if (JSON_MODE) process.stdout.write(JSON.stringify({ checks: jsonChecks, exit_code: 2, error: 'timeout' }, null, 2) + '\n');
  process.exit(2);
}, Number(process.env.HARNESS_DOCTOR_TIMEOUT_MS) || 20000);
if (JSON_MODE) {
  console.log = (...a) => {
    for (const ln of a.join(' ').split('\n')) {
      const m = /^\[([^\]]+)\]\s*(.*)$/.exec(ln);
      if (!m) continue;
      const i = m[2].indexOf(' - ');
      jsonChecks.push({ level: m[1] === '--' ? 'na' : m[1].toLowerCase(), name: i < 0 ? m[2] : m[2].slice(0, i), detail: i < 0 ? '' : m[2].slice(i + 3) });
    }
  };
}
const groupWarn = {};
const warn = (group, ...m) => { groupWarn[group] = (groupWarn[group] || 0) + 1; console.log('[warn]', ...m); };
const line = (ok, label, extra = '') => { if (ok === false) process.exitCode = 1; console.log(`${ok === true ? '[OK]  ' : ok === false ? '[MISS]' : '[--]  '} ${label}${extra ? ' - ' + extra : ''}`); };

const major = Number(process.versions.node.split('.')[0]);
line(major >= 18, `node ${process.versions.node}`, major >= 18 ? '' : 'can >= 18');
const bun = ver('bun');
line(bun ? true : null, 'bun', bun || 'tuy chon, khong co');
const duck = ver('duckdb');
line(duck ? true : null, 'duckdb', duck || 'tuy chon, khong co');

const HUB_ROOT = workspaceRoot();
// workspace mode: workspace (CLAUDE_PROJECT_DIR/hub) khac plugin root -> loi harness nam o plugin, khong trong workspace
const WS_MODE = path.resolve(HUB_ROOT).toLowerCase() !== path.resolve(REPO_DIR).toLowerCase();
// du an thuong (BARE): workspace mode + khong co dau hieu hub (config/{workspace,hub}/default.json) -> bo cac kiem gia dinh hub
const BARE = WS_MODE && !workspaceMarker(HUB_ROOT);
const hub = resolveHub();
console.log(`[info] hubDir = ${hub.hubDir} (nguon: ${hub.source})`);
if (BARE) console.log('[skip] hubDir/arch/adapter manifest: du an thuong (khong dau hieu hub), bo kiem gia dinh hub');
else if (!isInside(REPO_DIR, hub.hubDir)) console.log(`[warn] repo (${REPO_DIR}) nam ngoai hubDir; kiem tra HUB_DIR/config/paths.local.json`);
// workspace co dau hieu ma con <ws>/.harness/data (du lieu lac do code nap loi khong qua wrapper, truoc fix) -> canh bao 1 dong + lenh sua
if (workspaceMarker(HUB_ROOT) && fs.existsSync(path.join(HUB_ROOT, '.harness', 'data'))) console.log(`[warn] ${path.join(HUB_ROOT, '.harness', 'data')} ton tai nhung du lieu workspace nam o <ws>/data - sua: harness data adopt --legacy-harness [--yes]`);
for (const b of findBadLinks(path.join(HUB_ROOT, '.claude', 'skills'), HUB_ROOT)) {
  line(false, `link .claude/skills/${b.name} ${b.problem === 'hong' ? 'hong' : 'tro ngoai hubDir'}`, `${b.target}`);
}
try {
  const hj = JSON.parse(fs.readFileSync(path.join(HUB_ROOT, '.agents', 'hooks.json'), 'utf8'));
  for (const p of walkAgyHooks(hj).problems) line(false, '.agents/hooks.json schema agy', p);
} catch (e) {
  if (e && e.code !== 'ENOENT') { process.exitCode = 1; console.log('[LOI]   .agents/hooks.json khong doc/parse duoc - ' + (e.message || e)); }
}
{ const { legacySummary } = await import('../../core/agy/legacy.mjs'); const w = legacySummary(HUB_ROOT); if (w) console.log(w); }
for (const b of findBadHookCommands(path.join(HUB_ROOT, '.agents', 'hooks.json'), HUB_ROOT)) {
  const why = b.problem === 'ngoai-hub' ? 'tro ngoai hubDir' : b.problem === 'agents-prefix' ? 'command bat dau bang .agents/ (agy cwd = .agents/, dung "node ../harness/hooks/...")' : 'duong dan tuyet doi';
  line(false, `.agents/hooks.json ${why}`, b.command);
}

// du an (registry/verify) thuoc hub tooling: kiem bang `node harness/cli/harness.mjs projects check` (doctor chi kiem harness, khong import hub)

// hook dispatcher (settings.json -> hooks/dispatch/run.mjs <Event>; audit la module cua dispatcher)
// Plugin: chay o che do plugin (plugin.json o goc ma), co CLAUDE_PLUGIN_ROOT, hoac truyen --plugin-dir <p> -> hook den tu plugin, khong doi hook trong settings.
// Gioi han: doctor khong thay duoc plugin nap bang --plugin-dir cua phien claude khac; chi canh bao khi chac chan thieu.
const pdIdx = process.argv.indexOf('--plugin-dir');
const pluginDirArg = pdIdx > 0 ? process.argv[pdIdx + 1] : null;
const pluginLoaded = isPluginMode() || !!process.env.CLAUDE_PLUGIN_ROOT || !!pluginDirArg;
const enabledGuardPlugin = (() => {
  for (const f of [path.join(HUB_ROOT, '.claude', 'settings.json'), path.join(HUB_ROOT, '.claude', 'settings.local.json'), path.join(os.homedir(), '.claude', 'settings.json')]) {
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); if (Object.keys(j.enabledPlugins || {}).some((k) => /(?:harness-kit|agent-guard-kit)/.test(k) && j.enabledPlugins[k])) return true; } catch {}
  }
  try { if (/(?:harness-kit|agent-guard-kit)/.test(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'))) return true; } catch {}
  return false;
})();
const pluginSeen = pluginLoaded || enabledGuardPlugin;
const dispatchPath = path.join(isPluginMode() ? REPO_DIR : HUB_ROOT, 'harness', 'hooks', 'dispatch', 'run.mjs');
line(fs.existsSync(dispatchPath), 'hooks/dispatch/run.mjs ton tai');
// Launcher (bin/harness.mjs hook <Event>): hook tro launcher thay vi dispatch/run.mjs. Tim plugin theo cung thu tu voi launcher (env -> launcher.local.json -> installed_plugins.json).
const LAUNCHER_HOOK_RE = /bin[\\/]harness\.mjs"?\s+hook\s+[A-Za-z]+/;
function findLauncherPlugin() {
  const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
  const okRoot = (r) => { if (!r) return false; const m = rj(path.join(path.resolve(String(r)), '.claude-plugin', 'plugin.json')); return !!m && ['harness-kit', 'agent-guard-kit', 'harness-plugin'].includes(m.name) && fs.existsSync(path.join(path.resolve(String(r)), 'harness', 'cli', 'harness.mjs')); };
  const env = process.env.HARNESS_PLUGIN_DIR || process.env.HARNESS_PLUGIN_ROOT;
  if (env) return okRoot(env) ? { ok: true, how: 'env' } : { ok: false, why: 'HARNESS_PLUGIN_DIR sai/khong hop le' };
  const loc = rj(path.join(HUB_ROOT, 'config', 'launcher.local.json'));
  if (loc && loc.pluginRoot) return okRoot(loc.pluginRoot) ? { ok: true, how: 'config/launcher.local.json' } : { ok: false, why: 'launcher.local.json pluginRoot sai/khong tim thay plugin' };
  const reg = rj(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'));
  for (const [k, list] of Object.entries((reg && reg.plugins) || {})) if (/^(harness-kit|agent-guard-kit|harness-plugin)@/.test(k) && Array.isArray(list) && list.some((e) => okRoot(e && e.installPath))) return { ok: true, how: 'installed_plugins.json' };
  return { ok: false, why: 'khong tim thay plugin harness-kit' };
}
/** Rule Write(...) trong permissions.{allow,deny,ask} -> [{kind, rule, fix}] (fix = Edit(...)). Thuan. */
function writeRules(st) {
  const out = [];
  for (const kind of ["deny", "allow", "ask"]) for (const r of (st && st.permissions && Array.isArray(st.permissions[kind]) ? st.permissions[kind] : [])) if (String(r).startsWith('Write(')) out.push({ kind, rule: r, fix: "Edit" + String(r).slice(5) });
  return out;
}
const lowerPosix =(s) => String(s).replace(/\\/g, '/').toLowerCase();
const projectSettingsFile = path.join(HUB_ROOT, '.claude', 'settings.json');
try {
  const txt = fs.readFileSync(projectSettingsFile, 'utf8');
  const st = JSON.parse(txt.charCodeAt(0) === 0xfeff ? txt.slice(1) : txt);
  const cmds = [];
  for (const [ev, arr] of Object.entries(st.hooks || {})) {
    for (const g of arr || []) for (const h of g.hooks || []) if (h.command && /^\s*node\s/.test(h.command) && (/dispatch[\\/]run\.mjs/.test(h.command) || LAUNCHER_HOOK_RE.test(h.command))) cmds.push([ev, h.command]);
  }
  // Claude Code bo qua rule Write(...) trong permissions (tool ghi/sua file khop rule Edit(...)) -> rule Write khong co tac dung.
  for (const r of writeRules(st)) warn("settings", `.claude/settings.json permissions.${r.kind} "${r.rule}": Claude bo qua Write(...); doi thanh "${r.fix}"`);
  const launcherCmds = cmds.filter(([, c]) => LAUNCHER_HOOK_RE.test(c));
  if (launcherCmds.length) {
    const lp = findLauncherPlugin();
    line(lp.ok, 'launcher bin/harness.mjs: plugin harness', lp.ok ? `${launcherCmds.length} hook qua launcher, plugin: ${lp.how}` : lp.why + ' (thieu plugin: PreToolUse bi chan exit 2, hook khac exit 3; cai plugin harness-kit, dat HARNESS_PLUGIN_DIR hoac config/launcher.local.json {"pluginRoot"})');
    line(fs.existsSync(path.join(HUB_ROOT, 'bin', 'harness.mjs')), 'bin/harness.mjs ton tai');
  }
  const expand = (c) => String(c).replace(/\$\{?CLAUDE_PROJECT_DIR\}?|%CLAUDE_PROJECT_DIR%/g, () => HUB_ROOT.split(path.sep).join('/'));
  const target = (c) => { if (LAUNCHER_HOOK_RE.test(c)) return path.join(HUB_ROOT, 'bin', 'harness.mjs'); const m = expand(c).match(/"([^"]*dispatch[\\/]run\.mjs)"|(\S*dispatch[\\/]run\.mjs)/); return m ? path.resolve(HUB_ROOT, m[1] || m[2]) : null; };
  const good = cmds.filter(([, c]) => { const t = target(c); return t && fs.existsSync(t); });
  if (cmds.length === 0 && pluginSeen) line(null, '.claude/settings.json hook dispatch', 'khong co hook trong settings: hook den tu plugin harness-kit');
  else if (cmds.length === 0) line(false, '.claude/settings.json hook dispatch', 'canh bao: khong co hook guard trong settings va khong thay plugin harness-kit nap (enabledPlugins/--plugin-dir). Neu da nap plugin bang --plugin-dir cua phien claude, chay doctor kem --plugin-dir <p>; doctor khong tu phat hien duoc truong hop do');
  else line(good.length === cmds.length, `.claude/settings.json hook dispatch`, `${good.length}/${cmds.length} su kien tro toi file dispatch/run.mjs ton tai`);
  try {
    const { hook_events } = await import(new URL('../../observe/audit/defaults.mjs', import.meta.url).href);
    const have = new Set(good.map(([ev]) => ev));
    const missing = Object.keys(hook_events || {}).filter((ev) => !have.has(ev));
    const extra = [...have].filter((ev) => !(hook_events || {})[ev]);
    if (cmds.length) line(!missing.length, '.claude/settings.json du su kien hook_events', missing.length ? 'thieu: ' + missing.join(', ') : '');
    if (extra.length) console.log('[warn] settings co su kien khong co trong hook_events:', extra.join(', '));
  } catch (e) { console.log('[warn] khong so duoc hook_events:', e.message); }
} catch (e) {
  if (pluginSeen && e && e.code === 'ENOENT') line(null, '.claude/settings.json', 'khong co (plugin mode)');
  else line(false, '.claude/settings.json', 'khong doc/parse duoc (' + (e.code || e.message) + ')');
}

// Shim `harness` cho shell cua user (hook SessionStart build/user-shim tu duy tri): thieu/lech/chua tren PATH -> canh bao mem kem lenh sua.
if (pluginSeen) try {
  const { shimStatus, pluginCacheDir, realTerminalLine } = await import('../../core/runtime/user-shim.mjs');
  const s = shimStatus({ cacheDir: pluginCacheDir(REPO_DIR), pluginRoot: REPO_DIR });
  const fix = 'hook SessionStart tu sua o phien sau, hoac chay: harness install --shim';
  if (s.state === 'missing') warn('shim', `chua co shim \`harness\` (${s.file}): PowerShell/cmd/bash ngoai Claude khong goi duoc harness -> ${fix}`);
  else if (s.state === 'stale') warn('shim', `shim ${s.file} lech ban hien tai -> ${fix}`);
  else if (s.state === 'nopath') warn('shim', `${s.dir} chua co tren PATH user -> ${fix}`);
  else if (s.state === 'foreign') warn('shim', `${s.file} khong do harness-kit sinh -> xem roi chay: harness install --shim --force`);
  // Claude desktop (MSIX) ao hoa ghi %LOCALAPPDATA%/%APPDATA% cua tien trinh con -> shim/PATH co the chi ton tai trong goi, shell that khong thay.
  if (s.risk) warn('shim', `${s.risk.why}: shim/PATH ghi tu trong Claude co the khong toi duoc shell that -> chay trong PowerShell/cmd THAT (ngoai Claude): ${realTerminalLine(REPO_DIR)}`);
} catch { /* fail-open */ }

// hooks block built from hook_events (audit/defaults.mjs), command path computed from this hub. Plugin da nap: hook den tu plugin, khong in khoi mau.
if (pluginSeen) console.log("[skip] khoi hook mau settings.json: plugin harness-kit da nap (hook den tu plugin, khong dan vao settings)");
else try {
  const defaultsUrl = new URL('../../observe/audit/defaults.mjs', import.meta.url);
  const { hook_events } = await import(defaultsUrl.href);
  if (!hook_events || typeof hook_events !== 'object') throw new Error('defaults.mjs khong export hook_events');
  const build = (cmd) => {
    const hooks = {};
    for (const [ev, cfg] of Object.entries(hook_events)) {
      const g = {};
      if (cfg.matcher !== undefined) g.matcher = cfg.matcher;
      g.hooks = [{ type: 'command', command: cmd(ev), timeout: cfg.timeout }];
      hooks[ev] = [g];
    }
    return JSON.stringify({ hooks }, null, 2);
  };
  // Khoi in ra la may-cuc-bo (hubDir hien tai), KHONG commit. Dung cho user scope (~/.claude/settings.json).
  console.log('\nKhoi hook tham khao cho user scope ~/.claude/settings.json (KHONG can dan neu da co project settings; doctor khong tu ghi):');
  console.log(build((ev) => `node "${dispatchPath.replace(/\\/g, '/')}" ${ev}`));
  // Project scope (.claude/settings.json cua hub): khong can duong dan tuyet doi. $CLAUDE_PROJECT_DIR: da dung o .claude/settings.json cua hub (commit san, khong can dan tay).
  console.log('\nHoac cho project scope (hub la project), khong co duong dan tuyet doi:');
  console.log(build((ev) => `node "$CLAUDE_PROJECT_DIR/harness/hooks/dispatch/run.mjs" ${ev}`));
} catch (e) { process.exitCode = 1; console.log('[LOI] khong tao duoc khoi hooks (import hook_events tu harness/observe/audit/defaults.mjs):', e.message); }
try {
} catch (e) { console.log('[warn] legacy-write check loi:', e.message); }
// module hook khong co tac dung: CHI CANH BAO (khong tu go). Nguon: gate `module-acted` (run.mjs) + gate `hook:<id>` san co. Chi khi audit da chay du retention_days voi tinh nang nay (tranh bao nham sau khi nang cap).
try {
  const { ORDER } = await import(new URL('../../hooks/dispatch/modules.mjs', import.meta.url).href);
  const { CORE_MODULES, MAINTENANCE_MODULES } = await import(new URL('../../hooks/dispatch/run.mjs', import.meta.url).href);
  const { auditRoot } = await import(new URL('../../core/audit/audit-write.mjs', import.meta.url).href);
  const { loadAuditConfig } = await import(new URL('../../core/config/audit-config.mjs', import.meta.url).href);
  const { listFiles } = await import(new URL('../../observe/views/query/files.mjs', import.meta.url).href);
  const ac = loadAuditConfig().config;
  const days = Number(ac.retention_days) > 0 ? Number(ac.retention_days) : 30;
  const deadline = Date.now() + Math.min(Number((ac.limits || {}).query_timeout_ms) || 30000, 5000);
  const dayStr = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const cand = new Map(); // id -> Set(su kien)
  for (const [ev, list] of Object.entries(ORDER)) for (const e of list) if (!CORE_MODULES.includes(e.id) && !MAINTENANCE_MODULES.includes(e.id)) (cand.get(e.id) || cand.set(e.id, new Set()).get(e.id)).add(ev);
  const seen = new Set(); let firstActed = ''; let truncated = false;
  const root = auditRoot();
  const files = cand.size ? listFiles(root, { type: ['gate', 'proc'], since: dayStr(days) }) : [];
  const MAX_FILES = 5000; const SLACK = 2; // sentinel module-acted khong nhat thiet roi dung ngay dau cua cua so
  for (const f of files.slice(0, MAX_FILES)) {
    if (Date.now() > deadline) { truncated = true; break; }
    if (f.type === 'proc') { seen.add('proc-orphans'); continue; } // proc-orphans tu ghi audit type=proc (khong co id module)
    let txt = '';
    try { txt = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    for (const ln of txt.split('\n')) {
      if (!ln.includes('"gate"')) continue;
      let g = null; try { g = (JSON.parse(ln).data || {}).gate; } catch { continue; }
      if (!g) continue;
      if (g.rule === 'module-acted' && typeof g.reason === 'string') { seen.add(g.reason.split(':')[0]); if (!firstActed || f.date < firstActed) firstActed = f.date; }
      else if (g.hook) seen.add(g.hook);
    }
  }
  if (files.length > MAX_FILES && !truncated) { console.log('[warn] unused-modules truncated: files'); truncated = true; }
  if (truncated) { if (Date.now() > deadline) console.log('[warn] unused-modules truncated: timeout'); }
  else if (!cand.size) { /* chi con module loi */ }
  else if (!firstActed) console.log(`[skip] unused-modules: chua co ban ghi module-acted nao trong audit; bat dau xet khi co ban ghi dau tien + ${days - SLACK} ngay (tranh bao nham sau nang cap)`);
  else if (firstActed > dayStr(days - SLACK)) console.log(`[skip] unused-modules: module-acted dau tien ${firstActed}; bat dau xet tu ${new Date(Date.parse(firstActed) + (days - SLACK) * 86400000).toISOString().slice(0, 10)} (tranh bao nham sau nang cap)`);
  else for (const [id, evs] of cand) if (!seen.has(id)) console.log(`[info] ${id} (${[...evs].join(', ')}) khong co tac dung trong ${days} ngay o audit nay; neu moi du an deu vay, can nhac bo khoi plugin`);
} catch (e) { console.log('[warn] unused-modules check loi:', e.message); }
// skill-drift: ban sao skill (.claude/skills, .agents/skills, plugin cache) lech hash -> warn; thieu ban sao -> info.
try {
  const { skillDrift } = await import('./skill-drift.mjs');
  const { pluginCacheDir } = await import('../../core/runtime/user-shim.mjs');
  let pluginSkillsDir = isPluginMode() ? path.join(REPO_DIR, 'skills') : null;
  if (!pluginSkillsDir) { const c = pluginCacheDir(REPO_DIR); try { const v = fs.readdirSync(c).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]; if (v) pluginSkillsDir = path.join(c, v, 'skills'); } catch { /* khong co cache */ } }
  const sd = skillDrift({ projectDir: HUB_ROOT, pluginSkillsDir });
  for (const f of sd.findings) if (f.level === 'warn') warn('skill-drift', `skill-drift ${f.skill}: ${f.detail}`); else if (f.level === 'info') console.log(`[info] skill-drift ${f.skill}: ${f.detail}`);
  if (sd.truncated) console.log(`[warn] skill-drift truncated: ${sd.truncated}`);
} catch (e) { console.log('[warn] skill-drift check loi:', e.message); }
// job lo: loi gan nhat (kick/spawn/exit/timeout/lock) hoac khong chay xong trong 72h.
try {
  const { readState, jobHealth } = await import('../../observe/ledger/ledger.mjs');
  const st = readState(); const jh = jobHealth(st);
  if (jh) warn('ledger-job', `ledger job loi: ${jh.error} (${new Date(jh.at).toISOString()}); xem harness observe ledger`);
  else if (st.lastRun && Date.now() - Number(st.lastRun) > 72 * 3600e3) warn('ledger-job', `ledger job khong chay tu ${new Date(Number(st.lastRun)).toISOString()} (>72h)`);
} catch (e) { console.log('[warn] ledger-job check loi:', e.message); }
// runtime: config guard hop le + du lieu (data scan: retention/dang ky/stray). Check phat trien nam o dev/.
try {
  const rows = [];
  const cap = (arr, n = 15) => { arr.slice(0, n).forEach((s) => console.log('[warn]', s)); if (arr.length > n) console.log(`[warn] ... con ${arr.length - n} muc nua`); };
  const { guardConfigHealth } = await import('../../core/config/guard-health.mjs');
  const gh = guardConfigHealth({ hubRoot: HUB_ROOT });
  gh.forEach((x) => console.log(`[ERROR] config guard hong, protectedPaths mat hieu luc: ${x.file} (${x.problem})`));
  rows.push({ name: 'guard-config', total: gh.length, errors: gh.length, truncated: false });
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../harness.mjs', import.meta.url)), 'data', 'scan', '--json'], { encoding: 'utf8', timeout: 15000 });
    const dw = JSON.parse(r.stdout).warnings || [];
    for (const [name, rules] of [['data-unregistered', ['unregistered']], ['data-fields', ['missing-field']], ['data-caps', ['over-caps']], ['data-retention', ['retention', 'stray']], ['data-orphan-ws', ['orphan-ws']]]) {
      const ws = dw.filter((w) => rules.includes(w.rule));
      cap(ws.map((w) => `${name} rule=${w.rule} ${w.path}: ${w.detail} -> ${w.fix}`), 10);
      rows.push({ name, total: ws.length, errors: 0, truncated: false });
    }
  } catch { /* fail-open */ }
  for (const r of rows) console.log(`[check] ${r.name}: ${r.total} finding (${r.errors} error)`);
  const gTotal = Object.values(groupWarn).reduce((x, y) => x + y, 0);
  if (gTotal) console.log(`[check] khac: ${gTotal} warn (${Object.entries(groupWarn).map(([k, v]) => k + '=' + v).join(' ')})`);
  const total = rows.reduce((s, r) => s + r.total, 0) + gTotal;
  const errors = rows.reduce((s, r) => s + r.errors, 0);
  console.log(`[checks] warnings=${total} errors=${errors}${process.argv.includes('--strict') ? ' strict' : ''}`);
  if (process.argv.includes('--strict') && errors > 0) process.exitCode = 1;
} catch (e) { console.log('[warn] data/config check loi:', e.message); }

clearTimeout(t);
if (JSON_MODE) process.stdout.write(JSON.stringify({ checks: jsonChecks, exit_code: process.exitCode || 0 }, null, 2) + '\n');
