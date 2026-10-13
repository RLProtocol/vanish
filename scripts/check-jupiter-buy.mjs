// Dry run of a private buy's Jupiter leg against mainnet: quote, build the route with the
// order PDA as the user and a fresh wallet as the destination, and check the execute
// transaction fits. Sends nothing.
//   node scripts/check-jupiter-buy.mjs [outputMint] [lamports]
import { ComputeBudgetProgram, Keypair as SolKeypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { ASSETS } from "../sdk/assets.js";
import { buyExecuteInstruction, buyOrderPda, destinationTokenAccount, orderTokenAccount } from "../sdk/buy.js";
import { PROGRAM_ID, connection, lookupTable } from "../cli/common.mjs";

const mintOut = process.argv[2] ?? "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"; // Fartcoin (pump.fun)
const amount = process.argv[3] ?? "100000000"; // 0.1 SOL
const JUP = "https://lite-api.jup.ag";
const SOL = ASSETS.find((a) => a.symbol === "SOL");

const mintAcc = await connection.getAccountInfo(new PublicKey(mintOut));
const tokenProgram = mintAcc.owner.toBase58();
const order = buyOrderPda(PROGRAM_ID, crypto.getRandomValues(new Uint8Array(32)));
const destination = SolKeypair.generate().publicKey;
const destToken = destinationTokenAccount(destination, mintOut, tokenProgram);

const q = await (await fetch(`${JUP}/swap/v1/quote?inputMint=${NATIVE_MINT}&outputMint=${mintOut}&amount=${amount}&slippageBps=100&swapMode=ExactIn&maxAccounts=30&restrictIntermediateTokens=true`)).json();
if (q.error) throw new Error(q.error);
console.log(`quote: ${amount} lamports -> ${q.outAmount} (min ${q.otherAmountThreshold}), impact ${q.priceImpactPct}, via ${q.routePlan.map((r) => r.swapInfo.label).join(" > ")}`);

const built = await (await fetch(`${JUP}/swap/v1/swap-instructions`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ quoteResponse: q, userPublicKey: order.toBase58(), wrapAndUnwrapSol: false, destinationTokenAccount: destToken.toBase58(), skipUserAccountsRpcCalls: true }),
})).json();
if (built.error) throw new Error(built.error);
const si = built.swapInstruction;
console.log(`swap ix: program ${si.programId}, ${si.accounts.length} accounts, ${Buffer.from(si.data, "base64").length} data bytes; signer accounts: ${si.accounts.filter((a) => a.isSigner).map((a) => a.pubkey).join(", ")} (order ${order.toBase58()})`);
for (const ix of built.setupInstructions ?? []) console.log(`setup: ${ix.programId} accounts ${ix.accounts.map((a) => a.pubkey.slice(0, 6)).join(",")}`);
console.log(`escrow (order wSOL) ${(await import("../sdk/buy.js")).buyEscrowAddress(order, SOL).toBase58().slice(0, 6)}, dest token ${destToken.toBase58().slice(0, 6)}, uses shared accounts: ${q.routePlan.length > 1 ? "multi-hop" : "single"}`);

const orderOut = (built.setupInstructions ?? [])[1]?.accounts[1]?.pubkey; console.log(`order output ATA ${orderOut?.slice(0, 6)} referenced by route: ${si.accounts.some((a) => a.pubkey === orderOut)}; dest referenced: ${si.accounts.some((a) => a.pubkey === destToken.toBase58())}`);
const route = { programId: new PublicKey(si.programId), keys: si.accounts.map((a) => ({ pubkey: a.pubkey, isWritable: a.isWritable })), data: Buffer.from(si.data, "base64") };
const luts = [await lookupTable(), ...(await Promise.all((built.addressLookupTableAddresses ?? []).map(async (a) => (await connection.getAddressLookupTable(new PublicKey(a))).value)))].filter(Boolean);
const relayer = new PublicKey("FwL2cgcAND3X1o5pTiiMyuQrsStSJUkabDdbqjNXBhHq");
const { blockhash } = await connection.getLatestBlockhash();
const msg = new TransactionMessage({
  payerKey: relayer, recentBlockhash: blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    createAssociatedTokenAccountIdempotentInstruction(relayer, destToken, destination, new PublicKey(mintOut), new PublicKey(tokenProgram)),
    createAssociatedTokenAccountIdempotentInstruction(relayer, orderTokenAccount(order, mintOut, tokenProgram), order, new PublicKey(mintOut), new PublicKey(tokenProgram)),
    buyExecuteInstruction({ programId: PROGRAM_ID, relayer, assetIn: SOL, order, destination, mintOut, tokenProgramOut: tokenProgram, route, withOrderTokenOut: true }),
  ],
}).compileToV0Message(luts);
const size = new VersionedTransaction(msg).serialize().length;
console.log(`execute transaction: ${size} / 1232 bytes, ${msg.staticAccountKeys.length} static keys + ${msg.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0)} from lookup tables`);
console.log(size <= 1232 ? "FITS" : "TOO BIG");
