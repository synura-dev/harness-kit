// harness/knowledge/vault/probe.mjs - chay probe cua fact (frontmatter `probe: {cmd:[argv], expect, timeoutS}`) de phat hien fact lech (stale-probe).
// An toan: argv KHONG qua shell, cmd phai KHOP CHINH XAC 1 muc allowlist (mac dinh `<bin> --version`; them qua config knowledge.probe.allow),
// moi token chi gom ky tu an toan, co timeout/tran output. Mac dinh `knowledge check` KHONG chay probe (can --probe).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileExpect, PROBE } from './schema.mjs';

/** Tim file thuc thi trong PATH (Windows: .exe/.com/.cmd/.bat). Khong thay -> null. */
function resolveBin(name, env = process.env) {
  const win = process.platform === 'win32';
  const exts = win ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const x of exts) {
    const f = path.join(d, name + x);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* tiep */ }
  }
  return null;
}

/** Chay 1 probe. Tra {status: 'ok'|'stale'|'error', got, msg}. Khong bao gio throw. */
function runProbe(probe, { timeoutS, env = process.env } = {}) {
  let ex;
  try { ex = compileExpect(probe.expect); } catch (e) { return { status: 'error', msg: `expect khong hop le: ${e.message}` }; }
  const bin = resolveBin(probe.cmd[0], env);
  if (!bin) return { status: 'error', msg: `khong thay lenh ${probe.cmd[0]} trong PATH` };
  const cap = Math.min(Number(probe.timeoutS) > 0 ? Number(probe.timeoutS) : PROBE.timeoutDefaultS, PROBE.timeoutMaxS);
  const tmo = Math.max(100, Math.min(cap * 1000, timeoutS > 0 ? timeoutS * 1000 : cap * 1000));
  // .cmd/.bat khong chay duoc khi shell:false -> qua cmd.exe; an toan vi moi token da khop allowlist + charset an toan.
  const shim = /\.(cmd|bat)$/i.test(bin);
  const argv = shim ? ['/d', '/s', '/c', bin, ...probe.cmd.slice(1)] : probe.cmd.slice(1);
  const r = spawnSync(shim ? (env.ComSpec || 'cmd.exe') : bin, argv, { shell: false, encoding: 'utf8', timeout: tmo, maxBuffer: PROBE.outputMax * 4, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { status: 'error', msg: r.error.code === 'ETIMEDOUT' ? `timeout ${Math.round(tmo / 1000)}s` : `khong chay duoc: ${r.error.code || r.error.message}` };
  const got = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, PROBE.outputMax);
  if (r.status !== 0) return { status: 'error', msg: `exit ${r.status}`, got: got.split(/\r?\n/)[0].slice(0, 120) };
  const hit = ex.re ? ex.re.test(got) : got.includes(ex.text);
  return hit ? { status: 'ok', got: got.split(/\r?\n/)[0].slice(0, 120) } : { status: 'stale', got: got.split(/\r?\n/)[0].slice(0, 120) };
}

/** Chay probe cho cac note co meta.probe (khong archived) co tran thoi gian/so luong.
 *  Tra {stale:[{kind,id,msg,got}], errors:[{kind,id,msg}], ran, truncated}. validateProbe da duoc chay o `check` truoc (note hong bi bo qua). */
export function probeNotes(notes, { allow, timeoutS = 10, maxProbes = 50, validate } = {}) {
  const t0 = Date.now(), deadline = t0 + timeoutS * 1000;
  const out = { stale: [], errors: [], ran: 0, truncated: null };
  for (const n of notes) {
    const p = n.meta && n.meta.probe;
    if (!p || n.meta.status === 'archived' || n.error) continue;
    const bad = validate(p, allow);
    if (bad.length) { out.errors.push({ kind: n.kind, id: n.id, msg: `probe khong hop le: ${bad[0]}` }); continue; }
    if (out.ran >= maxProbes) { out.truncated = `limit ${maxProbes} probes`; break; }
    if (Date.now() >= deadline) { out.truncated = 'timeout'; break; }
    out.ran++;
    const r = runProbe(p, { timeoutS: Math.max(0.2, (deadline - Date.now()) / 1000) });
    if (r.status === 'stale') out.stale.push({ kind: n.kind, id: n.id, msg: `stale-probe: ${p.cmd.join(' ')} khong khop expect ${JSON.stringify(p.expect)} (got ${JSON.stringify(r.got)})`, got: r.got });
    else if (r.status === 'error') out.errors.push({ kind: n.kind, id: n.id, msg: `probe-error: ${r.msg}` });
  }
  return out;
}
