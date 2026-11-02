import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put, query, context, map, resolveRoot } from './vault.mjs';
import { syncIndex } from './index.mjs';
import { run } from './cli.mjs';
import { dataPathFor } from '../../core/io/storage.mjs';

const NOW = '2026-10-30';
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-ctx-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const P = (input, o = {}) => put(input, { root, now: NOW, ...o });

test('multi-scope trong query: OR filter, tuong thich 1 scope', () => {
  expect(P({ meta: { id: 'scope-a', kind: 'fact', scope: 'project:alpha' }, body: 'Fact A.' }).ok).toBe(true);
  expect(P({ meta: { id: 'scope-b', kind: 'fact', scope: 'project:beta' }, body: 'Fact B.' }).ok).toBe(true);
  expect(P({ meta: { id: 'scope-c', kind: 'fact', scope: 'project:gamma' }, body: 'Fact C.' }).ok).toBe(true);

  // Mang scope: tra ve ca alpha va beta (OR)
  const qMulti = query({ scope: ['project:alpha', 'project:beta'] }, { root, now: NOW });
  expect(qMulti.items.map((x) => x.id).sort()).toEqual(['scope-a', 'scope-b']);

  // 1 scope chuoi don: giu tuong thich
  const qSingle = query({ scope: 'project:gamma' }, { root, now: NOW });
  expect(qSingle.items.map((x) => x.id)).toEqual(['scope-c']);

  // CLI voi nhieu --scope (lap lai hoac dau phay)
  const out1 = [];
  const r1 = run(['query', '--scope', 'project:alpha', '--scope', 'project:gamma', '--root', root, '--now', NOW], { out: (s) => out1.push(s), err: () => {} });
  expect(r1.code).toBe(0);
  expect(out1.join('\n')).toContain('scope-a');
  expect(out1.join('\n')).toContain('scope-c');
  expect(out1.join('\n')).not.toContain('scope-b');

  const out2 = [];
  const r2 = run(['query', '--scope', 'project:beta,project:gamma', '--root', root, '--now', NOW], { out: (s) => out2.push(s), err: () => {} });
  expect(r2.code).toBe(0);
  expect(out2.join('\n')).toContain('scope-b');
  expect(out2.join('\n')).toContain('scope-c');
});

test('context: scope OR nhieu pham vi', () => {
  P({ meta: { id: 'rule-alpha', kind: 'rule', scope: 'project:alpha', status: 'active' }, body: 'Quy tac alpha.' });
  P({ meta: { id: 'rule-beta', kind: 'rule', scope: 'project:beta', status: 'active' }, body: 'Quy tac beta.' });
  P({ meta: { id: 'rule-other', kind: 'rule', scope: 'project:other', status: 'active' }, body: 'Quy tac other.' });

  const res = context({ scope: ['project:alpha', 'project:beta'] }, { root, now: NOW });
  const ids = res.items.map((x) => x.id).sort();
  expect(ids).toEqual(['rule-alpha', 'rule-beta']);

  // CLI context voi nhieu --scope
  const out = [];
  const r = run(['context', '--scope', 'project:alpha', '--scope', 'project:beta', '--root', root, '--now', NOW], { out: (s) => out.push(s), err: () => {} });
  expect(r.code).toBe(0);
  expect(out.join('\n')).toContain('rule-alpha');
  expect(out.join('\n')).toContain('rule-beta');
  expect(out.join('\n')).not.toContain('rule-other');
});

