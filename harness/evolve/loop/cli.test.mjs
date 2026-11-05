import { test, expect } from 'bun:test';
import { render } from './cli.mjs';

test('apply/rollback --approve qua CLI: khong TTY -> exit 2 (agent khong tu duyet)', async () => {
  for (const cmd of ['apply', 'rollback']) {
    const r = await render({ cmd, arg: 'x1', approve: true, isTTY: false });
    expect(r.code).toBe(2);
    expect(r.summary).toContain('agent khong tu duyet');
  }
});

test('apply/rollback: nguoi tu choi -> exit 1; dong y moi toi ham apply', async () => {
  expect((await render({ cmd: 'apply', arg: 'x1', approve: true, confirm: () => false })).code).toBe(1);
  expect((await render({ cmd: 'rollback', arg: 'v1', approve: true, confirm: () => false })).code).toBe(1);
  await expect(render({ cmd: 'apply', arg: 'khong-co', approve: true, confirm: () => true, dataBase: '.', dataRoot: '.' })).rejects.toThrow();
});
