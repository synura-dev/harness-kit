import { test, expect } from 'bun:test';
import { ALLOW, TOOL_MAP, getSid, getCommand, makePick } from './agy-payload.mjs';

test('hang bat bien', () => {
  expect(Object.isFrozen(ALLOW)).toBe(true);
  expect(TOOL_MAP.run_command).toBe('Bash');
  expect(getSid({ conversationId: 'conv-real', sessionId: 's' })).toBe('conv-real');
  expect(getSid({ sessionId: 's' })).toBe('s');
  expect(getCommand({ commandLine: 'x' })).toBe('x');
  expect(getCommand({ CommandLine: '', command: 'y' })).toBe('');
  expect(makePick({ CommandLine: '  ', cmd: 'z' })('CommandLine', 'cmd')).toBe('z');
  expect(makePick({ n: 5 })('n')).toBe('5');
});
