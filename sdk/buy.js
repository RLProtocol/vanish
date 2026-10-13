// Vanish v2: private buy. Spend shielded notes on any token the aggregator can route and
// deliver it to a fresh wallet. Instruction builders, order decoding and the proof.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import { Utxo, assetId } from "./crypto.js";
import { NATIVE_SOL } from "./assets.js";
import { Reader, Writer, encodeTransactArgs, pdas, prepareTransaction, relayerEndpoint } from "./solmix.js";
import { escrowMint, escrowTokenProgram, swapExtDataHash } from "./swap.js";

/** Same as MIN_GAS on-chain: smallest gas top-up (lamports) for a fresh wallet. */
export const MIN_GAS = 1_000_000n;

const disc = (name) => sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);
const BUY_DISC = {
  open: disc("buy_open"),
  execute: disc("buy_execute"),
  cancel: disc("buy_cancel"),
  order: sha256(new TextEncoder().encode("account:BuyOrder")).subarray(0, 8),
};

export function buyOrderPda(programId, orderId) {
  return PublicKey.findProgramAddressSync([Buffer.from("buy"), Buffer.from(orderId)], new PublicKey(programId))[0];
}
export const buyEscrowAddress = (order, assetIn) => getAssociatedTokenAddressSync(escrowMint(assetIn), new PublicKey(order), true, escrowTokenProgram(assetIn));

const writeTerms = (w, t) =>
  w.bytes(new PublicKey(t.mintOut).toBytes()).u64(t.minOut).i64(t.deadline).bytes(new PublicKey(t.destination).toBytes()).u64(t.gas);

/** keccak("buy" | mint_out | min_out | deadline | destination | gas) — same as BuyTerms::hash. */
export function buyTermsHash(t) {
  return keccak_256(writeTerms(new Writer().bytes(new TextEncoder().encode("buy")), t).done());
}

/**
 * Proves the buy: spends `inputs` (assetIn); amountIn goes to the order escrow, `gas` lamports
 * (SOL input only) to the destination, `fee` to the relayer, change back to `keypair`.
 */
export async function prepareBuy({ programId, tree, keypair, prove, assetIn, inputs, amountIn, gas = 0n, fee = 0n, relayerFeeAccount, mintOut, minOut, deadline, destination, orderId = crypto.getRandomValues(new Uint8Array(32)), onProgress }) {
  amountIn = BigInt(amountIn);
  gas = BigInt(gas);
  fee = BigInt(fee);
  if (gas && assetIn.mint !== NATIVE_SOL) throw new Error("gas can only be sent when buying with SOL");
  if (gas && gas < MIN_GAS) throw new Error("gas must be at least 0.001 SOL");
  const total = inputs.reduce((s, u) => s + u.amount, 0n);
  const spend = amountIn + gas;
  if (total < spend + fee) throw new Error("not enough private balance for this buy and the fee");
  const order = buyOrderPda(programId, orderId);
  const terms = { mintOut: new PublicKey(mintOut).toBase58(), minOut: BigInt(minOut), deadline: BigInt(deadline), destination: new PublicKey(destination).toBase58(), gas };
  const th = buyTermsHash(terms);
  const change = new Utxo({ amount: total - spend - fee, assetId: assetId(new PublicKey(assetIn.mint)), keypair });
  const open = await prepareTransaction({
    tree, asset: assetIn, inputs, outputs: [change], extAmount: -spend, fee, keypair, prove, onProgress,
    hashExt: ({ enc1, enc2 }) => swapExtDataHash({ order, extAmount: -spend, relayer: relayerFeeAccount, fee, mintIn: assetIn.mint, enc1, enc2, terms: th }),
  });
  return { orderId, order, terms, open };
}

const w = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: true });
const r = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: false });
const s = (k) => ({ pubkey: new PublicKey(k), isSigner: true, isWritable: true });

export function buyOpenInstruction({ programId, relayer, relayerFeeAccount, assetIn, orderId, terms, open }) {
  const P = pdas(programId);
  const order = buyOrderPda(programId, orderId);
  const data = writeTerms(new Writer().bytes(BUY_DISC.open).bytes(orderId), terms);
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      s(relayer), w(P.pool), r(P.asset(assetIn.mint)), w(order),
      w(P.nullifier(open.inputNullifiers[0])), w(P.nullifier(open.inputNullifiers[1])),
      w(relayerFeeAccount), w(P.solVault),
      r(escrowMint(assetIn)), w(buyEscrowAddress(order, assetIn)),
      assetIn.mint === NATIVE_SOL ? r(P.programId) : w(P.vault(assetIn)),
      r(escrowTokenProgram(assetIn)), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
    ],
    data: Buffer.from(encodeTransactArgs(open, data)),
  });
}

