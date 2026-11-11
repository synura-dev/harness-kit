// Trung gan dung noi dung (memory/rule/knowledge): khoi heading/bullet -> 5-shingle tu -> chi muc nguoc -> Jaccard.
// Tat dinh, chi xuat vi tri + diem, KHONG xuat noi dung khoi.
import fs from 'node:fs';
import path from 'node:path';
import { spawnTimed, killTree } from '../../core/runtime/proc.mjs';
import { LIMITS, foldText } from '../../observe/report/cost-contract.mjs';

export const SHINGLE = 5;
export const MIN_WORDS = 8; // khoi < 8 tu bo qua (ma/mà, tieu de ngan)
export const THRESHOLD = 0.6;
export const EXPORT_MAX_BYTES = 8000000;
const FILE_CAP = { maxFiles: 200, maxFileBytes: 200000, maxTotalBytes: 2000000 };

/** Chia theo heading/bullet/dong trong; dong tiep noi vao khoi dang mo. -> [{line, text}] (line 1-based). */
export function blocksOf(text) {
  const out = [];
  let cur = null;
  const lines = String(text ?? '').split('\n');
  if (/^---\s*$/.test(lines[0] || '')) { // bo frontmatter YAML, giu so dong
    const end = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
    if (end > 0) for (let i = 0; i <= end; i++) lines[i] = '';
  }
  lines.forEach((raw, i) => {
    const l = raw.trim();
    if (!l) { cur = null; return; }
    if (!cur || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(l)) { cur = { line: i + 1, text: l }; out.push(cur); } else cur.text += ' ' + l;
  });
  return out;
}

