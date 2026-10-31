// Validator hop dong harness (T0): module hook, ket qua hook, extRoots, manifest, su kien, config. Thuan, khong I/O.
// Tach tu contract.mjs (<400 dong); contract.mjs re-export nen moi importer giu nguyen. Hang so lay tu contract.mjs (vong import co chu y:
// chi dung trong than ham / lazy, KHONG o muc module, de khong dinh TDZ). contract.test cam contract.mjs co import nen chieu ngan nay nam o day.
import { LAYERS, CONFIG_LAYERS, CORE_RULE_DISABLE_LAYERS, DEFAULT_CAPS, HOOK_MODULE, DECISION_ORDER, isInHarness } from './contract.mjs';
import { isObj } from '../io/paths.mjs';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Cac loai extension va tier. */
const KINDS = Object.freeze(['hook', 'cli', 'lib', 'view']);
const TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3']);

/** Kiem mot module hook. Tra mang loi (rong = hop le). Thuan. */
export function validateHookModule(mod) {
  const e = [];
  if (!isObj(mod)) return ['module hook phai la object'];
  for (const k of HOOK_MODULE.required) if (mod[k] === undefined) e.push(`thieu truong bat buoc: ${k}`);
  if (mod.id !== undefined && !(typeof mod.id === 'string' && KEBAB.test(mod.id))) e.push('id phai kebab-case');
  if (mod.events !== undefined && !(Array.isArray(mod.events) && mod.events.length > 0 && mod.events.every((x) => typeof x === 'string' && x))) e.push('events phai la mang string khong rong');
  if (mod.tools !== undefined && !(mod.tools instanceof RegExp)) e.push('tools phai la RegExp');
  if (mod.timeoutMs !== undefined && !(Number.isFinite(mod.timeoutMs) && mod.timeoutMs > 0)) e.push('timeoutMs phai la so duong');
  if (mod.onError !== undefined && !HOOK_MODULE.onError.includes(mod.onError)) e.push(`onError phai thuoc ${HOOK_MODULE.onError.join('|')}`);
  if (mod.handle !== undefined && typeof mod.handle !== 'function') e.push('handle phai la ham');
  return e;
}

/** Kiem ket qua handle(). Tra mang loi. Khoa la khong loi (additive). Thuan. */
export function validateHookResult(r) {
  const e = [];
  if (r === undefined || r === null) return e; // khong y kien
  if (!isObj(r)) return ['ket qua phai la object'];
  if (r.decision !== undefined && !DECISION_ORDER.includes(r.decision)) e.push(`decision phai thuoc ${DECISION_ORDER.join('|')}`);
  if (r.reason !== undefined && typeof r.reason !== 'string') e.push('reason phai la string');
  if (r.updatedInput !== undefined && !isObj(r.updatedInput)) e.push('updatedInput phai la object');
  if (r.additionalContext !== undefined && typeof r.additionalContext !== 'string') e.push('additionalContext phai la string');
  if (r.block !== undefined && typeof r.block !== 'boolean') e.push('block phai la boolean');
  if (r.record !== undefined && !isObj(r.record)) e.push('record phai la object');
  if (r.records !== undefined) {
    if (!Array.isArray(r.records)) e.push('records phai la mang');
    else {
      r.records.forEach((x, i) => {
        if (!isObj(x)) { e.push(`records[${i}] phai la object`); return; }
        if (!HOOK_MODULE.sinks.includes(x.sink)) e.push(`records[${i}].sink phai thuoc ${HOOK_MODULE.sinks.join('|')}`);
        if (!isObj(x.data)) e.push(`records[${i}].data phai la object`);
      });
    }
  }
  return e;
}