/** The destination's token account for the bought mint (create it idempotently before execute). */
export const destinationTokenAccount = (destination, mintOut, tokenProgramOut) =>
  getAssociatedTokenAddressSync(new PublicKey(mintOut), new PublicKey(destination), true, new PublicKey(tokenProgramOut));

/** The order's own account for the bought mint; some routes reference it (swept + closed on execute). */
export const orderTokenAccount = (order, mintOut, tokenProgramOut) =>
  getAssociatedTokenAddressSync(new PublicKey(mintOut), new PublicKey(order), true, new PublicKey(tokenProgramOut));

/**
 * route: { programId, keys, data }, the aggregator instruction with the order PDA as the user.
 * withOrderTokenOut: pass the order's own output account (it must exist; create it idempotently).
 */
export function buyExecuteInstruction({ programId, relayer, assetIn, order, destination, mintOut, tokenProgramOut, route, withOrderTokenOut = false }) {
  const P = pdas(programId);
  const remaining = route.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: false, isWritable: k.isWritable }));
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      s(relayer), r(P.pool), w(order), w(P.solVault),
      r(escrowMint(assetIn)), w(buyEscrowAddress(order, assetIn)),
      assetIn.mint === NATIVE_SOL ? r(P.programId) : w(P.vault(assetIn)),
      w(destination), r(mintOut), w(destinationTokenAccount(destination, mintOut, tokenProgramOut)),
      withOrderTokenOut ? w(orderTokenAccount(order, mintOut, tokenProgramOut)) : r(P.programId),
      r(escrowTokenProgram(assetIn)), r(tokenProgramOut), r(route.programId), r(SystemProgram.programId),
      ...remaining,
    ],
    data: Buffer.from(new Writer().bytes(BUY_DISC.execute).vec(route.data).done()),
  });
}

export function buyCancelInstruction({ programId, caller, order, state, assetIn }) {
  const P = pdas(programId);
  const isSol = assetIn.mint === NATIVE_SOL;
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      s(caller), w(order), w(state.relayer), w(state.destination),
      r(escrowMint(assetIn)), w(buyEscrowAddress(order, assetIn)),
      isSol ? r(P.programId) : w(destinationTokenAccount(state.destination, assetIn.mint, assetIn.tokenProgram)),
      r(escrowTokenProgram(assetIn)), r(SystemProgram.programId),
    ],
    data: Buffer.from(BUY_DISC.cancel),
  });
}

export function decodeBuyOrder(data) {
  const b = Uint8Array.from(data);
  if (!BUY_DISC.order.every((x, i) => x === b[i])) throw new Error("not a BuyOrder account");
  const rd = new Reader(b.subarray(8));
  const key = () => new PublicKey(rd.take(32)).toBase58();
  return {
    relayer: key(),
    orderId: Uint8Array.from(rd.take(32)),
    bump: rd.take(1)[0],
    mintIn: key(),
    amountIn: rd.u64(),
    gas: rd.u64(),
    mintOut: key(),
    minOut: rd.u64(),
    deadline: rd.i64(),
    destination: key(),
  };
}

const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Array.from(x) : x));

/**
 * Private buy through a relayer: spend shielded `assetIn` on `mintOut`, delivered to the
 * `destination` wallet. `fee` is in assetIn; `gas` (SOL input only) tops up the destination.
 * Resolves to { status: "filled" | "refunded", openSignature, signature }. On "refunded" the
 * input (and gas) went to the destination wallet instead.
 */
export async function privateBuy(client, { assetIn, amountIn, gas = 0n, fee, mintOut, minOut, destination, relayerUrl, relayer, mergeFee = 0n, ttl = 180, onStage, onProgress }) {
  amountIn = BigInt(amountIn);
  gas = BigInt(gas);
  fee = BigInt(fee);
  const inputs = await client.spendable({ asset: assetIn, need: amountIn + gas + fee, relayerUrl, relayer, mergeFee, onStage, onProgress });
  onStage?.("prove");
  const b = await prepareBuy({
    programId: client.P.programId, tree: client.tree, keypair: client.keypair, prove: client.prove, assetIn, inputs, amountIn, gas, fee,
    relayerFeeAccount: client.receivingAccount(assetIn, relayer), mintOut, minOut, deadline: Math.floor(Date.now() / 1000) + ttl, destination, onProgress,
  });
  onStage?.("relay");
  const res = await fetch(relayerEndpoint(relayerUrl, "/buy"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: toJson({ mintIn: assetIn.mint, orderId: b.orderId, terms: b.terms, args: b.open }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Relayer refused: ${json.error ?? res.status}`);
  await client.sync();
  onStage?.("done", json.signature);
  return json;
}
