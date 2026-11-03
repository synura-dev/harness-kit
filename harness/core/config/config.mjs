// Bo nap config duy nhat (S1): loadConfig(tool, opts) -> {config, sources, warnings}. Khong bao gio throw.
// Thu tu D3: code < default.json < machine < project < env < flag. Luat loi (protect) chi tat o tang machine.
// warnings CHI chua ten khoa/ten file/id, KHONG chua gia tri (bi mat).
// opts: {project, flags, env, root} + {defaults, protect, envAliases, maxBytes, configDir}.
//   protect: {arrKey: {ids:'all-from-code'|[id]}}; mang co id gop theo id, {id, disable:true} go phan tu.
//   envAliases: {OLD_VAR: 'a.b'} (env cu, giu 1 vong, canh bao legacy-env).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { workspaceRoot, isObj, isPluginMode, REPO_DIR } from '../io/paths.mjs';
import { CORE_RULE_DISABLE_LAYERS, LEGACY_WARNING, configPath, envName } from './contract.mjs';

const MAX_FILE_BYTES = 256 * 1024;
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
const NAME_RE = /^[\w.-]+$/;
const validName = (n) => typeof n === 'string' && NAME_RE.test(n) && !n.includes('..') && n !== '.';
const hasId = (a) => a.some((e) => isObj(e) && e.id !== undefined);

function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) if (!BAD.has(k)) o[k] = clean(v[k]); return o; }
  return v;
}
function clearUnder(sources, p) {
  for (const k of Object.keys(sources)) if (k === p || k.startsWith(p + '.')) delete sources[k];
}
function mark(v, p, src, sources) {
  if (isObj(v) && Object.keys(v).length) for (const k of Object.keys(v)) mark(v[k], p ? p + '.' + k : k, src, sources);
  else if (p) sources[p] = src;
}
function getPath(o, p) { let c = o; for (const k of p.split('.')) { if (!isObj(c) || BAD.has(k)) return undefined; c = c[k]; } return c; }
function setPath(o, p, v) {
  const ks = p.split('.'); if (ks.some((k) => BAD.has(k))) return;
  let c = o; for (const k of ks.slice(0, -1)) { if (!isObj(c[k])) c[k] = {}; c = c[k]; }
  c[ks[ks.length - 1]] = v;
}
function leaves(o, p = '', out = []) {
  for (const k of Object.keys(o)) { const q = p ? p + '.' + k : k; if (isObj(o[k]) && Object.keys(o[k]).length) leaves(o[k], q, out); else out.push(q); }
  return out;
}

function readConfigJson(file, warnings, maxBytes) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const name = path.basename(file);
  if (st.size > maxBytes) { warnings.push(`${name}: qua lon, bo tang`); return null; }
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    const j = JSON.parse(t);
    if (!isObj(j)) { warnings.push(`${name}: goc khong phai object, bo tang`); return null; }
    return j;
  } catch { warnings.push(`${name}: JSON hong, bo tang`); return null; }
}

function protectedIds(opts, defaults, p) {
  const pc = isObj(opts.protect) && isObj(opts.protect[p]) ? opts.protect[p] : null;
  if (!pc) return new Set();
  if (pc.ids === 'all-from-code') {
    const a = getPath(defaults, p);
    return new Set((Array.isArray(a) ? a : []).filter((e) => isObj(e) && e.id !== undefined).map((e) => e.id));
  }
  return new Set(Array.isArray(pc.ids) ? pc.ids : []);
}

function mergeArr(base, over, ctx, p) {
  const res = base.slice();
  const prot = protectedIds(ctx.opts, ctx.defaults, p);
  const canDisable = CORE_RULE_DISABLE_LAYERS.includes(ctx.kind) || ctx.kind === 'code' || ctx.kind === 'default';
  for (const e of over) {
    if (!isObj(e) || e.id === undefined) { ctx.warnings.push(`${p}: phan tu khong id bi bo (${ctx.src})`); continue; }
    if (prot.has(e.id) && !canDisable) { ctx.warnings.push(`${p}: id "${e.id}" duoc bao ve, tang ${ctx.src} khong duoc sua/tat, bo`); continue; }
    const i = res.findIndex((x) => isObj(x) && x.id === e.id);
    if (e.disable) { if (i >= 0) res.splice(i, 1); continue; }
    if (i >= 0) res[i] = e; else res.push(e);
  }
  return res;
}

