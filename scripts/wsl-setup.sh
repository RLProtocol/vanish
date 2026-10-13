#!/usr/bin/env bash
# One-time toolchain setup inside WSL (Ubuntu): Rust, Solana (Agave), Anchor 0.31.1, Node 22.
#   bash scripts/wsl-setup.sh
set -euo pipefail

SUDO="${SUDO:-sudo}"
$SUDO apt-get update -y
$SUDO apt-get install -y build-essential pkg-config libssl-dev libudev-dev llvm libclang-dev protobuf-compiler curl git

if ! command -v rustup >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
source "$HOME/.cargo/env"

if ! command -v solana >/dev/null; then
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

if ! command -v avm >/dev/null; then
  cargo install --git https://github.com/coral-xyz/anchor avm --force
fi
avm install 0.31.1
avm use 0.31.1

if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

# a local key for tests (never used on mainnet)
[ -f "$HOME/.config/solana/id.json" ] || solana-keygen new --no-bip39-passphrase -s -o "$HOME/.config/solana/id.json"

grep -q 'solana/install/active_release' "$HOME/.bashrc" || \
  echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.bashrc"

rustc --version; solana --version; anchor --version; node --version
echo "toolchain ready"