test('context: co --text cham diem id/tag=3, line/source=1, minScore, rule xep truoc', () => {
  // note-rule: khop 1 tu khoa manh o id -> diem 3, kind=rule
  P({ meta: { id: 'audit-rule', kind: 'rule', scope: 'global', status: 'active' }, body: 'Chi tiet audit rule.' });
  // note-fact-high: khop 2 tu khoa manh o tag -> diem 6, kind=fact
  P({ meta: { id: 'some-fact', kind: 'fact', scope: 'global', status: 'active', tags: ['audit', 'system'] }, body: 'Audit system info.' });
  // note-weak: khop 1 tu khoa yeu o source -> diem 1 (< minScore 2) -> bi loai
  P({ meta: { id: 'weak-fact', kind: 'fact', scope: 'global', status: 'active', source: 'audit-log' }, body: 'Noi dung khong khop.' });

  const res = context({ scope: 'global', text: 'audit system' }, { root, now: NOW });
  // weak-fact bi loai vi score=1 < minScore 2
  expect(res.items.map((x) => x.id)).toEqual(['audit-rule', 'some-fact']);
  // audit-rule (diem 3) xep truoc some-fact (diem 6) vi rule luon xep truoc
  expect(res.items[0].id).toBe('audit-rule');
  expect(res.items[0].score).toBe(3);
  expect(res.items[1].id).toBe('some-fact');
  expect(res.items[1].score).toBe(6);
});

test('context: khong co --text xep theo kind(rule>lesson>decision>fact>ref) roi updated moi nhat', () => {
  P({ meta: { id: 'fact-1', kind: 'fact', scope: 'global', status: 'active' }, body: 'Fact 1' }, { now: '2026-10-01' });
  P({ meta: { id: 'rule-1', kind: 'rule', scope: 'global', status: 'active' }, body: 'Rule 1' }, { now: '2026-10-05' });
  P({ meta: { id: 'ref-1', kind: 'ref', scope: 'global', status: 'active', quote: 'Ref quote' }, body: 'Ref 1' }, { now: '2026-10-20' });
  P({ meta: { id: 'lesson-1', kind: 'lesson', scope: 'global', status: 'active' }, body: 'Lesson 1' }, { now: '2026-10-10' });
  P({ meta: { id: 'decision-1', kind: 'decision', scope: 'global', status: 'active' }, body: 'Decision 1' }, { now: '2026-10-15' });
  P({ meta: { id: 'lesson-2', kind: 'lesson', scope: 'global', status: 'active' }, body: 'Lesson 2 (moi hon)' }, { now: '2026-10-25' });

  const res = context({ scope: 'global', limit: 10 }, { root, now: NOW });
  // Thu tu kind: rule > lesson > decision > fact > ref
  // Giua 2 lesson: lesson-2 (2026-10-25) moi hon lesson-1 (2026-10-10)
  expect(res.items.map((x) => x.id)).toEqual([
    'rule-1',
    'lesson-2',
    'lesson-1',
    'decision-1',
    'fact-1',
    'ref-1',
  ]);
});

test('context: kind=ref chi hien id + quote (khong nap body)', () => {
  const secretRefBody = 'SECRET_BODY_NEVER_APPEAR_12345';
  P({
    meta: { id: 'api-ref', kind: 'ref', scope: 'project:p1', status: 'active', quote: 'API docs at https://api.example.com' },
    body: secretRefBody,
  });
  P({
    meta: { id: 'standard-rule', kind: 'rule', scope: 'project:p1', status: 'active' },
    body: 'Rule body text must be visible.',
  });

  const res = context({ scope: 'project:p1' }, { root, now: NOW });
  expect(res.md).toContain('api-ref [ref]');
  expect(res.md).toContain('> API docs at https://api.example.com');
  expect(res.md).not.toContain(secretRefBody);

  // Trong items JSON: kind=ref khong co truong body
  const refItem = res.items.find((x) => x.id === 'api-ref');
  expect(refItem.quote).toBe('API docs at https://api.example.com');
  expect(refItem.body).toBeUndefined();

  // kind khac: co truong body
  const ruleItem = res.items.find((x) => x.id === 'standard-rule');
  expect(ruleItem.body).toBe('Rule body text must be visible.');
});

