// Thue context: token cua phan luon nap moi phien (CLAUDE.md + @import, MEMORY.md, mo ta skill) uoc bytes/4, hieu chinh bang
// data.usage.first_ctx (Stop dau moi sid). Dong lap giua cac file nap san (foldText, khop chinh xac). Chi xuat so + file:dong, khong noi dung.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldText, median } from './cost-contract.mjs';
import { workspaceRoot } from '../../core/io/paths.mjs';

export const CTX = Object.freeze({ maxFiles: 80, maxBytes: 262144, memoryLines: 200, minLine: 30, maxGroups: 50, maxLocs: 4, maxSkills: 300 });
const PLUGIN_SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');
const tok = (bytes) => Math.ceil(bytes / 4);
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return ''; } };

/** Doc file nho, chi khi realpath nam trong root. Loi/ngoai root -> null. */
function readIn(root, f, max = CTX.maxBytes) {
  try {
    const rp = fs.realpathSync(f);
    if (!root || (rp !== root && !rp.startsWith(root + path.sep))) return null;
    return fs.readFileSync(rp).subarray(0, max).toString('utf8');
  } catch { return null; }
}
const lsMd = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => path.join(dir, n)); } catch { return []; } };
const lsDirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };

/** Byte ten + description trong frontmatter SKILL.md (plugin + .claude/skills cua du an). */
function skillDescBytes(root) {
  let bytes = 0; let n = 0;
  for (const base of [PLUGIN_SKILLS, path.join(root, '.claude', 'skills')]) {
    const br = realOf(base);
    for (const d of lsDirs(base)) {
      if (++n > CTX.maxSkills) return bytes;
      const t = readIn(br, path.join(base, d, 'SKILL.md'), 8192);
      if (!t) continue;
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t);
      const desc = m ? /^description:[ \t]*([\s\S]*?)(?=\r?\n[A-Za-z_-]+:|$)/m.exec(m[1]) : null;
      bytes += Buffer.byteLength(d) + (desc ? Buffer.byteLength(desc[1]) : 0);
    }
  }
  return bytes;
}

/** Tinh the context. opts: {projectDir, events, deadline}. -> {rows:[{name,tokens}], dupRows:[{loc,n}], truncated}. */
export function contextTax({ projectDir, events = [], deadline = Infinity } = {}) {
  let truncated = null;
  const over = () => { if (Date.now() > deadline) { truncated = 'timeout'; return true; } return false; };
  const root = projectDir ? realOf(projectDir) : '';
  const rows = [];
  const put = (name, tokens) => { if (tokens != null) rows.push({ name, tokens }); };
  const dupRows = [];
  if (root) {
    let ruleBytes = 0; let memTokens = null; let dupLines = 0;
    const loaded = [];
    const claude = readIn(root, path.join(root, 'CLAUDE.md'));
    if (claude != null) {
      loaded.push({ file: 'CLAUDE.md', text: claude }); ruleBytes += Buffer.byteLength(claude);
      for (const m of claude.matchAll(/^@(\S+)\s*$/gm)) {
        if (loaded.length >= 8) break;
        const t = readIn(root, path.resolve(root, m[1]));
        if (t != null && !loaded.some((x) => x.file === m[1])) { loaded.push({ file: m[1], text: t }); ruleBytes += Buffer.byteLength(t); }
      }
    }
    const mem = readIn(root, path.join(root, '.claude', 'memory', 'MEMORY.md'));
    let memText = null;
    if (mem != null) { memText = mem.split(/\r?\n/).slice(0, CTX.memoryLines).join('\n'); memTokens = tok(Buffer.byteLength(memText)); }
    const skillsTok = tok(skillDescBytes(root));
    const files = [...loaded];
    if (memText != null) files.push({ file: '.claude/memory/MEMORY.md', text: memText });
    for (const dir of ['.claude/memory', '.claude/agents', '.agents/agents']) {
      for (const f of lsMd(path.join(root, dir))) {
        if (files.length >= CTX.maxFiles || over()) break;
        const rel = path.relative(root, f);
        if (files.some((x) => x.file === rel)) continue;
        const t = readIn(root, f); if (t != null) files.push({ file: rel, text: t });
      }
    }
    const seen = new Map();
    for (const { file, text } of files) {
      if (over()) break;
      text.split(/\r?\n/).forEach((l, i) => {
        const s = l.trim(); if (s.length < CTX.minLine) return;
        const k = foldText(s); let g = seen.get(k); if (!g) seen.set(k, g = []);
        if (!g.some((x) => x.file === file)) g.push({ file, line: i + 1 });
      });
    }
    for (const g of seen.values()) {
      if (g.length < 2) continue;
      dupLines++;
      if (dupRows.length < CTX.maxGroups) dupRows.push({ loc: g.slice(0, CTX.maxLocs).map((x) => `${x.file}:${x.line}`).join(' = '), n: g.length });
    }
    put('rules_tokens', tok(ruleBytes));
    put('memory_index_tokens', memTokens);
    put('skills_desc_tokens', skillsTok);
    put('static_tokens', tok(ruleBytes) + (memTokens || 0) + skillsTok);
    put('dup_lines', dupLines);
  }
  // do thuc: Stop dau moi sid (main); usage.truncated -> first_ctx khong tin, bo sid do
  const first = new Map();
  for (const e of events || []) {
    if (!e || e.event !== 'Stop' || e.agent_id || !e.sid || first.has(e.sid)) continue;
    const u = e.data && e.data.usage;
    if (!u) continue;
    if (u.truncated) { first.set(e.sid, null); continue; }
    if (Number.isFinite(u.first_ctx) && u.first_ctx > 0) first.set(e.sid, u.first_ctx);
  }
  const fc = median([...first.values()].filter((v) => v != null));
  if (fc != null) {
    put('first_ctx_tokens', Math.round(fc));
    const st = rows.find((r) => r.name === 'static_tokens');
    if (st && st.tokens > 0) put('calibration_x100', Math.round((fc / st.tokens) * 100));
  }
  return { rows, dupRows, truncated };
}

const proj = () => { if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR; try { return workspaceRoot(); } catch { return ''; } };
export const derive = {
  context_tax: (a) => { const r = contextTax({ projectDir: a.projectDir || proj(), events: a.events, deadline: a.deadline }); return { rows: r.rows, truncated: r.truncated }; },
  context_dupes: (a) => contextTax({ projectDir: a.projectDir || proj(), events: [], deadline: a.deadline }).dupRows,
};
