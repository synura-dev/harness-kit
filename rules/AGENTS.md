# harness (lop dung chung cho moi CLI)

- `harness` la lop dung chung cho moi CLI agent; Claude va agy dung chung du lieu (audit, kho tri thuc, du an/task), khong dung chung cau hinh.
- Goi `harness <domain> <lenh>`. Lenh co san tren PATH (plugin dua `bin/` vao PATH). Tra cuu: `harness` (liet ke domain), `harness doctor` (kiem moi truong).
- Lenh doc tu chay duoc khong can duyet: `harness doctor`, `harness data ls|stat|scan`, `harness observe usage|report`, `harness knowledge search|get|fact|role`, `harness projects list|get|tasks`.
  Viet MOT lenh don, khong pipe/`&&`/redirect/quote; lenh khac (ghi, `ext`, `install`, co `--apply|--yes|--force`) can nguoi duyet.
- Truoc khi lam: tra kho tri thuc chung `harness knowledge search <tu khoa>` / `harness knowledge get <id>`.
  Checklist vai tro: `harness knowledge role <ten-agent>`.
- Bai hoc va ket qua ben (quyet dinh, tham chieu): bao lai de ghi ve kho chung (`harness knowledge add`), khong luu rieng trong thu muc cua CLI.
- Khong doc file tho trong `.harness/data` (hoac thu muc data cua du an); doc qua lenh `harness`.
