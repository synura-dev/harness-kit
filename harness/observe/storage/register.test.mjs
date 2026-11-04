import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCmd, treeCmd, parseResolveOutput, hintClass, TREE_START, TREE_END } from './register.mjs';

function mk() {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  fs.mkdirSync(path.join(hub, 'tools', 'x'), { recursive: true });
  const registryFile = path.join(hub, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({ entries: { audit: { owner: 'a', retentionDays: 90 } }, reserved: [] }));
  const readmeFile = path.join(hub, 'README.md');
  fs.writeFileSync(readmeFile, '# R\nkeep\n');
  return { hubRoot: hub, dataDir: path.join(hub, 'data'), registryFile, readmeFile, wsDir: path.join(hub, 'ws'), resolveProject: (id) => (id === 'ok' ? { path: '/p' } : null) };
}

test('resolverFailed (projectResolver co cau hinh nhung loi) -> --project fail-closed, khong unchecked', () => {
  const c = mk(); delete c.resolveProject; c.resolverFailed = true;
  const r = registerCmd(['workspaces/ws3/events', '--class', 'log', '--owner', 'tools/x', '--project', 'any', '--yes'], c);
  expect(r.code).not.toBe(0);
  expect(r.lines.join('\n')).toContain('resolve that bai');
});

test('dry-run khong ghi, --yes ghi, trung bi tu choi', () => {
  const c = mk();
  const a = ['system/audit2/events', '--class', 'log', '--owner', 'tools/x'];
  expect(registerCmd(a, c).code).toBe(0);
  expect(JSON.parse(fs.readFileSync(c.registryFile, 'utf8')).entries['system/audit2/events']).toBeUndefined();
  expect(registerCmd([...a, '--yes'], c).code).toBe(0);
  expect(JSON.parse(fs.readFileSync(c.registryFile, 'utf8')).entries['system/audit2/events'].class).toBe('log');
  expect(registerCmd([...a, '--yes'], c).code).toBe(2);
});

test('validate zone, class, ten, owner', () => {
  const c = mk();
  expect(registerCmd(['bad/d/t', '--class', 'log', '--owner', 'tools/x'], c).code).toBe(2);
  expect(registerCmd(['system/d/t', '--class', 'zzz', '--owner', 'tools/x'], c).code).toBe(2);
  expect(registerCmd(['system/d/t', '--owner', 'tools/x'], c).code).toBe(2);
  expect(registerCmd(['system/../t', '--class', 'log', '--owner', 'tools/x'], c).code).toBe(2);
  expect(registerCmd(['system/d/t', '--class', 'log'], c).code).toBe(2);
  expect(registerCmd(['system/d/t', '--class', 'log', '--owner', 'nope'], c).code).toBe(2);
  expect(registerCmd(['system/d/t', '--class', 'log'], { ...c, callerDir: path.join(c.hubRoot, 'tools', 'x') }).code).toBe(0);
});

test('goi y class theo ten', () => {
  expect(hintClass('events.jsonl')).toBe('log');
  expect(hintClass('scan-cache')).toBe('cache');
  expect(hintClass('thing')).toBe(null);
  expect(registerCmd(['system/d/run-log', '--owner', 'tools/x'], mk()).code).toBe(0);
});

test('workspace: resolve dung/sai, ghi vao wsDir', () => {
  const c = mk();
  expect(registerCmd(['workspaces/nope/t', '--class', 'durable', '--owner', 'tools/x'], c).code).toBe(2);
  expect(registerCmd(['workspaces/ok/t', '--class', 'durable', '--owner', 'tools/x', '--yes'], c).code).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(c.wsDir, 'ok.json'), 'utf8')).entries.t.workspace).toBe('ok');
});

test('parseResolveOutput text + json', () => {
  expect(parseResolveOutput('warn: x\nE:\\p\n').path).toBe('E:\\p');
  expect(parseResolveOutput('{"id":"a","path":"/q"}').path).toBe('/q');
  expect(parseResolveOutput('khong resolve duoc: z')).toBe(null);
});

test('tree + write-readme giu phan khac, idempotent', () => {
  const c = mk();
  registerCmd(['system/d/t', '--class', 'cache', '--owner', 'tools/x', '--yes'], c);
  const t = treeCmd([], c).lines.join('\n');
  expect(t).toContain('system/');
  expect(t).toContain('[cache]');
  treeCmd(['--write-readme'], c);
  const one = fs.readFileSync(c.readmeFile, 'utf8');
  expect(one).toContain('keep');
  expect(one).toContain(TREE_START);
  treeCmd(['--write-readme'], c);
  const two = fs.readFileSync(c.readmeFile, 'utf8');
  expect(two.replace(/da ghi.*/, '')).toBe(one.replace(/da ghi.*/, ''));
  expect(two.split(TREE_END).length).toBe(2);
});

test('registry hong: register khong ghi de; owner tuyet doi -> tuong doi; ten .example bi chan', () => {
  const c = mk();
  const base = ['system/d1/t1', '--class', 'log', '--yes'];
  expect(registerCmd([...base, '--owner', path.join(c.hubRoot, 'tools', 'x')], c).code).toBe(0);
  const j = JSON.parse(fs.readFileSync(c.registryFile, 'utf8'));
  expect(j.entries['system/d1/t1'].owner).toBe('tools/x');
  expect(registerCmd([...base, '--owner', os.tmpdir()], c).code).toBe(2);
  expect(registerCmd(['system/d2/foo.example', '--class', 'log', '--owner', 'tools/x'], c).code).toBe(2);
  fs.writeFileSync(c.registryFile, '{broken');
  expect(registerCmd(['system/d3/t', '--class', 'log', '--owner', 'tools/x', '--yes'], c).code).toBe(2);
  expect(fs.readFileSync(c.registryFile, 'utf8')).toBe('{broken');
});

test('hai register dong thoi (2 tien trinh) khong hong file', async () => {
  const c = mk();
  const mod = path.resolve(import.meta.dir, 'register.mjs').replace(/\\/g, '/');
  const run = (t) => Bun.spawn([process.execPath, '-e', `const m=await import('file:///${mod}');for(let i=0;i<20;i++)m.registerCmd(['system/dd/${t}'+i,'--class','log','--owner','tools/x','--yes'],${JSON.stringify(c)});`], { stdout: 'ignore', stderr: 'ignore' }).exited;
  await Promise.all([run('a'), run('b')]);
  const j = JSON.parse(fs.readFileSync(c.registryFile, 'utf8'));
  expect(Object.keys(j.entries).length).toBeGreaterThan(1);
  expect(fs.readdirSync(c.hubRoot).filter((n) => n.endsWith('.tmp')).length).toBe(0);
});
