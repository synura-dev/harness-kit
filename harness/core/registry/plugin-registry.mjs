// harness/core/registry/plugin-registry.mjs - registry = manifest.json cua tung extension (nguon duy nhat). Thuan doc, khong import cli/plugins/hooks/tools.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/config.mjs';
import { validateExtManifest, validateExtRoots, TOP_DIRS, DEFAULT_CAPS, IMPORT_RULES, GROUP_ZONES } from '../config/contract.mjs';

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Doc cac thu muc co manifest.json; tra {domains, meta, manifests, errors, drift:[]}.
// domains: ten -> file tuyet doi; meta: ten -> {desc, cmds, default}.
function scan(targets, hubRel) {
  const domains = {}, meta = {}, manifests = [], errors = [], ext = {}, rawAliases = [];
  let cur = null, curMan = null;
  // aliases: muc domain (domains.<d>.aliases) hoac muc manifest (tro ve m.domain); aliasMap[alias] = anh xa lenh con (du lieu, xem translateAlias).
  const addAliases = (list, dom, o) => {
    if (!Array.isArray(list)) return;
    for (const a of list) rawAliases.push({ alias: a, domain: dom, map: (o && o.aliasMap && o.aliasMap[a]) || (curMan && curMan.aliasMap && curMan.aliasMap[a]) || null, label: cur ? cur.rel : '' });
  };
  const addDomain = (dom, file, label, m) => {
    if (domains[dom]) { errors.push(`${label}: trung domain ${dom} voi ${domains[dom]}`); return; }
    domains[dom] = file;
    if (cur && cur.ext) ext[dom] = cur.ext; // domain tu extRoot: spawn, khong import
    const o = m || {};
    meta[dom] = { desc: o.desc, cmds: o.cmds, default: o.default };
    addAliases(o.aliases, dom, o);
  };
  for (const t of targets) {
    cur = t;
    const mf = path.join(t.dir, 'manifest.json');
    if (!fs.existsSync(mf)) continue;
    let m;
    try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { errors.push(`${t.rel}: manifest JSON hong`); continue; }
    const errs = validateExtManifest(m);
    if (errs.length) { errors.push(...errs.map((x) => `${t.rel}: ${x}`)); continue; }
    const entry = path.join(t.dir, m.entry);
    if (!fs.existsSync(entry)) { errors.push(`${t.rel}: entry khong ton tai (${m.entry})`); continue; }
    curMan = m;
    manifests.push(hubRel ? { ...m, dir: t.dirRel || `harness/${t.rel}` } : m);
    if (m.kind !== 'cli') continue;
    if (m.domains && typeof m.domains === 'object') {
      for (const [dom, v] of Object.entries(m.domains)) {
        const o = typeof v === 'string' ? { file: v } : v;
        const f = path.join(t.dir, String(o.file));
        if (!fs.existsSync(f)) errors.push(`${t.rel}: domain ${dom} tro file khong ton tai (${o.file})`);
        else addDomain(dom, f, t.rel, o);
      }
    } else addDomain(m.domain, entry, t.rel, m);
    if (m.domains && m.domain && m.aliases) addAliases(m.aliases, m.domain, m); // aliases muc manifest + co `domains`: tro ve domain chinh
  }
  // Giai alias sau khi biet het domain that: trung domain that / trung alias khac / tro domain khong ton tai => loi registry (alias bi bo, khong ghi de).
  const aliases = {};
  for (const r of rawAliases) {
    if (Object.hasOwn(domains, r.alias)) errors.push(`${r.label}: alias ${r.alias} trung domain that`);
    else if (Object.hasOwn(aliases, r.alias)) errors.push(`${r.label}: alias ${r.alias} trung alias da dang ky -> ${aliases[r.alias].domain}`);
    else if (!Object.hasOwn(domains, r.domain)) errors.push(`${r.label}: alias ${r.alias} tro domain khong ton tai (${r.domain})`);
    else aliases[r.alias] = { domain: r.domain, map: r.map };
  }
  for (const [al, v] of Object.entries(aliases)) (meta[v.domain].aliases ||= []).push(al);
  return { domains, meta, manifests, errors, drift: [], ext, aliases };
}

/**
 * Dich tham so lenh cu -> lenh domain dich theo spec = { map?: {sub: [lenh...]}, pass?: [sub...], fallback?: [lenh...] } (aliasMap[alias] trong manifest).
 * Thu tu: map[a0] -> pass (giu nguyen) -> fallback + args -> (co map/pass ma khong khop) loi -> khong co spec: giu nguyen. Tra {args} | {error}.
 */
