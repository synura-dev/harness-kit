// Ham thuan: chuan hoa thong diep loi/lenh thanh "chu ky" on dinh (bo duong dan, id, so, timestamp). Khong I/O. Dung lai cho chu ky lenh.
import { createHash } from 'node:crypto';

const QUOTED_PATH = /(["'`])(?:[^"'`\r\n]*[\\/])[^"'`\r\n]*\1/g;
const WIN_ABS = /[A-Za-z]:[\\/][^\r\n"'<>|*?]*?\.[A-Za-z0-9]{1,6}(?![\w])|[A-Za-z]:[\\/][^\s"'<>|*?,;)]*/g;
const REL_DOT = /(?<![\w.])\.{1,2}[\\/][^\s"'<>|*?,;)]*/g;
const WIN_SEG = /(?<![\w<])[\w.@~+-]+(?:\\[\w.@~+-]+)+/g;
const UNIX_ABS = /(?<![\w.:<])\/(?:[\w.@~+-]+\/)*[\w.@~+-]+/g;
const UNIX_REL = /(?<![\w.:<\\])[\w.@~+-]+(?:\/[\w.@~+-]+)+/g;

export const TRUNC_PREFIX_MIN = 80; // chi gop ban bi cat "..." voi ban day du khi tien to >= 80 ky tu

/** Chuan hoa DAY DU (khong cat do dai). Tra {text, truncated}: truncated = thong diep goc ket thuc bang "..." (bi cat boi nguon). */
export function normalizeFull(text) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(QUOTED_PATH, '<path>').replace(WIN_ABS, '<path>').replace(REL_DOT, '<path>')
    .replace(WIN_SEG, '<path>').replace(UNIX_ABS, '<path>').replace(UNIX_REL, '<path>');
  s = s.replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, '<ts>').replace(/\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/g, '<ts>');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
  s = s.replace(/\bagent-[0-9a-z]{6,}\b/gi, '<id>');
  s = s.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, '<id>');
  s = s.replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g, '<id>');
  s = s.replace(/\d+/g, 'N');
  s = s.replace(/(?:<path>[\s,.;:]*){2,}/g, '<path> ').replace(/\s+/g, ' ').trim();
  const truncated = /(?:\.{2,}|\u2026)\s*$/.test(s);
  if (truncated) s = s.replace(/(?:\.{2,}|\u2026)\s*$/, '').trim();
  return { text: s, truncated };
}

/** Chuan hoa de HIEN THI: thay duong dan/id/so/timestamp bang token co dinh, cat con `max` ky tu (mac dinh 50). Khong dung de bam. */
export function normalizeMessage(text, max = 50) {
  return normalizeFull(text).text.slice(0, max).trim();
}

/** Dau van tay 10 hex tu (tool, thong diep chuan hoa DAY DU). Rong -> null. */
export function messageFingerprint(text, tool = '') {
  const n = normalizeFull(text).text;
  if (!n) return null;
  return createHash('sha1').update(String(tool || '') + '|' + n).digest('hex').slice(0, 10);
}
