// Tien trinh con chay 1 external: nap ctx tu core, import entry, goi main(ctx, argv). Throw -> stderr + exit 70.
// node ext-runner.mjs --ext <id> --entry <abs> --root <abs> --domain <d> [--workspace <abs>] [--caps a,b] -- <argv...>
import { pathToFileURL } from 'node:url';

const a = process.argv.slice(2);
const cut = a.indexOf('--');
const flags = cut < 0 ? a : a.slice(0, cut);
const argv = cut < 0 ? [] : a.slice(cut + 1);
const get = (k) => { const i = flags.indexOf(k); return i >= 0 ? flags[i + 1] : undefined; };

try {
  const { buildCtx } = await import('../core/ext/ctx.mjs');
  const ctx = buildCtx({ extId: get('--ext'), extRoot: get('--root'), workspace: get('--workspace') || null, caps: get('--caps') ? get('--caps').split(',').filter(Boolean) : undefined, data: get('--data') ? JSON.parse(get('--data')) : null });
  const mod = await import(pathToFileURL(get('--entry')).href);
  if (typeof mod.main !== 'function') throw new Error('entry khong export main(ctx, argv)');
  const r = await mod.main(ctx, argv, { domain: get('--domain') });
  if (typeof r === 'string') process.stdout.write(r.endsWith('\n') ? r : r + '\n');
  process.exitCode = Number.isInteger(r) ? r : 0;
} catch (e) {
  process.stderr.write(`ext-runner: ${e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : e}\n`);
  process.exitCode = 70;
}
