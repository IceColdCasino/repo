#!/usr/bin/env bash
# Shared build + simctl helpers for iOS simulator scripts.
set -euo pipefail

unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH

_IOS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_REPO_ROOT="$(cd "$_IOS_SCRIPT_DIR/../.." && pwd)"

ios_sim_init_paths() {
  ROOT="$IOS_REPO_ROOT"
  APP_DIR="$ROOT/app"
  IOS_DIR="$APP_DIR/ios"
  PROJECT="$IOS_DIR/ZeroNativeIOSExample.xcodeproj"
  SCHEME="${IOS_SCHEME:-ZKPoker}"
  DEST="${IOS_SIMULATOR_DEST:-platform=iOS Simulator,OS=26.5,name=iPhone 17 Pro}"
  SIM_NAME="${IOS_SIMULATOR_NAME:-iPhone 17 Pro}"
  BUNDLE_ID="${IOS_BUNDLE_ID:-dev.zero_native.app}"
}

ios_sim_require_frontend_dist() {
  if [[ ! -f "$APP_DIR/frontend/dist/index.html" ]]; then
    echo "[ios] error: frontend dist missing — build on the host first:" >&2
    echo "  cd app/frontend && npx vite build" >&2
    exit 1
  fi
}

ios_sim_require_testdata() {
  local missing=0
  local files=(
    "register_prove_payload.json"
    "shuffle_prove_payload.json"
    "bridge-chain/manifest.json"
    "bridge-chain/register_p0_payload.json"
    "bridge-chain/shuffle_p0_payload.json"
    "bridge-chain/share_p0_payload.json"
    "bridge-chain/showdown_p0_payload.json"
    "bridge-chain/showdown_p1_payload.json"
  )
  for rel in "${files[@]}"; do
    if [[ ! -f "$APP_DIR/ios/testdata/$rel" ]]; then
      echo "[ios] error: missing bundled testdata: ios/testdata/$rel" >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    echo "[ios] regenerate on the host (dev only): bun app/scripts/bridge-chain/generate-fixtures.ts" >&2
    exit 1
  fi
}

ios_sim_build_deps() {
  ios_sim_require_frontend_dist
  ios_sim_require_testdata
  echo "[ios] frontend dist ok ($(wc -c < "$APP_DIR/frontend/dist/index.html" | tr -d ' ') bytes index.html)"

  if [[ ! -f "$ROOT/rapidsnark/lib/ios-simulator/lib/librapidsnark.a" ]]; then
    echo "[ios] building rapidsnark for iOS simulator..."
    bash "$APP_DIR/scripts/build-ios-rapidsnark.sh"
  fi

  echo "[ios] building witness dylibs for iOS simulator..."
  bash "$APP_DIR/scripts/build-ios-witness.sh"

  echo "[ios] building ios-lib (simulator)..."
  (cd "$APP_DIR" && env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
    zig build ios-lib -Dios-target=aarch64-ios-simulator -Doptimize=ReleaseFast)
}

ios_sim_build_app() {
  echo "[ios] xcodebuild build for simulator..."
  env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
    DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
    xcodebuild build \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -destination "$DEST" \
      -configuration Debug \
      ARCHS=arm64 \
      ONLY_ACTIVE_ARCH=YES \
      -quiet
}

ios_sim_find_built_app() {
  local derived
  derived="$(ls -td "$HOME/Library/Developer/Xcode/DerivedData/ZeroNativeIOSExample-"* 2>/dev/null | head -1 || true)"
  if [[ -z "$derived" || ! -d "$derived/Build/Products/Debug-iphonesimulator/ZKPoker.app" ]]; then
    echo "[ios] error: ZKPoker.app not found under DerivedData" >&2
    return 1
  fi
  echo "$derived/Build/Products/Debug-iphonesimulator/ZKPoker.app"
}

ios_sim_udid() {
  python3 - <<PY
import json, subprocess, sys
name = ${SIM_NAME@Q}
proc = subprocess.run(["xcrun", "simctl", "list", "devices", "available", "-j"], capture_output=True, text=True, check=True)
data = json.loads(proc.stdout)
for runtime, devices in data.get("devices", {}).items():
    if "iOS" not in runtime:
        continue
    for device in devices:
        if device.get("name") == name and device.get("isAvailable"):
            print(device["udid"])
            sys.exit(0)
print(f"simulator not found: {name}", file=sys.stderr)
sys.exit(1)
PY
}

ios_sim_prepare() {
  local udid="$1"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  open -a Simulator >/dev/null 2>&1 || true
}

# Simulator zkeys load from host repo (bundle cannot contain symlinks).
ios_sim_zkey_launch_args() {
  echo "-e2e_zkey_root=${ROOT}"
}

ios_sim_install() {
  local udid="$1"
  local app_path="$2"
  xcrun simctl terminate "$udid" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl install "$udid" "$app_path"
}

macos_witness_ok() {
  local lib="$ROOT/libzkcasino/zig-out/lib/libzkcasino.dylib"
  [[ -f "$lib" ]] || return 1
  local platform
  platform="$(otool -l "$lib" 2>/dev/null | awk '/cmd LC_BUILD_VERSION/{getline; getline; print $2; exit}')"
  [[ "$platform" == "1" ]]
}

ensure_macos_witness() {
  if macos_witness_ok; then
    echo "[ios] macOS witness dylibs ok"
    return 0
  fi
  echo "[ios] building macOS witness dylibs (host seat 0)..."
  (
    cd "$ROOT/libzkcasino"
    env -u CPATH -u C_INCLUDE_PATH -u CPLUS_INCLUDE_PATH \
      zig build -Dcircuit-set=poker -Dwitness-link=dynamic -Doptimize=ReleaseFast
  )
}
