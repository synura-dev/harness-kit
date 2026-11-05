import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const reg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'registry.json'), 'utf8'));

test('entry play thuoc loi (harness/tools/play), giu path/class/retention', () => {
  const p = reg.entries.play;
  expect(p.owner).toBe('harness/tools/play');
  expect(p).toMatchObject({ zone: 'system', class: 'log', retentionDays: 14, path: 'system/play', target: 'system/play' });
});

test('khong entry loi nao co owner hub/play', () => {
  expect(Object.values(reg.entries).some((e) => /^hub\/play\b/.test(String(e.owner)))).toBe(false);
});
