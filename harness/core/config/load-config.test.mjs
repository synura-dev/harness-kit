import { test, expect } from 'bun:test';
import { loadFlat as loadConfig } from './config.mjs';

test('loadConfig: file thieu bo qua, defaults giu', () => {
  const { config, warnings } = loadConfig({ defaults: { a: { b: 1 } }, files: ['/khong/co.json'] });
  expect(config).toEqual({ a: { b: 1 } });
  expect(warnings).toEqual([]);
});
