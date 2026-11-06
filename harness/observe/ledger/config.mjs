// Nguong luat repeated-error: nguon mac dinh duy nhat = defaults/repeated-error.json. Ghi de qua lop config san co
// (config/ledger/local.json = machine, du an, env HARNESS_LEDGER_<KEY>). Khong file config moi, khong doi cach thu thap.
// Quy tac (khop protectedViolations + CORE_RULE_DISABLE_LAYERS): SIET nhan o moi tang; NOI chi nhan o tang machine; tang khac -> bo qua + warning.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../core/config/config.mjs';
import { DEFAULTS_DIR } from './engine.mjs';

// cfg key -> {f: truong cua luat, min hop le, tighter(a,b): a siet hon b}
const FIELDS = {
  repeatedErrorThreshold: { f: 'threshold', min: 1, tighter: (a, b) => a < b },
  repeatedErrorDays: { f: 'days', min: 1, tighter: (a, b) => a > b },
  repeatedErrorMinSessions: { f: 'min_sessions', min: 1, tighter: (a, b) => a < b },
};
const KEY_EX = 'repeatedErrorExclude';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const layerOf = (sources, key) => String(sources[key] || 'code');

function baseDef() {
  try { return JSON.parse(fs.readFileSync(path.join(DEFAULTS_DIR, 'repeated-error.json'), 'utf8')); } catch { return {}; }
}

/** Doc cau hinh ledger. Tra {values (chi gia tri dat tuong minh va duoc nhan), base, warnings}. Khong throw. */
export function loadLedgerConfig(opts = {}) {
  const b = opts.baseDef || baseDef();
  const base = { threshold: b.threshold, days: b.days, min_sessions: b.min_sessions, exclude: Array.isArray(b.exclude) ? b.exclude : [] };
  const defaults = { repeatedErrorThreshold: base.threshold, repeatedErrorDays: base.days, repeatedErrorMinSessions: base.min_sessions, [KEY_EX]: base.exclude };
  const out = { values: {}, base, warnings: [] };
  let r;
  try { r = loadConfig('ledger', { ...opts, defaults }); } catch { return out; }
  const sources = r.sources || {};
  const accept = (key, v, loosens) => {
    const layer = layerOf(sources, key);
    if (layer === 'code' || layer === 'default') return false; // khong phai ghi de
    if (loosens && layer !== 'machine') { out.warnings.push(`ledger: ${key} noi luat tu tang ${layer} bi bo (chi tang machine duoc noi)`); return false; }
    if (loosens) out.warnings.push(`ledger: ${key} noi luat repeated-error (tang machine): ${JSON.stringify(v)}`);
    return true;
  };
  for (const [key, spec] of Object.entries(FIELDS)) {
    const v = r.config[key];
    if (layerOf(sources, key) === 'code' || layerOf(sources, key) === 'default') continue;
    if (!isNum(v) || v < spec.min) { out.warnings.push(`ledger: ${key} khong hop le (${JSON.stringify(v)}), dung mac dinh`); continue; }
    if (v === base[spec.f]) continue;
    if (accept(key, v, !spec.tighter(v, base[spec.f]))) out.values[spec.f] = v;
  }
  const ex = r.config[KEY_EX];
  if (Array.isArray(ex) && ex.every((s) => typeof s === 'string')) { if (ex.length && accept(KEY_EX, ex, true)) out.values.exclude = [...ex]; }
  else if (!['code', 'default'].includes(layerOf(sources, KEY_EX))) out.warnings.push(`ledger: ${KEY_EX} khong hop le, dung mac dinh`);
  return out;
}

/** Ap cau hinh len repeated-error; giu override du an hop le (lay gia tri chat hon). Thuan. */
export function applyLedgerConfig(defs, cfg) {
  const v = cfg && cfg.values; const base = (cfg && cfg.base) || {};
  if (!v || !Object.keys(v).length) return defs;
  return defs.map((d) => {
    if (d.id !== 'repeated-error') return d;
    const n = { ...d };
    for (const spec of Object.values(FIELDS)) {
      if (v[spec.f] == null) continue;
      const cur = d[spec.f];
      const projectTightened = cur != null && cur !== base[spec.f] && spec.tighter(cur, base[spec.f]);
      n[spec.f] = projectTightened && !spec.tighter(v[spec.f], cur) ? cur : v[spec.f]; // project da siet -> khong de cau hinh noi ha xuong
    }
    if (v.exclude) n.exclude = [...new Set([...(d.exclude || []), ...v.exclude])];
    return n;
  });
}
