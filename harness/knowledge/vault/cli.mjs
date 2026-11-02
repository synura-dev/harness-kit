// harness/knowledge/vault/cli.mjs - domain `knowledge` (vault tri thuc). Goi qua: node harness/cli/harness.mjs knowledge <lenh> ...
// put  --id <kebab> --kind rule|fact|ref|decision|lesson [--scope global|project:<id>|role:<ten>] [--tags a,b] [--links a,b] [--refs a,b]
//      [--source <url|text>] [--quote "<=200"] [--fetched YYYY-MM-DD] [--recheck YYYY-MM-DD | --ttl-days N] [--confidence low|med|high]
//      [--status active|stale|archived] [--body "..." | --body-file f | --stdin] [--from note.md] [--replace] [--dry-run]
// get <id> [--kind k] | links <id> [--format text|json] | query [text] [--kind --scope --tag t (lap) --status s|any --text --stale|--fresh --limit N]
// check [--probe] | prune [--apply]. put: [--probe-json '{"cmd":["node","--version"],"expect":"/^v\d+/","timeoutS":5}'] (hoac `probe:` trong --from).
//  Chung: --root <dir> --json --raw --max-bytes N --timeout-s N.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCommon, emit } from '../../core/io/out.mjs';
import { samePath } from '../../core/io/paths.mjs';
import { normKind } from './schema.mjs';
import { parse } from './frontmatter.mjs';
import { put, get, links, query, context, check, prune, migrate, index } from './vault.mjs';

const BOOL = new Set(['replace', 'dry-run', 'stdin', 'stale', 'fresh', 'apply', 'probe', 'rebuild']);
const MAX_INPUT = 65536;
const USAGE = 'usage: knowledge put --id <id> --kind <k> [...] | get <id> | links <id> [...] | query [text] [...] | context --scope <scope> [...] | index [--rebuild] | check [--probe] | prune [--apply] | migrate [--apply]  (--root <dir>)';

function parseFlags(rest) {
  const f = { _: [], tag: [], scope: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { f._.push(a); continue; }
    let k = a.slice(2), v;
    const eq = k.indexOf('=');
    if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    else if (BOOL.has(k)) v = true;
    else v = rest[++i];
    if (v === undefined) throw new Error(`thieu gia tri cho --${k}`);
    if (k === 'tag' || k === 'tags') f.tag.push(...String(v).split(',').map((x) => x.trim()).filter(Boolean));
    else if (k === 'scope' || k === 'scopes') f.scope.push(...String(v).split(',').map((x) => x.trim()).filter(Boolean));
    else f[k] = v;
  }
  return f;
}

const splitCsv = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
function readInput(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX_INPUT) throw new Error(`file dau vao khong hop le hoac > ${MAX_INPUT} bytes`);
  return fs.readFileSync(file, 'utf8');
}

function buildInput(f) {
  let meta = {}, body = '';
  if (f.from) { const p = parse(readInput(f.from)); if (p.error) throw new Error(`--from: ${p.error}`); meta = { ...p.meta }; body = p.body; }
  const map = { id: 'id', kind: 'kind', status: 'status', confidence: 'confidence', source: 'source', quote: 'quote', fetched: 'fetched', recheck: 'recheck', 'ttl-days': 'ttl_days' };
  for (const [flag, key] of Object.entries(map)) if (f[flag] !== undefined) meta[key] = String(f[flag]);
  if (f.scope.length) meta.scope = f.scope[f.scope.length - 1];
  if (f['probe-json'] !== undefined) { try { meta.probe = JSON.parse(String(f['probe-json'])); } catch { throw new Error('--probe-json khong phai JSON'); } }
  if (f.tags !== undefined) meta.tags = splitCsv(f.tags);
  if (f.tag.length) meta.tags = [...new Set([...(meta.tags || []), ...f.tag])];
  if (f.links !== undefined) meta.links = splitCsv(f.links);
  if (f.refs !== undefined) meta.refs = splitCsv(f.refs);
  if (meta.kind !== undefined) meta.kind = normKind(meta.kind);
  if (f.body !== undefined) body = String(f.body);
  else if (f['body-file']) body = readInput(f['body-file']);
  else if (f.stdin) { const b = fs.readFileSync(0); if (b.length > MAX_INPUT) throw new Error(`stdin > ${MAX_INPUT} bytes`); body = b.toString('utf8'); }
  return { meta, body };
}