function mergeInto(target, over, ctx, prefix = '') {
  for (const k of Object.keys(over)) {
    if (BAD.has(k)) continue;
    const v = clean(over[k]);
    const p = prefix ? prefix + '.' + k : k;
    if (p === 'disable' && Array.isArray(v) && v.length && !CORE_RULE_DISABLE_LAYERS.includes(ctx.kind) && ctx.kind !== 'code' && ctx.kind !== 'default') {
      ctx.warnings.push(`disable: chi duoc dat o tang ${CORE_RULE_DISABLE_LAYERS.join('|')}, bo (${ctx.src})`); continue;
    }
    if (isObj(v) && isObj(target[k])) { mergeInto(target[k], v, ctx, p); continue; }
    const idKey = isObj(ctx.opts.protect) && isObj(ctx.opts.protect[p]);
    if (Array.isArray(v) && (hasId(v) || idKey || (Array.isArray(target[k]) && hasId(target[k])))) {
      if (Array.isArray(target[k]) || target[k] === undefined) {
        target[k] = mergeArr(Array.isArray(target[k]) ? target[k] : [], v, ctx, p);
        clearUnder(ctx.sources, p); ctx.sources[p] = ctx.src; continue;
      }
    } else if (!Array.isArray(v) && Array.isArray(target[k]) && hasId(target[k])) {
      ctx.warnings.push(`${p}: khong phai mang, khong thay duoc mang id, bo (${ctx.src})`); continue;
    }
    target[k] = v;
    clearUnder(ctx.sources, p);
    mark(v, p, ctx.src, ctx.sources);
  }
}

const parseEnv = (s) => { try { return clean(JSON.parse(s)); } catch { return s; } };

// Lop du an (workspace/.harness/config/<tool>/project.json) la dau vao khong tin cay: chi cac khoa nay duoc dat (them luat siet).
// Moi khoa khac (projectResolver, extRoots, ownerRoots, knowledge.root, duong dan/ma thuc thi...) bi chan.
export const PROJECT_LAYER_ALLOW = Object.freeze({ guard: Object.freeze(['denyPatterns', 'allowlist', 'protectedPaths']) });

export function pluginLayerDirs({ env = process.env, repoDir = REPO_DIR } = {}) {
  const pd = typeof env.CLAUDE_PLUGIN_DATA === 'string' && env.CLAUDE_PLUGIN_DATA.trim();
  let pname = 'harness-kit'; try { pname = JSON.parse(fs.readFileSync(path.join(repoDir, '.claude-plugin', 'plugin.json'), 'utf8')).name || pname; } catch { /* mac dinh */ }
  const machineDir = path.join(pd ? pd : path.join(os.homedir(), '.claude', 'plugins', ['da', 'ta'].join(''), pname), 'config');
  let projectDir = null; try { projectDir = path.join(workspaceRoot({ env, repoDir }), '.harness', 'config'); } catch { /* khong co */ }
  return { machineDir, projectDir };
}

