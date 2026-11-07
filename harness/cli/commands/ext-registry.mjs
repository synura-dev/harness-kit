// Dang ky extension o LOP MAY (khong bao gio o lop du an). Luoc do (file config/ext/local.json, lop may):
//   { "extensions": { "<workspace tuyet doi>": [ { id, root(tuong doi workspace), hash(sha256 ca cay code), approvedAt } ] } }
// Hash lech => CHAN (isExtensionTrusted=false) cho toi khi `ext approve`. Worktree cua hub goc doc dang ky cua hub goc.
// Doc/kiem hash nam o core/ext/ext-trust.mjs (core khong import cli); file nay giu register/approve/list/verify + re-export API cu.
import fs from 'node:fs';
import path from 'node:path';
import { manifestDomains } from '../../core/ext/manifest-domains.mjs';
import { hash8, hashTree, registryWorkspace, machineFile, listRegistered, isExtensionTrusted, guardDecl, mirrorRegistry, readAll, writeAll, findKey, readEntries, extensionStatus } from '../../core/ext/ext-trust.mjs';

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
  let guard = null;
  if (m.guard !== undefined) {
    const g = guardDecl(m);
    if (!g) return { error: 'guard khai bao sai (can event=PreToolUse, matcher regex hop le, args mang string)' };
    guard = { ...g, domain: domains[0] };
  }
  const ui = scanUi(m, domains);
  if (ui.error) return { error: ui.error };
  return { id: m.id, domains, guard, commands: ui.commands, views: ui.views };
}

const MODES = ['read', 'confirm', 'tty'], KINDS = ['graph', 'timeline', 'system', 'list'];
/** commands (mang {name,mode,args} hoac object ten->{mode,args}) + views: chuan hoa va kiem. Khong co -> []. */
function scanUi(m, domains) {
  const cmds = [];
  if (m.commands !== undefined) {
    const raw = Array.isArray(m.commands) ? m.commands : (m.commands && typeof m.commands === 'object' ? Object.entries(m.commands).map(([name, v]) => ({ name, ...(v && typeof v === 'object' ? v : {}) })) : null);
    if (!raw) return { error: 'commands phai la mang/object' };
    for (const c of raw) {
      if (!c || typeof c.name !== 'string' || !c.name) return { error: 'commands[]: thieu name' };
      if (!MODES.includes(c.mode)) return { error: `commands.${c.name}: mode phai thuoc ${MODES.join('|')}` };
      if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a) => typeof a === 'string'))) return { error: `commands.${c.name}: args phai la mang string` };
      cmds.push({ name: c.name, mode: c.mode, args: c.args || [] });
    }
  }
  const views = [];
  if (m.views !== undefined) {
    if (!Array.isArray(m.views)) return { error: 'views phai la mang' };
    if (m.views.length && m.commands === undefined) return { error: 'manifest co views nhung thieu commands: them commands (name, mode read|confirm|tty) cho moi source/action' };
    for (let [i, v] of m.views.entries()) {
      if (!v || !KINDS.includes(v.kind)) return { error: `views[${i}]: kind phai thuoc ${KINDS.join('|')}` };
      if (typeof v.source !== 'string' || !v.source.trim()) return { error: `views[${i}]: thieu source` };
      const t = v.source.trim().split(/\s+/), name = domains.includes(t[0]) && t.length > 1 ? t[1] : t[0];
      const c = cmds.find((x) => x.name === name);
      if (!c) return { error: `views[${i}]: source '${v.source}' khong khai bao trong commands` };
      if (c.mode !== 'read') return { error: `views[${i}]: source '${name}' phai o mode read (dang ${c.mode})` };
      if (v.actions !== undefined && !(Array.isArray(v.actions) && v.actions.every((a) => a && typeof a.label === 'string' && typeof a.cmd === 'string' && (a.mode === undefined || MODES.includes(a.mode))))) return { error: `views[${i}]: actions sai (label, cmd, mode)` };
      if (v.actions) v = { ...v, actions: v.actions.map((a) => ({ ...a })) };
      for (const [j, a] of (v.actions || []).entries()) {
        const at = a.cmd.trim().split(/\s+/), an = domains.includes(at[0]) && at.length > 1 ? at[1] : at[0];
        const ac = cmds.find((x) => x.name === an);
        if (!ac) return { error: `views[${i}].actions[${j}]: cmd '${a.cmd}' khong khai bao trong commands (action)` };
        if (a.mode !== undefined && MODES.indexOf(a.mode) < MODES.indexOf(ac.mode)) return { error: `views[${i}].actions[${j}]: mode '${a.mode}' yeu hon command '${an}' (${ac.mode})` };
        a.mode = ac.mode;
      }
      views.push(v);
    }
  }
  return { commands: cmds, views };
}

