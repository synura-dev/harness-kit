// harness/knowledge/vault/index.mjs - Zero-Scan Index (.index.json) cho vault.
// Luu metadata trong <root>/.index.json: chi statSync (mtimeMs, size) de check cache hit, khong doc file khi khong doi.
import fs from 'node:fs';
import path from 'node:path';
import { KINDS, findSecret, metaText, isWebSource, bodyLinks } from './schema.mjs';
import { parse } from './frontmatter.mjs';

const INDEX_FILE = '.index.json';
const MAX_SCAN_FILES = 2000;
const RENAME_TRIES = 8, RENAME_BUDGET_MS = 500, RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);

const lexists = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

/** Windows: rename de len file dang bi tien trinh khac mo nem EPERM/EBUSY/EACCES tam thoi. */
export function renameRetry(from, to, { tries = RENAME_TRIES, budgetMs = RENAME_BUDGET_MS, platform = process.platform, rename = fs.renameSync } = {}) {
  const t0 = Date.now();
  for (let i = 1; ; i++) {
    try { return rename(from, to); } catch (e) {
      if (platform !== 'win32' || !RENAME_RETRY.has(e.code) || i >= tries || Date.now() - t0 >= budgetMs) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10 * i, 80));
    }
  }
}

function readIndex(root) {
  const p = path.join(root, INDEX_FILE);
  try {
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(txt);
    if (data && data.version === 1 && typeof data.entries === 'object' && data.entries !== null) {
      return data;
    }
  } catch {}
  return null;
}

function writeIndexAtomic(root, data) {
  const p = path.join(root, INDEX_FILE);
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameRetry(tmp, p);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export function syncIndex(root, opts = {}) {
  const baseSt = lexists(root);
  if (!baseSt || baseSt.isSymbolicLink() || !baseSt.isDirectory()) {
    return { ok: true, items: [], count: 0, cachedHits: 0, parsedCount: 0, truncated: null };
  }

  const cachedIndex = opts.rebuild ? null : readIndex(root);
  const oldEntries = cachedIndex && cachedIndex.entries ? cachedIndex.entries : {};
  const entries = {};
  let cachedHits = 0;
  let parsedCount = 0;
  let truncated = null;
  let fileCount = 0;
  const t0 = Date.now();
  const tmo = (opts.timeoutS || 10) * 1000;
  const cap = opts.maxFiles || MAX_SCAN_FILES;

  function processFile(filePath, id, kind) {
    let st;
    try { st = fs.statSync(filePath); } catch { return; }
    const relPath = path.relative(root, filePath).replace(/\\/g, '/');
    const old = oldEntries[id];
    if (
      !opts.rebuild &&
      old &&
      old.relPath === relPath &&
      old.size === st.size &&
      (old.mtimeMs === st.mtimeMs || Math.abs(old.mtimeMs - st.mtimeMs) < 1)
    ) {
      entries[id] = old;
      cachedHits++;
      return;
    }

    let text = '';
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    const { meta: fm = {}, body = '' } = parse(text);
    const secret = findSecret([metaText(fm), body].join('\n'));
    const web = isWebSource(fm.source);
    const firstLine = String(body || '').split(/\r?\n/).map((x) => x.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
    const title = (typeof fm.quote === 'string' && fm.quote.trim()) ? fm.quote.trim() : firstLine;
    const links = [...new Set([...(Array.isArray(fm.links) ? fm.links : []), ...bodyLinks(body)])];
    const refs = Array.isArray(fm.refs) ? fm.refs : [];

    entries[id] = {
      id: fm.id || id,
      kind: fm.kind || kind,
      scope: fm.scope || 'global',
      status: fm.status || 'active',
      confidence: fm.confidence || null,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      links,
      refs,
      source: typeof fm.source === 'string' ? fm.source : null,
      quote: typeof fm.quote === 'string' ? fm.quote : null,
      fetched: fm.fetched || null,
      recheck: fm.recheck || null,
      probe: fm.probe || null,
      created: fm.created || null,
      updated: fm.updated || null,
      secret,
      web,
      title,
      relPath,
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
    parsedCount++;
  }

  outer: for (const kind of KINDS) {
    const kindDir = path.join(root, kind);
    const kSt = lexists(kindDir);
    if (!kSt || !kSt.isDirectory() || kSt.isSymbolicLink()) continue;

    let ents = [];
    try { ents = fs.readdirSync(kindDir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (Date.now() - t0 > tmo) { truncated = 'timeout'; break outer; }
      if (fileCount >= cap) { truncated = `limit ${cap} files`; break outer; }
      if (e.name.startsWith('.')) continue;

      if (e.isFile() && e.name.endsWith('.md')) {
        fileCount++;
        processFile(path.join(kindDir, e.name), e.name.slice(0, -3), kind);
      } else if (e.isDirectory()) {
        const subDir = path.join(kindDir, e.name);
        const subSt = lexists(subDir);
        if (!subSt || !subSt.isDirectory() || subSt.isSymbolicLink()) continue;
        let subEnts = [];
        try { subEnts = fs.readdirSync(subDir, { withFileTypes: true }); } catch { continue; }
        for (const se of subEnts.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (Date.now() - t0 > tmo) { truncated = 'timeout'; break outer; }
          if (fileCount >= cap) { truncated = `limit ${cap} files`; break outer; }
          if (se.name.startsWith('.') || !se.isFile() || !se.name.endsWith('.md')) continue;
          fileCount++;
          processFile(path.join(subDir, se.name), se.name.slice(0, -3), kind);
        }
      }
    }
  }

  const isDirty = Boolean(
    opts.write !== false &&
    (
      opts.rebuild ||
      parsedCount > 0 ||
      (fileCount > 0 && !cachedIndex) ||
      (cachedIndex && Object.keys(oldEntries).length !== Object.keys(entries).length) ||
      (cachedIndex && Object.keys(oldEntries).some((k) => !entries[k]))
    )
  );

  if (isDirty && fs.existsSync(root)) {
    writeIndexAtomic(root, {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    });
  }

  const items = Object.values(entries);
  return {
    ok: true,
    items,
    count: items.length,
    cachedHits,
    parsedCount,
    truncated,
  };
}

/** Di chuyen file flat hoac sai scope-dir sang dung cau truc thu muc. */
export function doMigrate(root, options = {}, { safeFile } = {}) {
  const idx = syncIndex(root, options);
  const moved = [];
  for (const it of idx.items) {
    const scope = it.scope || 'global';
    let targetFile;
    if (typeof safeFile === 'function') {
      try { targetFile = safeFile(root, it.kind, it.id, scope); } catch { continue; }
    } else {
      continue;
    }
    const curFile = path.join(root, it.relPath);
    if (path.resolve(curFile) !== path.resolve(targetFile)) {
      if (options.apply === true) {
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        renameRetry(curFile, targetFile);
        try { fs.rmdirSync(path.dirname(curFile)); } catch {}
      }
      moved.push({ id: it.id, from: curFile, to: targetFile });
    }
  }
  if (options.apply === true && moved.length) {
    try { syncIndex(root, { rebuild: true }); } catch {}
  }
  return { ok: true, dryRun: options.apply !== true, moved, count: moved.length };
}
