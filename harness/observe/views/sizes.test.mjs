import { test, expect } from 'bun:test';
import { sizesMain } from './sizes.mjs';
import { dataMain } from './data.mjs';

test('sizes: thu muc ngoai hub tra ma 2 (khong process.exit), qua observe/data giu ma', () => {
  const err = console.error; console.error = () => {};
  try {
    expect(sizesMain(['..'])).toBe(2);
    expect(dataMain(['sizes', '..'])).toBe(2);
  } finally { console.error = err; }
});