/** describe <id>: tu manifest dang ky (khong doc du lieu); chi doc manifest khi hash con khop. */
export function describe(id, opts = {}) {
  let entries, ws; try { ({ entries, ws } = readEntries(opts)); } catch (e) { return { code: 2, text: `ext describe: ${e.message}` }; }
  const e = entries.find((x) => x.id === id);
  if (!e) return { code: 2, text: `ext describe: ${id || '?'} chua dang ky` };
  const s = extensionStatus(id, opts), abs = path.resolve(ws, e.root);
  const out = { id, path: e.root, hash: e.hash, status: s.status, domains: [], commands: [], views: [] };
  if (s.status === 'ok') { const sc = scanManifest(abs); if (!sc.error) Object.assign(out, { domains: sc.domains, commands: sc.commands, views: sc.views }); else out.error = sc.error; }
  return { code: 0, text: JSON.stringify(out) };
}

const fmtG = (g) => `${g.event} matcher=${g.matcher} args=[${(g.args || []).join(' ')}] domain=${g.domain}`;
/** Thay doi guard so voi registry hien tai, in vao prompt TTY de nguoi duyet thay. */
export function guardDiff(oldG, newG) {
  if (!oldG && !newG) return 'guard: khong co';
  if (!oldG) return `THEM guard: ${fmtG(newG)}`;
  if (!newG) return `GO GUARD (manifest moi khong co guard): ${fmtG(oldG)}`;
  return JSON.stringify(oldG) === JSON.stringify(newG) ? `guard khong doi: ${fmtG(newG)}` : `DOI guard: ${fmtG(oldG)} -> ${fmtG(newG)}`;
}

function audit(id, event, rel, hash) {
  import('../../core/ext/ctx.mjs').then((m) => m.auditExt(id, { ok: true, event, status: 'ext-ok', data: { root: rel, hash8: hash8(hash) } })).catch(() => {});
}

// Seam test: opts.confirm/opts.isTTY CHI duoc tin khi chay duoi test runner (NODE_ENV=test hoac BUN_TEST). Ngoai test luon doi TTY that + doc phim.
const underTest = () => process.env.NODE_ENV === 'test' || !!process.env.BUN_TEST;
function confirmTty(msg, opts) {
  if (opts.confirm && underTest()) return Promise.resolve(!!opts.confirm(msg));
  const tty = (underTest() ? opts.isTTY : undefined) ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) return Promise.resolve(null);
  return import('node:readline').then((rl) => new Promise((res) => {
    const i = rl.createInterface({ input: process.stdin, output: process.stdout });
    i.question(`${msg} [yes/N] `, (a) => { i.close(); res(/^y(es)?$/i.test(a.trim())); });
  }));
}

