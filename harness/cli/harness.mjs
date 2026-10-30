// node harness/cli/harness.mjs                -> index nhom theo vung (observe/constrain/knowledge/evolve + build/cli/legacy), dong "domain - mo ta - lenh con"
// node harness/cli/harness.mjs --flat         -> index phang nhu cu (<=25 domain)
// node harness/cli/harness.mjs <nhom> | --group <nhom> -> domain cua nhom (domain trung ten nhom: domain uu tien)
// node harness/cli/harness.mjs <domain>       -> index cua domain do
// node harness/cli/harness.mjs <domain> <args> (hoac "<domain> run") -> spawn CLI cu
// extRoots (config/hub/default.json): them manifest ngoai harness/ (vd hub/<ten>/manifest.json) -> nhom "Hub (hub/)"; spawn, khong import; domain trung harness: harness thang + bao loi.
// Registry = manifest.json cua tung extension (harness/{cli,plugins,tools,hooks}/.../manifest.json): script/desc/cmds/default. Loi/thieu => fallback toi thieu. Hook khong goi qua shim.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit } from '../core/io/out.mjs';
import { loadHarnessRegistry, translateAlias } from '../core/registry/plugin-registry.mjs';
import { GROUP_ZONES } from '../core/config/contract.mjs';
import { loadConfig } from '../core/config/config.mjs';
import { guardWrite } from '../core/io/storage.mjs';
import { loadDataRegistry, ZONES } from '../core/registry/data-registry.mjs';
import { dataRoot, ensureDataIgnore } from '../core/io/paths.mjs';
import { dataPathFor } from '../core/io/storage.mjs';

import { auditRoot } from '../core/audit/audit-write.mjs';
// Fallback toi thieu khi khong doc duoc registry. default: 'run'|'index' (mac dinh index).
const FALLBACK_DOMAINS = {
  doctor: { script: 'harness/cli/commands/doctor.mjs', desc: 'kiem tra moi truong/hook', default: 'run' },
};

// {doms, errors}: errors = loi registry (vd domain trung ten giua 2 manifest -> giu ban dau, bao loi, khong ghi de im lang).
export function loadRegistryInfo(root) {
  const out = Object.create(null);
  let errors = [], aliases = {};
  try {
    const hd = path.join(root, 'harness');
    if (fs.existsSync(hd)) {
      // extRoots (config 'hub'): quet manifest ngoai harness/; domain o do chi SPAWN (khong import). Loi config -> khong co extRoots.
      let extRoots;
      try { extRoots = loadConfig('workspace', { root }).config.extRoots; } catch { /* bo qua */ }
      const reg = loadHarnessRegistry({ harnessDir: hd, hubRoot: root, extRoots });
      errors = reg.errors || [];
      aliases = reg.aliases || {}; // ten cu -> {domain, map}; index chi in domain that (alias ghi kem)
      for (const [dom, file] of Object.entries(reg.domains)) {
        const d = { script: path.relative(root, file).split(path.sep).join('/'), desc: '-' };
        if (reg.ext && reg.ext[dom]) d.ext = reg.ext[dom];
        for (const [k, v] of Object.entries(reg.meta[dom] || {})) if (v !== undefined && !(Array.isArray(v) && !v.length)) d[k] = v;
        out[dom] = d;
      }
    }
  } catch (e) { errors = [`registry: ${e.message}`]; }
  return { doms: Object.keys(out).length ? out : Object.assign(Object.create(null), FALLBACK_DOMAINS), errors, aliases };
}

export function loadDomains(root) { return loadRegistryInfo(root).doms; }

// Nhom = vung (thu muc cap 1 duoi harness/) chua file domain, suy tu duong dan registry; khong hardcode ten domain.
const GROUP_LABELS = { hub: 'Hub (hub/)', observe: 'Quan sat', constrain: 'Han che', knowledge: 'Tri thuc', evolve: 'Tien hoa', build: 'Build', cli: 'CLI', legacy: 'Cu (plugins/tools/hooks)' };
const MAIN_GROUPS = ['observe', 'constrain', 'knowledge', 'evolve']; // luon in tieu de, ke ca rong
const LEGACY_ZONES = new Set(['plugins', 'tools', 'hooks']);
export const INDEX_MAX_LINES = 40;

export function groupOf(d) {
  if (d.ext) return String(d.ext).split('/')[0]; // domain tu extRoot (vd hub/): nhom rieng theo goc
  const seg = String(d.script || '').split('/');
  const z = seg[0] === 'harness' ? seg[1] : null;
  if (!z) return 'legacy';
  return LEGACY_ZONES.has(z) ? 'legacy' : z;
}

