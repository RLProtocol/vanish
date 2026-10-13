// Dry run of a private swap's Jupiter leg against mainnet: for each pair, quote, build the route
// with the order PDA as the user delivering into its output escrow, and check the execute
// transaction fits. Sends nothing.
//   node scripts/check-jupiter-swap.mjs [IN:OUT ...]   e.g. SOL:NVDAx NVDAx:SOL USDC:TSLAx
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { NATIVE_SOL, assetBySymbol } from "../sdk/assets.js";
import { escrowAddress, orderPda, swapExecuteInstruction } from "../sdk/swap.js";
import { PROGRAM_ID, connection, lookupTable } from "../cli/common.mjs";

const JUP = "https://lite-api.jup.ag";
// same routing rules as the relayer: CPI-safe AMMs, shared accounts for multi-hop routes
const DEXES = "Raydium,Raydium CLMM,Raydium CP,Raydium Launchlab,Whirlpool,Orca V1,Orca V2,Meteora,Meteora DLMM,Meteora DAMM v2,Dynamic Bonding Curve,Pump.fun,Pump.fun Amm,Phoenix,OpenBook V2,Manifest,Invariant,Saber,Saber (Decimals),Stabble Stable Swap,Stabble Weighted Swap,Stabble CLMM,Byreal,PancakeSwap,Crema,Saros,Saros DLMM,FluxBeam,Boop.fun,Heaven,Moonit,Bonkswap,GooseFX GAMMA,DefiTuna,Sanctum Infinity,Token Swap";
const jupMint = (m) => (m === NATIVE_SOL ? "So11111111111111111111111111111111111111112" : m);
const relayer = new PublicKey("FwL2cgcAND3X1o5pTiiMyuQrsStSJUkabDdbqjNXBhHq");
const ours = await lookupTable();
const pairs = process.argv.slice(2).length ? process.argv.slice(2) : ["SOL:NVDAx", "NVDAx:SOL", "USDC:TSLAx", "SOL:USDC"];

for (const pair of pairs) {
  const [a, b] = pair.split(":").map(assetBySymbol);
  const amount = a.mint === NATIVE_SOL ? 100_000_000n : a.kind === "dollar" ? 20_000_000n : 10_000_000n;
  try {
    const order = orderPda(PROGRAM_ID, crypto.getRandomValues(new Uint8Array(32)));
    const q = await (await fetch(`${JUP}/swap/v1/quote?inputMint=${jupMint(a.mint)}&outputMint=${jupMint(b.mint)}&amount=${amount}&slippageBps=100&swapMode=ExactIn&maxAccounts=30&restrictIntermediateTokens=true&dexes=${encodeURIComponent(DEXES)}`)).json();
    if (q.error) throw new Error(q.error);
    const built = await (await fetch(`${JUP}/swap/v1/swap-instructions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: order.toBase58(), wrapAndUnwrapSol: false, destinationTokenAccount: escrowAddress(order, b).toBase58(), skipUserAccountsRpcCalls: true, useSharedAccounts: true }),
    })).json();
    if (built.error) throw new Error(built.error);
    const si = built.swapInstruction;
    const route = { programId: new PublicKey(si.programId), keys: si.accounts.map((x) => ({ pubkey: x.pubkey, isWritable: x.isWritable })), data: Buffer.from(si.data, "base64") };
    const luts = [ours, ...(await Promise.all((built.addressLookupTableAddresses ?? []).map(async (x) => (await connection.getAddressLookupTable(new PublicKey(x))).value)))].filter(Boolean);
    const relayerOut = b.mint === NATIVE_SOL ? relayer : getAssociatedTokenAddressSync(new PublicKey(b.mint), relayer, false, new PublicKey(b.tokenProgram));
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })];
    if (b.mint !== NATIVE_SOL) ixs.push(createAssociatedTokenAccountIdempotentInstruction(relayer, relayerOut, relayer, new PublicKey(b.mint), new PublicKey(b.tokenProgram)));
    ixs.push(swapExecuteInstruction({ programId: PROGRAM_ID, relayer, assetIn: a, assetOut: b, order, relayerOutAccount: relayerOut, route }));
    const { blockhash } = await connection.getLatestBlockhash();
    const size = new VersionedTransaction(new TransactionMessage({ payerKey: relayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts)).serialize().length;
    const signerOk = si.accounts.filter((x) => x.isSigner).every((x) => x.pubkey === order.toBase58());
    // the order owns only its two escrows: any other token account of the order's would not exist
    const { getAssociatedTokenAddressSync: ata } = await import("@solana/spl-token");
    const mints = new Set(q.routePlan.flatMap((r) => [r.swapInfo.inputMint, r.swapInfo.outputMint]));
    const orderOwned = [...mints].flatMap((m) => ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].map((tp) => ata(new PublicKey(m), order, true, new PublicKey(tp)).toBase58()));
    const escrows = [escrowAddress(order, a).toBase58(), escrowAddress(order, b).toBase58()];
    const missing = si.accounts.filter((x) => orderOwned.includes(x.pubkey) && !escrows.includes(x.pubkey)).length;
    console.log(`${pair.padEnd(12)} ${amount} -> ${q.outAmount} via ${q.routePlan.map((r) => r.swapInfo.label).join(" > ")}; ${si.accounts.length} route accts; signer=order ${signerOk}; missing order accounts ${missing}; tx ${size}/1232 ${size <= 1232 ? "FITS" : "TOO BIG"}`);
  } catch (e) {
    console.log(`${pair.padEnd(12)} ERROR ${e.message}`);
  }
}
