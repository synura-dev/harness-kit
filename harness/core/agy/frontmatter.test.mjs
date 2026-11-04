import { test, expect } from 'bun:test';
import { parseFrontmatter } from './agents.mjs';

test('parseFrontmatter tach data va body', () => {
  const r = parseFrontmatter('---\nname: "x"\nmodel: opus\n---\nbody');
  expect(r.data).toEqual({ name: 'x', model: 'opus' });
  expect(r.body).toBe('body');
});
test('parseFrontmatter khong co -> null', () => {
  expect(parseFrontmatter('no fm')).toBeNull();
});
