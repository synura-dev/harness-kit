// Manifest hub THAT (kind cli + `domain` string + entry, khong co `domains`) phai qua duoc register (parse/validate)
// va loadExternals/runExternal chay duoc main(ctx). Loi cu: register chi nhan `domains` mang => "manifest thieu entry/domains".
// Doc truc tiep <repo>/hub/*/manifest.json neu co (hub main); khong co (repo plugin) thi dung ban sao nguyen van manifest projects.
import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from './ext-registry.mjs';
import { loadExternals, runExternal } from '../../core/ext/ext-host.mjs';
import { manifestDomains } from '../../core/ext/manifest-domains.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HUB = path.join(REPO, 'hub');
const HUB_IDS = ['projects', 'tasks', 'agy', 'dispatch', 'release', 'ai-job-search'];
const realHub = HUB_IDS.filter((id) => fs.existsSync(path.join(HUB, id, 'manifest.json')));
// Ban sao nguyen van hub/projects/manifest.json (dang manifest hub that).
const PROJECTS_MANIFEST = { id: 'projects', kind: 'cli', layer: 'ext', entry: 'projects.mjs', domain: 'projects', desc: 'registry du an (resolve/brief/limits/check)', cmds: 'list resolve brief check limits', default: 'index', files: { helpers: ['projects-registry.mjs'] }, tests: ['projects-registry.test.mjs', 'projects.test.mjs'], requires: { ctx: '^1' }, caps: [], config: { defaults: null, schema: null }, data: null, tier: 'T0' };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exthub-')));
const _old = ['HUB_DATA_DIR', 'CLAUDE_AUDIT_DIR'].map((k) => [k, process.env[k]]);
process.env.HUB_DATA_DIR = path.join(tmp, 'data'); process.env.CLAUDE_AUDIT_DIR = path.join(tmp, 'audit');
afterAll(() => { for (const [k, v] of _old) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// Copy cay ext (chi file, bo node_modules/.git) vao workspace tmp de register khong dung den hub that.
function copyExt(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    if (d.name === 'node_modules' || d.name === '.git') continue;
    const s = path.join(src, d.name), t = path.join(dst, d.name);
    if (d.isDirectory()) copyExt(s, t); else if (d.isFile()) fs.copyFileSync(s, t);
  }
}
function fixtureProjects(ws) {
  const root = path.join(ws, 'hub', 'projects'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(PROJECTS_MANIFEST));
  fs.writeFileSync(path.join(root, 'projects.mjs'), 'export function main(ctx, argv) { console.log("ok " + argv.join(",")); return 0; }');
  return root;
}
const regOpts = (ws, answers) => ({ workspace: ws, machineFile: path.join(ws, 'machine', 'config', 'ext', 'local.json'), confirm: (msg) => { answers.push(msg); return false; }, coreDomains: new Set(['data', 'audit', 'ext']) });

test('manifestDomains: `domain` string (hub that), `domains` mang, `domains` object', () => {
  expect(manifestDomains(PROJECTS_MANIFEST)).toEqual(['projects']);
  expect(manifestDomains({ domains: ['a', 'b'] })).toEqual(['a', 'b']);
  expect(manifestDomains({ domain: 'a', domains: { a: 'x.mjs', b: 'y.mjs' } })).toEqual(['a', 'b']);
  expect(manifestDomains({ entry: 'x.mjs' })).toEqual([]);
});

test('register: manifest dang hub that qua parse/validate (toi buoc hoi TTY), khong ghi khi tu choi', async () => {
  const ws = path.join(tmp, 'ws1');
  const ids = realHub.length ? realHub : ['projects'];
  if (realHub.length) for (const id of realHub) copyExt(path.join(HUB, id), path.join(ws, 'hub', id)); else fixtureProjects(ws);
  for (const id of ids) {
    const asked = []; const o = regOpts(ws, asked);
    const r = await R.register(`hub/${id}`, o);
    expect({ id, text: r.text }).toEqual({ id, text: 'ext register: tu choi' }); // qua scanManifest + hashTree, dung o buoc xac nhan
    expect(asked.length).toBe(1); expect(asked[0]).toContain(`Dang ky extension ${id} `);
    expect(fs.existsSync(o.machineFile)).toBe(false);
  }
});

test('register van chan: entry khong ton tai, domain trung core, thieu domain', async () => {
  const ws = path.join(tmp, 'ws2'); const root = fixtureProjects(ws);
  const run = (m) => { fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(m)); return R.register('hub/projects', regOpts(ws, [])); };
  expect((await run({ ...PROJECTS_MANIFEST, entry: 'khong-co.mjs' })).text).toContain('entry khong ton tai');
  expect((await run({ ...PROJECTS_MANIFEST, domain: 'data' })).text).toContain('domain trung core');
  const { domain, ...noDom } = PROJECTS_MANIFEST;
  expect((await run(noDom)).text).toContain('thieu entry/domain');
});

test('ext-runner chay main(ctx) cua projects (manifest hub that)', () => {
  const root = realHub.includes('projects') ? path.join(HUB, 'projects') : fixtureProjects(path.join(tmp, 'ws3'));
  const { byDomain, errors } = loadExternals([{ id: 'projects', root }], { coreDomains: new Set(['data']) });
  expect(errors).toEqual([]);
  expect(byDomain.projects && byDomain.projects.id).toBe('projects');
  const r = runExternal(byDomain.projects, 'projects', ['list', '--json'], { workspace: realHub.length ? REPO : path.dirname(path.dirname(root)), timeoutS: 30 });
  expect({ code: r.code, err: r.stderr.slice(0, 300) }).toEqual({ code: 0, err: expect.any(String) });
}, 60000);
