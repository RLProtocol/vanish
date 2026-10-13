// Vanish v2: shielded swaps. Instruction builders, order decoding and the three proofs a swap
// needs (see docs/v2-shielded-swaps.md). Works in Node and the browser.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import { FIELD_SIZE, Utxo, assetId, fromBytes, toBytes32 } from "./crypto.js";
import { NATIVE_SOL } from "./assets.js";
import { Reader, Writer, encodeTransactArgs, pdas, prepareTransaction, relayerEndpoint } from "./solmix.js";

export const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

const disc = (name) => sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);
const SWAP_DISC = {
  prepare: disc("swap_prepare"),
  commitOut: disc("swap_commit_out"),
  open: disc("swap_open"),
  execute: disc("swap_execute"),
  cancel: disc("swap_cancel"),
  order: sha256(new TextEncoder().encode("account:SwapOrder")).subarray(0, 8),
};

const isSol = (asset) => asset.mint === NATIVE_SOL;
/** Mint and token program of the escrow that holds an asset during a swap (wSOL for SOL). */
export const escrowMint = (asset) => (isSol(asset) ? NATIVE_MINT : new PublicKey(asset.mint));
export const escrowTokenProgram = (asset) => (isSol(asset) ? TOKEN_PROGRAM_ID : new PublicKey(asset.tokenProgram));

export function orderPda(programId, orderId) {
  return PublicKey.findProgramAddressSync([Buffer.from("order"), Buffer.from(orderId)], new PublicKey(programId))[0];
}
export const escrowAddress = (order, asset) => getAssociatedTokenAddressSync(escrowMint(asset), new PublicKey(order), true, escrowTokenProgram(asset));

/** Same as SwapOrder::terms_hash on-chain. */
export function termsHash({ mintOut, minOut, deadline, outCommitments, outEnc, refundCommitments, refundEnc }) {
  const w = new Writer()
    .bytes(new TextEncoder().encode("swap"))
    .bytes(new PublicKey(mintOut).toBytes())
    .u64(minOut)
    .i64(deadline)
    .bytes(toBytes32(outCommitments[0]))
    .bytes(toBytes32(outCommitments[1]))
    .bytes(outEnc[0])
    .bytes(outEnc[1])
    .bytes(toBytes32(refundCommitments[0]))
    .bytes(toBytes32(refundCommitments[1]))
    .bytes(refundEnc[0])
    .bytes(refundEnc[1]);
  return keccak_256(w.done());
}

/** keccak(order | ext_amount | relayer | fee | mint_in | enc1 | enc2 | terms_hash) mod p */
export function swapExtDataHash({ order, extAmount, relayer, fee, mintIn, enc1, enc2, terms }) {
  const w = new Writer()
    .bytes(new PublicKey(order).toBytes())
    .i64(extAmount)
    .bytes(new PublicKey(relayer).toBytes())
    .u64(fee)
    .bytes(new PublicKey(mintIn).toBytes())
    .bytes(enc1)
    .bytes(enc2)
    .bytes(terms);
  return fromBytes(keccak_256(w.done())) % FIELD_SIZE;
}

/**
 * Proves everything a swap needs, entirely client side:
 *   refund  deposit-shaped proof over assetIn worth amountIn (credited only if the swap is cancelled)
 *   out     deposit-shaped proof over assetOut worth minOut  (credited when the swap fills)
 *   open    spends `inputs` (assetIn): amountIn to the order escrow, `fee` to the relayer, change back
 * All notes are owned by `keypair`.
 */