test('context: gioi han max-chars cat bot noi dung vuot tran', () => {
  P({ meta: { id: 'long-note-1', kind: 'rule', scope: 'project:p1', status: 'active' }, body: 'A'.repeat(500) });
  P({ meta: { id: 'long-note-2', kind: 'rule', scope: 'project:p1', status: 'active' }, body: 'B'.repeat(500) });
  P({ meta: { id: 'long-note-3', kind: 'rule', scope: 'project:p1', status: 'active' }, body: 'C'.repeat(500) });

  // maxChars = 600: chi du cho 1 note (khoang 520 ky tu ca header)
  const res = context({ scope: 'project:p1', maxChars: 600 }, { root, now: NOW });
  expect(res.items.length).toBe(1);
  expect(res.items[0].id).toBe('long-note-1');
  expect(res.md.length).toBeLessThanOrEqual(600);
});

test('context: loc status active, bo stale va bo secret', () => {
  // active hop le
  P({ meta: { id: 'clean-rule', kind: 'rule', scope: 'project:p1', status: 'active' }, body: 'Sach se.' });
  // archived: bi bo
  P({ meta: { id: 'archived-rule', kind: 'rule', scope: 'project:p1', status: 'archived' }, body: 'Da cu.' });
  // stale: recheck qua han -> bi bo
  P({ meta: { id: 'stale-rule', kind: 'rule', scope: 'project:p1', status: 'active', recheck: '2026-01-01' }, body: 'Het han.' });
  // file tay chua secret -> bi bo
  fs.mkdirSync(path.join(root, 'rule'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rule', 'secret-rule.md'), `---\nid: secret-rule\nkind: rule\nscope: project:p1\nstatus: active\napi_key: abcdef123456\n---\nKey la bi mat.\n`);

  const res = context({ scope: 'project:p1' }, { root, now: NOW });
  expect(res.items.map((x) => x.id)).toEqual(['clean-rule']);
});

test('goc vault mac dinh: dataPathFor memory tro ve knowledge/memory', () => {
  const memPath = dataPathFor('memory');
  expect(memPath.replace(/\\/g, '/')).toMatch(/knowledge\/memory$/);

  // resolveRoot khi khong truyen gi tro ve goc memory mac dinh
  const defaultVault = resolveRoot();
  expect(defaultVault.replace(/\\/g, '/')).toMatch(/knowledge\/memory$/);
});

test('CLI context: --format json va kiem tra thieu --scope', () => {
  P({ meta: { id: 'json-rule', kind: 'rule', scope: 'project:demo', status: 'active' }, body: 'Content.' });

  // Thieu --scope -> bao loi code 2
  const errOut = [];
  const rErr = run(['context', '--root', root], { out: () => {}, err: (s) => errOut.push(s) });
  expect(rErr.code).toBe(2);
  expect(errOut.join('\n')).toContain('thieu --scope');

  // Co --format json -> xuat JSON hop le
  const jsonOut = [];
  const rOk = run(['context', '--scope', 'project:demo', '--format', 'json', '--root', root, '--now', NOW], { out: (s) => jsonOut.push(s), err: () => {} });
  expect(rOk.code).toBe(0);
  const parsed = JSON.parse(jsonOut.join('\n'));
  expect(parsed.total).toBe(1);
  expect(parsed.items[0].id).toBe('json-rule');
  expect(parsed.items[0].body).toBe('Content.');
});

test('context compact: khong nap full body, 1 dong - [id] (kind:tags): quote + footer huong dan, <= 600 chars', () => {
  P({
    meta: { id: 'compact-rule', kind: 'rule', scope: 'project:p1', status: 'active', tags: ['auth', 'security'], quote: 'Rule compact quote' },
    body: 'VERY_LONG_BODY_LINE_1\nVERY_LONG_BODY_LINE_2\nVERY_LONG_BODY_LINE_3',
  });
  P({
    meta: { id: 'compact-fact', kind: 'fact', scope: 'project:p1', status: 'active' },
    body: 'First line fact title\nSecond line fact body',
  });

  // compact = true
  const res = context({ scope: 'project:p1', compact: true }, { root, now: NOW });
  expect(res.items.length).toBe(2);
  expect(res.text).toContain('- [compact-rule] (rule:auth,security): Rule compact quote');
  expect(res.text).toContain('- [compact-fact] (fact): First line fact title');
  expect(res.text).toContain('Chi tiet: harness knowledge get <id>');
  expect(res.text).not.toContain('VERY_LONG_BODY_LINE_1');
  expect(res.text).not.toContain('Second line fact body');
  expect(res.text.length).toBeLessThanOrEqual(600);

  // CLI voi co --compact
  const out = [];
  const r = run(['context', '--scope', 'project:p1', '--compact', '--root', root, '--now', NOW], { out: (s) => out.push(s), err: () => {} });
  expect(r.code).toBe(0);
  const outStr = out.join('\n');
  expect(outStr).toContain('- [compact-rule] (rule:auth,security): Rule compact quote');
  expect(outStr).toContain('Chi tiet: harness knowledge get <id>');
  expect(outStr).not.toContain('VERY_LONG_BODY_LINE_1');
  expect(outStr.length).toBeLessThanOrEqual(600);
});

test('map va CLI knowledge map: gom gon tu .index.json, parsedCount === 0 khi cache hit', () => {
  P({
    meta: { id: 'map-rule-1', kind: 'rule', scope: 'global', status: 'active', tags: ['core', 'sys'], quote: 'Rule 1 quote' },
    body: 'Body rule 1',
  });
  P({
    meta: { id: 'map-fact-2', kind: 'fact', scope: 'project:alpha', status: 'active', quote: 'Fact 2 quote' },
    body: 'Body fact 2',
  });
  P({
    meta: { id: 'map-stale', kind: 'fact', scope: 'global', status: 'active', recheck: '2026-01-01' },
    body: 'Stale fact',
  });
  P({
    meta: { id: 'map-archived', kind: 'rule', scope: 'global', status: 'archived' },
    body: 'Archived rule',
  });

  // .index.json da duoc put dong bo tu dong, kiem tra cache hit parsedCount === 0
  const hitSync = syncIndex(root);
  expect(hitSync.parsedCount).toBe(0);
  expect(hitSync.cachedHits).toBe(hitSync.count);

  // map() loc bo stale va archived, format <= 90 chars + footer map
  const res = map(root, { now: NOW });
  expect(res.ok).toBe(true);
  expect(res.total).toBe(2);
  expect(res.count).toBe(2);
  expect(res.text).toContain('- [map-rule-1] (rule:core,sys): Rule 1 quote');
  expect(res.text).toContain('- [map-fact-2] (fact): Fact 2 quote');
  expect(res.text).toContain('Chi tiet: harness knowledge get <id> | Tim: harness knowledge query --tags <tag>');
  expect(res.text).not.toContain('map-stale');
  expect(res.text).not.toContain('map-archived');
  expect(res.text.length).toBeLessThanOrEqual(800);

  // map voi filter scope
  const resScope = map(root, { scope: 'project:alpha', now: NOW });
  expect(resScope.count).toBe(1);
  expect(resScope.items[0].id).toBe('map-fact-2');

  // CLI knowledge map
  const outMap = [];
  const rMap = run(['map', '--root', root, '--now', NOW], { out: (s) => outMap.push(s), err: () => {} });
  expect(rMap.code).toBe(0);
  const outMapStr = outMap.join('\n');
  expect(outMapStr).toContain('- [map-rule-1] (rule:core,sys): Rule 1 quote');
  expect(outMapStr).toContain('Chi tiet: harness knowledge get <id> | Tim: harness knowledge query --tags <tag>');

  // CLI knowledge map voi --json
  const jsonMap = [];
  const rJson = run(['map', '--json', '--root', root, '--now', NOW], { out: (s) => jsonMap.push(s), err: () => {} });
  expect(rJson.code).toBe(0);
  const parsedMap = JSON.parse(jsonMap.join('\n'));
  expect(parsedMap.ok).toBe(true);
  expect(parsedMap.count).toBe(2);
  expect(parsedMap.items.map((x) => x.id).sort()).toEqual(['map-fact-2', 'map-rule-1']);
});
