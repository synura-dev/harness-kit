// approval: phan tich lenh xoa (rm/Remove-Item/find -delete/git clean...) de quy qua wrapper/shell. Chi doc fs de dem glob.
import fs from 'node:fs';
import path from 'node:path';
import { split, base, restOf, shellCommand, decodePs } from './parse.mjs';

export const RANK = { none: 0, ask: 1, deny: 2 };

/** Mo rong glob 1 cap (khong de quy) theo cwd. -> so file | null (khong xac dinh). */
function expandCount(t, cwd, mode, dc) {
  if (!cwd) return null;
  const v = t.v.replace(/\\/g, '/');
  const i = v.lastIndexOf('/');
  const dir = i >= 0 ? v.slice(0, i) || '/' : '.';
  const pat = v.slice(i + 1);
  if (/[*?[]/.test(dir) || !pat) return null;
  let re = '^';
  for (let k = 0; k < pat.length; k++) {
    const c = pat[k];
    if (c === '*') re += '.*'; else if (c === '?') re += '.';
    else if (c === '[') { const e = pat.indexOf(']', k + 1); if (e < 0) return null; re += '[' + pat.slice(k + 1, e).replace(/^!/, '^').replace(/[\\\]]/g, '\\$&') + ']'; k = e; }
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  let m; try { m = new RegExp(re + '$', mode === 'ps' ? 'i' : ''); } catch { return null; }
  let names;
  try {
    const d = fs.opendirSync(path.resolve(cwd, dir)); names = [];
    try { for (let e; (e = d.readSync()) !== null;) { names.push(e.name); if (names.length > dc.maxDirEntries) return null; } } finally { d.closeSync(); }
  } catch { return 1; } // thu muc khong ton tai: shell giu nguyen chu -> toi da 1 muc
  const n = names.filter((x) => m.test(x) && (mode === 'ps' || !x.startsWith('.') || pat.startsWith('.'))).length;
  return n || 1;
}

const PS_VAL = ['-path', '-literalpath', '-pspath', '-lp'];
const PS_INDET = ['-include', '-exclude', '-filter'];
const PS_ARGS = ['-erroraction', '-ea', '-warningaction', '-wa', '-informationaction', '-credential', '-stream', '-errorvariable', '-ev', '-outvariable', '-ov'];
const psMatch = (flag, list, min = 3) => { const f = flag.split(':')[0].toLowerCase(); return f.length >= min && list.some((x) => x.startsWith(f)); };

/** Phan tich xoa cho 1 doan lenh. -> {tier, id, why} | null */
function analyzeDelete(args, kind, ctx) {
  const { mode, cwd, dc } = ctx;
  let recursive = false, unknown = false, count = 0, ended = false;
  const ops = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i], v = t.v;
    if (!ended && v === '--' && kind !== 'ps') { ended = true; continue; }
    if (!ended && kind === 'cmd' && /^\/[a-z](:\S*)?$/i.test(v)) { if (/^\/s/i.test(v)) recursive = true; continue; }
    if (!ended && v.startsWith('-') && v.length > 1) {
      const low = v.toLowerCase();
      if (kind === 'ps') {
        const f = low.split(':')[0];
        if (f.length >= 2 && '-recurse'.startsWith(f)) recursive = true;
        else if (/^-[a-z]*r[a-z]*$/.test(f) && f.length <= 5 && !'-force'.startsWith(f) && !'-erroraction'.startsWith(f)) recursive = true; // rm -rf go nham trong PowerShell
        else if (psMatch(f, PS_VAL, 2) && !f.includes(':')) { if (args[i + 1]) ops.push(args[++i]); }
        else if (psMatch(f, PS_INDET)) { unknown = true; if (!low.includes(':')) i++; }
        else if (psMatch(f, PS_ARGS, 2) && !low.includes(':')) i++;
      } else if (low === '--cached' && ctx.git) return null; // git rm --cached: chi go khoi index
      else if (low.startsWith('--') ? low.length >= 3 && '--recursive'.startsWith(low) : /^-[a-z]*r[a-z]*$/.test(low)) recursive = true; // GNU nhan moi tien to: --r/--rec/--recursive
      continue;
    }
    ops.push(t);
  }
  if (ctx.always) recursive = true;
  if (recursive) return { tier: 'deny', id: 'recursive-delete', why: 'xoa thu muc/de quy (khong dem duoc so file)' };
  if (!ops.length) return ctx.piped ? { tier: 'deny', id: 'pipe-delete', why: 'xoa theo danh sach tu pipe (khong dem duoc)' } : null;
  for (const t of ops) {
    if (t.dyn || t.brace) { unknown = true; continue; }
    if (t.glob) { const n = expandCount(t, cwd, mode, dc); if (n === null) unknown = true; else count += n; continue; }
    count++;
  }
  if (count >= dc.threshold) return { tier: 'deny', id: 'mass-delete', why: `xoa ${count} file (>= ${dc.threshold})` };
  if (unknown) { const tier = RANK[dc.unknownCount] !== undefined ? dc.unknownCount : 'ask'; return tier === 'none' ? null : { tier, id: 'delete-unknown-count', why: 'khong dem duoc so file bi xoa' }; }
  return null;
}

