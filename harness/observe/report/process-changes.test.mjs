import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { processChanges } from './process-changes.mjs';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const DAY = 86400000;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const git = (d, args, date) => spawnSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) } });
function mkRepo(commits) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  git(d, ['init', '-q']);
  commits.forEach(([file, daysAgo], i) => {
    fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true });
    fs.writeFileSync(path.join(d, file), `v${i}\n`);
    git(d, ['add', '-A']);
    git(d, ['commit', '-q', '-m', `c${i}`], iso(daysAgo));
  });
  return d;
}

test('dem theo tuan, repeat khi >=2 lan trong 14 ngay, bo file ngoai paths', () => {
  const d = mkRepo([['AGENTS.md', 10], ['AGENTS.md', 3], ['CLAUDE.md', 2], ['src/x.js', 1], ['.claude/agents/b.md', 20]]);
  const r = processChanges({ projectDir: d, sinceDays: 28, nowMs: NOW });
  assert.equal(r.truncated, null);
  assert.ok(!r.files.some((f) => f.path === 'src/x.js'));
  assert.equal(r.files.find((f) => f.path === 'AGENTS.md').edits, 2);
  assert.deepEqual(r.repeat.map((x) => x.path), ['AGENTS.md']);
  assert.equal(r.weeks.reduce((s, w) => s + w.changes, 0), 4);
  assert.ok(r.weeks.every((w) => /^\d{4}-W\d{2}$/.test(w.week)));
  fs.rmSync(d, { recursive: true, force: true });
});

test('sua cach nhau > 14 ngay khong tinh repeat', () => {
  const d = mkRepo([['AGENTS.md', 25], ['AGENTS.md', 2]]);
  const r = processChanges({ projectDir: d, nowMs: NOW });
  assert.deepEqual(r.repeat, []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('khong phai repo -> truncated no_git', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  const r = processChanges({ projectDir: d, nowMs: NOW });
  assert.equal(r.truncated, 'no_git'); assert.deepEqual(r.items, []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('maxCommits cat -> truncated max_commits', () => {
  const d = mkRepo([['AGENTS.md', 5], ['AGENTS.md', 4], ['AGENTS.md', 3]]);
  const r = processChanges({ projectDir: d, nowMs: NOW, maxCommits: 2 });
  assert.equal(r.truncated, 'max_commits');
  fs.rmSync(d, { recursive: true, force: true });
});