/** Goc mo rong cua cong chung (config khoa `extRoots`): thu muc tuong doi goc hub, ngoai harness/. harness.mjs spawn manifest o day, khong import. */
export function validateExtRoots(v) {
  if (v === undefined) return [];
  if (!(Array.isArray(v) && v.every((x) => typeof x === 'string'))) return ['extRoots phai la mang string'];
  const e = [];
  for (const raw of v) {
    const x = raw.replace(/\\/g, '/');
    if (!x || x.startsWith('/') || /^[A-Za-z]:/.test(x) || x.split('/').includes('..')) e.push(`extRoots: ${raw} phai la duong dan tuong doi, khong ra ngoai goc hub`);
    else if (isInHarness(x)) e.push(`extRoots: ${raw} khong duoc nam trong harness/`);
  }
  return e;
}

/** Schema manifest extension (tai plugins/<x>/manifest.json) dang mo ta. Lazy (tham chieu LAYERS tu contract.mjs). */
const manifestSchema = () => Object.freeze({
  required: ['id', 'kind', 'layer', 'entry'],
  fields: {
    id: 'kebab-string', kind: KINDS, layer: LAYERS, entry: 'string', domain: 'string?', desc: 'string?', cmds: 'string|string[]?', aliases: 'string[]?',
    domains: '{<domain>: file | {file, desc?, cmds?, default?, aliases?}}', adapters: '{<cli>: native|none|n/a|<file>, note?}',
    default: ['run', 'index'], files: '{helpers:string[]}', tests: 'string[]',
    config: '{defaults:string|null,schema:string|null,tool:string?}', data: 'string|null|[{path|zone,class,retentionDays?,tool}]', tier: TIERS,
  },
});

