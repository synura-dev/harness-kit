// Tien ich stdin/stdout dung chung cho hook/adapter (dong bo, fail-open). Hook constrain/observe import tu day thay vi chep ban rieng.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Doc stdin dong bo -> object JSON. Bo BOM; rong/loi/khong phai JSON -> {}. */
export function readJsonStdin() {
  try {
    let raw = fs.readFileSync(0, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/** true khi file goi (import.meta.url) la entry cua tien trinh; false khi duoc import. */
export function isMain(importMetaUrl) {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}

/** Ghi stdout dong bo (tranh cat output pipe tren Windows khi exit ngay). Loi -> bo qua. */
export function writeOut(str) {
  try { fs.writeSync(1, String(str)); } catch {}
}
