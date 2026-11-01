// `data archive <ws> [--yes]` + kiem tra workspace mo coi (ws khong nut nao tro toi).
// ctx: { root?, reg?, nodes: [{id, workspace}]|null (null = khong hook), registryFile?, wsDir?, opts?, now? }. Tra {code, lines}. Dry-run mac dinh.
// Dich: _archive/workspaces/<ws>-<YYYYMMDD-HHMMSS>. Tai dung mv: manifest md5 + khoa + rename + xac minh + cap nhat registry (rollback khi loi). Khong xoa.
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../../core/io/paths.mjs';
import { appendJsonl, dataPathFor, today } from '../../core/io/storage.mjs';
import { isSafeWs } from '../../core/io/node-hook.mjs';
import { loadDataRegistry, setEntryPath } from '../../core/registry/data-registry.mjs';
import { LIMITS } from './data.mjs';
import { manifest, takeLock } from './mv.mjs';

const posix = (x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '');
const stamp = (d) => d.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

/** Ten thu muc con (chi ten, khong doc file) duoi workspaces/ khong nut nao tro toi. nodes rong/null -> [] (khong co hook thi bo qua rule). */
export function orphanWorkspaces(root, nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return [];
  const mapped = new Set(nodes.map((n) => n && n.workspace));
  let ents = [];
  try { ents = fs.readdirSync(path.join(root, 'workspaces'), { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && !mapped.has(e.name)).map((e) => e.name).sort();
}

/** Nut tho tu hook (truoc khi listNodes loc) co workspace khong an toan -> [{id, workspace}]. */
export function unsafeWorkspaceNodes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((n) => n && typeof n === 'object' && n.workspace != null && !isSafeWs(n.workspace)).map((n) => ({ id: String(n.id ?? '').slice(0, 80), workspace: String(n.workspace).slice(0, 80) }));
}

export async function archiveCmd(args = [], ctx = {}) {
  const lines = [];
  const L = (s) => lines.push(s);
  const fail = (e) => { L(`data archive: ${e.message}`); return { code: /abort:/.test(e.message) ? 2 : 1, lines }; };
  let lock = null;
  try {
    const yes = args.includes('--yes');
    const pos = args.filter((a) => !a.startsWith('--'));
    if (pos.length !== 1) throw new Error('abort: usage: data archive <ws> [--yes]');
    const ws = pos[0];
    if (!isSafeWs(ws)) throw new Error('abort: ten workspace khong an toan');
    const root = ctx.root || dataRoot();
    if (!Array.isArray(ctx.nodes) || !ctx.nodes.length) throw new Error('abort: khong co hook nut (listNodes) nen khong xac minh duoc ws con nut tro toi; khong archive');
    const mapped = ctx.nodes.filter((n) => n && n.workspace === ws).map((n) => n.id);
    if (mapped.length) throw new Error(`abort: ws "${ws}" con nut tro toi (${mapped.slice(0, 5).join(', ')}); khong archive`);
    const from = `workspaces/${ws}`;
    const absFrom = path.join(root, 'workspaces', ws);
    if (!fs.existsSync(absFrom)) throw new Error(`abort: ws khong ton tai: ${from}`);
    const st = fs.lstatSync(absFrom);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('abort: ws phai la thu muc thuong');
    const reg = ctx.reg || loadDataRegistry({ registryFile: ctx.registryFile, workspacesDir: ctx.wsDir, noCache: true });
    if (reg.failed) throw new Error('abort: registry khong doc duoc');
    const to = `_archive/workspaces/${ws}-${stamp(ctx.now instanceof Date ? ctx.now : new Date())}`;
    const absTo = path.join(root, ...to.split('/'));
    if (fs.existsSync(absTo)) throw new Error(`abort: dich da ton tai: ${to}`);
    const lim = { maxFiles: ctx.opts?.maxFiles ?? LIMITS.maxFiles, deadline: ctx.opts?.deadline ?? Date.now() + LIMITS.timeoutS * 1000 };
    const before = manifest(absFrom, lim);
    const show = (tag, m) => L(`${tag}: ${m.files.length} file, ${m.bytes} bytes, md5=${m.md5}${m.truncated ? `  truncated: ${m.truncated}` : ''}`);
    const ents = Object.entries(reg.entries).map(([k, e]) => ({ k, p: posix((e && e.path) || k) })).filter((x) => x.p === from || x.p.startsWith(from + '/'));
    if (!yes) {
      L(`dry-run: se archive ${from} -> ${to} (${ents.length} muc registry)`);
      show('before', before);
      L(`them --yes de archive; hoan tac: data mv ${to} ${from} --yes`);
      return { code: 0, lines, manifest: before };
    }
    if (before.truncated) throw new Error(`abort: manifest bi cat (${before.truncated}); khong the xac minh md5`);
    lock = takeLock(root);
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    try { fs.renameSync(absFrom, absTo); } catch (e) { throw new Error(`abort: rename that bai (${e.code || e.message}); chi ho tro cung o dia`); }
    const after = manifest(absTo, { ...lim, deadline: Date.now() + LIMITS.timeoutS * 1000 });
    if (after.truncated || after.md5 !== before.md5 || after.files.length !== before.files.length) {
      try { fs.renameSync(absTo, absFrom); } catch {}
      throw new Error('abort: md5 lech sau rename; da rename nguoc');
    }
    const so = { registryFile: ctx.registryFile, workspacesDir: ctx.wsDir };
    const done = [];
    try {
      for (const x of ents) {
        const np = to + x.p.slice(from.length);
        if (setEntryPath(x.p, np, so)) done.push([x.p, np]);
      }
    } catch (e) {
      for (const [a, b] of done.reverse()) { try { setEntryPath(b, a, so); } catch {} }
      try { fs.renameSync(absTo, absFrom); } catch {}
      throw new Error(`abort: khong cap nhat duoc registry (${e.message}); da rename nguoc`);
    }
    try { appendJsonl(dataPathFor('audit', `date=${today()}`, 'type=data-access', 'data-cli.jsonl'), { ts: new Date().toISOString(), cmd: 'archive', from, to, entries: done.length, files: after.files.length, bytes: after.bytes, md5: after.md5 }); } catch {}
    L(`da archive ${from} -> ${to} (${done.length} muc registry cap nhat)`);
    show('before', before);
    show('after ', after);
    L('md5 khop');
    return { code: 0, lines, before, after };
  } catch (e) { return fail(e); } finally { if (lock) try { fs.rmSync(lock, { force: true }); } catch {} }
}
