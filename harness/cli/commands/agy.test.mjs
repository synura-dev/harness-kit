import { test, expect } from 'bun:test';
import { missingRules, RULES } from './agy.mjs';

test('missingRules', () => {
  expect(missingRules(null)).toEqual([...RULES]);
  expect(missingRules({ permissions: { allow: [...RULES] } })).toEqual([]);
});
