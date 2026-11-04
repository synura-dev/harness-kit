# dispatch - 1 hook cho moi su kien (Dot 5.2b)

`node harness/hooks/dispatch/run.mjs <Event> [module-id]` (Claude), `node ../harness/hooks/dispatch/agy.mjs <Event>` (agy, cwd = `.agents/`).
Da duoc noi: `.claude/settings.json` va `.agents/hooks.json` deu tro vao dispatcher (1 muc/su kien, tu 5.3).

## Cach chay
1. Doc stdin 1 lan (tran `maxInputBytes`, `stdinTimeoutMs`). JSON hong / rong / qua lon / qua han -> fail-open `{}` exit 0 + vet gate `dispatch:fail-open` (chi ly do ngan, KHONG ghi stdin). WorktreeCreate -> exit 1 + stderr nhu hook cu.
2. `modules.mjs` (`ORDER`): moi su kien -> danh sach module theo thu tu; chi import module cua su kien do. Loc theo `events` + `tools` (regex ten tool).
3. Chay tuan tu, `handle(event, input, {write:false, deadline})`: moi module co `timeoutMs` rieng (Promise.race) va `onError` rieng (open = bo qua; closed = deny). Tran tong theo su kien (`budgetsMs`) < `timeout` settings; het tran -> tra phan da co. `updatedInput` ap tuan tu (module sau thay input da sua). Module gate (guard, approval, bash-guard, model-policy) sau mot `deny` bi bo qua; audit van chay.
4. `merge.mjs`: decision manh nhat (deny > ask > allow, `DECISION_ORDER`), reason noi ` | `, updatedInput chi khi khong deny, additionalContext noi, block (Stop...).
5. In dinh dang Claude (PreToolUse `hookSpecificOutput`, Stop `{decision:'block'}`, UserPromptSubmit/SessionStart `additionalContext`, WorktreeCreate in duong dan), roi ghi MOT lan moi `records` qua writer cua core (gate/audit/guard/worktree).
6. `agy.mjs`: cung loi, ho so agy: Pre = `{"decision":"allow|deny"}` (khong bao gio `{}`), con lai `{}`. Module: audit-agy, bash-guard-agy, session-agy (doctor).

## Gioi han that
- Timeout trong cung tien trinh KHONG ngat duoc code dong bo (regex, spawnSync): giu tran `maxCommandChars`, `hardTimeoutMs`, kiem thoi gian giua module. Hook het gio = khong chan (tru khi `onFailure: block`).
- Chain moi doi hook song song -> tuan tu: do p50/p95 (`docs/research/hook-latency-baseline.md`).
- Chua kiem voi Claude that: `ask` kem `updatedInput` trong cung output (git push: approval ask + bash-guard timeout) [can tra].

## Test
`run.test.mjs` (golden): so output/exit/vet audit voi chuoi hook tach roi truoc 5.3 (stub da xoa, chi con golden), `unit.test.mjs` (merge, loi module, timeout, chuoi updatedInput), `agy.test.mjs`.
