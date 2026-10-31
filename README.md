# harness-kit

Plugin Claude Code: lop rang buoc tat dinh cho agent (guard, approval, data zone, audit, hook dispatcher, cong CLI). Zero dependency, can Node.

<p align="center"><img src="assets/icon.svg" width="64" alt="harness-kit"></p>

## Cai dat

```
/plugin marketplace add <owner>/<repo>
/plugin install harness-kit@harness-kit-marketplace
```

Xong, khong can setup them: khong launcher, khong `bin/harness.mjs` o du an, khong sua PATH. Hook Claude do plugin cung cap; CLI `harness` co trong PATH cua Bash tool.
Cho agy: chay `harness agy init` mot lan trong du an (sinh `.agents/hooks.json`, shim, `.agents/harness-agy.local.json`; thieu thi hook SessionStart/doctor tu sinh lai hoac bao `fix_command`). Agy goi CLI bang `node ./.agents/harness-agy-shim.mjs cli <lenh>` (process.execPath + duong dan tuyet doi, khong PATH).

- Repo nay la NGUON cua code loi; sua o day. Xem docs/SOURCE-HISTORY.md (lich su truoc cutover nam o hub).
- CLI: lenh `harness [<domain> [lenh]]` (bin/harness, bin/harness.cmd) co trong PATH cua Bash tool khi plugin bat (da kiem Claude Code 2.1.312, Windows Git Bash). Ngoai Claude: `node "<plugin>/bin/harness" ...`.
- Du lieu: <du an>/.harness/data (tu them .gitignore). PLUGIN_ROOT chi doc.
- Workspace tuy bien (vd hub): du an co `config/workspace/default.json` hoac `config/hub/default.json` (file cau hinh tool `workspace`, ten cu `hub`) -> hook (`hooks/run.mjs`) va CLI `harness` dat `HUB_DATA_DIR=<du an>/data`, `HARNESS_CONFIG_DIR=<du an>/config` (khong ghi de bien da dat; repo nguon plugin khong tinh). Loi suy workspace/wrapper: fail-open + mot dong `HKERR {...}` ra stderr (HK-HOOK-001/002).
- Guard chi o muc no luc tot nhat (hook fail-open); nen tu them deny trong settings cua du an.
- Khong bat cung luc voi dispatcher cung loai trong .claude/settings.json (hook chay doi).
