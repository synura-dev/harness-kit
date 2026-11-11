// Chinh sach dinh tuyen = DU LIEU (core trung tinh cong cu). Mac dinh chi biet model Claude; backend ngoai (CLI khac) khai bao
// qua <projectDir>/.harness/routing.json: {expected?, prices?, thresholds?, riskRe?, backends?:{<cli>:{classes:[...],label?}}}.
// File hong/sai schema -> dung mac dinh, source 'default(invalid project)'. Doc co gioi han kich thuoc.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 64 * 1024;
const TOP = new Set(['expected', 'prices', 'thresholds', 'riskRe', 'backends']);
const RISK = /(^|\/)(auth|perm|permission|permissions|guard|deploy|secret|secrets|migrate|migration|migrations|security)(\/|\.|$)/i;

/** Mac dinh chung: lop -> mode ky vong (null = khong co luat backend ngoai). Lop khong khai bao -> 'haiku'. review_risk = review cham file nhay cam. */
export const DEFAULT_POLICY = Object.freeze({
  expected: Object.freeze({ web_lookup: null, large_read: null, plan: 'opus', review: 'sonnet', review_risk: 'opus', code_edit: 'sonnet', read_small: 'haiku', test_run: 'haiku' }),
  prices: Object.freeze({ haiku: 1, sonnet: 3, opus: 5 }),
  thresholds: Object.freeze({ largeReadChars: 400000, builderTurns: 25, overreadChars: 20000, redoMs: 24 * 3600 * 1000 }),
  riskRe: RISK.source,
  backends: Object.freeze({}),
});

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const posNum = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** Hop nhat `over` len mac dinh + kiem schema -> {policy, errors}; errors != [] -> policy = mac dinh. */
export function resolvePolicy(over) {
  const errors = [];
  const o = over == null ? {} : over;
  if (!isObj(o)) return { policy: DEFAULT_POLICY, errors: ['goc phai la object'] };
  for (const k of Object.keys(o)) if (!TOP.has(k)) errors.push(`khoa la: ${k}`);
  const expected = { ...DEFAULT_POLICY.expected }, prices = { ...DEFAULT_POLICY.prices }, thresholds = { ...DEFAULT_POLICY.thresholds }, backends = {};
  let riskRe = DEFAULT_POLICY.riskRe;
  if (o.expected !== undefined) {
    if (!isObj(o.expected)) errors.push('expected: phai la object');
    else for (const [c, m] of Object.entries(o.expected)) { if (!(c in Object.prototype) && (m === null || typeof m === "string")) expected[c] = m; else errors.push(`expected.${c}: null|string`); }
  }
  if (o.prices !== undefined) {
    if (!isObj(o.prices)) errors.push('prices: phai la object');
    else for (const [f, p] of Object.entries(o.prices)) { if (!(f in Object.prototype) && posNum(p)) prices[f] = p; else errors.push(`prices.${f}: so duong`); }
  }
  if (o.thresholds !== undefined) {
    if (!isObj(o.thresholds)) errors.push('thresholds: phai la object');
    else for (const [t, v] of Object.entries(o.thresholds)) { if (Object.hasOwn(thresholds, t) && posNum(v)) thresholds[t] = v; else errors.push(`thresholds.${t}: khoa/so duong khong hop le`); }
  }
  if (o.riskRe !== undefined) {
    try { if (typeof o.riskRe !== 'string' || o.riskRe.length > 200) throw new Error('x'); new RegExp(o.riskRe, 'i'); riskRe = o.riskRe; } catch { errors.push('riskRe: regex string khong hop le'); }
  }
  if (o.backends !== undefined) {
    if (!isObj(o.backends)) errors.push('backends: phai la object');
    else for (const [name, b] of Object.entries(o.backends)) {
      if (!/^[a-z][a-z0-9_-]*$/.test(name) || name === "claude" || name in Object.prototype) { errors.push(`backends.${name}: ten khong hop le`); continue; }
      if (!isObj(b) || !Array.isArray(b.classes) || !b.classes.every((c) => typeof c === 'string') || (b.label !== undefined && typeof b.label !== 'string')) { errors.push(`backends.${name}: {classes:[str], label?:str}`); continue; }
      backends[name] = { classes: [...b.classes], label: b.label || name };
    }
  }
  if (errors.length) return { policy: DEFAULT_POLICY, errors };
  return { policy: { expected, prices, thresholds, riskRe, backends }, errors };
}

/** @returns {{policy:object, source:'default'|'project'|'default(invalid project)'}} */
export function loadRoutingPolicy({ projectDir } = {}) {
  if (!projectDir) return { policy: DEFAULT_POLICY, source: 'default' };
  const f = path.join(projectDir, '.harness', 'routing.json');
  let raw;
  try {
    if (!fs.existsSync(f)) return { policy: DEFAULT_POLICY, source: 'default' }; // khong co file (ke ca symlink treo) = mac dinh
    const real = fs.realpathSync(f), root = fs.realpathSync(projectDir);
    if (!real.startsWith(root + path.sep)) return { policy: DEFAULT_POLICY, source: 'default(invalid project)' }; // symlink ra ngoai projectDir
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_BYTES) return { policy: DEFAULT_POLICY, source: 'default(invalid project)' };
    raw = fs.readFileSync(real, 'utf8');
  } catch { return { policy: DEFAULT_POLICY, source: 'default(unreadable project)' }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { policy: DEFAULT_POLICY, source: 'default(invalid project)' }; }
  const r = resolvePolicy(j);
  return r.errors.length ? { policy: DEFAULT_POLICY, source: 'default(invalid project)' } : { policy: r.policy, source: 'project' };
}
