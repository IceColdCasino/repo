#!/usr/bin/env bash
# Build ZKPoker and launch it on the iOS Simulator for interactive use.
#
# Does NOT pass -e2e_automation (the app stays open).
#
# Usage:
#   ./app/scripts/run-ios-simulator.sh
#   VITE_API_BASE=http://192.168.1.10:3847 ./app/scripts/run-ios-simulator.sh
#   SKIP_IOS_BUILD=1 ./app/scripts/run-ios-simulator.sh
set -euo pipefail

source "$(dirname "$0")/ios-simulator-common.sh"
ios_sim_init_paths

SKIP_BUILD="${SKIP_IOS_BUILD:-0}"

echo "[ios] repo root: $ROOT"

if [[ "$SKIP_BUILD" != "1" ]]; then
  ios_sim_build_deps
fi
if [[ "$SKIP_BUILD" != "1" ]] || ! ios_sim_find_built_app >/dev/null 2>&1; then
  ios_sim_build_app
fi

APP_PATH="$(ios_sim_find_built_app)"
UDID="$(ios_sim_udid)"

echo "[ios] simulator: $SIM_NAME ($UDID)"
echo "[ios] app bundle: $APP_PATH"

ios_sim_prepare "$UDID"
ios_sim_install "$UDID" "$APP_PATH"

echo "[ios] launching ZKPoker (interactive — no E2E flags)"
xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null

echo "[ios] ZKPoker is running in Simulator."
if [[ -z "${VITE_API_BASE:-}" ]]; then
  echo "[ios] tip: point at a game server with:"
  echo "      VITE_API_BASE=http://<host>:3847 ./app/scripts/run-ios-simulator.sh"
fi
