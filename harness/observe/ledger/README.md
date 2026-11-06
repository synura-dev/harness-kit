# observe/ledger: so su co + engine luat khai bao + canh bao co cooldown

- Luat = 1 file JSON (`defaults/*.json`). Ghi de: `<project>/.harness/rules/<cung-ten>.json` thay ban mac dinh; `{"enabled":false}` tat; ten moi = them luat. Khong registry, khong config bat buoc.
- Truong: `source` candidates|audit|ledger, `days`, `filter` (truong audit: actor, tool, kind, signal, project, scope(hub|other), event, edit; candidate: kind, fp, tool...), `group_by`, `metric` (count|sessions|sum:cost_ms), `threshold`, `action` (log|warn|propose|report), `cooldown_hours`, `message` ({count} {sessions} {key} {sample} {value}).
- Luat mac dinh: repeated-error (>=3 loi lap va >=2 phien/7 ngay, warn, 24h), main-self-edit, main-self-verify (main tu sua/chay test o du an khac hub, warn), warn-ignored (canh bao bi bo qua -> report).
- So: `data/system/ledger/ledger.jsonl` (status open|warned|acted|ignored|resolved). Doc: `harness observe ledger [--status X] [--limit N]`.
- Job lo `job.mjs` (nen, <=1 lan/gio, timeout cung 25s) tinh va ghi so. Hook `hook.mjs` (SessionStart/UserPromptSubmit) CHI doc so, phat <=3 dong, ghi warn_ts; SessionStart kick job khi het han. Job gom candidates (error) + patterns + prune, roi chay autopilot evolve (<=1 lan/24h; chi tu ap luat canh bao evolve-*.json).
- Candidate dung hop dong `core/audit/CANDIDATE.md`.
