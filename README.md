# harness-kit

Plugin Claude Code: lop rang buoc tat dinh cho agent (guard, approval, data zone, audit, hook dispatcher, cong CLI). Zero dependency, can Node.

<p align="center"><img src="assets/icon.svg" width="64" alt="harness-kit"></p>

## Cai dat

```
/plugin marketplace add synura-dev/harness-kit
/plugin install harness-kit@synura
```

Repo private: can dang nhap GitHub (git credential) co quyen doc repo thi `marketplace add` va cap nhat moi chay duoc.

Xong, khong can setup them: khong launcher, khong `bin/harness.mjs` o du an, khong sua PATH. Hook Claude do plugin cung cap; CLI `harness` co trong PATH cua Bash tool.
Lenh `harness` cho PowerShell/cmd/bash cua user (ngoai Claude): hook SessionStart tu cai o phien Claude dau tien (xem muc CLI duoi); mo terminal moi la dung duoc.
Cho agy: chay `harness agy init` mot lan trong du an (sinh `.agents/hooks.json`, shim, `.agents/harness-agy.local.json`; thieu thi hook SessionStart/doctor tu sinh lai hoac bao `fix_command`). Agy goi CLI bang `node ./.agents/harness-agy-shim.mjs cli <lenh>` (process.execPath + duong dan tuyet doi, khong PATH).

- Repo nay la NGUON cua code loi; sua o day. Xem docs/SOURCE-HISTORY.md (lich su truoc cutover nam o hub).
- CLI: lenh `harness [<domain> [lenh]]` (bin/harness, bin/harness.cmd) co trong PATH cua Bash tool khi plugin bat (da kiem Claude Code 2.1.312, Windows Git Bash). Ngoai Claude (PowerShell/cmd/bash cua user): hook SessionStart `build/user-shim` tu dong ghi shim `harness` vao MOT thu muc co dinh cho ca may (Windows `%LOCALAPPDATA%\harness-kit\bin`: `harness.cmd` + `harness` cho Git Bash; POSIX `~/.local/bin`), them thu muc do vao PATH user mot lan (Windows: noi vao cuoi HKCU\Environment Path, giu REG_EXPAND_SZ, khong setx; POSIX: mot dong co marker trong `~/.profile`, macOS `~/.zprofile`) va xoa shim cu cua harness-kit o cho khac (vd `%APPDATA%\npm`). Shim chon ban plugin moi nhat trong cache luc chay nen nang cap plugin khong can cai lai. Khong ghi de file la; chay tu nguon (khong cache plugin) thi bo qua. Ban tay, cung logic: `harness install --shim [--dir D] [--dry-run] [--force]`. Tat: `HOOK_USER_SHIM_ENABLED=0`. Go: xoa thu muc shim va bo no khoi PATH user. Doctor canh bao (`[warn]` nhom shim) khi thieu/lech/chua tren PATH.
- Du lieu: <du an>/.harness/data (tu them .gitignore). PLUGIN_ROOT chi doc.
- Workspace tuy bien (vd hub): du an co `config/workspace/default.json` hoac `config/hub/default.json` (file cau hinh tool `workspace`, ten cu `hub`) -> hook (`hooks/run.mjs`) va CLI `harness` dat `HUB_DATA_DIR=<du an>/data`, `HARNESS_CONFIG_DIR=<du an>/config` (khong ghi de bien da dat; repo nguon plugin khong tinh). Loi suy workspace/wrapper: fail-open + mot dong `HKERR {...}` ra stderr (HK-HOOK-001/002).
- Guard chi o muc no luc tot nhat (hook fail-open); nen tu them deny trong settings cua du an.
- Khong bat cung luc voi dispatcher cung loai trong .claude/settings.json (hook chay doi).
