// node harness/cli/harness.mjs                -> index nhom theo vung (observe/constrain/knowledge/evolve + build/cli/legacy), dong "domain - mo ta - lenh con"
// node harness/cli/harness.mjs --flat         -> index phang nhu cu (<=25 domain)
// node harness/cli/harness.mjs <nhom> | --group <nhom> -> domain cua nhom (domain trung ten nhom: domain uu tien)
// node harness/cli/harness.mjs <domain>       -> index cua domain do
// node harness/cli/harness.mjs <domain> <args> (hoac "<domain> run") -> spawn CLI cu
// extRoots (config workspace): them manifest ngoai harness/ (vd <root>/<ten>/manifest.json) -> nhom "Ngoai: <root>/"; spawn, khong import; domain trung harness: harness thang + bao loi.
// Registry = manifest.json cua tung extension (harness/{cli,plugins,tools,hooks}/.../manifest.json): script/desc/cmds/default. Loi/thieu => fallback toi thieu. Hook khong goi qua shim.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit } from '../core/io/out.mjs';
import { loadExternals, runExternal, blockExternal } from '../core/ext/ext-host.mjs';
import { listRegistered, isExtensionTrusted } from './commands/ext-registry.mjs';
import { loadHarnessRegistry, translateAlias } from '../core/registry/plugin-registry.mjs';
import { GROUP_ZONES } from '../core/config/contract.mjs';
import { loadConfig } from '../core/config/config.mjs';
import { guardWrite } from '../core/io/storage.mjs';
import { loadDataRegistry, ZONES } from '../core/registry/data-registry.mjs';
import { dataRoot, ensureDataIgnore, hkerrLine, workspaceRoot } from '../core/io/paths.mjs';
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
      // extRoots (config workspace): quet manifest ngoai harness/; domain o do chi SPAWN (khong import). Loi config -> khong co extRoots.
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
const GROUP_LABELS = { observe: 'Quan sat', constrain: 'Han che', knowledge: 'Tri thuc', evolve: 'Tien hoa', build: 'Build', cli: 'CLI', legacy: 'Cu (plugins/tools/hooks)' };
const MAIN_GROUPS = ['observe', 'constrain', 'knowledge', 'evolve']; // luon in tieu de, ke ca rong
const LEGACY_ZONES = new Set(['plugins', 'tools', 'hooks']);
export const INDEX_MAX_LINES = 40;

export function groupOf(d) {
  if (d.ext) return String(d.ext).split('/')[0]; // domain tu extRoot (vd <root>/): nhom rieng theo goc
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
    L.push(extG ? `== ${GROUP_LABELS[g] || `Ngoai: ${g}/`} ==` : `== ${GROUP_LABELS[g] || g} (${g}) ==`);
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

// Hop dong ext: nhan argv nhu nguoi dung go (tru domain); parseCommon cua ext la noi parse duy nhat. Cong chi loai co rieng cua no.
export const GATEWAY_ONLY_FLAGS = ['--timeout-s'];
export function stripFlags(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (names.includes(a)) { i++; continue; }
    if (names.some((n) => a.startsWith(n + '='))) continue;
    out.push(a);
  }
  return out;
}
function externalArgv(argv, domain, typed, rest0) {
  if (domain !== typed) return rest0; // alias: lenh con da dich, giu nhu cu
  const idx = argv.indexOf(domain);
  if (idx < 0) return rest0;
  const pre = stripFlags(stripFlags(argv.slice(0, idx), GATEWAY_ONLY_FLAGS), ['--group']).filter((x) => x !== '--flat');
  return [...pre, ...stripFlags(argv.slice(idx + 1), GATEWAY_ONLY_FLAGS)];
}
const available = (root, d) => !!(d.script && fs.existsSync(path.resolve(root, d.script)));

// "domain - mo ta - lenh con"; khong co CLI => (chua co). Toi da 25 dong.
function indexLines(root, doms, only, max = 25) {
  return Object.entries(doms).filter(([k]) => !only || k === only).slice(0, max)
    .map(([k, d]) => [k, d.desc || '-', available(root, d) ? d.cmds || '(khong co lenh con)' : '(chua co)'].concat(d.default === 'run' && available(root, d) ? ['(mac dinh: chay)'] : []).join(' - ') + (d.aliases && d.aliases.length ? ` [alias: ${d.aliases.join(', ')}]` : ''));
}

// Khoang cach chinh sua (Levenshtein), chuoi ngan.
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Domain la -> hop dong loi (HKERR) + help rut gon (<= 10 dong). Thu muc <ws>/<hub|extRoot>/<domain>/manifest.json co ma chua dang ky
 * -> goi y `harness ext register <rel>`; nguoc lai goi y domain gan ten nhat. Khong nem. -> { text, stderr }.
 */
