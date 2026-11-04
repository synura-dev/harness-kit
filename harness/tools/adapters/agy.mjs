// Adapter agy (Antigravity): (1) sinh rule orchestrator tu AGENTS.md, (2) validate (agent .agents/agents/<n>.md viet tay) cau truc.
// agy bo qua im lang rule thieu frontmatter trigger, nen validate la phan quan trong.
import fs from 'node:fs';
import path from 'node:path';
import { walkAgyHooks } from '../../core/io/paths.mjs';
import { TOOL_MAP as AGY_TOOLS } from '../../core/io/agy-payload.mjs';
import { read, listDirs, listDirFiles, rel, parseFrontmatter, writeIfChanged, withHeader, isGenerated } from './_util.mjs';

export const name = 'agy';
const TRIGGERS = ['always_on', 'model_decision', 'glob', 'manual'];
const AGY_MODELS = ['inherit', 'flash', 'pro'];

// agy chay hook voi cwd = thu muc chua hooks.json (.agents/): command tuong doi tinh tu .agents/, KHONG tu root.
export function checkHookCommand(command, agentsDir) {
  const out = [];
  if (!command) return out;
  const m = /^node\s+"?([^"\s]+)"?/.exec(command);
  if (m) {
    if (/^\.?[\\/]?\.agents[\\/]/.test(m[1])) out.push(`.agents/hooks.json: command khong duoc bat dau bang .agents/ (cwd da la .agents/; se loi duong dan lap): ${command}`);
    else if (!fs.existsSync(path.resolve(agentsDir, m[1]))) out.push(`.agents/hooks.json: khong thay file ${m[1]} (tinh tu .agents/)`);
  }
  if (/(^|[\s"'])([A-Za-z]:[\\/]|\/)/.test(command)) out.push(`.agents/hooks.json: duong dan tuyet doi trong command: ${command}`);
  return out;
}

// Map tool Claude -> tool agy (VERIFIED bang chay that agy 1.4.8). Ten khac (WebSearch, WebFetch...) khong map -> bo.
const inv = {};
for (const [a, c] of Object.entries(AGY_TOOLS)) if (c !== 'MCP' && c !== 'Agent' && !(c in inv)) inv[c] = a;
export const TOOL_MAP = { ...inv, Glob: inv.Bash, Grep: inv.Bash };
const CLAUDE_TOOLS = ['Read', 'Bash', 'Glob', 'Grep', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Task', 'Agent', 'NotebookEdit', 'TodoWrite'];

export function mapTools(tools) {
  const list = Array.isArray(tools) ? tools : String(tools || '').split(',');
  const out = [];
  for (const t of list.map((x) => String(x).trim()).filter(Boolean)) {
    const v = TOOL_MAP[t];
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// Doan cuoi than prompt ban agy: ten tool agy that + rang buoc chi-doc bang prompt (commandExecutionPolicy khong kiem chung duoc).
export function toolNote(t) {
  if (!t.length) return '\n';
  const parts = [];
  if (t.includes('view_file')) parts.push('view_file de doc file');
  if (t.includes('run_command')) parts.push('run_command de tim/grep/ls/chay lenh (PowerShell tren Windows)');
  if (t.includes('edit_file')) parts.push('edit_file de sua file');
  if (t.includes('write_file')) parts.push('write_file de tao file');
  let s = `\n\n## Tool agy\n${parts.join('; ')}. Cac ten tool Claude trong prompt (Read, Glob, Grep, Bash...) tuong ung cac tool nay.\nTra loi chi ghi file:dong dang van ban thuong, khong dung link markdown file:///.`;
  if (!t.includes('edit_file') && !t.includes('write_file')) s += '\nCHI DOC: khong sua/tao/xoa file, khong chay lenh ghi (redirect, git commit/add...).';
  return s + '\n';
}

// agy tu choi (unknown agent) model Claude hoac tools dang chuoi/ten Claude trong .agents/agents/ (VERIFIED agy 1.4.8).
export function checkAgentFile(text, label) {
  const fm = parseFrontmatter(text);
  if (!fm) return [`${label}: thieu frontmatter`];
  const out = [];
  if (!fm.data.name) out.push(`${label}: thieu name`);
  if (!fm.data.description) out.push(`${label}: thieu description`);
  if (fm.data.model && !AGY_MODELS.includes(fm.data.model)) out.push(`${label}: model "${fm.data.model}" ngoai ${AGY_MODELS.join('|')}; agy se tu choi agent nay`);
  if (fm.data.tools !== undefined) {
    const raw = String(fm.data.tools).trim();
    const inline = /^\[(.*)\]$/.exec(raw);
    if (!inline) out.push(`${label}: tools phai la mang inline [a, b]; dang chuoi lam agy tu choi agent`);
    else {
      const t = inline[1].split(',').map((x) => x.trim()).filter(Boolean);
      if (t.some((x) => CLAUDE_TOOLS.includes(x))) out.push(`${label}: tools chua ten Claude (${t.join(', ')}); agy tu choi agent, dung view_file/run_command/edit_file/write_file`);
    }
  }
  return out;
}

function checkAgentFiles(root, dir) {
  const out = [];
  for (const f of listDirFiles(dir).filter((x) => x.endsWith('.md'))) out.push(...checkAgentFile(read(path.join(dir, f)), rel(root, path.join(dir, f))));
  for (const n of listDirs(dir)) { const f = path.join(dir, n, 'agent.md'); const t = read(f); if (t != null) out.push(...checkAgentFile(t, rel(root, f))); }
  return out;
}

export async function run({ root, check = false }) {
  const changes = [];
  const problems = [];
  const A = path.join(root, '.agents');

  // (1) rules/orchestrator.md = AGENTS.md + frontmatter always_on (AGENTS.md la nguon, tranh trung lap thu cong)
  const agentsMd = read(path.join(root, 'AGENTS.md'));
  if (agentsMd == null) problems.push('thieu AGENTS.md');
  else {
    const want = withHeader(`---\ntrigger: always_on\n---\n${agentsMd}`, 'AGENTS.md');
    const f = path.join(A, 'rules', 'orchestrator.md');
    if (writeIfChanged(f, want, check)) changes.push(rel(root, f));
  }

  // (2) validate
  problems.push(...checkAgentFiles(root, path.join(A, 'agents')));
  for (const n of listDirs(path.join(A, 'skills'))) {
    const f = path.join(A, 'skills', n, 'SKILL.md');
    const fm = parseFrontmatter(read(f));
    if (!fm) { problems.push(`${rel(root, f)}: thieu SKILL.md hoac frontmatter`); continue; }
    if (!fm.data.name || !fm.data.description) problems.push(`${rel(root, f)}: thieu name/description`);
  }
  for (const file of listDirFiles(path.join(A, 'rules')).filter((x) => x.endsWith('.md'))) {
    const f = path.join(A, 'rules', file);
    const fm = parseFrontmatter(read(f));
    if (!fm || !TRIGGERS.includes(fm.data.trigger)) problems.push(`${rel(root, f)}: thieu/sai frontmatter trigger (${TRIGGERS.join('|')}); agy se bo qua rule nay`);
    else if (fm.data.trigger === 'model_decision' && !fm.data.description) problems.push(`${rel(root, f)}: model_decision can description`);
    else if (fm.data.trigger === 'glob' && !fm.data.globs) problems.push(`${rel(root, f)}: trigger glob can globs`);
  }
  const hj = read(path.join(A, 'hooks.json'));
  if (hj != null) {
    try {
      const j = JSON.parse(hj);
      const w = walkAgyHooks(j);
      problems.push(...w.problems.map((x) => '.agents/hooks.json: ' + x));
      for (const h of w.handlers) problems.push(...checkHookCommand(h.command, A));
    } catch (e) { problems.push('.agents/hooks.json: JSON loi: ' + e.message); }
  }
  return { changes, problems };
}
