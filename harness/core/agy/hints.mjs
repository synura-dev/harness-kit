// Goi y agy cho bash-guard adapter va digest (tach tu agy-runtime, chi doi cho, khong doi logic).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

// Goi y cho agy (deny kem ly do): (1) lenh shell don gian thay duoc bang Read/Glob/Grep; (2) lenh read-only lap lai.
// Thuan (tru phan marker o cuoi). Chi chan khi CHAC CHAN: 1 lenh don, khong pipe/redirect/noi lenh.

const COMPLEX = /[|;&<>`\n\r]|\$\(|\$\{/; // pipe, noi lenh, redirect, thay the lenh -> khong dung

const tok = String.raw`(?:"[^"]+"|'[^']+'|[^\s"'-][^\s"']*)`;
const RE_READ = new RegExp(String.raw`^(?:Get-Content|gc|cat|type)\s+(?:-(?:Path|LiteralPath)\s+)?${tok}$`, 'i');
const RE_RECURSE = /^(?:Get-ChildItem|gci)\b(?=.*\s-(?:Recurse|r)\b)/i;
const RE_DIR_S = /^dir\b(?=.*\s\/s\b)/i;
const RE_FIND = /^find\s+\S+(?:\s+-(?:name|iname|type)\s+\S+)*$/;
const RE_GREP = /^(?:Select-String|sls|grep|egrep|findstr|rg)\s+\S/i;

// -> ly do chuyen sang tool chuyen dung, hoac null.
export function replaceReason(cmd) {
  if (typeof cmd !== 'string') return null;
  const c = cmd.trim();
  if (!c || c.length > 300 || COMPLEX.test(c)) return null;
  if (RE_READ.test(c)) return 'Doc file: dung tool Read (khong qua shell).';
  if (RE_RECURSE.test(c) || RE_DIR_S.test(c) || RE_FIND.test(c)) return 'Liet ke/tim file de quy: dung tool Glob (vd **/*.mjs), khong qua shell.';
  if (RE_GREP.test(c)) return 'Tim noi dung trong file: dung tool Grep, khong qua shell.';
  return null;
}

// Allowlist lenh READ-ONLY (khop toan bo, sau chuan hoa).
const RO = [
  /^git (?:status|log|diff|branch|show|rev-parse|remote|stash list)\b[^|;&<>`]*$/,
  /^node harness\/cli\/commands\/doctor\.mjs(?: --?[\w-]+)*$/,
  /^node harness\/tools\/sync\.mjs --check$/,
  /^(?:ls|dir|pwd|get-location|get-childitem)(?: [^|;&<>`]*)?$/,
];
const RO_DENY = /\b(?:push|commit|checkout|reset|clean|add|merge|rebase|pull|fetch|stash (?:push|pop|drop|apply)|branch -[dDmM])\b|\s--output/;

export const normalize = (cmd) => String(cmd).trim().replace(/\s+/g, ' ').toLowerCase();
export function isReadOnly(cmd) {
  if (typeof cmd !== 'string' || COMPLEX.test(cmd)) return false;
  const n = normalize(cmd);
  if (RO_DENY.test(n)) return false;
  return RO.some((re) => re.test(n));
}
const hashCmd = (cmd) => crypto.createHash('sha1').update(normalize(cmd)).digest('hex').slice(0, 16);

// --- marker (theo conversation): {last:{h,ts,denied}, mut:ts}. Moi loi -> fail-open (khong deny). ---
const file = (root, sid) => path.join(root, '.agy_guard', `${String(sid).replace(/[^\w.-]/g, '_')}.json`);
const readState = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

function save(root, f, st, now) {
  const d = path.dirname(f);
  fs.mkdirSync(d, { recursive: true });
  for (const n of fs.readdirSync(d).slice(0, 200)) {
    try { const p = path.join(d, n); if (now - fs.statSync(p).mtimeMs > 3600000) fs.rmSync(p, { force: true }); } catch {}
  }
  fs.writeFileSync(f, JSON.stringify(st));
}

// Ghi nhan 1 thao tac ghi (write_file/edit_file/lenh khong read-only) -> lenh read-only sau do khong tinh la lap.
export function noteMutation(root, sid, now = Date.now()) {
  try { if (!root || !sid) return; const f = file(root, sid); save(root, f, { ...readState(f), mut: now }, now); } catch {}
}

// Lenh read-only: neu giong het lenh vua chay (<= ttl, khong co ghi xen giua, chua tung bi chan) -> tra ly do deny (1 lan);
// nguoc lai ghi nhan va tra null. Lenh khong read-only: ghi nhan mutation, tra null.
export function repeatReason(root, sid, cmd, ttlMs = 60000, now = Date.now()) {
  try {
    if (!root || !sid || typeof cmd !== 'string') return null;
    const f = file(root, sid);
    const st = readState(f);
    if (!isReadOnly(cmd)) { save(root, f, { ...st, mut: now }, now); return null; }
    const h = hashCmd(cmd);
    const l = st.last;
    if (l && l.h === h && now - l.ts <= ttlMs && !(st.mut && st.mut >= l.ts) && !l.denied) {
      save(root, f, { ...st, last: { ...l, denied: true } }, now); // chan 1 lan; lan tiep theo cho qua
      return `Lenh nay vua chay ${Math.round((now - l.ts) / 1000)}s truoc va chua co thay doi file; dung ket qua o tren (neu that su can, chay lai se duoc cho qua).`;
    }
    save(root, f, { ...st, last: { h, ts: now, denied: false } }, now);
    return null;
  } catch { return null; }
}

// Log deny (de digest dem 'denied'): <root>/.agy_guard/denied.log, moi dong "ISO-ts<TAB>kind". Loi -> bo qua.
export function logDeny(root, kind, now = Date.now()) {
  try {
    if (!root) return;
    const d = path.join(root, '.agy_guard');
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'denied.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 200000) fs.writeFileSync(f, '');
    fs.appendFileSync(f, new Date(now).toISOString() + '\t' + kind + '\n');
  } catch {}
}
export function countDenied(root, date) {
  try { return fs.readFileSync(path.join(root, '.agy_guard', 'denied.log'), 'utf8').split('\n').filter((l) => l.startsWith(date)).length; } catch { return 0; }
}
