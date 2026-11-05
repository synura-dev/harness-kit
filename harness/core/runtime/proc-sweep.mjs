// Tien trinh nen: don so PID (liet ke tien trinh dong bo nam o day, khong nam trong hook). Timeout cung 30s. Khoi chay qua sweepBackground().
import { bgDoneOnExit, sweepNow } from './proc.mjs';

bgDoneOnExit();
const hard = setTimeout(() => process.exit(2), 30000);
try { await sweepNow({ dir: process.env.HARNESS_PROC_DIR || undefined }); } catch { /* fail-open */ }
clearTimeout(hard);
process.exit(0);
