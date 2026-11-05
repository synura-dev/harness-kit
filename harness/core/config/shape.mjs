// Kiem schema nho (thuan, khong I/O): validateShape(obj, spec) -> mang loi (rong = hop le).
// spec: { required?: [ten], fields: { ten: kieu } }; kieu: 'string'|'number'|'boolean'|'object'|'array'|'function'|'regexp'|'string[]'|[gia tri cho phep] | (v)=>loi|''.
import { isObj } from '../io/paths.mjs';
import { HOOK_MODULE, DECISION_ORDER, isInHarness } from './constants.mjs';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CHECK = {
  string: (v) => typeof v === 'string',
  number: (v) => Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: isObj,
  array: Array.isArray,
  function: (v) => typeof v === 'function',
  regexp: (v) => v instanceof RegExp,
  'string[]': (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
};

export function validateShape(obj, spec) {
  if (!isObj(obj)) return ['phai la object'];
  const e = [];
  for (const k of spec.required || []) if (obj[k] === undefined) e.push(`thieu truong bat buoc: ${k}`);
  for (const [k, t] of Object.entries(spec.fields || {})) {
    const v = obj[k];
    if (v === undefined) continue;
    if (Array.isArray(t)) { if (!t.includes(v)) e.push(`${k} phai thuoc ${t.join('|')}`); }
    else if (typeof t === 'function') { const m = t(v); if (m) e.push(`${k} ${m}`); }
    else if (!CHECK[t](v)) e.push(`${k} phai la ${t}`);
  }
  return e;
}

const kebab = (v) => (typeof v === 'string' && KEBAB.test(v) ? '' : 'phai la kebab-case');
const HOOK_SPEC = {
  required: HOOK_MODULE.required,
  fields: {
    id: kebab, tools: 'regexp', handle: 'function', onError: HOOK_MODULE.onError,
    events: (v) => (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x) ? '' : 'phai la mang string khong rong'),
    timeoutMs: (v) => (Number.isFinite(v) && v > 0 ? '' : 'phai la so duong'),
  },
};
export const validateHookModule = (mod) => validateShape(mod, HOOK_SPEC);

const RESULT_SPEC = {
  fields: {
    decision: DECISION_ORDER, reason: 'string', updatedInput: 'object', additionalContext: 'string', block: 'boolean', record: 'object',
    records: (v) => (!Array.isArray(v) ? 'phai la mang'
      : v.some((x) => !isObj(x) || !HOOK_MODULE.sinks.includes(x.sink) || !isObj(x.data)) ? 'moi muc phai la {sink thuoc sinks, data object}' : ''),
  },
};
export const validateHookResult = (r) => (r === undefined || r === null ? [] : validateShape(r, RESULT_SPEC));

/** extRoots: mang duong dan tuong doi goc hub, ngoai harness/. */
export function validateExtRoots(v) {
  if (v === undefined) return [];
  if (!CHECK['string[]'](v)) return ['extRoots phai la mang string'];
  return v.flatMap((raw) => {
    const x = raw.replace(/\\/g, '/');
    if (!x || x.startsWith('/') || /^[A-Za-z]:/.test(x) || x.split('/').includes('..')) return [`extRoots: ${raw} phai la duong dan tuong doi, khong ra ngoai goc hub`];
    return isInHarness(x) ? [`extRoots: ${raw} khong duoc nam trong harness/`] : [];
  });
}

const MANIFEST_SPEC = {
  required: ['id', 'kind', 'layer', 'entry'],
  fields: {
    id: kebab, kind: ['hook', 'cli', 'lib', 'view'], layer: ['core', 'ext'], domain: 'string', desc: 'string', tests: 'string[]',
    entry: (v) => (typeof v === 'string' && /^[a-z0-9-]+(\/[a-z0-9-]+)*\.mjs$/.test(v) ? '' : 'phai la ten file kebab-case .mjs'),
    cmds: (v) => (typeof v === 'string' || CHECK['string[]'](v) ? '' : 'phai la string hoac mang string'),
    aliases: (v) => (CHECK['string[]'](v) && v.every((x) => KEBAB.test(x)) ? '' : 'phai la mang kebab-case'),
    default: ['run', 'index'], tier: ['T0', 'T1', 'T2', 'T3'],
  },
};
export function validateExtManifest(m) {
  const e = validateShape(m, MANIFEST_SPEC);
  if (isObj(m) && m.kind === 'cli' && !m.domain) e.push('kind cli can domain');
  return e;
}