function groupOrder(doms) {
  const seen = [...MAIN_GROUPS, ...GROUP_ZONES.filter((z) => !MAIN_GROUPS.includes(z)), 'cli', 'legacy'];
  for (const d of Object.values(doms)) { const g = groupOf(d); if (!seen.includes(g)) seen.push(g); }
  return seen;
}

// Index nhom: tieu de nhom + dong domain (dinh dang nhu --flat, khong thut le). Toi da INDEX_MAX_LINES dong.
function groupedLines(root, doms, errors, only) {
  const L = [];
  for (const g of groupOrder(doms)) {
    if (only && g !== only) continue;
    const ent = Object.entries(doms).filter(([, d]) => groupOf(d) === g);
    if (!ent.length && !(MAIN_GROUPS.includes(g) || g === only)) continue;
    const extG = ent.length && ent.every(([, d]) => d.ext);
    L.push(extG ? `== ${GROUP_LABELS[g] || `${g}/`} ==` : `== ${GROUP_LABELS[g] || g} (${g}) ==`);
    if (!ent.length) L.push('(chua co domain)');
    L.push(...indexLines(root, Object.fromEntries(ent), null, Infinity));
  }
  const errs = errors.slice(0, 3).map((e) => `! registry: ${e}`);
  if (errors.length > 3) errs.push(`! registry: ... +${errors.length - 3} loi`);
  const room = INDEX_MAX_LINES - errs.length;
  const body = L.length > room ? L.slice(0, room - 1).concat(`... +${L.length - room + 1} dong (dung --flat hoac <domain>)`) : L;
  return body.concat(errs);
}

export const DEFAULT_TIMEOUT_S = 120;

const available = (root, d) => !!(d.script && fs.existsSync(path.resolve(root, d.script)));

// "domain - mo ta - lenh con"; khong co CLI => (chua co). Toi da 25 dong.
function indexLines(root, doms, only, max = 25) {
  return Object.entries(doms).filter(([k]) => !only || k === only).slice(0, max)
    .map(([k, d]) => [k, d.desc || '-', available(root, d) ? d.cmds || '(khong co lenh con)' : '(chua co)'].concat(d.default === 'run' && available(root, d) ? ['(mac dinh: chay)'] : []).join(' - ') + (d.aliases && d.aliases.length ? ` [alias: ${d.aliases.join(', ')}]` : ''));
}

