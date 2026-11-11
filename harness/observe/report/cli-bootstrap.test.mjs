import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './cli.mjs';
import { indexFile, bootstrapIndex } from './cost-repeat.mjs';

// Index chi ghi khi co segment tot (da test o cost-repeat.test); o day: duong CLI cach ly, khong de tmp, exit code.
test('--bootstrap-days: chay tren HUB_DATA_DIR/CLAUDE_AUDIT_DIR tam, khong de file .tmp; ngoai 1..90 -> exit 2', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rboot-'));
  const saved = { h: process.env.HUB_DATA_DIR, a: process.env.CLAUDE_AUDIT_DIR };
  process.env.HUB_DATA_DIR = d; process.env.CLAUDE_AUDIT_DIR = path.join(d, 'audit');
  const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {};
  try {
    expect(await main(['report', '--bootstrap-days', '1'])).toBe(0);
    const f = indexFile({ env: { HUB_DATA_DIR: d } });
    if (fs.existsSync(f)) expect(() => JSON.parse(fs.readFileSync(f, 'utf8'))).not.toThrow();
    expect(await main(['report', '--bootstrap-days', '0'])).toBe(2);
    expect(await main(['report', '--bootstrap-days', '91'])).toBe(2);
    expect(bootstrapIndex({ events: [], dataOpts: { env: { HUB_DATA_DIR: d } } }).ok).toBe(true);
    const all = fs.readdirSync(d, { recursive: true }).map(String);
    expect(all.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  } finally {
    console.log = log; console.error = err;
    for (const [k, v] of [['HUB_DATA_DIR', saved.h], ['CLAUDE_AUDIT_DIR', saved.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(d, { recursive: true, force: true });
  }
});
