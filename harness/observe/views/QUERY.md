# Audit query

Doc audit log (`$CLAUDE_AUDIT_DIR` hoac `$HUB_DATA_DIR/audit`, mac dinh `<hub>/data/audit`) ma khong can doc file tho.

```
node harness/cli/harness.mjs observe query --report summary --since 2026-10-20
node harness/cli/harness.mjs observe query --report writes --date 2026-10-24      # main (agent==null) vs subagent
node harness/cli/harness.mjs observe query --report timeline --session <id>
node harness/cli/harness.mjs observe query --type tool --tool Bash --limit 20 --format json
node harness/cli/harness.mjs observe query --report slow --backend node
```

Co: `--type --date --since --until --session --tool --agent (id|type|main) --event --ok true|false --actor main|sub --include-phantom (mac dinh LOAI dong data.phantom=true: SubagentStop khong agent_type/Start/transcript) --origin work|noise (mac dinh khong loc; dong cu: tinh lai tu cwd) --project --limit --report --format table|json|jsonl|md --backend auto|duckdb|node --timeout giay --max-bytes --max-rows --digest YYYY-MM-DD`.
Digest: `--digest DATE` (hoac `digest.mjs DATE`) ghi `<root>/digest/DATE.md` (bang phien x agent: tools, errors, tokens, duration), co gioi han nhu query.
Het han/qua gioi han -> in `truncated: timeout|max_bytes|max_rows`.
Report: summary, slow, errors, writes, timeline (can --session), hot-files, tokens, subagents, checkpoint (tom tat phien gan nhat), events (mac dinh).
Doc layout v2 `date=/type=/` va v1 cu `type=/date=/` (chi mo thu muc khop); dong JSON hong bi bo qua; `.state/` bi bo qua.

## Them report
Them 1 muc vao `reports.json` (khong sua loi): `name`, `description`, `sections[]` moi section co
`sql` (DuckDB, doc bang `ev`) va `node` (khai bao tuong duong: `where[{f,op,v}]`, `groupBy`, `aggs`, `select`, `orderBy`, `limit`).
Cot `ev`: type,date,ts,v,event,session_id,agent_id,agent_type,actor(main|sub),project,cwd,tool,target,target_kind,ok,dur_ms,turns,in_tok,out_tok,status,model,summary,origin (v1 va v2 deu map ve cot nay). Report tokens: max theo phien x agent (token Stop/SubagentStop la luy ke).
Hay ORDER BY du cot de hai backend ra cung ket qua.

## Prune
```
node harness/cli/harness.mjs observe prune                 # dry-run (mac dinh), retention_days mac dinh 30 trong defaults.mjs, ghi de bang audit.config.json / audit.config.local.json / env CLAUDE_AUDIT_RETENTION_DAYS
node harness/cli/harness.mjs observe prune --days 14 --yes # xoa that, xoa date=* (v2), type=*/date=* (v1) va digest/*.md cu hon retention
node harness/cli/harness.mjs observe prune --yes --once-per-day   # chi chay tay; KHONG co hook (SessionStart...) nao goi prune. Playbook weekly-maintenance chi chay dry-run
```

## Cai DuckDB (tuy chon, chi ghi chu)
Backend `auto` thu `duckdb` CLI trong PATH, roi package `@duckdb/node-api`; khong co thi dung Node thuan.
CLI: https://duckdb.org/docs/installation . Package: `bun add @duckdb/node-api` (chua cai o day).


## Lọc và khử trùng
- `--cli claude|agy` lọc theo CLI nguồn (node + DuckDB).
- Khử trùng là OPT-IN: mặc định TẮT, `--dedupe` bật (`--no-dedupe` vẫn nhận, không làm gì). Khóa: cli+sid+agent_id+tool_use_id+event+tool+target+ts (giây); chỉ bỏ ghi đôi đúng cùng cli. Không khớp chéo CLI (agy chạy audit.mjs của Claude có cli/sid khác nhau) nên không phát hiện được trùng kiểu đó.
- `--cli claude` gồm cả dòng cũ không có cli (coi là claude); dòng từ agy adapter giữ 'agy'.
- TODO (chưa xác minh): matcher agy hooks.json chỉ gồm run_command|write_file|edit_file; view_file/read chưa có bằng chứng chạy thật nên chưa thêm.
