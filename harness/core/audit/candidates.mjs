import crypto from 'node:crypto';
import { messageFingerprint, normalizeFull, TRUNC_PREFIX_MIN } from './normalize-message.mjs';
import { isHookRun } from './signals.mjs';
import { sanitizeHintPath, normalizeErrorSignature, extractErrorDetails, buildRegexPattern } from './signature.mjs';

function hashString(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 12);
}

// Nhom su kien ok=false theo thong diep chuan hoa DAY DU (+ error_fp luu san); >=2 lan -> repeated_failure.
// Khoa chinh tac cua nhom = fp thong diep nho nhat theo thu tu tu dien -> id/fp khong phu thuoc thu tu su kien / cua so truot.
export function repeatedFailureCandidates(events, nowIso) {
  const failedSigCounts = new Map();
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const info = new Map(); // node mfp -> {tool, full, trunc}
  const pending = [];
  for (const ev of events) {
    if (isHookRun(ev)) continue; // HookRun khong phai tool call
    if (ev.ok === false) {
      const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
      const tool = ev.tool || d.tool || 'unknown';
      const details = extractErrorDetails(ev);
      const norm = normalizeErrorSignature(tool, details);
      const stored = typeof d.error_fp === 'string' && d.error_fp ? d.error_fp : null;
      const nm = normalizeFull(details);
      const recomputed = nm.text ? messageFingerprint(details, tool) : null;
      const nodes = [stored && `fp:${stored}`, recomputed && `mfp:${recomputed}`].filter(Boolean);
      for (const n of nodes) { if (!parent.has(n)) parent.set(n, n); }
      for (const n of nodes.slice(1)) union(nodes[0], n);
      if (recomputed && !info.has(`mfp:${recomputed}`)) info.set(`mfp:${recomputed}`, { tool, full: nm.text, trunc: nm.truncated });
      pending.push({ ev, nodes, norm, stored, recomputed });
    }
  }
  // Ban bi cat "..." (tien to >= 80) gop voi ban day du cung tool co cung tien to.
  const infos = [...info.entries()];
  for (const [tn, t] of infos) {
    if (!t.trunc || t.full.length < TRUNC_PREFIX_MIN) continue;
    for (const [nn, n] of infos) if (nn !== tn && n.tool === t.tool && n.full.startsWith(t.full)) union(tn, nn);
  }
  const canon = new Map(); // root -> fp nho nhat
  for (const { nodes, stored, recomputed } of pending) {
    if (!nodes.length) continue;
    const root = find(nodes[0]);
    const c = recomputed || stored;
    if (c && (!canon.has(root) || c < canon.get(root))) canon.set(root, c);
  }
  // uu tien fp thong diep (mfp) hon fp luu khi nhom co ca hai
  const mfpMin = new Map();
  for (const { nodes, recomputed } of pending) {
    if (!nodes.length || !recomputed) continue;
    const root = find(nodes[0]);
    if (!mfpMin.has(root) || recomputed < mfpMin.get(root)) mfpMin.set(root, recomputed);
  }
  for (const { ev, nodes, norm } of pending) {
    const root = nodes.length ? find(nodes[0]) : null;
    const key = root ? (mfpMin.get(root) || canon.get(root) || root) : norm.signature;
    if (!failedSigCounts.has(key)) failedSigCounts.set(key, { count: 0, norm, fp: key, evs: [] });
    const entry = failedSigCounts.get(key);
    entry.count++;
    entry.evs.push(ev);
  }
  const out = [];
  for (const [sig, data] of failedSigCounts.entries()) {
    if (data.count >= 2) {
      const rawHint = `[Repeated Failure] Tool ${data.norm.tool} failed repeatedly: ${data.norm.cleaned.slice(0, 100)}`;
      out.push({
        id: `rep_${hashString(sig)}`,
        category: 'repeated_failure',
        tier: 'T1',
        pattern: buildRegexPattern(data.norm.cleaned, data.norm.raw),
        hint: sanitizeHintPath(rawHint),
        evidenceCount: data.count,
        status: 'incubating',
        createdAt: nowIso,
        lastSeenAt: nowIso,
        ...(data.evs[0] && typeof data.evs[0].source === 'string' ? { source: data.evs[0].source } : {}), // external: ext:<id>
        _evs: data.evs,
        _fp: data.fp,
      });
    }
  }
  return out;
}
