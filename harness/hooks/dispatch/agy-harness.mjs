// Phan loai lenh `harness ...` trong agy (ham thuan, khong I/O). Chi lenh DOC trong allowlist chat moi duoc tu cho phep (permissionOverrides command(harness)).
// Nguon allowlist: nguoi dung duyet 2026-11-07 (plan agy-plugin-only) tren cac domain cua `harness` (cli/manifest.json: doctor; ext domains data/observe/knowledge/projects)
// va chi cac lenh con chi-doc. KHONG co: ext (approve|register|remove|list), install, data adopt|clean, observe query, bat ky lenh ghi (knowledge add, projects add-task/set-task).
// unsafe = khong can thiep (agy tu quyet quyen), nhung co ly do de ghi audit gate.
export const SAFE_RULE = 'harness-allow';
export const UNSAFE_RULE = 'harness-unsafe';

/** domain -> lenh con cho phep; null = khong co lenh con (chi doi so trong extra). */
export const ALLOW = Object.freeze({
  doctor: null,
  data: ['ls', 'stat', 'scan'],
  observe: ['usage', 'report'],
  knowledge: ['search', 'get', 'fact', 'role'],
  projects: ['list', 'get', 'tasks'],
});
const DOCTOR_ARGS = ['--json'];
const TOKEN = /^[A-Za-z0-9_.:=,@+/-]+$/; // moi ky tu shell / quote / backslash / bien (% $) nam ngoai tap nay
const DANGER_FLAG = /^(--(apply|yes|force)(=|$)|-[yf]$)/;
const FAKE_HARNESS = /(^|[\\/])harness(\.[A-Za-z0-9]+)?$/i;

/** @returns {{kind:'safe'|'unsafe'|'none', argv?:string[], reason?:string}} */
export function classifyHarnessCommand(cmd, { allow = ALLOW } = {}) {
  if (typeof cmd !== 'string') return { kind: 'none' };
  const s = cmd.trim();
  if (!s) return { kind: 'none' };
  const tokens = s.split(/[ \t]+/);
  if (tokens[0] !== 'harness') return FAKE_HARNESS.test(tokens[0]) ? { kind: 'unsafe', reason: 'harness gia mao/duong dan (chi `harness` tran)' } : { kind: 'none' };
  const no = (reason) => ({ kind: 'unsafe', reason });
  if (/[\r\n]/.test(s) || !tokens.every((t) => TOKEN.test(t))) return no('ky tu shell/quote/xuong dong (chi token an toan)');
  const argv = tokens.slice(1);
  if (argv.some((t) => DANGER_FLAG.test(t))) return no('co --apply|--yes|--force');
  const [domain, sub, ...rest] = argv;
  if (!domain) return no('harness khong doi so');
  if (!Object.hasOwn(allow, domain)) return no(`domain ngoai allowlist chi-doc: ${domain.slice(0, 30)}`);
  const subs = allow[domain];
  if (subs === null) return rest.length === 0 && (sub === undefined || DOCTOR_ARGS.includes(sub)) ? { kind: 'safe', argv, reason: 'lenh doc trong allowlist' } : no(`${domain}: chi cho phep ${DOCTOR_ARGS.join('|')}`);
  if (!sub || !subs.includes(sub)) return no(`${domain} ${String(sub || '').slice(0, 30)}: lenh con ngoai allowlist chi-doc`);
  return { kind: 'safe', argv, reason: 'lenh doc trong allowlist' };
}
