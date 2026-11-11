// Token tu transcript tai hook Stop/SubagentStop: chi doc DUOI file (tran 512KB, timeout 200ms), cong message.usage cua cac message assistant MOI
// ke tu lan Stop truoc (offset byte theo transcript, moi transcript mot file trong <audit root>/.state/usage-offsets/). Fail-open: loi -> null, khong nem.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const USAGE_TAIL = Object.freeze({ maxBytes: 524288, timeoutMs: 200, maxEntries: 200 });

// Moi transcript mot file offset (ten = sha1 cua duong dan tuyet doi): Stop/SubagentStop cua transcript khac nhau khong de nhau; ghi atomic tmp+rename.
const stateDir = (root) => (root ? path.join(String(root), '.state', 'usage-offsets') : null);
const stateFile = (root, file) => { const d = stateDir(root); return d ? path.join(d, createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 20) + '.json') : null; };
const readState = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
function writeState(f, st) {
  try {
    const dir = path.dirname(f);
    const isNew = !fs.existsSync(f);
    fs.mkdirSync(dir, { recursive: true });
    const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, f);
    if (isNew) { // chi khi them file moi: giu <= maxEntries file (xoa cu nhat)
      const ents = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
      if (ents.length > USAGE_TAIL.maxEntries) {
        const aged = ents.map((n) => { try { return [n, fs.statSync(path.join(dir, n)).mtimeMs]; } catch { return [n, 0]; } }).sort((x, y) => x[1] - y[1]);
        for (const [n] of aged.slice(0, ents.length - USAGE_TAIL.maxEntries)) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* bo qua */ } }
      }
    }
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
  const r = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total_tokens: 0, msgs: by.size, model };
  for (const u of by.values()) { r.input += u.input_tokens || 0; r.output += u.output_tokens || 0; r.cache_read += u.cache_read_input_tokens || 0; r.cache_creation += u.cache_creation_input_tokens || 0; }
  const f0 = by.values().next().value; // message DAU trong delta (Map giu thu tu chen): kich thuoc context luc vao
  if (f0) r.first_ctx = (f0.input_tokens || 0) + (f0.cache_creation_input_tokens || 0) + (f0.cache_read_input_tokens || 0);
  r.total_tokens = r.input + r.output + r.cache_creation; // khop tokens_in+tokens_out (khong tinh cache_read)
  return r;
}

/** Doc phan moi cua transcript `file` ke tu offset da luu (moi transcript mot file offset). root: thu muc audit (cho state); thieu -> khong luu offset. */
export function readUsageDelta(file, { root = null, limits = USAGE_TAIL, now = Date.now, sum = sumUsage } = {}) {
  try {
    if (typeof file !== 'string' || !/\.jsonl$/i.test(file)) return null;
    const deadline = now() + limits.timeoutMs;
    const st = fs.statSync(file); if (!st.isFile()) return null;
    const sf = stateFile(root, file); const state = sf ? readState(sf) : {};
    let prev = Number(state.off) || 0;
    if (prev > st.size) prev = 0; // transcript bi cat/xoay
    const start = Math.max(prev, st.size - limits.maxBytes);
    const len = st.size - start;
    if (len <= 0) return { input: 0, output: 0, cache_read: 0, cache_creation: 0, total_tokens: 0, msgs: 0, model: null, truncated: false };
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    // Offset tinh tren BYTE tho (khong qua chuoi giai ma): dong cuoi chua xong (khong co \n) bi bo, lan sau doc lai.
    const lastNl = buf.lastIndexOf(0x0a);
    const complete = lastNl >= 0 ? buf.subarray(0, lastNl + 1) : buf.subarray(0, 0);
    const jumped = start > prev; // nhay vao giua file (qua tran) -> dong dau co the bi cat (ke ca giua ky tu UTF-8): bo
    let body = complete;
    if (jumped) { const nl = complete.indexOf(0x0a); body = nl >= 0 ? complete.subarray(nl + 1) : complete.subarray(0, 0); }
    const text = body.toString('utf8');
    const r = sum(text, deadline);
    if (!r) return null; // het gio: khong tien offset (lan sau doc lai)
    if (sf) writeState(sf, { off: start + complete.length, ts: Date.now() });
    return { ...r, truncated: jumped };
  } catch { return null; }
}
