// guard khi KHONG co luat hub (thu muc tam rong): khong loi, chi ap luat chung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, configFiles } from './hook.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guard-nohub-'));

test('hub rong: load khong nem loi, co luat loi', () => {
  const hubRoot = tmp();
  const { config } = load(configFiles(hubRoot), { env: {}, hubRoot });
  const ids = config.denyPatterns.map((r) => r.id);
  assert.ok(ids.includes('mongo-cli') && ids.includes('git-force-push'));
});

test('hub rong + GUARD_PROJECT thieu: chi canh bao, van luat chung', () => {
  const hubRoot = tmp();
  const { config, warnings } = load(configFiles(hubRoot), { env: { GUARD_PROJECT: 'khong-ton-tai' }, hubRoot });
  assert.ok(warnings.some((w) => w.includes('chi ap luat chung')));
  assert.ok(config.denyPatterns.some((r) => r.id === 'mongo-uri'));
});
