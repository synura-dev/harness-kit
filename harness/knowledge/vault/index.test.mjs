import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { put, get, query, context, links } from './vault.mjs';
import { syncIndex } from './index.mjs';
import { run } from './cli.mjs';

const NOW = '2026-11-02';
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-index-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('put tao va cap nhat .index.json voi day du metadata', () => {
  const r = put({
    meta: {
      id: 'rule-alpha',
      kind: 'rule',
      scope: 'global',
      tags: ['security', 'core'],
      links: ['other-note'],
      refs: ['project:hub/notes/arch'],
      source: 'docs/rules.md',
    },
    body: '# Tieu de Alpha\nNoi dung quy tac Alpha.',
  }, { root, now: NOW });
  expect(r.ok).toBe(true);

  const indexPath = path.join(root, '.index.json');
  expect(fs.existsSync(indexPath)).toBe(true);

  const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  expect(idx.version).toBe(1);
  expect(typeof idx.updatedAt).toBe('string');

  const ent = idx.entries['rule-alpha'];
  expect(ent).toBeDefined();
  expect(ent.id).toBe('rule-alpha');
  expect(ent.kind).toBe('rule');
  expect(ent.scope).toBe('global');
  expect(ent.status).toBe('active');
  expect(ent.tags).toEqual(['security', 'core']);
  expect(ent.links).toEqual(['other-note']);
  expect(ent.refs).toEqual(['project:hub/notes/arch']);
  expect(ent.source).toBe('docs/rules.md');
  expect(ent.title).toBe('Tieu de Alpha');
  expect(ent.relPath).toBe('rule/global/rule-alpha.md');
  expect(ent.secret).toBe(null);
  expect(ent.web).toBe(false);
  expect(typeof ent.mtimeMs).toBe('number');
  expect(typeof ent.size).toBe('number');
  expect(ent.size > 0).toBe(true);
});

test('Zero-Scan: goi query, context, links lan 2 dat cachedHits === count va parsedCount === 0', () => {
  put({
    meta: { id: 'note-1', kind: 'rule', scope: 'global', tags: ['auth'] },
    body: '# Auth Rule\nBat buoc xac thuc.',
  }, { root, now: NOW });

  put({
    meta: { id: 'note-2', kind: 'fact', scope: 'global', tags: ['db'] },
    body: '# DB Host\n127.0.0.1:27017',
  }, { root, now: NOW });

  put({
    meta: { id: 'note-3', kind: 'ref', scope: 'global', quote: 'Tric doan sach', source: 'docs/spec' },
    body: 'Xem them [[note-1]].',
  }, { root, now: NOW });

  // Index da duoc tao boi put, goi syncIndex lan nua khong parse lai file
  const s1 = syncIndex(root);
  expect(s1.count).toBe(3);
  expect(s1.cachedHits).toBe(3);
  expect(s1.parsedCount).toBe(0);

  // query su dung index khong gay cache miss
  const qRes = query({ scope: 'global' }, { root, now: NOW });
  expect(qRes.total).toBe(3);
  expect(qRes.items.length).toBe(3);

  // context loc va doc top limit ma khong pha index cache
  const ctxRes = context({ scope: 'global', limit: 2 }, { root, now: NOW });
  expect(ctxRes.count).toBe(2);

  // links lay incoming/outgoing truc tiep tu metadata index
  const linkRes = links('note-1', { root });
  expect(linkRes.ok).toBe(true);
  expect(linkRes.incoming).toEqual(['note-3']);

  // Kiem tra lan nua syncIndex van 100% cache hit
  const s2 = syncIndex(root);
  expect(s2.count).toBe(3);
  expect(s2.cachedHits).toBe(3);
  expect(s2.parsedCount).toBe(0);
});