export async function prepareSwap({ programId, tree, keypair, prove, assetIn, assetOut, inputs, amountIn, minOut, fee = 0n, relayerFeeAccount, deadline, orderId = crypto.getRandomValues(new Uint8Array(32)), onProgress }) {
  amountIn = BigInt(amountIn);
  minOut = BigInt(minOut);
  fee = BigInt(fee);
  const order = orderPda(programId, orderId);
  const idIn = assetId(new PublicKey(assetIn.mint));
  const idOut = assetId(new PublicKey(assetOut.mint));
  const total = inputs.reduce((s, u) => s + u.amount, 0n);
  if (total < amountIn + fee) throw new Error("inputs don't cover the swap and fee");

  const step = (i) => (p) => onProgress?.((i + p) / 3);
  const refund = await prepareTransaction({
    tree, asset: assetIn, outputs: [new Utxo({ amount: amountIn, assetId: idIn, keypair })], extAmount: amountIn,
    recipient: order, relayer: order, keypair, prove, onProgress: step(0),
  });
  const out = await prepareTransaction({
    tree, asset: assetOut, outputs: [new Utxo({ amount: minOut, assetId: idOut, keypair })], extAmount: minOut,
    recipient: order, relayer: order, keypair, prove, onProgress: step(1),
  });
  const terms = termsHash({
    mintOut: assetOut.mint, minOut, deadline, outCommitments: out.outputCommitments, outEnc: [out.enc1, out.enc2],
    refundCommitments: refund.outputCommitments, refundEnc: [refund.enc1, refund.enc2],
  });
  const change = new Utxo({ amount: total - amountIn - fee, assetId: idIn, keypair });
  const open = await prepareTransaction({
    tree, asset: assetIn, inputs, outputs: [change], extAmount: -amountIn, fee, keypair, prove, onProgress: step(2),
    hashExt: ({ enc1, enc2 }) => swapExtDataHash({ order, extAmount: -amountIn, relayer: relayerFeeAccount, fee, mintIn: assetIn.mint, enc1, enc2, terms }),
  });
  return { orderId, order, deadline: BigInt(deadline), refund, out, open };
}

// ---------------------------------------------------------------------------- instructions

const w = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: true });
const r = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: false });
const s = (k) => ({ pubkey: new PublicKey(k), isSigner: true, isWritable: true });

export function swapPrepareInstruction({ programId, relayer, assetIn, orderId, deadline, refund }) {
  const P = pdas(programId);
  const data = new Writer().bytes(SWAP_DISC.prepare).bytes(orderId).i64(deadline);
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      s(relayer), r(P.pool), r(P.asset(assetIn.mint)), w(orderPda(programId, orderId)),
      w(P.nullifier(refund.inputNullifiers[0])), w(P.nullifier(refund.inputNullifiers[1])), r(SystemProgram.programId),
    ],
    data: Buffer.from(encodeTransactArgs(refund, data)),
  });
}

export function swapCommitOutInstruction({ programId, relayer, assetOut, order, out }) {
  const P = pdas(programId);
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      s(relayer), r(P.pool), r(P.asset(assetOut.mint)), w(order),
      w(P.nullifier(out.inputNullifiers[0])), w(P.nullifier(out.inputNullifiers[1])),
      r(escrowMint(assetOut)), w(escrowAddress(order, assetOut)), r(escrowTokenProgram(assetOut)),
      r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
    ],
    data: Buffer.from(encodeTransactArgs(out, new Writer().bytes(SWAP_DISC.commitOut))),
  });
}

export function swapOpenInstruction({ programId, relayer, relayerFeeAccount, assetIn, order, open }) {
  const P = pdas(programId);
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      s(relayer), w(P.pool), w(order),
      w(P.nullifier(open.inputNullifiers[0])), w(P.nullifier(open.inputNullifiers[1])),
      w(relayerFeeAccount), w(P.solVault),
      r(escrowMint(assetIn)), w(escrowAddress(order, assetIn)),
      isSol(assetIn) ? r(P.programId) : w(P.vault(assetIn)),
      r(escrowTokenProgram(assetIn)), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
    ],
    data: Buffer.from(encodeTransactArgs(open, new Writer().bytes(SWAP_DISC.open))),
  });
}

/**
 * route: { programId, keys: AccountMeta[], data } — the aggregator instruction, with the order PDA
 * as the swapping user. Its accounts are passed through as remaining accounts.
 * relayerOutAccount: the relayer's token account for assetOut (receives positive slippage);
 * for SOL output pass the relayer wallet.
 */
