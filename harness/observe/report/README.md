# observe/report: bao cao tuan khai bao

- Muc = JSON trong `defaults/*.json` (id, title, source audit|candidates|ledger|inventory, filter, group_by, metric (chuoi | mang cot {as,metric,filter,rate_filter}), window_days (0 = toan thoi gian), compare prev_window|baseline, format table|kpi|list, limit, order, empty_note).
- Metric: count, sessions, per_session[:F], per_task, per_1000, sum:F, last:F, rate (rate_filter). F = `a|b.c` (truong dau co gia tri).
- Ghi de: `<project>/.harness/report/<ten>.json` (tron nong theo ten file); `{"enabled":false}` tat; file moi them muc.
- `harness observe report [--days N] [--out -|obsidian] [--dry-run] [--baseline] [--weekly]`. Baseline: `ledger/report-baseline.json`. Obsidian: goi `harness obsidian put --section "Noi dung=..."` (qua dai/loi -> in stdout, hub tu put).
- Hang tuan: hook ledger SessionStart goi `kickReport` (<= 1 lan/7 ngay, khoa 10 phut, detached, timeout cung).
