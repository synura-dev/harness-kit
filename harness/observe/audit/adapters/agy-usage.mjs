// Parser thuan transcript agy (khong fs, khong import audit): usage theo buoc MODEL, thoi luong buoc GENERIC, exit code.
// Shape sumAgyUsage khop sumUsage (usage-tail.mjs).

/** text (jsonl) -> {input, output, cache_read, cache_creation:0, total_tokens, msgs, model:null}; het deadline -> null. Dedupe step_index (lay output lon nhat). */
export function sumAgyUsage(text, deadline = Infinity) {
  const by = new Map();
  for (const line of String(text).split('\n')) {
    if (Date.now() > deadline) return null;
    if (!line.includes('"input_tokens"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.source !== 'MODEL' || typeof e.input_tokens !== 'number') continue;
    const k = e.step_index ?? `n${by.size}`;
    const prev = by.get(k);
    if (!prev || (e.output_tokens || 0) >= (prev.output_tokens || 0)) by.set(k, e);
  }
  const r = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total_tokens: 0, msgs: by.size, model: null };
  for (const e of by.values()) { r.input += e.input_tokens || 0; r.output += e.output_tokens || 0; r.cache_read += e.cache_read_tokens || 0; }
  r.total_tokens = r.input + r.output; // khop tokens_in+tokens_out
  return r;
}

const CREATED = /Created At:\s*(\S+)/;
const COMPLETED = /Completed At:\s*(\S+)/;

/** text -> Map step_index -> ms (Created At/Completed At ISO co mui gio); thieu Completed/khong parse duoc -> bo. */
export function stepDurations(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.includes('Created At:')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.step_index !== 'number') continue;
    const c = typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? '');
    const a = CREATED.exec(c), b = COMPLETED.exec(c);
    if (!a || !b) continue;
    const ms = Date.parse(b[1]) - Date.parse(a[1]);
    if (Number.isFinite(ms) && ms >= 0) out.set(e.step_index, ms);
  }
  return out;
}

/** "Command exited with code N." -> N | null */
export function exitCodeOf(content) {
  const m = /Command exited with code (-?\d+)/.exec(String(content ?? ''));
  return m ? Number(m[1]) : null;
}

/** "exit status N" -> N | null */
export function exitStatusOf(err) {
  const m = /exit status (-?\d+)/.exec(String(err ?? ''));
  return m ? Number(m[1]) : null;
}