export function translateAlias(spec, args) {
  const s = spec || {};
  const [a0, ...rest] = args;
  if (a0 !== undefined && s.map && Object.hasOwn(s.map, a0)) return { args: [...s.map[a0], ...rest] };
  if (a0 !== undefined && Array.isArray(s.pass) && s.pass.includes(a0)) return { args };
  if (Array.isArray(s.fallback)) return { args: [...s.fallback, ...args] };
  if (s.map || s.pass) return { error: `lenh la: ${a0 ?? ''} (can: ${[...Object.keys(s.map || {}), ...(s.pass || [])].join(' | ')})` };
  return { args };
}

const EXT_LIMITS = Object.freeze({ maxManifests: 40, timeoutMs: 2000 });

// extRoots (tuong doi goc hub) -> targets: <root>/manifest.json va <root>/<con>/manifest.json. Root khong ton tai -> bo qua em.
// Co gioi han so manifest + thoi gian; vuot -> dung em, bao loi 'truncated'. Chi doc, domain o day se bi SPAWN (khong import).
function extTargets(hubRoot, extRoots, errors, limits) {
  const out = [];
  if (extRoots === undefined || extRoots === null) return out;
  const bad = validateExtRoots(extRoots);
  if (bad.length) { errors.push(...bad); return out; }
  const t0 = Date.now();
  for (const raw of extRoots) {
    const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!rel) continue;
    const abs = path.resolve(hubRoot, rel);
    const back = path.relative(hubRoot, abs);
    if (back.startsWith('..') || path.isAbsolute(back)) { errors.push(`extRoots: ${raw} ra ngoai goc hub`); continue; }
    if (!fs.existsSync(abs)) continue;
    const cands = [{ rel, dirRel: rel, dir: abs, ext: rel }, ...subdirs(abs).map((d) => ({ rel: `${rel}/${d}`, dirRel: `${rel}/${d}`, dir: path.join(abs, d), ext: rel }))];
    for (const c of cands) {
      if (Date.now() - t0 > limits.timeoutMs) { errors.push(`extRoots: truncated: timeout (${rel})`); return out; }
      if (!fs.existsSync(path.join(c.dir, 'manifest.json'))) continue;
      if (out.length >= limits.maxManifests) { errors.push(`extRoots: truncated: toi da ${limits.maxManifests} manifest`); return out; }
      out.push(c);
    }
  }
  return out;
}

const subdirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; } };

/** Doc tho moi manifest.json (cli + plugins/tools/hooks), khong kiem hop le/entry: [{dir:'harness/<z>/<d>', m}]. Manifest hong bi bo qua. */
export function readManifests(harnessDir = HARNESS_DIR) {
  const out = [];
  const targets = [{ rel: 'cli', dir: path.join(harnessDir, 'cli') }];
  for (const z of ZONES) for (const d of subdirs(path.join(harnessDir, z))) targets.push({ rel: `${z}/${d}`, dir: path.join(harnessDir, z, d) });
  for (const t of targets) {
    try { out.push({ dir: `harness/${t.rel}`, m: JSON.parse(fs.readFileSync(path.join(t.dir, 'manifest.json'), 'utf8')) }); } catch { /* khong co/hong */ }
  }
  return out;
}

/** Registry plugins/ (opts.pluginsDir). plugins/ mac dinh co the vang (da chuyen het sang hub/ + observe/...): khong bao loi. */
export function loadPluginRegistry(opts = {}) {
  const pluginsDir = opts.pluginsDir || path.join(HARNESS_DIR, 'plugins');
  const r = scan(subdirs(pluginsDir).map((d) => ({ rel: d, dir: path.join(pluginsDir, d) })));
  if (opts.pluginsDir && !fs.existsSync(pluginsDir)) r.errors.push(`khong doc duoc ${pluginsDir}: ENOENT`);
  return r;
}

// Vung quet manifest <vung>/<nhom>/manifest.json; skills/ va config/ la du lieu, khong quet.
// Domain chi dang ky khi manifest kind:'cli' (bat buoc co `domain`); co `domains` thi dang ky moi muc trong do (bo qua `domain`).
const ZONES = ['plugins', 'tools', 'hooks', ...GROUP_ZONES];

/** Registry cac vung ZONES (plugins, tools, hooks + vung nhom moi) + cli/manifest.json (nhieu domain qua `domains`). Thuan doc. */
export function loadHarnessRegistry(opts = {}) {
  const hd = opts.harnessDir || HARNESS_DIR;
  const targets = [{ rel: 'cli', dir: path.join(hd, 'cli') }];
  for (const z of ZONES) for (const d of subdirs(path.join(hd, z))) targets.push({ rel: `${z}/${d}`, dir: path.join(hd, z, d) });
  // extRoots: opts.extRoots (mang tuong doi), opts.hubRoot (mac dinh = cha cua harnessDir). Harness quet truoc => trung ten: harness thang + bao loi.
  const pre = [];
  const ext = extTargets(opts.hubRoot || path.dirname(hd), opts.extRoots, pre, { ...EXT_LIMITS, ...(opts.extLimits || {}) });
  const r = scan(targets.concat(ext), true);
  r.errors.push(...pre);
  return r;
}

