// Check tat dinh: file ngoai helper core/runtime/proc.mjs khong duoc import/goi truc tiep child_process (tranh bat cua so console tren Windows).
import fs from 'node:fs';
import path from 'node:path';

/** Ngoai le (duong dan tuong doi, / phan cach) + ly do. Giu ngan. */
export const PROC_EXCEPTIONS = {
  'harness/core/runtime/proc.mjs': 'chinh helper',
  'harness/core/ext/ext-supervisor.mjs': 'giam sat tien trinh con ext: tu tinh timeout + giet cay, da windowsHide',
  'harness/hooks/dispatch/agy-shim.mjs': 'shim doc lap duoc copy ra .agents, khong import duoc tuong doi; da windowsHide',
  'harness/hooks/dispatch/agy-native.mjs': 'hook agy native: timeout con < timeout hooks.json, khong killTree dong bo (taskkill toi 10s); da windowsHide',
  'harness/core/runtime/user-shim.mjs': 'chuoi sinh file shim cho nguoi dung (khong phai goi cua repo)',
};

const RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]|\bBun\.spawn(?:Sync)?\s*\(/;

/** Thuan: files [{path, text}] -> [{file, line}] vi pham (bo qua .test.mjs, fixtures, ngoai le). */
export function checkProcDirect(files, exceptions = PROC_EXCEPTIONS) {
  const out = [];
  for (const f of files) {
    const p = f.path.replace(/\\/g, '/');
    if (/\.test\.(mjs|js|cjs)$/.test(p) || /(^|\/)fixtures?\//.test(p) || exceptions[p]) continue;
    const lines = String(f.text).split('\n');
    for (let i = 0; i < lines.length; i++) if (RE.test(lines[i]) && !/^\s*\/\//.test(lines[i])) out.push({ file: p, line: i + 1 });
  }
  return out;
}

/** Quet cay `root` (chi harness/ + bin/ + hooks/, toi da maxFiles) -> vi pham. */
export function scanProcDirect(root, { maxFiles = 3000, exceptions = PROC_EXCEPTIONS } = {}) {
  const files = [];
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (files.length >= maxFiles) return;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|cjs)$/.test(e.name)) { try { files.push({ path: path.relative(root, p), text: fs.readFileSync(p, 'utf8') }); } catch {} }
    }
  };
  for (const d of ['harness', 'bin', 'hooks']) walk(path.join(root, d));
  return checkProcDirect(files, exceptions);
}
