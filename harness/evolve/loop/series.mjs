// Chuoi thoi gian KPI theo tuan (append-only) + trend. Fail-open, co gioi han doc.
import fs from 'node:fs';
import path from 'node:path';

export const SERIES_LIMITS = { maxLines: 200, maxBytes: 2 * 1024 * 1024 };
const BARS = '▁▂▃▄▅▆▇█';

// Tuan ISO 'YYYY-Www' (tinh theo UTC).
export function isoWeek(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input); // nhan Date hoac ms
  const d =new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear();
  const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

// Doc toi da maxBytes cuoi file, toi da maxLines dong cuoi; dong hong bi bo.
function readLines(file, limits = SERIES_LIMITS) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, limits.maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    let truncated;
    if (size > len) {
      truncated = 'max_bytes';
      text = text.slice(text.indexOf('\n') + 1); // bo dong cat dut o dau
    }
    let lines = text.split('\n').filter(Boolean);
    if (lines.length > limits.maxLines) {
      lines = lines.slice(-limits.maxLines);
      truncated = truncated || 'max_lines';
    }
    return { lines, truncated };
  } catch {
    return { lines: [] };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* bo qua */ }
  }
}

function parse(lines) {
  const out = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o.week === 'string') out.push(o);
    } catch { /* dong hong: bo */ }
  }
  return out;
}

export function readSeries(file) {
  const { lines, truncated } = readLines(file);
  const byWeek = new Map();
  for (const o of parse(lines)) byWeek.set(o.week, o); // dong cuoi thang
  const series = [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));
  return truncated ? { series, truncated } : { series };
}

// Chi append; cung tuan -> rev+1.
export function appendSnapshot(file, { week, kpi = {}, selfdev = {}, nowMs = Date.now() }) {
  const { lines } = readLines(file);
  const rev = parse(lines).filter((o) => o.week === week).reduce((m, o) => Math.max(m, o.rev || 1), 0) + 1;
  const row = { week, ts: new Date(nowMs).toISOString(), rev, kpi, selfdev };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let pre = '';
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      fs.closeSync(fd);
      if (b[0] !== 10) pre = '\n'; // dong cuoi bi cut: tach de dong moi khong dinh vao
    }
  } catch { /* chua co file */ }
  fs.appendFileSync(file, pre + JSON.stringify(row) + '\n');
  return row;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (x) => Math.round(x * 10) / 10;

export function trend(series, key, n = 8, baseline = null) {
  const values = (Array.isArray(series) ? series : []).slice(-n).map((s) => num(s?.kpi?.[key]));
  const valid = values.map((v, i) => [i, v]).filter(([, v]) => v !== null);
  const lo = Math.min(...valid.map(([, v]) => v));
  const hi = Math.max(...valid.map(([, v]) => v));
  const spark = values
    .map((v) => (v === null ? ' ' : BARS[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]))
    .join('');
  let slope = null;
  if (valid.length >= 2) {
    const mx = valid.reduce((a, [i]) => a + i, 0) / valid.length;
    const my = valid.reduce((a, [, v]) => a + v, 0) / valid.length;
    const den = valid.reduce((a, [i]) => a + (i - mx) ** 2, 0);
    slope = valid.reduce((a, [i, v]) => a + (i - mx) * (v - my), 0) / den;
  }
  const last = valid.length ? valid.at(-1)[1] : null;
  const prev = valid.length >= 2 ? valid.at(-2)[1] : null;
  const pct = (a, b) => (a === null || b === null || b === 0 ? null : round1(((a - b) / Math.abs(b)) * 100));
  const avg = valid.length ? valid.reduce((a, [, v]) => a + v, 0) / valid.length : 0;
  let direction = 'flat';
  if (slope !== null && Math.abs(slope) >= 0.05 * Math.abs(avg) && slope !== 0) direction = slope > 0 ? 'up' : 'down';
  return { values, spark, slope, vs_prev_pct: pct(last, prev), vs_baseline_pct: pct(last, num(baseline)), direction };
}