// ---- Phan cau truc harness trong docs/ARCHITECTURE.md: SINH tu registry + contract (khong viet tay). Lenh: adapters --write-arch.
export const ARCH_BEGIN = '<!-- generated:begin -->';
export const ARCH_END = '<!-- generated:end -->';

/** Render khoi markdown (khong gom marker), on dinh/idempotent: chi phu thuoc registry manifest, contract va ten thu muc. */
export function renderArchitecture(opts = {}) {
  const hd = opts.harnessDir || HARNESS_DIR;
  const hub = opts.hubRoot || path.dirname(hd);
  let extRoots = opts.extRoots;
  if (extRoots === undefined) { try { extRoots = loadConfig('workspace', { root: hub }).config.extRoots; } catch { /* khong co config -> khong extRoots */ } }
  const reg = loadHarnessRegistry({ harnessDir: hd, hubRoot: hub, extRoots });
  const rel = (f) => path.relative(hub, f).split(path.sep).join('/'); // tuong doi goc hub: harness/... va hub/...
  const L = ['Sinh tu manifest registry + contract (`node harness/cli/harness.mjs adapters --write-arch`); KHONG sua tay trong khoi nay.', ''];
  L.push('### Cay thu muc harness/ (2 cap)', '```');
  for (const z of TOP_DIRS) {
    if (!fs.existsSync(path.join(hd, z))) continue;
    L.push(`harness/${z}/`);
    for (const s of subdirs(path.join(hd, z))) L.push(`  ${s}/`);
  }
  L.push('```', '', '### Domain va lenh (cong `harness.mjs`)', '| domain | file | lenh | mac dinh | mo ta |', '|---|---|---|---|---|');
  const cell = (x) => String(x == null ? '' : x).replace(/\|/g, '\\|');
  const row = (dom) => {
    const m = reg.meta[dom] || {};
    const cmds = Array.isArray(m.cmds) ? m.cmds.join(' ') : m.cmds;
    const al = m.aliases && m.aliases.length ? ` (alias: ${m.aliases.join(', ')})` : '';
    L.push(`| \`${dom}\` | \`${rel(reg.domains[dom])}\` | ${cell(cmds)} | ${cell(m.default)} | ${cell((m.desc || '') + al)} |`);
  };
  const all = Object.keys(reg.domains).sort();
  all.filter((d) => !reg.ext[d]).forEach(row);
  for (const g of [...new Set(Object.values(reg.ext))].sort()) { L.push(`| **${g}/** | | | | nhom Hub (extRoots) |`); all.filter((d) => reg.ext[d] === g).forEach(row); }
  L.push('', '### Tran file nguon', `Tran phang moi thu muc: flatMax=${DEFAULT_CAPS.flatMax}; filesPerExtension=${DEFAULT_CAPS.filesPerExtension}; maxDepth=${DEFAULT_CAPS.maxDepth}; linesPerFile=${DEFAULT_CAPS.linesPerFile}. Khong co tran tong de quy theo vung.`);
  L.push('', '### Zone import (nguon -> dich duoc phep)', '| zone | duoc import |', '|---|---|');
  for (const [z, a] of Object.entries(IMPORT_RULES)) L.push(`| ${z} | ${a.join(', ')} |`);
  return L.join('\n');
}

/** Thay khoi giua marker; null neu thieu marker. */
export function applyArchitecture(text, block) {
  const i = text.indexOf(ARCH_BEGIN), k = text.indexOf(ARCH_END);
  if (i < 0 || k < i) return null;
  return text.slice(0, i) + ARCH_BEGIN + '\n' + block + '\n' + text.slice(k);
}

/** write=false: chi kiem. Tra {changed, problem}. root = goc hub. */
export function syncArchitecture(root, write = false) {
  const f = path.join(root, 'docs', 'ARCHITECTURE.md');
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { return { changed: false, problem: 'docs/ARCHITECTURE.md khong doc duoc' }; }
  const n = applyArchitecture(t, renderArchitecture({ harnessDir: path.join(root, 'harness'), hubRoot: root }));
  if (n === null) return { changed: false, problem: 'docs/ARCHITECTURE.md thieu marker generated:begin/end' };
  if (n === t) return { changed: false };
  if (write) fs.writeFileSync(f, n);
  return { changed: true };
}
