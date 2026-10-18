#!/usr/bin/env bash
set -euo pipefail

# Cross-compile static GMP for iOS with ARM64 assembly enabled.
# Usage: ./scripts/build-ios-gmp.sh [iphonesimulator|iphoneos]

SDK_NAME="${1:-iphonesimulator}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/../rapidsnark/lib/ios-simulator"
GMP_VERSION="6.3.0"
GMP_TARBALL="/tmp/gmp-${GMP_VERSION}.tar.xz"
GMP_SRC="$ROOT/third_party/gmp-${GMP_VERSION}"

SDK="$(xcrun --sdk "$SDK_NAME" --show-sdk-path)"
MIN_VERSION="15.0"
if [[ "$SDK_NAME" == "iphonesimulator" ]]; then
  MIN_FLAG="-mios-simulator-version-min=${MIN_VERSION}"
  TARGET_FLAG="-target arm64-apple-ios${MIN_VERSION}-simulator"
else
  MIN_FLAG="-mios-version-min=${MIN_VERSION}"
  TARGET_FLAG="-target arm64-apple-ios${MIN_VERSION}"
  OUT="$ROOT/../rapidsnark/lib/ios-device"
fi

# GMP selects ARM64 assembly macros from the host OS tag. aarch64-apple-ios
# picks ELF-style :lo12: relocations that fail under iOS PIC; darwin selects
# @GOTPAGE assembly while CC -target still emits iOS simulator/device objects.
HOST="aarch64-apple-darwin"
CC="clang -arch arm64 -isysroot ${SDK} ${MIN_FLAG} ${TARGET_FLAG}"
CCAS="clang -arch arm64 -isysroot ${SDK} ${MIN_FLAG} ${TARGET_FLAG} -c"

if [[ ! -f "$GMP_SRC/configure" ]]; then
  mkdir -p "$ROOT/third_party"
  curl -L -o "$GMP_TARBALL" "https://gmplib.org/download/gmp/gmp-${GMP_VERSION}.tar.xz"
  tar -xJf "$GMP_TARBALL" -C "$ROOT/third_party"
fi

BUILD="$ROOT/third_party/gmp-build-${SDK_NAME}"
rm -rf "$BUILD"
mkdir -p "$BUILD" "$OUT/lib"
cd "$BUILD"

"$GMP_SRC/configure" \
  --host="$HOST" \
  --build="$(uname -m)-apple-darwin" \
  CC="$CC" \
  CXX="clang++ -arch arm64 -isysroot ${SDK} ${MIN_FLAG} ${TARGET_FLAG}" \
  CCAS="$CCAS" \
  CFLAGS="-O2 -fPIC" \
  --disable-shared --enable-static \
  --prefix="$OUT"

make -j"$(sysctl -n hw.ncpu)"
make install

echo "Installed $OUT/lib/libgmp.a"
file "$OUT/lib/libgmp.a"
