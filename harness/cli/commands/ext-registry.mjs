// Dang ky extension o LOP MAY (khong bao gio o lop du an). Luoc do (file config/ext/local.json, lop may):
//   { "extensions": { "<workspace tuyet doi>": [ { id, root(tuong doi workspace), hash(sha256 ca cay code), approvedAt } ] } }
// Hash lech => CHAN (isExtensionTrusted=false) cho toi khi `ext approve`. Worktree cua hub goc doc dang ky cua hub goc.
// Doc/kiem hash nam o core/ext/ext-trust.mjs (core khong import cli); file nay giu register/approve/list/verify + re-export API cu.
import fs from 'node:fs';
import path from 'node:path';
import { manifestDomains } from '../../core/ext/manifest-domains.mjs';
import { hash8, hashTree, registryWorkspace, machineFile, listRegistered, isExtensionTrusted, readAll, writeAll, findKey, readEntries, extensionStatus } from '../../core/ext/ext-trust.mjs';

export { hash8, hashTree, registryWorkspace, machineFile, listRegistered, isExtensionTrusted };

function scanManifest(rootAbs, coreDomains = new Set()) {
  let m; try { m = JSON.parse(fs.readFileSync(path.join(rootAbs, 'manifest.json'), 'utf8')); } catch (e) { return { error: `doc manifest loi: ${String(e.message).slice(0, 80)}` }; }
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !/^[\w.-]+$/.test(m.id)) return { error: 'manifest thieu id hop le' };
  // Cung luat voi ext-host (loadExternals): `domain` string (manifest hub that) hoac `domains` mang/object.
  const domains = manifestDomains(m);
  if (typeof m.entry !== 'string' || !domains.length) return { error: 'manifest thieu entry/domain(s)' };
  const entry = path.resolve(rootAbs, m.entry), rel = path.relative(rootAbs, entry);
  if (m.entry.split(/[\\/]/).includes('..') || !rel || rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'entry ra ngoai root' };
  if (!fs.existsSync(entry)) return { error: `entry khong ton tai: ${m.entry}` };
  const dup = domains.filter((d) => coreDomains.has(d));
  if (dup.length) return { error: `domain trung core: ${dup.join(',')}` };
  return { id: m.id, domains };
}

function audit(id, event, rel, hash) {
  import('../../core/ext/ctx.mjs').then((m) => m.auditExt(id, { ok: true, event, status: 'ext-ok', data: { root: rel, hash8: hash8(hash) } })).catch(() => {});
}

function confirmTty(msg, opts) {
  if (opts.confirm) return Promise.resolve(!!opts.confirm(msg));
  const tty = opts.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) return Promise.resolve(null);
  return import('node:readline').then((rl) => new Promise((res) => {
    const i = rl.createInterface({ input: process.stdin, output: process.stdout });
    i.question(`${msg} [yes/N] `, (a) => { i.close(); res(/^y(es)?$/i.test(a.trim())); });
  }));
}

/** register <path>: ask (TTY). -> {code, text} */
export async function register(p, opts = {}) {
  const ws = path.resolve(opts.workspace || process.cwd());
  const abs = path.resolve(ws, p || '');
  const rel = path.relative(ws, abs).split(path.sep).join('/');
  if (!p || !rel || rel.startsWith('..') || path.isAbsolute(rel)) return { code: 2, text: 'ext register: root phai nam trong workspace' };
  const sc = scanManifest(abs, opts.coreDomains || new Set());
  if (sc.error) return { code: 2, text: `ext register: ${sc.error}` };
  const t = hashTree(abs, opts.limits);
  if (t.truncated) return { code: 2, text: `ext register: ${t.rejected ? `tu choi (${t.rejected})` : 'cay code qua lon (truncated)'}` };
  const ok = await confirmTty(`Dang ky extension ${sc.id} (${rel}, hash ${hash8(t.hash)}, ${t.files} file, domain ${sc.domains.join(',')}). Extension chay duoc moi thu node. Dong y?`, opts);
  if (ok === null) return { code: 2, text: 'ext register: can TTY de xac nhan (agent khong tu duyet)' };
  if (!ok) return { code: 1, text: 'ext register: tu choi' };
  const { base } = registryWorkspace(ws);
  let all; try { all = readAll({ ...opts, base }); } catch (e) { return { code: 2, text: `ext register: ${e.message}` }; }
  const k = findKey(all, base) || path.resolve(base);
  const list = (Array.isArray(all.extensions[k]) ? all.extensions[k] : []).filter((x) => x && x.id !== sc.id);
  list.push({ id: sc.id, root: rel, hash: t.hash, approvedAt: new Date().toISOString() });
  all.extensions[k] = list; writeAll({ ...opts, base }, all);
  audit(sc.id, 'register', rel, t.hash);
  return { code: 0, text: `ext register: ${sc.id} ${rel} hash=${hash8(t.hash)}` };
}

