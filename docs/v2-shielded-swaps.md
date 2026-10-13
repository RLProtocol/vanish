# Vanish v2 — shielded swaps

Swap one shielded asset for another (e.g. SOL → NVDAx) without the funds ever leaving
program control and without any user wallet appearing on-chain.

v2 ships as an **upgrade of the existing program** (same address, same pool, same notes).
All v1 accounts and the `transact` instruction stay byte-compatible; v2 only adds instructions
and one account type. The circuit and verifying key are unchanged.

## Why several transactions

A swap needs three Groth16 proofs (each proof is bound to one asset τ) plus an aggregator
route, which is far over Solana's 1,232-byte transaction limit. The swap is therefore a small
on-chain state machine, driven by the relayer:

```
swap_prepare ──▶ swap_commit_out ──▶ swap_open ──▶ swap_execute ──▶ (done)
      │                 │                │
      └─────────────────┴────────────────┴──────▶ swap_cancel (private refund once opened)
```

The rule that makes it safe: **every note the pool can ever create for a swap is proven
before any value moves.** A refund or output note is never taken on trust.

## Flow

Let `x` = amount of asset A to sell, `y` = minimum amount of asset B to receive
(aggregator quote minus slippage), `f` = relayer fee in A. The user's client builds all three
proofs; the order PDA is `["order", order_id]` with a random 32-byte `order_id`.

### 1. `swap_prepare`: prove the refund notes
* Proof **P_refund** over A, shaped like a deposit: `ext_amount = +x`, fee 0, recipient and
  relayer = the order PDA, zero-value dummy inputs. It proves the two refund notes are worth
  exactly `x` of A. No value moves.
* Effects: order created (`mint_in`, `amount_in = x`, `deadline`, refund commitments and
  ciphertexts), P_refund's dummy nullifiers spent.

### 2. `swap_commit_out`: prove the output notes
* Proof **P_out** over B, the same deposit shape: `ext_amount = +y`. It proves the output
  notes are worth exactly `y` of B.
* Effects: `mint_out`, `min_out = y` and the output commitments and ciphertexts stored; the
  order's B escrow (token account owned by the order PDA; wSOL for SOL) created.

### 3. `swap_open`: spend A into the escrow
* Proof **P_in** over A spends the user's notes: `ext_amount = −x`, fee `f`, outputs = change.
* Its ext-data hash appends `terms_hash = keccak("swap" ‖ mint_out ‖ y ‖ deadline ‖ out cms ‖
  out encs ‖ refund cms ‖ refund encs)`, recomputed on-chain from the stored order. If the
  relayer swapped in different refund/output notes or terms in steps 1–2, P_in doesn't verify
  and nothing is spent.
* Effects: nullifiers spent, change inserted, `x` moves vault_A → escrow_A, `f` → relayer.

### 4. `swap_execute`: run the route
* Only the order's relayer, before the deadline.
* CPI into the **whitelisted aggregator** (Jupiter `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`),
  route accounts passed as remaining accounts, signed **only by the order PDA**. The pool PDA
  and SOL vault may not appear in the route at all.
* After the CPI: `received = escrow_B_after − escrow_B_before ≥ y`, else everything reverts.
  * `y` → vault_B (must arrive in full: transfer-fee tokens are rejected), output notes inserted,
    `TransactEvent` emitted so wallets discover them like any deposit.
  * everything above `y` in escrow_B (positive slippage) → relayer, as a tip.
  * any A the route didn't spend → vault_A.
  * escrows and order closed; rent back to the relayer.

### 5. `swap_cancel`: unwind
* The relayer any time before execution; **anyone** after the deadline, so funds never depend on
  the relayer showing up.
* Before `swap_open`: just closes the order (nothing was spent).
* After `swap_open`: escrow_A → vault_A and the proven refund notes (worth `x`) are inserted.
  The user gets back everything except the relayer fee, privately.

## Security properties

