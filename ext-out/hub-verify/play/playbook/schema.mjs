// Playbook schema: validate + load + params + substitution (buildArgv).
import fs from 'node:fs';
import path from 'node:path';
import { workspaceRoot, isInside, isObj } from '../../../core/io/paths.mjs';
import { denyRun, resolveBuiltin } from './policy.mjs';

export const DEFAULT_LIMITS = { timeout_s: 120, max_output_bytes: 200000 };
export const EXIT = { PASS: 0, PASS_WITH_WARNINGS: 0, FAIL: 1, USAGE: 2, ESCALATE: 3, TIMEOUT: 4, DRYRUN: 6 };
export const RETENTION_DAYS = 14;
const MAX_PLAYBOOK_BYTES = 64 * 1024;
const MAX_STEPS = 15;
const SAFE_DEFAULT_PATTERN = '[A-Za-z0-9_./:@,=+-]+';
export const CAPTURE_SAFE = /^[A-Za-z0-9_./:@,=+-]{0,200}$/;
const TOKEN_RE = /\$\{([^}]*)\}/g;
const STEP_STATUS = ['pass', 'fail', 'timeout', 'skip'];

export class PlaybookError extends Error {
  constructor(msg, errors) { super(msg); this.errors = errors || [msg]; }
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function strictKeys(o, allowed, where, errs) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${where}: khoa la '${k}' (cho phep: ${allowed.join(',')})`);
}

// ---------- validate ----------
function compileRe(src, where, errs) {
  if (typeof src !== 'string' || !src || src.length > 300) { errs.push(`${where}: regex phai la chuoi 1..300 ky tu`); return null; }
  try { return new RegExp(src); } catch (e) { errs.push(`${where}: regex loi (${e.message})`); return null; }
}

function refsIn(str, where, params, captures, errs, { allowList } = {}) {
  let whole = null;
  for (const m of str.matchAll(TOKEN_RE)) {
    const t = m[1];
    const cm = /^capture\.([A-Za-z_]\w*)$/.exec(t);
    if (cm) { if (!captures.has(cm[1])) errs.push(`${where}: \${${t}} tham chieu capture chua khai bao o buoc truoc`); continue; }
    if (!/^[a-z][a-z0-9_]*$/.test(t) || !params[t]) { errs.push(`${where}: \${${t}} khong phai param da khai bao`); continue; }
    if (params[t].list) {
      if (!allowList || m[0] !== str) errs.push(`${where}: param list '${t}' chi duoc dung nguyen ca 1 doi so ("\${${t}}")`);
      else whole = t;
    }
  }
  const stripped = str.replace(TOKEN_RE, '');
  if (stripped.includes('${') ) errs.push(`${where}: '\${' khong hop le (chi cho \${param} hoac \${capture.name})`);
  return whole;
}

/** @returns {string[]} danh sach loi (rong = hop le) */
export function validatePlaybook(pb) {
  const errs = [];
  if (!isObj(pb)) return ['playbook phai la object JSON'];
  strictKeys(pb, ['name', 'description', 'params', 'limits', 'steps'], 'playbook', errs);
  if (typeof pb.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(pb.name)) errs.push('name: bat buoc, [a-z0-9-] toi da 40 ky tu');
  if (pb.description !== undefined && (typeof pb.description !== 'string' || pb.description.length > 500)) errs.push('description: chuoi <= 500');
  const params = {};
  if (pb.params !== undefined) {
    if (!isObj(pb.params)) errs.push('params: phai la object');
    else for (const [n, p] of Object.entries(pb.params)) {
      const w = `params.${n}`;
      if (!/^[a-z][a-z0-9_]*$/.test(n) || n === 'capture') { errs.push(`${w}: ten khong hop le`); continue; }
      if (!isObj(p)) { errs.push(`${w}: phai la object`); continue; }
      strictKeys(p, ['required', 'default', 'pattern', 'list'], w, errs);
      if (p.required !== undefined && typeof p.required !== 'boolean') errs.push(`${w}.required: boolean`);
      if (p.list !== undefined && typeof p.list !== 'boolean') errs.push(`${w}.list: boolean`);
      if (p.default !== undefined && typeof p.default !== 'string') errs.push(`${w}.default: chuoi`);
      if (p.pattern !== undefined) compileRe(p.pattern, `${w}.pattern`, errs);
      params[n] = p;
      if (typeof p.default === 'string' && !p.default.startsWith('@') && !errs.length) {
        const bad = checkParamValue(n, p, p.default);
        if (bad) errs.push(`${w}.default: ${bad}`);
      }
    }
  }
  if (pb.limits !== undefined) {
    if (!isObj(pb.limits)) errs.push('limits: phai la object');
    else {
      strictKeys(pb.limits, ['timeout_s', 'max_output_bytes'], 'limits', errs);
      if (pb.limits.timeout_s !== undefined && !isInt(pb.limits.timeout_s, 1, 3600)) errs.push('limits.timeout_s: so nguyen 1..3600');
      if (pb.limits.max_output_bytes !== undefined && !isInt(pb.limits.max_output_bytes, 1000, 5000000)) errs.push('limits.max_output_bytes: so nguyen 1000..5000000');
    }
  }
  if (!Array.isArray(pb.steps) || !pb.steps.length) { errs.push('steps: mang khong rong'); return errs; }
  if (pb.steps.length > MAX_STEPS) errs.push(`steps: toi da ${MAX_STEPS} buoc`);
  const ids = new Set();
  const captures = new Set();
  pb.steps.forEach((s, i) => {
    const w = `steps[${i}]`;
    if (!isObj(s)) { errs.push(`${w}: phai la object`); return; }
    strictKeys(s, ['id', 'run', 'cwd', 'timeout_s', 'mutating', 'when', 'expect', 'capture', 'on_fail', 'summarize'], w, errs);
    if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(s.id)) errs.push(`${w}.id: [a-z0-9_-] toi da 40`);
    else if (ids.has(s.id)) errs.push(`${w}.id: trung '${s.id}'`);
    const ww = `steps[${s.id ?? i}]`;
    if (!Array.isArray(s.run) || !s.run.length || s.run.length > 40 || !s.run.every((a) => typeof a === 'string' && a.length <= 500 && !a.includes('\0'))) {
      errs.push(`${ww}.run: MANG chuoi 1..40 phan tu (khong phai chuoi shell)`);
    } else {
      if (!/^[A-Za-z0-9_.-]+$/.test(s.run[0])) errs.push(`${ww}.run[0]: ten exe tran (khong co duong dan/ky tu dac biet)`);
      const d = denyRun(s.run);
      if (d) errs.push(`${ww}.run: ${d}`);
      s.run.forEach((a, k) => { refsIn(a, `${ww}.run[${k}]`, params, captures, errs, { allowList: k > 0 }); });
    }
    if (s.cwd !== undefined) {
      if (typeof s.cwd !== 'string' || !s.cwd) errs.push(`${ww}.cwd: chuoi`);
      else refsIn(s.cwd, `${ww}.cwd`, params, captures, errs);
    }
    if (s.timeout_s !== undefined && !isInt(s.timeout_s, 1, 3600)) errs.push(`${ww}.timeout_s: so nguyen 1..3600`);
    if (s.mutating !== undefined && typeof s.mutating !== 'boolean') errs.push(`${ww}.mutating: boolean`);
    if (s.when !== undefined && s.when !== null) {
      if (!isObj(s.when)) errs.push(`${ww}.when: {step,status} hoac null`);
      else {
        strictKeys(s.when, ['step', 'status'], `${ww}.when`, errs);
        if (!ids.has(s.when.step)) errs.push(`${ww}.when.step: phai la id buoc truoc do`);
        if (!STEP_STATUS.includes(s.when.status)) errs.push(`${ww}.when.status: ${STEP_STATUS.join('|')}`);
      }
    }
    if (s.expect !== undefined) {
      if (!isObj(s.expect)) errs.push(`${ww}.expect: object`);
      else {
        strictKeys(s.expect, ['exit', 'stdout_includes', 'stdout_regex'], `${ww}.expect`, errs);
        if (s.expect.exit !== undefined && !isInt(s.expect.exit, 0, 255)) errs.push(`${ww}.expect.exit: 0..255`);
        if (s.expect.stdout_includes !== undefined && (typeof s.expect.stdout_includes !== 'string' || !s.expect.stdout_includes)) errs.push(`${ww}.expect.stdout_includes: chuoi`);
        if (s.expect.stdout_regex !== undefined) compileRe(s.expect.stdout_regex, `${ww}.expect.stdout_regex`, errs);
      }
    }
    let capName = null;
    if (s.capture !== undefined) {
      if (!isObj(s.capture)) errs.push(`${ww}.capture: object`);
      else {
        strictKeys(s.capture, ['name', 'regex', 'json_path', 'lines'], `${ww}.capture`, errs);
        if (typeof s.capture.name !== 'string' || !/^[A-Za-z_]\w{0,30}$/.test(s.capture.name)) errs.push(`${ww}.capture.name: identifier`);
        else capName = s.capture.name;
        const kinds = ['regex', 'json_path', 'lines'].filter((k) => s.capture[k] !== undefined);
        if (kinds.length !== 1) errs.push(`${ww}.capture: dung 1 trong regex|json_path|lines`);
        if (s.capture.regex !== undefined) compileRe(s.capture.regex, `${ww}.capture.regex`, errs);
        if (s.capture.json_path !== undefined && (typeof s.capture.json_path !== 'string' || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(s.capture.json_path))) errs.push(`${ww}.capture.json_path: a.b.c`);
        if (s.capture.lines !== undefined && !isInt(s.capture.lines, 1, 20)) errs.push(`${ww}.capture.lines: 1..20`);
      }
    }
    if (s.on_fail !== undefined && !['stop', 'continue', 'escalate'].includes(s.on_fail)) errs.push(`${ww}.on_fail: stop|continue|escalate`);
    if (s.summarize !== undefined) {
      if (!isObj(s.summarize)) errs.push(`${ww}.summarize: object`);
      else {
        strictKeys(s.summarize, ['head', 'tail', 'match_regex', 'max_lines'], `${ww}.summarize`, errs);
        for (const k of ['head', 'tail']) if (s.summarize[k] !== undefined && !isInt(s.summarize[k], 0, 50)) errs.push(`${ww}.summarize.${k}: 0..50`);
        if (s.summarize.max_lines !== undefined && !isInt(s.summarize.max_lines, 1, 20)) errs.push(`${ww}.summarize.max_lines: 1..20`);
        if (s.summarize.match_regex !== undefined) compileRe(s.summarize.match_regex, `${ww}.summarize.match_regex`, errs);
      }
    }
    if (typeof s.id === 'string') ids.add(s.id);
    if (capName) captures.add(capName);
  });
  return errs;
}

function checkParamValue(name, spec, v) {
  const items = spec.list ? v.split(',').map((x) => x.trim()) : [v];
  if (spec.list && !v.trim()) return 'danh sach rong';
  const re = new RegExp(`^(?:${spec.pattern ?? SAFE_DEFAULT_PATTERN})$`);
  for (const it of items) {
    if (/[\0\r\n]/.test(it)) return 'chua NUL/xuong dong';
    if (spec.list && !it) return 'phan tu rong';
    if (!re.test(it)) return `gia tri '${it.slice(0, 40)}' khong khop pattern`;
  }
  return null;
}

export function loadPlaybook(nameOrPath, { hub = workspaceRoot() } = {}) {
  let file;
  if (/^[a-z0-9][a-z0-9-]*$/.test(nameOrPath)) file = path.join(hub, '.agents', 'playbooks', `${nameOrPath}.json`);
  else file = path.resolve(hub, nameOrPath);
  if (process.env.HUB_PLAYBOOK_ANY !== '1') {
    const pdir = path.join(hub, '.agents', 'playbooks');
    let real = file; try { real = fs.realpathSync(file); } catch {}
    if (!isInside(file, pdir) || !isInside(real, pdir)) throw new PlaybookError(`playbook phai nam trong .agents/playbooks/ (HUB_PLAYBOOK_ANY=1 de bo qua): ${nameOrPath}`);
  }
  let text;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_PLAYBOOK_BYTES) throw new PlaybookError(`playbook qua lon (> ${MAX_PLAYBOOK_BYTES} byte): ${file}`);
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e instanceof PlaybookError) throw e;
    throw new PlaybookError(`khong doc duoc playbook '${nameOrPath}': ${e.code || e.message}`);
  }
  let pb;
  try { pb = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (e) { throw new PlaybookError(`JSON hong: ${e.message}`); }
  const errs = validatePlaybook(pb);
  if (errs.length) throw new PlaybookError(`playbook khong hop le (${errs.length} loi)`, errs);
  return pb;
}

// ---------- params / substitution ----------
export function resolveParams(pb, given = {}, now = new Date()) {
  const out = {};
  const specs = pb.params || {};
  for (const k of Object.keys(given)) if (!specs[k]) throw new PlaybookError(`param la: '${k}'`);
  for (const [n, spec] of Object.entries(specs)) {
    let v = given[n] !== undefined ? given[n] : resolveBuiltin(spec.default, now);
    if (v === undefined) {
      if (spec.required) throw new PlaybookError(`thieu param bat buoc: ${n}`);
      continue;
    }
    const bad = checkParamValue(n, spec, String(v));
    if (bad) throw new PlaybookError(`param '${n}' bi tu choi: ${bad}`);
    out[n] = spec.list ? String(v).split(',').map((x) => x.trim()) : String(v);
  }
  return out;
}

/** Thay the 1 chuoi; list-param (nguyen ca doi so) -> mang. Tra {value:string[]|string} hoac {missing:'capture.x'}. */
export function subst(tpl, params, caps, { first = false } = {}) {
  const whole = /^\$\{([a-z][a-z0-9_]*)\}$/.exec(tpl);
  if (whole && Array.isArray(params[whole[1]])) return { value: params[whole[1]] };
  let missing = null;
  const value = tpl.replace(TOKEN_RE, (_, t) => {
    const cm = /^capture\.(.+)$/.exec(t);
    if (cm) { if (caps[cm[1]] === undefined) { missing = t; return ''; } return caps[cm[1]]; }
    if (params[t] === undefined) { missing = t; return ''; }
    return Array.isArray(params[t]) ? params[t].join(',') : params[t];
  });
  if (missing) return { missing };
  if (!first && tpl !== value && !tpl.startsWith('-') && value.startsWith('-')) return { error: `gia tri thay the bat dau bang '-' (tiem option): ${value.slice(0, 30)}` };
  return { value };
}

export function buildArgv(step, params, caps) {
  const out = [];
  for (let i = 0; i < step.run.length; i++) {
    const r = subst(step.run[i], params, caps, { first: i === 0 });
    if (r.missing) return { missing: r.missing };
    if (r.error) return { error: r.error };
    if (Array.isArray(r.value)) {
      for (const it of r.value) { if (it.startsWith('-')) return { error: `phan tu list bat dau bang '-': ${it}` }; out.push(it); }
    } else out.push(r.value);
  }
  const d = denyRun(out);
  if (d) return { error: `sau khi thay the: ${d}` };
  return { argv: out };
}
