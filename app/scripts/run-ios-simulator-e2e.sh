#!/usr/bin/env bash
# Build ZKPoker for iOS Simulator and run in-app bridge smoke E2E.
#
# Default: simctl launch + poll Documents/e2e-results.json (fast, no XCUITest loop).
# Set IOS_E2E_USE_XCUITEST=1 to use xcodebuild test instead (slower; for Xcode UI).
#
# For interactive simulator use (app stays open), run:
#   ./app/scripts/run-ios-simulator.sh
set -euo pipefail

source "$(dirname "$0")/ios-simulator-common.sh"
ios_sim_init_paths

POLL_SECONDS="${IOS_E2E_POLL_SECONDS:-45}"
SKIP_BUILD="${SKIP_IOS_E2E_BUILD:-0}"

echo "[ios-e2e] repo root: $ROOT"

build_deps() { ios_sim_build_deps; }
build_app() { ios_sim_build_app; }
find_built_app() { ios_sim_find_built_app; }
sim_udid() { ios_sim_udid; }

run_simctl_e2e() {
  local app_path udid
  app_path="$(find_built_app)"
  udid="$(sim_udid)"
  echo "[ios-e2e] simulator $SIM_NAME ($udid)"
  echo "[ios-e2e] app bundle $app_path"

  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null

  xcrun simctl terminate "$udid" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl uninstall "$udid" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl install "$udid" "$app_path"
  local launch_args=(-e2e_automation "$(ios_sim_zkey_launch_args)")
  if [[ "${IOS_E2E_PROVE:-0}" == "1" ]]; then
    launch_args+=(-e2e_prove)
    POLL_SECONDS="${IOS_E2E_POLL_SECONDS:-180}"
  fi
  xcrun simctl launch "$udid" "$BUNDLE_ID" "${launch_args[@]}" >/dev/null

  local container results elapsed=0
  while (( elapsed < POLL_SECONDS )); do
    if container="$(xcrun simctl get_app_container "$udid" "$BUNDLE_ID" data 2>/dev/null)"; then
      results="$container/Documents/e2e-results.json"
      if [[ -f "$results" ]]; then
        echo "[ios-e2e] results: $results"
        if python3 - <<PY
import json, sys
with open(${results@Q}) as f:
    report = json.load(f)
for case in report.get("cases", []):
    status = "PASS" if case.get("ok") else "FAIL"
    print(f"[ios-e2e] {status} {case.get('name')}: {case.get('detail', '')}")
passed = bool(report.get("passed"))
print(f"[ios-e2e] overall passed={passed}")
sys.exit(0 if passed else 1)
PY
        then
          exit 0
        else
          exit 1
        fi
      fi
    fi
    sleep 0.5
    elapsed=$((elapsed + 1))
  done

  echo "[ios-e2e] timed out after ${POLL_SECONDS}s waiting for e2e-results.json" >&2
  exit 1
}

run_xcuitest_e2e() {
  local test_filter="${IOS_E2E_TEST:-ZKPokerUITests/SimulatorE2ETests/testBridgeSmoke}"
  env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
    DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
    xcodebuild test \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -destination "$DEST" \
      -only-testing:"$test_filter" \
      ARCHS=arm64 \
      ONLY_ACTIVE_ARCH=YES
}

if [[ "$SKIP_BUILD" != "1" ]]; then
  build_deps
fi
if [[ "$SKIP_BUILD" != "1" ]] || ! find_built_app >/dev/null 2>&1; then
  build_app
fi

if [[ "${IOS_E2E_USE_XCUITEST:-0}" == "1" ]]; then
  echo "[ios-e2e] mode: XCUITest"
  run_xcuitest_e2e
else
  echo "[ios-e2e] mode: simctl + results file"
  run_simctl_e2e
fi
