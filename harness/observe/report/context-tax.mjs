// Thue context: token cua phan luon nap moi phien (CLAUDE.md + @import, MEMORY.md, mo ta skill) uoc bytes/4, hieu chinh bang
// data.usage.first_ctx (Stop dau moi sid). Dong lap CHI giua cac file nap san (foldText, khop chinh xac); memory/agents da co content-dupes.
// Chi xuat so + file:dong, khong noi dung.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldText, median } from './cost-contract.mjs';
import { workspaceRoot } from '../../core/io/paths.mjs';

export const CTX = Object.freeze({ maxFiles: 300, maxBytes: 262144, memoryLines: 200, minLine: 30, maxGroups: 50, maxLocs: 4, maxImports: 8 });
const PLUGIN_SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');
const tok = (bytes) => Math.ceil(bytes / 4);
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return ''; } };
const lsDirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };

/** Doc file nho, chi khi realpath nam trong root. -> {text, cut} | null (loi/ngoai root). */
function readIn(root, f, max = CTX.maxBytes) {
  try {
    const rp = fs.realpathSync(f);
    if (!root || (rp !== root && !rp.startsWith(root + path.sep))) return null;
    const b = fs.readFileSync(rp);
    return { text: b.subarray(0, max).toString('utf8'), cut: b.length > max };
  } catch { return null; }
}

/** Dong dem duoc de tim trung: bo frontmatter dau file, code fence, dong bang markdown. -> [{s, line}] */
export function countableLines(text) {
  const out = []; const ls = text.split(/\r?\n/);
  let i = 0; let fence = false;
  if (ls[0] && ls[0].trim() === '---') { const e = ls.findIndex((l, k) => k > 0 && l.trim() === '---'); if (e > 0) i = e + 1; }
  for (; i < ls.length; i++) {
    const s = ls[i].trim();
    if (/^(```|~~~)/.test(s)) { fence = !fence; continue; }
    if (fence || s.startsWith('|') || s.length < CTX.minLine) continue;
    out.push({ s, line: i + 1 });
  }
  return out;
}

/** description trong frontmatter, gom ca khoi nhieu dong (`>`, `|`, hoac tiep tuc thut le). -> chuoi */
export function skillDesc(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return '';
  const ls = m[1].split(/\r?\n/);
  const i = ls.findIndex((l) => /^description:/.test(l));
  if (i < 0) return '';
  const parts = []; const first = ls[i].replace(/^description:[ \t]*/, '');
  if (!/^[>|][+-]?\d*$/.test(first.trim())) parts.push(first);
  for (let k = i + 1; k < ls.length && (/^[ \t]+\S/.test(ls[k]) || ls[k].trim() === ''); k++) parts.push(ls[k].trim());
  return parts.join('\n').trim();
}

/** Quet file nap san. -> {ruleBytes, memTokens, skillsTok, dupLines, dupRows, truncated}. */
export function scanLoaded({ projectDir, deadline = Infinity } = {}) {
  const res = { ruleBytes: 0, memTokens: null, skillsTok: 0, dupLines: 0, dupRows: [], truncated: null };
  const root = projectDir ? realOf(projectDir) : '';
  if (!root) return res;
  const trunc = (why) => { res.truncated = res.truncated || why; };
  let reads = 0;
  // partial: chi can phan dau (SKILL.md: mo ta o frontmatter) -> cat khong tinh la truncated
  const rd = (r, f, max, partial) => { if (++reads > CTX.maxFiles) { trunc('max_files'); return null; } const x = readIn(r, f, max); if (x && x.cut && !partial) trunc('max_bytes'); return x; };
  const files = [];
  const claude = rd(root, path.join(root, 'CLAUDE.md'));
  if (claude) {
    let n = 0;
    files.push({ file: 'CLAUDE.md', text: claude.text }); res.ruleBytes += Buffer.byteLength(claude.text);
    for (const m of claude.text.matchAll(/^@(\S+)\s*$/gm)) {
      if (n++ >= CTX.maxImports) { trunc('max_files'); break; }
      const t = rd(root, path.resolve(root, m[1]));
      if (t) { files.push({ file: m[1], text: t.text }); res.ruleBytes += Buffer.byteLength(t.text); }
    }
  }
  const mem = rd(root, path.join(root, '.claude', 'memory', 'MEMORY.md'));
  if (mem) {
    const t = mem.text.split(/\r?\n/).slice(0, CTX.memoryLines).join('\n');
    res.memTokens = tok(Buffer.byteLength(t)); files.push({ file: '.claude/memory/MEMORY.md', text: t });
  }
  let skillBytes = 0;
  for (const base of [PLUGIN_SKILLS, path.join(root, '.claude', 'skills')]) {
    const br = realOf(base);
    for (const d of lsDirs(base)) {
      if (Date.now() > deadline) { trunc('timeout'); break; }
      const t = rd(br, path.join(base, d, 'SKILL.md'), 8192, true);
      if (!t) continue;
      const desc = skillDesc(t.text);
      skillBytes += Buffer.byteLength(d) + Buffer.byteLength(desc);
      files.push({ file: `skill:${d}`, text: desc });
    }
  }
  res.skillsTok = tok(skillBytes);
  const seen = new Map();
  for (const { file, text } of files) {
    if (Date.now() > deadline) { trunc('timeout'); break; }
    for (const { s, line } of countableLines(text)) {
      const k = foldText(s); let g = seen.get(k); if (!g) seen.set(k, g = []);
      if (!g.some((x) => x.file === file)) g.push({ file, line });
    }
  }
  for (const g of seen.values()) {
    if (g.length < 2) continue;
    res.dupLines++;
    if (res.dupRows.length < CTX.maxGroups) res.dupRows.push({ loc: g.slice(0, CTX.maxLocs).map((x) => `${x.file}:${x.line}`).join(' = '), n: g.length });
  }
  return res;
}

/** Tinh the context. opts: {projectDir, events, deadline, memo}. memo (doi tuong chung moi buildReport) luu ket qua quet. */
export function contextTax({ projectDir, events = [], deadline = Infinity, memo } = {}) {
  const mk = projectDir || '';
  let sc = memo && memo[mk];
  if (!sc) { sc = scanLoaded({ projectDir, deadline }); if (memo && sc.truncated !== 'timeout') memo[mk] = sc; }
  const rows = []; const put = (name, tokens) => { if (tokens != null) rows.push({ name, tokens }); };
  if (projectDir && realOf(projectDir)) {
    put('rules_tokens', tok(sc.ruleBytes));
    put('memory_index_tokens', sc.memTokens);
    put('skills_desc_tokens', sc.skillsTok);
    put('static_tokens', tok(sc.ruleBytes) + (sc.memTokens || 0) + sc.skillsTok);
    put('dup_lines', sc.dupLines);
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
  return { rows, dupRows: sc.dupRows, truncated: sc.truncated };
}

// Thu tu thu muc: a.projectDir (buildReport) -> env -> workspace hub.
const proj = (a) => { if (a.projectDir) return a.projectDir; if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR; try { return workspaceRoot(); } catch { return ''; } };
export const derive = {
  context_tax: (a) => { const r = contextTax({ projectDir: proj(a), events: a.events, deadline: a.deadline, memo: a.memo }); return { rows: r.rows, truncated: r.truncated }; },
  context_dupes: (a) => { const r = contextTax({ projectDir: proj(a), events: [], deadline: a.deadline, memo: a.memo }); return { rows: r.dupRows, truncated: r.truncated }; },
};
