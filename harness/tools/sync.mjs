// node harness/tools/sync.mjs [--check] [--tool <name>]
// Nguon that = .agents/ (rules, agents) va harness/skills/ (skill: build qua harness/build/skills, --adopt). Sinh adapter cho tung CLI bat trong config workspace.
// --check: khong ghi, chi bao lech (exit 1 neu co lech/loi). Node ESM, khong dependency.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_TOOLS, loadToolsConfig } from '../core/agy/adapters-report.mjs';
import { workspaceRoot, samePath } from '../core/io/paths.mjs';
import { loadAgents, rolesTable, replaceBlock } from '../core/agy/agents.mjs';
import { spawnSync } from '../core/runtime/proc.mjs';
import { parseFrontmatter } from './adapters/_util.mjs';
const ROOT = workspaceRoot();

function loadTools(root = ROOT) {
  return loadToolsConfig(root, { strict: true }).tools || DEFAULT_TOOLS;
}

// Bang vai tro (tu .claude/agents/*.md) vao khoi marker GENERATED trong cac file rule; kiem name/trung/thu muc.
function syncRoles({ root = ROOT, check = false } = {}) {
  const { agents, problems } = loadAgents(root);
  const changes = [];
  const table = rolesTable(agents);
  for (const rel of ['.agents/rules/subagents.md']) {
    const f = path.join(root, rel);
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const n = replaceBlock(t, table);
    if (n === null || n === t) continue;
    changes.push(rel);
    if (!check) fs.writeFileSync(f, n);
  }
  // role co ca ban Claude va ban agy: name + description phai khop (fork tay, chi check re)
  for (const a of agents) {
    let t; try { t = fs.readFileSync(path.join(root, '.agents', 'agents', a.dir + '.md'), 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(t);
    if (!fm) continue;
    if (fm.data.name !== a.name) problems.push(`agents/${a.dir}: name khac giua .claude/agents va .agents/agents`);
    if ((fm.data.description || '').replace(/\\"/g, '"') !== a.description.replace(/\\"/g, '"')) problems.push(`agents/${a.dir}: description khac giua .claude/agents va .agents/agents`);
  }
  // ban agy ma thieu ban claude -> loi
  let agyFiles = []; try { agyFiles = fs.readdirSync(path.join(root, '.agents', 'agents')).filter((f) => f.endsWith('.md')); } catch {}
  for (const f of agyFiles) if (!agents.some((a) => a.dir === f.slice(0, -3))) problems.push(`agents/${f.slice(0, -3)}: co .agents/agents nhung thieu .claude/agents/${f}`);
  return { tool: 'roles', changes, problems };
}

// Skill: nguon harness/skills -> .claude/skills + .agents/skills. Goi CLI skills (tools khong import build/); khong co nguon thi bo qua.
// check: `skills check` (lech/chua build/conflict = loi). Ghi: `skills build --apply --adopt` (adopt chi thay thu muc khong marker khi noi dung trung nguon).
function syncSkills({ root = ROOT, check = false } = {}) {
  const res = { tool: 'skills', changes: [], problems: [] };
  const cli = path.join(root, 'harness', 'build', 'skills', 'cli.mjs');
  const src = path.join(root, 'harness', 'skills');
  let has = false;
  try { has = fs.readdirSync(src, { withFileTypes: true }).some((e) => e.isDirectory() && fs.existsSync(path.join(src, e.name, 'SKILL.md'))); } catch {}
  if (!has) return null;
  if (!fs.existsSync(cli)) { res.problems.push('thieu harness/build/skills/cli.mjs'); return res; }
  const args = check ? ['check'] : ['build', '--apply', '--adopt'];
  const r = spawnSync(process.execPath, [cli, ...args, '--root', root, '--json', '--timeout-s', '60'], { encoding: 'utf8', timeout: 90000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  if (!j) { res.problems.push('skills ' + args[0] + ' khong tra JSON: ' + String(r.stderr || r.error || '').slice(0, 200)); return res; }
  if (check) for (const i of j.issues || []) res.problems.push(`${i.issue}: ${i.target || i.skill}${i.detail ? ' - ' + i.detail : ''} (chay: node harness/tools/sync.mjs)`);
  else {
    for (const i of j.items || []) if (i.action !== 'skip') res.changes.push(`${i.target} (${i.action})`);
    for (const p of j.problems || []) res.problems.push(p);
  }
  if (j.truncated || (r.status === null && r.error)) res.problems.push('skills: truncated/timeout');
  return res;
}

// Chay adapter; tra ve { tool, changes: [...], problems: [...] }. Moi adapter export run({root, check, config}).
export async function syncAll({ root = ROOT, check = false, only = null } = {}) {
  const tools = loadTools(root);
  const out = [];
  for (const [name, cfg] of Object.entries(tools)) {
    if (!cfg || cfg.enabled === false || (only && only !== name)) continue;
    let file = path.join(root, 'harness', 'tools', 'adapters', `${name}.mjs`);
    if (!fs.existsSync(file)) file = path.join(root, 'tools', 'adapters', `${name}.mjs`);
    if (!fs.existsSync(file)) { out.push({ tool: name, changes: [], problems: [`thieu adapter harness/tools/adapters/${name}.mjs`] }); continue; }
    try {
      const mod = await import(pathToFileURL(file).href);
      const r = await mod.run({ root, check, config: cfg });
      out.push({ tool: name, changes: r.changes || [], problems: r.problems || [] });
    } catch (e) { out.push({ tool: name, changes: [], problems: ['adapter loi: ' + e.message] }); }
  }
  if (!only) {
    const r = syncRoles({ root, check }); if (r.changes.length || r.problems.length) out.push(r);
    const sk = syncSkills({ root, check }); if (sk) out.push(sk);
    try {
      const { syncReadme } = await import('../core/agy/adapters-report.mjs');
      const a = syncReadme(root, !check);
      if (a.changed || a.problem) out.push({ tool: 'adapters-readme', changes: a.changed ? ['harness/README.md'] : [], problems: a.problem ? [a.problem] : [] });
    } catch (e) { out.push({ tool: 'adapters-readme', changes: [], problems: ['loi: ' + e.message] }); }
  }
  return out;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  const check = a.includes('--check');
  const ti = a.indexOf('--tool');
  const only = ti >= 0 ? a[ti + 1] : null;
  const fail = (m) => { console.error('sync: ' + m); process.exit(2); };
  if (ti >= 0 && (!only || only.startsWith('--'))) fail('--tool thieu gia tri');
  let tools;
  try { tools = loadTools(); } catch (e) { fail(e.message); }
  if (only && !(only in tools)) fail('--tool ' + only + ' khong co trong config workspace (co: ' + Object.keys(tools).join(', ') + ')');
  const res = await syncAll({ check, only });
  let bad = 0;
  for (const r of res) {
    for (const c of r.changes) console.log(`[${r.tool}] ${check ? 'lech' : 'ghi'}: ${c}`);
    for (const p of r.problems) console.log(`[${r.tool}] LOI: ${p}`);
    if (!r.changes.length && !r.problems.length) console.log(`[${r.tool}] OK`);
    bad += r.problems.length + (check ? r.changes.length : 0);
  }
  process.exit(bad ? 1 : 0);
}
