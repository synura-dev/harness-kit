// Hop dong chung cho do hao token theo van de (T2-T9): hang so, hinh dang Segment, ham thuan dung chung.
// Khong I/O, khong phu thuoc. Hinh dang suy ra tu cac truong audit.mjs thuc su ghi (envelope v2):
//   envelope: {ts ISO, type ('prompt'|'tool'|'stop'|'session'|... ; 'prompt' cat doan), event (UserPromptSubmit|PostToolUse|
//     PostToolUseFailure|Stop|SubagentStart|SubagentStop), sid, agent_id|null, agent_type|null, actor, cwd, tool, target,
//     ok, turns, tokens_in (= input + cache_creation), tokens_out, origin ('noise'|'dispatch'|...), data}
//   data (khi co): task_id, error_fp, files_touched[], prompt_kw[<=8 tu chuan hoa], prompt_hash, tokens_cache (cache_read, cumulative),
//     usage {input, output, cache_creation, cache_read, msgs, first_ctx} (delta moi Stop; first_ctx = input+cache_creation+cache_read
//     cua message dau trong delta), out_len (Bash: do dai stdout+stderr, KHONG noi dung), phantom, run_kind, run_id.
//   Luu y: CONG `data.usage` (delta) cua cac Stop trong doan; KHONG cong `tokens_in` cua Stop (LUY KE); SubagentStop ghi tokens_in/tokens_out LUY KE theo agent_id.

/**
 * Segment = doan tu mot prompt den prompt ke tiep cung sid (T3 `segment()` tra ve).
 * @typedef {object} Segment
 * @property {string} sid                      session id
 * @property {string|null} start_ts            ISO ts su kien dau doan
 * @property {string|null} end_ts              ISO ts su kien cuoi doan
 * @property {string[]} prompt_kw              data.prompt_kw cua prompt mo doan ([] neu doan 0)
 * @property {{task:string|null, plan:string|null, branch:string|null, fp:string|null, kw:string|null}} keys  khoa ung vien theo loai (chua gom vao `problem`)
 * @property {string|null} problem             khoa van de da chon (uu tien task>plan>branch>err>kw), vd 'plan:slug'; null = thua khoa doan truoc
 * @property {'high'|'mid'|'low'|null} precision  task/plan=high, branch/err=mid, kw=low
 * @property {string|null} family              err -> id ledger entry chua fp; khac -> '<loai>:<slug>'
 * @property {{input:number, output:number, cache_read:number, cache_creation:number}} tokens  tong data.usage cac Stop trong doan (KHONG gom subagent)
 * @property {number} eff_tokens               effTokens(tokens) (khong gom sub_tokens)
 * @property {number} turns                    tong usage.msgs
 * @property {number} tools                    so PostToolUse + PostToolUseFailure
 * @property {number} fetches                  so lan lay thong tin (kpi-info-fetch hoac `harness knowledge get|search`)
 * @property {string[]} kfetch                 doc id sau `harness knowledge get`
 * @property {number} wall_ms                  prompt dau -> Stop cuoi (0 neu thieu)
 * @property {number} sub_tokens               sum MAX luy ke (tokens_in+tokens_out) theo agent_id cua SubagentStop co SubagentStart trong doan; phantom = 0
 */

export const LIMITS = Object.freeze({
  maxEvents: 200000, maxSegments: 5000, maxProblems: 2000, timeoutMs: 15000, lookbackDays: 28,
  indexTtlDays: 90, cacheReadWeight: 0.1, minSide: 3, maxDupPairs: 50, maxBlocks: 3000,
});

/** @returns {Segment} doan rong, moi lan goi la doi tuong moi. */
export function emptySegment() {
  return {
    sid: '', start_ts: null, end_ts: null, prompt_kw: [],
    keys: { task: null, plan: null, branch: null, fp: null, kw: null },
    problem: null, precision: null, family: null,
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    eff_tokens: 0, turns: 0, tools: 0, fetches: 0, kfetch: [], wall_ms: 0, sub_tokens: 0,
  };
}

/** input + cache_creation + output + cacheReadWeight * cache_read; thieu/khong phai so -> 0. */
export function effTokens(t) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const x = t || {};
  return n(x.input) + n(x.cache_creation) + n(x.output) + LIMITS.cacheReadWeight * n(x.cache_read);
}

/** Trung vi; mang rong -> null. */
export function median(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Dinh tuyen (T13): gia TUONG DOI (haiku 1, sonnet 3, opus 5). agy KHONG co gia (quota rieng, khong ep 0): chi do token, nhan "tokens, unpriced". */
export const ROUTING = Object.freeze({
  priceRel: Object.freeze({ haiku: 1, sonnet: 3, opus: 5 }),
  largeReadChars: 400000, // ~100k token
  builderTurns: 25,
  riskRe: /(^|\/)(auth|perm|permission|permissions|guard|deploy|secret|secrets|migrate|migration|migrations|security)(\/|\.|$)/i,
  overreadChars: 20000, // ~5k token: main doc tong out_len > nguong => main_overread
  redoMs: 24 * 3600 * 1000,
});

/** lowercase, d-gach -> d, NFD bo dau, gop khoang trang, trim. */
export function foldText(s) {
  return String(s ?? '').toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}
