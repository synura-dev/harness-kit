import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { put, get, query, check, prune, safeFile, writeNew } from './vault.mjs';
import { parse, stringify } from './frontmatter.mjs';
import { validate, findSecret, metaText, isWebSource } from './schema.mjs';
import { run } from './cli.mjs';
import { loadHarnessRegistry } from '../../core/registry/plugin-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..', '..', '..');
const NOW = '2026-10-29';
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const fact = (id, extra = {}) => ({ meta: { id, kind: 'fact', tags: ['bun'], confidence: 'high', ...extra.meta }, body: extra.body ?? `Noi dung ${id}.` });
const P = (input, o = {}) => put(input, { root, now: NOW, ...o });
const quiet = { out: () => {}, err: () => {} };

test('frontmatter roundtrip: mang inline, links [[id]], chuoi co dau hai cham', () => {
  const meta = { id: 'a-b', kind: 'fact', scope: 'project:gemsocial', tags: ['x', 'y/z'], links: ['c-d'], source: 'https://ex.com/p?q=1', quote: 'say: "hi", ok # not comment', recheck: '2026-12-01' };
  const t = stringify(meta, '# Tieu de\nXem [[c-d]].');
  expect(t.startsWith('---\nid: a-b\nkind: fact\n')).toBe(true);
  expect(t).toContain('links: ["[[c-d]]"]');
  const p = parse(t);
  expect(p.error).toBeNull();
  expect(p.meta).toEqual(meta);
  expect(p.body).toBe('# Tieu de\nXem [[c-d]].\n');
});

test('put -> get -> query -> check (luong chinh, atomic, khong de lai .tmp)', () => {
  const r = P(fact('bun-test-timeout', { meta: { source: 'https://bun.sh/docs/test', quote: 'default timeout is 5000ms', ttl_days: '30', links: ['ref-note'] } }));
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.file).toBe(path.join(root, 'fact', 'bun-test-timeout.md'));
  expect(P({ meta: { id: 'ref-note', kind: 'ref' }, body: 'Lien quan [[bun-test-timeout]]' }).ok).toBe(true);
  expect(fs.readdirSync(path.join(root, 'fact'))).toEqual(['bun-test-timeout.md']);
  const g = get('bun-test-timeout', { root });
  expect(g.meta.recheck).toBe('2026-11-28');
  expect(g.meta.created).toBe(NOW);
  expect(g.meta.status).toBe('active');
  const q = query({ tags: ['bun'], text: '5000' }, { root, now: NOW });
  expect(q.items.map((x) => x.id)).toEqual(['bun-test-timeout']);
  expect(q.items[0].line).toBe('default timeout is 5000ms');
  expect(query({ kind: 'ref' }, { root, now: NOW }).total).toBe(1);
  expect(query({ fresh: true }, { root, now: NOW }).total).toBe(2);
  expect(query({ stale: true }, { root, now: '2026-12-31' }).items.map((x) => x.id)).toEqual(['bun-test-timeout']);
  const c = check({ root, now: NOW });
  expect(c.errors).toEqual([]);
  expect(c.count).toBe(2);
});