| Threat | Mitigation |
|---|---|
| Refund note worth more than `x` (pool inflation) | Refund notes are proven worth exactly `x` (P_refund) before anything is spent |
| Relayer substitutes its own output/refund notes or changes terms | P_in binds `terms_hash` of the stored order; mismatch → P_in fails, nothing spent (tested) |
| Malicious route drains the pool | Only the order PDA signs; it controls only its escrows. Pool PDA / SOL vault forbidden in the route (tested) |
| Route returns too little | `received ≥ y` after the CPI, else full revert (tested) |
| Arbitrary program called | Aggregator program ID hard-whitelisted (tested) |
| Re-entrancy into Vanish | Solana forbids re-entrant CPI into a program already on the stack |
| Relayer disappears mid-swap | Anyone can `swap_cancel` after the deadline (tested) |
| Griefing by donating tokens to an escrow | Surplus is swept to the relayer on execute; on cancel a non-empty B escrow is left behind instead of blocking the refund |
| Replay of a deposit-shaped proof | Its dummy nullifiers are spent in steps 1–2 |
| Value mismatch across assets | Each proof is single-asset; A and B accounting are independent and both checked |

## Privacy

On-chain an observer sees: "the pool sold `x` A for ≥ `y` B, paid by the relayer". Both legs
start and end inside the pool, so no wallet links to either. The amounts and assets of the swap
are public, so round amounts still blend in best.

## Costs (per swap)

* Three proofs (generated in the browser, ~15–60 s total).
* Rent: 6 nullifier accounts (~0.0054 SOL, permanent) + temporary order/escrows (refunded to the relayer).
* Network fees for 4 transactions; aggregator route compute (~200k–600k CU).

## Testing plan

1. ✅ Localnet with a **mock swap program** that speaks the same CPI shape (order PDA signs, escrow in →
   escrow out at a fixed rate). Feature flag `mock-swap` swaps the whitelisted program ID.
2. Mainnet-fork (Surfpool) against real Jupiter routes and real xStocks pools.
3. Small real swaps on mainnet after the upgrade, before announcing.

Localnet status: 20/20 tests pass (14 v1 + 6 swap: SOL→Token-2022 stock with surplus tip,
classic SPL→SOL with partial fill, underfilled route + refund, forbidden/malicious routes,
note substitution, deadline cancel). Run: build solmix with `--features mock-swap` into
`target/mock/`, then `SO=target/mock/solmix.so bash scripts/localnet-test.sh`.

## Upgrade notes

The v2 program is ~357 KB vs ~257 KB allocated on mainnet, so the upgrade first extends the
program account (`solana program extend`, ~100 KB ≈ 0.7 SOL rent, permanent) and needs a
temporary buffer (~2.5 SOL, refunded after the upgrade).

## Private buy (any token)

Spend shielded notes on any token Jupiter can route (pump.fun, PumpSwap, Raydium, ...) and
deliver it to a fresh wallet. The token is never listed or held by the pool, so this needs one
proof and two transactions instead of the three-proof swap.

* `buy_open`: proof spends the notes; `ext_amount = -(amount_in + gas)`. The ext-data hash binds
  `keccak("buy" | mint_out | min_out | deadline | destination | gas)`, so the relayer can't change
  the token, the minimum, the deadline or the wallet. amount_in moves to an escrow owned by the
  order PDA `["buy", order_id]`; gas (SOL only, >= 0.001 SOL) waits on the order; fee to relayer.
* `buy_execute`: Jupiter route signed only by the order PDA, delivering into the destination's
  token account; at least min_out must arrive. Any output a route leaves on the order's own token
  account is swept to the destination. Unspent input returns to the pool; gas goes to the
  destination; order and escrows close (rent to the relayer). Any extra output is the buyer's.
* `buy_cancel`: relayer any time, anyone after the deadline. The input and gas go to the
  destination wallet, which is exactly a withdrawal to it, so a failed buy loses no privacy.

The relayer (`POST /buy`) refuses up front if the live quote is below min_out (nothing spent),
opens the order, then tries up to 3 fresh routes before the deadline and cancels otherwise.
`GET /token?mint=` and `GET /quote` back the UI. Dry run against mainnet Jupiter:
`node scripts/check-jupiter-buy.mjs <mint>` (execute transactions measured at 758-1032 / 1232 bytes).
