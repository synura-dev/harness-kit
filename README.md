# harness-kit

Plugin Claude Code: lop rang buoc tat dinh cho agent (guard, approval, data zone, audit, hook dispatcher, cong CLI). Zero dependency, can Node.

- Cai: `/plugin install harness-kit --marketplace <owner>/<repo>` (repo nay chua .claude-plugin/marketplace.json).
- Repo nay la NGUON cua code loi; sua o day. Xem docs/SOURCE-HISTORY.md (lich su truoc cutover nam o hub).
- Du lieu: <du an>/.harness/data (tu them .gitignore). PLUGIN_ROOT chi doc.
- Workspace tuy bien (vd hub): du an co `config/workspace/default.json` hoac `config/hub/default.json` (file cau hinh tool `workspace`, ten cu `hub`) -> hook (`hooks/run.mjs`) va CLI `harness` dat `HUB_DATA_DIR=<du an>/data`, `HARNESS_CONFIG_DIR=<du an>/config` (khong ghi de bien da dat; repo nguon plugin khong tinh). Loi suy workspace/wrapper: fail-open + mot dong `HKERR {...}` ra stderr (HK-HOOK-001/002).
- Guard chi o muc no luc tot nhat (hook fail-open); nen tu them deny trong settings cua du an.
- Khong bat cung luc voi dispatcher cung loai trong .claude/settings.json (hook chay doi).
