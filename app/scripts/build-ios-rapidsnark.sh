#!/usr/bin/env bash
# Build rapidsnark + fr/fq static libraries for iOS (simulator or device), arm64.
#
# Usage:
#   app/scripts/build-ios-rapidsnark.sh [iphonesimulator|iphoneos]
#
# Multi-thread (macOS-like ThreadPool) — requires large worker stacks in misc.hpp:
#   IOS_RAPIDSNARK_MULTI_THREAD=1 app/scripts/build-ios-rapidsnark.sh
#
# Default: MULTI_THREAD=1 after stack fix. Set IOS_RAPIDSNARK_MULTI_THREAD=0 for ST baseline.
set -euo pipefail

unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH

SDK_NAME="${1:-iphonesimulator}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
RAPIDSNARK_SRC="$ROOT/third_party/rapidsnark"
RAPIDSNARK_COMMIT="81eddf1a536d26497b237c0b8a04fe90baf7e439"
MULTI_THREAD="${IOS_RAPIDSNARK_MULTI_THREAD:-1}"

# TARGET_PLATFORM=ios selects package_ios_arm64 + ARCH=arm64 in cmake/platform.cmake.
# Do not use ios_simulator here: that path expects package_iphone_simulator_arm64 and
# incorrectly sets ARCH=x86_64 in upstream platform.cmake.
if [[ "$SDK_NAME" == "iphoneos" ]]; then
  GMP_ROOT="$REPO_ROOT/rapidsnark/lib/ios-device"
  OUT_LIB="$REPO_ROOT/rapidsnark/lib/ios-device/lib"
  BUILD="$ROOT/third_party/rapidsnark-build-ios-device"
  # Device: Fr/Fq ASM on (matches upstream `make ios`).
  USE_ASM=ON
else
  SDK_NAME="iphonesimulator"
  GMP_ROOT="$REPO_ROOT/rapidsnark/lib/ios-simulator"
  OUT_LIB="$REPO_ROOT/rapidsnark/lib/ios-simulator/lib"
  BUILD="$ROOT/third_party/rapidsnark-build-ios-simulator"
  # Simulator: Fr/Fq ASM on by default (arm64 sim). Upstream `make ios_simulator`
  # uses USE_ASM=NO for x86_64 history; on Apple Silicon ASM is correct and ~2× faster.
  # Set IOS_RAPIDSNARK_USE_ASM=OFF for a generic-Fr baseline.
  USE_ASM="${IOS_RAPIDSNARK_USE_ASM:-ON}"
fi
TARGET_PLATFORM=ios

SDK="$(xcrun --sdk "$SDK_NAME" --show-sdk-path)"
MIN_VERSION="15.0"

if [[ ! -f "$GMP_ROOT/lib/libgmp.a" ]]; then
  echo "[ios-rapidsnark] missing $GMP_ROOT/lib/libgmp.a — run:" >&2
  echo "  app/scripts/build-ios-gmp.sh $SDK_NAME" >&2
  exit 1
fi

if [[ ! -d "$RAPIDSNARK_SRC/.git" ]]; then
  echo "[ios-rapidsnark] cloning rapidsnark..."
  mkdir -p "$ROOT/third_party"
  git clone --depth 1 --recursive "https://github.com/iden3/rapidsnark.git" "$RAPIDSNARK_SRC"
  git -C "$RAPIDSNARK_SRC" fetch --depth 1 origin "$RAPIDSNARK_COMMIT"
  git -C "$RAPIDSNARK_SRC" checkout "$RAPIDSNARK_COMMIT"
  git -C "$RAPIDSNARK_SRC" submodule update --init --recursive
fi