export function unknownDomain(domain, doms, aliases = {}, ws = workspaceRoot(), json = false) {
  let roots = ['hub'];
  try { const x = loadConfig('workspace', { root: ws }).config.extRoots; if (Array.isArray(x)) roots = [...new Set([...roots, ...x.filter((s) => typeof s === 'string')])]; } catch { /* bo qua */ }
  let extRel = null;
  for (const r of roots) {
    try { const dir = path.resolve(ws, r, domain); if (fs.existsSync(path.join(dir, 'manifest.json'))) { extRel = path.relative(ws, dir).split(path.sep).join('/'); break; } } catch { /* bo qua */ }
  }
  const names = [...new Set([...Object.keys(doms), ...Object.keys(aliases || {}), ...groupOrder(doms)])];
  let near = null, best = Infinity;
  for (const n of names) { const d = editDistance(domain.toLowerCase(), n.toLowerCase()); if (d < best) { best = d; near = n; } }
  if (best > Math.max(2, Math.floor(domain.length / 3))) near = null;
  const e = extRel
    ? { code: 'HK_EXT_UNREGISTERED', cause: `${extRel}/manifest.json co nhung ext chua dang ky cho workspace nay`, fix_command: `harness ext register ${extRel}`, next_step: `kiem code ${extRel}/ roi dang ky (xac nhan TTY), sau do chay lai: harness ${domain}` }
    : { code: 'HK_UNKNOWN_DOMAIN', cause: `khong co domain/alias/nhom ten ${domain}`, fix_command: near ? `harness ${near}` : 'harness --help', next_step: near ? `co phai y la "${near}"? Xem tat ca: harness --help` : 'xem danh sach domain: harness --help' };
  const line = hkerrLine(e.code, e.cause, { severity: 'error', fix_command: e.fix_command, next_step: e.next_step, safe: true, source: 'harness-cli' });
  const list = Object.keys(doms).join(', ');
  const lines = [
    `domain la: ${domain}`,
    extRel ? `Ext ${extRel} chua dang ky. Chay: ${e.fix_command}` : near ? `Co phai y la: ${e.fix_command} ?` : 'Khong co domain gan ten.',
    `Domain co san: ${list.length > 160 ? list.slice(0, 157) + '...' : list}`,
    'Xem day du: harness --help',
  ];
  const text = json ? JSON.stringify({ error: { code: e.code, cause: e.cause, fix_command: e.fix_command, next_step: e.next_step, safe: true } }, null, 2) : lines.join('\n');
  return { text, stderr: line + '\n', ...e };
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
  const typedDomain = domain;
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
  const extArgv = externalArgv(argv, domain, typedDomain, rest0);
  const known = domain && Object.hasOwn(doms, domain) ? doms[domain] : null;
  // External (ctx + tien trinh con, song song extRoots). Chi khi domain khong phai cua core (core thang). opts.externals = [{id, root}] (tam thoi, chua co ext register).
  if (!known && domain && !group) {
    // opts.externals (tuong minh) bo qua dang ky; mac dinh doc lop may qua listRegistered va CHAN neu hash lech/chua duyet.
    // Workspace = goc du an (plugin mode: CLAUDE_PROJECT_DIR), KHONG phai root ma loi: dang ky ext khoa theo workspace (nhu `ext register`).
    const ws = opts.workspace || workspaceRoot();
    const regOpts = { workspace: ws, ...(opts.registry || {}) };
    let list, regErr;
    try { list = opts.externals || listRegistered(regOpts); } catch (e) { list = []; regErr = e; }
    // Dang ky lop may hong: fail-closed (khong chay external nao), bao huong dan; ten nhom van xu ly binh thuong ben duoi.
    if (regErr && !groupOrder(doms).includes(domain)) { const text = `ext ${domain}: CHAN (exit 66): ${String(regErr.message).slice(0, 400)}`; if (!opts.capture) console.error(text); return { code: 66, stdout: '', stderr: `${text}\n`, text, printed: !opts.capture }; }
    const { byDomain, blocked = {} } = list.length ? loadExternals(list, { coreDomains: doms }) : { byDomain: {} };
    if (Object.hasOwn(byDomain, domain)) {
      // Tin cay theo id + root tu dang ky (loadExternals da ep m.id === id dang ky); hash dung cay root se chay.
      if (!opts.externals && !isExtensionTrusted(byDomain[domain].id, { ...regOpts, root: byDomain[domain].root })) { const b = blockExternal(byDomain[domain], domain); return { code: b.code, stdout: b.stdout, stderr: b.stderr }; }
      const r = runExternal(byDomain[domain], domain, extArgv, { timeoutS: opts.timeoutS || c.timeoutS, workspace: regOpts.workspace, json: c.json });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    }
    if (!opts.externals && Object.hasOwn(blocked, domain)) { const b = blockExternal(blocked[domain], domain, blocked[domain].reason); return { code: b.code, stdout: b.stdout, stderr: b.stderr }; }
  }
  // Ten nhom (khong trung domain) -> liet ke domain cua nhom. Domain luon uu tien; nhom trung ten domain dung --group.
  if (!group && domain && !known && !rest0.length && groupOrder(doms).includes(domain)) group = domain;
  if (!group && domain && !known && !domain.startsWith('-')) {
    const u = unknownDomain(domain, doms, aliases, opts.workspace || workspaceRoot(), c.json);
    if (!opts.capture) console.log(u.text); // stderr (HKERR) do main ghi tu r.stderr
    return { code: 2, text: u.text, stderr: u.stderr, printed: !opts.capture };
  }
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
  // External (va ext bi CHAN) tra stdout/stderr da bat (core chay stdio inherit nen rong): phai in ra, khong thi mat output.
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.text && !r.stdout && !r.printed && r.code) console.log(r.text);
  process.exit(r.code);
}
