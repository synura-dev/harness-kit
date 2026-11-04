// Vong 3: pattern khong modifier (chay Node 22+ va bun), URL userinfo, flag mo rong.
// Chay: node --test <file> hoac bun test <file> (node:test chay duoc ca hai).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, redact } from './redact.mjs';
import { DEFAULTS } from '../../core/config/audit-config.mjs';

const res = compile(DEFAULTS.redact);
const R = (s) => redact(s, res);

test('khong con (?-i:...) trong config', () => {
  assert.equal(DEFAULTS.redact.some((p) => p.includes('(?-i')), false);
});

test('Slack/AWS/Google key bi che (pattern khong modifier; che thua do co i duoc chap nhan)', () => {
  assert.equal(R('t xoxb-1234567890-abcdef y'), 't *** y');
  assert.equal(R('t AKIAABCDEFGHIJKLMNOP y'), 't *** y');
  assert.equal(R('t AIzaSyA1234567890abcdef y'), 't *** y');
});

test('URL userinfo: cac ca bi che, khong lot', () => {
  for (const c of ['curl https://u:p@h', '(https://u:p@h)', '"https://u:p@h"', 'git+https://u:p@h', '1https://u:p@h', '-https://u:p@h']) {
    assert.ok(!R(c).includes('u:p@'), c);
  }
});

test('URL userinfo: khong ReDoS', () => {
  for (const s of ['a'.repeat(100000), 'a'.repeat(100000) + '://']) {
    const t = Date.now(); R(s); assert.ok(Date.now() - t < 200);
  }
});

test('flag secret mo rong', () => {
  for (const c of ['--secret-key x', '--secretkey x', '--Secret-Key abc', '--api_key x', '--passphrase x', '--db-pass x', '--password "my pass word"', "--token 'a b c'"]) {
    assert.equal(R(`t ${c} z`), 't *** z', c);
  }
});

test('flag secret: khong che nham', () => {
  for (const c of ['--password-file x', '--no-token y', '--passthrough x', '--secrets-dir x']) {
    assert.equal(R(`t ${c} z`), `t ${c} z`, c);
  }
});
