import crypto from 'node:crypto';
import { sanitizeHintPath, normalizeErrorSignature, extractErrorDetails, buildRegexPattern } from './signature.mjs';

function hashString(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 12);
}

// Nhom su kien ok=false theo error_fp (hoac chu ky chuan hoa); >=2 lan -> repeated_failure.
export function repeatedFailureCandidates(events, nowIso) {
  const failedSigCounts = new Map();
  for (const ev of events) {
    if (ev.ok === false) {
      const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
      const tool = ev.tool || d.tool || 'unknown';
      const norm = normalizeErrorSignature(tool, extractErrorDetails(ev));
      const fp = typeof d.error_fp === 'string' && d.error_fp ? d.error_fp : null;
      const key = fp ? `fp:${fp}` : norm.signature;
      if (!failedSigCounts.has(key)) {
        failedSigCounts.set(key, { count: 0, norm, fp, evs: [] });
      }
      const entry = failedSigCounts.get(key);
      entry.count++;
      entry.evs.push(ev);
    }
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
