// Nguon duy nhat danh sach vai tro: .claude/agents/<dir>.md (frontmatter). Khong dependency.
import fs from 'node:fs';
import path from 'node:path';

/** "A, B" | '["A","B"]' | undefined -> string[] */
export function parseList(v) {
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(String); } catch {} }
  return s.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** @returns {{agents:{dir,name,description,model,maxTurns,tools:string[]}[], problems:string[]}} */
export function loadAgents(root) {
  const base = path.join(root, '.claude', 'agents');
  const agents = [], problems = [];
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name.slice(0, -3)).sort(); } catch { return { agents, problems }; }
  const seen = new Map();
  for (const dir of dirs) {
    const file = path.join(base, dir + '.md');
    let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(txt);
    if (!fm) { problems.push(`agents/${dir}: thieu frontmatter`); continue; }
    const d = fm.data;
    const a = { dir, name: d.name || '', description: d.description || '', model: d.model || '', maxTurns: d.maxTurns ? Number(d.maxTurns) : undefined, effort: d.effort || '', tools: parseList(d.tools) };
    if (!a.name) problems.push(`agents/${dir}: thieu name`);
    else if (a.name !== dir) problems.push(`agents/${dir}: name '${a.name}' khac ten thu muc`);
    if (a.name && seen.has(a.name)) problems.push(`agents/${dir}: ten trung voi agents/${seen.get(a.name)}`);
    seen.set(a.name, dir);
    if (d.maxTurns && !Number.isFinite(a.maxTurns)) problems.push(`agents/${dir}: maxTurns khong phai so`);
    agents.push(a);
  }
  return { agents, problems };
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
const shortDesc = (s) => { const t = oneLine(s); const i = t.search(/[.:]\s/); const r = i > 20 ? t.slice(0, i) : t; return r.length > 110 ? r.slice(0, 107) + '...' : r; };

/** Bang markdown vai tro (role | model | maxTurns | mo ta 1 dong). */
export function rolesTable(agents) {
  const rows = agents.map((a) => `| \`${a.name || a.dir}\` | ${a.model || '-'} | ${a.maxTurns ?? '-'} | ${shortDesc(a.description)} |`);
  return ['| role | model | maxTurns | mo ta |', '| --- | --- | ---: | --- |', ...rows].join('\n');
}

export const BEGIN = '<!-- BEGIN GENERATED: roles (node harness/tools/sync.mjs) -->';
export const END = '<!-- END GENERATED: roles -->';

/** Thay khoi giua marker; tra ve null neu file khong co marker. */
export function replaceBlock(text, table) {
  const i = text.indexOf(BEGIN), j = text.indexOf(END);
  if (i < 0 || j < i) return null;
  return text.slice(0, i) + BEGIN + '\n' + table + '\n' + text.slice(j);
}

// Tach frontmatter (thuan, khong I/O). Dung chung cho core/agents va tools/adapters.
// { fm: 'noi dung giua ---', fmRaw: nguyen khoi gom ---, body, data: {k:v} } hoac null neu khong co.
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text || '');
  if (!m) return null;
  const data = {};
  for (const ln of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(ln);
    if (k) data[k[1]] = k[2].replace(/^["']|["']$/g, '');
  }
  return { fm: m[1], fmRaw: m[0].replace(/\r?\n$/, ''), body: text.slice(m[0].length), data };
}
