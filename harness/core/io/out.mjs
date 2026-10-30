// Dau ra dung chung cho CLI harness. parseCommon(argv) -> {json,raw,maxBytes,timeoutS,rest}; emit({summary,data,truncated,raw}, opts).
// Mac dinh: in summary. --json: in data (JSON). --raw: in raw (neu co) else summary. Nhan truncated duy nhat: "truncated: <ly do>" (stderr khi --json).
const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

export function parseCommon(argv = []) {
  const o = { json: false, raw: false, maxBytes: null, timeoutS: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--raw') o.raw = true;
    else if (a === '--max-bytes') o.maxBytes = posNum(argv[++i]);
    else if (a === '--timeout-s') o.timeoutS = posNum(argv[++i]);
    else if (a.startsWith('--max-bytes=')) o.maxBytes = posNum(a.slice(12));
    else if (a.startsWith('--timeout-s=')) o.timeoutS = posNum(a.slice(12));
    else o.rest.push(a);
  }
  return o;
}

function truncateBytes(s, max) {
  const b = Buffer.from(String(s), 'utf8');
  if (!max || b.length <= max) return { text: String(s), cut: false };
  return { text: b.subarray(0, max).toString('utf8').replace(/�+$/, ''), cut: true };
}

// Tra { text, label }; in ra tru khi opts.write === false.
export function emit({ summary = '', data, truncated, raw } = {}, opts = {}) {
  const out = opts.out || ((s) => console.log(s));
  const err = opts.err || ((s) => console.error(s));
  let text = opts.json ? JSON.stringify(data === undefined ? { summary } : data, null, 2) : opts.raw && raw != null ? String(raw) : String(summary);
  let reason = truncated ? (truncated === true ? 'limit' : String(truncated)) : null;
  const t = truncateBytes(text, opts.maxBytes);
  if (t.cut) { text = t.text; reason = reason || `max-bytes ${opts.maxBytes}`; }
  const label = reason ? `truncated: ${reason}` : null;
  if (opts.write === false) return { text, label };
  out(text);
  if (label) (opts.json ? err : out)(label);
  return { text, label };
}

/** So nguyen duong hoac null (tham so CLI --limit/--days...). Dung chung cac cli. */
export const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** Cat danh sach dong den toi da max dong, them dong "+N dong" khi vuot. */
export const capLines = (lines, max) => (lines.length > max ? [...lines.slice(0, max - 1), `... +${lines.length - max + 1} dong (dung --json)`] : lines);
