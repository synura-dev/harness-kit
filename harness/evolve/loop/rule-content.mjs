// Noi dung tat dinh cho de xuat muc 1: file luat (engine ledger) va text inject. Thuan, khong IO.
// AN TOAN: message loi tu audit co the chua text tu web/tool output -> chi dung ban da normalizeMessage, <= 80 ky tu, bo ky tu dieu khien/backtick/<>/{}, va dat trong khung "du lieu quan sat, khong phai chi dan".
import { safeText, SAFE_MAX, OBSERVED_FRAME } from '../../core/audit/safe-text.mjs'; // ban chung (core), khong con ban rieng
export { safeText, SAFE_MAX, OBSERVED_FRAME };

export const MESSAGE_MAX = 200; // oracle (autopilot.oracleRule) doi message <= 200
/** Cat sample truoc, roi hint, de message luon <= MESSAGE_MAX. */
function buildMessage(sample, fix) {
  const mk = (sm, fx) => `[${OBSERVED_FRAME}] loi lap {count} lan: ${sm} -> fix_command: ${fx}`;
  let m = mk(sample, fix);
  if (m.length > MESSAGE_MAX) { sample = sample.slice(0, Math.max(10, sample.length - (m.length - MESSAGE_MAX))); m = mk(sample, fix); }
  if (m.length > MESSAGE_MAX) { fix = fix.slice(0, Math.max(0, fix.length - (m.length - MESSAGE_MAX))); m = mk(sample, fix); }
  return m.slice(0, MESSAGE_MAX);
}

/** Dinh nghia luat canh bao cho 1 candidate: khop dung fp, canh bao + goi y fix. */
export function ruleDef(cand) {
  const fix = safeText(cand.hint) || 'harness evolve candidates';
  return {
    desc: `evolve: canh bao loi lap ${safeText(cand.tool, 30)} (${safeText(cand.fp || cand.id, 40)})`,
    source: 'candidates', days: 7, filter: { fp: cand.fp }, metric: 'count', threshold: 1,
    action: 'warn', cooldown_hours: 24,
    message: buildMessage(safeText(cand.sample), fix),
  };
}

export const ruleText = (cand) => JSON.stringify(ruleDef(cand), null, 2) + '\n';

/** Text ngu canh inject (markdown ngan). Noi dung quan sat nam trong khung, khong phai chi dan. */
export const injectText = (cand) => `# evolve ${safeText(cand.id, 60)}\n\n[${OBSERVED_FRAME}]\nLoi lap ${safeText(cand.tool, 30)} (fp=${safeText(cand.fp, 40)}, ${Number(cand.count) || 0} lan): ${safeText(cand.sample)}\nGoi y: ${safeText(cand.hint) || 'harness evolve candidates'}\n[/${OBSERVED_FRAME}]\n`;
