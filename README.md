# agent-guard-kit

Plugin Claude Code: lop rang buoc tat dinh cho agent (guard, approval, data zone, audit, hook dispatcher, cong CLI). Zero dependency, can Node.

- Cai: `/plugin install agent-guard-kit --marketplace <owner>/<repo>` (repo nay chua .claude-plugin/marketplace.json).
- Xuat tu mot chieu tu nguon goc; xem export-manifest.json (md5 tung file).
- Du lieu: <du an>/.harness/data (tu them .gitignore). PLUGIN_ROOT chi doc.
- Guard chi o muc no luc tot nhat (hook fail-open); nen tu them deny trong settings cua du an.
- Khong bat cung luc voi dispatcher cung loai trong .claude/settings.json (hook chay doi).
