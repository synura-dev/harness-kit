// Lenh `data register` va `data tree`. Tra {code, lines}; W2 noi vao dispatch data.mjs.
// ctx: { dataDir, hubRoot, registryFile?, wsDir?, readmeFile?, callerDir?, resolveProject?(id)->{path}|null, ownerRoots?: string[] (rel hub; mac dinh ['.']) }
import fs from 'node:fs';
import path from 'node:path';
import { ZONES, CLASSES, CLASS_DEFAULTS, readJ as readJson, writeAtomic } from '../../core/registry/data-registry.mjs';
import { workspaceRoot } from '../../core/io/paths.mjs';
import { safeId } from '../../core/io/safe-id.mjs';

export const TREE_START = '<!-- data-tree:start -->';
export const TREE_END = '<!-- data-tree:end -->';
const SEG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;

const paths = (ctx = {}) => {
  const hub = ctx.hubRoot || workspaceRoot();
  return {
    hub,
    reg: ctx.registryFile || path.join(hub, 'harness', 'observe', 'storage', 'registry.json'),
    ws: ctx.wsDir || path.join(hub, 'config', 'data', 'workspaces'),
    readme: ctx.readmeFile || path.join(hub, 'harness', 'observe', 'storage', 'README.md'),
  };
};
const readJ = (f, d) => readJson(f) ?? d;

export function parseArgs(args = []) {
  const o = { _: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '--write-readme' || a === '--no-resolve') o.flags[a.slice(2)] = true;
    else if (a.startsWith('--')) o.flags[a.slice(2)] = args[++i];
    else o._.push(a);
  }
  return o;
}

/** Goi y class theo ten tool. */
export function hintClass(tool) {
  if (/(^|[-_.])(log|logs|jsonl|events?)($|[-_.])|\.jsonl$/i.test(tool)) return 'log';
  if (/(^|[-_.])(cache|state)($|[-_.])|^\.state/i.test(tool)) return 'cache';
  return null;
}

/** Xu ly ca dang text (1 dong duong dan) va json (object co path/root). */
export function parseResolveOutput(out) {
  const lines = String(out || '').split(/\r?\n/).filter((l) => l.trim() && !/^warn:/.test(l));
  const txt = lines.join('\n').trim();
  if (txt.startsWith('{')) {
    try { const j = JSON.parse(txt); const p = j.path || j.root || j.dir || j.abs; return p ? { path: p } : null; } catch { return null; }
  }
  if (!lines.length || /^khong resolve duoc/i.test(lines[0])) return null;
  return { path: lines[0].trim() };
}

// Provider inject qua ctx.resolveProject(id)->{path}|null. Khong co provider -> bo qua kiem project.
function resolveProject(id, ctx) {
  if (ctx.resolverFailed) return null; // fail-closed: resolver co cau hinh nhung khong dung duoc
  return ctx.resolveProject ? ctx.resolveProject(id) : { path: 'unchecked' };
}

