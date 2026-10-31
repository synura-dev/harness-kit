import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDataArgs, runPrune } from './data.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-10-29T00:00:00Z');
const mk = () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'dataprune-'));
  const d = path.join(hub, 'data');
  fs.mkdirSync(path.join(d, 'events'), { recursive: true });
  fs.mkdirSync(path.join(d, 'baselines'), { recursive: true });
  const iso = (n) => new Date(NOW - n * DAY).toISOString();
  fs.writeFileSync(path.join(d, 'events', 'e.jsonl'), [{ ts: iso(40) }, { ts: iso(5) }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (let i = 0; i < 12; i++) {
    const p = path.join(d, 'baselines', `b${i}.json`);
    fs.writeFileSync(p, '{}');
    fs.utimesSync(p, new Date(NOW - i * DAY), new Date(NOW - i * DAY));
  }
  return { hub, d };
};

test('parseDataArgs: can lenh prune, --timeout-s co tran, mac dinh dry-run', () => {
  expect(parseDataArgs(['prune']).yes).toBe(false);
  expect(parseDataArgs(['prune', '--yes']).yes).toBe(true);
  expect(() => parseDataArgs([])).toThrow();
  expect(() => parseDataArgs(['prune', '--timeout-s', '999'])).toThrow();
});

test('runPrune: dry-run khong xoa; --yes xoa events qua 30 ngay va giu 10 baselines moi nhat', () => {
  const { hub, d } = mk();
  const dry = runPrune({ dir: d, hub, now: NOW });
  expect(dry.dryRun).toBe(true);
  expect(dry.removed).toBe(3);
  expect(fs.readdirSync(path.join(d, 'baselines')).length).toBe(12);
  const real = runPrune({ dir: d, hub, now: NOW, yes: true });
  expect(real.removed).toBe(3);
  expect(fs.readdirSync(path.join(d, 'baselines')).length).toBe(10);
  expect(fs.readFileSync(path.join(d, 'events', 'e.jsonl'), 'utf8').trim().split('\n').length).toBe(1);
});

test('runPrune: --dir ngoai hub bi chan', () => {
  const { hub } = mk();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dataprune-out-'));
  expect(() => runPrune({ dir: other, hub, now: NOW })).toThrow(/trong hub/);
});
