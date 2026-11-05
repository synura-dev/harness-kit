# guard (PreToolUse)

Guard chi giu: `protectedPaths` (cong harness obsidian la ngoai le), bao ve du lieu harness (launcher, so dang ky plugin, ext registry, config-dump file bi mat) va chan lenh qua dai (`maxCommandChars`). Luat theo mau nam o `denyPatterns` cua config may/du an (mac dinh rong). Regex loi trong config khong bi nuot im lang: ghi stderr `guard: regex loi bi bo qua`.

`core.fixture.json` chi la fixture cho test lop config, khong nap luc chay.

## Luat native thay the (settings.json permissions)

- deny: `Bash(git push --force:*)`, `Bash(git push -f:*)`, `Bash(rm -rf:*)`, `Bash(git clean:*)`
- ask: `Bash(git push:*)`, `Bash(git reset --hard:*)`, `Bash(ssh:*)`, `Bash(scp:*)`, `Bash(rsync:*)`, `Bash(npm run migrate:*)`, `Bash(npx prisma migrate:*)`

Module approval da xoa; luat mongo/db-cli/remote-cat/remote-node-run/hub-local-node da bo.
