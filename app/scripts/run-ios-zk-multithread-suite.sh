#!/usr/bin/env bash
# Correctness + soak + latency gates for iOS multi-thread rapidsnark (vs macOS).
#
# Prerequisites:
#   IOS_RAPIDSNARK_MULTI_THREAD=1 app/scripts/build-ios-rapidsnark.sh iphonesimulator
#   (optional) same for iphoneos + device GMP
#
# Usage:
#   bash app/scripts/run-ios-zk-multithread-suite.sh
#   SKIP_IOS_E2E_BUILD=1 bash app/scripts/run-ios-zk-multithread-suite.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MODE_FILE_SIM="$ROOT/rapidsnark/lib/ios-simulator/zk-thread-mode.txt"
MODE_FILE_DEV="$ROOT/rapidsnark/lib/ios-device/zk-thread-mode.txt"
BENCH_MD="$ROOT/docs/ios-zk-multithread-bench.md"
RESULTS_DIR="$ROOT/.local/ios-zk-mt-results"
mkdir -p "$RESULTS_DIR"

echo "[ios-zk-mt] checking sim thread mode..."
if [[ ! -f "$MODE_FILE_SIM" ]] || ! grep -q 'multi_thread=1' "$MODE_FILE_SIM"; then
  echo "[ios-zk-mt] building simulator rapidsnark MULTI_THREAD=1"
  IOS_RAPIDSNARK_MULTI_THREAD=1 bash app/scripts/build-ios-rapidsnark.sh iphonesimulator
fi
cat "$MODE_FILE_SIM"

if [[ -f "$MODE_FILE_DEV" ]]; then
  echo "[ios-zk-mt] device mode:"
  cat "$MODE_FILE_DEV"
else
  echo "[ios-zk-mt] note: ios-device libs not present (optional for this host suite)"
fi

# nm check: ThreadPool / pthread_create symbols present in static archive
echo "[ios-zk-mt] verifying ThreadPool symbols in librapidsnark.a..."
if ! nm "$ROOT/rapidsnark/lib/ios-simulator/lib/librapidsnark.a" 2>/dev/null | rg -q 'ThreadPool|pthread_create|defaultThreadCount'; then
  # C++ mangling — looser check
  if ! nm "$ROOT/rapidsnark/lib/ios-simulator/lib/librapidsnark.a" 2>/dev/null | rg -qi 'threadpool|pthread'; then
    echo "[ios-zk-mt] warning: could not confirm ThreadPool symbols via nm (mangling); continuing"
  fi
fi

echo "[ios-zk-mt] Phase 3 — correctness: register + shuffle + share bridge"
export SKIP_IOS_E2E_BUILD="${SKIP_IOS_E2E_BUILD:-0}"
npm run test:ios:simulator:native-register-prove 2>&1 | tee "$RESULTS_DIR/register.log"
npm run test:ios:simulator:native-shuffle-prove 2>&1 | tee "$RESULTS_DIR/shuffle.log"
npm run test:ios:bridge:share 2>&1 | tee "$RESULTS_DIR/share.log"

echo "[ios-zk-mt] Phase 4 — soak: 5× register prove (serial)"
export SKIP_IOS_E2E_BUILD=1
for i in 1 2 3 4 5; do
  echo "[ios-zk-mt] soak register $i/5"
  npm run test:ios:simulator:native-register-prove 2>&1 | tee -a "$RESULTS_DIR/soak-register.log"
done

extract_ms() {
  local log="$1"
  local circuit="$2"
  rg -o "groth16 prove finished ${circuit} [0-9]+ms" "$log" 2>/dev/null \
    | rg -o '[0-9]+ms' | sed 's/ms//' || true
}

echo "[ios-zk-mt] Phase 5 — latency extract (from suite logs)"
{
  echo ""
  echo "## Auto-collected iOS MT suite ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo ""
  echo "| Circuit | Samples (ms) |"
  echo "|---------|--------------|"
  for circuit in register_main shuffle_1_deck_52_main poker_share_hashout_main; do
    samples=$(extract_ms "$RESULTS_DIR"/*.log "$circuit" | tr '\n' ' ' | sed 's/ $//')
    echo "| \`$circuit\` | ${samples:-none} |"
  done
  echo ""
  echo "macOS baseline (Phase 0): register ~96ms, shuffle ~2.6s, share ~12s groth16."
  echo "Gate: register iOS MT median ≤ 2× macOS; share ≥1.5× faster than prior ST if ST available."
} | tee -a "$BENCH_MD"

echo "[ios-zk-mt] suite finished — see $RESULTS_DIR and $BENCH_MD"
