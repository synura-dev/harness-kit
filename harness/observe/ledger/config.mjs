// Nguong luat repeated-error: mac dinh trong code, ghi de qua lop config san co (config/ledger/local.json, du an, env HARNESS_LEDGER_<KEY>).
// Khong file config moi, khong doi cach thu thap; chi doi cach doc/tinh.
import { loadConfig } from '../../core/config/config.mjs';

export const DEFAULTS = Object.freeze({
  repeatedErrorThreshold: 3,    // so lan lap toi thieu
  repeatedErrorDays: 7,         // cua so ngay
  repeatedErrorMinSessions: 2,  // so phien toi thieu (1 phien = retry/guard chan, khong phai loi lap)
  // Regex (khong phan biet hoa thuong) khop sample -> loi do guard chan co chu dich, bo qua.
  repeatedErrorExclude: Object.freeze(['Khong doc tho knowledge', 'is isolated in the worktree']),
});

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== '' && v !== null ? Number(v) : d);

/** Doc cau hinh ledger (default < may < du an < env). Khong throw; gia tri sai -> mac dinh. */
export function loadLedgerConfig(opts = {}) {
  let c = {};
  try { c = loadConfig('ledger', { defaults: DEFAULTS, ...opts }).config || {}; } catch { /* mac dinh */ }
  const ex = Array.isArray(c.repeatedErrorExclude) ? c.repeatedErrorExclude.filter((s) => typeof s === 'string') : DEFAULTS.repeatedErrorExclude;
  return {
    threshold: num(c.repeatedErrorThreshold, DEFAULTS.repeatedErrorThreshold),
    days: num(c.repeatedErrorDays, DEFAULTS.repeatedErrorDays) || DEFAULTS.repeatedErrorDays,
    minSessions: num(c.repeatedErrorMinSessions, DEFAULTS.repeatedErrorMinSessions),
    exclude: [...ex],
  };
}

/** Ap cau hinh len dinh nghia repeated-error (cac luat khac giu nguyen). Thuan. */
export function applyLedgerConfig(defs, cfg) {
  return defs.map((d) => (d.id === 'repeated-error' ? { ...d, threshold: cfg.threshold, days: cfg.days, min_sessions: cfg.minSessions, exclude: cfg.exclude } : d));
}
