# Evolve: do hieu qua sau apply (harness-kit-0060) - Design

## Intent
Evolve phai biet rule tu dong ap co that su giup khong: giu rule co ich, rollback rule khong ich, va hien ket qua. Pham vi: CHI de xuat kind `rule`. Non-goals: kind khac, tich hop report-engine, doi retention audit, dashboard, do thay doi khong phai evolve. Anti-goal: rollback do nhieu (noise).

## Van de hien tai (verified)
`harness/evolve/loop/autopilot.mjs:150-165` tu rollback moc muc 1 sau `CFG.rollbackAfterDays=7` neu count khong giam. BUG: `count_before` lay tu cua so 30 ngay (`oracleDays=30`, autopilot.mjs:172; ghi vao rec `count_before: cand.count`) con count hien tai dung cua so 7 ngay (autopilot.mjs:153) -> so sanh lech, rollback gan nhu khong bao gio kich hoat (`shouldRollback`, autopilot.mjs:58).

## Quyet dinh (approved)
1. Baseline luc apply (rule): 7 ngay truoc apply tinh `target_count` (loi ok=false trong nhom fp cua proposal, cung cach gom nhom voi `core/audit/candidates.mjs`), `tool_calls` (su kien tool xong, thanh cong+that bai, cung loai tru nhu candidates.mjs, vd HookRun), `rate_per_1000 = target_count*1000/tool_calls`, `sessions`, `tokens_per_session` (su kien Stop), `corrections_per_session` (data.signal correction+interrupt). Luu `proposal.effect.baseline {window_days, from, to, ...}` (doc lap retention). Proposal da apply khong co baseline: tinh bu luc do dau tien neu audit con trong retention (30 ngay), khong thi verdict `insufficient` reason `no_baseline`.
2. Module moi `harness/evolve/loop/effect.mjs`: `measureDue(proposals, now, opts)` chon proposal rule da apply, chua co verdict cuoi, `now >= applied_at+7d`; MOT luot doc audit cho moi cua so den han (khong moi rule mot luot), ton trong limits cua `core/config/audit-config.mjs` (`query_timeout_ms` 30s, `query_max_rows`, `query_max_bytes`). Luot bi cat (truncated) -> `insufficient` reason `truncated`, khong hanh dong.
3. Verdict tren `rate_per_1000` (nguong de trong defaults cua effect.mjs, khong them file config): after <= 0.7*before -> `better` (giu); after >= 1.3*before -> `worse` (rollback); con lai -> `unchanged` (rollback: rule canh bao khong giup chi ton context). `insufficient` khi `tool_calls` cua so after < toi thieu hoac baseline `target_count` < 3: do lai o lan chay sau toi da 21 ngay sau apply, het han -> `inconclusive` (giu, khong hanh dong). Metric phu (`tokens_per_session`, `corrections_per_session`) ghi lai va danh dau neu te hon >= 30%, KHONG BAO GIO kich hoat rollback.
4. Ban ghi: `proposal.effect = {metric:'target_rate_per_1000', baseline, after, verdict, reason, measured_at, action, side}`; them dong `op:'effect'` vao `evolve/applied.jsonl`. `evolve list` them cot verdict; `evolve log` hien dong effect.
5. Thay khoi rollback cu (30/7) cua autopilot bang quyet dinh theo effect; rollback van tu dong cho rule muc 1 va ghi ly do.
6. Quy mo: baseline luu trong proposal, gom batch mot luot, chuan hoa per-1000, hinh dang effect chung de tai dung sau nay.

## Builder's call (chua chot)
- Toi thieu `tool_calls` cua so after: mac dinh 200 (hang so `EFFECT.minToolCalls`).
- Cua so after: 7 ngay ke tu `applied_at` den `now`; lan do lai van dung 7 ngay cuoi toi `now`.
- fp group cua proposal: `proposal.evidence.fp` (+ `legacy_fps`); dung lai ham gom nhom cua candidates.mjs thay vi viet lai.
- `applied_at` lay tu dong apply trong `applied.jsonl` (`ts`) khi proposal thieu truong.
- Dem tool_calls: chi su kien `type=tool` PostToolUse/PostToolUseFailure, loai HookRun bang `isHookRun`.

## Rui ro
Doc audit 30 ngay: gioi han bang limits + `truncated`. Rate nhieu khi mau nho: guard bang `minToolCalls` va `target_count>=3`. Rule bi rollback roi apply lai: effect gan voi `ver`, khong do lai ban cu.
