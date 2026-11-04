# data-check

Hook chi canh bao (khong bao gio chan), fail-open.

- SessionStart: doc cache `data/.state/data-scan.json`; vang hoac cu hon `cacheMaxAgeHours` thi spawn `harness data scan --json` (timeout `scanTimeoutMs`, het gio bo qua). Co vi pham -> additionalContext <=5 dong (`formatWarn`). Khong co -> im lang. Cung rule+key chi day 1 lan/phien (state `data/.state/data-check-<sid>.json`).
- PostToolUse Write/Edit: file moi ghi o `docs/` khong phai `.md`, hoac o goc repo co duoi rac (log/tmp/txt/out/bak/csv/zip/png/jpg) ngoai `TOP_FILES` va `allowlist` -> `data-warn rule=clutter ...`.
- Config `hook.config.json`: `enabled`, `timeoutMs`, `scanTimeoutMs`, `cacheMaxAgeHours`, `allowlist` (duong dan tuong doi repo, mac dinh rong). Env `HOOK_DATA_CHECK_ENABLED`.
- Chua xac minh: agy khong ho tro additionalContext (adapter none).

## Don tu dong (autoClean)
SessionStart: khi lan don gan nhat (`lastRun` trong data/.state/data-check-clean.json) cach >= `autoClean.minIntervalHours` (24), hook spawn nen (detached, khong cho) `harness data clean --auto --yes`; khoa `.state/data-check-clean.lock` (pid, het han 5 phut). Lenh tu ghi ket qua; phien sau neu N>0 hoac loi thi them 1 dong `data-clean: da don N file (X MB) tu <ts>` (N=0 im lang). Config `autoClean {enabled,minIntervalHours,maxFiles,maxBytes,timeoutS}` trong hook.config.json. Tat ngay: env `HOOK_DATA_CHECK_AUTOCLEAN=0` hoac `autoClean.enabled=false`. Fail-open. Pham vi/gioi han: harness/observe/storage/README.md.