export function loadConfig(tool, opts = {}) {
  const warnings = [];
  const sources = {};
  const config = {};
  try {
    const o = isObj(opts) ? opts : {};
    const env = isObj(o.env) ? o.env : process.env;
    const maxBytes = o.maxBytes || MAX_FILE_BYTES;
    const defaults = isObj(o.defaults) ? clean(o.defaults) : {};
    const mk = (kind, src) => ({ kind, src, opts: o, defaults, warnings, sources });
    mergeInto(config, defaults, mk('code', 'code'));
    if (!validName(tool)) { warnings.push('tool khong hop le'); return { config, sources, warnings }; }

    let root = o.root;
    if (!root) { try { root = workspaceRoot({ env }); } catch { root = null; } }
    // Plugin mode (3 lop): plugin (<codeRoot>/config, doc) < may (CLAUDE_PLUGIN_DATA | ~/.claude/plugins/<x>/<ten>/config) < du an (<du an>/.harness/config). Lop du an KHONG tat/ha luat loi (protect).
    const plug = !(typeof env.HARNESS_CONFIG_DIR === 'string' && env.HARNESS_CONFIG_DIR.trim()) && isPluginMode(o.repoDir || REPO_DIR);
    let machineDir = null, projectDir = null;
    if (plug) { const d = pluginLayerDirs({ env, repoDir: o.repoDir || REPO_DIR }); machineDir = d.machineDir; projectDir = d.projectDir; root = o.repoDir || REPO_DIR; }
    let cfgDir = o.configDir || (typeof env.HARNESS_CONFIG_DIR === 'string' && env.HARNESS_CONFIG_DIR.trim()) || (root ? path.join(root, 'config') : null);
    if (cfgDir) {
      cfgDir = path.resolve(cfgDir);
      // Ten trung tinh 'workspace' <-> ten cu 'hub': neu chi co thu muc/file cua ten kia thi doc ten kia (khong doi file user).
      const has = (n) => fs.existsSync(path.join(cfgDir, n)) || fs.existsSync(path.join(cfgDir, n + '.local.json'));
      const ALIAS = { workspace: 'hub', hub: 'workspace' };
      const ft = ALIAS[tool] && !has(tool) && has(ALIAS[tool]) ? ALIAS[tool] : tool;
      const at = (rel) => path.join(cfgDir, rel.replace(/^config\//, ''));
      const apply = (file, kind, src) => {
        const j = readConfigJson(file, warnings, maxBytes);
        if (j) mergeInto(config, j, mk(kind, src));
        return !!j;
      };
      apply(at(configPath('default', ft)), 'default', 'default');
      const local = at(configPath('machine', ft));
      const legacy = at(configPath('machineLegacy', ft));
      if (fs.existsSync(local)) apply(local, 'machine', 'machine');
      else if (apply(legacy, 'machine', 'machine')) warnings.push(`${LEGACY_WARNING}: ${path.basename(legacy)} -> ${configPath('machine', ft)}`);
      // legacy: config/<tool>/*.local.json (theo ten) la tang machine
      let extra = [];
      try { extra = fs.readdirSync(path.join(cfgDir, ft)).filter((f) => f.endsWith('.local.json') && f !== 'local.json').sort(); } catch { /* thieu thu muc */ }
      for (const f of extra) if (apply(path.join(cfgDir, ft, f), 'machine', 'machine')) warnings.push(`${LEGACY_WARNING}: ${ft}/${f} -> ${configPath('machine', ft)}`);
      if (plug && machineDir) apply(path.join(machineDir, configPath('machine', ft).replace(/^config\//, '')), 'machine', 'machine');
      if (plug && projectDir && !o.skipProjectLayer) {
        const pj = readConfigJson(path.join(projectDir, ft, 'project.json'), warnings, maxBytes);
        if (pj) {
          const allow = PROJECT_LAYER_ALLOW[ft] || [];
          const kept = {};
          for (const k of Object.keys(pj)) { if (allow.includes(k)) kept[k] = pj[k]; else warnings.push(`project.json: khoa "${k}" khong duoc phep o lop du an, bo`); }
          mergeInto(config, kept, mk('project', 'project:project'));
        }
      }
      if (o.project !== undefined && o.project !== null) {
        if (validName(o.project)) {
          const pp = at(configPath('project', ft, o.project));
          const lg = path.join(cfgDir, ft, o.project + '.json'); // legacy: config/<tool>/<id>.json (1 vong, canh bao)
          const reserved = ['default', 'local', 'projects'].includes(o.project) || o.project.endsWith('.local') || o.project.endsWith('.example');
          if (!fs.existsSync(pp) && !reserved && fs.existsSync(lg)) {
            if (apply(lg, 'project', 'project:' + o.project)) warnings.push(`${LEGACY_WARNING}: ${ft}/${o.project}.json -> ${configPath('project', ft, o.project)}`);
          } else apply(pp, 'project', 'project:' + o.project);
        } else warnings.push('ten project khong hop le');
      }
    }

    // env: HARNESS_<TOOL>_<KEY> cho moi khoa la; alias cu giu 1 vong.
    const ctxEnv = mk('env', 'env');
    for (const [name, key] of Object.entries(isObj(o.envAliases) ? o.envAliases : {})) {
      if (typeof env[name] === 'string' && env[name] !== '') {
        const patch = {}; setPath(patch, String(key), parseEnv(env[name]));
        mergeInto(config, patch, { ...ctxEnv, src: 'env:' + name });
        warnings.push(`legacy-env: ${name} -> ${envName(tool, String(key).replace(/\./g, '_'))}`);
      }
    }
    for (const key of leaves(config)) {
      const name = envName(tool, key.replace(/\./g, '_'));
      if (typeof env[name] === 'string' && env[name] !== '') {
        const patch = {}; setPath(patch, key, parseEnv(env[name]));
        mergeInto(config, patch, { ...ctxEnv, src: 'env:' + name });
      }
    }
    if (isObj(o.flags)) mergeInto(config, o.flags, mk('flag', 'flag'));
  } catch (e) { warnings.push('loi noi bo'); }
  return { config, sources, warnings };
}

// ---- Bo nap phang cho hook/projects: defaults < files < env map. Mang thay hang, khong throw. Khong co luat bao ve (guard dung loadConfig).
// loadFlat({ defaults, files: [path...], env: { NAME: 'a.b.c' } }) -> { config, warnings }
const clone = (v) => (Array.isArray(v) ? v.map(clone) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);

export function merge(base, over) {
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__') continue;
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : clone(v);
  }
  return out;
}

export function loadFlat(opts = {}) {
  const warnings = [];
  let config = {};
  try {
    config = isObj(opts.defaults) ? clone(opts.defaults) : {};
    for (const f of Array.isArray(opts.files) ? opts.files : []) {
      let raw;
      try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { if (e && e.code !== 'ENOENT') warnings.push(`${f}: khong doc duoc (${e.code || e.message})`); continue; }
      try {
        const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
        if (!isObj(j)) { warnings.push(`${f}: khong phai object JSON, bo qua`); continue; }
        config = merge(config, j);
      } catch (e) { warnings.push(`${f}: JSON hong, bo qua (${e.message})`); }
    }
    for (const [name, p] of Object.entries(opts.env || {})) {
      const v = process.env[name];
      if (v !== undefined && v !== '') { try { setPath(config, String(p).split('.').filter((k) => k).join('.'), parseEnv(v)); } catch (e) { warnings.push(`env ${name}: ${e.message}`); } }
    }
  } catch (e) {
    warnings.push(`loadFlat: ${e && e.message}`);
    if (!isObj(config)) config = {};
  }
  return { config, warnings };
}

// ---- Cau noi hook -> loadConfig. loadHookConfig(tool, {defaults, files, env: {OLD_VAR:'a.b'}}) -> {config, sources, warnings}.
// files (hook.config.json, *.local.json) = tang code/legacy duoi cung (giu duong dan cu); tren do: config/<tool>/{default,local}.json,
// project, env HARNESS_<TOOL>_<KEY>, alias env cu (canh bao legacy-env). *.local.json con ton tai -> canh bao legacy-config (chi ten file).
export function loadHookConfig(tool, opts = {}) {
  const files = Array.isArray(opts.files) ? opts.files : [];
  const base = loadFlat({ defaults: opts.defaults, files });
  const warnings = base.warnings.slice();
  for (const f of files) {
    try { if (typeof f === 'string' && /\.local\.json$/.test(f) && fs.existsSync(f)) warnings.push(`legacy-config: ${path.basename(f)} -> config/${tool}/local.json`); } catch { /* bo qua */ }
  }
  const r = loadConfig(tool, { defaults: base.config, envAliases: opts.env, project: opts.project, flags: opts.flags, root: opts.root, configDir: opts.configDir });
  return { config: r.config, sources: r.sources, warnings: warnings.concat(r.warnings) };
}
