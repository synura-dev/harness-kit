// Tien ich dung chung cho adapter (khong phai adapter). Khong dependency.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../../core/agy/agents.mjs';

export { parseFrontmatter };

export const MARK = 'GENERATED - do not edit';

export const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
export const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
export const listDirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };
export const listDirFiles = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort(); } catch { return []; } };
export const rel = (root, f) => path.relative(root, f).replace(/\\/g, '/');

// Ghi neu khac. check=true: khong ghi. Tra ve true neu co thay doi/lech.
export function writeIfChanged(file, content, check) {
  if (read(file) === content) return false;
  if (!check) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  return true;
}

export const withHeader = (text, source) => {
  const fm = parseFrontmatter(text);
  const h = `<!-- ${MARK}: sinh tu ${source} boi tools/sync.mjs -->`;
  if (!fm) return `${h}\n${text}`;
  return `${fm.fmRaw}\n${h}\n${fm.body.replace(/^(\r?\n)+/, '')}`;
};

// File sinh = dong header (do withHeader tao) nam o dau than file (sau frontmatter neu co); nhac MARK trong than khong tinh.
export const isGenerated = (text) => {
  text = String(text || '');
  const fm = parseFrontmatter(text);
  const body = (fm ? fm.body : text).replace(/^(\r?\n)+/, '');
  return body.startsWith(`<!-- ${MARK}`);
};
