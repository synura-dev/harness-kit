// Tien ich dung chung cho audit-review: dinh dang, doc file co tran, quet jsonl.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../../../core/io/paths.mjs';
import { fmtDur } from '../../../core/io/fmt.mjs';
import { collectJsonlFiles } from '../../../core/audit/scan.mjs';

export { fmtDur, collectJsonlFiles };


export const fmtTok = (n) => {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
};

// Thu muc tam: os.tmpdir() va thu muc tam co dinh (.gemini); khong doan theo ten 'temp'/'tmp'.
export function isTempPath(target, tmpdir = os.tmpdir()) {
  if (!target) return false;
  const norm = String(target).split(path.sep).join('/').split('\\').join('/');
  return isInside(target, tmpdir) || /\/\.gemini\//i.test(norm);
}

// Doc toi da maxBytes CUOI file (su kien moi nhat), bo dong dau bi cat do; tra { text, truncated }.
export function readCapped(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, maxBytes);
    const buf = Buffer.alloc(n);
    const got = n ? fs.readSync(fd, buf, 0, n, size - n) : 0;
    let text = buf.toString('utf8', 0, got);
    const truncated = size > maxBytes;
    if (truncated) { const i = text.indexOf('\n'); text = i >= 0 ? text.slice(i + 1) : ''; }
    return { text, truncated };
  } finally { fs.closeSync(fd); }
}