/** Sao chep ban chinh sang CLI khac; CHI goi sau khi nguoi dung da xac nhan o TTY. Chep loi => code 1 (ban chinh da ghi). */
function syncCopies(opts, res) {
  const m = mirrorRegistry(opts);
  if (m.failed.length) return { code: 1, text: `${res.text}\next: ban chinh da ghi nhung SAO CHEP LOI: ${m.failed.join('; ')}. CLI do chua dong bo; sua roi chay lai \`harness ext approve <id>\` o terminal.` };
  return m.mirrored.length ? { ...res, text: `${res.text} (dong bo: ${m.mirrored.join(',')})` } : res;
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
  let oldG = null;
  try { const a0 = readAll({ ...opts, base: registryWorkspace(ws).base }); const k0 = findKey(a0, registryWorkspace(ws).base); const e0 = k0 && (a0.extensions[k0] || []).find((x) => x && x.id === sc.id); oldG = (e0 && e0.guard) || null; } catch { /* readAll loi bao o buoc ghi */ }
  const ok = await confirmTty(`Dang ky extension ${sc.id} (${rel}, hash ${hash8(t.hash)}, ${t.files} file, domain ${sc.domains.join(',')}). ${guardDiff(oldG, sc.guard)}. Extension chay duoc moi thu node. Dong y?`, opts);
  if (ok === null) return { code: 2, text: 'ext register: can TTY de xac nhan (agent khong tu duyet)' };
  if (!ok) return { code: 1, text: 'ext register: tu choi' };
  const { base } = registryWorkspace(ws);
  let all; try { all = readAll({ ...opts, base }); } catch (e) { return { code: 2, text: `ext register: ${e.message}` }; }
  const k = findKey(all, base) || path.resolve(base);
  const list = (Array.isArray(all.extensions[k]) ? all.extensions[k] : []).filter((x) => x && x.id !== sc.id);
  list.push({ id: sc.id, root: rel, hash: t.hash, approvedAt: new Date().toISOString(), ...(sc.guard ? { guard: sc.guard } : {}) });
  all.extensions[k] = list; writeAll({ ...opts, base }, all);
  audit(sc.id, 'register', rel, t.hash);
  return syncCopies({ ...opts, base }, { code: 0, text: `ext register: ${sc.id} ${rel} hash=${hash8(t.hash)}` });
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
  // Khai bao guard ghim cung luc voi hash (ext cu chua co truong guard: approve lai se ghi). Manifest bo guard => approve GO guard (prompt ghi ro GO GUARD, can TTY); manifest tren dia tu no khong xoa guard da ghim.
  const sc = scanManifest(abs, opts.coreDomains || new Set());
  if (sc.error && /^guard /.test(sc.error)) return { code: 2, text: `ext approve: ${sc.error}` };
  const manifestOk = !sc.error;
  const newGuard = manifestOk ? sc.guard : (e.guard || null);
  const guardChanged = manifestOk && JSON.stringify(newGuard) !== JSON.stringify(e.guard || null);
  if (t.hash === e.hash && !guardChanged) {
    const same = { code: 0, text: `ext approve: ${id} khong doi (${hash8(t.hash)})` };
    // Khong doi: neu nguoi dung xac nhan o TTY thi van dong bo ban chep sang CLI khac (sau khi cai agy / doi roots.json).
    return (await confirmTty(`${id} khong doi. Dong bo ban dang ky hien tai sang thu muc du lieu cua CLI khac?`, opts)) === true ? syncCopies({ ...opts, base }, same) : same;
  }
  const ok = await confirmTty(`Duyet code moi cua ${id}: hash ${hash8(e.hash)} -> ${hash8(t.hash)}. ${guardDiff(e.guard || null, newGuard)}. Dong y?`, opts);
  if (ok === null) return { code: 2, text: 'ext approve: can TTY de xac nhan (agent khong tu duyet)' };
  if (!ok) return { code: 1, text: 'ext approve: tu choi' };
  e.hash = t.hash; e.approvedAt = new Date().toISOString();
  if (newGuard) e.guard = newGuard; else delete e.guard;
  writeAll({ ...opts, base }, all);
  audit(id, 'approve', e.root, t.hash);
  return syncCopies({ ...opts, base }, { code: 0, text: `ext approve: ${id} hash=${hash8(t.hash)}` });
}