export function run(argv, root, opts = {}) {
  const c = parseCommon(argv);
  // Co cua cong chi nhan khi dung TRUOC domain (sau domain la tham so cua CLI con, chuyen nguyen).
  let flat = false, group = null;
  while (c.rest.length) {
    const a = c.rest[0];
    if (a === '--flat') { flat = true; c.rest.shift(); }
    else if (a === '--group') { c.rest.shift(); group = c.rest.shift() || null; }
    else if (a.startsWith('--group=')) { group = a.slice(8) || null; c.rest.shift(); }
    else break;
  }
  let [domain, ...rest0] = c.rest;
  const { doms, errors, aliases } = loadRegistryInfo(root);
  // Alias (manifest `aliases`): ten cu -> domain dich; co tham so thi dich lenh con theo aliasMap. Domain that luon thang (alias trung domain that bi registry bo + bao loi).
  if (domain && !group && !Object.hasOwn(doms, domain) && Object.hasOwn(aliases, domain)) {
    const al = aliases[domain];
    if (rest0.length) {
      const t = translateAlias(al.map, rest0);
      if (t.error) { const text = `${domain}: ${t.error}`; if (!opts.capture) console.error(text); return { code: 2, text, printed: !opts.capture }; }
      rest0 = t.args;
    } else if (al.map && Array.isArray(al.map.onEmpty)) rest0 = [...al.map.onEmpty]; // alias khong tham so: aliasMap.onEmpty (vd doctor/install chay mac dinh)
    domain = al.domain;
  }
  const known = domain && Object.hasOwn(doms, domain) ? doms[domain] : null;
  // Ten nhom (khong trung domain) -> liet ke domain cua nhom. Domain luon uu tien; nhom trung ten domain dung --group.
  if (!group && domain && !known && !rest0.length && groupOrder(doms).includes(domain)) group = domain;
  const autoRun = known && !rest0.length && known.default === 'run' && available(root, known);
  if (group || !known || (!rest0.length && !autoRun)) {
    const inGroup = group ? groupOrder(doms).includes(group) : false;
    const bad = group ? !inGroup : domain && domain !== '--help' && !known;
    const pick = ([k, d]) => (group ? groupOf(d) === group : !known || k === domain);
    const lines = known && !group ? indexLines(root, doms, domain)
      : flat ? indexLines(root, doms, null)
      : groupedLines(root, doms, errors, inGroup ? group : null);
    const data = Object.fromEntries(Object.entries(doms).filter(pick).map(([k, d]) => [k, { desc: d.desc || null, cmds: d.cmds || null, default: d.default === 'run' ? 'run' : 'index', available: available(root, d), group: groupOf(d) }]));
    const head = bad ? (group ? `nhom la: ${group}\n` : `domain la: ${domain}\n`) : '';
    const o = emit({ summary: head + lines.join('\n'), data }, { ...c, write: !opts.capture });
    return { code: bad ? 2 : 0, text: o.text, printed: !opts.capture };
  }
  const d = known;
  if (!d.script) return { code: 2, text: `${domain}: chua co CLI` };
  const script = path.resolve(root, d.script);
  if (!fs.existsSync(script)) return { code: 2, text: `script khong ton tai: ${d.script}` };
  const rest = rest0[0] === 'run' ? rest0.slice(1) : rest0;
  const args = [...rest];
  if (c.json) args.push('--json');
  if (c.raw) args.push('--raw');
  if (c.maxBytes) args.push('--max-bytes', String(c.maxBytes));
  if (c.timeoutS) args.push('--timeout-s', String(c.timeoutS));
  const tmo = ((opts.timeoutS || c.timeoutS || DEFAULT_TIMEOUT_S) + 5) * 1000;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', timeout: tmo, env: { ...process.env, HARNESS_GATEWAY: '1' } });
  const code = r.error ? 2 : (r.status ?? 1);
  logGateway({ domain, cmd: rest[0] || null, args: rest.slice(1), exit: code, ms: Date.now() - t0, dataWarn: unregisteredDirs() });
  if (r.error) return { code: 2, text: r.error.code === 'ETIMEDOUT' ? 'truncated: timeout' : String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

// Thu muc cap 1 la trong data/ (ngoai registry, zone, reserved): canh bao 1 dong stderr. Timeout 200ms, fail-open.
export function unregisteredDirs(opts = {}) {
  try {
    const t0 = Date.now();
    const reg = loadDataRegistry(opts);
    if (reg.failed) return null;
    const known = new Set([...ZONES, ...reg.reserved, ...Object.keys(reg.entries).map((k) => String(k).split('/')[0]), ...Object.values(reg.entries).map((e) => String(e.path || '').split('/')[0]).filter(Boolean)]);
    const odd = [];
    for (const ent of fs.readdirSync(dataRoot(undefined, opts), { withFileTypes: true })) {
      if (Date.now() - t0 > 200) break;
      if (ent.isDirectory() && !ent.name.startsWith('.') && !known.has(ent.name)) odd.push(ent.name);
    }
    if (!odd.length) return null;
    const list = odd.slice(0, 5).join(',');
    const wf = path.join(dataRoot(undefined, opts), '.state', 'gateway-warned.json');
    let w = {}; try { w = JSON.parse(fs.readFileSync(wf, 'utf8')) || {}; } catch {}
    const day = new Date().toISOString().slice(0, 10);
    const fresh = odd.filter((n) => w[n] !== day);
    if (fresh.length) {
      process.stderr.write(`data-warn rule=unregistered path=${fresh.slice(0, 5).join(',')} key=${fresh[0]} detail="thu muc cap 1 la trong data/ (${fresh.length})" fix="harness data register <key> --class log"\n`);
      for (const n of fresh) w[n] = day;
      try { fs.mkdirSync(path.dirname(wf), { recursive: true }); const t = `${wf}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(w)); fs.renameSync(t, wf); } catch {}
    }
    return list;
  } catch { return null; }
}

// Log cong: 1 dong JSONL/lenh vao <audit-root>/gateway/date=YYYY-MM-DD/gateway.jsonl. Loi log khong lam hong lenh.
function logGateway(e) {
  try {
    const ts = new Date().toISOString();
    const dir = path.join(auditRoot(), 'gateway', `date=${ts.slice(0, 10)}`); // ton trong HUB_DATA_DIR + registry
    ensureDataIgnore(); fs.mkdirSync(dir, { recursive: true });
    guardWrite(path.join(dir, 'gateway.jsonl')); // chi warn (audit khong enforce)
    const args = e.args.map((a) => String(a).slice(0, 80)).slice(0, 10);
    fs.appendFileSync(path.join(dir, 'gateway.jsonl'), JSON.stringify({ ts, domain: e.domain, cmd: e.cmd, args, session: process.env.CLAUDE_SESSION_ID || null, exit: e.exit, ms: e.ms, ...(e.dataWarn ? { dataWarn: e.dataWarn } : {}) }) + '\n');
  } catch {}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const r = run(process.argv.slice(2), root);
  if (r.text && !r.stdout && !r.printed && r.code) console.log(r.text);
  process.exit(r.code);
}
