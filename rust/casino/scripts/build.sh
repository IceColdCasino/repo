#!/usr/bin/env bash
# Build the poker workspace in two steps:
#   1. Arcis circuits via arcium (skip the on-chain program — edition2024 workaround)
#   2. Anchor program (.so) via cargo build-sbf (not --skip-program)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p target/deploy
bash "$ROOT/../../scripts/write-build-keypairs.sh" casino

FEATURES="${CASINO_FEATURES:-}"
SBF_TOOLS_VERSION="${SBF_TOOLS_VERSION:-v1.54}"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"

# Production/release builds must not ship `testing` helpers (set_showdown_hash, …).
# Localnet E2E: CASINO_ALLOW_TESTING=1 CASINO_FEATURES=testing ./scripts/build.sh
bash "$REPO_ROOT/scripts/assert-casino-release-no-testing.sh"

echo "==> [1/2] Arcis circuits: arcium build --skip-program --skip-keys-sync"
# Arcium images are amd64-only; run under Apple Container (not Docker Desktop).
export ARCIUM_USE_APPLE_CONTAINER="${ARCIUM_USE_APPLE_CONTAINER:-1}"
unset DOCKER_HOST
export PATH="${HOME:-}/.local/bin:${HOME:-}/.local/apple-container/bin:${PATH}"
export DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-linux/amd64}"
arcium build --skip-program --skip-keys-sync

# arcium build generates docker-compose-arx-env.yml; pin platform for ARM hosts.
COMPOSE="$ROOT/artifacts/docker-compose-arx-env.yml"
if [[ -f "$COMPOSE" ]] && ! grep -q 'platform: linux/amd64' "$COMPOSE"; then
  echo "==> Patching $COMPOSE for linux/amd64 (Apple Silicon)"
  python3 - "$COMPOSE" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
lines = []
for line in text.splitlines():
    lines.append(line)
    if 'image: "arcium/' in line:
        lines.append('    platform: linux/amd64')
open(path, 'w').write('\n'.join(lines) + ('\n' if text.endswith('\n') else ''))
PY
fi

echo "==> [2/2] On-chain program: cargo build-sbf (no --skip-program)"
export RUSTFLAGS='--cfg getrandom_backend="custom"'
unset CARGO_TARGET_DIR
cargo build-sbf --tools-version "$SBF_TOOLS_VERSION" \
  --manifest-path programs/casino/Cargo.toml \
  ${FEATURES:+--features "$FEATURES"}

if [[ ! -f target/deploy/casino.so ]]; then
  echo "error: target/deploy/casino.so not found after build" >&2
  exit 1
fi

echo "==> [3/3] Anchor IDL: anchor idl build (for E2E TypeScript clients)"
mkdir -p target/idl
anchor idl build -p casino -o target/idl/casino.json --skip-lint ${FEATURES:+-- --features "$FEATURES"}

echo "==> Done. Artifacts:"
echo "    Circuits: $ROOT/build/*.arcis"
echo "    Program:  $ROOT/target/deploy/casino.so"
echo "    IDL:      $ROOT/target/idl/casino.json"