const INDEX_LINE = /^[-*]\s*\[[^\]]*\]\([^)]*\.md\)/; // dong index MEMORY.md
const LABELS = /\*\*(why|how to apply):?\*\*:?/gi; // nhan boilerplate
const wordsOf = (t) => foldText(t.replace(LABELS, ' ')).split(/[^a-z0-9]+/).filter(Boolean);
function shingles(words) {
  const s = new Set();
  for (let i = 0; i + SHINGLE <= words.length; i++) s.add(words.slice(i, i + SHINGLE).join(' '));
  return s;
}
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** sources: [{name, text, sep}] (sep ':' file, '#' knowledge id). -> {pairs:[{a,b,score}], truncated} */
export function findContentDupes(sources, { threshold = THRESHOLD, maxBlocks = LIMITS.maxBlocks, maxPairs = LIMITS.maxDupPairs, timeoutMs = LIMITS.timeoutMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  let truncated = null;
  const per = sources.map((s) => {
    const l = [];
    for (const b of blocksOf(s.text)) {
      if (INDEX_LINE.test(b.text)) continue;
      const w = wordsOf(b.text);
      if (w.length >= MIN_WORDS) l.push({ file: s.name, line: b.line, loc: `${s.name}${s.sep || ':'}${b.line}`, sh: shingles(w) });
    }
    return l;
  });
  // tran maxBlocks: chia deu theo nguon (vong tron), khong cat duoi
  const blocks = [];
  const total = per.reduce((n, l) => n + l.length, 0);
  if (total > maxBlocks) truncated = 'max_blocks';
  for (let r = 0; blocks.length < Math.min(total, maxBlocks); r++) {
    for (const l of per) if (r < l.length && blocks.length < maxBlocks) blocks.push(l[r]);
  }
  const index = new Map();
  blocks.forEach((b, i) => { for (const sh of b.sh) { const l = index.get(sh); if (l) l.push(i); else index.set(sh, [i]); } });
  const pairs = [];
  for (let i = 0; i < blocks.length; i++) {
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
    const x = blocks[i], cand = new Map();
    for (const sh of x.sh) for (const j of index.get(sh)) if (j > i) cand.set(j, (cand.get(j) || 0) + 1);
    for (const [j, inter] of cand) {
      const y = blocks[j];
      if (x.file === y.file) continue; // chi tinh trung giua cac nguon khac nhau
      const score = inter / (x.sh.size + y.sh.size - inter);
      if (score < threshold) continue;
      const [a, b] = cmp(x.loc, y.loc) <= 0 ? [x, y] : [y, x];
      pairs.push({ a: { file: a.file, line: a.line, loc: a.loc }, b: { file: b.file, line: b.line, loc: b.loc }, score: Math.round(score * 1000) / 1000 });
    }
  }
  pairs.sort((p, q) => q.score - p.score || cmp(p.a.loc, q.a.loc) || cmp(p.b.loc, q.b.loc));
  if (pairs.length > maxPairs) { pairs.length = maxPairs; truncated = truncated || 'max_pairs'; }
  return { pairs, truncated };
}

/** Chay `harness knowledge export --json` qua proc.mjs co timeout. Tra stdout. */
export function runExport({ timeoutMs = LIMITS.timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawnTimed('harness', ['knowledge', 'export', '--json', '--max-bytes', String(EXPORT_MAX_BYTES)], { timeoutMs, cwd });
    let out = '', over = false;
    c.stdout.on('data', (d) => {
      if (over) return;
      out += d;
      if (out.length > EXPORT_MAX_BYTES) { over = true; out = ''; killTree(c.pid); }
    });
    c.stderr.on('data', () => {}); // xa stderr, khong ket pipe
    c.on('error', reject);
    c.on('close', (code) => {
      if (over) reject(Object.assign(new Error('max_bytes'), { code: 'max_bytes' }));
      else if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}`));
    });
  });
}

/** Fail-open: loi/khong co lenh -> sources [] + truncated 'knowledge: no_export'. */
export async function loadKnowledge({ run = runExport, timeoutMs } = {}) {
  try {
    const j = JSON.parse(await run({ timeoutMs }));
    if (!j || !Array.isArray(j.docs)) throw new Error('shape');
    const sources = j.docs.filter((d) => d && d.id && typeof d.body === 'string').map((d) => ({ name: String(d.id), text: d.body, sep: '#' }));
    return { sources, truncated: j.truncated ? `knowledge: ${typeof j.truncated === 'string' ? j.truncated : 'truncated'}` : null };
  } catch (e) {
    return { sources: [], truncated: e && e.code === 'max_bytes' ? 'knowledge: max_bytes' : 'knowledge: no_export' };
  }
}

// Chi nhan duong dan co realpath nam trong root (khong theo symlink ra ngoai).
function inside(real, p) { try { const r = fs.realpathSync(p); return r === real || r.startsWith(real + path.sep); } catch { return false; } }
function listMd(real, dir) {
  if (!inside(real, dir)) return [];
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(dir, f)); } catch { return []; }
}

/** Nguon file (CLAUDE.md, AGENTS.md, .claude/agents, .claude/memory) + knowledge. Tran file/byte -> truncated. */
export async function collectSources({ root, run, timeoutMs, maxFiles = FILE_CAP.maxFiles, maxFileBytes = FILE_CAP.maxFileBytes, maxTotalBytes = FILE_CAP.maxTotalBytes } = {}) {
  let real; try { real = fs.realpathSync(root); } catch { real = root; }
  const files = [path.join(root, 'CLAUDE.md'), path.join(root, 'AGENTS.md'), ...listMd(real, path.join(root, '.claude/agents')), ...listMd(real, path.join(root, '.claude/memory'))];
  const sources = [];
  const reasons = [];
  let total = 0;
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (!inside(real, f)) continue;
    if (sources.length >= maxFiles) { reasons.push('max_files'); break; }
    if (st.size > maxFileBytes || total + st.size > maxTotalBytes) { reasons.push('max_bytes'); continue; }
    total += st.size;
    try { sources.push({ name: path.relative(root, f), text: fs.readFileSync(f, 'utf8'), sep: ':' }); } catch { /* bo qua */ }
  }
  const k = await loadKnowledge({ run, timeoutMs });
  if (k.truncated) reasons.push(k.truncated);
  return { sources: [...sources, ...k.sources], truncated: reasons.length ? [...new Set(reasons)].join(',') : null };
}
