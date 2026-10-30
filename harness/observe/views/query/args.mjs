// Parse co CLI.
export function parseQueryArgs(argv) {
  const f = { format: 'table', backend: 'auto' };
  const map = { '--type': 'type', '--date': 'date', '--since': 'since', '--until': 'until', '--session': 'session', '--tool': 'tool', '--agent': 'agent', '--event': 'event', '--ok': 'ok', '--actor': 'actor', '--origin': 'origin', '--project': 'project', '--cli': 'cli', '--digest': 'digest', '--limit': 'limit', '--report': 'report', '--format': 'format', '--backend': 'backend', '--timeout': 'timeout', '--max-bytes': 'maxBytes', '--max-rows': 'maxRows' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--include-phantom') { f.includePhantom = true; continue; }
    if (argv[i] === '--dedupe') { f.dedupe = true; continue; }
    if (argv[i] === '--no-dedupe') { f.dedupe = false; continue; } // no-op: dedupe is off by default
    const k = map[argv[i]];
    if (!k) throw new Error('Co la: ' + argv[i]);
    f[k] = argv[++i];
    if (f[k] === undefined) throw new Error('Thieu gia tri cho ' + argv[i - 1]);
  }
  if (f.limit !== undefined) f.limit = parseInt(f.limit, 10);
  if (f.ok !== undefined && !['true', 'false'].includes(f.ok)) throw new Error('--ok la true|false');
  if (f.actor !== undefined && !['main', 'sub'].includes(f.actor)) throw new Error('--actor la main|sub');
  if (f.origin !== undefined && !['work', 'noise'].includes(f.origin)) throw new Error('--origin la work|noise');
  if (!['table', 'json', 'jsonl', 'md'].includes(f.format)) throw new Error('--format la table|json|jsonl|md');
  if (f.digest !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(f.digest)) throw new Error('--digest can ngay YYYY-MM-DD');
  for (const k of ['timeout', 'maxBytes', 'maxRows']) if (f[k] !== undefined && !(Number(f[k]) > 0)) throw new Error('gia tri khong hop le cho --' + k);
  if (f.timeout !== undefined) f.timeoutMs = Number(f.timeout) * 1000; // --timeout tinh bang giay
  if (f.maxBytes !== undefined) f.maxBytes = Number(f.maxBytes);
  if (f.maxRows !== undefined) f.maxRows = Number(f.maxRows);
  if (f.report === 'checkpoint' && !argv.includes('--format')) f.format = 'md';
  return f;
}
