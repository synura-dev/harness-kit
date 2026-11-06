import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as R from './ext-registry.mjs';
import { main } from './ext-cmd.mjs';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function setup(extra = {}) {
  const ws = tmp('extd-'); const mf = path.join(tmp('extdm-'), 'config', 'ext', 'local.json');
  const root = path.join(ws, 'ext', 'demo'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'main.mjs'), 'export const main = () => 1;');
  const m = { id: 'demo', entry: 'main.mjs', domains: ['demo'],
    commands: [{ name: 'runs', mode: 'read', args: ['--json'] }, { name: 'go', mode: 'confirm' }],
    views: [{ kind: 'timeline', title: 'T', source: 'demo runs --json', actions: [{ label: 'Go', cmd: 'demo go', mode: 'confirm' }] }], ...extra };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(m));
  return { ws, root, opts: { workspace: ws, machineFile: mf, confirm: () => true, coreDomains: new Set(['data']) } };
}

test('describe --json: manifest ghim, co commands/views', async () => {
  const { opts } = setup();
  expect((await R.register('ext/demo', opts)).code).toBe(0);
  const r = await main(['describe', 'demo', '--json'], opts);
  const j = JSON.parse(r.text);
  expect(r.code).toBe(0);
  expect(j.id).toBe('demo'); expect(j.status).toBe('ok'); expect(j.domains).toEqual(['demo']);
  expect(j.commands).toEqual([{ name: 'runs', mode: 'read', args: ['--json'] }, { name: 'go', mode: 'confirm', args: [] }]);
  expect(j.views[0].source).toBe('demo runs --json');
});

test('describe: id la -> code 2; manifest cu khong views van chay', async () => {
  const { opts, root } = setup();
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'demo', entry: 'main.mjs', domains: ['demo'] }));
  await R.register('ext/demo', opts);
  const j = JSON.parse((await main(['describe', 'demo', '--json'], opts)).text);
  expect(j.commands).toEqual([]); expect(j.views).toEqual([]);
  expect((await main(['describe', 'nope', '--json'], opts)).code).toBe(2);
});

test('register: view/command sai -> loi ro', async () => {
  for (const [views, re] of [
    [[{ kind: 'list', source: 'demo go' }], /read/],
    [[{ kind: 'list', source: 'demo zzz' }], /khong khai bao/],
    [[{ kind: 'bogus', source: 'demo runs' }], /kind/],
  ]) {
    const { opts } = setup({ views });
    const r = await R.register('ext/demo', opts);
    expect(r.code).toBe(2); expect(r.text).toMatch(re);
  }
  const { opts } = setup({ commands: [{ name: 'x', mode: 'weird' }], views: undefined });
  expect((await R.register('ext/demo', opts)).text).toMatch(/mode/);
});

test('list --json la JSON that; text mac dinh khong doi', async () => {
  const { opts } = setup();
  await R.register('ext/demo', opts);
  const j = JSON.parse((await main(['list', '--json'], opts)).text);
  expect(j[0].id).toBe('demo'); expect(j[0].status).toBe('ok');
  expect((await main(['list'], opts)).text).toContain('demo\text/demo');
});
