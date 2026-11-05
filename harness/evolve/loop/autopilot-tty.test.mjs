// confirmTty chi nhan opts.confirm trong env test; ngoai test -> khong TTY thi tu choi.
import { test, expect } from 'bun:test';
import { confirmTty } from './autopilot.mjs';

test('ngoai NODE_ENV=test, opts.confirm bi bo qua (khong TTY -> null)', async () => {
  const old = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    expect(await confirmTty('x', { confirm: () => true, isTTY: false })).toBe(null);
    process.env.NODE_ENV = 'test';
    expect(await confirmTty('x', { confirm: () => true, isTTY: false })).toBe(true);
  } finally { process.env.NODE_ENV = old; }
});