# Ensure ThreadPool large-stack / iOS multi-thread patch (ffiasm submodule).
MISC_HPP="$RAPIDSNARK_SRC/depends/ffiasm/c/misc.hpp"
PATCH="$ROOT/scripts/patches/rapidsnark-ios-threadpool-stack.patch"
if ! grep -q 'RAPIDSNARK_WORKER_STACK_BYTES' "$MISC_HPP" 2>/dev/null; then
  echo "[ios-rapidsnark] applying ThreadPool large-stack patch to ffiasm misc.hpp"
  if [[ ! -f "$PATCH" ]]; then
    echo "[ios-rapidsnark] error: missing $PATCH" >&2
    exit 1
  fi
  patch -p1 -d "$RAPIDSNARK_SRC/depends/ffiasm" < "$PATCH"
fi

GMP_PACKAGE="$RAPIDSNARK_SRC/depends/gmp/package_ios_arm64"
mkdir -p "$GMP_PACKAGE"
ln -sfn "$GMP_ROOT/include" "$GMP_PACKAGE/include"
ln -sfn "$GMP_ROOT/lib" "$GMP_PACKAGE/lib"

rm -rf "$BUILD"
mkdir -p "$BUILD" "$OUT_LIB"

CXX_EXTRA=""
C_EXTRA=""
if [[ "$MULTI_THREAD" == "1" ]]; then
  echo "[ios-rapidsnark] MULTI_THREAD=1 (ThreadPool like macOS; large worker stacks)"
else
  echo "[ios-rapidsnark] MULTI_THREAD=0 (RAPIDSNARK_SINGLE_THREAD=1)"
  CXX_EXTRA="-DRAPIDSNARK_SINGLE_THREAD=1"
  C_EXTRA="-DRAPIDSNARK_SINGLE_THREAD=1"
fi

echo "[ios-rapidsnark] TARGET_PLATFORM=$TARGET_PLATFORM USE_ASM=$USE_ASM"

cmake -S "$RAPIDSNARK_SRC" -B "$BUILD" \
  -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_OSX_SYSROOT="$SDK" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_VERSION" \
  -DTARGET_PLATFORM="$TARGET_PLATFORM" \
  -DUSE_OPENMP=OFF \
  -DBUILD_TESTS=OFF \
  -DUSE_ASM="$USE_ASM" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="$CXX_EXTRA" \
  -DCMAKE_C_FLAGS="$C_EXTRA" \
  -DCMAKE_INSTALL_PREFIX="$OUT_LIB/.."

cmake --build "$BUILD" --target rapidsnarkStatic fr -j"$(sysctl -n hw.ncpu)"

# fq target may be named differently across rapidsnark versions
if cmake --build "$BUILD" --target fq -j"$(sysctl -n hw.ncpu)" 2>/dev/null; then
  :
elif [[ -f "$BUILD/src/libfq.a" ]]; then
  :
else
  echo "[ios-rapidsnark] warning: building all to obtain libfq.a"
  cmake --build "$BUILD" -j"$(sysctl -n hw.ncpu)" || true
fi

cp "$BUILD/src/librapidsnark.a" "$OUT_LIB/librapidsnark.a"
cp "$BUILD/src/libfr.a" "$OUT_LIB/libfr.a"
if [[ -f "$BUILD/src/libfq.a" ]]; then
  cp "$BUILD/src/libfq.a" "$OUT_LIB/libfq.a"
fi

# Record build mode for tests
echo "multi_thread=${MULTI_THREAD}" > "$OUT_LIB/../zk-thread-mode.txt"
echo "sdk=${SDK_NAME}" >> "$OUT_LIB/../zk-thread-mode.txt"
echo "use_asm=${USE_ASM}" >> "$OUT_LIB/../zk-thread-mode.txt"
echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT_LIB/../zk-thread-mode.txt"

echo "[ios-rapidsnark] installed ($SDK_NAME, multi_thread=$MULTI_THREAD):"
file "$OUT_LIB/librapidsnark.a" "$OUT_LIB/libfr.a" "$GMP_ROOT/lib/libgmp.a"
cat "$OUT_LIB/../zk-thread-mode.txt"
