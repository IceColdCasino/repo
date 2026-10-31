#!/usr/bin/env bash
# Run each proof test in its own process.
# The Metal prover keeps every zkey it loads. One bun process that plays
# the 2-player hand, then 3, then 10, then 12 holds all of those keys at
# once, and the macOS runner runs out of memory.
set -euo pipefail

file="${1:?proof test file}"
test -f "$file"

list="$(mktemp)"
trap 'rm -f "$list"' EXIT

# Bun matches the describe titles and the test title joined by spaces.
# The ">" in the reporter is not part of that string. Parentheses and
# plus signs are regex metacharacters, so they are escaped.
python3 - "$file" >"$list" <<'PY'
import re
import sys

lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
stack = []
brace = 0
names = []
describe_re = re.compile(r"""^\s*describe\(\s*(['"])(.+?)\1""")
test_re = re.compile(r"""^\s*(?:test|it)\(\s*(['"])(.+?)\1""")
for line in lines:
    described = describe_re.match(line)
    tested = test_re.match(line)
    if described:
        stack.append((described.group(2), brace))
    if tested:
        parts = [name for name, _depth in stack]
        parts.append(tested.group(2))
        names.append(" ".join(parts))
    brace += line.count("{") - line.count("}")
    while stack and brace <= stack[-1][1]:
        stack.pop()

def bun_regex(name):
    literal = re.sub(r"([\\.+*?^${}()|[\]])", r"\\\1", name)
    return "^" + literal + "$"

if not names:
    sys.exit("no tests found")
for name in names:
    print(bun_regex(name))
PY

while IFS= read -r pattern; do
  [ -n "$pattern" ] || continue
  echo "==> ${pattern}"
  bun test --max-concurrency 1 --test-name-pattern "$pattern" "$file"
done <"$list"
