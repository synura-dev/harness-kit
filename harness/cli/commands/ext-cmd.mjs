// harness ext <register <path> | approve <id> | list | verify>. register/approve can TTY (bac ask); verify lech => exit 1.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from '../../core/io/paths.mjs';
import * as R from './ext-registry.mjs';

export async function main(argv, opts = {}) {
  const [cmd, arg] = argv.filter((a) => !a.startsWith('--'));
  const o = { workspace: workspaceRoot(), ...opts };
  if (cmd === 'register' || cmd === 'approve') {
    if (!o.coreDomains) {
      try { const h = await import('../harness.mjs'); o.coreDomains = new Set(Object.keys(h.loadDomains(path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')))); } catch { o.coreDomains = new Set(); }
    }
    return cmd === 'register' ? R.register(arg, o) : R.approve(arg, o);
  }
  if (cmd === 'list') return R.list(o);
  if (cmd === 'verify') return R.verify(o);
  return { code: 2, text: 'dung: ext register <path> | approve <id> | list | verify' };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) { const r = await main(process.argv.slice(2)); console.log(r.text); process.exit(r.code); }
