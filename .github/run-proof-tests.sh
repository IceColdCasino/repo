#!/usr/bin/env bash
# Run each proof test in its own process.
# The Metal prover keeps every zkey it loads. One bun process that plays
# the 2-player hand, then 3, then 10, then 12 holds all of those keys at
# once, and the macOS runner runs out of memory. The next proof then either
# fails verification or the process is killed.
set -euo pipefail

file="${1:?proof test file}"
test -f "$file"

names="$(
  python3 - "$file" <<'PY'
import re
import sys
text = open(sys.argv[1], encoding="utf-8").read()
for quote, name in re.findall(r"""(?m)^[ \t]*(?:test|it)\(\s*(['"])(.+?)\1""", text):
    print(name)
PY
)"

if [ -z "$names" ]; then
  echo "no tests found in ${file}" >&2
  exit 1
fi

while IFS= read -r name; do
  [ -n "$name" ] || continue
  pattern="$(python3 -c 'import re,sys; print("(?:^| > )"+re.escape(sys.argv[1])+"$")' "$name")"
  echo "==> ${name}"
  bun test --max-concurrency 1 --test-name-pattern "$pattern" "$file"
done <<< "$names"
