import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, REF_RE } from './schema.mjs';
import { put, get, links, check } from './vault.mjs';
import { run } from './cli.mjs';

const NOW = '2026-11-02';
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-links-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const P = (input, o = {}) => put(input, { root, now: NOW, ...o });

test('schema: REF_RE validate chuoi project:<id>/(notes|facts)/<target>', () => {
  expect(REF_RE.test('project:hub/notes/arch')).toBe(true);
  expect(REF_RE.test('project:gemsocial/facts/db.host')).toBe(true);
  expect(REF_RE.test('project:a_b-1/notes/my_note-1.spec')).toBe(true);

  expect(REF_RE.test('project:/notes/a')).toBe(false);
  expect(REF_RE.test('project:hub/other/a')).toBe(false);
  expect(REF_RE.test('project:hub/notes/')).toBe(false);
  expect(REF_RE.test('http://example.com')).toBe(false);
  expect(REF_RE.test('global/notes/a')).toBe(false);
});

test('schema: validate() kiem tra truong refs[]', () => {
  // refs hop le
  const v1 = validate({ id: 'note-1', kind: 'fact', refs: ['project:p1/notes/spec', 'project:p2/facts/key'] });
  expect(v1.errors).toEqual([]);

  // refs khong phai mang
  const v2 = validate({ id: 'note-2', kind: 'fact', refs: 'project:p1/notes/spec' });
  expect(v2.errors).toContain('refs phai la mang <= 50 muc');

  // refs vuot 50 phan tu
  const v3 = validate({ id: 'note-3', kind: 'fact', refs: Array(51).fill('project:p1/notes/spec') });
  expect(v3.errors).toContain('refs phai la mang <= 50 muc');

  // refs co phan tu sai dinh dang
  const v4 = validate({ id: 'note-4', kind: 'fact', refs: ['project:p1/notes/spec', 'invalid-ref'] });
  expect(v4.errors.some((x) => x.includes('refs khong hop le'))).toBe(true);
});

test('vault: put & check voi refs (loose coupling, khong check ton tai file ngoai)', () => {
  const r1 = P({
    meta: {
      id: 'fact-with-refs',
      kind: 'fact',
      refs: ['project:hub/notes/arch-guide', 'project:hub/facts/sys.version'],
    },
    body: 'Noi dung fact co refs.',
  });
  expect(r1.ok).toBe(true);

  const g1 = get('fact-with-refs', { root });
  expect(g1.meta.refs).toEqual(['project:hub/notes/arch-guide', 'project:hub/facts/sys.version']);

  // check khong bao loi link gay cho refs (loose coupling)
  const c = check({ root, now: NOW });
  expect(c.errors).toEqual([]);

  // put voi refs sai -> tu choi
  const r2 = P({
    meta: { id: 'bad-refs', kind: 'fact', refs: ['not-a-valid-ref'] },
    body: 'Bad',
  });
  expect(r2.ok).toBe(false);
  expect(r2.errors.some((x) => x.includes('refs khong hop le'))).toBe(true);
});

test('vault: links() tinh dung outgoing va incoming (backlinks)', () => {
  // note-a: lien ket toi note-b va mot ref ngoai
  P({
    meta: {
      id: 'note-a',
      kind: 'fact',
      links: ['note-b'],
      refs: ['project:proj-x/notes/intro'],
    },
    body: 'Fact A',
  });

  // note-b: khong lien ket ai
  P({ meta: { id: 'note-b', kind: 'fact' }, body: 'Fact B' });

  // note-c: tro toi note-a qua frontmatter links
  P({ meta: { id: 'note-c', kind: 'rule', links: ['note-a'] }, body: 'Rule C' });

  // note-d: tro toi note-a qua body [[note-a]]
  P({ meta: { id: 'note-d', kind: 'lesson' }, body: 'Lesson D lien quan [[note-a]].' });

  // note-e: khong lien ket toi note-a
  P({ meta: { id: 'note-e', kind: 'decision', links: ['note-b'] }, body: 'Decision E' });

  // Tra cuu links cua note-a:
  // Outgoing: note-b, project:proj-x/notes/intro
  // Incoming: note-c, note-d
  const resA = links('note-a', { root });
  expect(resA.ok).toBe(true);
  expect(resA.outgoing).toEqual(['note-b', 'project:proj-x/notes/intro']);
  expect(resA.incoming.sort()).toEqual(['note-c', 'note-d']);

  // Tra cuu links cua note-b:
  // Outgoing: rong
  // Incoming: note-a, note-e
  const resB = links('note-b', { root });
  expect(resB.ok).toBe(true);
  expect(resB.outgoing).toEqual([]);
  expect(resB.incoming.sort()).toEqual(['note-a', 'note-e']);

  // Tra cuu links cua note khong ton tai hoac id sai
  expect(links('khong-co', { root }).ok).toBe(false);
  expect(links('ID_SAI_FORMAT', { root }).ok).toBe(false);
});