/** rmdir (bash) chi xoa thu muc RONG -> 1 thu muc: vo hai. -p/--parents (moi tien to) hoac nhieu/khong dem duoc thu muc -> ask. */
function rmdirHit(args) {
  let parents = false, n = 0, unk = false, ended = false;
  for (const t of args) {
    const v = t.v.toLowerCase();
    if (!ended && v === '--') { ended = true; continue; }
    if (!ended && v.startsWith('--')) { if (v.length >= 3 && '--parents'.startsWith(v)) parents = true; continue; }
    if (!ended && /^-[a-z]+$/.test(v)) { if (v.includes('p')) parents = true; continue; }
    n++; if (t.glob || t.dyn || t.brace) unk = true;
  }
  return parents || n > 1 || unk ? { tier: 'ask', id: 'rmdir-multi', why: 'rmdir -p/nhieu thu muc (chi xoa thu muc rong - vo hai neu rong, van can duyet)' } : null;
}

const SSH_OPTS = new Set(['-p', '-i', '-l', '-o', '-f', '-j', '-r', '-d', '-b', '-c', '-e', '-m', '-O', '-q', '-s', '-w', '-B', '-F', '-J', '-L', '-R', '-D', '-E', '-S', '-W', '-Q', '-I']);

// Wrapper: co nhan gia tri (bo qua 2 token), co nhan CHUOI LENH (quet de quy), so doi so vi tri truoc lenh.
const WRAP_VAL = { sudo: ['-u', '-g', '-p', '-C', '-D', '-r', '-t', '-U', '-T'], doas: ['-u', '-C'], env: ['-u', '-C', '--unset', '--chdir'], nice: ['-n', '--adjustment'], ionice: ['-c', '-n', '-p'], time: ['-o', '-f', '--output', '--format'], timeout: ['-s', '-k', '--signal', '--kill-after'], stdbuf: ['-i', '-o', '-e'], npx: ['-p', '--package'], bunx: ['-p', '--package'], pnpx: ['-p', '--package'], xargs: ['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--arg-file', '--eof', '--process-slot-var'] };
const WRAP_CMD = { env: ['-S', '--split-string'], npx: ['-c', '--call'], pnpx: ['-c', '--call'] };
const WRAP_POS = { timeout: 1 };

/** Duyet cac doan lenh, de quy vao $(..)/`..` trong nhay kep, sh -c, pwsh, cmd /c, wsl, ssh, eval/iex, env -S, xargs/find -exec sh -c (sau <= maxDepth).
 * extra: nhan lenh -EncodedCommand da giai ma (evaluate chay du luat tren do). inX: dang trong xargs/find -exec. -> [hit] */
