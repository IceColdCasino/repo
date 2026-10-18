#!/usr/bin/env bash
# Native iOS simulator register-then-shuffle Groth16 prove isolation test.
# Runs register prove then shuffle prove back-to-back in one app launch,
# catching inter-prove state corruption. No WebView.
#
# Usage:
#   npm run test:ios:simulator:native-register-shuffle
set -euo pipefail

source "$(dirname "$0")/ios-simulator-common.sh"
ios_sim_init_paths

SHUFFLE_TIMEOUT="${IOS_E2E_SHUFFLE_TIMEOUT:-5400}"
REGISTER_TIMEOUT="${IOS_E2E_REGISTER_TIMEOUT:-600}"
POLL_SECONDS="${IOS_E2E_POLL_SECONDS:-$((SHUFFLE_TIMEOUT + REGISTER_TIMEOUT + 600))}"
SKIP_BUILD="${SKIP_IOS_E2E_BUILD:-0}"

echo "[ios-native-register-shuffle] repo root: $ROOT"

if [[ "$SKIP_BUILD" != "1" ]]; then
  ios_sim_build_deps
fi

if [[ "$SKIP_BUILD" != "1" ]] || ! ios_sim_find_built_app >/dev/null 2>&1; then
  ios_sim_build_app
fi

APP_PATH="$(ios_sim_find_built_app)"
UDID="$(ios_sim_udid)"

echo "[ios-native-register-shuffle] simulator $SIM_NAME ($UDID)"
echo "[ios-native-register-shuffle] app bundle $APP_PATH"

ios_sim_prepare "$UDID"
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP_PATH"

if container="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null)"; then
  rm -f "$container/Documents/e2e-results.json"
fi

xcrun simctl spawn "$UDID" log stream --style compact --predicate 'eventMessage CONTAINS "[zk]"' >>"${ROOT}/.ios-native-register-shuffle-zk.log" 2>&1 &
LOG_PID=$!
trap 'kill "$LOG_PID" 2>/dev/null || true' EXIT INT TERM

echo "[ios-native-register-shuffle] poll ${POLL_SECONDS}s"

if ! xcrun simctl launch "$UDID" "$BUNDLE_ID" \
  -e2e_automation -e2e_native_register_then_shuffle "-e2e_shuffle_timeout=${SHUFFLE_TIMEOUT}" \
  "$(ios_sim_zkey_launch_args)" >/dev/null; then
  echo "[ios-native-register-shuffle] simctl launch failed" >&2
  exit 1
fi

elapsed=0
while (( elapsed < POLL_SECONDS )); do
  if container="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null)"; then
    results="$container/Documents/e2e-results.json"
    if [[ -f "$results" ]]; then
      echo "[ios-native-register-shuffle] results: $results"
      set +e
      python3 - <<PY
import json, sys
with open(${results@Q}) as f:
    report = json.load(f)
for case in report.get("cases", []):
    status = "PASS" if case.get("ok") else "FAIL"
    print(f"[ios-native-register-shuffle] {status} {case.get('name')}: {case.get('detail', '')}")
names = {c.get("name") for c in report.get("cases", [])}
if not report.get("complete", True):
    print(f"[ios-native-register-shuffle] partial report ({len(names)} cases), waiting for complete...")
    sys.exit(2)
if not any(n.startswith("native.register_then_shuffle") for n in names):
    print("[ios-native-register-shuffle] stale results — combined test did not run", file=sys.stderr)
    sys.exit(1)
passed = bool(report.get("passed"))
print(f"[ios-native-register-shuffle] overall passed={passed}")
sys.exit(0 if passed else 1)
PY
      py_exit=$?
      set -e
      if [[ "$py_exit" -eq 0 ]]; then
        exit 0
      elif [[ "$py_exit" -eq 2 ]]; then
        :
      else
        exit 1
      fi
    fi
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "[ios-native-register-shuffle] timed out after ${POLL_SECONDS}s waiting for e2e-results.json" >&2
xcrun simctl spawn "$UDID" log show --last 5m 2>/dev/null | rg "\[zk\]" | tail -30 >&2 || true
exit 1