test('cli: knowledge links --format text|json va loi', () => {
  P({
    meta: {
      id: 'alpha-note',
      kind: 'fact',
      links: ['beta-note'],
      refs: ['project:p1/notes/doc'],
    },
    body: 'Alpha',
  });
  P({ meta: { id: 'beta-note', kind: 'rule', links: ['alpha-note'] }, body: 'Beta' });

  // Format text mac dinh
  const outText = [];
  const rText = run(['links', 'alpha-note', '--root', root], {
    out: (s) => outText.push(s),
    err: () => {},
  });
  expect(rText.code).toBe(0);
  const textJoined = outText.join('\n');
  expect(textJoined).toContain('Outgoing (2):');
  expect(textJoined).toContain('beta-note');
  expect(textJoined).toContain('project:p1/notes/doc');
  expect(textJoined).toContain('Incoming (1):');
  expect(textJoined).toContain('beta-note');

  // Format JSON (--format json)
  const outJson1 = [];
  const rJson1 = run(['links', 'alpha-note', '--format', 'json', '--root', root], {
    out: (s) => outJson1.push(s),
    err: () => {},
  });
  expect(rJson1.code).toBe(0);
  const data1 = JSON.parse(outJson1.join('\n'));
  expect(data1.id).toBe('alpha-note');
  expect(data1.outgoing).toEqual(['beta-note', 'project:p1/notes/doc']);
  expect(data1.incoming).toEqual(['beta-note']);

  // Format JSON qua co --json
  const outJson2 = [];
  const rJson2 = run(['links', 'alpha-note', '--json', '--root', root], {
    out: (s) => outJson2.push(s),
    err: () => {},
  });
  expect(rJson2.code).toBe(0);
  const data2 = JSON.parse(outJson2.join('\n'));
  expect(data2.outgoing).toEqual(['beta-note', 'project:p1/notes/doc']);

  // Khi note khong ton tai -> code 1
  const errLog = [];
  const rMiss = run(['links', 'missing-note', '--root', root], {
    out: () => {},
    err: (s) => errLog.push(s),
  });
  expect(rMiss.code).toBe(1);
  expect(errLog.join('\n')).toContain('knowledge links: khong thay missing-note');

  // Khi thieu id -> code 2 (usage)
  const errUsage = [];
  const rUsage = run(['links', '--root', root], {
    out: () => {},
    err: (s) => errUsage.push(s),
  });
  expect(rUsage.code).toBe(2);
});

test('cli: put voi co --refs', () => {
  const out = [];
  const r = run([
    'put',
    '--id', 'cli-refs-note',
    '--kind', 'fact',
    '--refs', 'project:alpha/notes/spec,project:beta/facts/port',
    '--body', 'CLI created body',
    '--root', root,
    '--now', NOW,
  ], {
    out: (s) => out.push(s),
    err: () => {},
  });
  expect(r.code).toBe(0);

  const g = get('cli-refs-note', { root });
  expect(g.ok).toBe(true);
  expect(g.meta.refs).toEqual(['project:alpha/notes/spec', 'project:beta/facts/port']);
});
