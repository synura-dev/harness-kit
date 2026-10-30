// Cat tia phan vung audit: v2 date=/type= va v1 (cu) type=/date=.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const typeOk = (f, type) => !f.type || [].concat(f.type).includes(type);
const dateOk = (f, date) => !(f.date && date !== f.date) && !(f.since && date < f.since) && !(f.until && date > f.until);
export function listFiles(root, f = {}) {
  const out = [];
  if (!existsSync(root)) return out;
  const dirs = (p) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory());
  const add = (dir, type, date) => {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      if (f.session && !(file === f.session + '.jsonl' || file.startsWith(f.session + '.'))) continue;
      out.push({ path: join(dir, file), type, date });
    }
  };
  for (const a of dirs(root)) {
    if (a.name.startsWith('date=')) { // v2
      const date = a.name.slice(5);
      if (!dateOk(f, date)) continue;
      for (const t of dirs(join(root, a.name))) {
        if (!t.name.startsWith('type=')) continue;
        const type = t.name.slice(5);
        if (typeOk(f, type)) add(join(root, a.name, t.name), type, date);
      }
    } else if (a.name.startsWith('type=')) { // v1
      const type = a.name.slice(5);
      if (!typeOk(f, type)) continue;
      for (const d of dirs(join(root, a.name))) {
        if (!d.name.startsWith('date=')) continue;
        const date = d.name.slice(5);
        if (dateOk(f, date)) add(join(root, a.name, d.name), type, date);
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
