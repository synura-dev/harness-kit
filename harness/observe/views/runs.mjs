// harness/observe/views/runs.mjs - doc-only: runs/*.{json,log} (dispatch-worker ghi; .md cu van doc duoc neu con). Usage: runs.mjs list [--limit N=20] | show <ten> [--raw] [--max-bytes N] [--timeout-s N=10]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { samePath } from '../../core/io/paths.mjs';
import { dataReadRoots } from '../../core/registry/data-registry.mjs';
import { parseCommon, emit } from '../../core/io/out.mjs';

const USAGE = 'usage: runs.mjs list [--limit N] | show <ten> [--raw] [--max-bytes N] [--timeout-s N] [--json]';
const EXT = /\.(md|json|log)$/;
const HEAD = 4096;
function readHead(f, n) { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(n); const r = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, r); } finally { fs.closeSync(fd); } }
const firstOf = (text) => (text.split(/\r?\n/).find((l) => l.trim()) || '').slice(0, 120);
const firstLine = (f) => { try { return firstOf(readHead(f, HEAD).toString('utf8')); } catch { return ''; } };

export function run(argv, { dir, emitOpts = {} } = {}) {
  const dirs = dir ? [dir] : dataReadRoots('runs');
  const c = parseCommon(argv);
  const li = c.rest.indexOf('--limit');
  let limit = 20;
  if (li >= 0) { limit = Number(c.rest[li + 1]) || 20; c.rest.splice(li, 2); }
  const [cmd, name] = c.rest;
  const o = { json: c.json, raw: c.raw, maxBytes: c.maxBytes || 65536, ...emitOpts };
  const t0 = Date.now(), tmo = (c.timeoutS || 10) * 1000;
  if (cmd === 'list') {
    const names = [];
    const owner = {};
    for (const d of dirs) { try { for (const n of fs.readdirSync(d).filter((x) => EXT.test(x))) if (!(n in owner)) { owner[n] = d; names.push(n); } } catch {} }
    let truncated = null;
    const rows = [];
    for (const n of names) {
      if (Date.now() - t0 > tmo) { truncated = 'timeout'; break; }
      let m = 0; try { m = fs.statSync(path.join(owner[n], n)).mtimeMs; } catch {}
      rows.push({ name: n, mtime: new Date(m).toISOString(), mtimeMs: m });
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const cut = rows.slice(0, limit);
    if (!truncated && rows.length > limit) truncated = `limit ${limit}/${rows.length}`;
    for (const r of cut) {
      if (Date.now() - t0 > tmo) { truncated = truncated || 'timeout'; break; }
      r.first = firstLine(path.join(owner[r.name], r.name));
    }
    const summary = cut.map((r) => `${r.name}  ${r.mtime}  ${r.first}`).join('\n') || '(no runs)';
    return { code: 0, ...emit({ summary, data: cut, truncated }, o) };
  }
  if (cmd === 'show' && name) {
    const base = path.basename(name);
    const f = dirs.flatMap((d) => [base, base + '.json', base + '.log', base + '.md'].map((x) => path.join(d, x))).find((x) => EXT.test(x) && fs.existsSync(x) && fs.statSync(x).isFile()) || path.join(dirs[0] || '.', base + '.json');
    if (!fs.existsSync(f)) { (emitOpts.err || console.error)(`runs: khong thay ${name}`); return { code: 1 }; }
    let st, buf;
    try {
      st = fs.statSync(f);
      if (!st.isFile()) throw Object.assign(new Error('not file'), { code: 'EISDIR' });
      if (Date.now() - t0 > tmo) return { code: 0, ...emit({ summary: '(timeout)', data: { name: path.basename(f) }, raw: '', truncated: 'timeout' }, o) };
      buf = readHead(f, Math.min(st.size, o.maxBytes + 4));
    } catch { (emitOpts.err || console.error)(`runs: khong thay ${name}`); return { code: 1 }; }
    const text = buf.toString('utf8');
    const summary = `${path.basename(f)}  ${st.mtime.toISOString()}  ${st.size}B\n${firstOf(text)}`;
    return { code: 0, ...emit({ summary, data: { name: path.basename(f), size: st.size, mtime: st.mtime.toISOString(), first: firstOf(text) }, raw: text, truncated: st.size > buf.length ? `max-bytes ${o.maxBytes}` : null }, o) };
  }
  (emitOpts.err || console.error)(USAGE);
  return { code: 2 };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exit(run(process.argv.slice(2)).code);
