import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyFindings, legacySummary } from './legacy.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
const put = (d, rel, s = '{}') => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

test('thu muc sach -> [] va summary null', () => {
  const d = tmp();
  expect(legacyFindings(d)).toEqual([]);
  expect(legacySummary(d)).toBeNull();
});
test('hooks.json co khoa harness-kit -> 1 phat hien; khong khoa -> sach', () => {
  const d = tmp();
  put(d, '.agents/hooks.json', '{"other":[]}');
  expect(legacyFindings(d)).toEqual([]);
  put(d, '.agents/hooks.json', '{"harness-kit":[]}');
  expect(legacyFindings(d).length).toBe(1);
});
test('shim, local.json, clone plugin -> moi cai mot phat hien', () => {
  const d = tmp();
  put(d, '.agents/harness-agy-shim.mjs');
  put(d, '.agents/harness-agy.local.json');
  put(d, '.agents/plugins/harness-kit/x.txt');
  expect(legacyFindings(d).length).toBe(3);
});
test('summary: mot chuoi [warn] gop, co huong dan xoa tay, khong tu xoa', () => {
  const d = tmp();
  put(d, '.agents/hooks.json', '{"harness-kit":[]}');
  put(d, '.agents/harness-agy-shim.mjs');
  const s = legacySummary(d);
  expect(typeof s).toBe('string');
  expect(s.startsWith('[warn]')).toBe(true);
  expect(s).not.toContain('\n');
  expect(s).toContain('harness-agy-shim.mjs');
  expect(s).toContain('xoa');
  expect(fs.existsSync(path.join(d, '.agents', 'harness-agy-shim.mjs'))).toBe(true);
});
