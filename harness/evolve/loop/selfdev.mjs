// Chi so kha nang tu phat trien (spec 4.5). Ham thuan: khong I/O, mau 0 -> null (khong chia 0).
// Hinh input (fixture): appliedLog = dong applied.jsonl that {ts, op:'apply'|'rollback', ok, id, ver, target};
// proposals [{id, candidate, effect:{measured_at}}] (candidate = ledgerEntries[].id); ledgerEntries [{id, first_ts, last_ts, status}];
// effects [{id, effect:{verdict, measured_at}}]; processChanges [{ts, file}] (moi thay doi file quy tac qua git = user-directed);
// signals {sessions, corrections, interrupts}. Moi chi so lay theo cua so tuan [weekStartMs, weekEndMs) de chuoi tuan khong tron so tich luy.
const FINAL = new Set(['better', 'worse', 'unchanged', 'inconclusive']);
const HOUR = 3600e3, DAY = 24 * HOUR;
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
  const applied = arr(appliedLog).filter((e) => e.op === 'apply' && e.ok && inWeek(e.ts));
  const rolled = arr(appliedLog).filter((e) => e.op === 'rollback' && e.ok && inWeek(e.ts));
  const changes = arr(processChanges);
  const user = changes.filter((c) => inWeek(c.ts)).length;
  const ledger = new Map(arr(ledgerEntries).map((l) => [l.id, l]));
  const applyTs = new Map(applied.map((e) => [e.id, ms(e.ts)]));
  const fix = [], verify = [];
  for (const p of arr(proposals)) {
    const l = ledger.get(p.candidate), a = applyTs.get(p.id);
    const f = l && ms(l.first_ts);
    if (a == null || !Number.isFinite(f)) continue;
    if (a >= f) fix.push((a - f) / HOUR);
    const v = p.effect && ms(p.effect.measured_at);
    if (Number.isFinite(v) && v >= f) verify.push((v - f) / HOUR);
  }
  const done = arr(effects).filter((e) => e.effect && FINAL.has(e.effect.verdict) && inWeek(e.effect.measured_at));
  const led = arr(ledgerEntries).filter((l) => ['open', 'warned', 'resolved'].includes(l.status) && inWeek(l.last_ts || l.first_ts));
  const sig = signals || {};
  // repeat_files: file quy tac sua >= 2 lan trong 14 ngay toi cuoi tuan
  const per = new Map();
  for (const c of changes) { const t = ms(c.ts); if (Number.isFinite(t) && t >= weekEndMs - 14 * DAY && t < weekEndMs) per.set(c.file, (per.get(c.file) || 0) + 1); }
  const r = (value, better) => ({ value, better });
  return {
    self_initiated_rate: r(ratio(applied.length, applied.length + user), 'up'),
    time_to_fix_h: r(median(fix), 'down'),
    time_to_verify_h: r(median(verify), 'down'),
    effective_rate: r(ratio(done.filter((e) => e.effect.verdict === 'better').length, done.length), 'up'),
    rollback_rate: r(ratio(rolled.length, applied.length), 'down'),
    repeat_correction_rate: r(ratio((sig.corrections || 0) + (sig.interrupts || 0), sig.sessions || 0), 'down'),
    repeat_errors_resolved: r(ratio(led.filter((l) => l.status === 'resolved').length, led.length), 'up'),
    repeat_files: r([...per.values()].filter((n) => n >= 2).length, 'down'),
  };
}

/**
 * trends: {metric: {direction:'up'|'down'|'flat', better:'up'|'down'}} (direction cua series.trend).
 * Anh xa: flat -> ngang; direction === better -> tot; nguoc lai -> xau.
 * Quy tac F3: co >= 1 chi so xau -> 'worse'; khong xau ma >= 2 chi so ngang -> 'flat'; con lai 'improving'. Rong -> 'flat'.
 */
export function compositeDirection(trends) {
  const v = Object.values(trends || {});
  if (!v.length) return 'flat';
  const cls = v.map((t) => (!t || t.direction === 'flat' ? 'flat' : t.direction === t.better ? 'good' : 'bad'));
  if (cls.includes('bad')) return 'worse';
  return cls.filter((c) => c === 'flat').length >= 2 ? 'flat' : 'improving';
}
