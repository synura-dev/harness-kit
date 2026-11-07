# observe/ledger: so su co + engine luat khai bao + canh bao co cooldown

- Luat = 1 file JSON (`defaults/*.json`). Ghi de: `<project>/.harness/rules/<cung-ten>.json` thay ban mac dinh; `{"enabled":false}` tat; ten moi = them luat. Khong registry, khong config bat buoc.
- Truong: `source` candidates|audit|ledger, `days`, `filter` (truong audit: actor, tool, kind, signal, project, scope(hub|other), event, edit; candidate: kind, fp, tool...), `group_by`, `metric` (count|sessions|sum:cost_ms), `threshold`, `action` (log|warn|propose|report), `cooldown_hours`, `message` ({count} {sessions} {key} {sample} {value}).
- Luat mac dinh: repeated-error (>=3 loi lap va >=2 phien/7 ngay, warn, 24h), main-self-edit, main-self-verify (main tu sua/chay test o du an khac hub, warn), warn-ignored (canh bao bi bo qua -> report).
- Nguong repeated-error chinh duoc (khong file moi): `config.mjs` mac dinh trong code; ghi de qua config san co `config/ledger/local.json` hoac env `HARNESS_LEDGER_REPEATED_ERROR_{THRESHOLD,DAYS,MIN_SESSIONS,EXCLUDE}` (EXCLUDE = mang regex khop sample de bo qua; mac dinh RONG).
- So: `data/system/ledger/ledger.jsonl` (status open|warned|acted|ignored|resolved). Doc: `harness observe ledger [--status X] [--limit N]`.
- Job lo `job.mjs` (nen, <=1 lan/gio, timeout cung 25s) tinh va ghi so. Hook `hook.mjs` (SessionStart/UserPromptSubmit) CHI doc so, phat <=3 dong, ghi warn_ts; SessionStart kick job khi het han. Job gom candidates (error) + patterns + prune, roi chay autopilot evolve (<=1 lan/24h; chi tu ap luat canh bao evolve-*.json).
- Candidate dung hop dong `core/audit/CANDIDATE.md`.

## Do dung evolve (`harness evolve scan --kind deprecate`)
- Cua so du lieu thuc moi nguon (transcript, audit) = tu ngay som nhat co du lieu; thieu so voi `--days` -> `insufficient_window` (khong de xuat xoa).
- Kenh: tool | slash | read | preload. Loc maintenance: doc skill/lenh hang loat do bao tri bi bo (`maintenance_dropped`). Trung 1 lan dung nhieu nguon -> bo (`duplicates_dropped`).
- Nguon -> hanh dong: project `delete_in_repo`, plugin `edit_plugin_repo`, account `disable_on_claude_ai`; builtin/third_party/unknown chi `report_only`.
- `--cost`: chi phi = desc_tokens x so phien co nap + body_tokens x so lan dung. `--by-project`: dem theo du an. `--detail kind:id[,kind:id]`: kenh, ids, phien, mau su kien.
- Transcript `~/.claude/projects/**/*.jsonl` doc tang dan, cache `data/evolve/transcripts-cache.jsonl`; cold (cache rong) tran 4GB/120s, warm 512MB/20s, qua tran -> `truncated`.
- `harness doctor` them `skill-drift`: ban sao skill (.claude/skills, .agents/skills, plugin cache) lech hash -> warn, thieu -> info.
- Job nen (pruneSource) chi doc cache transcript (cacheOnly, khong parse); chua co cache -> bo qua transcript, skill = insufficient_window. CLI quet day du chay duoi khoa `transcripts.lock` canh cache (song -> `busy: pid X`). Goc transcript theo `CLAUDE_CONFIG_DIR`.