export function scanDeletes(cmd, mode, cwd, dc, depth, extra, inX) {
  const hits = [];
  if (depth > dc.maxDepth) return [{ tier: dc.unknownCount === 'deny' ? 'deny' : 'ask', id: 'delete-unknown-count', why: 'long lenh qua sau' }];
  const segs = split(cmd, mode);
  const sub = (s, m, x = inX) => { const h = scanDeletes(s, m, cwd, dc, depth + 1, extra, x); hits.push(...h); return h; };
  for (const s of segs.subs) sub(s, mode);
  for (const seg of segs) {
    const a = seg.tokens; let k = 0; let xargs = inX;
    while (k < a.length) {
      const v = a[k].v; const b = base(v);
      if (/^\w+=/.test(v)) { k++; continue; }
      if (b === 'eval' || (mode === 'ps' && (b === 'iex' || b === 'invoke-expression'))) { sub(restOf(a, k + 1), mode); k = a.length; break; }
      if (b === 'xargs' || dc.wrappers.includes(b)) {
        if (b === 'xargs') xargs = true;
        const vals = WRAP_VAL[b] || [], cmds = WRAP_CMD[b] || []; let pos = WRAP_POS[b] || 0; k++;
        while (k < a.length) {
          const f = a[k].v;
          if (cmds.includes(f)) { sub(restOf(a, k + 1), mode, xargs); k = a.length; break; }
          if (f.length > 1 && f.startsWith('-')) { k += vals.includes(f) ? 2 : 1; continue; }
          if (/^\w+=/.test(f)) { k++; continue; }
          if (pos > 0) { pos--; k++; continue; }
          break;
        }
        continue;
      }
      if (mode === 'ps' && (v === '.' || v === '&')) { k++; continue; }
      break;
    }
    if (k >= a.length) continue;
    const name = base(a[k].v); const args = a.slice(k + 1);
    const ctx = { mode, cwd, dc, piped: seg.piped || xargs };
    if (dc.shells.includes(name)) {
      const s = shellCommand(name, args);
      if (!s) continue;
      if (s.stdin) { if (seg.piped) hits.push({ tier: 'ask', id: 'pipe-shell', why: 'lenh dua vao shell qua pipe (khong doc duoc)' }); continue; }
      if (s.encoded !== undefined) {
        hits.push({ tier: 'ask', id: 'encoded-command', why: 'lenh ma hoa (-EncodedCommand)' });
        const d = decodePs(s.encoded); if (d && extra.length < 4) extra.push(d);
        continue;
      }
      sub(s.cmd, s.mode, xargs);
      continue;
    }
    if (name === 'ssh') {
      let j = 0; while (j < args.length && args[j].v.startsWith('-')) { j += SSH_OPTS.has(args[j].v) ? 2 : 1; }
      if (j + 1 < args.length) sub(args.slice(j + 1).map((t) => t.v).join(' '), 'bash');
      continue;
    }
    if (name === 'find') {
      const vs = args.map((t) => t.v.toLowerCase());
      const ex = vs.findIndex((x) => x === '-exec' || x === '-execdir' || x === '-ok');
      const xn = base(vs[ex + 1] || '');
      const viaShell = () => { const s = shellCommand(xn, args.slice(ex + 2)); return !!(s && s.cmd && scanDeletes(s.cmd, s.mode, cwd, dc, depth + 1, extra, true).length); };
      if (vs.includes('-delete') || (ex >= 0 && ([...dc.posix, ...dc.alwaysRecursive].includes(xn) || (dc.shells.includes(xn) && viaShell())))) hits.push({ tier: 'deny', id: 'find-delete', why: 'find -delete/-exec rm (khong dem duoc)' });
      continue;
    }
    if (name === 'git') {
      let j = 0; while (j < args.length && args[j].v.startsWith('-')) { j += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[j].v) ? 2 : 1; }
      const sc = (args[j]?.v || '').toLowerCase(); const rest = args.slice(j + 1);
      if (sc === 'clean' && !rest.some((t) => /^(--dry-run|-[a-z]*n[a-z]*|-i|--interactive)$/i.test(t.v))) hits.push({ tier: 'deny', id: 'git-clean', why: 'git clean xoa file chua theo doi (khong dem duoc)' });
      else if (sc === 'rm') { const h = analyzeDelete(rest, 'posix', { ...ctx, git: true }); if (h) hits.push(h); }
      continue;
    }
    if (dc.alwaysRecursive.includes(name)) { hits.push({ tier: 'deny', id: 'recursive-delete', why: name + ' (xoa de quy)' }); continue; }
    if (xargs && (dc.posix.includes(name) || dc.ps.includes(name))) { hits.push({ tier: 'deny', id: 'pipe-delete', why: 'xargs ' + name + ' (khong dem duoc)' }); continue; }
    let kind = null;
    if (mode === 'ps' && dc.ps.includes(name)) kind = 'ps';
    else if (dc.posix.includes(name)) kind = 'posix';
    if (dc.cmd.includes(name) && args.some((t) => /^\/[a-z]/i.test(t.v) && t.v.length <= 4)) kind = 'cmd';
    if (!kind && mode === 'bash' && dc.dirOnly.includes(name)) { const h = rmdirHit(args); if (h) hits.push(h); continue; }
    if (!kind) continue;
    const h = analyzeDelete(args, kind, ctx);
    if (h) hits.push(h);
  }
  return hits;
}
