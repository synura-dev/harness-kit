// Lenh `data tree` (cay du lieu sinh tu registry). Tra {code, lines}.
// ctx: { dataDir, hubRoot, registryFile?, wsDir?, readmeFile?, callerDir?, resolveProject?(id)->{path}|null, ownerRoots?: string[] (rel hub; mac dinh ['.']) }
import fs from 'node:fs';
import path from 'node:path';
import { ZONES, CLASSES, CLASS_DEFAULTS, readJ as readJson, writeAtomic, loadDataRegistry } from '../../core/registry/data-registry.mjs';
import { workspaceRoot } from '../../core/io/paths.mjs';

export const TREE_START = '<!-- data-tree:start -->';
export const TREE_END = '<!-- data-tree:end -->';

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
function collect(P, ctx = {}) {
  const rows = [];
  const add = (key, e, group) => {
    const zone = e.domain || e.zone || 'legacy';
    const segs = key.split('/');
    const g = group || e.workspace || (e.zone && segs.length === 3 ? segs[1] : segs[0]);
    const tool = e.tool || (segs.length === 3 ? segs[2] : '-');
    const ret = e.retentionDays !== undefined ? e.retentionDays : (CLASS_DEFAULTS[e.class]?.retentionDays ?? null);
    rows.push({ zone, group: g, tool, cls: e.class || '-', owner: e.owner || '-', ret, derived: !!e.derived });
  };
  const env = { ...process.env, HUB_DIR: P.hub };
  if (ctx.dataDir) env.HUB_DATA_DIR = ctx.dataDir;
  const reg = loadDataRegistry({ registryFile: ctx.registryFile, workspacesDir: ctx.wsDir, env, noCache: true });
  for (const [k, e] of Object.entries(reg.entries || {})) add(k, e || {});
  for (const [k, e] of Object.entries(reg.patterns || {})) add(`workspaces/*/${e.tool || k}`, { zone: 'workspaces', ...e, tool: e.tool || k }, '*');
  return rows;
}

function buildTree(P, ctx) {
  const rows = collect(P, ctx);
  const zones = [...new Set([...ZONES, 'external', 'legacy'])];
  const out = [];
  for (const z of zones) {
    const zr = rows.filter((r) => r.zone === z);
    if (!zr.length) continue;
    out.push(`${z}/`);
    for (const g of [...new Set(zr.map((r) => r.group))].sort()) {
      out.push(`  ${g}/`);
      for (const r of zr.filter((x) => x.group === g).sort((a, b) => a.tool.localeCompare(b.tool))) {
        out.push(`    ${r.tool}  [${r.cls}] owner=${r.owner} retention=${r.ret === null ? 'giu' : r.ret + 'd'}${r.derived ? ' (derived)' : ''}`);
      }
    }
  }
  return out;
}

export function treeCmd(args = [], ctx = {}) {
  const P = paths(ctx);
  const { flags } = parseArgs(args);
  const tree = buildTree(P, ctx);
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
