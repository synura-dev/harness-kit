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

const DUR = /^Created At:\s*(\S+)\nCompleted At:\s*(\S+)/;

const durOf = (e) => {
  if (!e || e.type !== 'GENERIC' || typeof e.content !== 'string') return null;
  const m = DUR.exec(e.content); if (!m) return null;
  const ms = Date.parse(m[2]) - Date.parse(m[1]);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

/** text -> Map step_index -> ms (chi dong GENERIC, content bat dau Created At/Completed At); khong khop/am -> bo. */
export function stepDurations(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.includes('Created At:')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ms = durOf(e);
    if (ms !== null && typeof e.step_index === 'number') out.set(e.step_index, ms);
  }
  return out;
}

/** Thoi luong mot buoc GENERIC theo step_index -> ms | null; dung som khi thay, het deadline -> null. */
export function stepDuration(text, stepIdx, deadline = Infinity) {
  const n = Number(stepIdx); if (!Number.isInteger(n)) return null;
  const pat = `"step_index":${n}`;
  for (const line of String(text).split('\n')) {
    if (Date.now() > deadline) return null;
    if (!line.includes(pat)) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e && e.type === 'GENERIC' && e.step_index === n) return durOf(e);
  }
  return null;
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
