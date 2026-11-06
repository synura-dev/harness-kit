# observe/report: bao cao tuan khai bao

- Muc = JSON trong `defaults/*.json` (id, title, source audit|candidates|ledger|inventory, filter, group_by, metric (chuoi | mang cot {as,metric,filter,rate_filter}), window_days (0 = toan thoi gian), compare prev_window|baseline, format table|kpi|list, limit, order, empty_note).
- Metric: count, sessions, per_session[:F], per_task, per_1000, sum:F, last:F, rate (rate_filter). F = `a|b.c` (truong dau co gia tri).
- Ghi de: `<project>/.harness/report/<ten>.json` (tron nong theo ten file); `{"enabled":false}` tat; file moi them muc.
- `harness observe report [--days N] [--out -|obsidian] [--dry-run] [--baseline] [--weekly]`. Baseline: `ledger/report-baseline.json`. Obsidian: goi `harness obsidian put --section "Noi dung=..."` (qua dai/loi -> in stdout, hub tu put).
- Hang tuan: hook ledger SessionStart goi `kickReport` (<= 1 lan/7 ngay, khoa 10 phut, detached, timeout cung).
- So sanh: cot cua so lien truoc (ten theo do dai: hom qua/tuan truoc/N ngay truoc) + trung binh K cua so truoc (mac dinh K=7) + baseline. Tham so: `--avg-of K`, `--compare all|prev|avg|baseline`, config `report` (loadConfig: config/report*.json, env HARNESS_REPORT_AVG_OF/COMPARE); mac dinh trong `REPORT_DEFAULTS` (run.mjs). `--days 1` ghi `harness-daily-YYYY-MM-DD.md`. Task done lay tu ext `projects` (`projects tasks --all --json`, completed/khong tinh cancelled; fail-open).
