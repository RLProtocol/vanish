// Lists every open swap / buy order and, with --cancel, cancels the ones past their deadline
// (or all of them when signed by the order's relayer). A cancelled buy pays its input to the
// buyer's destination wallet; a cancelled swap that was opened re-inserts the refund notes.
//   RELAYER_KEYPAIR=keys/relayer.json node scripts/cancel-orders.mjs [--cancel]
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import { NATIVE_SOL, assetByMint } from "../sdk/assets.js";
import { decodeOrder, swapCancelInstruction } from "../sdk/swap.js";
import { buyCancelInstruction, decodeBuyOrder, destinationTokenAccount } from "../sdk/buy.js";
import { PROGRAM_ID, loadSolKeypair } from "../cli/common.mjs";

const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const caller = loadSolKeypair(process.env.RELAYER_KEYPAIR ?? "keys/relayer.json");
const doCancel = process.argv.includes("--cancel");
const now = Math.floor(Date.now() / 1000);
const discOf = (name) => Buffer.from(sha256(new TextEncoder().encode(`account:${name}`)).subarray(0, 8));
const fmt = (raw, a) => (a ? `${Number(raw) / 10 ** a.decimals} ${a.symbol}` : `${raw} raw`);

const all = await connection.getProgramAccounts(PROGRAM_ID);
const send = (ixs) =>
  sendAndConfirmTransaction(connection, new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...ixs), [caller], { commitment: "confirmed" });

for (const { pubkey, account } of all) {
  const head = account.data.subarray(0, 8);
  if (head.equals(discOf("SwapOrder"))) {
    const o = decodeOrder(account.data);
    const assetIn = assetByMint(o.mintIn), assetOut = o.outReady ? assetByMint(o.mintOut) : null;
    const expired = now > Number(o.deadline);
    console.log(`swap ${pubkey.toBase58()}: ${fmt(o.amountIn, assetIn)} -> ${assetOut?.symbol ?? "?"}, opened=${o.opened}, outReady=${o.outReady}, ${expired ? "expired" : `${Number(o.deadline) - now}s left`}`);
    if (doCancel && (expired || o.relayer === caller.publicKey.toBase58())) {
      const sig = await send([swapCancelInstruction({ programId: PROGRAM_ID, caller: caller.publicKey, order: pubkey, state: o, assetIn, assetOut: assetOut ?? assetIn })]);
      console.log(`  cancelled ${sig}${o.opened ? " (refund notes credited)" : " (nothing had been spent)"}`);
    }
  } else if (head.equals(discOf("BuyOrder"))) {
    const o = decodeBuyOrder(account.data);
    const assetIn = assetByMint(o.mintIn);
    const expired = now > Number(o.deadline);
    console.log(`buy  ${pubkey.toBase58()}: ${fmt(o.amountIn, assetIn)} (+gas ${Number(o.gas) / 1e9} SOL) for ${o.mintOut} -> ${o.destination}, ${expired ? "expired" : `${Number(o.deadline) - now}s left`}`);
    if (doCancel && (expired || o.relayer === caller.publicKey.toBase58())) {
      const ixs = [];
      if (o.mintIn !== NATIVE_SOL) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(caller.publicKey, destinationTokenAccount(o.destination, o.mintIn, assetIn.tokenProgram), new PublicKey(o.destination), new PublicKey(o.mintIn), new PublicKey(assetIn.tokenProgram)));
      }
      ixs.push(buyCancelInstruction({ programId: PROGRAM_ID, caller: caller.publicKey, order: pubkey, state: o, assetIn }));
      const sig = await send(ixs);
      console.log(`  cancelled ${sig}: input went to ${o.destination}`);
    }
  }
}
