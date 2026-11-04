// Test CLI bin/harness: chuyen tiep argv + ma thoat; workspace = git top-level (goi tu thu muc con); dau hieu workspace -> config/ cua du an.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dir, '..', '..', 'bin', 'harness');
const cleanEnv = () => { const e = {}; for (const [k, v] of Object.entries(process.env)) if (!/^(HUB_|HARNESS_|CLAUDE_)/.test(k)) e[k] = v; return e; };
const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: cleanEnv(), encoding: 'utf8', timeout: 60000 });
const repo = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-harness-')); spawnSync('git', ['init', '-q'], { cwd: d }); return d; };

test('bin/harness: shebang node, LF', () => {
  const t = fs.readFileSync(BIN, 'utf8');
  expect(t.startsWith('#!/usr/bin/env node\n')).toBe(true);
  expect(fs.existsSync(BIN + '.cmd')).toBe(true);
});

test('--help exit 0; domain sai -> ma loi cua CLI (khac 0)', () => {
  const d = repo();
  const ok = run(['--help'], d);
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('constrain');
  expect(run(['khong-co-domain'], d).status).not.toBe(0);
});

test('workspace co dau hieu, goi tu thu muc con: doc config/hub cua du an, du lieu vao data/', () => {
  const d = repo();
  fs.mkdirSync(path.join(d, 'config', 'hub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'config', 'hub', 'default.json'), JSON.stringify({ zzMarker: 1 }));
  fs.mkdirSync(path.join(d, 'sub'));
  const r = run(['config', 'sources', 'hub'], path.join(d, 'sub'));
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('zzMarker');
  expect(fs.existsSync(path.join(d, '.harness'))).toBe(false);
});

test('du an sach: khong doc config/ cua du an, mac dinh .harness', () => {
  const d = repo();
  const r = run(['config', 'sources', 'hub'], d);
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain('zzMarker');
  expect(fs.existsSync(path.join(d, 'data'))).toBe(false);
});
