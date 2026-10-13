#!/usr/bin/env bash
# Runs the test suite against a local validator we control (deterministic startup).
#   bash scripts/localnet-test.sh            (after `anchor build`)
set -uo pipefail
cd "$(dirname "$0")/.."
PROGRAM_ID=$(solana-keygen pubkey target/deploy/solmix-keypair.json)
SO="${SO:-target/deploy/solmix.so}"
LEDGER=$(mktemp -d)
WALLET="$HOME/.config/solana/id.json"
# Swap tests need solmix built with `--features mock-swap` (SO=target/mock/solmix.so) plus the mock aggregator.
EXTRA=()
if [ -f target/deploy/mock_swap.so ]; then
  EXTRA=(--bpf-program "$(solana-keygen pubkey target/deploy/mock_swap-keypair.json)" target/deploy/mock_swap.so)
fi

solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --upgradeable-program "$PROGRAM_ID" "$SO" "$(solana-keygen pubkey "$WALLET")" \
  "${EXTRA[@]}" > "$LEDGER/out.log" 2>&1 &
VALIDATOR=$!
trap 'kill $VALIDATOR 2>/dev/null; wait $VALIDATOR 2>/dev/null; rm -rf "$LEDGER"' EXIT

# wait for RPC, a few slots, and the program to be executable
for i in $(seq 1 90); do
  if solana -u localhost slot >/dev/null 2>&1 && [ "$(solana -u localhost slot 2>/dev/null)" -gt 8 ] \
     && solana -u localhost program show "$PROGRAM_ID" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
echo "validator ready at slot $(solana -u localhost slot), program $PROGRAM_ID from $SO ($(sha256sum "$SO" | cut -c1-16))"
solana -u localhost airdrop 100 "$(solana-keygen pubkey "$WALLET")" >/dev/null

ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET="$WALLET" \
  node --test --test-concurrency=1 --test-force-exit tests/*.test.mjs