/** approve <id>: ask (TTY); ghim lai hash hien tai sau khi code doi. */
export async function approve(id, opts = {}) {
  const ws = path.resolve(opts.workspace || process.cwd());
  const { base } = registryWorkspace(ws);
  let all; try { all = readAll({ ...opts, base }); } catch (e) { return { code: 2, text: `ext approve: ${e.message}` }; }
  const k = findKey(all, base);
  const e = k && (all.extensions[k] || []).find((x) => x && x.id === id);
  if (!e) return { code: 2, text: `ext approve: ${id} chua dang ky` };
  const abs = path.resolve(ws, e.root);
  if (!fs.existsSync(abs)) return { code: 2, text: `ext approve: thieu ${e.root}` };
  const t = hashTree(abs, opts.limits);
  if (t.truncated) return { code: 2, text: `ext approve: ${t.rejected ? `tu choi (${t.rejected})` : 'cay code qua lon (truncated)'}` };
  if (t.hash === e.hash) return { code: 0, text: `ext approve: ${id} khong doi (${hash8(t.hash)})` };
  const ok = await confirmTty(`Duyet code moi cua ${id}: hash ${hash8(e.hash)} -> ${hash8(t.hash)}. Dong y?`, opts);
  if (ok === null) return { code: 2, text: 'ext approve: can TTY de xac nhan (agent khong tu duyet)' };
  if (!ok) return { code: 1, text: 'ext approve: tu choi' };
  e.hash = t.hash; e.approvedAt = new Date().toISOString();
  writeAll({ ...opts, base }, all);
  audit(id, 'approve', e.root, t.hash);
  return { code: 0, text: `ext approve: ${id} hash=${hash8(t.hash)}` };
}

export function list(opts = {}) {
  let entries; try { ({ entries } = readEntries(opts)); } catch (e) { return { code: 2, text: `ext list: ${e.message}` }; }
  const lines = entries.map((e) => { const s = extensionStatus(e.id, opts); return `${e.id}\t${e.root}\t${hash8(e.hash)}\t${s.status}`; });
  return { code: 0, text: lines.length ? lines.join('\n') : '(chua co extension dang ky)' };
}

/** verify: lech/thieu => exit 1 (va nghia la CHAN chay cho toi `ext approve`). */
export function verify(opts = {}) {
  let entries; try { ({ entries } = readEntries(opts)); } catch (e) { return { code: 1, text: `ext verify: ${e.message}` }; }
  let bad = 0; const L = [];
  for (const e of entries) {
    const s = extensionStatus(e.id, opts);
    if (s.status !== 'ok') { bad++; L.push(`${e.id}: ${s.status} (ghim ${hash8(s.pinned)}${s.current ? `, hien tai ${hash8(s.current)}` : ''}) -> BI CHAN; chay: harness ext approve ${e.id}`); }
    else L.push(`${e.id}: ok (${hash8(e.hash)})`);
  }
  return { code: bad ? 1 : 0, text: L.length ? L.join('\n') : '(chua co extension dang ky)' };
}
