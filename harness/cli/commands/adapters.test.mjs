import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, registeredFiles, formatAdaptersTable, markdownTable, applyReadme } from '../../core/agy/adapters-report.mjs';

const mk = (units, settings, agy) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  // Tuong minh: config doc tu fixture <r>/config (plugin mode mac dinh doc lop plugin/may/du an).
  process.env.HARNESS_CONFIG_DIR = path.join(r, 'config');
  const w = (rel, s = '') => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), s); };
  for (const u of units) w(`${u.path}/manifest.json`, JSON.stringify({ id: u.id, kind: 'hook', adapters: u.adapters }));
  if (settings) w('.claude/settings.json', JSON.stringify(settings));
  if (agy) w('.agents/hooks.json', JSON.stringify(agy));
  return { r, w };
};
const cmd = (c) => ({ hooks: { X: [{ hooks: [{ type: 'command', command: c }] }] } });

test('registeredFiles bat ca duong dan claude va agy', () => {
  const s = registeredFiles({ a: [{ command: 'node "$CLAUDE_PROJECT_DIR/harness/hooks/g/hook.mjs" sweep' }], b: { command: 'node ../harness/hooks/g/adapters/agy.mjs pre' } });
  expect([...s].sort()).toEqual(['g/adapters/agy.mjs', 'g/hook.mjs']);
});

test('bang dung, khong canh bao khi khop', () => {
  const { r, w } = mk([{ id: 'hook-g', kind: 'hook', path: 'harness/hooks/g', adapters: { claude: 'native', agy: 'adapters/agy.mjs' } }], cmd('node x/harness/hooks/g/hook.mjs'), { g: { PreToolUse: [{ type: 'command', command: 'node ../harness/hooks/g/adapters/agy.mjs' }] } });
  w('harness/hooks/g/hook.mjs'); w('harness/hooks/g/adapters/agy.mjs');
  const rep = buildReport(r);
  expect(rep.warnings).toEqual([]);
  expect(formatAdaptersTable(rep.rows)).toContain('adapters/agy.mjs [dk]');
});

test('canh bao: adapter thieu file, file lac, none co file, dang ky ngoai manifest', () => {
  const { r, w } = mk([{ id: 'hook-g', kind: 'hook', path: 'harness/hooks/g', adapters: { claude: 'native', agy: 'none' } }, { id: 'hook-h', kind: 'hook', path: 'harness/hooks/h', adapters: { claude: 'adapters/claude.mjs', agy: 'n/a' } }], cmd('node harness/hooks/zz/hook.mjs'), null);
  w('harness/hooks/g/adapters/agy.mjs');
  const m = buildReport(r).warnings.join('\n');
  expect(m).toContain('co file adapters/agy.mjs nhung manifest ghi agy=none');
  expect(m).toContain('adapters/claude.mjs nhung file khong ton tai');
  expect(m).toContain('dang ky file khong ton tai: harness/hooks/zz/hook.mjs');
});

test('canh bao kieu cu: agy_adapter.mjs canh hook, adapters/ chua khai bao, agy_*.mjs le', () => {
  const { r, w } = mk([{ id: 'hook-g', kind: 'hook', path: 'harness/hooks/g', adapters: { claude: 'native', agy: 'agy_adapter.mjs' } }, { id: 'hook-h', kind: 'hook', path: 'harness/hooks/h', adapters: { claude: 'native', agy: 'none' } }], cmd('node x/harness/hooks/g/hook.mjs'), null);
  w('harness/hooks/g/hook.mjs'); w('harness/hooks/g/adapters/agy.mjs'); w('harness/hooks/h/adapters/foo.mjs'); w('harness/hooks/h/agy_y.mjs');
  const m = buildReport(r).warnings.join('\n');
  expect(m).toContain('kieu cu agy_adapter.mjs');
  expect(m).toContain('co adapters/foo.mjs nhung manifest khong khai bao');
  expect(m).toContain('file le agy_y.mjs');
});

test('manifest hong -> canh bao, khong nem loi', () => {
  expect(buildReport(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'))).warnings.length).toBe(1);
});

test('CLI thu ba khai bao trong config/tools.json duoc nhan ra, khong sua code', () => {
  const { r, w } = mk([{ id: 'hook-g', kind: 'hook', path: 'harness/hooks/g', adapters: { claude: 'native', agy: 'none', x: 'adapters/x.mjs' } }], cmd('node harness/hooks/g/hook.mjs'), null);
  w('config/tools.json', JSON.stringify({ tools: { claude: {}, agy: {}, x: { hookRegistration: 'x/reg.json' } } }));
  w('x/reg.json', JSON.stringify({ g: [{ command: 'node ../harness/hooks/g/adapters/x.mjs' }] }));
  w('harness/hooks/g/hook.mjs'); w('harness/hooks/g/adapters/x.mjs');
  const rep = buildReport(r);
  expect(rep.clis).toEqual(['claude', 'agy', 'x']);
  expect(rep.rows[0].registered.x).toEqual(['adapters/x.mjs']);
  expect(formatAdaptersTable(rep.rows, rep.clis)).toContain('adapters/x.mjs [dk]');
  expect(rep.warnings.join('\n')).not.toContain('adapters/x.mjs nhung');
});

test('bang README sinh giua marker, khong co marker -> null', () => {
  const rows = [{ hook: 'g', claude: 'native', agy: 'n/a', note: 'a|b', registered: { claude: ['hook.mjs'], agy: [] } }];
  const tb = markdownTable(rows, ['claude', 'agy']);
  expect(tb).toContain('| `g` | native [dk] | n/a | a\\|b |');
  const t = applyReadme('x\n<!-- GENERATED:adapters -->\nOLD\n<!-- /GENERATED -->\ny', tb);
  expect(t).toContain(tb); expect(t).not.toContain('OLD'); expect(t.endsWith('y')).toBe(true);
  expect(applyReadme('khong marker', tb)).toBeNull();
});

afterAll(() => { delete process.env.HARNESS_CONFIG_DIR; });