export function swapExecuteInstruction({ programId, relayer, assetIn, assetOut, order, relayerOutAccount, route }) {
  const P = pdas(programId);
  const ph = r(P.programId);
  const remaining = route.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: false, isWritable: k.isWritable }));
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      s(relayer), w(P.pool), w(order), w(P.solVault),
      r(escrowMint(assetIn)), r(escrowMint(assetOut)),
      w(escrowAddress(order, assetIn)), w(escrowAddress(order, assetOut)),
      isSol(assetIn) ? ph : w(P.vault(assetIn)),
      isSol(assetOut) ? ph : w(P.vault(assetOut)),
      w(relayerOutAccount),
      r(escrowTokenProgram(assetIn)), r(escrowTokenProgram(assetOut)),
      r(route.programId), r(SystemProgram.programId),
      ...remaining,
    ],
    data: Buffer.from(new Writer().bytes(SWAP_DISC.execute).vec(route.data).done()),
  });
}

/** `state` is a decoded order (decodeOrder); assets are looked up by its mints. */
export function swapCancelInstruction({ programId, caller, order, state, assetIn, assetOut }) {
  const P = pdas(programId);
  const ph = r(P.programId);
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      s(caller), w(P.pool), w(order), w(state.relayer), w(P.solVault),
      state.opened ? r(escrowMint(assetIn)) : ph,
      state.opened ? w(escrowAddress(order, assetIn)) : ph,
      state.opened && !isSol(assetIn) ? w(P.vault(assetIn)) : ph,
      state.opened ? r(escrowTokenProgram(assetIn)) : ph,
      state.outReady ? w(escrowAddress(order, assetOut)) : ph,
      state.outReady ? r(escrowTokenProgram(assetOut)) : ph,
      r(SystemProgram.programId),
    ],
    data: Buffer.from(SWAP_DISC.cancel),
  });
}

export function decodeOrder(data) {
  const b = Uint8Array.from(data);
  if (!SWAP_DISC.order.every((x, i) => x === b[i])) throw new Error("not a SwapOrder account");
  const rd = new Reader(b.subarray(8));
  const key = () => new PublicKey(rd.take(32)).toBase58();
  const field = () => fromBytes(rd.take(32));
  const o = {};
  o.relayer = key();
  o.orderId = Uint8Array.from(rd.take(32));
  o.bump = rd.take(1)[0];
  o.mintIn = key();
  o.amountIn = rd.u64();
  o.deadline = rd.i64();
  o.refundCommitments = [field(), field()];
  o.refundEnc = [Uint8Array.from(rd.vec()), Uint8Array.from(rd.vec())];
  o.outReady = rd.take(1)[0] === 1;
  o.mintOut = key();
  o.minOut = rd.u64();
  o.outCommitments = [field(), field()];
  o.outEnc = [Uint8Array.from(rd.vec()), Uint8Array.from(rd.vec())];
  o.opened = rd.take(1)[0] === 1;
  return o;
}

const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Array.from(x) : x));

/**
 * Private swap through a relayer: shielded assetIn -> shielded assetOut (both listed). `fee` is in
 * assetIn. Resolves to { status: "filled" | "refunded", signature }. On "refunded" the user keeps
 * amountIn as a private note (only the fee is spent).
 */
export async function privateSwap(client, { assetIn, assetOut, amountIn, minOut, fee, relayerUrl, relayer, mergeFee = 0n, ttl = 300, onStage, onProgress }) {
  amountIn = BigInt(amountIn);
  fee = BigInt(fee);
  const inputs = await client.spendable({ asset: assetIn, need: amountIn + fee, relayerUrl, relayer, mergeFee, onStage, onProgress });
  onStage?.("prove");
  const sw = await prepareSwap({
    programId: client.P.programId, tree: client.tree, keypair: client.keypair, prove: client.prove, assetIn, assetOut, inputs, amountIn, minOut, fee,
    relayerFeeAccount: client.receivingAccount(assetIn, relayer), deadline: Math.floor(Date.now() / 1000) + ttl, onProgress,
  });
  onStage?.("relay");
  const res = await fetch(relayerEndpoint(relayerUrl, "/swap"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: toJson({ mintIn: assetIn.mint, mintOut: assetOut.mint, orderId: sw.orderId, deadline: sw.deadline, refund: sw.refund, out: sw.out, open: sw.open }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Relayer refused: ${json.error ?? res.status}`);
  await client.sync();
  onStage?.("done", json.signature);
  return json;
}
