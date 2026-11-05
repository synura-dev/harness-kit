// Token tu transcript tai hook Stop/SubagentStop: chi doc DUOI file (tran 512KB, timeout 200ms), cong message.usage cua cac message assistant MOI
// ke tu lan Stop truoc (offset theo transcript luu trong <audit root>/.state/usage-offsets.json). Fail-open: loi -> null, khong nem.
import fs from 'node:fs';
import path from 'node:path';

export const USAGE_TAIL = Object.freeze({ maxBytes: 524288, timeoutMs: 200, maxEntries: 200 });

const stateFile = (root) => (root ? path.join(String(root), '.state', 'usage-offsets.json') : null);
const readState = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
function writeState(f, st) {
  try {
    const keys = Object.keys(st);
    if (keys.length > USAGE_TAIL.maxEntries) for (const k of keys.sort((a, b) => (st[a].ts || 0) - (st[b].ts || 0)).slice(0, keys.length - USAGE_TAIL.maxEntries)) delete st[k];
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, f);
  } catch { /* fail-open */ }
}

/** Thuan: text (cac dong jsonl) -> {input, output, cache_read, cache_creation, msgs, model}. Mot message.id lap theo content block -> lay ban output lon nhat. */
export function sumUsage(text, deadline = Infinity) {
  const by = new Map(); let model = null;
  for (const line of String(text).split('\n')) {
    if (Date.now() > deadline) return null;
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e && e.type === 'assistant' && e.message;
    if (!m || !m.usage || typeof m.usage !== 'object') continue;
    const id = m.id || e.uuid || String(by.size);
    const prev = by.get(id);
    if (!prev || (m.usage.output_tokens || 0) >= (prev.output_tokens || 0)) by.set(id, m.usage);
    if (m.model && m.model !== '<synthetic>') model = m.model;
  }
  const r = { input: 0, output: 0, cache_read: 0, cache_creation: 0, msgs: by.size, model };
  for (const u of by.values()) { r.input += u.input_tokens || 0; r.output += u.output_tokens || 0; r.cache_read += u.cache_read_input_tokens || 0; r.cache_creation += u.cache_creation_input_tokens || 0; }
  return r;
}

/** Doc phan moi cua transcript `file` ke tu offset da luu (key = ten file). root: thu muc audit (cho state); thieu -> khong luu offset. */
export function readUsageDelta(file, { root = null, limits = USAGE_TAIL, now = Date.now } = {}) {
  try {
    if (typeof file !== 'string' || !/\.jsonl$/i.test(file)) return null;
    const deadline = now() + limits.timeoutMs;
    const st = fs.statSync(file); if (!st.isFile()) return null;
    const sf = stateFile(root); const state = sf ? readState(sf) : {};
    const key = path.basename(file);
    let prev = Number(state[key] && state[key].off) || 0;
    if (prev > st.size) prev = 0; // transcript bi cat/xoay
    const start = Math.max(prev, st.size - limits.maxBytes);
    const len = st.size - start;
    if (len <= 0) return { input: 0, output: 0, cache_read: 0, cache_creation: 0, msgs: 0, model: null, truncated: false };
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    let text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl >= 0 ? text.slice(0, lastNl + 1) : ''; // bo dong cuoi dang ghi do
    const jumped = start > prev; // nhay vao giua file (qua tran) -> dong dau co the bi cat: bo
    if (jumped) { const nl = complete.indexOf('\n'); text = nl >= 0 ? complete.slice(nl + 1) : ''; } else text = complete;
    const r = sumUsage(text, deadline);
    if (!r) return null; // het gio: khong tien offset (lan sau doc lai)
    if (sf) { state[key] = { off: start + Buffer.byteLength(complete, 'utf8'), ts: Date.now() }; writeState(sf, state); }
    return { ...r, truncated: jumped };
  } catch { return null; }
}
