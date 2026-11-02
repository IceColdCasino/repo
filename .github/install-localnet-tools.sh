#!/usr/bin/env bash
# Solana, Anchor 1.0.2, and Arcium CLI 0.14.1.
# The Arcium resolver looks for /tmp/arcium-0.14/bin/arcium.
# scripts/bin/anchor execs ~/.local/bin/anchor, so the real CLI lives there.
set -euo pipefail

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    anchor_asset="anchor-1.0.2-x86_64-unknown-linux-gnu"
    arcium_asset="arcium_x86_64_linux_0.14.1"
    ;;
  Darwin-arm64)
    anchor_asset="anchor-1.0.2-aarch64-apple-darwin"
    arcium_asset="arcium_aarch64_macos_0.14.1"
    ;;
  *)
    echo "unsupported host $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is required before the Solana and Anchor CLIs" >&2
  exit 1
fi

# Arcium 0.14.1 requires Solana CLI 3.1.10 (see docs.arcium.com installation).
# `stable`/`edge` track Agave 4.x and make `arcium localnet` panic after log streams.
SOLANA_RELEASE="${SOLANA_RELEASE:-v3.1.10}"
echo "==> Solana CLI ${SOLANA_RELEASE}"
sh -c "$(curl -sSfL "https://release.anza.xyz/${SOLANA_RELEASE}/install")"
solana_bin="${HOME}/.local/share/solana/install/active_release/bin"
export PATH="${solana_bin}:${PATH}"
solana --version | grep -E '3\.1\.10|3\.1\.' || {
  echo "error: expected Solana ${SOLANA_RELEASE}, got: $(solana --version)" >&2
  exit 1
}

echo "==> Anchor ${anchor_asset}"
mkdir -p "${HOME}/.local/bin"
curl -fsSL -o "${HOME}/.local/bin/anchor" \
  "https://github.com/coral-xyz/anchor/releases/download/v1.0.2/${anchor_asset}"
chmod +x "${HOME}/.local/bin/anchor"

echo "==> Arcium ${arcium_asset}"
mkdir -p /tmp/arcium-0.14/bin
curl -fsSL -o /tmp/arcium-0.14/bin/arcium \
  "https://bin.arcium.com/download/${arcium_asset}"
chmod +x /tmp/arcium-0.14/bin/arcium

export PATH="/tmp/arcium-0.14/bin:${HOME}/.local/bin:${PATH}"
solana --version
"${HOME}/.local/bin/anchor" --version
arcium --version

# Anchor.toml and `arcium localnet` read this wallet. CI images have none.
mkdir -p "${HOME}/.config/solana"
if [[ ! -f "${HOME}/.config/solana/id.json" ]]; then
  solana-keygen new --no-bip39-passphrase --silent -o "${HOME}/.config/solana/id.json"
fi
solana-keygen pubkey "${HOME}/.config/solana/id.json"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "${solana_bin}" >> "${GITHUB_PATH}"
  echo "${HOME}/.local/bin" >> "${GITHUB_PATH}"
  echo "/tmp/arcium-0.14/bin" >> "${GITHUB_PATH}"
fi
