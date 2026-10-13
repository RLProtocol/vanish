#!/usr/bin/env bash
# Compiles the circuit, runs a Groth16 setup and exports the Solidity verifier.
# Requires tools/circom(.exe) and tools/pot15.ptau (see README).
set -euo pipefail
cd "$(dirname "$0")/.."

CIRCOM=tools/circom.exe
[ -x "$CIRCOM" ] || CIRCOM=circom
PTAU=tools/pot15.ptau
OUT=build/circuits
SNARKJS="node node_modules/snarkjs/build/cli.cjs"

mkdir -p "$OUT"

echo "==> compiling transaction.circom"
$CIRCOM circuits/transaction.circom --r1cs --wasm --sym -o "$OUT"
$SNARKJS r1cs info "$OUT/transaction.r1cs"

echo "==> groth16 setup (phase 2)"
$SNARKJS groth16 setup "$OUT/transaction.r1cs" "$PTAU" "$OUT/transaction_0000.zkey"
# Single local contribution: fine for a hobby deployment. For anything holding real
# value, run a multi-party phase-2 ceremony instead (see README).
ENTROPY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
$SNARKJS zkey contribute "$OUT/transaction_0000.zkey" "$OUT/transaction.zkey" \
  --name="robinmix-local" -e="$ENTROPY"
rm -f "$OUT/transaction_0000.zkey"
$SNARKJS zkey export verificationkey "$OUT/transaction.zkey" "$OUT/verification_key.json"

echo "==> exporting Verifier.sol"
$SNARKJS zkey export solidityverifier "$OUT/transaction.zkey" contracts/Verifier.sol

echo "done. artifacts in $OUT"