/** Kiem manifest extension. Tra mang loi (rong = hop le). Thuan. */
export function validateExtManifest(obj) {
  const e = [];
  if (!isObj(obj)) return ['manifest phai la object'];
  for (const k of manifestSchema().required) if (obj[k] === undefined) e.push(`thieu truong bat buoc: ${k}`);
  if (obj.id !== undefined && !(typeof obj.id === 'string' && KEBAB.test(obj.id))) e.push('id phai kebab-case');
  if (obj.kind !== undefined && !KINDS.includes(obj.kind)) e.push(`kind phai thuoc ${KINDS.join('|')}`);
  if (obj.layer !== undefined && !LAYERS.includes(obj.layer)) e.push(`layer phai thuoc ${LAYERS.join('|')}`);
  if (obj.entry !== undefined && !(typeof obj.entry === 'string' && /^[a-z0-9-]+(\/[a-z0-9-]+)*\.mjs$/.test(obj.entry))) e.push('entry phai la ten file kebab-case .mjs');
  if (obj.domain !== undefined && typeof obj.domain !== 'string') e.push('domain phai la string');
  if (obj.kind === 'cli' && !obj.domain) e.push('kind cli can domain');
  const cmdsOk = (c) => typeof c === 'string' || (Array.isArray(c) && c.every((x) => typeof x === 'string'));
  if (obj.cmds !== undefined && !cmdsOk(obj.cmds)) e.push('cmds phai la string hoac mang string');
  if (obj.desc !== undefined && typeof obj.desc !== 'string') e.push('desc phai la string');
  const aliasOk = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && KEBAB.test(x));
  if (obj.aliases !== undefined && !aliasOk(obj.aliases)) e.push('aliases phai la mang kebab-case');
  if (obj.default !== undefined && !['run', 'index'].includes(obj.default)) e.push('default phai la run|index');
  if (obj.domains !== undefined) {
    if (Array.isArray(obj.domains)) { if (!obj.domains.every((x) => typeof x === 'string')) e.push('domains (mang) phai la string'); }
    else if (!isObj(obj.domains)) e.push('domains phai la object hoac mang string');
    else for (const [k, v] of Object.entries(obj.domains)) {
      if (typeof v === 'string') continue;
      if (!isObj(v) || typeof v.file !== 'string') e.push(`domains.${k} phai la file hoac {file,...}`);
      else {
        if (v.desc !== undefined && typeof v.desc !== 'string') e.push(`domains.${k}.desc phai la string`);
        if (v.cmds !== undefined && !cmdsOk(v.cmds)) e.push(`domains.${k}.cmds khong hop le`);
        if (v.aliases !== undefined && !aliasOk(v.aliases)) e.push(`domains.${k}.aliases phai la mang kebab-case`);
        if (v.default !== undefined && !['run', 'index'].includes(v.default)) e.push(`domains.${k}.default phai la run|index`);
      }
    }
  }
  if (obj.adapters !== undefined && !isObj(obj.adapters)) e.push('adapters phai la object');
  const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (obj.files !== undefined) {
    if (!isObj(obj.files) || (obj.files.helpers !== undefined && !strArr(obj.files.helpers))) e.push('files.helpers phai la mang string');
  }
  if (obj.tests !== undefined && !strArr(obj.tests)) e.push('tests phai la mang string');
  if (obj.config !== undefined) {
    if (!isObj(obj.config)) e.push('config phai la object');
    else for (const k of ['defaults', 'schema', 'tool']) {
      const v = obj.config[k];
      if (v !== undefined && v !== null && typeof v !== 'string') e.push(`config.${k} phai la string|null`);
    }
  }
  if (Array.isArray(obj.data)) {
    obj.data.forEach((d, i) => {
      if (!isObj(d)) { e.push(`data[${i}] phai la object`); return; }
      if (d.path === undefined && d.zone === undefined) e.push(`data[${i}] can path hoac zone`);
      if (d.path !== undefined && typeof d.path !== 'string') e.push(`data[${i}].path phai la string`);
      if (d.zone !== undefined && typeof d.zone !== 'string') e.push(`data[${i}].zone phai la string`);
      if (d.class !== undefined && typeof d.class !== 'string') e.push(`data[${i}].class phai la string`);
      if (d.tool !== undefined && typeof d.tool !== 'string') e.push(`data[${i}].tool phai la string`);
    });
  } else if (obj.data !== undefined && obj.data !== null && typeof obj.data !== 'string') e.push('data phai la string|null|mang');
  if (obj.tier !== undefined && !TIERS.includes(obj.tier)) e.push(`tier phai thuoc ${TIERS.join('|')}`);
  const helpers = isObj(obj.files) && strArr(obj.files.helpers) ? obj.files.helpers : [];
  const tests = strArr(obj.tests) ? obj.tests : [];
  const names = [obj.entry, ...helpers, ...tests].filter((x) => typeof x === 'string');
  if (new Set(names).size !== names.length) e.push('file trung lap giua entry/helpers/tests');
  if (obj.kind === 'lib' && tests.length === 0) e.push('kind lib can it nhat 1 test');
  const cap = DEFAULT_CAPS.filesPerExtension;
  if (names.filter((n) => !/\.test\.mjs$/.test(n)).length > cap) e.push(`vuot ${cap} file/extension`);
  return e.filter(Boolean);
}

/** Schema su kien (audit/store): truong bat buoc + tuy chon. */
const EVENT_SCHEMA = Object.freeze({
  required: ['ts', 'type'],
  optional: ['sid', 'task_id', 'agent_id', 'agent_type', 'model', 'tokens_in', 'tokens_out', 'tokens_cache',
    'turns', 'exit_code', 'fp', 'retry', 'files', 'rule', 'tool', 'verdict',
    'error_fingerprint', 'retry_of', 'attempt', 'files_touched', 'verifier_outcome',
    'verify_kind', 'gate'], // verify_kind: loai lenh verify (audit Bash) hoac null; gate: ban ghi gate-event {kind, decision, hook, rule, ...}
  verdicts: Object.freeze(['pass', 'fail', 'unknown']),
  verifierOutcomes: Object.freeze(['pass', 'fail', 'none']),
});