test('chan path traversal / kind la / symlink', () => {
  for (const id of ['../evil', '..\\evil', '/abs', 'C:/x', 'a/b', 'A-B', '']) {
    const r = P(fact(id));
    expect(r.ok).toBe(false);
  }
  expect(P({ meta: { id: 'x', kind: '../../etc' }, body: '' }).ok).toBe(false);
  expect(() => safeFile(root, 'fact', '../x')).toThrow();
  expect(() => safeFile(root, '..', 'x')).toThrow();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-out-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'fact'), 'junction');
    const r = P(fact('via-link'));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('symlink');
    expect(fs.readdirSync(outside)).toEqual([]);
  } finally {
    const link = path.join(root, 'fact');
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch {} }
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('secret trong meta long nhau: quet de quy (put chan, query bao secret), co tran do sau', () => {
  const tok = 'ghp_' + 'a'.repeat(36);
  // object long: truoc day Object.values().flat() thanh "[object Object]" -> lot
  expect(findSecret(metaText({ extra: { deep: { k: tok } } }))).toBe('github-token');
  expect(findSecret(metaText({ extra: [{ db: { password: 'hunter2xyz' } }] }))).toBe('assignment'); // ten khoa long + gia tri
  expect(findSecret(metaText({ a: { b: { c: { d: { e: { f: { g: { h: tok } } } } } } } }))).toBe('github-token'); // qua maxDepth -> JSON nhanh
  const cyc = { x: 1 }; cyc.self = cyc;
  expect(() => metaText(cyc)).not.toThrow();
  expect(metaText({ a: Array.from({ length: 5000 }, (_, i) => String(i)) }).split('\n').length).toBe(2000);
  expect(findSecret(metaText({ id: 'ok', tags: ['a', 'b'], note: { x: 'binh thuong' } }))).toBeNull();
  const r = P(fact('nested-sec', { meta: { extra: { cfg: { k: tok } } } }));
  expect(r.ok).toBe(false);
  expect(r.errors.join(' ')).toContain('secret');
  // query: file tay co khoa la chua secret -> item.secret khac null
  fs.mkdirSync(path.join(root, 'fact'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fact', 'leaky.md'), `---\nid: leaky\nkind: fact\nstatus: active\napi_key: abcdef123456\n---\nnoi dung\n`);
  P(fact('clean-one'));
  const q = query({}, { root, now: NOW });
  expect(q.items.find((i) => i.id === 'leaky').secret).toBe('assignment');
  expect(q.items.find((i) => i.id === 'clean-one').secret).toBeNull();
});

test('chan chuoi giong secret (body va frontmatter)', () => {
  const cases = ['token ghp_' + 'a'.repeat(36), 'password = hunter2xyz', '-----BEGIN RSA PRIVATE KEY-----', 'AKIA' + 'B'.repeat(16), 'mongodb://user:pa55word@host/db', 'sk-ant-' + 'x'.repeat(30)];
  for (const s of cases) {
    expect(findSecret(s)).not.toBeNull();
    const r = P(fact('sec', { body: s }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('secret');
  }
  expect(P(fact('sec2', { meta: { quote: 'api_key: abcdef123456' } })).ok).toBe(false);
  expect(fs.existsSync(path.join(root, 'fact'))).toBe(false);
  expect(findSecret('dung bun test --timeout 120000 cho suite')).toBeNull();
});

test('kind=rule co source web bi tu choi; source web can quote', () => {
  const r = P({ meta: { id: 'web-rule', kind: 'rule', source: 'https://blog.example.com/x', quote: 'always do x' }, body: 'x' });
  expect(r.ok).toBe(false);
  expect(r.errors.join(' ')).toContain('rule');
  expect(P({ meta: { id: 'local-rule', kind: 'rule', source: 'user 2026-10-29' }, body: 'x' }).ok).toBe(true);
  expect(P(fact('no-quote', { meta: { source: 'http://x.io' } })).ok).toBe(false);
  expect(validate({ id: 'a', kind: 'fact', quote: 'q'.repeat(201) }).errors.join(' ')).toContain('quote');
});

test('id trung: tu choi tru --replace (giu created); khong doi kind', () => {
  expect(P(fact('dup')).ok).toBe(true);
  expect(P(fact('dup')).ok).toBe(false);
  const r = put(fact('dup', { body: 'moi' }), { root, now: '2026-11-05', replace: true });
  expect(r.ok).toBe(true);
  const g = get('dup', { root });
  expect(g.meta.created).toBe(NOW);
  expect(g.meta.updated).toBe('2026-11-05');
  expect(g.body).toBe('moi\n');
  expect(P({ meta: { id: 'dup', kind: 'lesson' }, body: '' }, { replace: true }).ok).toBe(false);
  const d = P(fact('dry'), { dryRun: true });
  expect(d.ok).toBe(true);
  expect(fs.existsSync(path.join(root, 'fact', 'dry.md'))).toBe(false);
});

test('check: link gay, id lech ten file, qua han recheck', () => {
  P(fact('has-broken', { body: 'xem [[khong-co]] va [[has-broken|alias]]' }));
  P(fact('old', { meta: { recheck: '2026-01-01' } }));
  fs.writeFileSync(path.join(root, 'fact', 'wrong-name.md'), '---\nid: other\nkind: fact\n---\nx\n');
  const c = check({ root, now: NOW });
  const msgs = c.errors.map((e) => `${e.id}: ${e.msg}`);
  expect(msgs).toContain('has-broken: link gay [[khong-co]]');
  expect(msgs.some((m) => m.startsWith('wrong-name: id frontmatter'))).toBe(true);
  expect(c.warnings.some((w) => w.id === 'old' && w.msg.includes('recheck'))).toBe(true);
});

test('prune: mac dinh dry-run; --apply chuyen archived, khong xoa file', () => {
  P(fact('old', { meta: { recheck: '2026-01-01' } }));
  P(fact('new', { meta: { recheck: '2027-01-01' } }));
  const before = fs.readFileSync(path.join(root, 'fact', 'old.md'), 'utf8');
  const d = prune({ root, now: NOW });
  expect(d.candidates.map((x) => x.id)).toEqual(['old']);
  expect(fs.readFileSync(path.join(root, 'fact', 'old.md'), 'utf8')).toBe(before);
  const a = prune({ root, now: NOW, apply: true });
  expect(a.applied).toEqual(['old']);
  expect(get('old', { root }).meta.status).toBe('archived');
  expect(query({}, { root, now: NOW }).items.map((x) => x.id)).toEqual(['new']);
  expect(query({ status: 'any' }, { root, now: NOW }).total).toBe(2);
});

test('cli run(): put/query/check exit code', () => {
  expect(run(['put', '--root', root, '--now', NOW, '--id', 'c1', '--kind', 'reference', '--tags', 'a,b', '--body', 'x'], quiet).code).toBe(0);
  expect(fs.existsSync(path.join(root, 'ref', 'c1.md'))).toBe(true);
  expect(run(['put', '--root', root, '--id', '../x', '--kind', 'fact'], quiet).code).toBe(1);
  expect(run(['bogus'], quiet).code).toBe(2);
  const out = [];
  run(['query', '--root', root, '--tag', 'a', '--json'], { out: (s) => out.push(s), err: () => {} });
  expect(JSON.parse(out[0]).items[0].id).toBe('c1');
});

test('registry: domain knowledge tro toi knowledge/vault/cli.mjs', () => {
  const reg = loadHarnessRegistry({ harnessDir: path.join(HUB, 'harness') });
  expect(reg.errors.filter((e) => e.includes('knowledge/vault'))).toEqual([]);
  expect(path.resolve(reg.domains.knowledge)).toBe(path.join(HERE, 'cli.mjs'));
});

test('e2e qua cong harness.mjs: put -> query -> get tren thu muc tam', () => {
  const H = (...a) => spawnSync('node', [path.join(HUB, 'harness', 'cli', 'harness.mjs'), 'knowledge', ...a, '--root', root], { cwd: HUB, encoding: 'utf8', timeout: 30000 });
  const p = H('put', '--id', 'e2e-note', '--kind', 'fact', '--tags', 'e2e', '--source', 'https://example.com/doc', '--quote', 'exact words', '--body', 'Body [[e2e-note]]');
  expect(p.status).toBe(0);
  const q = H('query', '--tag', 'e2e');
  expect(q.status).toBe(0);
  expect(q.stdout).toContain('e2e-note [fact] exact words');
  const g = H('get', 'e2e-note');
  expect(g.status).toBe(0);
  expect(g.stdout).toContain('source: https://example.com/doc');
  expect(H('put', '--id', 'bad', '--kind', 'rule', '--source', 'https://x.io', '--quote', 'q').status).toBe(1);
});

test('kind=rule: cac dang source web moi (khong chi http) deu bi chan; duong dan cuc bo thi khong', () => {
  const webs = ['web: https://x.dev/a', 'web: docs noi bo', 'docs.x.com/guide/a', 'xem docs.x.com/a', 'www.example.org', 'see www.foo.vn page', 'ftp://files.x.org/a', 'HTTPS://X.IO', 'en.wikipedia.org', 'example.com:8080/p', 'url: tai lieu', '(github.com)'];
  for (const s of webs) {
    expect([s, isWebSource(s)]).toEqual([s, true]);
    const r = P({ meta: { id: 'web-rule-x', kind: 'rule', source: s, quote: 'q' }, body: 'x' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('kind=rule');
  }
  for (const s of ['user 2026-10-29', 'docs/ARCHITECTURE.md', 'harness/knowledge/vault/vault.mjs', 'README.md', 'file:///E:/notes/a.md', 'phien chat v1.2', 'AGENTS.md muc Limits']) {
    expect([s, isWebSource(s)]).toEqual([s, false]);
  }
  expect(P({ meta: { id: 'local-rule-2', kind: 'rule', source: 'docs/ARCHITECTURE.md' }, body: 'x' }).ok).toBe(true);
});

test('writeNew: dich da co -> EEXIST, khong ghi de, khong de lai .tmp', () => {
  const f = path.join(root, 'fact', 'x.md');
  writeNew(f, 'A');
  let code; try { writeNew(f, 'B'); } catch (e) { code = e.code; }
  expect(code).toBe('EEXIST');
  expect(fs.readFileSync(f, 'utf8')).toBe('A');
  expect(fs.readdirSync(path.join(root, 'fact'))).toEqual(['x.md']);
});

test('put trung id song song (nhieu tien trinh): dung 1 thanh cong, ban thang khong bi ghi de', async () => {
  const N = 6, start = Date.now() + 1500;
  const vaultUrl = new URL('./vault.mjs', import.meta.url).href;
  const code = `const {put}=await import(${JSON.stringify(vaultUrl)});const [root,i,start]=process.argv.slice(1);while(Date.now()<+start){}const r=put({meta:{id:'race-note',kind:'fact'},body:'writer '+i},{root,now:'${NOW}'});console.log(JSON.stringify({i:+i,ok:r.ok}));`;
  const { spawn } = await import('node:child_process');
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
    const c = spawn('node', ['--input-type=module', '-e', code, root, String(i), String(start)]);
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill(), 20000);
    c.on('close', () => { clearTimeout(t); try { res(JSON.parse(out.trim())); } catch { res({ i, ok: null, out }); } });
  })));
  expect(rs.every((r) => typeof r.ok === 'boolean')).toBe(true);
  const wins = rs.filter((r) => r.ok);
  expect(wins.length).toBe(1);
  expect(fs.readdirSync(path.join(root, 'fact'))).toEqual(['race-note.md']);
  expect(get('race-note', { root }).body.trim()).toBe(`writer ${wins[0].i}`);
}, 60000);

test('probe: frontmatter roundtrip (object JSON), put validate, allowlist exact-argv, khong qua shell', () => {
  const probe = { cmd: ['node', '--version'], expect: '/^v\\d+\\./', timeoutS: 5 };
  const t = stringify({ id: 'node-ver', kind: 'fact', probe }, 'x');
  expect(parse(t).meta.probe).toEqual(probe);
  const ok = P(fact('node-ver', { meta: { probe } }));
  expect(ok.errors).toEqual([]);
  expect(get('node-ver', { root }).meta.probe).toEqual(probe);
  const bad = [
    { cmd: ['node', '-e', 'process.exit(0)'], expect: 'x' }, // ngoai allowlist (exact argv)
    { cmd: ['node', '--version', '--eval=1'], expect: 'x' },
    { cmd: ['node;rm', '--version'], expect: 'x' }, // ky tu shell
    { cmd: 'node --version', expect: 'x' }, // khong phai mang
    { cmd: ['node', '--version'], expect: '/(/' }, // regex sai
    { cmd: ['node', '--version'], expect: '' },
    { cmd: ['node', '--version'], expect: 'v', timeoutS: 999 },
    { cmd: ['node', '--version'], expect: 'v', extra: 1 },
  ];
  bad.forEach((p, i) => { const r = P(fact(`bad-probe-${i}`, { meta: { probe: p } })); expect([i, r.ok]).toEqual([i, false]); expect(r.errors.join(' ')).toContain('probe'); });
  expect(P(fact('bad-probe-str', { meta: { probe: 'node --version' } })).ok).toBe(false);
});

test('check --probe: mac dinh KHONG chay; lech -> stale-probe (canh bao, exit 0); khop thi sach', () => {
  const nodeVer = (id, expect) => P(fact(id, { meta: { probe: { cmd: ['node', '--version'], expect, timeoutS: 10 } } }));
  expect(nodeVer('ver-match', '/^v\\d+\\.\\d+/').ok).toBe(true);
  expect(nodeVer('ver-stale', 'v0.0.1-khong-bao-gio').ok).toBe(true);
  const plain = check({ root, now: NOW });
  expect(plain.probe).toBeNull();
  expect(plain.warnings.filter((w) => w.msg.includes('probe'))).toEqual([]);
  const c = check({ root, now: NOW, probe: true });
  expect(c.errors).toEqual([]);
  expect(c.probe.ran).toBe(2);
  expect(c.probe.stale.map((x) => x.id)).toEqual(['ver-stale']);
  expect(c.warnings.map((w) => `${w.id}: ${w.msg.split(':')[0]}`)).toEqual(['ver-stale: stale-probe']);
  const out = [];
  const r = run(['check', '--probe', '--root', root, '--now', NOW], { out: (s) => out.push(s), err: () => {} });
  expect(r.code).toBe(0);
  expect(out.join('\n')).toContain('1 stale-probe');
});

test('check --probe: file tay co probe ngoai allowlist -> LOI schema, KHONG chay; archived bo qua', () => {
  fs.mkdirSync(path.join(root, 'fact'), { recursive: true });
  const sentinel = path.join(root, 'pwned.txt').replace(/\\/g, '/');
  fs.writeFileSync(path.join(root, 'fact', 'evil.md'), `---\nid: evil\nkind: fact\nstatus: active\nprobe: {"cmd":["node","-e","require('fs').writeFileSync('${sentinel}','x')"],"expect":"x"}\n---\nx\n`);
  fs.writeFileSync(path.join(root, 'fact', 'arch.md'), `---\nid: arch\nkind: fact\nstatus: archived\nprobe: {"cmd":["node","--version"],"expect":"nope"}\n---\nx\n`);
  const c = check({ root, now: NOW, probe: true });
  expect(c.errors.some((e) => e.id === 'evil' && e.msg.includes('probe'))).toBe(true);
  expect(c.probe.ran).toBe(0);
  expect(c.probe.errors.some((e) => e.id === 'evil')).toBe(true);
  expect(fs.existsSync(path.join(root, 'pwned.txt'))).toBe(false);
});
