import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const SKILLS = path.join(ROOT, 'skills');

test('moi skills/*/SKILL.md co frontmatter YAML hop le, name+description khong rong', () => {
  const dirs = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory());
  expect(dirs.length).toBeGreaterThan(0);
  for (const d of dirs) {
    const file = path.join(SKILLS, d.name, 'SKILL.md');
    const m = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(m, `${d.name}: thieu frontmatter`).not.toBeNull();
    let fm;
    try { fm = Bun.YAML.parse(m[1]); } catch (e) { throw new Error(`${d.name}: YAML loi: ${e.message}`); }
    expect(typeof fm.name === 'string' && fm.name.trim() !== '', `${d.name}: name rong`).toBe(true);
    expect(fm.name).toBe(d.name);
    expect(typeof fm.description === 'string' && fm.description.trim() !== '', `${d.name}: description rong`).toBe(true);
  }
});
