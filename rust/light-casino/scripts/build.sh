#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p target/deploy
bash "$ROOT/../../scripts/write-build-keypairs.sh" light-casino

unset CARGO_TARGET_DIR

echo "==> light-casino SBF build"
RUSTFLAGS='--cfg getrandom_backend="custom"' cargo build-sbf \
  --tools-version v1.54 \
  --manifest-path programs/light-casino/Cargo.toml

echo "==> light-casino IDL"
mkdir -p target/idl
anchor idl build -p light-casino -o target/idl/light_casino.json --skip-lint -- --lib

echo "==> Done: target/deploy/light_casino.so + target/idl/light_casino.json"
