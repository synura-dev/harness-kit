import { test, expect } from 'bun:test';
import { compile, redact } from './redact.mjs';
import { DEFAULTS } from '../../core/config/audit-config.mjs';

const res = compile(DEFAULTS.redact);
const R = (s) => redact(s, res);

test('redact: cac flag secret dang dau cach bi che (ke ca client-secret, access-token...)', () => {
  for (const f of ['--password', '--token', '--api-key', '--secret', '--client-secret', '--access-token', '--auth-token', '--private-key', '--passwd', '--apikey', '--api-secret']) {
    const out = R(`tool ${f} hunter2xyz run`);
    expect(out).not.toContain('hunter2xyz');
    expect(out).toBe('tool *** run');
  }
});

test('redact: hoa thuong, nhieu khoang trang/tab, cuoi lenh, dang =', () => {
  expect(R('x --SECRET hunter2xyz y')).toBe('x *** y');
  expect(R('x --PASSWORD hunter2xyz y')).toBe('x *** y');
  expect(R('x --token   \t  hunter2xyz y')).toBe('x *** y');
  expect(R('x --secret')).toBe('x --secret');
  expect(R('x --token=hunter2xyz y')).not.toContain('hunter2xyz');
});

test('redact: khong che nham', () => {
  expect(R('tool --password-file /etc/pw.txt')).toBe('tool --password-file /etc/pw.txt');
  expect(R('harness mytoken-list now')).toBe('harness mytoken-list now');
  expect(R('x --no-token y')).toBe('x --no-token y');
  // Chap nhan che thua: config dung co 'i' chung nen aiza.../xoxb... (chu thuong) cung bi che.
});

test('redact: sk- chi che khi du dai', () => {
  expect(R('sk-abcdefgh12 and sk-12')).toBe('*** and sk-12');
});

test('redact: slack/aws/google key', () => {
  expect(R('a xoxb-1234567890-abcdef b')).toBe('a *** b');
  expect(R('a xoxs-1234567890 b')).toBe('a *** b');
  expect(R('a AKIAABCDEFGHIJKL b')).toBe('a *** b');
  expect(R('a AIzaSyA1234567890abc b')).toBe('a *** b');
  expect(R('xoxb-short AKIA123 AIza12')).toBe('xoxb-short AKIA123 AIza12');
  expect(R('preAKIAABCDEFGHIJKL preAIzaSyA1234567890abc')).toBe('preAKIAABCDEFGHIJKL preAIzaSyA1234567890abc');
});

test('redact: ReDoS - chuoi dai khong treo (< 1000ms moi chuoi)', () => {
  for (const s of ['--token ' + ' '.repeat(100000) + 'x', '--secret ' + 'a'.repeat(100000), '--' + 'a'.repeat(100000), '--token ' + ' '.repeat(100000)]) {
    const t = performance.now();
    R(s);
    expect(performance.now() - t).toBeLessThan(1000);
  }
});
