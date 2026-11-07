// Doc transcript Claude Code (~/.claude/projects/**/*.jsonl, gom subagents/), co tran.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const TRANSCRIPTS = Object.freeze({ limits: Object.freeze({ timeoutMs: 20000, maxBytes: 512 * 1048576, maxFiles: 5000 }) });
const MARK = ['"Skill"', '<command-name>', 'SKILL.md', '.md"', 'subagent_type'];

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

export async function readTranscripts({ roots = [path.join(os.homedir(), '.claude', 'projects')], fromMs = 0, nowMs = Date.now(), limits = {} } = {}) {
  const L = { ...TRANSCRIPTS.limits, ...limits };
  const deadline = Date.now() + L.timeoutMs;
  const records = []; let files_read = 0, bytes = 0, truncated = null;
  let earliest = Infinity, latest = -Infinity, eTs = null, lTs = null;
  outer: for (const root of roots) {
    const all = []; walk(root, all);
    for (const f of all) {
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < fromMs) continue;
      if (files_read >= L.maxFiles) { truncated = 'max_files'; break outer; }
      if (bytes + st.size > L.maxBytes) { truncated = 'max_bytes'; break outer; }
      bytes += st.size; files_read++;
      const rel = path.relative(root, f).split(path.sep);
      const project = rel.length > 1 ? rel[0] : '';
      const rl = createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
      let n = 0, turn = 0;
      for await (const line of rl) {
        if ((++n & 255) === 0 && Date.now() > deadline) { truncated = 'timeout'; rl.close(); break outer; }
        if (!line) continue;
        const hit = MARK.some((k) => line.includes(k));
        // dong user co the khong chua MARK nhung van phai dem turn
        if (!hit && !line.includes('"user"')) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (isPrompt(msg)) turn++;
        if (!hit) continue;
        const ts = Date.parse(msg.timestamp);
        records.push({ session: msg.sessionId, project: project || msg.cwd || '', ts: msg.timestamp, turn: `${f}#${turn}`, file: f, msg });
        if (ts < earliest) { earliest = ts; eTs = msg.timestamp; }
        if (ts > latest) { latest = ts; lTs = msg.timestamp; }
      }
    }
  }
  return { records, truncated, files_read, earliest_ts: eTs, latest_ts: lTs };
}
