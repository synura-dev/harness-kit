// File chuan o goc moi repo: khong bao gio tinh la clutter (data scan repo-root, hook data-check). Hang so trong code, khong config.
const PREFIXES = ['README', 'LICENSE', 'LICENCE', 'NOTICE', 'CHANGELOG', 'CONTRIBUTING', 'SECURITY', 'CODE_OF_CONDUCT'];
const NAMES = new Set([
  'agents.md', 'claude.md', 'gemini.md',
  'package.json', 'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'tsconfig.json', 'jsconfig.json', 'deno.json', 'deno.jsonc',
  'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'poetry.lock', 'uv.lock', 'pipfile', 'pipfile.lock',
  'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'makefile', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'justfile',
]);

/** Ten file (khong duong dan) la file chuan o goc repo? README*, LICENSE*, NOTICE*, CHANGELOG*, CONTRIBUTING*, SECURITY*, CODE_OF_CONDUCT*, AGENTS/CLAUDE.md, manifest du an. */
export function isStdRootFile(name) {
  if (typeof name !== 'string' || !name || /[\\/]/.test(name)) return false;
  const u = name.toUpperCase();
  if (PREFIXES.some((p) => u === p || u.startsWith(p + '.') || u.startsWith(p + '_') || u.startsWith(p + '-'))) return true;
  return NAMES.has(name.toLowerCase());
}
