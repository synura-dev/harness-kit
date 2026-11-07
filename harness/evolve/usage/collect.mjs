// Generic usage counter (kind-agnostic). Event:
// {kind,id,ts,session,project,channel:'tool'|'slash'|'read'|'preload',source?,origin:'audit'|'transcript'|'gateway',turn?,callId?,file?}

const tsMs = (x) => (typeof x === "number" ? x : Date.parse(x));

export function countEvents(events) {
  const items = new Map();
  const window = {};
  const seen = new Set();
  const sess = new Map();
  let duplicates_dropped = 0;
  for (const e of events) {
    if (e.callId) {
      const dk = `${e.kind}:${e.callId}`;
      if (seen.has(dk)) { duplicates_dropped++; continue; }
      seen.add(dk);
    }
    const t = tsMs(e.ts);
    const okTs = Number.isFinite(t);
    const key = `${e.kind}:${e.id}`;
    let it = items.get(key);
    if (!it) {
      it = { count: 0, sessions: 0, first_ts: null, last_ts: null, channels: {}, projects: {} };
      items.set(key, it);
      sess.set(key, new Set());
    }
    it.count++;
    if (e.session) sess.get(key).add(e.session);
    if (okTs) {
      if (it.first_ts == null || t < tsMs(it.first_ts)) it.first_ts = e.ts;
      if (it.last_ts == null || t > tsMs(it.last_ts)) it.last_ts = e.ts;
    }
    if (e.channel) it.channels[e.channel] = (it.channels[e.channel] || 0) + 1;
    if (e.project) it.projects[e.project] = (it.projects[e.project] || 0) + 1;
    const o = e.origin || 'audit';
    const w = window[o] || (window[o] = { earliest: null, latest: null, n: 0 });
    w.n++;
    if (okTs) {
      if (w.earliest == null || t < tsMs(w.earliest)) w.earliest = e.ts;
      if (w.latest == null || t > tsMs(w.latest)) w.latest = e.ts;
    }
  }
  for (const [k, it] of items) it.sessions = sess.get(k).size;
  return { items, window, duplicates_dropped };
}

// Maintenance reads (bulk reading of definition files in one turn) are not usage.
export function filterMaintenance(events, { threshold = 5 } = {}) {
  const groups = new Map();
  for (const e of events) {
    if (e.channel !== 'read' || e.turn == null || !e.session) continue;
    const g = `${e.session || ''}\u0000${e.turn ?? ''}`;
    let s = groups.get(g);
    if (!s) groups.set(g, (s = new Set()));
    if (e.file) s.add(e.file);
  }
  const bulk = new Set([...groups].filter(([, s]) => s.size >= threshold).map(([g]) => g));
  const kept = [];
  let maintenance_dropped = 0;
  for (const e of events) {
    if (e.channel === 'read' && e.turn != null && e.session && bulk.has(`${e.session || ''}\u0000${e.turn ?? ''}`)) maintenance_dropped++;
    else kept.push(e);
  }
  return { kept, maintenance_dropped };
}
