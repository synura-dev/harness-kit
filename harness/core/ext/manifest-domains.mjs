// Danh sach domain cua manifest extension — MOT nguon cho ext-host (nap/chay) va ext-registry (register).
// Chuan: `domain` (string, nhu manifest hub that) + tuy chon `domains` dang object {ten: file|{file,...}} (nhu manifest core).
// Chap nhan them `domains` dang mang string. Khong import gi (nhe, dung duoc o ca cong CLI).
export function manifestDomains(m) {
  const out = [];
  if (m && typeof m.domain === 'string' && m.domain) out.push(m.domain);
  if (m && Array.isArray(m.domains)) out.push(...m.domains.filter((x) => typeof x === 'string' && x));
  else if (m && m.domains && typeof m.domains === 'object') out.push(...Object.keys(m.domains));
  return [...new Set(out)];
}
