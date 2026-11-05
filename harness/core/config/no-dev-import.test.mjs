import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('khong file nao ngoai dev/ import dev/', () => {
  const bad = [];
  for (const dir of ['harness', 'hooks', 'bin']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      if (!/\.(mjs|js|cjs)$/.test(f) || /\.test\.mjs$/.test(f)) continue;
      const txt = fs.readFileSync(f, 'utf8');
      if (/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)(?:new URL\()?['"`][^'"`]*(?:^|[\\/])dev[\\/][^'"`]*['"`]/m.test(txt)) bad.push(path.relative(ROOT, f));
    }
  }
  expect(bad).toEqual([]);
});
