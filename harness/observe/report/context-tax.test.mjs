import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextTax, derive, skillDesc } from './context-tax.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtax-'));
const w = (root, rel, s) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const val = (r, n) => (r.rows.find((x) => x.name === n) || {}).tokens;
const LONG = 'Khong duoc tu y xoa du lieu cua nguoi dung khi chua hoi';

test('2 file chung 1 dong dai (co/khong dau) -> dup_lines 1, output khong chua noi dung', () => {
  const p = mk();
  w(p, 'CLAUDE.md', `@AGENTS.md\n# t\n${LONG}\nshort\n`);
  w(p, 'AGENTS.md', `# a\nKhông được tự ý xóa dữ liệu của người dùng khi chưa hỏi\n`);
  w(p, '.claude/memory/MEMORY.md', '- idx\n');
  const r = contextTax({ projectDir: p });
  expect(val(r, 'dup_lines')).toBe(1);
  expect(r.dupRows).toEqual([{ loc: 'CLAUDE.md:3 = AGENTS.md:2', n: 2 }]);
  expect(JSON.stringify(r)).not.toContain('xoa du lieu');
  expect(val(r, 'rules_tokens')).toBeGreaterThan(0);
  expect(val(r, 'memory_index_tokens')).toBeGreaterThan(0);
  expect(val(r, 'static_tokens')).toBeGreaterThanOrEqual(val(r, 'rules_tokens'));
});

test('first_ctx: median Stop dau moi sid, bo usage.truncated, + calibration', () => {
  const p = mk(); w(p, 'CLAUDE.md', 'x'.repeat(400));
  const stop = (sid, u) => ({ event: 'Stop', sid, data: { usage: u } });
  const events = [stop('a', { first_ctx: 1000 }), stop('a', { first_ctx: 9 }), stop('b', { first_ctx: 3000 }), stop('c', { first_ctx: 77777, truncated: true }), stop('c', { first_ctx: 5 })];
  const r = contextTax({ projectDir: p, events });
  expect(val(r, 'first_ctx_tokens')).toBe(2000);
  expect(val(r, 'calibration_x100')).toBeGreaterThan(0);
});

test('thieu MEMORY.md/thu muc: khong co dong memory, khong nem; khong projectDir -> chi first_ctx', () => {
  const p = mk(); w(p, 'CLAUDE.md', 'hi');
  expect(val(contextTax({ projectDir: p }), 'memory_index_tokens')).toBeUndefined();
  expect(contextTax({ projectDir: '' }).rows).toEqual([]);
});

test('@import ngoai root bi bo qua (realpath + prefix)', () => {
  const p = mk(); const out = mk(); w(out, 'secret.md', 'S'.repeat(4000));
  w(p, 'CLAUDE.md', `@${path.join(out, 'secret.md')}\n`);
  expect(val(contextTax({ projectDir: p }), 'rules_tokens')).toBeLessThan(100);
});

test('derive: dedup qua MEMORY.md, deadline qua han -> truncated', () => {
  const p = mk(); w(p, 'CLAUDE.md', `${LONG}\n`); w(p, '.claude/memory/MEMORY.md', `${LONG}\n`);
  expect(derive.context_dupes({ projectDir: p, deadline: Date.now() + 5000 }).rows.length).toBe(1);
  expect(derive.context_tax({ projectDir: p, events: [], deadline: Date.now() - 1 }).truncated).toBe('timeout');
});

test('memory/*.md va agents/*.md khong tinh vao dup_lines', () => {
  const p = mk(); w(p, 'CLAUDE.md', `${LONG}\n`);
  w(p, '.claude/memory/a.md', `${LONG}\n`); w(p, '.claude/agents/x.md', `${LONG}\n`); w(p, '.agents/agents/x.md', `${LONG}\n`);
  expect(val(contextTax({ projectDir: p }), 'dup_lines')).toBe(0);
});

test('bo code fence, dong bang, frontmatter', () => {
  const p = mk();
  w(p, 'CLAUDE.md', `@AGENTS.md\n---\nkey: ${LONG}\n---\n\`\`\`\n${LONG}\n\`\`\`\n| ${LONG} | b |\n`);
  w(p, 'AGENTS.md', `---\nname: x\n---\n${LONG}\n`);
  expect(val(contextTax({ projectDir: p }), 'dup_lines')).toBe(0);
});

test('skillDesc: khoi > va | nhieu dong, mot dong', () => {
  expect(skillDesc('---\nname: a\ndescription: >\n  dong mot\n  dong hai\nmodel: x\n---\n')).toBe('dong mot\ndong hai');
  expect(skillDesc('---\ndescription: |-\n  a\n  b\n---\n')).toBe('a\nb');
  expect(skillDesc('---\ndescription: ngan\nname: z\n---\n')).toBe('ngan');
});

test('cham maxBytes -> truncated max_bytes', () => {
  const p = mk(); w(p, 'CLAUDE.md', 'x'.repeat(300000));
  expect(contextTax({ projectDir: p }).truncated).toBe('max_bytes');
});

test('SKILL.md > 8KB chi doc phan dau (mo ta), khong bao truncated', () => {
  const p = mk(); w(p, '.claude/skills/big/SKILL.md', `---\nname: big\ndescription: mo ta ngan\n---\n${'x'.repeat(20000)}\n`);
  expect(contextTax({ projectDir: p }).truncated).toBeNull();
});

test('projectDir tu tham so thang env; memo dung chung cho 2 derive', () => {
  const p = mk(); const q = mk(); w(p, 'CLAUDE.md', 'a'.repeat(400)); w(q, 'CLAUDE.md', 'b'.repeat(40000));
  const old = process.env.CLAUDE_PROJECT_DIR; process.env.CLAUDE_PROJECT_DIR = q;
  try {
    const memo = {};
    const t = derive.context_tax({ projectDir: p, events: [], deadline: Infinity, memo });
    expect(t.rows.find((r) => r.name === 'rules_tokens').tokens).toBe(100);
    const before = memo[p];
    expect(before).toBeTruthy();
    derive.context_dupes({ projectDir: p, deadline: Infinity, memo });
    expect(memo[p]).toBe(before);
  } finally { if (old === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = old; }
});