export function run(argv, emitOpts = {}) {
  const c = parseCommon(argv);
  const o = { json: c.json, raw: c.raw, maxBytes: c.maxBytes || 65536, ...emitOpts };
  const err = emitOpts.err || console.error;
  let f; try { f = parseFlags(c.rest); } catch (e) { err(`knowledge: ${e.message}`); return { code: 2 }; }
  const [cmd, arg] = f._;
  const base = { root: f.root, now: f.now, timeoutS: c.timeoutS || 10 };
  try {
    if (cmd === 'put') {
      const r = put(buildInput(f), { ...base, replace: !!f.replace, dryRun: !!f['dry-run'] });
      if (!r.ok) { err(`knowledge put: tu choi\n- ${r.errors.join('\n- ')}`); return { code: 1, ...r }; }
      const verb = r.dryRun ? 'dry-run (khong ghi)' : r.created ? 'da tao' : 'da thay';
      const summary = [`${verb}: ${r.file}`, ...r.warnings.map((w) => `canh bao: ${w}`)].join('\n');
      return { code: 0, ...emit({ summary, data: { ok: true, file: r.file, created: r.created, dryRun: r.dryRun, warnings: r.warnings }, raw: r.text }, o) };
    }
    if (cmd === 'get' && arg) {
      const r = get(arg, { ...base, kind: f.kind ? normKind(f.kind) : undefined, maxBytes: o.maxBytes });
      if (!r.ok) { err(`knowledge get: ${r.error}`); return { code: 1 }; }
      return { code: 0, ...emit({ summary: r.text, data: { id: arg, kind: r.kind, file: r.file, meta: r.meta, body: r.body }, raw: r.text, truncated: r.cut ? `max-bytes ${o.maxBytes}` : null }, o) };
    }
    if (cmd === 'links' && arg) {
      if (f.format === 'json') o.json = true;
      const r = links(arg, { ...base, maxBytes: o.maxBytes });
      if (!r.ok) { err(`knowledge links: ${r.error}`); return { code: 1 }; }
      const outLines = r.outgoing.length ? r.outgoing.map((x) => `  - ${x}`).join('\n') : '  (khong co)';
      const inLines = r.incoming.length ? r.incoming.map((x) => `  - ${x}`).join('\n') : '  (khong co)';
      const summary = [`Outgoing (${r.outgoing.length}):`, outLines, `Incoming (${r.incoming.length}):`, inLines].join('\n');
      return { code: 0, ...emit({ summary, data: { id: r.id, outgoing: r.outgoing, incoming: r.incoming }, truncated: r.truncated }, o) };
    }
    if (cmd === 'query') {
      const q = { kind: f.kind ? normKind(f.kind) : undefined, scope: f.scope.length ? f.scope : undefined, tags: f.tag, status: f.status, text: f.text || arg, stale: !!f.stale, fresh: !!f.fresh, limit: Number(f.limit) || 10 };
      const r = query(q, base);
      const lines = r.items.map((x) => `${x.id} [${x.kind}${x.stale ? ',het-han' : ''}] ${x.line}`);
      const more = r.total > r.items.length ? `(${r.items.length}/${r.total}, tang --limit)` : `(${r.total})`;
      const summary = (lines.length ? lines.join('\n') + '\n' : '(khong co)\n') + more;
      return { code: 0, ...emit({ summary, data: { total: r.total, items: r.items }, truncated: r.truncated }, o) };
    }
    if (cmd === 'context') {
      if (!f.scope.length) { err('knowledge context: thieu --scope'); return { code: 2 }; }
      const q = {
        scope: f.scope,
        text: f.text || (arg && !arg.startsWith('--') ? arg : undefined),
        tags: f.tag,
        limit: Number(f.limit) || 5,
        maxChars: Number(f['max-chars']) || 1200,
      };
      const r = context(q, base);
      if (f.format === 'json') o.json = true;
      return { code: 0, ...emit({ summary: r.md || '(khong co tri thuc phu hop)\n', data: { total: r.total, count: r.count, items: r.items }, raw: r.md }, o) };
    }
    if (cmd === 'index') {
      const r = index(base.root, { ...base, rebuild: !!f.rebuild });
      const summary = `da dong bo index: ${r.count} ghi chu (${r.cachedHits} cache, ${r.parsedCount} parse)${r.truncated ? ` (truncated: ${r.truncated})` : ''}`;
      return { code: 0, ...emit({ summary, data: r, truncated: r.truncated }, o) };
    }
    if (cmd === 'check') {
      const r = check({ ...base, probe: !!f.probe });
      const fmt = (x) => `${x.kind}/${x.id}: ${x.msg}`;
      const summary = [`${r.count} ghi chu, ${r.errors.length} loi, ${r.warnings.length} canh bao${r.probe ? `, probe: ${r.probe.ran} chay, ${r.probe.stale.length} stale-probe, ${r.probe.errors.length} loi probe` : ''}`, ...r.errors.slice(0, 20).map((x) => `LOI ${fmt(x)}`), ...r.warnings.slice(0, 15).map((x) => `canh bao ${fmt(x)}`)].join('\n');
      return { code: r.errors.length ? 1 : 0, ...emit({ summary, data: r, truncated: r.truncated }, o) };
    }
    if (cmd === 'prune') {
      const r = prune({ ...base, apply: !!f.apply });
      const head = r.apply ? `da archive ${r.applied.length}/${r.candidates.length}` : `${r.candidates.length} ung vien (dry-run; --apply de chuyen status: archived, khong xoa file)`;
      const summary = [head, ...r.candidates.slice(0, 30).map((x) => `${x.kind}/${x.id} recheck=${x.recheck || '-'} status=${x.status || '-'}`), ...r.failed.map((x) => `LOI ${x.id}: ${x.msg}`)].join('\n');
      return { code: r.failed.length ? 1 : 0, ...emit({ summary, data: r, truncated: r.truncated }, o) };
    }
    if (cmd === 'migrate') {
      const r = migrate({ ...base, apply: !!f.apply });
      const head = r.dryRun
        ? `${r.count} file can di chuyen (dry-run; dung --apply de thuc hien)`
        : `da di chuyen ${r.count} file sang cau truc thu muc moi`;
      const summary = [head, ...r.moved.slice(0, 30).map((x) => `${x.id}: ${x.from} -> ${x.to}`)].join('\n');
      return { code: 0, ...emit({ summary, data: r }, o) };
    }
  } catch (e) { err(`knowledge ${cmd}: ${e.message}`); return { code: 1 }; }
  err(USAGE);
  return { code: 2 };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exit(run(process.argv.slice(2)).code);