export function registerCmd(args = [], ctx = {}) {
  const P = paths(ctx);
  const { _, flags } = parseArgs(args);
  const err = (m) => ({ code: 2, lines: [`register: ${m}`] });
  if (_.length !== 1) return err('usage: register <zone>/<domain|ws>/<tool> --class C [--project ID] [--owner X] [--note T] [--yes]');
  const segs = _[0].split('/');
  if (segs.length !== 3) return err('dich phai la <zone>/<domain|ws>/<tool>');
  const [zone, domain, tool] = segs;
  if (!ZONES.includes(zone)) return err(`zone khong hop le: ${zone} (${ZONES.join(', ')})`);
  if (zone === '_inbox') return err('_inbox khong dang ky duoc');
  for (const s of [domain, tool]) {
    if (!SEG.test(s) || safeId(s) !== s || s.includes('..')) return err(`ten doan khong hop le: ${s}`);
    if (/\.example$/i.test(s)) return err(`ten doan khong duoc ket thuc .example: ${s}`);
  }

  const notes = [];
  let cls = flags.class;
  if (!cls) {
    cls = hintClass(tool);
    if (!cls) return err(`thieu --class (${CLASSES.join(', ')})`);
    notes.push(`class goi y theo ten: ${cls}`);
  }
  if (!CLASSES.includes(cls)) return err(`class khong hop le: ${cls} (${CLASSES.join(', ')})`);

  let owner = flags.owner;
  if (owner) {
    let abs = path.isAbsolute(owner) ? owner : path.join(P.hub, owner);
    if (path.isAbsolute(owner)) {
      const rel = path.relative(P.hub, owner);
      const roots = ctx.ownerRoots?.length ? ctx.ownerRoots : ['.'];
      const inRoot = roots.some((r) => { const rr = path.relative(path.join(P.hub, r), owner); return rr && !rr.startsWith('..') && !path.isAbsolute(rr); });
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !inRoot) return err(`owner tuyet doi ngoai hub bi tu choi: ${owner}`);
      owner = rel.split(path.sep).join('/');
      abs = path.join(P.hub, owner);
    }
    if (!fs.existsSync(abs)) return err(`owner khong ton tai: ${owner}`);
  } else if (ctx.callerDir) owner = path.relative(P.hub, ctx.callerDir).split(path.sep).join('/') || '.';
  else return err('thieu --owner (duong dan ton tai)');

  const entry = { zone, class: cls, tool, owner };
  const isWs = zone === 'workspaces';
  if (isWs) {
    entry.workspace = domain;
    const pid = flags.project || domain;
    const tmpRoot = flags['no-resolve'] && process.env.HUB_DATA_DIR && path.resolve(process.env.HUB_DATA_DIR) !== path.resolve(path.join(P.hub, 'data'));
    const r = tmpRoot ? { path: 'tmp' } : resolveProject(pid, ctx);
    if (!r || !r.path) return err(`projects resolve that bai cho id: ${pid}`);
    entry.project = pid;
  } else if (flags.project) entry.project = flags.project;
  if (flags.note) entry.note = String(flags.note).slice(0, 200);

  const key = `${zone}/${domain}/${tool}`;
  const wsFile = path.join(P.ws, `${domain}.json`);
  if (!fs.existsSync(P.reg) || readJson(P.reg) === null) return err(`registry.json khong doc duoc: ${P.reg} (khong ghi de)`);
  if (isWs && fs.existsSync(wsFile) && readJson(wsFile) === null) return err(`workspace json hong: ${wsFile} (khong ghi de)`);
  const reg = readJ(P.reg, { entries: {}, reserved: [] });
  const doc = isWs ? readJ(wsFile, { workspace: domain, entries: {} }) : reg;
  doc.entries ||= {};
  const k = isWs ? tool : key;
  if (Object.hasOwn(doc.entries, k) || Object.hasOwn(reg.entries || {}, key)) return err(`trung key: ${key}`);

  const d = CLASS_DEFAULTS[cls];
  const target = isWs ? wsFile : P.reg;
  const lines = [...notes.map((n) => `note: ${n}`), `${flags.yes ? 'ghi' : 'dry-run'} -> ${target}`, `+ "${k}": ${JSON.stringify(entry)}`, `  (retention ${d.retentionDays ?? 'giu'}d, maxFiles ${d.maxFiles}, maxDepth ${d.maxDepth} suy tu class)`];
  if (!flags.yes) { lines.push('them --yes de ghi'); return { code: 0, lines }; }
  doc.entries[k] = entry;
  writeAtomic(target, JSON.stringify(doc, null, 2) + '\n');
  return { code: 0, lines };
}

function collect(P) {
  const rows = [];
  const add = (key, e) => {
    const zone = e.domain || e.zone || 'legacy';
    const segs = key.split('/');
    const group = e.workspace || (e.zone && segs.length === 3 ? segs[1] : segs[0]);
    const tool = e.tool || (segs.length === 3 ? segs[2] : '-');
    const ret = e.retentionDays !== undefined ? e.retentionDays : (CLASS_DEFAULTS[e.class]?.retentionDays ?? null);
    rows.push({ zone, group, tool, cls: e.class || '-', owner: e.owner || '-', ret });
  };
  const reg = readJ(P.reg, { entries: {} });
  for (const [k, e] of Object.entries(reg.entries || {})) add(k, e || {});
  let files = [];
  try { files = fs.readdirSync(P.ws).filter((f) => f.endsWith('.json')).sort(); } catch { /* none */ }
  for (const f of files) {
    const j = readJ(path.join(P.ws, f), {});
    const w = j.workspace || f.slice(0, -5);
    for (const [t, e] of Object.entries(j.entries || {})) add(`workspaces/${w}/${t}`, { zone: 'workspaces', workspace: w, tool: t, ...e });
  }
  return rows;
}

function buildTree(P) {
  const rows = collect(P);
  const zones = [...new Set([...ZONES, 'external', 'legacy'])];
  const out = [];
  for (const z of zones) {
    const zr = rows.filter((r) => r.zone === z);
    if (!zr.length) continue;
    out.push(`${z}/`);
    for (const g of [...new Set(zr.map((r) => r.group))].sort()) {
      out.push(`  ${g}/`);
      for (const r of zr.filter((x) => x.group === g).sort((a, b) => a.tool.localeCompare(b.tool))) {
        out.push(`    ${r.tool}  [${r.cls}] owner=${r.owner} retention=${r.ret === null ? 'giu' : r.ret + 'd'}`);
      }
    }
  }
  return out;
}

export function treeCmd(args = [], ctx = {}) {
  const P = paths(ctx);
  const { flags } = parseArgs(args);
  const tree = buildTree(P);
  const lines = tree.length ? tree : ['(registry rong)'];
  if (!flags['write-readme']) return { code: 0, lines };
  const block = `${TREE_START}\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n${TREE_END}`;
  let txt = '';
  try { txt = fs.readFileSync(P.readme, 'utf8'); } catch { /* new */ }
  const a = txt.indexOf(TREE_START), b = txt.indexOf(TREE_END);
  const next = a >= 0 && b > a ? txt.slice(0, a) + block + txt.slice(b + TREE_END.length)
    : `${txt.replace(/\s*$/, '')}\n\n## Cay du lieu (sinh tu registry)\n${block}\n`;
  writeAtomic(P.readme, next);
  return { code: 0, lines: [...lines, `da ghi ${P.readme}`] };
}
