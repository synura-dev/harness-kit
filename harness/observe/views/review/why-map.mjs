// audit why / map: loi lap, thu lai khong thanh, file churn (doc su kien co error_fp/files_touched).
import fs from 'node:fs';
import path from 'node:path';
import { normalizeError } from '../../../core/audit/fingerprint.mjs';
import { readCapped, collectJsonlFiles } from './util.mjs';

const MAX_LINES = 40;
const LIM = { timeoutMs: 20000, maxBytes: 8 * 1024 * 1024, maxFiles: 400 };
export function parseSince(s, now = Date.now()) {
  if (!s) return now - 86400000;
  const m = /^(\d+)([dh])$/.exec(String(s));
  if (m) return now - Number(m[1]) * (m[2] === 'd' ? 86400000 : 3600000);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00');
  return now - 86400000;
}
const safeRel = (f) => {
  const s = String(f || '').replace(/\\/g, '/');
  return /^(?:[A-Za-z]:)?\//.test(s) ? s.split('/').pop() : s.replace(/^\.\//, '');
};
const clipTilde = (s, n) => (s.length > n ? s.slice(0, n - 1) + '~' : s);
/** Doc su kien lien quan; tra { events, skipped, truncated }. */
export function loadEvents(auditDir, o = {}) {
  const t0 = o.since ?? parseSince(null);
  const deadline = Date.now() + (o.timeoutMs || LIM.timeoutMs);
  const events = [];
  let skipped = 0, truncated = null;
  let files = [];
  try {
    for (const dirRoot of [].concat(auditDir)) {
      let names = []; try { names = fs.readdirSync(dirRoot); } catch { continue; }
      for (const d of names) {
        const m = /^date=(\d{4}-\d{2}-\d{2})$/.exec(d);
        if (m && Date.parse(m[1] + 'T23:59:59') >= t0) files.push(...collectJsonlFiles(path.join(dirRoot, d)));
      }
    }
  } catch { return { events, skipped, truncated }; }
  if (files.length > LIM.maxFiles) { files = files.slice(-LIM.maxFiles); truncated = 'max-files'; }
  for (const f of files) {
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
    let text;
    try { const r = readCapped(f, o.maxBytes || LIM.maxBytes); text = r.text; if (r.truncated) truncated = truncated || 'max-bytes'; } catch { continue; }
    for (const ln of text.split('\n')) {
      if (!ln.trim()) continue;
      let e; try { e = JSON.parse(ln); } catch { skipped++; continue; }
      const ts = e && typeof e === 'object' ? Date.parse(e.ts) : NaN;
      if (!Number.isFinite(ts)) { skipped++; continue; }
      if (ts < t0) continue;
      const d = e.data && typeof e.data === 'object' ? e.data : {};
      if (!d.error_fp && !d.files_touched && !d.verifier_outcome) continue; // khong lien quan (khong tinh la bo qua)
      const sid = e.sid || e.session_id || null;
      const task = d.task_id || null;
      if (o.task && task !== o.task) continue;
      if (o.session && sid !== o.session) continue;
      events.push({ ts, key: task || (sid ? 's:' + String(sid).slice(-8) : '?'), tool: e.tool || '?', fp: d.error_fp || null,
        attempt: Number.isFinite(d.attempt) ? d.attempt : 1, err: typeof d.error === 'string' ? d.error : '',
        files: Array.isArray(d.files_touched) ? d.files_touched.filter((x) => typeof x === 'string').map(safeRel) : [],
        vo: d.verifier_outcome === 'pass' || d.verifier_outcome === 'fail' ? d.verifier_outcome : null });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, skipped, truncated };
}
const head = (name, r, n) => `=== audit ${name}: ${n} events${r.skipped ? `, ${r.skipped} skipped (thieu/loi)` : ''}${r.truncated ? ` [truncated: ${r.truncated}]` : ''} ===`;
const byKey = (events) => { const m = new Map(); for (const e of events) { if (!m.has(e.key)) m.set(e.key, []); m.get(e.key).push(e); } return m; };
const fin = (lines) => (lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `... (+${lines.length - MAX_LINES + 1} dong an)`] : lines);
export function why(r, o = {}) {
  const lim = o.limit || 5;
  const groups = new Map(), stuck = [], aband = [], churn = [];
  for (const [key, evs] of byKey(r.events)) {
    for (const e of evs) {
      if (!e.fp) continue;
      const g = groups.get(e.fp) || groups.set(e.fp, { fp: e.fp, n: 0, max: 0, tool: e.tool, ex: '', keys: new Set() }).get(e.fp);
      g.n++; g.max = Math.max(g.max, e.attempt); g.keys.add(key);
      if (!g.ex && e.err) g.ex = clipTilde(normalizeError(e.err, 80), 80);
    }
    // thu lai khong thanh: attempt>=3, khong co verifier pass sau lan loi cuoi cua fp
    const last = new Map();
    for (const e of evs) if (e.fp && e.attempt >= 3) last.set(e.fp, e);
    for (const [fp, e] of last) if (!evs.some((x) => x.vo === 'pass' && x.ts > e.ts)) stuck.push(`${key}: ${e.tool} fp=${fp} attempt=${e.attempt}`);
    const v = evs.filter((x) => x.vo).pop();
    if (v && v.vo === 'fail') aband.push(`${key}: verifier fail cuoi (${evs.length} su kien)`);
    // file sua lien tiep >=3 lan
    let prev = null, run = 0; const best = new Map();
    for (const e of evs) for (const f of e.files) { run = f === prev ? run + 1 : 1; prev = f; best.set(f, Math.max(best.get(f) || 0, run)); }
    for (const [f, c] of best) if (c >= 3) churn.push([c, `${key}: ${clipTilde(f, 60)} x${c}`]);
  }
  const rep = [...groups.values()].filter((g) => g.n >= 2).sort((a, b) => b.n - a.n);
  churn.sort((a, b) => b[0] - a[0]);
  const sec = (t, arr) => [`${t} (${arr.length}):`, ...(arr.length ? arr.slice(0, lim).map((x) => '  ' + x) : ['  none'])];
  return fin([head('why', r, r.events.length),
    ...sec('Loi lap theo error_fp', rep.map((g) => `${g.n}x fp=${g.fp} max_attempt=${g.max} tool=${g.tool} tasks=${g.keys.size} | ${g.ex || '(khong co mau loi)'}`)),
    ...sec('Thu lai khong thanh (attempt>=3, chua verifier pass)', stuck),
    ...sec('Bo dang (verifier fail cuoi)', aband),
    ...sec('File sua lien tiep >=3 lan', churn.map((x) => x[1]))]);
}
export function map(r, o = {}) {
  const lim = o.limit || 5, out = [head('map', r, r.events.length)];
  const tasks = [...byKey(r.events)].map(([key, evs]) => {
    const files = new Map(), dirs = new Map();
    for (const e of evs) for (const f of e.files) { files.set(f, (files.get(f) || 0) + 1); const d = f.includes('/') ? f.split('/').slice(0, 2).join('/') + '/' : './'; dirs.set(d, (dirs.get(d) || 0) + 1); }
    const v = evs.filter((x) => x.vo).pop();
    return { key, touches: [...files.values()].reduce((a, b) => a + b, 0), files, dirs, vo: v ? v.vo : 'none' };
  }).filter((t) => t.touches).sort((a, b) => b.touches - a.touches);
  if (!tasks.length) out.push('khong co file bi cham trong pham vi');
  for (const t of tasks.slice(0, 8)) {
    const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, lim);
    out.push(`${t.key}: ${t.touches} lan cham, verifier=${t.vo}`,
      '  dir: ' + top(t.dirs).map(([d, c]) => `${clipTilde(d, 30)} ${c}`).join(', '),
      '  file: ' + top(t.files).slice(0, 3).map(([f, c]) => `${clipTilde(f, 40)} ${c}`).join(', '));
  }
  return fin(out);
}
export function runWhyMap(cmd, args, auditDir) {
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const limit = Number(val('--limit')) > 0 ? Number(val('--limit')) : undefined;
  const r = loadEvents(auditDir, { since: parseSince(val('--since')), task: val('--task'), session: val('--session'), timeoutMs: Number(val('--timeout')) > 0 ? Number(val('--timeout')) * 1000 : undefined, maxBytes: Number(val('--max-bytes')) > 0 ? Number(val('--max-bytes')) : undefined });
  return (cmd === 'why' ? why(r, { limit }) : map(r, { limit })).join('\n');
}
