// Noi dung tat dinh cho de xuat muc 1: file luat (engine ledger) va text inject. Thuan, khong IO.
const clean = (s, n) => String(s ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Dinh nghia luat canh bao cho 1 candidate: khop dung fp, canh bao + goi y fix. */
export function ruleDef(cand) {
  const fix = clean(cand.hint, 120) || 'harness evolve candidates';
  return {
    desc: `evolve: canh bao loi lap ${clean(cand.tool, 30)} (${clean(cand.fp || cand.id, 40)})`,
    source: 'candidates', days: 7, filter: { fp: cand.fp }, metric: 'count', threshold: 1,
    action: 'warn', cooldown_hours: 24,
    message: `loi lap {count} lan: ${clean(cand.sample, 80)} -> fix_command: ${fix}`.slice(0, 200),
  };
}

export const ruleText = (cand) => JSON.stringify(ruleDef(cand), null, 2) + '\n';

/** Text ngu canh inject (markdown ngan). */
export const injectText = (cand) => `# evolve ${clean(cand.id, 60)}\n\nLoi lap ${clean(cand.tool, 30)} (fp=${clean(cand.fp, 40)}, ${Number(cand.count) || 0} lan): ${clean(cand.sample, 120)}\nGoi y: ${clean(cand.hint, 160) || 'harness evolve candidates'}\n`;