/** Kiem mot su kien. Tra mang loi. Khoa la khong loi (additive); cam truong nhay cam. */
export function validateEvent(ev) {
  const e = [];
  if (!isObj(ev)) return ['su kien phai la object'];
  if (typeof ev.ts !== 'string' && !Number.isFinite(ev.ts)) e.push('ts phai la ISO string hoac so');
  else if (typeof ev.ts === 'string' && Number.isNaN(Date.parse(ev.ts))) e.push('ts khong phai thoi gian hop le');
  if (typeof ev.type !== 'string' || !ev.type) e.push('type phai la string khong rong');
  // null = "khong co" (du lieu moi ghi null cho task_id/error_fingerprint); thieu truong (du lieu cu) van hop le.
  for (const k of ['tokens_in', 'tokens_out', 'tokens_cache', 'turns', 'retry', 'exit_code', 'retry_of', 'attempt']) {
    if (ev[k] !== undefined && ev[k] !== null && !Number.isFinite(ev[k])) e.push(`${k} phai la so`);
  }
  for (const k of ['sid', 'task_id', 'agent_id', 'agent_type', 'model', 'fp', 'rule', 'tool', 'error_fingerprint']) {
    if (ev[k] !== undefined && ev[k] !== null && typeof ev[k] !== 'string') e.push(`${k} phai la string`);
  }
  for (const k of ['files', 'files_touched']) {
    if (ev[k] !== undefined && !(Array.isArray(ev[k]) && ev[k].every((f) => typeof f === 'string'))) e.push(`${k} phai la mang string`);
  }
  if (ev.verifier_outcome !== undefined && !EVENT_SCHEMA.verifierOutcomes.includes(ev.verifier_outcome)) e.push('verifier_outcome khong hop le');
  if (ev.verdict !== undefined && !EVENT_SCHEMA.verdicts.includes(ev.verdict)) e.push('verdict khong hop le');
  for (const k of ['prompt', 'content', 'secret', 'token', 'password']) if (k in ev) e.push(`cam truong nhay cam: ${k}`);
  return e;
}

/** Schema config tang default/custom: tap con JSON Schema. */
const CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    caps: { type: 'object' },
    disable: { type: 'array' },
    protect: { type: 'object' },
    extRoots: { type: 'array' }, // goc mo rong cua cong chung (hub tooling), xem validateExtRoots
  },
});

/** Kiem file config dua vao (da doc san) cho mot tang. Tra {errors, warnings}; khoa la -> canh bao. */
export function validateConfig(cfg, layer = 'machine') {
  const errors = [];
  const warnings = [];
  if (!CONFIG_LAYERS.includes(layer)) errors.push(`tang khong hop le: ${layer}`);
  if (!isObj(cfg)) return { errors: [...errors, 'config phai la object'], warnings };
  for (const k of Object.keys(cfg)) if (!(k in CONFIG_SCHEMA.properties)) warnings.push(`khoa la: ${k}`);
  if (cfg.caps !== undefined) {
    if (!isObj(cfg.caps)) errors.push('caps phai la object');
    else for (const k of Object.keys(cfg.caps)) {
      if (!(k in DEFAULT_CAPS)) warnings.push(`caps.${k} la`);
      else if (k === 'retention') {
        if (!isObj(cfg.caps.retention)) errors.push('caps.retention phai la object');
      } else if (!(Number.isFinite(cfg.caps[k]) && cfg.caps[k] > 0)) errors.push(`caps.${k} phai la so duong`);
    }
  }
  errors.push(...validateExtRoots(cfg.extRoots));
  if (cfg.disable !== undefined && !(Array.isArray(cfg.disable) && cfg.disable.every((x) => typeof x === 'string'))) errors.push('disable phai la mang string');
  if (Array.isArray(cfg.disable) && cfg.disable.length && !CORE_RULE_DISABLE_LAYERS.includes(layer) && layer !== 'code') {
    errors.push(`luat loi chi tat duoc o tang ${CORE_RULE_DISABLE_LAYERS.join('|')}, khong phai ${layer}`);
  }
  return { errors, warnings };
}
