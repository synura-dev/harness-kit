// harness observe usage [--days N=7] [--by cmd|ext|hook] [--limit N] [--json]: dem so lan goi lenh harness / extension (domain) / hook tu audit + so loi.
// Chi doc, co timeout + tran byte (limits.query_* cua audit-config); het han -> `truncated: timeout`.
import fs from 'node:fs';
import { parseCommon, emit, posInt, capLines } from '../../core/io/out.mjs';
import { collectJsonlFiles } from '../../core/audit/scan.mjs';
import { auditRoot, loadAuditConfig } from '../../core/config/audit-config.mjs';

const BY = ['cmd', 'ext', 'hook'];
const USAGE = 'usage [--days N=7] [--by cmd|ext|hook] [--limit N] [--json]';

/** `harness <domain> [sub]` trong dong lenh Bash (bo qua tien to cd/timeout). -> {domain, sub} | null. */
export function harnessCall(cmdLine) {
  const bare = String(cmdLine || '').replace(/"[^"]*"|'[^']*'/g, '""'); // bo chu nam trong chuoi nhay
  const m = bare.match(/(?:^|[\s;&|(])(?:[^\s;&|()]*[\\/])?harness(?:\.mjs|\.cmd|\.exe)?\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/);
  if (!m) return null;
  return { domain: m[1], sub: m[2] && !m[2].startsWith('-') ? m[2] : null };
}

/** Thuan: su kien -> Map<khoa,{n,err}> theo by. */
export function tally(events, by) {
  const m = new Map();
  const add = (k, err) => { if (!k) return; const r = m.get(k) || { n: 0, err: 0 }; r.n++; if (err) r.err++; m.set(k, r); };
  for (const ev of events) {
    if (by === 'hook') {
      if (ev.hook) add(ev.hook, ev.action === 'error' || ev.ok === false);
      continue;
    }
    // Loi that: Claude gui PostToolUseFailure (ok=false, data.exit_code) thay vi PostToolUse; PostToolUse co the mang exit_code != 0.
    if (ev.event !== 'PostToolUse' && ev.event !== 'PostToolUseFailure' || ev.tool !== 'Bash' && ev.tool !== 'PowerShell') continue;
    const d = ev.data || {};
    const c = harnessCall(d.cmd_line || ev.target);
    if (!c) continue;
    add(by === 'ext' ? c.domain : (c.sub ? `${c.domain} ${c.sub}` : c.domain), ev.event === 'PostToolUseFailure' || ev.ok === false || (typeof d.exit_code === 'number' && d.exit_code !== 0));
  }
  return m;
}

export function collect({ root = auditRoot(), days = 7, nowMs = Date.now(), timeoutMs, maxBytes } = {}) {
  const lim = loadAuditConfig().config.limits || {};
  const deadline = Date.now() + (timeoutMs ?? lim.query_timeout_ms ?? 30000);
  const cap = maxBytes ?? lim.query_max_bytes ?? 209715200;
  const from = new Date(nowMs - days * 86400000).toISOString().slice(0, 10);
  const events = []; let used = 0, truncated = null;
  for (const f of collectJsonlFiles(root)) {
    const d = f.replace(/\\/g, '/').match(/date=(\d{4}-\d{2}-\d{2})|(\d{4}-\d{2}-\d{2})\.jsonl$/);
    const date = d && (d[1] || d[2]);
    if (date && date < from) continue;
    if (Date.now() > deadline) { truncated = 'timeout'; break; }
    let size = 0; try { size = fs.statSync(f).size; } catch { continue; }
    if (used + size > cap) { truncated = 'max_bytes'; break; }
    used += size;
    let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try { const ev = JSON.parse(line); if (ev && typeof ev === 'object') events.push(ev); } catch { /* bo dong hong */ }
    }
  }
  return { events, truncated };
}

export function render(o, deps = {}) {
  const { events, truncated } = (deps.collect || collect)({ root: o.root, days: o.days, nowMs: o.nowMs, timeoutMs: o.timeoutMs });
  const rows = [...tally(events, o.by)].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  const items = rows.slice(0, o.limit);
  const lines = [`usage by=${o.by} ${o.days}d: ${items.length}/${rows.length}`, ...items.map((r) => `${String(r.n).padStart(6)}  err=${r.err}  ${r.key}`)];
  return { summary: capLines(lines, 60).join('\n'), data: { by: o.by, days: o.days, items, total: rows.length }, truncated: truncated || (rows.length > items.length ? 'limit' : null) };
}

export function usageMain(argv = []) {
  const c = parseCommon(argv);
  const o = { days: 7, by: 'cmd', limit: 20 };
  try {
    for (let i = 0; i < c.rest.length; i++) {
      const a = c.rest[i];
      if (a === '--days') o.days = posInt(c.rest[++i]) || 7;
      else if (a === '--limit') o.limit = posInt(c.rest[++i]) || 20;
      else if (a === '--by') { o.by = c.rest[++i]; if (!BY.includes(o.by)) throw new Error(`by phai thuoc ${BY.join('|')}`); }
      else throw new Error(`tham so la: ${a}`);
    }
    if (c.timeoutS) o.timeoutMs = c.timeoutS * 1000;
    emit(render(o), { json: c.json, raw: c.raw, maxBytes: c.maxBytes });
    return 0;
  } catch (e) { console.error('usage: ' + e.message + '\n' + USAGE); return 2; }
}
