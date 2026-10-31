import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('storage: enforce chan writeJson/appendJsonl; warn cho ghi + stderr 1 lan/key', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const rd = path.join(hub, 'harness', 'observe', 'storage');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'registry.json'), JSON.stringify({ entries: { ok: { owner: 'o', class: 'log', zone: 'system' } }, reserved: [] }));
  const saved = ['HUB_DIR', 'HUB_DATA_DIR', 'HARNESS_DATA_ENFORCE'].map((k) => [k, process.env[k]]);
  process.env.HUB_DIR = hub;
  process.env.HUB_DATA_DIR = path.join(hub, 'data');
  delete process.env.HARNESS_DATA_ENFORCE;
  const w = process.stderr.write.bind(process.stderr);
  let err = '';
  process.stderr.write = (x) => { err += x; return true; };
  try {
    const s = await import('./storage.mjs');
    const f = path.join(hub, 'data', 'stray1', 'a.json');
    s.writeJson(f, { a: 1 });
    s.writeJson(f, { a: 2 });
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).a).toBe(2);
    expect(err.match(/data-warn rule=unregistered/g).length).toBe(1);
    process.env.HARNESS_DATA_ENFORCE = 'enforce';
    const f2 = path.join(hub, 'data', 'stray2', 'a.jsonl');
    expect(() => s.writeJson(path.join(hub, 'data', 'stray2', 'b.json'), {})).toThrow('data-enforce');
    expect(s.appendJsonl(f2, { x: 1 })).toBeNull();
    expect(fs.existsSync(f2)).toBe(false);
    expect(err).toMatch(/data-enforce: chan ghi/);
    // Plugin mode: registry doc tu goc code (khong tu fixture) -> dung key that 'audit'; hub mode: key fixture 'ok'.
    const { isPluginMode } = await import('./paths.mjs');
    const okDir = isPluginMode() ? s.dataPathFor('audit', { quiet: true }) : path.join(hub, 'data', 'ok');
    expect(s.appendJsonl(path.join(okDir, 'a.jsonl'), { x: 1 })).not.toBeNull();
  } finally {
    process.stderr.write = w;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
