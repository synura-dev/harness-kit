import fs from 'node:fs';
import path from 'node:path';
import { ensureDataIgnore } from './paths.mjs';
import { resolveCaps } from '../config/contract.mjs';

export const STORE_DEFAULTS = {
  maxBytes: 524288, // 512 KB
  timeoutMs: 5000,
  limit: 50
};

export function appendRecord(filePath, record) {
  if (!filePath || !record) return null;
  const dir = path.dirname(filePath);
  ensureDataIgnore(); fs.mkdirSync(dir, { recursive: true });

  const rec = { ...record, ts: record.ts || new Date().toISOString() };
  fs.appendFileSync(filePath, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

export function appendRecords(filePath, records, options = {}) {
  const dedupeKey = options.dedupeKey;
  if (!filePath || !Array.isArray(records) || records.length === 0) {
    return { addedCount: 0, records: [] };
  }
  const dir = path.dirname(filePath);
  ensureDataIgnore(); fs.mkdirSync(dir, { recursive: true });

  const existingKeys = new Set();
  if (dedupeKey && fs.existsSync(filePath)) {
    const maxBytes = options.maxBytes || STORE_DEFAULTS.maxBytes;
    const { records: prev } = readRecords(filePath, { maxBytes, reverse: true });
    for (const r of prev) {
      if (r && r[dedupeKey] !== undefined) {
        existingKeys.add(String(r[dedupeKey]));
      }
    }
  }

  const toAdd = [];
  for (const r of records) {
    if (!r) continue;
    if (dedupeKey && r[dedupeKey] !== undefined) {
      const keyVal = String(r[dedupeKey]);
      if (existingKeys.has(keyVal)) continue;
      existingKeys.add(keyVal);
    }
    const rec = { ...r, ts: r.ts || new Date().toISOString() };
    toAdd.push(rec);
  }

  if (toAdd.length > 0) {
    const payload = toAdd.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(filePath, payload, 'utf8');
  }

  return { addedCount: toAdd.length, records: toAdd };
}

export function readRecords(filePath, options = {}) {
  const maxBytes = options.maxBytes ?? STORE_DEFAULTS.maxBytes;
  const timeoutMs = options.timeoutMs ?? STORE_DEFAULTS.timeoutMs;
  const reverse = Boolean(options.reverse);
  const t0 = Date.now();

  if (!fs.existsSync(filePath)) {
    return { records: [], truncated: null };
  }

  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return { records: [], truncated: null };
  }

  if (st.size === 0) {
    return { records: [], truncated: null };
  }

  let truncated = null;
  let rawText = '';

  if (st.size <= maxBytes) {
    rawText = fs.readFileSync(filePath, 'utf8');
  } else {
    truncated = 'max_bytes';
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      if (reverse) {
        const startOffset = st.size - maxBytes;
        fs.readSync(fd, buf, 0, maxBytes, startOffset);
        rawText = buf.toString('utf8');
        const firstNl = rawText.indexOf('\n');
        if (firstNl >= 0) rawText = rawText.slice(firstNl + 1);
      } else {
        fs.readSync(fd, buf, 0, maxBytes, 0);
        rawText = buf.toString('utf8');
        const lastNl = rawText.lastIndexOf('\n');
        if (lastNl >= 0) rawText = rawText.slice(0, lastNl);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  const lines = rawText.split(/\r?\n/);
  const records = [];
  const lineCount = lines.length;

  if (reverse) {
    for (let i = lineCount - 1; i >= 0; i--) {
      if (Date.now() - t0 > timeoutMs) {
        truncated = 'timeout';
        break;
      }
      const line = lines[i].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
  } else {
    for (let i = 0; i < lineCount; i++) {
      if (Date.now() - t0 > timeoutMs) {
        truncated = 'timeout';
        break;
      }
      const line = lines[i].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
  }

  return { records, truncated };
}

export function queryRecords(filePath, options = {}) {
  const q = String(options.q || '').trim().toLowerCase();
  const sectionFilter = String(options.section || '').trim().toLowerCase();
  const statusFilter = String(options.status || '').trim().toLowerCase();
  const limit = options.limit ?? STORE_DEFAULTS.limit;
  const timeoutMs = options.timeoutMs ?? STORE_DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? STORE_DEFAULTS.maxBytes;

  const t0 = Date.now();
  const { records, truncated: readTrunc } = readRecords(filePath, { maxBytes, timeoutMs, reverse: true });

  const matches = [];
  let totalScanned = 0;
  let truncated = readTrunc;

  for (const r of records) {
    if (Date.now() - t0 > timeoutMs) {
      truncated = 'timeout';
      break;
    }
    totalScanned++;

    if (sectionFilter) {
      const s = String(r.section || '').toLowerCase();
      if (!s.includes(sectionFilter)) continue;
    }

    if (statusFilter) {
      const st = String(r.status || '').toLowerCase();
      if (!st.includes(statusFilter)) continue;
    }

    if (q) {
      const title = String(r.title || '').toLowerCase();
      const text = String(r.text || '').toLowerCase();
      const section = String(r.section || '').toLowerCase();
      const id = String(r.id || '').toLowerCase();
      const tags = Array.isArray(r.tags) ? r.tags.join(' ').toLowerCase() : String(r.tags || '').toLowerCase();

      const matched = title.includes(q) || text.includes(q) || section.includes(q) || id.includes(q) || tags.includes(q);
      if (!matched) continue;
    }

    matches.push(r);
    if (matches.length >= limit) {
      if (totalScanned < records.length) truncated = truncated || 'limit';
      break;
    }
  }

  return { matches, totalScanned, truncated };
}

// ---- Retention (prune / rotate). Atomic: write temp file then rename. ----

const DAY_MS = 86400000;

/** Reject paths escaping `root` (when given); returns resolved absolute path. */
function guardPath(file, root) {
  if (!file || typeof file !== 'string') throw new Error('invalid path');
  const abs = path.resolve(file);
  if (!root || typeof root !== 'string') throw new Error('root bat buoc cho thao tac xoa/ghi de (prune/rotate)');
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes root: ${file}`);
  }
  return abs;
}

function atomicWrite(abs, text) {
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, abs); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

const nowMs = (n) => (n instanceof Date ? n.getTime() : (n ?? Date.now()));

/**
 * Prune records by age and/or count (keeps newest). Returns {kept, removed, truncated}.
 * If the file exceeds maxBytes or timeoutMs hits, nothing is written and truncated is set.
 */
export function pruneRecords(file, options = {}) {
  const { maxAgeDays, maxRecords, tsField = 'ts', dryRun = false, root } = options;
  const maxBytes = options.maxBytes ?? STORE_DEFAULTS.maxBytes * 8;
  const timeoutMs = options.timeoutMs ?? STORE_DEFAULTS.timeoutMs;
  const now = nowMs(options.now);
  const abs = guardPath(file, root);
  const t0 = Date.now();
  if (!fs.existsSync(abs)) return { kept: 0, removed: 0, truncated: null };
  if (fs.statSync(abs).size > maxBytes) return { kept: 0, removed: 0, truncated: 'max_bytes' };

  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  let keep = [];
  for (const line of lines) {
    if (Date.now() - t0 > timeoutMs) return { kept: 0, removed: 0, truncated: 'timeout' };
    let drop = false;
    if (maxAgeDays > 0) {
      try {
        const t = Date.parse(JSON.parse(line)[tsField]);
        if (Number.isFinite(t) && now - t > maxAgeDays * DAY_MS) drop = true;
      } catch { /* unparsable line: keep */ }
    }
    if (!drop) keep.push(line);
  }
  if (maxRecords > 0 && keep.length > maxRecords) keep = keep.slice(keep.length - maxRecords);
  const removed = lines.length - keep.length;
  if (removed > 0 && !dryRun) atomicWrite(abs, keep.join('\n') + (keep.length ? '\n' : ''));
  return { kept: keep.length, removed, truncated: null };
}

/** If file > maxBytes, keep the newest whole lines fitting in ~half of maxBytes. */
export function rotateFile(file, options = {}) {
  const maxBytes = options.maxBytes ?? STORE_DEFAULTS.maxBytes;
  const abs = guardPath(file, options.root);
  if (!fs.existsSync(abs)) return { kept: 0, removed: 0, truncated: null };
  const size = fs.statSync(abs).size;
  const readCap = options.readMaxBytes ?? maxBytes * 4;
  if (size > readCap) return { kept: 0, removed: 0, truncated: 'max_bytes' };
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  if (size <= maxBytes) return { kept: lines.length, removed: 0, truncated: null };
  const target = Math.floor(maxBytes / 2);
  let total = 0;
  let start = lines.length;
  while (start > 0 && total + Buffer.byteLength(lines[start - 1]) + 1 <= target) {
    start--;
    total += Buffer.byteLength(lines[start]) + 1;
  }
  const keep = lines.slice(start);
  if (!options.dryRun) atomicWrite(abs, keep.join('\n') + (keep.length ? '\n' : ''));
  return { kept: keep.length, removed: lines.length - keep.length, truncated: null };
}

/**
 * Apply retention caps to <dir>/{events,digests,runs,baselines}. Only touches regular files
 * inside dir (symlinks skipped). caps = overrides for resolveCaps.
 */
export function pruneDir(dir, options = {}) {
  const { caps, dryRun = false } = options;
  const now = nowMs(options.now);
  const timeoutMs = options.timeoutMs ?? STORE_DEFAULTS.timeoutMs;
  if (!options.root) throw new Error('pruneDir: root bat buoc');
  const root = path.resolve(dir);
  const relDir = path.relative(path.resolve(options.root), root); // dir phai nam trong (hoac bang) options.root
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) throw new Error(`pruneDir: dir ngoai root: ${dir}`);
  const ret = resolveCaps(caps).retention;
  const t0 = Date.now();
  const out = { kept: 0, removed: 0, truncated: null, files: [] };
  const plan = [
    ['events', ret.eventsDays, 'jsonl'], ['digests', ret.digestsDays, 'jsonl'],
    ['runs', ret.runsDays, 'age'], ['baselines', ret.baselinesKeep, 'keep'],
  ];
  const listFiles = (sub) => {
    const d = path.join(root, sub);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).map((n) => path.join(d, n)).filter((p) => {
      try { guardPath(p, root); return fs.lstatSync(p).isFile(); } catch { return false; }
    });
  };
  const rm = (p) => { if (!dryRun) fs.unlinkSync(p); out.removed++; out.files.push(path.relative(root, p)); };
  for (const [sub, val, mode] of plan) {
    const files = listFiles(sub);
    if (mode === 'keep') {
      files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      files.slice(val).forEach(rm);
      out.kept += Math.min(files.length, val);
      continue;
    }
    for (const f of files) {
      if (Date.now() - t0 > timeoutMs) { out.truncated = 'timeout'; return out; }
      if (mode === 'jsonl' && f.endsWith('.jsonl')) {
        const r = pruneRecords(f, { maxAgeDays: val, now, dryRun, root, timeoutMs: timeoutMs - (Date.now() - t0) });
        out.kept += r.kept; out.removed += r.removed;
        if (r.truncated) out.truncated = r.truncated;
        if (r.removed) out.files.push(path.relative(root, f));
      } else if (now - fs.statSync(f).mtimeMs > val * DAY_MS) rm(f);
      else out.kept++;
    }
  }
  return out;
}
