import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prunePlayRuns } from './playbook/run.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slim2-'));
const put = (root, rel, obj) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); };

test('prunePlayRuns: nonexistent config/play.json -> default retention, no throw', () => {
  const root = mk();
  const r = prunePlayRuns({ hub: root });
  expect(r.mode).toBe('dry-run');
  expect(Number.isInteger(r.days) && r.days >= 1).toBe(true);
});

test('prunePlayRuns: retention_days from config/play/default.json; invalid falls back', () => {
  const root = mk();
  put(root, 'config/play/default.json', { retention_days: 5 });
  expect(prunePlayRuns({ hub: root }).days).toBe(5);
  const root2 = mk();
  put(root2, 'config/play/default.json', { retention_days: 0 });
  expect(prunePlayRuns({ hub: root2 }).days).toBeGreaterThanOrEqual(1);
});
