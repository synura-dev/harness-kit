#!/usr/bin/env bash
# Verify plugin binaries match the source tree; exit 1 on any mismatch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="$ROOT/plugins/claude/bin/harness-rs"
A="$ROOT/plugins/agy/bin/harness-rs"
fail=0

for f in "$C" "$A"; do
  if [ ! -f "$f" ]; then echo "missing: $f" >&2; fail=1; continue; fi
  if [ "$(head -c4 "$f" | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]; then
    echo "not ELF: $f" >&2; fail=1
  fi
done
[ "$fail" = 0 ] || exit 1

if [ "$(sha256sum "$C" | cut -d' ' -f1)" != "$(sha256sum "$A" | cut -d' ' -f1)" ]; then
  echo "sha256 differs between plugins" >&2; exit 1
fi

for p in claude agy; do
  m="$(git -c safe.directory="*" -C "$ROOT" ls-files -s "plugins/$p/bin/harness-rs" | cut -d" " -f1)"
  if [ "$m" != "100755" ]; then echo "index mode $m != 100755: plugins/$p/bin/harness-rs" >&2; exit 1; fi
done

want="$(git -c safe.directory='*' -C "$ROOT" rev-parse HEAD:rust/harness | cut -c1-12)"
got="$("$C" --version | sed -n 's/.*(src \([0-9a-f]*\)).*/\1/p')"
if [ "$got" != "$want" ]; then
  echo "src tree mismatch: binary=$got source=$want" >&2; exit 1
fi
echo "ok: src $want"
