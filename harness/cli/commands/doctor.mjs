// node harness/cli/commands/doctor.mjs  — read-only checks; prints hooks block for THIS machine. Never writes settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ver } from '../../core/runtime/proc-list.mjs';
import { parseCommon, emit } from '../../core/io/out.mjs';
import { workspaceRoot, resolveHub, isInside, REPO_DIR, findBadLinks, findBadHookCommands, walkAgyHooks, isPluginMode } from '../../core/io/paths.mjs';

if (process.argv.includes('--adapters')) {
  const { buildReport, formatAdaptersTable } = await import('../../core/agy/adapters-report.mjs');
  const rep = buildReport(HUB_ROOT);
  const c = parseCommon(process.argv.slice(2));
  if (c.json || c.raw || c.maxBytes) emit({ summary: formatAdaptersTable(rep.rows) + '\n' + rep.warnings.map((w) => '[warn] ' + w).join('\n'), data: rep }, c);
  else { console.log(formatAdaptersTable(rep.rows)); rep.warnings.forEach((w) => console.log('[warn]', w)); }
  process.exit(0);
}
const t = setTimeout(() => { console.error('timeout'); process.exit(2); }, 20000);
const groupWarn = {};
// Ham trung ten NHUNG khac nghia (moi module/CLI mot ban rieng, khong chia se duoc) -> khong tinh la dup. Bo sung cho contract DUP_ALLOW; moi muc kem files de dup moi van bi bat.
const DOCTOR_DUP_ALLOW = [
  { name: 'parseArgs', files: ['harness/build/skills/cli.mjs', 'harness/evolve/eval/bench/hook-latency.mjs', 'harness/evolve/eval/cli.mjs', 'harness/evolve/loop/cli.mjs', 'harness/observe/evidence/cli.mjs'], reason: 'moi CLI co bo co rieng' },
  { name: 'render', files: ['harness/evolve/loop/cli.mjs', 'harness/hooks/dispatch/merge.mjs', 'harness/observe/cost/cli.mjs', 'harness/observe/evidence/cli.mjs'], reason: 'moi CLI dinh dang output rieng; dispatch/merge ghep ket qua hook (khac nghia)' },
  { name: 'build', files: ['harness/build/skills/skills.mjs', 'harness/knowledge/inject/hook.mjs'], reason: 'build skills (sinh ban sao) khac build payload inject' },
  { name: 'check', files: ['harness/build/skills/skills.mjs', 'harness/evolve/loop/loop.mjs', 'harness/knowledge/vault/vault.mjs'], reason: 'API cung ten cua ba domain khac nhau (skills/loop/vault)' },
  { name: 'prune', files: ['harness/build/skills/skills.mjs', 'harness/knowledge/vault/vault.mjs', 'harness/observe/views/prune.mjs'], reason: 'API cung ten cua ba domain khac nhau' },
  { name: 'scan', files: ['harness/core/registry/plugin-registry.mjs', 'harness/knowledge/vault/vault.mjs'], reason: 'quet registry khac quet vault' },
  { name: 'validate', files: ['harness/evolve/eval/eval.mjs', 'harness/knowledge/vault/schema.mjs'], reason: 'validate case eval khac validate schema vault' },
  { name: 'ctx', files: ['harness/build/skills/skills.mjs', 'harness/evolve/loop/loop.mjs', 'harness/observe/cost/cost.mjs'], reason: 'ngu canh rieng moi module (truong khac nhau)' },
  { name: 'summary', files: ['harness/observe/cost/cost.mjs', 'harness/observe/evidence/evidence.mjs'], reason: 'tong hop so lieu cost khac evidence' },
  { name: 'redact', files: ['harness/evolve/loop/loop.mjs', 'harness/observe/audit/redact.mjs'], reason: 'loop.redact che mot chuoi mau bang maskSecrets; audit.redact ap danh sach regex cau hinh (khac chu ky)' },
  { name: 'syncSkills', files: ['harness/tools/adapters/claude.mjs', 'harness/tools/sync.mjs'], reason: 'adapter claude dong bo .agents->.claude; sync.mjs goi build/skills CLI' },
  { name: 'toOutput', files: ['harness/constrain/approval/hook.mjs', 'harness/constrain/guard/hook.mjs'], reason: 'moi hook doc lap (cam import hook khac), dinh dang output rieng' },
  { name: 'toClaudeOutput', files: ['harness/constrain/bash-guard/hook.mjs', 'harness/constrain/model-policy/hook.mjs'], reason: 'moi hook doc lap (cam import hook khac), dinh dang output rieng' },
  { name: 'readStdin', files: ['harness/constrain/approval/hook.mjs', 'harness/constrain/guard/hook.mjs', 'harness/constrain/model-policy/hook.mjs', 'harness/constrain/verify-gate/hook.mjs', 'harness/hooks/dispatch/run.mjs'], reason: 'moi hook/dispatcher tu doc stdin voi gioi han rieng; doc lap, fail-open (mo rong rule contract them dispatch/run.mjs)' },
];
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
const hub = resolveHub();
console.log(`[info] hubDir = ${hub.hubDir} (nguon: ${hub.source})`);
if (!isInside(REPO_DIR, hub.hubDir)) console.log(`[warn] repo (${REPO_DIR}) nam ngoai hubDir; kiem tra HUB_DIR/config/paths.local.json`);
for (const b of findBadLinks(path.join(HUB_ROOT, '.claude', 'skills'), HUB_ROOT)) {
  line(false, `link .claude/skills/${b.name} ${b.problem === 'hong' ? 'hong' : 'tro ngoai hubDir'}`, `${b.target}; chay: node harness/tools/sync.mjs`);
}
try {
  const hj = JSON.parse(fs.readFileSync(path.join(HUB_ROOT, '.agents', 'hooks.json'), 'utf8'));
  for (const p of walkAgyHooks(hj).problems) line(false, '.agents/hooks.json schema agy', p);
} catch (e) {
  if (e && e.code !== 'ENOENT') { process.exitCode = 1; console.log('[LOI]   .agents/hooks.json khong doc/parse duoc - ' + (e.message || e)); }
}
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
const lowerPosix =(s) => String(s).replace(/\\/g, '/').toLowerCase();
const projectSettingsFile = path.join(HUB_ROOT, '.claude', 'settings.json');
try {
  const txt = fs.readFileSync(projectSettingsFile, 'utf8');
  const st = JSON.parse(txt.charCodeAt(0) === 0xfeff ? txt.slice(1) : txt);
  const cmds = [];
  for (const [ev, arr] of Object.entries(st.hooks || {})) {
    for (const g of arr || []) for (const h of g.hooks || []) if (h.command && /^\s*node\s/.test(h.command) && (/dispatch[\\/]run\.mjs/.test(h.command) || LAUNCHER_HOOK_RE.test(h.command))) cmds.push([ev, h.command]);
  }
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

// hooks block built from hook_events (audit/defaults.mjs), command path computed from this hub
try {
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
// adapter lech nguon (.agents/ -> .claude/, rule agy) + validate cau truc
// co dieu kien: workspace khong co adapter nguon (.agents/) thi khong co gi de lech -> bo qua, khong bao MISS adapter
if (!fs.existsSync(path.join(HUB_ROOT, '.agents'))) console.log('[skip] adapter: workspace khong co .agents/ (khong co nguon adapter)');
else try {
  const { syncAll } = await import(new URL('../../tools/sync.mjs', import.meta.url).href);
  const res = await syncAll({ root: HUB_ROOT, check: true });
  for (const r of res) {
    // bang [dk] trong README suy ra tu hook trong settings; plugin mode khong co hook settings -> lech do thiet ke, chi canh bao
    if (r.tool === 'adapters-readme' && pluginSeen && r.changes.length && !r.problems.length) { warn('adapters', 'README bang adapter lech [dk] vi hook den tu plugin (khong trong settings); bo qua'); continue; }
    for (const c of r.changes) line(false, `adapter ${r.tool} lech nguon`, c);
    // skill chua build (vd worktree moi, .agents/skills khong tracked) = chua sinh, khong phai hong: chi canh bao kem lenh build
    const soft = r.tool === 'skills' ? r.problems.filter((p) => /^unbuilt:/.test(p)) : [];
    if (soft.length) warn('adapters', `adapter skills chua build (${soft.length} muc, vd ${soft[0].replace(/ \(chay:.*$/, '')}) -> chay: node harness/build/skills/cli.mjs build --apply`);
    // workspace mode: adapter la code loi cua plugin, workspace khong chua harness/tools/adapters -> khong phai loi
    const noAdapter = WS_MODE ? r.problems.filter((p) => /^thieu adapter /.test(p)) : [];
    if (noAdapter.length) { console.log(`[skip] adapter ${r.tool}: workspace mode, adapter nam o plugin (khong trong workspace)`); if (!r.changes.length && r.problems.length === noAdapter.length) continue; }
    const hard = r.problems.filter((p) => !soft.includes(p) && !noAdapter.includes(p));
    for (const p of hard) line(false, `adapter ${r.tool}`, p);
    if (!r.changes.length && !hard.length && !soft.length) line(true, `adapter ${r.tool} khop nguon .agents/`);
    else if (r.changes.length || hard.length) console.log('       -> chay: node harness/tools/sync.mjs');
  }
} catch (e) { process.exitCode = 1; console.log('[LOI] khong chay duoc harness/tools/sync.mjs --check:', e.message); }
// manifest: CHI CANH BAO, khong lam doctor fail
try {
  const { checkManifest } = await import(new URL('../../core/checks/manifest-check.mjs', import.meta.url).href);
  for (const m of checkManifest(HUB_ROOT)) warn('manifest', m);
} catch (e) { console.log('[warn] manifest check loi:', e.message); }
try {
  const { buildReport } = await import('../../core/agy/adapters-report.mjs');
  for (const m of buildReport(HUB_ROOT).warnings) warn('adapters', m);
} catch (e) { console.log('[warn] adapters check loi:', e.message); }
try {
  const { checkRegistry } = await import(new URL('../../core/checks/manifest-check.mjs', import.meta.url).href);
  for (const m of checkRegistry(HUB_ROOT)) warn('registry', m);
} catch (e) { console.log('[warn] registry check loi:', e.message); }
try {
  const { checkLegacyWrites } = await import(new URL('../../core/registry/data-registry.mjs', import.meta.url).href);
  for (const m of checkLegacyWrites()) warn('data', m);
} catch (e) { console.log('[warn] legacy-write check loi:', e.message); }
try {
  const { syncArchitecture } = await import(new URL('../../core/registry/plugin-registry.mjs', import.meta.url).href);
  const ar = syncArchitecture(HUB_ROOT, false);
  // workspace mode: khoi generated thuoc ARCHITECTURE cua plugin; workspace khong bat buoc co marker
  if (ar.problem && WS_MODE && /thieu marker/.test(ar.problem)) console.log('[skip] arch: workspace mode, docs/ARCHITECTURE.md khong can marker generated');
  else if (ar.problem) warn('arch', ar.problem);
  else if (ar.changed) { warn('arch', 'docs/ARCHITECTURE.md (khoi generated) lech registry; chay: node harness/cli/harness.mjs adapters --write-arch'); if (process.argv.includes('--strict')) { process.exitCode = 1; console.log('[LOI] architecture lech registry (strict)'); } }
} catch (e) { console.log('[warn] architecture check loi:', e.message); }
// ba check dai han (ref/import/clutter): mac dinh chi canh bao (D6); --strict exit 1 neu co muc error
try {
  const { buildScanInput, collectStray } = await import(new URL('../../core/checks/scan-input.mjs', import.meta.url).href);
  const { checkRefs, makeCoreOwned } = await import(new URL('../../core/checks/ref-check.mjs', import.meta.url).href);
  const { scanTree } = await import(new URL('../../core/checks/import-check.mjs', import.meta.url).href);
  const { checkClutter, checkStray, countSources, countFlat, scanCode } = await import(new URL('../../core/checks/clutter-check.mjs', import.meta.url).href);
  const si = buildScanInput(HUB_ROOT);
  const rows = [];
  const cap = (arr, n = 15) => { arr.slice(0, n).forEach((s) => console.log('[warn]', s)); if (arr.length > n) console.log(`[warn] ... con ${arr.length - n} muc nua`); };
  // workspace mode: harness/<loi>/... thuoc plugin, docs lich su la anh chup -> khong phai loi ref cua workspace
  const coreOwned = WS_MODE ? makeCoreOwned({
    coreDirs: (() => { try { return fs.readdirSync(path.join(REPO_DIR, 'harness'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } })(),
    existsInPlugin: (p) => fs.existsSync(path.join(REPO_DIR, p)),
  }) : null;
  const ref = checkRefs({ files: si.files, exists: si.exists, coreOwned, skipHistorical: WS_MODE });
  cap(ref.errors.map((e) => `ref ${e.file}:${e.line} tro toi khong ton tai: ${e.ref}`));
  rows.push({ name: 'ref', total: ref.errors.length, errors: ref.errors.length, truncated: ref.truncated });
  const imp = scanTree(HUB_ROOT);
  cap([...imp.violations.map((v) => `import ${v.file}:${v.line} ${v.from} -> ${v.to} (${v.rule})`), ...imp.missing.map((m) => `import ${m.file}:${m.line} thieu file: ${m.spec}`)]);
  rows.push({ name: 'import', total: imp.violations.length + imp.missing.length, errors: imp.violations.length + imp.missing.length, truncated: imp.truncated });
  const clu = checkClutter(si.files, si.registry);
  cap(clu.findings.map((f) => `clutter [${f.severity}] ${f.rule} ${f.path}: ${f.message}`));
  rows.push({ name: 'clutter', total: clu.findings.length, errors: clu.findings.filter((f) => f.severity === 'error').length, truncated: clu.truncated ? (clu.reason || true) : false });
  const src = countSources(si.files);
  console.log('[sources] ' + src.map((s) => `${s.dir}=${s.count}`).join(' '));
  const { LONG_FILE_SOFT, DUP_ALLOW } = await import(new URL('../../core/config/contract.mjs', import.meta.url).href);
  si.files.filter((f) => /^harness\/.+\.mjs$/.test(String(f.path).replace(/\\/g, '/')) && !/\.test\./.test(f.path) && f.lines > LONG_FILE_SOFT).forEach((f) => warn('long', `${f.path}: ${f.lines} dong > ${LONG_FILE_SOFT} (canh bao mem)`));
  const flatTop = countFlat(si.files)[0];
  if (flatTop) console.log(`[flat] max ${flatTop.count}/${flatTop.max} (${flatTop.dir})`);
  const sc = scanCode(si.files, { dupAllow: [...DUP_ALLOW, ...DOCTOR_DUP_ALLOW] });
  cap(sc.unused.map((u) => `dead ${u.file}: export ${u.name} khong ai dung`), 10);
  cap(sc.dup.map((d) => `dup ham ${d.name}: ${d.files.join(', ')}`), 10);
  console.log(`[dead] ${sc.unused.length} (chi test dung: ${sc.testOnly.length})`);
  console.log(`[dup] ${sc.dup.length}`);
  console.log(`[todo] ${sc.todo.length}`);
  const stray = checkStray(collectStray(HUB_ROOT).entries);
  cap(stray.map((s) => `stray ${s.path}: ${s.message}`), 10);
  console.log(`[stray] ${stray.length}`);
  rows.push({ name: 'stray', total: stray.length, errors: stray.length, truncated: false });
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../harness.mjs', import.meta.url)), 'data', 'scan', '--json'], { encoding: 'utf8', timeout: 15000 });
    const dw = JSON.parse(r.stdout).warnings || [];
    for (const [name, rules] of [['data-unregistered', ['unregistered']], ['data-fields', ['missing-field']], ['data-caps', ['over-caps']], ['data-retention', ['retention', 'stray']], ['repo-clutter', ['clutter']]]) {
      const ws = dw.filter((w) => rules.includes(w.rule));
      cap(ws.map((w) => `${name} rule=${w.rule} ${w.path}: ${w.detail} -> ${w.fix}`), 10);
      rows.push({ name, total: ws.length, errors: 0, truncated: false });
    }
  } catch { /* fail-open */ }
  rows.push({ name: 'dead', total: sc.unused.length, errors: sc.unused.length, truncated: false });
  if (si.truncated) console.log('[warn] scan-input truncated: ' + si.truncated);
  for (const r of rows) console.log(`[check] ${r.name}: ${r.total} finding (${r.errors} error)${r.truncated ? ' truncated: ' + r.truncated : ''}`);
  const gTotal = Object.values(groupWarn).reduce((a, b) => a + b, 0);
  if (gTotal) console.log(`[check] khac: ${gTotal} warn (${Object.entries(groupWarn).map(([k, v]) => k + '=' + v).join(' ')})`);
  const total = rows.reduce((s, r) => s + r.total, 0) + gTotal;
  const errors = rows.reduce((s, r) => s + r.errors, 0);
  console.log(`[checks] warnings=${total} errors=${errors}${process.argv.includes('--strict') ? ' strict' : ''}`);
  if (process.argv.includes('--strict') && errors > 0) process.exitCode = 1;
} catch (e) { console.log('[warn] ref/import/clutter check loi:', e.message); }

clearTimeout(t);
