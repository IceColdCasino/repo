#!/bin/bash
# Replace a raw zkey with zkx1: magic, uncompressed length, xz stream.
# A file that is already zkx1 is left in place.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: pack-zkey.sh <file.zkey>" >&2
  exit 1
fi

file=$1
if [[ ! -f "$file" ]]; then
  echo "missing $file" >&2
  exit 1
fi

magic=$(python3 -c 'import sys; print(open(sys.argv[1],"rb").read(4).decode("ascii","replace"))' "$file")
if [[ "$magic" == "zkx1" ]]; then
  exit 0
fi
if [[ "$magic" != "zkey" ]]; then
  echo "not a zkey: $file" >&2
  exit 1
fi

xz=${XZ:-$(command -v xz)}
size=$(stat -f %z "$file")
tmp=$(mktemp /tmp/zkey-pack.XXXXXX)
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

{
  printf 'zkx1'
  python3 -c 'import struct,sys; sys.stdout.buffer.write(struct.pack("<Q", int(sys.argv[1])))' "$size"
  "$xz" -6 -T0 -c "$file"
} > "$tmp"

if ! tail -c +13 "$tmp" | "$xz" -dc | cmp -s - "$file"; then
  echo "xz roundtrip failed: $file" >&2
  exit 1
fi

mv "$tmp" "$file"
trap - EXIT
