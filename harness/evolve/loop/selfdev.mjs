// Chi so kha nang tu phat trien (spec 4.5). Ham thuan: khong I/O, mau 0 -> null (khong chia 0).
// Hinh input (fixture): appliedLog [{id, ts, status:'applied'|'rolled_back'}]; proposals [{id, candidate, effect:{measured_at}}];
// ledgerEntries [{id, first_ts, status:'open'|'warned'|'resolved'}]; effects [{id, effect:{verdict}}];
// processChanges [{ts, file}] (moi thay doi file quy tac qua git = user-directed); signals {sessions, corrections, interrupts}.
const FINAL = new Set(['better', 'worse', 'unchanged', 'inconclusive']);
const HOUR = 3600e3;
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
const ratio = (n, d) => (d > 0 ? n / d : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};
const arr = (x) => (Array.isArray(x) ? x : []);

export function selfdevMetrics({ appliedLog, proposals, ledgerEntries, effects, processChanges, signals, weekStartMs = -Infinity, weekEndMs = Infinity } = {}) {
  const inWeek = (t) => { const v = ms(t); return Number.isFinite(v) && v >= weekStartMs && v < weekEndMs; };
  const applied = arr(appliedLog).filter((e) => inWeek(e.ts));
  const user = arr(processChanges).filter((c) => inWeek(c.ts)).length;
  const ledger = new Map(arr(ledgerEntries).map((l) => [l.id, l]));
  const applyTs = new Map(applied.map((e) => [e.id, ms(e.ts)]));
  const fix = [], verify = [];
  for (const p of arr(proposals)) {
    const l = ledger.get(p.candidate), a = applyTs.get(p.id);
    const f = l && ms(l.first_ts);
    if (a == null || !Number.isFinite(f)) continue;
    fix.push((a - f) / HOUR);
    const v = p.effect && ms(p.effect.measured_at);
    if (Number.isFinite(v)) verify.push((v - f) / HOUR);
  }
  const done = arr(effects).filter((e) => e.effect && FINAL.has(e.effect.verdict));
  const led = arr(ledgerEntries);
  const sig = signals || {};
  const r = (value, better) => ({ value, better });
  return {
    self_initiated_rate: r(ratio(applied.length, applied.length + user), 'up'),
    time_to_fix_h: r(median(fix), 'down'),
    time_to_verify_h: r(median(verify), 'down'),
    effective_rate: r(ratio(done.filter((e) => e.effect.verdict === 'better').length, done.length), 'up'),
    rollback_rate: r(ratio(applied.filter((e) => e.status === 'rolled_back').length, applied.length), 'down'),
    repeat_correction_rate: r(ratio((sig.corrections || 0) + (sig.interrupts || 0), sig.sessions || 0), 'down'),
    repeat_errors_resolved: r(ratio(led.filter((l) => l.status === 'resolved').length, led.filter((l) => ['open', 'warned', 'resolved'].includes(l.status)).length), 'up'),
  };
}

/** trends: {metric: 'up'|'flat'|'worse'} (huong so voi "tot"). >= 2 chi so flat/worse -> worse (co it nhat 1 worse) hoac flat; con lai improving. Rong -> flat. */
export function compositeDirection(trends) {
  const v = Object.values(trends || {});
  if (!v.length) return 'flat';
  const bad = v.filter((d) => d === 'flat' || d === 'worse');
  if (bad.length < 2) return 'improving';
  return bad.includes('worse') ? 'worse' : 'flat';
}
