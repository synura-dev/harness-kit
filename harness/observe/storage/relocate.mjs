// `data relocate <key> <to-rel> [--yes]`: CHI doi vi tri GHI trong registry (path=<to>, legacy=<cu>), khong di chuyen file.
// Reader doc gop path moi + legacy (dataReadRoots). Loi thoat: `data relocate <key> <duong cu>`. Dry-run mac dinh.
import path from 'node:path';
import { dataRoot, isInside, samePath } from '../../core/io/paths.mjs';
import { appendJsonl, dataPathFor, today } from '../../core/io/storage.mjs';
import { loadDataRegistry, setEntryPath } from '../../core/registry/data-registry.mjs';

const posix = (x) => String(x ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

export async function relocateCmd(args = [], ctx = {}) {
  const lines = [];
  const L = (s) => lines.push(s);
  try {
    const yes = args.includes('--yes');
    const pos = args.filter((a) => !a.startsWith('--'));
    if (pos.length !== 2) throw new Error('abort: usage: data relocate <key> <to-rel> [--yes]');
    const key = pos[0];
    const to = posix(pos[1]);
    const root = ctx.root || dataRoot();
    const reg = ctx.reg || loadDataRegistry({ registryFile: ctx.registryFile, workspacesDir: ctx.wsDir, noCache: true });
    if (reg.failed) throw new Error('abort: registry khong doc duoc');
    const ent = reg.entries[key];
    if (!ent) throw new Error(`abort: key khong co trong registry: ${key}`);
    if (!to || path.isAbsolute(to) || /^[A-Za-z]:/.test(to) || to.startsWith('/')) throw new Error('abort: to-rel khong duoc rong/tuyet doi');
    if (to.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error("abort: to-rel co '..'");
    const abs = path.join(root, ...to.split('/'));
    if (!isInside(abs, root) || samePath(abs, root)) throw new Error('abort: to-rel thoat khoi dataDir');
    const top = to.split('/')[0];
    if (reg.reserved.includes(top) && !reg.entries[top]) throw new Error(`abort: to-rel nam trong vung reserved: ${top}`);
    const from = posix(ent.path || key);
    if (to === from) throw new Error('abort: to-rel trung vi tri hien tai');
    L(`${yes ? 'relocate' : 'dry-run: se doi'} ghi ${key}: ${from} -> ${to} (legacy=${from}; KHONG di chuyen file; reader doc gop 2 noi)`);
    if (!yes) { L(`them --yes de ap dung; loi thoat: data relocate ${key} ${from} --yes`); return { code: 0, lines }; }
    const upd = setEntryPath(from, to, { registryFile: ctx.registryFile, workspacesDir: ctx.wsDir });
    if (!upd) throw new Error('abort: khong ghi duoc registry');
    try { appendJsonl(dataPathFor('audit', `date=${today()}`, 'type=data-access', 'data-cli.jsonl'), { ts: new Date().toISOString(), cmd: 'relocate', key, from, to }); } catch {}
    L(`da ghi registry: ${upd.key}.path=${to}`);
    return { code: 0, lines };
  } catch (e) { L(`data relocate: ${e.message}`); return { code: /abort:/.test(e.message) ? 2 : 1, lines }; }
}