test('phat hien sua, them, xoa file ben ngoai (doi mtime/size/relPath)', () => {
  put({
    meta: { id: 'f-1', kind: 'fact', scope: 'global' },
    body: 'Fact ban dau',
  }, { root, now: NOW });
  put({
    meta: { id: 'f-2', kind: 'fact', scope: 'global' },
    body: 'Fact 2',
  }, { root, now: NOW });

  const s0 = syncIndex(root);
  expect(s0.count).toBe(2);
  expect(s0.cachedHits).toBe(2);
  expect(s0.parsedCount).toBe(0);

  // 1. Sua noi dung f-1 ben ngoai (doi size va mtime)
  const f1Path = path.join(root, 'fact', 'global', 'f-1.md');
  const nowSec = Math.floor(Date.now() / 1000) + 10;
  fs.writeFileSync(f1Path, '---\nid: f-1\nkind: fact\nscope: global\n---\nNoi dung da bi sua ben ngoai voi do dai lon hon\n');
  fs.utimesSync(f1Path, nowSec, nowSec);

  const s1 = syncIndex(root);
  expect(s1.count).toBe(2);
  expect(s1.parsedCount).toBe(1);
  expect(s1.cachedHits).toBe(1);

  // 2. Them file moi truc tiep vao disk
  const newRuleDir = path.join(root, 'rule', 'global');
  fs.mkdirSync(newRuleDir, { recursive: true });
  fs.writeFileSync(path.join(newRuleDir, 'f-ext.md'), '---\nid: f-ext\nkind: rule\nscope: global\n---\n# External Rule\nRule tu ngoai.\n');

  const s2 = syncIndex(root);
  expect(s2.count).toBe(3);
  expect(s2.parsedCount).toBe(1);
  expect(s2.cachedHits).toBe(2);

  // 3. Xoa 1 file tren disk -> syncIndex loai bo khoi index
  fs.rmSync(path.join(newRuleDir, 'f-ext.md'));
  const s3 = syncIndex(root);
  expect(s3.count).toBe(2);
  expect(s3.parsedCount).toBe(0);
  expect(s3.cachedHits).toBe(2);

  const idxData = JSON.parse(fs.readFileSync(path.join(root, '.index.json'), 'utf8'));
  expect(idxData.entries['f-ext']).toBeUndefined();
});

test('CLI knowledge index: mac dinh, --rebuild va --json', () => {
  put({
    meta: { id: 'cli-item-1', kind: 'rule', scope: 'global' },
    body: '# Rule 1',
  }, { root, now: NOW });
  put({
    meta: { id: 'cli-item-2', kind: 'lesson', scope: 'global' },
    body: '# Lesson 2',
  }, { root, now: NOW });

  // 1. Chay knowledge index --json mac dinh (cache hit)
  const out1 = [];
  const r1 = run(['index', '--root', root, '--json'], { out: (s) => out1.push(s), err: () => {} });
  expect(r1.code).toBe(0);
  const data1 = JSON.parse(out1.join('\n'));
  expect(data1.ok).toBe(true);
  expect(data1.count).toBe(2);
  expect(data1.cachedHits).toBe(2);
  expect(data1.parsedCount).toBe(0);

  // 2. Chay knowledge index --rebuild --json (buoc parse lai toan bo)
  const out2 = [];
  const r2 = run(['index', '--root', root, '--rebuild', '--json'], { out: (s) => out2.push(s), err: () => {} });
  expect(r2.code).toBe(0);
  const data2 = JSON.parse(out2.join('\n'));
  expect(data2.ok).toBe(true);
  expect(data2.count).toBe(2);
  expect(data2.parsedCount).toBe(2);
  expect(data2.cachedHits).toBe(0);

  // 3. Text output mac dinh khong co --json
  const out3 = [];
  const r3 = run(['index', '--root', root], { out: (s) => out3.push(s), err: () => {} });
  expect(r3.code).toBe(0);
  expect(out3.join('\n')).toContain('da dong bo index: 2 ghi chu (2 cache, 0 parse)');
});

test('doc: loi ghi .index.json khong lam query/context/map/links that bai', () => {
  put({ meta: { id: 'ro-a', kind: 'fact', scope: 'global', tags: ['t'] }, body: 'noi dung ro a' }, { root, now: NOW });
  fs.rmSync(path.join(root, '.index.json'));
  fs.mkdirSync(path.join(root, '.index.json')); // rename len thu muc -> loi ghi
  const q = query({}, { root, now: NOW });
  expect(q.items.map((i) => i.id)).toContain('ro-a');
  expect(context({ root, now: NOW, scope: 'global' }).ok !== false).toBe(true);
  expect(links('ro-a', { root, now: NOW }).ok).toBe(true);
  expect(syncIndex(root).writeError).toBeTruthy();
});

test('index cut (truncated) khong duoc ghi ra .index.json', () => {
  fs.mkdirSync(path.join(root, 'fact', 'global'), { recursive: true });
  for (const n of ['tr-a', 'tr-b', 'tr-c']) fs.writeFileSync(path.join(root, 'fact', 'global', `${n}.md`), `---\nid: ${n}\nkind: fact\nscope: global\n---\nx\n`);
  const r = syncIndex(root, { maxFiles: 1 });
  expect(r.truncated).toBeTruthy();
  expect(fs.existsSync(path.join(root, '.index.json'))).toBe(false);
  expect(syncIndex(root).count).toBe(3);
  expect(fs.existsSync(path.join(root, '.index.json'))).toBe(true);
});
