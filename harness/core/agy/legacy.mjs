// Di san agy cu (truoc khi agy chi cai bang `agy plugin install`): phat hien, KHONG tu xoa.
import fs from 'node:fs';
import path from 'node:path';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** -> mang chuoi mo ta di san trong <dir>/.agents (rong neu sach). Ham thuan. */
export function legacyFindings(dir) {
  const a = path.join(dir, '.agents');
  const out = [];
  const raw = read(path.join(a, 'hooks.json'));
  if (raw && /"harness-kit"/.test(raw)) out.push('.agents/hooks.json (khoa "harness-kit")');
  for (const f of ['harness-agy-shim.mjs', 'harness-agy.local.json']) if (fs.existsSync(path.join(a, f))) out.push(`.agents/${f}`);
  if (fs.existsSync(path.join(a, 'plugins', 'harness-kit'))) out.push('.agents/plugins/harness-kit');
  return out;
}

/** -> MOT chuoi `[warn] ...` gop + huong dan xoa tay, hoac null khi sach. */
export function legacySummary(dir) {
  const f = legacyFindings(dir);
  return f.length ? `[warn] di san agy cu trong ${dir}: ${f.join(', ')} -> hook chay doi voi plugin da cai; xoa tay cac muc nay (khong tu xoa)` : null;
}
