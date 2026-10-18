#!/bin/bash
# Launch the macOS app against the devnet RPC in ../.env.devnet.
# Cluster offset 456. Does not upload computation definitions.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f ../.env.devnet ]]; then
  set -a
  # shellcheck disable=SC1091
  source ../.env.devnet
  set +a
fi
unset UPLOAD_COMP_DEFS
export ZK_LAUNCH_BACKEND=solana
export DYLD_LIBRARY_PATH="${PWD}/zig-out/lib${DYLD_LIBRARY_PATH:+:${DYLD_LIBRARY_PATH}}"
ln -sfn zig-out/lib lib
exec ./zig-out/bin/app
