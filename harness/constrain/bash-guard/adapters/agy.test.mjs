// bun test harness/constrain/bash-guard/adapters/agy.test.mjs
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyDecide } from './agy.mjs';
import { DEFAULTS } from '../hook.mjs';

const ALLOW = { decision: 'allow' };
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agy.mjs');
const call = (CommandLine, name = 'run_command') => ({ conversationId: 'c', stepIdx: 1, toolCall: { name, args: { CommandLine } } });
const run = (input) => spawnSync(process.execPath, [script], { input, encoding: 'utf8' });

test('agyDecide: heredoc dai bi deny theo dinh dang agy', () => {
  const r = agyDecide(call('cat > f <<EOF\n1\n2\n3\n4\nEOF'), DEFAULTS);
  expect(r.decision).toBe('deny');
  expect(r.reason).toContain('bash-guard');
  expect(Object.keys(r).sort()).toEqual(['decision', 'reason']);
});

test('agyDecide: lenh thuong / tool khac -> {} (khong updatedInput)', () => {
  expect(agyDecide(call('echo hi'), DEFAULTS)).toEqual(ALLOW);
  expect(agyDecide(call('echo hi', 'write_file'), DEFAULTS)).toEqual(ALLOW);
  expect(agyDecide(null, DEFAULTS)).toEqual(ALLOW);
});

test('adapter CLI: deny in JSON hop le; stdin rong/rac -> {} exit 0', () => {
  const d = run(JSON.stringify(call('python -')));
  expect(d.status).toBe(0);
  expect(JSON.parse(d.stdout).decision).toBe('deny');
  for (const bad of ['', 'khong phai json', '[]']) {
    const r = run(bad);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(ALLOW);
  }
});