/** remove <id> [--yes]: go dang ky. Mac dinh dry-run; --yes (opts.yes) moi ghi. Khong guard: KHONG can TTY (giam quyen). Co guard: go guard = giam an toan => BAT BUOC TTY (tra Promise). */
export function remove(id, opts = {}) {
  const ws = path.resolve(opts.workspace || process.cwd());
  const { base } = registryWorkspace(ws);
  let all; try { all = readAll({ ...opts, base }); } catch (e) { return { code: 2, text: `ext remove: ${e.message}` }; }
  const k = findKey(all, base);
  const e = k && (all.extensions[k] || []).find((x) => x && x.id === id);
  if (!id || !e) return { code: 2, text: `ext remove: ${id || '(thieu id)'} chua dang ky` };
  if (!opts.yes) return { code: 0, text: `ext remove: dry-run, se go ${id} (${e.root}); them --yes de go` };
  const doRemove = (viaTty) => {
    all.extensions[k] = all.extensions[k].filter((x) => x && x.id !== id);
    writeAll({ ...opts, base }, all);
    audit(id, 'remove', e.root, e.hash);
    const res = { code: 0, text: `ext remove: da go ${id} (${e.root})` };
    // Khong qua TTY (khong guard) => KHONG chep sang CLI khac (agent goi duoc, khong duoc lan sang ban cua CLI khac).
    return viaTty ? syncCopies({ ...opts, base }, res) : { ...res, text: `${res.text}; chua dong bo sang CLI khac (can TTY: harness ext approve)` };
  };
  if (!e.guard) return doRemove(false);
  return confirmTty(`Go extension ${id} KEM GUARD: ${fmtG(e.guard)}. Tool khop matcher se het duoc guard bao ve. Dong y?`, opts).then((ok) => {
    if (ok === null) return { code: 2, text: `ext remove: ${id} co guard, can TTY de xac nhan: chay trong PowerShell rieng (khong qua agent): harness ext remove ${id} --yes` };
    return ok ? doRemove(true) : { code: 1, text: 'ext remove: tu choi' };
  });
}

export function list(opts = {}) {
  let entries; try { ({ entries } = readEntries(opts)); } catch (e) { return { code: 2, text: `ext list: ${e.message}` }; }
  if (opts.json) return { code: 0, text: JSON.stringify(entries.map((e) => ({ id: e.id, path: e.root, hash: e.hash, status: extensionStatus(e.id, opts).status }))) };
  const lines = entries.map((e) => { const s = extensionStatus(e.id, opts); return `${e.id}\t${e.root}\t${hash8(e.hash)}\t${s.status}`; });
  return { code: 0, text: lines.length ? lines.join('\n') : '(chua co extension dang ky)' };
}

/** verify: lech/thieu => exit 1 (va nghia la CHAN chay cho toi `ext approve`). */
export function verify(opts = {}) {
  let entries, ws; try { ({ entries, ws } = readEntries(opts)); } catch (e) { return { code: 1, text: `ext verify: ${e.message}` }; }
  let bad = 0; const L = [];
  for (const e of entries) {
    const s = extensionStatus(e.id, opts);
    if (s.status !== 'ok') { bad++; L.push(`${e.id}: ${s.status} (ghim ${hash8(s.pinned)}${s.current ? `, hien tai ${hash8(s.current)}` : ''}) -> BI CHAN; chay: harness ext approve ${e.id}`); }
    else {
      const sc = scanManifest(path.resolve(ws, e.root));
      if (sc.error) { bad++; L.push(`${e.id}: manifest sai: ${sc.error}`); } else L.push(`${e.id}: ok (${hash8(e.hash)})`);
    }
  }
  return { code: bad ? 1 : 0, text: L.length ? L.join('\n') : '(chua co extension dang ky)' };
}
