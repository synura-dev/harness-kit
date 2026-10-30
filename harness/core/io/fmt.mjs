// Dinh dang thoi luong dung chung (audit-review, digest).
export const fmtDur = (ms) => {
  if (!(ms >= 0)) return '0s';
  const s = Math.round(ms / 1000);
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h${String(m).padStart(2, '0')}m`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m${String(rem).padStart(2, '0')}s`;
  }
  return `${s}s`;
};

/** So huu han hoac null (khong ep kieu: chuoi so -> null). Dung chung hook audit va observe/views. */
export const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
