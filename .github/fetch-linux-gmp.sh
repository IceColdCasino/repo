#!/usr/bin/env bash
# Download Ubuntu 24.04 libgmp for amd64 and arm64 so a macOS Zig build can
# link Linux witness libraries. Prints nothing. Writes:
#   $1/x86_64/include/gmp.h
#   $1/x86_64/lib/libgmp.so
#   $1/aarch64/include/gmp.h
#   $1/aarch64/lib/libgmp.so
set -euo pipefail

dest="${1:?usage: fetch-linux-gmp.sh <dest>}"
mkdir -p "$dest"

fetch_arch() {
  local deb_arch="$1"
  local zig_arch="$2"
  local multiarch="$3"
  local packages pool
  case "$deb_arch" in
    amd64)
      packages="http://archive.ubuntu.com/ubuntu/dists/noble/main/binary-amd64/Packages.gz"
      pool="http://archive.ubuntu.com/ubuntu"
      ;;
    arm64)
      packages="http://ports.ubuntu.com/ubuntu-ports/dists/noble/main/binary-arm64/Packages.gz"
      pool="http://ports.ubuntu.com/ubuntu-ports"
      ;;
    *) echo "unsupported arch $deb_arch" >&2; exit 1 ;;
  esac

  local work
  work="$(mktemp -d)"
  curl -fsSL "$packages" | gzip -dc > "$work/Packages"
  local dev_path lib_path
  dev_path="$(awk -v pkg=libgmp-dev '
    $1 == "Package:" { in_pkg = ($2 == pkg) }
    in_pkg && $1 == "Filename:" { print $2; exit }
  ' "$work/Packages")"
  lib_path="$(awk -v pkg=libgmp10 '
    $1 == "Package:" { in_pkg = ($2 == pkg) }
    in_pkg && $1 == "Filename:" { print $2; exit }
  ' "$work/Packages")"
  if [ -z "$dev_path" ] || [ -z "$lib_path" ]; then
    echo "could not find libgmp packages for $deb_arch" >&2
    exit 1
  fi
  curl -fsSL -o "$work/dev.deb" "$pool/$dev_path"
  curl -fsSL -o "$work/lib.deb" "$pool/$lib_path"
  mkdir -p "$work/dev" "$work/lib"
  (cd "$work/dev" && ar x "$work/dev.deb" && zstd -dc data.tar.zst | tar -xf -)
  (cd "$work/lib" && ar x "$work/lib.deb" && zstd -dc data.tar.zst | tar -xf -)

  local out="$dest/$zig_arch"
  mkdir -p "$out/include" "$out/lib"
  cp "$work/dev/usr/include/gmp.h" "$out/include/gmp.h"
  local soname
  soname="$(find "$work/lib/usr/lib/$multiarch" -name 'libgmp.so.*' -type f | head -n 1)"
  if [ -z "$soname" ]; then
    echo "libgmp shared library missing for $deb_arch" >&2
    exit 1
  fi
  cp "$soname" "$out/lib/$(basename "$soname")"
  ln -s "$(basename "$soname")" "$out/lib/libgmp.so"
  rm -rf "$work"
}

if ! command -v zstd >/dev/null 2>&1; then
  brew install zstd
fi

fetch_arch amd64 x86_64 x86_64-linux-gnu
fetch_arch arm64 aarch64 aarch64-linux-gnu
