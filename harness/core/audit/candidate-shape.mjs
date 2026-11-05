// Hop dong candidate chung (xem CANDIDATE.md): moi nguon dau vao cua engine luat tra cung dang nay.
// {id, kind:'error'|'pattern'|..., fp, count, sessions, first_ts, last_ts, sample, cost_ms?, tool?}
import { repeatedFailureCandidates } from './candidates.mjs';
import { extractErrorDetails, sanitizeHintPath } from './signature.mjs';
import { maskSecrets } from './gate-event.mjs';

export const CANDIDATE_FIELDS = Object.freeze(['id', 'kind', 'fp', 'count', 'sessions', 'first_ts', 'last_ts', 'sample']);
const SAMPLE_CHARS = 200;

/** Kiem hop dong; tra mang loi (rong = hop le). */
export function validateCandidate(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['candidate khong phai object'];
  for (const f of ['id', 'kind', 'fp']) if (typeof c[f] !== 'string' || !c[f]) errs.push(`${f} phai la chuoi khong rong`);
  for (const f of ['count', 'sessions']) if (!Number.isInteger(c[f]) || c[f] < 0) errs.push(`${f} phai la so nguyen >= 0`);
  for (const f of ['first_ts', 'last_ts']) if (c[f] != null && typeof c[f] !== 'string') errs.push(`${f} phai la chuoi ISO hoac null`);
  if (typeof c.sample !== 'string') errs.push('sample phai la chuoi');
  if (c.cost_ms != null && !Number.isFinite(c.cost_ms)) errs.push('cost_ms phai la so');
  return errs;
}

/** Bao repeatedFailureCandidates: events -> candidate[] kind='error' (>= minCount lan, mac dinh 2), dung hop dong. */
export function failureCandidates(events, nowIso = new Date().toISOString(), { minCount = 2 } = {}) {
  return repeatedFailureCandidates(events, nowIso)
    .filter((x) => x.evidenceCount >= minCount)
    .map((x) => {
      const evs = (x._evs || []).slice().sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
      const last = evs[evs.length - 1] || {};
      return {
        id: x.id, kind: 'error', fp: x._fp || x.id, count: x.evidenceCount,
        sessions: new Set(evs.map((e) => e.sid || e.session_id || '-')).size,
        first_ts: evs[0] ? evs[0].ts || null : null, last_ts: last.ts || null,
        sample: maskSecrets(sanitizeHintPath(String(extractErrorDetails(last) || ''))).slice(0, SAMPLE_CHARS),
        tool: last.tool || (last.data && last.data.tool) || 'unknown',
        occ: evs.slice(-50).map((e) => ({ sid: e.sid || e.session_id || '-', ts: e.ts || null })), // cho ledger (acted/ignored)
      };
    })
    .sort((a, b) => b.count - a.count);
}
