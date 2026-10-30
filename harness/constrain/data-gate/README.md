# data-gate

Hook PreToolUse (gate): agent khong doc/ghi thang `data/` (dataRoot(), ton trong $HUB_DATA_DIR). Truy cap di qua `node harness/cli/harness.mjs data|observe ...` (cong ghi log gateway).

- Read/Write/Edit/NotebookEdit/Glob/Grep: deny neu duong dan (chuan hoa, `..`, backslash, symlink) nam trong data/.
- Bash: deny lenh doc/ghi/xoa tham chieu data/ (cat/type/mv/cp/`>`/node -e...), tru lenh `node <...harness/...>` (cong, script harness).
- Config `hook.config.json`: `enabled`, `allow` (duong dan tuyet doi hoac tuong doi voi data/; mac dinh rong). Env `HOOK_DATA_GATE_ENABLED`.
- `HARNESS_GATEWAY=1` (cong dat cho tien trinh con) trong env cua hook -> bo qua. Loi -> fail-open.
- Heuristic Bash: boc `$(...)`/backtick va noi dung wrapper (bash|sh|zsh|pwsh|powershell|cmd + -c/-Command//c) roi quet de quy toi 3 tang.
- Token nhay giu nguyen (duong dan co dau cach), `\ ` duoc giai; theo doi `cd`/`pushd` trong lenh (xet ca cwd goc vi cd co the that bai); realpath.native chan ten 8.3.
- Mien tru cong: chi khi script dau (doi so dau sau co cua node/bun) la `...harness/...` va segment khong co `$(`, backtick, redirect (tru `2>&1`, `>/dev/null`); node/bun script khac nhan duong dan data/ -> deny.
- Con ho: bien/glob (`cat $X`, `cat d*/x`), noi chuoi nhay (`"X:/a"/data/x`), script tu doc data/ (`node a.js`), ten 8.3 chua kiem tren may co 8.3.
- Gioi han: Glob/Grep khong path quet tu cwd co the di vao data/ (khong chan); hook audit ghi data/audit truc tiep (noi bo, khong qua tool call).
