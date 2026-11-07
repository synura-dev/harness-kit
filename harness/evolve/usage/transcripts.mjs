// Doc transcript Claude Code (~/.claude/projects/**/*.jsonl, gom subagents/), co tran + cache tang dan theo file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

// Tran ap cho byte THUC SU parse lan chay nay (cache hit mien phi).
// shortcut: cold = cache rong -> tran lon 4GB/120s de lan dau xong gan het; warm = 512MB/20s.
// Con so do tu may that (2.5GB/4277 file/30 ngay), khong suy ra tu cong thuc; ghi de bang `limits`.
export const TRANSCRIPTS = Object.freeze({
  limits: Object.freeze({ timeoutMs: 20000, maxBytes: 512 * 1048576, maxFiles: 5000 }),
  coldLimits: Object.freeze({ timeoutMs: 120000, maxBytes: 4096 * 1048576, maxFiles: 20000 }),
});
const MARK = ['"Skill"', '<command-name>', 'SKILL.md', '.md"', 'subagent_type'];
const CMD_RE = /<command-name>[\s\S]*?<\/command-name>/;

function walk(dir, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.jsonl')) out.push(p);
  }
}

// prompt that cua nguoi dung: content la chuoi hoac co khoi text (khong phai tool_result)
function isPrompt(m) {
  if (m?.type !== 'user') return false;
  const c = m.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && c.some((b) => b?.type === 'text'));
}

// Chi giu thu detector can.
export function compactMsg(m) {
  const c = m?.message?.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  const content = [];
  for (const b of blocks) {
    if (b?.type === 'tool_use') {
      const i = b.input || {};
      const input = {};
      for (const k of ['skill', 'file_path', 'subagent_type']) if (i[k] !== undefined) input[k] = i[k];
      content.push({ type: 'tool_use', id: b.id, name: b.name, input });
    } else if (b?.type === 'text' && typeof b.text === 'string') {
      const x = b.text.match(CMD_RE);
      if (x) content.push({ type: 'text', text: x[0] });
    }
  }
  const r = { type: m?.type, uuid: m?.uuid, message: { role: m?.message?.role, content } };
  if (m?.isSidechain !== undefined) r.isSidechain = m.isSidechain;
  return r;
}

function loadCache(file) {
  const m = new Map();
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { return m; }
  for (const l of txt.split('\n')) { if (!l) continue; try { const e = JSON.parse(l); if (e?.file) m.set(e.file, e); } catch { /* bo dong hong */ } }
  return m;
}
function saveCache(file, m) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, [...m.values()].map((e) => JSON.stringify(e)).join('\n') + (m.size ? '\n' : ''));
  fs.renameSync(tmp, file);
}

export async function readTranscripts({ roots = [path.join(os.homedir(), '.claude', 'projects')], fromMs = 0, nowMs = Date.now(), limits = {}, cacheFile = null } = {}) {
  const cache = cacheFile ? loadCache(cacheFile) : null;
  const L = { ...(cache && cache.size === 0 ? TRANSCRIPTS.coldLimits : TRANSCRIPTS.limits), ...limits };
  const deadline = Date.now() + L.timeoutMs;
  const records = []; let cache_hits = 0, files_parsed = 0, bytes_parsed = 0, truncated = null;
  let earliest = Infinity, latest = -Infinity, eTs = null, lTs = null;
  const seen = new Set(); const fresh = new Map();
  const allSess = new Map(); // sessionId -> ts lon nhat tren MOI dong (khong chi dong khop prefilter) -> total_sessions chinh xac
  const mergeSess = (o) => { for (const [k, v] of Object.entries(o)) if (!allSess.has(k) || v > allSess.get(k)) allSess.set(k, v); };
  const add = (r) => {
    records.push(r);
    const ts = Date.parse(r.ts);
    if (ts < earliest) { earliest = ts; eTs = r.ts; }
    if (ts > latest) { latest = ts; lTs = r.ts; }
  };
  outer: for (const root of roots) {
    const all = []; walk(root, all);
    for (const f of all) {
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < fromMs) continue;
      seen.add(f);
      const hit = cache?.get(f);
      if (hit && hit.sess && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { cache_hits++; mergeSess(hit.sess); for (const r of hit.records) add(r); continue; }
      if (files_parsed >= L.maxFiles) { truncated = 'max_files'; break outer; }
      if (bytes_parsed + st.size > L.maxBytes) { truncated = 'max_bytes'; break outer; }
      bytes_parsed += st.size; files_parsed++;
      const rel = path.relative(root, f).split(path.sep);
      const project = rel.length > 1 ? rel[0] : '';
      const rl = createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
      let n = 0, turn = 0; const mine = []; const sess = {};
      for await (const line of rl) {
        if ((++n & 255) === 0 && Date.now() > deadline) { truncated = 'timeout'; rl.close(); break; }
        if (!line) continue;
        const si = line.indexOf('"sessionId":"'); // khong JSON.parse: chi cat chuoi sessionId + timestamp
        if (si >= 0) {
          const sid = line.slice(si + 13, line.indexOf('"', si + 13)); const ti = line.indexOf('"timestamp":"');
          const tv = ti >= 0 ? line.slice(ti + 13, line.indexOf('"', ti + 13)) : '';
          if (sid && tv && (!sess[sid] || tv > sess[sid])) sess[sid] = tv;
        }
        const marked = MARK.some((k) => line.includes(k));
        // dong user co the khong chua MARK nhung van phai dem turn
        if (!marked && !line.includes('"user"')) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (isPrompt(msg)) turn++;
        if (!marked) continue;
        mine.push({ session: msg.sessionId, project: project || msg.cwd || '', ts: msg.timestamp, turn: `${f}#${turn}`, file: f, msg: cache ? compactMsg(msg) : msg });
      }
      for (const r of mine) add(r);
      mergeSess(sess);
      if (truncated) break outer; // file dang do khong cache
      if (cache) fresh.set(f, { file: f, mtimeMs: st.mtimeMs, size: st.size, records: mine, sess });
    }
  }
  if (cache) {
    // giu entry cu con ton tai + trong cua so (ke ca file chua tham do vi bi cat); entry moi ghi de
    const out = new Map();
    for (const [f, e] of cache) {
      if (seen.has(f)) { out.set(f, e); continue; }
      try { if (fs.statSync(f).mtimeMs >= fromMs) out.set(f, e); } catch { /* da xoa */ }
    }
    for (const [f, e] of fresh) out.set(f, e);
    saveCache(cacheFile, out);
  }
  let total_sessions = 0; for (const v of allSess.values()) if (Date.parse(v) >= fromMs) total_sessions++;
  return { records, total_sessions, truncated, files_read: cache_hits + files_parsed, cache_hits, files_parsed, bytes_parsed, earliest_ts: eTs, latest_ts: lTs };
}
