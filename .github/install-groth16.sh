#!/usr/bin/env bash
# Install the published groth16 0.3.0 archive and put zkey on PATH.
# `zkey lib` resolves libgroth16 from bin/../lib next to this prefix.
set -euo pipefail

version="${GROTH16_VERSION:-0.3.0}"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset="groth16-${version}-linux-x86_64" ;;
  Linux-aarch64) asset="groth16-${version}-linux-aarch64" ;;
  Darwin-arm64) asset="groth16-${version}-macos-aarch64" ;;
  *)
    echo "unsupported host $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

prefix="${GROTH16_PREFIX:-${HOME}/.local/groth16}"
mkdir -p "${prefix}"
archive="$(mktemp)"
curl -fsSL -o "${archive}" \
  "https://github.com/IceColdCasino/groth16/releases/download/v${version}/${asset}.tar.gz"
tar -xzf "${archive}" -C "${prefix}" --strip-components=1
rm -f "${archive}"
test -x "${prefix}/bin/zkey"
if [ "$(uname -s)" = "Darwin" ]; then
  test -f "${prefix}/lib/libgroth16.dylib"
else
  test -f "${prefix}/lib/libgroth16.so"
fi

export PATH="${prefix}/bin:${PATH}"
zkey lib
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "${prefix}/bin" >> "${GITHUB_PATH}"
fi
